// Site ledger node (ARCHITECTURE 6.3, 6.6 to 6.8 and 15.4; DESIGN-REVIEW items 1 to 5, S1, S2, S9; v0.3
// hardening and the freeze group's local rules: V03-DESIGN-REVIEW 1.1 item 7, 2.5.3, 2.16.4, 3.3; MF-24,
// MF-29, MF-64, MF-73 to MF-75).
//
// ChainNode ties the pieces together: a Dag of verified blocks loaded from the store (pruned to the
// stored checkpoint, when there is one), the deterministic state (state.js reduce) recomputed lazily,
// the ingest pipeline, local writes, the gossip, and the torrent wire adapter.
//
// Ingest (6.3), per block, cheapest first (v0.3, MF-75: policy before signature): shape and limits ->
// h recomputes -> the claimed PoW holds (leadingZeroBits(h) >= e.bits) -> the root rule (only the
// genesis owner creates roots; the block named by the pointer's gen= is always accepted) -> the
// control-state check under the control state at the local heads (state.js admit: writers, allow
// list, bans, the fee, owner-only ops; blocks a held orphan waits for, i.e. parents WANTed for
// blocks already held, are exempt but still verified, and still bounded by the cap) -> the reserved
// pool -> the ingress throttle -> only then the ECDSA signature and the value hash (validateBlock, in
// the verifier pool), within the peer's signature-check budget (verifyRate per second per peer,
// chosen; blocks over it wait in a bounded per-peer queue that tick() drains, and the gossip asks
// that peer for nothing more while its queue is long) -> dedupe -> dag.add. Rejected blocks are
// neither stored nor relayed; reasons are counted in node.stats. A block refused without its parents
// (frames out of order, a fresh node without the genesis yet) is set aside instead (at most deferMax;
// when full, the peer holding the most entries loses its oldest, PEER A8) and judged again once its
// parents are in. Rate rejections are
// never remembered by hash; policy rejections of blocks judged with their parents are, until the
// control state changes (so a peer's INV does not make us fetch them again and again), except
// E_LIMIT, which depends on the value and so not on the hash alone; cap and pool rejections are
// remembered only while the node stays at its cap or its pool stays full (code review round 1).
// A block whose control op may open the policy (policy, allow, owner, unban, rotate, keyinfo) ends the
// batch's wave when it passes its checks: the blocks after it are judged under the state it makes.
//
// Ingress throttle (local, per author, never part of validity; v0.3, MF-75): live blocks (pushed by a
// peer, announced, or written here) are counted by their arrival time on this node, at most
// ingressRate.n per perMs per author, whatever ts they claim; history (asked for by a sync session,
// as a parent of a held orphan, from a snapshot, or offered by a direct ingest() call without
// { live: true }) is not counted. The owner and moderators in effect are never counted.
//
// Reserved pool (freeze group, an admit rule, local; R 2.5.3, U-LG-3): authors who are not the owner,
// a moderator or allow-listed (vetted authors, a key they rotated to included) share at most
// policy.reservedPool percent of maxChainBytes (default 25); a block that would take them past it is
// refused with E_CAP while vetted authors still write. Beyond maxChainBytes only vetted blocks are
// ingested (admit returns E_CAP). Ownerless ledgers have no vetted authors and no pool. capacity()
// reports the figures; a local write that leaves the ledger (or, for an unvetted writer, the pool) at
// or above 80 percent of its size reports E_LEDGER_FULL to the writer (opts.onWarning; MF-24).
//
// Moderator tombstone grace (freeze group, a node rule, local; R 2.5.3, MF-29): a value tombstoned by a
// moderator alone is hidden at once (the state never shows it, gossip never relays it, exportBlocks
// never exports it) and deleted from memory and the store 24 h (graceMs) after this node first saw
// it hidden, by local time (never the claimed ts), so a late revocation (voided, removal) can show it
// again. Review round (HUB-2): the same grace covers every value hidden by moderator standing only (a
// moderator bulk tombstone or a moderator ban too: state.modHidden). No grace when the target is on the P0
// path (a _deny/ entry with reason 'P0' names its block hash as ref, or the hash of its value's ih or
// sha256), when its author or the owner also tombstoned it, or when an owner ban or owner bulk tombstone
// hides it: those values are deleted at once. Grace start times are kept in the store's meta ('grace'),
// so a reload does not restart them.
//
// Checkpoints (freeze group; R 2.5.3): applyCheckpoint(S) prunes the DAG to the checkpoint in effect
// whose snap S matches (dag.pruneTo): the covered blocks, stubs included, leave memory and the store
// (store.applyCheckpoint keeps S in meta, with the depths of the covered blocks, so a reopened copy
// gets the depths and windows of a copy that pruned live), and later blocks naming covered parents
// are accepted; orphans that waited only on covered parents enter the DAG and the store. A node that
// does not hold the covered history (a fresh copy fed a recent window or a snapshot) may pass the
// checkpoint block itself: it must be valid, name S's snap, and be signed by the last owner key in S,
// which must be the pointer's owner (expectedOwner, else the genesis owner). Code review v0.3 (MF-24 to
// MF-26): every copy prunes on its own; tick() applies the checkpoint that has come into effect (an
// owner checkpoint arrived over gossip, from a snapshot, or from a tool) with the state S reduce()
// computed for it. exportSnapshot() puts { mw: 'checkpoint-v1', ledger, checkpoint: { h, snap, S } }
// before the blocks of a pruned copy, and importSnapshot() applies such a header (or a recent window's)
// first, so a pruned ledger still travels as a cs= file.
//
// Claimed times (code review v0.3; ts is chosen by the signer): a remote or snapshot block whose ts is
// more than futureMs (5 minutes) ahead of this clock is not stored or relayed until then: a remote one
// waits in the deferred pool while it is at most futureDeferMs (1 hour) ahead, anything further is
// refused with E_FUTURE (not remembered by hash for long: it is offered again later). So a banned
// author cannot post past a ban's until, which governs blocks by their ts. A live moderator ban,
// unban, tombstone or allow block must claim a time within modClockMs (15 minutes) of its arrival
// (E_CLOCK, never remembered: it may still come as history), so one session cannot spread its actions
// over many claimed hours to pass modActionsPerHour; the state rule keys the cap by the block's time
// (max of ts and its causal past, state.js).
//
// Write-through: inserted blocks are in the store before ingest() / put() resolve and before they
// are announced. A local write is stored before it enters the DAG: when the store refuses it, put()
// rejects and the block is neither kept, relayed nor used as a parent (code review round 1). A
// remote block whose store write failed stays in memory and is written again with the next batch
// (or by tick() every persistRetryMs, and at close()). Tombstones and bans drop v in memory and in
// the store (dropValue). A v-less payload block that no tombstone or ban explains is asked for
// again with WANT { h, v: true }; so is a value whose hiding a control change lifted.
// Timers: real ones by default, unref'd in Node; close() clears every timer the node set.
//
// Control state. admit() needs the policy, the owner, the bans and the tombstones at the heads. They
// change only through control blocks: a tombstone by the target's own author admitted at the heads
// is applied incrementally; any other control block (policy, owner, allow, ban, a moderator or owner
// tombstone, or one that arrived as an exempt parent) and any _deny/ entry trigger a full reduce
// before the next admission. The full state (kv, lists, profiles) is recomputed only when read
// (node.state, snapshot()) and remote notifications are coalesced, so a bootstrap of thousands of
// blocks does not reduce per batch.
//
// Local writes (S9): prev = own last block + the max-depth head + the oldest heads, at most 8;
// ts = now rounded to the minute (createBlock); seq = own highest seq + 1 (informational); bits =
// 0 for the owner and moderators in effect, else max(config.minBits, policy bits). Writes are
// checked with admit(), the pool and the throttle before mining, mined outside the ingest lock,
// checked again and stored through the same pipeline, and run one at a time so each builds on the
// previous one. Control ops from the browser go through writeControl(op) (v0.3 reconciliation: the SDK's
// mw.mod.* and owner.policy; admit decides who may sign each op, so a reader's call fails E_NOT_OWNER or
// E_NOT_MODERATOR); tools/ledger-admin.mjs writes them offline; a person's own site (R 3.3) starts from
// ChainNode.genesis() in the browser. setIdentity(identity | null) swaps the signing key of an open node
// (sign-in, sign-out) and recomputes the own-chain hints. MF-20 (code review v0.3): an identity that
// carries rc (the key bundle's recovery commitment, 43 base64url characters) writes { t: 'keyinfo', rc }
// before its first other write on this ledger (after it, when that first write is a recover rotation to
// this key), so every member key gets its commitment while it is still first (state.js keyinfo).
// Every write takes { signal, onProgress, onWarning } (code review round 1, DESIGN-REVIEW item 4):
// onProgress({ hashes, bits }) follows the mining; an aborted signal stops it (E_POW_ABORTED), and a
// write whose signal aborts before it is ingested is never stored or published, so a caller that
// gave up (the SDK's timeout) does not see its entry appear later.

import { Dag } from './dag.js';
import {
  reduce, snapshot as snapshotOf, roleOf, isBanned, admit, shouldDropValue, revokedAuthor, ownerAt, checkpointSnap, decodeCovered,
  allowListed,
} from './state.js';
import {
  createBlock, validateBlock, validatePolicyFields, roundTs, LIMITS, DEFAULT_POLICY, POLICY_FIELDS, PAYLOAD_OPS, CONTROL_OPS,
  SIG_PREFIX, isControlOp, isPayloadOp, blockBytes, redact,
} from './block.js';
import { canonicalize, utf8, hex, b64url } from './canonical.js';
import { sha256Sync } from './sha256-sync.js';
import { powAbortedError, leadingZeroBits, MAX_BITS } from './pow.js';
import { Gossip, Bucket, MIN_BLOCK_BYTES, MAX_LEDGER_BLOCKS } from './gossip.js';
import { attachToTorrent } from './wire-ext.js';
import { MemoryBlockStore } from './stores.js';
import { isPublicKeyString, fromUntaggedP256, keyAlgorithm, verify as verifySignature } from './crypto.js';
import { ledgerIdFor } from '../common/pointer.js';

// The local identity only (never input from peers): a browser that stored its identity before
// v0.2.1 holds the untagged spelling of the same key; it signs as 'p256:...' (DIGEST-AMENDMENTS A2).
function localIdentity(identity) {
  if (!identity || typeof identity.pub !== 'string') return null;
  if (isPublicKeyString(identity.pub) || keyAlgorithm(identity.pub) !== null) return identity;
  try {
    return Object.assign({}, identity, { pub: fromUntaggedP256(identity.pub) });
  } catch (_) {
    return identity; // not a key at all: writes fail with E_IDENTITY
  }
}

export const DEFAULT_CONFIG = Object.freeze({
  minBits: 0,
  ingressRate: Object.freeze({ n: 30, perMs: 600000 }),
  tickMs: 1000, // gossip tick (in-flight expiry, periodic HELLO, sync sessions); 0 = call tick() yourself
  notifyMs: 250, // remote changes are announced to subscribers at most this often
  metaMs: 1000, // meta (heads, root, bytes) is handed to the store at most this often
  verifyChunk: 64,
  snapshotChunk: 256,
  rejectMemory: 4096,
  deferMax: 512, // verified or prechecked blocks set aside until their parents arrive (see _defer)
  persistRetryMs: 30000, // failed store writes of remote blocks are retried at most this often by tick()
  persistRetryMax: 512, // blocks written again per retry
  deferTtlMs: 120000,
  verifyRate: 512, // v0.3 (MF-75): signature checks per second per peer (chosen, not measured)
  verifyBurst: 2048,
  verifyQueueMax: 1024, // blocks of one peer waiting for their signature check
  verifyBusyAt: 256, // above this many the gossip asks that peer for nothing more
  fullRatio: 0.8, // v0.3 (MF-24): E_LEDGER_FULL at 80 percent
  graceMs: 86400000, // v0.3 (MF-29): moderator tombstone values kept 24 h (chosen)
  futureMs: 300000, // code review v0.3: a block more than 5 minutes ahead of this clock waits until then (chosen)
  futureDeferMs: 3600000, // ... in the deferred pool while at most an hour ahead; beyond, E_FUTURE (chosen)
  modClockMs: 900000, // code review v0.3: a live moderator action claims a time within 15 minutes of its arrival (chosen)
  // Review round (SCALE-8): blocks held plus blocks a checkpoint pruned stop here for everyone, vetted authors
  // included, so a copy's HELLO (n + c) never passes MAX_LEDGER_BLOCKS and the ledger stays syncable.
  maxLifetimeBlocks: MAX_LEDGER_BLOCKS - 64,
});

/** First entry of a pruned copy's export (exportSnapshot): importSnapshot() applies its checkpoint first. */
export const CHECKPOINT_SNAPSHOT_KIND = 'checkpoint-v1';
const RC_RE = /^[A-Za-z0-9_-]{43}$/;
// Moderator actions whose claimed time the live clock check reads (HUB H2).
const MOD_CLOCK_OPS = new Set(['ban', 'unban', 'tombstone', 'allow']);

const HEX64 = /^[0-9a-f]{64}$/;
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;
const NONCE_RE = /^[0-9A-Za-z_-]{0,64}$/;
const ENTRY_KEYS = ['v', 'site', 'author', 'seq', 'prev', 'ts', 'bits', 'op', 'nonce'];
const PAYLOAD_SET = new Set(PAYLOAD_OPS);
const KNOWN_OPS = new Set(PAYLOAD_OPS.concat(CONTROL_OPS));
const JUSTIFY_MAX = 4;
const PRIV_NEEDS_MAX = 4096;
const DENY_PREFIX = '_deny/';
// Control ops whose effect can turn a refusal into an acceptance for later blocks of the same batch (the
// rest, bans and tombstones, only make the checks _place repeats stricter).
const PERMISSIVE_OPS = new Set(['policy', 'allow', 'owner', 'unban', 'rotate', 'keyinfo']);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// One signal that aborts when either does (the node's close() and the caller's own signal).
function linkSignals(a, b) {
  if (!a) return { signal: b || null, done() {} };
  if (!b) return { signal: a, done() {} };
  const c = new AbortController();
  const forward = () => c.abort();
  if (a.aborted || b.aborted) c.abort();
  else {
    a.addEventListener('abort', forward);
    b.addEventListener('abort', forward);
  }
  return {
    signal: c.signal,
    done() {
      a.removeEventListener('abort', forward);
      b.removeEventListener('abort', forward);
    },
  };
}

function writeOptions(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const signal = o.signal && typeof o.signal.addEventListener === 'function' ? o.signal : null;
  const onProgress = typeof o.onProgress === 'function' ? o.onProgress : null;
  const onWarning = typeof o.onWarning === 'function' ? o.onWarning : null;
  return { signal, onProgress, onWarning };
}

// Real timers by default, unref'd in Node so an unclosed node never keeps a process alive
// (browsers return numbers and have no unref).
function defaultSetTimeout(fn, ms) {
  const t = setTimeout(fn, ms);
  if (t && typeof t === 'object' && typeof t.unref === 'function') t.unref();
  return t;
}

function defaultClearTimeout(t) {
  clearTimeout(t);
}

function coded(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function isPlainObject(x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

// { e, h, s, v?, z? }: the value travels with its salt (v0.2.1 A1) and never without it.
function plainBlock(b) {
  const out = { e: b.e, h: b.h, s: b.s };
  if (b.v !== undefined) {
    out.v = b.v;
    if (b.z !== undefined) out.z = b.z;
  }
  return out;
}

function looksLikeBlock(b) {
  return isPlainObject(b) && typeof b.h === 'string' && HEX64.test(b.h) && isPlainObject(b.e) && Array.isArray(b.e.prev);
}

/**
 * quickShape(block, siteId) -> null | reason: the structural rules of validateBlock that the checks
 * before the signature rely on (block.js stays the authority: every block that passes them is still
 * validated in full before it is stored). Reasons as validateBlock: 'shape', 'limit', 'op', 'unknown-op'.
 */
export function quickShape(b, siteId) {
  for (const key of Object.keys(b)) if (key !== 'e' && key !== 'h' && key !== 's' && key !== 'v' && key !== 'z') return 'shape';
  if (typeof b.s !== 'string' || !SIG_RE.test(b.s)) return 'shape';
  const e = b.e;
  const keys = Object.keys(e);
  if (keys.length !== ENTRY_KEYS.length) return 'shape';
  for (const k of ENTRY_KEYS) if (!has(e, k)) return 'shape';
  if (e.v !== 1) return 'shape';
  if (typeof siteId === 'string' && e.site !== siteId) return 'shape';
  if (!isPublicKeyString(e.author)) return 'shape';
  if (!Number.isSafeInteger(e.seq) || e.seq < 0) return 'shape';
  if (e.prev.length > LIMITS.maxPrev) return 'limit';
  for (let i = 0; i < e.prev.length; i++) {
    const p = e.prev[i];
    if (typeof p !== 'string' || !HEX64.test(p)) return 'shape';
    if (i > 0 && !(e.prev[i - 1] < p)) return 'shape';
  }
  if (!Number.isSafeInteger(e.ts) || e.ts < 0 || e.ts % 60000 !== 0) return 'shape';
  if (!Number.isInteger(e.bits) || e.bits < 0 || e.bits > MAX_BITS) return 'shape';
  if (typeof e.nonce !== 'string' || !NONCE_RE.test(e.nonce)) return 'shape';
  const op = e.op;
  if (!isPlainObject(op) || typeof op.t !== 'string') return 'op';
  if (!KNOWN_OPS.has(op.t)) return 'unknown-op';
  if (op.t === 'checkpoint' && !has(op, 'heads')) return 'unknown-op'; // the v0.2.1 placeholder form
  const payload = PAYLOAD_SET.has(op.t);
  const hasV = b.v !== undefined;
  const hasZ = b.z !== undefined;
  if (!payload && (hasV || hasZ)) return 'shape';
  if (hasV !== hasZ) return 'shape';
  if (op.t === 'put' && typeof op.k !== 'string') return 'op';
  if (op.t === 'append' && typeof op.l !== 'string') return 'op';
  if (op.t === 'tombstone' && op.h !== undefined && (typeof op.h !== 'string' || !HEX64.test(op.h))) return 'op';
  if (op.t === 'rotate' && op.by === 'recover' && typeof op.rp !== 'string') return 'op';
  if ((op.t === 'allow') && op.remove !== undefined && !Array.isArray(op.remove)) return 'op';
  return null;
}

/** denyIdOf(id) -> the _deny/ key suffix of a content identifier: b64url(sha256(utf8(id))) (R 2.8.7). */
export function denyIdOf(id) {
  return b64url.encode(sha256Sync(utf8.encode(String(id))));
}

/**
 * topoSort(blocks): the blocks ordered so that every block comes after the blocks of the set its
 * prev names; blocks that do not depend on each other keep their input order (a peer answers in
 * total order, and a snapshot is exported in total order). Entries that are not block-shaped are
 * left out; of a repeated hash the first copy is kept, or the first one carrying a value. A cycle
 * (impossible with valid hashes) leaves its members at the end in input order.
 */
export function topoSort(blocks) {
  const list = [];
  const pos = new Map();
  for (const b of blocks || []) {
    if (!looksLikeBlock(b)) continue;
    const at = pos.get(b.h);
    if (at === undefined) {
      pos.set(b.h, list.length);
      list.push(b);
    } else if (list[at].v === undefined && b.v !== undefined) {
      list[at] = b;
    }
  }
  const n = list.length;
  const waits = new Int32Array(n);
  const children = new Array(n);
  for (let i = 0; i < n; i++) {
    const prev = list[i].e.prev;
    for (let j = 0; j < prev.length; j++) {
      const p = pos.get(prev[j]);
      if (p === undefined || p === i) continue;
      waits[i]++;
      if (children[p]) children[p].push(i);
      else children[p] = [i];
    }
  }
  // Ready blocks leave in input order: a binary min-heap of indices.
  const heap = [];
  const push = (x) => {
    let i = heap.length;
    heap.push(x);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (heap[up] <= x) break;
      heap[i] = heap[up];
      i = up;
    }
    heap[i] = x;
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= heap.length) break;
        const c = l + 1 < heap.length && heap[l + 1] < heap[l] ? l + 1 : l;
        if (heap[c] >= last) break;
        heap[i] = heap[c];
        i = c;
      }
      heap[i] = last;
    }
    return top;
  };
  for (let i = 0; i < n; i++) if (waits[i] === 0) push(i);
  const out = [];
  const done = new Uint8Array(n);
  while (heap.length > 0) {
    const i = pop();
    done[i] = 1;
    out.push(list[i]);
    const kids = children[i];
    if (!kids) continue;
    for (let j = 0; j < kids.length; j++) if (--waits[kids[j]] === 0) push(kids[j]);
  }
  if (out.length < n) for (let i = 0; i < n; i++) if (!done[i]) out.push(list[i]);
  return out;
}

const RANK = { owner: 3, moderator: 2, writer: 1, reader: 0 };

/** Defaults of a person's own site (R 3.3): owner-only, a 16-bit fee for anyone it later opens to, 8 MiB. */
export const PERSONAL_POLICY = Object.freeze({ writers: 'owner', bits: 16, maxChainBytes: 8388608 });

// A full genesis policy op: every v1 field (DEFAULT_POLICY where not given) and the freeze fields given.
function genesisPolicyOp(partial) {
  const src = partial || {};
  const op = { t: 'policy' };
  for (const f of ['writers', 'bits', 'maxValueBytes', 'maxChainBytes', 'moderators', 'allow']) {
    let v = src[f] === undefined || src[f] === null ? DEFAULT_POLICY[f] : src[f];
    if (f === 'moderators' || f === 'allow') v = Array.from(new Set(v)).sort();
    op[f] = v;
  }
  for (const f of POLICY_FIELDS) {
    if (has(op, f) || src[f] === undefined || src[f] === null) continue;
    op[f] = src[f];
  }
  const check = validatePolicyFields(op);
  if (!check.ok) throw coded('E_INVALID', 'invalid policy field ' + (check.field || '') + ' (' + check.reason + ')');
  return op;
}

// A control block signed by an injected signer: { pub, sign(bytes) -> Promise<Uint8Array(64) | b64url> }.
async function signedControl({ signer, site, seq, prev, op, ts }) {
  const e = { v: 1, site, author: signer.pub, seq, prev: Array.from(new Set(prev)).sort(), ts: roundTs(ts), bits: 0, op, nonce: '' };
  const h = hex.encode(sha256Sync(utf8.encode(canonicalize(e))));
  let sig = await signer.sign(utf8.encode(SIG_PREFIX + h));
  if (sig instanceof ArrayBuffer) sig = new Uint8Array(sig);
  const s = typeof sig === 'string' ? sig : b64url.encode(sig);
  if (!(await verifySignature(signer.pub, SIG_PREFIX + h, s))) throw coded('E_IDENTITY', 'the signer\'s signature does not verify with its public key');
  const block = { e, h, s };
  const v = await validateBlock(block, { site, minBits: 0 });
  if (!v.ok) throw coded('E_INVALID', 'the genesis block is invalid (' + v.reason + ')');
  return block;
}

export class ChainNode {
  /**
   * ChainNode.open({ siteId, expectedOwner = null, ledgerOwner = null, genesisHash = null, store, identity, miner,
   *   verifierPool, now, setTimeoutFn, clearTimeoutFn, config, gossipLimits }) -> Promise<ChainNode>
   * expectedOwner: the pointer's owner (the owner in effect the visitor trusts, the succession anchor);
   * ledgerOwner: the pointer's lo= (code review round 1), the genesis owner assumed until the genesis block is held.
   * identity: { privateKey, pub } (null: read-only node). store: MemoryBlockStore | IdbBlockStore
   * (default: a new MemoryBlockStore). config: { minBits, ingressRate: { n, perMs }, tickMs, ... }.
   */
  static async open(options) {
    const node = new ChainNode(options || {});
    try {
      await node._load();
    } catch (err) {
      node._closed = true;
      node._stopTimers();
      throw err;
    }
    return node;
  }

  /**
   * ChainNode.genesis({ signer, policy, keyinfo, chain, ledgerId, now }) -> Promise<{ blocks, ledgerId, gen,
   * chain }>: the first blocks of a person's own site, minted in the browser (R 3.3, MF-64, N-3). signer =
   * { pub: 'p256:...', sign(bytes) -> Promise<Uint8Array(64) P1363 | b64url string> }, the person's working
   * key for that site behind an injected function (never a raw key; the identity origin card signs).
   * policy defaults to PERSONAL_POLICY (writers 'owner', bits 16, maxChainBytes 8 MiB) over DEFAULT_POLICY;
   * keyinfo = { rc } adds the recovery commitment as a second block. ledgerId defaults to the chain= form:
   * "mw1:" + b64url(sha256(utf8(pub + "|" + chain))).slice(0, 27), with a fresh random chain unless one is
   * given. The pointer the caller signs carries owner=<pub>, chain=<chain>, gen=<gen>.
   */
  static async genesis({ signer, policy = null, keyinfo = null, chain = null, ledgerId = null, now = Date.now() } = {}) {
    if (!signer || typeof signer.sign !== 'function' || !isPublicKeyString(signer.pub)) {
      throw coded('E_IDENTITY', 'genesis needs a signer { pub: "p256:...", sign(bytes) }');
    }
    let chainLabel = chain;
    let site = ledgerId;
    if (typeof site !== 'string' || !site) {
      if (typeof chainLabel !== 'string' || !chainLabel) {
        const r = new Uint8Array(16);
        globalThis.crypto.getRandomValues(r);
        chainLabel = b64url.encode(r);
      }
      site = await ledgerIdFor({ sig: 'pending', owner: signer.pub, chain: chainLabel }, 'btih:' + '0'.repeat(40));
    }
    const op = genesisPolicyOp(Object.assign({}, PERSONAL_POLICY, policy || {}));
    const ts = typeof now === 'number' ? now : Date.now();
    const gen = await signedControl({ signer, site, seq: 0, prev: [], op, ts });
    const blocks = [gen];
    if (keyinfo) {
      const rc = typeof keyinfo === 'string' ? keyinfo : keyinfo.rc;
      blocks.push(await signedControl({ signer, site, seq: 1, prev: [gen.h], op: { t: 'keyinfo', rc }, ts }));
    }
    return { blocks, ledgerId: site, gen: gen.h, chain: typeof chainLabel === 'string' ? chainLabel : null };
  }

  constructor({
    siteId, expectedOwner = null, ledgerOwner = null, genesisHash = null, store = null, identity = null, miner = null,
    verifierPool = null, now = null, setTimeoutFn = null, clearTimeoutFn = null, config = null, gossipLimits = null,
  } = {}) {
    if (typeof siteId !== 'string' || siteId.length === 0) throw new TypeError('ChainNode needs a siteId');
    this.siteId = siteId;
    this.expectedOwner = typeof expectedOwner === 'string' && expectedOwner ? expectedOwner : null;
    this.ledgerOwner = typeof ledgerOwner === 'string' && ledgerOwner ? ledgerOwner : this.expectedOwner;
    this.genesisHash = typeof genesisHash === 'string' && HEX64.test(genesisHash) ? genesisHash : null;
    this.store = store || new MemoryBlockStore();
    this._identity = localIdentity(identity);
    this.miner = miner || null;
    this.verifierPool = verifierPool || null;
    this.now = typeof now === 'function' ? now : () => Date.now();
    this._setTimeout = typeof setTimeoutFn === 'function' ? setTimeoutFn : defaultSetTimeout;
    this._clearTimeout = typeof clearTimeoutFn === 'function' ? clearTimeoutFn : defaultClearTimeout;
    const cfg = Object.assign({}, DEFAULT_CONFIG, config || {});
    if (!cfg.ingressRate || typeof cfg.ingressRate !== 'object') cfg.ingressRate = null;
    this.config = cfg;
    this._gossipLimits = gossipLimits || null;
    this.dag = new Dag();
    this.gossip = null;
    this._genesisOwner = null;
    this._ctl = null;
    this._ctlDirty = true;
    this._full = null;
    this._fullVersion = -1;
    this._pendingDrops = new Set();
    this._unpersisted = new Set(); // blocks in the DAG whose store write failed (written again later)
    this._lastPersistRetry = 0;
    this._tombIndex = new Map();
    this._tombsOf = new Map(); // target h -> Set of tombstone hashes (all of them; the grace rule reads it)
    this._banIndex = new Map();
    this._throttle = new Map();
    this._policyRejects = new Map();
    this._capRejects = new Map(); // h -> { kind: 'cap' | 'pool', size }: remembered while the node stays full
    this._futureRejects = new Map(); // h -> local time from which a block refused as E_FUTURE may be judged again
    this._checkpointFailed = null; // snap of a checkpoint in effect that could not be applied here (not retried)
    this._tempBansInForce = null; // temporary bans in force at the last tick (one running out notifies subscribers)
    this._privNeeds = new Set(); // missing parents a privileged (or cap-exempt) orphan waits on
    this._deferred = new Map(); // h -> { block, peerId, at, verified, live }: refused without parents, judged later
    this._orphanSizes = new Map(); // h -> { n: blockBytes, author } of blocks held in the Dag's orphan pool
    this._vbuckets = new Map(); // peerId -> Bucket of signature checks (MF-75)
    this._vq = new Map(); // peerId -> [{ b, live }] waiting for their signature check
    this._vqSet = new Set();
    this._authorBytes = new Map(); // author -> DAG bytes of that author's blocks
    this._poolUsed = 0; // DAG bytes of authors who are not vetted (the reserved pool)
    this._grace = new Map(); // h -> local time a moderator tombstone first hid its value (MF-29)
    this._graceDirty = false;
    this._denyCache = { st: null, ids: null, refs: null };
    this._pendingCheckpoint = null; // { meta, covered } the store has not taken yet
    this._subs = new Set();
    this._torrents = new Map();
    this._queue = Promise.resolve();
    this._writes = Promise.resolve();
    this._ownLast = null;
    this._ownSeq = 0;
    this._closed = false;
    this._abort = typeof AbortController === 'function' ? new AbortController() : null;
    this._tickTimer = null;
    this._notifyTimer = null;
    this._metaTimer = null;
    this.stats = {
      added: 0, duplicates: 0, orphans: 0, deferred: 0, valuesRestored: 0, persistErrors: 0, verified: 0, queued: 0,
      graceExpired: 0, rejected: {},
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Properties
  // ---------------------------------------------------------------------------------------------

  /** Full reduced state (state.js): kv, lists, profiles, owner, policy, tombstoned, height, ... */
  get state() {
    this._ensureControl();
    if (this._full === null || this._fullVersion !== this.dag.version) {
      const st = reduce(this.dag, this._reduceOptions());
      this._full = st;
      this._fullVersion = this.dag.version;
    }
    return this._full;
  }

  // The pointer's owner (expectedOwner) anchors contested successions (state.js header).
  _reduceOptions() {
    return { genesisOwner: this._genesisOwner, expectedOwner: this.expectedOwner, minBits: this.config.minBits };
  }

  _admitOptions() {
    return { dag: this.dag, genesisOwner: this._genesisOwner, expectedOwner: this.expectedOwner, minBits: this.config.minBits };
  }

  /** snapshot() -> state.js snapshot at this node's clock (a temporary ban is listed while it is in force). */
  snapshot() {
    return snapshotOf(this.state, { now: this.now() });
  }

  get height() {
    return this.dag.size;
  }

  get bytes() {
    return this.dag.bytes;
  }

  get peers() {
    return this.gossip ? this.gossip.peers : 0;
  }

  get inSyncPeers() {
    return this.gossip ? this.gossip.inSyncPeers : 0;
  }

  get identity() {
    return this._identity ? { pub: this._identity.pub, kind: this._identity.kind || 'visitor' } : null;
  }

  get role() {
    if (!this._identity) return 'reader';
    return this.roleOf(this._identity.pub);
  }

  /**
   * roleOf(pub) -> 'owner' | 'moderator' | 'writer' | 'reader' at the heads and this node's clock (code review v0.3: an
   * expired temporary ban no longer makes a reader; a key that rotated away is one). The chat and identity services ask
   * the node first.
   */
  roleOf(pub) {
    this._ensureControl();
    return roleOf(pub, this._ctl, this.now());
  }

  /** isBanned(pub) -> true while a ban governs pub's new blocks (permanent, or temporary and not yet over); never the owner. */
  isBanned(pub) {
    this._ensureControl();
    if (pub === this._ctl.owner && !this._ctl.ownerConflict) return false;
    return isBanned(pub, this._ctl, this.now());
  }

  /** The genesis owner this ledger is validated against (null: ownerless "btih:" ledger). */
  get genesisOwner() {
    return this._genesisOwner;
  }

  /** The owner in effect at the heads (after successions). */
  get owner() {
    this._ensureControl();
    return this._ctl.owner;
  }

  /** The pointer names an owner other than the ledger's owner in effect ("pointer and ledger owner differ"). */
  get ownerMismatch() {
    if (this.expectedOwner === null) return false;
    this._ensureControl();
    return this._ctl.owner !== null && this._ctl.owner !== this.expectedOwner;
  }

  /** Two contested hand-overs by one owner key and no endorsement by the pointer's owner: owner changes are paused. */
  get ownerConflict() {
    this._ensureControl();
    return this._ctl.ownerConflict === true;
  }

  get unmoderated() {
    return this._genesisOwner === null;
  }

  get closed() {
    return this._closed;
  }

  /**
   * capacity() -> { bytes, max, ratio, full, capReached, pool: { bytes, max, ratio, full }, code } (v0.3,
   * MF-24): bytes and max are the DAG's bytes and maxChainBytes; pool is what authors who are not vetted
   * hold and may hold (reservedPool percent of max; Infinity on an ownerless ledger); full is true at or
   * above fullRatio (80 percent) and code is then 'E_LEDGER_FULL'. Values in their tombstone grace count
   * until they are deleted.
   */
  capacity() {
    this._ensureControl();
    const max = this._ctl.policy.maxChainBytes;
    const bytes = this.dag.bytes;
    const ratioOf = (a, b) => (b > 0 && b !== Infinity ? a / b : b === Infinity ? 0 : 1);
    const fr = Number(this.config.fullRatio) || 0.8;
    const poolMax = this._poolMax();
    const ratio = ratioOf(bytes, max);
    const poolRatio = ratioOf(this._poolUsed, poolMax);
    const full = ratio >= fr;
    const poolFull = poolRatio >= fr;
    return {
      bytes, max, ratio, full, capReached: bytes >= max,
      pool: { bytes: this._poolUsed, max: poolMax, ratio: poolRatio, full: poolFull },
      code: full || poolFull ? 'E_LEDGER_FULL' : null,
    };
  }

  /** The checkpoint base { h, snap, S } this node pruned to (serve S by its snap: cs=, the hub lane), or null. */
  checkpointBase() {
    return this.dag.checkpointBase();
  }

  // ---------------------------------------------------------------------------------------------
  // Open, close
  // ---------------------------------------------------------------------------------------------

  async _load() {
    await this.store.open(this.siteId);
    const rows = await this.store.getAll();
    let cpMeta = null;
    try {
      cpMeta = typeof this.store.getCheckpoint === 'function' ? await this.store.getCheckpoint() : null;
    } catch (_) {
      cpMeta = null;
    }
    let grace = null;
    try {
      grace = await this.store.getMeta('grace');
    } catch (_) {
      grace = null;
    }
    const blocks = [];
    for (const b of rows || []) if (looksLikeBlock(b) && b.e.site === this.siteId) blocks.push(plainBlock(b));
    const sKeys = cpMeta && cpMeta.S && cpMeta.S.state && cpMeta.S.state.owner && Array.isArray(cpMeta.S.state.owner.keys) ? cpMeta.S.state.owner.keys : null;
    if (this.genesisHash) {
      const g = blocks.find((b) => b.h === this.genesisHash && b.e.prev.length === 0);
      this._genesisOwner = g ? g.e.author : (sKeys && typeof sKeys[0] === 'string' ? sKeys[0] : this.ledgerOwner);
    } else {
      this._genesisOwner = this.ledgerOwner || (sKeys && typeof sKeys[0] === 'string' ? sKeys[0] : null);
    }
    if (cpMeta && cpMeta.S && typeof cpMeta.h === 'string') {
      const cp = blocks.find((b) => b.h === cpMeta.h);
      if (cp) {
        try {
          this.dag.pruneTo(cp, cpMeta.S, { depths: cpMeta.depths || null });
        } catch (_) {
          this.stats.rejected.store = (this.stats.rejected.store || 0) + 1; // a damaged checkpoint row
        }
      }
    }
    for (const b of topoSort(blocks)) {
      if (this.dag.has(b.h) || this.dag.hasOrphan(b.h) || this.dag.isCovered(b.h)) continue;
      try {
        this.dag.add(b, 'store');
      } catch (_) {
        this.stats.rejected.store = (this.stats.rejected.store || 0) + 1; // a damaged row
        continue;
      }
      for (const x of this.dag.lastAdded) this._noteInserted(this.dag.get(x));
    }
    if (grace && typeof grace === 'object') {
      for (const h of Object.keys(grace)) {
        const at = grace[h];
        if (HEX64.test(h) && typeof at === 'number' && this.dag.has(h)) this._grace.set(h, at);
      }
    }
    this._recomputeControl();
    if (this._pendingDrops.size > 0) await this._persist([], []);
    this.gossip = new Gossip({
      site: this.siteId,
      owner: this._genesisOwner,
      dag: this.dag,
      ingest: (blocks2, peerId, ctx) => this.ingest(blocks2, peerId, ctx),
      getBlock: (h) => this.dag.get(h),
      justify: (h) => this._justify(h),
      needsValue: (h) => this._needsValue(h),
      skip: (h) => this._policyRejects.has(h) || this._capRejected(h) || this._futureRejected(h),
      pending: (h) => this._deferred.has(h) || this._vqSet.has(h),
      hidden: (h) => this._grace.has(h),
      busy: (peerId) => this._queueLength(peerId) >= (Number(this.config.verifyBusyAt) || Infinity),
      privileged: (pub) => (this._ctl ? this._capExempt(pub) : false),
      maxChainBytes: () => (this._ctl ? this._ctl.policy.maxChainBytes : LIMITS.maxChainBytesCeiling),
      onChange: () => this._notify('remote'),
      now: this.now,
      setTimeoutFn: this._setTimeout,
      clearTimeoutFn: this._clearTimeout,
      limits: this._gossipLimits || undefined,
      random: typeof this.config.random === 'function' ? this.config.random : undefined, // STALK-8 jitter (tests seed it)
    });
    const unexplained = [];
    for (const b of this.dag.blocks()) if (this._needsValue(b.h)) unexplained.push(b.h);
    if (unexplained.length > 0) this.gossip.wantValues(unexplained);
    this._scheduleTick();
    if (this.dag.size > 0) {
      this._setTimeout(() => {
        if (!this._closed) this._emit('load');
      }, 0);
    }
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    this._stopTimers();
    if (this._abort) {
      try {
        this._abort.abort();
      } catch (_) {
        // nothing in flight
      }
    }
    for (const detach of Array.from(this._torrents.values())) {
      try {
        detach();
      } catch (_) {
        // the torrent is already gone
      }
    }
    this._torrents.clear();
    this._deferred.clear();
    this._vq.clear();
    this._vqSet.clear();
    if (this.gossip) this.gossip.destroy();
    try {
      await this._queue;
    } catch (_) {
      // ingest failures were reported to their callers
    }
    if (this._unpersisted.size > 0 || this._pendingDrops.size > 0) {
      try {
        await this._persist([], []);
      } catch (_) {
        this.stats.persistErrors++; // the blocks come back from peers next time
      }
    }
    if (this._pendingCheckpoint) {
      try {
        await this._storeCheckpoint(this._pendingCheckpoint.meta, this._pendingCheckpoint.covered);
        this._pendingCheckpoint = null;
      } catch (_) {
        this.stats.persistErrors++;
      }
    }
    try {
      await this._writeMeta();
      await this.store.flush();
      await this.store.close();
    } catch (_) {
      // the store may already be closed
    }
    this._subs.clear();
  }

  _stopTimers() {
    for (const key of ['_tickTimer', '_notifyTimer', '_metaTimer']) {
      if (this[key] !== null) {
        try {
          this._clearTimeout(this[key]);
        } catch (_) {
          // already fired
        }
        this[key] = null;
      }
    }
  }

  _scheduleTick() {
    const ms = Number(this.config.tickMs);
    if (!(ms > 0) || this._closed) return;
    this._tickTimer = this._setTimeout(() => {
      this._tickTimer = null;
      if (this._closed) return undefined;
      const work = this.tick();
      this._scheduleTick();
      return work; // a virtual-clock harness awaits it; browsers ignore the return value
    }, ms);
  }

  /**
   * tick() -> Promise | undefined: gossip housekeeping, failed store writes, the throttle and deferred-pool
   * expiry, the signature-check queues and the end of tombstone grace periods (called every config.tickMs
   * automatically when > 0). Returns a promise of the asynchronous work it started, if any.
   */
  tick() {
    if (this._closed || !this.gossip) return undefined;
    this.gossip.tick();
    const now = this.now();
    const work = [];
    if ((this._unpersisted.size > 0 || this._pendingDrops.size > 0 || this._pendingCheckpoint) &&
      now - this._lastPersistRetry >= (Number(this.config.persistRetryMs) || 0)) {
      this._lastPersistRetry = now;
      work.push(this._exclusive(async () => {
        if (this._pendingCheckpoint) {
          await this._storeCheckpoint(this._pendingCheckpoint.meta, this._pendingCheckpoint.covered);
          this._pendingCheckpoint = null;
        }
        await this._persist([], []);
      }).catch(() => {
        this.stats.persistErrors++;
      }));
    }
    const rate = this.config.ingressRate;
    if (rate && this._throttle.size > 0) {
      const cutoff = now - rate.perMs;
      for (const [author, list] of this._throttle) {
        while (list.length > 0 && list[0] <= cutoff) list.shift();
        if (list.length === 0) this._throttle.delete(author);
      }
    }
    if (this._deferred.size > 0) {
      const old = now - (Number(this.config.deferTtlMs) || 0);
      let due = false;
      for (const [h, d] of this._deferred) {
        if (Math.max(d.at, d.notBefore || 0) <= old) this._deferred.delete(h);
        else if (d.notBefore && d.notBefore <= now && d.block.e.prev.every((p) => this.dag.has(p) || this.dag.isCovered(p))) due = true;
      }
      // Blocks that waited for their claimed time: judged now, as if they had just arrived (code review v0.3).
      if (due) {
        work.push(this._exclusive(() => this._ingest([], 'deferred', 'remote', { history: null, live: false, liveMap: null, wire: false })).catch(() => {
          this.stats.persistErrors++;
        }));
      }
    }
    // A temporary ban that ran out changes roles and the snapshot without any new block: subscribers hear it.
    if (this._ctl && this._ctl.policy.banUntil instanceof Map && this._ctl.policy.banUntil.size > 0) {
      let inForce = 0;
      for (const u of this._ctl.policy.banUntil.values()) if (u !== Infinity && now < u) inForce++;
      if (this._tempBansInForce !== null && inForce < this._tempBansInForce) this._notify('remote');
      this._tempBansInForce = inForce;
    }
    // A checkpoint that came into effect: this copy prunes to it (code review v0.3, MF-24 to MF-26).
    if (this._dueCheckpoint()) {
      work.push(this._exclusive(() => this._autoCheckpoint()).catch(() => {
        this.stats.persistErrors++;
      }));
    }
    if (this._vq.size > 0) for (const p of this._drainVerifyQueues()) work.push(p);
    if (this._grace.size > 0) {
      const p = this._expireGrace(now);
      if (p) work.push(p);
    }
    return work.length > 0 ? Promise.all(work).then(() => undefined) : undefined;
  }

  // ---------------------------------------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------------------------------------

  /** subscribe(fn) -> unsubscribe; fn(snapshot, { reason: 'local' | 'remote' | 'load' | 'snapshot' | 'identity' }). */
  subscribe(fn) {
    if (typeof fn !== 'function') throw new TypeError('subscribe expects a function');
    this._subs.add(fn);
    return () => {
      this._subs.delete(fn);
    };
  }

  _notify(reason) {
    if (this._closed || this._subs.size === 0) return;
    if (reason !== 'remote') {
      this._emit(reason);
      return;
    }
    if (this._notifyTimer !== null) return;
    this._notifyTimer = this._setTimeout(() => {
      this._notifyTimer = null;
      this._emit('remote');
    }, Math.max(0, Number(this.config.notifyMs) || 0));
  }

  _emit(reason) {
    if (this._closed || this._subs.size === 0) return;
    let snap;
    try {
      snap = this.snapshot();
    } catch (_) {
      return;
    }
    for (const fn of Array.from(this._subs)) {
      try {
        fn(snap, { reason });
      } catch (_) {
        // a subscriber's bug never breaks the ledger
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Torrents
  // ---------------------------------------------------------------------------------------------

  /**
   * attachTorrent(torrent, opts) -> detach(): gossip over every wire of the torrent (site or anchor, S1).
   * opts (v0.3, MF-74, all optional, from the loader's TorrentManager): anchorWire(wire) for a wire that
   * delivered a valid block, ignoreWire(wire, reason) for one the gossip ignores (default: the wire is
   * flagged __mwIgnored and the loader closes it), noteProgress(kind) with kind (default 'rendezvous')
   * when a peer is in sync.
   */
  attachTorrent(torrent, opts) {
    if (this._closed) return () => {};
    const known = this._torrents.get(torrent);
    if (known) return known;
    const detach = attachToTorrent(torrent, this.gossip, opts || {});
    const wrapped = () => {
      if (this._torrents.get(torrent) === wrapped) this._torrents.delete(torrent);
      detach();
    };
    this._torrents.set(torrent, wrapped);
    return wrapped;
  }

  // ---------------------------------------------------------------------------------------------
  // Control state
  // ---------------------------------------------------------------------------------------------

  _ensureControl() {
    if (this._ctlDirty || this._ctl === null) this._recomputeControl();
  }

  _recomputeControl() {
    const prev = this._ctl;
    const st = reduce(this.dag, this._reduceOptions());
    // The whole state: admit() reads the policy, the succession, keyinfo, rotations, the moderator
    // tombstones and what the owner wrote (freeze group).
    this._ctl = st;
    this._ctlDirty = false;
    const now = this.now();
    const graceOk = this._graceRule(st);
    for (const h of st.redacted) {
      const b = this.dag.get(h);
      if (!b || b.v === undefined) {
        if (this._grace.delete(h)) this._graceDirty = true;
        continue;
      }
      if (graceOk(h)) {
        if (!this._grace.has(h)) {
          this._grace.set(h, now);
          this._graceDirty = true;
        }
        continue;
      }
      if (this._grace.delete(h)) this._graceDirty = true;
      this._redactValue(h);
    }
    // A revocation (voided, a removed moderator) lifted the hiding: the value is shown again.
    for (const h of Array.from(this._grace.keys())) {
      if (!st.redacted.has(h)) {
        this._grace.delete(h);
        this._graceDirty = true;
      }
    }
    // Redaction does not change effects; only the byte figures move.
    st.bytes = this.dag.bytes;
    st.capReached = st.bytes >= st.policy.maxChainBytes;
    this._full = st;
    this._fullVersion = this.dag.version;
    this._policyRejects.clear();
    this._capRejects.clear(); // a control change (cap, allow list, moderators) judges them again
    this._recomputePool();
    if (prev && prev.redacted instanceof Set && this.gossip) {
      // Values another control state hid and this one shows: ask for the ones we no longer hold.
      const want = [];
      for (const h of prev.redacted) if (!st.redacted.has(h) && this._needsValue(h)) want.push(h);
      if (want.length > 0) this.gossip.wantValues(want);
    }
    if (this._graceDirty) this._scheduleMeta();
  }

  // Code review round 1: a block refused at the cap is not fetched again while the node stays at
  // its cap (two nodes at the cap with different subsets used to re-download each other's surplus
  // every sync); below the cap, or after any control change, everything is judged again. v0.3: the
  // same for the reserved pool, while the pool stays too full for that block.
  _capRejected(h) {
    const r = this._capRejects.get(h);
    if (!r) return false;
    if (this._ctl) {
      if (r.kind === 'cap' && this.dag.bytes >= this._ctl.policy.maxChainBytes) return true;
      if (r.kind === 'pool' && this._poolUsed + r.size > this._poolMax()) return true;
    }
    this._capRejects.clear();
    return false;
  }

  _rememberCapRejection(h, kind, size) {
    const max = this.config.rejectMemory;
    if (!(max > 0)) return;
    if (this._capRejects.size >= max) this._capRejects.delete(this._capRejects.keys().next().value);
    this._capRejects.set(h, { kind, size });
  }

  // A tombstone by the target's own author admitted at the heads: its effect on the control view is
  // exactly reduce()'s (admit() and reduce() agree for blocks at the heads), so no full reduce is
  // needed. Moderator and owner tombstones go through a full reduce (the grace rule decides).
  _applyTombstone(t) {
    const target = t.e.op.h;
    this._ctl.tombstoned.add(target);
    const b = this.dag.get(target);
    if (b && isPayloadOp(b.e.op)) {
      this._ctl.redacted.add(target);
      if (b.v !== undefined) this._redactValue(target);
    }
  }

  // Drops a held value (memory now, the store with the next persist) and keeps the byte counts.
  _redactValue(h) {
    const b = this.dag.get(h);
    if (!b || b.v === undefined) return false;
    let before = 0;
    let after = 0;
    try {
      before = blockBytes(b);
      after = blockBytes({ e: b.e });
    } catch (_) {
      before = after = 0;
    }
    if (!this.dag.redact(h)) return false;
    this._addAuthorBytes(b.e.author, after - before);
    this._pendingDrops.add(h);
    return true;
  }

  _isRedacted(h) {
    return this._ctl.redacted.has(h) || this._ctl.tombstoned.has(h);
  }

  _needsValue(h) {
    const b = this.dag.get(h);
    if (!b || b.v !== undefined || !isPayloadOp(b.e.op)) return false;
    this._ensureControl();
    return !this._isRedacted(h);
  }

  _privileged(pub) {
    return (this._ctl.owner === pub && !this._ctl.ownerConflict) || this._ctl.policy.moderators.has(pub);
  }

  // Authors whose blocks are still ingested beyond maxChainBytes (6.3).
  _capExempt(pub) {
    return this._privileged(pub) || this._ctl.policy.allow.has(pub);
  }

  // Vetted authors (the reserved pool's exemption): the owner, moderators, allow-listed keys, and a
  // key an allow-listed key rotated to (it inherits the allow membership, freeze group).
  _vetted(pub) {
    if (this._genesisOwner === null) return true; // ownerless: no vetted authors, so no pool
    if (this._capExempt(pub)) return true;
    return allowListed(pub, this._ctl);
  }

  // Review round (SCALE-8): the ledger's lifetime block count (held plus pruned) has reached the ceiling.
  _lifetimeFull() {
    const max = Number(this.config.maxLifetimeBlocks);
    if (!(max > 0)) return false;
    const covered = typeof this.dag.coveredCount === 'number' ? this.dag.coveredCount : 0;
    return this.dag.size + this.dag.orphanCount + covered >= max;
  }

  // MP-6: an exempt parent that pays less than the governing fee and is not by a vetted author (owner,
  // moderator, allow-listed; any author of an ownerless ledger pays the default fee the same way).
  _unpaidParent(b) {
    if (!this._ctl) return false;
    const e = b.e;
    if (this._genesisOwner !== null && this._vetted(e.author)) return false;
    const floor = Math.max(Number(this.config.minBits) || 0, this._ctl.policy.bits);
    return e.bits < floor;
  }

  _poolMax() {
    if (this._genesisOwner === null || !this._ctl) return Infinity;
    const p = this._ctl.policy;
    const pct = Number.isFinite(p.reservedPool) ? p.reservedPool : 25;
    return Math.floor((p.maxChainBytes * pct) / 100);
  }

  _addAuthorBytes(author, delta) {
    if (!delta) return;
    const cur = this._authorBytes.get(author) || 0;
    const next = cur + delta;
    if (next <= 0) this._authorBytes.delete(author);
    else this._authorBytes.set(author, next);
    if (this._ctl && !this._vetted(author)) this._poolUsed += delta;
  }

  _recomputePool() {
    let used = 0;
    if (this._ctl) for (const [author, n] of this._authorBytes) if (!this._vetted(author)) used += n;
    this._poolUsed = used;
  }

  _recomputeAuthorBytes() {
    this._authorBytes.clear();
    for (const b of this.dag.blocks()) {
      let n = 0;
      try {
        n = blockBytes(b);
      } catch (_) {
        n = 0;
      }
      if (n > 0) this._authorBytes.set(b.e.author, (this._authorBytes.get(b.e.author) || 0) + n);
    }
    this._recomputePool();
  }

  // Bytes of the blocks waiting in the Dag's orphan pool (entries the pool evicted are pruned);
  // `pool`: only those of authors who are not vetted.
  _orphanBytes(pool = false) {
    let total = 0;
    for (const [h, o] of this._orphanSizes) {
      if (!this.dag.hasOrphan(h)) {
        this._orphanSizes.delete(h);
        continue;
      }
      if (pool && this._vetted(o.author)) continue;
      total += o.n;
    }
    return total;
  }

  _notePrivNeed(h) {
    if (this._privNeeds.has(h)) return;
    if (this._privNeeds.size >= PRIV_NEEDS_MAX) this._privNeeds.delete(this._privNeeds.values().next().value);
    this._privNeeds.add(h);
  }

  _noteInserted(b) {
    const op = b.e.op;
    if (op.t === 'tombstone' && typeof op.h === 'string') {
      let list = this._tombIndex.get(op.h);
      if (!list) {
        list = [];
        this._tombIndex.set(op.h, list);
      }
      if (list.length < JUSTIFY_MAX) list.push(b.h);
      let all = this._tombsOf.get(op.h);
      if (!all) {
        all = new Set();
        this._tombsOf.set(op.h, all);
      }
      all.add(b.h);
    } else if (op.t === 'ban') {
      let list = this._banIndex.get(op.author);
      if (!list) {
        list = [];
        this._banIndex.set(op.author, list);
      }
      if (list.length < JUSTIFY_MAX) list.push(b.h);
    }
    let n = 0;
    try {
      n = blockBytes(b);
    } catch (_) {
      n = 0;
    }
    this._addAuthorBytes(b.e.author, n);
    if (this._identity && b.e.author === this._identity.pub) {
      if (b.e.seq > this._ownSeq) this._ownSeq = b.e.seq;
      const cur = this._ownLast;
      const d = this.dag.depth(b.h);
      const cd = cur === null || !this.dag.has(cur) ? -1 : this.dag.depth(cur);
      if (cur === null || !this.dag.has(cur) || d > cd || (d === cd && b.h < cur)) this._ownLast = b.h;
    }
  }

  // Blocks that explain why h travels without its value: tombstones of h, else bans of its author.
  _justify(h) {
    const out = [];
    for (const th of this._tombIndex.get(h) || []) {
      const t = this.dag.get(th);
      if (t) out.push(t);
    }
    if (out.length === 0) {
      const b = this.dag.get(h);
      if (b) {
        for (const bh of this._banIndex.get(b.e.author) || []) {
          const x = this.dag.get(bh);
          if (x) out.push(x);
        }
      }
    }
    return out;
  }

  _rootAllowed(b) {
    if (this._genesisOwner === null) return true;
    if (this.genesisHash !== null && b.h === this.genesisHash) {
      if (b.e.author !== this._genesisOwner) {
        // The pointer's gen= names this block: the ledger's own genesis decides who owns it.
        this._genesisOwner = b.e.author;
        this._ctlDirty = true;
        if (this.gossip) this.gossip.setOwner(b.e.author);
      }
      return true;
    }
    return b.e.author === this._genesisOwner;
  }

  _rootAllowedDry(b) {
    if (this._genesisOwner === null) return true;
    if (this.genesisHash !== null && b.h === this.genesisHash) return true;
    return b.e.author === this._genesisOwner;
  }

  // Ingress throttle (MF-75): true when the author may add one more live block now (and records it
  // when `record`). Counted by arrival time on this node; history is never counted.
  _throttleOk(b, now, record, live) {
    if (!live) return true;
    const rate = this.config.ingressRate;
    if (!rate || !(rate.n > 0) || !(rate.perMs > 0)) return true;
    const author = b.e.author;
    let list = this._throttle.get(author);
    if (list) while (list.length > 0 && list[0] <= now - rate.perMs) list.shift();
    if (list && list.length >= rate.n) return false;
    if (record) {
      if (!list) {
        list = [];
        this._throttle.set(author, list);
      }
      list.push(now);
    }
    return true;
  }

  // A block refused as E_FUTURE is not fetched again before it could be taken (code review v0.3).
  _futureRejected(h) {
    const at = this._futureRejects.get(h);
    if (at === undefined) return false;
    if (this.now() >= at) {
      this._futureRejects.delete(h);
      return false;
    }
    return true;
  }

  _rememberFuture(h, notBefore) {
    const max = this.config.rejectMemory;
    if (!(max > 0)) return;
    if (this._futureRejects.size >= max) this._futureRejects.delete(this._futureRejects.keys().next().value);
    this._futureRejects.set(h, notBefore);
  }

  /**
   * _clockVerdict(b, mode, live, now) -> null | { kind: 'defer', notBefore } | { kind: 'reject', reason, notBefore? }: the
   * claimed-time rules (see the header). Local writes carry this node's own time and are never judged here.
   */
  _clockVerdict(b, mode, live, now) {
    if (mode === 'local') return null;
    const e = b.e;
    const fut = Number(this.config.futureMs);
    if (Number.isFinite(fut) && fut >= 0 && e.ts - now > fut) {
      const notBefore = e.ts - fut;
      const max = Number(this.config.futureDeferMs) || 0;
      if (mode === 'remote' && e.ts - now <= max) return { kind: 'defer', notBefore };
      return { kind: 'reject', reason: 'E_FUTURE', notBefore };
    }
    const skew = Number(this.config.modClockMs);
    if (live && skew > 0 && MOD_CLOCK_OPS.has(e.op.t) && now - e.ts > skew) {
      this._ensureControl();
      const owner = this._ctl.owner === e.author && !this._ctl.ownerConflict;
      if (!owner && this._ctl.policy.moderators.has(e.author)) return { kind: 'reject', reason: 'E_CLOCK' };
    }
    return null;
  }

  _rememberRejection(h, code) {
    const max = this.config.rejectMemory;
    if (!(max > 0) || code === 'E_LIMIT') return; // E_LIMIT depends on the value, not only on h
    if (this._policyRejects.size >= max) this._policyRejects.delete(this._policyRejects.keys().next().value);
    this._policyRejects.set(h, code);
  }

  _reject(res, h, reason) {
    res.rejected.push({ h, reason });
    this.stats.rejected[reason] = (this.stats.rejected[reason] || 0) + 1;
  }

  // ---------------------------------------------------------------------------------------------
  // Moderator tombstone grace (MF-29)
  // ---------------------------------------------------------------------------------------------

  // -> h -> true when the value of h, hidden by state st, waits out the grace instead of being dropped.
  // Review round (HUB-2): every value hidden by moderator standing only (a moderator tombstone, a moderator bulk
  // tombstone or a moderator ban: state.modHidden) waits out the grace, so voided, a removal or an unban inside it
  // shows the content again; an owner ban or tombstone, an author's tombstone and the P0 path drop at once.
  _graceRule(st) {
    const hidden = st.modHidden instanceof Set ? st.modHidden : st.modTombstoned;
    if (!(Number(this.config.graceMs) > 0) || !(hidden instanceof Set) || hidden.size === 0) return () => false;
    let deny = null;
    return (h) => {
      if (!hidden.has(h)) return false;
      const b = this.dag.get(h);
      if (!b || b.v === undefined || !isPayloadOp(b.e.op)) return false;
      if (this._strongTombstone(h, b, st)) return false;
      if (!(st.modHidden instanceof Set) && this._bannedHidden(b, st)) return false;
      if (deny === null) deny = this._denyIndex(st);
      if (this._onP0Path(h, b, deny)) return false;
      return true;
    };
  }

  // An effective tombstone of h by its own author or with owner standing (no grace for those).
  _strongTombstone(h, target, st) {
    const list = this._tombsOf.get(h);
    if (!list) return false;
    for (const th of list) {
      const t = this.dag.get(th);
      if (!t || !(st.effective instanceof Set) || !st.effective.has(th)) continue;
      if (t.e.author === target.e.author) return true;
      if (this._genesisOwner !== null && ownerAt(this.dag, th, this._genesisOwner, this.expectedOwner) === t.e.author) return true;
    }
    return false;
  }

  _bannedHidden(b, st) {
    if (b.e.author === st.owner) return false;
    const p = st.policy;
    if (p.banUntil instanceof Map) {
      const u = p.banUntil.get(b.e.author);
      return u !== undefined && b.e.ts < u;
    }
    return p.banned instanceof Set && p.banned.has(b.e.author);
  }

  // The P0 path of R 2.8.7: _deny/<id> entries with reason 'P0' (ids, and block hashes named as ref).
  _denyIndex(st) {
    if (this._denyCache.st === st) return this._denyCache;
    const ids = new Set();
    const refs = new Set();
    if (st.kv instanceof Map) {
      for (const [k, entry] of st.kv) {
        if (typeof k !== 'string' || !k.startsWith(DENY_PREFIX)) continue;
        const v = entry && entry.v;
        if (!v || v.reason !== 'P0') continue;
        ids.add(k.slice(DENY_PREFIX.length));
        if (typeof v.ref === 'string') refs.add(v.ref);
      }
    }
    this._denyCache = { st, ids, refs };
    return this._denyCache;
  }

  _onP0Path(h, b, deny) {
    if (deny.refs.has(h)) return true;
    if (deny.ids.size === 0) return false;
    const v = b.v;
    if (!v || typeof v !== 'object') return false;
    for (const id of [v.ih, v.sha256]) if (typeof id === 'string' && deny.ids.has(denyIdOf(id))) return true;
    return false;
  }

  _expireGrace(now) {
    const ms = Number(this.config.graceMs) || 0;
    const due = [];
    for (const [h, since] of this._grace) if (now - since >= ms) due.push(h);
    if (due.length === 0) return null;
    for (const h of due) {
      this._grace.delete(h);
      if (this._redactValue(h)) this.stats.graceExpired++;
    }
    this._graceDirty = true;
    this._scheduleMeta();
    return this._exclusive(() => this._persist([], [])).catch(() => {
      this.stats.persistErrors++;
    });
  }

  /** Hashes whose value is hidden and waits out the moderator tombstone grace (tests, diagnostics). */
  graceList() {
    return Array.from(this._grace.keys());
  }

  // ---------------------------------------------------------------------------------------------
  // Ingest
  // ---------------------------------------------------------------------------------------------

  /**
   * ingest(blocks, peerId = 'local', opts) -> { added, rejected: [{ h, reason }], duplicates, orphans,
   * deferred, queued, needValue }. opts: { history?: Set<h> | h[] } (the gossip: these blocks arrive as
   * history, every other one is live), or { live: true } (every block is live; without either, a direct
   * call offers history); { wire: true } (the gossip: the blocks came off that transport peer, so their
   * signature checks are charged to its budget; direct calls by tools are not). reasons: validateBlock's ('shape', 'size', 'hash', 'pow', 'sig', 'op', 'limit',
   * 'unknown-op', 'value-hash', 'value-size'), 'root', admit's codes ('E_POLICY', 'E_NOT_OWNER',
   * 'E_NOT_MODERATOR', 'E_BANNED', 'E_LIMIT', 'E_CAP' incl. the reserved pool), 'E_RATE' (throttle),
   * 'E_BUSY' (the peer's signature-check queue is full), 'E_VERIFY', 'E_CLOSED'. queued: blocks waiting
   * for their signature check (the peer's budget was spent; tick() checks them and tells the gossip).
   */
  ingest(blocks, peerId = 'local', opts) {
    if (!Array.isArray(blocks)) return Promise.reject(new TypeError('ingest expects an array of blocks'));
    const o = opts && typeof opts === 'object' ? opts : {};
    let history = null;
    if (o.history instanceof Set) history = o.history;
    else if (Array.isArray(o.history)) history = new Set(o.history);
    const ctx = { history, live: history !== null ? true : o.live === true, liveMap: null, wire: o.wire === true };
    return this._exclusive(() => this._ingest(blocks, String(peerId), 'remote', ctx));
  }

  _exclusive(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  _isLive(h, ctx) {
    if (!ctx) return false;
    if (ctx.liveMap) return ctx.liveMap.get(h) === true;
    if (ctx.history) return !ctx.history.has(h);
    return ctx.live === true;
  }

  async _verify(blocks) {
    const opts = { minBits: 0, maxValueBytes: LIMITS.maxBlockBytes, site: this.siteId };
    const pool = this.verifierPool;
    const out = new Array(blocks.length);
    const chunk = Math.max(1, Number(this.config.verifyChunk) || 64);
    for (let i = 0; i < blocks.length; i += chunk) {
      const part = blocks.slice(i, i + chunk);
      const results = await Promise.all(part.map((b) => {
        let p;
        try {
          p = pool ? pool.verifyBlock(b, opts) : validateBlock(b, opts);
        } catch (_) {
          p = Promise.resolve({ ok: false, reason: 'E_VERIFY' });
        }
        return Promise.resolve(p).catch(() => ({ ok: false, reason: 'E_VERIFY' }));
      }));
      for (let j = 0; j < results.length; j++) out[i + j] = results[j];
    }
    this.stats.verified += blocks.length;
    return out;
  }

  async _ingest(input, peerId, mode, ctx) {
    const res = { added: [], rejected: [], duplicates: [], orphans: [], deferred: [], queued: [], needValue: [] };
    if (this._closed) {
      for (const b of input) res.rejected.push({ h: b && typeof b.h === 'string' ? b.h : null, reason: 'E_CLOSED' });
      return res;
    }
    const now = this.now();
    const fresh = [];
    const valueOnly = [];
    const shaped = [];
    for (const b of input) {
      if (looksLikeBlock(b)) shaped.push(b);
      else this._reject(res, b && typeof b.h === 'string' ? b.h : null, 'shape');
    }
    // Parents before children within the batch, otherwise the sender's (total) order.
    for (const b of topoSort(shaped)) {
      if (this.dag.has(b.h)) {
        const ours = this.dag.get(b.h);
        if (ours.v === undefined && b.v !== undefined && isPayloadOp(ours.e.op)) valueOnly.push(b);
        else res.duplicates.push(b.h);
        continue;
      }
      if (this.dag.hasOrphan(b.h) || this._deferred.has(b.h) || this.dag.isCovered(b.h) || this._vqSet.has(b.h)) {
        res.duplicates.push(b.h);
        continue;
      }
      fresh.push(b);
    }
    const inserted = [];
    const stored = new Set(); // local blocks written to the store before they entered the DAG
    if (mode === 'local') {
      for (const raw of fresh) {
        const b = plainBlock(raw);
        // Write-through for local writes (6.7, code review round 1): the store comes first, so a
        // block the store refused is not in the DAG, not relayed and not the next write's parent.
        const form = this._wouldPlace(b, now);
        if (form !== null) {
          try {
            await this.store.putMany([plainBlock(form)]);
          } catch (err) {
            this.stats.persistErrors++;
            throw err;
          }
          stored.add(b.h);
        }
        this._place(b, peerId, mode, now, res, inserted, true);
      }
      if (inserted.length > 0 && this._deferred.size > 0) await this._checked([], peerId, mode, ctx, now, res, inserted);
    } else {
      await this._checked(fresh, peerId, mode, ctx, now, res, inserted);
      if (this._closed) return res;
    }
    // Values for blocks we held without one.
    const valued = [];
    for (const b of valueOnly) {
      this._ensureControl();
      if (this._isRedacted(b.h)) {
        res.duplicates.push(b.h);
        continue;
      }
      const ours = this.dag.get(b.h);
      let ok = false;
      try {
        ok = ours.v === undefined && blockBytes({ e: ours.e, v: b.v, z: b.z }) <= LIMITS.maxBlockBytes && this.dag.attachValue(b.h, b.v, b.z);
      } catch (_) {
        ok = false;
      }
      if (ok) {
        valued.push(b.h);
        res.duplicates.push(b.h);
        this.stats.valuesRestored++;
        try {
          this._addAuthorBytes(ours.e.author, blockBytes(this.dag.get(b.h)) - blockBytes({ e: ours.e }));
        } catch (_) {
          // sizes are advisory
        }
      } else if (this.dag.get(b.h).v === undefined) {
        this._reject(res, b.h, 'value-hash');
      } else {
        res.duplicates.push(b.h);
      }
    }
    this._ensureControl(); // applies redactions of any control block added above
    this.stats.added += res.added.length;
    this.stats.duplicates += res.duplicates.length;
    // Write-through: stored before ingest()/put() resolve and before anything is announced. Rows
    // that fail stay in _unpersisted and are written again later (_persist).
    let persisted = true;
    try {
      await this._persist(stored.size > 0 ? inserted.filter((h) => !stored.has(h)) : inserted, valued);
    } catch (err) {
      persisted = false;
      this.stats.persistErrors++;
    }
    for (const h of inserted) if (this._needsValue(h)) res.needValue.push(h);
    if (res.added.length > 0 || valued.length > 0) {
      this._scheduleMeta();
      if (mode !== 'snapshot') this._notify(mode === 'local' ? 'local' : 'remote');
    }
    const announce = persisted ? res.added : res.added.filter((h) => stored.has(h));
    // STALK-8: a block written here is announced after a longer random delay than a relayed one (gossip.js).
    if (announce.length > 0 && this.gossip) this.gossip.announce(announce, { except: mode === 'remote' ? peerId : null, local: mode === 'local' });
    return res;
  }

  // The checks before the signature, the signature within the peer's budget, then the DAG (MF-75).
  // Waves: a block whose control op may open the policy ends the wave when it passes its checks, so the
  // blocks after it are judged under the state it makes (_place repeats every check after the signature,
  // so a ban or a tombstone earlier in the batch still reaches them); deferred blocks whose parents came
  // in join the next wave.
  async _checked(fresh, peerId, mode, ctx, now, res, inserted) {
    const wire = !!(ctx && ctx.wire === true);
    let todo = fresh.map((b) => ({ b, peerId, verified: false, live: this._isLive(b.h, ctx), mode, wire }));
    let rounds = 0;
    for (;;) {
      if (todo.length === 0) {
        todo = this._readyDeferred();
        if (todo.length === 0) return;
      }
      if (++rounds > 100000) return; // impossible with finite input; a guard all the same
      const pass = [];
      const later = [];
      let stop = false;
      for (const t of todo) {
        if (stop) {
          later.push(t);
          continue;
        }
        const h = t.b.h;
        if (this.dag.has(h) || this.dag.hasOrphan(h) || this.dag.isCovered(h)) {
          res.duplicates.push(h);
          continue;
        }
        const pre = t.verified ? { kind: 'verify' } : this._precheck(t.b, t.mode, t.live, now);
        if (pre.kind === 'reject') {
          this._reject(res, h, pre.reason);
          if (pre.memo === 'policy') this._rememberRejection(h, pre.reason);
          else if (pre.memo === 'cap' || pre.memo === 'pool') this._rememberCapRejection(h, pre.memo, pre.size || 0);
          else if (pre.reason === 'E_FUTURE' && pre.notBefore) this._rememberFuture(h, pre.notBefore);
          continue;
        }
        if (pre.kind === 'defer') {
          if (this._defer(t.b, t.peerId, now, false, t.live, t.wire, pre.notBefore || 0)) res.deferred.push(h);
          else this._reject(res, h, 'E_BUSY');
          continue;
        }
        pass.push(t);
        if (PERMISSIVE_OPS.has(t.b.e.op.t)) stop = true;
      }
      // Signature checks within each peer's budget; over budget, the block waits in that peer's queue.
      const check = [];
      const order = [];
      for (const t of pass) {
        if (!t.verified) {
          if (t.mode === 'remote' && t.wire && !this._takeVerifyToken(t.peerId)) {
            if (this._enqueueVerify(t)) res.queued.push(t.b.h);
            else this._reject(res, t.b.h, 'E_BUSY');
            continue;
          }
          check.push(t);
        }
        order.push(t);
      }
      const verdicts = check.length > 0 ? await this._verify(check.map((t) => t.b)) : [];
      if (this._closed) {
        for (const t of order) res.rejected.push({ h: t.b.h, reason: 'E_CLOSED' });
        return;
      }
      const okOf = new Map();
      for (let i = 0; i < check.length; i++) okOf.set(check[i], verdicts[i]);
      for (const t of order) {
        if (!t.verified) {
          const v = okOf.get(t);
          if (!v || v.ok !== true) {
            this._reject(res, t.b.h, (v && v.reason) || 'shape');
            continue;
          }
        }
        this._place(plainBlock(t.b), t.peerId, t.mode, now, res, inserted, t.live);
      }
      todo = later;
    }
  }

  // Cheap checks of a remote or snapshot block before its signature:
  // -> { kind: 'reject', reason, memo?, size? } | { kind: 'defer' } | { kind: 'verify' }
  _precheck(b, mode, live, now) {
    const shape = quickShape(b, this.siteId);
    if (shape) return { kind: 'reject', reason: shape };
    const e = b.e;
    let hHex;
    try {
      hHex = hex.encode(sha256Sync(utf8.encode(canonicalize(e))));
    } catch (_) {
      return { kind: 'reject', reason: 'shape' };
    }
    if (hHex !== b.h) return { kind: 'reject', reason: 'hash' };
    if (leadingZeroBits(hex.decode(hHex)) < e.bits) return { kind: 'reject', reason: 'pow' };
    const clock = this._clockVerdict(b, mode, live, now);
    if (clock) return clock;
    if (e.prev.length === 0 && !this._rootAllowedDry(b)) return { kind: 'reject', reason: 'root' };
    this._ensureControl();
    let size = 0;
    try {
      size = blockBytes(b);
    } catch (_) {
      return { kind: 'reject', reason: 'shape' };
    }
    let missing = false;
    for (let j = 0; j < e.prev.length; j++) {
      if (!this.dag.has(e.prev[j]) && !this.dag.isCovered(e.prev[j])) {
        missing = true;
        break;
      }
    }
    if (this._lifetimeFull()) return { kind: 'reject', reason: 'E_CAP' };
    const exempt = mode === 'snapshot' || (mode === 'remote' && this.dag.orphanSender(b.h) !== null);
    if (exempt) {
      if (mode === 'remote' && !missing && isControlOp(e.op) && e.op.t !== 'owner' && revokedAuthor(this._ctl, b, this.dag)) {
        return { kind: 'reject', reason: 'E_NOT_OWNER' };
      }
      const needed = this._privNeeds.has(b.h);
      if (mode === 'remote' && missing && !needed && this._unpaidParent(b)) return { kind: 'reject', reason: 'E_POLICY' };
      if (!needed && !this._capExempt(e.author) && this.dag.bytes + this._orphanBytes() >= this._ctl.policy.maxChainBytes) {
        return { kind: 'reject', reason: 'E_CAP' };
      }
      if (!needed && !this._vetted(e.author) && this._poolUsed + this._orphanBytes(true) + size > this._poolMax()) {
        return { kind: 'reject', reason: 'E_CAP' };
      }
      return { kind: 'verify' };
    }
    let verdict;
    try {
      verdict = admit(this._ctl, b, this._admitOptions());
    } catch (_) {
      return { kind: 'reject', reason: 'shape' };
    }
    if (!verdict.ok) {
      if (missing && mode === 'remote' && verdict.code !== 'E_CAP') return { kind: 'defer' };
      if (verdict.code === 'E_CAP') return { kind: 'reject', reason: 'E_CAP', memo: missing ? null : 'cap', size };
      return { kind: 'reject', reason: verdict.code, memo: missing ? null : 'policy' };
    }
    if (!this._vetted(e.author) && this._poolUsed + size > this._poolMax()) {
      return { kind: 'reject', reason: 'E_CAP', memo: missing ? null : 'pool', size };
    }
    if (live && !this._privileged(e.author) && !this._throttleOk(b, now, false, true)) return { kind: 'reject', reason: 'E_RATE' };
    return { kind: 'verify' };
  }

  _takeVerifyToken(peerId) {
    const rate = Number(this.config.verifyRate);
    if (!(rate > 0) || !Number.isFinite(rate)) return true;
    let bucket = this._vbuckets.get(peerId);
    if (!bucket) {
      bucket = new Bucket(rate, Math.max(1, Number(this.config.verifyBurst) || rate), this.now);
      this._vbuckets.set(peerId, bucket);
    }
    return bucket.take(1);
  }

  _queueLength(peerId) {
    const q = this._vq.get(peerId);
    return q ? q.length : 0;
  }

  _enqueueVerify(t) {
    const max = Number(this.config.verifyQueueMax) || 0;
    let q = this._vq.get(t.peerId);
    if (!q) {
      q = [];
      this._vq.set(t.peerId, q);
    }
    if (q.length >= max || this._vqSet.has(t.b.h)) return false;
    q.push({ b: t.b, live: t.live });
    this._vqSet.add(t.b.h);
    this.stats.queued++;
    return true;
  }

  // tick(): blocks that waited for their signature check, as each peer's budget allows. -> the promises.
  _drainVerifyQueues() {
    const work = [];
    for (const [peerId, q] of Array.from(this._vq)) {
      if (q.length === 0) {
        this._vq.delete(peerId);
        continue;
      }
      const bucket = this._vbuckets.get(peerId);
      const tokens = bucket ? Math.floor(bucket.available()) : q.length;
      const n = Math.min(q.length, tokens);
      if (n <= 0) continue;
      const items = q.splice(0, n);
      if (q.length === 0) this._vq.delete(peerId);
      for (const it of items) this._vqSet.delete(it.b.h);
      const blocks = items.map((it) => it.b);
      const liveMap = new Map(items.map((it) => [it.b.h, it.live === true]));
      work.push(this._exclusive(() => this._ingest(blocks, peerId, 'remote', { history: null, live: false, liveMap, wire: true })).then((res) => {
        if (this.gossip && !this._closed) this.gossip.ingested(peerId, blocks, res);
      }, () => {}));
    }
    return work;
  }

  // Dry run of _place for a local block: the form it would be added in (without its value when
  // the control state drops it), or null when it would not be added now. Records nothing.
  _wouldPlace(b, now) {
    const e = b.e;
    if (this.dag.has(b.h) || this.dag.hasOrphan(b.h)) return null;
    if (e.prev.length === 0 && !this._rootAllowed(b)) return null;
    for (let j = 0; j < e.prev.length; j++) if (!this.dag.has(e.prev[j]) && !this.dag.isCovered(e.prev[j])) return null;
    this._ensureControl();
    const verdict = admit(this._ctl, b, this._admitOptions());
    if (!verdict.ok) return null;
    if (!this._vetted(e.author) && this._poolUsed + blockBytes(b) > this._poolMax()) return null;
    if (this._lifetimeFull()) return null;
    if (!this._privileged(e.author) && !this._throttleOk(b, now, false, true)) return null;
    return verdict.dropValue && b.v !== undefined ? redact(b) : b;
  }

  // One verified block: the root rule, the control-state check at the local heads (or the
  // exemption of parents WANTed for held orphans), the pool, the ingress throttle, dedupe, dag.add.
  _place(b, peerId, mode, now, res, inserted, live) {
    const h = b.h;
    if (this.dag.has(h) || this.dag.hasOrphan(h) || this.dag.isCovered(h)) {
      res.duplicates.push(h);
      return;
    }
    const e = b.e;
    // The claimed-time rules again (a block verified before it was deferred comes here directly).
    const clock = this._clockVerdict(b, mode, live, now);
    if (clock) {
      if (clock.kind === 'defer' && this._defer(b, peerId, now, true, live, false, clock.notBefore)) {
        res.deferred.push(h);
        return;
      }
      this._reject(res, h, clock.kind === 'defer' ? 'E_BUSY' : clock.reason);
      if (clock.reason === 'E_FUTURE' && clock.notBefore) this._rememberFuture(h, clock.notBefore);
      return;
    }
    if (e.prev.length === 0 && !this._rootAllowed(b)) {
      this._reject(res, h, 'root');
      return;
    }
    this._ensureControl();
    let missing = false;
    for (let j = 0; j < e.prev.length; j++) {
      if (!this.dag.has(e.prev[j]) && !this.dag.isCovered(e.prev[j])) {
        missing = true;
        break;
      }
    }
    let size = 0;
    try {
      size = blockBytes(b);
    } catch (_) {
      this._reject(res, h, 'shape');
      return;
    }
    // Blocks WANTed as parents of held orphans skip the control-state check (6.3); a snapshot
    // is history from the host. The cap still applies to them unless a privileged (or
    // allow-listed) block waits on them, otherwise a chain of free blocks could hang below one
    // admitted orphan and grow the ledger past maxChainBytes (or the pool past its share).
    if (this._lifetimeFull()) {
      this._reject(res, h, 'E_CAP');
      return;
    }
    const exempt = mode === 'snapshot' || (mode === 'remote' && this.dag.orphanSender(h) !== null);
    let dropValue = false;
    if (exempt) {
      // A control block signed by a key that has already handed over (or is contested), outside
      // the hand-over's causal past, has no owner standing: never stored, even as a parent (code
      // review round 1). A contested hand-over itself stays admissible, so the pointer's owner can
      // decide between them (state.js).
      if (mode === 'remote' && !missing && isControlOp(e.op) && e.op.t !== 'owner' && revokedAuthor(this._ctl, b, this.dag)) {
        this._reject(res, h, 'E_NOT_OWNER');
        return;
      }
      dropValue = shouldDropValue(this._ctl, b, this.dag);
      const needed = this._privNeeds.has(h);
      // Review round (MP-6): a parent below the fee that would itself wait for parents does not make its own
      // parents exempt: one paid orphan carries at most its own (up to 8) free parents. It is asked again
      // once its parents are here (the orphan still wants it).
      if (mode === 'remote' && missing && !needed && this._unpaidParent(b)) {
        this._reject(res, h, 'E_POLICY');
        return;
      }
      // Held orphans count toward the cap here: a parent chain connects all at once.
      if (!needed && !this._capExempt(e.author) && this.dag.bytes + this._orphanBytes() >= this._ctl.policy.maxChainBytes) {
        this._reject(res, h, 'E_CAP');
        return;
      }
      if (!needed && !this._vetted(e.author) && this._poolUsed + this._orphanBytes(true) + size > this._poolMax()) {
        this._reject(res, h, 'E_CAP');
        return;
      }
    } else {
      const verdict = admit(this._ctl, b, this._admitOptions());
      if (!verdict.ok) {
        // Refused without its parents (an orphan; frames arriving out of order; a fresh node
        // without the genesis yet): the control state of its causal past is unknown here, so it
        // is set aside, verified, and judged again once its parents are in. Its parents do not
        // become exempt. Cap refusals and refusals of blocks judged with their parents are
        // final for now; only the latter are remembered (rate and cap never are).
        if (missing && mode === 'remote' && verdict.code !== 'E_CAP' && this._defer(b, peerId, now, true, live, false)) {
          res.deferred.push(h);
          return;
        }
        this._reject(res, h, verdict.code);
        if (verdict.code === 'E_CAP') {
          if (!missing) this._rememberCapRejection(h, 'cap', size);
        } else if (!missing) {
          this._rememberRejection(h, verdict.code);
        }
        return;
      }
      dropValue = verdict.dropValue;
      // The reserved pool (R 2.5.3, U-LG-3): authors who are not vetted share reservedPool percent.
      if (!this._vetted(e.author) && this._poolUsed + size > this._poolMax()) {
        this._reject(res, h, 'E_CAP');
        if (!missing) this._rememberCapRejection(h, 'pool', size);
        return;
      }
    }
    // Ingress throttle (local, per author, never part of validity, MF-75): live blocks only, by
    // arrival time; not for the owner and moderators in effect.
    if (mode !== 'snapshot' && !this._privileged(e.author) && !this._throttleOk(b, now, true, live)) {
      this._reject(res, h, 'E_RATE');
      return;
    }
    if (dropValue && b.v !== undefined) b = redact(b);
    let status;
    try {
      status = this.dag.add(b, peerId);
    } catch (_) {
      this._reject(res, h, 'shape');
      return;
    }
    if (status === 'orphan') {
      res.orphans.push(h);
      this.stats.orphans++;
      try {
        this._orphanSizes.set(h, { n: blockBytes(b), author: e.author });
      } catch (_) {
        // sizes are advisory
      }
      if (this._capExempt(e.author) || this._privNeeds.has(h)) {
        for (const p of e.prev) if (!this.dag.has(p) && !this.dag.isCovered(p)) this._notePrivNeed(p);
      }
      return;
    }
    if (status === 'duplicate') {
      res.duplicates.push(h);
      return;
    }
    for (const x of this.dag.lastAdded) {
      const blk = this.dag.get(x);
      inserted.push(x);
      res.added.push(x);
      this._privNeeds.delete(x);
      this._deferred.delete(x);
      this._orphanSizes.delete(x);
      this._noteInserted(blk);
      const op = blk.e.op;
      if (op.t === 'put' && typeof op.k === 'string' && op.k.startsWith(DENY_PREFIX)) this._ctlDirty = true; // the P0 path moved
      // A key's first payload block makes a later keyinfo from it late (state.js wrote): kept exact without a reduce.
      if (!isControlOp(op) && blk.e.prev.length > 0 && this._ctl && this._ctl.wrote instanceof Set) this._ctl.wrote.add(blk.e.author);
      if (!isControlOp(op)) continue;
      const target = op.t === 'tombstone' && typeof op.h === 'string' ? this.dag.get(op.h) : null;
      if (x === h && !exempt && op.t === 'tombstone' && target && target.e.author === blk.e.author) this._applyTombstone(blk);
      else this._ctlDirty = true;
    }
  }

  // PEER A8: the deferred pool is shared, so when it is full the peer holding the most entries loses
  // its oldest one: a Sybil group that floods the pool evicts its own entries, not everyone else's,
  // while one honest peer bootstrapping alone still has the whole pool.
  _defer(b, peerId, now, verified, live, wire, notBefore = 0) {
    const max = Number(this.config.deferMax) || 0;
    if (max <= 0) return false;
    while (this._deferred.size >= max) {
      const count = new Map();
      for (const d of this._deferred.values()) count.set(d.peerId, (count.get(d.peerId) || 0) + 1);
      let top = null;
      let most = -1;
      for (const [id, n] of count) {
        if (n > most) {
          most = n;
          top = id;
        }
      }
      let victim = null;
      for (const [h, d] of this._deferred) {
        if (d.peerId === top) {
          victim = h;
          break;
        }
      }
      if (victim === null) victim = this._deferred.keys().next().value;
      this._deferred.delete(victim);
    }
    this._deferred.set(b.h, { block: b, peerId, at: now, verified: verified === true, live: live === true, wire: wire === true, notBefore: notBefore || 0 });
    this.stats.deferred++;
    return true;
  }

  // Deferred blocks whose parents are all held now (and whose claimed time has come), taken out of the pool,
  // parents first.
  _readyDeferred() {
    if (this._deferred.size === 0) return [];
    const ready = [];
    const now = this.now();
    for (const d of this._deferred.values()) {
      if (d.notBefore > now) continue;
      let all = true;
      for (const p of d.block.e.prev) {
        if (!this.dag.has(p) && !this.dag.isCovered(p)) {
          all = false;
          break;
        }
      }
      if (all) ready.push(d);
    }
    if (ready.length === 0) return [];
    const by = new Map();
    for (const d of ready) {
      this._deferred.delete(d.block.h);
      by.set(d.block.h, d);
    }
    return topoSort(ready.map((d) => d.block)).map((b) => {
      const d = by.get(b.h);
      return { b, peerId: d.peerId, verified: d.verified, live: d.live, mode: 'remote', wire: d.wire };
    });
  }

  async _persist(insertedHashes, valuedHashes) {
    const rows = [];
    const written = new Set();
    const add = (h) => {
      if (written.has(h)) return;
      const b = this.dag.get(h);
      if (!b) return;
      written.add(h);
      rows.push(plainBlock(b));
    };
    for (const h of insertedHashes) add(h);
    for (const h of valuedHashes) add(h);
    // Blocks whose earlier write failed go with this batch (bounded per call).
    let retry = Math.max(0, Number(this.config.persistRetryMax) || 0);
    for (const h of this._unpersisted) {
      if (retry-- <= 0) break;
      if (this.dag.has(h)) add(h);
      else this._unpersisted.delete(h);
    }
    const drops = [];
    for (const h of this._pendingDrops) if (!written.has(h)) drops.push(h);
    this._pendingDrops.clear();
    try {
      if (rows.length > 0) await this.store.putMany(rows);
    } catch (err) {
      for (const h of written) this._unpersisted.add(h);
      for (const h of drops) this._pendingDrops.add(h);
      throw err;
    }
    for (const h of written) this._unpersisted.delete(h);
    for (let i = 0; i < drops.length; i++) {
      try {
        await this.store.dropValue(drops[i]);
      } catch (err) {
        for (let j = i; j < drops.length; j++) this._pendingDrops.add(drops[j]);
        throw err;
      }
    }
  }

  _scheduleMeta() {
    if (this._metaTimer !== null || this._closed) return;
    this._metaTimer = this._setTimeout(() => {
      this._metaTimer = null;
      this._writeMeta();
    }, Math.max(0, Number(this.config.metaMs) || 0));
  }

  async _writeMeta() {
    try {
      await this.store.setMeta('state', {
        n: this.dag.size,
        d: this.dag.maxDepth(),
        root: this.dag.root(),
        heads: this.dag.heads(),
        bytes: this.dag.bytes,
        covered: this.dag.coveredCount,
        savedAt: this.now(),
      });
      if (this._graceDirty) {
        const g = {};
        for (const [h, at] of this._grace) g[h] = at;
        await this.store.setMeta('grace', g);
        this._graceDirty = false;
      }
    } catch (_) {
      // meta is advisory; blocks are written through
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Checkpoints (freeze group)
  // ---------------------------------------------------------------------------------------------

  /**
   * applyCheckpoint(S, { block } = {}) -> Promise<{ dropped, h }>: prunes this copy to the checkpoint
   * whose state is S (see the header): the covered blocks, stubs included, leave memory and the store,
   * S is kept in the store, and later blocks naming covered parents are accepted. Without `block`, S
   * must match the checkpoint in effect here (state.checkpoint). With it (a copy without the covered
   * history), the block must be a valid checkpoint naming S's snap, signed by the last owner key in S,
   * which must be the pointer's owner. Error code E_SNAP otherwise; nothing changes then.
   */
  applyCheckpoint(S, { block = null } = {}) {
    if (this._closed) return Promise.reject(coded('E_CLOSED', 'the ledger is closed'));
    return this._exclusive(() => this._applyCheckpoint(S, block));
  }

  // The checkpoint in effect that this copy has not pruned to yet (reduce() carries its S), or null.
  _dueCheckpoint() {
    if (this._closed) return null;
    this._ensureControl();
    const cp = this._ctl.checkpoint;
    if (!cp || !cp.S || !this.dag.has(cp.h) || cp.snap === this._checkpointFailed) return null;
    const base = this.dag.checkpointBase();
    if (base && base.snap === cp.snap) return null;
    return cp;
  }

  // tick(): prunes to the checkpoint that came into effect. A failure is not retried for that checkpoint.
  async _autoCheckpoint() {
    const cp = this._dueCheckpoint();
    if (!cp) return null;
    try {
      return await this._applyCheckpoint(cp.S, null);
    } catch (_) {
      this._checkpointFailed = cp.snap;
      this.stats.rejected.checkpoint = (this.stats.rejected.checkpoint || 0) + 1;
      return null;
    }
  }

  async _applyCheckpoint(S, block) {
    this._ensureControl();
    let snap;
    try {
      snap = checkpointSnap(S);
    } catch (_) {
      throw coded('E_SNAP', 'the checkpoint state is not canonical JSON');
    }
    const base = this.dag.checkpointBase();
    if (base && base.snap === snap) return { dropped: 0, h: base.h };
    let cp = null;
    let anchored = false;
    const eff = this._ctl.checkpoint;
    if (eff && eff.snap === snap && this.dag.has(eff.h)) {
      cp = this.dag.get(eff.h);
    } else if (block && looksLikeBlock(block)) {
      await this._checkAnchor(block, S, snap);
      cp = plainBlock(block);
      anchored = !this.dag.has(block.h);
    } else {
      throw coded('E_SNAP', 'no checkpoint in effect here names this state');
    }
    const covered = decodeCovered(S.covered);
    const { dropped } = this.dag.pruneTo(cp, S);
    // Orphans that waited only on covered parents entered the DAG (dag.lastAdded): they are noted and stored like any
    // block that connects (code review v0.3), and so is the anchored checkpoint block with what it connects.
    const inserted = this.dag.lastAdded.slice();
    if (anchored && !this.dag.has(cp.h)) {
      let status = null;
      try {
        status = this.dag.add(cp, 'checkpoint');
      } catch (_) {
        status = null;
      }
      if (status === 'added') for (const x of this.dag.lastAdded) inserted.push(x);
    }
    for (const x of inserted) {
      const blk = this.dag.get(x);
      if (!blk) continue;
      this._noteInserted(blk);
      this._orphanSizes.delete(x);
      this._privNeeds.delete(x);
      this._deferred.delete(x);
    }
    this._afterPrune(covered); // byte counts start over from what the DAG holds now
    this._ctlDirty = true;
    this._ensureControl();
    // The depths of the covered blocks go with S, so a reopened copy keeps this copy's depths and windows.
    const meta = { h: cp.h, snap, S, depths: this.dag.coveredDepths(S) };
    try {
      await this._storeCheckpoint(meta, covered);
    } catch (_) {
      this._pendingCheckpoint = { meta, covered };
      this.stats.persistErrors++;
    }
    if (inserted.length > 0) {
      try {
        await this._persist(inserted, []);
      } catch (_) {
        this.stats.persistErrors++;
      }
    }
    this._scheduleMeta();
    this._notify('snapshot');
    if (this.gossip) {
      const connected = inserted.filter((x) => x !== cp.h);
      if (connected.length > 0) this.gossip.announce(connected, { except: null });
      this.gossip.hello();
    }
    return { dropped, h: cp.h, connected: inserted.filter((x) => x !== cp.h).length };
  }

  // A checkpoint block offered by a copy that does not hold the covered history.
  async _checkAnchor(block, S, snap) {
    const v = await validateBlock(block, { site: this.siteId, minBits: 0, maxValueBytes: LIMITS.maxBlockBytes });
    if (!v.ok) throw coded('E_SNAP', 'the checkpoint block is invalid (' + v.reason + ')');
    const op = block.e.op;
    if (!op || op.t !== 'checkpoint' || op.snap !== snap) throw coded('E_SNAP', 'the checkpoint block does not name this state');
    const keys = S && S.state && S.state.owner && Array.isArray(S.state.owner.keys) ? S.state.owner.keys : null;
    if (!keys || keys.length === 0 || this._genesisOwner === null || keys[0] !== this._genesisOwner) {
      throw coded('E_SNAP', 'the checkpoint state does not start at this ledger\'s genesis owner');
    }
    const last = keys[keys.length - 1];
    const anchor = this.expectedOwner || this._genesisOwner;
    if (block.e.author !== last || last !== anchor) throw coded('E_SNAP', 'the checkpoint is not signed by the owner this visitor trusts');
  }

  // Bookkeeping after dag.pruneTo: covered hashes leave every side table; byte counts start over.
  _afterPrune(covered) {
    const gone = (h) => covered.has(h);
    for (const h of Array.from(this._deferred.keys())) if (gone(h)) this._deferred.delete(h);
    for (const [peerId, q] of Array.from(this._vq)) {
      const kept = q.filter((it) => !gone(it.b.h));
      for (const it of q) if (gone(it.b.h)) this._vqSet.delete(it.b.h);
      if (kept.length > 0) this._vq.set(peerId, kept);
      else this._vq.delete(peerId);
    }
    for (const h of Array.from(this._grace.keys())) if (gone(h)) this._grace.delete(h);
    for (const h of Array.from(this._unpersisted)) if (gone(h)) this._unpersisted.delete(h);
    for (const h of Array.from(this._pendingDrops)) if (gone(h)) this._pendingDrops.delete(h);
    for (const h of Array.from(this._orphanSizes.keys())) if (gone(h)) this._orphanSizes.delete(h);
    for (const h of Array.from(this._privNeeds)) if (gone(h)) this._privNeeds.delete(h);
    this._graceDirty = true;
    this._recomputeAuthorBytes();
    this._policyRejects.clear();
    this._capRejects.clear();
  }

  async _storeCheckpoint(meta, covered) {
    if (typeof this.store.applyCheckpoint === 'function') {
      await this.store.applyCheckpoint(meta, Array.from(covered));
      return;
    }
    await this.store.setMeta('checkpoint', meta);
  }

  // ---------------------------------------------------------------------------------------------
  // Snapshots (S2) and export
  // ---------------------------------------------------------------------------------------------

  /**
   * Every block in total order, as stored (tombstoned and banned payloads without v); a value in its
   * moderator tombstone grace is exported without it as well (it is hidden).
   */
  exportBlocks() {
    return this.dag.order().map((b) => (this._grace.has(b.h) ? redact(b) : plainBlock(b)));
  }

  /**
   * exportSnapshot() -> exportBlocks(), preceded on a copy pruned to a checkpoint by { mw: 'checkpoint-v1', ledger,
   * checkpoint: { h, snap, S } }: without S the blocks after a checkpoint name parents nobody holds (code review v0.3).
   * importSnapshot() applies the header first; a cs= file (tools/snapshot.mjs, tools/pin.mjs) has the same form.
   */
  exportSnapshot() {
    const blocks = this.exportBlocks();
    const base = this.dag.checkpointBase();
    if (!base) return blocks;
    return [{ mw: CHECKPOINT_SNAPSHOT_KIND, ledger: this.siteId, checkpoint: { h: base.h, snap: base.snap, S: base.S } }].concat(blocks);
  }

  /**
   * importSnapshot(blocks): a ledger snapshot (cs= file, Settings import, pin.mjs). Every block is
   * verified and the root rule applies; the control-state check and the throttle are skipped
   * because a snapshot is history held by the host or by this visitor, so the result matches the
   * exporting node exactly. Stops admitting non-privileged blocks at maxChainBytes (and blocks of
   * authors who are not vetted at the reserved pool).
   * -> { added, rejected, duplicates, orphans } (counts).
   */
  async importSnapshot(blocks) {
    if (!Array.isArray(blocks)) throw new TypeError('importSnapshot expects an array of blocks');
    if (this._closed) throw coded('E_CLOSED', 'the ledger is closed');
    let shaped = 0;
    for (const b of blocks) if (looksLikeBlock(b)) shaped++;
    // A pruned ledger's export starts with its checkpoint (exportSnapshot, a recent window): S first, then the blocks
    // after it connect to the covered parents. A checkpoint this copy cannot take (not the trusted owner's, another
    // ledger's) is left out; the blocks are offered all the same.
    let header = 0;
    const head = blocks.length > 0 && isPlainObject(blocks[0]) && !looksLikeBlock(blocks[0]) ? blocks[0] : null;
    if (head && (head.mw === CHECKPOINT_SNAPSHOT_KIND || head.mw === 'recent-v1') && (head.ledger === undefined || head.ledger === null || head.ledger === this.siteId)) {
      header = 1;
      const c = isPlainObject(head.checkpoint) ? head.checkpoint : null;
      if (c && c.S && typeof c.h === 'string') {
        const block = blocks.find((b) => looksLikeBlock(b) && b.h === c.h) || (looksLikeBlock(c.block) ? c.block : null);
        try {
          await this.applyCheckpoint(c.S, { block });
        } catch (_) {
          this.stats.rejected.checkpoint = (this.stats.rejected.checkpoint || 0) + 1;
        }
      }
    }
    const ordered = topoSort(blocks);
    // Entries that are not blocks (a header aside) are rejected; repeated hashes count as duplicates.
    const total = { added: 0, rejected: blocks.length - shaped - header, duplicates: shaped - ordered.length, orphans: 0 };
    const need = [];
    const step = Math.max(1, Number(this.config.snapshotChunk) || 256);
    for (let i = 0; i < ordered.length; i += step) {
      const r = await this._exclusive(() => this._ingest(ordered.slice(i, i + step), 'snapshot', 'snapshot', { history: null, live: false, liveMap: null }));
      total.added += r.added.length;
      total.rejected += r.rejected.length;
      total.duplicates += r.duplicates.length;
      total.orphans += r.orphans.length;
      for (const h of r.needValue) need.push(h);
    }
    const stillNeed = need.filter((h) => this._needsValue(h));
    if (stillNeed.length > 0 && this.gossip) this.gossip.wantValues(stillNeed);
    if (total.added > 0) this._notify('snapshot');
    return total;
  }

  // ---------------------------------------------------------------------------------------------
  // Local writes
  // ---------------------------------------------------------------------------------------------

  // Every write: (..., { signal, onProgress, onWarning } = {}) -> Promise<Block> (see the header).
  put(k, v, opts) {
    if (v === undefined) return Promise.reject(coded('E_INVALID', 'a value is required (use del(k) to clear a key)'));
    return this._write({ t: 'put', k }, v, opts);
  }

  del(k, opts) {
    return this._write({ t: 'put', k }, null, opts);
  }

  append(l, v, opts) {
    if (v === undefined) return Promise.reject(coded('E_INVALID', 'a value is required'));
    return this._write({ t: 'append', l }, v, opts);
  }

  profile(name, opts) {
    if (typeof name !== 'string') return Promise.reject(coded('E_INVALID', 'a profile name is a string'));
    return this._write({ t: 'profile' }, name, opts);
  }

  tombstone(h, opts) {
    if (typeof h !== 'string' || !HEX64.test(h)) return Promise.reject(coded('E_INVALID', 'tombstone needs a block hash'));
    return this._write({ t: 'tombstone', h }, undefined, opts);
  }

  ban(author, opts) {
    if (typeof author !== 'string' || author.length === 0) return Promise.reject(coded('E_INVALID', 'ban needs a public key'));
    return this._write({ t: 'ban', author }, undefined, opts);
  }

  /**
   * writeControl(op, opts) -> Promise<Block> (v0.3, reconciliation of the sdk lane's request): any control op of
   * block.js CONTROL_OPS signed with this node's identity: unban, ban with until, the bulk tombstone { authors,
   * before }, allow { add, remove }, policy, keyinfo, checkpoint, ... The op is validated as every block is
   * (createBlock, then the admit rules of state.js: E_NOT_OWNER, E_NOT_MODERATOR, E_POLICY, E_LIMIT). Payload ops
   * (put, append, profile) keep their own methods.
   */
  writeControl(op, opts) {
    if (!op || typeof op !== 'object' || Array.isArray(op) || CONTROL_OPS.indexOf(op.t) < 0) {
      return Promise.reject(coded('E_INVALID', 'writeControl needs a control op: ' + CONTROL_OPS.join(', ')));
    }
    return this._write(Object.assign({}, op), undefined, opts);
  }

  /**
   * setIdentity(identity | null) -> boolean (v0.3, reconciliation of the sdk lane's request): the key new blocks are
   * signed with, changed while the node is open (sign-in, sign-out, R 2.4.1), without reopening the ledger or its
   * wires. identity is the open() shape { privateKey, pub, kind? }; null makes the node read-only (a guest). The
   * own-chain hints (the last own block for prev, the next seq) are recomputed from the DAG for the new key, so a
   * returning author keeps linking to their own last entry. A write already being signed keeps the key it started
   * with. Subscribers hear reason 'identity' (the role may have changed).
   */
  setIdentity(identity) {
    const id = localIdentity(identity || null);
    const before = this._identity ? this._identity.pub : null;
    this._identity = id;
    this._ownLast = null;
    this._ownSeq = 0;
    if (id) {
      for (const b of this.dag.blocks()) {
        if (!b || !b.e || b.e.author !== id.pub) continue;
        if (b.e.seq > this._ownSeq) this._ownSeq = b.e.seq;
        const cur = this._ownLast;
        const d = this.dag.depth(b.h);
        const cd = cur === null ? -1 : this.dag.depth(cur);
        if (cur === null || d > cd || (d === cd && b.h < cur)) this._ownLast = b.h;
      }
    }
    if ((id ? id.pub : null) !== before) this._notify('identity');
    return true;
  }

  /** prev for a new local block (S9): own last + the max-depth head + the oldest heads, at most 8. */
  choosePrev() {
    const heads = this.dag.heads({ limit: Infinity });
    if (heads.length === 0) return [];
    const out = [];
    const add = (h) => {
      if (h && this.dag.has(h) && out.indexOf(h) < 0 && out.length < LIMITS.maxPrev) out.push(h);
    };
    add(this._ownLast);
    add(heads[0]);
    for (let i = heads.length - 1; i >= 0 && out.length < LIMITS.maxPrev; i--) add(heads[i]);
    return out.sort();
  }

  _write(op, value, opts) {
    const o = writeOptions(opts);
    const run = () => this._writeNow(op, value, o);
    const result = this._writes.then(run, run);
    this._writes = result.catch(() => {});
    return result;
  }

  // MF-20 (code review v0.3): the recovery commitment an identity carrying rc writes before its first other block
  // here, or null when none is due (it has one, it has already written, the write is the keyinfo itself or a recover
  // rotation to this key, which comes first, or the ledger has no genesis yet).
  _keyinfoDue(identity, op) {
    const rc = identity && typeof identity.rc === 'string' && RC_RE.test(identity.rc) ? identity.rc : null;
    if (rc === null || !op || op.t === 'keyinfo' || this.dag.size === 0) return null;
    if (op.t === 'rotate' && op.by === 'recover' && op.next === identity.pub) return null;
    this._ensureControl();
    if (this._ctl.keyinfo instanceof Map && this._ctl.keyinfo.has(identity.pub)) return null;
    if (this._ctl.wrote instanceof Set && this._ctl.wrote.has(identity.pub)) return null;
    // The own-chain hint knows every block of this key here (a root, the genesis, is not a write before).
    const own = this._ownLast !== null ? this.dag.get(this._ownLast) : null;
    if (own && own.e.prev.length > 0) return null;
    return rc;
  }

  // Writes the commitment; a refusal (the ledger's policy, a full pool, the throttle) is not the caller's write failing.
  async _writeKeyinfo(rc, { signal = null, onProgress = null } = {}) {
    try {
      await this._writeNow({ t: 'keyinfo', rc }, undefined, { signal, onProgress, onWarning: null });
    } catch (err) {
      if (signal && signal.aborted) throw err;
    }
  }

  async _writeNow(op, value, { signal = null, onProgress = null, onWarning = null } = {}) {
    if (this._closed) throw coded('E_CLOSED', 'the ledger is closed');
    if (signal && signal.aborted) throw powAbortedError('the write was cancelled');
    const identity = this._identity;
    if (!identity || !identity.privateKey) throw coded('E_IDENTITY', 'this browser has no identity for writing');
    const rcDue = this._keyinfoDue(identity, op);
    if (rcDue !== null) await this._writeKeyinfo(rcDue, { signal, onProgress });
    this._ensureControl();
    const pub = identity.pub;
    const prev = this.choosePrev();
    if (prev.length === 0 && !(this._genesisOwner === null || pub === this._genesisOwner)) {
      throw coded('E_POLICY', 'the ledger has no genesis block yet');
    }
    const payload = isPayloadOp(op);
    let valueBytes = 0;
    if (payload) {
      try {
        valueBytes = canonicalize(value).length;
      } catch (err) {
        throw coded('E_INVALID', 'the value must be plain JSON: ' + err.message);
      }
    }
    const privileged = this._privileged(pub);
    const bits = privileged ? 0 : Math.max(Number(this.config.minBits) || 0, this._ctl.policy.bits);
    const now = this.now();
    const draft = { e: { author: pub, prev, bits, op, ts: now }, h: '', v: payload ? value : undefined };
    const verdict = admit(this._ctl, draft, this._admitOptions());
    if (!verdict.ok) throw coded(verdict.code, 'refused by the ledger policy (' + verdict.reason + ')');
    // The reserved pool, estimated before the fee is paid (the stored block is checked exactly).
    const estimate = 300 + prev.length * 67 + (payload ? valueBytes + 22 : 0);
    if (!this._vetted(pub) && this._poolUsed + estimate > this._poolMax()) {
      throw coded('E_CAP', 'the part of this ledger open to new writers is full');
    }
    if (this._lifetimeFull()) throw coded('E_CAP', 'this ledger has reached its lifetime block count; the owner starts a new ledger');
    if (!privileged && !this._throttleOk({ e: { author: pub, ts: now } }, now, false, true)) {
      throw coded('E_RATE', 'too many entries from this identity; try again in a few minutes');
    }
    const linked = linkSignals(this._abort ? this._abort.signal : null, signal);
    let block;
    try {
      block = await createBlock({
        identity,
        site: this.siteId,
        seq: this._ownSeq + 1,
        prev,
        op,
        value: payload ? value : undefined,
        ts: now,
        bits,
        miner: this.miner,
        signal: linked.signal,
        onProgress: onProgress === null ? null : (hashes) => {
          try {
            onProgress({ hashes, bits });
          } catch (_) {
            // a listener's error never stops the mining
          }
        },
        maxValueBytes: LIMITS.maxBlockBytes,
      });
    } finally {
      linked.done();
    }
    // Cancelled while it was being signed: never stored or published.
    if (signal && signal.aborted) throw powAbortedError('the write was cancelled');
    const res = await this._exclusive(() => {
      if (signal && signal.aborted) throw powAbortedError('the write was cancelled');
      return this._ingest([block], 'local', 'local', { history: null, live: true, liveMap: null });
    });
    if (res.added.indexOf(block.h) >= 0 || res.duplicates.indexOf(block.h) >= 0) {
      // A recover rotation to this key is its first block here; its commitment follows at once (MF-20).
      if (op.t === 'rotate' && op.by === 'recover' && op.next === pub && typeof identity.rc === 'string' && RC_RE.test(identity.rc)) {
        this._ensureControl();
        const has = this._ctl.keyinfo instanceof Map && this._ctl.keyinfo.has(pub);
        const wrote = this._ctl.wrote instanceof Set && this._ctl.wrote.has(pub);
        if (!has && !wrote) await this._writeKeyinfo(identity.rc, { signal, onProgress });
      }
      if (onWarning !== null) {
        // MF-24: the writer learns that the ledger (or, for a writer who is not vetted, its pool) is 80 percent full.
        const cap = this.capacity();
        if (cap.full || (!this._vetted(pub) && cap.pool.full)) {
          try {
            onWarning({ code: 'E_LEDGER_FULL', message: 'This site cannot take many more entries.', capacity: cap });
          } catch (_) {
            // a listener's error never fails a stored write
          }
        }
      }
      return block;
    }
    const rej = res.rejected[0];
    const code = rej && typeof rej.reason === 'string' && rej.reason.indexOf('E_') === 0 ? rej.reason : 'E_POLICY';
    throw coded(code, 'the entry was refused (' + (rej ? rej.reason : 'unknown') + ')');
  }

  /** The rank of a role, for callers comparing roles ('owner' > 'moderator' > 'writer' > 'reader'). */
  static roleRank(role) {
    return RANK[role] === undefined ? -1 : RANK[role];
  }
}
