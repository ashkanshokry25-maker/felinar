// Unit tests for the v0.3 freeze-group state rules in src/chain/state.js (U-LG-1 and U-LG-4 of
// DESIGN-REVIEW 4.1; rules in 2.5.3 and ARCHITECTURE 15.4): unban standing, ban.until, keyinfo
// (first wins, not redactable), rotate precedence (recover beats self in either order, lowest
// recover wins, next inherits bans and allow membership, never moderator standing, keychange),
// voided, owner-protected payload, author-scoped keys, the bulk tombstone, the moderator caps by
// UTC day and by claimed hour, and two keys under writers 'open' (U-LG-4). Every scenario is also
// reduced under arrival-order shuffles. Blocks are synthetic (real e, h and keys; reduce never
// checks signatures); test/vectors/ledger.json carries real signed blocks and is checked last.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reduce, snapshot, admit, authorScope, reduceFromCheckpoint, roleOf, isBanned } from '../../src/chain/state.js';
import { validateBlock } from '../../src/chain/block.js';
import { Dag } from '../../src/chain/dag.js';
import { generateKeyPair, exportPublicKey } from '../../src/chain/crypto.js';
import { sha256Sync } from '../../src/chain/sha256-sync.js';
import { canonicalize, utf8, hex, b64url } from '../../src/chain/canonical.js';

const SITE = 'mw1:freezestatetestsite000000';
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const HOUR = 3600000;
const DAY = 86400000;
const SIG = 'A'.repeat(86);

async function makeIdentity() {
  const kp = await generateKeyPair();
  return { privateKey: kp.privateKey, pub: await exportPublicKey(kp.publicKey) };
}
const [O, M, M2, A, B, X, Y, R, R2, N1, N2] = (await Promise.all(Array.from({ length: 11 }, makeIdentity))).map((k) => k.pub);

let serial = 0;
function blk(author, op, value, prev, { ts = T0, bits = 0 } = {}) {
  serial++;
  let full = op;
  if (op.t === 'put' || op.t === 'append' || op.t === 'profile') {
    full = Object.assign({}, op, { vh: hex.encode(sha256Sync(utf8.encode(canonicalize(value)))) });
  }
  const e = { v: 1, site: SITE, author, seq: serial, prev: Array.from(new Set(prev)).sort(), ts, bits, op: full, nonce: '' };
  const block = { e, h: hex.encode(sha256Sync(utf8.encode(canonicalize(e)))), s: SIG };
  if (value !== undefined) block.v = value;
  return block;
}
const append = (a, l, v, prev, o) => blk(a, { t: 'append', l }, v, prev, o);
const put = (a, k, v, prev, o) => blk(a, { t: 'put', k }, v, prev, o);
const ctl = (a, op, prev, o) => blk(a, op, undefined, prev, o);
const rcOf = (pub) => b64url.encode(sha256Sync(utf8.encode(pub)));
const recover = (from, next, rp, prev, o) => ctl(next, { t: 'rotate', from, next, by: 'recover', rp, rsig: SIG }, prev, o);

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
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function dagOf(blocks) {
  const dag = new Dag({ maxOrphansPerPeer: 1e6, maxOrphans: 1e6 });
  for (const b of blocks) dag.add(b);
  assert.equal(dag.orphanCount, 0, 'every parent is present');
  return dag;
}
function fingerprint(st) {
  return JSON.stringify({
    snap: snapshot(st),
    redacted: Array.from(st.redacted).sort(),
    effective: Array.from(st.effective).sort(),
    keyinfo: Array.from(st.keyinfo).sort(),
    rotations: Array.from(st.rotations).sort(),
    banUntil: Array.from(st.policy.banUntil).sort(),
  });
}
// Reduces in the given order and under `times` shuffles; all must agree. Returns the state.
function stateOf(blocks, { times = 20, seed = 7, genesisOwner = O, minBits = 0 } = {}) {
  const want = reduce(dagOf(blocks), { genesisOwner, minBits });
  const fp = fingerprint(want);
  const rand = mulberry32(seed + blocks.length);
  for (let i = 0; i < times; i++) assert.equal(fingerprint(reduce(dagOf(shuffle(rand, blocks)), { genesisOwner, minBits })), fp, 'shuffle ' + i);
  return want;
}
const listOf = (st, name) => (st.lists.get(name) || []).map((it) => it.v);
const kvOf = (st) => Object.fromEntries(Array.from(st.kv, ([k, e]) => [k, e.v]));

const G = ctl(O, { t: 'policy', writers: 'open', bits: 0, moderators: [M] }, []);

test('U-LG-1 unban: owner lifts any ban, a moderator only moderator bans; hidden blocks stay hidden; a concurrent unban lifts nothing', () => {
  const x1 = append(X, 'gb', 'x1', [G.h]);
  const mban = ctl(M, { t: 'ban', author: X }, [x1.h]);
  const mun = ctl(M, { t: 'unban', author: X }, [mban.h]);
  const x2 = append(X, 'gb', 'x2', [mun.h]);
  let st = stateOf([G, x1, mban, mun, x2]);
  assert.deepEqual(listOf(st, 'gb'), ['x2'], 'x1 stays hidden after the unban');
  assert.ok(st.redacted.has(x1.h) && !st.redacted.has(x2.h));
  assert.equal(st.policy.banned.size, 0);
  assert.ok(st.effective.has(mun.h));

  // An owner ban: a moderator unban does not lift it; the owner's does.
  const oban = ctl(O, { t: 'ban', author: X }, [x1.h]);
  const mun2 = ctl(M, { t: 'unban', author: X }, [oban.h]);
  const x3 = append(X, 'gb', 'x3', [mun2.h]);
  st = stateOf([G, x1, oban, mun2, x3]);
  assert.deepEqual(listOf(st, 'gb'), []);
  assert.deepEqual(Array.from(st.policy.banned), [X]);
  const oun = ctl(O, { t: 'unban', author: X }, [mun2.h]);
  const x4 = append(X, 'gb', 'x4', [oun.h]);
  st = stateOf([G, x1, oban, mun2, x3, oun, x4]);
  assert.deepEqual(listOf(st, 'gb'), ['x4'], 'x3 precedes the owner unban');
  assert.equal(st.policy.banned.size, 0);

  // A moderator ban and an owner ban: the moderator unban lifts only its own; still banned.
  const both = ctl(O, { t: 'ban', author: X }, [mban.h]);
  const mun3 = ctl(M, { t: 'unban', author: X }, [both.h]);
  const x5 = append(X, 'gb', 'x5', [mun3.h]);
  st = stateOf([G, x1, mban, both, mun3, x5]);
  assert.deepEqual(listOf(st, 'gb'), []);

  // An unban concurrent with the ban (the ban not in its causal past) lifts nothing.
  const early = ctl(M, { t: 'unban', author: X }, [x1.h]);
  const x6 = append(X, 'gb', 'x6', [early.h, mban.h]);
  st = stateOf([G, x1, mban, early, x6]);
  assert.deepEqual(listOf(st, 'gb'), []);
  // Strangers and writers cannot unban.
  const sun = ctl(A, { t: 'unban', author: X }, [mban.h]);
  const x7 = append(X, 'gb', 'x7', [sun.h]);
  st = stateOf([G, x1, mban, sun, x7]);
  assert.deepEqual(listOf(st, 'gb'), []);
  assert.ok(!st.effective.has(sun.h));
});

test('U-LG-1 ban.until: the ban governs blocks with ts < until; banUntil at the heads; admit agrees', () => {
  const ban = ctl(O, { t: 'ban', author: X, until: T0 + 2 * HOUR }, [G.h]);
  const during = append(X, 'gb', 'during', [ban.h], { ts: T0 + HOUR });
  const after = append(X, 'gb', 'after', [during.h], { ts: T0 + 2 * HOUR });
  const st = stateOf([G, ban, during, after]);
  assert.deepEqual(listOf(st, 'gb'), ['after']);
  assert.equal(st.policy.banUntil.get(X), T0 + 2 * HOUR);
  const dag = dagOf([G, ban]);
  const s0 = reduce(dag, { genesisOwner: O });
  assert.equal(admit(s0, append(X, 'gb', 'a', [ban.h], { ts: T0 + HOUR }), { dag, genesisOwner: O }).code, 'E_BANNED');
  assert.equal(admit(s0, append(X, 'gb', 'b', [ban.h], { ts: T0 + 3 * HOUR }), { dag, genesisOwner: O }).ok, true);
  // A permanent ban beside a timed one: the longer governs.
  const perm = ctl(M, { t: 'ban', author: X }, [ban.h]);
  const st2 = stateOf([G, ban, perm, during, after]);
  assert.deepEqual(listOf(st2, 'gb'), []);
  assert.equal(st2.policy.banUntil.get(X), Infinity);
});

test('U-LG-1 keyinfo (MF-20): the key\'s first word wins; a moderator tombstone or ban does not remove it; only keys that may write', () => {
  const k1 = ctl(A, { t: 'keyinfo', rc: rcOf(R) }, [G.h]);
  const k2 = ctl(A, { t: 'keyinfo', rc: rcOf(R2) }, [k1.h]); // in the future of the first: it changes nothing
  const tomb = ctl(M, { t: 'tombstone', h: k1.h }, [k2.h]);
  const ban = ctl(M, { t: 'ban', author: A }, [tomb.h]);
  const bulk = ctl(M, { t: 'tombstone', authors: [A], before: tomb.h }, [ban.h]);
  let st = stateOf([G, k1, k2, tomb, ban, bulk]);
  assert.equal(st.keyinfo.get(A).rc, rcOf(R));
  assert.equal(st.keyinfo.get(A).h, k1.h);
  assert.ok(!st.tombstoned.has(k1.h), 'control blocks are never redacted');
  assert.ok(st.effective.has(k1.h) && !st.effective.has(k2.h));
  // Two commitments to different recover keys with neither first: none counts (a planted one cannot win by its depth).
  const c1 = ctl(A, { t: 'keyinfo', rc: rcOf(R) }, [G.h]);
  const c2 = ctl(A, { t: 'keyinfo', rc: rcOf(R2) }, [G.h]);
  assert.equal(stateOf([G, c1, c2]).keyinfo.has(A), false);
  // Two devices commit to the same recover key at once: one commitment, the first in total order is kept.
  const d1 = ctl(A, { t: 'keyinfo', rc: rcOf(R) }, [G.h], { ts: T0 });
  const d2 = ctl(A, { t: 'keyinfo', rc: rcOf(R) }, [G.h], { ts: T0 + HOUR });
  const d3 = append(A, 'gb', 'from the second device', [d2.h]);
  st = stateOf([G, d1, d2, d3]);
  assert.equal(st.keyinfo.get(A).rc, rcOf(R));
  assert.equal(st.keyinfo.get(A).h, (d1.h < d2.h ? d1 : d2).h);
  // A keyinfo after the key's first block (or beside it) is late: ignored, and admit refuses it.
  const post = append(A, 'gb', 'hello', [G.h]);
  const late = ctl(A, { t: 'keyinfo', rc: rcOf(R) }, [post.h]);
  st = stateOf([G, post, late]);
  assert.equal(st.keyinfo.has(A), false, 'a key that has already written cannot get a late commitment');
  assert.ok(st.wrote.has(A) && !st.wrote.has(O), 'the genesis root is not a write before');
  assert.equal(stateOf([G, post, ctl(A, { t: 'keyinfo', rc: rcOf(R) }, [G.h])]).keyinfo.has(A), false, 'beside the first post');
  const dag = dagOf([G, post]);
  assert.deepEqual(admit(reduce(dag, { genesisOwner: O }), ctl(A, { t: 'keyinfo', rc: rcOf(R) }, [post.h]), { dag, genesisOwner: O }),
    { ok: false, code: 'E_POLICY', reason: 'keyinfo-late' });
  const fresh = dagOf([G]);
  assert.equal(admit(reduce(fresh, { genesisOwner: O }), ctl(A, { t: 'keyinfo', rc: rcOf(R) }, [G.h]), { dag: fresh, genesisOwner: O }).ok, true);
  // A person's own site: the owner's keyinfo right after the genesis counts (a root is not a write before it).
  const Gp = ctl(O, { t: 'policy', writers: 'owner', bits: 16 }, []);
  assert.equal(stateOf([Gp, ctl(O, { t: 'keyinfo', rc: rcOf(R) }, [Gp.h])]).keyinfo.get(O).rc, rcOf(R));
  // writers 'owner': a visitor key may not write, so its keyinfo has no effect.
  const Gown = ctl(O, { t: 'policy', writers: 'owner', bits: 0 }, []);
  const kv = ctl(A, { t: 'keyinfo', rc: rcOf(R) }, [Gown.h]);
  assert.equal(stateOf([Gown, kv]).keyinfo.has(A), false);
  // PoW: a non-privileged keyinfo meets the governing bits.
  const Gbits = ctl(O, { t: 'policy', writers: 'open', bits: 3 }, []);
  assert.equal(stateOf([Gbits, ctl(A, { t: 'keyinfo', rc: rcOf(R) }, [Gbits.h], { bits: 2 })]).keyinfo.has(A), false);
  assert.equal(stateOf([Gbits, ctl(A, { t: 'keyinfo', rc: rcOf(R) }, [Gbits.h], { bits: 3 })]).keyinfo.has(A), true);
});

test('U-LG-1 rotate: recover beats self in either order; the lowest (depth, h) recover wins; rp must match keyinfo.rc', () => {
  const k = ctl(A, { t: 'keyinfo', rc: rcOf(R) }, [G.h]);
  // Self first in total order, recover later.
  const self = ctl(A, { t: 'rotate', from: A, next: N1, by: 'self' }, [k.h]);
  const rec = recover(A, N2, R, [self.h]);
  let st = stateOf([G, k, self, rec]);
  assert.equal(st.rotations.get(A).next, N2);
  assert.equal(st.rotations.get(A).by, 'recover');
  // Recover first in total order, self later.
  const rec2 = recover(A, N2, R, [k.h]);
  const self2 = ctl(A, { t: 'rotate', from: A, next: N1, by: 'self' }, [rec2.h]);
  st = stateOf([G, k, rec2, self2]);
  assert.equal(st.rotations.get(A).next, N2);
  assert.ok(st.effective.has(rec2.h) && !st.effective.has(self2.h));
  // Several recovers: the lowest (depth, h) wins, whatever arrives first.
  const deep = recover(A, N1, R, [rec2.h]);
  st = stateOf([G, k, deep, rec2]);
  assert.equal(st.rotations.get(A).next, N2);
  const twinA = recover(A, N1, R, [k.h]);
  const twinB = recover(A, N2, R, [k.h]);
  st = stateOf([G, k, twinA, twinB]);
  assert.equal(st.rotations.get(A).next, (twinA.h < twinB.h ? twinA : twinB).e.op.next, 'same depth: lowest h');
  // rp that does not hash to keyinfo.rc, or no keyinfo at all: no effect; a self rotation stands.
  st = stateOf([G, k, self, recover(A, N2, R2, [self.h])]);
  assert.equal(st.rotations.get(A).next, N1);
  st = stateOf([G, recover(A, N2, R, [G.h])]);
  assert.equal(st.rotations.size, 0);
  // Among self rotations the first in total order wins.
  const s1 = ctl(A, { t: 'rotate', from: A, next: N1, by: 'self' }, [G.h]);
  const s2 = ctl(A, { t: 'rotate', from: A, next: N2, by: 'self' }, [s1.h]);
  assert.equal(stateOf([G, s2, s1]).rotations.get(A).next, N1);
});

test('U-LG-1 rotate: next inherits bans and allow membership, never moderator standing; keychange records the change', () => {
  const G2 = ctl(O, { t: 'policy', writers: 'allow', bits: 0, allow: [A], moderators: [A] }, []);
  const k = ctl(A, { t: 'keyinfo', rc: rcOf(R) }, [G2.h]);
  const rec = recover(A, N1, R, [k.h], { ts: T0 + HOUR });
  const p = append(N1, 'gb', 'new key', [rec.h]);
  const u = put(N1, '_notice', 'not a moderator', [p.h]);
  let st = stateOf([G2, k, rec, p, u]);
  assert.deepEqual(listOf(st, 'gb'), ['new key'], 'allow membership inherited');
  assert.equal(st.kv.has('_notice'), false, 'moderator standing is not inherited');
  assert.deepEqual(st.keychange.get(A), { from: A, next: N1, by: 'recover', h: rec.h, ts: T0 + HOUR });
  assert.deepEqual(st.keychange.get(N1), st.keychange.get(A));
  assert.deepEqual(snapshot(st).keychange[N1], { from: A, next: N1, by: 'recover', ts: T0 + HOUR });
  // Bans of from reach next (a chain of rotations too), never the other way.
  const ban = ctl(O, { t: 'ban', author: A }, [p.h]);
  st = stateOf([G2, k, rec, p, ban]);
  assert.deepEqual(listOf(st, 'gb'), []);
  assert.deepEqual(Array.from(st.policy.banned).sort(), [A, N1].sort());
  // A self rotation joins the keys only with next's consent (nsig, checked by block.js; review round HUB-1).
  const self = ctl(N1, { t: 'rotate', from: N1, next: N2, by: 'self', nsig: SIG }, [p.h]);
  const p2 = append(N2, 'gb', 'second rotation', [self.h]);
  st = stateOf([G2, k, rec, p, self, p2, ban]);
  assert.deepEqual(listOf(st, 'gb'), []);
  st = stateOf([G2, k, rec, p, self, p2]);
  assert.deepEqual(listOf(st, 'gb'), ['new key', 'second rotation']);
  // Without nsig the self rotation retires N1 but moves neither its allow membership nor its bans to N2.
  const bare = ctl(N1, { t: 'rotate', from: N1, next: N2, by: 'self' }, [p.h]);
  const pBare = append(N2, 'gb', 'no consent', [bare.h]);
  st = stateOf([G2, k, rec, p, bare, pBare]);
  assert.deepEqual(listOf(st, 'gb'), ['new key'], 'N2 is not on the allow list through a rotation it never agreed to');
  assert.equal(st.rotations.get(N1).next, N2, 'N1 is retired');
  assert.equal(roleOf(N1, st), 'reader');
  assert.equal(st.keychange.has(N2), false, 'N2 is not shown as a changed key');
  st = stateOf([G2, k, rec, p, bare, ban]);
  assert.equal(st.policy.banned.has(N2), false, 'a ban of the family does not reach a key that never agreed');
  // A ban covers the whole rotation family, both ways (MF-20): a ban of next hides what from wrote before the rotation too.
  const early = append(A, 'gb', 'before the rotation', [k.h]);
  const rec2 = recover(A, N1, R, [early.h], { ts: T0 + HOUR });
  const p3 = append(N1, 'gb', 'new key', [rec2.h]);
  st = stateOf([G2, k, early, rec2, p3]);
  assert.deepEqual(listOf(st, 'gb'), ['before the rotation', 'new key']);
  const banNext = ctl(O, { t: 'ban', author: N1 }, [p3.h]);
  st = stateOf([G2, k, early, rec2, p3, banNext]);
  assert.deepEqual(listOf(st, 'gb'), [], 'a ban of next reaches from');
  assert.deepEqual(Array.from(st.policy.banned).sort(), [A, N1].sort());
  // And an unban of either key lifts it for both (the owner banned, the owner unbans).
  const unbanFrom = ctl(O, { t: 'unban', author: A }, [banNext.h]);
  const p4 = append(N1, 'gb', 'after the unban', [unbanFrom.h]);
  st = stateOf([G2, k, early, rec2, p3, banNext, unbanFrom, p4]);
  assert.deepEqual(listOf(st, 'gb'), ['after the unban']);
  assert.equal(st.policy.banned.size, 0);
});

test('MF-20: a recover rotation revokes the old key: what it signs outside the rotation\'s causal past has no effect and admit refuses it', () => {
  const G2 = ctl(O, { t: 'policy', writers: 'allow', bits: 0, allow: [A], moderators: [M] }, []);
  const k = ctl(A, { t: 'keyinfo', rc: rcOf(R) }, [G2.h]);
  const before = append(A, 'gb', 'before the theft', [k.h]);
  const rec = recover(A, N1, R, [before.h], { ts: T0 + HOUR });
  const thiefAfter = append(A, 'gb', 'the thief after the recovery', [rec.h]);
  const thiefBeside = append(A, 'gb', 'the thief beside it', [before.h]);
  const mine = append(N1, 'gb', 'the person again', [rec.h]);
  const st = stateOf([G2, k, before, rec, thiefAfter, thiefBeside, mine]);
  assert.deepEqual(listOf(st, 'gb'), ['before the theft', 'the person again']);
  assert.ok(!st.effective.has(thiefAfter.h) && !st.effective.has(thiefBeside.h));
  assert.ok(!st.redacted.has(thiefAfter.h), 'revoked blocks have no effect; their values are not dropped like a ban\'s');
  assert.equal(roleOf(A, st), 'reader');
  assert.equal(roleOf(N1, st), 'writer');
  // admit refuses anything new from the old key, but its rotation and keyinfo blocks.
  const dag = dagOf([G2, k, before, rec, mine]);
  const s0 = reduce(dag, { genesisOwner: O });
  const opts = { dag, genesisOwner: O };
  assert.deepEqual(admit(s0, append(A, 'gb', 'more', [mine.h]), opts), { ok: false, code: 'E_POLICY', reason: 'rotated' });
  assert.deepEqual(admit(s0, ctl(A, { t: 'tombstone', h: mine.h }, [mine.h]), opts), { ok: false, code: 'E_POLICY', reason: 'rotated' });
  assert.equal(admit(s0, append(N1, 'gb', 'fine', [mine.h]), opts).ok, true);
  // A rotated-away moderator key: its bans and tombstones have no effect.
  const Gm = ctl(O, { t: 'policy', writers: 'open', bits: 0, moderators: [M] }, []);
  const km = ctl(M, { t: 'keyinfo', rc: rcOf(R) }, [Gm.h]);
  const x = append(X, 'gb', 'x', [km.h]);
  const recM = recover(M, N2, R, [x.h]);
  const lateBan = ctl(M, { t: 'ban', author: X }, [recM.h]);
  const lateTomb = ctl(M, { t: 'tombstone', h: x.h }, [lateBan.h]);
  const sm = stateOf([Gm, km, x, recM, lateBan, lateTomb]);
  assert.deepEqual(listOf(sm, 'gb'), ['x']);
  assert.equal(sm.policy.banUntil.size, 0);
});

test('MF-20: the key a recover rotation moves to commits to its own recover key with the allow membership it inherits; a second recovery works', () => {
  const G2 = ctl(O, { t: 'policy', writers: 'allow', bits: 0, allow: [A] }, []);
  const k = ctl(A, { t: 'keyinfo', rc: rcOf(R) }, [G2.h]);
  const r1 = recover(A, N1, R, [k.h]);
  const k1 = ctl(N1, { t: 'keyinfo', rc: rcOf(R2) }, [r1.h]); // N1 is not on the allow list itself
  const r2 = recover(N1, N2, R2, [k1.h]);
  const k2 = ctl(N2, { t: 'keyinfo', rc: rcOf(R) }, [r2.h]);
  const p = append(N2, 'gb', 'after two recoveries', [k2.h]);
  const st = stateOf([G2, k, r1, k1, r2, k2, p]);
  assert.equal(st.keyinfo.get(N1).rc, rcOf(R2));
  assert.equal(st.keyinfo.get(N2).rc, rcOf(R), 'the chain of recoveries carries the allow membership');
  assert.equal(st.rotations.get(N1).next, N2);
  assert.deepEqual(listOf(st, 'gb'), ['after two recoveries']);
  // Without the recover rotation N1 may not write here, so its keyinfo has no effect.
  assert.equal(stateOf([G2, ctl(N1, { t: 'keyinfo', rc: rcOf(R2) }, [G2.h])]).keyinfo.has(N1), false);
});

test('MF-20: a thief who plants a keyinfo for a key that already wrote gets nothing; neither does a late recover rotation', () => {
  const G2 = ctl(O, { t: 'policy', writers: 'allow', bits: 0, allow: [A] }, []);
  const ana = append(A, 'gb', 'Ana wrote without a keyinfo', [G2.h]);
  const planted = ctl(A, { t: 'keyinfo', rc: rcOf(R2) }, [ana.h]); // hostile code while Ana is signed in
  const takeover = recover(A, X, R2, [planted.h]);
  const xPost = append(X, 'gb', 'the thief as Ana', [takeover.h]);
  const st = stateOf([G2, ana, planted, takeover, xPost]);
  assert.equal(st.keyinfo.has(A), false);
  assert.equal(st.rotations.size, 0);
  assert.deepEqual(snapshot(st).keychange, {}, 'nobody is shown "key changed"');
  assert.deepEqual(listOf(st, 'gb'), ['Ana wrote without a keyinfo'], 'X inherits nothing');
  assert.equal(roleOf(A, st), 'writer');
});

test('expired temporary bans: banned holds permanent bans; isBanned, roleOf and snapshot take now', () => {
  const ban = ctl(O, { t: 'ban', author: X, until: T0 + HOUR }, [G.h]);
  const perm = ctl(O, { t: 'ban', author: Y }, [ban.h]);
  const st = stateOf([G, ban, perm]);
  assert.deepEqual(Array.from(st.policy.banned), [Y]);
  assert.equal(st.policy.banUntil.get(X), T0 + HOUR);
  assert.equal(isBanned(X, st, T0 + 30 * 60000), true);
  assert.equal(isBanned(X, st, T0 + 2 * HOUR), false);
  assert.equal(isBanned(X, st), false, 'without a clock only permanent bans count');
  assert.equal(isBanned(Y, st, T0 + 365 * DAY), true);
  assert.equal(roleOf(X, st, T0 + 30 * 60000), 'reader');
  assert.equal(roleOf(X, st, T0 + 2 * HOUR), 'writer');
  assert.equal(roleOf(Y, st, T0 + 2 * HOUR), 'reader');
  const during = snapshot(st, { now: T0 + 30 * 60000 }).policy;
  assert.deepEqual(during.banned, [X, Y].sort());
  assert.deepEqual(during.banUntil, { [X]: T0 + HOUR });
  const later = snapshot(st, { now: T0 + 2 * HOUR }).policy;
  assert.deepEqual(later.banned, [Y], 'the snapshot does not list an expired ban');
  assert.deepEqual(later.banUntil, {});
  assert.deepEqual(snapshot(st).policy.banned, [Y]);
  assert.deepEqual(snapshot(st).policy.banUntil, { [X]: T0 + HOUR });
});

test('moderator caps count a block at max(ts, the newest ts in its causal past): an older claimed hour does not open a new budget', () => {
  const G3 = ctl(O, { t: 'policy', writers: 'open', bits: 0, moderators: [M], modActionsPerHour: 3 }, []);
  const posts = [];
  let prev = G3.h;
  for (let i = 0; i < 10; i++) {
    const p = append(X, 'gb', 'p' + i, [prev], { ts: T0 + 24 * HOUR });
    posts.push(p);
    prev = p.h;
  }
  const tombs = [];
  for (let i = 0; i < 10; i++) {
    const t = ctl(M, { t: 'tombstone', h: posts[i].h }, [prev], { ts: T0 + i * HOUR }); // claims ten different past hours
    tombs.push(t);
    prev = t.h;
  }
  const st = stateOf(Array.prototype.concat([G3], posts, tombs), { times: 5 });
  assert.equal(tombs.filter((t) => st.effective.has(t.h)).length, 3, 'all ten count in the hour of the posts they build on');
  assert.equal(listOf(st, 'gb').length, 7);
});

test('U-LG-1 voided: a voided moderator\'s control blocks outside the causal past of after have no effect', () => {
  const b1 = ctl(M, { t: 'ban', author: X }, [G.h]);
  const b2 = ctl(M, { t: 'ban', author: Y }, [b1.h]);
  const t1 = ctl(M, { t: 'tombstone', h: G.h }, [b2.h]); // control target: nothing anyway
  const pa = append(A, 'gb', 'a', [t1.h]);
  const t2 = ctl(M, { t: 'tombstone', h: pa.h }, [pa.h]);
  const pol = ctl(O, { t: 'policy', voided: [{ author: M, after: b1.h }] }, [t2.h]);
  let st = stateOf([G, b1, b2, t1, pa, t2, pol]);
  assert.deepEqual(Array.from(st.policy.banned), [X]);
  assert.deepEqual(listOf(st, 'gb'), ['a'], 'the voided tombstone is restored');
  assert.deepEqual(st.policy.voided, [{ author: M, after: b1.h }]);
  // Without the voided entry both bans and the tombstone stand.
  st = stateOf([G, b1, b2, t1, pa, t2]);
  assert.deepEqual(Array.from(st.policy.banned).sort(), [X, Y].sort());
  assert.deepEqual(listOf(st, 'gb'), []);
  // after unknown: every control block of that author is void. The owner is never voided.
  const pol2 = ctl(O, { t: 'policy', voided: [{ author: M, after: 'f'.repeat(64) }, { author: O, after: 'f'.repeat(64) }] }, [b2.h]);
  const ob = ctl(O, { t: 'ban', author: A }, [pol2.h]);
  st = stateOf([G, b1, b2, pol2, ob]);
  assert.deepEqual(Array.from(st.policy.banned), [A]);
});

test('U-LG-1 owner-protected payload: moderator tombstones of owner-standing payload have no effect', () => {
  const po = put(O, 'motd', 'owner text', [G.h]);
  const la = append(O, 'news', 'owner news', [po.h]);
  const pa = put(A, 'a', 'alice', [la.h]);
  const t1 = ctl(M, { t: 'tombstone', h: po.h }, [pa.h]);
  const t2 = ctl(M, { t: 'tombstone', h: la.h }, [t1.h]);
  const t3 = ctl(M, { t: 'tombstone', h: pa.h }, [t2.h]);
  let st = stateOf([G, po, la, pa, t1, t2, t3]);
  assert.deepEqual(kvOf(st), { motd: 'owner text' });
  assert.deepEqual(listOf(st, 'news'), ['owner news']);
  assert.ok(!st.effective.has(t1.h) && !st.effective.has(t2.h) && st.effective.has(t3.h));
  assert.ok(st.ownerWritten.has(po.h));
  // The owner and the author still tombstone their own entries.
  const ot = ctl(O, { t: 'tombstone', h: po.h }, [t3.h]);
  st = stateOf([G, po, la, pa, t1, t2, t3, ot]);
  assert.deepEqual(kvOf(st), {});
  // admit refuses a moderator tombstone of an owner entry.
  const dag = dagOf([G, po, la, pa]);
  const s0 = reduce(dag, { genesisOwner: O });
  assert.deepEqual(admit(s0, ctl(M, { t: 'tombstone', h: po.h }, [pa.h]), { dag, genesisOwner: O }), { ok: false, code: 'E_POLICY', reason: 'owner-protected' });
  assert.equal(admit(s0, ctl(M, { t: 'tombstone', h: pa.h }, [pa.h]), { dag, genesisOwner: O }).ok, true);
});

test('U-LG-1 author-scoped keys: "@" + 16 chars of b64url(sha256(author)) + "/" take effect only from that author', () => {
  const ka = authorScope(A) + 'bio';
  assert.equal(authorScope(A), '@' + b64url.encode(sha256Sync(utf8.encode(A))).slice(0, 16) + '/');
  const pa = put(A, ka, 'alice', [G.h]);
  const pb = put(B, ka, 'forged', [pa.h]);
  const pm = put(M, ka, 'moderator', [pb.h]);
  const po = put(O, ka, 'owner', [pm.h]);
  const free = put(B, '@bob-free-form', 'any', [po.h]);
  const del = put(B, ka, null, [free.h]);
  const st = stateOf([G, pa, pb, pm, po, free, del]);
  assert.deepEqual(kvOf(st), { [ka]: 'alice', '@bob-free-form': 'any' });
  const dag = dagOf([G, pa]);
  assert.deepEqual(admit(reduce(dag, { genesisOwner: O }), put(B, ka, 'x', [pa.h]), { dag, genesisOwner: O }), { ok: false, code: 'E_POLICY', reason: 'scope' });
});

test('U-LG-1 bulk tombstone: hides the listed authors\' payload not in the causal future of before', () => {
  const x1 = append(X, 'gb', 'x1', [G.h]);
  const y1 = append(Y, 'gb', 'y1', [G.h]);
  const x2 = append(X, 'gb', 'x2', [x1.h, y1.h]);
  const xs = append(X, 'gb', 'x side', [G.h]); // concurrent with before: hidden too
  const po = append(O, 'gb', 'owner', [x2.h]);
  const bulk = ctl(M, { t: 'tombstone', authors: [X, Y, O].sort(), before: x2.h }, [po.h, xs.h]);
  const x3 = append(X, 'gb', 'x3', [bulk.h]);
  let st = stateOf([G, x1, y1, x2, xs, po, bulk, x3]);
  assert.deepEqual(listOf(st, 'gb'), ['owner', 'x3']);
  assert.ok(st.redacted.has(x1.h) && st.redacted.has(x2.h) && st.redacted.has(xs.h) && st.redacted.has(y1.h));
  // before must be in the bulk block's causal past; writers cannot bulk-tombstone.
  const blind = ctl(M, { t: 'tombstone', authors: [X], before: x3.h }, [G.h]);
  st = stateOf([G, x1, y1, x2, xs, po, bulk, x3, blind]);
  assert.ok(!st.effective.has(blind.h));
  const byWriter = ctl(A, { t: 'tombstone', authors: [X], before: x1.h }, [x1.h]);
  st = stateOf([G, x1, byWriter]);
  assert.deepEqual(listOf(st, 'gb'), ['x1']);
  // The owner's bulk tombstone hides owner payload too.
  const ob = ctl(O, { t: 'tombstone', authors: [O], before: po.h }, [po.h]);
  st = stateOf([G, x1, y1, x2, po, ob]);
  assert.deepEqual(listOf(st, 'gb').sort(), ['x1', 'x2', 'y1'], 'x1 and y1 share a depth: order by h');
});

test('U-LG-1 moderator caps: allow additions per UTC day (claimed ts), ban/tombstone/unban per claimed hour', () => {
  const G3 = ctl(O, { t: 'policy', writers: 'allow', bits: 0, moderators: [M, M2], modAllowPerDay: 2, modActionsPerHour: 2 }, []);
  const al1 = ctl(M, { t: 'allow', add: [A, B] }, [G3.h]);
  const al2 = ctl(M, { t: 'allow', add: [X] }, [al1.h], { ts: T0 + HOUR }); // same UTC day: over the cap
  const al3 = ctl(M2, { t: 'allow', add: [Y] }, [al2.h]); // another moderator has its own count
  const al4 = ctl(M, { t: 'allow', add: [X] }, [al3.h], { ts: T0 + DAY }); // next UTC day
  let st = stateOf([G3, al1, al2, al3]);
  assert.deepEqual(Array.from(st.policy.allow).sort(), [A, B, Y].sort());
  assert.ok(!st.effective.has(al2.h));
  st = stateOf([G3, al1, al2, al3, al4]);
  assert.deepEqual(Array.from(st.policy.allow).sort(), [A, B, X, Y].sort());
  // Partial: the first additions up to the cap count.
  st = stateOf([G3, ctl(M, { t: 'allow', add: [A, B, X] }, [G3.h])]);
  assert.deepEqual(Array.from(st.policy.allow).sort(), [A, B].sort());
  // Moderators add only: a moderator allow block that removes has no effect; admit refuses it.
  const rm = ctl(M, { t: 'allow', add: [X], remove: [A] }, [al1.h]);
  st = stateOf([G3, al1, rm]);
  assert.deepEqual(Array.from(st.policy.allow).sort(), [A, B].sort());
  const dag = dagOf([G3, al1]);
  assert.equal(admit(reduce(dag, { genesisOwner: O }), rm, { dag, genesisOwner: O }).code, 'E_NOT_OWNER');
  // Hour cap: ban, tombstone and unban count together; the owner is not counted.
  const pa = append(A, 'gb', 'a', [al1.h]);
  const b1 = ctl(M, { t: 'ban', author: X }, [pa.h]);
  const t1 = ctl(M, { t: 'tombstone', h: pa.h }, [b1.h]);
  const b2 = ctl(M, { t: 'ban', author: Y }, [t1.h]); // third in the hour: no effect
  const ob = ctl(O, { t: 'ban', author: B }, [b2.h]);
  const b3 = ctl(M, { t: 'ban', author: Y }, [ob.h], { ts: T0 + HOUR }); // next claimed hour
  st = stateOf([G3, al1, pa, b1, t1, b2, ob]);
  assert.deepEqual(Array.from(st.policy.banned).sort(), [X, B].sort());
  assert.deepEqual(listOf(st, 'gb'), []);
  st = stateOf([G3, al1, pa, b1, t1, b2, ob, b3]);
  assert.deepEqual(Array.from(st.policy.banned).sort(), [X, Y, B].sort());
});

test('U-LG-4: two keys under writers \'open\': B cannot replace A\'s "@"-scoped items or sealed items', () => {
  const sealed = (n) => ({ enc: 'mw-seal-v1', iv: b64url.encode(new Uint8Array(12).fill(n)), ct: b64url.encode(new Uint8Array(1040).fill(n)) });
  const scoped = authorScope(A) + 'record';
  const a1 = append(A, 'mw.s', sealed(1), [G.h], { bits: 16 });
  const a2 = put(A, scoped, { display: 'Alice' }, [a1.h], { bits: 16 });
  const b1 = ctl(B, { t: 'tombstone', h: a1.h }, [a2.h], { bits: 16 });
  const b2 = put(B, scoped, { display: 'Mallory' }, [b1.h], { bits: 16 });
  const b3 = put(B, scoped, null, [b2.h], { bits: 16 });
  const b4 = append(B, 'mw.s', sealed(2), [b3.h], { bits: 16 });
  const b5 = ctl(B, { t: 'tombstone', authors: [A], before: a2.h }, [b4.h], { bits: 16 });
  const st = stateOf([G, a1, a2, b1, b2, b3, b4, b5]);
  assert.deepEqual(kvOf(st), { [scoped]: { display: 'Alice' } });
  const items = st.lists.get('mw.s');
  assert.deepEqual(items.map((it) => it.author), [A, B]);
  assert.deepEqual(items[0].v, sealed(1), 'A\'s sealed item is untouched');
  assert.ok(!st.effective.has(b1.h) && !st.effective.has(b5.h));
});

test('convergence: random ledgers with freeze-group ops reduce identically under shuffles', () => {
  const rand = mulberry32(0xf2ee2e);
  const keys = [A, B, X, Y, N1];
  for (let round = 0; round < 6; round++) {
    const blocks = [ctl(O, { t: 'policy', writers: 'open', bits: 0, moderators: [M] }, [])];
    const payloads = [];
    for (let i = 0; i < 120; i++) {
      const lo = Math.max(0, blocks.length - 12);
      const prev = [blocks[lo + Math.floor(rand() * (blocks.length - lo))].h, blocks[lo + Math.floor(rand() * (blocks.length - lo))].h];
      const who = keys[Math.floor(rand() * keys.length)];
      const ts = T0 + Math.floor(rand() * 4) * HOUR;
      const r = rand();
      let b;
      if (r < 0.4) b = append(who, rand() < 0.8 ? 'gb' : 'mw.s', 'p' + i, prev, { ts });
      else if (r < 0.55) b = put(who, rand() < 0.3 ? authorScope(keys[0]) + 'k' : 'k' + (i % 5), i, prev, { ts });
      else if (r < 0.62 && payloads.length) b = ctl([M, O, who][Math.floor(rand() * 3)], { t: 'tombstone', h: payloads[Math.floor(rand() * payloads.length)].h }, prev, { ts });
      else if (r < 0.68) b = ctl([M, O][Math.floor(rand() * 2)], rand() < 0.5 ? { t: 'ban', author: who, until: ts + HOUR } : { t: 'ban', author: who }, prev, { ts });
      else if (r < 0.74) b = ctl([M, O, who][Math.floor(rand() * 3)], { t: 'unban', author: who }, prev, { ts });
      else if (r < 0.8) b = ctl(who, { t: 'keyinfo', rc: rcOf(rand() < 0.5 ? R : R2) }, prev, { ts });
      else if (r < 0.86) {
        const from = keys[Math.floor(rand() * keys.length)];
        const next = keys[Math.floor(rand() * keys.length)];
        if (from === next) continue;
        b = rand() < 0.5 ? ctl(from, { t: 'rotate', from, next, by: 'self' }, prev, { ts }) : recover(from, next, rand() < 0.5 ? R : R2, prev, { ts });
      } else if (r < 0.9 && payloads.length) b = ctl(M, { t: 'tombstone', authors: [who], before: prev[0] }, prev, { ts });
      else if (r < 0.94) b = ctl(M, { t: 'allow', add: [who] }, prev, { ts });
      else if (r < 0.97) b = ctl(O, { t: 'policy', modActionsPerHour: 1 + Math.floor(rand() * 4), voided: rand() < 0.3 ? [{ author: M, after: prev[0] }] : [] }, prev, { ts });
      else b = append(O, 'gb', 'o' + i, prev, { ts });
      if (b.e.op.t === 'put' || b.e.op.t === 'append') payloads.push(b);
      blocks.push(b);
    }
    stateOf(blocks, { times: 30, seed: round });
  }
});

test('ledger vectors (test/vectors/ledger.json): real signed blocks, reduced in any order, give expect', async () => {
  const doc = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'vectors', 'ledger.json'), 'utf8'));
  assert.equal(typeof doc.format, 'string');
  assert.ok(doc.vectors.length >= 18);
  const rand = mulberry32(0x1ed6e7);
  const rules = new Set();
  for (const v of doc.vectors) {
    rules.add(v.rule);
    for (const b of v.blocks) assert.deepEqual(await validateBlock(b, { site: v.site }), { ok: true }, v.id);
    for (let i = 0; i < 5; i++) {
      const st = reduce(dagOf(i === 0 ? v.blocks : shuffle(rand, v.blocks)), { genesisOwner: v.genesisOwner });
      assert.deepEqual(viewOf(st), v.expect, v.id + ' order ' + i);
    }
    if (v.checkpoint) {
      const after = v.blocks.filter((b) => v.checkpoint.after.includes(b.h));
      const st = reduceFromCheckpoint(v.checkpoint.S, shuffle(rand, after), { genesisOwner: v.genesisOwner });
      const got = viewOf(st);
      assert.deepEqual([got.kv, got.lists, got.banned, got.keyinfo, got.checkpoint], [v.expect.kv, v.expect.lists, v.expect.banned, v.expect.keyinfo, v.expect.checkpoint], v.id + ' from S');
    }
  }
  for (const r of ['unban', 'ban.until', 'keyinfo', 'rotate', 'voided', 'owner-protected', 'author-scoped', 'bulk tombstone', 'modAllowPerDay', 'modActionsPerHour', 'schema', 'checkpoint']) {
    assert.ok(rules.has(r), 'a vector for ' + r);
  }
});

function viewOf(state) {
  const snap = snapshot(state);
  const lists = {};
  for (const [k, items] of Object.entries(snap.lists)) lists[k] = items.map((it) => it.v);
  const keyinfo = {};
  for (const k of Array.from(state.keyinfo.keys()).sort()) keyinfo[k] = state.keyinfo.get(k).rc;
  const keychange = {};
  for (const [k, r] of Object.entries(snap.keychange)) keychange[k] = { from: r.from, next: r.next, by: r.by };
  return {
    kv: snap.kv,
    lists,
    profiles: snap.profiles,
    banned: bannedAtHeads(state),
    keyinfo,
    keychange,
    hidden: Array.from(state.redacted).sort(),
    checkpoint: state.checkpoint ? state.checkpoint.h : null,
  };
}

// The vectors' `banned`: every key a ban at the heads reaches, whatever its until (State.policy.banUntil). Since the
// v0.3 review State.policy.banned (and the snapshot without `now`) holds the permanent bans only.
function bannedAtHeads(state) {
  return Array.from(state.policy.banUntil.keys()).sort();
}
