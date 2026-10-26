// Unit tests for src/chain/crypto.js (ECDSA P-256 / SHA-256 over globalThis.crypto.subtle).
// node:crypto is used only as an independent oracle (hashes, IEEE P1363 signature layout).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { KeyObject, createHash, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import { hex, b64url, utf8, concatBytes } from '../../src/chain/canonical.js';
import {
  sha256, generateKeyPair, exportPublicKey, importPublicKey, sign, verify,
  exportPrivateJwk, importPrivateJwk, publicFromPrivateJwk, fingerprint,
  isPublicKeyString, publicKeyBytes, RAW_PUBLIC_KEY_BYTES, SIGNATURE_BYTES, PUBLIC_KEY_B64URL_LENGTH,
  PUBLIC_KEY_STRING_LENGTH, P256_PREFIX, KEY_ALGORITHMS, keyAlgorithm, encodePublicKey, fromUntaggedP256, shortKey,
} from '../../src/chain/crypto.js';

const DATA = utf8.encode('felinar chain block');
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

function flipBit(u8, index) {
  const copy = new Uint8Array(u8);
  copy[index] ^= 0x01;
  return copy;
}

test('sha256: known vectors, string and byte inputs, matches node:crypto', async () => {
  const empty = await sha256(new Uint8Array(0));
  assert.ok(empty instanceof Uint8Array);
  assert.equal(empty.length, 32);
  assert.equal(hex.encode(empty), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(hex.encode(await sha256(utf8.encode('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(hex.encode(await sha256('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(hex.encode(await sha256('')), hex.encode(empty));
  for (let i = 0; i < 20; i++) {
    const bytes = new Uint8Array(i * 37);
    for (let j = 0; j < bytes.length; j++) bytes[j] = (j * 31 + i) & 0xff;
    assert.equal(hex.encode(await sha256(bytes)), createHash('sha256').update(bytes).digest('hex'));
    assert.equal(hex.encode(await sha256(bytes.buffer)), createHash('sha256').update(bytes).digest('hex'));
  }
  // Views with an offset hash only their window.
  const window = new Uint8Array([9, 9, 0x61, 0x62, 0x63, 9]).subarray(2, 5);
  assert.equal(hex.encode(await sha256(window)), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  await assert.rejects(sha256(123), TypeError);
  await assert.rejects(sha256(null), TypeError);
});

test('generateKeyPair: P-256 ECDSA, non-extractable by default, exportable public half', async () => {
  const { publicKey, privateKey } = await generateKeyPair();
  assert.equal(privateKey.type, 'private');
  assert.equal(publicKey.type, 'public');
  assert.equal(privateKey.extractable, false);
  assert.equal(publicKey.extractable, true);
  assert.equal(privateKey.algorithm.name, 'ECDSA');
  assert.equal(privateKey.algorithm.namedCurve, 'P-256');
  assert.deepEqual([...privateKey.usages], ['sign']);
  assert.deepEqual([...publicKey.usages], ['verify']);

  const pub = await exportPublicKey(publicKey);
  assert.equal(typeof pub, 'string');
  // v0.2.1 (DIGEST-AMENDMENTS A2): keys are algorithm-tagged, 'p256:' + 87 base64url characters.
  assert.equal(pub.length, PUBLIC_KEY_STRING_LENGTH);
  assert.ok(pub.startsWith(P256_PREFIX));
  assert.equal(pub.length - P256_PREFIX.length, PUBLIC_KEY_B64URL_LENGTH);
  assert.match(pub.slice(P256_PREFIX.length), B64URL_RE);
  const raw = publicKeyBytes(pub);
  assert.equal(raw.length, RAW_PUBLIC_KEY_BYTES);
  assert.equal(raw[0], 0x04);
  assert.equal(isPublicKeyString(pub), true);

  const ext = await generateKeyPair({ extractable: true });
  assert.equal(ext.privateKey.extractable, true);
  assert.notEqual(await exportPublicKey(ext.publicKey), pub);
  await assert.rejects(exportPublicKey(privateKey), TypeError);
  await assert.rejects(exportPublicKey({ publicKey, privateKey }), TypeError);
  await assert.rejects(exportPublicKey('not a key'), TypeError);
});

test('sign/verify round trip with a non-extractable key; every input form accepted', async () => {
  const { publicKey, privateKey } = await generateKeyPair();
  const pub = await exportPublicKey(publicKey);
  const sig = await sign(privateKey, DATA);
  assert.ok(sig instanceof Uint8Array);
  assert.equal(sig.length, SIGNATURE_BYTES);

  assert.equal(await verify(pub, DATA, sig), true);
  assert.equal(await verify(pub, DATA, b64url.encode(sig)), true);
  assert.equal(await verify(pub, DATA.buffer, sig), true);
  assert.equal(await verify(pub, 'felinar chain block', sig), true);
  assert.equal(await verify(pub, Buffer.from(DATA), Buffer.from(sig)), true);
  assert.equal(await verify(publicKey, DATA, sig), true);
  assert.equal(await verify(await importPublicKey(pub), DATA, sig), true);
  // Strings sign as their UTF-8 bytes.
  const sig2 = await sign(privateKey, 'felinar chain block');
  assert.equal(await verify(pub, DATA, sig2), true);
  // Many verifications in parallel share the cached key import.
  const results = await Promise.all(Array.from({ length: 50 }, () => verify(pub, DATA, sig)));
  assert.ok(results.every((v) => v === true));
  // Empty message is fine.
  const sigEmpty = await sign(privateKey, new Uint8Array(0));
  assert.equal(await verify(pub, new Uint8Array(0), sigEmpty), true);
  assert.equal(await verify(pub, '', sigEmpty), true);
});

test('verify returns false (never throws) for tampered or malformed input', async () => {
  const a = await generateKeyPair();
  const b = await generateKeyPair();
  const pubA = await exportPublicKey(a.publicKey);
  const pubB = await exportPublicKey(b.publicKey);
  const sig = await sign(a.privateKey, DATA);
  const sixtyFour = b64url.encode(new Uint8Array(64));
  const wrongPrefix = b64url.encode(concatBytes(new Uint8Array([0x02]), publicKeyBytes(pubA).subarray(1)));
  const offCurve = b64url.encode(concatBytes(new Uint8Array([0x04]), new Uint8Array(64)));
  const cases = [
    ['tampered data', [pubA, flipBit(DATA, 0), sig]],
    ['tampered data (string)', [pubA, 'felinar chain blocK', sig]],
    ['tampered signature r', [pubA, DATA, flipBit(sig, 0)]],
    ['tampered signature s', [pubA, DATA, flipBit(sig, 63)]],
    ['tampered b64url signature', [pubA, DATA, b64url.encode(flipBit(sig, 10))]],
    ['truncated signature', [pubA, DATA, sig.subarray(0, 63)]],
    ['extended signature', [pubA, DATA, concatBytes(sig, new Uint8Array([0]))]],
    ['empty signature', [pubA, DATA, new Uint8Array(0)]],
    ['zero signature', [pubA, DATA, new Uint8Array(64)]],
    ['wrong key', [pubB, DATA, sig]],
    ['wrong CryptoKey', [b.publicKey, DATA, sig]],
    ['private CryptoKey as pub', [a.privateKey, DATA, sig]],
    ['empty pub', ['', DATA, sig]],
    ['garbage pub', ['not-base64!', DATA, sig]],
    ['64-byte pub', [sixtyFour, DATA, sig]],
    ['compressed prefix pub', [wrongPrefix, DATA, sig]],
    ['off-curve pub', [offCurve, DATA, sig]],
    ['null pub', [null, DATA, sig]],
    ['undefined pub', [undefined, DATA, sig]],
    ['number pub', [42, DATA, sig]],
    ['object pub', [{ pub: pubA }, DATA, sig]],
    ['null data', [pubA, null, sig]],
    ['number data', [pubA, 7, sig]],
    ['array data', [pubA, [1, 2], sig]],
    ['null sig', [pubA, DATA, null]],
    ['number sig', [pubA, DATA, 1]],
    ['object sig', [pubA, DATA, { sig }]],
    ['non-b64url sig string', [pubA, DATA, 'Zm9v+']],
    ['hex sig string', [pubA, DATA, hex.encode(sig)]],
    ['no args', []],
  ];
  for (const [label, args] of cases) {
    let result;
    try {
      result = await verify(...args);
    } catch (err) {
      assert.fail('verify threw for ' + label + ': ' + err);
    }
    assert.equal(result, false, label);
  }
  // The genuine triple still verifies after all that.
  assert.equal(await verify(pubA, DATA, sig), true);
});

test('signatures are IEEE P1363 r||s and interoperate with node:crypto both ways', async () => {
  const { publicKey, privateKey } = await generateKeyPair({ extractable: true });
  const pub = await exportPublicKey(publicKey);
  const sig = await sign(privateKey, DATA);
  const nodePub = KeyObject.from(await importPublicKey(pub));
  assert.equal(nodeVerify('sha256', DATA, { key: nodePub, dsaEncoding: 'ieee-p1363' }, sig), true);
  assert.equal(nodeVerify('sha256', flipBit(DATA, 3), { key: nodePub, dsaEncoding: 'ieee-p1363' }, sig), false);
  const nodeSig = nodeSign('sha256', DATA, { key: KeyObject.from(privateKey), dsaEncoding: 'ieee-p1363' });
  assert.equal(nodeSig.length, 64);
  assert.equal(await verify(pub, DATA, new Uint8Array(nodeSig)), true);
  // The raw export is the uncompressed SEC1 point node:crypto also produces.
  const nodeRaw = nodePub.export({ format: 'jwk' });
  assert.deepEqual(publicKeyBytes(pub), concatBytes(new Uint8Array([4]), b64url.decode(nodeRaw.x), b64url.decode(nodeRaw.y)));
});

test('private JWK export/import round trip and public key derivation', async () => {
  const { publicKey, privateKey } = await generateKeyPair({ extractable: true });
  const pub = await exportPublicKey(publicKey);
  const jwk = await exportPrivateJwk(privateKey);
  assert.deepEqual(Object.keys(jwk).sort(), ['crv', 'd', 'kty', 'x', 'y']);
  assert.equal(jwk.kty, 'EC');
  assert.equal(jwk.crv, 'P-256');
  for (const field of ['x', 'y', 'd']) {
    assert.match(jwk[field], B64URL_RE);
    assert.equal(b64url.decode(jwk[field]).length, 32, field);
  }
  assert.deepEqual(publicKeyBytes(pub), concatBytes(new Uint8Array([4]), b64url.decode(jwk.x), b64url.decode(jwk.y)));
  assert.equal(await publicFromPrivateJwk(jwk), pub);
  assert.equal(await publicFromPrivateJwk({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }), pub);
  assert.equal(await publicFromPrivateJwk(JSON.parse(JSON.stringify(jwk))), pub);

  const imported = await importPrivateJwk(JSON.parse(JSON.stringify(jwk)));
  assert.equal(imported.type, 'private');
  assert.equal(imported.extractable, false);
  assert.deepEqual([...imported.usages], ['sign']);
  const sig = await sign(imported, DATA);
  assert.equal(await verify(pub, DATA, sig), true);
  assert.equal(await verify(pub, DATA, await sign(privateKey, DATA)), true);
  await assert.rejects(exportPrivateJwk(imported));

  const reExtractable = await importPrivateJwk(jwk, { extractable: true });
  assert.equal(reExtractable.extractable, true);
  assert.deepEqual(await exportPrivateJwk(reExtractable), jwk);
  // Extra JWK members (ext, key_ops, alg, kid) are ignored rather than fatal.
  const noisy = { ...jwk, ext: false, key_ops: ['verify'], alg: 'ES256', kid: 'owner' };
  assert.equal(await verify(pub, DATA, await sign(await importPrivateJwk(noisy), DATA)), true);
  assert.equal(await publicFromPrivateJwk(noisy), pub);
});

test('JWK helpers reject keys they cannot use', async () => {
  const nonExtractable = await generateKeyPair();
  await assert.rejects(exportPrivateJwk(nonExtractable.privateKey));
  await assert.rejects(exportPrivateJwk(nonExtractable.publicKey), TypeError);
  await assert.rejects(exportPrivateJwk(null), TypeError);
  const { privateKey } = await generateKeyPair({ extractable: true });
  const jwk = await exportPrivateJwk(privateKey);
  const { d, ...publicOnly } = jwk;
  await assert.rejects(importPrivateJwk(publicOnly), TypeError);
  await assert.rejects(importPrivateJwk({ ...jwk, d: undefined }), TypeError);
  await assert.rejects(importPrivateJwk({ ...jwk, kty: 'RSA' }), TypeError);
  await assert.rejects(importPrivateJwk({ ...jwk, crv: 'P-384' }), TypeError);
  await assert.rejects(importPrivateJwk({ ...jwk, x: 42 }), TypeError);
  await assert.rejects(importPrivateJwk(null), TypeError);
  await assert.rejects(importPrivateJwk('jwk'), TypeError);
  await assert.rejects(importPrivateJwk({ ...jwk, d: jwk.x })); // d does not match (x, y)
  await assert.rejects(publicFromPrivateJwk({ kty: 'EC', crv: 'P-256', x: 'AA', y: 'AA' }));
  await assert.rejects(publicFromPrivateJwk({ kty: 'EC', crv: 'P-256', x: b64url.encode(new Uint8Array(32)), y: b64url.encode(new Uint8Array(32)) }));
  await assert.rejects(publicFromPrivateJwk({ kty: 'oct', k: 'AA' }), TypeError);
  await assert.rejects(publicFromPrivateJwk(undefined), TypeError);
});

test('fingerprint: first 8 hex of sha256(raw public key), stable, accepts CryptoKey', async () => {
  const pairs = await Promise.all([generateKeyPair(), generateKeyPair(), generateKeyPair()]);
  const prints = [];
  for (const { publicKey } of pairs) {
    const pub = await exportPublicKey(publicKey);
    const fp = await fingerprint(pub);
    assert.match(fp, /^[0-9a-f]{8}$/);
    assert.equal(fp, createHash('sha256').update(publicKeyBytes(pub)).digest('hex').slice(0, 8));
    assert.equal(await fingerprint(pub), fp);
    assert.equal(await fingerprint(publicKey), fp);
    prints.push(fp);
  }
  assert.equal(new Set(prints).size, 3);
  await assert.rejects(fingerprint('garbage'), TypeError);
  await assert.rejects(fingerprint(b64url.encode(new Uint8Array(64))), TypeError);
  await assert.rejects(fingerprint(pairs[0].privateKey), TypeError);
  await assert.rejects(fingerprint(undefined), TypeError);
});

test('importPublicKey: validation, off-curve rejection, cached imports', async () => {
  const { publicKey } = await generateKeyPair();
  const pub = await exportPublicKey(publicKey);
  const k1 = await importPublicKey(pub);
  const k2 = await importPublicKey(pub);
  assert.equal(k1.type, 'public');
  assert.equal(k1, k2);
  await assert.rejects(importPublicKey(P256_PREFIX + b64url.encode(new Uint8Array(64))), TypeError);
  await assert.rejects(importPublicKey(P256_PREFIX + b64url.encode(new Uint8Array(66))), TypeError);
  await assert.rejects(importPublicKey(P256_PREFIX + b64url.encode(concatBytes(new Uint8Array([0x03]), publicKeyBytes(pub).subarray(1)))), TypeError);
  await assert.rejects(importPublicKey(pub.slice(0, -1) + '!'), TypeError);
  await assert.rejects(importPublicKey(''), TypeError);
  await assert.rejects(importPublicKey(publicKeyBytes(pub)), TypeError);
  await assert.rejects(importPublicKey(null), TypeError);
  // Untagged v0.2 keys and unknown algorithms are refused (A2).
  await assert.rejects(importPublicKey(pub.slice(P256_PREFIX.length)), /algorithm-tagged/);
  await assert.rejects(importPublicKey('ed25519:' + pub.slice(P256_PREFIX.length)), /unsupported key type: ed25519/);
  const offCurve = P256_PREFIX + b64url.encode(concatBytes(new Uint8Array([0x04]), new Uint8Array(64)));
  assert.equal(isPublicKeyString(offCurve), true); // shape only
  await assert.rejects(importPublicKey(offCurve));
  await assert.rejects(importPublicKey(offCurve)); // a failed import is not cached
  assert.equal(await verify(offCurve, DATA, new Uint8Array(64)), false);
});

test('isPublicKeyString / publicKeyBytes are synchronous shape checks', async () => {
  const { publicKey } = await generateKeyPair();
  const pub = await exportPublicKey(publicKey);
  assert.equal(isPublicKeyString(pub), true);
  assert.equal(isPublicKeyString('p256:B' + 'A'.repeat(86)), true); // 0x04 prefix, 65 bytes, not on the curve
  const body = pub.slice(P256_PREFIX.length);
  for (const bad of ['', pub.slice(1), pub + 'A', pub.slice(0, -1) + '=', 'A'.repeat(87), 'p256:' + 'A'.repeat(87),
    P256_PREFIX + body.replace(/[A-Za-z]/, '+'), body, 'B' + 'A'.repeat(86), 'P256:' + body, 'ed25519:' + body, 'p256:' + body + '=',
    'p256 :' + body, ' p256:' + body, 42, null, undefined, publicKeyBytes(pub)]) {
    assert.equal(isPublicKeyString(bad), false, String(bad));
  }
  assert.throws(() => publicKeyBytes('A'.repeat(87)), TypeError);
  assert.throws(() => publicKeyBytes(body), /algorithm-tagged/);
  assert.throws(() => publicKeyBytes('ed25519:' + body), /unsupported key type: ed25519/);
  assert.throws(() => publicKeyBytes(pub.slice(1)), TypeError);
  assert.throws(() => publicKeyBytes(42), TypeError);
  assert.equal(publicKeyBytes(pub).length, 65);
});

test('sign rejects wrong key types and non-binary data', async () => {
  const { publicKey, privateKey } = await generateKeyPair();
  await assert.rejects(sign(publicKey, DATA), TypeError);
  await assert.rejects(sign(null, DATA), TypeError);
  await assert.rejects(sign('secret', DATA), TypeError);
  await assert.rejects(sign(privateKey, 123), TypeError);
  await assert.rejects(sign(privateKey, null), TypeError);
  await assert.rejects(sign(privateKey, { data: DATA }), TypeError);
});

test('algorithm-tagged key strings (v0.2.1 A2): tag helpers, one spelling per key, untagged never accepted', async () => {
  const { publicKey, privateKey } = await generateKeyPair();
  const pub = await exportPublicKey(publicKey);
  const body = pub.slice(P256_PREFIX.length);
  assert.deepEqual([...KEY_ALGORITHMS], ['p256']);
  assert.equal(keyAlgorithm(pub), 'p256');
  assert.equal(keyAlgorithm('ed25519:abc'), 'ed25519');
  assert.equal(keyAlgorithm(body), null);
  assert.equal(keyAlgorithm(42), null);
  assert.equal(encodePublicKey(publicKeyBytes(pub)), pub);
  assert.throws(() => encodePublicKey(new Uint8Array(65)), TypeError); // no 0x04 prefix
  assert.throws(() => encodePublicKey(new Uint8Array(64)), TypeError);
  // fromUntaggedP256 exists for v0.2 fixtures and locally stored identities only.
  assert.equal(fromUntaggedP256(body), pub);
  assert.equal(fromUntaggedP256(pub), pub);
  assert.throws(() => fromUntaggedP256('A'.repeat(87)), TypeError);
  assert.throws(() => fromUntaggedP256('ed25519:' + body), /unsupported key type/);
  assert.equal(shortKey(pub), body.slice(0, 8));
  assert.equal(shortKey(body), body.slice(0, 8));
  assert.equal(shortKey(null), '');
  // The JWK route gives the tagged string too.
  const ext = await generateKeyPair({ extractable: true });
  const jwk = await exportPrivateJwk(ext.privateKey);
  const tagged = await publicFromPrivateJwk(jwk);
  assert.ok(tagged.startsWith(P256_PREFIX));
  assert.equal(tagged, await exportPublicKey(ext.publicKey));
  // A valid signature does not verify under the untagged or a re-tagged spelling of the same key.
  const sig = await sign(privateKey, DATA);
  assert.equal(await verify(pub, DATA, sig), true);
  assert.equal(await verify(body, DATA, sig), false);
  assert.equal(await verify('ed25519:' + body, DATA, sig), false);
  assert.equal(await verify('P256:' + body, DATA, sig), false);
  // One spelling per key: non-canonical trailing bits are refused (a ban could otherwise be dodged).
  const last = body[body.length - 1];
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const sibling = alphabet[(alphabet.indexOf(last) & ~3) | ((alphabet.indexOf(last) + 1) & 3)];
  assert.notEqual(sibling, last);
  assert.equal(isPublicKeyString(P256_PREFIX + body.slice(0, -1) + sibling), false);
  assert.equal(await verify(P256_PREFIX + body.slice(0, -1) + sibling, DATA, sig), false);
  // The fingerprint hashes the raw point, not the tag.
  assert.equal(await fingerprint(pub), createHash('sha256').update(publicKeyBytes(pub)).digest('hex').slice(0, 8));
});
