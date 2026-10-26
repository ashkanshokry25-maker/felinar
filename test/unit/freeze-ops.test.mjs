// Unit tests for the v0.3 freeze-group ops in src/chain/block.js (DESIGN-REVIEW 2.5.3, 2.10.1;
// ARCHITECTURE 15.4): shape and signature validity of unban, ban.until, keyinfo, rotate (self and
// recover, with rsig), checkpoint, the bulk tombstone and the new policy fields; vanish and grp
// stay unknown-op; the caps (32 heads, 64 bulk authors, 50 voided entries); every v1 vector still
// validates as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createBlock, validateBlock, validatePolicyFields, isControlOp, isPayloadOp, rotateSigningInput,
  CONTROL_OPS, FUTURE_CONTROL_OPS, POLICY_FIELDS, FREEZE_POLICY_DEFAULTS, FREEZE_LIMITS, SIG_PREFIX, ROTATE_PREFIX,
} from '../../src/chain/block.js';
import { generateKeyPair, exportPublicKey, sign } from '../../src/chain/crypto.js';
import { hashEntry } from '../../src/chain/pow.js';
import { b64url, utf8, hex } from '../../src/chain/canonical.js';
import { sha256Sync } from '../../src/chain/sha256-sync.js';

const SITE = 'mw1:freezeopstestsite00000000';
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);

async function makeIdentity() {
  const kp = await generateKeyPair();
  return { privateKey: kp.privateKey, pub: await exportPublicKey(kp.publicKey) };
}
const [owner, mod, alice, bob, rec, next] = await Promise.all(Array.from({ length: 6 }, makeIdentity));
const manyKeys = (await Promise.all(Array.from({ length: 65 }, makeIdentity))).map((k) => k.pub).sort();

const control = (identity, op, prev = [H1]) => createBlock({ identity, site: SITE, seq: 1, prev, op, ts: T0 });
const rc = (pub) => b64url.encode(sha256Sync(utf8.encode(pub)));
const hexOf = (s) => hex.encode(sha256Sync(utf8.encode(s)));

// A correctly hashed and signed block around an arbitrary entry (bypasses createBlock's checks).
async function reseal(e, identity) {
  const { hashHex } = await hashEntry(e);
  return { e, h: hashHex, s: b64url.encode(await sign(identity.privateKey, SIG_PREFIX + hashHex)) };
}
const entry = (author, op) => ({ v: 1, site: SITE, author, seq: 1, prev: [H1], ts: T0, bits: 0, op, nonce: '' });
async function reasonOf(block) {
  const r = await validateBlock(block, { site: SITE });
  return r.ok ? 'ok' : r.reason;
}
const opReason = async (author, op, identity) => reasonOf(await reseal(entry(author, op), identity));

async function recoverOp(from, nxt, rp, site = SITE) {
  const rsig = b64url.encode(await sign(rp.privateKey, rotateSigningInput(site, from.pub, nxt.pub)));
  return { t: 'rotate', from: from.pub, next: nxt.pub, by: 'recover', rp: rp.pub, rsig };
}

test('the freeze group defines unban, keyinfo, rotate and checkpoint; vanish and grp stay reserved', () => {
  for (const t of ['unban', 'keyinfo', 'rotate', 'checkpoint']) {
    assert.ok(CONTROL_OPS.includes(t), t);
    assert.equal(isControlOp({ t }), true, t);
    assert.equal(isPayloadOp({ t }), false, t);
  }
  assert.deepEqual([...FUTURE_CONTROL_OPS], ['vanish', 'grp']);
  assert.deepEqual([...POLICY_FIELDS], ['writers', 'bits', 'maxValueBytes', 'maxChainBytes', 'moderators', 'allow',
    'modAllowPerDay', 'modActionsPerHour', 'reservedPool', 'voided']);
  assert.deepEqual(JSON.parse(JSON.stringify(FREEZE_POLICY_DEFAULTS)), { modAllowPerDay: 20, modActionsPerHour: 60, reservedPool: 25, voided: [] });
  assert.equal(FREEZE_LIMITS.maxCheckpointHeads, 32);
  assert.equal(FREEZE_LIMITS.maxBulkAuthors, 64);
  assert.equal(FREEZE_LIMITS.maxVoided, 50);
  assert.equal(ROTATE_PREFIX, 'mw-rotate-v1\n');
  assert.equal(rotateSigningInput('mw1:x', 'p256:a', 'p256:b'), 'mw-rotate-v1\nmw1:x\np256:a\np256:b');
});

test('vanish and grp are unknown-op even when correctly hashed and signed; checkpoint without heads too', async () => {
  for (const t of ['vanish', 'grp']) {
    assert.equal(await opReason(owner.pub, { t, author: alice.pub }, owner), 'unknown-op', t);
    await assert.rejects(control(owner, { t }), (err) => err.code === 'E_INVALID' && err.reason === 'unknown-op');
  }
  assert.equal(await opReason(owner.pub, { t: 'checkpoint', n: 1, root: H2 }, owner), 'unknown-op', 'the v0.2.1 placeholder form');
});

test('unban: { t, author } signed and valid; malformed forms are op', async () => {
  const b = await control(mod, { t: 'unban', author: alice.pub });
  assert.equal(await reasonOf(b), 'ok');
  assert.equal(await reasonOf({ ...b, s: b.s.slice(0, -2) + (b.s.endsWith('AA') ? 'AB' : 'AA') }), 'sig');
  assert.equal(await opReason(mod.pub, { t: 'unban', author: alice.pub.slice(5) }, mod), 'op', 'untagged key');
  assert.equal(await opReason(mod.pub, { t: 'unban', author: alice.pub, until: 5 }, mod), 'op', 'no until on unban');
  assert.equal(await opReason(mod.pub, { t: 'unban' }, mod), 'op');
});

test('ban.until: optional unix ms; negative, fractional or extra fields are op', async () => {
  assert.equal(await reasonOf(await control(mod, { t: 'ban', author: alice.pub, until: T0 + 3600000 })), 'ok');
  assert.equal(await reasonOf(await control(mod, { t: 'ban', author: alice.pub, until: 0 })), 'ok');
  assert.equal(await reasonOf(await control(mod, { t: 'ban', author: alice.pub })), 'ok', 'v1 form unchanged');
  for (const until of [-1, 1.5, '1', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(await opReason(mod.pub, { t: 'ban', author: alice.pub, until }, mod), 'op', String(until));
  }
  assert.equal(await opReason(mod.pub, { t: 'ban', author: alice.pub, until: 1, why: 'x' }, mod), 'op');
});

test('keyinfo: rc is the b64url of a 32-byte sha256 (43 canonical characters)', async () => {
  assert.equal(await reasonOf(await control(alice, { t: 'keyinfo', rc: rc(rec.pub) })), 'ok');
  const good = rc(rec.pub);
  for (const bad of [good.slice(0, 42), good + 'A', good.slice(0, 42) + '=', good.slice(0, 42) + '+', 'x'.repeat(43), 42]) {
    assert.equal(await opReason(alice.pub, { t: 'keyinfo', rc: bad }, alice), 'op', String(bad));
  }
  // Non-canonical trailing bits: the strict decoder gives every hash one spelling.
  const last = good[42];
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bumped = good.slice(0, 42) + alphabet[(alphabet.indexOf(last) + 1) % 64];
  assert.equal(await opReason(alice.pub, { t: 'keyinfo', rc: bumped }, alice), 'op');
  assert.equal(await opReason(alice.pub, { t: 'keyinfo', rc: good, extra: 1 }, alice), 'op');
});

test('rotate by self: signed by from; next differs from from; no rp or rsig', async () => {
  const op = { t: 'rotate', from: alice.pub, next: next.pub, by: 'self' };
  assert.equal(await reasonOf(await control(alice, op)), 'ok');
  assert.equal(await opReason(bob.pub, op, bob), 'op', 'not signed by from');
  assert.equal(await opReason(alice.pub, { ...op, next: alice.pub }, alice), 'op', 'from === next');
  assert.equal(await opReason(alice.pub, { ...op, rp: rec.pub }, alice), 'op');
  assert.equal(await opReason(alice.pub, { ...op, by: 'other' }, alice), 'op');
  assert.equal(await opReason(alice.pub, { t: 'rotate', from: alice.pub, by: 'self' }, alice), 'op');
});

test('rotate by recover: signed by next, rsig = ECDSA by rp over "mw-rotate-v1\\n" + ledgerId + "\\n" + from + "\\n" + next', async () => {
  const op = await recoverOp(alice, next, rec);
  const block = await control(next, op);
  assert.equal(await reasonOf(block), 'ok');
  // rsig over another next, another site, or by another key: sig (a signature over e only).
  const other = await recoverOp(alice, bob, rec);
  assert.equal(await opReason(next.pub, { ...op, rsig: other.rsig }, next), 'sig');
  const otherSite = await recoverOp(alice, next, rec, 'mw1:anothersite0000000000000');
  assert.equal(await opReason(next.pub, { ...op, rsig: otherSite.rsig }, next), 'sig');
  const byOther = await recoverOp(alice, next, bob);
  assert.equal(await opReason(next.pub, { ...op, rsig: byOther.rsig }, next), 'sig');
  assert.equal(await opReason(next.pub, { ...op, rp: bob.pub }, next), 'sig', 'rp must be the key that signed');
  // Shape: signed by next, rp and rsig required.
  assert.equal(await opReason(alice.pub, op, alice), 'op', 'a recover rotation is signed by next');
  const { rsig, ...noSig } = op;
  assert.equal(await opReason(next.pub, noSig, next), 'op');
  assert.equal(await opReason(next.pub, { ...op, rsig: 'short' }, next), 'op');
  assert.equal(await opReason(next.pub, { ...op, rp: rec.pub.slice(5) }, next), 'op');
  assert.equal(rsig.length, 86);
});

test('checkpoint: heads 1 to 32 sorted unique hashes, snap, n >= 1, bytes; 33 heads is limit', async () => {
  const heads = (k) => Array.from({ length: k }, (_, i) => hexOf('h' + i)).sort();
  const op = (k, extra = {}) => Object.assign({ t: 'checkpoint', heads: heads(k), snap: hexOf('S'), n: 10, bytes: 500 }, extra);
  assert.equal(await reasonOf(await control(owner, op(1))), 'ok');
  assert.equal(await reasonOf(await control(owner, op(32))), 'ok');
  assert.equal(await opReason(owner.pub, op(33), owner), 'limit');
  assert.equal(await opReason(owner.pub, op(0), owner), 'op');
  assert.equal(await opReason(owner.pub, op(2, { heads: heads(2).reverse() }), owner), 'op', 'unsorted');
  assert.equal(await opReason(owner.pub, op(2, { heads: [heads(1)[0], heads(1)[0]] }), owner), 'op', 'duplicate');
  assert.equal(await opReason(owner.pub, op(1, { snap: 'Z'.repeat(64) }), owner), 'op');
  assert.equal(await opReason(owner.pub, op(1, { n: 0 }), owner), 'op');
  assert.equal(await opReason(owner.pub, op(1, { bytes: -1 }), owner), 'op');
  assert.equal(await opReason(owner.pub, op(1, { root: H1 }), owner), 'op', 'unknown field');
});

test('bulk tombstone: { authors (1 to 64 distinct keys), before }; 65 is limit; the h form is unchanged', async () => {
  const op = (authors) => ({ t: 'tombstone', authors, before: H2 });
  assert.equal(await reasonOf(await control(mod, op([alice.pub, bob.pub].sort()))), 'ok');
  assert.equal(await reasonOf(await control(mod, op(manyKeys.slice(0, 39)))), 'ok', '39 tagged keys fit in a 4 096-byte block (measured)');
  assert.equal(await opReason(mod.pub, op(manyKeys.slice(0, 40)), mod), 'size', '40 do not (measured)');
  assert.equal(await opReason(mod.pub, op(manyKeys), mod), 'limit', '65 authors');
  // 64 is within the op cap; such a block is still over maxBlockBytes.
  assert.equal(await opReason(mod.pub, op(manyKeys.slice(0, 64)), mod), 'size');
  assert.equal(await opReason(mod.pub, op([]), mod), 'op');
  assert.equal(await opReason(mod.pub, op([alice.pub, alice.pub]), mod), 'op');
  assert.equal(await opReason(mod.pub, { t: 'tombstone', authors: [alice.pub], before: 'x' }, mod), 'op');
  assert.equal(await opReason(mod.pub, { t: 'tombstone', authors: [alice.pub], before: H2, h: H1 }, mod), 'op');
  assert.equal(await opReason(mod.pub, { t: 'tombstone', authors: [alice.pub] }, mod), 'op');
  assert.equal(await reasonOf(await control(mod, { t: 'tombstone', h: H2 })), 'ok');
});

test('policy fields: modAllowPerDay, modActionsPerHour, reservedPool (0 to 50), voided (at most 50, one per author)', async () => {
  assert.equal(await reasonOf(await control(owner, { t: 'policy', modAllowPerDay: 0, modActionsPerHour: 60, reservedPool: 50, voided: [] })), 'ok');
  assert.equal(await reasonOf(await control(owner, { t: 'policy', voided: [{ author: mod.pub, after: H2 }] })), 'ok');
  const check = (fields) => validatePolicyFields(Object.assign({ t: 'policy' }, fields));
  assert.deepEqual(check({ reservedPool: 51 }), { ok: false, reason: 'limit', field: 'reservedPool' });
  assert.deepEqual(check({ reservedPool: -1 }), { ok: false, reason: 'op', field: 'reservedPool' });
  assert.deepEqual(check({ modAllowPerDay: 1.5 }), { ok: false, reason: 'op', field: 'modAllowPerDay' });
  assert.deepEqual(check({ modActionsPerHour: '60' }), { ok: false, reason: 'op', field: 'modActionsPerHour' });
  const voided = (n) => manyKeys.slice(0, n).map((author) => ({ author, after: H1 }));
  assert.deepEqual(check({ voided: voided(50) }), { ok: true });
  assert.deepEqual(check({ voided: voided(51) }), { ok: false, reason: 'limit', field: 'voided' });
  assert.deepEqual(check({ voided: [{ author: mod.pub, after: H1 }, { author: mod.pub, after: H2 }] }), { ok: false, reason: 'op', field: 'voided' });
  assert.deepEqual(check({ voided: [{ author: mod.pub }] }), { ok: false, reason: 'op', field: 'voided' });
  assert.deepEqual(check({ voided: [{ author: mod.pub, after: H1, x: 1 }] }), { ok: false, reason: 'op', field: 'voided' });
  assert.deepEqual(check({ voided: {} }), { ok: false, reason: 'op', field: 'voided' });
  assert.deepEqual(check({ unknown: 1 }), { ok: false, reason: 'op', field: 'unknown' });
});

test('every v1 block vector still validates as recorded (block.json, the freeze-group vectors included)', async () => {
  const doc = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'vectors', 'block.json'), 'utf8'));
  let n = 0;
  for (const v of doc.vectors) {
    if (v.kind !== 'block') continue;
    n++;
    const got = await validateBlock(v.block, v.options);
    assert.deepEqual(got, v.expect.valid ? { ok: true } : { ok: false, reason: v.expect.reason }, v.id);
  }
  assert.ok(n >= 22, n + ' block vectors');
});
