// chain-review-round: regression tests for the chain findings of the v0.3 review round (R 5.3;
// .orchestration/reports/all-findings-2026-10-22.json, docs/deviations/review-round-chain.md). Every case drives the real
// ChainNode, Gossip or MultiGossip with signed blocks on the simulator's clock, or the reducer on real blocks, in the
// shape the finding's probe used, and fails on the tree before the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBlock, selfRotateSigningInput } from '../../src/chain/block.js';
import { reduce, admit, schemaOk } from '../../src/chain/state.js';
import { Dag } from '../../src/chain/dag.js';
import { sign, verify } from '../../src/chain/crypto.js';
import { b64url, utf8, hex } from '../../src/chain/canonical.js';
import { sha256Sync } from '../../src/chain/sha256-sync.js';
import { MSG, encode, decode } from '../../src/chain/gossip.js';
import { MultiGossip, LANE_MSG, encodeLane, decodeLane } from '../../src/chain/multi.js';
import { rotateOp } from '../../tools/ledger-admin.mjs';
import {
  Sim, SITE, T0, makeIdentity, makeNode, storeWith, mk, policy, append, put, ban, makeCheckpoint, rawPeer, NO_JITTER,
} from './chain-net-helpers.mjs';

const HOUR = 3600000;
const DAY = 86400000;
const hashOf = (s) => hex.encode(sha256Sync(utf8.encode(String(s))));
const listOf = (node, name) => ((node.snapshot().lists || {})[name] || []).map((it) => it.v.text);
const held = (node, blocks) => blocks.filter((b) => {
  const got = node.dag.get(b.h);
  return got !== undefined && got.v !== undefined;
}).length;
function dagOf(blocks) {
  const dag = new Dag({ maxOrphansPerPeer: 1e6, maxOrphans: 1e6 });
  for (const b of blocks) dag.add(b);
  return dag;
}

// ---------------------------------------------------------------------------------------------- HUB-1, SYB-1

async function banWorld() {
  const owner = await makeIdentity();
  const mod = await makeIdentity();
  const spammer = await makeIdentity();
  const victim = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0, moderators: [mod.pub] }, []);
  const v1 = await append(victim, 'gb', { text: 'v1' }, [G.h]);
  const v2 = await append(victim, 'gb', { text: 'v2' }, [v1.h]);
  const a1 = await append(spammer, 'gb', { text: 'spam' }, [v2.h]);
  const B = await ban(mod, spammer.pub, [a1.h]);
  return { owner, mod, spammer, victim, G, posts: [v1, v2], blocks: [G, v1, v2, a1, B], head: B };
}

test('HUB-1, SYB-1: a banned key\'s self rotation onto a key that never signed it hands over nothing, live or as history', async () => {
  const w = await banWorld();
  const rot = await mk(w.spammer, { t: 'rotate', from: w.spammer.pub, next: w.victim.pub, by: 'self' }, undefined, [w.head.h]);
  assert.deepEqual(await validateBlock(rot, { site: SITE }), { ok: true }, 'still a valid block (it retires the old key)');
  // Live: admit refuses a banned key's rotation.
  const st0 = reduce(dagOf(w.blocks), { genesisOwner: w.owner.pub });
  assert.deepEqual(admit(st0, rot, { dag: dagOf(w.blocks), genesisOwner: w.owner.pub }), { ok: false, code: 'E_BANNED', reason: 'banned' });
  // As history (the reducer): no link, so no ban, no hidden posts, and the victim is not shown as a changed key.
  const st = reduce(dagOf(w.blocks.concat([rot])), { genesisOwner: w.owner.pub });
  assert.equal(st.policy.banned.has(w.victim.pub), false);
  assert.equal(st.redacted.has(w.posts[0].h) || st.redacted.has(w.posts[1].h), false);
  assert.deepEqual((st.lists.get('gb') || []).map((x) => x.v.text), ['v1', 'v2']);
  assert.equal(st.keychange.has(w.victim.pub), false);
  // On a node that takes it as history the victim keeps its posts, their values and its write right.
  const sim = new Sim({ seed: 201 });
  const node = await makeNode(sim, { name: 'N', owner: w.owner.pub, identity: w.victim, store: await storeWith(w.blocks) });
  try {
    await node.ingest([rot], 'peer');
    assert.equal(node.roleOf(w.victim.pub), 'writer');
    assert.equal(held(node, w.posts), 2);
    await node.append('gb', { text: 'v3' });
    assert.deepEqual(listOf(node, 'gb'), ['v1', 'v2', 'v3']);
  } finally {
    await node.close();
  }
});

test('HUB-1: with next\'s nsig the rotation is consensual and next inherits the ban (2.5.3); a wrong nsig is invalid', async () => {
  const w = await banWorld();
  const op = await rotateOp({ by: 'self', from: w.spammer.pub, next: w.victim.pub, ledgerId: SITE, nextKey: w.victim });
  assert.equal(await verify(w.victim.pub, selfRotateSigningInput(SITE, w.spammer.pub, w.victim.pub), op.nsig), true, 'nsig is next\'s signature over the self-rotation input');
  const rot = await mk(w.spammer, op, undefined, [w.head.h]);
  assert.deepEqual(await validateBlock(rot, { site: SITE }), { ok: true });
  const st = reduce(dagOf(w.blocks.concat([rot])), { genesisOwner: w.owner.pub });
  assert.equal(st.policy.banned.has(w.victim.pub), true, 'next agreed, so the family rule applies');
  assert.equal(st.keychange.get(w.victim.pub).from, w.spammer.pub);
  const other = await makeIdentity();
  const forged = await mk(w.spammer, Object.assign({}, op, { nsig: b64url.encode(await sign(other.privateKey, selfRotateSigningInput(SITE, w.spammer.pub, w.victim.pub))) }), undefined, [w.head.h]);
  assert.deepEqual(await validateBlock(forged, { site: SITE }), { ok: false, reason: 'sig' });
  await assert.rejects(rotateOp({ by: 'self', from: w.spammer.pub, next: w.victim.pub, ledgerId: SITE, nextKey: other }), /next-key/);
});

test('HUB-1: aimed at a moderator key, a one-sided rotation leaves the moderator\'s _deny entry and posts in place', async () => {
  const owner = await makeIdentity();
  const mod = await makeIdentity();
  const spammer = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0, moderators: [mod.pub] }, []);
  const deny = '_deny/' + b64url.encode(sha256Sync(utf8.encode('ih')));
  const d = await put(mod, deny, { by: mod.pub, t: 1, reason: 'spam' }, [G.h]);
  const a1 = await append(spammer, 'gb', { text: 'spam' }, [d.h]);
  const B = await ban(owner, spammer.pub, [a1.h]);
  const rot = await mk(spammer, { t: 'rotate', from: spammer.pub, next: mod.pub, by: 'self' }, undefined, [B.h]);
  const st = reduce(dagOf([G, d, a1, B, rot]), { genesisOwner: owner.pub });
  assert.equal(st.kv.has(deny), true, 'the takedown stays');
  assert.equal(st.policy.banned.has(mod.pub), false);
});

// ---------------------------------------------------------------------------------------------- HUB-7, SYB-4

test('HUB-7, SYB-4: a stranger\'s rotate is refused on owner-only and allow ledgers and has no effect as history', async () => {
  for (const fields of [{ writers: 'owner' }, { writers: 'allow', allow: [] }]) {
    const owner = await makeIdentity();
    const stranger = await makeIdentity();
    const next = await makeIdentity();
    const G = await policy(owner, Object.assign({ bits: 0 }, fields), []);
    const op = await rotateOp({ by: 'self', from: stranger.pub, next: next.pub, ledgerId: SITE, nextKey: next });
    const rot = await mk(stranger, op, undefined, [G.h]);
    const st0 = reduce(dagOf([G]), { genesisOwner: owner.pub });
    const verdict = admit(st0, rot, { dag: dagOf([G]), genesisOwner: owner.pub });
    assert.equal(verdict.code, 'E_POLICY', fields.writers);
    const st = reduce(dagOf([G, rot]), { genesisOwner: owner.pub });
    assert.equal(st.rotations.has(stranger.pub), false, fields.writers + ': no effect');
    assert.equal(st.effective.has(rot.h), false);
  }
  // A member of an allow ledger still rotates (with the new key's consent) and the new key writes.
  const owner = await makeIdentity();
  const member = await makeIdentity();
  const next = await makeIdentity();
  const G = await policy(owner, { writers: 'allow', allow: [member.pub], bits: 0 }, []);
  const rot = await mk(member, await rotateOp({ by: 'self', from: member.pub, next: next.pub, ledgerId: SITE, nextKey: next }), undefined, [G.h]);
  const p = await append(next, 'gb', { text: 'new key' }, [rot.h]);
  const st = reduce(dagOf([G, rot, p]), { genesisOwner: owner.pub });
  assert.deepEqual((st.lists.get('gb') || []).map((x) => x.v.text), ['new key']);
});

// ---------------------------------------------------------------------------------------------- HUB-2

async function graceWorld(sim, n) {
  const owner = await makeIdentity();
  const mod = await makeIdentity();
  const authors = [];
  for (let i = 0; i < n; i++) authors.push(await makeIdentity());
  const G = await policy(owner, { writers: 'open', bits: 0, moderators: [mod.pub] }, []);
  const posts = [];
  let prev = G.h;
  for (const a of authors) {
    const b = await append(a, 'gb', { text: 'post ' + posts.length }, [prev]);
    posts.push(b);
    prev = b.h;
  }
  const node = await makeNode(sim, { name: 'N', owner: owner.pub, store: await storeWith([G, ...posts]) });
  return { owner, mod, authors, posts, head: posts[posts.length - 1], node };
}

test('HUB-2: moderator bans and bulk tombstones wait out the 24 h grace (voided restores them); owner bans drop at once', async () => {
  const sim = new Sim({ seed: 202 });
  const w = await graceWorld(sim, 4);
  try {
    const B = await ban(w.mod, w.authors[0].pub, [w.head.h], { ts: sim.now() });
    const bulk = await mk(w.mod, { t: 'tombstone', authors: [w.authors[1].pub, w.authors[2].pub], before: w.head.h }, undefined, [B.h], { ts: sim.now() });
    assert.deepEqual((await w.node.ingest([B, bulk], 'mod', { live: true })).rejected, []);
    assert.deepEqual(listOf(w.node, 'gb'), ['post 3'], 'hidden at once');
    assert.equal(held(w.node, w.posts), 4, 'values kept');
    assert.deepEqual(w.node.graceList().sort(), w.posts.slice(0, 3).map((b) => b.h).sort());
    await sim.run(HOUR);
    assert.equal(held(w.node, w.posts), 4, 'still kept an hour later');
    const V = await policy(w.owner, { moderators: [], voided: [{ author: w.mod.pub, after: w.head.h }] }, [bulk.h], { ts: sim.now() });
    assert.deepEqual((await w.node.ingest([V], 'owner', { live: true })).rejected, []);
    assert.deepEqual(listOf(w.node, 'gb'), ['post 0', 'post 1', 'post 2', 'post 3'], 'voided shows them again, values included');
    assert.equal(w.node.graceList().length, 0);
    // An owner ban: no grace.
    const OB = await ban(w.owner, w.authors[3].pub, [V.h], { ts: sim.now() });
    await w.node.ingest([OB], 'owner', { live: true });
    assert.equal(w.node.dag.get(w.posts[3].h).v, undefined, 'an owner ban drops the value at once');
  } finally {
    await w.node.close();
  }
});

test('HUB-2: without a revocation the moderator-hidden values go after the grace', async () => {
  const sim = new Sim({ seed: 203 });
  const w = await graceWorld(sim, 2);
  try {
    const B = await ban(w.mod, w.authors[0].pub, [w.head.h], { ts: sim.now() });
    await w.node.ingest([B], 'mod', { live: true });
    assert.equal(held(w.node, w.posts), 2);
    sim.t += DAY + 1000;
    w.node.tick();
    await sim.run(2000);
    assert.equal(w.node.dag.get(w.posts[0].h).v, undefined, 'dropped after 24 h');
    assert.equal(held(w.node, w.posts), 1);
  } finally {
    await w.node.close();
  }
});

// ---------------------------------------------------------------------------------------------- HUB-4, SYB-2

test('HUB-4, SYB-2: moderator blocks forked from before the appointment have no standing; after it the hour cap holds', async () => {
  const owner = await makeIdentity();
  const mod = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0 }, [], { ts: T0 - 30 * DAY });
  const writers = [];
  const posts = [];
  let prev = G.h;
  for (let i = 0; i < 12; i++) {
    const wr = await makeIdentity();
    const b = await append(wr, 'gb', { text: 'post ' + i }, [prev], { ts: T0 - 25 * DAY + i * HOUR });
    writers.push(wr);
    posts.push(b);
    prev = b.h;
  }
  const P = await policy(owner, { moderators: [mod.pub], modActionsPerHour: 2 }, [prev], { ts: T0 - HOUR });
  // Old-parent forks (SYB-2 L1a): each ban names an old post as parent and claims that post's hour.
  const forks = [];
  for (let i = 0; i < 12; i++) forks.push(await ban(mod, writers[i].pub, [posts[i].h], { ts: T0 - 25 * DAY + i * HOUR }));
  const st = reduce(dagOf([G, ...posts, P, ...forks]), { genesisOwner: owner.pub });
  assert.equal(st.policy.banned.size, 0, 'none has the appointment in its past');
  // Built on the appointment: capped per hour.
  const after = [];
  for (let i = 0; i < 6; i++) after.push(await ban(mod, writers[i].pub, [P.h], { ts: T0 - HOUR + i * 60000 }));
  const st2 = reduce(dagOf([G, ...posts, P, ...after]), { genesisOwner: owner.pub });
  assert.equal(st2.policy.banned.size, 2, 'modActionsPerHour');
  // admit agrees: a live fork is refused.
  const st3 = reduce(dagOf([G, ...posts, P]), { genesisOwner: owner.pub });
  const live = await ban(mod, writers[0].pub, [posts[11].h], { ts: T0 });
  assert.equal(admit(st3, live, { dag: dagOf([G, ...posts, P]), genesisOwner: owner.pub }).code, 'E_NOT_MODERATOR');
});

test('SYB-2: old parents and old claimed hours give a moderator at most 24 hours (7 days of allow) of actions per epoch', async () => {
  const owner = await makeIdentity();
  const mod = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0, moderators: [mod.pub], modActionsPerHour: 1, modAllowPerDay: 1 }, [], { ts: T0 - 60 * DAY });
  const writers = [];
  const posts = [];
  let prev = G.h;
  for (let i = 0; i < 30; i++) {
    const wr = await makeIdentity();
    const b = await append(wr, 'gb', { text: 'post ' + i }, [prev], { ts: T0 - 50 * DAY + i * DAY });
    writers.push(wr);
    posts.push(b);
    prev = b.h;
  }
  const forks = [];
  for (let i = 0; i < 30; i++) forks.push(await ban(mod, writers[i].pub, [posts[i].h], { ts: T0 - 50 * DAY + i * DAY }));
  const adds = [];
  for (let i = 0; i < 10; i++) adds.push(await mk(mod, { t: 'allow', add: [(await makeIdentity()).pub] }, undefined, [posts[i].h], { ts: T0 - 50 * DAY + i * DAY }));
  const st = reduce(dagOf([G, ...posts, ...forks, ...adds]), { genesisOwner: owner.pub });
  assert.equal(st.policy.banned.size, 24, 'modActionsPerHour x 24 per epoch');
  assert.equal(st.policy.allow.size, 7, 'modAllowPerDay x 7 per epoch');
});

test('HUB-4: after a checkpoint, a moderator block on covered parents takes its hour from the checkpointed past, not its claim', async () => {
  const sim = new Sim({ seed: 204 });
  const owner = await makeIdentity();
  const mod = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0, moderators: [mod.pub], modActionsPerHour: 1 }, [], { ts: T0 - 30 * DAY });
  const writers = [];
  const posts = [];
  let prev = G.h;
  for (let i = 0; i < 6; i++) {
    const wr = await makeIdentity();
    const b = await append(wr, 'gb', { text: 'post ' + i }, [prev], { ts: T0 - HOUR });
    writers.push(wr);
    posts.push(b);
    prev = b.h;
  }
  const node = await makeNode(sim, { name: 'N', owner: owner.pub, store: await storeWith([G, ...posts]) });
  try {
    const cp = await makeCheckpoint(owner, node, { ts: T0 - HOUR });
    assert.deepEqual((await node.ingest([cp.block], 'owner')).rejected, []);
    await node.applyCheckpoint(cp.S);
    assert.equal(node.dag.has(posts[0].h), false, 'pruned');
    const bans = [];
    for (let i = 0; i < 6; i++) bans.push(await ban(mod, writers[i].pub, [posts[i].h], { ts: T0 - 400 * DAY + i * HOUR }));
    await node.ingest(bans, 'sync');
    assert.equal(node.snapshot().policy.banned.length, 1, 'one hour (the newest checkpointed item time), cap 1');
  } finally {
    await node.close();
  }
});

// ---------------------------------------------------------------------------------------------- HUB-6

test('HUB-6: reserved entries written with owner standing stand against moderator puts; a voided moderator\'s puts lose effect', async () => {
  const owner = await makeIdentity();
  const mod = await makeIdentity();
  const mod2 = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0, moderators: [mod.pub, mod2.pub] }, []);
  const DENY = '_deny/' + b64url.encode(sha256Sync(utf8.encode('x')));
  const DENY2 = '_deny/' + b64url.encode(sha256Sync(utf8.encode('y')));
  const d = await put(owner, DENY, { by: owner.pub, t: 1, reason: 'P0' }, [G.h]);
  const c = await put(owner, '_mw.cfg', { chat: 'members' }, [d.h]);
  const md = await put(mod, DENY2, { by: mod.pub, t: 2, reason: 'spam' }, [c.h]);
  const lift = await put(mod, DENY, null, [md.h]);
  const cfg = await put(mod, '_mw.cfg', { chat: 'off' }, [lift.h]);
  const lift2 = await put(mod2, DENY2, null, [cfg.h]);
  const base = [G, d, c, md];
  let st = reduce(dagOf(base.concat([lift, cfg, lift2])), { genesisOwner: owner.pub });
  assert.equal(st.kv.has(DENY), true, 'the owner takedown stands');
  assert.deepEqual(st.kv.get('_mw.cfg').v, { chat: 'members' });
  assert.equal(st.kv.has(DENY2), true, 'a _deny entry changes only by its author or the owner');
  const st0 = reduce(dagOf(base), { genesisOwner: owner.pub });
  assert.deepEqual(admit(st0, lift, { dag: dagOf(base), genesisOwner: owner.pub }), { ok: false, code: 'E_POLICY', reason: 'owner-protected' });
  // The owner replaces its own entry; the moderator lifts its own.
  const oc = await put(owner, '_mw.cfg', { chat: 'off' }, [lift2.h]);
  const own2 = await put(mod, DENY2, null, [oc.h]);
  st = reduce(dagOf(base.concat([lift, cfg, lift2, oc, own2])), { genesisOwner: owner.pub });
  assert.deepEqual(st.kv.get('_mw.cfg').v, { chat: 'off' });
  assert.equal(st.kv.has(DENY2), false);
  // voided reaches a removed moderator's '_' puts.
  const note = await put(mod2, '_notice', 'from mod2', [G.h]);
  const V = await policy(owner, { moderators: [mod.pub], voided: [{ author: mod2.pub, after: G.h }] }, [note.h]);
  st = reduce(dagOf([G, note, V]), { genesisOwner: owner.pub });
  assert.equal(st.kv.has('_notice'), false);
});

// ---------------------------------------------------------------------------------------------- MP-1, MP-2, MP-11

async function gossipWorld(seed) {
  const sim = new Sim({ seed });
  const owner = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const C = await makeNode(sim, { name: 'C', owner: owner.pub, blocks: [G] });
  return { sim, C };
}
const helloOf = (node, extra) => Object.assign({ v: 1, site: SITE, owner: node.gossip.owner, n: 5, d: 3, root: hashOf('their root'), heads: [hashOf('their head')] }, extra || {});

test('MP-1: an INV flood in a sync session is bounded by the peer\'s own HELLO and the session backlog', async () => {
  const { C } = await gossipWorld(205);
  try {
    const F = rawPeer(C.gossip, 'F', { decode });
    await C.gossip.handle('F', encode(MSG.HELLO, helloOf(C, { n: 300000, d: 299999 })));
    assert.ok(C.gossip._peers.get('F').session, 'a session opened');
    const t0 = Date.now();
    for (let f = 0; f < 3000 && C.gossip._peers.get('F').session; f++) {
      const h = Array.from({ length: 200 }, (_, i) => hashOf('flood ' + f + ' ' + i));
      await C.gossip.handle('F', encode(MSG.INV, { k: f % 3, h, more: true }));
    }
    const wants = C.gossip.stats.wants;
    assert.ok(wants <= C.gossip.limits.maxSessionBacklog + C.gossip.limits.maxWants, 'wants: ' + wants);
    assert.ok(Date.now() - t0 < 5000, 'handled in ' + (Date.now() - t0) + ' ms');
    // A peer that lists more than its HELLO's n + c is struck and its session ends.
    const G2 = rawPeer(C.gossip, 'G2', { decode });
    await C.gossip.handle('G2', encode(MSG.HELLO, helloOf(C, { n: 100, d: 99, root: hashOf('g2') })));
    for (let f = 0; f < 3 && C.gossip._peers.get('G2').session; f++) {
      await C.gossip.handle('G2', encode(MSG.INV, { k: 0, h: Array.from({ length: 200 }, (_, i) => hashOf('g2 ' + f + ' ' + i)), more: true }));
    }
    assert.equal(C.gossip._peers.get('G2').session, null, 'the session ended');
    assert.ok(C.gossip._peers.get('G2').invalid >= 1, 'and the peer was struck');
    assert.ok(F.attached && G2.attached);
  } finally {
    await C.close();
  }
});

test('MP-2: fresh roots in every HELLO start at most one sync session per 2 s per peer', async () => {
  const { sim, C } = await gossipWorld(206);
  try {
    const F = rawPeer(C.gossip, 'F', { decode });
    const before = C.gossip.stats.syncs || 0;
    let bytesIn = 0;
    for (let i = 0; i < 300; i++) {
      const frame = encode(MSG.HELLO, helloOf(C, { n: 1000, d: 999, root: hashOf('root ' + i), heads: [hashOf('head ' + i)] }));
      bytesIn += frame.length;
      await C.gossip.handle('F', frame);
      sim.t += 5; // 300 HELLOs in 1.5 s
    }
    const started = (C.gossip.stats.syncs || 0) - before;
    assert.ok(started <= 2, 'sessions started: ' + started);
    const syncBytes = F.frames.filter((u8) => u8[0] === MSG.SYNC).reduce((n, u8) => n + u8.length, 0);
    assert.ok(syncBytes <= 8 * bytesIn, 'SYNC bytes out ' + syncBytes + ' for ' + bytesIn + ' in');
  } finally {
    await C.close();
  }
});

test('MP-11: one peer\'s HELLO heads hold at most 256 wants; another peer\'s ANN still gets one', async () => {
  const { C } = await gossipWorld(207);
  try {
    rawPeer(C.gossip, 'F', { decode });
    rawPeer(C.gossip, 'H', { decode });
    for (let i = 0; i < 1500; i++) {
      const heads = Array.from({ length: 32 }, (_, j) => hashOf('fast ' + i + ' ' + j));
      await C.gossip.handle('F', encode(MSG.HELLO, helloOf(C, { n: 3, d: 1, root: hashOf('r ' + i), heads })));
    }
    assert.ok(C.gossip._peers.get('F').fastWants.size <= 256);
    const fresh = hashOf('honest new block');
    await C.gossip.handle('H', encode(MSG.ANN, { h: [fresh] }));
    assert.ok(C.gossip._wants.has(fresh), 'the honest announcement is wanted');
  } finally {
    await C.close();
  }
});

// ---------------------------------------------------------------------------------------------- MP-6

test('MP-6: one paid orphan carries at most its own free parents, never a tree of them', async () => {
  const sim = new Sim({ seed: 208 });
  const owner = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 6 }, []);
  const S = await makeNode(sim, { name: 'S', owner: owner.pub, blocks: [G] });
  try {
    const bob = await makeIdentity();
    // level 2 (unsent), level 1 names them, the paid root names level 1.
    const level2 = [];
    for (let i = 0; i < 8; i++) level2.push(await append(bob, 'gb', { l2: i }, [G.h, hashOf('missing ' + i)].sort()));
    const level1 = [];
    for (let i = 0; i < 8; i++) level1.push(await append(bob, 'gb', { l1: i }, [level2[i].h]));
    const paid = await append(bob, 'gb', { paid: 1 }, level1.map((b) => b.h).sort(), { bits: 6 });
    assert.deepEqual((await S.ingest([paid], 'p')).orphans, [paid.h]);
    const r = await S.ingest(level1, 'p');
    assert.equal(r.added.length, 0, 'free parents that would wait for parents of their own are refused');
    assert.ok(r.rejected.every((x) => x.reason === 'E_POLICY'), JSON.stringify(r.rejected));
    // Free parents whose own parents are held still connect a paid orphan (history keeps working).
    const ok1 = [];
    for (let i = 0; i < 3; i++) ok1.push(await append(bob, 'gb', { ok: i }, [G.h]));
    const paid2 = await append(bob, 'gb', { paid: 2 }, ok1.map((b) => b.h).sort(), { bits: 6 });
    await S.ingest([paid2], 'p');
    const r2 = await S.ingest(ok1, 'p');
    assert.equal(r2.added.length + (r2.orphans || []).length >= 3 || S.dag.has(paid2.h), true, JSON.stringify(r2));
    assert.ok(S.dag.has(paid2.h), 'the paid block connects');
  } finally {
    await S.close();
  }
});

// ---------------------------------------------------------------------------------------------- STALK-8

test('STALK-8: a local write is announced to each peer after its own random delay (0.5 to 3 s), a relay after up to 1 s', async () => {
  const sim = new Sim({ seed: 209 });
  const owner = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const A = await makeNode(sim, { name: 'A', owner: owner.pub, identity: await makeIdentity(), blocks: [G] });
  try {
    const peers = [];
    for (let i = 0; i < 5; i++) {
      const id = 'P' + i;
      const at = [];
      A.gossip.attach({ id, send: (u8) => { const m = decode(u8); if (m && m.type === MSG.ANN) at.push(sim.t); } });
      peers.push(at);
    }
    await sim.run(100);
    const t0 = sim.t;
    await A.append('gb', { text: 'hello' });
    await sim.run(400);
    assert.equal(peers.filter((at) => at.length > 0).length, 0, 'no ANN within 0.5 s');
    await sim.run(3000);
    const times = peers.map((at) => at[0] - t0);
    assert.ok(times.every((t) => t >= 500 && t <= 3100), JSON.stringify(times));
    assert.ok(new Set(times).size > 1, 'not every peer at once: ' + JSON.stringify(times));
  } finally {
    await A.close();
  }
});

// ---------------------------------------------------------------------------------------------- SCALE-8

test('SCALE-8: at the lifetime ceiling every author is refused, so a copy\'s HELLO never passes the bound', async () => {
  const sim = new Sim({ seed: 210 });
  const owner = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const node = await makeNode(sim, { name: 'N', owner: owner.pub, identity: owner, blocks: [G], config: { maxLifetimeBlocks: 6 } });
  try {
    for (let i = 0; i < 5; i++) await node.put('k' + i, i);
    assert.equal(node.dag.size, 6);
    await assert.rejects(node.put('k9', 9), (err) => err.code === 'E_CAP');
    const stranger = await makeIdentity();
    const b = await append(stranger, 'gb', { text: 'late' }, node.dag.heads());
    assert.equal((await node.ingest([b], 'p')).rejected[0].reason, 'E_CAP');
  } finally {
    await node.close();
  }
});

// ---------------------------------------------------------------------------------------------- lane: STALK-3, DS-3, SCALE-11

const laneId = (i) => 'mw1:lane' + String(i).padStart(23, '0');
async function personal(site, posts) {
  const who = await makeIdentity();
  const G = await mk(who, { t: 'policy', writers: 'owner', bits: 16 }, undefined, [], { site });
  const blocks = [G];
  let prev = G.h;
  for (let i = 0; i < posts; i++) {
    const b = await mk(who, { t: 'append', l: 'mw.post' }, { text: 'post ' + i }, [prev], { site });
    blocks.push(b);
    prev = b.h;
  }
  return { owner: who, G, blocks };
}
function lane(sim, name, ledgers, opts = {}) {
  const m = new MultiGossip(Object.assign({ hubSuffix: 'hub.example', ledgers, now: sim.now, setTimeoutFn: sim.setTimeout, clearTimeoutFn: sim.clearTimeout, random: sim.rand }, opts));
  m.name = name;
  const tick = () => {
    if (m._destroyed) return undefined;
    m.tick();
    sim.schedule(1000, tick);
    return undefined;
  };
  sim.schedule(1000, tick);
  return m;
}

test('STALK-3: a private follow is never in HAVE, and its RECENT goes out only among decoys of the same shape', async () => {
  const sim = new Sim({ seed: 211 });
  const target = laneId(1);
  const node = await makeNode(sim, { name: 'f', siteId: target });
  const B = lane(sim, 'B', new Map([[target, node]]));
  try {
    B.follow(target, { private: true });
    const sent = [];
    B.attach({ id: 'X', send: (u8) => sent.push(decodeLane(u8)) });
    // X holds the target only: too few ledgers to hide among, so nothing is asked of it.
    await B.handle('X', encodeLane(LANE_MSG.HAVE, { ledgers: [target] }));
    await sim.run(3000);
    assert.equal(sent.filter((m) => m && m.type === LANE_MSG.RECENT).length, 0);
    // With enough other ledgers on offer: one request for the target and three decoys, all alike.
    await B.handle('X', encodeLane(LANE_MSG.HAVE, { ledgers: [laneId(2), laneId(3), laneId(4), laneId(5)] }));
    await sim.run(3000);
    const recent = sent.filter((m) => m && m.type === LANE_MSG.RECENT).map((m) => m.obj);
    assert.equal(recent.length, 4, JSON.stringify(recent));
    assert.equal(recent.filter((o) => o.ledger === target).length, 1);
    assert.equal(new Set(recent.map((o) => o.posts + '|' + o.fromDepth)).size, 1, 'same shape');
    for (const m of sent) if (m && m.type === LANE_MSG.HAVE) assert.ok(!m.obj.ledgers.includes(target), 'never in HAVE');
    assert.deepEqual(B.holdings(), []);
    // A public follow still appears.
    const pub = laneId(9);
    B.ledgers.set(pub, await makeNode(sim, { name: 'g', siteId: pub }));
    B.follow(pub);
    B._follow.get(pub).lastSync = sim.now();
    assert.deepEqual(B.holdings(), [pub]);
  } finally {
    B.destroy();
    await node.close();
  }
});

test('DS-3, SCALE-11: a refresh asks for 20 posts at most every 30 minutes; one wire gets one answer per ledger per minute and S once', async () => {
  const sim = new Sim({ seed: 212 });
  const site = laneId(7);
  const P = await personal(site, 40);
  const own = await makeNode(sim, { name: 'own', siteId: site, owner: P.owner.pub, genesisHash: P.G.h, blocks: P.blocks });
  const A = lane(sim, 'A', new Map([[site, own]]));
  try {
    A.hold(site);
    const got = [];
    A.attach({ id: 'X', send: (u8) => { const m = decodeLane(u8); if (m && m.type === LANE_MSG.RECENT && m.obj.more === false) got.push(m.obj.rid); } });
    for (let i = 0; i < 120; i++) {
      await A.handle('X', encodeLane(LANE_MSG.RECENT, { ledger: site, fromDepth: i % 7, posts: 1 + (i % 50), rid: i + 1 }));
      sim.t += 500;
    }
    await sim.run(2000);
    assert.ok(got.length >= 1 && got.length <= 2, 'answers in 60 s: ' + got.length);
    assert.equal(A.limits.refreshMs, 1800000);
    assert.equal(A.limits.refreshPosts, 20);
  } finally {
    A.destroy();
    await own.close();
  }
});

// ---------------------------------------------------------------------------------------------- MAL53-13

test('MAL53-13: a listing\'s ws is https at a public host', () => {
  const F = { ih: 'a'.repeat(40), len: 1, name: 'x', mime: 'text/plain', t: 1 };
  assert.equal(schemaOk('mw.files', Object.assign({}, F, { ws: 'https://seed.example/x' })), true);
  for (const ws of ['http://seed.example/x', 'https://127.0.0.1/x', 'https://10.1.2.3:8080/x', 'https://192.168.0.2/x', 'https://[::1]/x', 'https://nas.local/x', 'https://localhost/x']) {
    assert.equal(schemaOk('mw.files', Object.assign({}, F, { ws })), false, ws);
  }
});

// ---------------------------------------------------------------------------------------------- HUB-5 (documented limit)

test('HUB-5 (limit kept on purpose until the loader check lands): a planted first keyinfo decides who can recover the key', async () => {
  const owner = await makeIdentity();
  const person = await makeIdentity();
  const realRecover = await makeIdentity();
  const hubRecover = await makeIdentity();
  const hubKey = await makeIdentity();
  const personNext = await makeIdentity();
  const rcOf = (pub) => b64url.encode(sha256Sync(utf8.encode(pub)));
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const planted = await mk(person, { t: 'keyinfo', rc: rcOf(hubRecover.pub) }, undefined, [G.h]);
  const post = await append(person, 'gb', { text: 'mine' }, [planted.h]);
  const blocks = [G, planted, post];
  const st = reduce(dagOf(blocks), { genesisOwner: owner.pub });
  const mine = await mk(personNext, await rotateOp({ by: 'recover', from: person.pub, next: personNext.pub, ledgerId: SITE, recover: realRecover }), undefined, [post.h]);
  assert.deepEqual(admit(st, mine, { dag: dagOf(blocks), genesisOwner: owner.pub }), { ok: false, code: 'E_POLICY', reason: 'recover' });
  const theirs = await mk(hubKey, await rotateOp({ by: 'recover', from: person.pub, next: hubKey.pub, ledgerId: SITE, recover: hubRecover }), undefined, [G.h]);
  assert.equal(admit(st, theirs, { dag: dagOf(blocks), genesisOwner: owner.pub }).ok, true);
});
