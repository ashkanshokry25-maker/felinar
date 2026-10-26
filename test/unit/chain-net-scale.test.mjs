// chain-net: scale checks from the design review (DESIGN-REVIEW items 4 and 5; distributed-systems
// review section 7, tests 3 and 4). 300 heads keep HELLO small and a fresh node still syncs; a
// 5 000-block chain syncs in O(blocks / 64) frames rather than one round trip per level; a flood
// of 10 000 valid blocks into an open ledger leaves every node at or under the reserved pool (v0.3:
// authors who are not vetted share 25 percent of maxChainBytes) while owner blocks are still accepted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MSG, FRAME_MAX, decode } from '../../src/chain/gossip.js';
import { LIMITS, DEFAULT_POLICY, FREEZE_POLICY_DEFAULTS } from '../../src/chain/block.js';

const DEFAULT_POOL = FREEZE_POLICY_DEFAULTS.reservedPool;
import { Sim, makeIdentity, makeNode, policy, put, append, sameLedger } from './chain-net-helpers.mjs';

function recorder(sim) {
  const log = [];
  sim.trace = (from, to, u8, t) => {
    const msg = decode(u8);
    log.push({ from, to, t, bytes: u8.length, type: msg ? msg.type : 0, obj: msg ? msg.obj : null });
  };
  return log;
}

test('300 heads: HELLO stays far under 15 KiB and a fresh node still syncs', async () => {
  const sim = new Sim({ seed: 300 });
  const owner = await makeIdentity();
  const alice = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const blocks = [G];
  for (let i = 0; i < 300; i++) blocks.push(await put(alice, 'k' + i, i, [G.h]));
  const A = await makeNode(sim, { name: 'A', owner: owner.pub, blocks });
  const C = await makeNode(sim, { name: 'C', owner: owner.pub });
  const log = recorder(sim);
  try {
    assert.equal(A.dag.heads({ limit: Infinity }).length, 300);
    sim.link(A, C, { latency: 30 });
    assert.ok(await sim.run(30000, () => sameLedger(A, C)));
    const hellos = log.filter((m) => m.type === MSG.HELLO);
    assert.ok(hellos.length > 0);
    for (const m of hellos) {
      assert.ok(m.obj.heads.length <= 32);
      assert.ok(m.bytes < 4096, 'HELLO of ' + m.bytes + ' bytes');
    }
    for (const m of log) assert.ok(m.bytes <= FRAME_MAX);
    assert.equal(C.gossip.peerInfo('A').invalid, 0);
  } finally {
    await A.close();
    await C.close();
  }
});

test('a 5 000-block chain syncs to a fresh node in O(blocks / 64) frames, not O(depth) round trips', async () => {
  const sim = new Sim({ seed: 5000 });
  const owner = await makeIdentity();
  const alice = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const blocks = [G];
  for (let i = 1; i < 5000; i++) blocks.push(await append(alice, 'gb', i, [blocks[i - 1].h]));
  const A = await makeNode(sim, { name: 'A', owner: owner.pub, blocks });
  const C = await makeNode(sim, { name: 'C', owner: owner.pub });
  const log = recorder(sim);
  try {
    assert.equal(A.dag.maxDepth(), 4999);
    sim.link(A, C, { latency: 40 });
    const wall = Date.now();
    const t0 = sim.t;
    assert.ok(await sim.run(120000, () => sameLedger(A, C)));
    const simMs = sim.t - t0;
    const wallMs = Date.now() - wall;
    const count = (type, from) => log.filter((m) => m.type === type && m.from === from).length;
    const windows = Math.ceil(5000 / 64);
    // One round trip per level would be 5 000 x 80 ms = 400 s; windows go two at a time.
    assert.ok(simMs < 30000, 'simulated time ' + simMs + ' ms');
    assert.ok(count(MSG.SYNC, 'C') <= 2, 'SYNC frames: ' + count(MSG.SYNC, 'C'));
    assert.ok(count(MSG.INV, 'A') <= windows + 2, 'INV frames: ' + count(MSG.INV, 'A'));
    // WANTs are paced at 48 KiB/s (under the responder's 64 KiB/s unsolicited budget), so with
    // small blocks some leave as partial frames: still a constant number per window.
    assert.ok(count(MSG.WANT, 'C') <= 3 * windows, 'WANT frames: ' + count(MSG.WANT, 'C'));
    assert.ok(count(MSG.BLOCKS, 'A') <= 5 * windows, 'BLOCKS frames: ' + count(MSG.BLOCKS, 'A'));
    assert.ok(log.length <= 1000, 'frames in total: ' + log.length + ' (one round trip per level would be about 10 000)');
    assert.equal(C.dag.orphanCount, 0);
    console.log(`# 5 000-block chain: ${simMs} ms simulated, ${wallMs} ms wall, ${log.length} frames (WANT ${count(MSG.WANT, 'C')}, INV ${count(MSG.INV, 'A')}, BLOCKS ${count(MSG.BLOCKS, 'A')})`);
    assert.ok(wallMs < 60000, 'wall-clock budget');
  } finally {
    await A.close();
    await C.close();
  }
});

test('a flood of 10 000 valid blocks leaves every node at or under its reserved pool; owner blocks still get in', async () => {
  const sim = new Sim({ seed: 10000 });
  const owner = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const authors = [];
  for (let i = 0; i < 50; i++) authors.push(await makeIdentity());
  const flood = [];
  let prev = G.h;
  for (let i = 0; i < 10000; i++) {
    const b = await append(authors[i % 50], 'gb', { text: 'f'.repeat(900), i }, [prev]);
    flood.push(b);
    prev = b.h;
  }
  const A = await makeNode(sim, { name: 'A', owner: owner.pub, blocks: [G] });
  const B = await makeNode(sim, { name: 'B', owner: owner.pub, blocks: [G] });
  try {
    const cap = DEFAULT_POLICY.maxChainBytes;
    let added = 0;
    let capped = 0;
    for (let i = 0; i < flood.length; i += 500) {
      const r = await A.ingest(flood.slice(i, i + 500), 'flooder');
      added += r.added.length;
      capped += r.rejected.filter((x) => x.reason === 'E_CAP').length;
    }
    assert.ok(added > 0 && capped > 0, 'added ' + added + ', capped ' + capped);
    assert.equal(added + capped, 10000);
    const pool = A.capacity().pool;
    assert.equal(pool.max, Math.floor(cap * DEFAULT_POOL / 100));
    assert.ok(pool.bytes <= pool.max && pool.full, 'the pool is full: ' + pool.bytes + ' of ' + pool.max);
    assert.ok(A.bytes <= pool.max + 4096, 'A holds ' + A.bytes);
    assert.equal(A.snapshot().capReached, false, 'the cap itself stays free for vetted authors');
    // The other node takes what A holds and no more.
    sim.link(A, B, { latency: 30 });
    assert.ok(await sim.run(120000, () => sameLedger(A, B)));
    assert.ok(B.bytes <= pool.max + 4096);
    // The owner still writes past the cap, and it travels.
    const notice = await put(owner, '_notice', 'ledger full', A.dag.heads());
    assert.deepEqual((await A.ingest([notice], 'owner-tool')).added, [notice.h]);
    assert.ok(await sim.run(5000, () => B.dag.has(notice.h)));
    assert.equal(B.snapshot().kv._notice, 'ledger full');
  } finally {
    await A.close();
    await B.close();
  }
});

// v0.3: the refusals are the reserved pool's here (reservedPool 50, the highest a policy may set).
test('code review round 1: two nodes at a 64 KiB cap with different subsets stop re-fetching each other\'s surplus; owner blocks still travel', async () => {
  const sim = new Sim({ seed: 64 });
  const owner = await makeIdentity();
  const cap = 65536;
  const G = await policy(owner, { writers: 'open', bits: 0, maxChainBytes: cap, reservedPool: 50 }, []);
  const authors = [];
  for (let i = 0; i < 20; i++) authors.push(await makeIdentity());
  const posts = [];
  for (let i = 0; i < 200; i++) posts.push(await append(authors[i % 20], 'gb', { text: 'p'.repeat(700), i }, [G.h]));
  const A = await makeNode(sim, { name: 'A', owner: owner.pub, blocks: [G] });
  const B = await makeNode(sim, { name: 'B', owner: owner.pub, blocks: [G] });
  const log = recorder(sim);
  try {
    // A takes the posts in one order, B in the other: both stop at the cap with different subsets.
    for (let i = 0; i < posts.length; i += 20) await A.ingest(posts.slice(i, i + 20), 'flood-a');
    const reversed = posts.slice().reverse();
    for (let i = 0; i < reversed.length; i += 20) await B.ingest(reversed.slice(i, i + 20), 'flood-b');
    assert.ok(A.capacity().pool.full && B.capacity().pool.full, 'both stopped at the pool');
    const onlyA = posts.filter((p) => A.dag.has(p.h) && !B.dag.has(p.h));
    assert.ok(onlyA.length > 20, 'A holds ' + onlyA.length + ' posts B does not');
    const surplus = onlyA.reduce((n, p) => n + JSON.stringify(p).length, 0);
    sim.link(A, B, { latency: 30 });
    await sim.run(90 * 60 * 1000, () => false);
    const fromA = log.filter((m) => m.from === 'A' && m.to === 'B' && m.type === MSG.BLOCKS).reduce((n, m) => n + m.bytes, 0);
    assert.ok(fromA < 2 * surplus, 'B received ' + fromA + ' bytes of blocks from A in 90 minutes; the surplus is ' + surplus);
    assert.ok(B.bytes <= cap + LIMITS.maxBlockBytes);
    // An owner block written on A afterwards still reaches B quickly.
    const notice = await put(owner, '_notice', 'still here', A.choosePrev());
    assert.deepEqual((await A.ingest([notice], 'owner-tool')).added, [notice.h]);
    assert.ok(await sim.run(10000, () => B.dag.has(notice.h)), 'the owner block reached B within 10 s');
    assert.equal(B.snapshot().kv._notice, 'still here');
  } finally {
    await A.close();
    await B.close();
  }
});
