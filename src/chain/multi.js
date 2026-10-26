// The hub follow lane, extension 'mw_chain2' (V03-DESIGN-REVIEW 3.1, 3.2.2, 3.2.3; MF-65; ARCHITECTURE
// 15.8; INTERFACES v0.3 multi.js). v0.3.
//
// One or a few hub-wide swarms carry every personal and group ledger of a hub: the lane's infohash is
// sha1(utf8("mw-hub-lane1|" + hubSuffix + "|" + shard)) (laneInfoHash), shard 0 by default; an operator
// who raises the shard count (a power of two) puts each ledger on shardOf(ledgerId, shards) and a tab
// joins the shard of its own ledger id. wire-ext.js registers the extension on the lane torrent's wires
// (attachToTorrent(torrent, multiGossip, { name: EXT_NAME_2 })); a MultiGossip is the peer interface
// (attach, detach, handle) the adapter needs.
//
// Frames: byte 0 = type, the rest UTF-8 JSON, at most FRAME_MAX (15 KiB). Every frame except HAVE
// carries `ledger` (the ledger id it is about).
//   1-6  HELLO, WANT, BLOCKS, ANN, SYNC, INV  the mw_chain1 frames (gossip.js) with the ledger field and
//                                             the same bounds (MF-73)
//   7    RECENT request { ledger, fromDepth, posts?, rid }  blocks at or above fromDepth (-1: the depth
//                                             of the newest `posts` payload blocks, 1 to 200), newest first,
//                                             with every control block of the ledger (recent.js)
//        RECENT answer  { ledger, rid, b: [Block...], more, cp?, truncated? }  paged; the first page may
//                                             name the checkpoint state S that follows as SNAP parts:
//                                             cp = { h, snap, parts, bytes }, and says truncated: true when
//                                             the window lost its oldest control blocks to the cap
//   8    HAVE { ledgers: [<= 256 ids], more?, full? }  which ledgers this peer holds windows of (additive);
//                                             full: true lists ledgers it holds in full (hold())
//   9    SNAP { ledger, rid, snap, part, parts, data }  canonical(S) in parts of at most 12,000
//                                             characters, at most 512 parts; S must hash to snap
// Budgets per wire as mw_chain1 (gossip.js): unsolicited frames 64 KiB/s, solicited data (answers to our
// RECENT and WANT) 1 MiB/s, both charged or checked before parsing; answers paced at 768 KiB/s; RECENT
// requests answered at most 2 per second per wire (bursts of 8, at most 8 more waiting; a window computed
// once per 2 s is reused);
// blocks for a followed ledger are taken only when we asked for them; more than 50 malformed frames,
// invalid blocks or unasked answers ignore the wire (its transport is told). Code review v0.3: a block the
// view refuses because its key has no standing (recent.js admission) counts against the wire too, and a
// peer is credited (delivered, which _pickPeer prefers) only for the blocks the view kept. Frames 1-6 skip
// the lane budget only when they open with the ledger field of a held ledger and parse to that same ledger
// (a second "ledger" key used to move a frame to the followed path without any charge).
//
// Modes. A followed ledger (follow()) is kept as a recent window in the view of its ChainNode
// (recent.js viewOf): the scheduler pulls RECENT windows, at most maxActive (4, chosen) ledgers at a
// time per tab, from a peer that HAVEs the ledger (a peer that has delivered before first), retries
// another peer after 15 s, and refreshes a window every 30 minutes with the newest 20 posts (review round,
// DS-3); ANN of new blocks on the lane brings them into the view (WANT, BLOCKS). A private follow
// (follow(id, { private: true }), STALK-3) is never listed in HAVE and is asked for only among decoy
// requests of the same shape. A wire gets one RECENT answer per ledger per minute and a checkpoint state
// once (SCALE-11). A held ledger (hold(): the member's own ledger, a ledger opened in
// full) keeps the full mw_chain1 protocol: frames 1-6 for it reach its node's Gossip through a virtual
// peer per wire (at most 8 per wire, closed after 60 s idle), whose frames go back with the ledger field;
// a new head is announced on the lane (ANN) to peers that hold it.
// Caps (chosen; gate rows confirm): follows 250 on phones and 1,000 on desktops (follow() beyond throws
// E_LIMIT, "You follow 250 of 250 on this phone."); phones pull, then disconnect: once nothing is due or
// syncing the lane keeps at most 2 wires, and none while the page is hidden (setHidden(true));
// wantedWires tells the loader how many lane wires to keep (desktop 40, phones 8 while syncing).
//
// No Buffer, no node: imports, no post-floor APIs.

import { utf8, hex, byteLength, canonicalize } from './canonical.js';
import { sha256Sync } from './sha256-sync.js';
import {
  Bucket, validFrame, encode as encodeChain, decode as decodeChain, FRAME_MAX, MAX_LEDGER_BLOCKS, INVALID_REASONS,
} from './gossip.js';
import { checkpointSnap } from './state.js';
import { redact } from './block.js';
import { RECENT_POSTS, MAX_WINDOW_BLOCKS, recentWindow, applyWindow, viewOf } from './recent.js';
import { topoSort } from './node.js';

export const EXT_NAME_2 = 'mw_chain2';
export const LANE_MSG = Object.freeze({ HELLO: 1, WANT: 2, BLOCKS: 3, ANN: 4, SYNC: 5, INV: 6, RECENT: 7, HAVE: 8, SNAP: 9 });
export const LANE_PREFIX = 'mw-hub-lane1|';
export const MAX_HAVE = 256;
export const SNAP_CHUNK = 12000;
export const MAX_SNAP_PARTS = 512;
export const FOLLOW_CAPS = Object.freeze({ phone: 250, desktop: 1000 });

export const DEFAULT_LANE_LIMITS = Object.freeze({
  maxActive: 4, // ledgers syncing at once per tab (chosen; R 3.2.2)
  posts: RECENT_POSTS,
  recentTimeoutMs: 15000,
  recentTries: 3,
  refreshMs: 1800000, // review round (DS-3): ANN keeps a window current; the scheduled pull is a catch-up
  refreshPosts: 20, // review round (DS-3): a refresh asks for the newest 20 posts (and what is above), not 200
  fullSyncMs: 30000,
  followCap: FOLLOW_CAPS,
  wires: Object.freeze({ phone: 8, desktop: 40 }),
  phoneIdleWires: 2,
  maxHavePerPeer: 2048,
  maxVirtualPerWire: 8,
  virtualIdleMs: 60000,
  recentRequestRate: 2, // RECENT requests one wire may have us answer per second, bursts of 8 (each
  recentRequestBurst: 8, //   computes a window; chosen: an honest tab asks at most 4 at a time)
  recentRequestQueue: 8, // requests over the rate wait here (beyond: dropped)
  windowCacheMs: 2000, // the same window is computed at most once per this long
  recentRepeatMs: 60000, // review round (SCALE-11): one wire gets one answer per ledger per this long
  privateDecoys: 3, // review round (STALK-3): RECENT requests for decoy ledgers sent with a private follow's
  maxWindowBlocks: MAX_WINDOW_BLOCKS, // blocks one RECENT answer of ours carries at most (beyond: truncated)
  maxAskedPerPeer: 256,
  unsolicitedRate: 65536,
  unsolicitedBurst: 65536,
  solicitedRate: 1048576,
  solicitedBurst: 1048576,
  egressRate: 786432,
  egressBurst: 786432,
  maxEgressBytes: 4194304,
  maxInvalid: 50,
  maxHeld: 16,
});

const TYPES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
const HEX64 = /^[0-9a-f]{64}$/;
const LEDGER_RE = /^[A-Za-z0-9:._-]{1,128}$/;
const INVALID = new Set(INVALID_REASONS);
const MAX_RID = 2147483647;

const isUint = (x) => Number.isSafeInteger(x) && x >= 0;
const isHex64 = (x) => typeof x === 'string' && HEX64.test(x);
const isLedger = (x) => typeof x === 'string' && LEDGER_RE.test(x);

function isPlainObject(x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

function unrefTimeout(fn, ms) {
  const t = setTimeout(fn, ms);
  if (t && typeof t === 'object' && typeof t.unref === 'function') t.unref();
  return t;
}

function callHook(fn, ...args) {
  if (typeof fn !== 'function') return undefined;
  try {
    return fn(...args);
  } catch (_) {
    return undefined;
  }
}

function coded(code, message, extra) {
  const err = new Error(message || code);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

/** laneInfoHash(hubSuffix, shard = 0) -> Promise<40 hex>: sha1(utf8("mw-hub-lane1|" + hubSuffix + "|" + shard)). */
export async function laneInfoHash(hubSuffix, shard = 0) {
  const suffix = String(hubSuffix || '').trim().toLowerCase().replace(/\.$/, '');
  if (!suffix) throw new TypeError('laneInfoHash needs a hub suffix');
  if (!isUint(shard)) throw new TypeError('the shard is an unsigned integer');
  const d = await globalThis.crypto.subtle.digest('SHA-1', utf8.encode(LANE_PREFIX + suffix + '|' + shard));
  return hex.encode(new Uint8Array(d));
}

/** shardOf(ledgerId, shards = 1) -> the shard (0 .. shards - 1) of a ledger; shards is a power of two. */
export function shardOf(ledgerId, shards = 1) {
  if (!Number.isSafeInteger(shards) || shards < 1 || (shards & (shards - 1)) !== 0) throw new TypeError('shards is a power of two');
  const d = sha256Sync(utf8.encode(String(ledgerId)));
  const n = ((d[0] << 24) >>> 0) + (d[1] << 16) + (d[2] << 8) + d[3];
  return n % shards;
}

// ---------------------------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------------------------

function recentOk(o) {
  if (!isUint(o.rid) || o.rid > MAX_RID) return false;
  if (o.b === undefined) {
    if (!Number.isSafeInteger(o.fromDepth) || o.fromDepth < -1 || o.fromDepth >= MAX_LEDGER_BLOCKS) return false;
    return o.posts === undefined || (Number.isSafeInteger(o.posts) && o.posts >= 1 && o.posts <= RECENT_POSTS);
  }
  if (!Array.isArray(o.b) || !o.b.every(isPlainObject) || typeof o.more !== 'boolean') return false;
  if (o.truncated !== undefined && typeof o.truncated !== 'boolean') return false;
  if (o.cp !== undefined) {
    const c = o.cp;
    if (!isPlainObject(c) || !isHex64(c.h) || !isHex64(c.snap) || !Number.isSafeInteger(c.parts) || c.parts < 1 || c.parts > MAX_SNAP_PARTS) return false;
    if (!isUint(c.bytes) || c.bytes > MAX_SNAP_PARTS * SNAP_CHUNK * 4) return false;
  }
  return true;
}

const LANE_VALIDATORS = {
  [LANE_MSG.RECENT]: (o) => isLedger(o.ledger) && recentOk(o),
  [LANE_MSG.HAVE]: (o) => Array.isArray(o.ledgers) && o.ledgers.length <= MAX_HAVE && o.ledgers.every(isLedger) &&
    (o.more === undefined || typeof o.more === 'boolean') && (o.full === undefined || typeof o.full === 'boolean'),
  [LANE_MSG.SNAP]: (o) => isLedger(o.ledger) && isUint(o.rid) && o.rid <= MAX_RID && isHex64(o.snap) &&
    Number.isSafeInteger(o.parts) && o.parts >= 1 && o.parts <= MAX_SNAP_PARTS && isUint(o.part) && o.part < o.parts &&
    typeof o.data === 'string' && o.data.length <= SNAP_CHUNK,
};

/** encodeLane(type, obj) -> Uint8Array; RangeError { code: 'E_FRAME' } above FRAME_MAX bytes. */
export function encodeLane(type, obj) {
  if (!TYPES.has(type)) throw new TypeError('unknown lane message type ' + type);
  const json = JSON.stringify(obj);
  if (typeof json !== 'string' || json[0] !== '{') throw new TypeError('lane payload must be a JSON object');
  const body = utf8.encode(json);
  if (body.length + 1 > FRAME_MAX) {
    const err = new RangeError('lane frame of ' + (body.length + 1) + ' bytes exceeds ' + FRAME_MAX);
    err.code = 'E_FRAME';
    throw err;
  }
  const out = new Uint8Array(body.length + 1);
  out[0] = type;
  out.set(body, 1);
  return out;
}

/** decodeLane(u8) -> { type, obj } | null: a well-formed lane frame (the ledger field on every frame but HAVE). */
export function decodeLane(u8) {
  let bytes;
  if (u8 instanceof Uint8Array) bytes = u8;
  else if (u8 instanceof ArrayBuffer) bytes = new Uint8Array(u8);
  else if (u8 && ArrayBuffer.isView(u8)) bytes = new Uint8Array(u8.buffer, u8.byteOffset, u8.byteLength);
  else return null;
  if (bytes.length < 3 || bytes.length > FRAME_MAX) return null;
  const type = bytes[0];
  if (!TYPES.has(type)) return null;
  let obj;
  try {
    obj = JSON.parse(utf8.decode(bytes.subarray(1), { fatal: true }));
  } catch (_) {
    return null;
  }
  if (!isPlainObject(obj)) return null;
  if (type <= 6) return isLedger(obj.ledger) && validFrame(type, obj) ? { type, obj } : null;
  return LANE_VALIDATORS[type](obj) ? { type, obj } : null;
}

function withoutLedger(obj) {
  const out = {};
  for (const k of Object.keys(obj)) if (k !== 'ledger') out[k] = obj[k];
  return out;
}

function itemJson(b) {
  const o = { e: b.e, h: b.h, s: b.s };
  if (b.v !== undefined) {
    o.v = b.v;
    if (b.z !== undefined) o.z = b.z;
  }
  return JSON.stringify(o);
}

// Packs blocks into frames: build(items, last, index) -> obj, each frame at most FRAME_MAX bytes. The room
// for the frame's own fields is measured on build([], false, 0), so the first page's extras fit too.
// Empty frames are left out unless allowEmpty (a RECENT answer with nothing in it still says more: false).
function packFrames(type, blocks, build, { allowEmpty = false } = {}) {
  const frames = [];
  let items = [];
  const base = byteLength(JSON.stringify(build([], false, 0))) + 1 + 16;
  let size = base;
  const flush = () => {
    frames.push(encodeLane(type, build(items, false, frames.length)));
    items = [];
    size = base;
  };
  const pending = [];
  for (const b of blocks) {
    let json;
    try {
      json = itemJson(b);
    } catch (_) {
      continue;
    }
    const n = byteLength(json) + 1;
    if (base + n > FRAME_MAX) continue; // a block above the frame cap travels nowhere
    pending.push({ json, n });
  }
  for (let i = 0; i < pending.length; i++) {
    const x = pending[i];
    if (size + x.n > FRAME_MAX && items.length > 0) flush();
    items.push(JSON.parse(x.json));
    size += x.n;
  }
  if (items.length > 0) frames.push(encodeLane(type, build(items, true, frames.length)));
  else if (allowEmpty) frames.push(encodeLane(type, build([], true, frames.length)));
  return frames;
}

// canonical(S) cut into SNAP parts: each at most SNAP_CHUNK characters and each frame within FRAME_MAX
// once JSON escaping is counted (quotes in S grow); null when S needs more than MAX_SNAP_PARTS parts.
function snapParts(ledger, rid, cp) {
  const text = canonicalize(cp.S);
  const parts = [];
  let i = 0;
  while (i < text.length) {
    let len = SNAP_CHUNK;
    for (;;) {
      try {
        encodeLane(LANE_MSG.SNAP, { ledger, rid, snap: cp.snap, part: MAX_SNAP_PARTS - 1, parts: MAX_SNAP_PARTS, data: text.slice(i, i + len) });
        break;
      } catch (_) {
        len = Math.floor(len / 2);
        if (len < 64) return null;
      }
    }
    parts.push(text.slice(i, i + len));
    i += len;
    if (parts.length > MAX_SNAP_PARTS) return null;
  }
  return parts.length > 0 ? parts : null;
}

// ---------------------------------------------------------------------------------------------
// MultiGossip
// ---------------------------------------------------------------------------------------------

export class MultiGossip {
  /**
   * new MultiGossip({ hubSuffix, shard = 0, ledgers: Map<ledgerId, ChainNode>, limits, deviceClass = 'desktop',
   *   now, setTimeoutFn, clearTimeoutFn, onChange, onView, random })
   * ledgers: the member's ChainNodes by ledger id (its own ledger and one per followed ledger; read on
   * demand, so the caller may add nodes later). onView(ledgerId, view) after a window was applied.
   */
  constructor(options) {
    const o = options || {};
    if (typeof o.hubSuffix !== 'string' || !o.hubSuffix) throw new TypeError('MultiGossip needs a hubSuffix');
    this.hubSuffix = o.hubSuffix.trim().toLowerCase().replace(/\.$/, '');
    this.shard = isUint(o.shard) ? o.shard : 0;
    this.ledgers = o.ledgers instanceof Map ? o.ledgers : new Map();
    this.deviceClass = o.deviceClass === 'phone' ? 'phone' : 'desktop';
    const lim = Object.assign({}, DEFAULT_LANE_LIMITS, o.limits || {});
    lim.followCap = Object.assign({}, DEFAULT_LANE_LIMITS.followCap, (o.limits && o.limits.followCap) || {});
    lim.wires = Object.assign({}, DEFAULT_LANE_LIMITS.wires, (o.limits && o.limits.wires) || {});
    this.limits = lim;
    this.now = typeof o.now === 'function' ? o.now : () => Date.now();
    this._random = typeof o.random === 'function' ? o.random : Math.random; // decoy choice (STALK-3)
    this._setTimeout = typeof o.setTimeoutFn === 'function' ? o.setTimeoutFn : unrefTimeout;
    this._clearTimeout = typeof o.clearTimeoutFn === 'function' ? o.clearTimeoutFn : (t) => clearTimeout(t);
    this._onChange = typeof o.onChange === 'function' ? o.onChange : null;
    this._onView = typeof o.onView === 'function' ? o.onView : null;
    this._peers = new Map();
    this._follow = new Map(); // ledgerId -> { since, lastSync, tries, state: 'due' | 'active' | 'idle', tried: Set }
    this._held = new Map(); // ledgerId -> { root, active, since }
    this._active = new Set();
    this._rid = 0;
    this._hidden = false;
    this._destroyed = false;
    this._infoHash = null;
    this._windows = new Map(); // ledger|posts|fromDepth -> { at, root, window }
    this._s = {
      in: 0, out: 0, malformed: 0, invalid: 0, dropped: 0, refused: 0, killed: 0, recentAsked: 0, recentDone: 0,
      recentFailed: 0, served: 0, snapsServed: 0, snapsTaken: 0,
    };
  }

  /** infoHash() -> Promise<40 hex> of this lane's swarm. */
  infoHash() {
    if (!this._infoHash) this._infoHash = laneInfoHash(this.hubSuffix, this.shard);
    return this._infoHash;
  }

  get stats() {
    return Object.assign({}, this._s, {
      attached: this._peers.size, active: this._active.size, followed: this._follow.size, held: this._held.size,
      due: this._dueList().length,
    });
  }

  get followed() {
    return this._follow.size;
  }

  get hidden() {
    return this._hidden;
  }

  /** How many lane wires the loader should keep (0 hidden; phones: 2 once current, 8 while syncing; desktops 40). */
  get wantedWires() {
    if (this._hidden) return 0;
    if (this.deviceClass === 'phone') return this._idle() ? this.limits.phoneIdleWires : this.limits.wires.phone;
    return this.limits.wires.desktop;
  }

  /** True while a followed ledger is behind (a pull runs or is due); the loader gives the hub lane first place then (SCALE-6). */
  get syncing() {
    return !this._hidden && !this._idle();
  }

  /** Every ledger this tab holds a window of (what HAVE lists; ledgers held in full are listed with full: true). */
  holdings() {
    const out = [];
    for (const [id, f] of this._follow) if (f.lastSync > -Infinity && !this._held.has(id) && !f.private) out.push(id);
    return out;
  }

  view(ledgerId) {
    const node = this.ledgers.get(ledgerId);
    return node ? viewOf(node) : null;
  }

  peerInfo(id) {
    const p = this._peers.get(id);
    if (!p) return null;
    return {
      id: p.id, group: p.group, ignored: p.ignored, invalid: p.invalid, delivered: p.delivered, has: p.has.size,
      requests: p.requests.size, virtual: p.vpeers.size, queuedBytes: p.outBytes,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Follows
  // ---------------------------------------------------------------------------------------------

  /**
   * follow(ledgerId, { private }) -> true: keep a recent window of that ledger (its ChainNode must be in `ledgers`).
   * Error code E_LIMIT (reason 'follow-cap', cap, count) beyond the device class's follow cap. Review round (STALK-3):
   * a private follow is never listed in HAVE, and its window is asked of a peer only together with privateDecoys
   * RECENT requests for other ledgers that peer HAVEs (the same shape; their answers are dropped), so no lane
   * neighbour learns it from this tab alone.
   */
  follow(ledgerId, { private: isPrivate = false } = {}) {
    if (!isLedger(ledgerId)) throw new TypeError('follow needs a ledger id');
    if (!this.ledgers.has(ledgerId)) throw new TypeError('follow needs a ChainNode for ' + ledgerId + ' in ledgers');
    if (this._follow.has(ledgerId)) {
      if (isPrivate === true) this._follow.get(ledgerId).private = true;
      return true;
    }
    const cap = this.limits.followCap[this.deviceClass];
    if (this._follow.size >= cap) {
      const where = this.deviceClass === 'phone' ? 'on this phone' : 'on this computer';
      throw coded('E_LIMIT', 'You follow ' + this._follow.size + ' of ' + cap + ' ' + where + '.', { reason: 'follow-cap', cap, count: this._follow.size });
    }
    this._follow.set(ledgerId, { since: this.now(), lastSync: -Infinity, tries: 0, state: 'due', tried: new Set(), private: isPrivate === true });
    this._changed();
    this._pumpSchedule();
    return true;
  }

  unfollow(ledgerId) {
    const f = this._follow.get(ledgerId);
    if (!f) return false;
    this._follow.delete(ledgerId);
    this._active.delete(ledgerId);
    for (const p of this._peers.values()) {
      for (const [rid, req] of p.requests) if (req.ledger === ledgerId) p.requests.delete(rid);
    }
    this._changed();
    this._pumpSchedule();
    return true;
  }

  /**
   * hold(ledgerId) -> true: keep that ledger in full over the lane (the member's own ledger, a ledger
   * opened in full): its node's Gossip runs mw_chain1 through virtual peers, and new heads are announced.
   */
  hold(ledgerId) {
    if (!isLedger(ledgerId)) throw new TypeError('hold needs a ledger id');
    const node = this.ledgers.get(ledgerId);
    if (!node || !node.gossip) throw new TypeError('hold needs an open ChainNode for ' + ledgerId);
    if (this._held.has(ledgerId)) return true;
    if (this._held.size >= this.limits.maxHeld) throw coded('E_LIMIT', 'too many ledgers held in full on this lane', { reason: 'held-cap' });
    this._held.set(ledgerId, { root: node.dag.root(), active: false, since: this.now() });
    for (const p of this._peers.values()) {
      this._sendHave(p, [ledgerId], true);
      if (p.full.has(ledgerId)) this._virtual(p, ledgerId);
    }
    this._changed();
    return true;
  }

  release(ledgerId) {
    const h = this._held.get(ledgerId);
    if (!h) return false;
    this._held.delete(ledgerId);
    for (const p of this._peers.values()) this._dropVirtual(p, ledgerId);
    this._active.delete(ledgerId);
    this._changed();
    return true;
  }

  /** setHidden(hidden): a hidden page keeps no lane wire (phones especially); new wires are refused meanwhile. */
  setHidden(hidden) {
    this._hidden = hidden === true;
    if (this._hidden) for (const p of Array.from(this._peers.values())) this._kill(p, 'hidden');
    this._changed();
  }

  // ---------------------------------------------------------------------------------------------
  // Peers
  // ---------------------------------------------------------------------------------------------

  /** attach({ id, send, close?, group?, ignored?(reason) }) -> true, or false when refused (hidden, phone wire cap). */
  attach(peer) {
    if (this._destroyed) return false;
    if (!peer || typeof peer.send !== 'function' || peer.id === undefined || peer.id === null) throw new TypeError('attach expects { id, send(u8) }');
    const id = String(peer.id);
    if (this._peers.has(id)) this.detach(id);
    const onIgnored = typeof peer.ignored === 'function' ? peer.ignored : null;
    if (this._hidden || this._peers.size >= this.wantedWires) {
      this._s.refused++;
      callHook(onIgnored, this._hidden ? 'hidden' : 'lane-wires');
      return false;
    }
    const L = this.limits;
    const now = this.now;
    const p = {
      id,
      group: peer.group !== undefined && peer.group !== null && String(peer.group) !== '' ? String(peer.group) : id,
      send: peer.send,
      close: typeof peer.close === 'function' ? peer.close : null,
      onIgnored,
      ignored: false,
      invalid: 0,
      delivered: 0,
      attachedAt: now(),
      lastFrameAt: null,
      unsol: new Bucket(L.unsolicitedRate, L.unsolicitedBurst, now),
      sol: new Bucket(L.solicitedRate, L.solicitedBurst, now),
      out: new Bucket(L.egressRate, L.egressBurst, now),
      recentReq: new Bucket(L.recentRequestRate, L.recentRequestBurst, now),
      recentWait: [], // RECENT requests over the rate, answered from tick()
      outQueue: [],
      outBytes: 0,
      drainTimer: null,
      has: new Set(),
      full: new Set(), // ledgers the peer holds in full (HAVE full: true)
      requests: new Map(), // rid -> our RECENT request to this peer
      asked: new Map(), // ledger + '|' + h -> at: lane WANTs for followed ledgers
      vpeers: new Map(), // ledger -> { id, lastAt }
      served: new Map(), // ledger -> { at, root }: our last answer to this wire's RECENT for it (SCALE-11)
      snapSent: new Set(), // ledger|snap of checkpoint states this wire got from us (SCALE-11)
    };
    this._peers.set(id, p);
    this._sendHave(p, Array.from(this._held.keys()), true);
    this._sendHave(p, this.holdings());
    this._changed();
    this._pumpSchedule();
    return true;
  }

  detach(peerId) {
    const p = this._peers.get(peerId);
    if (!p) return false;
    this._peers.delete(peerId);
    if (p.drainTimer !== null) this._clearTimeout(p.drainTimer);
    p.drainTimer = null;
    for (const ledger of Array.from(p.vpeers.keys())) this._dropVirtual(p, ledger);
    for (const req of p.requests.values()) this._failRequest(req, 'detached');
    p.requests.clear();
    if (p.close) {
      try {
        p.close();
      } catch (_) {
        // the transport is gone
      }
    }
    this._changed();
    this._pumpSchedule();
    return true;
  }

  _kill(p, reason) {
    this._s.killed++;
    callHook(p.onIgnored, reason);
    this.detach(p.id);
  }

  _strike(p, n) {
    p.invalid += n;
    this._s.invalid += n;
    if (!p.ignored && p.invalid > this.limits.maxInvalid) {
      p.ignored = true;
      for (const req of p.requests.values()) this._failRequest(req, 'ignored');
      p.requests.clear();
      for (const ledger of Array.from(p.vpeers.keys())) this._dropVirtual(p, ledger);
      callHook(p.onIgnored, 'invalid');
      this._changed();
    }
  }

  _changed() {
    callHook(this._onChange);
  }

  _transmit(p, frame) {
    try {
      p.send(frame);
      this._s.out++;
    } catch (_) {
      // the transport closed
    }
  }

  // Answers (RECENT pages, SNAP parts, BLOCKS): paced below the receiver's solicited budget.
  _enqueue(p, frames) {
    for (const frame of frames) {
      if (p.outBytes + frame.length > this.limits.maxEgressBytes) {
        this._s.dropped++;
        return false;
      }
      p.outQueue.push(frame);
      p.outBytes += frame.length;
    }
    this._drain(p);
    return true;
  }

  _drain(p) {
    if (this._destroyed || this._peers.get(p.id) !== p) return;
    while (p.outQueue.length > 0) {
      const frame = p.outQueue[0];
      if (!p.out.take(frame.length)) {
        if (p.drainTimer === null) {
          p.drainTimer = this._setTimeout(() => {
            p.drainTimer = null;
            this._drain(p);
          }, Math.max(10, p.out.msUntil(frame.length)));
        }
        return;
      }
      p.outQueue.shift();
      p.outBytes -= frame.length;
      this._transmit(p, frame);
    }
  }

  _sendHave(p, ledgers, full = false) {
    if (p.ignored) return;
    const list = Array.from(new Set(ledgers)).filter(isLedger);
    for (let i = 0; i < list.length; i += MAX_HAVE) {
      const page = { ledgers: list.slice(i, i + MAX_HAVE) };
      if (i + MAX_HAVE < list.length) page.more = true;
      if (full) page.full = true;
      this._transmit(p, encodeLane(LANE_MSG.HAVE, page));
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Frames
  // ---------------------------------------------------------------------------------------------

  /** handle(peerId, u8) -> Promise: one lane frame from a peer. Never throws. */
  async handle(peerId, u8) {
    const p = this._peers.get(peerId);
    if (!p || this._destroyed) return;
    let bytes = null;
    if (u8 instanceof Uint8Array) bytes = u8;
    else if (u8 instanceof ArrayBuffer) bytes = new Uint8Array(u8);
    else if (u8 && ArrayBuffer.isView(u8)) bytes = new Uint8Array(u8.buffer, u8.byteOffset, u8.byteLength);
    const len = bytes ? bytes.length : 0;
    this._s.in++;
    p.lastFrameAt = this.now();
    if (p.ignored) return;
    if (!bytes || len < 3 || len > FRAME_MAX || !TYPES.has(bytes[0])) {
      this._s.malformed++;
      this._strike(p, 1);
      return;
    }
    // Budget before parsing (as mw_chain1): answers to what we asked use the solicited bucket, frames 1-6
    // for a held ledger with a virtual peer on this wire are charged by that ledger's Gossip, the rest
    // (a virtual peer's creation included) are unsolicited.
    const t0 = bytes[0];
    let bucket = p.unsol;
    const heldLedger = t0 <= 6 ? this._heldMode(bytes) : null;
    if (heldLedger !== null && p.vpeers.has(heldLedger)) bucket = null;
    else if ((t0 === LANE_MSG.RECENT || t0 === LANE_MSG.SNAP) && p.requests.size > 0) bucket = p.sol;
    else if (t0 === LANE_MSG.BLOCKS && p.asked.size > 0) bucket = p.sol;
    if (bucket !== null && !bucket.take(len)) {
      this._s.dropped++;
      return;
    }
    const msg = decodeLane(bytes);
    if (!msg) {
      this._s.malformed++;
      this._strike(p, 1);
      return;
    }
    const { type, obj } = msg;
    if (bucket === null && obj.ledger !== heldLedger) {
      // Charged nothing as a held ledger's frame, but it parses to another ledger (a second "ledger" key): it pays
      // as an unsolicited frame, counts against the wire, and is not handled.
      p.unsol.take(len);
      this._s.malformed++;
      this._strike(p, 1);
      return;
    }
    try {
      if (type === LANE_MSG.HAVE) this._onHave(p, obj);
      else if (type === LANE_MSG.RECENT) await (obj.b === undefined ? this._onRecentRequest(p, obj) : this._onRecentAnswer(p, obj));
      else if (type === LANE_MSG.SNAP) await this._onSnap(p, obj);
      else await this._onChainFrame(p, type, obj);
    } catch (_) {
      this._s.errors = (this._s.errors || 0) + 1;
    }
  }

  // A cheap look at the ledger field (before parsing) -> the held ledger a frame 1-6 is for, or null. Only a frame that
  // opens with it counts (every lane frame this code sends does: _wrapSend puts ledger first); handle() checks after
  // parsing that the frame is for that ledger.
  _heldMode(bytes) {
    if (this._held.size === 0) return null;
    const head = utf8.decode(bytes.subarray(1, Math.min(bytes.length, 160)));
    const m = /^\{"ledger":"([A-Za-z0-9:._-]{1,128})"/.exec(head);
    return m && this._held.has(m[1]) ? m[1] : null;
  }

  _onHave(p, obj) {
    for (const id of obj.ledgers) {
      if (p.has.size >= this.limits.maxHavePerPeer) break;
      p.has.add(id);
      if (obj.full === true) {
        p.full.add(id);
        // Both sides hold it in full: run mw_chain1 for it through a virtual peer (its HELLO starts the sync).
        if (this._held.has(id)) this._virtual(p, id);
      }
    }
    this._pumpSchedule();
  }

  async _onRecentRequest(p, obj) {
    if (!p.recentReq.take(1)) {
      if (p.recentWait.length < this.limits.recentRequestQueue) p.recentWait.push(obj);
      else this._s.dropped++;
      return;
    }
    this._serveRecent(p, obj);
  }

  _serveRecent(p, obj) {
    const ledger = obj.ledger;
    // Review round (SCALE-11): one full answer per ledger per wire per recentRepeatMs (an honest tab asks a
    // ledger of one wire once per refresh), and the checkpoint state S once per wire.
    // A ledger whose root moved since is answered again (a retry after a new post is honest).
    const now = this.now();
    const node = this.ledgers.get(ledger);
    const root = node && node.dag ? node.dag.root() + '|' + (node.dag.size || 0) : null;
    const last = p.served.get(ledger);
    if (last !== undefined && now - last.at < this.limits.recentRepeatMs && last.root === root) {
      this._s.repeatDropped = (this._s.repeatDropped || 0) + 1;
      return;
    }
    if (p.served.size >= 1024) p.served.delete(p.served.keys().next().value);
    p.served.set(ledger, { at: now, root });
    let window = null;
    if (node && this._held.has(ledger)) {
      window = this._cachedWindow(node, obj.posts || RECENT_POSTS, obj.fromDepth);
    } else if (node && this._follow.has(ledger) && this.deviceClass !== 'phone') {
      window = this._viewWindow(viewOf(node));
    }
    if (window === null) window = { blocks: [], checkpoint: null, truncated: false };
    const frames = [];
    const cp = window.checkpoint;
    const sentKey = cp ? ledger + '|' + cp.snap : null;
    const parts = cp && cp.S && !p.snapSent.has(sentKey) ? snapParts(ledger, obj.rid, cp) : null;
    if (parts) p.snapSent.add(sentKey);
    const head = parts ? { h: cp.h, snap: cp.snap, parts: parts.length, bytes: byteLength(canonicalize(cp.S)) } : null;
    // The checkpoint head rides on the first page (packFrames reserves its room on every page).
    const pages = packFrames(LANE_MSG.RECENT, window.blocks, (items, last, index) => {
      const o = { ledger, rid: obj.rid, b: items, more: !last };
      if (head && index === 0) o.cp = head;
      if (window.truncated === true && index === 0) o.truncated = true;
      return o;
    }, { allowEmpty: true });
    for (const f of pages) frames.push(f);
    if (parts) {
      for (let i = 0; i < parts.length; i++) {
        frames.push(encodeLane(LANE_MSG.SNAP, { ledger, rid: obj.rid, snap: cp.snap, part: i, parts: parts.length, data: parts[i] }));
      }
      this._s.snapsServed++;
    }
    this._enqueue(p, frames);
    this._s.served++;
  }

  _cachedWindow(node, posts, fromDepth) {
    const key = node.siteId + '|' + posts + '|' + fromDepth;
    const now = this.now();
    const root = node.dag.root();
    const hit = this._windows.get(key);
    if (hit && hit.root === root && now - hit.at < this.limits.windowCacheMs) return hit.window;
    const window = recentWindow(node, { posts, fromDepth, maxBlocks: this.limits.maxWindowBlocks });
    if (this._windows.size >= 64) this._windows.delete(this._windows.keys().next().value);
    this._windows.set(key, { at: now, root, window });
    return window;
  }

  // A follower relaying its own window (desktop class only); values its state hides travel as stubs.
  _viewWindow(view) {
    const hidden = view.state().state.redacted;
    const blocks = topoSort(view.blocks()).reverse().map((b) => (b.v !== undefined && hidden instanceof Set && hidden.has(b.h) ? redact(b) : b));
    const cp = view._checkpoint;
    return { blocks, checkpoint: cp ? { h: cp.h, snap: cp.snap, S: cp.S } : null, truncated: view._truncated === true };
  }

  async _onRecentAnswer(p, obj) {
    const req = p.requests.get(obj.rid);
    if (req && req.decoy && req.ledger === obj.ledger) {
      if (!obj.more) p.requests.delete(req.rid); // a decoy's answer is dropped unread (STALK-3)
      return;
    }
    if (!req || req.ledger !== obj.ledger || req.blocksDone) {
      this._strike(p, 1); // an answer nobody asked for
      return;
    }
    if (req.blocks.length + obj.b.length > MAX_WINDOW_BLOCKS) {
      this._strike(p, 1);
      this._failRequest(req, 'too-large');
      p.requests.delete(req.rid);
      return;
    }
    for (const b of obj.b) req.blocks.push(b);
    if (obj.truncated === true) req.truncated = true;
    if (obj.cp && !req.cp) req.cp = { h: obj.cp.h, snap: obj.cp.snap, parts: obj.cp.parts, chunks: new Array(obj.cp.parts), got: 0 };
    req.lastAt = this.now();
    if (!obj.more) req.blocksDone = true;
    await this._maybeFinish(p, req);
  }

  async _onSnap(p, obj) {
    const req = p.requests.get(obj.rid);
    if (req && req.decoy && req.ledger === obj.ledger) return;
    if (!req || req.ledger !== obj.ledger || !req.cp || req.cp.snap !== obj.snap || req.cp.parts !== obj.parts) {
      this._strike(p, 1);
      return;
    }
    if (req.cp.chunks[obj.part] === undefined) {
      req.cp.chunks[obj.part] = obj.data;
      req.cp.got++;
    }
    req.lastAt = this.now();
    await this._maybeFinish(p, req);
  }

  async _maybeFinish(p, req) {
    if (!req.blocksDone) return;
    let checkpoint = null;
    if (req.cp) {
      if (req.cp.got < req.cp.parts) return;
      let S = null;
      try {
        S = JSON.parse(req.cp.chunks.join(''));
        if (checkpointSnap(S) !== req.cp.snap) S = null;
      } catch (_) {
        S = null;
      }
      if (S === null) this._strike(p, 1);
      else {
        checkpoint = { h: req.cp.h, snap: req.cp.snap, S };
        this._s.snapsTaken++;
      }
    }
    p.requests.delete(req.rid);
    if (!req.scheduled) {
      // peerFor(): the caller (recent.js syncRecent) applies the window itself.
      this._s.recentDone++;
      if (typeof req.resolve === 'function') req.resolve({ blocks: req.blocks, checkpoint, truncated: req.truncated === true });
      this._doneRequest(req, true);
      return undefined;
    }
    const node = this.ledgers.get(req.ledger);
    if (!node) return this._doneRequest(req, false);
    const r = await applyWindow(node, { blocks: req.blocks, checkpoint, truncated: req.truncated === true }, { from: 'lane:' + p.id });
    const invalid = this._countInvalid(r.rejected);
    if (invalid > 0) this._strike(p, invalid);
    if (r.added.length > 0) p.delivered += r.added.length;
    // An answer the view kept nothing of, and refused some of, is a failed pull: another peer is asked.
    const ok = !(invalid > 0 && r.added.length === 0);
    if (ok) this._s.recentDone++;
    this._doneRequest(req, ok);
    callHook(this._onView, req.ledger, r.view);
    return undefined;
  }

  // Refusals that count against the wire: invalid blocks, and (in a RECENT answer) blocks the view refused for lack of standing.
  _countInvalid(rejected, { standing = true } = {}) {
    let n = 0;
    for (const x of rejected || []) if (x && (INVALID.has(x.reason) || (standing && x.strike === true))) n++;
    return n;
  }

  _failRequest(req, why) {
    if (typeof req.reject === 'function') req.reject(coded('E_PEER_UNREACHABLE', 'the recent window did not arrive (' + why + ')'));
    this._doneRequest(req, false);
  }

  _doneRequest(req, ok) {
    if (req.settled) return;
    req.settled = true;
    if (!req.scheduled) return;
    this._active.delete(req.ledger);
    const f = this._follow.get(req.ledger);
    if (f) {
      if (ok) {
        f.lastSync = this.now();
        f.tries = 0;
        f.tried.clear();
        f.state = 'idle';
        if (!f.private) for (const q of this._peers.values()) this._sendHave(q, [req.ledger]);
      } else {
        f.tries++;
        f.state = f.tries >= this.limits.recentTries * Math.max(1, this._peers.size) ? 'idle' : 'due';
        if (f.state === 'idle') {
          this._s.recentFailed++;
          f.lastSync = this.now(); // try again at the next refresh
          f.tried.clear();
          f.tries = 0;
        }
      }
    }
    this._changed();
    this._pumpSchedule();
  }

  async _onChainFrame(p, type, obj) {
    const ledger = obj.ledger;
    const node = this.ledgers.get(ledger);
    if (!node) return; // a ledger this tab does not hold: nothing to do
    if (this._held.has(ledger)) {
      const vp = this._virtual(p, ledger);
      if (!vp) return;
      vp.lastAt = this.now();
      let inner;
      try {
        inner = encodeChain(type, withoutLedger(obj));
      } catch (_) {
        return;
      }
      await node.gossip.handle(vp.id, inner);
      return;
    }
    if (!this._follow.has(ledger)) return;
    const view = viewOf(node);
    if (type === LANE_MSG.ANN) {
      const want = [];
      for (const h of obj.h) {
        const key = ledger + '|' + h;
        if (view.has(h) || p.asked.has(key)) continue;
        if (p.asked.size >= this.limits.maxAskedPerPeer) break;
        p.asked.set(key, this.now());
        want.push(h);
      }
      for (let i = 0; i < want.length; i += 64) this._transmit(p, encodeLane(LANE_MSG.WANT, { ledger, h: want.slice(i, i + 64) }));
      return;
    }
    if (type === LANE_MSG.BLOCKS) {
      // Only what we asked for (ANN, then WANT): a followed ledger is never pushed into the view.
      const take = [];
      for (const b of obj.b) {
        const key = ledger + '|' + b.h;
        if (!p.asked.has(key)) {
          this._s.dropped++;
          continue;
        }
        p.asked.delete(key);
        take.push(b);
      }
      if (take.length === 0) return;
      const r = await applyWindow(node, { blocks: take }, { from: 'lane:' + p.id });
      // Blocks pushed after a window may arrive before a control block they depend on: a refusal here is no strike
      // (a RECENT answer must carry every control block, so there it is one); invalid blocks still are.
      const invalid = this._countInvalid(r.rejected, { standing: false });
      if (invalid > 0) this._strike(p, invalid);
      if (r.added.length > 0) {
        p.delivered += r.added.length;
        callHook(this._onView, ledger, r.view);
      }
      return;
    }
    if (type === LANE_MSG.WANT && this.deviceClass !== 'phone') {
      const found = [];
      for (const h of obj.h) {
        const b = view.get(h);
        if (b) found.push(b);
      }
      if (found.length > 0) this._enqueue(p, packFrames(LANE_MSG.BLOCKS, found, (items) => ({ ledger, b: items })));
    }
    // HELLO, SYNC, INV for a followed ledger: windows are pulled with RECENT, never synced in full.
  }

  // A virtual peer of ledger's Gossip on wire p (held ledgers): its frames go back with the ledger field.
  _virtual(p, ledger) {
    let vp = p.vpeers.get(ledger);
    if (vp) return vp;
    const node = this.ledgers.get(ledger);
    if (!node || !node.gossip || p.ignored) return null;
    if (p.vpeers.size >= this.limits.maxVirtualPerWire) {
      // the idlest one makes room
      let oldest = null;
      for (const [l, v] of p.vpeers) if (oldest === null || v.lastAt < p.vpeers.get(oldest).lastAt) oldest = l;
      if (oldest === null) return null;
      this._dropVirtual(p, oldest);
    }
    const id = p.id + '|' + ledger;
    vp = { id, ledger, lastAt: this.now() };
    p.vpeers.set(ledger, vp);
    const ok = node.gossip.attach({
      id,
      group: p.group,
      send: (u8) => this._wrapSend(p, ledger, u8),
      close: () => {
        if (p.vpeers.get(ledger) === vp) p.vpeers.delete(ledger);
      },
      ignored: (reason) => {
        if (reason === 'invalid') this._strike(p, this.limits.maxInvalid + 1);
      },
    });
    if (ok === false) {
      p.vpeers.delete(ledger);
      return null;
    }
    return vp;
  }

  _dropVirtual(p, ledger) {
    const vp = p.vpeers.get(ledger);
    if (!vp) return;
    p.vpeers.delete(ledger);
    const node = this.ledgers.get(ledger);
    if (node && node.gossip) {
      try {
        node.gossip.detach(vp.id);
      } catch (_) {
        // the node is closing
      }
    }
  }

  // An mw_chain1 frame from a held ledger's Gossip, sent on the lane with the ledger field (a BLOCKS
  // frame packed to the cap is split, since the field adds bytes).
  _wrapSend(p, ledger, u8) {
    const msg = decodeChain(u8);
    if (!msg) return;
    const obj = Object.assign({ ledger }, msg.obj);
    let frame = null;
    try {
      frame = encodeLane(msg.type, obj);
    } catch (_) {
      frame = null;
    }
    if (frame) {
      this._transmit(p, frame);
      return;
    }
    if (msg.type === LANE_MSG.BLOCKS) {
      for (const f of packFrames(LANE_MSG.BLOCKS, msg.obj.b, (items) => ({ ledger, b: items }))) this._transmit(p, f);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------------------------------

  _dueList() {
    const now = this.now();
    const out = [];
    for (const [id, f] of this._follow) {
      if (f.state === 'active') continue;
      if (f.state === 'due' || now - f.lastSync >= this.limits.refreshMs) out.push([id, f]);
    }
    out.sort((a, b) => (a[1].lastSync - b[1].lastSync) || (a[1].since - b[1].since));
    return out;
  }

  _idle() {
    return this._active.size === 0 && this._dueList().length === 0;
  }

  // Starts RECENT pulls while fewer than maxActive ledgers sync (R 3.2.2: 4 at a time).
  _pumpSchedule() {
    if (this._destroyed || this._hidden) return;
    const due = this._dueList();
    for (const [ledger, f] of due) {
      if (this._active.size >= this.limits.maxActive) break;
      const peer = this._pickPeer(ledger, f);
      if (!peer) continue;
      // DS-3: a window already pulled is refreshed with the newest refreshPosts posts; ANN carries the rest.
      const posts = f.lastSync > -Infinity ? this.limits.refreshPosts : this.limits.posts;
      if (f.private) this._sendDecoys(peer, ledger, posts);
      this._startRecent(peer, ledger, f, { posts });
    }
  }

  // STALK-3: RECENT requests, in the same shape, for privateDecoys other ledgers the peer HAVEs.
  _sendDecoys(p, ledger, posts) {
    const pool = [];
    for (const id of p.has) if (id !== ledger && !this._follow.has(id)) pool.push(id);
    for (let i = 0; i < this.limits.privateDecoys && pool.length > 0; i++) {
      const j = Math.floor(this._random() * pool.length);
      const id = pool.splice(j, 1)[0];
      const rid = (this._rid = (this._rid % MAX_RID) + 1);
      p.requests.set(rid, { rid, ledger: id, peer: p.id, decoy: true, blocks: [], cp: null, at: this.now(), lastAt: this.now(), blocksDone: false, settled: true, scheduled: false });
      this._transmit(p, encodeLane(LANE_MSG.RECENT, { ledger: id, fromDepth: -1, posts, rid }));
    }
  }

  _pickPeer(ledger, f) {
    let best = null;
    for (const p of this._peers.values()) {
      if (p.ignored || !p.has.has(ledger) || p.requests.size >= 4) continue;
      if (f.private && p.has.size <= this.limits.privateDecoys) continue; // too few other ledgers to hide among
      if (f.tried.has(p.id) && f.tried.size < this._peers.size) continue;
      if (best === null || p.delivered > best.delivered) best = p;
    }
    return best;
  }

  _startRecent(p, ledger, f, { resolve = null, reject = null, scheduled = true, posts = this.limits.posts, fromDepth = -1 } = {}) {
    const rid = (this._rid = (this._rid % MAX_RID) + 1);
    const req = { rid, ledger, peer: p.id, blocks: [], cp: null, at: this.now(), lastAt: this.now(), blocksDone: false, resolve, reject, scheduled, settled: false };
    p.requests.set(rid, req);
    if (scheduled && f) {
      f.state = 'active';
      f.tried.add(p.id);
      this._active.add(ledger);
    }
    this._s.recentAsked++;
    this._transmit(p, encodeLane(LANE_MSG.RECENT, { ledger, fromDepth, posts, rid }));
    this._changed();
    return req;
  }

  /**
   * peerFor(peerId) -> { id, recent({ ledger, fromDepth, posts }) -> Promise<{ blocks, checkpoint }> }: a
   * peer for recent.js syncRecent() over this lane (outside the scheduler).
   */
  peerFor(peerId) {
    return {
      id: peerId,
      recent: ({ ledger, fromDepth = -1, posts = RECENT_POSTS } = {}) => new Promise((resolve, reject) => {
        const p = this._peers.get(peerId);
        if (!p || p.ignored) {
          reject(coded('E_PEER_UNREACHABLE', 'that lane peer is gone'));
          return;
        }
        this._startRecent(p, ledger, null, { resolve, reject, scheduled: false, posts, fromDepth });
      }),
    };
  }

  /**
   * tick(): call about once a second: request timeouts and retries, new heads of held ledgers announced,
   * idle virtual peers closed, and on phones the wires beyond 2 once nothing syncs.
   */
  tick() {
    if (this._destroyed) return;
    const now = this.now();
    for (const p of Array.from(this._peers.values())) {
      while (p.recentWait.length > 0 && !p.ignored && p.recentReq.take(1)) this._serveRecent(p, p.recentWait.shift());
      for (const [rid, req] of Array.from(p.requests)) {
        if (now - req.lastAt < this.limits.recentTimeoutMs) continue;
        p.requests.delete(rid);
        this._failRequest(req, 'timeout');
      }
      for (const [key, at] of Array.from(p.asked)) if (now - at >= this.limits.recentTimeoutMs) p.asked.delete(key);
      for (const [ledger, vp] of Array.from(p.vpeers)) if (now - vp.lastAt >= this.limits.virtualIdleMs) this._dropVirtual(p, ledger);
    }
    // New heads of held ledgers: ANN to the peers that hold them (virtual peers get them from the Gossip).
    for (const [ledger, h] of this._held) {
      const node = this.ledgers.get(ledger);
      if (!node || node.closed) continue;
      const root = node.dag.root();
      if (root === h.root) continue;
      // STALK-8: the lane ANN of a new head waits a random 0.5 to 3 s (as mw_chain1 does for a local block).
      if (h.annRoot !== root) {
        h.annRoot = root;
        h.annAt = now + 500 + Math.floor(this._random() * 2500);
      }
      if (now < h.annAt) continue;
      h.root = root;
      const heads = node.dag.heads({ limit: 32 });
      if (heads.length === 0) continue;
      for (const p of this._peers.values()) {
        if (p.ignored || p.vpeers.has(ledger) || !p.has.has(ledger)) continue;
        this._transmit(p, encodeLane(LANE_MSG.ANN, { ledger, h: heads }));
      }
    }
    // Phones pull, then disconnect (R 3.2.2): at most phoneIdleWires once nothing is due or syncing.
    if (this.deviceClass === 'phone' && this._idle()) {
      const keep = this.limits.phoneIdleWires;
      if (this._peers.size > keep) {
        const list = Array.from(this._peers.values()).sort((a, b) => (b.delivered - a.delivered) || (a.attachedAt - b.attachedAt));
        for (const p of list.slice(keep)) this._kill(p, 'phone-idle');
      }
    }
    this._pumpSchedule();
  }

  destroy() {
    if (this._destroyed) return;
    for (const id of Array.from(this._peers.keys())) this.detach(id);
    this._destroyed = true;
  }
}
