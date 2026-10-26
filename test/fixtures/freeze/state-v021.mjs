// FROZEN COPY of src/chain/state.js as of v0.2.1 (lane freeze, 2026-10-20), taken before the
// freeze-group edits. freeze-schema.test.mjs checks that the new reducer agrees with it on every
// DAG without new ops. Do not edit except the import paths.

// Deterministic reducer of a site ledger (ARCHITECTURE 6.2 and 6.5; DESIGN-REVIEW items 2-4, S9).
//
// The state is a pure function of the block set (dag.order() = sort by (depth, h)), the genesis
// owner and the PoW floor, so every node holding the same blocks computes the same state.
//
// Owner (code review round 1: a succession is a revocation). The succession chain
// K0 -> K1 -> ... is built level by level: K0 is the genesis owner; the candidates at level m are
// the reachable { t:'owner' } blocks by Km (a hand-over to the author itself is a no-op) that have
// the chosen succession of level m - 1 in their causal past, minimal ones only (a candidate with
// another candidate of its level in its past had already been superseded). One candidate is
// chosen. Several (equivocation: the key signed two hand-overs) are never decided by total order:
// with `expectedOwner` (the pointer's owner, the visitor's trust anchor) not already in the chain,
// the candidate endorsed by expectedOwner wins: a block signed by expectedOwner whose causal past
// holds that one candidate and no other (nobody else can forge it; a later merge of both is no
// endorsement); otherwise the chain stops there and the ledger reports `ownerConflict` (owner
// changes paused until the pointer's owner endorses one hand-over).
// level(B) = the number of chosen successions in B's causal past; ownerAt(B) = K(level(B)).
// Owner standing of block B (control ops, the owner's PoW and ban exemptions): author === ownerAt(B)
// and, when a succession away from that key was chosen, B is in its causal past (or is it): what
// the old key signed before the hand-over stays valid, anything it signs beside or after it has no
// owner standing. Under an ownerConflict the contested key keeps standing only for what is in the
// causal past of every contested hand-over.
//
// Pass 1 decides which control blocks are valid:
//   - owner: the chosen successions;
//   - policy, allow: owner standing;
//   - ban: owner standing, or a moderator under controlFor(C);
//   - tombstone: owner standing, a moderator under controlFor(C), or the author of the target
//     payload block (that author pays the governing PoW like any write).
// Pass 2 reduces the payload blocks in total order. controlFor(B) folds, in total order, the
// valid policy and allow blocks P with B not in ancestors(P): a tightening governs concurrent
// and later writes, but never the writes its author had already seen. Bans and tombstones are
// not subject to that exclusion: a ban removes every payload of the banned author (except the
// owner's own blocks) and a tombstone removes its target wherever they sit in the DAG, otherwise
// neither could reach the entries a moderator saw and wants removed (ARCHITECTURE 6.5).
//
// A payload block B takes effect only if, under controlFor(B): it is reachable from a valid root
// (roots other than the genesis owner's are rejected, ARCHITECTURE 6.2); it still holds its value;
// it is not tombstoned; its author is not banned (the owner at B is exempt); the author is the
// owner at B or a moderator, or writers is 'open', or writers is 'allow' and the author is in
// the allow set; non-privileged authors meet max(minBits, bits); the value fits maxValueBytes;
// and keys or list names starting with '_' come from the owner (owner standing) or a moderator. put is
// last-writer-wins in total order (null deletes the key), append pushes { h, author, ts, v },
// profile sets the author's display name ('' clears it).
//
// genesisOwner === null means an ownerless ledger (unsigned pointer, "btih:" id): open writing
// with the default PoW, roots by anyone, no owner or moderator, so the only valid control blocks
// are tombstones by the target's author.

import { canonicalize, byteLength } from '../../../src/chain/canonical.js';
import { DEFAULT_POLICY, LIMITS, validateName } from '../../../src/chain/block.js';

const PAYLOAD = new Set(['put', 'append', 'profile']);
const UNDERSCORE = 95; // '_'

function basePolicy(owned) {
  return {
    writers: owned ? DEFAULT_POLICY.writers : 'open',
    bits: DEFAULT_POLICY.bits,
    maxValueBytes: DEFAULT_POLICY.maxValueBytes,
    maxChainBytes: DEFAULT_POLICY.maxChainBytes,
    moderators: new Set(),
    allow: new Set(),
  };
}

// Applies one valid policy or allow op to a control state (mutates it).
function applyPermission(cs, op) {
  if (op.t === 'policy') {
    if (op.writers !== undefined) cs.writers = op.writers;
    if (op.bits !== undefined) cs.bits = op.bits;
    if (op.maxValueBytes !== undefined) cs.maxValueBytes = op.maxValueBytes;
    if (op.maxChainBytes !== undefined) cs.maxChainBytes = op.maxChainBytes;
    if (Array.isArray(op.moderators)) cs.moderators = new Set(op.moderators.slice(0, LIMITS.maxModerators));
    if (Array.isArray(op.allow)) cs.allow = new Set(op.allow.slice(0, LIMITS.maxAllow));
  } else if (op.t === 'allow') {
    if (Array.isArray(op.remove)) for (const p of op.remove) cs.allow.delete(p);
    if (Array.isArray(op.add)) {
      for (const p of op.add) {
        if (cs.allow.size >= LIMITS.maxAllow) break;
        cs.allow.add(p);
      }
    }
  }
}

function valueBytesOf(dag, block) {
  if (typeof dag.valueBytes === 'function') return dag.valueBytes(block.h);
  return byteLength(canonicalize(block.v));
}

function opOk(op) {
  if (op === null || typeof op !== 'object' || typeof op.t !== 'string') return false;
  if (op.t === 'put') return typeof op.k === 'string' && op.k.length > 0;
  if (op.t === 'append') return typeof op.l === 'string' && op.l.length > 0;
  return true;
}

// ---------------------------------------------------------------------------------------------
// The succession chain (see the header). All passes work on positions in the total order: every
// parent has a smaller position than its children (depth strictly increases along prev).
// ---------------------------------------------------------------------------------------------

function baseOf(dag, genesisOwner) {
  const order = dag.order();
  const N = order.length;
  const index = new Map();
  for (let i = 0; i < N; i++) index.set(order[i].h, i);
  const prevIdx = new Array(N);
  for (let i = 0; i < N; i++) {
    const prev = order[i].e.prev;
    const arr = new Array(prev.length);
    for (let j = 0; j < prev.length; j++) {
      const p = index.get(prev[j]);
      arr[j] = p === undefined ? -1 : p;
    }
    prevIdx[i] = arr;
  }
  // Reachability from a valid root (owned ledgers: only the genesis owner's roots).
  const owned = genesisOwner !== null;
  const reachable = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const pv = prevIdx[i];
    if (pv.length === 0) {
      reachable[i] = !owned || order[i].e.author === genesisOwner ? 1 : 0;
      continue;
    }
    for (let j = 0; j < pv.length; j++) {
      const p = pv[j];
      if (p >= 0 && reachable[p]) {
        reachable[i] = 1;
        break;
      }
    }
  }
  return { order, N, index, prevIdx, reachable };
}

// The candidates (sorted positions) without a candidate in their strict causal past.
function minimalOf(base, cand) {
  const { N, prevIdx } = base;
  const lo = cand[0];
  const isCand = new Uint8Array(N);
  for (const c of cand) isCand[c] = 1;
  const below = new Uint8Array(N); // a candidate is in the strict causal past
  for (let i = lo + 1; i < N; i++) {
    const pv = prevIdx[i];
    for (let j = 0; j < pv.length; j++) {
      const p = pv[j];
      if (p >= lo && (below[p] || isCand[p])) {
        below[i] = 1;
        break;
      }
    }
  }
  return cand.filter((c) => !below[c]);
}

// The candidate (sorted positions) endorsed by `who`: a reachable block signed by `who` whose
// causal past holds exactly that one candidate. A block of `who` that has several in its past (a
// later merge of the heads) endorses none; two blocks endorsing different ones decide nothing.
// -> the candidate's position, or -1.
function endorsedBy(base, cand, who) {
  const { order, N, prevIdx, reachable } = base;
  const C = cand.length;
  const W = (C + 31) >>> 5;
  const lo = cand[0];
  const slot = new Map();
  for (let k = 0; k < C; k++) slot.set(cand[k], k);
  const bits = new Uint32Array((N - lo) * W);
  let found = -1;
  for (let i = lo; i < N; i++) {
    const bi = (i - lo) * W;
    const pv = prevIdx[i];
    for (let j = 0; j < pv.length; j++) {
      const p = pv[j];
      if (p < lo) continue;
      const pb = (p - lo) * W;
      for (let w = 0; w < W; w++) bits[bi + w] |= bits[pb + w];
      const k = slot.get(p);
      if (k !== undefined) bits[bi + (k >>> 5)] |= 1 << (k & 31);
    }
    if (!reachable[i] || order[i].e.author !== who) continue;
    let count = 0;
    let which = -1;
    for (let w = 0; w < W && count < 2; w++) {
      let x = bits[bi + w];
      while (x !== 0 && count < 2) {
        const t = x & -x;
        which = w * 32 + (31 - Math.clz32(t));
        count++;
        x ^= t;
      }
    }
    if (count !== 1) continue;
    const c = cand[which];
    if (found === -1) found = c;
    else if (found !== c) return -1;
  }
  return found;
}

// out[i] = 1 when block i is in the strict causal past of every candidate (sorted positions).
function commonPastOf(base, cand) {
  const { N, prevIdx } = base;
  const C = cand.length;
  const W = (C + 31) >>> 5;
  const hi = cand[C - 1];
  const bits = new Uint32Array((hi + 1) * W);
  const slot = new Map();
  for (let k = 0; k < C; k++) slot.set(cand[k], k);
  for (let i = hi; i >= 0; i--) {
    const bi = i * W;
    const k = slot.get(i);
    const pv = prevIdx[i];
    for (let j = 0; j < pv.length; j++) {
      const p = pv[j];
      if (p < 0) continue;
      const pb = p * W;
      for (let w = 0; w < W; w++) bits[pb + w] |= bits[bi + w];
      if (k !== undefined) bits[pb + (k >>> 5)] |= 1 << (k & 31);
    }
  }
  const out = new Uint8Array(N);
  for (let i = 0; i <= hi; i++) {
    let all = true;
    for (let w = 0; w < W && all; w++) {
      const n = w < W - 1 ? 32 : C - 32 * (W - 1);
      const want = n === 32 ? 0xffffffff : ((1 << n) >>> 0) - 1;
      if ((bits[i * W + w] & want) >>> 0 !== want) all = false;
    }
    if (all) out[i] = 1;
  }
  return out;
}

// -> { keys, chosen (positions), conflict (positions), frozen, level, chosenAt, standing }
function computeSuccession(base, genesisOwner, expectedOwner) {
  const { order, N, prevIdx, reachable } = base;
  const level = new Int32Array(N);
  const chosenAt = new Uint8Array(N);
  const standing = new Uint8Array(N);
  const keys = genesisOwner === null ? [] : [genesisOwner];
  const chosen = [];
  let conflict = [];
  let frozen = false;
  if (genesisOwner === null) return { keys, chosen, conflict, frozen, level, chosenAt, standing };
  const succ = [];
  for (let i = 0; i < N; i++) {
    const e = order[i].e;
    if (reachable[i] && e.op && e.op.t === 'owner' && e.op.next !== e.author) succ.push(i);
  }
  for (let m = 0; succ.length > 0; m++) {
    const K = keys[m];
    let cand = [];
    for (const i of succ) if (level[i] === m && order[i].e.author === K) cand.push(i);
    if (cand.length === 0) break;
    if (cand.length > 1) cand = minimalOf(base, cand);
    let pick = cand.length === 1 ? cand[0] : -1;
    if (pick < 0 && expectedOwner !== null && keys.indexOf(expectedOwner) < 0) pick = endorsedBy(base, cand, expectedOwner);
    if (pick < 0) {
      frozen = true;
      conflict = cand;
      break;
    }
    chosen.push(pick);
    chosenAt[pick] = 1;
    keys.push(order[pick].e.op.next);
    // The chosen succession's descendants are one level up.
    const desc = new Uint8Array(N);
    desc[pick] = 1;
    for (let i = pick + 1; i < N; i++) {
      const pv = prevIdx[i];
      for (let j = 0; j < pv.length; j++) {
        const p = pv[j];
        if (p >= pick && desc[p]) {
          desc[i] = 1;
          level[i] = m + 1;
          break;
        }
      }
    }
  }
  // Owner standing. before[i]: block i is in the causal past of (or is) the chosen succession of
  // its own level; a path from a block to that succession never leaves the level.
  const L = chosen.length;
  const before = new Uint8Array(N);
  for (const c of chosen) before[c] = 1;
  for (let i = N - 1; i >= 0; i--) {
    if (!before[i]) continue;
    const li = level[i];
    const pv = prevIdx[i];
    for (let j = 0; j < pv.length; j++) {
      const p = pv[j];
      if (p >= 0 && level[p] === li) before[p] = 1;
    }
  }
  const common = frozen ? commonPastOf(base, conflict) : null;
  for (let i = 0; i < N; i++) {
    if (!reachable[i]) continue;
    const lv = level[i];
    if (order[i].e.author !== keys[lv]) continue;
    if (lv < L) standing[i] = before[i];
    else standing[i] = frozen ? common[i] : 1;
  }
  return { keys, chosen, conflict, frozen, level, chosenAt, standing };
}

// The succession as kept in a State: hashes, and levelAfter(h) = level(h) + (h is a chosen
// succession), for blocks in the DAG at reduce time and, through `dag`, for blocks added since
// (payload blocks and tombstones: anything else makes the node reduce again).
function successionView(base, s) {
  const { order, index } = base;
  const extra = new Map();
  const known = (h) => {
    const i = index.get(h);
    if (i !== undefined) return s.level[i] + s.chosenAt[i];
    return extra.get(h);
  };
  const levelAfter = (h, dag) => {
    const k = known(h);
    if (k !== undefined) return k;
    if (!dag || typeof dag.get !== 'function') return 0;
    const stack = [h];
    while (stack.length > 0) {
      const x = stack[stack.length - 1];
      if (known(x) !== undefined) {
        stack.pop();
        continue;
      }
      const b = dag.get(x);
      if (!b) {
        extra.set(x, 0);
        stack.pop();
        continue;
      }
      let pending = false;
      for (const p of b.e.prev) {
        if (known(p) === undefined) {
          stack.push(p);
          pending = true;
        }
      }
      if (pending) continue;
      let m = 0;
      for (const p of b.e.prev) {
        const l = known(p);
        if (l > m) m = l;
      }
      extra.set(x, m);
      stack.pop();
    }
    return known(h);
  };
  return {
    keys: s.keys.slice(),
    chosen: s.chosen.map((i) => order[i].h),
    conflict: s.conflict.map((i) => order[i].h),
    frozen: s.frozen,
    levelOf: (h) => {
      const i = index.get(h);
      return i === undefined ? -1 : s.level[i];
    },
    levelAfter,
    levelAfterPrev: (prev, dag) => {
      let m = 0;
      for (const p of prev || []) {
        const l = levelAfter(p, dag);
        if (l > m) m = l;
      }
      return m;
    },
  };
}

// Memo of the latest succession per (dag, genesisOwner, expectedOwner), valid while dag.version
// is unchanged (ownerAt and ownerAfter read it; reduce refreshes it).
const SUCCESSIONS = new WeakMap();

function memoKey(genesisOwner, expectedOwner) {
  return String(genesisOwner) + '|' + String(expectedOwner);
}

function successionFor(dag, genesisOwner, expectedOwner) {
  let perDag = SUCCESSIONS.get(dag);
  if (!perDag) {
    perDag = new Map();
    SUCCESSIONS.set(dag, perDag);
  }
  const key = memoKey(genesisOwner, expectedOwner);
  const hit = perDag.get(key);
  const version = typeof dag.version === 'number' ? dag.version : -1;
  if (hit && hit.version === version && version >= 0) return hit.view;
  const base = baseOf(dag, genesisOwner);
  const view = successionView(base, computeSuccession(base, genesisOwner, expectedOwner));
  perDag.set(key, { version, view });
  return view;
}

/**
 * reduce(dag, { genesisOwner = null, expectedOwner = null, minBits = 0 }) -> State
 *
 * State = { kv: Map<k, { v, author, h, ts }>, lists: Map<name, Item[]>, profiles: Map<pub, name>,
 *   owner, policy: { writers, bits, maxValueBytes, maxChainBytes, moderators: Set, allow: Set,
 *   banned: Set }, tombstoned: Set<h>, height (blocks in the DAG), bytes, authors: Set,
 *   controlBlocks (valid control blocks), depth (max depth), capReached (bytes >= maxChainBytes),
 *   redacted: Set<h> (payload blocks in the DAG whose value must be dropped: tombstoned, or by a
 *   banned author without owner standing), effective: Set<h> (payload blocks that took effect and
 *   valid control blocks), ownerless, ownerConflict (two contested hand-overs by one key and no
 *   endorsement by expectedOwner: owner changes are paused), succession: { keys, chosen, conflict,
 *   frozen, levelOf(h), levelAfter(h, dag?), levelAfterPrev(prev, dag?) } }
 * `policy` is the control state at the heads: the fold of every valid policy and allow block,
 * which is exactly what governs a block arriving now (ingest check, ARCHITECTURE 6.3).
 * expectedOwner: the pointer's owner key, the anchor that decides contested successions.
 */
export function reduce(dag, options) {
  const opts = options || {};
  const genesisOwner = typeof opts.genesisOwner === 'string' ? opts.genesisOwner : null;
  const expectedOwner = typeof opts.expectedOwner === 'string' && opts.expectedOwner ? opts.expectedOwner : null;
  const owned = genesisOwner !== null;
  const floorBits = Number.isInteger(opts.minBits) && opts.minBits > 0 ? opts.minBits : 0;

  const base = baseOf(dag, genesisOwner);
  const { order, N, index, prevIdx, reachable } = base;
  const sc = computeSuccession(base, genesisOwner, expectedOwner);
  const view = successionView(base, sc);
  if (typeof dag.version === 'number') {
    let perDag = SUCCESSIONS.get(dag);
    if (!perDag) {
      perDag = new Map();
      SUCCESSIONS.set(dag, perDag);
    }
    perDag.set(memoKey(genesisOwner, expectedOwner), { version: dag.version, view });
  }
  const standing = sc.standing;

  // Pass 1a: valid successions and permission blocks.
  const permBit = new Int32Array(N).fill(-1);
  const perms = []; // block indices of valid policy/allow blocks, in total order
  const validControl = new Uint8Array(N);
  if (owned) {
    for (let i = 0; i < N; i++) {
      if (!reachable[i]) continue;
      const op = order[i].e.op;
      if (!op) continue;
      if (op.t === 'owner') {
        if (sc.chosenAt[i]) validControl[i] = 1;
      } else if ((op.t === 'policy' || op.t === 'allow') && standing[i]) {
        validControl[i] = 1;
        permBit[i] = perms.length;
        perms.push(i);
      }
    }
  }

  // Pass 1b (backward): D(i) = bitset of valid permission blocks that descend from block i.
  const K = perms.length;
  const W = (K + 31) >>> 5;
  const D = K > 0 ? new Uint32Array(N * W) : null;
  if (D) {
    for (let i = N - 1; i >= 0; i--) {
      const pv = prevIdx[i];
      if (pv.length === 0) continue;
      const base = i * W;
      const bit = permBit[i];
      for (let j = 0; j < pv.length; j++) {
        const p = pv[j];
        if (p < 0) continue;
        const pb = p * W;
        for (let w = 0; w < W; w++) D[pb + w] |= D[base + w];
        if (bit >= 0) D[pb + (bit >>> 5)] |= 1 << (bit & 31);
      }
    }
  }

  // controlFor(i): fold of the permission blocks that do not descend from i, memoised by mask.
  const foldMemo = new Map();
  const foldExcluding = (i) => {
    const cs = basePolicy(owned);
    for (let j = 0; j < K; j++) {
      if (i >= 0 && (D[i * W + (j >>> 5)] & (1 << (j & 31))) !== 0) continue;
      applyPermission(cs, order[perms[j]].e.op);
    }
    return cs;
  };
  const controlAt = (i) => {
    let key = 0;
    if (W === 1) key = D[i];
    else if (W > 1) {
      key = '';
      for (let w = 0; w < W; w++) key += D[i * W + w].toString(36) + ',';
    }
    let cs = foldMemo.get(key);
    if (cs === undefined) {
      cs = foldExcluding(i);
      foldMemo.set(key, cs);
    }
    return cs;
  };

  // Pass 1c: bans and tombstones (global in effect).
  const banned = new Set();
  const tombstoned = new Set();
  for (let i = 0; i < N; i++) {
    const b = order[i];
    const e = b.e;
    const op = e.op;
    if (!op || (op.t !== 'ban' && op.t !== 'tombstone') || !reachable[i]) continue;
    const cs = controlAt(i);
    const privileged = (owned && standing[i] === 1) || cs.moderators.has(e.author);
    if (op.t === 'ban') {
      if (!privileged) continue;
      banned.add(op.author);
    } else {
      const ti = index.get(op.h);
      const target = ti === undefined ? null : order[ti];
      if (target && !PAYLOAD.has(target.e.op.t)) continue; // control blocks are never redacted
      if (!privileged) {
        if (!target || target.e.author !== e.author) continue;
        if (e.bits < Math.max(floorBits, cs.bits)) continue;
      }
      tombstoned.add(op.h);
    }
    validControl[i] = 1;
  }

  // Pass 2: payload effects in total order.
  const kv = new Map();
  const lists = new Map();
  const profiles = new Map();
  const authors = new Set();
  const redacted = new Set();
  const effective = new Set();
  let controlBlocks = 0;
  for (let i = 0; i < N; i++) {
    const b = order[i];
    const e = b.e;
    const op = e.op;
    if (!op || !PAYLOAD.has(op.t)) {
      if (validControl[i]) {
        controlBlocks++;
        authors.add(e.author);
        effective.add(b.h);
      }
      continue;
    }
    const isOwner = owned && standing[i] === 1;
    if (tombstoned.has(b.h) || (banned.has(e.author) && !isOwner)) {
      redacted.add(b.h);
      continue;
    }
    if (!reachable[i] || b.v === undefined || !opOk(op)) continue;
    const cs = controlAt(i);
    const privileged = isOwner || cs.moderators.has(e.author);
    if (!privileged) {
      if (cs.writers === 'owner') continue;
      if (cs.writers === 'allow' && !cs.allow.has(e.author)) continue;
      if (e.bits < Math.max(floorBits, cs.bits)) continue;
    }
    if (valueBytesOf(dag, b) > cs.maxValueBytes) continue;
    if (op.t === 'put') {
      if (op.k.charCodeAt(0) === UNDERSCORE && !privileged) continue;
      if (b.v === null) kv.delete(op.k);
      else kv.set(op.k, { v: b.v, author: e.author, h: b.h, ts: e.ts });
    } else if (op.t === 'append') {
      if (op.l.charCodeAt(0) === UNDERSCORE && !privileged) continue;
      let list = lists.get(op.l);
      if (!list) {
        list = [];
        lists.set(op.l, list);
      }
      list.push({ h: b.h, author: e.author, ts: e.ts, v: b.v });
    } else {
      if (!validateName(b.v).ok) continue;
      if (b.v === '') profiles.delete(e.author);
      else profiles.set(e.author, b.v);
    }
    authors.add(e.author);
    effective.add(b.h);
  }

  const current = foldExcluding(-1); // no exclusions: the control state at the heads
  const bytes = typeof dag.bytes === 'number' ? dag.bytes : 0;
  return {
    kv,
    lists,
    profiles,
    owner: owned ? sc.keys[sc.keys.length - 1] : null,
    policy: {
      writers: current.writers,
      bits: current.bits,
      maxValueBytes: current.maxValueBytes,
      maxChainBytes: current.maxChainBytes,
      moderators: current.moderators,
      allow: current.allow,
      banned,
    },
    tombstoned,
    redacted,
    height: N,
    depth: typeof dag.maxDepth === 'function' ? dag.maxDepth() : -1,
    bytes,
    capReached: bytes >= current.maxChainBytes,
    authors,
    controlBlocks,
    effective,
    ownerless: !owned,
    ownerConflict: sc.frozen,
    succession: view,
  };
}

// ---------------------------------------------------------------------------------------------
// ownerAt / ownerAfter: read the memoised succession of the DAG as it is now (an equivocating
// succession can change the chain, so they are a function of the whole DAG, not of one past).
// ---------------------------------------------------------------------------------------------

/**
 * ownerAt(dag, h, genesisOwner, expectedOwner = null) -> K(level(h)): the owner key in effect for
 * block h (null: unknown h or ownerless). Owner standing of h itself also needs it to precede the
 * succession away from that key (reduce: state.effective / the header).
 */
export function ownerAt(dag, h, genesisOwner = null, expectedOwner = null) {
  if (typeof genesisOwner !== 'string' || !dag.has(h)) return null;
  const view = successionFor(dag, genesisOwner, typeof expectedOwner === 'string' && expectedOwner ? expectedOwner : null);
  const lv = view.levelOf(h);
  return lv < 0 ? null : view.keys[lv];
}

/**
 * ownerAfter(dag, prev, genesisOwner, expectedOwner = null) -> the owner key in effect for a new
 * block whose parents are `prev` (all in the DAG). The block has owner standing only when that key
 * is also the owner at the heads (no succession away from it, no ownerConflict): see admit().
 */
export function ownerAfter(dag, prev, genesisOwner = null, expectedOwner = null) {
  if (typeof genesisOwner !== 'string') return null;
  const view = successionFor(dag, genesisOwner, typeof expectedOwner === 'string' && expectedOwner ? expectedOwner : null);
  return view.keys[view.levelAfterPrev(prev || [], dag)];
}

/**
 * ownerStanding(state, block, { dag, expectedOwner }) -> true when `block`, arriving now with all
 * of its parents in `dag` (and no descendants), would have owner standing: its level is the last
 * one, no ownerConflict, and its author is the owner at the heads. Under an ownerConflict, a block
 * signed by expectedOwner (not already in the chain) that has exactly one contested hand-over in
 * its causal past is the endorsement that resolves it, and has standing.
 */
export function ownerStanding(state, block, options) {
  if (!state || state.ownerless || typeof state.owner !== 'string') return false;
  const opts = options || {};
  const dag = opts.dag || null;
  const e = block.e;
  const sc = state.succession;
  if (!sc) return e.author === state.owner;
  const last = sc.keys.length - 1;
  const lv = sc.levelAfterPrev(e.prev, dag);
  if (!sc.frozen) return lv === last && e.author === sc.keys[last];
  const x = typeof opts.expectedOwner === 'string' ? opts.expectedOwner : null;
  if (x === null || e.author !== x || sc.keys.indexOf(x) >= 0 || !dag || lv !== last) return false;
  const past = new Set();
  for (const p of e.prev) {
    past.add(p);
    if (typeof dag.ancestors === 'function' && dag.has(p)) for (const a of dag.ancestors(p)) past.add(a);
  }
  let count = 0;
  for (const c of sc.conflict) if (past.has(c)) count++;
  return count === 1;
}

/**
 * revokedAuthor(state, block, dag) -> true when `block` (all of its parents in `dag`) is signed by
 * a key at its own level that has already handed over (a chosen succession away from it, which the
 * new block cannot precede) or that is contested (ownerConflict): the old key's blocks outside the
 * hand-over's causal past have no owner standing. node.js refuses such control blocks even as
 * exempt parents (contested hand-overs themselves stay admissible there, so the anchor can decide).
 */
export function revokedAuthor(state, block, dag) {
  const sc = state && state.succession;
  if (!sc || state.ownerless || sc.keys.length === 0) return false;
  const e = block.e;
  for (const p of e.prev) if (!dag || !dag.has(p)) return false;
  const last = sc.keys.length - 1;
  const lv = sc.levelAfterPrev(e.prev, dag);
  if (e.author !== sc.keys[lv]) return false;
  return lv < last || sc.frozen;
}

/**
 * controlFor(dag, h, controlBlocks, ancestorSets, { genesisOwner }) -> ControlState
 * The permission state that governs block h: the fold, in the given (total) order, of the valid
 * policy and allow blocks C with h not in ancestors(C), plus every valid ban (bans are global).
 * controlBlocks: the valid control blocks in total order; ancestorSets: optional Map(h -> Set)
 * memo, filled on demand from dag.ancestors(). Owner and tombstone blocks are ignored here.
 * -> { writers, bits, maxValueBytes, maxChainBytes, moderators: Set, allow: Set, banned: Set }
 */
export function controlFor(dag, h, controlBlocks, ancestorSets, options) {
  const owned = !options || options.genesisOwner === undefined || typeof options.genesisOwner === 'string';
  const cs = basePolicy(owned);
  const banned = new Set();
  for (const c of controlBlocks || []) {
    const op = c.e.op;
    if (op.t === 'ban') {
      banned.add(op.author);
      continue;
    }
    if (op.t !== 'policy' && op.t !== 'allow') continue;
    let anc = ancestorSets ? ancestorSets.get(c.h) : undefined;
    if (!anc) {
      anc = dag.ancestors(c.h);
      if (ancestorSets) ancestorSets.set(c.h, anc);
    }
    if (anc.has(h)) continue;
    applyPermission(cs, op);
  }
  cs.banned = banned;
  return cs;
}

function refuse(code, reason) {
  return { ok: false, code, reason };
}

/**
 * admit(state, block, { dag, genesisOwner = null, expectedOwner = null, minBits = 0 })
 *   -> { ok: true, dropValue: boolean } | { ok: false, code, reason }
 *
 * The ingest control-state check of ARCHITECTURE 6.3, with the reducer's own rules: would
 * `block`, arriving now with all of its parents in `dag` (and no descendants), take effect under
 * the control state at the local heads, `state = reduce(dag, ...)`? For such a block
 * controlFor(block) is exactly state.policy, and its owner standing is ownerStanding(): the owner
 * at the heads, at the last level of the chain (a key that has handed over, or is contested, has
 * none), so the answer matches what reduce() will do once the block is added (unit-tested). Run it
 * after validateBlock; skip it for blocks WANTed as parents of blocks already held.
 * codes (SDK, ARCHITECTURE 9): E_NOT_OWNER (owner-only op, or a root by anyone but the genesis
 * owner), E_NOT_MODERATOR (ban, foreign tombstone, '_' key), E_BANNED, E_POLICY (writers, allow
 * set, governing bits, tombstone of a control block), E_LIMIT (value over maxValueBytes), E_CAP
 * (DAG at maxChainBytes: only the owner, moderators and allow-listed authors are ingested).
 * dropValue: the block may be stored only without its value (its tombstone arrived first).
 */
export function admit(state, block, options) {
  const opts = options || {};
  const dag = opts.dag || null;
  const genesisOwner = typeof opts.genesisOwner === 'string' ? opts.genesisOwner : null;
  const owned = genesisOwner !== null;
  const minBits = Number.isInteger(opts.minBits) && opts.minBits > 0 ? opts.minBits : 0;
  const e = block.e;
  const op = e.op;
  const author = e.author;
  const p = state.policy;
  if (owned && e.prev.length === 0 && author !== genesisOwner) return refuse('E_NOT_OWNER', 'root');
  let isOwner = false;
  if (owned) {
    if (state.succession) isOwner = ownerStanding(state, block, { dag, expectedOwner: opts.expectedOwner });
    else isOwner = author === (dag ? ownerAfter(dag, e.prev, genesisOwner) : state.owner);
  }
  const privileged = isOwner || p.moderators.has(author);
  const floor = Math.max(minBits, p.bits);
  const atCap = dag !== null && typeof dag.bytes === 'number' && dag.bytes >= p.maxChainBytes;
  if (PAYLOAD.has(op.t)) {
    if (p.banned.has(author) && !isOwner) return refuse('E_BANNED', 'banned');
    if (!privileged) {
      if (p.writers === 'owner') return refuse('E_POLICY', 'writers');
      if (p.writers === 'allow' && !p.allow.has(author)) return refuse('E_POLICY', 'allow');
      if (e.bits < floor) return refuse('E_POLICY', 'bits');
    }
    const name = op.t === 'put' ? op.k : op.t === 'append' ? op.l : '';
    if (name.charCodeAt(0) === UNDERSCORE && !privileged) return refuse('E_NOT_MODERATOR', 'underscore');
    if (block.v !== undefined && byteLength(canonicalize(block.v)) > p.maxValueBytes) return refuse('E_LIMIT', 'value-size');
    if (atCap && !privileged && !p.allow.has(author)) return refuse('E_CAP', 'cap');
    return { ok: true, dropValue: state.tombstoned.has(block.h) };
  }
  if (op.t === 'policy' || op.t === 'owner' || op.t === 'allow') {
    if (!isOwner) return refuse('E_NOT_OWNER', 'owner-only');
    if (op.t === 'owner' && op.next === author) return refuse('E_POLICY', 'self-succession');
    return { ok: true, dropValue: false };
  }
  if (op.t === 'ban') return privileged ? { ok: true, dropValue: false } : refuse('E_NOT_MODERATOR', 'moderator-only');
  if (op.t === 'tombstone') {
    const target = dag ? dag.get(op.h) : undefined;
    if (target && !PAYLOAD.has(target.e.op.t)) return refuse('E_POLICY', 'target');
    if (privileged) return { ok: true, dropValue: false };
    if (!target || target.e.author !== author) return refuse('E_NOT_MODERATOR', 'not-author');
    if (e.bits < floor) return refuse('E_POLICY', 'bits');
    if (atCap && !p.allow.has(author)) return refuse('E_CAP', 'cap');
    return { ok: true, dropValue: false };
  }
  return refuse('E_POLICY', 'op');
}

/**
 * shouldDropValue(state, block, dag?) -> boolean: the block is a payload block whose value must
 * not be kept or relayed (tombstoned, or by a banned author). Exact for blocks in `dag` (it reads
 * state.redacted); for a block not yet in the DAG the owner exemption uses the current owner.
 */
export function shouldDropValue(state, block, dag) {
  if (!block || !block.e || !block.e.op || !PAYLOAD.has(block.e.op.t)) return false;
  if (state.redacted.has(block.h) || state.tombstoned.has(block.h)) return true;
  if (dag && typeof dag.has === 'function' && dag.has(block.h)) return false;
  return state.policy.banned.has(block.e.author) && block.e.author !== state.owner;
}

// Own data properties only, so keys such as "__proto__" stay ordinary keys.
function plainObject(entries) {
  const out = {};
  for (const [k, v] of entries) Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
  return out;
}

/**
 * snapshot(state) -> plain JSON for the SDK and UI:
 * { height, depth, bytes, capReached, kv: { k: v }, lists: { name: [{ h, author, ts, v }] oldest
 *   first }, profiles: { pub: name }, policy: { writers, bits, maxValueBytes, maxChainBytes,
 *   moderators: [], banned: [], allowCount }, owner, authors: n, unmoderated }
 * Values are shared with the state, not copied: treat them as read-only.
 */
export function snapshot(state) {
  const kvEntries = [];
  for (const [k, entry] of state.kv) kvEntries.push([k, entry.v]);
  const listEntries = [];
  for (const [name, items] of state.lists) {
    listEntries.push([name, items.map((it) => ({ h: it.h, author: it.author, ts: it.ts, v: it.v }))]);
  }
  const p = state.policy;
  return {
    height: state.height,
    depth: state.depth,
    bytes: state.bytes,
    capReached: state.capReached,
    kv: plainObject(kvEntries),
    lists: plainObject(listEntries),
    profiles: plainObject(state.profiles),
    policy: {
      writers: p.writers,
      bits: p.bits,
      maxValueBytes: p.maxValueBytes,
      maxChainBytes: p.maxChainBytes,
      moderators: Array.from(p.moderators).sort(),
      banned: Array.from(p.banned).sort(),
      allowCount: p.allow.size,
    },
    owner: state.owner,
    authors: state.authors.size,
    unmoderated: state.owner === null,
  };
}

/** roleOf(pub, state) -> 'owner' | 'moderator' | 'writer' | 'reader' under the current control state. */
export function roleOf(pub, state) {
  if (typeof pub !== 'string' || !state) return 'reader';
  if (state.owner && pub === state.owner && !state.ownerConflict) return 'owner';
  const p = state.policy;
  if (p.moderators.has(pub)) return 'moderator';
  if (p.banned.has(pub)) return 'reader';
  if (p.writers === 'open') return 'writer';
  if (p.writers === 'allow' && p.allow.has(pub)) return 'writer';
  return 'reader';
}
