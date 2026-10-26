// chain-net: ChainNode (ARCHITECTURE 6.3, 6.7, 6.8; DESIGN-REVIEW items 1 to 4, S2, S9). Store
// loading and write-through, ingest validation reasons, the control-state check at the local
// heads with exempt parents, the ingress throttle, the cap, prev selection, PoW bits by role,
// roles, the owner-mismatch flag, subscribe reasons, export/import, a policy switch seen by two
// nodes, bans and tombstone permissions, the ownerless ledger, and close().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChainNode, topoSort } from '../../src/chain/node.js';
import { MemoryBlockStore } from '../../src/chain/stores.js';
import { MSG, decode } from '../../src/chain/gossip.js';
import { createBlock, blockBytes, redact } from '../../src/chain/block.js';
import { leadingZeroBits } from '../../src/chain/pow.js';
import { hex } from '../../src/chain/canonical.js';
import {
  Sim, SITE, T0, makeIdentity, makeNode, storeWith, mk, policy, append, put, tomb, ban, succession, sameLedger, NO_JITTER,
} from './chain-net-helpers.mjs';

async function ledger(fields = {}) {
  const owner = await makeIdentity();
  const G = await policy(owner, Object.assign({ writers: 'open', bits: 0 }, fields), []);
  return { owner, G };
}

async function rejects(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, 'expected ' + code + ', got ' + err.code + ': ' + err.message);
    return true;
  });
}

test('open loads the store (tombstoned values dropped there too); writes are stored before they resolve and before ANN', async () => {
  const sim = new Sim();
  const { owner, G } = await ledger();
  const alice = await makeIdentity();
  const p1 = await append(alice, 'gb', { text: 'one' }, [G.h]);
  const p2 = await append(alice, 'gb', { text: 'two' }, [p1.h]);
  const T = await tomb(owner, p1.h, [p2.h]);
  const store = await storeWith([T, p2, G, p1]); // any order
  const node = await makeNode(sim, { name: 'N', owner: owner.pub, identity: alice, store, gossipLimits: NO_JITTER });
  const reasons = [];
  node.subscribe((snap, info) => reasons.push(info.reason));
  try {
    assert.equal(node.height, 4);
    assert.deepEqual(node.snapshot().lists.gb.map((x) => x.v.text), ['two']);
    assert.ok(node.state.tombstoned.has(p1.h));
    assert.equal((await store.getAll()).find((b) => b.h === p1.h).v, undefined, 'the stored copy lost its value');
    await sim.run(10);
    assert.deepEqual(reasons, ['load']);
    // Write-through: the block is in the store before put() resolves and before it is announced.
    const events = [];
    const putMany = store.putMany.bind(store);
    store.putMany = async (rows) => {
      await putMany(rows);
      events.push('stored ' + rows.map((r) => r.h).join(','));
    };
    node.gossip.attach({ id: 'P', send: (u8) => { const m = decode(u8); if (m.type === MSG.ANN) events.push('ann ' + m.obj.h.join(',')); } });
    const b = await node.append('gb', { text: 'three' });
    assert.ok((await store.getAll()).some((x) => x.h === b.h));
    assert.deepEqual(events, ['stored ' + b.h, 'ann ' + b.h]);
    assert.deepEqual(reasons, ['load', 'local']);
    // del(k) is put(k, null).
    await node.put('k', 1);
    await node.del('k');
    assert.equal(node.snapshot().kv.k, undefined);
    // A second node on the same store sees the same ledger.
    await node.close();
    const again = await makeNode(sim, { name: 'N2', owner: owner.pub, store });
    assert.equal(again.dag.root(), node.dag.root());
    assert.deepEqual(again.snapshot(), node.snapshot());
    await again.close();
  } finally {
    await node.close();
  }
});

test('ingest: every rejection reason; rejected blocks are neither stored nor announced', async () => {
  const sim = new Sim();
  const { owner, G } = await ledger({ maxValueBytes: 100 });
  const alice = await makeIdentity();
  const node = await makeNode(sim, { name: 'N', owner: owner.pub, blocks: [G] });
  const announced = [];
  node.gossip.attach({ id: 'P', send: (u8) => { const m = decode(u8); if (m.type === MSG.ANN) announced.push(...m.obj.h); } });
  try {
    const good = await append(alice, 'gb', { ok: 1 }, [G.h]);
    const unsent = await append(alice, 'gb', { ok: 0 }, [G.h]);
    const badHash = Object.assign({}, unsent, { e: Object.assign({}, unsent.e, { seq: unsent.e.seq + 1 }) });
    const other = await append(alice, 'gb', { ok: 2 }, [G.h]);
    const badSig = Object.assign({}, other, { s: good.s });
    const badValue = Object.assign({}, await append(alice, 'gb', { ok: 3 }, [G.h]), { v: { ok: 4 } });
    const wrongSite = await mk(alice, { t: 'put', k: 'x' }, 1, [G.h], { site: SITE + 'x' });
    const strangerRoot = await policy(alice, { writers: 'open' }, []);
    const noPow = await createBlock({ identity: alice, site: SITE, seq: 1, prev: [G.h], op: { t: 'put', k: 'p' }, value: 1, ts: T0, bits: 0 });
    const fakePow = Object.assign({}, noPow, { e: Object.assign({}, noPow.e, { bits: 30 }) });
    const tooBig = await append(alice, 'gb', { text: 'x'.repeat(200) }, [G.h]);
    const res = await node.ingest([good, badHash, badSig, badValue, wrongSite, strangerRoot, fakePow, tooBig, 'junk', null], 'P');
    const reasons = Object.fromEntries(res.rejected.map((r) => [r.h, r.reason]));
    assert.deepEqual(res.added, [good.h]);
    assert.equal(reasons[badHash.h], 'hash');
    assert.equal(reasons[badSig.h], 'sig');
    assert.equal(reasons[badValue.h], 'value-hash');
    assert.equal(reasons[wrongSite.h], 'shape');
    assert.equal(reasons[strangerRoot.h], 'root');
    assert.equal(reasons[fakePow.h], 'hash', 'a changed bits field changes h');
    assert.equal(reasons[tooBig.h], 'E_LIMIT', 'a value over the policy maxValueBytes is a policy refusal');
    assert.equal(res.rejected.filter((r) => r.h === null).length, 2, 'non-blocks are rejected as shape');
    assert.equal(node.height, 2);
    assert.deepEqual((await node.store.getAll()).map((b) => b.h).sort(), [G.h, good.h].sort());
    await sim.run(1);
    assert.deepEqual(announced, [], 'blocks from P are not announced back to P');
    assert.equal(node.stats.rejected.sig, 1);
    // Duplicates are reported, not re-added.
    const dup = await node.ingest([good], 'P');
    assert.deepEqual(dup.added, []);
    assert.deepEqual(dup.duplicates, [good.h]);
  } finally {
    await node.close();
  }
});

test('control-state check at the local heads; a parent WANTed for a held orphan is exempt', async () => {
  const sim = new Sim();
  const { owner, G } = await ledger();
  const bob = await makeIdentity();
  // x is a stranger's write concurrent with the owner closing the ledger (P).
  const x = await put(bob, 'note', 'concurrent', [G.h]);
  const P = await policy(owner, { writers: 'owner' }, [G.h]);
  const node = await makeNode(sim, { name: 'N', owner: owner.pub, blocks: [G, P] });
  try {
    const r1 = await node.ingest([x], 'peer1');
    assert.deepEqual(r1.rejected, [{ h: x.h, reason: 'E_POLICY' }]);
    assert.equal(node.dag.has(x.h), false);
    // The owner had seen x before writing O: O arrives first (an orphan), then x as its parent.
    const O = await put(owner, 'motd', 'hello', [P.h, x.h].sort());
    const r2 = await node.ingest([O], 'peer2');
    assert.deepEqual(r2.orphans, [O.h]);
    const r3 = await node.ingest([x], 'peer2');
    assert.deepEqual(r3.added, [x.h, O.h], 'x is exempt as a parent of a held orphan; O connects');
    assert.equal(node.snapshot().kv.note, undefined, 'x stays a no-op: P governs it');
    assert.equal(node.snapshot().kv.motd, 'hello');
    // A stranger's later write is refused at the heads.
    const y = await put(bob, 'note', 'later', node.dag.heads());
    const r4 = await node.ingest([y], 'peer1');
    assert.equal(r4.rejected[0].reason, 'E_POLICY');
  } finally {
    await node.close();
  }
});

test('blocks refused without their parents are set aside and judged again when the parents arrive', async () => {
  const sim = new Sim();
  const { owner, G } = await ledger();
  const bob = await makeIdentity();
  const b1 = await put(bob, 'a', 1, [G.h]);
  const b2 = await put(bob, 'b', 2, [b1.h]);
  const fresh = await makeNode(sim, { name: 'F', owner: owner.pub });
  try {
    // A fresh node without the genesis judges b2 under the default policy (owner only).
    const r1 = await fresh.ingest([b2], 'p');
    assert.deepEqual(r1.deferred, [b2.h]);
    assert.deepEqual(r1.rejected, []);
    assert.equal(fresh.gossip._held(b2.h), true, 'counted as held by the gossip');
    const r2 = await fresh.ingest([G, b1], 'p');
    assert.deepEqual(r2.added.sort(), [G.h, b1.h, b2.h].sort());
    assert.equal(fresh.snapshot().kv.b, 2);
    assert.equal(fresh.stats.deferred, 1);
  } finally {
    await fresh.close();
  }
});

// v0.3 (MF-75): the throttle counts live blocks by their arrival time here; the ts a block claims no
// longer exempts it. History (sync answers, parents, snapshots, a direct ingest without { live: true })
// is not counted.
test('ingress throttle: 30 live blocks per author per 10 min by arrival; never remembered; owner and history exempt', async () => {
  const sim = new Sim();
  const { owner, G } = await ledger();
  const bob = await makeIdentity();
  const carol = await makeIdentity();
  const node = await makeNode(sim, { name: 'N', owner: owner.pub, blocks: [G] });
  try {
    const chain = [];
    let prev = G.h;
    for (let i = 0; i < 31; i++) {
      const b = await put(bob, 'k' + i, i, [prev], { ts: T0 });
      chain.push(b);
      prev = b.h;
    }
    const r1 = await node.ingest(chain, 'p', { live: true });
    assert.equal(r1.added.length, 30);
    assert.deepEqual(r1.rejected, [{ h: chain[30].h, reason: 'E_RATE' }]);
    assert.equal(node._policyRejects.has(chain[30].h), false, 'rate refusals are never remembered');
    const again = await node.ingest([chain[30]], 'p', { live: true });
    assert.equal(again.rejected[0].reason, 'E_RATE', 'still inside the window');
    await sim.run(600001);
    const r2 = await node.ingest([chain[30]], 'p', { live: true });
    assert.deepEqual(r2.added, [chain[30].h], 'accepted once the window has passed');
    // A claimed ts an hour back is counted all the same when the blocks arrive live.
    const backdated = [];
    prev = G.h;
    for (let i = 0; i < 40; i++) {
      const b = await put(carol, 'h' + i, i, [prev], { ts: T0 - 3600000 });
      backdated.push(b);
      prev = b.h;
    }
    const live = await node.ingest(backdated.slice(0, 31), 'p', { live: true });
    assert.equal(live.added.length, 30);
    assert.equal(live.rejected[0].reason, 'E_RATE');
    // History (here: a direct ingest without { live: true }) and the owner are not throttled.
    assert.equal((await node.ingest(backdated.slice(30), 'p')).added.length, 10);
    const own = [];
    prev = G.h;
    for (let i = 0; i < 40; i++) {
      const b = await put(owner, 'o' + i, i, [prev], { ts: sim.t });
      own.push(b);
      prev = b.h;
    }
    assert.equal((await node.ingest(own, 'p', { live: true })).added.length, 40);
    // Local writes hit the same throttle (an early E_RATE).
    const dave = await makeIdentity();
    const writer = await makeNode(sim, { name: 'W', owner: owner.pub, identity: dave, blocks: [G] });
    for (let i = 0; i < 30; i++) await writer.put('w' + i, i);
    await rejects(writer.put('w30', 30), 'E_RATE');
    await writer.close();
  } finally {
    await node.close();
  }
});

// v0.3: authors who are not vetted stop at the reserved pool (25 percent) long before the cap, so the
// cap is reached here by an allow-listed writer; a moderator tombstone frees its bytes only after its
// 24 h grace (MF-29), an owner tombstone at once.
test('cap: past maxChainBytes only owner, moderator and allow-listed blocks get in; free parent chains stop at the cap', async () => {
  const sim = new Sim();
  const mod = await makeIdentity();
  const listed = await makeIdentity();
  const bob = await makeIdentity();
  const { owner, G } = await ledger({ maxChainBytes: 8000, moderators: [mod.pub], allow: [listed.pub] });
  const N = await makeNode(sim, { name: 'N', owner: owner.pub, identity: listed, blocks: [G] });
  const M = await makeNode(sim, { name: 'M', owner: owner.pub, identity: mod, blocks: [G] });
  const O = await makeNode(sim, { name: 'O', owner: owner.pub, identity: owner, blocks: [G] });
  try {
    while (N.bytes < 8000) await N.append('gb', { text: 'y'.repeat(1500) });
    assert.ok(N.snapshot().capReached);
    const strangerBlock = await append(bob, 'gb', { s: 1 }, N.dag.heads(), { ts: T0 - 3600000 });
    const r1 = await N.ingest([strangerBlock], 'p');
    assert.equal(r1.rejected[0].reason, 'E_CAP');
    assert.equal(N._policyRejects.has(strangerBlock.h), false, 'cap refusals are never remembered');
    const fromMod = await append(mod, 'gb', { m: 1 }, N.dag.heads());
    const fromListed = await append(listed, 'gb', { l: 1 }, N.dag.heads(), { ts: T0 - 3600000 });
    const fromOwner = await put(owner, '_notice', 'full', N.dag.heads());
    const r2 = await N.ingest([fromMod, fromListed, fromOwner], 'p');
    assert.equal(r2.added.length, 3);
    // A moderator's node writes past the cap with bits 0; moderation frees space once the grace is over.
    await M.ingest(N.exportBlocks(), 'n');
    assert.ok(M.snapshot().capReached);
    const victims = M.snapshot().lists.gb.filter((x) => x.author === listed.pub).slice(0, 3).map((x) => x.h);
    for (const h of victims) assert.equal((await M.tombstone(h)).e.bits, 0);
    await N.ingest(M.exportBlocks(), 'm');
    for (const h of victims) assert.equal(N.snapshot().lists.gb.some((x) => x.h === h), false, 'hidden at once');
    assert.ok(N.bytes >= 8000, 'the values wait out the 24 h grace: ' + N.bytes);
    assert.deepEqual(N.graceList().sort(), victims.slice().sort());
    sim.t += 86400000;
    N.tick();
    assert.ok(N.bytes < 8000, 'below the cap after the grace: ' + N.bytes);
    assert.equal(N.snapshot().capReached, false);
    assert.ok((await N.append('gb', { text: 'room again' })).h);
    // The owner's tombstone frees space at once.
    await O.ingest(N.exportBlocks(), 'n');
    const before = O.bytes;
    const big = O.snapshot().lists.gb.find((x) => x.author === listed.pub && x.v.text.length >= 1500).h;
    await O.tombstone(big);
    assert.ok(O.bytes < before, 'no grace for an owner tombstone');
    // A stranger's admitted orphan cannot pull a chain of zero-PoW parents past the cap (here the pool).
    const S = await makeNode(sim, { name: 'S', owner: owner.pub, blocks: [await policy(owner, { writers: 'open', bits: 6, maxChainBytes: 6000 }, [])] });
    const G2 = S.dag.order()[0];
    const free = [];
    let prev = G2.h;
    for (let i = 0; i < 40; i++) {
      const b = await append(bob, 'gb', { text: 'z'.repeat(200) + i }, [prev], { ts: T0 - 3600000 });
      free.push(b);
      prev = b.h;
    }
    const paid = await append(bob, 'gb', { text: 'paid' }, [prev], { ts: T0 - 3600000, bits: 6 });
    assert.ok(leadingZeroBits(hex.decode(paid.h)) >= 6);
    assert.deepEqual((await S.ingest([paid], 'p')).orphans, [paid.h]);
    for (let i = free.length - 1; i >= 0; i--) await S.ingest([free[i]], 'p');
    assert.ok(S.bytes <= 6000 + 400, 'stopped at the cap: ' + S.bytes);
    assert.ok(S.capacity().pool.bytes <= S.capacity().pool.max, 'and at the reserved pool');
    // Review round (MP-6): a free parent that would wait for parents of its own is refused (E_POLICY), so the
    // paid orphan carries no chain at all here; the cap stays the bound behind it.
    assert.ok((S.stats.rejected.E_POLICY || 0) + (S.stats.rejected.E_CAP || 0) > 0);
    assert.equal(free.filter((b) => S.dag.has(b.h)).length, 0, 'no zero-fee block hangs below the paid one');
    await S.close();
  } finally {
    await N.close();
    await M.close();
    await O.close();
  }
});

test('prev selection (S9): own last block, the deepest head, then the oldest heads; at most 8, sorted', async () => {
  const sim = new Sim();
  const { owner, G } = await ledger();
  const alice = await makeIdentity();
  const bob = await makeIdentity();
  const a1 = await put(bob, 'a1', 1, [G.h]);
  const a2 = await put(bob, 'a2', 2, [a1.h]);
  const mine = await put(alice, 'mine', 1, [G.h]);
  const wide = [];
  for (let i = 0; i < 10; i++) wide.push(await put(bob, 'w' + i, i, [G.h]));
  const node = await makeNode(sim, { name: 'N', owner: owner.pub, identity: alice, blocks: [G, a1, a2, mine, ...wide] });
  try {
    const prev = node.choosePrev();
    assert.equal(prev.length, 8);
    assert.deepEqual(prev, prev.slice().sort());
    assert.ok(prev.indexOf(mine.h) >= 0, 'own last block');
    assert.ok(prev.indexOf(a2.h) >= 0, 'the deepest head');
    const heads = node.dag.heads({ limit: Infinity });
    for (const h of prev) assert.ok(heads.indexOf(h) >= 0 || h === mine.h);
    const b = await node.put('next', 1);
    assert.deepEqual(b.e.prev, prev);
    assert.equal(b.e.seq, mine.e.seq + 1, 'seq follows the author\'s highest seq (informational)');
    assert.equal(b.e.ts % 60000, 0, 'ts rounded to the minute');
    // 12 heads, at most 8 per block: the remaining 4 are picked up by the next write.
    const left = node.dag.heads({ limit: Infinity });
    assert.equal(left.length, 5);
    assert.ok(left.indexOf(b.h) >= 0);
    const c = await node.put('merge', 1);
    assert.deepEqual(c.e.prev, left.slice().sort());
    assert.deepEqual(node.dag.heads({ limit: Infinity }), [c.h], 'two writes merged every head');
  } finally {
    await node.close();
  }
});

test('PoW bits: owner and moderators write with 0; writers with max(minBits, policy bits)', async () => {
  const sim = new Sim();
  const mod = await makeIdentity();
  const alice = await makeIdentity();
  const { owner, G } = await ledger({ bits: 4, moderators: [mod.pub] });
  const cfg = { minBits: 6 };
  const O = await makeNode(sim, { name: 'O', owner: owner.pub, identity: owner, blocks: [G], config: cfg });
  const M = await makeNode(sim, { name: 'M', owner: owner.pub, identity: mod, blocks: [G], config: cfg });
  const W = await makeNode(sim, { name: 'W', owner: owner.pub, identity: alice, blocks: [G], config: cfg });
  try {
    assert.equal((await O.put('o', 1)).e.bits, 0);
    assert.equal((await M.put('_m', 1)).e.bits, 0, 'moderators may write _ keys');
    const w = await W.put('w', 1);
    assert.equal(w.e.bits, 6);
    assert.ok(leadingZeroBits(hex.decode(w.h)) >= 6);
    await rejects(W.put('_w', 1), 'E_NOT_MODERATOR');
    // A remote writer block with the policy's bits but below minBits is refused here.
    const weak = await put(alice, 'weak', 1, [G.h], { bits: 4 });
    assert.equal((await W.ingest([weak], 'p')).rejected[0].reason, 'E_POLICY');
  } finally {
    for (const n of [O, M, W]) await n.close();
  }
});

test('roles, the owner-mismatch flag and the ownerless (unmoderated) ledger', async () => {
  const sim = new Sim();
  const mod = await makeIdentity();
  const alice = await makeIdentity();
  const next = await makeIdentity();
  const { owner, G } = await ledger({ moderators: [mod.pub] });
  const roleOf = async (identity, blocks, extra = {}) => {
    const n = await makeNode(sim, Object.assign({ name: 'R', owner: owner.pub, identity, blocks }, extra));
    const r = n.role;
    await n.close();
    return r;
  };
  assert.equal(await roleOf(owner, [G]), 'owner');
  assert.equal(await roleOf(mod, [G]), 'moderator');
  assert.equal(await roleOf(alice, [G]), 'writer');
  assert.equal(await roleOf(null, [G]), 'reader');
  const closed = await policy(owner, { writers: 'owner' }, [G.h]);
  assert.equal(await roleOf(alice, [G, closed]), 'reader');
  const banned = await ban(mod, alice.pub, [G.h]);
  assert.equal(await roleOf(alice, [G, banned]), 'reader');
  // The pointer names the new owner, the ledger has not seen the succession yet.
  const S = await succession(owner, next.pub, [G.h]);
  const N = await makeNode(sim, { name: 'N', owner: next.pub, genesisHash: G.h, blocks: [G] });
  try {
    assert.equal(N.genesisOwner, owner.pub, 'gen= names the genesis; its author owns the ledger');
    assert.equal(N.owner, owner.pub);
    assert.equal(N.ownerMismatch, true);
    await N.ingest([S], 'p');
    assert.equal(N.owner, next.pub);
    assert.equal(N.ownerMismatch, false);
    assert.equal(N.unmoderated, false);
  } finally {
    await N.close();
  }
  const stale = await makeNode(sim, { name: 'T', owner: owner.pub, blocks: [G, S] });
  assert.equal(stale.ownerMismatch, true, 'an older pointer after a succession');
  await stale.close();
  // Unsigned pointer: btih: ledger, no owner, anyone writes with the default fee (16 bits).
  const site = 'btih:' + 'ab'.repeat(20);
  const U = await makeNode(sim, { name: 'U', siteId: site, identity: alice });
  try {
    assert.equal(U.unmoderated, true);
    assert.equal(U.owner, null);
    assert.equal(U.role, 'writer');
    const b = await U.append('gb', { text: 'first' });
    assert.deepEqual(b.e.prev, [], 'anyone creates the root of an ownerless ledger');
    assert.equal(b.e.bits, 16);
    assert.equal(U.snapshot().lists.gb.length, 1);
  } finally {
    await U.close();
  }
});

test('subscribe: reasons load, local, remote (coalesced), snapshot; unsubscribe; a throwing subscriber is isolated', async () => {
  const sim = new Sim();
  const { owner, G } = await ledger();
  const alice = await makeIdentity();
  const bob = await makeIdentity();
  const node = await makeNode(sim, { name: 'N', owner: owner.pub, identity: alice, blocks: [G] });
  const seen = [];
  node.subscribe(() => { throw new Error('subscriber bug'); });
  const off = node.subscribe((snap, info) => seen.push([info.reason, snap.height]));
  try {
    await sim.run(10);
    assert.deepEqual(seen, [['load', 1]]);
    await node.put('a', 1);
    assert.deepEqual(seen.at(-1), ['local', 2]);
    const r1 = await put(bob, 'b', 1, [G.h]);
    const r2 = await put(bob, 'c', 1, [r1.h]);
    await node.ingest([r1], 'p');
    await node.ingest([r2], 'p');
    assert.equal(seen.length, 2, 'remote changes are coalesced');
    await sim.run(300);
    assert.deepEqual(seen.at(-1), ['remote', 4]);
    assert.equal(seen.filter((s) => s[0] === 'remote').length, 1);
    const other = await makeNode(sim, { name: 'O', owner: owner.pub, blocks: [G] });
    const r3 = await put(bob, 'd', 1, [G.h]);
    await other.ingest([r3], 'p');
    const res = await node.importSnapshot(other.exportBlocks());
    assert.equal(res.added, 1);
    assert.deepEqual(seen.at(-1), ['snapshot', 5]);
    await other.close();
    off();
    await node.put('e', 1);
    assert.equal(seen.at(-1)[1], 5, 'no calls after unsubscribe');
  } finally {
    await node.close();
  }
});

test('export/import: JSON round trip, shuffled input, invalid entries, another site', async () => {
  const sim = new Sim();
  const mod = await makeIdentity();
  const { owner, G } = await ledger({ moderators: [mod.pub] });
  const alice = await makeIdentity();
  const bob = await makeIdentity();
  const A = await makeNode(sim, { name: 'A', owner: owner.pub, identity: alice, blocks: [G] });
  const M = await makeNode(sim, { name: 'M', owner: owner.pub, identity: mod, blocks: [G] });
  const B = await makeNode(sim, { name: 'B', owner: owner.pub });
  try {
    const posts = [];
    for (let i = 0; i < 6; i++) posts.push(await A.append('gb', { i }));
    await A.profile('Alice');
    await A.put('k', { deep: [1, 2, { x: null }] });
    const bobPost = await append(bob, 'gb', { spam: true }, A.dag.heads());
    await A.ingest([bobPost], 'p');
    await M.ingest(A.exportBlocks(), 'a');
    await M.tombstone(posts[2].h);
    await M.ban(bob.pub);
    await A.ingest(M.exportBlocks(), 'm');
    // v0.3 (MF-29): the moderator tombstone hides the value at once; A keeps it for the 24 h grace.
    assert.notEqual(A.dag.get(posts[2].h).v, undefined);
    sim.t += 86400000;
    A.tick();
    assert.equal(A.dag.get(posts[2].h).v, undefined, 'deleted after the grace');
    const exported = JSON.parse(JSON.stringify(A.exportBlocks()));
    assert.equal(exported.length, A.height);
    assert.equal(exported.find((b) => b.h === posts[2].h).v, undefined, 'tombstoned payloads export without v');
    assert.equal(exported.find((b) => b.h === bobPost.h).v, undefined, 'and banned ones');
    const shuffled = exported.slice().reverse();
    const forged = Object.assign({}, exported[3], { s: exported[4].s });
    const foreign = await mk(alice, { t: 'put', k: 'x' }, 1, [G.h], { site: SITE + 'x' });
    const res = await B.importSnapshot(shuffled.concat([forged, foreign]));
    assert.equal(res.added, exported.length);
    assert.equal(res.duplicates, 1, 'the forged copy repeats a hash of the snapshot');
    assert.equal(res.rejected, 1, 'the block of another site is rejected');
    assert.ok(sameLedger(A, B), 'same root and state');
    assert.deepEqual(B.exportBlocks(), exported);
    // topoSort keeps independent blocks in input order and puts parents first.
    const order = topoSort(shuffled).map((b) => b.h);
    for (const b of exported) for (const p of b.e.prev) assert.ok(order.indexOf(p) < order.indexOf(b.h));
    await assert.rejects(B.importSnapshot('nope'), TypeError);
  } finally {
    for (const n of [A, M, B]) await n.close();
  }
});

test('policy switch to writers: owner blocks a stranger\'s later write on both nodes', async () => {
  const sim = new Sim({ seed: 31 });
  const { owner, G } = await ledger();
  const bob = await makeIdentity();
  const A = await makeNode(sim, { name: 'A', owner: owner.pub, blocks: [G] });
  const B = await makeNode(sim, { name: 'B', owner: owner.pub, identity: bob, blocks: [G] });
  try {
    sim.link(A, B, { latency: 20 });
    const early = await B.put('note', 'before');
    assert.ok(await sim.run(3000, () => A.dag.has(early.h)));
    const P = await policy(owner, { writers: 'owner' }, A.choosePrev());
    assert.deepEqual((await A.ingest([P], 'owner-tool')).added, [P.h]);
    assert.ok(await sim.run(3000, () => B.dag.has(P.h)));
    assert.equal(B.role, 'reader');
    await rejects(B.put('note', 'after'), 'E_POLICY');
    const direct = await put(bob, 'note', 'after', A.dag.heads());
    assert.equal((await A.ingest([direct], 'B')).rejected[0].reason, 'E_POLICY');
    assert.equal((await B.ingest([direct], 'x')).rejected[0].reason, 'E_POLICY');
    assert.equal(A.snapshot().kv.note, 'before', 'the earlier write (an ancestor of P) still counts');
    assert.ok(await sim.run(3000, () => sameLedger(A, B)));
  } finally {
    await A.close();
    await B.close();
  }
});

test('bans and tombstones: who may issue them, and what happens to values (memory and store)', async () => {
  const sim = new Sim();
  const mod = await makeIdentity();
  const { owner, G } = await ledger({ moderators: [mod.pub] });
  const alice = await makeIdentity();
  const bob = await makeIdentity();
  const A = await makeNode(sim, { name: 'A', owner: owner.pub, identity: alice, blocks: [G] });
  const B = await makeNode(sim, { name: 'B', owner: owner.pub, identity: bob, blocks: [G] });
  const M = await makeNode(sim, { name: 'M', owner: owner.pub, identity: mod, blocks: [G] });
  try {
    sim.link(A, B, { latency: 10 });
    sim.link(A, M, { latency: 10 });
    const a1 = await A.append('gb', { text: 'mine' });
    const a2 = await A.append('gb', { text: 'also mine' });
    const b1 = await B.append('gb', { text: 'bob' });
    assert.ok(await sim.run(3000, () => [A, B, M].every((n) => n.height === 4)));
    await rejects(B.tombstone(a1.h), 'E_NOT_MODERATOR');
    await rejects(B.ban(alice.pub), 'E_NOT_MODERATOR');
    await rejects(A.tombstone(G.h), 'E_POLICY');
    const t1 = await A.tombstone(a1.h);
    assert.ok(t1.h);
    assert.equal(A.dag.get(a1.h).v, undefined);
    assert.equal((await A.store.getAll()).find((b) => b.h === a1.h).v, undefined);
    const t2 = await M.tombstone(a2.h);
    const banBlock = await M.ban(bob.pub);
    assert.ok(t2.h && banBlock.h);
    assert.ok(await sim.run(5000, () => [A, B, M].every((n) => n.dag.has(banBlock.h) && n.dag.has(t2.h))));
    for (const n of [A, B, M]) {
      assert.deepEqual(n.snapshot().lists.gb || [], [], n.name + ' hides every post');
      // Review round (HUB-2): a moderator ban hides at once and keeps the value for the 24 h grace.
      assert.deepEqual(n.dag.get(b1.h).v, { text: 'bob' }, n.name + ' keeps the moderator-banned value for the grace');
      assert.ok(n.graceList().includes(b1.h), n.name + ' lists it in grace');
      assert.deepEqual(n.snapshot().policy.banned, [bob.pub]);
    }
    await rejects(B.append('gb', { text: 'again' }), 'E_BANNED');
    assert.equal(B.role, 'reader');
    assert.ok(await sim.run(3000, () => sameLedger(A, B) && sameLedger(A, M)));
  } finally {
    for (const n of [A, B, M]) await n.close();
  }
});

test('close(): writes and ingests fail with E_CLOSED, timers are cleared, the store is closed', async () => {
  const { owner, G } = await ledger();
  const alice = await makeIdentity();
  const store = new MemoryBlockStore();
  await store.open(SITE);
  await store.putMany([G]);
  // Real timers (unref'd) this time: close() must leave nothing behind.
  const node = await ChainNode.open({ siteId: SITE, expectedOwner: owner.pub, store, identity: alice });
  assert.ok(node._tickTimer !== null, 'the gossip tick runs');
  const b = await node.put('a', 1);
  assert.ok(b.h);
  await node.close();
  assert.equal(node.closed, true);
  assert.equal(node._tickTimer, null);
  assert.equal(node._metaTimer, null);
  assert.equal(node._notifyTimer, null);
  assert.equal(store.closed, true);
  assert.deepEqual((await store.getMeta('state')).n, 2, 'meta flushed on close');
  await rejects(node.put('b', 2), 'E_CLOSED');
  const r = await node.ingest([await put(alice, 'c', 3, [G.h])], 'p');
  assert.equal(r.rejected[0].reason, 'E_CLOSED');
  await node.close(); // idempotent
});

test('verifier pool and miner: blocks are verified through the pool, writes are mined through the miner', async () => {
  const { createVerifierPool } = await import('../../src/chain/verify-pool.js');
  const { createMiner } = await import('../../src/chain/pow-client.js');
  const sim = new Sim();
  const { owner, G } = await ledger({ bits: 6 });
  const alice = await makeIdentity();
  const bob = await makeIdentity();
  const pool = createVerifierPool({ size: 2 });
  const calls = { verify: 0, mine: 0 };
  const countingPool = { verifyBlock: (b, o) => { calls.verify++; return pool.verifyBlock(b, o); } };
  const miner = createMiner();
  const countingMiner = { mine: (e, bits, o) => { calls.mine++; return miner.mine(e, bits, o); } };
  const node = await ChainNode.open({
    siteId: SITE, expectedOwner: owner.pub, store: await storeWith([G]), identity: alice,
    miner: countingMiner, verifierPool: countingPool, now: sim.now, setTimeoutFn: sim.setTimeout, clearTimeoutFn: sim.clearTimeout,
  });
  try {
    const remote = await put(bob, 'r', 1, [G.h], { bits: 6 });
    const forged = Object.assign({}, await put(bob, 'f', 1, [G.h], { bits: 6 }), { s: remote.s });
    const res = await node.ingest([remote, forged], 'p');
    assert.deepEqual(res.added, [remote.h]);
    assert.equal(res.rejected[0].reason, 'sig');
    assert.equal(calls.verify, 2);
    const mine = await node.put('w', 1);
    assert.equal(calls.mine, 1);
    assert.equal(mine.e.bits, 6);
    assert.ok(leadingZeroBits(hex.decode(mine.h)) >= 6);
    // A pool that fails is not the peer's fault: the block is refused as E_VERIFY, not invalid.
    const broken = { verifyBlock: () => Promise.reject(new Error('worker crashed')) };
    const other = await ChainNode.open({ siteId: SITE, expectedOwner: owner.pub, store: await storeWith([G]), verifierPool: broken, now: sim.now, setTimeoutFn: sim.setTimeout, clearTimeoutFn: sim.clearTimeout });
    other.gossip.attach({ id: 'P', send: () => {} });
    await other.gossip.handle('P', (await import('../../src/chain/gossip.js')).encode(MSG.BLOCKS, { b: [remote] }));
    assert.equal(other.stats.rejected.E_VERIFY, 1);
    assert.equal(other.gossip.peerInfo('P').invalid, 0);
    await other.close();
  } finally {
    await node.close();
    pool.destroy();
    miner.destroy();
  }
});

test('salted values (v0.2.1 A1): WANT { v: true } brings v back with z; a value without its salt is refused; tombstones drop z too', async () => {
  const sim = new Sim();
  const { owner, G } = await ledger();
  const alice = await makeIdentity();
  const p1 = await append(alice, 'gb', { text: 'hello' }, [G.h]);
  const p2 = await append(alice, 'gb', { text: 'second' }, [p1.h]);
  assert.ok(typeof p1.z === 'string' && p1.z.length === 22);
  const A = await makeNode(sim, { name: 'A', owner: owner.pub, identity: alice, blocks: [G, p1, p2] });
  // B holds p1 as a stub with no tombstone that explains it, so it asks for the value.
  const B = await makeNode(sim, { name: 'B', owner: owner.pub, blocks: [G, redact(p1)] });
  try {
    assert.equal(B.dag.get(p1.h).v, undefined);
    sim.link(A, B, { latency: 10 });
    assert.ok(await sim.run(10000, () => B.dag.has(p2.h) && B.dag.get(p1.h).v !== undefined), 'B got p2 and the value of p1');
    assert.deepEqual(B.dag.get(p1.h).v, p1.v);
    assert.equal(B.dag.get(p1.h).z, p1.z, 'the value came back with its salt');
    const row = (await B.store.getAll()).find((b) => b.h === p1.h);
    assert.deepEqual([row.v, row.z], [p1.v, p1.z], 'stored with v and z');
    assert.ok(sameLedger(A, B));
    // A value that arrives without its salt is malformed under v0.2.1.
    const p3 = await append(alice, 'gb', { text: 'third' }, [p2.h]);
    const { z: _z, ...unsalted } = p3;
    const res = await B.ingest([unsalted], 'peer-x');
    assert.deepEqual(res.rejected, [{ h: p3.h, reason: 'shape' }]);
    assert.equal(B.dag.has(p3.h), false);
    // A tombstone drops the value and the salt, in memory and in the store.
    const t = await A.tombstone(p1.h);
    assert.ok(t.h);
    assert.equal(A.dag.get(p1.h).v, undefined);
    assert.equal(A.dag.get(p1.h).z, undefined);
    const stub = (await A.store.getAll()).find((b) => b.h === p1.h);
    assert.ok(!('v' in stub) && !('z' in stub), 'the stored stub keeps neither v nor z');
    assert.ok(await sim.run(5000, () => B.dag.has(t.h) && B.dag.get(p1.h).v === undefined));
    assert.equal(B.dag.get(p1.h).z, undefined);
    assert.ok(!('z' in (await B.store.getAll()).find((b) => b.h === p1.h)));
    // exportBlocks carries z with every held value and never for a stub.
    for (const b of A.exportBlocks()) assert.equal(b.z !== undefined, b.v !== undefined, b.h);
  } finally {
    await A.close();
    await B.close();
  }
});

test('the unknown-op rule (v0.2.1 A2): a block with an op v1 does not define is rejected at ingest and never relayed', async () => {
  const sim = new Sim();
  const { owner, G } = await ledger();
  const A = await makeNode(sim, { name: 'A', owner: owner.pub, blocks: [G] });
  const B = await makeNode(sim, { name: 'B', owner: owner.pub, blocks: [G] });
  try {
    sim.link(A, B, { latency: 10 });
    const { hashEntry } = await import('../../src/chain/pow.js');
    const { sign } = await import('../../src/chain/crypto.js');
    const { b64url } = await import('../../src/chain/canonical.js');
    const e = { v: 1, site: SITE, author: owner.pub, seq: 9, prev: [G.h], ts: T0 - 60000, bits: 0, op: { t: 'checkpoint', n: 1, root: G.h }, nonce: '' };
    const { hashHex } = await hashEntry(e);
    const block = { e, h: hashHex, s: b64url.encode(await sign(owner.privateKey, 'mw-block-v1\n' + hashHex)) };
    const res = await A.ingest([block], 'peer-x');
    assert.deepEqual(res.rejected, [{ h: block.h, reason: 'unknown-op' }]);
    assert.equal(A.stats.rejected['unknown-op'], 1);
    assert.equal(A.dag.has(block.h), false);
    assert.equal((await A.store.getAll()).some((b) => b.h === block.h), false, 'not stored');
    await sim.run(3000);
    assert.equal(B.dag.has(block.h), false, 'not relayed');
  } finally {
    await A.close();
    await B.close();
  }
});

test('a local identity stored before v0.2.1 (untagged pub) signs with the tagged key (A2); untagged keys from peers stay invalid', async () => {
  const sim = new Sim();
  const { owner, G } = await ledger();
  const alice = await makeIdentity();
  const legacy = { privateKey: alice.privateKey, pub: alice.pub.slice('p256:'.length) };
  const A = await makeNode(sim, { name: 'A', owner: owner.pub, identity: legacy, blocks: [G] });
  try {
    assert.equal(A.identity.pub, alice.pub, 'the node exposes the tagged spelling');
    const b = await A.append('gb', { text: 'from an old browser' });
    assert.equal(b.e.author, alice.pub);
    assert.equal(A.dag.has(b.h), true);
  } finally {
    await A.close();
  }
});

test('code review round 1: after a hand-over the old key cannot ban, set policy or hand over again, not even as an exempt parent', async () => {
  const sim = new Sim();
  const [k1, k2, k3, visitor] = await Promise.all([makeIdentity(), makeIdentity(), makeIdentity(), makeIdentity()]);
  const G = await policy(k1, { writers: 'open', bits: 0 }, []);
  const V = await append(visitor, 'gb', 'hello', [G.h]);
  const S1 = await succession(k1, k2.pub, [V.h]);
  const E = await policy(k2, {}, [S1.h]); // the new owner's endorsement of S1
  const node = await makeNode(sim, { name: 'A', owner: k2.pub, genesisHash: G.h, blocks: [G, V, S1, E] });
  try {
    assert.equal(node.owner, k2.pub);
    assert.equal(node.ownerConflict, false);
    // The old key on a side branch whose causal past omits S1.
    const P = await policy(k1, { writers: 'owner', moderators: [k3.pub] }, [V.h]);
    const B = await ban(k1, visitor.pub, [P.h]);
    const S2 = await succession(k1, k3.pub, [B.h]);
    const direct = await node.ingest([P], 'evil');
    assert.deepEqual(direct.rejected, [{ h: P.h, reason: 'E_NOT_OWNER' }]);
    const banNow = await node.ingest([await ban(k1, visitor.pub, [V.h])], 'evil');
    assert.equal(banNow.rejected[0].reason, 'E_NOT_MODERATOR');
    // A reply that merged the side branch makes S2, B and P parents WANTed for a held orphan.
    const reply = await append(visitor, 'gb', 'reply', [S2.h, E.h].sort());
    assert.deepEqual((await node.ingest([reply], 'evil')).orphans, [reply.h]);
    await node.ingest([S2], 'evil');
    await node.ingest([B], 'evil');
    const parent = await node.ingest([P], 'evil');
    assert.deepEqual(parent.rejected, [{ h: P.h, reason: 'E_NOT_OWNER' }], 'a revoked key\'s policy is refused even as an exempt parent');
    assert.equal(node.dag.has(P.h) || node.dag.has(B.h) || node.dag.has(S2.h), false, 'nothing of the side branch connected');
    const snap = node.snapshot();
    assert.equal(snap.owner, k2.pub);
    assert.equal(snap.policy.writers, 'open');
    assert.deepEqual(snap.policy.banned, []);
    assert.deepEqual(snap.lists.gb.map((it) => it.v), ['hello'], 'the visitor post keeps its effect');
    assert.equal(node.dag.get(V.h).v, 'hello', 'and its value');
    // The new owner keeps every power.
    const ok = await node.ingest([await policy(k2, { writers: 'owner' }, [E.h])], 'owner');
    assert.equal(ok.added.length, 1);
    assert.equal(node.snapshot().policy.writers, 'owner');
  } finally {
    await node.close();
  }
});

test('code review round 1: a local write the store refuses rejects and leaves nothing behind (DAG, peer, next prev, reopen)', async () => {
  const sim = new Sim();
  const { owner, G } = await ledger();
  const alice = await makeIdentity();
  const store = await storeWith([G]);
  const A = await makeNode(sim, { name: 'A', owner: owner.pub, identity: alice, store });
  const B = await makeNode(sim, { name: 'B', owner: owner.pub, blocks: [G] });
  let again = null;
  try {
    sim.link(A, B, { latency: 10 });
    await sim.run(3000);
    const first = await A.append('gb', { text: 'kept' });
    await sim.run(3000);
    assert.ok(B.dag.has(first.h));
    const sizeA = A.dag.size;
    const snapA = JSON.stringify(A.snapshot());
    const sizeB = B.dag.size;
    const putMany = store.putMany.bind(store);
    let failing = 1;
    let refused = null;
    store.putMany = async (rows) => {
      if (failing > 0) {
        failing--;
        refused = rows.map((r) => r.h);
        const err = new Error('the quota is full');
        err.name = 'QuotaExceededError';
        throw err;
      }
      return putMany(rows);
    };
    await assert.rejects(A.append('gb', { text: 'lost' }), (err) => err.name === 'QuotaExceededError');
    assert.equal(refused.length, 1);
    assert.equal(A.dag.size, sizeA, 'the refused block is not in the DAG');
    assert.equal(A.dag.has(refused[0]) || A.dag.hasOrphan(refused[0]), false);
    assert.equal(JSON.stringify(A.snapshot()), snapA, 'nor in the state');
    assert.equal(A.stats.persistErrors, 1);
    await sim.run(10000); // HELLO rounds and sync sessions
    assert.equal(B.dag.size, sizeB, 'the linked peer never got it');
    assert.equal(B.dag.has(refused[0]), false);
    const next = await A.append('gb', { text: 'retry' });
    assert.equal(next.e.prev.indexOf(refused[0]), -1, 'the next write does not build on the refused block');
    assert.deepEqual(next.e.prev, [first.h]);
    await sim.run(3000);
    assert.ok(B.dag.has(next.h));
    await A.close();
    again = await makeNode(sim, { name: 'A2', owner: owner.pub, store });
    assert.equal(again.dag.size, A.dag.size);
    assert.equal(again.dag.orphanCount, 0, 'no orphan after a reopen');
    assert.deepEqual(again.snapshot().lists.gb.map((x) => x.v.text).sort(), ['kept', 'retry']);
  } finally {
    await A.close();
    await B.close();
    if (again) await again.close();
  }
});

test('code review round 1: remote blocks whose store write failed are written again (next batch, tick, close)', async () => {
  const sim = new Sim();
  const { owner, G } = await ledger();
  const alice = await makeIdentity();
  const store = await storeWith([G]);
  const node = await makeNode(sim, { name: 'N', owner: owner.pub, store, config: { persistRetryMs: 5000 } });
  try {
    const putMany = store.putMany.bind(store);
    let failing = 1;
    store.putMany = async (rows) => {
      if (failing > 0) {
        failing--;
        throw Object.assign(new Error('transient'), { name: 'UnknownError' });
      }
      return putMany(rows);
    };
    const p1 = await append(alice, 'gb', 'one', [G.h]);
    const r1 = await node.ingest([p1], 'peer');
    assert.deepEqual(r1.added, [p1.h], 'a remote block is still accepted');
    assert.equal(node.stats.persistErrors, 1);
    assert.equal((await store.getAll()).some((b) => b.h === p1.h), false);
    // The next batch writes it as well.
    const p2 = await append(alice, 'gb', 'two', [p1.h]);
    await node.ingest([p2], 'peer');
    const rows = (await store.getAll()).map((b) => b.h);
    assert.ok(rows.includes(p1.h) && rows.includes(p2.h), 'the failed row went with the next batch');
    // tick() retries on its own when nothing else arrives.
    failing = 1;
    const p3 = await append(alice, 'gb', 'three', [p2.h]);
    await node.ingest([p3], 'peer');
    assert.equal((await store.getAll()).some((b) => b.h === p3.h), false);
    await sim.run(6000);
    assert.ok((await store.getAll()).some((b) => b.h === p3.h), 'tick() wrote it again');
  } finally {
    await node.close();
  }
});

test('code review round 1: writes report mining progress and a cancelled write is never ingested', async () => {
  const sim = new Sim();
  const { owner, G } = await ledger({ bits: 4 });
  const alice = await makeIdentity();
  let release = null;
  const slowMiner = {
    mine(entry, bits, { signal, onProgress }) {
      return new Promise((resolve, reject) => {
        if (onProgress) onProgress(1000);
        if (onProgress) onProgress(2000);
        const stop = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'E_POW_ABORTED' }));
        if (signal) signal.addEventListener('abort', stop);
        release = async () => {
          const { mine } = await import('../../src/chain/pow.js');
          resolve(await mine(entry, bits));
        };
      });
    },
  };
  const node = await ChainNode.open({
    siteId: SITE, expectedOwner: owner.pub, store: await storeWith([G]), identity: alice, miner: slowMiner,
    now: sim.now, setTimeoutFn: sim.setTimeout, clearTimeoutFn: sim.clearTimeout,
  });
  try {
    // Progress reaches the caller; aborting mid-mining rejects with E_POW_ABORTED.
    const seen = [];
    const ac = new AbortController();
    const p = node.append('gb', 'x', { signal: ac.signal, onProgress: (e) => seen.push(e) });
    while (release === null) await new Promise((r) => setTimeout(r, 1));
    assert.deepEqual(seen, [{ hashes: 1000, bits: 4 }, { hashes: 2000, bits: 4 }]);
    ac.abort();
    await rejects(p, 'E_POW_ABORTED');
    assert.equal(node.height, 1);
    // Aborted after the nonce was found but before ingest: still never stored or published.
    release = null;
    const ac2 = new AbortController();
    const announced = [];
    node.gossip.attach({ id: 'P', send: (u8) => { const m = decode(u8); if (m.type === MSG.ANN) announced.push(...m.obj.h); } });
    const p2 = node.append('gb', 'y', { signal: ac2.signal });
    while (release === null) await new Promise((r) => setTimeout(r, 1));
    const done = release();
    ac2.abort();
    await done;
    await rejects(p2, 'E_POW_ABORTED');
    assert.equal(node.height, 1, 'the cancelled write is not in the ledger');
    assert.deepEqual(announced, []);
    // An already aborted signal fails at once; a write without options still works.
    await rejects(node.append('gb', 'z', { signal: AbortSignal.abort() }), 'E_POW_ABORTED');
    release = null;
    const p3 = node.append('gb', 'ok');
    while (release === null) await new Promise((r) => setTimeout(r, 1));
    await release();
    const b = await p3;
    assert.ok(node.dag.has(b.h));
  } finally {
    await node.close();
  }
});
