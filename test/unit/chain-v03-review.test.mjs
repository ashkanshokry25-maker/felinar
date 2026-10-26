// chain-v03-review: the ChainNode fixes of the v0.3 code review (docs/review/code-review-v03-*.md; lane ledger-tools).
// MF-20: an identity carrying rc writes its keyinfo before its first other block (after a recover rotation to it); a key
// that rotated away is refused. Claimed times: a block more than 5 minutes ahead waits (or is refused), so a banned author
// cannot post past a ban's until; a live moderator action must claim a time near its arrival, so one session cannot spread
// itself over many claimed hours. Temporary bans: roleOf, isBanned and snapshot read the node's clock. Checkpoints (MF-24 to
// MF-26): every copy prunes on its own (tick), stores S with the covered depths, stores the orphans pruning connects, and a
// pruned copy exports and imports its checkpoint with the blocks. Every block is real (signed); the clock is the simulator's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChainNode, CHECKPOINT_SNAPSHOT_KIND } from '../../src/chain/node.js';
import { MemoryBlockStore } from '../../src/chain/stores.js';
import { rotateSigningInput } from '../../src/chain/block.js';
import { sign } from '../../src/chain/crypto.js';
import { b64url, utf8 } from '../../src/chain/canonical.js';
import { sha256Sync } from '../../src/chain/sha256-sync.js';
import { Sim, SITE, T0, makeIdentity, makeNode, storeWith, mk, policy, append, ban, tomb, makeCheckpoint } from './chain-net-helpers.mjs';

const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const rcOf = (pub) => b64url.encode(sha256Sync(utf8.encode(pub)));

async function rejects(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, 'expected ' + code + ', got ' + err.code + ': ' + err.message);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------- MF-20

test('MF-20: an identity with rc writes { t: keyinfo, rc } before its first other block, once; the later blocks build on it', async () => {
  const sim = new Sim({ seed: 1 });
  const owner = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const ana = await makeIdentity();
  const recoverKey = await makeIdentity();
  const rc = rcOf(recoverKey.pub);
  const node = await makeNode(sim, { name: 'N', owner: owner.pub, identity: Object.assign({}, ana, { rc }), blocks: [G] });
  try {
    const first = await node.append('gb', { text: 'hello' });
    const mine = node.dag.order().filter((b) => b.e.author === ana.pub);
    assert.deepEqual(mine.map((b) => b.e.op.t), ['keyinfo', 'append']);
    assert.equal(mine[0].e.op.rc, rc);
    assert.ok(first.e.prev.includes(mine[0].h), 'the first post builds on the commitment');
    assert.equal(node.state.keyinfo.get(ana.pub).rc, rc);
    await node.append('gb', { text: 'again' });
    assert.equal(node.dag.order().filter((b) => b.e.author === ana.pub && b.e.op.t === 'keyinfo').length, 1, 'once');
    // A key that already wrote without one (an older loader) gets none: it would be late.
    const bo = await makeIdentity();
    const boPost = await append(bo, 'gb', { text: 'bo, before' }, [first.h]);
    await node.ingest([boPost], 'peer');
    node.setIdentity(Object.assign({}, bo, { rc }));
    await node.append('gb', { text: 'bo, after' });
    assert.equal(node.dag.order().some((b) => b.e.author === bo.pub && b.e.op.t === 'keyinfo'), false);
    await rejects(node.writeControl({ t: 'keyinfo', rc }), 'E_POLICY');
  } finally {
    await node.close();
  }
});

test('MF-20: a recover rotation to a new key is followed by its keyinfo; the old key is refused from then on', async () => {
  const sim = new Sim({ seed: 2 });
  const owner = await makeIdentity();
  const old = await makeIdentity();
  const next = await makeIdentity();
  const recoverKey = await makeIdentity();
  const G = await policy(owner, { writers: 'allow', bits: 0, allow: [old.pub] }, []);
  const node = await makeNode(sim, { name: 'N', owner: owner.pub, identity: Object.assign({}, old, { rc: rcOf(recoverKey.pub) }), blocks: [G] });
  try {
    await node.append('gb', { text: 'before the theft' });
    assert.equal(node.state.keyinfo.get(old.pub).rc, rcOf(recoverKey.pub));
    // The person recovers on a new device: the new key signs the rotation, the recover key signs rsig.
    const rsig = b64url.encode(await sign(recoverKey.privateKey, rotateSigningInput(SITE, old.pub, next.pub)));
    node.setIdentity(Object.assign({}, next, { rc: rcOf(recoverKey.pub) }));
    await node.writeControl({ t: 'rotate', from: old.pub, next: next.pub, by: 'recover', rp: recoverKey.pub, rsig });
    const byNext = node.dag.order().filter((b) => b.e.author === next.pub).map((b) => b.e.op.t);
    assert.deepEqual(byNext, ['rotate', 'keyinfo'], 'the commitment follows the rotation');
    assert.equal(node.state.keyinfo.get(next.pub).rc, rcOf(recoverKey.pub));
    await node.append('gb', { text: 'the person again' });
    assert.equal(node.roleOf(old.pub), 'reader');
    assert.equal(node.roleOf(next.pub), 'writer', 'next inherits the allow membership');
    // The thief still holds the old key: whatever it signs now is refused.
    node.setIdentity(old);
    await rejects(node.append('gb', { text: 'the thief' }), 'E_POLICY');
    assert.deepEqual(node.snapshot().lists.gb.map((x) => x.v.text), ['before the theft', 'the person again']);
  } finally {
    await node.close();
  }
});

// ---------------------------------------------------------------------------------------------- claimed times

test('probe p9: a post claiming a time past a ban\'s until is not stored while the clock is before it; a near-future post waits', async () => {
  const sim = new Sim({ seed: 3 });
  const owner = await makeIdentity();
  const spammer = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0 }, [], { ts: T0 - HOUR });
  const until = T0 + 7 * DAY;
  const B = await mk(owner, { t: 'ban', author: spammer.pub, until }, undefined, [G.h], { ts: T0 - HOUR });
  const node = await makeNode(sim, { name: 'N', owner: owner.pub, blocks: [G, B] });
  try {
    const now = await append(spammer, 'gb', { text: 'written now' }, [B.h], { ts: T0 });
    const claimsUntil = await append(spammer, 'gb', { text: 'claims next week' }, [B.h], { ts: until });
    const r1 = await node.ingest([now], 'spammer', { live: true });
    assert.deepEqual(r1.rejected, [{ h: now.h, reason: 'E_BANNED' }]);
    const r2 = await node.ingest([claimsUntil], 'spammer', { live: true });
    assert.deepEqual(r2.rejected, [{ h: claimsUntil.h, reason: 'E_FUTURE' }]);
    assert.equal(node.dag.has(claimsUntil.h), false, 'neither stored nor relayed');
    assert.equal(node.snapshot().lists.gb, undefined, 'no post in effect during the ban');
    // History is no way around it: a block from the future is never history.
    const r3 = await node.ingest([claimsUntil], 'sync');
    assert.equal(r3.added.length, 0);
    // A post a little ahead (a skewed clock) waits in the deferred pool and is taken when its time comes.
    const alice = await makeIdentity();
    const soon = await append(alice, 'gb', { text: 'twenty minutes ahead' }, [B.h], { ts: T0 + 20 * MIN });
    const r4 = await node.ingest([soon], 'alice', { live: true });
    assert.deepEqual(r4.deferred, [soon.h]);
    assert.equal(node.dag.has(soon.h), false);
    await sim.run(10 * MIN);
    assert.equal(node.dag.has(soon.h), false, 'still more than 5 minutes ahead');
    await sim.run(6 * MIN);
    assert.equal(node.dag.has(soon.h), true, 'taken once its time came (tick)');
    assert.deepEqual(node.snapshot().lists.gb.map((x) => x.v.text), ['twenty minutes ahead']);
  } finally {
    await node.close();
  }
});

test('200 moderator tombstones claiming 24 past hours, arriving live within an hour, have at most modActionsPerHour effects', async () => {
  const sim = new Sim({ seed: 4, start: T0 + MIN });
  const owner = await makeIdentity();
  const mod = await makeIdentity();
  const writer = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0, moderators: [mod.pub], modActionsPerHour: 20 }, [], { ts: T0 - 2 * DAY });
  const blocks = [G];
  let prev = G.h;
  for (let i = 0; i < 200; i++) {
    const b = await append(writer, 'gb', { text: 'post ' + i }, [prev], { ts: T0 });
    blocks.push(b);
    prev = b.h;
  }
  const node = await makeNode(sim, { name: 'N', owner: owner.pub, blocks });
  try {
    const posts = blocks.slice(1);
    let refused = 0;
    for (let i = 0; i < 200; i++) {
      // Every other one claims an older time over the last 24 hours (14.4 minutes apart), the rest the time they are sent;
      // all build on the head. 200 arrivals over 50 minutes of one clock hour.
      const claim = i % 2 === 0 ? T0 + MIN - i * 432000 : sim.now();
      const t = await mk(mod, { t: 'tombstone', h: posts[i].h }, undefined, [prev], { ts: Math.floor(claim / MIN) * MIN });
      const r = await node.ingest([t], 'mod', { live: true });
      if (r.rejected.some((x) => x.reason === 'E_CLOCK')) refused++;
      await sim.run(15000);
    }
    const effects = node.state.tombstoned.size;
    assert.equal(effects, 20, 'modActionsPerHour tombstones in effect, no more');
    assert.ok(refused >= 98, 'those claiming a time far from their arrival are refused: ' + refused);
    assert.equal(node.snapshot().lists.gb.length, 200 - effects);
    // An old-dated tombstone may still come as history (a sync): the state rule counts it in the hour of what it builds on, so
    // it can take a slot of that hour (and end the effect of the one it displaces) but never adds one. It names a post that is not
    // hidden yet (code review v0.3, round 2): with an already hidden target, two blocks for one post left 19 effects whenever
    // the late block sorted into the cap (1 of 40 runs).
    const free = posts.find((p) => !node.state.tombstoned.has(p.h));
    const late = await mk(mod, { t: 'tombstone', h: free.h }, undefined, [prev], { ts: T0 - DAY });
    assert.equal((await node.ingest([late], 'sync')).rejected.length, 0);
    assert.equal(node.state.tombstoned.size, 20, 'still capped');
  } finally {
    await node.close();
  }
});

// ---------------------------------------------------------------------------------------------- temporary bans

test('an expired temporary ban: roleOf is writer again, the snapshot does not list it, isBanned is false (chat asks node.isBanned)', async () => {
  const sim = new Sim({ seed: 5 });
  const owner = await makeIdentity();
  const x = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0 }, [], { ts: T0 - HOUR });
  const B = await mk(owner, { t: 'ban', author: x.pub, until: T0 + HOUR }, undefined, [G.h], { ts: T0 - HOUR });
  const node = await makeNode(sim, { name: 'N', owner: owner.pub, identity: x, blocks: [G, B] });
  const heard = [];
  node.subscribe((snap, info) => heard.push([info.reason, snap.policy.banned.length]));
  try {
    assert.equal(node.role, 'reader');
    assert.equal(node.isBanned(x.pub), true);
    assert.deepEqual(node.snapshot().policy.banned, [x.pub]);
    assert.deepEqual(node.snapshot().policy.banUntil, { [x.pub]: T0 + HOUR });
    await rejects(node.append('gb', { text: 'during' }), 'E_BANNED');
    await sim.run(2 * HOUR);
    assert.ok(heard.some(([reason, n]) => reason === 'remote' && n === 0), 'subscribers heard the ban run out');
    assert.equal(node.role, 'writer');
    assert.equal(node.roleOf(x.pub), 'writer');
    assert.equal(node.isBanned(x.pub), false);
    assert.deepEqual(node.snapshot().policy.banned, []);
    assert.deepEqual(node.snapshot().policy.banUntil, {});
    await node.append('gb', { text: 'after the ban' });
    assert.deepEqual(node.snapshot().lists.gb.map((it) => it.v.text), ['after the ban']);
    assert.equal(node.isBanned(owner.pub), false, 'never the owner');
  } finally {
    await node.close();
  }
});

// ---------------------------------------------------------------------------------------------- checkpoints

async function history(n = 40) {
  const owner = await makeIdentity();
  const alice = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const blocks = [G];
  let prev = G.h;
  const posts = [];
  for (let i = 0; i < n; i++) {
    const b = await append(alice, 'gb', { text: 'post ' + i }, [prev]);
    blocks.push(b);
    posts.push(b);
    prev = b.h;
  }
  const T = await tomb(owner, posts[3].h, [prev]);
  blocks.push(T);
  return { owner, alice, G, blocks, posts, last: T };
}

test('MF-24 to MF-26: an owner checkpoint arrives over gossip; after a tick every copy has pruned: S row, covered rows gone, fewer bytes; a reopened copy keeps root and windows', async () => {
  const sim = new Sim({ seed: 6 });
  const w = await history();
  const storeN = await storeWith(w.blocks);
  const storeP = await storeWith(w.blocks);
  const N = await makeNode(sim, { name: 'N', owner: w.owner.pub, identity: w.owner, store: storeN });
  const P = await makeNode(sim, { name: 'P', owner: w.owner.pub, store: storeP });
  let R = null;
  try {
    sim.link(N, P);
    await sim.run(2000);
    const bytesBefore = P.dag.bytes;
    const capBefore = P.capacity().bytes;
    const contentBefore = JSON.stringify(P.snapshot());
    const cp = await makeCheckpoint(w.owner, N);
    await N.ingest([cp.block], 'owner-tool');
    assert.ok(await sim.run(10000, () => P.dag.coveredCount > 0 && N.dag.coveredCount > 0), 'both copies pruned on a tick');
    assert.equal(P.state.checkpoint.h, cp.block.h);
    assert.equal(P.dag.coveredCount, w.blocks.length);
    assert.ok(P.dag.bytes < bytesBefore && P.capacity().bytes < capBefore, 'the bytes and the capacity meter drop');
    assert.equal(JSON.stringify(P.snapshot()).length > 0, true);
    const row = await storeP.getCheckpoint();
    assert.equal(row.h, cp.block.h);
    assert.equal(row.snap, cp.snap);
    assert.equal(row.depths.list.length, w.blocks.length, 'the covered depths travel with S');
    assert.deepEqual((await storeP.getAll()).map((b) => b.h), [cp.block.h], 'covered rows are gone');
    // Later blocks on both copies, then P reopens from its store: same root and windows as N, which pruned live.
    const more = await N.append('gb', { text: 'after the checkpoint' });
    await sim.run(2000);
    assert.equal(P.dag.has(more.h), true);
    const content = JSON.stringify(P.snapshot().lists);
    await P.close();
    R = await makeNode(sim, { name: 'R', owner: w.owner.pub, store: storeP });
    assert.equal(R.dag.root(), N.dag.root());
    assert.deepEqual(R.dag.windows(), N.dag.windows(), 'the depths survive the reopen');
    assert.equal(JSON.stringify(R.snapshot().lists), content);
    assert.notEqual(contentBefore, '');
  } finally {
    await N.close();
    await P.close();
    if (R) await R.close();
  }
});

test('an orphan waiting on a covered parent is stored when the copy prunes; a pruned copy exports its checkpoint with the blocks and a fresh copy imports it', async () => {
  const sim = new Sim({ seed: 7 });
  const w = await history(20);
  const N = await makeNode(sim, { name: 'N', owner: w.owner.pub, identity: w.owner, blocks: w.blocks });
  // F holds the ledger up to post 12 (an earlier visit).
  const storeF = await storeWith(w.blocks.slice(0, w.blocks.indexOf(w.posts[12]) + 1));
  const F = await makeNode(sim, { name: 'F', owner: w.owner.pub, store: storeF });
  let F2 = null;
  try {
    const cp = await makeCheckpoint(w.owner, N);
    await N.ingest([cp.block], 'owner-tool');
    await N.tick();
    assert.equal(N.dag.coveredCount, w.blocks.length, 'N pruned on its tick');
    const after = await N.append('gb', { text: 'after the checkpoint' });
    // A late reply to post 16 (F does not hold it; the checkpoint covers it) reaches F first and waits as an orphan.
    const reply = await append(w.alice, 'gb', { text: 'late reply' }, [w.posts[16].h]);
    const r0 = await F.ingest([reply], 'peer');
    assert.deepEqual(r0.orphans, [reply.h]);
    const file = N.exportSnapshot();
    assert.equal(file[0].mw, CHECKPOINT_SNAPSHOT_KIND);
    assert.equal(file[0].checkpoint.snap, cp.snap);
    assert.deepEqual(file.slice(1).map((b) => b.h).sort(), [cp.block.h, after.h].sort(), 'the blocks after the checkpoint');
    assert.deepEqual(N.exportBlocks().map((b) => b.h).sort(), [cp.block.h, after.h].sort(), 'exportBlocks stays blocks only');
    const imp = await F.importSnapshot(JSON.parse(JSON.stringify(file)));
    assert.equal(imp.rejected, 0);
    assert.equal(F.dag.coveredCount, w.blocks.length, 'S applied first');
    assert.equal(F.dag.has(after.h), true);
    assert.equal(F.dag.has(reply.h), true, 'the orphan connected');
    assert.ok((await storeF.getAll()).some((b) => b.h === reply.h), 'and was stored');
    assert.ok(F.snapshot().lists.gb.some((x) => x.v.text === 'late reply'));
    assert.deepEqual(F.snapshot().kv, N.snapshot().kv);
    // Reopened, F still has it.
    await F.close();
    F2 = await makeNode(sim, { name: 'F2', owner: w.owner.pub, store: storeF });
    assert.equal(F2.dag.has(reply.h), true);
    // A header for another ledger is not applied.
    const fresh = await makeNode(sim, { name: 'X', owner: w.owner.pub });
    const foreign = JSON.parse(JSON.stringify(file));
    foreign[0].ledger = 'mw1:anotherledger000000000000';
    const r = await fresh.importSnapshot(foreign);
    assert.equal(fresh.dag.coveredCount, 0);
    assert.ok(r.rejected >= 1);
    await fresh.close();
  } finally {
    await N.close();
    await F.close();
    if (F2) await F2.close();
  }
});
