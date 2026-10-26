// chain-net: the BitTorrent wire adapter (ARCHITECTURE 1 and 6.6; DESIGN-REVIEW S1, S9), driven
// with fake wires that reproduce bittorrent-protocol 5.0.9's extension mechanics (use(),
// extendedMapping, peerExtendedMapping, extended(), additive extended handshakes) and fake
// torrents ('wire' events, torrent.wires). Two ChainNodes converge over them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { EXT_NAME, makeWireExtension, attachToTorrent, handlerFor } from '../../src/chain/wire-ext.js';
import { MSG, encode, decode } from '../../src/chain/gossip.js';
import { Sim, SITE, makeIdentity, makeNode, policy, sameLedger } from './chain-net-helpers.mjs';

let wireCount = 0;

class FakeWire extends EventEmitter {
  constructor(sim, { type = 'webrtc', extensions = true, peerId = null } = {}) {
    super();
    this.sim = sim;
    this.type = type;
    this.peerId = peerId || (++wireCount).toString(16).padStart(40, '0'); // the REMOTE client's id
    this.destroyed = false;
    this.extensions = extensions; // false: a client without BEP 10 extension messages for us
    this._ext = {};
    this.extendedMapping = {};
    this._nextExt = 1;
    this.peerExtendedMapping = {};
    this._extendedHandshakeSent = false;
    this.handshakesSent = 0;
    this.remote = null;
    this.extendedSent = [];
  }

  use(Ext) {
    const name = Ext.prototype.name;
    if (!name) throw new Error('Extension class requires a "name" property on the prototype');
    const id = this._nextExt++;
    const handler = new Ext(this);
    for (const fn of ['onHandshake', 'onExtendedHandshake', 'onMessage']) if (typeof handler[fn] !== 'function') handler[fn] = () => {};
    this.extendedMapping[id] = name;
    this._ext[name] = handler;
    this[name] = handler;
  }

  _sendExtendedHandshake() {
    const m = {};
    if (this.extensions) for (const id in this.extendedMapping) m[this.extendedMapping[id]] = Number(id);
    this._extendedHandshakeSent = true;
    this.handshakesSent++;
    this._toRemote((r) => r._onExtendedHandshake({ m }));
  }

  _onExtendedHandshake(info) {
    for (const name in info.m) this.peerExtendedMapping[name] = Number(info.m[name]);
    for (const name in this._ext) if (this.peerExtendedMapping[name]) this._ext[name].onExtendedHandshake(info);
  }

  extended(ext, buf) {
    if (typeof ext === 'string' && this.peerExtendedMapping[ext]) ext = this.peerExtendedMapping[ext];
    if (typeof ext !== 'number') throw new Error('Unrecognized extension: ' + ext);
    this.extendedSent.push(buf);
    const copy = buf.slice();
    this._toRemote((r) => r._onExtended(ext, copy));
  }

  _onExtended(ext, buf) {
    const name = this.extendedMapping[ext];
    if (name && this._ext[name]) return this._ext[name].onMessage(buf); // awaited by the simulator
    return undefined;
  }

  _toRemote(fn) {
    const remote = this.remote;
    if (!remote || this.destroyed) return;
    this.sim.schedule(5, () => (!remote.destroyed && !this.destroyed ? fn(remote) : undefined));
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
    if (this.remote) this.remote.destroy();
  }
}

class FakeTorrent extends EventEmitter {
  constructor() {
    super();
    this.wires = [];
  }

  addWire(wire) {
    this.wires.push(wire);
    this.emit('wire', wire);
  }
}

function pair(sim, opts = {}) {
  const a = new FakeWire(sim, opts.a);
  const b = new FakeWire(sim, opts.b);
  a.remote = b;
  b.remote = a;
  return [a, b];
}

/** Both ends open: each side's torrent emits its wire, then both send their extended handshake. */
function connect(sim, ta, tb, opts) {
  const [a, b] = pair(sim, opts);
  ta.addWire(a);
  tb.addWire(b);
  a._sendExtendedHandshake();
  b._sendExtendedHandshake();
  return [a, b];
}

async function world() {
  const owner = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  return { owner, G };
}

test('the extension class: name mw_chain1 on the prototype, custom names, webSeed wires skipped', async () => {
  assert.equal(EXT_NAME, 'mw_chain1');
  const gossip = { attach() {}, detach() {}, handle: async () => {} };
  assert.equal(makeWireExtension(gossip).prototype.name, 'mw_chain1');
  assert.equal(makeWireExtension(gossip, { name: 'mw_test' }).prototype.name, 'mw_test');
  const sim = new Sim();
  const torrent = new FakeTorrent();
  const detach = attachToTorrent(torrent, gossip);
  const web = new FakeWire(sim, { type: 'webSeed' });
  torrent.addWire(web);
  assert.deepEqual(web._ext, {}, 'no extension on an HTTP web seed');
  assert.equal(handlerFor(web), null);
  const rtc = new FakeWire(sim);
  torrent.addWire(rtc);
  assert.ok(rtc._ext.mw_chain1, 'registered synchronously from the wire event');
  assert.equal(handlerFor(rtc).extName, 'mw_chain1');
  detach();
  assert.equal(torrent.listenerCount('wire'), 0);
  assert.throws(() => attachToTorrent(null, gossip), TypeError);
});

test('a wire joins the gossip only after the remote advertises mw_chain1; earlier messages are ignored', async () => {
  const sim = new Sim();
  const { owner, G } = await world();
  const A = await makeNode(sim, { name: 'A', owner: owner.pub, blocks: [G] });
  const B = await makeNode(sim, { name: 'B', owner: owner.pub, blocks: [G] });
  const ta = new FakeTorrent();
  const tb = new FakeTorrent();
  try {
    A.attachTorrent(ta);
    B.attachTorrent(tb);
    const [a, b] = pair(sim);
    ta.addWire(a);
    tb.addWire(b);
    // A peer that talks before its extended handshake: ignored and counted.
    const early = encode(MSG.HELLO, { v: 1, site: SITE, owner: owner.pub, n: 1, d: 0, root: B.dag.root(), heads: [G.h] });
    a._onExtended(1, early);
    assert.equal(handlerFor(a).early, 1);
    assert.equal(A.gossip.stats.attached, 0);
    a._sendExtendedHandshake();
    b._sendExtendedHandshake();
    await sim.run(100);
    assert.equal(A.gossip.stats.attached, 1);
    assert.equal(A.peers, 1, 'HELLO exchanged over the extension');
    assert.equal(A.inSyncPeers, 1);
    assert.ok(a.extendedSent.length > 0 && decode(a.extendedSent[0]).type === MSG.HELLO);
    // A client without our extension is never attached.
    const [c, d] = pair(sim, { b: { extensions: false } });
    ta.addWire(c);
    c._sendExtendedHandshake();
    d._sendExtendedHandshake();
    await sim.run(100);
    assert.equal(handlerFor(c).ready, false);
    assert.equal(A.gossip.stats.attached, 1);
    // Closing the wire detaches the peer.
    a.destroy();
    assert.equal(A.gossip.stats.attached, 0);
    assert.equal(B.gossip.stats.attached, 0);
  } finally {
    await A.close();
    await B.close();
  }
});

test('two ChainNodes converge over wires; a later write travels too', async () => {
  const sim = new Sim({ seed: 3 });
  const { owner, G } = await world();
  const A = await makeNode(sim, { name: 'A', owner: owner.pub, identity: await makeIdentity(), blocks: [G] });
  const B = await makeNode(sim, { name: 'B', owner: owner.pub, identity: await makeIdentity(), blocks: [G] });
  const ta = new FakeTorrent();
  const tb = new FakeTorrent();
  try {
    for (let i = 0; i < 10; i++) {
      await A.append('gb', { text: 'a' + i });
      await B.append('gb', { text: 'b' + i });
    }
    A.attachTorrent(ta);
    B.attachTorrent(tb);
    assert.equal(A.attachTorrent(ta), A.attachTorrent(ta), 'attaching the same torrent twice returns the same detach');
    connect(sim, ta, tb);
    assert.ok(await sim.run(10000, () => sameLedger(A, B)));
    const x = await B.put('late', 1);
    assert.ok(await sim.run(5000, () => A.dag.has(x.h)));
  } finally {
    await A.close();
    await B.close();
  }
});

test('another (site, owner) on the wire: the gossip detaches it and the handler drops its messages', async () => {
  const sim = new Sim();
  const w1 = await world();
  const w2 = await world();
  const A = await makeNode(sim, { name: 'A', owner: w1.owner.pub, blocks: [w1.G] });
  const B = await makeNode(sim, { name: 'B', owner: w2.owner.pub, blocks: [w2.G] });
  const ta = new FakeTorrent();
  const tb = new FakeTorrent();
  try {
    A.attachTorrent(ta);
    B.attachTorrent(tb);
    const [a] = connect(sim, ta, tb);
    await sim.run(200);
    const h = handlerFor(a);
    assert.equal(h.attached, false);
    assert.equal(h.dropped, true);
    assert.equal(A.gossip.stats.attached, 0);
    assert.ok(A.gossip.stats.mismatch >= 1);
    const before = A.gossip.stats.in;
    a._onExtended(1, encode(MSG.ANN, { h: [w2.G.h] }));
    assert.equal(A.gossip.stats.in, before, 'nothing reaches the gossip');
    assert.equal(A.dag.has(w2.G.h), false);
  } finally {
    await A.close();
    await B.close();
  }
});

// Code review round 1 (F33): every wire is its own gossip peer (the remote peer id is self-declared,
// so grouping by it let an impostor take over or drop an honest visitor's link); the counts still say
// one visitor.
test('one visitor over the site and the rendezvous swarm: one gossip peer per wire, counted as one visitor; losing one wire keeps the other', async () => {
  const sim = new Sim({ seed: 7 });
  const { owner, G } = await world();
  const A = await makeNode(sim, { name: 'A', owner: owner.pub, identity: await makeIdentity(), blocks: [G] });
  const B = await makeNode(sim, { name: 'B', owner: owner.pub, identity: await makeIdentity(), blocks: [G] });
  const siteA = new FakeTorrent();
  const anchorA = new FakeTorrent();
  const siteB = new FakeTorrent();
  const anchorB = new FakeTorrent();
  const clientA = 'aa'.repeat(20);
  const clientB = 'bb'.repeat(20);
  try {
    for (const t of [siteA, anchorA]) A.attachTorrent(t);
    for (const t of [siteB, anchorB]) B.attachTorrent(t);
    // Each wire knows the remote client's peer id, as after a BitTorrent handshake.
    const [s1, s2] = connect(sim, siteA, siteB, { a: { peerId: clientB }, b: { peerId: clientA } });
    const [x1, x2] = connect(sim, anchorA, anchorB, { a: { peerId: clientB }, b: { peerId: clientA } });
    await sim.run(500);
    assert.equal(A.gossip.stats.attached, 2, 'one gossip peer per wire');
    assert.equal(A.peers, 1, 'one visitor');
    assert.equal(B.peers, 1);
    assert.notEqual(handlerFor(s1).peerId, handlerFor(x1).peerId);
    for (let i = 0; i < 5; i++) await A.append('gb', { i });
    assert.ok(await sim.run(5000, () => sameLedger(A, B)));
    assert.ok(await sim.run(30000, () => A.inSyncPeers >= 1), 'in sync after the next HELLO');
    assert.equal(A.inSyncPeers, 1, 'in sync with one visitor, not two wires');
    // One wire closes: the other one carries on.
    s1.destroy();
    assert.equal(A.gossip.stats.attached, 1);
    assert.equal(A.peers, 1);
    const late = await B.put('after', 1);
    assert.ok(await sim.run(5000, () => A.dag.has(late.h)));
    assert.ok(x2.extendedSent.length > 0 || x1.extendedSent.length > 0);
    x1.destroy();
    assert.equal(A.gossip.stats.attached, 0, 'the last wire closing detaches the visitor');
    assert.equal(B.gossip.stats.attached, 0);
    assert.ok(s2.destroyed && x2.destroyed);
  } finally {
    await A.close();
    await B.close();
  }
});

test('code review round 1: an impostor wire claiming a visitor\'s peer id cannot drop or steal that visitor\'s gossip', async () => {
  const sim = new Sim({ seed: 11 });
  const { owner, G } = await world();
  const other = await world();
  const A = await makeNode(sim, { name: 'A', owner: owner.pub, identity: await makeIdentity(), blocks: [G] });
  const V = await makeNode(sim, { name: 'V', owner: owner.pub, identity: await makeIdentity(), blocks: [G] });
  const X = await makeNode(sim, { name: 'X', owner: other.owner.pub, identity: await makeIdentity(), blocks: [other.G] });
  const siteA = new FakeTorrent();
  const siteV = new FakeTorrent();
  const siteX = new FakeTorrent();
  const victim = 'cc'.repeat(20);
  try {
    A.attachTorrent(siteA);
    V.attachTorrent(siteV);
    X.attachTorrent(siteX);
    const [av] = connect(sim, siteA, siteV, { a: { peerId: victim } });
    await sim.run(300);
    assert.equal(A.peers, 1);
    // X claims V's peer id and answers with another ledger's HELLO (another (site, owner)).
    const [ax] = connect(sim, siteA, siteX, { a: { peerId: victim } });
    await sim.run(500);
    assert.equal(handlerFor(ax).dropped, true, 'the impostor wire is detached');
    assert.equal(handlerFor(av).dropped, false, 'the honest wire is not');
    assert.equal(handlerFor(av).attached, true);
    assert.equal(A.peers, 1, 'still one visitor');
    // The honest wire keeps working both ways: V's write reaches A, A's write reaches V.
    const fromV = await V.append('gb', 'from V');
    assert.ok(await sim.run(5000, () => A.dag.has(fromV.h)), 'V -> A still flows');
    const fromA = await A.append('gb', 'from A');
    assert.ok(await sim.run(5000, () => V.dag.has(fromA.h)), 'A -> V still flows (ANN and HELLO reach V)');
    assert.equal(X.dag.has(fromA.h), false, 'nothing of A reached the impostor');
  } finally {
    await A.close();
    await V.close();
    await X.close();
  }
});

test('late attach: wires that already sent their handshake get a re-sent one; detach and re-bind', async () => {
  const sim = new Sim({ seed: 4 });
  const { owner, G } = await world();
  const A = await makeNode(sim, { name: 'A', owner: owner.pub, blocks: [G] });
  const B = await makeNode(sim, { name: 'B', owner: owner.pub, identity: await makeIdentity(), blocks: [G] });
  const ta = new FakeTorrent();
  const tb = new FakeTorrent();
  try {
    B.attachTorrent(tb);
    // The site torrent was connected before the ledger opened on A's side.
    const [a, b] = pair(sim);
    ta.addWire(a);
    tb.addWire(b);
    a._sendExtendedHandshake();
    b._sendExtendedHandshake();
    await sim.run(50);
    assert.equal(a.peerExtendedMapping.mw_chain1 > 0, true, 'B advertised mw_chain1 before A registered');
    const detachA = A.attachTorrent(ta);
    assert.equal(a.handshakesSent, 2, 'the extended handshake was sent again (additive m)');
    await sim.run(100);
    assert.equal(A.peers, 1);
    assert.equal(B.peers, 1);
    // detach(): the handler is unbound, new wires no longer get the extension.
    detachA();
    assert.equal(A.gossip.stats.attached, 0);
    assert.equal(ta.listenerCount('wire'), 0);
    const [c] = pair(sim);
    ta.addWire(c);
    assert.equal(handlerFor(c), null);
    // A reopened ledger re-binds the handler that stays on the wire.
    await A.close();
    const A2 = await makeNode(sim, { name: 'A2', owner: owner.pub, store: A.store, blocks: null });
    A2.attachTorrent(ta);
    assert.equal(handlerFor(a).gossip, A2.gossip);
    await sim.run(100);
    assert.equal(A2.gossip.stats.attached, 1);
    const y = await B.put('after reopen', 1);
    assert.ok(await sim.run(5000, () => A2.dag.has(y.h)), 'within the announcement jitter (STALK-8) and a round trip');
    await A2.close();
  } finally {
    await A.close();
    await B.close();
  }
});
