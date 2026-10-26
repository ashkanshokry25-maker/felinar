// hub-lane-multi: the hub follow lane mw_chain2 (V03-DESIGN-REVIEW 3.1, 3.2.2, 3.2.3; MF-65; INTERFACES v0.3
// multi.js). mw_chain1 frames with a ledger field on every frame, RECENT { ledger, fromDepth } and HAVE { ledgers
// <= 256 }, SNAP parts for a checkpoint state; per-wire budgets as mw_chain1; at most 4 ledgers syncing at once per
// tab; follow caps of 250 on phones and 1,000 on desktops; phones pull, then disconnect (at most 2 wires, none
// when hidden). Two or more tabs run on a virtual clock over in-memory links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  MultiGossip, EXT_NAME_2, LANE_MSG, MAX_HAVE, SNAP_CHUNK, MAX_SNAP_PARTS, FOLLOW_CAPS, encodeLane, decodeLane, laneInfoHash, shardOf,
} from '../../src/chain/multi.js';
import { FRAME_MAX, MAX_LEDGER_BLOCKS } from '../../src/chain/gossip.js';
import { attachToTorrent, handlerFor } from '../../src/chain/wire-ext.js';
import { recentWindow, viewOf } from '../../src/chain/recent.js';
import { isPayloadOp } from '../../src/chain/block.js';
import { sha256Sync } from '../../src/chain/sha256-sync.js';
import { hex, utf8 } from '../../src/chain/canonical.js';
import { Sim, makeIdentity, makeNode, storeWith, policy, append, mk, makeCheckpoint, mulberry32, sameLedger } from './chain-net-helpers.mjs';

const MAX = Number.MAX_SAFE_INTEGER;
const hashOf = (s) => hex.encode(sha256Sync(utf8.encode(String(s))));
const raw = (type, obj) => {
  const body = utf8.encode(JSON.stringify(obj));
  const out = new Uint8Array(body.length + 1);
  out[0] = type;
  out.set(body, 1);
  return out;
};
const ledgerId = (i) => 'mw1:lane' + String(i).padStart(23, '0');

// A personal ledger (owner-only) of `posts` posts on site `site`.
async function personal(site, posts, { owner = null } = {}) {
  const who = owner || (await makeIdentity());
  const G = await mk(who, { t: 'policy', writers: 'owner', bits: 16 }, undefined, [], { site });
  const blocks = [G];
  let prev = G.h;
  for (let i = 0; i < posts; i++) {
    const b = await mk(who, { t: 'append', l: 'mw.post' }, { text: site.slice(-4) + ' post ' + i }, [prev], { site });
    blocks.push(b);
    prev = b.h;
  }
  return { owner: who, G, blocks, site };
}

function lane(sim, name, ledgers, opts = {}) {
  const m = new MultiGossip(Object.assign({ hubSuffix: 'hub.example', ledgers, now: sim.now, setTimeoutFn: sim.setTimeout, clearTimeoutFn: sim.clearTimeout }, opts));
  m.name = name;
  m.killed = [];
  const tick = () => {
    if (m._destroyed) return undefined;
    m.tick();
    sim.schedule(1000, tick);
    return undefined;
  };
  sim.schedule(1000, tick);
  return m;
}

function laneLink(sim, a, b, { latency = 20, filter = null, trace = null } = {}) {
  const deliver = (from, to, u8) => {
    if (filter && filter(from.name, to.name, u8) === false) return;
    if (trace) trace(from.name, to.name, u8, sim.t);
    const copy = u8.slice();
    sim.schedule(latency, () => to.handle(from.name, copy));
  };
  const okA = a.attach({ id: b.name, send: (u8) => deliver(a, b, u8), ignored: (r) => a.killed.push([b.name, r]) });
  const okB = b.attach({ id: a.name, send: (u8) => deliver(b, a, u8), ignored: (r) => b.killed.push([a.name, r]) });
  return { okA, okB };
}

test('codec: every frame carries the ledger field; mw_chain1 bounds apply; RECENT, HAVE and SNAP have theirs', () => {
  const L = ledgerId(1);
  const hello = { ledger: L, v: 1, site: L, owner: null, n: 5, d: 4, root: hashOf('r'), heads: [hashOf('h')] };
  const ok = [
    [LANE_MSG.HELLO, hello],
    [LANE_MSG.WANT, { ledger: L, h: [hashOf(1)] }],
    [LANE_MSG.BLOCKS, { ledger: L, b: [{ e: {}, h: hashOf(2) }] }],
    [LANE_MSG.ANN, { ledger: L, h: [hashOf(3)] }],
    [LANE_MSG.SYNC, { ledger: L, w: [{ k: 0, dg: hashOf(4), n: 1 }] }],
    [LANE_MSG.INV, { ledger: L, k: 0, h: [], more: false }],
    [LANE_MSG.RECENT, { ledger: L, fromDepth: -1, posts: 200, rid: 1 }],
    [LANE_MSG.RECENT, { ledger: L, rid: 1, b: [], more: false }],
    [LANE_MSG.RECENT, { ledger: L, rid: 1, b: [], more: true, cp: { h: hashOf(5), snap: hashOf(6), parts: 3, bytes: 30000 } }],
    [LANE_MSG.HAVE, { ledgers: Array.from({ length: MAX_HAVE }, (_, i) => ledgerId(i)) }],
    [LANE_MSG.HAVE, { ledgers: [], more: true }],
    [LANE_MSG.SNAP, { ledger: L, rid: 7, snap: hashOf(7), part: 0, parts: 1, data: 'x'.repeat(SNAP_CHUNK) }],
  ];
  for (const [type, obj] of ok) {
    const u8 = encodeLane(type, obj);
    assert.ok(u8.length <= FRAME_MAX);
    const back = decodeLane(u8);
    assert.ok(back, 'type ' + type + ' decodes');
    assert.deepEqual(back.obj, obj);
  }
  const noLedger = (obj) => { const o = Object.assign({}, obj); delete o.ledger; return o; };
  const bad = [
    ...ok.filter(([t]) => t !== LANE_MSG.HAVE).map(([t, o]) => [t, noLedger(o), 'no ledger field']),
    [LANE_MSG.ANN, { ledger: 'has spaces', h: [hashOf(1)] }, 'ledger shape'],
    [LANE_MSG.HELLO, Object.assign({}, hello, { d: MAX }), 'HELLO d = 2^53-1 (MF-73)'],
    [LANE_MSG.HELLO, Object.assign({}, hello, { n: MAX }), 'HELLO n = 2^53-1'],
    [LANE_MSG.SYNC, { ledger: L, w: [{ k: -1, dg: hashOf(4), n: 1 }] }, 'SYNC k = -1'],
    [LANE_MSG.INV, { ledger: L, k: MAX, h: [], more: false }, 'INV k = 2^53-1'],
    [LANE_MSG.RECENT, { ledger: L, fromDepth: -2, rid: 1 }, 'fromDepth -2'],
    [LANE_MSG.RECENT, { ledger: L, fromDepth: MAX_LEDGER_BLOCKS, rid: 1 }, 'fromDepth past the ledger bound'],
    [LANE_MSG.RECENT, { ledger: L, fromDepth: MAX, rid: 1 }, 'fromDepth 2^53-1'],
    [LANE_MSG.RECENT, { ledger: L, fromDepth: -1, posts: 0, rid: 1 }, 'posts 0'],
    [LANE_MSG.RECENT, { ledger: L, fromDepth: -1, posts: 201, rid: 1 }, 'posts 201'],
    [LANE_MSG.RECENT, { ledger: L, fromDepth: -1, rid: -1 }, 'rid -1'],
    [LANE_MSG.RECENT, { ledger: L, fromDepth: -1, rid: MAX }, 'rid 2^53-1'],
    [LANE_MSG.RECENT, { ledger: L, rid: 1, b: [1], more: false }, 'a non-block in an answer'],
    [LANE_MSG.RECENT, { ledger: L, rid: 1, b: [], more: false, cp: { h: hashOf(5), snap: hashOf(6), parts: MAX_SNAP_PARTS + 1, bytes: 1 } }, 'too many parts'],
    [LANE_MSG.HAVE, { ledgers: Array.from({ length: MAX_HAVE + 1 }, (_, i) => ledgerId(i)) }, 'HAVE of 257'],
    [LANE_MSG.HAVE, { ledgers: [], more: 'yes' }, 'HAVE more'],
    [LANE_MSG.SNAP, { ledger: L, rid: 7, snap: hashOf(7), part: 1, parts: 1, data: '' }, 'part >= parts'],
    [LANE_MSG.SNAP, { ledger: L, rid: 7, snap: hashOf(7), part: -1, parts: 1, data: '' }, 'part -1'],
    [LANE_MSG.SNAP, { ledger: L, rid: 7, snap: hashOf(7), part: 0, parts: 1, data: 'x'.repeat(SNAP_CHUNK + 1) }, 'data too long'],
  ];
  for (const [type, obj, why] of bad) assert.equal(decodeLane(raw(type, obj)), null, why);
  assert.equal(decodeLane(raw(10, { ledger: L })), null, 'unknown type');
  assert.equal(decodeLane(new Uint8Array(FRAME_MAX + 1).fill(0x20)), null, 'over the frame cap');
  const rand = mulberry32(99);
  for (let i = 0; i < 2000; i++) {
    const u8 = new Uint8Array(1 + Math.floor(rand() * 64));
    for (let j = 0; j < u8.length; j++) u8[j] = Math.floor(rand() * 256);
    const r = decodeLane(u8);
    assert.ok(r === null || (r.type >= 1 && r.type <= 9));
  }
});

test('the lane swarm: sha1(utf8("mw-hub-lane1|" + hubSuffix + "|" + shard)); ledgers spread over power-of-two shards', async () => {
  const want = createHash('sha1').update('mw-hub-lane1|hub.example|0').digest('hex');
  assert.equal(await laneInfoHash('hub.example'), want);
  assert.equal(await laneInfoHash('Hub.Example.'), want, 'one spelling of the suffix');
  assert.equal(await laneInfoHash('hub.example', 3), createHash('sha1').update('mw-hub-lane1|hub.example|3').digest('hex'));
  await assert.rejects(laneInfoHash(''), TypeError);
  const m = new MultiGossip({ hubSuffix: 'hub.example', shard: 2 });
  assert.equal(await m.infoHash(), createHash('sha1').update('mw-hub-lane1|hub.example|2').digest('hex'));
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const s = shardOf(ledgerId(i), 8);
    assert.ok(s >= 0 && s < 8);
    seen.add(s);
  }
  assert.equal(seen.size, 8);
  assert.equal(shardOf(ledgerId(5), 1), 0);
  assert.equal(shardOf(ledgerId(5), 4), shardOf(ledgerId(5), 4), 'deterministic');
  assert.throws(() => shardOf(ledgerId(1), 3), TypeError);
});

test('RECENT over the lane: a follower gets the newest 200 posts and every control block; new posts arrive by ANN', async () => {
  const sim = new Sim({ seed: 1 });
  const site = ledgerId(1);
  const P = await personal(site, 260);
  const own = await makeNode(sim, { name: 'own', siteId: site, owner: P.owner.pub, genesisHash: P.G.h, identity: P.owner, blocks: P.blocks });
  const follower = await makeNode(sim, { name: 'f', siteId: site, owner: P.owner.pub, genesisHash: P.G.h });
  const A = lane(sim, 'A', new Map([[site, own]]));
  const B = lane(sim, 'B', new Map([[site, follower]]));
  try {
    A.hold(site);
    B.follow(site);
    laneLink(sim, A, B);
    assert.ok(await sim.run(20000, () => B.stats.recentDone === 1), 'the window arrived');
    const view = viewOf(follower);
    const d = view.state();
    const win = recentWindow(own);
    assert.equal(view.size, win.blocks.length);
    assert.equal(d.snapshot.lists['mw.post'].length, 200);
    assert.deepEqual(d.snapshot.lists['mw.post'], own.snapshot().lists['mw.post'].slice(-200));
    assert.deepEqual(d.snapshot.policy, own.snapshot().policy);
    assert.ok(B.peerInfo('A').has >= 1, 'HAVE told B what A holds');
    assert.equal(A.stats.served, 1);
    assert.deepEqual(B.holdings(), [site], 'B now holds a window of it and says so');
    // The owner posts: A announces the new head on the lane, B fetches it into the view.
    const post = await own.append('mw.post', { text: 'fresh' });
    assert.ok(await sim.run(5000, () => view.has(post.h)), 'the new post reached the follower');
    assert.equal(viewOf(follower).state().snapshot.lists['mw.post'].at(-1).v.text, 'fresh');
  } finally {
    A.destroy();
    B.destroy();
    await own.close();
    await follower.close();
  }
});

test('at most 4 ledgers sync at once per tab; all ten complete', async () => {
  const sim = new Sim({ seed: 2 });
  const authorLedgers = new Map();
  const followLedgers = new Map();
  const nodes = [];
  for (let i = 0; i < 10; i++) {
    const site = ledgerId(100 + i);
    const P = await personal(site, 40);
    const own = await makeNode(sim, { name: 'o' + i, siteId: site, owner: P.owner.pub, genesisHash: P.G.h, blocks: P.blocks });
    const f = await makeNode(sim, { name: 'f' + i, siteId: site, owner: P.owner.pub, genesisHash: P.G.h });
    authorLedgers.set(site, own);
    followLedgers.set(site, f);
    nodes.push(own, f);
  }
  const A = lane(sim, 'A', authorLedgers);
  const B = lane(sim, 'B', followLedgers);
  try {
    for (const id of authorLedgers.keys()) A.hold(id);
    for (const id of followLedgers.keys()) B.follow(id);
    let maxActive = 0;
    let outstanding = 0;
    let maxOutstanding = 0;
    laneLink(sim, A, B, {
      latency: 50,
      trace: (from, to, u8) => {
        const m = decodeLane(u8);
        if (!m || m.type !== LANE_MSG.RECENT) return;
        if (from === 'B' && m.obj.b === undefined) outstanding++;
        if (from === 'A' && m.obj.b !== undefined && !m.obj.more) outstanding--;
        maxOutstanding = Math.max(maxOutstanding, outstanding);
      },
    });
    assert.ok(await sim.run(60000, () => {
      maxActive = Math.max(maxActive, B.stats.active);
      return B.stats.recentDone === 10;
    }), 'every followed ledger got its window');
    assert.equal(maxActive, 4, 'four at a time');
    assert.ok(maxOutstanding <= 4, 'never more than four RECENT requests out: ' + maxOutstanding);
    for (const [id, f] of followLedgers) assert.equal(viewOf(f).state().snapshot.lists['mw.post'].length, 40, id);
  } finally {
    A.destroy();
    B.destroy();
    for (const n of nodes) await n.close();
  }
});

test('follow caps: 250 on a phone, 1,000 on a desktop, with a clear error', () => {
  assert.deepEqual({ ...FOLLOW_CAPS }, { phone: 250, desktop: 1000 });
  const stub = (id) => ({ siteId: id, genesisOwner: null, expectedOwner: null, config: { minBits: 0 } });
  for (const [cls, cap, where] of [['phone', 250, 'on this phone'], ['desktop', 1000, 'on this computer']]) {
    const ledgers = new Map();
    for (let i = 0; i <= cap; i++) ledgers.set(ledgerId(i), stub(ledgerId(i)));
    const m = new MultiGossip({ hubSuffix: 'hub.example', deviceClass: cls, ledgers, now: () => 0, setTimeoutFn: () => null, clearTimeoutFn: () => {} });
    for (let i = 0; i < cap; i++) m.follow(ledgerId(i));
    assert.equal(m.followed, cap);
    assert.throws(() => m.follow(ledgerId(cap)), (err) => {
      assert.equal(err.code, 'E_LIMIT');
      assert.equal(err.reason, 'follow-cap');
      assert.equal(err.cap, cap);
      assert.equal(err.message, 'You follow ' + cap + ' of ' + cap + ' ' + where + '.');
      return true;
    });
    assert.equal(m.follow(ledgerId(0)), true, 'following again is not a new follow');
    m.unfollow(ledgerId(0));
    assert.equal(m.follow(ledgerId(cap)), true, 'room after an unfollow');
  }
  const m = new MultiGossip({ hubSuffix: 'hub.example', ledgers: new Map() });
  assert.throws(() => m.follow(ledgerId(1)), TypeError, 'a followed ledger needs its ChainNode');
});

test('phones pull, then disconnect: at most 2 wires once current, none while hidden', async () => {
  const sim = new Sim({ seed: 3 });
  const site = ledgerId(7);
  const P = await personal(site, 30);
  const authors = [];
  const nodes = [];
  for (let i = 0; i < 5; i++) {
    const own = await makeNode(sim, { name: 'o' + i, siteId: site, owner: P.owner.pub, genesisHash: P.G.h, blocks: P.blocks });
    nodes.push(own);
    const A = lane(sim, 'A' + i, new Map([[site, own]]));
    A.hold(site);
    authors.push(A);
  }
  const f = await makeNode(sim, { name: 'f', siteId: site, owner: P.owner.pub, genesisHash: P.G.h });
  nodes.push(f);
  const phone = lane(sim, 'phone', new Map([[site, f]]), { deviceClass: 'phone' });
  try {
    phone.follow(site);
    assert.equal(phone.wantedWires, 8, 'while something is due');
    assert.equal(phone.syncing, true, 'integrator (SCALE-6): syncing while a follow is due');
    for (const A of authors) laneLink(sim, A, phone);
    assert.equal(phone.stats.attached, 5);
    assert.ok(await sim.run(20000, () => phone.stats.recentDone === 1));
    await sim.run(2000);
    assert.equal(phone.wantedWires, 2);
    assert.equal(phone.syncing, false, 'not syncing once every follow is current');
    assert.equal(phone.stats.attached, 2, 'pulled, then disconnected down to 2 wires');
    assert.equal(phone.killed.filter((k) => k[1] === 'phone-idle').length, 3);
    // A wire beyond the two is refused while nothing is due.
    const extra = lane(sim, 'X', new Map([[site, nodes[0]]]));
    const r = laneLink(sim, extra, phone);
    assert.equal(r.okB, false);
    // Hidden: no lane wire at all, and none accepted.
    phone.setHidden(true);
    assert.equal(phone.stats.attached, 0);
    assert.equal(phone.wantedWires, 0);
    assert.ok(phone.killed.some((k) => k[1] === 'hidden'));
    const again = lane(sim, 'Y', new Map([[site, nodes[1]]]));
    assert.equal(laneLink(sim, again, phone).okB, false);
    phone.setHidden(false);
    assert.equal(phone.wantedWires, 2);
    extra.destroy();
    again.destroy();
  } finally {
    phone.destroy();
    for (const A of authors) A.destroy();
    for (const n of nodes) await n.close();
  }
});

test('a pruned author sends its checkpoint state as SNAP parts; the follower checks it; a tampered part is refused', async () => {
  const sim = new Sim({ seed: 4 });
  const site = ledgerId(8);
  const P = await personal(site, 260);
  const own = await makeNode(sim, { name: 'own', siteId: site, owner: P.owner.pub, genesisHash: P.G.h, identity: P.owner, blocks: P.blocks });
  const cp = await makeCheckpoint(P.owner, own);
  // makeCheckpoint signs for the helpers' default site; re-sign it for this ledger.
  const cpBlock = await mk(P.owner, cp.block.e.op, undefined, cp.block.e.prev, { site });
  await own.ingest([cpBlock], 'owner');
  await own.applyCheckpoint(cp.S);
  for (let i = 0; i < 5; i++) await own.append('mw.post', { text: 'after ' + i });
  const f1 = await makeNode(sim, { name: 'f1', siteId: site, owner: P.owner.pub, genesisHash: P.G.h });
  const f2 = await makeNode(sim, { name: 'f2', siteId: site, owner: P.owner.pub, genesisHash: P.G.h });
  const A = lane(sim, 'A', new Map([[site, own]]));
  const B = lane(sim, 'B', new Map([[site, f1]]));
  const C = lane(sim, 'C', new Map([[site, f2]]));
  try {
    A.hold(site);
    B.follow(site);
    C.follow(site);
    let parts = 0;
    laneLink(sim, A, B, { trace: (from, to, u8) => { if (u8[0] === LANE_MSG.SNAP) parts++; } });
    // A's frames to C have one character changed in every SNAP part.
    laneLink(sim, A, C);
    const aToC = A._peers.get('C');
    const send = aToC.send;
    aToC.send = (u8) => {
      if (u8[0] !== LANE_MSG.SNAP) return send(u8);
      const m = decodeLane(u8);
      m.obj.data = m.obj.data.replace(/"/, "'");
      return send(encodeLane(LANE_MSG.SNAP, m.obj));
    };
    assert.ok(await sim.run(30000, () => B.stats.recentDone === 1 && C.stats.recentDone === 1));
    assert.ok(parts >= 2, 'S travelled in ' + parts + ' parts');
    assert.equal(A.stats.snapsServed, 2);
    const d = viewOf(f1).state();
    assert.equal(d.checkpoint.snap, cp.snap);
    assert.equal(d.complete, true);
    assert.equal(d.controlExact, true);
    assert.deepEqual(d.snapshot.lists['mw.post'], own.snapshot().lists['mw.post']);
    assert.equal(B.stats.snapsTaken, 1);
    assert.equal(viewOf(f2).checkpoint, null, 'the tampered S was not taken');
    assert.ok(C.peerInfo('A').invalid >= 1, 'and the wire was struck');
  } finally {
    A.destroy();
    B.destroy();
    C.destroy();
    await own.close();
    await f1.close();
    await f2.close();
  }
});

test('per-wire budgets and strikes: answers nobody asked for strike; over 50 the wire is handed back to close', async () => {
  const sim = new Sim({ seed: 5 });
  const site = ledgerId(9);
  const P = await personal(site, 3);
  const f = await makeNode(sim, { name: 'f', siteId: site, owner: P.owner.pub, genesisHash: P.G.h });
  const B = lane(sim, 'B', new Map([[site, f]]));
  try {
    const ignored = [];
    B.attach({ id: 'X', send: () => {}, ignored: (r) => ignored.push(r) });
    for (let i = 0; i < 51; i++) await B.handle('X', encodeLane(LANE_MSG.RECENT, { ledger: site, rid: 1000 + i, b: [], more: false }));
    assert.equal(B.peerInfo('X').ignored, true);
    assert.deepEqual(ignored, ['invalid']);
    // Unsolicited frames above 64 KiB/s are dropped before they are parsed.
    B.attach({ id: 'Y', send: () => {} });
    const big = encodeLane(LANE_MSG.HAVE, { ledgers: Array.from({ length: 256 }, (_, i) => 'mw1:' + String(i).padStart(27, 'x')) });
    const before = B.stats.dropped;
    for (let i = 0; i < 20; i++) await B.handle('Y', big);
    assert.ok(B.stats.dropped > before, 'dropped: ' + (B.stats.dropped - before));
    assert.equal(B.peerInfo('Y').invalid, 0);
    // Malformed frames are strikes.
    await B.handle('Y', raw(LANE_MSG.ANN, { h: [hashOf(1)] }));
    assert.equal(B.peerInfo('Y').invalid, 1);
  } finally {
    B.destroy();
    await f.close();
  }
});

class FakeWire extends EventEmitter {
  constructor(sim) {
    super();
    this.sim = sim;
    this.type = 'webrtc';
    this.peerId = null;
    this.destroyed = false;
    this._ext = {};
    this.extendedMapping = {};
    this._nextExt = 1;
    this.peerExtendedMapping = {};
    this._extendedHandshakeSent = false;
    this.remote = null;
  }

  use(Ext) {
    const id = this._nextExt++;
    const h = new Ext(this);
    this.extendedMapping[id] = Ext.prototype.name;
    this._ext[Ext.prototype.name] = h;
  }

  _sendExtendedHandshake() {
    const m = {};
    for (const id in this.extendedMapping) m[this.extendedMapping[id]] = Number(id);
    this._extendedHandshakeSent = true;
    const remote = this.remote;
    this.sim.schedule(5, () => remote._onExtendedHandshake({ m }));
  }

  _onExtendedHandshake(info) {
    for (const name in info.m) this.peerExtendedMapping[name] = Number(info.m[name]);
    for (const name in this._ext) if (this.peerExtendedMapping[name]) this._ext[name].onExtendedHandshake(info);
  }

  extended(name, buf) {
    const remote = this.remote;
    const copy = buf.slice();
    this.sim.schedule(5, () => (remote._ext[name] ? remote._ext[name].onMessage(copy) : undefined));
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
}

test('registered through wire-ext.js as mw_chain2: two tabs complete a RECENT sync over BitTorrent-style wires', async () => {
  const sim = new Sim({ seed: 6 });
  const site = ledgerId(10);
  const P = await personal(site, 50);
  const own = await makeNode(sim, { name: 'own', siteId: site, owner: P.owner.pub, genesisHash: P.G.h, blocks: P.blocks });
  const f = await makeNode(sim, { name: 'f', siteId: site, owner: P.owner.pub, genesisHash: P.G.h });
  const A = lane(sim, 'A', new Map([[site, own]]));
  const B = lane(sim, 'B', new Map([[site, f]]));
  const ta = new EventEmitter();
  const tb = new EventEmitter();
  ta.wires = [];
  tb.wires = [];
  try {
    A.hold(site);
    B.follow(site);
    attachToTorrent(ta, A, { name: EXT_NAME_2 });
    attachToTorrent(tb, B, { name: EXT_NAME_2 });
    const a = new FakeWire(sim);
    const b = new FakeWire(sim);
    a.remote = b;
    b.remote = a;
    ta.emit('wire', a);
    tb.emit('wire', b);
    assert.equal(handlerFor(a, EXT_NAME_2).extName, 'mw_chain2');
    a._sendExtendedHandshake();
    b._sendExtendedHandshake();
    assert.ok(await sim.run(20000, () => B.stats.recentDone === 1));
    assert.equal(viewOf(f).state().snapshot.lists['mw.post'].length, 50);
  } finally {
    A.destroy();
    B.destroy();
    await own.close();
    await f.close();
  }
});

test('a held ledger keeps the full mw_chain1 protocol over the lane (virtual peers): a second device syncs in full', async () => {
  const sim = new Sim({ seed: 7 });
  const site = ledgerId(11);
  const P = await personal(site, 120);
  const laptop = await makeNode(sim, { name: 'laptop', siteId: site, owner: P.owner.pub, genesisHash: P.G.h, blocks: P.blocks });
  const phone = await makeNode(sim, { name: 'phone', siteId: site, owner: P.owner.pub, genesisHash: P.G.h, store: await storeWith(P.blocks.slice(0, 10)) });
  const A = lane(sim, 'A', new Map([[site, laptop]]));
  const B = lane(sim, 'B', new Map([[site, phone]]));
  try {
    A.hold(site);
    B.hold(site);
    laneLink(sim, A, B);
    assert.ok(await sim.run(30000, () => sameLedger(laptop, phone)), 'the second device has the whole ledger');
    assert.ok(A.peerInfo('B').virtual >= 1 && B.peerInfo('A').virtual >= 1, 'through a virtual peer on each side');
    // A later block travels the same way (ANN through the virtual peers).
    const next = await mk(P.owner, { t: 'append', l: 'mw.post' }, { text: 'later' }, laptop.choosePrev(), { site });
    assert.deepEqual((await laptop.ingest([next], 'owner-tool')).added, [next.h]);
    assert.ok(await sim.run(5000, () => phone.dag.has(next.h)));
  } finally {
    A.destroy();
    B.destroy();
    await laptop.close();
    await phone.close();
  }
});

test('a wire flooding RECENT requests gets 8 answers at once, 8 more as its rate allows, and the rest are dropped', async () => {
  const sim = new Sim({ seed: 8 });
  const site = ledgerId(12);
  const P = await personal(site, 20);
  const own = await makeNode(sim, { name: 'own', siteId: site, owner: P.owner.pub, genesisHash: P.G.h, blocks: P.blocks });
  // The rate rule alone: the one-answer-per-ledger-per-minute rule of the review round (SCALE-11) is off here.
  const A = lane(sim, 'A', new Map([[site, own]]), { limits: { recentRepeatMs: 0 } });
  try {
    A.hold(site);
    const got = [];
    A.attach({ id: 'X', send: (u8) => { const m = decodeLane(u8); if (m && m.type === LANE_MSG.RECENT && m.obj.more === false) got.push(m.obj.rid); } });
    const before = A.stats.dropped;
    for (let i = 0; i < 30; i++) await A.handle('X', encodeLane(LANE_MSG.RECENT, { ledger: site, fromDepth: -1, rid: i + 1 }));
    assert.equal(got.length, 8, 'the burst');
    assert.equal(A.stats.dropped - before, 14, 'over the burst and the queue');
    await sim.run(5000);
    assert.equal(got.length, 16, 'the queued ones, as the rate allows');
    assert.deepEqual(got, Array.from({ length: 16 }, (_, i) => i + 1));
  } finally {
    A.destroy();
    await own.close();
  }
});

test('peerFor(): recent.js syncRecent over a lane wire, outside the scheduler', async () => {
  const { syncRecent } = await import('../../src/chain/recent.js');
  const sim = new Sim({ seed: 9 });
  const site = ledgerId(13);
  const P = await personal(site, 30);
  const own = await makeNode(sim, { name: 'own', siteId: site, owner: P.owner.pub, genesisHash: P.G.h, blocks: P.blocks });
  const f = await makeNode(sim, { name: 'f', siteId: site, owner: P.owner.pub, genesisHash: P.G.h });
  const A = lane(sim, 'A', new Map([[site, own]]));
  const B = lane(sim, 'B', new Map([[site, f]]));
  try {
    A.hold(site);
    laneLink(sim, A, B);
    const pending = syncRecent(f, B.peerFor('A'), { posts: 10 });
    await sim.run(5000); // the frames travel on the virtual clock; the checks finish on the real one
    const result = await pending;
    assert.equal(result.added, 11, 'the newest 10 posts and the genesis policy');
    assert.equal(result.state.snapshot.lists['mw.post'].length, 10);
    assert.equal(B.stats.active, 0, 'the scheduler was not involved');
    await assert.rejects(B.peerFor('nobody').recent({ ledger: site }), (err) => err.code === 'E_PEER_UNREACHABLE');
  } finally {
    A.destroy();
    B.destroy();
    await own.close();
    await f.close();
  }
});

test('a desktop follower relays its window to another follower, never with a value its state hides', async () => {
  const sim = new Sim({ seed: 10 });
  const site = ledgerId(14);
  const P = await personal(site, 12);
  const T = await mk(P.owner, { t: 'tombstone', h: P.blocks[5].h }, undefined, [P.blocks.at(-1).h], { site });
  const own = await makeNode(sim, { name: 'own', siteId: site, owner: P.owner.pub, genesisHash: P.G.h, blocks: P.blocks.concat([T]) });
  const f1 = await makeNode(sim, { name: 'f1', siteId: site, owner: P.owner.pub, genesisHash: P.G.h });
  const f2 = await makeNode(sim, { name: 'f2', siteId: site, owner: P.owner.pub, genesisHash: P.G.h });
  const A = lane(sim, 'A', new Map([[site, own]]));
  const B = lane(sim, 'B', new Map([[site, f1]]));
  const C = lane(sim, 'C', new Map([[site, f2]]));
  try {
    A.hold(site);
    B.follow(site);
    laneLink(sim, A, B);
    assert.ok(await sim.run(10000, () => B.stats.recentDone === 1));
    // B's view got the value of the tombstoned post from somewhere (a value arriving for a stub).
    await viewOf(f1).add([P.blocks[5]]);
    assert.notEqual(viewOf(f1).get(P.blocks[5].h).v, undefined);
    // C follows and is linked only to B: B relays its window.
    C.follow(site);
    const seen = [];
    laneLink(sim, B, C, { trace: (from, to, u8) => { if (from === 'B') seen.push(u8); } });
    assert.ok(await sim.run(10000, () => C.stats.recentDone === 1), 'C got the window from B');
    assert.equal(viewOf(f2).state().snapshot.lists['mw.post'].length, 11);
    const sent = seen.map((u8) => utf8.decode(u8.subarray(1))).join('\n');
    assert.equal(sent.includes('post 4"'), false, 'the hidden value never left B');
  } finally {
    A.destroy();
    B.destroy();
    C.destroy();
    await own.close();
    await f1.close();
    await f2.close();
  }
});

// ---------------------------------------------------------------------------------------------- code review v0.3

test('code review v0.3: a lane peer that answers RECENT with blocks of a key without standing is struck, credited nothing and not picked again', async () => {
  const sim = new Sim({ seed: 21 });
  const site = ledgerId(21);
  const P = await personal(site, 40);
  const own = await makeNode(sim, { name: 'own', siteId: site, owner: P.owner.pub, genesisHash: P.G.h, blocks: P.blocks });
  const f = await makeNode(sim, { name: 'f', siteId: site, owner: P.owner.pub, genesisHash: P.G.h });
  const H = lane(sim, 'H', new Map([[site, own]]));
  const F = lane(sim, 'F', new Map([[site, f]]));
  try {
    H.hold(site);
    // F's view already holds the ledger's posts (an earlier visit); the junk builds on its newest post.
    assert.equal((await viewOf(f).add(P.blocks.slice(0, 31))).added.length, 31);
    const toJ = [];
    const ignored = [];
    F.attach({ id: 'J', send: (u8) => toJ.push(u8), ignored: (r) => ignored.push(r) });
    await F.handle('J', encodeLane(LANE_MSG.HAVE, { ledgers: [site] }));
    F.follow(site);
    const ask = toJ.map(decodeLane).find((m) => m && m.type === LANE_MSG.RECENT && m.obj.b === undefined);
    assert.ok(ask, 'F asked J first');
    const thief = await makeIdentity();
    const junk = [];
    for (let i = 0; i < 120; i++) junk.push(await mk(thief, { t: 'append', l: 'mw.post' }, { text: 'junk ' + i }, [P.blocks[30].h], { site }));
    for (let i = 0; i < junk.length; i += 20) {
      await F.handle('J', encodeLane(LANE_MSG.RECENT, { ledger: site, rid: ask.obj.rid, b: junk.slice(i, i + 20), more: i + 20 < junk.length }));
      await sim.run(50);
    }
    assert.equal(F.peerInfo('J').delivered, 0, 'refused blocks are no delivery');
    assert.equal(F.peerInfo('J').invalid, 120, 'each refusal for lack of standing is a strike');
    assert.equal(F.peerInfo('J').ignored, true, 'more than 50 refusals ignore the wire');
    assert.deepEqual(ignored, ['invalid']);
    assert.equal(viewOf(f).size, 31, 'nothing of the answer is kept');
    // The honest peer is asked next; the posts arrive, and J is never the peer picked.
    laneLink(sim, H, F);
    assert.ok(await sim.run(30000, () => ((viewOf(f).state().snapshot.lists['mw.post'] || []).length === 40)));
    assert.equal(F._pickPeer(site, F._follow.get(site)).id, 'H');
    assert.ok(F.peerInfo('H').delivered > 0);
  } finally {
    H.destroy();
    F.destroy();
    await own.close();
    await f.close();
  }
});

test('code review v0.3: a RECENT answer cut to the block cap says truncated, and the follower\'s control state is not exact', async () => {
  const sim = new Sim({ seed: 22 });
  const site = ledgerId(22);
  const P = await personal(site, 20);
  const extra = [];
  let prev = P.blocks.at(-1).h;
  for (let i = 0; i < 30; i++) {
    const b = await mk(P.owner, { t: 'policy', maxChainBytes: 8388608 + i * 1024 }, undefined, [prev], { site });
    extra.push(b);
    prev = b.h;
  }
  const own = await makeNode(sim, { name: 'own', siteId: site, owner: P.owner.pub, genesisHash: P.G.h, blocks: P.blocks.concat(extra) });
  const f = await makeNode(sim, { name: 'f', siteId: site, owner: P.owner.pub, genesisHash: P.G.h });
  const A = lane(sim, 'A', new Map([[site, own]]), { limits: { maxWindowBlocks: 40 } });
  const B = lane(sim, 'B', new Map([[site, f]]));
  let flagged = false;
  try {
    A.hold(site);
    B.follow(site);
    laneLink(sim, A, B, { trace: (from, to, u8) => { const m = decodeLane(u8); if (m && m.type === LANE_MSG.RECENT && m.obj.truncated === true) flagged = true; } });
    assert.ok(await sim.run(20000, () => B.stats.recentDone === 1));
    assert.equal(flagged, true, 'the first page says truncated');
    assert.equal(viewOf(f).state().controlExact, false);
    assert.equal(decodeLane(encodeLane(LANE_MSG.RECENT, { ledger: site, rid: 1, b: [], more: false, truncated: 'yes' })), null, 'truncated is a boolean');
  } finally {
    A.destroy();
    B.destroy();
    await own.close();
    await f.close();
  }
});

test('code review v0.3: a frame that names a held ledger first and a followed one second pays as unsolicited, counts against the wire and is not handled', async () => {
  const sim = new Sim({ seed: 23 });
  const heldSite = ledgerId(23);
  const followSite = ledgerId(24);
  const Hd = await personal(heldSite, 3);
  const Fw = await personal(followSite, 5);
  const heldNode = await makeNode(sim, { name: 'h', siteId: heldSite, owner: Hd.owner.pub, genesisHash: Hd.G.h, blocks: Hd.blocks });
  const followNode = await makeNode(sim, { name: 'w', siteId: followSite, owner: Fw.owner.pub, genesisHash: Fw.G.h });
  const D = lane(sim, 'D', new Map([[heldSite, heldNode], [followSite, followNode]]));
  try {
    D.hold(heldSite);
    D.follow(followSite);
    await viewOf(followNode).add(Fw.blocks);
    const sent = [];
    D.attach({ id: 'P', send: (u8) => sent.push(u8) });
    await D.handle('P', encodeLane(LANE_MSG.HAVE, { ledgers: [heldSite], full: true })); // a virtual peer for the held ledger
    assert.equal(D.peerInfo('P').virtual, 1);
    const want = Fw.blocks.slice(1, 3).map((b) => b.h);
    const text = '{"ledger":"' + heldSite + '","h":' + JSON.stringify(want) + ',"ledger":"' + followSite + '"}';
    const frame = new Uint8Array(utf8.encode(text).length + 1);
    frame[0] = LANE_MSG.WANT;
    frame.set(utf8.encode(text), 1);
    const tokens = D._peers.get('P').unsol.available();
    const before = sent.length;
    await D.handle('P', frame);
    assert.equal(D.peerInfo('P').invalid, 1);
    assert.ok(D._peers.get('P').unsol.available() <= tokens - frame.length + 1, 'charged to the unsolicited bucket');
    assert.equal(sent.slice(before).map(decodeLane).filter((m) => m && m.type === LANE_MSG.BLOCKS).length, 0, 'the followed view did not answer');
    // The same WANT with one ledger key is answered from the view (desktop class).
    await D.handle('P', encodeLane(LANE_MSG.WANT, { ledger: followSite, h: want }));
    await sim.run(1000);
    assert.equal(sent.slice(before).map(decodeLane).filter((m) => m && m.type === LANE_MSG.BLOCKS).length, 1);
  } finally {
    D.destroy();
    await heldNode.close();
    await followNode.close();
  }
});
