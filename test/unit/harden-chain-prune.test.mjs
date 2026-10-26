// harden-chain-prune: checkpoint storage and the moderator tombstone grace (V03-DESIGN-REVIEW 2.5.3 rows
// "checkpoint" and "moderator tombstone grace"; MF-26, MF-29). stores.js applies a checkpoint: it keeps S, drops
// the causal past (stubs included) and the node then accepts later blocks naming covered parents; a fresh copy
// may start from S with the checkpoint block when the pointer's owner signed it. A moderator tombstone hides a
// value at once and deletes it after 24 h (local time, a virtual clock here) unless the target is on the _deny/
// P0 path, so a late revocation can show it again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MSG, decode, helloBoundsOk } from '../../src/chain/gossip.js';
import { MemoryBlockStore, IdbBlockStore, dbNameFor } from '../../src/chain/stores.js';
import { checkpointSnap } from '../../src/chain/state.js';
import { denyIdOf, ChainNode } from '../../src/chain/node.js';
import {
  Sim, SITE, makeIdentity, makeNode, storeWith, policy, append, put, tomb, mk, rawPeer, makeCheckpoint, FakeIndexedDB,
} from './chain-net-helpers.mjs';

const DAY = 86400000;

function contentOf(node) {
  const s = node.snapshot();
  return JSON.stringify({ kv: s.kv, lists: s.lists, profiles: s.profiles, policy: s.policy, owner: s.owner });
}

async function ledgerWithHistory() {
  const owner = await makeIdentity();
  const alice = await makeIdentity();
  const bob = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const blocks = [G];
  let prev = G.h;
  const posts = [];
  for (let i = 0; i < 20; i++) {
    const b = await append(alice, 'gb', { text: 'post ' + i }, [prev]);
    blocks.push(b);
    posts.push(b);
    prev = b.h;
  }
  const T = await tomb(owner, posts[3].h, [prev]); // leaves a stub behind
  blocks.push(T);
  prev = T.h;
  const motd = await put(owner, 'motd', 'before the checkpoint', [prev]);
  blocks.push(motd);
  return { owner, alice, bob, G, blocks, posts, T, last: motd };
}

test('a checkpoint applied in storage: S kept, the causal past (stubs included) gone; later blocks naming covered parents are accepted; reopen keeps it', async () => {
  const sim = new Sim({ seed: 1 });
  const w = await ledgerWithHistory();
  const store = await storeWith(w.blocks);
  const N = await makeNode(sim, { name: 'N', owner: w.owner.pub, store });
  try {
    // A block bob wrote on another copy before the checkpoint, on top of post 10 (it reaches N late).
    const late = await append(w.bob, 'gb', { text: 'late reply' }, [w.posts[10].h]);
    const cp = await makeCheckpoint(w.owner, N);
    assert.deepEqual((await N.ingest([cp.block], 'owner-tool')).added, [cp.block.h]);
    assert.equal(N.state.checkpoint.h, cp.block.h, 'in effect');
    const before = contentOf(N);
    const height = N.height;
    const r = await N.applyCheckpoint(cp.S);
    assert.equal(r.h, cp.block.h);
    assert.equal(r.dropped, w.blocks.length, 'every covered block left memory, the stub of post 3 included');
    assert.equal(N.height, height - w.blocks.length);
    assert.equal(N.dag.coveredCount, w.blocks.length);
    assert.equal(contentOf(N), before, 'the same state from S');
    const rows = (await store.getAll()).map((b) => b.h);
    assert.deepEqual(rows, [cp.block.h], 'the store keeps only what is not covered');
    const kept = await store.getCheckpoint();
    assert.equal(kept.h, cp.block.h);
    assert.equal(kept.snap, cp.snap);
    assert.equal(checkpointSnap(kept.S), cp.snap);
    // HELLO counts what the checkpoint covers (d < n + c).
    const P = rawPeer(N.gossip, 'P', { decode });
    const hello = P.of(MSG.HELLO).at(-1).obj;
    assert.equal(hello.c, w.blocks.length);
    assert.equal(helloBoundsOk(hello), true);
    // The late block names a covered parent: accepted as if the parent were held.
    const rl = await N.ingest([late], 'peer');
    assert.deepEqual(rl.added, [late.h]);
    assert.ok(N.snapshot().lists.gb.some((x) => x.v.text === 'late reply'));
    // Covered blocks offered again (by a full copy) are duplicates, never stored again.
    const again = await N.ingest(w.blocks.slice(0, 5), 'full-peer');
    assert.equal(again.added.length, 0);
    assert.equal(again.duplicates.length, 5);
    assert.equal(N.gossip._held(w.posts[0].h), true, 'a covered hash is never WANTed');
    // Reopen: the node prunes to the stored S before it loads the rest.
    const after = contentOf(N);
    await N.close();
    const R = await makeNode(sim, { name: 'R', owner: w.owner.pub, store });
    assert.equal(R.dag.coveredCount, w.blocks.length);
    assert.equal(R.height, 2);
    assert.equal(contentOf(R), after);
    assert.equal(R.state.checkpoint.h, cp.block.h);
    await R.close();
  } finally {
    await N.close();
  }
});

test('IdbBlockStore applies the checkpoint in one transaction (strict fake IndexedDB) and reopens pruned', async () => {
  const sim = new Sim({ seed: 2 });
  const w = await ledgerWithHistory();
  const idb = new FakeIndexedDB();
  const open = async (name) => {
    const store = new IdbBlockStore({ indexedDB: idb, metaDelayMs: 1, doc: null });
    return makeNode(sim, { name, owner: w.owner.pub, store });
  };
  const N = await open('N');
  try {
    assert.equal((await N.ingest(w.blocks, 'seed')).added.length, w.blocks.length);
    const cp = await makeCheckpoint(w.owner, N);
    await N.ingest([cp.block], 'owner-tool');
    await N.applyCheckpoint(cp.S);
    const rows = idb.rows(dbNameFor(SITE), 'blocks');
    assert.deepEqual(Array.from(rows.keys()), [cp.block.h]);
    const meta = idb.rows(dbNameFor(SITE), 'meta');
    assert.equal(meta.get('checkpoint').snap, cp.snap);
    const content = contentOf(N);
    await N.close();
    const R = await open('R');
    assert.equal(R.dag.coveredCount, w.blocks.length);
    assert.equal(contentOf(R), content);
    await R.close();
  } finally {
    await N.close();
  }
});

test('a fresh copy starts from S with the checkpoint block (anchored to the pointer\'s owner); forged anchors are refused', async () => {
  const sim = new Sim({ seed: 3 });
  const w = await ledgerWithHistory();
  const N = await makeNode(sim, { name: 'N', owner: w.owner.pub, blocks: w.blocks });
  const F = await makeNode(sim, { name: 'F', owner: w.owner.pub });
  try {
    const cp = await makeCheckpoint(w.owner, N);
    await N.ingest([cp.block], 'owner-tool');
    const after = [];
    let prev = cp.block.h;
    for (let i = 0; i < 5; i++) {
      const b = await append(w.alice, 'gb', { text: 'after ' + i }, [prev]);
      after.push(b);
      prev = b.h;
    }
    await N.ingest(after, 'peer');
    // Without the block, a copy that has no checkpoint in effect refuses S.
    await assert.rejects(F.applyCheckpoint(cp.S), (err) => err.code === 'E_SNAP');
    // S that does not match the block's snap.
    const tampered = JSON.parse(JSON.stringify(cp.S));
    tampered.state.kv.push(['injected', { v: 1, author: w.alice.pub, h: 'ab'.repeat(32), ts: 0 }]);
    await assert.rejects(F.applyCheckpoint(tampered, { block: cp.block }), (err) => err.code === 'E_SNAP');
    // A checkpoint block signed by someone else than the owner.
    const byAlice = await mk(w.alice, cp.block.e.op, undefined, cp.block.e.prev);
    await assert.rejects(F.applyCheckpoint(cp.S, { block: byAlice }), (err) => err.code === 'E_SNAP');
    // A pointer that names another owner does not trust this one.
    const other = await makeIdentity();
    const X = await ChainNode.open({
      siteId: SITE, expectedOwner: other.pub, ledgerOwner: w.owner.pub, store: new MemoryBlockStore(),
      now: sim.now, setTimeoutFn: sim.setTimeout, clearTimeoutFn: sim.clearTimeout,
    });
    assert.equal(X.genesisOwner, w.owner.pub);
    await assert.rejects(X.applyCheckpoint(cp.S, { block: cp.block }), (err) => err.code === 'E_SNAP' && /trusts/.test(err.message));
    await X.close();
    // The real one: F takes S, the block, then the later blocks, and reaches N's state.
    const r = await F.applyCheckpoint(cp.S, { block: cp.block });
    assert.equal(r.h, cp.block.h);
    assert.equal(F.dag.has(cp.block.h), true);
    assert.deepEqual((await F.ingest(after, 'peer')).added.length, 5);
    await N.applyCheckpoint(cp.S);
    assert.equal(contentOf(F), contentOf(N));
    assert.equal(F.dag.root(), N.dag.root(), 'the same blocks above the checkpoint');
  } finally {
    await N.close();
    await F.close();
  }
});

async function moderated() {
  const owner = await makeIdentity();
  const mod = await makeIdentity();
  const alice = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0, moderators: [mod.pub] }, []);
  return { owner, mod, alice, G };
}

test('MF-29: a moderator tombstone hides the value at once and deletes it after 24 h (local time, virtual clock)', async () => {
  const sim = new Sim({ seed: 4 });
  const { owner, mod, alice, G } = await moderated();
  const P1 = await append(alice, 'gb', { text: 'first' }, [G.h]);
  const store = await storeWith([G, P1]);
  const N = await makeNode(sim, { name: 'N', owner: owner.pub, store });
  try {
    // The moderator backdates its tombstone by a year: the grace counts from when N saw it.
    const T1 = await tomb(mod, P1.h, [P1.h], { ts: sim.t - 365 * DAY - (sim.t % 60000) });
    assert.deepEqual((await N.ingest([T1], 'mod')).added, [T1.h]);
    assert.deepEqual(N.snapshot().lists.gb || [], [], 'hidden at once');
    assert.deepEqual(N.graceList(), [P1.h]);
    assert.deepEqual(N.dag.get(P1.h).v, { text: 'first' }, 'kept in memory');
    assert.deepEqual((await store.getAll()).find((b) => b.h === P1.h).v, { text: 'first' }, 'and in the store');
    assert.equal(N.exportBlocks().find((b) => b.h === P1.h).v, undefined, 'never exported');
    sim.t += 23 * 3600000;
    await N.tick();
    assert.deepEqual(N.graceList(), [P1.h], 'still kept after 23 h');
    sim.t += 3600000 + 1000;
    await N.tick();
    assert.deepEqual(N.graceList(), []);
    assert.equal(N.dag.get(P1.h).v, undefined, 'deleted after 24 h');
    assert.equal((await store.getAll()).find((b) => b.h === P1.h).v, undefined, 'from the store too');
    assert.equal(N.stats.graceExpired, 1);
  } finally {
    await N.close();
  }
});

test('MF-29: a revocation within the grace shows the value again; the grace survives a reopen', async () => {
  const sim = new Sim({ seed: 5 });
  const { owner, mod, alice, G } = await moderated();
  const P = await append(alice, 'gb', { text: 'kept' }, [G.h]);
  const store = await storeWith([G, P]);
  const N = await makeNode(sim, { name: 'N', owner: owner.pub, store, config: { metaMs: 1 } });
  try {
    const T = await tomb(mod, P.h, [P.h]);
    await N.ingest([T], 'mod');
    const first = sim.t;
    assert.deepEqual(N.graceList(), [P.h]);
    // Reopen 10 h later: the grace start is the stored one.
    await sim.run(10);
    await N.close();
    sim.t = first + 10 * 3600000;
    const R = await makeNode(sim, { name: 'R', owner: owner.pub, store, config: { metaMs: 1 } });
    assert.deepEqual(R.graceList(), [P.h]);
    assert.equal(R._grace.get(P.h), first, 'counted from the first sighting');
    // The owner voids the moderator's actions (the key was stolen): the value is shown again.
    const V = await policy(owner, { voided: [{ author: mod.pub, after: G.h }] }, [T.h]);
    assert.deepEqual((await R.ingest([V], 'owner-tool')).added, [V.h]);
    assert.deepEqual(R.snapshot().lists.gb.map((x) => x.v.text), ['kept'], 'restored');
    assert.deepEqual(R.graceList(), []);
    sim.t = first + 30 * 3600000;
    await R.tick();
    assert.deepEqual(R.dag.get(P.h).v, { text: 'kept' }, 'never deleted');
    await R.close();
  } finally {
    await N.close();
  }
});

test('MF-29: no grace on the P0 path (_deny/ by content hash or by ref), for the author\'s or the owner\'s own tombstone, or for a banned author', async () => {
  const sim = new Sim({ seed: 6 });
  const { owner, mod, alice, G } = await moderated();
  const ih = 'ab'.repeat(20);
  const R1 = await append(alice, 'mw.files', { ih, len: 1000, name: 'a.bin', mime: 'application/octet-stream', t: 1 }, [G.h]);
  const R2 = await append(alice, 'gb', { text: 'reported' }, [G.h]);
  const R3 = await append(alice, 'gb', { text: 'spam' }, [G.h]);
  const R4 = await append(alice, 'gb', { text: 'own delete' }, [G.h]);
  const R5 = await append(alice, 'gb', { text: 'owner delete' }, [G.h]);
  const N = await makeNode(sim, { name: 'N', owner: owner.pub, blocks: [G, R1, R2, R3, R4, R5] });
  try {
    const heads = () => N.choosePrev();
    // P0 by the content hash of the listing's infohash, in the same moderator step as the tombstone.
    const D1 = await put(mod, '_deny/' + denyIdOf(ih), { by: mod.pub, t: 1, reason: 'P0' }, heads());
    const T1 = await tomb(mod, R1.h, [D1.h]);
    await N.ingest([D1, T1], 'mod');
    assert.equal(N.dag.get(R1.h).v, undefined, 'deleted at once');
    // P0 by ref, arriving after the tombstone: the value in grace is deleted when the entry arrives.
    const T2 = await tomb(mod, R2.h, heads());
    await N.ingest([T2], 'mod');
    assert.ok(N.graceList().includes(R2.h));
    const D2 = await put(mod, '_deny/' + denyIdOf('report-17'), { by: mod.pub, t: 2, reason: 'P0', ref: R2.h }, heads());
    await N.ingest([D2], 'mod');
    assert.equal(N.dag.get(R2.h).v, undefined, 'deleted once the P0 entry names it');
    assert.equal(N.graceList().includes(R2.h), false);
    // Another reason keeps the grace.
    const D3 = await put(mod, '_deny/' + denyIdOf('spam-1'), { by: mod.pub, t: 3, reason: 'spam', ref: R3.h }, heads());
    const T3 = await tomb(mod, R3.h, [D3.h]);
    await N.ingest([D3, T3], 'mod');
    assert.ok(N.graceList().includes(R3.h), 'spam waits out the grace');
    // The author's own tombstone, and the owner's: at once.
    const T4 = await tomb(alice, R4.h, heads());
    await N.ingest([T4], 'alice');
    assert.equal(N.dag.get(R4.h).v, undefined);
    const T5 = await tomb(owner, R5.h, heads());
    await N.ingest([T5], 'owner');
    assert.equal(N.dag.get(R5.h).v, undefined);
    // A moderator tombstone of a post whose author the owner banned: the ban drops it at once.
    const bob = await makeIdentity();
    const B1 = await append(bob, 'gb', { text: 'bob' }, heads());
    await N.ingest([B1], 'bob');
    const Tb = await tomb(mod, B1.h, heads());
    const ban = await mk(owner, { t: 'ban', author: bob.pub }, undefined, [Tb.h]);
    await N.ingest([Tb, ban], 'owner');
    assert.equal(N.dag.get(B1.h).v, undefined);
    assert.deepEqual(N.graceList(), [R3.h]);
  } finally {
    await N.close();
  }
});
