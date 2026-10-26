// hub-lane-recent: the recent window of a followed ledger (V03-DESIGN-REVIEW 3.2.2 "Recent-window sync" and
// "Snapshot first", MF-65; INTERFACES v0.3 recent.js). A member keeps the newest 200 posts' blocks plus every
// control block (and the latest checkpoint state when the answering copy pruned to one); blocks whose parents are
// not held are flagged "order not yet checked"; the display state equals the full ledger's state for what the
// window holds, and the control state is the full ledger's (controlExact says when the order of cut-off control
// blocks is not known).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recentWindow, localPeer, syncRecent, viewOf, RecentView, encodeRecentSnapshot, parseRecentSnapshot, loadRecentSnapshot, RECENT_POSTS, windowFromDag } from '../../src/chain/recent.js';
import { isControlOp, isPayloadOp } from '../../src/chain/block.js';
import { ChainNode } from '../../src/chain/node.js';
import { MemoryBlockStore } from '../../src/chain/stores.js';
import { Sim, SITE, makeIdentity, makeNode, storeWith, policy, append, put, tomb, mk, makeCheckpoint } from './chain-net-helpers.mjs';

// A person's site: owner-only writes; the newest posts on top of genesis, keyinfo, a profile, an early kv entry,
// a tombstone of an old post, a policy change and a tombstone among the recent posts.
async function personalLedger({ posts = 300, policyAt = [150], tombAt = [5, 290] } = {}) {
  const owner = await makeIdentity();
  const G = await policy(owner, { writers: 'owner', bits: 16, maxChainBytes: 8388608 }, []);
  const K = await mk(owner, { t: 'keyinfo', rc: 'A'.repeat(43) }, undefined, [G.h]);
  const blocks = [G, K];
  let prev = K.h;
  const add = (b) => {
    blocks.push(b);
    prev = b.h;
    return b;
  };
  add(await mk(owner, { t: 'profile' }, 'Robin', [prev]));
  add(await put(owner, 'about', 'early about text', [prev]));
  const postList = [];
  for (let i = 0; i < posts; i++) {
    postList.push(add(await append(owner, 'mw.post', { text: 'post ' + i }, [prev])));
    if (policyAt.indexOf(i) >= 0) add(await policy(owner, { maxChainBytes: 8388608 + (i + 1) * 1024 }, [prev]));
    if (tombAt.indexOf(i) >= 0 && i >= 1) add(await tomb(owner, postList[i - 1].h, [prev]));
  }
  return { owner, G, blocks, posts: postList };
}

function windowHashes(win) {
  return new Set(win.blocks.map((b) => b.h));
}

test('the window: the newest 200 posts and every block above them, every control block, newest first', async () => {
  const sim = new Sim({ seed: 1 });
  const L = await personalLedger();
  const A = await makeNode(sim, { name: 'A', owner: L.owner.pub, genesisHash: L.G.h, blocks: L.blocks });
  try {
    const win = recentWindow(A);
    assert.equal(win.posts, RECENT_POSTS);
    const F = win.fromDepth;
    const payload = win.blocks.filter((b) => isPayloadOp(b.e.op));
    assert.equal(payload.length, 200, 'a linear ledger: exactly the newest 200 payload blocks');
    assert.ok(payload.every((b) => A.dag.depth(b.h) >= F));
    const controls = A.dag.order().filter((b) => isControlOp(b.e.op));
    const has = windowHashes(win);
    assert.ok(controls.every((b) => has.has(b.h)), 'every control block of the ledger');
    assert.ok(win.blocks.some((b) => isControlOp(b.e.op) && A.dag.depth(b.h) < F), 'control blocks below the window come too');
    for (let i = 1; i < win.blocks.length; i++) {
      const a = win.blocks[i - 1];
      const b = win.blocks[i];
      const upper = (x) => A.dag.depth(x.h) >= F;
      if (upper(a) === upper(b)) assert.ok(A.dag.depth(a.h) >= A.dag.depth(b.h), 'newest first');
    }
    assert.equal(win.truncated, false);
    assert.equal(win.checkpoint, null);
    // fromDepth: blocks at or above it, and still every control block.
    const top = recentWindow(A, { fromDepth: A.dag.maxDepth() - 4 });
    assert.equal(top.blocks.filter((b) => isPayloadOp(b.e.op)).length, 5);
    assert.ok(controls.every((b) => windowHashes(top).has(b.h)));
    // A ledger with fewer posts than the window: all of it.
    const small = await personalLedger({ posts: 30, policyAt: [], tombAt: [] });
    const S = await makeNode(sim, { name: 'S', owner: small.owner.pub, blocks: small.blocks });
    assert.equal(recentWindow(S).blocks.length, small.blocks.length);
    assert.equal(recentWindow(S).fromDepth, 0);
    await S.close();
    // Bounded: the oldest control blocks go first when an answer would exceed maxBlocks.
    const cut = windowFromDag(A.dag, { maxBlocks: 150 });
    assert.equal(cut.blocks.length, 150);
    assert.equal(cut.truncated, true);
  } finally {
    await A.close();
  }
});

test('a value hidden by a moderator tombstone travels as a stub in the window', async () => {
  const sim = new Sim({ seed: 2 });
  const owner = await makeIdentity();
  const mod = await makeIdentity();
  const alice = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0, moderators: [mod.pub] }, []);
  const P = await append(alice, 'gb', { text: 'reported' }, [G.h]);
  const T = await tomb(mod, P.h, [P.h]);
  const A = await makeNode(sim, { name: 'A', owner: owner.pub, blocks: [G, P] });
  try {
    await A.ingest([T], 'mod');
    assert.deepEqual(A.graceList(), [P.h]);
    const win = recentWindow(A);
    assert.equal(win.blocks.find((b) => b.h === P.h).v, undefined);
    assert.equal(JSON.stringify(win).includes('reported'), false);
  } finally {
    await A.close();
  }
});

test('the display state equals the full ledger\'s for the window: the control state and every shown post', async () => {
  const sim = new Sim({ seed: 3 });
  const L = await personalLedger();
  const A = await makeNode(sim, { name: 'A', owner: L.owner.pub, genesisHash: L.G.h, blocks: L.blocks });
  const B = await makeNode(sim, { name: 'B', owner: L.owner.pub, genesisHash: L.G.h });
  try {
    const win = recentWindow(A);
    const has = windowHashes(win);
    const r = await syncRecent(B, localPeer(A, 'A'));
    assert.equal(r.added, win.blocks.length);
    assert.deepEqual(r.rejected, []);
    const view = viewOf(B);
    const d = view.state();
    assert.equal(d.controlExact, true, 'no two order-sensitive control blocks are cut off from each other');
    assert.equal(d.complete, false, 'the window has gaps below it');
    const full = A.snapshot();
    const shown = d.snapshot;
    // The control state is the full ledger's.
    assert.deepEqual(shown.policy, full.policy);
    assert.equal(shown.owner, full.owner);
    assert.deepEqual(shown.keychange, full.keychange);
    assert.equal(d.state.keyinfo.get(L.owner.pub).rc, A.state.keyinfo.get(L.owner.pub).rc);
    // Every post the window holds is shown as the full ledger shows it (tombstoned ones hidden in both).
    const fullPosts = full.lists['mw.post'].filter((x) => has.has(x.h));
    assert.deepEqual(shown.lists['mw.post'], fullPosts);
    assert.equal(fullPosts.length, 199, 'the newest 200 posts less the tombstoned one');
    assert.equal(shown.lists['mw.post'].some((x) => x.v.text === 'post 289'), false, 'hidden by its tombstone');
    // Order not yet checked: only the lowest post of the window and the control blocks cut off below it.
    const lowest = win.blocks.filter((b) => isPayloadOp(b.e.op)).at(-1);
    assert.equal(view.orderChecked(lowest.h), false);
    for (const h of d.unchecked) {
      const b = view.get(h);
      assert.ok(h === lowest.h || isControlOp(b.e.op), 'unchecked: ' + b.e.op.t);
    }
    const newest = win.blocks[0];
    assert.equal(view.orderChecked(newest.h), true);
  } finally {
    await A.close();
    await B.close();
  }
});

test('with a checkpoint the window is exact: S stands for the covered history', async () => {
  const sim = new Sim({ seed: 4 });
  const L = await personalLedger({ posts: 260, policyAt: [20, 40], tombAt: [5] });
  const A = await makeNode(sim, { name: 'A', owner: L.owner.pub, genesisHash: L.G.h, blocks: L.blocks });
  const B = await makeNode(sim, { name: 'B', owner: L.owner.pub, genesisHash: L.G.h });
  try {
    const cp = await makeCheckpoint(L.owner, A);
    await A.ingest([cp.block], 'owner');
    const tail = [];
    let prev = cp.block.h;
    for (let i = 0; i < 30; i++) {
      const b = await append(L.owner, 'mw.post', { text: 'after ' + i }, [prev]);
      tail.push(b);
      prev = b.h;
    }
    await A.ingest(tail, 'owner');
    await A.applyCheckpoint(cp.S);
    const win = recentWindow(A);
    assert.equal(win.checkpoint.snap, cp.snap);
    assert.equal(win.blocks.length, 31, 'the checkpoint and what follows it');
    await syncRecent(B, localPeer(A));
    const d = viewOf(B).state();
    assert.equal(d.complete, true);
    assert.equal(d.controlExact, true);
    assert.equal(d.checkpoint.snap, cp.snap);
    const full = A.snapshot();
    for (const k of ['kv', 'lists', 'profiles', 'policy', 'owner', 'keychange']) assert.deepEqual(d.snapshot[k], full[k], k);
    assert.equal(d.unchecked.size, 0);
    // A tampered S is refused (the view keeps no checkpoint from it).
    const C = await makeNode(sim, { name: 'C', owner: L.owner.pub, genesisHash: L.G.h });
    const bad = JSON.parse(JSON.stringify(win));
    bad.checkpoint.S.state.kv.push(['x', { v: 1, author: L.owner.pub, h: 'cd'.repeat(32), ts: 0 }]);
    const r = await syncRecent(C, { id: 'evil', recent: async () => bad });
    assert.ok(r.rejected.some((x) => x.reason === 'E_SNAP'));
    assert.equal(viewOf(C).checkpoint, null);
    await C.close();
  } finally {
    await A.close();
    await B.close();
  }
});

test('two cut-off policy changes: controlExact is false until their parents arrive', async () => {
  const sim = new Sim({ seed: 5 });
  const L = await personalLedger({ posts: 300, policyAt: [20, 40], tombAt: [] });
  const A = await makeNode(sim, { name: 'A', owner: L.owner.pub, genesisHash: L.G.h, blocks: L.blocks });
  const B = await makeNode(sim, { name: 'B', owner: L.owner.pub, genesisHash: L.G.h });
  try {
    await syncRecent(B, localPeer(A));
    const view = viewOf(B);
    assert.equal(view.state().controlExact, false, 'the order of two cut-off policy blocks is not known');
    // The rest of the history arrives (here in one go): the state is complete and exact.
    const r = await view.add(A.exportBlocks());
    assert.ok(r.added.length > 0);
    const d = view.state();
    assert.equal(d.complete, true);
    assert.equal(d.controlExact, true);
    const full = A.snapshot();
    for (const k of ['kv', 'lists', 'profiles', 'policy', 'owner']) assert.deepEqual(d.snapshot[k], full[k], k);
  } finally {
    await A.close();
    await B.close();
  }
});

test('snapshot first: a recent-window file loads into the view; foreign and forged blocks are refused', async () => {
  const sim = new Sim({ seed: 6 });
  const L = await personalLedger({ posts: 220, policyAt: [], tombAt: [] });
  const A = await makeNode(sim, { name: 'A', owner: L.owner.pub, genesisHash: L.G.h, blocks: L.blocks });
  const B = await makeNode(sim, { name: 'B', owner: L.owner.pub, genesisHash: L.G.h });
  try {
    const file = JSON.parse(JSON.stringify(encodeRecentSnapshot(recentWindow(A), SITE)));
    assert.equal(file[0].mw, 'recent-v1');
    const parsed = parseRecentSnapshot(file);
    assert.equal(parsed.blocks.length, file.length - 1);
    assert.equal(parseRecentSnapshot(file.slice(1)), null, 'an ordinary snapshot is not a window');
    await loadRecentSnapshot(B, file);
    const shown = viewOf(B).state().snapshot.lists['mw.post'];
    assert.equal(shown.length, 200);
    assert.equal(shown.at(-1).v.text, 'post 219');
    // Another ledger's window is refused; so is something that is not a window at all.
    const other = encodeRecentSnapshot(recentWindow(A), 'mw1:someotherledger0000000000000');
    await assert.rejects(loadRecentSnapshot(B, other), (err) => err.code === 'E_INVALID');
    await assert.rejects(loadRecentSnapshot(B, [1, 2]), (err) => err.code === 'E_INVALID');
    // An ordinary import of the same file recognises the header (code review v0.3: a header may carry a checkpoint,
    // applied first); it is not counted as a rejected block.
    const plain = await makeNode(sim, { name: 'P', owner: L.owner.pub, genesisHash: L.G.h });
    const imp = await plain.importSnapshot(file);
    assert.equal(imp.rejected, 0);
    await plain.close();
    // A view refuses forged signatures and blocks of other ledgers.
    const v = new RecentView({ siteId: SITE, genesisOwner: L.owner.pub });
    const good = L.posts[10];
    const forged = Object.assign({}, L.posts[11], { s: good.s });
    const foreign = Object.assign({}, good, { e: Object.assign({}, good.e, { site: SITE + 'x' }) });
    const res = await v.add([good, forged, foreign]);
    assert.deepEqual(res.added, [good.h]);
    assert.deepEqual(res.rejected.map((x) => x.reason).sort(), ['shape', 'sig']);
  } finally {
    await A.close();
    await B.close();
  }
});

test('syncRecent offers the blocks that connect to what the node already holds', async () => {
  const sim = new Sim({ seed: 7 });
  const L = await personalLedger({ posts: 300, policyAt: [], tombAt: [] });
  const A = await makeNode(sim, { name: 'A', owner: L.owner.pub, genesisHash: L.G.h, blocks: L.blocks });
  // B holds the ledger up to post 150 (an earlier visit).
  const upTo = L.blocks.indexOf(L.posts[150]) + 1;
  const B = await makeNode(sim, { name: 'B', owner: L.owner.pub, genesisHash: L.G.h, store: await storeWith(L.blocks.slice(0, upTo)) });
  try {
    await syncRecent(B, localPeer(A));
    assert.equal(B.height, A.height, 'the window connected to what B held');
    assert.equal(B.dag.orphanCount, 0);
    assert.equal(B.dag.root(), A.dag.root());
    // A node that holds nothing gets nothing pushed into its pools; the view keeps the window.
    const C = await makeNode(sim, { name: 'C', owner: L.owner.pub, genesisHash: L.G.h });
    await syncRecent(C, localPeer(A));
    assert.equal(C.height, 0);
    assert.equal(C.dag.orphanCount, 0);
    assert.ok(viewOf(C).size > 200);
    await C.close();
  } finally {
    await A.close();
    await B.close();
  }
});

// ---------------------------------------------------------------------------------------------- code review v0.3: admission

test('code review v0.3: one lane answer of 4,096 blocks by a key without standing changes nothing; the refusals are strikes; the view stays bounded', async () => {
  const sim = new Sim({ seed: 8 });
  const L = await personalLedger({ posts: 220, policyAt: [], tombAt: [] });
  const A = await makeNode(sim, { name: 'A', owner: L.owner.pub, genesisHash: L.G.h, blocks: L.blocks });
  const B = await makeNode(sim, { name: 'B', owner: L.owner.pub, genesisHash: L.G.h });
  try {
    await syncRecent(B, localPeer(A, 'A'));
    const view = viewOf(B);
    const shown = () => view.state().snapshot.lists['mw.post'];
    assert.equal(shown().length, 200);
    const sizeBefore = view.size;
    const stranger = await makeIdentity();
    const top = L.posts.at(-1).h;
    const junk = [];
    for (let i = 0; i < 4096; i++) junk.push(await append(stranger, 'mw.post', { text: 'junk ' + i }, [top], { ts: sim.now() }));
    const r = await view.add(junk);
    assert.deepEqual(r.added, []);
    assert.equal(r.rejected.length, 4096);
    assert.ok(r.rejected.every((x) => x.reason === 'no-effect' && x.strike === true), 'no standing on an owner-only ledger');
    assert.equal(view.size, sizeBefore, 'nothing of it is kept');
    assert.ok(view.size <= view.maxBlocks);
    assert.equal(shown().length, 200);
    assert.equal(shown().at(-1).v.text, 'post 219');
    // Probe p1: junk tombstones (control blocks without standing) are not kept either.
    const tombs = [];
    for (let i = 0; i < 400; i++) tombs.push(await tomb(stranger, junk[i].h, [top]));
    const r2 = await view.add(tombs);
    assert.equal(r2.added.length, 0);
    assert.equal(view.size, sizeBefore);
    // A block claiming a time more than 5 minutes ahead is not kept (and is no strike: a skewed clock is not hostile).
    const ahead = await append(L.owner, 'mw.post', { text: 'from the future' }, [top], { ts: sim.now() + 3600000 });
    const r3 = await view.add([ahead]);
    assert.deepEqual(r3.rejected, [{ h: ahead.h, reason: 'future' }]);
    // The owner's next post is kept.
    const next = await append(L.owner, 'mw.post', { text: 'post 220' }, [top]);
    assert.deepEqual((await view.add([next])).added, [next.h]);
    assert.equal(shown().at(-1).v.text, 'post 220');
  } finally {
    await A.close();
    await B.close();
  }
});

test('code review v0.3: a writer with standing on an open ledger keeps at most maxPerAuthor payload blocks in a view; the owner\'s are never trimmed; trims go by depth, not claimed ts', async () => {
  const owner = await makeIdentity();
  const writer = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const blocks = [G];
  let prev = G.h;
  for (let i = 0; i < 30; i++) {
    const b = await append(owner, 'gb', { text: 'owner ' + i }, [prev]);
    blocks.push(b);
    prev = b.h;
  }
  for (let i = 0; i < 60; i++) {
    // The writer claims an old ts on its newest posts: depth decides what goes, not ts.
    const b = await append(writer, 'gb', { text: 'writer ' + i }, [prev], { ts: Date.UTC(2026, 0, 1) + (60 - i) * 60000 });
    blocks.push(b);
    prev = b.h;
  }
  const view = new RecentView({ siteId: SITE, genesisOwner: owner.pub, maxPerAuthor: 25, maxBlocks: 200 });
  const r = await view.add(blocks);
  assert.equal(r.added.length, blocks.length, 'all have standing');
  const items = view.state().snapshot.lists.gb.map((x) => x.v.text);
  assert.equal(items.filter((t) => t.startsWith('owner')).length, 30);
  const kept = items.filter((t) => t.startsWith('writer'));
  assert.equal(kept.length, 25);
  assert.deepEqual(kept, Array.from({ length: 25 }, (_, i) => 'writer ' + (35 + i)), 'the newest by depth stay');
  // Beyond maxBlocks the oldest payload by depth goes first; the genesis policy stays.
  const small = new RecentView({ siteId: SITE, genesisOwner: owner.pub, maxPerAuthor: 1000, maxBlocks: 40 });
  await small.add(blocks);
  assert.equal(small.size, 40);
  assert.ok(small.has(G.h), 'control blocks with an effect stay');
  assert.equal(small.state().snapshot.lists.gb.at(-1).v.text, 'writer 59');
});

test('code review v0.3: a block whose parent the view lacks waits unjudged (its allow block may still come); without an effect it is trimmed first', async () => {
  const owner = await makeIdentity();
  const bob = await makeIdentity();
  const stranger = await makeIdentity();
  const G = await policy(owner, { writers: 'allow', bits: 0 }, []);
  const A = await mk(owner, { t: 'allow', add: [bob.pub] }, undefined, [G.h]);
  const P = await append(bob, 'gb', { text: 'bob, allowed' }, [A.h]);
  const view = new RecentView({ siteId: SITE, genesisOwner: owner.pub, maxBlocks: 30 });
  await view.add([G]);
  const r1 = await view.add([P]);
  assert.deepEqual(r1.added, [P.h], 'kept: its parent (the allow block) has not arrived');
  assert.equal(view.state().snapshot.lists.gb, undefined, 'not shown yet');
  await view.add([A]);
  assert.deepEqual(view.state().snapshot.lists.gb.map((x) => x.v.text), ['bob, allowed']);
  // Blocks naming parents nobody has are kept unjudged too, but they have no effect: the first to go when the view is full.
  const junk = [];
  for (let i = 0; i < 20; i++) junk.push(await append(stranger, 'gb', { text: 'junk ' + i }, ['ab'.repeat(31) + String(i).padStart(2, '0')]));
  assert.equal((await view.add(junk)).added.length, 20);
  const posts = [];
  let prev = P.h;
  for (let i = 0; i < 20; i++) {
    const b = await append(owner, 'gb', { text: 'owner ' + i }, [prev]);
    posts.push(b);
    prev = b.h;
  }
  await view.add(posts);
  assert.equal(view.size, 30);
  for (const b of posts) assert.ok(view.has(b.h), 'every owner post stays');
  assert.ok(view.has(G.h) && view.has(A.h) && view.has(P.h));
  assert.equal(junk.filter((b) => view.has(b.h)).length, 30 - 23, 'the junk made room');
  // Probe p1: 400 tombstones by a stranger, naming a parent nobody has, on a view capped at 30: bounded, nothing honest lost.
  const tombs = [];
  for (let i = 0; i < 400; i++) tombs.push(await tomb(stranger, posts[i % 20].h, ['cd'.repeat(32)]));
  await view.add(tombs);
  assert.ok(view.size <= 30, 'still bounded: ' + view.size);
  for (const b of posts) assert.ok(view.has(b.h));
  assert.deepEqual(view.state().snapshot.lists.gb.length, 21, 'bob and the 20 owner posts are shown');
});

test('integrator (DS-10): a full window after a truncated one makes the view exact again', async () => {
  const sim = new Sim({ seed: 11 });
  const L = await personalLedger({ posts: 30, policyAt: [], tombAt: [] });
  const A = await makeNode(sim, { name: 'A', owner: L.owner.pub, genesisHash: L.G.h, blocks: L.blocks });
  try {
    const v = new RecentView({ siteId: SITE, genesisOwner: L.owner.pub });
    await v.add([], { truncated: true });
    assert.equal(v.state().controlExact, false, 'a truncated answer: the control order is not known');
    const full = recentWindow(A);
    assert.equal(full.truncated, false);
    await v.add(full.blocks, { truncated: false });
    assert.equal(v.state().controlExact, true, 'the newest, full answer decides');
  } finally {
    await A.close();
  }
});
