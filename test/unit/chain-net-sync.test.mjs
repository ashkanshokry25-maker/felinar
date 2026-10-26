// chain-net: ledger gossip between ChainNodes over in-memory links driven by a virtual clock
// (ARCHITECTURE 6.6; DESIGN-REVIEW items 1, 3, 5). Convergence after concurrent writes, under
// 30% loss with reordering, relay along a line A-B-C, a tombstoned (v-less) block reaching a
// newcomer with its tombstone, the v request for an unexplained stub, orphan backfill from the
// orphan's sender first, and detaching a peer with another (site, owner).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MSG, decode, encode } from '../../src/chain/gossip.js';
import { redact } from '../../src/chain/block.js';
import {
  Sim, SITE, T0, makeIdentity, makeNode, policy, append, put, tomb, sameLedger, allSame, NO_JITTER,
} from './chain-net-helpers.mjs';

const OPEN = { writers: 'open', bits: 0 };

async function world({ moderators = [] } = {}) {
  const owner = await makeIdentity();
  const G = await policy(owner, Object.assign({ moderators }, OPEN), []);
  return { owner, G };
}

/** Frames sent by `from` to `to`, decoded, recorded through the simulator's trace hook. */
function recorder(sim) {
  const log = [];
  sim.trace = (from, to, u8, t) => {
    const msg = decode(u8);
    if (msg) log.push({ from, to, t, type: msg.type, obj: msg.obj });
  };
  return log;
}

test('two nodes converge after concurrent writes, then relay new writes at once', async () => {
  const sim = new Sim({ seed: 11 });
  const { owner, G } = await world();
  const alice = await makeIdentity();
  const bob = await makeIdentity();
  const A = await makeNode(sim, { name: 'A', owner: owner.pub, identity: alice, blocks: [G], gossipLimits: NO_JITTER });
  const B = await makeNode(sim, { name: 'B', owner: owner.pub, identity: bob, blocks: [G], gossipLimits: NO_JITTER });
  try {
    for (let i = 0; i < 12; i++) {
      await A.append('gb', { text: 'from A ' + i });
      await B.append('gb', { text: 'from B ' + i });
    }
    await A.put('motd', 'A says hi');
    await B.put('motd', 'B says hi');
    await A.profile('Alice');
    await B.profile('Bob');
    assert.notEqual(A.dag.root(), B.dag.root());
    sim.link(A, B, { latency: 25 });
    assert.ok(await sim.run(10000, () => sameLedger(A, B)), 'converged within 10 s simulated');
    assert.equal(A.height, 1 + 2 * 14);
    const snap = A.snapshot();
    assert.equal(snap.lists.gb.length, 24);
    assert.deepEqual(Object.values(snap.profiles).sort(), ['Alice', 'Bob']);
    await sim.run(1000);
    // Each side learns the other's new root from its coalesced HELLO (250 ms after the change).
    assert.equal(A.inSyncPeers, 1);
    assert.equal(B.inSyncPeers, 1);
    // A write made after the link reaches the other side through ANN, well under a second.
    const t0 = sim.t;
    const blk = await B.append('gb', { text: 'live' });
    assert.ok(await sim.run(2000, () => A.dag.has(blk.h)));
    assert.ok(sim.t - t0 < 500, 'relayed in ' + (sim.t - t0) + ' ms');
    assert.equal(A.gossip.stats.invalid + B.gossip.stats.invalid, 0);
  } finally {
    await A.close();
    await B.close();
  }
});

test('30% loss and reordering: three nodes converge after ticks', async () => {
  const sim = new Sim({ seed: 2026 });
  const { owner, G } = await world();
  const ids = [await makeIdentity(), await makeIdentity(), await makeIdentity()];
  const nodes = [];
  for (let i = 0; i < 3; i++) nodes.push(await makeNode(sim, { name: 'N' + i, owner: owner.pub, identity: ids[i], blocks: [G] }));
  try {
    for (let r = 0; r < 8; r++) for (const n of nodes) await n.append('gb', { text: n.name + ' early ' + r });
    const opts = { latency: 40, jitter: 400, loss: 0.3 };
    sim.link(nodes[0], nodes[1], opts);
    sim.link(nodes[1], nodes[2], opts);
    sim.link(nodes[0], nodes[2], opts);
    // Writes keep coming while frames are lost and reordered.
    let written = 0;
    for (let k = 0; k < 15; k++) {
      sim.schedule(1000 + k * 1700, async () => {
        const n = nodes[k % 3];
        await n.append('gb', { text: n.name + ' live ' + k });
        written++;
      });
    }
    await sim.run(30000);
    assert.equal(written, 15);
    const ok = await sim.run(10 * 60000, () => allSame(nodes));
    assert.ok(ok, 'converged; heights ' + nodes.map((n) => n.height).join(','));
    assert.equal(nodes[0].height, 1 + 24 + 15);
    for (const n of nodes) {
      assert.equal(n.gossip.stats.invalid, 0, n.name + ' saw no invalid blocks');
      assert.equal(n.gossip.peerInfo(nodes[(nodes.indexOf(n) + 1) % 3].name).ignored, false);
    }
    assert.ok(sim.stats.lost > 20, 'frames were lost: ' + sim.stats.lost);
  } finally {
    for (const n of nodes) await n.close();
  }
});

test('line topology A-B-C: a block written on A appears on C within 2 s, and back', async () => {
  const sim = new Sim({ seed: 5 });
  const { owner, G } = await world();
  const A = await makeNode(sim, { name: 'A', owner: owner.pub, identity: await makeIdentity(), blocks: [G], gossipLimits: NO_JITTER });
  const B = await makeNode(sim, { name: 'B', owner: owner.pub, identity: await makeIdentity(), blocks: [G], gossipLimits: NO_JITTER });
  const C = await makeNode(sim, { name: 'C', owner: owner.pub, identity: await makeIdentity(), blocks: [G], gossipLimits: NO_JITTER });
  try {
    sim.link(A, B, { latency: 30, jitter: 20 });
    sim.link(B, C, { latency: 30, jitter: 20 });
    await sim.run(3000);
    assert.equal(A.gossip.hasPeer('C'), false);
    const x = await A.append('gb', { text: 'hello from A' });
    let t0 = sim.t;
    assert.ok(await sim.run(2000, () => C.dag.has(x.h)), 'C has A\'s block');
    assert.ok(sim.t - t0 <= 2000);
    const y = await C.put('reply', 'hello from C');
    t0 = sim.t;
    assert.ok(await sim.run(2000, () => A.dag.has(y.h)), 'A has C\'s block');
    assert.ok(sim.t - t0 <= 2000);
    assert.ok(await sim.run(2000, () => allSame([A, B, C])));
    assert.equal(A.snapshot().kv.reply, 'hello from C');
  } finally {
    for (const n of [A, B, C]) await n.close();
  }
});

test('a tombstoned (v-less) block reaches a newcomer together with its tombstone', async () => {
  const sim = new Sim({ seed: 3 });
  const mod = await makeIdentity();
  const { owner, G } = await world({ moderators: [mod.pub] });
  const alice = await makeIdentity();
  // 50 blocks: genesis, 48 posts, one moderator tombstone of post 10.
  const blocks = [G];
  let last = G.h;
  const posts = [];
  for (let i = 0; i < 48; i++) {
    const b = await append(alice, 'gb', { text: 'post ' + i }, [last]);
    blocks.push(b);
    posts.push(b);
    last = b.h;
  }
  const T = await tomb(mod, posts[10].h, [last]);
  blocks.push(T);
  const A = await makeNode(sim, { name: 'A', owner: owner.pub, blocks });
  const C = await makeNode(sim, { name: 'C', owner: owner.pub });
  const log = recorder(sim);
  try {
    assert.equal(A.height, 50);
    // v0.3 (MF-29): a moderator tombstone hides the value at once; A keeps it for the 24 h grace
    // but never relays it: the stub travels with the tombstone, as for a dropped value.
    assert.notEqual(A.dag.get(posts[10].h).v, undefined, 'A keeps the value during the grace');
    assert.deepEqual(A.graceList(), [posts[10].h]);
    assert.equal(A.snapshot().lists.gb.length, 47, 'and hides it');
    assert.equal(A.exportBlocks().find((b) => b.h === posts[10].h).v, undefined, 'never exported');
    sim.link(A, C, { latency: 20 });
    assert.ok(await sim.run(20000, () => C.dag.root() === A.dag.root() && C.snapshot().lists.gb && C.snapshot().lists.gb.length === 47), 'same blocks and the same posts shown');
    assert.equal(C.dag.get(posts[10].h).v, undefined, 'C never received the hidden value');
    assert.ok(C.state.tombstoned.has(posts[10].h));
    assert.equal(C.snapshot().lists.gb.length, 47);
    const vWants = log.filter((m) => m.type === MSG.WANT && m.obj.v === true);
    assert.equal(vWants.length, 0, 'the stub came with its justification, so no value was requested');
    // A relays the stub only together with the tombstone.
    const blocksFrames = log.filter((m) => m.type === MSG.BLOCKS && m.from === 'A');
    const carried = blocksFrames.flatMap((m) => m.obj.b.map((b) => b.h));
    assert.ok(carried.indexOf(posts[10].h) >= 0 && carried.indexOf(T.h) >= 0);
    assert.equal(JSON.stringify(blocksFrames.map((m) => m.obj)).includes('post 10'), false, 'the hidden value never left A');
    // After the grace A deletes it (memory and store) and both report the same state again.
    sim.t += 86400000;
    A.tick();
    await sim.run(2000);
    assert.equal(A.dag.get(posts[10].h).v, undefined);
    assert.equal((await A.store.getAll()).find((b) => b.h === posts[10].h).v, undefined, 'and in its store');
    assert.ok(sameLedger(A, C));
  } finally {
    await A.close();
    await C.close();
  }
});

test('an unexplained stub makes the node ask WANT { h, v: true }, and the value is restored', async () => {
  const sim = new Sim({ seed: 9 });
  const { owner, G } = await world();
  const alice = await makeIdentity();
  const p1 = await append(alice, 'gb', { text: 'one' }, [G.h]);
  const p2 = await append(alice, 'gb', { text: 'two' }, [p1.h]);
  const A = await makeNode(sim, { name: 'A', owner: owner.pub, blocks: [G, p1, p2] });
  const D = await makeNode(sim, { name: 'D', owner: owner.pub, blocks: [G, p1] });
  const sent = [];
  // A forged relay: a peer that offers p2 without its value and without any tombstone.
  D.gossip.attach({ id: 'F', send: (u8) => sent.push(decode(u8)) });
  try {
    await D.gossip.handle('F', encode(MSG.HELLO, { v: 1, site: SITE, owner: owner.pub, n: 3, d: 2, root: A.dag.root(), heads: [p2.h] }));
    await D.gossip.handle('F', encode(MSG.BLOCKS, { b: [redact(p2)] }));
    assert.ok(D.dag.has(p2.h), 'the stub is a valid DAG node');
    assert.equal(D.dag.get(p2.h).v, undefined);
    await sim.run(500);
    assert.equal(sent.filter((m) => m && m.type === MSG.WANT && m.obj.v === true).length, 0, 'a grace period for a justification still on its way');
    await sim.run(2500);
    const vWant = sent.filter((m) => m && m.type === MSG.WANT && m.obj.v === true);
    assert.equal(vWant.length, 1, 'asked for the value');
    assert.deepEqual(vWant[0].obj.h, [p2.h]);
    // A real peer that holds the value answers, and D restores it.
    sim.link(A, D, { latency: 10 });
    assert.ok(await sim.run(15000, () => D.dag.get(p2.h).v !== undefined), 'value restored');
    assert.equal(D.snapshot().lists.gb.length, 2);
    assert.equal((await D.store.getAll()).find((b) => b.h === p2.h).v.text, 'two', 'and persisted');
    // A stub whose prev was altered no longer matches its hash: invalid, counted against F.
    const forged = redact(p2);
    forged.e = Object.assign({}, forged.e, { prev: [G.h] });
    const before = D.gossip.peerInfo('F').invalid;
    await D.gossip.handle('F', encode(MSG.BLOCKS, { b: [Object.assign({}, forged, { h: forged.h })] }));
    assert.equal(D.gossip.peerInfo('F').invalid, before, 'same h as a held block: a duplicate, not stored again');
    const fresh = await append(alice, 'gb', { text: 'three' }, [p2.h]);
    const altered = redact(fresh);
    altered.e = Object.assign({}, altered.e, { prev: [G.h] });
    await D.gossip.handle('F', encode(MSG.BLOCKS, { b: [altered] }));
    assert.equal(D.gossip.peerInfo('F').invalid, before + 1, 'altered prev fails h');
    assert.equal(D.dag.has(fresh.h), false);
    assert.equal(D.stats.rejected.hash, 1);
  } finally {
    await A.close();
    await D.close();
  }
});

test('orphan backfill: missing parents are WANTed from the orphan\'s sender first', async () => {
  const sim = new Sim({ seed: 4 });
  const { owner, G } = await world();
  const alice = await makeIdentity();
  const chain = [G];
  for (let i = 0; i < 20; i++) chain.push(await put(alice, 'k' + i, i, [chain[chain.length - 1].h]));
  // C holds the first 19 levels; A and D hold all 21 blocks.
  const C = await makeNode(sim, { name: 'C', owner: owner.pub, blocks: chain.slice(0, 19) });
  const A = await makeNode(sim, { name: 'A', owner: owner.pub, blocks: chain });
  const D = await makeNode(sim, { name: 'D', owner: owner.pub, blocks: chain });
  const log = recorder(sim);
  try {
    sim.link(C, A, { latency: 20 });
    sim.link(C, D, { latency: 60 });
    assert.ok(await sim.run(10000, () => allSame([A, C, D])));
    // C learned the tip first from A's HELLO (fast path, two levels above its depth), held it
    // as an orphan and asked A, its sender, for the missing parent.
    const tip = chain[20].h;
    const parent = chain[19].h;
    const wantsTip = log.filter((m) => m.type === MSG.WANT && m.from === 'C' && m.obj.h.indexOf(tip) >= 0);
    const wantsParent = log.filter((m) => m.type === MSG.WANT && m.from === 'C' && m.obj.h.indexOf(parent) >= 0);
    assert.equal(wantsTip[0].to, 'A');
    assert.ok(wantsParent.length >= 1);
    assert.equal(wantsParent[0].to, 'A', 'the orphan\'s sender is asked first');
    assert.ok(wantsParent[0].t > wantsTip[0].t);
    assert.equal(C.dag.orphanCount, 0);
    assert.equal(C.snapshot().kv.k19, 19);
  } finally {
    for (const n of [A, C, D]) await n.close();
  }
});

test('a peer with another (site, owner) or protocol version is detached', async () => {
  const sim = new Sim({ seed: 8 });
  const w1 = await world();
  const w2 = await world();
  const A = await makeNode(sim, { name: 'A', owner: w1.owner.pub, blocks: [w1.G] });
  const B = await makeNode(sim, { name: 'B', owner: w2.owner.pub, blocks: [w2.G] });
  const C = await makeNode(sim, { name: 'C', owner: w1.owner.pub, siteId: SITE + 'x' });
  try {
    sim.link(A, B, { latency: 10 });
    sim.link(A, C, { latency: 10 });
    await sim.run(500);
    assert.equal(A.gossip.hasPeer('B'), false);
    assert.equal(B.gossip.hasPeer('A'), false);
    assert.equal(A.gossip.hasPeer('C'), false);
    assert.equal(C.gossip.hasPeer('A'), false);
    assert.equal(A.peers, 0);
    assert.ok(A.gossip.stats.mismatch >= 2);
    assert.equal(B.height, 1);
    assert.ok(!B.dag.has(w1.G.h));
    // A future protocol version is detached too.
    let closed = 0;
    A.gossip.attach({ id: 'V2', send: () => {}, close: () => { closed++; } });
    await A.gossip.handle('V2', encode(MSG.HELLO, { v: 2, site: SITE, owner: w1.owner.pub, n: 0, d: -1, root: A.dag.root(), heads: [] }));
    assert.equal(A.gossip.hasPeer('V2'), false);
    assert.equal(closed, 1, 'the transport is told');
  } finally {
    for (const n of [A, B, C]) await n.close();
  }
});
