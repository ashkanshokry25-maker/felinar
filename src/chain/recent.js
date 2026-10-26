// Recent-window sync for the hub follow lane (V03-DESIGN-REVIEW 3.2.2 "Recent-window sync" and "Snapshot
// first", MF-65; ARCHITECTURE 15.8; INTERFACES v0.3 recent.js). v0.3.
//
// A member keeps, for each ledger it follows, a window instead of the whole ledger: the newest `posts`
// (200, chosen) payload blocks (put, append, profile) and every block above them, plus every control
// block of the ledger and the latest checkpoint state S when the copy that answers has pruned to one.
//
// The window (responder side), recentWindow(node, { posts, fromDepth }): F = the depth of the posts-th
// newest payload block in total order (0 when the ledger has fewer), or fromDepth when it is given
// (>= 0); the window is every held block at depth >= F and every control block below it, newest first
// ((depth, h) descending), values that the node hides (moderator tombstone grace) left out. At most
// MAX_WINDOW_BLOCKS blocks (truncated: true beyond that, the oldest control blocks go first).
//
// The view (requester side), RecentView: holds the window's blocks after a full check of each one
// (hash, PoW, signature, value hash: validateBlock, in the node's verifier pool when it has one) and
// computes a display state with state.js:
//   - a block with a parent this copy neither holds nor has covered by a checked checkpoint is flagged
//     "order not yet checked" (orderChecked(h) false) until its parents arrive. The window is a depth
//     suffix, so these are the blocks at its lower edge and the control blocks below it; a block above
//     them has its own parents and is shown in its place;
//   - when nothing is missing the state is reduce() of an ordinary Dag (pruned to the checkpoint when
//     there is one): exactly the full ledger's state for these blocks;
//   - with gaps, the missing parents count as settled history: the view reduces its blocks on top of a
//     checkpoint base (state.js reduceFromCheckpoint) whose state is S (or, without a checkpoint, the
//     genesis policy folded over the defaults) and whose covered set adds the missing hashes. The
//     window carries every control block, so the control state is the full ledger's, except that the
//     relative order of control blocks cut off from each other by gaps is not known: controlExact is
//     false when more than one order-sensitive control block (policy, allow, owner, rotate, keyinfo,
//     unban, checkpoint) has a missing parent, or when the answer was truncated.
// Display needs only these checks; the member's own ledger and ledgers it opens in full keep using
// ChainNode's full sync.
//
// Admission (code review v0.3): a lane peer is anyone in the hub swarm, so the view keeps a checked block
// only when it has an effect in the view's state with it (a payload block that takes effect or a value
// a tombstone or ban hides, a valid control block): a key with no standing under the ledger's writers,
// allow list, bans and fee, or a block claiming a time more than 5 minutes ahead of this clock, is not
// kept. A refusal for lack of standing is marked `strike` (the lane counts it against the peer) when the
// view's control state is exact. Bounded: at most maxBlocks blocks and maxPerAuthor payload blocks per
// key that is not the owner or a moderator; beyond, payload whose value is hidden goes first, then the
// oldest payload by depth (never by claimed ts); control blocks with an effect always stay.
//
// syncRecent(node, peer, { posts, fromDepth }): asks `peer` (any object with recent({ ledger,
// fromDepth, posts }) -> Promise<{ blocks, checkpoint? }>, such as MultiGossip.peerFor(id) or
// localPeer(otherNode)), then applyWindow(): the view of `node` (viewOf(node)) takes the blocks, and
// the blocks whose parents the node holds are also offered to the node itself (history, not live).
//
// Snapshot first (cs=): encodeRecentSnapshot(window) is a JSON array [header, ...blocks] that the
// loader's snapshot reader accepts (it reads arrays; the header is not block-shaped, so an ordinary
// importSnapshot skips it); parseRecentSnapshot(array) gives the window back and loadRecentSnapshot(node,
// array) applies it. Header: { mw: 'recent-v1', ledger, posts, fromDepth, truncated, checkpoint: { h,
// snap, S } | null }.
//
// No Buffer, no node: imports, no post-floor APIs.

import { Dag } from './dag.js';
import { reduce, reduceFromCheckpoint, snapshot as snapshotOf, checkpointSnap, decodeCovered, isBanned, allowListed } from './state.js';
import { validateBlock, LIMITS, DEFAULT_POLICY, FREEZE_POLICY_DEFAULTS, isControlOp, isPayloadOp, redact } from './block.js';
import { hex, b64url } from './canonical.js';
import { topoSort } from './node.js';

export const RECENT_POSTS = 200;
/** Most blocks one window answer carries (chosen): 200 posts plus control blocks fit easily. */
export const MAX_WINDOW_BLOCKS = 4096;
/** Most payload blocks a view keeps from one key that is not the owner or a moderator (chosen). */
export const MAX_VIEW_PER_AUTHOR = 1024;
/** A block claiming a time this far ahead of the view's clock is not kept (as ChainNode futureMs). */
export const VIEW_FUTURE_MS = 300000;
export const RECENT_SNAPSHOT_KIND = 'recent-v1';

const HEX64 = /^[0-9a-f]{64}$/;
const ORDER_SENSITIVE = new Set(['policy', 'allow', 'owner', 'rotate', 'keyinfo', 'unban', 'checkpoint']);

function isPlainObject(x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

function looksLikeBlock(b) {
  return isPlainObject(b) && typeof b.h === 'string' && HEX64.test(b.h) && isPlainObject(b.e) && Array.isArray(b.e.prev) &&
    isPlainObject(b.e.op) && typeof b.e.op.t === 'string';
}

function plainBlock(b) {
  const out = { e: b.e, h: b.h, s: b.s };
  if (b.v !== undefined) {
    out.v = b.v;
    if (b.z !== undefined) out.z = b.z;
  }
  return out;
}

function coded(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function clampPosts(posts) {
  const n = Number.isSafeInteger(posts) ? posts : RECENT_POSTS;
  return Math.max(1, Math.min(RECENT_POSTS, n));
}

// ---------------------------------------------------------------------------------------------
// The window (responder side)
// ---------------------------------------------------------------------------------------------

/**
 * windowFromDag(dag, { posts, fromDepth, hidden, checkpoint, maxBlocks }) -> { blocks (newest first),
 * fromDepth, posts, truncated, checkpoint: { h, snap, S } | null } (see the header). hidden(h) -> true
 * for blocks whose value must not leave (sent as stubs).
 */
export function windowFromDag(dag, { posts = RECENT_POSTS, fromDepth = -1, hidden = null, checkpoint = null, maxBlocks = MAX_WINDOW_BLOCKS } = {}) {
  const order = dag.order();
  const want = clampPosts(posts);
  let F = Number.isSafeInteger(fromDepth) && fromDepth >= 0 ? fromDepth : -1;
  if (F < 0) {
    F = 0;
    let count = 0;
    for (let i = order.length - 1; i >= 0; i--) {
      if (!isPayloadOp(order[i].e.op)) continue;
      count++;
      if (count === want) {
        F = dag.depth(order[i].h);
        break;
      }
    }
  }
  const upper = [];
  const lower = [];
  for (let i = order.length - 1; i >= 0; i--) {
    const b = order[i];
    const d = dag.depth(b.h);
    const form = typeof hidden === 'function' && b.v !== undefined && hidden(b.h) ? redact(b) : plainBlock(b);
    if (d >= F) upper.push(form);
    else if (isControlOp(b.e.op)) lower.push(form);
  }
  let blocks = upper.concat(lower);
  let truncated = false;
  if (blocks.length > maxBlocks) {
    blocks = blocks.slice(0, maxBlocks);
    truncated = true;
  }
  return { blocks, fromDepth: F, posts: want, truncated, checkpoint: checkpoint || null };
}

/** recentWindow(node, { posts = 200, fromDepth = -1 }) -> the window of a ChainNode (see windowFromDag). */
export function recentWindow(node, { posts = RECENT_POSTS, fromDepth = -1, maxBlocks = MAX_WINDOW_BLOCKS } = {}) {
  if (!node || !node.dag) throw new TypeError('recentWindow needs a ChainNode');
  const base = typeof node.checkpointBase === 'function' ? node.checkpointBase() : null;
  const hidden = typeof node.graceList === 'function' ? new Set(node.graceList()) : null;
  return windowFromDag(node.dag, {
    posts, fromDepth, maxBlocks,
    hidden: hidden && hidden.size > 0 ? (h) => hidden.has(h) : null,
    checkpoint: base ? { h: base.h, snap: base.snap, S: base.S } : null,
  });
}

/** localPeer(node, id) -> a peer for syncRecent that answers from another ChainNode in the same process (tests, tools). */
export function localPeer(node, id = 'local') {
  return {
    id,
    async recent({ ledger, fromDepth = -1, posts = RECENT_POSTS } = {}) {
      if (ledger !== undefined && ledger !== node.siteId) return { blocks: [], checkpoint: null };
      return recentWindow(node, { fromDepth, posts });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The view (requester side)
// ---------------------------------------------------------------------------------------------

function coveredString(set) {
  const list = Array.from(set).sort();
  const bytes = new Uint8Array(list.length * 32);
  for (let i = 0; i < list.length; i++) bytes.set(hex.decode(list[i]), i * 32);
  return b64url.encode(bytes);
}

// The defaults of an owned ledger's control state, with the genesis policy op folded in (when given).
function baseState(genesisOwner, genesis) {
  const p = {
    writers: DEFAULT_POLICY.writers,
    bits: DEFAULT_POLICY.bits,
    maxValueBytes: DEFAULT_POLICY.maxValueBytes,
    maxChainBytes: DEFAULT_POLICY.maxChainBytes,
    moderators: [],
    allow: [],
    modAllowPerDay: FREEZE_POLICY_DEFAULTS.modAllowPerDay,
    modActionsPerHour: FREEZE_POLICY_DEFAULTS.modActionsPerHour,
    reservedPool: FREEZE_POLICY_DEFAULTS.reservedPool,
    voided: [],
  };
  if (genesis) {
    const op = genesis.e.op;
    for (const f of ['writers', 'bits', 'maxValueBytes', 'maxChainBytes', 'modAllowPerDay', 'modActionsPerHour', 'reservedPool']) {
      if (op[f] !== undefined) p[f] = op[f];
    }
    if (Array.isArray(op.moderators)) p.moderators = Array.from(new Set(op.moderators)).sort().slice(0, LIMITS.maxModerators);
    if (Array.isArray(op.allow)) p.allow = Array.from(new Set(op.allow)).sort().slice(0, LIMITS.maxAllow);
    if (Array.isArray(op.voided)) p.voided = op.voided.map((x) => ({ author: x.author, after: x.after }));
  }
  return {
    owner: { keys: [genesisOwner] },
    policy: p,
    kv: [],
    lists: [],
    profiles: [],
    bans: [],
    tombstoned: [],
    modTombstoned: [],
    keyinfo: [],
    rotations: [],
    authors: genesis ? [genesisOwner] : [],
  };
}

export class RecentView {
  /**
   * new RecentView({ siteId, genesisOwner, expectedOwner, minBits, verifierPool, maxBlocks })
   * A follower's display copy of one ledger's recent window (see the header).
   */
  constructor({
    siteId, genesisOwner = null, expectedOwner = null, minBits = 0, verifierPool = null, maxBlocks = MAX_WINDOW_BLOCKS,
    maxPerAuthor = MAX_VIEW_PER_AUTHOR, now = null,
  } = {}) {
    if (typeof siteId !== 'string' || !siteId) throw new TypeError('RecentView needs a siteId');
    this.siteId = siteId;
    this.genesisOwner = typeof genesisOwner === 'string' && genesisOwner ? genesisOwner : null;
    this.expectedOwner = typeof expectedOwner === 'string' && expectedOwner ? expectedOwner : null;
    this.minBits = Number.isInteger(minBits) && minBits > 0 ? minBits : 0;
    this.verifierPool = verifierPool || null;
    this.maxBlocks = maxBlocks;
    this.maxPerAuthor = maxPerAuthor;
    this.now = typeof now === 'function' ? now : () => Date.now();
    this._blocks = new Map();
    this._checkpoint = null; // { h, snap, S, block, covered: Set }
    this._truncated = false;
    this._version = 0;
    this._cache = null;
    this.stats = { added: 0, rejected: 0, duplicates: 0, refused: 0, trimmed: 0 };
  }

  get size() {
    return this._blocks.size;
  }

  has(h) {
    return this._blocks.has(h) || (this._checkpoint !== null && this._checkpoint.covered.has(h));
  }

  get(h) {
    return this._blocks.get(h);
  }

  /** Every held block (no order). */
  blocks() {
    return Array.from(this._blocks.values());
  }

  /** The checked checkpoint { h, snap, n } the view reduces from, or null. */
  get checkpoint() {
    const cp = this._checkpoint;
    return cp ? { h: cp.h, snap: cp.snap, n: cp.covered.size } : null;
  }

  /**
   * add(blocks, { checkpoint, truncated }) -> Promise<{ added: h[], rejected: [{ h, reason, strike? }], duplicates: h[] }>.
   * Every block is checked in full (validateBlock, the node's pool when given); blocks of another ledger
   * are 'shape'. checkpoint { h, snap, S } (the block h among `blocks` or held already) is taken only when
   * S hashes to snap, the block is a valid checkpoint naming it, and its signer is the last owner key in
   * S, which must be the pointer's owner (expectedOwner, else the genesis owner). Then admission (see the
   * header): 'no-effect' (strike: true when the key has no standing and the control state is exact) and
   * 'future' blocks are not kept; `added` lists only what the view kept.
   */
  async add(blocks, { checkpoint = null, truncated = false } = {}) {
    const res = { added: [], rejected: [], duplicates: [] };
    const fresh = [];
    for (const b of Array.isArray(blocks) ? blocks : []) {
      if (!looksLikeBlock(b) || b.e.site !== this.siteId) {
        res.rejected.push({ h: b && typeof b.h === 'string' ? b.h : null, reason: 'shape' });
        continue;
      }
      if (this.has(b.h)) {
        const ours = this._blocks.get(b.h);
        if (ours && ours.v === undefined && b.v !== undefined) fresh.push(b); // a value for a stub
        else res.duplicates.push(b.h);
        continue;
      }
      fresh.push(b);
    }
    const opts = { minBits: 0, maxValueBytes: LIMITS.maxBlockBytes, site: this.siteId };
    const now = this.now();
    const verdicts = await Promise.all(fresh.map((b) => {
      let p;
      try {
        p = this.verifierPool ? this.verifierPool.verifyBlock(b, opts) : validateBlock(b, opts);
      } catch (_) {
        p = Promise.resolve({ ok: false, reason: 'E_VERIFY' });
      }
      return Promise.resolve(p).catch(() => ({ ok: false, reason: 'E_VERIFY' }));
    }));
    for (let i = 0; i < fresh.length; i++) {
      const b = fresh[i];
      const v = verdicts[i];
      if (!v || v.ok !== true) {
        res.rejected.push({ h: b.h, reason: (v && v.reason) || 'shape' });
        continue;
      }
      if (b.e.prev.length === 0 && this.genesisOwner !== null && b.e.author !== this.genesisOwner) {
        res.rejected.push({ h: b.h, reason: 'root' });
        continue;
      }
      if (b.e.ts - now > VIEW_FUTURE_MS) {
        res.rejected.push({ h: b.h, reason: 'future' });
        continue;
      }
      this._blocks.set(b.h, plainBlock(b));
      res.added.push(b.h);
    }
    if (checkpoint && isPlainObject(checkpoint)) {
      try {
        await this._takeCheckpoint(checkpoint);
      } catch (err) {
        res.rejected.push({ h: typeof checkpoint.h === 'string' ? checkpoint.h : null, reason: (err && err.code) || 'E_SNAP' });
      }
    }
    // DS-10: the newest answer decides; a full window from another peer clears an earlier truncation.
    this._truncated = truncated === true;
    if (res.added.length > 0 || checkpoint) {
      this._version++;
      this._cache = null;
      if (res.added.length > 0) this._admit(res);
      this._trim();
    }
    this.stats.added += res.added.length;
    this.stats.rejected += res.rejected.length;
    this.stats.duplicates += res.duplicates.length;
    return res;
  }

  // Admission: of the blocks just added, only those with an effect in the view's state stay (see the header).
  _admit(res) {
    const d = this.state();
    const st = d.state;
    const kept = [];
    let dropped = 0;
    for (const h of res.added) {
      const b = this._blocks.get(h);
      // Kept unjudged: covered by the checkpoint just taken, outside the part of an ownerless view that connects, or with
      // a parent the view lacks (what it builds on, a control block included, may still arrive; trimmed first while
      // it has no effect).
      if (!b || (d.evaluated !== null && !d.evaluated.has(h)) || d.unchecked.has(h) || st.effective.has(h) || st.redacted.has(h)) {
        kept.push(h);
        continue;
      }
      this._blocks.delete(h);
      dropped++;
      res.rejected.push({ h, reason: 'no-effect', strike: d.controlExact && !this._standing(b, st) });
    }
    res.added = kept;
    if (dropped > 0) {
      this.stats.refused += dropped;
      this._version++;
      this._cache = null;
    }
  }

  // Whether the author of b may write here at all under the view's control state (owner, moderator, writers and
  // allow list, not banned, the fee); a block refused without standing counts against the peer that sent it.
  _standing(b, st) {
    const author = b.e.author;
    const p = st.policy;
    if (st.owner === author) return true;
    const sc = st.succession;
    if (sc && Array.isArray(sc.keys) && sc.keys.indexOf(author) >= 0) return true;
    if (p.moderators.has(author)) return true;
    if (isBanned(author, st, this.now())) return false;
    if (p.writers === 'owner') return false;
    if (p.writers === 'allow' && !allowListed(author, st)) return false;
    return b.e.bits >= Math.max(this.minBits, p.bits);
  }

  async _takeCheckpoint({ h, snap, S, block = null }) {
    let mySnap;
    try {
      mySnap = checkpointSnap(S);
    } catch (_) {
      throw coded('E_SNAP', 'the checkpoint state is not canonical JSON');
    }
    if (typeof snap === 'string' && snap !== mySnap) throw coded('E_SNAP', 'the checkpoint state does not match its snap');
    if (this._checkpoint && this._checkpoint.snap === mySnap) return;
    const cp = this._blocks.get(h) || (block && looksLikeBlock(block) ? block : null);
    if (!cp || cp.e.op.t !== 'checkpoint' || cp.e.op.snap !== mySnap) throw coded('E_SNAP', 'no checkpoint block names this state');
    if (!this._blocks.has(cp.h)) {
      const v = await validateBlock(cp, { site: this.siteId, minBits: 0, maxValueBytes: LIMITS.maxBlockBytes });
      if (!v.ok) throw coded('E_SNAP', 'the checkpoint block is invalid (' + v.reason + ')');
    }
    const keys = S && S.state && S.state.owner && Array.isArray(S.state.owner.keys) ? S.state.owner.keys : null;
    if (!keys || keys.length === 0 || this.genesisOwner === null || keys[0] !== this.genesisOwner) {
      throw coded('E_SNAP', 'the checkpoint state does not start at this ledger\'s genesis owner');
    }
    const last = keys[keys.length - 1];
    if (cp.e.author !== last || last !== (this.expectedOwner || this.genesisOwner)) {
      throw coded('E_SNAP', 'the checkpoint is not signed by the owner this visitor trusts');
    }
    const covered = decodeCovered(S.covered);
    if (this._checkpoint && covered.size < this._checkpoint.covered.size) return; // an older one: keep ours
    this._checkpoint = { h: cp.h, snap: mySnap, S, block: plainBlock(cp), covered };
    this._blocks.set(cp.h, plainBlock(cp));
    for (const x of Array.from(this._blocks.keys())) if (covered.has(x)) this._blocks.delete(x);
  }

  // Keeps the view bounded (see the header): per key that is not the owner or a moderator at most maxPerAuthor
  // payload blocks, the newest by depth; beyond maxBlocks blocks without an effect (control blocks included) and payload
  // whose value is hidden leave first, then the oldest payload by depth. Control blocks with an effect stay. Depth here is
  // over what the view holds.
  _trim() {
    const perAuthor = new Map();
    let payloadCount = 0;
    for (const b of this._blocks.values()) {
      if (!isPayloadOp(b.e.op)) continue;
      payloadCount++;
      perAuthor.set(b.e.author, (perAuthor.get(b.e.author) || 0) + 1);
    }
    let over = false;
    for (const n of perAuthor.values()) if (n > this.maxPerAuthor) over = true;
    if (!over && this._blocks.size <= this.maxBlocks) return;
    const st = this.state().state;
    const privileged = (a) => a === st.owner || st.policy.moderators.has(a) || (st.succession && Array.isArray(st.succession.keys) && st.succession.keys.indexOf(a) >= 0);
    const depth = new Map();
    for (const b of topoSort(Array.from(this._blocks.values()))) {
      let d = 0;
      for (const p of b.e.prev) {
        const pd = depth.get(p);
        if (pd !== undefined && pd + 1 > d) d = pd + 1;
      }
      depth.set(b.h, d);
    }
    const older = (a, b) => (depth.get(a.h) - depth.get(b.h)) || (a.h < b.h ? -1 : 1);
    const gone = [];
    if (over) {
      const byAuthor = new Map();
      for (const b of this._blocks.values()) {
        if (!isPayloadOp(b.e.op) || privileged(b.e.author) || perAuthor.get(b.e.author) <= this.maxPerAuthor) continue;
        const list = byAuthor.get(b.e.author);
        if (list) list.push(b);
        else byAuthor.set(b.e.author, [b]);
      }
      for (const list of byAuthor.values()) {
        list.sort(older);
        for (const b of list.slice(0, list.length - this.maxPerAuthor)) gone.push(b.h);
      }
      for (const h of gone) this._blocks.delete(h);
    }
    if (this._blocks.size > this.maxBlocks) {
      // What may go: payload, and control blocks without an effect (junk waiting on parents nobody has). Control blocks with an
      // effect, roots (the genesis) and the checkpoint block stay. Blocks without an effect or with a hidden value go first.
      const cpH = this._checkpoint ? this._checkpoint.h : null;
      const removable = [];
      for (const b of this._blocks.values()) {
        if (b.e.prev.length === 0 || b.h === cpH) continue;
        if (!isPayloadOp(b.e.op) && st.effective.has(b.h)) continue;
        removable.push(b);
      }
      const shown = (b) => (isPayloadOp(b.e.op) && st.effective.has(b.h) && !st.redacted.has(b.h) ? 1 : 0);
      removable.sort((a, b) => (shown(a) - shown(b)) || older(a, b));
      let i = 0;
      while (this._blocks.size > this.maxBlocks && i < removable.length) {
        this._blocks.delete(removable[i].h);
        gone.push(removable[i++].h);
      }
    }
    if (gone.length > 0) {
      this.stats.trimmed += gone.length;
      this._version++;
      this._cache = null;
    }
    return payloadCount;
  }

  /** orderChecked(h) -> false when a block's causal past is not held ("Order not yet checked"). */
  orderChecked(h) {
    return !this.state().unchecked.has(h);
  }

  /**
   * state() -> { state (state.js State), snapshot (plain JSON), unchecked: Set<h>, missing: Set<h>,
   * controlExact, complete, checkpoint } (see the header). Cached until the view changes.
   */
  state() {
    if (this._cache !== null) return this._cache;
    const held = topoSort(Array.from(this._blocks.values()));
    const cp = this._checkpoint;
    const covered = cp ? cp.covered : new Set();
    const missing = new Set();
    const unchecked = new Set();
    for (const b of held) {
      for (const p of b.e.prev) {
        if (!this._blocks.has(p) && !covered.has(p)) {
          missing.add(p);
          unchecked.add(b.h);
        }
      }
    }
    const ctx = { genesisOwner: this.genesisOwner, expectedOwner: this.expectedOwner, minBits: this.minBits };
    let st;
    let controlExact = !this._truncated;
    let evaluated = null; // the hashes the state was reduced from, when not every held block
    if (missing.size === 0 || this.genesisOwner === null) {
      const dag = new Dag({ maxOrphans: Infinity, maxOrphansPerPeer: Infinity });
      if (cp) dag.pruneTo(cp.block, cp.S);
      for (const b of held) if (!dag.has(b.h) && !dag.isCovered(b.h)) dag.add(b, 'view');
      st = reduce(dag, ctx);
      if (missing.size > 0) {
        controlExact = false; // ownerless with gaps: only the connected part counts
        evaluated = new Set();
        for (const b of dag.blocks()) evaluated.add(b.h);
      }
    } else {
      // Gaps: the missing parents count as settled history on top of S (or the genesis defaults).
      let genesis = null;
      if (!cp) {
        for (const b of held) {
          if (b.e.prev.length === 0 && b.e.author === this.genesisOwner && b.e.op.t === 'policy') {
            genesis = b;
            break;
          }
        }
      }
      const cov = new Set(covered);
      for (const h of missing) cov.add(h);
      if (genesis) cov.add(genesis.h);
      const state = cp ? cp.S.state : baseState(this.genesisOwner, genesis);
      const S = { v: 1, covered: coveredString(cov), state };
      const after = held.filter((b) => !cov.has(b.h));
      st = reduceFromCheckpoint(S, after, Object.assign({ snap: checkpointSnap(S), unknown: missing }, ctx));
      if (genesis) evaluated = new Set(after.map((b) => b.h)); // the genesis is folded into the base
      let detached = 0;
      for (const b of held) {
        if (!isControlOp(b.e.op) || !ORDER_SENSITIVE.has(b.e.op.t) || cov.has(b.h)) continue;
        if (b.e.prev.some((p) => missing.has(p))) detached++;
      }
      if (detached > 1) controlExact = false;
    }
    this._cache = {
      state: st,
      snapshot: snapshotOf(st, { now: this.now() }),
      unchecked,
      missing,
      evaluated,
      controlExact,
      complete: missing.size === 0,
      checkpoint: this.checkpoint,
    };
    return this._cache;
  }
}

const VIEWS = new WeakMap();

/** viewOf(node) -> the RecentView of a ChainNode (created on first use from the node's ledger id, owners and pool). */
export function viewOf(node) {
  let view = VIEWS.get(node);
  if (!view) {
    view = new RecentView({
      siteId: node.siteId,
      genesisOwner: node.genesisOwner,
      expectedOwner: node.expectedOwner,
      minBits: node.config ? node.config.minBits : 0,
      verifierPool: node.verifierPool || null,
      now: typeof node.now === 'function' ? node.now : null,
    });
    VIEWS.set(node, view);
  }
  return view;
}

/**
 * applyWindow(node, window, { from }) -> Promise<{ added, rejected, view }>: the window's blocks go to the
 * view of `node`, and the ones whose parents the node holds (in order, so a chain connects) to the node
 * itself as history.
 */
export async function applyWindow(node, window, { from = 'recent' } = {}) {
  const w = window && typeof window === 'object' ? window : {};
  const view = viewOf(node);
  const res = await view.add(Array.isArray(w.blocks) ? w.blocks : [], { checkpoint: w.checkpoint || null, truncated: w.truncated === true });
  // Blocks that connect to what the node already holds are worth giving it (they extend its DAG).
  const connect = [];
  const held = new Set();
  if (node.dag && node.dag.size > 0) {
    for (const b of topoSort(res.added.map((h) => view.get(h)).filter(Boolean))) {
      let ok = true;
      for (const p of b.e.prev) {
        if (!node.dag.has(p) && !(typeof node.dag.isCovered === 'function' && node.dag.isCovered(p)) && !held.has(p)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        connect.push(b);
        held.add(b.h);
      }
    }
  }
  if (connect.length > 0 && typeof node.ingest === 'function' && !node.closed) {
    try {
      await node.ingest(connect, String(from));
    } catch (_) {
      // the view keeps them either way
    }
  }
  return { added: res.added, rejected: res.rejected, view };
}

/**
 * syncRecent(node, peer, { posts = 200, fromDepth = -1 }) -> Promise<{ added, rejected, view, state }>
 * (INTERFACES v0.3): asks `peer` for the recent window of node's ledger and applies it (see the header).
 */
export async function syncRecent(node, peer, { posts = RECENT_POSTS, fromDepth = -1 } = {}) {
  if (!node || typeof node.siteId !== 'string') throw new TypeError('syncRecent needs a ChainNode');
  if (!peer || typeof peer.recent !== 'function') throw new TypeError('syncRecent needs a peer with recent()');
  const window = await peer.recent({ ledger: node.siteId, fromDepth, posts: clampPosts(posts) });
  const r = await applyWindow(node, window, { from: 'recent:' + (peer.id || 'peer') });
  return { added: r.added.length, rejected: r.rejected, view: r.view, state: r.view.state() };
}

// ---------------------------------------------------------------------------------------------
// Snapshot first (cs=)
// ---------------------------------------------------------------------------------------------

/** encodeRecentSnapshot(window, ledger) -> JSON array [header, ...blocks] (see the header). */
export function encodeRecentSnapshot(window, ledger) {
  const w = window || {};
  const header = {
    mw: RECENT_SNAPSHOT_KIND,
    ledger: typeof ledger === 'string' ? ledger : null,
    posts: w.posts,
    fromDepth: w.fromDepth,
    truncated: w.truncated === true,
    checkpoint: w.checkpoint ? { h: w.checkpoint.h, snap: w.checkpoint.snap, S: w.checkpoint.S } : null,
  };
  return [header].concat(Array.isArray(w.blocks) ? w.blocks : []);
}

/** parseRecentSnapshot(array) -> { ledger, posts, fromDepth, truncated, checkpoint, blocks } | null (not a recent window). */
export function parseRecentSnapshot(array) {
  if (!Array.isArray(array) || array.length === 0) return null;
  const head = array[0];
  if (!isPlainObject(head) || head.mw !== RECENT_SNAPSHOT_KIND) return null;
  const blocks = array.slice(1).filter(looksLikeBlock);
  return {
    ledger: typeof head.ledger === 'string' ? head.ledger : null,
    posts: head.posts,
    fromDepth: head.fromDepth,
    truncated: head.truncated === true,
    checkpoint: isPlainObject(head.checkpoint) ? head.checkpoint : null,
    blocks,
  };
}

/** loadRecentSnapshot(node, array) -> Promise<{ added, rejected, view }> (E_INVALID when it is not a recent window of this ledger). */
export async function loadRecentSnapshot(node, array) {
  const w = parseRecentSnapshot(array);
  if (!w) throw coded('E_INVALID', 'not a recent-window snapshot');
  if (w.ledger !== null && w.ledger !== node.siteId) throw coded('E_INVALID', 'a recent window of another ledger (' + w.ledger + ')');
  return applyWindow(node, w, { from: 'snapshot' });
}
