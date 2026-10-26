// hub-moderator-gaps: the coverage gaps of the moderator-cap tests named by review finding HUB-12
// (.orchestration/reports/all-findings-2026-10-22.json). chain-v03-review.test.mjs builds every moderator block on the head and
// delivers it live, so it cannot see a block forked from the genesis, history delivery, a ban or bulk tombstone's values, a
// moderator put on owner entries, or a rotation the target never agreed to. Each case below drives the real ChainNode (signed
// blocks, the simulator's clock) in one of those shapes.
//
// The cases marked { todo } assert the behaviour the fixes of HUB-1, HUB-2, HUB-4, HUB-6 and HUB-7 must produce. They fail on
// a tree where the finding is live, and node:test reports a failing todo case without failing the run, so the gate stays green
// for the fixers working in parallel while the failures stay visible (`node tools/run-unit.mjs hub-moderator-gaps.test.mjs`
// prints them as "# TODO"). The chain fixer removes the todo option of a case when its fix lands; from then on that case gates.
// The cases without todo pin behaviour that holds today and that the fixes must keep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b64url, utf8 } from '../../src/chain/canonical.js';
import { sha256Sync } from '../../src/chain/sha256-sync.js';
import { Sim, T0, makeIdentity, makeNode, storeWith, mk, policy, append, put, ban, makeCheckpoint } from './chain-net-helpers.mjs';

const HOUR = 3600000;
const DAY = 86400000;

const listOf = (node, name) => ((node.snapshot().lists || {})[name] || []).map((it) => it.v.text);
const held = (node, blocks) => blocks.filter((b) => {
  const got = node.dag.get(b.h);
  return got !== undefined && got.v !== undefined;
}).length;

// ---------------------------------------------------------------------------------------------- HUB-1 rotation consent

async function rotationWorld(sim, { withBan }) {
  const owner = await makeIdentity();
  const mod = await makeIdentity();
  const spammer = await makeIdentity();
  const victim = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0, moderators: [mod.pub] }, []);
  const v1 = await append(victim, 'gb', { text: 'v1' }, [G.h]);
  const v2 = await append(victim, 'gb', { text: 'v2' }, [v1.h]);
  const v3 = await append(victim, 'gb', { text: 'v3' }, [v2.h]);
  const a1 = await append(spammer, 'gb', { text: 'spam' }, [v3.h]);
  const blocks = [G, v1, v2, v3, a1];
  if (withBan) blocks.push(await ban(mod, spammer.pub, [a1.h]));
  const node = await makeNode(sim, { name: 'N', owner: owner.pub, identity: victim, store: await storeWith(blocks) });
  const head = blocks[blocks.length - 1];
  // The spammer signs rotate { from: spammer, next: victim, by: 'self' }; the victim signs nothing.
  const rot = await mk(spammer, { t: 'rotate', from: spammer.pub, next: victim.pub, by: 'self' }, undefined, [head.h], { ts: sim.now() });
  return { owner, mod, spammer, victim, node, rot, victimPosts: [v1, v2, v3] };
}

test('HUB-1 control: a self rotation onto a key with no ban in play leaves that key\'s role and posts as they were', async () => {
  const sim = new Sim({ seed: 121 });
  const w = await rotationWorld(sim, { withBan: false });
  try {
    await w.node.ingest([w.rot], 'spammer', { live: true });
    assert.equal(w.node.roleOf(w.victim.pub), 'writer');
    assert.deepEqual(listOf(w.node, 'gb').filter((t) => t !== 'spam'), ['v1', 'v2', 'v3']);
    await w.node.append('gb', { text: 'v4' });
    assert.ok(listOf(w.node, 'gb').includes('v4'));
  } finally {
    await w.node.close();
  }
});

test('HUB-1: a banned key\'s self rotation onto a key that never agreed does not hand it the ban or hide its posts', async () => {
  const sim = new Sim({ seed: 122 });
  const w = await rotationWorld(sim, { withBan: true });
  try {
    await w.node.ingest([w.rot], 'spammer', { live: true });
    assert.equal(w.node.roleOf(w.victim.pub), 'writer', 'the victim keeps its role');
    assert.equal(w.node.isBanned(w.victim.pub), false, 'the spammer\'s ban stays with the spammer');
    assert.deepEqual(listOf(w.node, 'gb'), ['v1', 'v2', 'v3'], 'the victim\'s posts stay visible');
    assert.equal(held(w.node, w.victimPosts), 3, 'and their values stay held');
    assert.equal(w.node.state.rotations.has(w.spammer.pub), false, 'the one-sided rotation is not in effect');
    await w.node.append('gb', { text: 'v4' });
    assert.ok(listOf(w.node, 'gb').includes('v4'), 'the victim\'s next write is accepted');
  } finally {
    await w.node.close();
  }
});

// ---------------------------------------------------------------------------------------------- HUB-2 ban and bulk value grace

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
  const head = await put(owner, 'motd', 'hello', [prev]);
  const node = await makeNode(sim, { name: 'N', owner: owner.pub, store: await storeWith([G, ...posts, head]) });
  return { owner, mod, authors, posts, head, node };
}

async function voidModerator(w, sim, prev) {
  const V = await policy(w.owner, { moderators: [], voided: [{ author: w.mod.pub, after: w.head.h }] }, [prev], { ts: sim.now() });
  const r = await w.node.ingest([V], 'owner', { live: true });
  assert.deepEqual(r.added, [V.h], JSON.stringify(r.rejected));
}

test('HUB-2: a moderator ban keeps the author\'s values for the grace, and voiding the moderator brings the posts back', async () => {
  const sim = new Sim({ seed: 123 });
  const w = await graceWorld(sim, 6);
  try {
    const B = await ban(w.mod, w.authors[3].pub, [w.head.h], { ts: sim.now() });
    const r = await w.node.ingest([B], 'mod', { live: true });
    assert.deepEqual(r.added, [B.h], JSON.stringify(r.rejected));
    assert.equal(listOf(w.node, 'gb').length, 5, 'the ban hides the post');
    await sim.run(HOUR);
    assert.equal(held(w.node, w.posts), 6, 'the value is still held an hour later');
    await voidModerator(w, sim, B.h);
    assert.equal(listOf(w.node, 'gb').length, 6, 'the void shows the post again, with its value');
  } finally {
    await w.node.close();
  }
});

test('HUB-2: a moderator bulk tombstone keeps the values for the grace, and voiding the moderator brings the posts back', async () => {
  const sim = new Sim({ seed: 124 });
  const w = await graceWorld(sim, 5);
  try {
    const bulk = await mk(w.mod, { t: 'tombstone', authors: w.authors.map((a) => a.pub), before: w.head.h }, undefined, [w.head.h], { ts: sim.now() });
    const r = await w.node.ingest([bulk], 'mod', { live: true });
    assert.deepEqual(r.added, [bulk.h], JSON.stringify(r.rejected));
    assert.equal(listOf(w.node, 'gb').length, 0, 'the bulk tombstone hides every post');
    await sim.run(HOUR);
    assert.equal(held(w.node, w.posts), 5, 'the values are still held an hour later');
    assert.ok(w.node.graceList().length >= 5, 'and listed in grace');
    await voidModerator(w, sim, bulk.h);
    assert.equal(listOf(w.node, 'gb').length, 5, 'the void shows every post again');
  } finally {
    await w.node.close();
  }
});

// ---------------------------------------------------------------------------------------------- HUB-4 forked moderator chains

// The genesis is 30 days old and names no moderator; the owner appoints one an hour ago (cap 2 per hour); 12 writers post on
// the appointment. The moderator signs one ban per writer, every ban forked from the genesis (not from the head), each
// claiming its own past hour or all the same one, and delivers them as history (a sync), which the live clock check never sees.
async function forkWorld(sim, claims) {
  const owner = await makeIdentity();
  const mod = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0 }, [], { ts: T0 - 30 * DAY });
  const P = await policy(owner, { moderators: [mod.pub], modActionsPerHour: 2 }, [G.h], { ts: T0 - HOUR });
  const writers = [];
  const posts = [];
  let prev = P.h;
  for (let i = 0; i < 12; i++) {
    const wr = await makeIdentity();
    const b = await append(wr, 'gb', { text: 'post ' + i }, [prev], { ts: T0 - HOUR });
    writers.push(wr);
    posts.push(b);
    prev = b.h;
  }
  const node = await makeNode(sim, { name: 'N', owner: owner.pub, store: await storeWith([G, P, ...posts]) });
  const bans = [];
  for (let i = 0; i < 12; i++) bans.push(await ban(mod, writers[i].pub, [G.h], { ts: claims(i) }));
  return { node, bans };
}

test('HUB-4 control: 12 forked moderator bans claiming one hour, delivered as history, have at most modActionsPerHour effects', async () => {
  const sim = new Sim({ seed: 125 });
  const w = await forkWorld(sim, () => T0 - 20 * DAY);
  try {
    await w.node.ingest(w.bans, 'sync');
    assert.ok(w.node.snapshot().policy.banned.length <= 2, 'banned: ' + w.node.snapshot().policy.banned.length);
  } finally {
    await w.node.close();
  }
});

test('HUB-2 cap: of 12 moderator bans over a cap of 2, only the authors banned in the final state lose their posts', async () => {
  const sim = new Sim({ seed: 130 });
  const w = await forkWorld(sim, () => T0 - 20 * DAY);
  try {
    await w.node.ingest(w.bans, 'sync');
    const banned = w.node.snapshot().policy.banned.length;
    assert.ok(banned <= 2, 'banned: ' + banned);
    assert.equal(listOf(w.node, 'gb').length, 12 - banned, 'a ban the cap displaced hides nothing and drops nothing');
  } finally {
    await w.node.close();
  }
});

test('HUB-4: 12 forked moderator bans claiming 12 past hours before the appointment, delivered as history, stay within the cap since the appointment', async () => {
  const sim = new Sim({ seed: 126 });
  const w = await forkWorld(sim, (i) => T0 - 20 * DAY + i * HOUR);
  try {
    await w.node.ingest(w.bans, 'sync');
    // The appointment is an hour old: two clock hours, so at most 2 x 2 bans can be in effect, however far back they claim.
    const banned = w.node.snapshot().policy.banned.length;
    assert.ok(banned <= 4, 'banned: ' + banned);
    assert.ok(listOf(w.node, 'gb').length >= 8);
  } finally {
    await w.node.close();
  }
});

// The same backdated chain, delivered by a real sync over the simulator's gossip (probe p1c of HUB-4): a linear chain of 12
// bans forked from the genesis, each claiming its own past hour, ended by one block that claims the current time and joins
// the head, so the victim solicits the chain as parents (history) and the live clock check sees only the tip.
test('HUB-4 gossip: a backdated moderator chain fetched by a sync stays within the cap since the appointment', async () => {
  const sim = new Sim({ seed: 133 });
  const owner = await makeIdentity();
  const mod = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0 }, [], { ts: T0 - 30 * DAY });
  const P = await policy(owner, { moderators: [mod.pub], modActionsPerHour: 2 }, [G.h], { ts: T0 - HOUR });
  const writers = [];
  const posts = [];
  let head = P.h;
  for (let i = 0; i < 12; i++) {
    const wr = await makeIdentity();
    const b = await append(wr, 'gb', { text: 'post ' + i }, [head], { ts: T0 - HOUR });
    writers.push(wr);
    posts.push(b);
    head = b.h;
  }
  const base = [G, P, ...posts];
  const chain = [];
  let prev = G.h;
  for (let i = 0; i < 12; i++) {
    const b = await ban(mod, writers[i].pub, [prev], { ts: T0 - 20 * DAY + i * HOUR });
    chain.push(b);
    prev = b.h;
  }
  const tip = await mk(mod, { t: 'tombstone', h: posts[0].h }, undefined, [prev, head], { ts: T0 });
  const victim = await makeNode(sim, { name: 'V', owner: owner.pub, store: await storeWith(base) });
  const attacker = await makeNode(sim, { name: 'A', owner: owner.pub, store: await storeWith([...base, ...chain, tip]) });
  try {
    sim.link(attacker, victim, { latency: 25 });
    await sim.run(20000, () => victim.dag.has(tip.h));
    // Two clock hours since the appointment at 2 per hour: at most 4 of the 13 moderator actions in effect.
    const banned = victim.snapshot().policy.banned.length;
    assert.ok(banned <= 4, 'banned: ' + banned);
    assert.ok(listOf(victim, 'gb').length >= 8, 'visible: ' + listOf(victim, 'gb').length);
  } finally {
    await attacker.close();
    await victim.close();
  }
});

// After an owner checkpoint every copy prunes the covered blocks, and a moderator block whose parents are covered has no causal
// past to take a cap time from (probe p13 of HUB-4): 10 bans on covered posts, claiming hours 400 days before the ledger began.
test('HUB-4 checkpoint: moderator bans built on covered blocks after a checkpoint stay within the cap since the appointment', async () => {
  const sim = new Sim({ seed: 132 });
  const owner = await makeIdentity();
  const mod = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0 }, [], { ts: T0 - 30 * DAY });
  const P = await policy(owner, { moderators: [mod.pub], modActionsPerHour: 1 }, [G.h], { ts: T0 - HOUR });
  const writers = [];
  const posts = [];
  let prev = P.h;
  for (let i = 0; i < 10; i++) {
    const wr = await makeIdentity();
    const b = await append(wr, 'gb', { text: 'post ' + i }, [prev], { ts: T0 - HOUR });
    writers.push(wr);
    posts.push(b);
    prev = b.h;
  }
  const node = await makeNode(sim, { name: 'N', owner: owner.pub, store: await storeWith([G, P, ...posts]) });
  try {
    const cp = await makeCheckpoint(owner, node, { ts: T0 - HOUR });
    assert.deepEqual((await node.ingest([cp.block], 'owner')).rejected, []);
    await node.applyCheckpoint(cp.S);
    await sim.run(2000);
    assert.equal(node.dag.has(posts[0].h), false, 'control: the posts are covered and pruned');
    const bans = [];
    for (let i = 0; i < 10; i++) bans.push(await ban(mod, writers[i].pub, [posts[i].h], { ts: T0 - 400 * DAY + i * HOUR }));
    await node.ingest(bans, 'sync');
    // Two clock hours since the appointment at 1 per hour.
    const banned = node.snapshot().policy.banned.length;
    assert.ok(banned <= 2, 'banned: ' + banned);
    assert.ok(listOf(node, 'gb').length >= 8, 'visible: ' + listOf(node, 'gb').length);
  } finally {
    await node.close();
  }
});

// modAllowPerDay (probe p2 of HUB-4): an allow ledger, a moderator appointed an hour ago at 2 additions per day, and 10 allow
// blocks of 2 keys each forked from the genesis, claiming 10 past days, delivered as history.
test('HUB-4 allow: forked moderator allow blocks claiming past days add at most modAllowPerDay per day since the grant', async () => {
  const sim = new Sim({ seed: 131 });
  const owner = await makeIdentity();
  const mod = await makeIdentity();
  const G = await policy(owner, { writers: 'allow', allow: [], bits: 0 }, [], { ts: T0 - 30 * DAY });
  const P = await policy(owner, { moderators: [mod.pub], modAllowPerDay: 2 }, [G.h], { ts: T0 - HOUR });
  const node = await makeNode(sim, { name: 'N', owner: owner.pub, store: await storeWith([G, P]) });
  try {
    const adds = [];
    for (let i = 0; i < 10; i++) {
      const keys = [(await makeIdentity()).pub, (await makeIdentity()).pub];
      adds.push(await mk(mod, { t: 'allow', add: keys }, undefined, [G.h], { ts: T0 - 20 * DAY + i * DAY }));
    }
    await node.ingest(adds, 'sync');
    // The grant and now fall in one UTC day; 2 x 2 leaves room for a grant just before a day boundary.
    const allowed = node.snapshot().policy.allowCount;
    assert.ok(allowed <= 4, 'allowCount: ' + allowed);
    const writersNow = adds.flatMap((b) => b.e.op.add).filter((k) => node.roleOf(k) === 'writer').length;
    assert.ok(writersNow <= 4, 'keys that can write: ' + writersNow);
  } finally {
    await node.close();
  }
});

// ---------------------------------------------------------------------------------------------- HUB-6 owner entries

const DENY = '_deny/' + b64url.encode(sha256Sync(utf8.encode('some-infohash')));

async function ownerEntriesWorld(sim) {
  const owner = await makeIdentity();
  const mod = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0, moderators: [mod.pub] }, []);
  const d = await put(owner, DENY, { by: owner.pub, t: 1, reason: 'P0' }, [G.h]);
  const c = await put(owner, '_mw.cfg', { chat: 'members' }, [d.h]);
  const node = await makeNode(sim, { name: 'N', owner: owner.pub, store: await storeWith([G, d, c]) });
  return { owner, mod, node, head: c };
}

test('HUB-6 control: the owner\'s _deny entry and _mw.cfg are in effect before any moderator acts', async () => {
  const sim = new Sim({ seed: 127 });
  const w = await ownerEntriesWorld(sim);
  try {
    assert.equal(w.node.state.kv.has(DENY), true);
    assert.deepEqual(w.node.state.kv.get('_mw.cfg').v, { chat: 'members' });
  } finally {
    await w.node.close();
  }
});

test('HUB-6: a moderator put does not lift the owner\'s _deny entry or replace the owner\'s _mw.cfg; the owner still can', async () => {
  const sim = new Sim({ seed: 128 });
  const w = await ownerEntriesWorld(sim);
  try {
    const lift = await put(w.mod, DENY, null, [w.head.h], { ts: sim.now() });
    const cfg = await put(w.mod, '_mw.cfg', { chat: 'off' }, [lift.h], { ts: sim.now() });
    await w.node.ingest([lift], 'mod', { live: true });
    await w.node.ingest([cfg], 'mod', { live: true });
    assert.equal(w.node.state.kv.has(DENY), true, 'the takedown stands');
    assert.deepEqual(w.node.state.kv.get('_mw.cfg').v, { chat: 'members' }, 'the owner\'s settings stand');
    w.node.setIdentity(w.owner);
    await w.node.put('_mw.cfg', { chat: 'off' });
    assert.deepEqual(w.node.state.kv.get('_mw.cfg').v, { chat: 'off' }, 'the owner can still replace it');
  } finally {
    await w.node.close();
  }
});

// ---------------------------------------------------------------------------------------------- HUB-7 strangers' rotations

async function strangerRotate(sim, fields) {
  const owner = await makeIdentity();
  const member = await makeIdentity();
  const stranger = await makeIdentity();
  const next = await makeIdentity();
  const G = await policy(owner, Object.assign({ bits: 0 }, fields(member)), []);
  const node = await makeNode(sim, { name: 'N', owner: owner.pub, store: await storeWith([G]) });
  const rot = await mk(stranger, { t: 'rotate', from: stranger.pub, next: next.pub, by: 'self' }, undefined, [G.h], { ts: sim.now() });
  return { node, rot };
}

test('HUB-7: a stranger\'s rotate block is refused on an owner-only ledger and on an allow ledger it is not a member of', async () => {
  const sim = new Sim({ seed: 129 });
  for (const fields of [() => ({ writers: 'owner' }), (member) => ({ writers: 'allow', allow: [member.pub] })]) {
    const w = await strangerRotate(sim, fields);
    try {
      const r = await w.node.ingest([w.rot], 'stranger', { live: true });
      assert.deepEqual(r.rejected, [{ h: w.rot.h, reason: 'E_POLICY' }], JSON.stringify(fields({ pub: 'm' })));
      assert.equal(w.node.dag.has(w.rot.h), false, 'neither stored nor relayed');
    } finally {
      await w.node.close();
    }
  }
});
