// In-memory Merkle-DAG of ledger blocks with a deterministic total order (ARCHITECTURE 6.4).
//
// depth(b) = 0 for roots, else 1 + max(depth(p) for p in prev), computed once when the block is
// accepted (all of its parents are present by then, so no recursion is ever needed). The total
// order sorts by (depth, h): every prev has a strictly smaller depth, so causality is respected
// and the tie-break is content-addressed. Two nodes holding the same block set therefore agree on
// order(), root(), heads() and windows() whatever order the blocks arrived in.
//
// Blocks whose parents are unknown wait in a bounded orphan pool (256 per peer, 2 000 in total,
// oldest evicted first) and are inserted as soon as their last missing parent arrives.
// root() and the 64-level window digests hash the sorted 32-byte block hashes with the
// synchronous SHA-256, because INTERFACES makes them synchronous.
//
// The Dag trusts its input: callers validate blocks (block.js validateBlock) before add().
// Blocks are stored as given and must not be mutated afterwards; use redact(h) and
// attachValue(h, v, z) to drop or restore a payload value (with its salt z, v0.2.1 A1) so the
// byte accounting stays correct. dag.bytes counts canonical(e) + canonical(v) + z per block;
// valueBytes(h) is canonical(v) alone (the maxValueBytes rule).
//
// Checkpoints (v0.3 freeze group, DESIGN-REVIEW 2.5.3): pruneTo(checkpointBlock, S) drops every
// held block whose hash S covers (stubs included) and keeps S as the DAG's checkpoint base, which
// state.js reduces from. A covered hash is never held again: add() reports it as 'duplicate', and
// a later block whose prev names a covered hash is accepted as if that parent were held (its depth
// is remembered from pruning; a covered parent never seen here counts as the deepest covered
// block). coveredDepths(S) gives those depths in the order of S.covered, so a copy that stores them
// with S and passes them back to pruneTo(block, S, { depths }) when it reopens keeps the depths, and
// so the windows, of a copy that pruned live (code review v0.3). Whether a checkpoint is in effect
// is decided by state.js (owner standing, snap); the caller prunes only to such a checkpoint.

import { canonicalize, byteLength, hex, utf8, b64url } from './canonical.js';
import { sha256Sync } from './sha256-sync.js';
import { valueHashSync, isSalt, SALT_LENGTH } from './block.js';

export const WINDOW_SIZE = 64;
export const MAX_ORPHANS_PER_PEER = 256;
export const MAX_ORPHANS = 2000;
export const DEFAULT_HEADS_LIMIT = 32;

const HEX64 = /^[0-9a-f]{64}$/;
const PAYLOAD = new Set(['put', 'append', 'profile']);

function nibble(code) {
  return code <= 57 ? code - 48 : code - 87; // '0'-'9' or 'a'-'f' (hashes are validated lowercase hex)
}

/** hex sha256 over the concatenation of already sorted hex hashes taken as raw 32-byte strings. */
function digestSorted(hashes) {
  const bytes = new Uint8Array(hashes.length * 32);
  for (let i = 0; i < hashes.length; i++) {
    const h = hashes[i];
    const base = i * 32;
    for (let j = 0; j < 32; j++) {
      bytes[base + j] = (nibble(h.charCodeAt(2 * j)) << 4) | nibble(h.charCodeAt(2 * j + 1));
    }
  }
  return hex.encode(sha256Sync(bytes));
}

const compareHex = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** pruneTo(dag, checkpointBlock, S) -> { dropped }: the same as dag.pruneTo(checkpointBlock, S). */
export function pruneTo(dag, checkpointBlock, S) {
  return dag.pruneTo(checkpointBlock, S);
}

export class Dag {
  /**
   * new Dag({ maxOrphansPerPeer = 256, maxOrphans = 2000, onAdd = null })
   * onAdd(block, peerId) runs synchronously for every block that enters the DAG, including
   * orphans connected by a later parent (peerId is then the orphan's original sender).
   */
  constructor({ maxOrphansPerPeer = MAX_ORPHANS_PER_PEER, maxOrphans = MAX_ORPHANS, onAdd = null } = {}) {
    this._blocks = new Map(); // h -> block
    this._meta = new Map(); // h -> { depth, eBytes, vBytes }
    this._heads = new Set();
    this._bytes = 0;
    this._maxDepth = -1;
    this._windows = new Map(); // k -> { hashes: string[], sorted: boolean, dg: string | null }
    this._order = null;
    this._root = null;
    this._version = 0;
    this._orphans = new Map(); // h -> { block, peer, missing: Set<h> }, insertion ordered
    this._waiting = new Map(); // missing parent h -> Set<orphan h>
    this._byPeer = new Map(); // peer -> Set<orphan h>, insertion ordered
    this._maxOrphansPerPeer = maxOrphansPerPeer;
    this._maxOrphans = maxOrphans;
    this._onAdd = typeof onAdd === 'function' ? onAdd : null;
    this._covered = null; // Set<h> covered by the checkpoint base (pruneTo)
    this._coveredDepth = new Map(); // covered h -> depth, for covered blocks this DAG held
    this._coveredMaxDepth = -1;
    this._checkpoint = null; // { h, snap, S, parsed? }
    /** Hashes inserted by the most recent add(): the block itself, then any connected orphans. */
    this.lastAdded = [];
  }

  /** true when h is covered by the checkpoint base (pruned, never held again). */
  isCovered(h) {
    return this._covered !== null && this._covered.has(h);
  }

  /** Number of hashes covered by the checkpoint base. */
  get coveredCount() {
    return this._covered === null ? 0 : this._covered.size;
  }

  /** The checkpoint base { h, snap, S } (state.js reduces from it), or null. */
  checkpointBase() {
    return this._checkpoint;
  }

  _parentDepth(p) {
    const m = this._meta.get(p);
    if (m !== undefined) return m.depth;
    const d = this._coveredDepth.get(p);
    return d !== undefined ? d : this._coveredMaxDepth;
  }

  _held(p) {
    return this._blocks.has(p) || (this._covered !== null && this._covered.has(p));
  }

  /** Number of blocks in the DAG (orphans excluded). */
  get size() {
    return this._blocks.size;
  }

  /** Sum over DAG blocks of canonical(e) + canonical(v) bytes (orphans excluded). */
  get bytes() {
    return this._bytes;
  }

  get orphanCount() {
    return this._orphans.size;
  }

  /** Increments on every insertion, redaction and value restore. */
  get version() {
    return this._version;
  }

  has(h) {
    return this._blocks.has(h);
  }

  hasOrphan(h) {
    return this._orphans.has(h);
  }

  get(h) {
    return this._blocks.get(h);
  }

  /** Depth of a block in the DAG, undefined when the block is unknown or still an orphan. */
  depth(h) {
    const m = this._meta.get(h);
    return m === undefined ? undefined : m.depth;
  }

  /** Greatest depth in the DAG, -1 when empty. */
  maxDepth() {
    return this._maxDepth;
  }

  /** Bytes of canonical(v) for a block that holds its value, else 0. */
  valueBytes(h) {
    const block = this._blocks.get(h);
    if (!block || block.v === undefined) return 0;
    const m = this._meta.get(h);
    if (m.vBytes === 0) m.vBytes = byteLength(canonicalize(block.v));
    return m.vBytes;
  }

  blocks() {
    return this._blocks.values();
  }

  /**
   * add(block, peerId = null) -> 'added' | 'duplicate' | 'orphan'.
   * 'duplicate' means the hash is already in the DAG or in the orphan pool. An orphan waits
   * until its parents arrive; every block inserted by this call (the block, then the orphans it
   * connected, in insertion order) is listed in dag.lastAdded.
   */
  add(block, peerId = null) {
    if (!block || typeof block !== 'object' || typeof block.h !== 'string' || !HEX64.test(block.h) ||
      !block.e || typeof block.e !== 'object' || !Array.isArray(block.e.prev)) {
      throw new TypeError('Dag.add expects a validated block { e, h, s, v? }');
    }
    const h = block.h;
    const prev = block.e.prev;
    this.lastAdded = [];
    if (this._blocks.has(h) || this._orphans.has(h) || this.isCovered(h)) return 'duplicate';
    const missing = [];
    for (let i = 0; i < prev.length; i++) {
      const p = prev[i];
      if (typeof p !== 'string' || !HEX64.test(p) || p === h) throw new TypeError('Dag.add: invalid prev hash');
      if (!this._held(p)) missing.push(p);
    }
    if (missing.length > 0) {
      this._storeOrphan(block, peerId, missing);
      return 'orphan';
    }
    const added = [];
    this._insert(block, peerId, added);
    this._connect(h, added);
    this.lastAdded = added;
    return 'added';
  }

  _insert(block, peerId, added) {
    const h = block.h;
    const prev = block.e.prev;
    let depth = 0;
    for (let i = 0; i < prev.length; i++) {
      const d = this._parentDepth(prev[i]) + 1;
      if (d > depth) depth = d;
    }
    // Sizes first: a canonicalisation error must not leave a half-inserted block behind.
    const eBytes = byteLength(canonicalize(block.e));
    const vBytes = block.v === undefined ? 0 : byteLength(canonicalize(block.v));
    const zBytes = block.v !== undefined && block.z !== undefined ? SALT_LENGTH : 0;
    this._blocks.set(h, block);
    this._meta.set(h, { depth, eBytes, vBytes, zBytes });
    this._bytes += eBytes + vBytes + zBytes;
    if (depth > this._maxDepth) this._maxDepth = depth;
    for (let i = 0; i < prev.length; i++) this._heads.delete(prev[i]);
    this._heads.add(h);
    const k = Math.floor(depth / WINDOW_SIZE);
    let w = this._windows.get(k);
    if (!w) {
      w = { hashes: [], sorted: true, dg: null };
      this._windows.set(k, w);
    }
    w.hashes.push(h);
    w.sorted = false;
    w.dg = null;
    this._order = null;
    this._root = null;
    this._version++;
    added.push(h);
    if (this._onAdd) {
      try {
        this._onAdd(block, peerId);
      } catch (_) {
        // A failing hook must not leave the orphan pool half-processed.
      }
    }
  }

  // Inserts every orphan whose last missing parent just arrived, breadth-first, no recursion.
  _connect(first, added) {
    const queue = [first];
    for (let qi = 0; qi < queue.length; qi++) {
      const x = queue[qi];
      const waiters = this._waiting.get(x);
      if (!waiters) continue;
      this._waiting.delete(x);
      for (const o of waiters) {
        const orphan = this._orphans.get(o);
        if (!orphan) continue;
        orphan.missing.delete(x);
        if (orphan.missing.size > 0) continue;
        this._dropOrphanRecord(o, orphan);
        this._insert(orphan.block, orphan.peer, added);
        queue.push(o);
      }
    }
  }

  _storeOrphan(block, peer, missing) {
    if (!(this._maxOrphansPerPeer > 0) || !(this._maxOrphans > 0)) return;
    let set = this._byPeer.get(peer);
    while (set && set.size >= this._maxOrphansPerPeer) {
      this._evict(set.values().next().value);
      set = this._byPeer.get(peer);
    }
    while (this._orphans.size >= this._maxOrphans) this._evict(this._orphans.keys().next().value);
    set = this._byPeer.get(peer);
    if (!set) {
      set = new Set();
      this._byPeer.set(peer, set);
    }
    const h = block.h;
    this._orphans.set(h, { block, peer, missing: new Set(missing) });
    set.add(h);
    for (const m of missing) {
      let waiters = this._waiting.get(m);
      if (!waiters) {
        waiters = new Set();
        this._waiting.set(m, waiters);
      }
      waiters.add(h);
    }
  }

  _dropOrphanRecord(h, orphan) {
    this._orphans.delete(h);
    const set = this._byPeer.get(orphan.peer);
    if (set) {
      set.delete(h);
      if (set.size === 0) this._byPeer.delete(orphan.peer);
    }
  }

  _evict(h) {
    const orphan = this._orphans.get(h);
    if (!orphan) return;
    this._dropOrphanRecord(h, orphan);
    for (const m of orphan.missing) {
      const waiters = this._waiting.get(m);
      if (waiters) {
        waiters.delete(h);
        if (waiters.size === 0) this._waiting.delete(m);
      }
    }
  }

  /** Unknown parents referenced by orphans (neither in the DAG nor pooled), sorted. */
  missing() {
    const out = [];
    for (const h of this._waiting.keys()) if (!this._blocks.has(h) && !this._orphans.has(h)) out.push(h);
    return out.sort();
  }

  /**
   * The peer that sent orphan h; for a missing parent h, the sender of an orphan waiting on it
   * (so a WANT for the parent goes to that peer first). null when unknown.
   */
  orphanSender(h) {
    const orphan = this._orphans.get(h);
    if (orphan) return orphan.peer === undefined ? null : orphan.peer;
    const waiters = this._waiting.get(h);
    if (waiters) {
      for (const w of waiters) {
        const o = this._orphans.get(w);
        if (o) return o.peer === undefined ? null : o.peer;
      }
    }
    return null;
  }

  /** Drops every orphan received from peerId; returns how many were dropped. */
  dropOrphansFrom(peerId) {
    const set = this._byPeer.get(peerId);
    if (!set) return 0;
    const list = Array.from(set);
    for (const h of list) this._evict(h);
    return list.length;
  }

  /** Blocks without children, by (depth desc, h asc), at most `limit` (Infinity for all). */
  heads({ limit = DEFAULT_HEADS_LIMIT } = {}) {
    const list = Array.from(this._heads);
    const meta = this._meta;
    list.sort((a, b) => (meta.get(b).depth - meta.get(a).depth) || compareHex(a, b));
    return limit === Infinity ? list : list.slice(0, Math.max(0, Math.floor(limit) || 0));
  }

  /** All DAG blocks sorted by (depth, h). Cached; a fresh array is returned on every call. */
  order() {
    if (this._order === null) {
      const items = [];
      for (const [h, block] of this._blocks) items.push({ d: this._meta.get(h).depth, h, block });
      items.sort((a, b) => (a.d - b.d) || compareHex(a.h, b.h));
      const out = new Array(items.length);
      for (let i = 0; i < items.length; i++) out[i] = items[i].block;
      this._order = out;
    }
    return this._order.slice();
  }

  /** hex sha256 over the sorted hashes of every DAG block as raw 32-byte strings. */
  root() {
    if (this._root === null) this._root = digestSorted(Array.from(this._blocks.keys()).sort());
    return this._root;
  }

  _window(k) {
    let w = this._windows.get(k);
    if (!w) return null;
    if (!w.sorted) {
      w.hashes.sort();
      w.sorted = true;
      w.dg = null;
    }
    if (w.dg === null) w.dg = digestSorted(w.hashes);
    return w;
  }

  /**
   * Depth windows of WINDOW_SIZE levels, k = 0 .. floor(maxDepth / 64):
   * [{ k, dg: hex sha256 over the window's sorted hashes as raw bytes, n: block count }].
   */
  windows() {
    const out = [];
    if (this._maxDepth < 0) return out;
    const last = Math.floor(this._maxDepth / WINDOW_SIZE);
    for (let k = 0; k <= last; k++) {
      const w = this._window(k);
      if (w) out.push({ k, dg: w.dg, n: w.hashes.length });
      else out.push({ k, dg: digestSorted([]), n: 0 });
    }
    return out;
  }

  /** Sorted hashes of the blocks whose depth lies in window k (a fresh array). */
  hashesInWindow(k) {
    const w = this._window(k);
    return w ? w.hashes.slice() : [];
  }

  /** Every strict ancestor of h (a fresh Set; empty for unknown h). Iterative. */
  ancestors(h) {
    const out = new Set();
    const start = this._blocks.get(h);
    if (!start) return out;
    const stack = start.e.prev.slice();
    while (stack.length > 0) {
      const x = stack.pop();
      if (out.has(x)) continue;
      out.add(x);
      const b = this._blocks.get(x);
      if (!b) continue;
      const prev = b.e.prev;
      for (let i = 0; i < prev.length; i++) if (!out.has(prev[i])) stack.push(prev[i]);
    }
    return out;
  }

  /**
   * coveredDepths(S) -> { list, max }: the depth this DAG knows for each hash S covers, in the order
   * of S.covered (-1 where it never held the block), and the depth a covered parent it never saw
   * counts as. What pruneTo(block, S, { depths }) takes back.
   */
  coveredDepths(S) {
    const list = [];
    let bytes = null;
    try {
      bytes = b64url.decode(S.covered);
    } catch (_) {
      bytes = new Uint8Array(0);
    }
    for (let i = 0; i + 32 <= bytes.length; i += 32) {
      const h = hex.encode(bytes.subarray(i, i + 32));
      const m = this._meta.get(h);
      const d = m !== undefined ? m.depth : this._coveredDepth.get(h);
      list.push(d === undefined ? -1 : d);
    }
    let max = this._coveredMaxDepth;
    for (const d of list) if (d > max) max = d;
    return { list, max };
  }

  /**
   * pruneTo(checkpointBlock, S, { depths } = {}) -> { dropped }: keep S = { v: 1, covered, state } as
   * the checkpoint base and drop every held block (and pooled orphan) whose hash S covers. S must hash
   * to the checkpoint's snap (hex sha256 of canonical(S)), cover exactly n hashes in bytes =
   * byteLength(canonical(S)), cover every head, and cover every hash of the current base; otherwise
   * Error code 'E_SNAP' and nothing changes. Orphans waiting only on covered parents are connected
   * (dag.lastAdded lists them). depths (coveredDepths of the copy that pruned) restores the depths of
   * covered blocks this DAG does not hold, so later blocks get the depths they had there.
   */
  pruneTo(checkpointBlock, S, { depths = null } = {}) {
    const fail = (message) => {
      const err = new Error('pruneTo: ' + message);
      err.code = 'E_SNAP';
      return err;
    };
    const op = checkpointBlock && checkpointBlock.e && checkpointBlock.e.op;
    if (!op || op.t !== 'checkpoint' || !Array.isArray(op.heads)) throw fail('not a checkpoint block');
    let json;
    try {
      json = canonicalize(S);
    } catch (_) {
      throw fail('S is not canonical JSON');
    }
    if (hex.encode(sha256Sync(utf8.encode(json))) !== op.snap) throw fail('S does not match snap');
    if (byteLength(json) !== op.bytes) throw fail('S does not match bytes');
    if (!S || S.v !== 1 || typeof S.covered !== 'string') throw fail('S has no covered set');
    let bytes;
    try {
      bytes = b64url.decode(S.covered);
    } catch (_) {
      throw fail('covered is not base64url');
    }
    if (bytes.length === 0 || bytes.length % 32 !== 0) throw fail('covered must hold 32-byte hashes');
    const covered = new Set();
    let last = '';
    for (let i = 0; i < bytes.length; i += 32) {
      const h = hex.encode(bytes.subarray(i, i + 32));
      if (!(h > last)) throw fail('covered hashes must be sorted and unique');
      covered.add(h);
      last = h;
    }
    if (covered.size !== op.n) throw fail('covered does not hold n hashes');
    for (const h of op.heads) if (!covered.has(h)) throw fail('a head is not covered');
    if (covered.has(checkpointBlock.h)) throw fail('the checkpoint covers itself');
    if (this._covered !== null) for (const h of this._covered) if (!covered.has(h)) throw fail('S does not extend the current checkpoint');
    let dropped = 0;
    for (const h of covered) {
      const block = this._blocks.get(h);
      if (block !== undefined) {
        const m = this._meta.get(h);
        this._coveredDepth.set(h, m.depth);
        if (m.depth > this._coveredMaxDepth) this._coveredMaxDepth = m.depth;
        this._bytes -= m.eBytes + m.vBytes + (m.zBytes || 0);
        this._blocks.delete(h);
        this._meta.delete(h);
        this._heads.delete(h);
        const w = this._windows.get(Math.floor(m.depth / WINDOW_SIZE));
        if (w) {
          const at = w.hashes.indexOf(h);
          if (at >= 0) w.hashes.splice(at, 1);
          w.dg = null;
          if (w.hashes.length === 0) this._windows.delete(Math.floor(m.depth / WINDOW_SIZE));
        }
        dropped++;
      } else if (this._orphans.has(h)) {
        this._evict(h);
        dropped++;
      }
    }
    if (depths && Array.isArray(depths.list) && depths.list.length === covered.size) {
      let k = 0;
      for (const h of covered) {
        const d = depths.list[k++];
        if (Number.isSafeInteger(d) && d >= 0 && !this._coveredDepth.has(h)) {
          this._coveredDepth.set(h, d);
          if (d > this._coveredMaxDepth) this._coveredMaxDepth = d;
        }
      }
      if (Number.isSafeInteger(depths.max) && depths.max > this._coveredMaxDepth) this._coveredMaxDepth = depths.max;
    }
    this._covered = covered;
    this._checkpoint = { h: checkpointBlock.h, snap: op.snap, S };
    this._maxDepth = -1;
    for (const m of this._meta.values()) if (m.depth > this._maxDepth) this._maxDepth = m.depth;
    this._order = null;
    this._root = null;
    this._version++;
    // Orphans whose missing parents are all covered now connect.
    const added = [];
    for (const h of covered) {
      const waiters = this._waiting.get(h);
      if (!waiters) continue;
      this._waiting.delete(h);
      for (const o of waiters) {
        const orphan = this._orphans.get(o);
        if (!orphan) continue;
        orphan.missing.delete(h);
        if (orphan.missing.size > 0) continue;
        this._dropOrphanRecord(o, orphan);
        this._insert(orphan.block, orphan.peer, added);
        this._connect(o, added);
      }
    }
    this.lastAdded = added;
    return { dropped };
  }

  /** Drops the value and its salt from a payload block (tombstone or ban). true when a value was dropped. */
  redact(h) {
    const block = this._blocks.get(h);
    if (!block || block.v === undefined) return false;
    const m = this._meta.get(h);
    const vBytes = m.vBytes || byteLength(canonicalize(block.v));
    this._blocks.set(h, { e: block.e, h: block.h, s: block.s });
    this._bytes -= vBytes + (m.zBytes || 0);
    m.vBytes = 0;
    m.zBytes = 0;
    this._order = null;
    this._version++;
    return true;
  }

  /**
   * Restores the value of a payload block held without one. The value with its salt z must hash
   * to e.op.vh (checked here, A1); the caller decides whether the block may hold a value at all (a
   * tombstoned block must not). true when the value was attached.
   */
  attachValue(h, v, z) {
    const block = this._blocks.get(h);
    if (!block || block.v !== undefined || v === undefined || !isSalt(z)) return false;
    const op = block.e.op;
    if (!op || !PAYLOAD.has(op.t)) return false;
    let str;
    let vh;
    try {
      str = canonicalize(v);
      vh = valueHashSync(v, z);
    } catch (_) {
      return false;
    }
    if (vh !== op.vh) return false;
    const m = this._meta.get(h);
    m.vBytes = byteLength(str);
    m.zBytes = SALT_LENGTH;
    this._blocks.set(h, { e: block.e, h: block.h, s: block.s, v, z });
    this._bytes += m.vBytes + m.zBytes;
    this._order = null;
    this._version++;
    return true;
  }
}
