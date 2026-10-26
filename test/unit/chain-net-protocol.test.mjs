// chain-net: gossip protocol mechanics and budgets (ARCHITECTURE 6.6; DESIGN-REVIEW item 5).
// An ~8 MiB bootstrap from one honest peer (two windows in flight, paged INV, frame limits),
// SYNC paging, one in-flight source per hash with the 10 s hand-over, > 50 invalid blocks or
// malformed frames ignore a peer, unsolicited (64 KiB/s) versus solicited budgets with no
// remembering of budget drops, ANN relay on first acceptance with a coalesced HELLO, the 30 s
// HELLO, and the 32-head HELLO limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Gossip, MSG, FRAME_MAX, EMPTY_DIGEST, decode, encode } from '../../src/chain/gossip.js';
import { Dag } from '../../src/chain/dag.js';
import { blockBytes } from '../../src/chain/block.js';
import { sha256Sync } from '../../src/chain/sha256-sync.js';
import { hex, utf8 } from '../../src/chain/canonical.js';
import {
  Sim, SITE, makeIdentity, makeNode, policy, append, put, mulberry32, sameLedger, allSame, NO_JITTER,
} from './chain-net-helpers.mjs';

const hashOf = (s) => hex.encode(sha256Sync(utf8.encode(String(s))));

function recorder(sim) {
  const log = [];
  sim.trace = (from, to, u8, t) => {
    const msg = decode(u8);
    log.push({ from, to, t, bytes: u8.length, type: msg ? msg.type : 0, obj: msg ? msg.obj : null });
  };
  return log;
}

/** A transport peer attached straight to a gossip: what it is sent is decoded into `sent`. */
function fakePeer(gossip, id) {
  const peer = { id, sent: [], closed: 0 };
  gossip.attach({ id, send: (u8) => peer.sent.push(decode(u8)), close: () => { peer.closed++; } });
  peer.of = (type) => peer.sent.filter((m) => m && m.type === type);
  return peer;
}

function helloFor(node, extra) {
  return encode(MSG.HELLO, Object.assign({
    v: 1, site: SITE, owner: node.gossip.owner, n: node.height, d: node.dag.maxDepth(), root: node.dag.root(), heads: node.dag.heads(),
  }, extra || {}));
}

test('bootstrap: a fresh node takes an ~8 MiB ledger (bits 0) from one honest peer without banning it', async () => {
  const sim = new Sim({ seed: 1 });
  const owner = await makeIdentity();
  const writers = [];
  for (let i = 0; i < 6; i++) writers.push(await makeIdentity());
  // v0.3: allow-listed writers (vetted), since authors who are not vetted share only the reserved
  // pool (25 percent of maxChainBytes) and this test fills the whole 8 MiB.
  const G = await policy(owner, { writers: 'allow', allow: writers.map((w) => w.pub), bits: 0, maxValueBytes: 3500 }, []);
  // Layers of 2 to 5 blocks, each naming every block of the layer below: depth windows hold
  // more than 200 blocks, so INV pages.
  const rand = mulberry32(42);
  const blocks = [G];
  let below = [G.h];
  let bytes = blockBytes(G);
  const LIMIT = 8 * 1024 * 1024 - 16384;
  for (let done = false; !done;) {
    const width = 2 + Math.floor(rand() * 4);
    const layer = [];
    for (let i = 0; i < width; i++) {
      const w = writers[Math.floor(rand() * writers.length)];
      const b = await append(w, 'gb', { text: 'x'.repeat(3200 + Math.floor(rand() * 200)) }, below.slice(0, 8));
      const n = blockBytes(b);
      if (bytes + n > LIMIT) {
        done = true;
        break;
      }
      bytes += n;
      blocks.push(b);
      layer.push(b.h);
    }
    if (layer.length > 0) below = layer;
  }
  const A = await makeNode(sim, { name: 'A', owner: owner.pub, blocks });
  const C = await makeNode(sim, { name: 'C', owner: owner.pub });
  const log = recorder(sim);
  try {
    assert.ok(A.bytes > 8 * 1024 * 1024 - 32768 && A.bytes <= 8 * 1024 * 1024, 'about 8 MiB: ' + A.bytes);
    sim.link(A, C, { latency: 40, jitter: 10 });
    let maxJobs = 0;
    const t0 = sim.t;
    const ok = await sim.run(120000, () => {
      const info = C.gossip.peerInfo('A');
      if (info && info.activeJobs > maxJobs) maxJobs = info.activeJobs;
      return sameLedger(A, C);
    });
    assert.ok(ok, 'synced; C holds ' + C.height + ' of ' + A.height);
    assert.ok(sim.t - t0 < 30000, 'within 30 s simulated: ' + (sim.t - t0));
    assert.equal(C.bytes, A.bytes);
    const info = C.gossip.peerInfo('A');
    assert.equal(info.ignored, false, 'the honest peer is not ignored');
    assert.equal(info.invalid, 0);
    assert.equal(C.gossip.stats.dropped, 0, 'no frame exceeded a budget');
    assert.deepEqual(C.stats.rejected, {});
    assert.ok(maxJobs >= 1 && maxJobs <= 2, 'at most two windows in flight: ' + maxJobs);
    for (const m of log) assert.ok(m.bytes <= FRAME_MAX, 'frame of ' + m.bytes + ' bytes');
    const wants = log.filter((m) => m.type === MSG.WANT);
    const invs = log.filter((m) => m.type === MSG.INV);
    const blockFrames = log.filter((m) => m.type === MSG.BLOCKS);
    assert.ok(wants.every((m) => m.obj.h.length <= 64));
    assert.ok(invs.every((m) => m.obj.h.length <= 200));
    assert.ok(invs.some((m) => m.obj.more === true), 'INV paged');
    assert.ok(blockFrames.some((m) => m.obj.b.length >= 3), 'BLOCKS batched up to the frame cap');
    assert.equal(C.dag.orphanCount, 0);
  } finally {
    await A.close();
    await C.close();
  }
});

/** A Dag stand-in with `windows` depth windows of one block each (Gossip only duck-types it). */
function deepDag(windowCount) {
  const hashes = Array.from({ length: windowCount }, (_, k) => hashOf('w' + k));
  return {
    size: windowCount,
    root: () => hashOf('deep root'),
    maxDepth: () => windowCount * 64 - 1,
    heads: () => [hashes[windowCount - 1]],
    windows: () => hashes.map((h, k) => ({ k, dg: hashOf('dg' + k), n: 1 })),
    hashesInWindow: (k) => (k < windowCount ? [hashes[k]] : []),
    has: (h) => hashes.indexOf(h) >= 0,
    hasOrphan: () => false,
    depth: (h) => hashes.indexOf(h) * 64,
    get: () => undefined,
    missing: () => [],
    orphanSender: () => null,
  };
}

test('SYNC lists every window, at most 128 per frame; INV answers only differing windows', async () => {
  const g = new Gossip({ site: SITE, owner: null, dag: deepDag(300), ingest: async () => ({ added: [], rejected: [] }), getBlock: () => undefined, now: () => 0, setTimeoutFn: () => null, clearTimeoutFn: () => {} });
  const peer = fakePeer(g, 'P');
  // v0.3 (MF-73): an honest HELLO has d < n, so a peer this deep holds at least d + 1 blocks.
  await g.handle('P', encode(MSG.HELLO, { v: 1, site: SITE, owner: null, n: 300 * 64 + 51, d: 300 * 64 + 50, root: hashOf('other'), heads: [hashOf('far')] }));
  const syncs = peer.of(MSG.SYNC);
  assert.equal(syncs.length, 3);
  assert.deepEqual(syncs.map((m) => m.obj.w.length), [128, 128, 45]);
  const ks = syncs.flatMap((m) => m.obj.w.map((w) => w.k));
  assert.deepEqual(ks, Array.from({ length: 301 }, (_, k) => k), 'windows 0 .. floor(max(d, peer d) / 64)');
  assert.equal(syncs[2].obj.w[44].dg, EMPTY_DIGEST, 'a window we do not hold has the empty digest');
  // As responder: windows whose digest matches are skipped, the others get an INV.
  const ours = deepDag(300).windows();
  await g.handle('P', encode(MSG.SYNC, { w: [{ k: 0, dg: ours[0].dg, n: 1 }, { k: 1, dg: hashOf('x'), n: 1 }, { k: 400, dg: hashOf('y'), n: 3 }] }));
  const invs = peer.of(MSG.INV);
  assert.deepEqual(invs.map((m) => [m.obj.k, m.obj.h.length, m.obj.more]), [[1, 1, false], [400, 0, false]]);
  g.destroy();
  assert.equal(peer.closed, 1);
});

test('one in-flight peer per hash: a silent source is replaced after 10 s', async () => {
  const sim = new Sim({ seed: 6 });
  const owner = await makeIdentity();
  const alice = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const X = await append(alice, 'gb', { text: 'x' }, [G.h]);
  const A = await makeNode(sim, { name: 'A', owner: owner.pub, blocks: [G, X] });
  const C = await makeNode(sim, { name: 'C', owner: owner.pub, blocks: [G] });
  const log = recorder(sim);
  try {
    const F = fakePeer(C.gossip, 'F');
    await C.gossip.handle('F', helloFor(A));
    await C.gossip.handle('F', encode(MSG.ANN, { h: [X.h] }));
    const t0 = sim.t;
    assert.deepEqual(F.of(MSG.WANT).map((m) => m.obj.h), [[X.h]], 'asked F');
    sim.link(A, C, { latency: 20 });
    assert.ok(await sim.run(20000, () => C.dag.has(X.h)));
    const waited = sim.t - t0;
    assert.ok(waited >= 10000 && waited < 12000, 'A was asked only after F\'s 10 s expired: ' + waited);
    const toA = log.filter((m) => m.type === MSG.WANT && m.from === 'C' && m.obj.h.indexOf(X.h) >= 0);
    assert.equal(toA.length, 1);
    assert.ok(toA[0].t - t0 >= 10000);
    assert.equal(F.of(MSG.WANT).filter((m) => m.obj.h.indexOf(X.h) >= 0).length, 1, 'F was not asked twice in a row');
  } finally {
    await A.close();
    await C.close();
  }
});

test('more than 50 invalid blocks or malformed frames: the peer is ignored for the session', async () => {
  const sim = new Sim({ seed: 12 });
  const owner = await makeIdentity();
  const alice = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const C = await makeNode(sim, { name: 'C', owner: owner.pub, blocks: [G] });
  try {
    const good = [];
    for (let i = 0; i < 52; i++) good.push(await append(alice, 'gb', { i }, [G.h]));
    const bad = good.map((b, i) => Object.assign({}, b, { s: good[(i + 1) % good.length].s })); // signatures swapped
    const orphan = await append(alice, 'gb', { o: 1 }, [hashOf('unknown parent')]);
    fakePeer(C.gossip, 'F');
    await C.gossip.handle('F', encode(MSG.HELLO, { v: 1, site: SITE, owner: owner.pub, n: 2, d: 1, root: hashOf('r'), heads: [] }));
    await C.gossip.handle('F', encode(MSG.BLOCKS, { b: [orphan] }));
    assert.equal(C.dag.orphanCount, 1);
    for (let i = 0; i < 50; i += 5) await C.gossip.handle('F', encode(MSG.BLOCKS, { b: bad.slice(i, i + 5) }));
    assert.equal(C.gossip.peerInfo('F').invalid, 50);
    assert.equal(C.gossip.peerInfo('F').ignored, false, 'exactly 50 is still tolerated');
    await C.gossip.handle('F', encode(MSG.BLOCKS, { b: [bad[50]] }));
    assert.equal(C.gossip.peerInfo('F').ignored, true);
    assert.equal(C.dag.orphanCount, 0, 'its orphans are dropped');
    assert.equal(C.peers, 0);
    const before = C.gossip.stats.ignored;
    await C.gossip.handle('F', encode(MSG.BLOCKS, { b: [good[51]] }));
    assert.equal(C.dag.has(good[51].h), false, 'even valid blocks from it are ignored');
    assert.equal(C.gossip.stats.ignored, before + 1);
    assert.equal(C.stats.rejected.sig, 51);
    // Malformed frames count the same way.
    fakePeer(C.gossip, 'M');
    for (let i = 0; i < 51; i++) await C.gossip.handle('M', new Uint8Array([MSG.ANN, 0x7b, 0x7d]));
    assert.equal(C.gossip.peerInfo('M').ignored, true);
    // An honest peer is unaffected.
    fakePeer(C.gossip, 'H');
    await C.gossip.handle('H', encode(MSG.HELLO, { v: 1, site: SITE, owner: owner.pub, n: 1, d: 0, root: C.dag.root(), heads: [G.h] }));
    await C.gossip.handle('H', encode(MSG.BLOCKS, { b: [good[51]] }));
    assert.ok(C.dag.has(good[51].h));
    assert.equal(C.peers, 1);
  } finally {
    await C.close();
  }
});

test('budgets: unsolicited frames above 64 KiB/s are dropped, solicited answers are not, and drops are not remembered', async () => {
  const sim = new Sim({ seed: 13 });
  const owner = await makeIdentity();
  // v0.3 (MF-75): pushed and announced blocks are live, and the throttle counts 30 per author per
  // 10 min by arrival, so four authors keep this test about the byte budgets alone.
  const authors = [await makeIdentity(), await makeIdentity(), await makeIdentity(), await makeIdentity()];
  const G = await policy(owner, { writers: 'open', bits: 0, maxValueBytes: 3500 }, []);
  const big = [];
  for (let i = 0; i < 40; i++) big.push(await append(authors[i % 4], 'gb', { text: String(i).padEnd(3400, '.') }, [G.h]));
  const C = await makeNode(sim, { name: 'C', owner: owner.pub, blocks: [G] });
  try {
    const F = fakePeer(C.gossip, 'F');
    await C.gossip.handle('F', encode(MSG.HELLO, { v: 1, site: SITE, owner: owner.pub, n: 41, d: 1, root: hashOf('r'), heads: [] }));
    // Solicited: F announces 20 big blocks, C asks for them, F answers in one burst (~70 KB).
    await C.gossip.handle('F', encode(MSG.ANN, { h: big.slice(0, 20).map((b) => b.h) }));
    const asked = F.of(MSG.WANT).flatMap((m) => m.obj.h);
    assert.equal(asked.length, 20);
    for (let i = 0; i < 20; i += 3) await C.gossip.handle('F', encode(MSG.BLOCKS, { b: big.slice(i, i + 3) }));
    assert.ok(big.slice(0, 20).every((b) => C.dag.has(b.h)), 'every solicited block was taken');
    assert.equal(C.gossip.stats.dropped, 0);
    // Unsolicited: 20 more big blocks nobody asked for exceed the 64 KiB burst.
    for (let i = 20; i < 40; i += 3) await C.gossip.handle('F', encode(MSG.BLOCKS, { b: big.slice(i, i + 3) }));
    const missing = big.slice(20).filter((b) => !C.dag.has(b.h));
    assert.ok(missing.length > 0, 'some unsolicited blocks were dropped');
    // v0.3 (PEER A8): a frame that does not fit the budget is dropped before it is parsed, as a whole.
    assert.ok(C.gossip.stats.dropped >= Math.ceil(missing.length / 3));
    assert.equal(C.gossip.peerInfo('F').invalid, 0, 'a budget drop is not a strike');
    assert.equal(C.gossip.peerInfo('F').ignored, false);
    // Not remembered by hash: once the budget refills, the same blocks are accepted.
    await sim.run(2000);
    for (const b of missing) await C.gossip.handle('F', encode(MSG.BLOCKS, { b: [b] }));
    assert.ok(big.every((b) => C.dag.has(b.h)));
    // Unsolicited control frames share the budget: ANN floods are cut too.
    const before = C.gossip.stats.dropped;
    for (let i = 0; i < 8; i++) {
      await C.gossip.handle('F', encode(MSG.ANN, { h: Array.from({ length: 200 }, (_, j) => hashOf('flood' + i + ':' + j)) }));
    }
    assert.ok(C.gossip.stats.dropped > before, 'an ANN flood above 64 KiB/s is dropped');
  } finally {
    await C.close();
  }
});

test('first acceptance: ANN to every other peer, one coalesced HELLO; HELLO again every 30 s', async () => {
  const sim = new Sim({ seed: 21 });
  const owner = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const A = await makeNode(sim, { name: 'A', owner: owner.pub, identity: await makeIdentity(), blocks: [G], gossipLimits: NO_JITTER });
  const B = await makeNode(sim, { name: 'B', owner: owner.pub, blocks: [G], gossipLimits: NO_JITTER });
  const C = await makeNode(sim, { name: 'C', owner: owner.pub, blocks: [G], gossipLimits: NO_JITTER });
  const log = recorder(sim);
  try {
    sim.link(A, B, { latency: 15 });
    sim.link(B, C, { latency: 15 });
    await sim.run(2000);
    const t0 = sim.t;
    const written = [];
    for (let i = 0; i < 3; i++) written.push((await A.append('gb', { i })).h);
    assert.ok(await sim.run(3000, () => allSame([A, B, C])));
    await sim.run(1000); // the coalesced HELLO leaves 250 ms after the last head change
    const fromB = log.filter((m) => m.from === 'B' && m.t >= t0);
    const annToC = fromB.filter((m) => m.type === MSG.ANN && m.to === 'C').flatMap((m) => m.obj.h);
    const annToA = fromB.filter((m) => m.type === MSG.ANN && m.to === 'A').flatMap((m) => m.obj.h);
    assert.deepEqual(annToC.slice().sort(), written.slice().sort(), 'B relays each new block to C');
    assert.deepEqual(annToA, [], 'never back to the sender');
    const hellosBtoC = fromB.filter((m) => m.type === MSG.HELLO && m.to === 'C' && m.t < t0 + 1000);
    assert.equal(hellosBtoC.length, 1, 'head changes are coalesced into one HELLO');
    assert.equal(hellosBtoC[0].obj.root, A.dag.root());
    // Idle: a HELLO per peer every 30 s.
    const t1 = sim.t;
    await sim.run(65000);
    const idle = log.filter((m) => m.type === MSG.HELLO && m.from === 'B' && m.to === 'A' && m.t > t1);
    assert.equal(idle.length, 2, 'two periodic HELLOs in 65 s');
    const gap = idle[1].t - idle[0].t;
    assert.ok(gap >= 30000 && gap <= 31000, 'every 30 s (tick granularity 1 s): ' + gap);
  } finally {
    for (const n of [A, B, C]) await n.close();
  }
});

test('HELLO carries at most 32 heads, by (depth desc, h asc), and the empty ledger is valid', async () => {
  const dag = new Dag();
  const owner = await makeIdentity();
  const alice = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  dag.add(G);
  const sent = [];
  const g = new Gossip({ site: SITE, owner: owner.pub, dag, ingest: async () => ({ added: [], rejected: [] }), getBlock: (h) => dag.get(h), now: () => 0, setTimeoutFn: () => null, clearTimeoutFn: () => {} });
  g.attach({ id: 'P', send: (u8) => sent.push(decode(u8)) });
  assert.deepEqual(sent[0].obj, { v: 1, site: SITE, owner: owner.pub, n: 1, d: 0, root: dag.root(), heads: [G.h] });
  const kids = [];
  for (let i = 0; i < 40; i++) {
    const b = await put(alice, 'k' + i, i, [G.h]);
    dag.add(b);
    kids.push(b.h);
  }
  const deeper = await put(alice, 'deep', 1, [kids[0]]);
  dag.add(deeper);
  g.hello();
  const h = sent[sent.length - 1].obj;
  assert.equal(h.heads.length, 32);
  assert.equal(h.heads[0], deeper.h, 'the deepest head first');
  const rest = kids.slice(1).sort();
  assert.deepEqual(h.heads.slice(1), rest.slice(0, 31));
  assert.equal(h.n, 42);
  assert.equal(h.d, 2);
  g.destroy();
  const empty = new Gossip({ site: SITE, owner: null, dag: new Dag(), ingest: async () => ({ added: [] }), getBlock: () => undefined, now: () => 0, setTimeoutFn: () => null, clearTimeoutFn: () => {} });
  const out = [];
  empty.attach({ id: 'Q', send: (u8) => out.push(decode(u8)) });
  assert.deepEqual(out[0].obj, { v: 1, site: SITE, owner: null, n: 0, d: -1, root: EMPTY_DIGEST, heads: [] });
  empty.destroy();
});
