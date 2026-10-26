// Site ledger gossip (ARCHITECTURE 6.6; DESIGN-REVIEW items 1, 3, 5 and S9; v0.3 hardening, V03-DESIGN-REVIEW
// 1.1 item 7, 2.16.4, MF-73, MF-74, MF-75). Transport-agnostic: a peer is { id, send(u8), close?() } and every
// frame it receives goes to handle(peerId, u8). wire-ext.js adapts BitTorrent wires (extension 'mw_chain1');
// tests use in-memory links; multi.js (mw_chain2) multiplexes several ledgers over one wire.
//
// Frames: byte 0 = type, the rest is UTF-8 JSON, at most FRAME_MAX bytes in total.
//   1 HELLO  { v, site, owner, n, d, root, heads, c? }  n blocks held, d max depth (-1 when empty), root =
//                                                   dag.root(), heads <= 32 by (depth desc, h asc);
//                                                   owner is null or an algorithm-tagged key
//                                                   ('p256:...', v0.2.1 A2); an untagged owner
//                                                   makes the frame malformed. v0.3: c = blocks a
//                                                   checkpoint pruned (absent: 0); n + c is at most
//                                                   MAX_LEDGER_BLOCKS and -1 <= d < n + c (MF-73)
//   2 WANT   { h: [<= 64], v?: true }               v: also wants the payload of v-less blocks
//   3 BLOCKS { b: [Block...] }                      packed up to the frame cap
//   4 ANN    { h: [<= 200] }                        hashes only, on first acceptance
//   5 SYNC   { w: [{ k, dg, n }...] }               our 64-level window digests, <= 128 per frame
//   6 INV    { k, h: [<= 200], more }               our hashes in window k, paged
// Every integer has an upper bound the decoder enforces (v0.3, MF-73): n, c and a window's n at most
// MAX_LEDGER_BLOCKS (the 64 MiB ledger ceiling over the smallest valid block, 187 bytes, measured), a window
// index k at most MAX_WINDOWS - 1, d below n + c. A frame outside them is malformed: a strike.
//
// Flow. attach -> HELLO. A HELLO with another (site, owner) or protocol version detaches the peer.
// Equal root = in sync. Otherwise: when the peer's head list is complete (< 32) and every head is in
// our DAG we already hold everything it has and wait for it to pull; when its unknown heads sit at
// most two levels above our depth we WANT them directly, and if one of them (or a parent we then
// ask for) turns out to be an orphan the gap is deeper and a sync session starts at once; else we
// open a sync session: SYNC with every window 0..floor(max(d, peer.d) / 64), clamped to the bound above
// and to 256 windows beyond our own depth (a deeper peer is reached over later sessions as we grow), so
// one HELLO costs at most three SYNC frames beyond our own windows; the peer answers INV
// for every window whose digest differs (an empty INV when it holds nothing there; pages list the
// window in (depth, h) order), and we WANT what we lack window by window, lowest depth first, at
// most two windows in flight per peer, handing windows round-robin to every peer that advertises
// the same root. One sync session per distinct remote root; a session that brought nothing in ends
// after 3 s idle and backs off (2 s doubling to 60 s), one that made progress ends after 8 s idle and
// retries after 2 s; at most four sessions run at once, and a peer that has delivered valid blocks
// pre-empts a session with a peer that has not (PEER A7). Received blocks go to ingest(); unknown
// parents of orphans (and of blocks the node set aside until their parents arrive) are WANTed from the
// orphan's sender first, and parents still missing are asked again every 5 s. Answers go lowest depth
// first; a v-less payload block travels only in the same frame as the tombstone or ban that justifies
// it (so does a block whose value the node hides, hidden hook), and a held stub that nothing explains
// is WANTed with v: true after a 2 s grace. First acceptance of a block -> ANN to every other peer, each
// after its own random delay (review round, STALK-8: 0.5 to 3 s for a block written here, the HELLO that
// carries it as a head after the longest; up to 1 s for a relayed one); any head change -> HELLO to all
// peers (coalesced, 250 ms); HELLO also every 30 s from tick(). Review round: a sync session takes at most
// n + c (+64) listed hashes from a peer (its HELLO) and holds at most maxSessionBacklog queued or wanted
// (MP-1); a peer starts at most one session per syncStartGapMs, whatever its HELLO roots do (MP-2); one
// peer's HELLO heads hold at most maxFastWantsPerPeer wants (MP-11).
//
// Budgets (ingress, per peer). Unsolicited frames (HELLO, WANT, ANN, SYNC, INV outside a session,
// blocks nobody asked for): 64 KiB/s. Solicited data (INV for windows we listed in our SYNC, blocks
// we WANTed from that peer): 1 MiB/s and, until we are in sync with the peer again, at most
// 2 x maxChainBytes + 1 MiB of frame bytes (blocks travel as JSON with h and s, so a full ledger
// costs more than maxChainBytes on the wire). The frame length is charged (or, for frames whose
// solicited part is known only after parsing, checked against what the buckets hold) before the
// frame is parsed (PEER A8). Over-budget frames or blocks are dropped and never remembered by hash, so
// the data is simply fetched again later. More than 50 invalid blocks or malformed frames from one
// peer -> that peer is ignored for the rest of its session and its transport is told (ignored hook:
// wire-ext flags the wire, the loader closes it, MF-74). Wants created from one peer's ANN or INV are
// capped at 256 per peer, oldest dropped first (PEER A6). At most maxPeersPerGroup (4) peers share one
// `group` (a self-declared remote peer id): a fifth wire claiming the same id is refused (MF-74).
// A peer that sends no HELLO within 2 minutes of attach is refused as silent (MF-74, A10).
// Egress is paced below the receiver's budgets (answers 768 KiB/s, requests and notices 48 KiB/s
// per peer, at most 512 hashes asked of a peer at a time, an answer queue of at most 4 MiB) so
// honest peers never trip each other's limits. One peer per wanted hash at a time; after 10 s
// without an answer the next source is tried (each want tries its sources up to 3 times).
//
// ingest(blocks, peerId, { history, wire: true }) gets the set of hashes that arrive as history (asked
// for by a sync session, as parents of held orphans, or as value restores); every other block is live,
// which the node throttles by arrival time (MF-75). wire: the blocks came off a transport peer, so the
// node charges their signature checks to that peer's budget.
//
// No Buffer, no node: imports, no post-floor APIs: runs unchanged in Node >= 22 and browsers.

import { utf8, asBytes, byteLength } from './canonical.js';
import { WINDOW_SIZE } from './dag.js';

export const MSG = Object.freeze({ HELLO: 1, WANT: 2, BLOCKS: 3, ANN: 4, SYNC: 5, INV: 6 });
export const FRAME_MAX = 15360;
export const PROTOCOL_VERSION = 1;
/** Digest of an empty depth window: hex sha256 of zero bytes (Dag.windows() uses the same). */
export const EMPTY_DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
/** ingest() rejection reasons that mean the block itself is invalid (counted toward maxInvalid). */
export const INVALID_REASONS = Object.freeze(['shape', 'size', 'hash', 'pow', 'sig', 'op', 'limit', 'unknown-op', 'value-hash', 'value-size', 'root']);
/**
 * Shape of an owner key in HELLO: an algorithm tag, ':' and a base64url body (v0.2.1 A2). Any tag
 * passes the codec (a later algorithm is a different owner, so the peer is detached as a mismatch
 * rather than counted as malformed); untagged keys do not.
 */
export const OWNER_KEY_RE = /^[a-z][a-z0-9]{0,15}:[A-Za-z0-9_-]{1,240}$/;
/** Bytes of the smallest valid block: an empty policy root of a one-character site id (measured). */
export const MIN_BLOCK_BYTES = 187;
/** At most this many blocks fit a ledger: the 64 MiB maxChainBytes ceiling over MIN_BLOCK_BYTES (MF-73). */
export const MAX_LEDGER_BLOCKS = Math.floor(67108864 / MIN_BLOCK_BYTES);
/** Depth windows a ledger of MAX_LEDGER_BLOCKS blocks can have (valid window indexes 0..MAX_WINDOWS - 1). */
export const MAX_WINDOWS = Math.ceil(MAX_LEDGER_BLOCKS / WINDOW_SIZE);
/** Longest site id the codec accepts (block.js accepts at most 128). */
export const MAX_SITE_LENGTH = 256;

export const DEFAULT_LIMITS = Object.freeze({
  maxHeads: 32,
  maxWant: 64,
  maxInv: 200,
  maxAnn: 200,
  maxSyncWindows: 128,
  windowsInFlight: 2,
  wantTimeoutMs: 10000,
  maxTries: 3,
  helloIntervalMs: 30000,
  helloCoalesceMs: 250,
  unsolicitedRate: 65536,
  unsolicitedBurst: 65536,
  solicitedRate: 1048576,
  solicitedBurst: 1048576,
  solicitedCap: null, // null: 2 * maxChainBytes() + 1 MiB
  maxInvalid: 50,
  egressRate: 786432,
  egressBurst: 786432,
  controlRate: 49152,
  controlBurst: 49152,
  maxEgressBytes: 4194304,
  maxAskedPerPeer: 512,
  maxWants: 8192,
  maxWantsPerSource: 256, // v0.3 (PEER A6): wants created from one peer's ANN or INV
  maxWantAgeMs: 120000,
  annBacklog: 600,
  fastPathDepth: 2,
  syncFallbackMs: 3000,
  syncIdleMs: 8000,
  syncNoBlockMs: 3000, // v0.3 (PEER A7): a session that added nothing ends after 3 s idle
  syncBackoffMs: 2000,
  syncBackoffMaxMs: 60000,
  maxSyncSessions: 4,
  syncLookahead: 256, // v0.3 (MF-73): windows listed beyond our own depth per session
  missingRetryMs: 5000,
  valueGraceMs: 2000,
  maxPeersPerGroup: 4, // v0.3 (MF-74): wires sharing one self-declared remote peer id
  maxSessionBacklog: 8192, // review round (MP-1): hashes a sync session holds queued or wanted at once
  syncStartGapMs: 2000, // review round (MP-2): at most one sync session start per peer per this interval
  annJitterLocalMs: [500, 3000], // review round (STALK-8): a block written here is announced to each peer after its own random delay
  annJitterRelayMs: [0, 1000], // and a relayed one after an independent random delay
  maxFastWantsPerPeer: 256, // review round (MP-11): wants made from one peer's HELLO heads
  helloWaitMs: 120000, // v0.3 (MF-74, PEER A10): a peer silent this long after attach is refused
  syncedNoticeMs: 30000, // the synced() hook fires at most this often per peer
});

const TYPES = new Set([1, 2, 3, 4, 5, 6]);
const HEX64 = /^[0-9a-f]{64}$/;
const INVALID = new Set(INVALID_REASONS);
const PAYLOAD = new Set(['put', 'append', 'profile']);
const DEFAULT_MAX_CHAIN = 8388608;
const WANT_HASH_BYTES = 67; // '"<64 hex>",'
const WANT_FRAME_BYTES = 24;

const isHex64 = (x) => typeof x === 'string' && HEX64.test(x);

// Default timer: unref'd in Node so a forgotten gossip never keeps a process alive.
function unrefTimeout(fn, ms) {
  const t = setTimeout(fn, ms);
  if (t && typeof t === 'object' && typeof t.unref === 'function') t.unref();
  return t;
}

function isPlainObject(x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

const isUint = (x) => Number.isSafeInteger(x) && x >= 0;

function hashList(a, min, max) {
  if (!Array.isArray(a) || a.length < min || a.length > max) return false;
  for (let i = 0; i < a.length; i++) if (!isHex64(a[i])) return false;
  return true;
}

/**
 * helloBoundsOk(o) -> boolean: the integer fields of a HELLO (v0.3, MF-73): n and c (blocks held and
 * blocks a checkpoint pruned) at most MAX_LEDGER_BLOCKS together, and -1 <= d < n + c (an honest node
 * never has a depth at or above its block count).
 */
export function helloBoundsOk(o) {
  if (!o || !isUint(o.n) || o.n > MAX_LEDGER_BLOCKS) return false;
  const c = o.c === undefined ? 0 : o.c;
  if (!isUint(c) || o.n + c > MAX_LEDGER_BLOCKS) return false;
  return Number.isSafeInteger(o.d) && o.d >= -1 && o.d < o.n + c;
}

// [min, max] milliseconds of an announcement delay (a number n means [0, n]; anything else none).
function jitterSpan(x) {
  if (Array.isArray(x) && x.length === 2 && x[0] >= 0 && x[1] >= x[0]) return [Number(x[0]), Number(x[1])];
  if (typeof x === 'number' && x > 0) return [0, x];
  return [0, 0];
}

// Hashes a sync session holds: queued for windows not yet active, and wanted for active ones (MP-1).
function sessionBacklog(s) {
  let n = 0;
  for (const job of s.jobs.values()) n += job.queued.length + job.pending.size;
  return n;
}

function windowIndexOk(k) {
  return isUint(k) && k < MAX_WINDOWS;
}

// Structural checks per frame type. Unknown members are ignored (forward compatibility); the
// limits are the protocol's, so a frame a peer may legally send always passes.
const VALIDATORS = {
  [MSG.HELLO]: (o) => isUint(o.v) && typeof o.site === 'string' && o.site.length > 0 && o.site.length <= MAX_SITE_LENGTH &&
    (o.owner === null || (typeof o.owner === 'string' && OWNER_KEY_RE.test(o.owner))) &&
    helloBoundsOk(o) && isHex64(o.root) && hashList(o.heads, 0, DEFAULT_LIMITS.maxHeads),
  [MSG.WANT]: (o) => hashList(o.h, 1, DEFAULT_LIMITS.maxWant) && (o.v === undefined || typeof o.v === 'boolean'),
  [MSG.BLOCKS]: (o) => Array.isArray(o.b) && o.b.length > 0 && o.b.every(isPlainObject),
  [MSG.ANN]: (o) => hashList(o.h, 1, DEFAULT_LIMITS.maxAnn),
  [MSG.SYNC]: (o) => Array.isArray(o.w) && o.w.length > 0 && o.w.length <= DEFAULT_LIMITS.maxSyncWindows &&
    o.w.every((x) => isPlainObject(x) && windowIndexOk(x.k) && isHex64(x.dg) && isUint(x.n) && x.n <= MAX_LEDGER_BLOCKS),
  [MSG.INV]: (o) => windowIndexOk(o.k) && hashList(o.h, 0, DEFAULT_LIMITS.maxInv) && typeof o.more === 'boolean',
};

/** validFrame(type, obj) -> boolean: the structural rules of decode() for an already parsed frame (multi.js). */
export function validFrame(type, obj) {
  return TYPES.has(type) && isPlainObject(obj) && VALIDATORS[type](obj) === true;
}

/** encode(type, obj) -> Uint8Array frame. RangeError { code: 'E_FRAME' } above FRAME_MAX bytes. */
export function encode(type, obj) {
  if (!TYPES.has(type)) throw new TypeError('unknown gossip message type ' + type);
  const json = JSON.stringify(obj);
  if (typeof json !== 'string' || json[0] !== '{') throw new TypeError('gossip payload must be a JSON object');
  const body = utf8.encode(json);
  if (body.length + 1 > FRAME_MAX) {
    const err = new RangeError('gossip frame of ' + (body.length + 1) + ' bytes exceeds ' + FRAME_MAX);
    err.code = 'E_FRAME';
    throw err;
  }
  const out = new Uint8Array(body.length + 1);
  out[0] = type;
  out.set(body, 1);
  return out;
}

/** decode(u8) -> { type, obj } | null for anything that is not a well-formed frame of a known type. */
export function decode(u8) {
  let bytes;
  try {
    bytes = asBytes(u8);
  } catch (_) {
    return null;
  }
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
  return VALIDATORS[type](obj) ? { type, obj } : null;
}

// Token bucket on an injected clock. force() may leave a debt that later take() calls pay off.
export class Bucket {
  constructor(rate, burst, now) {
    this.rate = rate;
    this.burst = burst;
    this.now = now;
    this.tokens = burst;
    this.at = now();
  }

  _refill() {
    const t = this.now();
    const dt = t - this.at;
    if (dt > 0) this.tokens = Math.min(this.burst, this.tokens + (dt * this.rate) / 1000);
    this.at = t;
  }

  available() {
    this._refill();
    return this.tokens;
  }

  take(n) {
    this._refill();
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }

  force(n) {
    this._refill();
    this.tokens -= n;
  }

  msUntil(n) {
    this._refill();
    return this.tokens >= n ? 0 : Math.ceil(((n - this.tokens) * 1000) / this.rate);
  }
}

// A value always travels with its salt z (v0.2.1 A1): WANT { h, v: true } answers carry both.
function blockOnly(b) {
  if (b.v === undefined) return { e: b.e, h: b.h, s: b.s };
  return b.z === undefined ? { e: b.e, h: b.h, s: b.s, v: b.v } : { e: b.e, h: b.h, s: b.s, v: b.v, z: b.z };
}

function isPayloadBlock(b) {
  return !!(b && b.e && b.e.op && PAYLOAD.has(b.e.op.t));
}

function itemBytes(item) {
  try {
    return byteLength(JSON.stringify(item)) + 1;
  } catch (_) {
    return FRAME_MAX;
  }
}

function callHook(fn, ...args) {
  if (typeof fn !== 'function') return undefined;
  try {
    return fn(...args);
  } catch (_) {
    return undefined; // a transport hook never breaks the protocol
  }
}

export class Gossip {
  /**
   * new Gossip({ site, owner, dag, ingest, getBlock, now, setTimeoutFn, clearTimeoutFn, limits,
   *              justify, needsValue, skip, pending, hidden, busy, maxChainBytes, onChange, privileged })
   * ingest(blocks, peerId, { history: Set<h>, wire: true }) -> Promise<{ added: h[], rejected: [{ h, reason }],
   *   duplicates?: h[], orphans?: h[], deferred?: h[], needValue?: h[] }>. Optional hooks (node.js provides
   *   them): justify(h) -> Block[] (the tombstone or ban that explains a v-less block, sent along with
   *   it), needsValue(h) -> bool (a held v-less block whose value we still want), skip(h) -> bool
   *   (a hash ingest refused by policy; not fetched again until the control state changes),
   *   pending(h) -> bool (a block the node holds aside: until its parents arrive, or until its
   *   signature is checked; counts as held), hidden(h) -> bool (v0.3: the node holds the value but its
   *   state hides it, a moderator tombstone in its 24 h grace: plain WANT answers carry the stub and
   *   the tombstone), busy(peerId) -> bool (v0.3: the node's signature-check queue for that peer is
   *   full; nothing more is asked of it until it drains), maxChainBytes() -> number, onChange() (peer
   *   count or sync state changed), privileged(author) -> bool (code review round 1: the owner, a
   *   moderator or an allow-listed author; their blocks are never charged against the solicited
   *   allowance, so the cap never stops them).
   * Timers default to real ones (unref'd in Node); tests inject a virtual clock.
   */
  constructor(options) {
    const o = options || {};
    if (!o.dag || typeof o.dag.root !== 'function') throw new TypeError('Gossip needs a dag');
    if (typeof o.ingest !== 'function') throw new TypeError('Gossip needs ingest(blocks, peerId)');
    if (typeof o.getBlock !== 'function') throw new TypeError('Gossip needs getBlock(h)');
    this.site = String(o.site);
    this.owner = typeof o.owner === 'string' ? o.owner : null;
    this.dag = o.dag;
    this._ingest = o.ingest;
    this._getBlock = o.getBlock;
    this._justify = typeof o.justify === 'function' ? o.justify : null;
    this._needsValue = typeof o.needsValue === 'function' ? o.needsValue : null;
    this._skip = typeof o.skip === 'function' ? o.skip : null;
    this._pending = typeof o.pending === 'function' ? o.pending : null;
    this._hidden = typeof o.hidden === 'function' ? o.hidden : null;
    this._busy = typeof o.busy === 'function' ? o.busy : null;
    this._privileged = typeof o.privileged === 'function' ? o.privileged : null;
    const mcb = o.maxChainBytes;
    this._maxChainBytes = typeof mcb === 'function' ? mcb : () => (typeof mcb === 'number' ? mcb : DEFAULT_MAX_CHAIN);
    this._onChange = typeof o.onChange === 'function' ? o.onChange : null;
    this.now = typeof o.now === 'function' ? o.now : () => Date.now();
    this._setTimeout = typeof o.setTimeoutFn === 'function' ? o.setTimeoutFn : unrefTimeout;
    this._clearTimeout = typeof o.clearTimeoutFn === 'function' ? o.clearTimeoutFn : (t) => clearTimeout(t);
    this.limits = Object.assign({}, DEFAULT_LIMITS, o.limits || {});
    this._random = typeof o.random === 'function' ? o.random : Math.random; // announcement jitter (STALK-8)
    this._peers = new Map();
    this._wants = new Map();
    this._helloTimer = null;
    this._destroyed = false;
    this._lastRoot = null;
    this._rr = 0;
    this._lastMissingAt = -Infinity;
    this._lastProgressAt = null;
    this._s = {
      in: 0, out: 0, invalid: 0, dropped: 0, ignored: 0, malformed: 0, bytesIn: 0, bytesOut: 0, detached: 0, failedWants: 0,
      refused: 0, wantsEvicted: 0, preempted: 0,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------------------------------------

  /**
   * Visitors (distinct peer `group`s, code review round 1: one visitor may reach us over several wires,
   * each its own gossip peer) with a matching HELLO that are not ignored.
   */
  get peers() {
    const groups = new Set();
    for (const p of this._peers.values()) if (!p.ignored && p.hello) groups.add(p.group);
    return groups.size;
  }

  /** Visitors whose last HELLO root (on any of their wires) equals ours. */
  get inSyncPeers() {
    const root = this.dag.root();
    const groups = new Set();
    for (const p of this._peers.values()) if (!p.ignored && p.hello && p.hello.root === root) groups.add(p.group);
    return groups.size;
  }

  get stats() {
    return Object.assign({}, this._s, { wants: this._wants.size, attached: this._peers.size });
  }

  /** Time (this.now()) a block last entered the DAG from a peer, or null (the "peers but no progress" signal). */
  get lastProgressAt() {
    return this._lastProgressAt;
  }

  /** Debug view of one peer (tests, diagnostics panel). */
  peerInfo(peerId) {
    const p = this._peers.get(peerId);
    if (!p) return null;
    return {
      id: p.id,
      group: p.group,
      ignored: p.ignored,
      invalid: p.invalid,
      inSync: !!p.hello && p.hello.root === this.dag.root(),
      hello: p.hello,
      asked: p.asked.size,
      activeJobs: p.activeJobs,
      syncing: !!p.session,
      solicitedBytes: p.solTotal,
      queuedBytes: p.outBytes,
      delivered: p.delivered,
      origins: p.origins.size,
      lastFrameAt: p.lastFrameAt,
    };
  }

  hasPeer(peerId) {
    return this._peers.has(peerId);
  }

  /**
   * attach({ id, send(u8), close?, group?, ignored?(reason), delivered?(), synced?() }): registers a
   * transport peer and sends HELLO. group (default id) names the remote visitor for the peer counts and
   * the per-group cap only; it never merges two peers' traffic, strikes or detach (code review round
   * 1). The optional hooks tell the transport that the gossip ignores the peer (ignored: 'invalid',
   * 'silent', 'group-cap'), that it delivered its first valid block (delivered: the loader anchors the
   * wire) and that it is in sync with us (synced). -> true, or false when refused (the group already
   * has maxPeersPerGroup peers: ignored('group-cap') is called and nothing is attached).
   */
  attach(peer) {
    if (this._destroyed) return false;
    if (!peer || typeof peer.send !== 'function' || peer.id === undefined || peer.id === null) {
      throw new TypeError('attach expects { id, send(u8) }');
    }
    const id = String(peer.id);
    if (this._peers.has(id)) this.detach(id);
    const p = this._newPeer(id, peer);
    let same = 0;
    for (const q of this._peers.values()) if (q.group === p.group) same++;
    if (same >= this.limits.maxPeersPerGroup) {
      this._s.refused++;
      callHook(p.onIgnored, 'group-cap');
      return false;
    }
    this._peers.set(id, p);
    this._sendHello(p);
    this._changed();
    return true;
  }

  /** detach(peerId): forgets the peer, releases what was asked of it, tells its transport. */
  detach(peerId) {
    const p = this._peers.get(peerId);
    if (!p) return false;
    this._peers.delete(peerId);
    this._s.detached++;
    if (p.drainTimer !== null) this._clearTimeout(p.drainTimer);
    p.drainTimer = null;
    for (const h of p.asked.keys()) {
      const w = this._wants.get(h);
      if (w && w.peer === peerId) w.peer = null;
    }
    p.asked.clear();
    p.origins.clear();
    this._endSession(p, false);
    // Windows this peer was fetching for other sessions keep their wants; other sources take over.
    for (const q of this._peers.values()) {
      if (!q.session) continue;
      for (const job of q.session.jobs.values()) if (job.peer === peerId) job.peer = null;
    }
    if (p.close) {
      try {
        p.close();
      } catch (_) {
        // the transport is already gone
      }
    }
    this._pump();
    this._changed();
    return true;
  }

  /** handle(peerId, u8) -> Promise: processes one frame from an attached peer. Never throws. */
  async handle(peerId, u8) {
    const p = this._peers.get(peerId);
    if (!p || this._destroyed) return;
    let bytes = null;
    try {
      bytes = asBytes(u8);
    } catch (_) {
      bytes = null;
    }
    const len = bytes ? bytes.length : 0;
    this._s.in++;
    this._s.bytesIn += len;
    p.lastFrameAt = this.now();
    if (p.ignored) {
      this._s.ignored++;
      return;
    }
    if (!bytes || len < 3 || len > FRAME_MAX || !TYPES.has(bytes[0])) {
      this._s.malformed++;
      this._strike(p, 1);
      return;
    }
    // Budget before parsing (PEER A8): unsolicited types pay their length now; INV and BLOCKS, whose
    // solicited part is known only after parsing, must at least fit what the buckets hold.
    const type0 = bytes[0];
    if (type0 === MSG.BLOCKS || type0 === MSG.INV) {
      const sol = type0 === MSG.BLOCKS ? p.asked.size > 0 : !!p.session;
      if (p.unsol.available() < len && !(sol && p.sol.available() >= len)) {
        this._s.dropped++;
        return;
      }
    } else if (!p.unsol.take(len)) {
      this._s.dropped++;
      return;
    }
    const msg = decode(bytes);
    if (!msg) {
      this._s.malformed++;
      this._strike(p, 1);
      return;
    }
    const { type, obj } = msg;
    try {
      if (type === MSG.BLOCKS) {
        await this._onBlocks(p, obj);
        return;
      }
      if (type === MSG.INV) {
        const solicited = !!p.session && obj.k <= p.session.lastK;
        if (!this._charge(p, solicited, len)) return;
        this._onInv(p, obj, solicited);
        return;
      }
      if (type === MSG.HELLO) this._onHello(p, obj);
      else if (type === MSG.WANT) this._onWant(p, obj);
      else if (type === MSG.ANN) this._onAnn(p, obj);
      else if (type === MSG.SYNC) this._onSync(p, obj);
    } catch (err) {
      // A bug or a hook failure must never take the transport down with it.
      this._s.errors = (this._s.errors || 0) + 1;
    }
  }

  /** announce(hashes, { except }): ANN to every other peer, then a coalesced HELLO (head change). */
  announce(hashes, { except = null, local = false } = {}) {
    if (this._destroyed) return;
    const list = [];
    for (const h of Array.isArray(hashes) ? hashes : Array.from(hashes || [])) if (isHex64(h)) list.push(h);
    // Review round (STALK-8): every peer gets the ANN after its own random delay (blocks written here
    // annJitterLocalMs, relayed ones annJitterRelayMs), so the first announcer of a block is not its author.
    // The HELLO that carries a local block as a head waits for the longest local delay as well.
    const span = jitterSpan(local ? this.limits.annJitterLocalMs : this.limits.annJitterRelayMs);
    if (list.length > 0) {
      for (const p of this._peers.values()) {
        if (p.ignored || p.id === except) continue;
        const delay = span[1] > 0 ? Math.floor(span[0] + this._random() * (span[1] - span[0])) : 0;
        if (delay <= 0) this._queueAnn(p, list);
        else {
          this._setTimeout(() => {
            if (!this._destroyed && this._peers.get(p.id) === p && !p.ignored) this._queueAnn(p, list);
          }, delay);
        }
      }
    }
    if (local && span[1] > 0) {
      this._setTimeout(() => {
        if (this._destroyed) return;
        this._rootMaybeChanged();
        this._pump();
      }, span[1]);
    } else this._rootMaybeChanged();
    this._pump();
  }

  _queueAnn(p, list) {
    for (const h of list) {
      if (p.annSet.has(h)) continue;
      p.annSet.add(h);
      p.annPending.push(h);
    }
    if (p.annPending.length > this.limits.annBacklog) {
      // Too much to announce: the coalesced HELLO tells the peer to sync instead.
      p.annPending = [];
      p.annSet.clear();
      this._s.annOverflow = (this._s.annOverflow || 0) + 1;
    }
    this._flushAnn(p);
  }

  /** hello(): HELLO to every peer now. */
  hello() {
    for (const p of this._peers.values()) if (!p.ignored) this._sendHello(p);
  }

  /** wantValues(hashes): asks any peer for the payload of held v-less blocks (WANT { v: true }). */
  wantValues(hashes) {
    for (const h of hashes || []) this._want(h, { v: true, any: true });
    this._pump();
  }

  /** setOwner(owner): the ledger owner learned late (genesis block); re-HELLO every peer. */
  setOwner(owner) {
    this.owner = typeof owner === 'string' ? owner : null;
    this.hello();
  }

  /**
   * strike(peerId, n = 1): counts n invalid blocks against a peer, as if they had come in a frame
   * (node.js calls it for blocks it checked later, out of its signature-check queue).
   */
  strike(peerId, n = 1) {
    const p = this._peers.get(peerId);
    if (!p || !(n > 0)) return;
    this._strike(p, n);
  }

  /**
   * ingested(peerId, blocks, res): the ingest result of blocks a node checked after the frame that
   * carried them (its signature-check queue): settles their wants, strikes invalid ones, asks for
   * missing parents, as the frame handler does.
   */
  ingested(peerId, blocks, res) {
    const p = this._peers.get(peerId);
    if (!p || this._destroyed) return;
    this._afterIngest(p, Array.isArray(blocks) ? blocks : [], res || {}, new Map());
  }

  /**
   * tick(): call about once a second. Expires wants (10 s, then the next source), sends the 30 s
   * HELLO, ends idle sync sessions and starts due ones, refuses peers that never sent a HELLO,
   * flushes announcements and paced answers.
   */
  tick() {
    if (this._destroyed) return;
    const now = this.now();
    const L = this.limits;
    for (const p of this._peers.values()) {
      for (const [h, at] of p.asked) {
        if (now - at < L.wantTimeoutMs) continue;
        p.asked.delete(h);
        const w = this._wants.get(h);
        if (w && w.peer === p.id) {
          w.tried.add(p.id);
          w.peer = null;
        }
      }
    }
    for (const w of Array.from(this._wants.values())) {
      if (w.any && w.peer === null && now - w.created >= L.maxWantAgeMs) this._fail(w);
    }
    if (now - this._lastMissingAt >= L.missingRetryMs) {
      this._lastMissingAt = now;
      this._wantMissing();
    }
    for (const p of Array.from(this._peers.values())) {
      if (!this._peers.has(p.id) || p.ignored) continue;
      if (!p.hello && now - p.attachedAt >= L.helloWaitMs) {
        // Attached (the remote advertised the extension) but silent: it only holds a slot.
        this._s.silent = (this._s.silent || 0) + 1;
        callHook(p.onIgnored, 'silent');
        this.detach(p.id);
        continue;
      }
      if (now - p.lastHelloSent >= L.helloIntervalMs) this._sendHello(p);
      const s = p.session;
      if (s) {
        for (const job of Array.from(s.jobs.values())) {
          // The last INV page of a window was lost: stop waiting for it.
          if (!job.invDone && job.pending.size === 0 && job.queued.length === 0 && now - job.lastInvAt >= L.wantTimeoutMs) {
            job.invDone = true;
            this._checkJob(job);
          }
        }
        let busy = false;
        for (const job of s.jobs.values()) if (job.active || job.queued.length > 0) busy = true;
        const idleFor = s.added > 0 ? L.syncIdleMs : L.syncNoBlockMs;
        if (!busy && now - s.lastActivity >= idleFor) this._endSession(p, !!p.hello && p.hello.root === this.dag.root());
      } else {
        this._maybeSync(p);
      }
      this._flushAnn(p);
      this._drain(p);
    }
    this._pump();
  }

  // Parents that held orphans still wait for (a WANT was lost, refused or timed out): asked
  // again, from the orphan's sender first.
  _wantMissing() {
    if (typeof this.dag.missing !== 'function' || this._peers.size === 0) return;
    const missing = this.dag.missing();
    let budget = this.limits.maxWant * 4;
    for (const h of missing) {
      if (budget <= 0) break;
      if (this._wants.has(h) || this._covered(h)) continue;
      budget--;
      const sender = typeof this.dag.orphanSender === 'function' ? this.dag.orphanSender(h) : null;
      const sources = [];
      if (sender !== null && this._peers.has(sender)) sources.push(sender);
      for (const id of this._peers.keys()) if (sources.indexOf(id) < 0) sources.push(id);
      this._want(h, { sources, parent: true });
    }
  }

  /** destroy(): stops timers, detaches every peer (their transports are told), drops all wants. */
  destroy() {
    if (this._destroyed) return;
    for (const id of Array.from(this._peers.keys())) this.detach(id);
    this._destroyed = true;
    if (this._helloTimer !== null) this._clearTimeout(this._helloTimer);
    this._helloTimer = null;
    this._wants.clear();
  }

  // ---------------------------------------------------------------------------------------------
  // Peers, budgets, egress
  // ---------------------------------------------------------------------------------------------

  _newPeer(id, peer) {
    const L = this.limits;
    const now = this.now;
    const t = now();
    return {
      id,
      group: peer.group !== undefined && peer.group !== null && String(peer.group) !== '' ? String(peer.group) : id,
      send: peer.send,
      close: typeof peer.close === 'function' ? peer.close : null,
      onIgnored: typeof peer.ignored === 'function' ? peer.ignored : null,
      onDelivered: typeof peer.delivered === 'function' ? peer.delivered : null,
      onSynced: typeof peer.synced === 'function' ? peer.synced : null,
      attachedAt: t,
      lastFrameAt: null,
      lastSyncedNotice: -Infinity,
      hello: null,
      lastHelloSent: -Infinity,
      invalid: 0,
      ignored: false,
      delivered: 0,
      unsol: new Bucket(L.unsolicitedRate, L.unsolicitedBurst, now),
      sol: new Bucket(L.solicitedRate, L.solicitedBurst, now),
      solTotal: 0,
      ctl: new Bucket(L.controlRate, L.controlBurst, now),
      out: new Bucket(L.egressRate, L.egressBurst, now),
      outQueue: [],
      outBytes: 0,
      invQueued: new Set(),
      drainTimer: null,
      annPending: [],
      annSet: new Set(),
      asked: new Map(),
      origins: new Set(), // wants created from this peer's ANN or INV (PEER A6), oldest first
      activeJobs: 0,
      session: null,
      nextSyncAt: 0,
      syncAfter: 0,
      backoff: L.syncBackoffMs,
      lastSyncStart: -Infinity, // review round (MP-2)
      fastWants: new Set(), // review round (MP-11): wants made from this peer's HELLO heads
    };
  }

  _solicitedCap() {
    const cap = this.limits.solicitedCap;
    if (typeof cap === 'number') return cap;
    const max = Number(this._maxChainBytes()) || DEFAULT_MAX_CHAIN;
    return 2 * max + 1048576;
  }

  // Charges an incoming frame (or block) to the peer's budget; false = drop it. Code review round 1:
  // the solicited allowance (solTotal) counts only bytes that were added (see _onBlocks), so blocks
  // a node at its cap refuses never use it up, and privileged authors (owner, moderators,
  // allow-listed) are never stopped by it; the rate bucket still applies to everything.
  _charge(p, solicited, bytes, privileged = false) {
    if (solicited) {
      if ((!privileged && p.solTotal >= this._solicitedCap()) || !p.sol.take(bytes)) {
        this._s.dropped++;
        return false;
      }
      return true;
    }
    if (!p.unsol.take(bytes)) {
      this._s.dropped++;
      return false;
    }
    return true;
  }

  _strike(p, n) {
    p.invalid += n;
    this._s.invalid += n;
    if (!p.ignored && p.invalid > this.limits.maxInvalid) {
      p.ignored = true;
      this._s.peersIgnored = (this._s.peersIgnored || 0) + 1;
      this._endSession(p, false);
      for (const h of p.asked.keys()) {
        const w = this._wants.get(h);
        if (w && w.peer === p.id) {
          w.tried.add(p.id);
          w.peer = null;
        }
      }
      p.asked.clear();
      this._dropOrigins(p);
      p.outQueue = [];
      p.outBytes = 0;
      p.invQueued.clear();
      if (typeof this.dag.dropOrphansFrom === 'function') this.dag.dropOrphansFrom(p.id);
      // MF-74: an ignored peer keeps no slot; the transport closes the wire.
      callHook(p.onIgnored, 'invalid');
      this._changed();
      this._pump();
    }
  }

  _transmit(p, frame) {
    try {
      p.send(frame);
      this._s.out++;
      this._s.bytesOut += frame.length;
    } catch (_) {
      // the transport closed; its close event detaches the peer
    }
  }

  // Requests and notices: paced by the control bucket. force sends anyway (HELLO, SYNC, and WANTs
  // that were budgeted when they were assigned).
  _sendControl(p, type, obj, force) {
    let frame;
    try {
      frame = encode(type, obj);
    } catch (_) {
      return false;
    }
    if (force) p.ctl.force(frame.length);
    else if (!p.ctl.take(frame.length)) return false;
    this._transmit(p, frame);
    return true;
  }

  _sendHello(p) {
    if (p.ignored || this._destroyed) return;
    const heads = this.dag.heads({ limit: this.limits.maxHeads });
    const hello = {
      v: PROTOCOL_VERSION,
      site: this.site,
      owner: this.owner,
      n: this.dag.size,
      d: this.dag.maxDepth(),
      root: this.dag.root(),
      heads,
    };
    const c = typeof this.dag.coveredCount === 'number' ? this.dag.coveredCount : 0;
    if (c > 0) hello.c = c;
    this._sendControl(p, MSG.HELLO, hello, true);
    p.lastHelloSent = this.now();
  }

  _scheduleHello() {
    if (this._helloTimer !== null || this._destroyed) return;
    this._helloTimer = this._setTimeout(() => {
      this._helloTimer = null;
      if (this._destroyed) return;
      for (const p of this._peers.values()) {
        if (p.ignored) continue;
        this._flushAnn(p);
        this._sendHello(p);
      }
    }, this.limits.helloCoalesceMs);
  }

  _flushAnn(p) {
    while (p.annPending.length > 0 && !p.ignored) {
      const chunk = p.annPending.slice(0, this.limits.maxAnn);
      if (!this._sendControl(p, MSG.ANN, { h: chunk }, false)) return; // wait for budget (tick)
      p.annPending.splice(0, chunk.length);
      for (const h of chunk) p.annSet.delete(h);
    }
  }

  // Answers (INV pages, BLOCKS): paced below the receiver's solicited budget.
  _enqueueAnswer(p, task) {
    if (p.ignored) return;
    if (p.outBytes + task.bytes > this.limits.maxEgressBytes) {
      this._s.dropped++;
      return;
    }
    p.outQueue.push(task);
    p.outBytes += task.bytes;
    this._drain(p);
  }

  // Window k in (depth, h) order, so a requester that WANTs in INV order receives parents before
  // children and few blocks wait as orphans. The list is captured when the first page goes out,
  // so blocks added meanwhile cannot shift later pages.
  _windowList(k) {
    const dag = this.dag;
    const list = dag.hashesInWindow(k);
    list.sort((a, b) => (dag.depth(a) - dag.depth(b)) || (a < b ? -1 : a > b ? 1 : 0));
    return list;
  }

  _invFrame(task) {
    if (!task.list) task.list = this._windowList(task.k);
    const hashes = task.list;
    const page = hashes.slice(task.offset, task.offset + this.limits.maxInv);
    const more = task.offset + page.length < hashes.length;
    return { frame: encode(MSG.INV, { k: task.k, h: page, more }), n: page.length, more };
  }

  _drain(p) {
    if (this._destroyed || this._peers.get(p.id) !== p) return;
    while (p.outQueue.length > 0) {
      const task = p.outQueue[0];
      let frame;
      let inv = null;
      if (task.kind === 'inv') {
        inv = this._invFrame(task);
        frame = inv.frame;
      } else {
        frame = task.frame;
      }
      if (!p.out.take(frame.length)) {
        this._scheduleDrain(p, p.out.msUntil(frame.length));
        return;
      }
      if (inv && inv.more) {
        task.offset += inv.n;
      } else {
        p.outQueue.shift();
        p.outBytes -= task.bytes;
        if (task.kind === 'inv') p.invQueued.delete(task.k);
      }
      this._transmit(p, frame);
    }
  }

  _scheduleDrain(p, ms) {
    if (p.drainTimer !== null || this._destroyed) return;
    p.drainTimer = this._setTimeout(() => {
      p.drainTimer = null;
      this._drain(p);
    }, Math.max(10, ms));
  }

  _changed() {
    if (this._onChange) {
      try {
        this._onChange();
      } catch (_) {
        // observers never break the protocol
      }
    }
  }

  _rootMaybeChanged() {
    const root = this.dag.root();
    if (root === this._lastRoot) return;
    this._lastRoot = root;
    for (const p of this._peers.values()) {
      if (!p.hello || p.hello.root !== root) continue;
      if (p.session) this._endSession(p, true);
      p.backoff = this.limits.syncBackoffMs;
      p.solTotal = 0;
    }
    this._scheduleHello();
    this._changed();
  }

  // ---------------------------------------------------------------------------------------------
  // Frame handlers
  // ---------------------------------------------------------------------------------------------

  _onHello(p, h) {
    const owner = h.owner === undefined ? null : h.owner;
    if (h.v !== PROTOCOL_VERSION || h.site !== this.site || owner !== this.owner) {
      this._s.mismatch = (this._s.mismatch || 0) + 1;
      this.detach(p.id);
      return;
    }
    const first = p.hello === null;
    const prevRoot = first ? null : p.hello.root;
    p.hello = { v: h.v, site: h.site, owner, n: h.n, d: h.d, c: h.c === undefined ? 0 : h.c, root: h.root, heads: h.heads.slice() };
    const now = this.now();
    const root = this.dag.root();
    if (h.root === root) {
      if (p.session) this._endSession(p, true);
      p.backoff = this.limits.syncBackoffMs;
      p.solTotal = 0;
      if (now - p.lastSyncedNotice >= this.limits.syncedNoticeMs) {
        p.lastSyncedNotice = now;
        callHook(p.onSynced);
      }
    } else {
      const unknown = [];
      for (const x of h.heads) if (!this._held(x) && !(this._skip && this._skip(x))) unknown.push(x);
      // Code review round 1: a new root whose heads are all held or refused (two nodes at their
      // cap with different subsets) keeps the back-off, instead of a fresh sync every 2 s.
      if (prevRoot !== h.root && (unknown.length > 0 || prevRoot === null)) {
        p.backoff = this.limits.syncBackoffMs;
        p.nextSyncAt = Math.min(p.nextSyncAt, now);
        // Review round (MP-2): a fresh root in every HELLO used to end the session and start another at once
        // (three forced SYNC frames per 323-byte HELLO). A session younger than syncStartGapMs keeps running;
        // _maybeSync starts at most one session per peer per syncStartGapMs.
        if (p.session && p.session.theirRoot !== h.root && now - p.session.startedAt >= this.limits.syncStartGapMs) this._endSession(p, true);
      } else if (prevRoot !== h.root && p.session && p.session.theirRoot !== h.root) {
        this._endSession(p, false);
      }
      if (!p.session && unknown.length > 0 && h.d <= this.dag.maxDepth() + this.limits.fastPathDepth) {
        // A few new blocks on top of what we hold: fetch them directly, sync if that is not
        // enough. The fallback deadline is set once per divergence, so a peer that keeps writing
        // (a HELLO every 250 ms) cannot postpone the sync indefinitely.
        for (const x of unknown) {
          // Review round (MP-11): one peer's HELLO heads hold at most maxFastWantsPerPeer wants.
          if (p.fastWants.size >= this.limits.maxFastWantsPerPeer) {
            for (const f of Array.from(p.fastWants)) if (!this._wants.has(f)) p.fastWants.delete(f);
            if (p.fastWants.size >= this.limits.maxFastWantsPerPeer) {
              this._s.dropped++;
              continue;
            }
          }
          if (!this._wants.has(x)) p.fastWants.add(x);
          this._want(x, { sources: [p.id], fast: true });
        }
        if (!(p.syncAfter > now)) p.syncAfter = now + this.limits.syncFallbackMs;
      } else {
        this._maybeSync(p);
      }
    }
    if (first || prevRoot !== h.root) this._changed();
    this._pump();
  }

  _onAnn(p, obj) {
    for (const h of obj.h) this._want(h, { sources: [p.id], origin: p });
    this._pump();
  }

  _onWant(p, obj) {
    // Units travel whole, in one frame: a v-less payload block together with the tombstones or
    // bans that justify it (6.6), otherwise a single block. A block whose value the node holds but
    // hides (hidden hook) travels like a v-less one: as its stub with the tombstone.
    const units = [];
    const asked = new Set();
    const unit = (blocks) => {
      const list = [];
      for (const b of blocks) if (b && isHex64(b.h) && list.indexOf(b) < 0) list.push(b);
      if (list.length > 0) units.push(list);
    };
    for (const h of obj.h) {
      if (asked.has(h)) continue;
      asked.add(h);
      const b = this._getBlock(h);
      if (!b) continue;
      const hidden = b.v !== undefined && this._hidden !== null && isPayloadBlock(b) && this._hidden(h) === true;
      if (obj.v === true) {
        if (b.v !== undefined && !hidden) unit([b]);
        else if (this._justify) unit(this._justify(h) || []); // why the value is gone
      } else if (isPayloadBlock(b) && (b.v === undefined || hidden)) {
        const just = this._justify ? this._justify(h) || [] : [];
        if (just.length > 0) unit([hidden ? { e: b.e, h: b.h, s: b.s } : b].concat(just));
      } else {
        unit([b]);
      }
    }
    if (units.length === 0) return;
    // Lowest depth first (stable): parents travel before their children.
    const depthOf = (b) => {
      const d = this.dag.depth(b.h);
      return d === undefined ? Infinity : d;
    };
    units.sort((a, b) => depthOf(a[0]) - depthOf(b[0]));
    // Pack into BLOCKS frames: frame bytes = 8 + sum(json bytes + 1) for '\x03{"b":[' a,b ']}'.
    let items = [];
    let inFrame = new Set();
    let size = 8;
    const flush = () => {
      if (items.length === 0) return;
      const body = utf8.encode('{"b":[' + items.join(',') + ']}');
      items = [];
      inFrame = new Set();
      size = 8;
      if (body.length + 1 > FRAME_MAX) return; // the accounting above prevents this
      const frame = new Uint8Array(body.length + 1);
      frame[0] = MSG.BLOCKS;
      frame.set(body, 1);
      this._enqueueAnswer(p, { kind: 'blocks', frame, bytes: frame.length });
    };
    for (const u of units) {
      const parts = [];
      for (const b of u) {
        let json;
        try {
          json = JSON.stringify(blockOnly(b));
        } catch (_) {
          continue;
        }
        parts.push({ h: b.h, json, n: byteLength(json) + 1 });
      }
      let need = 0;
      for (const x of parts) if (!inFrame.has(x.h)) need += x.n;
      if (size + need > FRAME_MAX) flush();
      for (const x of parts) {
        if (inFrame.has(x.h)) continue;
        if (size + x.n > FRAME_MAX) flush(); // only for a unit larger than a frame
        if (size + x.n > FRAME_MAX) continue; // a single block above the frame cap
        inFrame.add(x.h);
        items.push(x.json);
        size += x.n;
      }
    }
    flush();
  }

  _onSync(p, obj) {
    const ours = this.dag.windows();
    for (const w of obj.w) {
      const mine = w.k < ours.length ? ours[w.k] : null;
      const dg = mine ? mine.dg : EMPTY_DIGEST;
      if (dg === w.dg || p.invQueued.has(w.k)) continue;
      p.invQueued.add(w.k);
      this._enqueueAnswer(p, { kind: 'inv', k: w.k, offset: 0, bytes: 1024 });
    }
  }

  _onInv(p, obj, solicited) {
    if (!solicited) {
      // An advertisement outside a session: treated like ANN.
      for (const h of obj.h) this._want(h, { sources: [p.id], origin: p });
      this._pump();
      return;
    }
    const s = p.session;
    const now = this.now();
    s.lastActivity = now;
    let job = s.jobs.get(obj.k);
    if (!job) {
      job = { k: obj.k, session: s, owner: p, queued: [], pending: new Set(), seen: new Set(), invDone: false, active: false, peer: null, lastInvAt: now };
      s.jobs.set(obj.k, job);
    }
    job.lastInvAt = now;
    // Review round (MP-1): an honest peer lists at most what its HELLO says it holds (n + c), and a session
    // keeps at most maxSessionBacklog hashes queued or wanted; a window cut short is listed again by the next
    // session (its digest still differs), so the bound costs an honest sync a round, never data.
    const listCap = Math.min(MAX_LEDGER_BLOCKS, (p.hello ? p.hello.n + p.hello.c : 0) + 64);
    let room = this.limits.maxSessionBacklog - sessionBacklog(s);
    for (const h of obj.h) {
      if (job.seen.has(h)) continue;
      if (s.listed >= listCap) {
        this._s.invOverflow = (this._s.invOverflow || 0) + 1;
        this._strike(p, 1);
        if (p.session === s) this._endSession(p, false);
        this._pump();
        return;
      }
      s.listed++;
      if (room <= 0) {
        job.truncated = true;
        continue;
      }
      job.seen.add(h);
      // Already wanted (an ANN from a peer that went quiet, say): the window's peers become
      // further sources of that want and the window waits for it too.
      if (this._held(h)) continue;
      if (this._skip && this._skip(h)) continue;
      if (job.active) this._want(h, { sources: this._sameRootIds(p, job.peer), job });
      else job.queued.push(h);
      room--;
    }
    if (!obj.more) job.invDone = true;
    this._checkJob(job);
    this._pump();
  }

  async _onBlocks(p, obj) {
    const accepted = [];
    const sizes = new Map(); // h -> bytes of a solicited item that counts toward solTotal once added
    const history = new Set(); // asked for by a sync session, as a parent, or for its value
    for (const item of obj.b) {
      const h = isHex64(item.h) ? item.h : null;
      const size = itemBytes(item);
      const solicited = h !== null && p.asked.has(h);
      const author = item && item.e && typeof item.e.author === 'string' ? item.e.author : null;
      let privileged = false;
      if (author !== null && this._privileged) {
        try {
          privileged = this._privileged(author) === true;
        } catch (_) {
          privileged = false;
        }
      }
      if (!this._charge(p, solicited, size, privileged)) continue;
      if (solicited) {
        const w = this._wants.get(h);
        if (w && (w.job || w.parent || w.v)) history.add(h);
        p.asked.delete(h);
        if (!privileged) sizes.set(h, size);
      }
      accepted.push(item);
    }
    if (accepted.length === 0) return;
    if (p.session) p.session.lastActivity = this.now();
    let res;
    try {
      res = await this._ingest(accepted, p.id, { history, wire: true });
    } catch (_) {
      // The ingest failed as a whole: what was asked of this peer can be asked again.
      for (const item of accepted) {
        const w = isHex64(item.h) ? this._wants.get(item.h) : null;
        if (w && w.peer === p.id) w.peer = null;
      }
      if (!this._destroyed) this._pump();
      return;
    }
    if (this._destroyed || this._peers.get(p.id) !== p) return;
    this._afterIngest(p, accepted, res || {}, sizes);
  }

  // What follows an ingest of blocks from p (a frame now, or the node's queue later).
  _afterIngest(p, accepted, res, sizes) {
    const added = Array.isArray(res.added) ? res.added : [];
    const rejected = Array.isArray(res.rejected) ? res.rejected : [];
    const duplicates = Array.isArray(res.duplicates) ? res.duplicates : [];
    const orphans = Array.isArray(res.orphans) ? res.orphans : [];
    let invalid = 0;
    for (const r of rejected) {
      if (!r) continue;
      if (INVALID.has(r.reason)) {
        invalid++;
        const w = this._wants.get(r.h);
        if (w && (w.peer === p.id || w.peer === null)) {
          w.tried.add(p.id);
          w.peer = null;
        }
      } else if (isHex64(r.h)) {
        // Refused by policy, throttle or cap: never remembered by hash here, simply not chased now.
        this._resolve(r.h);
      }
    }
    if (p.session && added.length > 0) p.session.added += added.length;
    for (const h of added) {
      const n = sizes.get(h);
      if (n !== undefined) p.solTotal += n;
    }
    if (added.length > 0) {
      this._lastProgressAt = this.now();
      if (p.delivered === 0) callHook(p.onDelivered);
      p.delivered += added.length;
    }
    for (const h of added) this._arrived(h, p);
    for (const h of duplicates) this._arrived(h, p);
    // A block held as an orphan has arrived too; if the pool evicts it, a later sync fetches it.
    // A head from the HELLO fast path or a parent we asked for that is itself an orphan means
    // more than a level or two is missing: walking it one round trip per level is what the
    // depth-window sync replaces, so a session starts at once.
    // Blocks the node set aside until their parents arrive (judged without them) count alike, and
    // so do blocks it queued for their signature check (held: not asked again).
    let deep = false;
    const deferred = Array.isArray(res.deferred) ? res.deferred : [];
    const queued = Array.isArray(res.queued) ? res.queued : [];
    for (const h of orphans.concat(deferred)) {
      const w = this._wants.get(h);
      if (w && (w.parent || w.fast)) deep = true;
      this._arrived(h, p);
    }
    for (const h of queued) this._arrived(h, p);
    // Orphans: their unknown parents come from the orphan's sender first, then from anyone.
    const others = [];
    for (const q of this._peers.values()) if (q !== p && !q.ignored) others.push(q.id);
    for (const item of accepted) {
      if (!item || !isHex64(item.h) || !item.e || !Array.isArray(item.e.prev)) continue;
      if (!this.dag.hasOrphan(item.h) && !(this._pending && this._pending(item.h))) continue;
      for (const parent of item.e.prev) {
        if (!isHex64(parent) || this._held(parent)) continue;
        this._want(parent, { sources: [p.id].concat(others), parent: true });
      }
    }
    if (Array.isArray(res.needValue)) {
      // A stub without its justification: ask the other peers for the value first, then any
      // peer (including ones that attach later), the sender last; after a grace period, since
      // the tombstone may sit in the next frame or wait as an orphan for its own parents.
      for (const h of res.needValue) {
        this._want(h, { v: true, sources: others.concat([p.id]), any: true, delay: this.limits.valueGraceMs });
      }
    }
    if (invalid > 0) this._strike(p, invalid);
    this._rootMaybeChanged();
    if (deep && !p.ignored && this._peers.get(p.id) === p && !p.session && p.hello && p.hello.root !== this.dag.root()) {
      p.syncAfter = 0;
      p.nextSyncAt = Math.min(p.nextSyncAt, this.now());
      this._maybeSync(p);
    }
    this._pump();
  }

  // ---------------------------------------------------------------------------------------------
  // Wants: one in-flight peer per hash
  // ---------------------------------------------------------------------------------------------

  // sources: peer ids in preference order. v: wants the value of a held stub. job: the sync
  // window it belongs to. parent: a missing parent of a held orphan (bypasses skip, its sources
  // go first). any: every attached peer is a source. fast: a head fetched from a HELLO. delay:
  // the first WANT waits this long (a justification may still be on its way). origin: the peer
  // whose ANN or INV created it (counted against that peer's maxWantsPerSource, PEER A6).
  _want(h, { sources = [], v = false, job = null, parent = false, any = false, fast = false, delay = 0, origin = null } = {}) {
    if (!isHex64(h) || this._destroyed) return;
    if (v) {
      if (!this.dag.has(h) || (this._needsValue && !this._needsValue(h))) return;
    } else {
      if (this._held(h)) return;
      if (!parent && this._skip && this._skip(h)) return;
    }
    let w = this._wants.get(h);
    if (w) {
      for (const id of sources) {
        const at = w.sources.indexOf(id);
        if (parent && at > 0 && w.peer === null) {
          w.sources.splice(at, 1);
          w.sources.unshift(id);
        } else if (at < 0) {
          if (parent && w.peer === null) w.sources.unshift(id);
          else w.sources.push(id);
        }
      }
      if (any) w.any = true;
      if (parent) w.parent = true;
      if (fast) w.fast = true;
      if (job && !w.job) {
        w.job = job;
        job.pending.add(h);
      }
      return;
    }
    if (!job && this._wants.size >= this.limits.maxWants) {
      this._s.dropped++;
      return;
    }
    if (origin !== null && !job && !parent) {
      // PEER A6: one peer's advertisements hold at most maxWantsPerSource wants; its oldest goes.
      while (origin.origins.size >= this.limits.maxWantsPerSource) {
        const oldest = origin.origins.values().next().value;
        origin.origins.delete(oldest);
        const ow = this._wants.get(oldest);
        if (ow && ow.origin === origin && !ow.job && !ow.parent) {
          this._s.wantsEvicted++;
          this._resolve(oldest);
        }
      }
    }
    const list = [];
    for (const id of sources) if (list.indexOf(id) < 0) list.push(id);
    const created = this.now();
    w = {
      h, v, sources: list, tried: new Set(), tries: 0, peer: null, at: 0, job, any, parent, fast, created,
      notBefore: delay > 0 ? created + delay : 0, origin: origin !== null && !job && !parent ? origin : null,
    };
    this._wants.set(h, w);
    if (w.origin) w.origin.origins.add(h);
    if (job) job.pending.add(h);
  }

  // A block arrived (added, or already held): settle its want unless it still lacks a wanted value.
  _arrived(h, from) {
    const w = this._wants.get(h);
    if (!w) return;
    if (w.v && this._needsValue && this._needsValue(h)) {
      if (w.peer === from.id) {
        w.tried.add(from.id);
        w.peer = null;
      }
      return;
    }
    this._resolve(h);
  }

  _resolve(h) {
    const w = this._wants.get(h);
    if (!w) return;
    this._wants.delete(h);
    if (w.origin) w.origin.origins.delete(h);
    if (w.job) {
      w.job.pending.delete(h);
      this._checkJob(w.job);
    }
  }

  _dropOrigins(p) {
    for (const h of Array.from(p.origins)) {
      const w = this._wants.get(h);
      if (w && w.origin === p && w.sources.length <= 1 && !w.job && !w.parent) this._resolve(h);
    }
    p.origins.clear();
  }

  _fail(w) {
    if (this._wants.get(w.h) !== w) return;
    this._s.failedWants++;
    this._resolve(w.h);
  }

  _stillWanted(w) {
    if (w.v) return this.dag.has(w.h) && (!this._needsValue || this._needsValue(w.h));
    return !this._held(w.h);
  }

  _covered(h) {
    return typeof this.dag.isCovered === 'function' && this.dag.isCovered(h);
  }

  // Held: in the DAG, waiting in the orphan pool, covered by the checkpoint base (pruned, never
  // fetched again), or set aside by the node (pending hook).
  _held(h) {
    return this.dag.has(h) || this.dag.hasOrphan(h) || this._covered(h) || (this._pending !== null && this._pending(h));
  }

  _sourceIds(w) {
    if (!w.any) return w.sources;
    const ids = w.sources.slice();
    for (const id of this._peers.keys()) if (ids.indexOf(id) < 0) ids.push(id);
    return ids;
  }

  _peerBusy(id) {
    if (this._busy === null) return false;
    try {
      return this._busy(id) === true;
    } catch (_) {
      return false;
    }
  }

  _pickSource(w, plan) {
    const ids = this._sourceIds(w);
    for (let pass = 0; pass < 2; pass++) {
      let live = 0;
      let untried = 0;
      for (const id of ids) {
        const q = this._peers.get(id);
        if (!q || q.ignored) continue;
        live++;
        if (w.tried.has(id)) continue;
        untried++;
        if (q.asked.size >= this.limits.maxAskedPerPeer) continue;
        if (this._peerBusy(id)) continue;
        const e = plan.get(id);
        const budget = e ? e.budget : q.ctl.available() - WANT_FRAME_BYTES;
        if (budget < WANT_HASH_BYTES) continue;
        return q;
      }
      if (untried > 0) return null; // sources exist but are busy or out of budget right now
      if (live === 0) {
        if (!w.any) this._fail(w);
        return null;
      }
      if (pass === 0 && w.tries < this.limits.maxTries) {
        w.tried.clear(); // every source tried once: go round again
        continue;
      }
      this._fail(w);
      return null;
    }
    return null;
  }

  _pump() {
    if (this._destroyed) return;
    this._pumpJobs();
    this._pumpWants();
  }

  _pumpWants() {
    if (this._wants.size === 0) return;
    const now = this.now();
    const plan = new Map();
    for (const w of Array.from(this._wants.values())) {
      if (w.peer !== null || this._wants.get(w.h) !== w || w.notBefore > now) continue;
      if (!this._stillWanted(w)) {
        this._resolve(w.h);
        continue;
      }
      const q = this._pickSource(w, plan);
      if (!q) continue;
      let e = plan.get(q.id);
      if (!e) {
        e = { p: q, plain: [], v: [], budget: q.ctl.available() - WANT_FRAME_BYTES };
        plan.set(q.id, e);
      }
      (w.v ? e.v : e.plain).push(w.h);
      e.budget -= WANT_HASH_BYTES;
      w.peer = q.id;
      w.at = now;
      w.tries++;
      q.asked.set(w.h, now);
    }
    const max = this.limits.maxWant;
    for (const e of plan.values()) {
      for (let i = 0; i < e.plain.length; i += max) this._sendControl(e.p, MSG.WANT, { h: e.plain.slice(i, i + max) }, true);
      for (let i = 0; i < e.v.length; i += max) this._sendControl(e.p, MSG.WANT, { h: e.v.slice(i, i + max), v: true }, true);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Sync sessions and window jobs
  // ---------------------------------------------------------------------------------------------

  _maybeSync(p) {
    if (!p.hello || p.ignored || p.session || this._destroyed) return false;
    const now = this.now();
    const root = this.dag.root();
    if (p.hello.root === root) return false;
    if (now < p.nextSyncAt || now < p.syncAfter) return false;
    if (now - p.lastSyncStart < this.limits.syncStartGapMs) return false; // review round (MP-2)
    const heads = p.hello.heads;
    if (heads.length < this.limits.maxHeads) {
      let all = true;
      for (const h of heads) if (!this.dag.has(h) && !this._covered(h) && !(this._skip && this._skip(h))) all = false;
      if (all) return false; // we already hold (or refuse) everything it has; it pulls from us
    }
    let sessions = 0;
    let victim = null;
    for (const q of this._peers.values()) {
      if (!q.session) continue;
      sessions++;
      if (q !== p && q.session.theirRoot === p.hello.root) return false; // same set: that session serves both
      if (q.delivered === 0 && (victim === null || q.session.startedAt < victim.session.startedAt)) victim = q;
    }
    if (sessions >= this.limits.maxSyncSessions) {
      // PEER A7: a peer that delivered valid blocks pre-empts a session with one that never did.
      if (p.delivered === 0 || victim === null) return false;
      this._s.preempted++;
      this._endSession(victim, false);
    }
    return this._startSync(p);
  }

  _startSync(p) {
    const ourD = this.dag.maxDepth();
    // MF-73: the peer's d is bounded by the codec; clamped here as well, to the ledger bound and to
    // syncLookahead windows beyond our own depth, so one HELLO costs a few SYNC frames whatever it claims.
    const D = Math.min(Math.max(ourD, p.hello.d), MAX_LEDGER_BLOCKS - 1);
    if (D < 0) return false;
    const ourLast = ourD < 0 ? -1 : Math.floor(ourD / WINDOW_SIZE);
    const ahead = Number.isSafeInteger(this.limits.syncLookahead) && this.limits.syncLookahead > 0 ? this.limits.syncLookahead : 256;
    const last = Math.min(Math.floor(D / WINDOW_SIZE), MAX_WINDOWS - 1, ourLast + ahead);
    const ours = this.dag.windows();
    const now = this.now();
    p.session = {
      theirRoot: p.hello.root,
      ourRoot: this.dag.root(),
      startedAt: now,
      lastActivity: now,
      lastK: last,
      jobs: new Map(),
      added: 0, // blocks that entered the DAG from this peer during the session
      listed: 0, // hashes the peer's INV pages listed in this session (review round, MP-1)
    };
    p.lastSyncStart = now;
    const step = this.limits.maxSyncWindows;
    for (let k0 = 0; k0 <= last; k0 += step) {
      const w = [];
      for (let k = k0; k <= last && k < k0 + step; k++) {
        const mine = k < ours.length ? ours[k] : null;
        w.push({ k, dg: mine ? mine.dg : EMPTY_DIGEST, n: mine ? mine.n : 0 });
      }
      this._sendControl(p, MSG.SYNC, { w }, true);
    }
    this._s.syncs = (this._s.syncs || 0) + 1;
    return true;
  }

  _endSession(p, reached) {
    const s = p.session;
    if (s) {
      p.session = null;
      for (const job of s.jobs.values()) {
        if (job.active && job.peer !== null) {
          const q = this._peers.get(job.peer);
          if (q && q.activeJobs > 0) q.activeJobs--;
        }
        job.active = false;
        job.peer = null;
        // Hashes already asked for keep going as ordinary wants.
        for (const h of job.pending) {
          const w = this._wants.get(h);
          if (w && w.job === job) w.job = null;
        }
        job.pending.clear();
        job.queued = [];
      }
      s.jobs.clear();
    }
    const now = this.now();
    if (reached) {
      p.backoff = this.limits.syncBackoffMs;
      p.nextSyncAt = now;
    } else if (s && s.added > 0) {
      // Progress but not there yet (lost frames, a busy peer): go again soon.
      p.backoff = this.limits.syncBackoffMs;
      p.nextSyncAt = now + p.backoff;
    } else if (s) {
      // Nothing came in (the peer holds blocks we refuse, or it does not answer): back off.
      p.nextSyncAt = now + p.backoff;
      p.backoff = Math.min(this.limits.syncBackoffMaxMs, p.backoff * 2);
    }
  }

  // Ids of peers holding the same block set as p (same advertised root): the job's peer first.
  _sameRootIds(p, first) {
    const root = p.session ? p.session.theirRoot : p.hello ? p.hello.root : null;
    const ids = [];
    if (first !== null && first !== undefined) ids.push(first);
    if (ids.indexOf(p.id) < 0) ids.push(p.id);
    for (const q of this._peers.values()) {
      if (q.ignored || !q.hello || q.hello.root !== root || ids.indexOf(q.id) >= 0) continue;
      ids.push(q.id);
    }
    return ids;
  }

  _pickJobPeer(p) {
    const root = p.session.theirRoot;
    const cands = [];
    for (const q of this._peers.values()) {
      if (q.ignored || !q.hello) continue;
      if (q !== p && q.hello.root !== root) continue;
      if (q.activeJobs >= this.limits.windowsInFlight) continue;
      cands.push(q);
    }
    if (cands.length === 0) return null;
    // Least loaded first; ties go round-robin.
    const start = this._rr++ % cands.length;
    let best = null;
    for (let i = 0; i < cands.length; i++) {
      const q = cands[(start + i) % cands.length];
      if (best === null || q.activeJobs < best.activeJobs) best = q;
    }
    return best;
  }

  _pumpJobs() {
    for (const p of Array.from(this._peers.values())) {
      const s = p.session;
      if (!s || p.ignored) continue;
      const ks = Array.from(s.jobs.keys()).sort((a, b) => a - b);
      for (const k of ks) {
        const job = s.jobs.get(k);
        if (!job || job.active || job.queued.length === 0) continue;
        const target = this._pickJobPeer(p);
        if (!target) break;
        job.active = true;
        job.peer = target.id;
        target.activeJobs++;
        const sources = this._sameRootIds(p, target.id);
        const queued = job.queued;
        job.queued = [];
        for (const h of queued) this._want(h, { sources, job });
        this._checkJob(job);
      }
    }
  }

  _checkJob(job) {
    const s = job.session;
    if (s.jobs.get(job.k) !== job) return;
    if (!job.invDone || job.pending.size > 0 || job.queued.length > 0) return;
    if (job.active && job.peer !== null) {
      const q = this._peers.get(job.peer);
      if (q && q.activeJobs > 0) q.activeJobs--;
    }
    job.active = false;
    job.peer = null;
    s.jobs.delete(job.k);
    s.lastActivity = this.now();
  }
}
