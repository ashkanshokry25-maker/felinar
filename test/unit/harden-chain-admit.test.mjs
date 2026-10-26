// harden-chain-admit: the checks before the signature and the freeze group's local admit rules (V03-DESIGN-REVIEW
// 2.5.3 rows "reserved pool", 2.16.4; MF-24, MF-75; U-HD-1, U-LG-3). Admit, writer and fee checks run before ECDSA,
// with a per-wire signature-check budget; live blocks are throttled by their arrival time, never by the ts they
// claim; authors who are not vetted share reservedPool percent of maxChainBytes and get E_CAP beyond it while
// vetted authors still write; writers learn E_LEDGER_FULL at 80 percent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MSG, encode, decode } from '../../src/chain/gossip.js';
import { validateBlock, createBlock } from '../../src/chain/block.js';
import { leadingZeroBits } from '../../src/chain/pow.js';
import { hex } from '../../src/chain/canonical.js';
import { Sim, SITE, T0, makeIdentity, makeNode, storeWith, policy, append, put, mk, rawPeer, sameLedger } from './chain-net-helpers.mjs';
import { ChainNode } from '../../src/chain/node.js';

function countingPool() {
  const pool = {
    calls: 0,
    times: [],
    now: () => 0,
    verifyBlock(b, o) {
      pool.calls++;
      pool.times.push(pool.now());
      return validateBlock(b, o);
    },
  };
  return pool;
}

async function rejects(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, 'expected ' + code + ', got ' + err.code + ': ' + err.message);
    return true;
  });
}

function hello(node, extra) {
  return encode(MSG.HELLO, Object.assign({ v: 1, site: SITE, owner: node.gossip.owner, n: node.height, d: node.dag.maxDepth(), root: node.dag.root(), heads: node.dag.heads() }, extra || {}));
}

async function sendBlocks(node, peerId, blocks) {
  for (let i = 0; i < blocks.length; i += 4) await node.gossip.handle(peerId, encode(MSG.BLOCKS, { b: blocks.slice(i, i + 4) }));
}

test('U-HD-1, MF-75: blocks the policy refuses never reach the signature check (a counter on verify calls)', async () => {
  const sim = new Sim({ seed: 1 });
  const owner = await makeIdentity();
  const G = await policy(owner, { writers: 'owner', bits: 0 }, []);
  const pool = countingPool();
  const C = await makeNode(sim, { name: 'C', owner: owner.pub, blocks: [G], verifierPool: pool, gossipLimits: { unsolicitedRate: 1e9, unsolicitedBurst: 1e9 } });
  try {
    rawPeer(C.gossip, 'F', { decode });
    await C.gossip.handle('F', hello(C));
    // 40 well-signed blocks by throwaway keys on an owner-only site (PEER A4's CPU burn).
    const strangers = [];
    for (let i = 0; i < 40; i++) strangers.push(await put(await makeIdentity(), 'k' + i, i, [G.h]));
    await sendBlocks(C, 'F', strangers);
    assert.equal(pool.calls, 0, 'no signature was checked');
    assert.equal(C.stats.rejected.E_POLICY, 40);
    assert.equal(C.gossip.peerInfo('F').invalid, 0, 'a policy refusal is not a strike');
    // Forged blocks that claim the owner (the policy lets them through): checked, refused as sig, struck.
    const real = await put(owner, 'real', 1, [G.h]);
    const forged = [];
    for (let i = 0; i < 5; i++) forged.push(Object.assign({}, await put(owner, 'f' + i, i, [G.h]), { s: real.s }));
    await sendBlocks(C, 'F', forged.concat([real]));
    assert.equal(pool.calls, 6, 'only the six blocks that passed the policy were checked');
    assert.equal(C.stats.rejected.sig, 5);
    assert.ok(C.dag.has(real.h));
    assert.equal(C.gossip.peerInfo('F').invalid, 5);
  } finally {
    await C.close();
  }
});

test('MF-75: the fee and the hash are checked before the signature as well', async () => {
  const sim = new Sim({ seed: 2 });
  const owner = await makeIdentity();
  const alice = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 8 }, []);
  const pool = countingPool();
  const C = await makeNode(sim, { name: 'C', owner: owner.pub, blocks: [G], verifierPool: pool });
  try {
    // Unpaid: bits 0 under a policy fee of 8.
    const unpaid = await put(alice, 'u', 1, [G.h], { bits: 0 });
    const r1 = await C.ingest([unpaid], 'p');
    assert.deepEqual(r1.rejected, [{ h: unpaid.h, reason: 'E_POLICY' }]);
    // A claimed fee the hash does not carry: 'pow', invalid, found without the signature.
    const paid = await put(alice, 'p', 1, [G.h], { bits: 8 });
    assert.ok(leadingZeroBits(hex.decode(paid.h)) >= 8);
    const e = Object.assign({}, unpaid.e, { bits: 30 });
    const { hashEntry } = await import('../../src/chain/pow.js');
    const fakeFee = { e, h: (await hashEntry(e)).hashHex, s: unpaid.s, v: unpaid.v, z: unpaid.z };
    const r2 = await C.ingest([fakeFee], 'p');
    assert.deepEqual(r2.rejected, [{ h: fakeFee.h, reason: 'pow' }]);
    // A changed field: 'hash'.
    const changed = Object.assign({}, paid, { e: Object.assign({}, paid.e, { seq: paid.e.seq + 1 }) });
    const r3 = await C.ingest([changed], 'p');
    assert.equal(r3.rejected[0].reason, 'hash');
    assert.equal(pool.calls, 0, 'none of the three needed a signature check');
    const r4 = await C.ingest([paid], 'p');
    assert.deepEqual(r4.added, [paid.h]);
    assert.equal(pool.calls, 1);
  } finally {
    await C.close();
  }
});

test('MF-75: a per-wire signature-check budget; blocks over it wait in that peer\'s queue for tick()', async () => {
  const sim = new Sim({ seed: 3 });
  const owner = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const authors = [];
  for (let i = 0; i < 10; i++) authors.push(await makeIdentity());
  const blocks = [];
  for (let i = 0; i < 30; i++) blocks.push(await append(authors[i % 10], 'gb', { i }, [G.h]));
  const pool = countingPool();
  pool.now = sim.now;
  const C = await makeNode(sim, {
    name: 'C', owner: owner.pub, blocks: [G], verifierPool: pool,
    config: { verifyRate: 10, verifyBurst: 10, verifyBusyAt: 5, verifyQueueMax: 24 },
  });
  try {
    rawPeer(C.gossip, 'F', { decode });
    await C.gossip.handle('F', hello(C));
    await sendBlocks(C, 'F', blocks);
    assert.equal(pool.calls, 10, 'the burst');
    assert.equal(C.dag.size, 11);
    assert.equal(C._queueLength('F'), 20, 'the rest wait for their check');
    assert.equal(C.gossip.stats.attached, 1);
    // The gossip asks that peer for nothing more while its queue is long.
    await C.gossip.handle('F', encode(MSG.ANN, { h: [blocks[0].h.replace(/^./, 'f')] }));
    assert.equal(C.gossip.peerInfo('F').asked, 0, 'F is busy: no WANT');
    await sim.run(1000);
    assert.equal(pool.calls, 20);
    await sim.run(1100);
    assert.equal(pool.calls, 30);
    assert.equal(C.dag.size, 31);
    assert.equal(C._queueLength('F'), 0);
    // Never more than the burst plus one second's rate in any second.
    for (let i = 0; i < pool.times.length; i++) {
      const inSecond = pool.times.filter((t) => t >= pool.times[i] && t < pool.times[i] + 1000).length;
      assert.ok(inSecond <= 20, inSecond + ' checks in one second');
    }
    // Over the queue's size: E_BUSY (not invalid, not remembered); the block comes again later.
    const more = [];
    for (let i = 0; i < 40; i++) more.push(await append(authors[i % 10], 'gb', { j: i }, [G.h]));
    await sendBlocks(C, 'F', more);
    assert.ok(C.stats.rejected.E_BUSY > 0);
    assert.equal(C.gossip.peerInfo('F').invalid, 0);
    assert.equal(C._policyRejects.size, 0);
    // Direct ingest by a tool (not a wire) is not budgeted.
    const tool = await makeNode(sim, { name: 'T', owner: owner.pub, blocks: [G], verifierPool: countingPool(), config: { verifyRate: 1, verifyBurst: 1 } });
    const r = await tool.ingest(more, 'pin-tool');
    assert.equal(r.added.length, 40);
    await tool.close();
  } finally {
    await C.close();
  }
});

test('MF-75: live blocks are throttled by arrival time, whatever ts they claim; history is not', async () => {
  const sim = new Sim({ seed: 4 });
  const owner = await makeIdentity();
  const bob = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const C = await makeNode(sim, { name: 'C', owner: owner.pub, blocks: [G], gossipLimits: { unsolicitedRate: 1e9, unsolicitedBurst: 1e9 } });
  try {
    rawPeer(C.gossip, 'F', { decode });
    await C.gossip.handle('F', hello(C));
    // 40 blocks claiming a ts a year back, pushed live: 30 in, then E_RATE (the v0.2.1 rule let all 40 in).
    const yearAgo = T0 - 365 * 86400000;
    const pushed = [];
    let prev = G.h;
    for (let i = 0; i < 40; i++) {
      const b = await put(bob, 'k' + i, i, [prev], { ts: yearAgo });
      pushed.push(b);
      prev = b.h;
    }
    await sendBlocks(C, 'F', pushed);
    assert.equal(C.dag.size, 31);
    assert.equal(C.stats.rejected.E_RATE, 10);
    // History: a node that holds 100 blocks of one author syncs them to a fresh node, unthrottled.
    const carol = await makeIdentity();
    const hist = [G];
    prev = G.h;
    for (let i = 0; i < 100; i++) {
      const b = await append(carol, 'gb', { i }, [prev], { ts: sim.t });
      hist.push(b);
      prev = b.h;
    }
    const A = await makeNode(sim, { name: 'A', owner: owner.pub, blocks: hist });
    const D = await makeNode(sim, { name: 'D', owner: owner.pub, blocks: [G] });
    sim.link(A, D, { latency: 20 });
    assert.ok(await sim.run(30000, () => sameLedger(A, D)), 'the whole history arrived');
    assert.equal(D.stats.rejected.E_RATE || 0, 0);
    await A.close();
    await D.close();
  } finally {
    await C.close();
  }
});

test('U-LG-3: a flood of unvetted authors stops at the reserved pool (E_CAP) while vetted authors still write', async () => {
  const sim = new Sim({ seed: 5 });
  const owner = await makeIdentity();
  const mod = await makeIdentity();
  const listed = await makeIdentity();
  const cap = 65536;
  const G = await policy(owner, { writers: 'open', bits: 0, maxChainBytes: cap, moderators: [mod.pub], allow: [listed.pub] }, []);
  const N = await makeNode(sim, { name: 'N', owner: owner.pub, blocks: [G] });
  try {
    const flood = [];
    for (let i = 0; i < 300; i++) flood.push(await append(await makeIdentity(), 'gb', { text: 's'.repeat(600), i }, [G.h]));
    let added = 0;
    let capped = 0;
    for (let i = 0; i < flood.length; i += 50) {
      const r = await N.ingest(flood.slice(i, i + 50), 'flooder');
      added += r.added.length;
      capped += r.rejected.filter((x) => x.reason === 'E_CAP').length;
    }
    const c = N.capacity();
    assert.equal(c.pool.max, Math.floor(cap * 25 / 100), 'the default reservedPool is 25 percent');
    assert.ok(c.pool.bytes <= c.pool.max, 'pool ' + c.pool.bytes + ' of ' + c.pool.max);
    assert.ok(c.pool.bytes > c.pool.max - 1500, 'and it is full');
    assert.equal(added + capped, 300);
    assert.ok(capped > 250, 'most of the flood is refused: ' + capped);
    assert.equal(c.capReached, false, 'the ledger itself is far from its cap');
    // Remembered while the pool stays full: a peer's INV does not make us fetch the refused blocks again.
    const refused = flood.find((b) => !N.dag.has(b.h));
    assert.equal(N.gossip._skip(refused.h), true);
    // Vetted authors still write: the owner, a moderator, an allow-listed key.
    const vetted = [
      await put(owner, '_notice', 'still open', N.choosePrev()),
      await append(mod, 'gb', { from: 'moderator' }, N.choosePrev()),
      await append(listed, 'gb', { from: 'listed' }, N.choosePrev()),
    ];
    assert.equal((await N.ingest(vetted, 'p')).added.length, 3);
    // An unvetted local write fails early with E_CAP; a listed one succeeds.
    const W = await makeNode(sim, { name: 'W', owner: owner.pub, identity: await makeIdentity(), store: await storeWith(N.exportBlocks()) });
    await rejects(W.append('gb', { text: 'one more' }), 'E_CAP');
    const L = await makeNode(sim, { name: 'L', owner: owner.pub, identity: listed, store: await storeWith(N.exportBlocks()) });
    assert.ok((await L.append('gb', { text: 'vetted writes on' })).h);
    // The owner raises the pool: the remembered refusals are judged again.
    const P = await policy(owner, { reservedPool: 50 }, N.choosePrev());
    assert.deepEqual((await N.ingest([P], 'owner-tool')).added, [P.h]);
    assert.equal(N.capacity().pool.max, Math.floor(cap / 2));
    assert.equal(N.gossip._skip(refused.h), false);
    assert.ok((await N.ingest([refused], 'p')).added.length === 1, 'room again');
    // An ownerless ledger has no vetted authors and no pool.
    const U = await makeNode(sim, { name: 'U', siteId: 'btih:' + 'cd'.repeat(20) });
    assert.equal(U.capacity().pool.max, Infinity);
    await W.close();
    await L.close();
    await U.close();
  } finally {
    await N.close();
  }
});

test('MF-24: writers learn E_LEDGER_FULL at 80 percent; capacity() reports the figures', async () => {
  const sim = new Sim({ seed: 6 });
  const owner = await makeIdentity();
  const listed = await makeIdentity();
  const max = 12000;
  const G = await policy(owner, { writers: 'open', bits: 0, maxChainBytes: max, allow: [listed.pub] }, []);
  const L = await makeNode(sim, { name: 'L', owner: owner.pub, identity: listed, blocks: [G] });
  try {
    const warnings = [];
    let below = 0;
    let before = 0;
    while (L.bytes < max) {
      before = L.bytes;
      await L.append('gb', { text: 'w'.repeat(900) }, { onWarning: (w) => warnings.push({ w, bytes: L.bytes }) });
      if (warnings.length > 0) break;
      below++;
    }
    assert.ok(below > 0, 'no warning while below 80 percent');
    assert.equal(warnings.length, 1);
    const w = warnings[0].w;
    assert.equal(w.code, 'E_LEDGER_FULL');
    assert.equal(w.capacity.full, true);
    assert.ok(before < 0.8 * max && warnings[0].bytes >= 0.8 * max, 'reported at the first write past 80 percent: ' + before + ' -> ' + warnings[0].bytes);
    const cap = L.capacity();
    assert.equal(cap.code, 'E_LEDGER_FULL');
    assert.equal(cap.max, max);
    assert.ok(cap.ratio >= 0.8 && cap.ratio < 1);
    // A vetted writer keeps writing past the cap (warned each time); nothing is refused.
    while (L.bytes < max + 2000) await L.append('gb', { text: 'w'.repeat(900) }, { onWarning: (x) => warnings.push({ w: x }) });
    assert.ok(L.capacity().capReached);
    assert.ok(warnings.every((x) => x.w.code === 'E_LEDGER_FULL'));
    // An unvetted writer is told when the pool (25 percent, 3000 bytes) is 80 percent full.
    const O = await makeNode(sim, { name: 'O', owner: owner.pub, identity: await makeIdentity(), blocks: [await policy(owner, { writers: 'open', bits: 0, maxChainBytes: max }, [])] });
    const ow = [];
    for (let i = 0; i < 3 && ow.length === 0; i++) await O.append('gb', { text: 'u'.repeat(500) }, { onWarning: (x) => ow.push(x) });
    assert.equal(ow.length, 1);
    assert.equal(ow[0].code, 'E_LEDGER_FULL');
    assert.equal(ow[0].capacity.pool.full, true);
    assert.equal(ow[0].capacity.full, false, 'the ledger itself is not');
    await rejects(O.append('gb', { text: 'u'.repeat(500) }), 'E_CAP');
    await O.close();
  } finally {
    await L.close();
  }
});

test('ChainNode.genesis: a person\'s own site minted in the browser with an injected signer (R 3.3, MF-64)', async () => {
  const kp = await makeIdentity();
  const { sign } = await import('../../src/chain/crypto.js');
  let calls = 0;
  const signer = { pub: kp.pub, sign: async (bytes) => { calls++; return sign(kp.privateKey, bytes); } };
  const rc = 'A'.repeat(43);
  const g = await ChainNode.genesis({ signer, keyinfo: { rc }, now: T0 });
  assert.equal(calls, 2, 'the signer signed both blocks; no key was handed over');
  assert.match(g.ledgerId, /^mw1:[A-Za-z0-9_-]{27}$/);
  assert.equal(typeof g.chain, 'string');
  assert.equal(g.blocks.length, 2);
  const [gen, ki] = g.blocks;
  assert.equal(g.gen, gen.h);
  assert.deepEqual(gen.e.prev, []);
  assert.equal(gen.e.op.t, 'policy');
  assert.equal(gen.e.op.writers, 'owner');
  assert.equal(gen.e.op.bits, 16);
  assert.equal(gen.e.op.maxChainBytes, 8388608);
  assert.deepEqual(ki.e.op, { t: 'keyinfo', rc });
  assert.deepEqual(ki.e.prev, [gen.h]);
  for (const b of g.blocks) assert.deepEqual(await validateBlock(b, { site: g.ledgerId }), { ok: true });
  // The ledger id is the pointer's: sha256(owner + "|" + chain).
  const { ledgerIdFor } = await import('../../src/common/pointer.js');
  assert.equal(g.ledgerId, await ledgerIdFor({ sig: 'x', owner: kp.pub, chain: g.chain }, 'example.com'));
  // A node on that ledger takes the blocks; the person posts without a fee.
  const node = await ChainNode.open({ siteId: g.ledgerId, expectedOwner: kp.pub, genesisHash: g.gen, identity: kp, config: { tickMs: 0 } });
  try {
    assert.equal((await node.ingest(g.blocks, 'genesis')).added.length, 2);
    assert.equal(node.role, 'owner');
    const post = await node.append('mw.post', { text: 'hello' });
    assert.equal(post.e.bits, 0);
    assert.equal(node.state.keyinfo.get(kp.pub).rc, rc);
  } finally {
    await node.close();
  }
  // A signer whose signature does not match its key is refused.
  const other = await makeIdentity();
  await rejects(ChainNode.genesis({ signer: { pub: other.pub, sign: (b) => sign(kp.privateKey, b) } }), 'E_IDENTITY');
  await rejects(ChainNode.genesis({ signer: { pub: kp.pub } }), 'E_IDENTITY');
});

test('in one batch, a policy that opens the ledger admits the blocks after it; a ban earlier in the batch still refuses', async () => {
  const sim = new Sim({ seed: 7 });
  const owner = await makeIdentity();
  const bob = await makeIdentity();
  const carol = await makeIdentity();
  const G = await policy(owner, { writers: 'owner', bits: 0 }, []);
  const pool = countingPool();
  const N = await makeNode(sim, { name: 'N', owner: owner.pub, blocks: [G], verifierPool: pool });
  try {
    const open = await policy(owner, { writers: 'open' }, [G.h]);
    const x = await put(bob, 'note', 'hello', [open.h]);
    const r = await N.ingest([open, x], 'p');
    assert.deepEqual(r.added.sort(), [open.h, x.h].sort(), 'judged under the policy that came first');
    assert.equal(N.snapshot().kv.note, 'hello');
    const ban = await mk(owner, { t: 'ban', author: carol.pub }, undefined, [x.h]);
    const y = await put(carol, 'spam', 1, [ban.h]);
    const r2 = await N.ingest([ban, y], 'p');
    assert.deepEqual(r2.added, [ban.h]);
    assert.equal(r2.rejected[0].reason, 'E_BANNED');
  } finally {
    await N.close();
  }
});

test('PEER A8: when the deferred pool is full the peer holding the most entries loses its oldest', async () => {
  const sim = new Sim({ seed: 8 });
  const owner = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const N = await makeNode(sim, { name: 'N', owner: owner.pub, config: { deferMax: 20 } });
  try {
    // A fresh node without the genesis cannot judge writers' blocks yet: it sets them aside.
    const mine = [];
    for (let i = 0; i < 5; i++) mine.push(await put(await makeIdentity(), 'm' + i, i, [G.h]));
    assert.equal((await N.ingest(mine, 'honest')).deferred.length, 5);
    const sybil = [];
    for (let i = 0; i < 60; i++) sybil.push(await put(await makeIdentity(), 's' + i, i, [G.h]));
    for (let i = 0; i < sybil.length; i += 10) await N.ingest(sybil.slice(i, i + 10), 'sybil');
    const left = Array.from(N._deferred.values());
    assert.equal(left.length, 20);
    assert.equal(left.filter((d) => d.peerId === 'honest').length, 5, 'the honest peer kept its entries');
    assert.equal(left.filter((d) => d.peerId === 'sybil').length, 15, 'the flood evicted its own oldest');
    // The genesis arrives: what was set aside is checked (it waited unverified) and judged again.
    const r = await N.ingest([G], 'host');
    assert.equal(r.added.length, 21);
    for (const b of mine) assert.ok(N.dag.has(b.h));
  } finally {
    await N.close();
  }
});

test('admit at the heads sees the whole state: a recover rotation is accepted, a second keyinfo is refused', async () => {
  const sim = new Sim({ seed: 9 });
  const { rotateSigningInput } = await import('../../src/chain/block.js');
  const { sign, sha256 } = await import('../../src/chain/crypto.js');
  const { b64url, utf8 } = await import('../../src/chain/canonical.js');
  const owner = await makeIdentity();
  const alice = await makeIdentity();
  const recover = await makeIdentity();
  const next = await makeIdentity();
  const G = await policy(owner, { writers: 'allow', allow: [alice.pub], bits: 0 }, []);
  const rc = b64url.encode(await sha256(utf8.encode(recover.pub)));
  const K = await mk(alice, { t: 'keyinfo', rc }, undefined, [G.h]);
  const N = await makeNode(sim, { name: 'N', owner: owner.pub, blocks: [G, K] });
  try {
    assert.equal(N.state.keyinfo.get(alice.pub).rc, rc);
    const again = await mk(alice, { t: 'keyinfo', rc: 'A'.repeat(43) }, undefined, [K.h]);
    const r1 = await N.ingest([again], 'p');
    assert.deepEqual(r1.rejected, [{ h: again.h, reason: 'E_POLICY' }], 'the first keyinfo per author stands');
    const rsig = b64url.encode(await sign(recover.privateKey, utf8.encode(rotateSigningInput(N.siteId, alice.pub, next.pub))));
    const R = await mk(next, { t: 'rotate', from: alice.pub, next: next.pub, by: 'recover', rp: recover.pub, rsig }, undefined, [K.h]);
    const r2 = await N.ingest([R], 'p');
    assert.deepEqual(r2.added, [R.h], 'the recover proof checks against keyinfo in the state');
    // next inherits alice's place on the allow list.
    const post = await append(next, 'gb', { from: 'next' }, [R.h]);
    assert.deepEqual((await N.ingest([post], 'p')).added, [post.h]);
  } finally {
    await N.close();
  }
});
