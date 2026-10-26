// Unit tests for the v0.3 checkpoint (DESIGN-REVIEW 2.5.3 F1, MF-24, MF-26; U-LG-1 checkpoint row):
// on random DAGs with every freeze-group op, reduce() of the full DAG equals reduce() of a copy
// pruned to the checkpoint (dag.pruneTo) and reduceFromCheckpoint(S, later blocks), with one and
// with two checkpoints; a pruned copy accepts a late block whose prev names a covered hash; a
// wrong snap is refused (pruneTo, reduceFromCheckpoint) and has no effect in a full DAG; a
// checkpoint without owner standing has no effect; a checkpoint is transparent for a ledger that
// only grows on top of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce, snapshot, checkpointFor, reduceFromCheckpoint, checkpointSnap, decodeCovered, authorScope } from '../../src/chain/state.js';
import { Dag, pruneTo } from '../../src/chain/dag.js';
import { generateKeyPair, exportPublicKey } from '../../src/chain/crypto.js';
import { sha256Sync } from '../../src/chain/sha256-sync.js';
import { canonicalize, utf8, hex, b64url, byteLength } from '../../src/chain/canonical.js';

const SITE = 'mw1:freezecheckpointsite00000';
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const HOUR = 3600000;
const SIG = 'A'.repeat(86);

async function makeIdentity() {
  const kp = await generateKeyPair();
  return { privateKey: kp.privateKey, pub: await exportPublicKey(kp.publicKey) };
}
const [O, M, A, B, X, Y, R] = (await Promise.all(Array.from({ length: 7 }, makeIdentity))).map((k) => k.pub);
const WRITERS = [A, B, X, Y];

let serial = 0;
function blk(author, op, value, prev, { ts = T0, bits = 0 } = {}) {
  serial++;
  let full = op;
  if (op.t === 'put' || op.t === 'append' || op.t === 'profile') {
    full = Object.assign({}, op, { vh: hex.encode(sha256Sync(utf8.encode(canonicalize(value)))) });
  }
  const e = { v: 1, site: SITE, author, seq: serial, prev: Array.from(new Set(prev)).sort(), ts, bits, op: full, nonce: '' };
  const block = { e, h: hex.encode(sha256Sync(utf8.encode(canonicalize(e)))), s: SIG };
  if (value !== undefined) block.v = value;
  return block;
}
const ctl = (a, op, prev, o) => blk(a, op, undefined, prev, o);
const rcOf = (pub) => b64url.encode(sha256Sync(utf8.encode(pub)));

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(rand, list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function dagOf(blocks) {
  const dag = new Dag({ maxOrphansPerPeer: 1e6, maxOrphans: 1e6 });
  for (const b of blocks) dag.add(b);
  assert.equal(dag.orphanCount, 0, 'every parent is present');
  return dag;
}
const OPTS = { genesisOwner: O };

// The ledger's meaning (everything but the local DAG's size, depth and byte counts).
function meaning(st) {
  const snap = snapshot(st);
  delete snap.height;
  delete snap.depth;
  delete snap.bytes;
  delete snap.capReached;
  return JSON.stringify({
    snap,
    tombstoned: Array.from(st.tombstoned).sort(),
    modTombstoned: Array.from(st.modTombstoned).sort(),
    keyinfo: Array.from(st.keyinfo).sort(),
    rotations: Array.from(st.rotations).sort(),
    banUntil: Array.from(st.policy.banUntil).sort(),
    allow: Array.from(st.policy.allow).sort(),
    kvMeta: Array.from(st.kv).map(([k, e]) => [k, e.author, e.h, e.ts]),
    owner: st.owner,
  });
}

// Random blocks with every op kind, built on `pool` (blocks they may name as parents).
function grow(rand, blocks, pool, count, tsBase) {
  const payloads = blocks.filter((b) => b.v !== undefined);
  for (let i = 0; i < count; i++) {
    const lo = Math.max(0, pool.length - 14);
    const pick = () => pool[lo + Math.floor(rand() * (pool.length - lo))].h;
    const prev = rand() < 0.7 ? [pick(), pick()] : [pick()];
    const who = WRITERS[Math.floor(rand() * WRITERS.length)];
    const ts = tsBase + Math.floor(rand() * 3) * HOUR;
    const r = rand();
    let b;
    if (r < 0.32) b = blk(who, { t: 'append', l: rand() < 0.85 ? 'gb' : 'mw.s' }, 'p' + serial, prev, { ts });
    else if (r < 0.48) b = blk(who, { t: 'put', k: rand() < 0.2 ? authorScope(WRITERS[0]) + 'k' : 'k' + Math.floor(rand() * 6) }, rand() < 0.1 ? null : serial, prev, { ts });
    else if (r < 0.53) b = blk(who, { t: 'profile' }, 'name ' + (serial % 5), prev, { ts });
    else if (r < 0.6 && payloads.length) b = ctl([M, O, who][Math.floor(rand() * 3)], { t: 'tombstone', h: payloads[Math.floor(rand() * payloads.length)].h }, prev, { ts });
    else if (r < 0.65) b = ctl([M, O][Math.floor(rand() * 2)], rand() < 0.5 ? { t: 'ban', author: who, until: ts + HOUR } : { t: 'ban', author: who }, prev, { ts });
    else if (r < 0.7) b = ctl([M, O][Math.floor(rand() * 2)], { t: 'unban', author: who }, prev, { ts });
    else if (r < 0.75) b = ctl(who, { t: 'keyinfo', rc: rcOf(R) }, prev, { ts });
    else if (r < 0.8) {
      const next = WRITERS[Math.floor(rand() * WRITERS.length)];
      if (next === who) continue;
      b = rand() < 0.5 ? ctl(who, { t: 'rotate', from: who, next, by: 'self' }, prev, { ts })
        : ctl(next, { t: 'rotate', from: who, next, by: 'recover', rp: R, rsig: SIG }, prev, { ts });
    } else if (r < 0.84) b = ctl(M, { t: 'tombstone', authors: [who], before: prev[0] }, prev, { ts });
    else if (r < 0.88) b = ctl(M, { t: 'allow', add: [who] }, prev, { ts });
    else if (r < 0.92) b = ctl(O, { t: 'policy', writers: rand() < 0.7 ? 'open' : 'allow', modActionsPerHour: 2 + Math.floor(rand() * 6), voided: rand() < 0.2 ? [{ author: M, after: prev[0] }] : [] }, prev, { ts });
    else b = blk(O, { t: 'append', l: 'gb' }, 'owner ' + serial, prev, { ts });
    if (b.v !== undefined) payloads.push(b);
    blocks.push(b);
    pool.push(b);
  }
}

// An owner checkpoint over 1 to 4 random heads of `dag` (blocks not yet covered).
function makeCheckpoint(rand, blocks, dag, covered) {
  const candidates = blocks.filter((b) => !covered.has(b.h));
  const k = 1 + Math.floor(rand() * 4);
  const heads = [];
  for (let i = 0; i < k; i++) heads.push(candidates[Math.max(0, candidates.length - 1 - Math.floor(rand() * 10))].h);
  const cp = checkpointFor(dag, heads, OPTS);
  const C = ctl(O, { t: 'checkpoint', heads: cp.heads, snap: cp.snap, n: cp.n, bytes: cp.bytes }, cp.heads);
  return { cp, C };
}

test('reduce of the full DAG equals reduce of a pruned copy and reduceFromCheckpoint(S, later blocks) on random DAGs', () => {
  const rand = mulberry32(0xc4ec4);
  let rounds = 0;
  let twice = 0;
  let lateAccepted = 0;
  for (let round = 0; round < 24; round++) {
    const G = ctl(O, { t: 'policy', writers: 'open', bits: 0, moderators: [M] }, []);
    const blocks = [G];
    const pool = [G];
    grow(rand, blocks, pool, 40 + Math.floor(rand() * 30), T0);
    const first = makeCheckpoint(rand, blocks, dagOf(blocks), new Set());
    blocks.push(first.C);
    pool.push(first.C);
    grow(rand, blocks, pool, 20 + Math.floor(rand() * 20), T0 + 2 * HOUR); // later and concurrent blocks
    let last = first;
    const covered1 = decodeCovered(first.cp.S.covered);
    if (round % 2 === 1) {
      const second = makeCheckpoint(rand, blocks, dagOf(blocks), covered1);
      blocks.push(second.C);
      pool.push(second.C);
      grow(rand, blocks, pool, 15, T0 + 4 * HOUR);
      last = second;
      twice++;
    }
    const full = reduce(dagOf(shuffle(rand, blocks)), OPTS);
    assert.equal(full.checkpoint && full.checkpoint.h, last.C.h, 'round ' + round + ': the checkpoint is in effect');
    assert.ok(full.effective.has(last.C.h));
    const want = meaning(full);
    // A pruned copy (to the last checkpoint directly, and step by step).
    const pruned = dagOf(shuffle(rand, blocks));
    const { dropped } = pruneTo(pruned, last.C, last.cp.S);
    assert.equal(dropped, decodeCovered(last.cp.S.covered).size);
    assert.equal(meaning(reduce(pruned, OPTS)), want, 'round ' + round + ': pruned copy');
    if (last !== first) {
      const stepwise = dagOf(blocks);
      stepwise.pruneTo(first.C, first.cp.S);
      assert.equal(meaning(reduce(stepwise, OPTS)), want, 'round ' + round + ': pruned to the first checkpoint');
      stepwise.pruneTo(last.C, last.cp.S);
      assert.equal(meaning(reduce(stepwise, OPTS)), want, 'round ' + round + ': then to the second');
      assert.throws(() => stepwise.pruneTo(first.C, first.cp.S), (err) => err.code === 'E_SNAP', 'a checkpoint never shrinks the covered set');
    }
    const covered = decodeCovered(last.cp.S.covered);
    const after = blocks.filter((b) => !covered.has(b.h));
    assert.equal(meaning(reduceFromCheckpoint(last.cp.S, shuffle(rand, after), OPTS)), want, 'round ' + round + ': from S');
    // A late block whose prev names covered hashes: the pruned copy accepts it as if the parents were held.
    const coveredList = Array.from(covered);
    const late = blk(WRITERS[round % 4], { t: 'append', l: 'gb' }, 'late ' + round, [coveredList[Math.floor(rand() * coveredList.length)], coveredList[Math.floor(rand() * coveredList.length)]], { ts: T0 + 5 * HOUR });
    assert.equal(pruned.add(late), 'added');
    assert.ok(pruned.depth(late.h) >= 1);
    lateAccepted++;
    const fullLate = reduce(dagOf(blocks.concat([late])), OPTS);
    assert.equal(meaning(reduce(pruned, OPTS)), meaning(fullLate), 'round ' + round + ': after a late block');
    // Covered blocks are never held again.
    assert.equal(pruned.add(blocks.find((b) => covered.has(b.h))), 'duplicate');
    rounds++;
  }
  assert.ok(rounds === 24 && twice >= 10 && lateAccepted === 24);
});

test('a pruned copy keeps orphans waiting on covered parents and connects them at pruneTo', () => {
  const G = ctl(O, { t: 'policy', writers: 'open', bits: 0, moderators: [M] }, []);
  const a = blk(A, { t: 'append', l: 'gb' }, 'a', [G.h]);
  const b = blk(B, { t: 'append', l: 'gb' }, 'b', [a.h]);
  const cp = checkpointFor(dagOf([G, a, b]), [b.h], OPTS);
  const C = ctl(O, { t: 'checkpoint', heads: cp.heads, snap: cp.snap, n: cp.n, bytes: cp.bytes }, [b.h]);
  const after = blk(A, { t: 'append', l: 'gb' }, 'after', [C.h]);
  const orphanOnCovered = blk(X, { t: 'append', l: 'gb' }, 'orphan', [b.h]);
  const dag = new Dag();
  for (const x of [G, a, C, after]) dag.add(x); // b is missing here: C and after wait
  assert.equal(dag.add(orphanOnCovered), 'orphan');
  assert.equal(dag.orphanCount, 3);
  dag.pruneTo(C, cp.S);
  assert.equal(dag.orphanCount, 0, 'every orphan connected once b is covered');
  assert.ok(dag.has(C.h) && dag.has(after.h) && dag.has(orphanOnCovered.h) && !dag.has(a.h) && !dag.has(G.h));
  assert.equal(dag.isCovered(b.h), true);
  assert.equal(dag.coveredCount, 3);
  assert.deepEqual(dag.checkpointBase(), { h: C.h, snap: cp.snap, S: cp.S });
  const st = reduce(dag, OPTS);
  assert.deepEqual((st.lists.get('gb') || []).map((it) => it.v), ['a', 'b', 'orphan', 'after']);
  assert.equal(meaning(st), meaning(reduce(dagOf([G, a, b, C, after, orphanOnCovered]), OPTS)));
});

test('a wrong snap is refused by pruneTo and reduceFromCheckpoint and has no effect in a full DAG', () => {
  const G = ctl(O, { t: 'policy', writers: 'open', bits: 0, moderators: [M] }, []);
  const a = blk(A, { t: 'append', l: 'gb' }, 'a', [G.h]);
  const pre = [G, a];
  const cp = checkpointFor(dagOf(pre), [a.h], OPTS);
  assert.equal(cp.snap, checkpointSnap(cp.S));
  assert.equal(cp.bytes, byteLength(canonicalize(cp.S)));
  assert.equal(cp.n, 2);
  const forged = JSON.parse(JSON.stringify(cp.S));
  forged.state.policy.writers = 'owner';
  const C = ctl(O, { t: 'checkpoint', heads: cp.heads, snap: cp.snap, n: cp.n, bytes: cp.bytes }, [a.h]);
  const code = (err) => err.code === 'E_SNAP';
  assert.throws(() => dagOf([...pre, C]).pruneTo(C, forged), code);
  assert.throws(() => reduceFromCheckpoint(forged, [C], OPTS), code, 'no checkpoint block names this S');
  assert.throws(() => reduceFromCheckpoint(cp.S, [C], Object.assign({ snap: checkpointSnap(forged) }, OPTS)), code);
  assert.throws(() => dagOf([...pre, C]).pruneTo(ctl(O, { t: 'checkpoint', heads: ['f'.repeat(64)], snap: cp.snap, n: cp.n, bytes: cp.bytes }, [a.h]), cp.S), code, 'a head S does not cover');
  // The owner signs a snap that does not match the blocks: the checkpoint has no effect.
  const bad = ctl(O, { t: 'checkpoint', heads: cp.heads, snap: checkpointSnap(forged), n: cp.n, bytes: byteLength(canonicalize(forged)) }, [a.h]);
  const later = blk(B, { t: 'append', l: 'gb' }, 'later', [bad.h]);
  let st = reduce(dagOf([...pre, bad, later]), OPTS);
  assert.equal(st.checkpoint, null);
  assert.deepEqual((st.lists.get('gb') || []).map((it) => it.v), ['a', 'later']);
  // Wrong n or bytes: no effect either.
  for (const op of [{ n: cp.n + 1, bytes: cp.bytes }, { n: cp.n, bytes: cp.bytes + 1 }]) {
    const c2 = ctl(O, Object.assign({ t: 'checkpoint', heads: cp.heads, snap: cp.snap }, op), [a.h]);
    assert.equal(reduce(dagOf([...pre, c2]), OPTS).checkpoint, null);
  }
  // Without owner standing: no effect; a head outside the block's causal past: no effect.
  const byA = ctl(A, { t: 'checkpoint', heads: cp.heads, snap: cp.snap, n: cp.n, bytes: cp.bytes }, [a.h]);
  st = reduce(dagOf([...pre, byA]), OPTS);
  assert.equal(st.checkpoint, null);
  assert.ok(!st.effective.has(byA.h));
  const blind = ctl(O, { t: 'checkpoint', heads: cp.heads, snap: cp.snap, n: cp.n, bytes: cp.bytes }, [G.h]);
  assert.equal(reduce(dagOf([...pre, blind]), OPTS).checkpoint, null);
  // The good one takes effect and the pruned copy agrees.
  st = reduce(dagOf([...pre, C]), OPTS);
  assert.equal(st.checkpoint.h, C.h);
  assert.equal(st.checkpoint.n, 2);
  assert.deepEqual(snapshot(st).checkpoint, { h: C.h, n: 2 });
});

test('a checkpoint is transparent for a ledger that only grows on top of it', () => {
  const rand = mulberry32(0x7a4);
  for (let round = 0; round < 10; round++) {
    const G = ctl(O, { t: 'policy', writers: 'open', bits: 0, moderators: [M] }, []);
    const blocks = [G];
    let tip = [G.h];
    for (let i = 0; i < 30; i++) {
      const who = WRITERS[Math.floor(rand() * WRITERS.length)];
      const b = rand() < 0.5 ? blk(who, { t: 'append', l: 'gb' }, 'p' + i, tip)
        : rand() < 0.7 ? blk(who, { t: 'put', k: 'k' + (i % 4) }, i, tip) : blk(who, { t: 'profile' }, 'n' + i, tip);
      blocks.push(b);
      tip = rand() < 0.3 ? [tip[0], b.h] : [b.h];
    }
    const dag = dagOf(blocks);
    const heads = dag.heads({ limit: 4 });
    const cp = checkpointFor(dag, heads, OPTS);
    const C = ctl(O, { t: 'checkpoint', heads: cp.heads, snap: cp.snap, n: cp.n, bytes: cp.bytes }, cp.heads);
    blocks.push(C);
    tip = [C.h];
    for (let i = 0; i < 20; i++) {
      const who = WRITERS[Math.floor(rand() * WRITERS.length)];
      const b = rand() < 0.5 ? blk(who, { t: 'append', l: 'gb' }, 'q' + i, tip) : blk(who, { t: 'put', k: 'k' + (i % 4) }, 100 + i, tip);
      blocks.push(b);
      tip = [b.h];
    }
    const withCp = reduce(dagOf(blocks), OPTS);
    const without = reduce(dagOf(blocks), Object.assign({ checkpoints: false }, OPTS));
    assert.equal(withCp.checkpoint.h, C.h);
    assert.equal(without.checkpoint, null);
    const pick = (st) => canonicalize([snapshot(st).kv, snapshot(st).lists, snapshot(st).profiles]); // Map insertion order aside
    assert.equal(pick(withCp), pick(without), 'round ' + round);
  }
});

test('S format: { v: 1, covered (sorted 32-byte hashes, b64url), state }; 32 bytes per covered block', () => {
  const G = ctl(O, { t: 'policy', writers: 'open', bits: 0 }, []);
  const a = blk(A, { t: 'put', k: 'x' }, 1, [G.h]);
  const cp = checkpointFor(dagOf([G, a]), [a.h], OPTS);
  assert.deepEqual(Object.keys(cp.S).sort(), ['covered', 'state', 'v']);
  assert.equal(cp.S.v, 1);
  assert.equal(b64url.decode(cp.S.covered).length, 64);
  assert.deepEqual(Array.from(decodeCovered(cp.S.covered)), [G.h, a.h].sort());
  assert.deepEqual(cp.S.state.kv, [['x', { v: 1, author: A, h: a.h, ts: T0 }]]);
  assert.deepEqual(cp.S.state.owner, { keys: [O] });
  assert.throws(() => checkpointFor(dagOf([G, a]), ['f'.repeat(64)], OPTS), (err) => err.code === 'E_SNAP');
  assert.throws(() => checkpointFor(dagOf([G, a]), [a.h], { genesisOwner: null }), (err) => err.code === 'E_SNAP');
});
