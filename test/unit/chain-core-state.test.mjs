// Unit tests for src/chain/state.js: the two-pass causal control model (DESIGN-REVIEW items 2-4,
// S9), payload effect rules, determinism under arrival-order shuffles, ownerAt/ownerAfter against
// a brute-force definition, and the 5 000-block reducer budget. Scenario blocks are real
// (createBlock); the property and timing tests use synthetic blocks with real hashes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce, snapshot, roleOf, ownerAt, ownerAfter, controlFor, admit, shouldDropValue } from '../../src/chain/state.js';
import { Dag } from '../../src/chain/dag.js';
import { createBlock, validateBlock } from '../../src/chain/block.js';
import { generateKeyPair, exportPublicKey } from '../../src/chain/crypto.js';
import { sha256Sync } from '../../src/chain/sha256-sync.js';
import { canonicalize, utf8, hex } from '../../src/chain/canonical.js';

const SITE = 'mw1:statetestsite0000000000000';
const T0 = Date.UTC(2026, 9, 17, 12, 0, 0);
const SIG = 'A'.repeat(86);

async function makeIdentity() {
  const kp = await generateKeyPair();
  return { privateKey: kp.privateKey, pub: await exportPublicKey(kp.publicKey) };
}

const [owner, owner2, owner3, alice, bob, mod, stranger] = await Promise.all(Array.from({ length: 7 }, makeIdentity));

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(rand, list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

let seq = 0;
const mk = (identity, op, value, prev, { bits = 0 } = {}) =>
  createBlock({ identity, site: SITE, seq: ++seq, prev, op, value, ts: T0, bits, maxValueBytes: 4096 });
const put = (id, k, v, prev, o) => mk(id, { t: 'put', k }, v, prev, o);
const append = (id, l, v, prev, o) => mk(id, { t: 'append', l }, v, prev, o);
const profile = (id, name, prev, o) => mk(id, { t: 'profile' }, name, prev, o);
const policy = (id, fields, prev) => mk(id, Object.assign({ t: 'policy' }, fields), undefined, prev);
const tomb = (id, h, prev, o) => mk(id, { t: 'tombstone', h }, undefined, prev, o);
const ban = (id, author, prev) => mk(id, { t: 'ban', author }, undefined, prev);
const allow = (id, add, remove, prev) => mk(id, { t: 'allow', add, remove }, undefined, prev);
const succession = (id, next, prev) => mk(id, { t: 'owner', next }, undefined, prev);

function dagOf(blocks) {
  const dag = new Dag({ maxOrphansPerPeer: 1e6, maxOrphans: 1e6 }); // shuffled test input may arrive child-first
  for (const b of blocks) assert.notEqual(dag.add(b), 'duplicate');
  assert.equal(dag.orphanCount, 0, 'every parent is present');
  return dag;
}

const stateOf = (blocks, genesisOwner = owner.pub, extra = {}) => reduce(dagOf(blocks), Object.assign({ genesisOwner }, extra));
const kvOf = (state) => Object.fromEntries(Array.from(state.kv, ([k, e]) => [k, e.v]));
const listOf = (state, name) => (state.lists.get(name) || []).map((it) => it.v);
const json = (state) => JSON.stringify(snapshot(state));

function sameUnderShuffles(blocks, times, seed, genesisOwner = owner.pub, extra = {}) {
  const rand = mulberry32(seed);
  const want = stateOf(blocks, genesisOwner, extra);
  const wantJson = json(want);
  const wantTomb = JSON.stringify(Array.from(want.tombstoned).sort());
  const wantRed = JSON.stringify(Array.from(want.redacted).sort());
  for (let i = 0; i < times; i++) {
    const st = stateOf(shuffle(rand, blocks), genesisOwner, extra);
    assert.equal(json(st), wantJson, 'shuffle ' + i);
    assert.equal(JSON.stringify(Array.from(st.tombstoned).sort()), wantTomb);
    assert.equal(JSON.stringify(Array.from(st.redacted).sort()), wantRed);
  }
  return want;
}

test("owner switches writers to 'owner', then a stranger's block with prev at depth 0 is a no-op on 1 000 shuffles", async () => {
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const A = await put(alice, 'a', 1, [G.h]);
  const P = await policy(owner, { writers: 'owner' }, [A.h]);
  const S = await put(stranger, 'b', 2, [G.h]);
  const S2 = await put(stranger, 'a', 3, [G.h]);
  const S3 = await append(stranger, 'gb', 'spam', [G.h]);
  const O = await put(owner, 'c', 4, [P.h, S.h]);
  const L = await put(alice, 'd', 5, [P.h]);
  const blocks = [G, A, P, S, S2, S3, O, L];
  const dag = dagOf(blocks);
  assert.equal(dag.depth(G.h), 0);
  assert.equal(dag.depth(S.h), 1, "the stranger's prev sits at depth 0");
  const st = sameUnderShuffles(blocks, 1000, 0x5717c4);
  assert.deepEqual(kvOf(st), { a: 1, c: 4 });
  assert.deepEqual(Array.from(st.lists.keys()), []);
  assert.equal(st.policy.writers, 'owner');
  assert.equal(st.owner, owner.pub);
  assert.equal(st.height, 8);
  assert.equal(roleOf(stranger.pub, st), 'reader');
  assert.equal(roleOf(owner.pub, st), 'owner');
});

test('a bits increase governs concurrent and later writes; the minBits floor applies to non-privileged authors', async () => {
  const G = await policy(owner, { writers: 'open', bits: 4 }, []);
  const A = await put(alice, 'x', 1, [G.h], { bits: 4 });
  const P = await policy(owner, { bits: 10 }, [A.h]);
  const B = await put(bob, 'y', 2, [G.h], { bits: 4 });
  const C = await put(bob, 'z', 3, [P.h], { bits: 10 });
  const D = await put(alice, 'w', 4, [P.h], { bits: 4 });
  const E = await put(bob, 'v', 5, [G.h], { bits: 10 });
  const O = await put(owner, 'o', 6, [P.h]);
  const blocks = [G, A, P, B, C, D, E, O];
  for (const b of blocks) assert.deepEqual(await validateBlock(b), { ok: true });
  const st = sameUnderShuffles(blocks, 200, 0xb175);
  assert.deepEqual(kvOf(st), { x: 1, z: 3, v: 5, o: 6 });
  assert.equal(st.policy.bits, 10);
  const floored = stateOf(blocks, owner.pub, { minBits: 12 });
  assert.deepEqual(kvOf(floored), { o: 6 }, 'the owner is exempt from the floor');
});

test("ban removes the author's effects, past and future; strangers cannot ban; the owner is exempt", async () => {
  const G = await policy(owner, { writers: 'open', bits: 0, moderators: [mod.pub] }, []);
  const X1 = await put(alice, 'k', 'alice', [G.h]);
  const X2 = await append(alice, 'gb', 'hi from alice', [X1.h]);
  const X3 = await profile(alice, 'Alice', [X1.h]);
  const Y1 = await append(bob, 'gb', 'hi from bob', [G.h]);
  const OW = await put(owner, '_notice', 'welcome', [G.h]);
  const B1 = await ban(owner, alice.pub, [X2.h, X3.h]);
  const X4 = await put(alice, 'k2', 'after the ban', [B1.h]);
  const SB = await ban(stranger, bob.pub, [Y1.h]);
  const MB = await ban(mod, owner.pub, [OW.h]);
  const OW2 = await put(owner, 'late', 1, [MB.h]);
  const blocks = [G, X1, X2, X3, Y1, OW, B1, X4, SB, MB, OW2];
  const st = sameUnderShuffles(blocks, 200, 0xba11);
  assert.deepEqual(kvOf(st), { _notice: 'welcome', late: 1 });
  assert.deepEqual(listOf(st, 'gb'), ['hi from bob']);
  assert.equal(st.profiles.size, 0);
  assert.deepEqual(snapshot(st).policy.banned, [alice.pub, owner.pub].sort());
  for (const b of [X1, X2, X3, X4]) assert.ok(st.redacted.has(b.h), 'banned payloads lose their value');
  for (const b of [OW, OW2, Y1]) assert.ok(!st.redacted.has(b.h));
  assert.equal(roleOf(alice.pub, st), 'reader');
  assert.equal(roleOf(bob.pub, st), 'writer');
  assert.equal(roleOf(mod.pub, st), 'moderator');
  assert.equal(roleOf(owner.pub, st), 'owner');
  const MB2 = await ban(mod, bob.pub, [Y1.h]);
  const st2 = stateOf(blocks.concat(MB2));
  assert.deepEqual(listOf(st2, 'gb'), [], 'a moderator ban works too');
  assert.equal(snapshot(st2).lists.gb, undefined);
});

test('allow add/remove follow the causal fold', async () => {
  const G = await policy(owner, { writers: 'allow', bits: 0 }, []);
  const W0 = await put(alice, 'w0', 0, [G.h]);
  const AL1 = await allow(owner, [alice.pub], [], [W0.h]);
  const W1 = await put(alice, 'w1', 1, [AL1.h]);
  const W2 = await put(alice, 'w2', 2, [G.h]);
  const AL2 = await allow(owner, [], [alice.pub], [W1.h, W2.h]);
  const W3 = await put(alice, 'w3', 3, [AL1.h]);
  const W4 = await put(alice, 'w4', 4, [AL2.h]);
  const BOB = await put(bob, 'b', 5, [AL2.h]);
  const POL = await policy(owner, { allow: [bob.pub] }, [BOB.h]);
  const BOB2 = await put(bob, 'b2', 6, [POL.h]);
  const W5 = await put(alice, 'w5', 7, [POL.h]);
  const blocks = [G, W0, AL1, W1, W2, AL2, W3, W4, BOB, POL, BOB2, W5];
  const st = sameUnderShuffles(blocks, 200, 0xa110);
  // W0: seen by the add, so judged without it. W2: concurrent with the add, so it is allowed.
  // W3: concurrent with the removal, so it is not. BOB: seen by the policy that allows bob.
  assert.deepEqual(kvOf(st), { w1: 1, w2: 2, b2: 6 });
  assert.deepEqual(Array.from(st.policy.allow), [bob.pub]);
  assert.equal(roleOf(bob.pub, st), 'writer');
  assert.equal(roleOf(alice.pub, st), 'reader');
  assert.equal(snapshot(st).policy.allowCount, 1);

  // controlFor (literal INTERFACES helper) agrees with the reducer.
  const dag = dagOf(blocks);
  const controls = dag.order().filter((b) => ['policy', 'allow'].includes(b.e.op.t));
  const memo = new Map();
  const cf = (b) => controlFor(dag, b.h, controls, memo, { genesisOwner: owner.pub });
  assert.equal(cf(W0).allow.has(alice.pub), false);
  assert.equal(cf(W2).allow.has(alice.pub), true);
  assert.equal(cf(W3).allow.has(alice.pub), false);
  assert.deepEqual(Array.from(cf(W5).allow), [bob.pub]);
  assert.equal(cf(BOB).allow.has(bob.pub), false);
  assert.equal(cf(W0).writers, 'allow');
  assert.ok(memo.size > 0, 'ancestor sets are memoised in the given Map');
  const withBan = controlFor(dag, W0.h, controls.concat([{ h: 'x', e: { op: { t: 'ban', author: bob.pub } } }]), memo, { genesisOwner: owner.pub });
  assert.ok(withBan.banned.has(bob.pub), 'bans are global');
  assert.equal(controlFor(dag, W0.h, [], null, { genesisOwner: null }).writers, 'open', 'ownerless base');
});

test('succession: earlier tombstones still apply, only the new owner issues control ops', async () => {
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const E1 = await append(alice, 'gb', 'one', [G.h]);
  const E2 = await append(alice, 'gb', 'two', [G.h]);
  const E3 = await append(alice, 'gb', 'three', [G.h]);
  const T1 = await tomb(owner, E1.h, [E1.h]);
  const O = await succession(owner, owner2.pub, [T1.h, E2.h]);
  const Pold = await policy(owner, { writers: 'owner' }, [O.h]);
  const Pconc = await policy(owner2, { writers: 'owner' }, [T1.h]);
  const Told = await tomb(owner, E2.h, [O.h]);
  const Tnew = await tomb(owner2, E3.h, [O.h]);
  const N1 = await put(owner2, '_notice', 'new owner', [O.h]);
  const N0 = await put(owner, '_old', 'x', [O.h]);
  const W = await put(alice, 'k', 1, [O.h]);
  const blocks = [G, E1, E2, E3, T1, O, Pold, Pconc, Told, Tnew, N1, N0, W];
  const st = sameUnderShuffles(blocks, 200, 0x0e2);
  assert.deepEqual(listOf(st, 'gb'), ['two']);
  assert.deepEqual(kvOf(st), { _notice: 'new owner', k: 1 });
  assert.equal(st.owner, owner2.pub);
  assert.equal(st.policy.writers, 'open', 'both late policies were invalid');
  assert.deepEqual(Array.from(st.tombstoned).sort(), [E1.h, E3.h].sort());
  assert.equal(roleOf(owner2.pub, st), 'owner');
  assert.equal(roleOf(owner.pub, st), 'writer');

  const dag = dagOf(blocks);
  assert.equal(ownerAt(dag, T1.h, owner.pub), owner.pub);
  assert.equal(ownerAt(dag, O.h, owner.pub), owner.pub);
  assert.equal(ownerAt(dag, Pold.h, owner.pub), owner2.pub);
  assert.equal(ownerAt(dag, Pconc.h, owner.pub), owner.pub);
  assert.equal(ownerAt(dag, 'f'.repeat(64), owner.pub), null);
  assert.equal(ownerAt(dag, O.h, null), null);
  assert.equal(ownerAfter(dag, [O.h], owner.pub), owner2.pub);
  assert.equal(ownerAfter(dag, [G.h, E3.h], owner.pub), owner.pub);
  assert.equal(ownerAfter(dag, [], owner.pub), owner.pub);

  // A second handover by the new owner counts; one by the old key after the first does not.
  const O2 = await succession(owner2, owner3.pub, [O.h]);
  const Obad = await succession(owner, stranger.pub, [O.h]);
  const P3 = await policy(owner3, { writers: 'owner' }, [O2.h, W.h]); // owner3 saw W
  const st2 = stateOf(blocks.concat([O2, Obad, P3]));
  assert.equal(st2.owner, owner3.pub);
  assert.equal(st2.policy.writers, 'owner');
  assert.equal(ownerAfter(dagOf(blocks.concat([O2, Obad, P3])), [Obad.h], owner.pub), owner2.pub);
  // code review round 1 (a succession is a revocation): N1, owner2's '_' write beside its own hand-over O2 (not
  // in O2's causal past), no longer has owner standing; W, which owner3 saw, keeps its effect.
  assert.deepEqual(kvOf(st2), { k: 1 }, 'a write the new owner saw keeps its effect');
  const W2 = await put(alice, 'k2', 2, [O.h]); // concurrent with P3: governed by it
  assert.deepEqual(kvOf(stateOf(blocks.concat([O2, Obad, P3, W2]))), { k: 1 });
  const N1after = await put(owner2, '_notice', 'before the hand-over', [N1.h]);
  const O2b = await succession(owner2, owner3.pub, [N1after.h]);
  assert.deepEqual(kvOf(stateOf(blocks.concat([N1after, O2b]))), { _notice: 'before the hand-over', k: 1 }, 'what the old key wrote before its hand-over stays valid');
});

test('code review round 1: a succession revokes the old key (side-branch control blocks, bans, a second hand-over)', async () => {
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const V = await append(alice, 'gb', 'visitor post', [G.h]);
  const Before = await policy(owner, { moderators: [mod.pub] }, [V.h]); // the old key, before its hand-over
  const S1 = await succession(owner, owner2.pub, [Before.h]); // K1 -> K2
  // The old key, on a side branch whose causal past omits S1.
  const Pside = await policy(owner, { writers: 'owner', moderators: [stranger.pub] }, [V.h]);
  const Bside = await ban(owner, alice.pub, [Pside.h]);
  const Tside = await tomb(owner, V.h, [Bside.h]);
  const Pad1 = await put(owner, 'pad1', 1, [Tside.h]);
  const S2 = await succession(owner, owner3.pub, [Pad1.h]); // K1 -> K3, equivocating with S1
  // The new owner's endorsement: any block signed by K2 that has S1 in its causal past.
  const Endorse = await policy(owner2, {}, [S1.h]);
  const honest = [G, V, Before, S1, Endorse];
  const attack = [Pside, Bside, Tside, Pad1, S2];

  // At ingest, on a node that holds S1: the old key has no owner standing at all.
  const dag = dagOf(honest);
  const st = reduce(dag, { genesisOwner: owner.pub, expectedOwner: owner2.pub });
  assert.equal(st.owner, owner2.pub);
  const verdict = (b, d = dag, s = st) => {
    const r = admit(s, b, { dag: d, genesisOwner: owner.pub, expectedOwner: owner2.pub });
    return r.ok ? 'ok' : r.code;
  };
  assert.equal(verdict(Pside), 'E_NOT_OWNER', 'side-branch policy');
  assert.equal(verdict(await ban(owner, alice.pub, [V.h])), 'E_NOT_MODERATOR', 'side-branch ban');
  assert.equal(verdict(await tomb(owner, V.h, [V.h])), 'E_NOT_MODERATOR', 'side-branch tombstone of a post by someone else');
  assert.equal(verdict(await succession(owner, owner3.pub, [V.h])), 'E_NOT_OWNER', 'second hand-over by the old key');
  assert.equal(verdict(await policy(owner, { writers: 'owner' }, [S1.h])), 'E_NOT_OWNER', 'old key after its hand-over');
  assert.equal(verdict(await policy(owner2, { writers: 'owner' }, [Endorse.h])), 'ok', 'the new owner');
  assert.equal(verdict(await policy(owner2, { writers: 'owner' }, [V.h])), 'E_NOT_OWNER', 'the new key before S1 is in its past');

  // Every block present (gossip merged both branches): no side-branch effect under 200 shuffles.
  const all = honest.concat(attack);
  const anchored = sameUnderShuffles(all, 200, 0xc0de1, owner.pub, { expectedOwner: owner2.pub });
  assert.equal(anchored.owner, owner2.pub, 'the endorsed hand-over wins');
  assert.equal(anchored.ownerConflict, false);
  assert.equal(anchored.policy.writers, 'open');
  assert.deepEqual(Array.from(anchored.policy.moderators), [mod.pub], 'the old key kept what it set before the hand-over');
  assert.deepEqual(Array.from(anchored.policy.banned), [], 'no ban');
  assert.deepEqual(listOf(anchored, 'gb'), ['visitor post'], 'the visitor post keeps its effect and its value');
  assert.equal(anchored.redacted.has(V.h), false);
  for (const b of attack) assert.equal(anchored.effective.has(b.h), b === Pad1, 'only the plain put by the old key counts (as an ordinary write)');
  assert.equal(roleOf(owner2.pub, anchored), 'owner');
  assert.equal(roleOf(owner.pub, anchored), 'writer');

  // Without the anchor the two hand-overs are contested: owner changes pause, and still nothing
  // the old key signed beside S1 takes effect.
  const contested = sameUnderShuffles(all, 50, 0xc0de2, owner.pub, {});
  assert.equal(contested.ownerConflict, true);
  assert.equal(contested.owner, owner.pub);
  assert.equal(contested.policy.writers, 'open');
  assert.deepEqual(Array.from(contested.policy.moderators), [], 'only the common past of both hand-overs keeps standing (Before is not in S2\'s past)');
  assert.deepEqual(Array.from(contested.policy.banned), []);
  assert.deepEqual(listOf(contested, 'gb'), ['visitor post']);
  assert.equal(roleOf(owner.pub, contested), 'writer', 'a contested key is not shown as the owner');
  assert.equal(contested.effective.has(Endorse.h), false, 'K2 has no standing while contested');
  // An anchor that is not reached by an endorsement (K3 never signed anything) does not decide it.
  assert.equal(stateOf(all, owner.pub, { expectedOwner: owner3.pub }).ownerConflict, true);

  // Under a conflict, the endorsement by expectedOwner is admitted (it resolves the conflict).
  const cdag = dagOf(honest.filter((b) => b !== Endorse).concat(attack));
  const cst = reduce(cdag, { genesisOwner: owner.pub, expectedOwner: owner2.pub });
  assert.equal(cst.ownerConflict, true);
  assert.equal(verdict(Endorse, cdag, cst), 'ok');
  assert.equal(verdict(await policy(owner2, {}, [S1.h, S2.h]), cdag, cst), 'E_NOT_OWNER', 'an endorsement of both is no endorsement');
  assert.equal(verdict(await policy(owner3, {}, [S2.h]), cdag, cst), 'E_NOT_OWNER', 'only expectedOwner endorses');
});

test('code review round 1: a hand-over to the author itself is a no-op; the chain is a function of the block set', async () => {
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const Self = await succession(owner, owner.pub, [G.h]);
  const st = stateOf([G, Self]);
  assert.equal(st.owner, owner.pub);
  assert.equal(st.effective.has(Self.h), false);
  assert.equal(admit(reduce(dagOf([G]), { genesisOwner: owner.pub }), Self, { dag: dagOf([G]), genesisOwner: owner.pub }).code, 'E_POLICY');
  // Two hand-overs to the same key are still two candidates: without an endorsement they are contested.
  const A = await succession(owner, owner2.pub, [G.h]);
  const B = await succession(owner, owner2.pub, [Self.h]);
  assert.equal(stateOf([G, Self, A, B]).ownerConflict, true);
  // One that saw the other is superseded, not contested.
  const C = await succession(owner, owner3.pub, [A.h]);
  const st2 = stateOf([G, A, C]);
  assert.equal(st2.ownerConflict, false);
  assert.equal(st2.owner, owner2.pub);
  assert.equal(st2.effective.has(C.h), false);
});

test('a non-owner root is rejected together with blocks that only it reaches', async () => {
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const A = await put(alice, 'a', 1, [G.h]);
  const R = await put(stranger, 'r', 1, []);
  const RC = await put(stranger, 'rc', 2, [R.h]);
  const MIX = await put(bob, 'mix', 3, [A.h, R.h]);
  const RP = await policy(stranger, { writers: 'owner' }, []);
  const st = sameUnderShuffles([G, A, R, RC, MIX, RP], 100, 0x2007);
  assert.deepEqual(kvOf(st), { a: 1, mix: 3 });
  assert.equal(st.policy.writers, 'open');
  assert.deepEqual(await validateBlock(R, { genesisOwner: owner.pub }), { ok: false, reason: 'shape' });
  assert.deepEqual(await validateBlock(G, { genesisOwner: owner.pub }), { ok: true });
  const owner2Root = await policy(owner2, {}, []);
  assert.deepEqual(await validateBlock(owner2Root, { genesisOwner: owner.pub }), { ok: false, reason: 'shape' }, 'only the genesis owner creates roots');
});

test("'_' keys and lists are owner/moderator-only", async () => {
  const G = await policy(owner, { writers: 'open', bits: 0, moderators: [mod.pub] }, []);
  const blocks = [
    G,
    await put(stranger, '_notice', 'spam', [G.h]),
    await append(stranger, '_log', 'spam', [G.h]),
    await put(owner, '_notice', 'hello', [G.h]),
    await put(mod, '_pinned', 'mod note', [G.h]),
    await append(mod, '_log', 'entry', [G.h]),
    await put(stranger, 'notice_', 'fine', [G.h]),
  ];
  const st = sameUnderShuffles(blocks, 50, 0x5f);
  assert.deepEqual(kvOf(st), { _notice: 'hello', _pinned: 'mod note', notice_: 'fine' });
  assert.deepEqual(listOf(st, '_log'), ['entry']);
});

test('tombstone by owner / moderator / author takes effect; by a stranger it is ignored', async () => {
  const G = await policy(owner, { writers: 'open', bits: 4, moderators: [mod.pub] }, []);
  const E = [];
  for (let i = 1; i <= 6; i++) E.push(await append(alice, 'gb', 'e' + i, [G.h], { bits: 4 }));
  const [E1, E2, E3, E4, E5, E6] = E;
  const TO = await tomb(owner, E1.h, [E1.h]);
  const TM = await tomb(mod, E2.h, [E2.h]);
  const TA = await tomb(alice, E3.h, [E3.h], { bits: 4 });
  const TS = await tomb(stranger, E4.h, [E4.h], { bits: 4 });
  const TA0 = await tomb(alice, E5.h, [E5.h]);
  const TC = await tomb(owner, G.h, [E1.h]);
  const TT = await tomb(owner, TO.h, [TO.h]);
  const TU = await tomb(owner, E6.h, [G.h]);
  const Prm = await policy(owner, { moderators: [] }, [TM.h]);
  const TM2 = await tomb(mod, E4.h, [E4.h]);
  const blocks = [G, E1, E2, E3, E4, E5, TO, TM, TA, TS, TA0, TC, TT, TU, Prm, TM2];
  const st = sameUnderShuffles(blocks, 200, 0x7b);
  const remaining = [E4, E5].sort((a, b) => (a.h < b.h ? -1 : 1)).map((b) => b.v);
  assert.deepEqual(listOf(st, 'gb'), remaining);
  assert.deepEqual(Array.from(st.tombstoned).sort(), [E1.h, E2.h, E3.h, E6.h].sort(), 'an unknown target is recorded');
  assert.equal(st.policy.writers, 'open', 'a control block cannot be tombstoned');
  assert.equal(st.policy.moderators.size, 0);
  for (const b of [E1, E2, E3]) assert.ok(st.redacted.has(b.h));
  const later = stateOf(blocks.concat(E6));
  assert.deepEqual(listOf(later, 'gb'), remaining, 'the target is hidden when it arrives');
  assert.ok(later.redacted.has(E6.h));
});

test('v-less payload blocks count as DAG nodes only', async () => {
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const A = await put(alice, 'k', 'old', [G.h]);
  const B = await put(alice, 'k', 'new', [A.h]);
  const L = await append(alice, 'gb', 'entry', [A.h]);
  const dag = dagOf([G, A, B, L]);
  const before = reduce(dag, { genesisOwner: owner.pub });
  assert.deepEqual(kvOf(before), { k: 'new' });
  const root = dag.root();
  dag.redact(B.h);
  dag.redact(L.h);
  const after = reduce(dag, { genesisOwner: owner.pub });
  assert.deepEqual(kvOf(after), { k: 'old' });
  assert.deepEqual(listOf(after, 'gb'), []);
  assert.equal(after.height, 4);
  assert.equal(dag.root(), root);
  assert.ok(after.bytes < before.bytes);
});

test('put is last-writer-wins in total order; same-depth ties go by h; null deletes', async () => {
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const X = await put(alice, 'k', 'alice', [G.h]);
  const Y = await put(bob, 'k', 'bob', [G.h]);
  const winner = X.h > Y.h ? 'alice' : 'bob';
  assert.deepEqual(kvOf(sameUnderShuffles([G, X, Y], 50, 1)), { k: winner });
  const Z = await put(alice, 'k', null, [X.h, Y.h]);
  assert.deepEqual(kvOf(stateOf([G, X, Y, Z])), {});
  const W = await put(bob, 'k', 'again', [Z.h]);
  const st = stateOf([G, X, Y, Z, W]);
  assert.deepEqual(kvOf(st), { k: 'again' });
  const entry = st.kv.get('k');
  assert.equal(entry.author, bob.pub);
  assert.equal(entry.h, W.h);
  assert.equal(entry.ts, T0);
});

test('append order follows the total order; items carry { h, author, ts, v }', async () => {
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const L1 = await append(alice, 'gb', 1, [G.h]);
  const L2 = await append(bob, 'gb', 2, [G.h]);
  const L3 = await append(alice, 'gb', 3, [L1.h]);
  const L4 = await append(bob, 'gb', 4, [L2.h, L3.h]);
  const L5 = await append(stranger, 'gb', 5, [G.h]);
  const blocks = [G, L1, L2, L3, L4, L5];
  const st = sameUnderShuffles(blocks, 100, 0xa9);
  const dag = dagOf(blocks);
  const expected = dag.order().filter((b) => b.e.op.t === 'append').map((b) => b.v);
  assert.deepEqual(listOf(st, 'gb'), expected);
  for (const item of st.lists.get('gb')) assert.deepEqual(Object.keys(item).sort(), ['author', 'h', 'ts', 'v']);
  const snap = snapshot(st);
  assert.deepEqual(snap.lists.gb.map((it) => it.v), expected, 'snapshot lists are oldest first');
  snap.lists.gb[0].v = 'mutated';
  assert.notEqual(st.lists.get('gb')[0].v, 'mutated', 'snapshot items are copies');
});

test("profiles: last writer wins per author, '' clears, invalid names are ignored", async () => {
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const P1 = await profile(alice, 'Alice', [G.h]);
  const P2 = await profile(alice, 'Alice B', [P1.h]);
  const P3 = await profile(bob, 'Bob', [G.h]);
  const P4 = await profile(bob, '', [P3.h]);
  const st = sameUnderShuffles([G, P1, P2, P3, P4], 50, 0x9f);
  assert.deepEqual(Object.fromEntries(st.profiles), { [alice.pub]: 'Alice B' });
  // A malformed name that bypassed validateBlock is still ignored by the reducer.
  const vh = hex.encode(sha256Sync(utf8.encode(canonicalize('bad' + String.fromCharCode(10)))));
  const e = { v: 1, site: SITE, author: bob.pub, seq: 999, prev: [G.h], ts: T0, bits: 0, op: { t: 'profile', vh }, nonce: '' };
  const forged = { e, h: hex.encode(sha256Sync(utf8.encode(canonicalize(e)))), s: SIG, v: 'bad' + String.fromCharCode(10) };
  assert.equal(stateOf([G, forged]).profiles.size, 0);
});

test('maxValueBytes comes from the governing policy; bytes and capReached are reported', async () => {
  const G = await policy(owner, { writers: 'open', bits: 0, maxValueBytes: 100, maxChainBytes: 2000 }, []);
  const A = await put(alice, 'small', 'x'.repeat(50), [G.h]);
  const B = await put(alice, 'big', 'y'.repeat(300), [G.h]);
  const O = await put(owner, 'owner-big', 'z'.repeat(300), [G.h]);
  const R = await policy(owner, { maxValueBytes: 1000 }, [A.h, B.h, O.h]);
  const C = await put(alice, 'later', 'w'.repeat(300), [R.h]);
  const blocks = [G, A, B, O, R, C];
  const st = sameUnderShuffles(blocks, 50, 0xcab);
  assert.deepEqual(Object.keys(kvOf(st)).sort(), ['later', 'small']);
  const dag = dagOf(blocks);
  assert.equal(st.bytes, dag.bytes);
  assert.equal(st.capReached, dag.bytes >= 2000);
  assert.equal(st.capReached, true);
  assert.equal(snapshot(st).capReached, true);
  assert.equal(stateOf([G, A]).capReached, false);
});

test('ownerless ledger (genesisOwner null): open writing with the default fee, author tombstones only', async () => {
  const R1 = await put(alice, 'a', 1, [], { bits: 16 });
  const R2 = await append(bob, 'gb', 'hi', [R1.h], { bits: 16 });
  const LOW = await put(bob, 'low', 1, [R1.h]);
  const POL = await policy(owner, { writers: 'owner' }, [R1.h]);
  const BAN = await ban(owner, bob.pub, [R1.h]);
  const SUC = await succession(owner, alice.pub, [R1.h]);
  const TA = await tomb(alice, R1.h, [R2.h], { bits: 16 });
  const U = await put(bob, '_x', 1, [R2.h], { bits: 16 });
  const blocks = [R1, R2, LOW, POL, BAN, SUC, TA, U];
  const st = sameUnderShuffles(blocks, 50, 0x0011, null);
  assert.deepEqual(kvOf(st), {});
  assert.deepEqual(listOf(st, 'gb'), ['hi']);
  assert.equal(st.owner, null);
  assert.equal(st.ownerless, true);
  assert.equal(st.policy.writers, 'open');
  assert.equal(st.policy.bits, 16);
  assert.equal(st.policy.banned.size, 0);
  assert.deepEqual(Array.from(st.tombstoned), [R1.h]);
  assert.equal(roleOf(alice.pub, st), 'writer');
  assert.equal(roleOf(owner.pub, st), 'writer');
  assert.equal(snapshot(st).unmoderated, true);
  assert.equal(ownerAfter(dagOf(blocks), [R1.h], null), null);
});

test('snapshot is plain JSON with sorted arrays; "__proto__" keys stay data', async () => {
  const G = await policy(owner, { writers: 'open', bits: 0, moderators: [mod.pub, bob.pub] }, []);
  const P = await put(owner, '__proto__', { polluted: true }, [G.h]); // '_' keys are owner/moderator-only
  const N = await profile(alice, 'Alice', [G.h]);
  const st = stateOf([G, P, N]);
  const snap = snapshot(st);
  assert.equal(Object.getPrototypeOf(snap.kv), Object.prototype);
  assert.ok(Object.prototype.hasOwnProperty.call(snap.kv, '__proto__'));
  assert.deepEqual(snap.kv.__proto__, { polluted: true });
  assert.equal(({}).polluted, undefined, 'Object.prototype untouched');
  assert.deepEqual(JSON.parse(JSON.stringify(snap)).kv, { ['__proto__']: { polluted: true } });
  assert.deepEqual(snap.policy.moderators, [mod.pub, bob.pub].sort());
  // v0.3 freeze group: keychange, checkpoint and the new policy fields (ARCHITECTURE 15.4).
  assert.deepEqual(Object.keys(snap).sort(), ['authors', 'bytes', 'capReached', 'checkpoint', 'depth', 'height', 'keychange', 'kv', 'lists', 'owner', 'policy', 'profiles', 'unmoderated']);
  assert.deepEqual(Object.keys(snap.policy).sort(), ['allowCount', 'banUntil', 'banned', 'bits', 'maxChainBytes', 'maxValueBytes', 'modActionsPerHour', 'modAllowPerDay', 'moderators', 'reservedPool', 'voided', 'writers']);
  assert.deepEqual(snap.policy.banUntil, {}, 'no temporary ban');
  assert.deepEqual([snap.policy.modAllowPerDay, snap.policy.modActionsPerHour, snap.policy.reservedPool, snap.policy.voided], [20, 60, 25, []]);
  assert.equal(snap.checkpoint, null);
  assert.deepEqual(snap.keychange, {});
  assert.equal(snap.height, 3);
  assert.equal(snap.depth, 1);
  assert.equal(snap.authors, 2, 'owner and alice');
  assert.equal(snap.owner, owner.pub);
  assert.equal(snap.profiles[alice.pub], 'Alice');
  assert.deepEqual(structuredClone(snap), snap);
});

test('roleOf', async () => {
  const G = await policy(owner, { writers: 'allow', bits: 0, moderators: [mod.pub], allow: [alice.pub, bob.pub] }, []);
  const B = await ban(owner, bob.pub, [G.h]);
  const st = stateOf([G, B]);
  assert.equal(roleOf(owner.pub, st), 'owner');
  assert.equal(roleOf(mod.pub, st), 'moderator');
  assert.equal(roleOf(alice.pub, st), 'writer');
  assert.equal(roleOf(bob.pub, st), 'reader', 'banned');
  assert.equal(roleOf(stranger.pub, st), 'reader');
  assert.equal(roleOf(null, st), 'reader');
  assert.equal(roleOf(alice.pub, null), 'reader');
  const empty = reduce(new Dag(), { genesisOwner: owner.pub });
  assert.equal(empty.owner, owner.pub);
  assert.equal(empty.policy.writers, 'owner', 'DEFAULT_POLICY before the genesis block arrives');
  assert.equal(roleOf(alice.pub, empty), 'reader');
  assert.equal(empty.height, 0);
  assert.equal(empty.depth, -1);
});

// ---------------------------------------------------------------------------------------------
// Synthetic blocks: real e and h (sha256Sync), placeholder signature. reduce() never checks s.
// ---------------------------------------------------------------------------------------------

let serial = 0;
function synth(author, op, value, prev, bits = 0) {
  serial++;
  let full = op;
  if (op.t === 'put' || op.t === 'append' || op.t === 'profile') {
    full = Object.assign({}, op, { vh: hex.encode(sha256Sync(utf8.encode(canonicalize(value)))) });
  }
  const e = { v: 1, site: SITE, author, seq: serial, prev: Array.from(new Set(prev)).sort(), ts: T0, bits, op: full, nonce: '' };
  const block = { e, h: hex.encode(sha256Sync(utf8.encode(canonicalize(e)))), s: SIG };
  if (value !== undefined) block.v = value;
  return block;
}

function fakeKeys(rand, n) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  return Array.from({ length: n }, () => 'B' + Array.from({ length: 86 }, () => alphabet[Math.floor(rand() * 64)]).join(''));
}

// Brute force of the round-1 succession chain (state.js header), with full ancestor sets.
function bruteSuccession(dag, genesisOwner, expectedOwner = null) {
  const order = dag.order();
  const anc = new Map(order.map((b) => [b.h, dag.ancestors(b.h)]));
  const reach = new Map();
  for (const b of order) reach.set(b.h, b.e.prev.length === 0 ? b.e.author === genesisOwner : b.e.prev.some((p) => reach.get(p)));
  const keys = [genesisOwner];
  const chosen = [];
  let frozen = false;
  let conflict = [];
  const levelOf = (h) => chosen.filter((c) => anc.get(h).has(c.h)).length;
  for (;;) {
    const m = keys.length - 1;
    let cand = order.filter((b) => reach.get(b.h) && b.e.op.t === 'owner' && b.e.op.next !== b.e.author && b.e.author === keys[m] && levelOf(b.h) === m);
    cand = cand.filter((c) => !cand.some((d) => d !== c && anc.get(c.h).has(d.h)));
    if (cand.length === 0) break;
    let pick = cand.length === 1 ? cand[0] : null;
    if (!pick && expectedOwner && !keys.includes(expectedOwner)) {
      const endorsers = order.filter((b) => reach.get(b.h) && b.e.author === expectedOwner);
      const single = (x) => cand.filter((d) => anc.get(x.h).has(d.h));
      const endorsed = cand.filter((c) => endorsers.some((x) => { const s = single(x); return s.length === 1 && s[0] === c; }));
      if (endorsed.length === 1) pick = endorsed[0];
    }
    if (!pick) {
      frozen = true;
      conflict = cand;
      break;
    }
    chosen.push(pick);
    keys.push(pick.e.op.next);
  }
  const owners = new Map();
  const standing = new Map();
  for (const b of order) {
    const lv = levelOf(b.h);
    owners.set(b.h, keys[lv]);
    let s = reach.get(b.h) && b.e.author === keys[lv];
    if (s && lv < chosen.length) s = chosen[lv].h === b.h || anc.get(chosen[lv].h).has(b.h);
    else if (s && frozen) s = conflict.every((c) => anc.get(c.h).has(b.h));
    standing.set(b.h, s);
  }
  return { keys, owners, standing, chosen: new Set(chosen.map((c) => c.h)), frozen, current: keys[keys.length - 1] };
}

test('ownerAt / ownerAfter / state.owner, standing and contested hand-overs agree with a brute-force definition on random DAGs', () => {
  const rand = mulberry32(0x0a7);
  let conflicts = 0;
  let anchoredRounds = 0;
  for (let round = 0; round < 40; round++) {
    const keys = fakeKeys(rand, 4);
    const k0 = keys[0];
    const blocks = [synth(k0, { t: 'policy' }, undefined, [])];
    for (let i = 0; i < 80; i++) {
      const author = keys[Math.floor(rand() * keys.length)];
      const lo = Math.max(0, blocks.length - 10);
      const prev = rand() < 0.03 ? [] : [blocks[lo + Math.floor(rand() * (blocks.length - lo))].h, blocks[lo + Math.floor(rand() * (blocks.length - lo))].h];
      const op = rand() < 0.25 ? { t: 'owner', next: keys[Math.floor(rand() * keys.length)] } : rand() < 0.2 ? { t: 'policy', bits: 1 } : { t: 'put', k: 'k' };
      blocks.push(op.t === 'put' ? synth(author, op, i, prev) : synth(author, op, undefined, prev));
    }
    const dag = dagOf(shuffle(rand, blocks));
    for (const expected of [null, keys[1 + Math.floor(rand() * 3)]]) {
      const brute = bruteSuccession(dag, k0, expected);
      if (brute.frozen) conflicts++;
      for (const b of blocks) assert.equal(ownerAt(dag, b.h, k0, expected), brute.owners.get(b.h));
      const st = reduce(dag, { genesisOwner: k0, expectedOwner: expected });
      assert.equal(st.owner, brute.current);
      assert.equal(st.ownerConflict, brute.frozen);
      const heads = dag.heads({ limit: Infinity });
      assert.equal(ownerAfter(dag, heads, k0, expected), brute.current);
      for (const b of blocks) {
        const t = b.e.op.t;
        // The genesis policy has no fields: writers 'owner', so a put takes effect exactly when
        // its author has owner standing, as does a policy; a succession when it is chosen.
        const want = t === 'owner' ? brute.chosen.has(b.h) : brute.standing.get(b.h);
        assert.equal(st.effective.has(b.h), want, t + ' ' + b.h.slice(0, 8));
      }
      if (expected && brute.chosen.size > 0) anchoredRounds++;
    }
  }
  assert.ok(conflicts > 0 && anchoredRounds > 0, conflicts + ' contested, ' + anchoredRounds + ' anchored');
});

function randomLedger(rand, count) {
  const keys = fakeKeys(rand, 12);
  const [own, own2, m1, m2] = keys;
  const writers = keys.slice(2);
  const spammers = keys.slice(10);
  const blocks = [synth(own, { t: 'policy', writers: 'open', bits: 2, moderators: [m1] }, undefined, [])];
  const payloads = [];
  for (let i = 1; i < count; i++) {
    const lo = Math.max(0, blocks.length - 16);
    const prev = [];
    const k = 1 + Math.floor(rand() * 3);
    for (let j = 0; j < k; j++) prev.push(blocks[lo + Math.floor(rand() * (blocks.length - lo))].h);
    const r = rand();
    const author = writers[Math.floor(rand() * writers.length)];
    const bits = rand() < 0.9 ? 2 : 0;
    let b;
    if (r < 0.5) b = synth(author, { t: 'append', l: rand() < 0.9 ? 'gb' : '_log' }, { text: 'post ' + i }, prev, bits);
    else if (r < 0.7) b = synth(author, { t: 'put', k: (rand() < 0.1 ? '_' : '') + 'key' + Math.floor(rand() * 40) }, rand() < 0.1 ? null : i, prev, bits);
    else if (r < 0.78) b = synth(author, { t: 'profile' }, 'name ' + (i % 7), prev, bits);
    else if (r < 0.88 && payloads.length > 0) {
      const target = payloads[Math.floor(rand() * payloads.length)];
      const who = [own, m1, m2, target.e.author, author][Math.floor(rand() * 5)];
      b = synth(who, { t: 'tombstone', h: target.h }, undefined, prev, 2);
    } else if (r < 0.91) b = synth([own, m1, author][Math.floor(rand() * 3)], { t: 'ban', author: spammers[Math.floor(rand() * spammers.length)] }, undefined, prev);
    else if (r < 0.95) {
      const fields = [{ writers: 'allow', allow: writers.slice(0, 6) }, { writers: 'open' }, { bits: 3 }, { bits: 2 }, { moderators: [m1, m2] }, { moderators: [m1] }, { allow: writers.slice(0, 4) }];
      b = synth(rand() < 0.8 ? own : author, Object.assign({ t: 'policy' }, fields[Math.floor(rand() * fields.length)]), undefined, prev);
    } else if (r < 0.98) b = synth(own, { t: 'allow', add: [writers[Math.floor(rand() * writers.length)]] }, undefined, prev);
    else b = synth(rand() < 0.5 ? own : own2, { t: 'owner', next: rand() < 0.5 ? own2 : own }, undefined, prev);
    if (b.e.op.t === 'put' || b.e.op.t === 'append' || b.e.op.t === 'profile') payloads.push(b);
    blocks.push(b);
  }
  return { blocks, owner: own };
}

test('convergence: random ledgers with every op type reduce identically under 100 shuffles', () => {
  const rand = mulberry32(0xc0ffee);
  for (let round = 0; round < 3; round++) {
    const { blocks, owner: own } = randomLedger(rand, 300);
    const want = reduce(dagOf(blocks), { genesisOwner: own, minBits: 1 });
    const wantJson = json(want);
    assert.ok(want.kv.size > 0 && want.lists.size > 0, 'the scenario has visible effects');
    for (let i = 0; i < 100; i++) {
      const st = reduce(dagOf(shuffle(rand, blocks)), { genesisOwner: own, minBits: 1 });
      assert.equal(json(st), wantJson);
      assert.deepEqual(Array.from(st.tombstoned).sort(), Array.from(want.tombstoned).sort());
      assert.equal(st.controlBlocks, want.controlBlocks);
    }
  }
});

test('reduce stays within budget for 5 000 blocks (target 50 ms; asserted < 200 ms)', () => {
  const rand = mulberry32(5000);
  const { blocks, owner: own } = randomLedger(rand, 5000);
  const dag = new Dag();
  for (const b of blocks) dag.add(b);
  assert.equal(dag.size, 5000);
  const t0 = performance.now();
  const first = reduce(dag, { genesisOwner: own });
  const firstMs = performance.now() - t0;
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    reduce(dag, { genesisOwner: own });
    runs.push(performance.now() - t);
  }
  runs.sort((a, b) => a - b);
  const median = runs[2];
  // eslint-disable-next-line no-console
  console.log(`# reduce(5000 blocks): first ${firstMs.toFixed(1)} ms, median of 5 ${median.toFixed(1)} ms, ` +
    `${first.controlBlocks} control blocks, depth ${first.depth}, ${first.kv.size} keys, ${(first.lists.get('gb') || []).length} list items`);
  assert.equal(first.height, 5000);
  assert.ok(median < 200, `median ${median.toFixed(1)} ms`);
});

test('admit() agrees with reduce() for every block at the moment it arrives (random ledgers)', () => {
  const rand = mulberry32(0xad317);
  let accepted = 0;
  let refused = 0;
  const codes = new Set();
  for (let round = 0; round < 3; round++) {
    const { blocks, owner: own } = randomLedger(rand, 300);
    const total = dagOf(blocks).order(); // arrival in total order: parents always first
    const dag = new Dag();
    let state = reduce(dag, { genesisOwner: own, minBits: 1 });
    for (const b of total) {
      const verdict = admit(state, b, { dag, genesisOwner: own, minBits: 1 });
      assert.equal(dag.add(b), 'added');
      state = reduce(dag, { genesisOwner: own, minBits: 1 });
      const tookEffect = state.effective.has(b.h);
      const payload = ['put', 'append', 'profile'].includes(b.e.op.t);
      const predicted = verdict.ok && !(payload && verdict.dropValue);
      assert.equal(predicted, tookEffect, `${b.e.op.t} by ${b.e.author.slice(0, 6)}: ${JSON.stringify(verdict)}`);
      if (verdict.ok) accepted++;
      else {
        refused++;
        codes.add(verdict.code);
      }
    }
  }
  assert.ok(accepted > 100 && refused > 20, `${accepted} accepted, ${refused} refused`);
  for (const code of ['E_NOT_OWNER', 'E_NOT_MODERATOR', 'E_BANNED', 'E_POLICY']) assert.ok(codes.has(code), code);
});

test('admit(): refusal codes for new blocks', async () => {
  const G = await policy(owner, { writers: 'allow', bits: 4, allow: [alice.pub], moderators: [mod.pub], maxValueBytes: 64 }, []);
  const A = await append(alice, 'gb', 'hi', [G.h], { bits: 4 });
  const B = await ban(owner, bob.pub, [A.h]);
  const dag = dagOf([G, A, B]);
  const state = reduce(dag, { genesisOwner: owner.pub });
  const check = async (block) => admit(state, block, { dag, genesisOwner: owner.pub });
  const code = async (block) => {
    const r = await check(block);
    return r.ok ? 'ok' : r.code + ':' + r.reason;
  };
  assert.equal(await code(await append(alice, 'gb', 'again', [B.h], { bits: 4 })), 'ok');
  assert.equal(await code(await append(alice, 'gb', 'cheap', [B.h], { bits: 2 })), 'E_POLICY:bits');
  assert.equal(await code(await append(stranger, 'gb', 'x', [B.h], { bits: 4 })), 'E_POLICY:allow');
  assert.equal(await code(await append(bob, 'gb', 'x', [B.h], { bits: 4 })), 'E_BANNED:banned');
  assert.equal(await code(await put(alice, '_notice', 'x', [B.h], { bits: 4 })), 'E_NOT_MODERATOR:underscore');
  assert.equal(await code(await put(mod, '_notice', 'x', [B.h])), 'ok', 'moderators: no PoW, "_" keys allowed');
  assert.equal(await code(await put(alice, 'big', 'x'.repeat(100), [B.h], { bits: 4 })), 'E_LIMIT:value-size');
  assert.equal(await code(await policy(alice, { writers: 'open' }, [B.h])), 'E_NOT_OWNER:owner-only');
  assert.equal(await code(await policy(mod, { writers: 'open' }, [B.h])), 'E_NOT_OWNER:owner-only');
  assert.equal(await code(await succession(mod, mod.pub, [B.h])), 'E_NOT_OWNER:owner-only');
  assert.equal(await code(await allow(owner, [stranger.pub], [], [B.h])), 'ok');
  assert.equal(await code(await ban(alice, stranger.pub, [B.h])), 'E_NOT_MODERATOR:moderator-only');
  assert.equal(await code(await ban(mod, stranger.pub, [B.h])), 'ok');
  assert.equal(await code(await tomb(alice, A.h, [A.h], { bits: 4 })), 'ok', 'own entry');
  assert.equal(await code(await tomb(alice, A.h, [A.h])), 'E_POLICY:bits');
  assert.equal(await code(await tomb(stranger, A.h, [A.h], { bits: 4 })), 'E_NOT_MODERATOR:not-author');
  assert.equal(await code(await tomb(mod, A.h, [A.h])), 'ok');
  assert.equal(await code(await tomb(owner, G.h, [A.h])), 'E_POLICY:target');
  assert.equal(await code(await tomb(owner, 'c'.repeat(64), [A.h])), 'ok', 'unknown target');
  assert.equal(await code(await put(stranger, 'r', 1, [], { bits: 4 })), 'E_NOT_OWNER:root');
  // A block whose tombstone arrived first is stored without its value.
  const late = await append(alice, 'gb', 'late', [G.h], { bits: 4 });
  const T = await tomb(owner, late.h, [B.h]);
  const dag2 = dagOf([G, A, B, T]);
  const st2 = reduce(dag2, { genesisOwner: owner.pub });
  assert.deepEqual(admit(st2, late, { dag: dag2, genesisOwner: owner.pub }), { ok: true, dropValue: true });
  assert.equal(shouldDropValue(st2, late), true);
  assert.equal(shouldDropValue(st2, A, dag2), false);
  assert.equal(shouldDropValue(st2, T), false, 'control blocks hold no value');
  assert.equal(shouldDropValue(state, await append(bob, 'gb', 'y', [B.h], { bits: 4 })), true, 'banned author');
  // At maxChainBytes only the owner, moderators and allow-listed authors are ingested.
  const C = await policy(owner, { writers: 'open', maxChainBytes: 100, allow: [alice.pub] }, [B.h]);
  const dag3 = dagOf([G, A, B, C]);
  const st3 = reduce(dag3, { genesisOwner: owner.pub });
  assert.equal(st3.capReached, true);
  const capCode = (block) => {
    const r = admit(st3, block, { dag: dag3, genesisOwner: owner.pub });
    return r.ok ? 'ok' : r.code;
  };
  assert.equal(capCode(await append(stranger, 'gb', 's', [C.h], { bits: 4 })), 'E_CAP');
  assert.equal(capCode(await append(alice, 'gb', 'a', [C.h], { bits: 4 })), 'ok');
  assert.equal(capCode(await append(owner, 'gb', 'o', [C.h])), 'ok');
  // Ownerless ledgers: any root, nobody owns.
  const R = await put(alice, 'a', 1, [], { bits: 16 });
  const empty = new Dag();
  assert.deepEqual(admit(reduce(empty, { genesisOwner: null }), R, { dag: empty, genesisOwner: null }), { ok: true, dropValue: false });
  assert.equal(admit(reduce(empty, { genesisOwner: null }), await policy(alice, { writers: 'owner' }, []), { dag: empty }).code, 'E_NOT_OWNER');
});

test('code review round 1: an endorsement holds exactly one contested hand-over; a later merge of both endorses nothing', async () => {
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const S1 = await succession(owner, owner2.pub, [G.h]);
  const S2 = await succession(owner, owner3.pub, [G.h]);
  const Merge = await policy(owner2, { bits: 1 }, [S1.h, S2.h]); // owner2 merged both heads
  assert.equal(stateOf([G, S1, S2, Merge], owner.pub, { expectedOwner: owner2.pub }).ownerConflict, true, 'a merge is no endorsement');
  const E = await policy(owner2, {}, [S1.h]);
  const st = sameUnderShuffles([G, S1, S2, Merge, E], 50, 0xe2d, owner.pub, { expectedOwner: owner2.pub });
  assert.equal(st.ownerConflict, false);
  assert.equal(st.owner, owner2.pub);
  assert.equal(st.policy.bits, 1, 'the merge, by the owner in effect, now takes effect');
  // The new owner endorsing both (separately) decides nothing.
  const E2 = await policy(owner2, {}, [S2.h]);
  assert.equal(stateOf([G, S1, S2, E, E2], owner.pub, { expectedOwner: owner2.pub }).ownerConflict, true);
});
