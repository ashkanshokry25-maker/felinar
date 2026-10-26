// ChatLane: the mw_chat1 transport (R 2.7.1, 2.7.3, 2.7.5, 2.7.9; MF-32, MF-33, MF-39, MF-43, MF-44).
//
// Per wire (a "wire" is one BEP 10 connection; nothing is keyed by the self-declared peer id):
//   1. both sides send HELLO in clear (site, owner, lanes; no identity); its random stamp nonce picks the
//      Noise initiator (the lower nonce);
//   2. the Noise XX handshake (noise.js) runs in XX frames; it times out after 15 s;
//   3. every later frame is sealed under the session (a failed AEAD is a strike).
// Strikes are per wire: an unknown type or version, a malformed body or point, a stamp below its bits, a
// frame before or after its phase; 20 strikes close the wire.
//
// Relayed frames (ENV, SIG, HOLDING, COLLECTED, ROOM) are checked in this order: day (today or yesterday,
// else dropped), the relay stamp (one hash), the seen-set (20,000 ids or 10 minutes). Frames that come back in
// HELD keep the day they were stamped on and are accepted for the 7 days of the hold. Then:
//   - local interest (the service's tags) under decrypt budgets of 50 per wire and 200 per tag per second;
//   - holders keep hold-flagged frames and route a HOLDING back toward the depositor;
//   - relay: hop + 1 up to 4 (ENV, SIG, HOLDING, COLLECTED) or 3 (ROOM, only after the service accepted it),
//     toward the wires a matching WANT-TAGS or HOLDING came from, otherwise to a random half of the eligible
//     neighbours, after a random 0.5 to 3 s; per-neighbour fair queues (round robin over the sources that
//     fed them) under 64 KiB/s on desktop. Phones relay nothing: iOS never; Android only after "Share on this
//     network", then 8 KiB/s and 2 MiB per session.
// The separate site chat lane sha1("mw-chat1|" + ledgerId) is joined only when fewer than 2 rendezvous
// neighbours speak mw_chat1, and only through the site's own tracker (never the public default trackers).
//
// Review round (R 5.3, 2026-10-24; docs/deviations/review-round-chat.md):
//   - WANT-TAGS routes add targets and never replace the random half (DS-1, MP-4, SYB-3); a wire's prefix routes are those of
//     its latest WANT (at most 32), full-tag routes are kept only by a holder, at most 16 per wire and 4,096 in all (MP-3,
//     SYB-9);
//   - own frames leave at a random hop (0 to 2), after the 0.5 to 3 s first-send jitter when more than one neighbour could
//     carry them, and a flood goes to a random half (at least two) of the neighbours (PRIV-1, STALK-7);
//   - frames without a stamp have per-wire token buckets (WANT, CK, PRES, ICHAL, IRESP, HELD; over budget: dropped and a
//     strike), ROOM signature checks have a per-wire and a global budget, and a wire whose unread backlog passes 1 MiB is
//     closed (MP-8, SYB-10);
//   - chatBits is read live (a getter), and a relayed stranger frame under the local requirement is dropped without a strike
//     (SEC-7);
//   - the seen-set keeps the lowest hop and whether the frame was relayed, so a copy sent first at the hop limit cannot stop
//     an honest copy (SYB-7);
//   - a full relay queue drops from the source holding the most bytes before it refuses a frame of another source (SYB-8);
//   - holders count quotas by the neighbour's Noise static key (DS-7).
//
// Shared code: Node >= 22 and browsers; WebCrypto, no Buffer, no node: imports.

import { utf8, hex } from '../chain/canonical.js';
import {
  T, HOP_LIMIT, decode, encode, frameId as frameIdOf, withHop, withNonce, helloBody, xxBody, wantBody, holdingBody,
  ichalBody,
} from './frames.js';
import { check as checkStamp, mint, requiredBits, dayAcceptable, dayWithin, headerDay, stampWork } from './stamp.js';
import { tagKey, secureRandom } from './tags.js';
import { XXHandshake, prologueFor } from './noise.js';
import { packHeld } from './holder.js';
import {
  EXT_NAME, FRAME_MAX, WIRE_AEAD_TAG, STRIKES_CLOSE, DECRYPT_PER_WIRE_PER_S, DECRYPT_PER_TAG_PER_S, SEEN_MAX,
  SEEN_TTL_MS, RELAY_JITTER_MIN_MS, RELAY_JITTER_MAX_MS, RELAY_BYTES_PER_S_DESKTOP, RELAY_BYTES_PER_S_ANDROID,
  RELAY_SESSION_BYTES_ANDROID, QUEUE_MAX_BYTES_PER_NEIGHBOUR, ROUTE_TTL_MS, LANE_MIN_RENDEZVOUS, LANE_PREFIX,
  HANDSHAKE_TIMEOUT_MS, STAMP_BITS_STRANGER_DEFAULT, FLAG_HOLD, DEVICE, HELD_INTERVAL_MS, HELD_DAYS, FLAG_STRANGER,
  STAMP_BITS_CONTACT, STAMP_BITS_MAX, OWN_HOP_MAX, ROUTE_TAGS_PER_WIRE, ROUTE_TAGS_MAX, INGRESS, ROOM_VERIFY_PER_WIRE_PER_S,
  ROOM_VERIFY_PER_S, RX_BACKLOG_BYTES,
} from './limits.js';

const RELAYED = new Set([T.ENV, T.SIG, T.HOLDING, T.COLLECTED, T.ROOM]);
const PUMP_MS = 50;

function randomBytes(n) {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

function compareBytes(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** sha1(utf8("mw-chat1|" + ledgerId)) as 40 hex: the infohash of the separate site chat lane. */
export async function chatLaneInfoHash(ledgerId) {
  const d = await globalThis.crypto.subtle.digest('SHA-1', utf8.encode(LANE_PREFIX + ledgerId));
  return hex.encode(new Uint8Array(d));
}

/** Relay budget of a device class: { rate, sessionCap } or null when it relays nothing. */
export function relayBudget(deviceClass, { shareOnNetwork = false } = {}) {
  if (deviceClass === DEVICE.ios) return null;
  if (deviceClass === DEVICE.android) return shareOnNetwork ? { rate: RELAY_BYTES_PER_S_ANDROID, sessionCap: RELAY_SESSION_BYTES_ANDROID } : null;
  return { rate: RELAY_BYTES_PER_S_DESKTOP, sessionCap: Infinity };
}

class SeenSet {
  constructor(max, ttl, now) {
    this.max = max;
    this.ttl = ttl;
    this.now = now;
    this.map = new Map(); // id hex -> { at, from, fwd: Set }
  }

  get(id) {
    const e = this.map.get(id);
    if (!e) return null;
    if (this.now() - e.at > this.ttl) {
      this.map.delete(id);
      return null;
    }
    return e;
  }

  add(id, from, hop = 0) {
    const e = { at: this.now(), from, fwd: new Set(), hop, relayed: false, roomOk: false };
    this.map.set(id, e);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    const t = this.now();
    for (const [k, v] of this.map) {
      if (t - v.at <= this.ttl) break;
      this.map.delete(k);
    }
    return e;
  }

  get size() {
    return this.map.size;
  }
}

export class ChatLane {
  /**
   * new ChatLane({ ledgerId, chatKey, hello: { site, owner }, torrentManager?, deviceClass = 'desktop',
   *   policy: { shareOnNetwork }, holder?, ownTracker?, chatBits = 20 (a number or a getter), now, setTimeout, clearTimeout,
   *   random = secureRandom })
   */
  constructor({
    ledgerId, chatKey, hello, torrentManager = null, deviceClass = DEVICE.desktop, policy = {}, holder = null,
    ownTracker = null, chatBits = STAMP_BITS_STRANGER_DEFAULT, now = () => Date.now(), setTimeout: st, clearTimeout: ct,
    random = secureRandom,
  }) {
    if (typeof ledgerId !== 'string' || !ledgerId) throw new TypeError('ChatLane: ledgerId');
    if (!chatKey || typeof chatKey.ecdh !== 'function') throw new TypeError('ChatLane: chatKey');
    this.ledgerId = ledgerId;
    this.chatKey = chatKey;
    this.hello = { site: (hello && hello.site) || ledgerId, owner: (hello && hello.owner) || null };
    this.tm = torrentManager;
    this.deviceClass = deviceClass;
    this.policy = Object.assign({ shareOnNetwork: false }, policy);
    this.holder = holder;
    this.ownTracker = ownTracker;
    this._chatBits = chatBits;
    this.now = now;
    this.setT = st || ((fn, ms) => setTimeout(fn, ms));
    this.clearT = ct || ((h) => clearTimeout(h));
    this.random = random;
    this.prologue = prologueFor(ledgerId);
    this.wires = new Map(); // id -> W
    this.listeners = new Map();
    this.seen = new SeenSet(SEEN_MAX, SEEN_TTL_MS, now);
    this.tagRoutes = new Map(); // tag hex -> { wire, at }
    this.prefixRoutes = new Map(); // byte -> Map(wire -> at)
    this.tagBudget = new Map(); // tag hex -> { sec, n }
    this.wireTags = new Map(); // wire id -> Set(tag hex) of its full-tag routes (holders only)
    this.roomVerify = { sec: -1, n: 0 }; // ROOM signature checks this second, all wires
    this.interest = () => false;
    this.roomFilter = null;
    this.enabled = false;
    this.relayed = 0; // bytes relayed this session
    this.stats = { dropped: 0, dayDropped: 0, overBudget: 0, relayed: 0, strikes: 0, understamped: 0, rated: 0, rerelayed: 0, evicted: 0 };
    this.laneJoined = null;
    this._timers = new Set();
    this._pumpTimer = null;
  }

  /**
   * The stranger stamp bits this lane requires, read live (SEC-7: the site setting may change or sync after the lane
   * started). A number or a getter; anything outside 10 to 32 bits reads as the default 20.
   */
  get chatBits() {
    let b = this._chatBits;
    if (typeof b === 'function') {
      try { b = b(); } catch (_) { b = null; }
    }
    return Number.isInteger(b) && b >= STAMP_BITS_CONTACT && b <= STAMP_BITS_MAX ? b : STAMP_BITS_STRANGER_DEFAULT;
  }

  set chatBits(v) {
    this._chatBits = v;
  }

  // -------------------------------------------------------------------------------------------
  // Events and hooks
  // -------------------------------------------------------------------------------------------

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    return () => this.listeners.get(event).delete(fn);
  }

  _emit(event, data) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        fn(data);
      } catch (_) {
        // a listener must not break the lane
      }
    }
  }

  /**
   * _emitWait(event, data): _emit, then waits until the promises the listeners return have settled. A CK frame goes
   * through here (code review v0.3, round 2): the next frame of the same wire is read once the chat key is cached and the
   * interest refreshed, so a SIG or a message sent right behind a CK frame is not dropped as nobody's.
   */
  async _emitWait(event, data) {
    const set = this.listeners.get(event);
    if (!set) return;
    const waits = [];
    for (const fn of Array.from(set)) {
      try {
        const r = fn(data);
        if (r && typeof r.then === 'function') waits.push(Promise.resolve(r).then(() => undefined, () => undefined));
      } catch (_) {
        // a listener must not break the lane
      }
    }
    if (waits.length) await Promise.all(waits);
  }

  /**
   * interest(tagBytes, decoded, via) -> boolean: is this tag one of ours (the service's contact, group or inbox tags).
   * via is 'relay' for a live frame and 'held' for one a holder handed back (older days count only then).
   */
  setInterest(fn) {
    this.interest = typeof fn === 'function' ? fn : () => false;
  }

  /** roomFilter(decoded) -> Promise<boolean>: ROOM frames are relayed only when the service accepts them. */
  setRoomFilter(fn) {
    this.roomFilter = typeof fn === 'function' ? fn : null;
  }

  _later(fn, ms) {
    const h = this.setT(() => {
      this._timers.delete(h);
      fn();
    }, ms);
    this._timers.add(h);
    return h;
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------

  enable() {
    this.enabled = true;
    this._checkLane();
  }

  disable() {
    this.enabled = false;
    for (const w of Array.from(this.wires.values())) this._close(w, 'disabled');
    for (const h of this._timers) this.clearT(h);
    this._timers.clear();
    if (this._pumpTimer) this.clearT(this._pumpTimer);
    this._pumpTimer = null;
    this._leaveLane();
  }

  /** Relay allowance for this device right now (null: relay nothing). */
  relayAllowance() {
    const b = relayBudget(this.deviceClass, this.policy);
    if (!b) return null;
    if (this.relayed >= b.sessionCap) return null;
    return b;
  }

  // -------------------------------------------------------------------------------------------
  // Wires
  // -------------------------------------------------------------------------------------------

  /**
   * attachWire({ id, send(u8) -> boolean, close(), swarm }) -> wire state. Sends HELLO at once.
   */
  attachWire(handle) {
    if (!this.enabled) return null;
    if (!handle || typeof handle.send !== 'function') throw new TypeError('attachWire: handle.send');
    const id = String(handle.id);
    if (this.wires.has(id)) return this.wires.get(id);
    const w = {
      id, handle, swarm: handle.swarm || 'rendezvous', strikes: 0, closed: false, helloSent: false, helloGot: false,
      nonce: randomBytes(8), hs: null, session: null, remote: null, sendChain: Promise.resolve(),
      decrypt: { sec: -1, n: 0 }, queues: new Map(), queueBytes: 0, srcBytes: new Map(), tokens: 0, lastFill: this.now(), rr: [],
      bytesIn: 0, lastIchal: -Infinity, hsTimer: null, rx: Promise.resolve(), rxBytes: 0, buckets: new Map(),
      roomVerify: { sec: -1, n: 0 },
    };
    this.wires.set(id, w);
    const helloFrame = encode(T.HELLO, { day: headerDay(this.now()), stampNonce: w.nonce },
      helloBody({ site: this.hello.site, owner: this.hello.owner, lanes: [EXT_NAME] }));
    w.helloSent = true;
    this._rawSend(w, helloFrame, true);
    w.hsTimer = this._later(() => {
      if (!w.session && !w.closed) this._close(w, 'handshake-timeout');
    }, HANDSHAKE_TIMEOUT_MS);
    this._checkLane();
    return w;
  }

  detachWire(id) {
    const w = this.wires.get(String(id));
    if (w) this._close(w, 'closed', { remoteClosed: true });
  }

  _close(w, reason, { remoteClosed = false } = {}) {
    if (w.closed) return;
    w.closed = true;
    this.wires.delete(w.id);
    if (w.hsTimer) this.clearT(w.hsTimer);
    if (!remoteClosed) {
      try { w.handle.close && w.handle.close(reason); } catch (_) { /* already closed */ }
    }
    for (const [k, r] of this.tagRoutes) if (r.wire === w.id) this.tagRoutes.delete(k);
    for (const m of this.prefixRoutes.values()) m.delete(w.id);
    this.wireTags.delete(w.id);
    if (w.session) this._emit('peer-gone', { wire: w.id, remote: w.remote, reason });
    this._checkLane();
  }

  /** strike(wireId | w, reason): 20 close the wire. */
  strike(wireOrId, reason) {
    const w = typeof wireOrId === 'object' ? wireOrId : this.wires.get(String(wireOrId));
    if (!w || w.closed) return;
    w.strikes++;
    this.stats.strikes++;
    this._emit('strike', { wire: w.id, reason, strikes: w.strikes });
    if (w.strikes >= STRIKES_CLOSE) this._close(w, 'strikes');
  }

  /** Neighbours that finished the handshake: [{ id, remote, swarm }]. */
  peers() {
    const out = [];
    for (const w of this.wires.values()) if (w.session && !w.closed) out.push({ id: w.id, remote: w.remote, swarm: w.swarm });
    return out;
  }

  /** The wire id of a neighbour whose chat key is `chatPub`, or null. */
  neighbourOf(chatPub) {
    for (const w of this.wires.values()) if (w.session && !w.closed && w.remote === chatPub) return w.id;
    return null;
  }

  _rawSend(w, frameBytes, clear = false) {
    if (w.closed) return;
    w.sendChain = w.sendChain.then(async () => {
      if (w.closed) return;
      const out = clear || !w.session ? frameBytes : await w.session.encrypt(frameBytes);
      try {
        w.handle.send(out);
      } catch (_) {
        // the wire is closing
      }
    }).catch(() => {});
    return w.sendChain;
  }

  /** Sends one frame on one wire (one-hop types: CK, PRES, WANT, HELD, ICHAL, IRESP, COLLECTED). */
  sendTo(wireId, frameBytes) {
    const w = this.wires.get(String(wireId));
    if (!w || !w.session || w.closed) return false;
    this._rawSend(w, frameBytes);
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Receive
  // -------------------------------------------------------------------------------------------

  /**
   * onMessage(wireId, bytes) -> Promise: one BEP 10 message from a wire. Messages of one wire are processed
   * strictly in arrival order (a sealed frame may arrive while the last handshake message is still being
   * processed).
   */
  onMessage(wireId, raw) {
    const w = this.wires.get(String(wireId));
    if (!w || w.closed || !this.enabled) return Promise.resolve();
    // The unread backlog of a wire is bounded (MP-8, SYB-10): a neighbour that sends faster than this tab can handle is
    // closed instead of growing the promise chain without end.
    const len = raw && typeof raw.length === 'number' ? raw.length : 0;
    w.rxBytes += len;
    if (w.rxBytes > RX_BACKLOG_BYTES) {
      this._close(w, 'backlog');
      return Promise.resolve();
    }
    const run = w.rx.then(() => this._process(w, raw));
    w.rx = run.then(() => { w.rxBytes -= len; }, () => { w.rxBytes -= len; });
    return w.rx;
  }

  /**
   * One token from a wire's bucket for a frame type without a stamp (MP-8, SYB-10): { burst, perMs } from INGRESS. Over
   * the budget the frame is dropped and the wire gets a strike (an honest peer never sends that fast).
   */
  _ingress(w, kind) {
    const spec = INGRESS[kind];
    if (!spec) return true;
    const t = this.now();
    let b = w.buckets.get(kind);
    if (!b) {
      b = { tokens: spec.burst, at: t };
      w.buckets.set(kind, b);
    }
    b.tokens = Math.min(spec.burst, b.tokens + (t - b.at) / spec.perMs);
    b.at = t;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    this.stats.rated++;
    this.strike(w, 'rate');
    return false;
  }

  /** ROOM frames reach the signature check at most 20 a second per wire and 100 a second in all (dropped, no strike). */
  _roomBudget(w) {
    const sec = Math.floor(this.now() / 1000);
    if (w.roomVerify.sec !== sec) w.roomVerify = { sec, n: 0 };
    if (this.roomVerify.sec !== sec) this.roomVerify = { sec, n: 0 };
    if (w.roomVerify.n >= ROOM_VERIFY_PER_WIRE_PER_S || this.roomVerify.n >= ROOM_VERIFY_PER_S) {
      this.stats.overBudget++;
      return false;
    }
    w.roomVerify.n++;
    this.roomVerify.n++;
    return true;
  }

  async _process(w, raw) {
    if (w.closed || !this.enabled) return;
    if (!(raw instanceof Uint8Array)) return this.strike(w, 'not-bytes');
    w.bytesIn += raw.length;
    if (raw.length > FRAME_MAX + WIRE_AEAD_TAG) return this.strike(w, 'too-large');
    let bytes = raw;
    if (w.session) {
      bytes = await w.session.decrypt(raw);
      if (!bytes) return this.strike(w, 'aead');
    }
    const d = decode(bytes);
    if (d.error) return this.strike(w, d.error);
    try {
      if (!w.session) return await this._preSession(w, d);
      if (d.type === T.HELLO || d.type === T.XX) return this.strike(w, 'after-handshake');
      return await this._frame(w, d, bytes);
    } catch (_) {
      return this.strike(w, 'internal');
    }
  }

  async _preSession(w, d) {
    if (d.type === T.HELLO) {
      if (w.helloGot) return this.strike(w, 'hello-twice');
      w.helloGot = true;
      if (d.fields.site !== this.hello.site || (d.fields.owner || null) !== this.hello.owner) {
        return this._close(w, 'other-site');
      }
      const c = compareBytes(w.nonce, d.header.stampNonce);
      if (c === 0) return this._close(w, 'nonce-collision');
      w.hs = new XXHandshake({ staticKey: this.chatKey, prologue: this.prologue, initiator: c < 0 });
      if (c < 0) {
        const r = await w.hs.next();
        if (r.error) return this._close(w, r.error);
        this._rawSend(w, encode(T.XX, { day: headerDay(this.now()) }, xxBody(1, r.send)), true);
      }
      return undefined;
    }
    if (d.type !== T.XX || !w.hs) return this.strike(w, 'before-handshake');
    const expect = w.hs.initiator ? 2 : (w.hs.step === 0 ? 1 : 3);
    if (d.fields.step !== expect) return this.strike(w, 'xx-order');
    const r = await w.hs.next(d.fields.msg.slice());
    if (r.error) {
      this.strike(w, r.error);
      return this._close(w, 'handshake-failed');
    }
    if (r.send) this._rawSend(w, encode(T.XX, { day: headerDay(this.now()) }, xxBody(w.hs.initiator ? 3 : 2, r.send)), true);
    if (r.done) {
      // The clear XX3 is already queued on sendChain, so it leaves before any sealed frame.
      w.session = r.session;
      w.remote = r.session.remoteStatic;
      if (w.hsTimer) this.clearT(w.hsTimer);
      w.hsTimer = null;
      this._emit('peer', { wire: w.id, remote: w.remote, swarm: w.swarm });
      this._checkLane();
    }
    return undefined;
  }

  _budgetOk(w, tag) {
    const sec = Math.floor(this.now() / 1000);
    if (w.decrypt.sec !== sec) {
      w.decrypt.sec = sec;
      w.decrypt.n = 0;
    }
    const k = tagKey(tag);
    let b = this.tagBudget.get(k);
    if (!b || b.sec !== sec) {
      b = { sec, n: 0 };
      this.tagBudget.set(k, b);
      if (this.tagBudget.size > 4096) this.tagBudget.delete(this.tagBudget.keys().next().value);
    }
    if (w.decrypt.n >= DECRYPT_PER_WIRE_PER_S || b.n >= DECRYPT_PER_TAG_PER_S) {
      this.stats.overBudget++;
      return false;
    }
    w.decrypt.n++;
    b.n++;
    return true;
  }

  /** Day and stamp checks of a relayable frame: 'ok' | 'day' | 'stamp'. */
  _admit(d) {
    if (!dayAcceptable(d.header.day, this.now())) return 'day';
    const bits = requiredBits(d.header.flags, this.chatBits);
    return checkStamp(frameIdOf(d), d.header.stampNonce, bits) ? 'ok' : 'stamp';
  }

  _local(w, d, bytes, via) {
    if ((d.type === T.ENV || d.type === T.SIG) && this.interest(d.fields.tag, d, via)) {
      if (!this._budgetOk(w, d.fields.tag)) return false;
      this._emit('envelope', { decoded: d, bytes, wire: w.id, via });
      return true;
    }
    return false;
  }

  async _frame(w, d, bytes) {
    if (RELAYED.has(d.type)) {
      const a = this._admit(d);
      if (a === 'day') {
        this.stats.dayDropped++;
        return undefined;
      }
      if (a === 'stamp') {
        // A stranger frame relayed under this tab's requirement may be honest (the sender read another chatBits, or the
        // setting changed): dropped without a strike, unless the neighbour wrote it (hop 0) or its stamp is below the 10
        // bits no site setting goes under (SEC-7).
        if ((d.header.flags & FLAG_STRANGER) && d.header.hop > 0 && stampWork(frameIdOf(d), d.header.stampNonce) >= STAMP_BITS_CONTACT) {
          this.stats.understamped++;
          return undefined;
        }
        return this.strike(w, 'stamp');
      }
      const idBytes = frameIdOf(d);
      const idHex = hex.encode(idBytes);
      const prev = this.seen.get(idHex);
      if (prev) {
        // A copy that arrived first at the hop limit must not stop an honest copy with a lower hop (SYB-7): the frame is
        // relayed once, from the lowest hop seen, never again after it went out.
        const relayable = d.type === T.ENV || d.type === T.SIG || (d.type === T.ROOM && prev.roomOk);
        if (relayable && prev.from !== null && !prev.relayed && d.header.hop < prev.hop) {
          prev.hop = d.header.hop;
          this.stats.rerelayed++;
          this._relay(w, d, bytes, prev);
        }
        this.stats.dropped++;
        return undefined;
      }
      const entry = this.seen.add(idHex, w.id, d.header.hop);
      if (d.type === T.ENV || d.type === T.SIG) {
        this._local(w, d, bytes, 'relay');
        if (this.holder && (d.header.flags & FLAG_HOLD)) {
          const r = this.holder.offer(bytes, d, w.id, w.remote);
          if (r.held) this._sendHolding(w, r.holding);
        }
        this._relay(w, d, bytes, entry);
        return undefined;
      }
      if (d.type === T.HOLDING) {
        const back = this.seen.get(hex.encode(d.fields.frameId));
        if (back && back.from === null) {
          this._emit('holding', { fields: d.fields, wire: w.id });
        } else if (back && back.from && this.relayAllowance()) {
          const to = this.wires.get(back.from);
          if (to && to.session && d.header.hop < HOP_LIMIT[T.HOLDING]) this._enqueue(to, w.id, withHop(bytes, d.header.hop + 1));
        }
        return undefined;
      }
      if (d.type === T.COLLECTED) {
        if (this.holder) this.holder.collected(d.fields.frameId, d.fields.proof, w.id);
        const fwd = this.seen.get(hex.encode(d.fields.frameId));
        if (fwd && this.relayAllowance() && d.header.hop < HOP_LIMIT[T.COLLECTED]) {
          for (const id of fwd.fwd) {
            const to = this.wires.get(id);
            if (to && to.session && id !== w.id) this._enqueue(to, w.id, withHop(bytes, d.header.hop + 1));
          }
        }
        return undefined;
      }
      if (d.type === T.ROOM) {
        let ok = false;
        if (this.roomFilter && this._roomBudget(w)) {
          try { ok = await this.roomFilter(d, w.id); } catch (_) { ok = false; }
        }
        if (ok) {
          entry.roomOk = true;
          this._emit('room', { decoded: d, bytes, wire: w.id });
          this._relay(w, d, bytes, entry);
        }
        return undefined;
      }
    }
    switch (d.type) {
      case T.WANT: return this._ingress(w, 'WANT') ? this._onWant(w, d) : undefined;
      case T.HELD: return this._ingress(w, 'HELD') ? this._onHeld(w, d) : undefined;
      case T.CK: return this._ingress(w, 'CK') ? this._emitWait('ck', { ck: d.fields.ck, wire: w.id, remote: w.remote }) : undefined;
      case T.PRES:
        if (this._ingress(w, 'PRES')) this._emit('pres', { fields: d.fields, wire: w.id, remote: w.remote, day: d.header.day });
        return undefined;
      case T.ICHAL:
        if (this._ingress(w, 'ICHAL')) this._emit('ichal', { fields: d.fields, wire: w.id });
        return undefined;
      case T.IRESP: return this._ingress(w, 'IRESP') ? this._onIresp(w, d) : undefined;
      default: return this.strike(w, 'unexpected-type');
    }
  }

  async _onWant(w, d) {
    const t = this.now();
    // A wire's prefix routes are those of its latest WANT-TAGS (an honest one lists every prefix it wants each minute), so
    // one wire holds at most 32 of the 256 buckets however many frames it sends (MP-4, SYB-3).
    for (const m of this.prefixRoutes.values()) m.delete(w.id);
    // Full tags go only to a holder the person chose: only a holder keeps them, at most 16 per wire (MP-3, SYB-9).
    const old = this.wireTags.get(w.id);
    if (old) for (const k of old) if (this.tagRoutes.has(k) && this.tagRoutes.get(k).wire === w.id) this.tagRoutes.delete(k);
    this.wireTags.delete(w.id);
    const mine = new Set();
    for (const e of d.fields.entries) {
      if (e.length === 1) {
        if (!this.prefixRoutes.has(e[0])) this.prefixRoutes.set(e[0], new Map());
        this.prefixRoutes.get(e[0]).set(w.id, t);
      } else if (this.holder && mine.size < ROUTE_TAGS_PER_WIRE) {
        const k = tagKey(e);
        mine.add(k);
        this.tagRoutes.delete(k);
        this.tagRoutes.set(k, { wire: w.id, at: t });
      }
    }
    if (mine.size) this.wireTags.set(w.id, mine);
    this._trimTagRoutes(t);
    if (!this.holder) return;
    const frames = this.holder.want(d.fields.entries, w.id);
    for (const body of packHeld(frames)) this.sendTo(w.id, encode(T.HELD, { day: headerDay(t) }, body));
    if (this.holder.pinMailbox && t - w.lastIchal >= HELD_INTERVAL_MS) {
      w.lastIchal = t;
      const c = await this.holder.challenge(w.id);
      if (c) {
        this.sendTo(w.id, encode(T.ICHAL, { day: headerDay(t) }, ichalBody(c)));
      }
    }
  }

  _onHeld(w, d) {
    for (const item of d.fields.frames) {
      const f = item.frame;
      // Held mail keeps the day it was stamped on: accepted for the 7 days of the hold, not only today or yesterday
      // (the live relay rule of _admit). The stamp is checked as for any frame.
      if (!dayWithin(f.header.day, this.now(), HELD_DAYS)) {
        this.stats.dayDropped++;
        continue;
      }
      if (!checkStamp(frameIdOf(f), f.header.stampNonce, requiredBits(f.header.flags, this.chatBits))) {
        this.strike(w, 'stamp');
        continue;
      }
      this._local(w, f, item.bytes, 'held');
    }
  }

  async _onIresp(w, d) {
    if (!this.holder || !this.holder.pinMailbox) return this.strike(w, 'unexpected-type');
    const frames = await this.holder.respond(w.id, d.fields);
    if (frames === null) return this.strike(w, 'inbox-proof');
    for (const body of packHeld(frames)) this.sendTo(w.id, encode(T.HELD, { day: headerDay(this.now()) }, body));
    return undefined;
  }

  async _sendHolding(w, holding) {
    const f = await this.stamped(T.HOLDING, { body: holdingBody(holding) });
    this.seen.add(hex.encode(frameIdOf(f)), null);
    this.sendTo(w.id, f);
  }

  // -------------------------------------------------------------------------------------------
  // Relay
  // -------------------------------------------------------------------------------------------

  _eligible(exceptId) {
    const out = [];
    for (const w of this.wires.values()) if (w.session && !w.closed && w.id !== exceptId) out.push(w);
    return out;
  }

  /** Expired full-tag routes go, then the oldest, down to ROUTE_TAGS_MAX (MP-3, SYB-9). */
  _trimTagRoutes(t) {
    if (this.tagRoutes.size <= ROUTE_TAGS_MAX) return;
    for (const [k, r] of this.tagRoutes) if (t - r.at > ROUTE_TTL_MS) this.tagRoutes.delete(k);
    while (this.tagRoutes.size > ROUTE_TAGS_MAX) this.tagRoutes.delete(this.tagRoutes.keys().next().value);
  }

  _routesFor(tag) {
    const t = this.now();
    const out = new Set();
    const r = this.tagRoutes.get(tagKey(tag));
    if (r && t - r.at <= ROUTE_TTL_MS) out.add(r.wire);
    const m = this.prefixRoutes.get(tag[0]);
    if (m) for (const [id, at] of m) if (t - at <= ROUTE_TTL_MS) out.add(id);
    return out;
  }

  _randomHalf(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      const x = a[i];
      a[i] = a[j];
      a[j] = x;
    }
    return a.slice(0, Math.ceil(a.length / 2));
  }

  /**
   * Targets of a frame: the wires a WANT-TAGS route names plus a random half of the others (at least one when there is
   * one), so a route adds paths and never replaces the flood (DS-1, MP-4, SYB-3).
   */
  _routedTargets(eligible, tag) {
    const routes = this._routesFor(tag);
    const routed = eligible.filter((w) => routes.has(w.id));
    if (!routed.length) return { routed, targets: null };
    const others = eligible.filter((w) => !routes.has(w.id));
    return { routed, targets: routed.concat(others.length ? this._randomHalf(others) : []) };
  }

  _relay(from, d, bytes, entry) {
    if (!this.relayAllowance()) return;
    const limit = HOP_LIMIT[d.type] || 0;
    if (d.header.hop >= limit) return;
    if (entry) entry.relayed = true;
    const out = withHop(bytes, d.header.hop + 1);
    const delay = RELAY_JITTER_MIN_MS + Math.floor(this.random() * (RELAY_JITTER_MAX_MS - RELAY_JITTER_MIN_MS + 1));
    this._later(() => {
      if (!this.enabled) return;
      const eligible = this._eligible(from.id);
      if (!eligible.length) return;
      let targets;
      if (d.type === T.ENV || d.type === T.SIG) {
        targets = this._routedTargets(eligible, d.fields.tag).targets || this._randomHalf(eligible);
      } else {
        targets = this._randomHalf(eligible);
      }
      for (const w of targets) {
        if (entry) entry.fwd.add(w.id);
        this._enqueue(w, from.id, out);
      }
    }, delay);
  }

  _enqueue(w, sourceId, frameBytes) {
    // Fair admission (SYB-8): when the queue is full, the source holding the most bytes gives up its oldest frames first;
    // a frame is refused only when its own source is that one.
    while (w.queueBytes + frameBytes.length > QUEUE_MAX_BYTES_PER_NEIGHBOUR) {
      let longest = null;
      let most = -1;
      for (const [src, b] of (w.srcBytes || new Map())) if (b > most) {
        longest = src;
        most = b;
      }
      if (longest === null || longest === sourceId) {
        this.stats.dropped++;
        return;
      }
      const q = w.queues.get(longest);
      const f = q && q.shift();
      if (!f) {
        w.srcBytes.delete(longest);
        continue;
      }
      w.queueBytes -= f.length;
      this._srcAdd(w, longest, -f.length);
      this.stats.dropped++;
      this.stats.evicted++;
      if (!q.length) {
        w.queues.delete(longest);
        const i = w.rr.indexOf(longest);
        if (i >= 0) w.rr.splice(i, 1);
      }
    }
    if (!w.queues.has(sourceId)) {
      w.queues.set(sourceId, []);
      w.rr.push(sourceId);
    }
    w.queues.get(sourceId).push(frameBytes);
    w.queueBytes += frameBytes.length;
    this._srcAdd(w, sourceId, frameBytes.length);
    this._pump();
  }

  _srcAdd(w, src, n) {
    if (!w.srcBytes) w.srcBytes = new Map();
    const v = (w.srcBytes.get(src) || 0) + n;
    if (v > 0) w.srcBytes.set(src, v);
    else w.srcBytes.delete(src);
  }

  _pump() {
    if (this._pumpTimer) return;
    this._pumpTimer = this.setT(() => {
      this._pumpTimer = null;
      this._drain();
    }, 0);
  }

  _drain() {
    const allow = this.relayAllowance();
    let more = false;
    const t = this.now();
    for (const w of this.wires.values()) {
      if (!w.queueBytes) continue;
      if (!allow) {
        w.queues.clear();
        if (w.srcBytes) w.srcBytes.clear();
        w.rr = [];
        w.queueBytes = 0;
        continue;
      }
      // The bucket holds one second of budget, or one largest frame when that is more (Android: 8 KiB/s).
      w.tokens = Math.min(Math.max(allow.rate, FRAME_MAX), w.tokens + ((t - w.lastFill) / 1000) * allow.rate);
      w.lastFill = t;
      // Round robin over the neighbours that fed this queue (the order persists across drains): with k
      // sources, each gets at most 1/k of this neighbour's budget while the others have frames waiting.
      const cap = (relayBudget(this.deviceClass, this.policy) || { sessionCap: 0 }).sessionCap;
      let guard = 0;
      while (w.queueBytes > 0 && w.rr.length && guard++ < 100000) {
        const src = w.rr[0];
        const q = w.queues.get(src);
        if (!q || !q.length) {
          w.rr.shift();
          w.queues.delete(src);
          continue;
        }
        const f = q[0];
        if (f.length > w.tokens) break;
        if (this.relayed + f.length > cap) {
          w.queues.clear();
          if (w.srcBytes) w.srcBytes.clear();
          w.rr = [];
          w.queueBytes = 0;
          break;
        }
        q.shift();
        w.queueBytes -= f.length;
        this._srcAdd(w, src, -f.length);
        w.tokens -= f.length;
        this.relayed += f.length;
        this.stats.relayed++;
        this._rawSend(w, f);
        w.rr.push(w.rr.shift());
        if (!q.length) {
          w.rr.pop();
          w.queues.delete(src);
        }
      }
      if (w.queueBytes > 0) more = true;
    }
    if (more && !this._pumpTimer) {
      this._pumpTimer = this.setT(() => {
        this._pumpTimer = null;
        this._drain();
      }, PUMP_MS);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Send (own frames)
  // -------------------------------------------------------------------------------------------

  /**
   * stamped(type, { flags = 0, body, bits?, signal }) -> Promise<frame bytes> with a minted relay stamp
   * (10 bits, or chatBits for the stranger flag) and today's day.
   */
  async stamped(type, { flags = 0, body, bits, signal = null, day } = {}) {
    const f = encode(type, { flags, day: day === undefined ? headerDay(this.now()) : day }, body);
    const b = bits === undefined ? requiredBits(flags, this.chatBits) : bits;
    const nonce = await mint(frameIdOf(f), b, { signal });
    return withNonce(f, nonce);
  }

  /**
   * send(frameBytes, { to?, tag? }) -> { reached, route, frameId }. to: the recipient's chat key (sent on its wire at once
   * when it is a neighbour); tag: interest routing (the routed wires plus a random half of the others); otherwise a random
   * half of the neighbours, at least two (PRIV-1). A frame that does not go straight to its recipient leaves at a random
   * hop (0 to 2, the frameId does not change) and, when more than one neighbour could carry it, after the 0.5 to 3 s
   * first-send jitter, so its first neighbours cannot tell it from a relayed frame by hop or timing alone (PRIV-1, STALK-7).
   */
  send(frameBytes, { to = null, tag = null } = {}) {
    const d = decode(frameBytes);
    if (d.error) throw new TypeError('send: invalid frame (' + d.error + ')');
    const idHex = hex.encode(frameIdOf(d));
    const entry = this.seen.get(idHex) || this.seen.add(idHex, null);
    let targets = [];
    let route = 'none';
    const eligible = this._eligible(null);
    if (to) {
      const direct = eligible.filter((w) => w.remote === to);
      if (direct.length) {
        targets = [direct[0]];
        route = 'direct';
      }
    }
    if (!targets.length && tag) {
      const r = this._routedTargets(eligible, tag);
      if (r.targets) {
        targets = r.targets;
        route = 'routed';
      }
    }
    if (!targets.length && eligible.length) {
      targets = eligible.length <= 2 ? eligible.slice() : this._randomHalf(eligible);
      if (targets.length < 2 && eligible.length >= 2) targets = eligible.slice(0, 2);
      route = 'flood';
    }
    for (const w of targets) entry.fwd.add(w.id);
    if (route === 'direct' || !targets.length) {
      for (const w of targets) this._rawSend(w, frameBytes);
      return { reached: targets.length, route, frameId: idHex };
    }
    const limit = HOP_LIMIT[d.type] || 0;
    const top = Math.max(0, Math.min(OWN_HOP_MAX, limit - 2));
    const hop = Math.floor(this.random() * (top + 1));
    const out = hop === d.header.hop ? frameBytes : withHop(frameBytes, hop);
    if (eligible.length > 1) {
      const delay = RELAY_JITTER_MIN_MS + Math.floor(this.random() * (RELAY_JITTER_MAX_MS - RELAY_JITTER_MIN_MS + 1));
      const list = targets.slice();
      this._later(() => {
        if (!this.enabled) return;
        for (const w of list) this._rawSend(w, out);
      }, delay);
    } else {
      for (const w of targets) this._rawSend(w, out);
    }
    return { reached: targets.length, route, frameId: idHex };
  }

  /**
   * sendWant(entries) -> wire id used or null: one WANT-TAGS frame to a neighbour other than the one this
   * page has received the most from (when there are two or more).
   */
  sendWant(entries) {
    const peers = this._eligible(null);
    if (!peers.length) return null;
    let pick = peers;
    if (peers.length > 1) {
      let top = peers[0];
      for (const w of peers) if (w.bytesIn > top.bytesIn) top = w;
      pick = peers.filter((w) => w !== top);
    }
    const w = pick[Math.floor(this.random() * pick.length)];
    this._rawSend(w, encode(T.WANT, { day: headerDay(this.now()) }, wantBody(entries)));
    return w.id;
  }

  /** Answers holder traffic for tests and the service: HELD bodies to one wire. */
  sendHeld(wireId, frames) {
    for (const body of packHeld(frames)) this.sendTo(wireId, encode(T.HELD, { day: headerDay(this.now()) }, body));
  }

  // -------------------------------------------------------------------------------------------
  // The separate chat lane
  // -------------------------------------------------------------------------------------------

  _rendezvousSpeakers() {
    let n = 0;
    for (const w of this.wires.values()) if (w.swarm === 'rendezvous' && w.helloGot && !w.closed) n++;
    return n;
  }

  async _checkLane() {
    if (!this.enabled) return;
    const need = this._rendezvousSpeakers() < LANE_MIN_RENDEZVOUS;
    if (need && !this.laneJoined && !this._laneJoining) {
      if (!this.ownTracker || !this.tm || typeof this.tm.joinLane !== 'function') return;
      this._laneJoining = true;
      try {
        const infoHash = await chatLaneInfoHash(this.ledgerId);
        if (!this.enabled || this._rendezvousSpeakers() >= LANE_MIN_RENDEZVOUS) return;
        // Only the site's own tracker: the lane is never announced to the public default trackers (MF-44;
        // TorrentManager.joinLane drops public trackers as well).
        this.laneJoined = await this.tm.joinLane({ kind: 'chat', infoHash, announce: [this.ownTracker] });
        this._emit('lane', { joined: true, infoHash });
      } catch (_) {
        this.laneJoined = null;
      } finally {
        this._laneJoining = false;
      }
    } else if (!need && this.laneJoined) {
      this._leaveLane();
    }
  }

  _leaveLane() {
    const h = this.laneJoined;
    this.laneJoined = null;
    if (h) {
      try { typeof h.leave === 'function' ? h.leave() : (typeof h.destroy === 'function' && h.destroy()); } catch (_) { /* gone */ }
      this._emit('lane', { joined: false });
    }
  }
}

