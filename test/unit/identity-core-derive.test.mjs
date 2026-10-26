// Identity core, derivation (R 2.2.1 to 2.2.3; tests U-ID-1, U-ID-2, U-ID-4):
// the BIP-39 English list against the published BIP-39 test vectors, test/vectors/identity.json in
// Node (identity-core-browser.test.mjs repeats it in Chromium and WebKit), the BigInt P-256 point
// multiply against node:crypto ECDH, the scalar reduction, non-extractable imports, and the label
// table with injected pointer and Public Suffix List fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createECDH, createHash, randomBytes } from 'node:crypto';

import { BIP39_ENGLISH, wordIndex } from '../../src/identity/bip39-english.js';
import { publicFromScalar, multiplyBase, isOnCurve, N, bytesToBigInt, bigIntToBytes } from '../../src/identity/p256.js';
import * as d from '../../src/identity/derive.js';
import { verify } from '../../src/chain/crypto.js';
import { hex, b64url, utf8 } from '../../src/chain/canonical.js';

const VECTORS = JSON.parse(readFileSync(new URL('../vectors/identity.json', import.meta.url), 'utf8'));
const byKind = (k) => VECTORS.vectors.filter((v) => v.kind === k);

// Published BIP-39 vectors (github.com/trezor/python-mnemonic vectors.json, English): entropy -> words.
const BIP39_VECTORS = [
  ['00000000000000000000000000000000', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'],
  ['7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f', 'legal winner thank year wave sausage worth useful legal winner thank yellow'],
  ['80808080808080808080808080808080', 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above'],
  ['ffffffffffffffffffffffffffffffff', 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'],
  ['000000000000000000000000000000000000000000000000', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon agent'],
  ['7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f', 'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal will'],
  ['808080808080808080808080808080808080808080808080', 'letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter always'],
  ['ffffffffffffffffffffffffffffffffffffffffffffffff', 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo when'],
  ['0000000000000000000000000000000000000000000000000000000000000000', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art'],
  ['7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f', 'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title'],
  ['8080808080808080808080808080808080808080808080808080808080808080', 'letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic bless'],
  ['ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote'],
  ['9e885d952ad362caeb4efe34a8e91bd2', 'ozone drill grab fiber curtain grace pudding thank cruise elder eight picnic'],
  ['c0ba5a8e914111210f2bd131f3d5e08d', 'scheme spot photo card baby mountain device kick cradle pact join borrow'],
  ['f30f8c1da665478f49b001d94c5fc452', 'vessel ladder alter error federal sibling chat ability sun glass valve picture'],
  ['77c2b00716cec7213839159e404db50d', 'jelly better achieve collect unaware mountain thought cargo oxygen act hood bridge'],
  ['0460ef47585604c5660618db2e6a7e7f', 'afford alter spike radar gate glance object seek swamp infant panel yellow'],
  ['18ab19a9f54a9274f03e5209a2ac8a91', 'board flee heavy tunnel powder denial science ski answer betray cargo cat'],
  ['eaebabb2383351fd31d703840b32e9e2', 'turtle front uncle idea crush write shrug there lottery flower risk shell'],
];

// Generic BIP-39 encoding for any entropy length (the module itself only does 16 bytes).
function mnemonic(entropyHex) {
  const e = Buffer.from(entropyHex, 'hex');
  const h = createHash('sha256').update(e).digest();
  const bits = [...e].map((b) => b.toString(2).padStart(8, '0')).join('') +
    [...h].map((b) => b.toString(2).padStart(8, '0')).join('').slice(0, (e.length * 8) / 32);
  const out = [];
  for (let i = 0; i < bits.length; i += 11) out.push(BIP39_ENGLISH[parseInt(bits.slice(i, i + 11), 2)]);
  return out.join(' ');
}

test('BIP-39 English list: 2048 unique sorted words, unique 4-letter prefixes, published vectors', () => {
  assert.equal(BIP39_ENGLISH.length, 2048);
  assert.equal(new Set(BIP39_ENGLISH).size, 2048);
  for (let i = 1; i < 2048; i++) assert.ok(BIP39_ENGLISH[i - 1] < BIP39_ENGLISH[i], 'sorted at ' + i);
  assert.equal(new Set(BIP39_ENGLISH.map((w) => w.slice(0, 4))).size, 2048, 'first four letters unique');
  for (const w of BIP39_ENGLISH) assert.match(w, /^[a-z]{3,8}$/);
  // The whole list: SHA-256 of bip-0039/english.txt (one word per line, LF, trailing newline).
  assert.equal(createHash('sha256').update(BIP39_ENGLISH.join('\n') + '\n').digest('hex'), '2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda');
  assert.equal(wordIndex('abandon'), 0);
  assert.equal(wordIndex('zoo'), 2047);
  assert.equal(wordIndex('magnetweb'), -1);
  for (const [entropy, words] of BIP39_VECTORS) assert.equal(mnemonic(entropy), words, entropy);
  // The four 16-byte vectors through the module API too.
  for (const [entropy, words] of BIP39_VECTORS.slice(0, 4)) {
    assert.equal(d.rootToPhrase(hex.decode(entropy)).join(' '), words);
    assert.equal(hex.encode(d.phraseToRoot(words)), entropy);
  }
});

test('U-ID-1 identity.json phrase vectors (round trip, errors, a mistyped phrase)', () => {
  for (const v of byKind('phrase')) {
    assert.equal(d.rootToPhrase(hex.decode(v.root)).join(' '), v.phrase, v.id);
    assert.equal(hex.encode(d.phraseToRoot(v.phrase)), v.root, v.id);
    assert.equal(hex.encode(d.phraseToRoot(v.phrase.split(' '))), v.root, v.id + ' as array');
    assert.equal(hex.encode(d.phraseToRoot('  ' + v.phrase.toUpperCase().replace(/ /g, '   ') + '\n')), v.root, v.id + ' spacing and case');
  }
  for (const v of byKind('phrase-error')) {
    assert.throws(() => d.phraseToRoot(v.phrase), (e) => e.code === v.expect.code, v.id);
  }
  assert.equal(byKind('phrase-error').length, 3);
});

test('U-ID-1 identity.json root*, check code, K_vaultHash (extra word through Argon2id 64 MiB)', async (t) => {
  for (const v of byKind('root-star')) {
    const started = Date.now();
    const rs = await d.rootStar(hex.decode(v.root), v.extra || undefined);
    if (v.extra) {
      t.diagnostic('root* with extra word (Argon2id m=65536 t=3 p=1, pure JS): ' + (Date.now() - started) + ' ms');
      assert.equal(hex.encode(d.extraSalt(hex.decode(v.root))), v.extraSalt);
    }
    assert.equal(hex.encode(rs), v.rootStar, v.id);
    assert.equal(await d.checkCode(rs), v.checkCode, v.id);
    assert.match(v.checkCode, /^[a-z2-7]{8}$/);
    assert.equal(hex.encode(await d.kVaultHash(rs)), v.kVaultHash, v.id);
  }
  const [mistyped] = byKind('phrase-mistyped');
  const wrong = d.phraseToRoot(mistyped.phrase);
  assert.equal(hex.encode(wrong), mistyped.root);
  assert.equal(await d.checkCode(await d.rootStar(wrong)), mistyped.checkCode);
  assert.notEqual(mistyped.checkCode, mistyped.intendedCheckCode, 'the check code catches the mistyped phrase');
});

test('U-ID-1 identity.json labels: seeds, sign keys i = 1 and 2, recover keys, K_name; signature', async () => {
  const labels = byKind('label');
  assert.equal(labels.length, 9);
  for (const kind of ['o|', 'l|', 'h|']) assert.equal(labels.filter((v) => v.label.startsWith(kind)).length, 3, kind);
  for (const v of labels) {
    const rs = hex.decode(v.rootStar);
    const seed = await d.labelSeed(rs, v.label);
    assert.equal(hex.encode(seed), v.seed, v.id);
    const s1 = await d.signScalar(seed, 1);
    const s2 = await d.signScalar(seed, 2);
    assert.equal(hex.encode(s1), v.signScalar1, v.id);
    assert.equal(hex.encode(s2), v.signScalar2, v.id);
    assert.equal(d.publicKeyOf(s1), v.pub1, v.id);
    assert.equal(d.publicKeyOf(s2), v.pub2, v.id);
    assert.equal(d.publicKeyOf(await d.recoverScalar(rs, v.label)), v.recoverPub, v.id);
    assert.equal(hex.encode(await d.kName(seed)), v.kName, v.id);
    const full = await d.deriveLabel(rs, v.label);
    assert.equal(full.pub, v.pub1);
    assert.equal(full.recoverPub, v.recoverPub);
  }
  const pubs = new Set(labels.flatMap((v) => [v.pub1, v.pub2, v.recoverPub]));
  assert.equal(pubs.size, 27, 'every derived key differs');
  const [sig] = byKind('signature');
  assert.equal(await verify(sig.pub, utf8.encode(sig.message), sig.sig), true);
  assert.equal(await verify(sig.pub, utf8.encode(sig.message + '!'), sig.sig), false);
  assert.equal(b64url.decode(sig.sig).length, 64, 'P1363 raw r||s');
});

test('p256.js public point equals node:crypto ECDH for random and edge scalars', () => {
  const scalars = [1n, 2n, 3n, N - 1n, N - 2n, (N - 1n) / 2n];
  for (let i = 0; i < 64; i++) scalars.push((bytesToBigInt(randomBytes(32)) % (N - 1n)) + 1n);
  for (const k of scalars) {
    const dBytes = bigIntToBytes(k, 32);
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(dBytes));
    assert.equal(Buffer.from(publicFromScalar(dBytes)).toString('hex'), ecdh.getPublicKey('hex', 'uncompressed'), k.toString(16));
    const [x, y] = multiplyBase(k);
    assert.ok(isOnCurve(x, y));
  }
  assert.throws(() => multiplyBase(0n), RangeError);
  assert.throws(() => multiplyBase(N), RangeError);
  assert.throws(() => publicFromScalar(new Uint8Array(31)), TypeError);
});

test('U-ID-2 scalar reduction is never 0 or n; imports are non-extractable and exportKey throws', async () => {
  const edge = [
    new Uint8Array(48),
    new Uint8Array(48).fill(0xff),
    bigIntToBytes(N - 1n, 48),
    bigIntToBytes(N - 2n, 48),
    bigIntToBytes(N, 48),
    bigIntToBytes(2n * (N - 1n), 48),
    bigIntToBytes(2n * (N - 1n) - 1n, 48),
  ];
  for (let i = 0; i < 200; i++) edge.push(new Uint8Array(randomBytes(48)));
  for (const x of edge) {
    const k = bytesToBigInt(d.scalar(x));
    assert.ok(k >= 1n && k <= N - 1n, 'in [1, n - 1]');
    assert.equal(k, (bytesToBigInt(x) % (N - 1n)) + 1n);
  }
  assert.equal(bytesToBigInt(d.scalar(new Uint8Array(48))), 1n, 'x = 0 gives 1');
  assert.equal(bytesToBigInt(d.scalar(bigIntToBytes(N - 1n, 48))), 1n, 'x = n - 1 wraps to 1');
  assert.equal(bytesToBigInt(d.scalar(bigIntToBytes(N - 2n, 48))), N - 1n, 'x = n - 2 gives n - 1, never n');
  assert.throws(() => d.scalar(new Uint8Array(32)), TypeError);

  const dScalar = d.scalar(new Uint8Array(randomBytes(48)));
  const jwk = d.scalarToJwk(dScalar);
  assert.deepEqual(Object.keys(jwk).sort(), ['crv', 'd', 'kty', 'x', 'y']);
  for (const usage of ['sign', 'ecdh']) {
    const key = await d.importScalar(dScalar, usage);
    assert.equal(key.extractable, false, usage);
    assert.equal(key.type, 'private');
    for (const format of ['jwk', 'pkcs8']) {
      await assert.rejects(() => crypto.subtle.exportKey(format, key), undefined, usage + ' ' + format);
    }
  }
  const signKey = await d.importScalar(dScalar, 'sign');
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signKey, utf8.encode('x')));
  assert.equal(await verify(d.publicKeyOf(dScalar), utf8.encode('x'), sig), true);
  await assert.rejects(() => d.signScalar(new Uint8Array(32), 0), RangeError);
});

test('U-ID-4 label table: identity.json label-choice vectors with fake pointer and PSL checks', async () => {
  const cases = byKind('label-choice');
  assert.ok(cases.length >= 15);
  for (const v of cases) {
    let calls = 0;
    const out = await d.labelFor(Object.assign({}, v.input, {
      verifyPointer: v.verifyResult ? async (text, origin) => {
        calls++;
        assert.equal(text, v.input.pointer);
        assert.equal(origin, v.input.origin);
        return v.verifyResult;
      } : undefined,
      isPublicSuffix: v.publicSuffix === null ? undefined : () => v.publicSuffix,
    }));
    assert.deepEqual(out, v.expect, v.id);
    if (v.verifyResult) assert.equal(calls, 1, v.id + ': verifyPointer called once');
  }
  const squat = cases.find((v) => v.id.includes('squat'));
  assert.equal(squat.expect.keyMode, 'pairwise', 'a squatting pointer of another owner gets the origin label');
  assert.equal(squat.expect.label, 'o|' + squat.input.origin);
});

test('U-ID-4 label table: refusals fall back to the origin label', async () => {
  const origin = 'https://shop.example';
  const good = { ok: true, ledgerId: 'mw1:abc', owner: 'p256:A', lo: null, host: 'shop.example', org: [] };
  assert.deepEqual(await d.labelFor({ origin, pointer: 'x' }), { label: 'o|' + origin, keyMode: 'pairwise', reason: 'no-verifier' });
  assert.equal((await d.labelFor({ origin, pointer: 'x', verifyPointer: async () => { throw new Error('boom'); } })).reason, 'unverified');
  assert.equal((await d.labelFor({ origin, pointer: 'x', verifyPointer: async () => Object.assign({}, good, { ledgerId: '' }) })).reason, 'unverified');
  assert.equal((await d.labelFor({ origin, pointer: 'x', verifyPointer: async () => good })).keyMode, 'ledger');
  // Port matters: the pointer host is shop.example, the origin has a port.
  assert.equal((await d.labelFor({ origin: 'https://shop.example:8443', pointer: 'x', verifyPointer: async () => good })).reason, 'not-listed');
  // Hub: the host must be exactly <32 base32>.<suffix>; deeper or shorter labels are not hub sites.
  const psl = () => true;
  assert.equal((await d.labelFor({ origin: 'https://x.abcdefghijklmnopqrstuvwxyz234567.hub.example', hubScope: { suffix: 'hub.example', optIn: true }, isPublicSuffix: psl })).keyMode, 'pairwise');
  assert.equal((await d.labelFor({ origin: 'https://short.hub.example', hubScope: { suffix: 'hub.example', optIn: true }, isPublicSuffix: psl })).keyMode, 'pairwise');
  // A link to the origin's own label is not a link; a link value that is not a label is ignored.
  assert.equal((await d.labelFor({ origin, links: { [origin]: 'o|' + origin } })).keyMode, 'pairwise');
  assert.equal((await d.labelFor({ origin, links: { [origin]: 'not a label' } })).keyMode, 'pairwise');
  assert.equal((await d.labelFor({ origin, links: new Map([[origin, 'o|https://forum.example']]) })).keyMode, 'linked');
  assert.equal((await d.labelFor({ origin, links: [{ origin, label: 'o|https://forum.example' }] })).keyMode, 'linked');
  // The origin is the browser's serialised origin; anything else is refused.
  for (const bad of ['https://shop.example/path', 'shop.example', 'ftp://shop.example', 'https://SHOP.example', 'https://user@shop.example']) {
    await assert.rejects(() => d.labelFor({ origin: bad }), TypeError, bad);
  }
});

test('derivation inputs are checked', async () => {
  const rs = new Uint8Array(32);
  await assert.rejects(() => d.labelSeed(rs, 'shop.example'), TypeError);
  await assert.rejects(() => d.labelSeed(new Uint8Array(16), 'o|https://a.example'), TypeError);
  await assert.rejects(() => d.rootStar(new Uint8Array(15)), TypeError);
  await assert.rejects(() => d.rootStar(new Uint8Array(16), 42), TypeError);
  assert.notDeepEqual(await d.rootStar(new Uint8Array(16), ''), await d.rootStar(new Uint8Array(16), 'x', { argon2: { m: 64, t: 1, p: 1 } }));
  assert.deepEqual(await d.rootStar(new Uint8Array(16), ''), await d.rootStar(new Uint8Array(16)), 'an empty extra word is no extra word');
  assert.equal(d.newRoot().length, 16);
});
