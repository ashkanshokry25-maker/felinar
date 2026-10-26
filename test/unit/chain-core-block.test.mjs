// Unit tests for src/chain/block.js: block v1 layout, createBlock, every validateBlock rejection
// reason, redaction, policy field rules. node:crypto is an independent oracle for the hashes and
// for the exact bytes that are signed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify as nodeVerify } from 'node:crypto';
import {
  LIMITS, DEFAULT_POLICY, SIG_PREFIX, TS_ROUND_MS, MAX_POLICY_BITS, CONTROL_OPS, PAYLOAD_OPS,
  valueHash, createBlock, validateBlock, isControlOp, isPayloadOp, blockBytes, redact,
  validatePolicyFields, validateName, roundTs,
  VH_PREFIX, SALT_BYTES, SALT_LENGTH, isSalt, newSalt, valueHashInput, valueHashSync,
  FUTURE_CONTROL_OPS, RESERVED_OP_NAMES,
} from '../../src/chain/block.js';
import { hashEntry, leadingZeroBits } from '../../src/chain/pow.js';
import { generateKeyPair, exportPublicKey, exportPrivateJwk, sign } from '../../src/chain/crypto.js';
import { canonicalize, utf8, hex, b64url, byteLength } from '../../src/chain/canonical.js';

const SITE = 'mw1:blocktestsite0000000000000';
const OTHER_SITE = 'btih:0123456789abcdef0123456789abcdef01234567';
const T0 = Date.UTC(2026, 9, 17, 12, 34, 0);
const H1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const H3 = '3'.repeat(64);

async function makeIdentity({ extractable = false } = {}) {
  const kp = await generateKeyPair({ extractable });
  return { privateKey: kp.privateKey, pub: await exportPublicKey(kp.publicKey) };
}

const owner = await makeIdentity({ extractable: true });
const alice = await makeIdentity();
const bob = await makeIdentity();

const nodeSha = (str) => createHash('sha256').update(utf8.encode(str)).digest('hex');
const clone = (x) => JSON.parse(JSON.stringify(x));
// A fixed value salt for hand-made blocks (v0.2.1 A1); createBlock draws a fresh one.
const Z = b64url.encode(Uint8Array.from({ length: 16 }, (_, i) => i + 1));

// Re-hash and re-sign a modified entry so that only the check under test can fail. A value is
// carried with its salt z (default Z).
async function reseal(e, v, identity = alice, z = Z) {
  const { hashHex } = await hashEntry(e);
  const s = b64url.encode(await sign(identity.privateKey, SIG_PREFIX + hashHex));
  const out = { e, h: hashHex, s };
  if (v !== undefined) {
    out.v = v;
    out.z = z;
  }
  return out;
}

async function putBlock(extra = {}) {
  return createBlock(Object.assign({ identity: alice, site: SITE, seq: 1, prev: [H1], op: { t: 'put', k: 'greeting' }, value: { text: 'hello' }, ts: T0, bits: 6 }, extra));
}

async function reasonOf(block, opts) {
  const r = await validateBlock(block, opts);
  return r.ok ? 'ok' : r.reason;
}

test('LIMITS and DEFAULT_POLICY match ARCHITECTURE 6.1 and are frozen', () => {
  assert.deepEqual({ ...LIMITS }, {
    maxBlockBytes: 4096, maxPrev: 8, maxKey: 256, maxListName: 64, maxName: 48,
    maxChainBytesCeiling: 64 * 1024 * 1024, maxAllow: 1000, maxModerators: 50,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(DEFAULT_POLICY)), {
    writers: 'owner', bits: 16, maxValueBytes: 2048, maxChainBytes: 8 * 1024 * 1024, moderators: [], allow: [],
  });
  assert.ok(Object.isFrozen(LIMITS) && Object.isFrozen(DEFAULT_POLICY));
  assert.ok(Object.isFrozen(DEFAULT_POLICY.moderators) && Object.isFrozen(DEFAULT_POLICY.allow));
  assert.equal(SIG_PREFIX, 'mw-block-v1\n');
  assert.equal(TS_ROUND_MS, 60000);
  assert.deepEqual([...PAYLOAD_OPS], ['put', 'append', 'profile']);
  // v0.3 freeze group (DESIGN-REVIEW 2.10.1): unban, keyinfo, rotate and the defined checkpoint.
  assert.deepEqual([...CONTROL_OPS], ['policy', 'owner', 'tombstone', 'ban', 'allow', 'unban', 'keyinfo', 'rotate', 'checkpoint']);
});

test('isControlOp / isPayloadOp', () => {
  for (const t of CONTROL_OPS) {
    assert.equal(isControlOp({ t }), true);
    assert.equal(isPayloadOp({ t }), false);
  }
  for (const t of PAYLOAD_OPS) {
    assert.equal(isPayloadOp({ t }), true);
    assert.equal(isControlOp({ t }), false);
  }
  for (const op of [null, undefined, 'put', {}, { t: 'nope' }]) {
    assert.equal(isControlOp(op), false);
    assert.equal(isPayloadOp(op), false);
  }
});

test('createBlock: layout, vh outside the hash, signature over "mw-block-v1\\n" + h', async () => {
  const value = { text: 'hello', n: [1, 2, 3] };
  const block = await createBlock({ identity: alice, site: SITE, seq: 7, prev: [H2, H1, H2], op: { t: 'put', k: 'greeting' }, value, ts: T0 + 59999, bits: 8 });
  assert.deepEqual(Object.keys(block).sort(), ['e', 'h', 's', 'v', 'z']);
  assert.ok(isSalt(block.z), 'a fresh 128-bit salt travels beside v (A1)');
  const e = block.e;
  assert.deepEqual(Object.keys(e).sort(), ['author', 'bits', 'nonce', 'op', 'prev', 'seq', 'site', 'ts', 'v']);
  assert.equal(e.v, 1);
  assert.equal(e.site, SITE);
  assert.equal(e.author, alice.pub);
  assert.equal(e.seq, 7);
  assert.deepEqual(e.prev, [H1, H2], 'prev is de-duplicated and sorted');
  assert.equal(e.ts, T0, 'ts is rounded down to the minute');
  assert.equal(e.bits, 8);
  // vh = sha256(utf8("mw-vh-v1\n" + z + "\n" + canonical(v))) (v0.2.1 A1), never the unsalted hash.
  assert.deepEqual(e.op, { t: 'put', k: 'greeting', vh: nodeSha('mw-vh-v1\n' + block.z + '\n' + canonicalize(value)) });
  assert.notEqual(e.op.vh, nodeSha(canonicalize(value)));
  assert.equal(e.op.vh, await valueHash(value, block.z));
  assert.notEqual(block.z, e.nonce, 'the salt is never the hashcash nonce');
  assert.equal(block.h, nodeSha(canonicalize(e)), 'h = sha256(utf8(canonical(e)))');
  assert.ok(leadingZeroBits(hex.decode(block.h)) >= 8);
  assert.deepEqual(block.v, value);
  assert.notEqual(block.v, value, 'the stored value is a copy');
  value.text = 'changed';
  assert.deepEqual(await validateBlock(block, { minBits: 8 }), { ok: true });

  // The signature is ECDSA-P256-SHA256, raw r||s, over exactly utf8("mw-block-v1\n" + h).
  const jwk = await exportPrivateJwk(owner.privateKey);
  const own = await createBlock({ identity: owner, site: SITE, op: { t: 'policy', writers: 'open' }, ts: T0 });
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
  const sigBytes = b64url.decode(own.s);
  assert.equal(sigBytes.length, 64);
  assert.equal(nodeVerify('sha256', utf8.encode('mw-block-v1\n' + own.h), { key, dsaEncoding: 'ieee-p1363' }, sigBytes), true);
  assert.equal(own.e.nonce, '', 'bits 0 needs no nonce');
  assert.equal(own.v, undefined, 'control blocks have no v');
  assert.equal(own.z, undefined, 'control blocks have no salt');
  assert.deepEqual(Object.keys(own).sort(), ['e', 'h', 's']);
});

test('createBlock: every op type round-trips through validateBlock', async () => {
  const ops = [
    [{ t: 'put', k: 'k' }, null],
    [{ t: 'put', k: '_notice' }, 'hi'],
    [{ t: 'append', l: 'guestbook' }, { text: 'hello', at: 1 }],
    [{ t: 'profile' }, 'Alice'],
    [{ t: 'profile' }, ''],
    [{ t: 'policy', writers: 'allow', bits: 12, maxValueBytes: 1024, maxChainBytes: 1 << 20, moderators: [bob.pub], allow: [alice.pub] }, undefined],
    [{ t: 'policy' }, undefined],
    [{ t: 'owner', next: bob.pub }, undefined],
    [{ t: 'tombstone', h: H3 }, undefined],
    [{ t: 'ban', author: bob.pub }, undefined],
    [{ t: 'allow', add: [bob.pub], remove: [alice.pub] }, undefined],
    [{ t: 'allow', add: [bob.pub] }, undefined],
    [{ t: 'allow', remove: [] }, undefined],
  ];
  for (const [op, value] of ops) {
    const block = await createBlock({ identity: owner, site: SITE, prev: [H1], op, value, ts: T0 });
    assert.deepEqual(await validateBlock(block), { ok: true }, JSON.stringify(op));
    assert.equal('v' in block, value !== undefined);
    assert.equal('z' in block, value !== undefined);
  }
});

test('createBlock: input errors', async () => {
  const base = { identity: alice, site: SITE, prev: [H1], ts: T0 };
  const code = (c, reason) => (err) => err.code === c && (reason === undefined || err.reason === reason);
  await assert.rejects(createBlock({ ...base, op: { t: 'put', k: 'a' }, value: 'x'.repeat(3000) }), code('E_LIMIT', 'value-size'));
  await assert.rejects(createBlock({ ...base, op: { t: 'put', k: 'a' }, value: 'x'.repeat(3900), maxValueBytes: 4096 }), code('E_LIMIT', 'size'));
  await assert.rejects(createBlock({ ...base, op: { t: 'put', k: 'k'.repeat(257) }, value: 1 }), code('E_LIMIT', 'limit'));
  await assert.rejects(createBlock({ ...base, prev: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => String(i).repeat(64)), op: { t: 'put', k: 'a' }, value: 1 }), code('E_LIMIT', 'limit'));
  await assert.rejects(createBlock({ ...base, op: { t: 'put', k: 'a' } }), code('E_INVALID', 'shape'));
  await assert.rejects(createBlock({ ...base, op: { t: 'put', k: 'a' }, value: { bad: undefined } }), code('E_INVALID', 'shape'));
  await assert.rejects(createBlock({ ...base, op: { t: 'put', k: 'a' }, value: NaN }), code('E_INVALID', 'shape'));
  await assert.rejects(createBlock({ ...base, op: { t: 'ban', author: bob.pub }, value: 1 }), code('E_INVALID', 'shape'));
  await assert.rejects(createBlock({ ...base, op: { t: 'nope' } }), code('E_INVALID', 'unknown-op'));
  await assert.rejects(createBlock({ ...base, op: { t: 'checkpoint' } }), code('E_INVALID', 'unknown-op'), 'the v0.2.1 placeholder form stays undefined');
  await assert.rejects(createBlock({ ...base, op: { t: 'vanish' } }), code('E_INVALID', 'unknown-op'));
  await assert.rejects(createBlock({ ...base, op: { t: 'put', k: 'a' }, value: 1, z: 'short' }), code('E_INVALID', 'shape'));
  await assert.rejects(createBlock({ ...base, identity: owner, op: { t: 'ban', author: bob.pub }, z: Z }), code('E_INVALID', 'shape'));
  await assert.rejects(createBlock({ ...base, op: { t: 'policy', writers: 'everyone' } }), code('E_INVALID', 'op'));
  await assert.rejects(createBlock({ ...base, op: null }), code('E_INVALID', 'op'));
  await assert.rejects(createBlock({ ...base, site: '', op: { t: 'put', k: 'a' }, value: 1 }), code('E_INVALID', 'shape'));
  await assert.rejects(createBlock({ ...base, op: { t: 'profile' }, value: 'x'.repeat(49) }), code('E_LIMIT', 'limit'));
  await assert.rejects(createBlock({ ...base, op: { t: 'put', k: 'a' }, value: 1, bits: -1 }), code('E_INVALID'));
  await assert.rejects(createBlock({ ...base, identity: { privateKey: alice.privateKey, pub: bob.pub }, op: { t: 'put', k: 'a' }, value: 1 }), code('E_IDENTITY'));
  await assert.rejects(createBlock({ ...base, identity: null, op: { t: 'put', k: 'a' }, value: 1 }), code('E_IDENTITY'));
  await assert.rejects(createBlock({ ...base, identity: { privateKey: null, pub: alice.pub }, op: { t: 'put', k: 'a' }, value: 1 }), code('E_IDENTITY'));
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(createBlock({ ...base, op: { t: 'put', k: 'a' }, value: 1, bits: 8, signal: aborted.signal }), code('E_POW_ABORTED'));
  // A control op given by the caller is deep-copied too.
  const mods = [bob.pub];
  const policy = await createBlock({ identity: owner, site: SITE, prev: [H1], op: { t: 'policy', moderators: mods }, ts: T0 });
  mods.push(alice.pub);
  assert.deepEqual(policy.e.op.moderators, [bob.pub]);
  assert.deepEqual(await validateBlock(policy), { ok: true });
  assert.equal(roundTs(T0 + 1), T0);
  assert.throws(() => roundTs(-5), TypeError);
});

test('createBlock: a custom miner is used and only its nonce is taken', async () => {
  const calls = [];
  const { mine } = await import('../../src/chain/pow.js');
  const miner = {
    async mine(entry, bits, opts) {
      calls.push({ bits, hasSignal: 'signal' in opts });
      const res = await mine(entry, bits);
      return { entry: Object.assign({}, res.entry, { seq: 999 }), h: 'f'.repeat(64) }; // only the nonce is trusted
    },
  };
  const block = await createBlock({ identity: alice, site: SITE, prev: [H1], op: { t: 'put', k: 'a' }, value: 1, ts: T0, bits: 7, miner });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bits, 7);
  assert.equal(block.e.seq, 0);
  assert.deepEqual(await validateBlock(block, { minBits: 7 }), { ok: true });
  const lying = { async mine(entry) { return { entry: Object.assign({}, entry, { nonce: 'zzzzzzzzzzzz' }) }; } };
  await assert.rejects(createBlock({ identity: alice, site: SITE, prev: [H1], op: { t: 'put', k: 'a' }, value: 1, ts: T0, bits: 20, miner: lying }), /target/);
});

test("validateBlock: 'shape' rejections", async () => {
  const good = await putBlock();
  assert.equal(await reasonOf(good), 'ok');
  const withE = (patch) => ({ ...good, e: { ...good.e, ...patch } });
  const cases = [
    null, 'block', [], {}, { e: good.e, h: good.h }, { ...good, extra: 1 },
    { ...good, h: good.h.toUpperCase() }, { ...good, h: good.h.slice(1) }, { ...good, s: good.s + 'A' }, { ...good, s: good.s.slice(0, 85) + '+' },
    withE({ extra: 1 }), withE({ v: 2 }), withE({ site: '' }), withE({ site: 'has space' }), withE({ site: 'x'.repeat(129) }), withE({ site: 5 }),
    withE({ author: 'not-a-key' }), withE({ author: bob.pub.slice(0, 86) + '!' }),
    withE({ seq: -1 }), withE({ seq: 1.5 }), withE({ seq: '1' }),
    withE({ prev: 'x' }), withE({ prev: ['ab'.repeat(32).toUpperCase()] }), withE({ prev: [H2, H1] }), withE({ prev: [H1, H1] }), withE({ prev: [H1.slice(2)] }),
    withE({ ts: T0 + 1 }), withE({ ts: -60000 }), withE({ ts: '0' }),
    withE({ bits: -1 }), withE({ bits: 257 }), withE({ bits: 1.5 }),
    withE({ nonce: 'a b' }), withE({ nonce: 'x'.repeat(65) }), withE({ nonce: 5 }),
    { ...good, v: { bad: undefined } },
    { ...good, e: (({ nonce, ...rest }) => rest)(good.e) },
  ];
  for (const [i, block] of cases.entries()) assert.equal(await reasonOf(block), "shape", "case " + i);
  // A control op never carries v or z.
  const ban = await createBlock({ identity: owner, site: SITE, prev: [H1], op: { t: 'ban', author: bob.pub }, ts: T0 });
  assert.equal(await reasonOf({ ...ban, v: 1 }), 'shape');
  assert.equal(await reasonOf({ ...ban, z: Z }), 'shape');
  assert.equal(await reasonOf({ ...ban, v: 1, z: Z }), 'shape');
  // site option, genesisOwner option (a root by anyone but the genesis owner), lone surrogates.
  assert.equal(await reasonOf(good, { site: OTHER_SITE }), 'shape');
  assert.equal(await reasonOf(good, { site: SITE }), 'ok');
  const strangerRoot = await createBlock({ identity: alice, site: SITE, prev: [], op: { t: 'put', k: 'a' }, value: 1, ts: T0 });
  const ownerRoot = await createBlock({ identity: owner, site: SITE, prev: [], op: { t: 'policy' }, ts: T0 });
  assert.equal(await reasonOf(strangerRoot, { genesisOwner: owner.pub }), 'shape', 'missing prev for a non-owner');
  assert.equal(await reasonOf(strangerRoot), 'ok', 'roots are allowed when the owner is unknown (ownerless ledgers)');
  assert.equal(await reasonOf(ownerRoot, { genesisOwner: owner.pub }), 'ok');
  const lone = withE({ op: { t: 'put', k: 'a' + String.fromCharCode(0xd800), vh: good.e.op.vh } });
  assert.equal(await reasonOf(lone), 'shape');
  // validateBlock never throws.
  const evil = { h: good.h, s: good.s };
  Object.defineProperty(evil, 'e', { enumerable: true, get() { throw new Error('boom'); } });
  assert.deepEqual(await validateBlock(evil), { ok: false, reason: 'shape' });
  assert.deepEqual(await validateBlock(good, null), { ok: true });
});

test("validateBlock: 'op' and 'limit' rejections", async () => {
  const good = await putBlock();
  const withOp = (op) => ({ ...good, e: { ...good.e, op } });
  const vh = good.e.op.vh;
  const opCases = [
    'put', null, [], {}, { t: 'put', k: 'a', vh, extra: 1 }, { t: 'put', k: 'a', vh: vh.toUpperCase() },
    { t: 'put', k: '', vh }, { t: 'put', k: 5, vh }, { t: 'put', vh }, { t: 'append', k: 'a', vh }, { t: 'profile', k: 'a', vh },
    { t: 'policy', writers: 'everyone' }, { t: 'policy', nope: 1 }, { t: 'policy', bits: 1.5 }, { t: 'policy', bits: -1 },
    { t: 'policy', moderators: 'x' }, { t: 'policy', moderators: [bob.pub, bob.pub] }, { t: 'policy', allow: ['bad'] },
    { t: 'owner', next: 'bad' }, { t: 'owner', next: bob.pub, extra: 1 }, { t: 'tombstone', h: 'x' }, { t: 'tombstone' },
    { t: 'ban', author: 'bad' }, { t: 'allow', add: [bob.pub], other: [] }, { t: 'allow', add: ['bad'] },
    { t: 'allow', add: [bob.pub], remove: [bob.pub] }, { t: 'allow', add: 'x' },
  ];
  for (const op of opCases) {
    const block = withOp(op);
    if (op && typeof op === 'object' && !Array.isArray(op) && ['policy', 'owner', 'tombstone', 'ban', 'allow'].includes(op.t)) {
      delete block.v;
      delete block.z;
    }
    assert.equal(await reasonOf(block), 'op', JSON.stringify(op));
  }
  // The unknown-op rule (v0.2.1 A2): an op name v1 does not define is 'unknown-op', reserved names too.
  for (const t of ['nope', 'checkpoint', 'vanish', 'grp', 'Put', 'POLICY', '__proto__', '']) { // checkpoint without heads: the reserved form
    const block = withOp({ t });
    delete block.v;
    delete block.z;
    assert.equal(await reasonOf(block), 'unknown-op', t);
  }
  const many = (n) => Array.from({ length: n }, (_, i) => String(i % 10).repeat(63) + 'abcdefghij'[Math.floor(i / 10)]).sort();
  const limitCases = [
    { ...good, e: { ...good.e, prev: many(9) } },
    withOp({ t: 'put', k: 'k'.repeat(257), vh }),
    withOp({ t: 'put', k: String.fromCharCode(0xe9).repeat(129), vh }), // 258 UTF-8 bytes
    withOp({ t: 'append', l: 'l'.repeat(65), vh }),
  ];
  for (const block of limitCases) assert.equal(await reasonOf(block), 'limit');
  const policyLimit = (op) => {
    const block = withOp(Object.assign({ t: 'policy' }, op));
    delete block.v;
    delete block.z;
    return block;
  };
  assert.equal(await reasonOf(policyLimit({ bits: MAX_POLICY_BITS + 1 })), 'limit');
  assert.equal(await reasonOf(policyLimit({ maxValueBytes: 4097 })), 'limit');
  assert.equal(await reasonOf(policyLimit({ maxChainBytes: LIMITS.maxChainBytesCeiling + 1 })), 'limit');
  const keys = [];
  for (let i = 0; i < 51; i++) keys.push((await makeIdentity()).pub);
  assert.equal(await reasonOf(policyLimit({ moderators: keys })), 'limit');
  // Profile values: names of at most 48 code points without control or bidi characters.
  const profile = await createBlock({ identity: alice, site: SITE, prev: [H1], op: { t: 'profile' }, value: 'Alice', ts: T0 });
  assert.equal(await reasonOf(profile), 'ok');
  for (const bad of [42, null, { name: 'x' }, 'a' + String.fromCharCode(10) + 'b', 'a' + String.fromCharCode(0x202e) + 'b']) {
    const v = bad;
    const e = { ...profile.e, op: { t: 'profile', vh: await valueHash(v, Z) } };
    assert.equal(await reasonOf(await reseal(e, v)), 'op', JSON.stringify(bad));
  }
  // A lone surrogate cannot even be canonicalised, so it is a 'shape' problem.
  const lone = String.fromCharCode(0xdc00);
  const loneBlock = { e: { ...profile.e, op: { t: 'profile', vh: 'a'.repeat(64) } }, h: profile.h, s: profile.s, v: lone, z: Z };
  assert.equal(await reasonOf(loneBlock), 'shape');
  const long = 'x'.repeat(49);
  assert.equal(await reasonOf(await reseal({ ...profile.e, op: { t: 'profile', vh: await valueHash(long, Z) } }, long)), 'limit');
  const emoji = String.fromCharCode(0xd83d, 0xde00).repeat(48); // 48 code points, 96 UTF-16 units
  assert.equal(await reasonOf(await reseal({ ...profile.e, op: { t: 'profile', vh: await valueHash(emoji, Z) } }, emoji)), 'ok');
});

test("validateBlock: 'size' covers canonical(e) + canonical(v) + z", async () => {
  const good = await putBlock({ bits: 0 });
  const big = 'x'.repeat(3800); // fits maxValueBytes 4096 on its own, not with e
  const e = { ...good.e, op: { t: 'put', k: 'greeting', vh: await valueHash(big, Z) } };
  const sealed = await reseal(e, big);
  assert.ok(byteLength(canonicalize(big)) <= 4096);
  assert.ok(blockBytes(sealed) > LIMITS.maxBlockBytes);
  assert.equal(await reasonOf(sealed, { maxValueBytes: 4096 }), 'size');
  const fits = 'x'.repeat(3000);
  const ok = await reseal({ ...good.e, op: { t: 'put', k: 'greeting', vh: await valueHash(fits, Z) } }, fits);
  assert.equal(await reasonOf(ok, { maxValueBytes: 4096 }), 'ok');
  // The 22-character salt counts (A1): a value that fills the block exactly without z does not fit with it.
  const eBytes = byteLength(canonicalize(ok.e));
  const exact = 'x'.repeat(LIMITS.maxBlockBytes - eBytes - 2); // canonical adds the two quotes
  const edge = await reseal({ ...ok.e, op: { t: 'put', k: 'greeting', vh: await valueHash(exact, Z) } }, exact);
  assert.equal(byteLength(canonicalize(edge.e)) + byteLength(canonicalize(exact)), LIMITS.maxBlockBytes);
  assert.equal(blockBytes(edge), LIMITS.maxBlockBytes + SALT_LENGTH);
  assert.equal(await reasonOf(edge, { maxValueBytes: 4096 }), 'size');
});

test("validateBlock: tampering any entry field or h is 'hash'", async () => {
  const good = await putBlock();
  const other = await putBlock({ seq: 2 });
  const tamper = {
    v: undefined,
    site: OTHER_SITE,
    author: bob.pub,
    seq: 2,
    prev: [H2],
    ts: T0 + 60000,
    bits: 5,
    op: { ...good.e.op, k: 'other' },
    nonce: good.e.nonce === 'zzzzzzzzzzzz' ? 'zzzzzzzzzzzy' : 'zzzzzzzzzzzz',
  };
  for (const [field, value] of Object.entries(tamper)) {
    if (field === 'v') continue;
    const block = clone(good);
    block.e[field] = value;
    assert.equal(await reasonOf(block), 'hash', field);
  }
  const vhTampered = clone(good);
  vhTampered.e.op.vh = 'a'.repeat(64);
  assert.equal(await reasonOf(vhTampered), 'hash', 'vh is inside the hash');
  assert.equal(await reasonOf({ ...good, h: other.h }), 'hash');
});

test("validateBlock: 'pow' (floor and claimed bits) and 'sig'", async () => {
  const good = await putBlock({ bits: 8 });
  assert.equal(await reasonOf(good, { minBits: 8 }), 'ok');
  assert.equal(await reasonOf(good, { minBits: 9 }), 'pow', 'e.bits below the floor');
  const claims = { ...good.e, bits: 40 };
  assert.equal(await reasonOf(await reseal(claims, good.v, alice, good.z)), 'pow', 'h misses the claimed bits');
  const other = await putBlock({ seq: 5 });
  assert.equal(await reasonOf({ ...good, s: other.s }), 'sig');
  assert.equal(await reasonOf({ ...good, s: 'A'.repeat(86) }), 'sig');
  assert.equal(await reasonOf(await reseal(good.e, good.v, bob, good.z)), 'sig', 'signed by a key other than e.author');
});

test("validateBlock: 'value-hash' and 'value-size'", async () => {
  const good = await putBlock();
  assert.equal(await reasonOf({ ...good, v: { text: 'HELLO' } }), 'value-hash');
  assert.equal(await reasonOf({ ...good, v: null }), 'value-hash');
  assert.equal(await reasonOf(redact(good), { requireValue: true }), 'value-hash');
  // The salt is part of the commitment (A1): another salt fails, a value never travels without its salt.
  assert.equal(await reasonOf({ ...good, z: Z }), 'value-hash', 'another salt');
  assert.equal(await reasonOf({ ...good, z: newSalt() }), 'value-hash', 'a fresh salt');
  const { z: _z, ...noSalt } = good;
  assert.equal(await reasonOf(noSalt), 'shape', 'v without z');
  assert.equal(await reasonOf({ ...redact(good), z: good.z }), 'shape', 'z without v');
  for (const bad of ['', 'A'.repeat(21), 'A'.repeat(23), good.z.slice(0, 21) + '+', good.z.slice(0, 21) + 'B', 16, null]) {
    assert.equal(await reasonOf({ ...good, z: bad }), 'shape', 'malformed salt ' + JSON.stringify(bad));
  }
  const big = await createBlock({ identity: alice, site: SITE, prev: [H1], op: { t: 'append', l: 'log' }, value: 'y'.repeat(2500), ts: T0, maxValueBytes: 3000 });
  assert.equal(await reasonOf(big), 'value-size', 'default cap 2048');
  assert.equal(await reasonOf(big, { maxValueBytes: 3000 }), 'ok');
  assert.equal(await reasonOf(redact(big)), 'ok', 'a stub carries no value to measure');
});

test('redaction keeps h and s valid; stubs cannot lie about prev; control ops keep their content', async () => {
  const good = await putBlock();
  const stub = redact(good);
  assert.deepEqual(Object.keys(stub).sort(), ['e', 'h', 's'], 'redact drops v and its salt z');
  assert.equal(stub.h, good.h);
  assert.equal(stub.s, good.s);
  assert.deepEqual(await validateBlock(stub), { ok: true });
  assert.equal(blockBytes(stub), byteLength(canonicalize(good.e)));
  assert.equal(blockBytes(good), byteLength(canonicalize(good.e)) + byteLength(canonicalize(good.v)) + SALT_LENGTH);
  const forged = clone(stub);
  forged.e.prev = [H2];
  assert.equal(await reasonOf(forged), 'hash', 'a stub with an altered prev fails h');
  // Control ops can never be redacted: their content is the entry itself.
  const policy = await createBlock({ identity: owner, site: SITE, prev: [H1], op: { t: 'policy', writers: 'open', bits: 4 }, ts: T0 });
  const red = redact(policy);
  assert.deepEqual(red, policy);
  assert.deepEqual(await validateBlock(red), { ok: true });
  const stripped = clone(policy);
  stripped.e.op = { t: 'policy' };
  assert.equal(await reasonOf(stripped), 'hash', 'a policy block cannot be stored without its content');
});

test('validatePolicyFields', () => {
  const ok = (p) => assert.deepEqual(validatePolicyFields(p), { ok: true }, JSON.stringify(p));
  const bad = (p, reason, field) => {
    const r = validatePolicyFields(p);
    assert.equal(r.ok, false, JSON.stringify(p));
    assert.equal(r.reason, reason);
    assert.equal(r.field, field);
  };
  ok({});
  ok({ t: 'policy' });
  ok({ writers: 'owner' });
  ok({ writers: 'allow', allow: [alice.pub, bob.pub] });
  ok({ writers: 'open', bits: 0, maxValueBytes: 0, maxChainBytes: 0, moderators: [] });
  ok({ bits: MAX_POLICY_BITS, maxValueBytes: 4096, maxChainBytes: LIMITS.maxChainBytesCeiling });
  bad(null, 'op', null);
  bad([], 'op', null);
  bad({ t: 'put' }, 'op', 't');
  bad({ writers: 'all' }, 'op', 'writers');
  bad({ extra: 1 }, 'op', 'extra');
  bad({ bits: '16' }, 'op', 'bits');
  bad({ bits: 33 }, 'limit', 'bits');
  bad({ maxValueBytes: -1 }, 'op', 'maxValueBytes');
  bad({ maxValueBytes: 4097 }, 'limit', 'maxValueBytes');
  bad({ maxChainBytes: LIMITS.maxChainBytesCeiling + 1 }, 'limit', 'maxChainBytes');
  bad({ moderators: [alice.pub, alice.pub] }, 'op', 'moderators');
  bad({ allow: 'everyone' }, 'op', 'allow');
});

test('validateName', () => {
  assert.deepEqual(validateName('Alice'), { ok: true });
  assert.deepEqual(validateName(''), { ok: true });
  assert.deepEqual(validateName('x'.repeat(48)), { ok: true });
  assert.deepEqual(validateName('x'.repeat(49)), { ok: false, reason: 'limit' });
  assert.deepEqual(validateName(5), { ok: false, reason: 'op' });
  assert.deepEqual(validateName('tab' + String.fromCharCode(9)), { ok: false, reason: 'op' });
  assert.deepEqual(validateName('rtl' + String.fromCharCode(0x2067)), { ok: false, reason: 'op' });
  assert.deepEqual(validateName(String.fromCharCode(0x41, 0x200d, 0x42)), { ok: true }, 'joiners are fine');
});

test('salted value hash (v0.2.1 A1): domain, layout, sync and async agree, the stub reveals nothing guessable', async () => {
  assert.equal(VH_PREFIX, 'mw-vh-v1\n');
  assert.equal(SALT_BYTES, 16);
  assert.equal(SALT_LENGTH, 22);
  const z = newSalt();
  assert.ok(isSalt(z));
  assert.equal(b64url.decode(z).length, 16);
  assert.notEqual(newSalt(), z, 'fresh salts differ');
  assert.equal(valueHashInput({ b: 1, a: 'x' }, z), 'mw-vh-v1\n' + z + '\n{"a":"x","b":1}');
  assert.equal(await valueHash('yes', z), nodeSha('mw-vh-v1\n' + z + '\n"yes"'));
  assert.equal(valueHashSync('yes', z), await valueHash('yes', z));
  await assert.rejects(valueHash('yes'), TypeError, 'the salt is required');
  await assert.rejects(valueHash('yes', 'short'), TypeError);
  assert.throws(() => valueHashSync('yes', undefined), TypeError);
  await assert.rejects(valueHash(undefined, z), TypeError);
  assert.equal(isSalt('A'.repeat(22)), true, '16 zero bytes is a valid (if unlucky) salt');
  assert.equal(isSalt('A'.repeat(21) + 'B'), false, 'non-canonical trailing bits');

  // A short, guessable value: after a tombstone the stub keeps only e (with the salted vh), h and s.
  const block = await createBlock({ identity: alice, site: SITE, prev: [H1], op: { t: 'put', k: 'answer' }, value: 'yes', ts: T0 });
  const stub = redact(block);
  const text = JSON.stringify(stub);
  assert.ok(!text.includes(block.z), 'the salt is gone with the value');
  assert.ok(!text.includes('"yes"'), 'the value is gone');
  const guesses = ['yes', 'no', 'true', 'false', '', 'maybe', 'Alice', 'Bob', '0', '1', true, false, null, 0, 1, 42];
  for (const g of guesses) {
    // Without z, neither the v0.2 unsalted hash nor a salted hash with any salt an attacker can
    // try (empty, the hashcash nonce, the block hash) confirms the guess.
    assert.notEqual(stub.e.op.vh, nodeSha(canonicalize(g)), 'unsalted ' + JSON.stringify(g));
    assert.notEqual(stub.e.op.vh, nodeSha('mw-vh-v1\n\n' + canonicalize(g)));
    assert.notEqual(stub.e.op.vh, nodeSha('mw-vh-v1\n' + stub.e.nonce + '\n' + canonicalize(g)));
    assert.notEqual(stub.e.op.vh, nodeSha('mw-vh-v1\n' + stub.h + '\n' + canonicalize(g)));
  }
  // Whoever still holds v and z can prove the commitment; the stub alone cannot be filled in.
  assert.equal(stub.e.op.vh, await valueHash('yes', block.z));
  assert.equal(await reasonOf({ ...stub, v: 'yes', z: block.z }), 'ok');
  assert.equal(await reasonOf({ ...stub, v: 'yes', z: Z }), 'value-hash');
});

test('reserved op names and the unknown-op rule (v0.2.1 A2, v0.3 freeze group)', async () => {
  assert.deepEqual([...FUTURE_CONTROL_OPS], ['vanish', 'grp']);
  assert.deepEqual([...RESERVED_OP_NAMES], ['put', 'append', 'profile', 'policy', 'owner', 'tombstone', 'ban', 'allow', 'unban', 'keyinfo', 'rotate', 'checkpoint', 'vanish', 'grp']);
  assert.ok(Object.isFrozen(RESERVED_OP_NAMES) && Object.isFrozen(FUTURE_CONTROL_OPS));
  for (const t of FUTURE_CONTROL_OPS) {
    assert.equal(isControlOp({ t }), false, t + ' is not a v1 control op');
    assert.equal(isPayloadOp({ t }), false);
  }
  // A correctly hashed and signed block with a reserved op, or with the v0.2.1 placeholder
  // checkpoint form (no heads; vector blk-007), is still invalid.
  const e = { v: 1, site: SITE, author: owner.pub, seq: 0, prev: [H1], ts: T0, bits: 0, op: { t: 'checkpoint', n: 1, root: H2 }, nonce: '' };
  const sealed = await reseal(e, undefined, owner);
  assert.equal(await reasonOf(sealed), 'unknown-op');
  const vanish = await reseal({ ...e, op: { t: 'vanish', author: alice.pub } }, undefined, owner);
  assert.equal(await reasonOf(vanish), 'unknown-op');
});
