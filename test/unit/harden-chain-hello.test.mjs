// harden-chain-hello: v0.2.1 works-today blockers in the chain transport (V03-DESIGN-REVIEW 1.1 item 7, 2.16.4,
// MF-73, MF-74 gossip part, U-HD-1). One HELLO with an absurd depth used to freeze a tab (PEER A1: d = 2e10 took
// 34 s and 290 MB in a scratch run); HELLO bounds now make it a strike that returns at once. Every numeric field
// of every mw_chain1 frame is swept with 0, -1 and 2^53-1. One remote peer id on many wires is capped at the
// gossip level; ignored and silent wires are handed to the loader to close; frames over budget are dropped
// before they are parsed (PEER A8); one peer's announcements hold at most 256 wants (PEER A6); sync sessions
// that bring nothing end after 3 s and a proven peer pre-empts an unproven one (PEER A7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  Gossip, MSG, FRAME_MAX, encode, decode, helloBoundsOk, MAX_LEDGER_BLOCKS, MAX_WINDOWS, MIN_BLOCK_BYTES, DEFAULT_LIMITS,
} from '../../src/chain/gossip.js';
import { attachToTorrent, wireCounts, handlerFor } from '../../src/chain/wire-ext.js';
import { Dag } from '../../src/chain/dag.js';
import { createBlock } from '../../src/chain/block.js';
import { sha256Sync } from '../../src/chain/sha256-sync.js';
import { hex, utf8 } from '../../src/chain/canonical.js';
import { Sim, SITE, T0, makeIdentity, makeNode, policy, append, rawPeer } from './chain-net-helpers.mjs';

const MAX = Number.MAX_SAFE_INTEGER;
const hashOf = (s) => hex.encode(sha256Sync(utf8.encode(String(s))));
const frameOf = (type, obj) => {
  const body = utf8.encode(JSON.stringify(obj));
  const out = new Uint8Array(body.length + 1);
  out[0] = type;
  out.set(body, 1);
  return out;
};

async function world() {
  const owner = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  return { owner, G };
}

function helloOf(node, extra) {
  return Object.assign({ v: 1, site: SITE, owner: node.gossip.owner, n: 5, d: 3, root: hashOf('their root'), heads: [hashOf('their head')] }, extra || {});
}

test('constants: the HELLO bound is the 64 MiB ceiling over the smallest valid block (measured: 187 bytes)', () => {
  assert.equal(MIN_BLOCK_BYTES, 187);
  assert.equal(MAX_LEDGER_BLOCKS, Math.floor(67108864 / 187));
  assert.equal(MAX_WINDOWS, Math.ceil(MAX_LEDGER_BLOCKS / 64));
  assert.equal(DEFAULT_LIMITS.maxPeersPerGroup, 4);
  // -1 <= d < n + c, and n + c <= MAX_LEDGER_BLOCKS
  assert.equal(helloBoundsOk({ n: 0, d: -1 }), true, 'the empty ledger');
  assert.equal(helloBoundsOk({ n: 0, d: 0 }), false);
  assert.equal(helloBoundsOk({ n: 10, d: 9 }), true);
  assert.equal(helloBoundsOk({ n: 10, d: 10 }), false, 'an honest node never has d >= n');
  assert.equal(helloBoundsOk({ n: 10, c: 990, d: 999 }), true, 'a pruned copy counts the blocks its checkpoint covers');
  assert.equal(helloBoundsOk({ n: 10, c: 990, d: 1000 }), false);
  assert.equal(helloBoundsOk({ n: MAX_LEDGER_BLOCKS, d: MAX_LEDGER_BLOCKS - 1 }), true);
  assert.equal(helloBoundsOk({ n: MAX_LEDGER_BLOCKS + 1, d: 0 }), false);
  assert.equal(helloBoundsOk({ n: MAX_LEDGER_BLOCKS, c: 1, d: 0 }), false);
  assert.equal(helloBoundsOk({ n: 5, d: -2 }), false);
  assert.equal(helloBoundsOk({ n: 5, d: 1.5 }), false);
});

test('U-HD-1: a HELLO with d = Number.MAX_SAFE_INTEGER is a strike that returns in bounded time and memory', async () => {
  const sim = new Sim({ seed: 1 });
  const { owner, G } = await world();
  const C = await makeNode(sim, { name: 'C', owner: owner.pub, blocks: [G] });
  try {
    const F = rawPeer(C.gossip, 'F', { decode });
    const before = F.frames.length;
    const heap0 = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    await C.gossip.handle('F', frameOf(MSG.HELLO, helloOf(C, { n: 5, d: MAX })));
    await C.gossip.handle('F', frameOf(MSG.HELLO, helloOf(C, { n: MAX, d: MAX - 1 })));
    await C.gossip.handle('F', frameOf(MSG.HELLO, helloOf(C, { n: 20000000000, d: 19999999999 })));
    const ms = performance.now() - t0;
    const grew = process.memoryUsage().heapUsed - heap0;
    // Code review v0.3 (round 2): generous sanity bounds, so a loaded runner does not fail them; the frame count and the
    // strikes below are the exact checks. The v0.2.1 code took 34 s and gigabytes for d = 2e10.
    assert.ok(ms < 2000, 'three hostile HELLOs took ' + ms.toFixed(1) + ' ms (the v0.2.1 code took 34 s for d = 2e10)');
    assert.ok(grew < 64 * 1024 * 1024, 'heap grew by ' + grew + ' bytes');
    assert.equal(F.frames.length, before, 'no SYNC (no frame at all) went out');
    const info = C.gossip.peerInfo('F');
    assert.equal(info.invalid, 3, 'each is a malformed frame: a strike');
    assert.equal(info.syncing, false);
    assert.equal(info.hello, null);
    assert.equal(decode(frameOf(MSG.HELLO, helloOf(C, { n: 5, d: MAX }))), null);
  } finally {
    await C.close();
  }
});

test('the largest legal HELLO costs a few SYNC frames: 256 windows beyond our own depth per session', async () => {
  const sim = new Sim({ seed: 2 });
  const { owner, G } = await world();
  const C = await makeNode(sim, { name: 'C', owner: owner.pub, blocks: [G] });
  try {
    const F = rawPeer(C.gossip, 'F', { decode });
    const heap0 = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    await C.gossip.handle('F', encode(MSG.HELLO, helloOf(C, { n: MAX_LEDGER_BLOCKS, d: MAX_LEDGER_BLOCKS - 1 })));
    const ms = performance.now() - t0;
    const syncs = F.of(MSG.SYNC);
    const windows = syncs.reduce((n, m) => n + m.obj.w.length, 0);
    assert.equal(windows, 257, 'windows 0 .. our last (0) + 256');
    assert.equal(syncs.length, 3);
    assert.ok(syncs.every((m) => m.obj.w.every((w) => w.k < MAX_WINDOWS)));
    const bytes = F.frames.reduce((n, f) => n + f.length, 0);
    assert.ok(bytes < 40000, bytes + ' bytes out');
    for (const f of F.frames) assert.ok(f.length <= FRAME_MAX);
    assert.ok(ms < 5000, 'took ' + ms.toFixed(1) + ' ms'); // a sanity bound; the window and frame counts above are exact
    assert.ok(process.memoryUsage().heapUsed - heap0 < 256 * 1024 * 1024);
    assert.equal(C.gossip.peerInfo('F').invalid, 0, 'legal, so no strike');
  } finally {
    await C.close();
  }
});

test('a peer deeper than the lookahead is still synced in full, over several sessions', async () => {
  const sim = new Sim({ seed: 12 });
  const { owner, G } = await world();
  const alice = await makeIdentity();
  const blocks = [G];
  let prev = G.h;
  for (let i = 1; i < 1500; i++) {
    const b = await append(alice, 'gb', { i }, [prev]);
    blocks.push(b);
    prev = b.h;
  }
  const A = await makeNode(sim, { name: 'A', owner: owner.pub, blocks });
  const C = await makeNode(sim, { name: 'C', owner: owner.pub, gossipLimits: { syncLookahead: 4 } });
  try {
    sim.link(A, C, { latency: 30 });
    assert.ok(await sim.run(120000, () => C.dag.size === A.dag.size), 'C has all ' + A.dag.size + ' blocks (it has ' + C.dag.size + ')');
    assert.ok(C.gossip.stats.syncs >= 2, 'more than one session: ' + C.gossip.stats.syncs);
  } finally {
    await A.close();
    await C.close();
  }
});

test('every numeric field of every mw_chain1 frame at 0, -1 and 2^53-1: never a throw, never a stall', async () => {
  const sim = new Sim({ seed: 3 });
  const { owner, G } = await world();
  const alice = await makeIdentity();
  const C = await makeNode(sim, { name: 'C', owner: owner.pub, blocks: [G] });
  const values = [0, -1, MAX];
  // [label, type, build(x) -> frame object, expected(x) -> 'ok' | 'bad']
  const fields = [
    ['HELLO.v', MSG.HELLO, (x) => helloOf(C, { v: x }), (x) => (x >= 0 ? 'ok' : 'bad')],
    ['HELLO.n', MSG.HELLO, (x) => helloOf(C, { n: x, d: -1 }), (x) => (x >= 0 && x <= MAX_LEDGER_BLOCKS ? 'ok' : 'bad')],
    ['HELLO.d', MSG.HELLO, (x) => helloOf(C, { n: 5, d: x }), (x) => (x >= -1 && x < 5 ? 'ok' : 'bad')],
    ['HELLO.c', MSG.HELLO, (x) => helloOf(C, { n: 5, d: 4, c: x }), (x) => (x >= 0 && x + 5 <= MAX_LEDGER_BLOCKS ? 'ok' : 'bad')],
    ['SYNC.w.k', MSG.SYNC, (x) => ({ w: [{ k: x, dg: hashOf('dg'), n: 1 }] }), (x) => (x >= 0 && x < MAX_WINDOWS ? 'ok' : 'bad')],
    ['SYNC.w.n', MSG.SYNC, (x) => ({ w: [{ k: 0, dg: hashOf('dg'), n: x }] }), (x) => (x >= 0 && x <= MAX_LEDGER_BLOCKS ? 'ok' : 'bad')],
    ['INV.k', MSG.INV, (x) => ({ k: x, h: [hashOf('i')], more: false }), (x) => (x >= 0 && x < MAX_WINDOWS ? 'ok' : 'bad')],
  ];
  try {
    let n = 0;
    for (const [label, type, build, expected] of fields) {
      for (const x of values) {
        const frame = frameOf(type, build(x));
        const want = expected(x);
        assert.equal(decode(frame) === null ? 'bad' : 'ok', want, label + ' = ' + x);
        const id = 'P' + (n++);
        const peer = rawPeer(C.gossip, id, { decode });
        if (type !== MSG.HELLO) await C.gossip.handle(id, encode(MSG.HELLO, helloOf(C, { root: C.dag.root(), heads: [G.h], n: 1, d: 0 })));
        const t0 = performance.now();
        await C.gossip.handle(id, frame);
        const ms = performance.now() - t0;
        assert.ok(ms < 2000, label + ' = ' + x + ' took ' + ms.toFixed(1) + ' ms'); // a sanity bound; the frame count is exact
        assert.ok(peer.frames.length <= 1 + Math.ceil(MAX_WINDOWS / 128) + 2, label + ' = ' + x + ': ' + peer.frames.length + ' frames out');
        const info = C.gossip.peerInfo(id);
        if (want === 'bad') assert.equal(info.invalid, 1, label + ' = ' + x + ' is a strike');
        else if (info) assert.equal(info.invalid, 0, label + ' = ' + x + ' is legal');
        C.gossip.detach(id);
      }
    }
    // Numeric fields inside BLOCKS: the block's own (e.v, e.seq, e.ts, e.bits) are checked by block rules.
    const base = await append(alice, 'gb', { x: 1 }, [G.h], { ts: T0 });
    for (const field of ['v', 'seq', 'ts', 'bits']) {
      for (let i = 0; i < values.length; i++) {
        const x = values[i];
        if (base.e[field] === x) continue; // the original block itself (sent last)
        const e = Object.assign({}, base.e, { [field]: x });
        const id = 'B' + field + i;
        rawPeer(C.gossip, id, { decode });
        const t0 = performance.now();
        await C.gossip.handle(id, encode(MSG.BLOCKS, { b: [Object.assign({}, base, { e })] }));
        assert.ok(performance.now() - t0 < 2000);
        const info = C.gossip.peerInfo(id);
        // A changed e no longer matches h (or the shape rule fires first): always an invalid block.
        assert.equal(info.invalid, 1, 'e.' + field + ' = ' + x);
        assert.equal(C.dag.has(base.h), false);
        C.gossip.detach(id);
      }
    }
    rawPeer(C.gossip, 'ok', { decode });
    await C.gossip.handle('ok', encode(MSG.BLOCKS, { b: [base] }));
    assert.ok(C.dag.has(base.h), 'the untouched block is accepted');
  } finally {
    await C.close();
  }
});

test('MF-74: one remote peer id on many wires is capped at the gossip level; other ids are not affected', async () => {
  const dag = new Dag();
  const g = new Gossip({ site: SITE, owner: null, dag, ingest: async () => ({ added: [], rejected: [] }), getBlock: () => undefined, now: () => 0, setTimeoutFn: () => null, clearTimeoutFn: () => {} });
  const same = [];
  for (let i = 0; i < 10; i++) same.push(rawPeer(g, 'w' + i, { group: 'p:' + 'ab'.repeat(20) }));
  assert.equal(same.filter((p) => p.attached).length, 4);
  assert.deepEqual(same.slice(4).map((p) => p.ignored[0]), Array(6).fill('group-cap'), 'the extra wires are handed to the loader to close');
  assert.equal(g.stats.attached, 4);
  assert.equal(g.stats.refused, 6);
  const other = rawPeer(g, 'x', { group: 'p:' + 'cd'.repeat(20) });
  assert.equal(other.attached, true);
  // A wire of the capped group closing frees a slot.
  g.detach('w0');
  assert.equal(rawPeer(g, 'w10', { group: 'p:' + 'ab'.repeat(20) }).attached, true);
  g.destroy();
});

class FakeWire extends EventEmitter {
  constructor(sim, peerId) {
    super();
    this.sim = sim;
    this.type = 'webrtc';
    this.peerId = peerId;
    this.destroyed = false;
    this._ext = {};
    this.extendedMapping = {};
    this._nextExt = 1;
    this.peerExtendedMapping = {};
    this._extendedHandshakeSent = false;
    this.sentFrames = [];
  }

  use(Ext) {
    const id = this._nextExt++;
    const handler = new Ext(this);
    this.extendedMapping[id] = Ext.prototype.name;
    this._ext[Ext.prototype.name] = handler;
  }

  extended(name, buf) {
    this.sentFrames.push(buf);
  }

  remoteAdvertises(name) {
    this.peerExtendedMapping[name] = 1;
    this._ext[name].onExtendedHandshake({ m: { [name]: 1 } });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
}

test('MF-74 over wires: counted by wire; wires over one id\'s share, and ignored wires, are flagged for the loader to close', async () => {
  const sim = new Sim({ seed: 4 });
  const { owner, G } = await world();
  const C = await makeNode(sim, { name: 'C', owner: owner.pub, blocks: [G] });
  const torrent = new EventEmitter();
  torrent.wires = [];
  try {
    const closed = [];
    C.attachTorrent(torrent, { ignoreWire: (wire, reason) => closed.push(reason) });
    const wires = [];
    for (let i = 0; i < 10; i++) {
      const w = new FakeWire(sim, 'ee'.repeat(20)); // one claimed peer id on ten wires
      torrent.wires.push(w);
      torrent.emit('wire', w);
      w.remoteAdvertises('mw_chain1');
      wires.push(w);
    }
    const counts = wireCounts(C.gossip);
    assert.equal(counts.wires, 10, 'ten handlers, one per wire');
    assert.equal(counts.attached, 4, 'four gossip peers for one claimed id');
    assert.equal(counts.refused, 6);
    assert.deepEqual(closed, Array(6).fill('group-cap'));
    assert.equal(C.gossip.stats.attached, 4);
    // 51 malformed frames on an attached wire: the gossip ignores its peer and asks the loader to close it.
    const victim = wires.find((w) => handlerFor(w).attached);
    for (let i = 0; i < 51; i++) await handlerFor(victim).onMessage(new Uint8Array([MSG.ANN, 0x7b, 0x7d]));
    assert.equal(closed.at(-1), 'invalid');
    assert.equal(handlerFor(victim).ignoredReason, 'invalid');
    const inBefore = C.gossip.stats.in;
    await handlerFor(victim).onMessage(encode(MSG.ANN, { h: [hashOf('x')] }));
    assert.equal(C.gossip.stats.in, inBefore, 'nothing from an ignored wire reaches the gossip');
    victim.destroy(); // what the loader does
    assert.equal(wireCounts(C.gossip).attached, 3);
  } finally {
    await C.close();
  }
});

test('without loader hooks the wire is flagged __mwIgnored (the loader\'s periodic check closes it)', async () => {
  const sim = new Sim({ seed: 5 });
  const { owner, G } = await world();
  const C = await makeNode(sim, { name: 'C', owner: owner.pub, blocks: [G] });
  const torrent = new EventEmitter();
  torrent.wires = [];
  try {
    C.attachTorrent(torrent);
    const wires = [];
    for (let i = 0; i < 6; i++) {
      const w = new FakeWire(sim, 'ff'.repeat(20));
      torrent.emit('wire', w);
      w.remoteAdvertises('mw_chain1');
      wires.push(w);
    }
    assert.deepEqual(wires.map((w) => w.__mwIgnored === true), [false, false, false, false, true, true]);
  } finally {
    await C.close();
  }
});

test('a peer silent for 2 minutes after attach is refused (MF-74, PEER A10); a talking one stays', async () => {
  const sim = new Sim({ seed: 6 });
  const { owner, G } = await world();
  const C = await makeNode(sim, { name: 'C', owner: owner.pub, blocks: [G] });
  try {
    const silent = rawPeer(C.gossip, 'S', { decode });
    const talker = rawPeer(C.gossip, 'T', { decode });
    await C.gossip.handle('T', encode(MSG.HELLO, helloOf(C, { root: C.dag.root(), heads: [G.h], n: 1, d: 0 })));
    await sim.run(119000);
    assert.ok(C.gossip.hasPeer('S'));
    await sim.run(3000);
    assert.equal(C.gossip.hasPeer('S'), false);
    assert.deepEqual(silent.ignored, ['silent']);
    assert.ok(C.gossip.hasPeer('T'));
    assert.deepEqual(talker.ignored, []);
  } finally {
    await C.close();
  }
});

test('PEER A8: a frame over the budget is dropped before it is parsed (no strike for what was never read)', async () => {
  const sim = new Sim({ seed: 7 });
  const { owner, G } = await world();
  const C = await makeNode(sim, { name: 'C', owner: owner.pub, blocks: [G] });
  try {
    rawPeer(C.gossip, 'F', { decode });
    // 100 frames of 10 KB of broken JSON: about 6 fit the 64 KiB unsolicited burst and are parsed.
    const junk = new Uint8Array(10000).fill(0x7b);
    junk[0] = MSG.ANN;
    for (let i = 0; i < 100; i++) await C.gossip.handle('F', junk);
    const info = C.gossip.peerInfo('F');
    assert.ok(info.invalid <= 7, 'parsed and struck: ' + info.invalid);
    assert.ok(C.gossip.stats.dropped >= 93, 'dropped unread: ' + C.gossip.stats.dropped);
    assert.equal(info.ignored, false, 'so a flood cannot burn more than the budget on parsing');
  } finally {
    await C.close();
  }
});

test('PEER A6: one peer\'s announcements hold at most 256 wants, oldest first out; others still get theirs', async () => {
  const sim = new Sim({ seed: 8 });
  const { owner, G } = await world();
  const C = await makeNode(sim, { name: 'C', owner: owner.pub, blocks: [G], gossipLimits: { unsolicitedRate: 1e9, unsolicitedBurst: 1e9 } });
  try {
    rawPeer(C.gossip, 'F', { decode });
    rawPeer(C.gossip, 'H', { decode });
    const hello = encode(MSG.HELLO, helloOf(C, { root: C.dag.root(), heads: [G.h], n: 1, d: 0 }));
    await C.gossip.handle('F', hello);
    await C.gossip.handle('H', hello);
    for (let i = 0; i < 10; i++) {
      await C.gossip.handle('F', encode(MSG.ANN, { h: Array.from({ length: 200 }, (_, j) => hashOf('fake' + i + ':' + j)) }));
    }
    assert.equal(C.gossip.peerInfo('F').origins, 256);
    assert.equal(C.gossip.stats.wantsEvicted, 2000 - 256);
    await C.gossip.handle('H', encode(MSG.ANN, { h: [hashOf('honest')] }));
    assert.equal(C.gossip.peerInfo('H').origins, 1);
    assert.ok(C.gossip.stats.wants <= 257);
  } finally {
    await C.close();
  }
});

test('PEER A7: a session that brings nothing ends after 3 s; a peer that delivered pre-empts an unproven session', async () => {
  const sim = new Sim({ seed: 9 });
  const { owner, G } = await world();
  const alice = await makeIdentity();
  const C = await makeNode(sim, { name: 'C', owner: owner.pub, blocks: [G] });
  const deep = (i) => encode(MSG.HELLO, helloOf(C, { root: hashOf('fake root ' + i), heads: Array.from({ length: 32 }, (_, j) => hashOf('h' + i + ':' + j)), n: 900, d: 800 }));
  const syncing = (ids) => ids.filter((id) => C.gossip.peerInfo(id).syncing).length;
  try {
    const silent = ['S0', 'S1', 'S2', 'S3'];
    for (let i = 0; i < 4; i++) {
      rawPeer(C.gossip, silent[i], { decode });
      await C.gossip.handle(silent[i], deep(i));
    }
    assert.equal(syncing(silent), 4, 'four unproven peers hold every sync slot');
    await sim.run(2500);
    assert.equal(syncing(silent), 4);
    await sim.run(1500);
    assert.equal(syncing(silent), 0, 'ended after 3 s without a block');
    // They take the slots again with new roots.
    for (let i = 0; i < 4; i++) await C.gossip.handle(silent[i], deep(10 + i));
    assert.equal(syncing(silent), 4);
    // P delivers a valid block first (it is now proven), then announces a root C lacks: it pre-empts.
    const P = rawPeer(C.gossip, 'P', { decode });
    await C.gossip.handle('P', encode(MSG.HELLO, helloOf(C, { root: C.dag.root(), heads: [G.h], n: 1, d: 0 })));
    const b = await append(alice, 'gb', { from: 'P' }, [G.h]);
    await C.gossip.handle('P', encode(MSG.BLOCKS, { b: [b] }));
    assert.ok(C.dag.has(b.h));
    assert.equal(C.gossip.peerInfo('P').delivered, 1);
    assert.equal(P.delivered, 1, 'the transport heard about the first delivery (the loader anchors the wire)');
    await C.gossip.handle('P', deep(99));
    assert.equal(C.gossip.peerInfo('P').syncing, true, 'P got a session');
    assert.equal(syncing(silent), 3, 'one unproven session made room');
    assert.equal(C.gossip.stats.preempted, 1);
    // An unproven newcomer does not pre-empt anyone.
    rawPeer(C.gossip, 'Q', { decode });
    await C.gossip.handle('Q', deep(100));
    assert.equal(C.gossip.peerInfo('Q').syncing, false);
    assert.equal(C.gossip.stats.preempted, 1);
  } finally {
    await C.close();
  }
});
