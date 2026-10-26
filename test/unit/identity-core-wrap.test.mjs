// Identity core, wrapping (R 2.2.4, 2.2.5; tests U-ID-3 parts and U-ID-7): BLAKE2b and Argon2id
// against published vectors (RFC 7693 appendix A, RFC 9106 section 5.3), the measured time of the
// identity origin's Argon2id parameters, PRF and passphrase wrapping with the KDF named in the
// header, fail-closed unwrapping, and forged or swapped escrow blobs failing AEAD.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { blake2b, argon2id, ARGON2ID_DEFAULTS } from '../../src/identity/argon2.js';
import * as w from '../../src/identity/wrap.js';
import { Vault } from '../../src/identity/vault.js';
import { hex, b64url } from '../../src/chain/canonical.js';

const bytes = (n, fill) => new Uint8Array(n).fill(fill);
const secrets = () => w.packSecrets({ rootStar: new Uint8Array(randomBytes(32)), kVault: new Uint8Array(randomBytes(32)) });
const SMALL = { m: 256, t: 1, p: 1 };

test('BLAKE2b-512 vectors (RFC 7693 appendix A "abc", and the empty input)', () => {
  assert.equal(hex.encode(blake2b(new TextEncoder().encode('abc'))),
    'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923');
  assert.equal(hex.encode(blake2b(new Uint8Array(0))),
    '786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce');
  // Multi-block input: 128-byte boundary handling (the last full block must be the final one).
  const a = blake2b(new Uint8Array(128));
  const b = blake2b(new Uint8Array(129));
  assert.notEqual(hex.encode(a), hex.encode(b));
  assert.equal(blake2b(new Uint8Array(3), 32).length, 32);
});

test('U-ID-3 Argon2id matches RFC 9106 section 5.3', () => {
  const tag = argon2id({ password: bytes(32, 1), salt: bytes(16, 2), secret: bytes(8, 3), ad: bytes(12, 4), m: 32, t: 3, p: 4, tagLength: 32 });
  assert.equal(hex.encode(tag), '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
  assert.throws(() => argon2id({ password: 'x', salt: bytes(4, 0), m: 64, t: 1, p: 1 }), RangeError);
  assert.throws(() => argon2id({ password: 'x', salt: bytes(16, 0), m: 7, t: 1, p: 1 }), RangeError);
});

test('Argon2id at the identity origin parameters (m = 64 MiB, t = 3, p = 1): measured', (t) => {
  assert.deepEqual(ARGON2ID_DEFAULTS, { m: 65536, t: 3, p: 1 });
  const runs = [];
  for (let i = 0; i < 2; i++) {
    const t0 = performance.now();
    argon2id({ password: 'correct horse battery staple', salt: bytes(16, i), ...ARGON2ID_DEFAULTS, tagLength: 32 });
    runs.push(Math.round(performance.now() - t0));
  }
  t.diagnostic('argon2id m=65536 t=3 p=1 (pure JS, Node ' + process.version + '): ' + runs.join(' ms, ') + ' ms');
});

test('U-ID-3 PRF wrap: K_unlock = HKDF(prf, "mw-idp-wrap-v1"); wrong PRF output fails closed', async () => {
  const prf = new Uint8Array(randomBytes(32));
  const s = secrets();
  const blob = await w.wrapWithPrf(prf, s, { credId: 'Y3JlZC0x' });
  assert.deepEqual(Object.keys(blob).sort(), ['credId', 'ct', 'iv', 'kind', 'v']);
  assert.equal(blob.v, 2);
  assert.equal(blob.kind, 'prf');
  assert.equal(b64url.decode(blob.iv).length, 12);
  assert.equal(b64url.decode(blob.ct).length, 64 + 16);
  const size = JSON.stringify(blob).length;
  assert.ok(size > 60 && size < 260, 'blob ' + size + ' characters as JSON');
  assert.deepEqual(await w.unwrapWithPrf(prf, blob), s);
  assert.deepEqual(w.unpackSecrets(await w.unwrapWithPrf(prf.buffer, blob)), w.unpackSecrets(s));
  await assert.rejects(() => w.unwrapWithPrf(new Uint8Array(randomBytes(32)), blob), (e) => e.code === 'E_UNWRAP');
  await assert.rejects(() => w.unwrapWithPassphrase('x', blob), (e) => e.code === 'E_UNWRAP');
  assert.equal(w.describeKdf(blob), 'prf');
  const again = await w.wrapWithPrf(prf, s);
  assert.notEqual(again.iv, blob.iv, 'a fresh random IV every time');
});

test('U-ID-3 passphrase wrap: Argon2id and PBKDF2 named in the header; wrong passphrase fails closed', async () => {
  const s = secrets();
  const a = await w.wrapWithPassphrase('blue lantern seven', s, { kdf: 'argon2id', params: SMALL });
  assert.deepEqual(a.kdf, { name: 'argon2id', m: 256, t: 1, p: 1 });
  assert.equal(a.kind, 'pass');
  assert.equal(b64url.decode(a.salt).length, 16);
  assert.deepEqual(await w.unwrapWithPassphrase('blue lantern seven', a), s);
  await assert.rejects(() => w.unwrapWithPassphrase('blue lantern sever', a), (e) => e.code === 'E_UNWRAP');
  assert.equal(w.describeKdf(a), 'argon2id');

  const p = await w.wrapWithPassphrase('blue lantern seven', s, { kdf: 'pbkdf2' });
  assert.deepEqual(p.kdf, { name: 'pbkdf2-sha256', iter: 600000 }, 'PBKDF2 at 600,000 iterations, named');
  assert.equal(w.describeKdf(p), 'pbkdf2-sha256');
  assert.deepEqual(await w.unwrapWithPassphrase('blue lantern seven', p), s);
  await assert.rejects(() => w.unwrapWithPassphrase('Blue lantern seven', p), (e) => e.code === 'E_UNWRAP');

  // NFC: the same passphrase typed with a combining accent opens it.
  const n = await w.wrapWithPassphrase('café au lait 99', s, { kdf: 'argon2id', params: SMALL });
  assert.deepEqual(await w.unwrapWithPassphrase('café au lait 99', n), s);
  await assert.rejects(() => w.wrapWithPassphrase('x', s, { kdf: 'scrypt' }), TypeError);
});

test('U-ID-3 the default passphrase wrap uses Argon2id m = 64 MiB, t = 3, p = 1', async () => {
  const s = secrets();
  const blob = await w.wrapWithPassphrase('blue lantern seven', s);
  assert.deepEqual(blob.kdf, { name: 'argon2id', m: 65536, t: 3, p: 1 });
  assert.deepEqual(await w.unwrapWithPassphrase('blue lantern seven', blob), s);
});

test('a changed header fails closed: no silent KDF downgrade, bounds checked before any work', async () => {
  const s = secrets();
  const p = await w.wrapWithPassphrase('pw', s, { kdf: 'pbkdf2', params: { iter: 2000 } });
  const changed = Object.assign({}, p, { kdf: { name: 'pbkdf2-sha256', iter: 1000 } });
  await assert.rejects(() => w.unwrapWithPassphrase('pw', changed), (e) => e.code === 'E_UNWRAP');
  const huge = Object.assign({}, p, { kdf: { name: 'argon2id', m: 1 << 22, t: 3, p: 1 } });
  const t0 = Date.now();
  await assert.rejects(() => w.unwrapWithPassphrase('pw', huge), (e) => e.code === 'E_UNWRAP');
  assert.ok(Date.now() - t0 < 1000, 'refused without running the KDF');
  for (const bad of [{ name: 'pbkdf2-sha256', iter: 10 }, { name: 'argon2id', m: 8, t: 0, p: 1 }, { name: 'md5' }, null]) {
    await assert.rejects(() => w.unwrapWithPassphrase('pw', Object.assign({}, p, { kdf: bad })), (e) => e.code === 'E_UNWRAP');
  }
  await assert.rejects(() => w.unwrapWithPassphrase('pw', Object.assign({}, p, { extra: 1 })), (e) => e.code === 'E_UNWRAP');
  await assert.rejects(() => w.unwrapWithPassphrase('pw', Object.assign({}, p, { v: 1 })), (e) => e.code === 'E_UNWRAP');
});

test('U-ID-7 escrow blobs: a forged or swapped blob fails AEAD', async () => {
  const prfA = new Uint8Array(randomBytes(32));
  const prfB = new Uint8Array(randomBytes(32));
  const sA = secrets();
  const blobA = await w.wrapWithPrf(prfA, sA, { credId: 'Y3JlZEE' });
  const blobB = await w.wrapWithPrf(prfB, secrets(), { credId: 'Y3JlZEI' });
  // Flipped ciphertext bit.
  const ct = b64url.decode(blobA.ct);
  ct[5] ^= 1;
  await assert.rejects(() => w.unwrapWithPrf(prfA, Object.assign({}, blobA, { ct: b64url.encode(ct) })), (e) => e.code === 'E_UNWRAP');
  // Flipped tag bit.
  const ct2 = b64url.decode(blobA.ct);
  ct2[ct2.length - 1] ^= 0x80;
  await assert.rejects(() => w.unwrapWithPrf(prfA, Object.assign({}, blobA, { ct: b64url.encode(ct2) })), (e) => e.code === 'E_UNWRAP');
  // Another person's blob handed back by a site: our PRF cannot open it.
  await assert.rejects(() => w.unwrapWithPrf(prfA, blobB), (e) => e.code === 'E_UNWRAP');
  // Swapped credId or IV in the header.
  await assert.rejects(() => w.unwrapWithPrf(prfA, Object.assign({}, blobA, { credId: blobB.credId })), (e) => e.code === 'E_UNWRAP');
  await assert.rejects(() => w.unwrapWithPrf(prfA, Object.assign({}, blobA, { iv: blobB.iv })), (e) => e.code === 'E_UNWRAP');
  // ct of B under A's header.
  await assert.rejects(() => w.unwrapWithPrf(prfA, Object.assign({}, blobA, { ct: blobB.ct })), (e) => e.code === 'E_UNWRAP');
  // A forged blob made from scratch.
  await assert.rejects(() => w.unwrapWithPrf(prfA, { v: 2, kind: 'prf', iv: b64url.encode(new Uint8Array(12)), ct: b64url.encode(new Uint8Array(80)) }), (e) => e.code === 'E_UNWRAP');
  assert.deepEqual(await w.unwrapWithPrf(prfA, blobA), sA, 'the genuine blob still opens');

  // The escrowed vault blob: swapped or forged vault blobs fail too.
  const { vault, kVault } = Vault.create();
  vault.label('o|https://shop.example');
  const vb = await vault.toBlob(kVault);
  const other = Vault.create();
  const ob = await other.vault.toBlob(other.kVault);
  await assert.rejects(() => Vault.open(kVault, ob), (e) => e.code === 'E_VAULT');
  await assert.rejects(() => Vault.open(kVault, Object.assign({}, vb, { id: 'x' })), (e) => e.code === 'E_VAULT');
  const vct = b64url.decode(vb.ct);
  vct[0] ^= 1;
  await assert.rejects(() => Vault.open(kVault, Object.assign({}, vb, { ct: b64url.encode(vct) })), (e) => e.code === 'E_VAULT');
  assert.ok((await Vault.open(kVault, vb)).label('o|https://shop.example', { create: false }));
});
