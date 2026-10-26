// Unit tests for src/pin/frames.js (mw_pin1, SEEDING-AND-ZERO-SETUP-DESIGN 3.1.6): frame round trips, signatures, the 5-minute
// skew window, the 1,024-byte cap, isPinSignable refusals, and the golden vectors in test/vectors/pin.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXT_NAME, FRAME_MAX_BYTES, NONCE_BYTES, SKEW_MS, HELLO_PREFIX, RECEIPT_PREFIX, SIGNABLE_MAX_BYTES, FRAME_TYPES,
  helloBytes, receiptBytes, parseSignable, isPinSignable, checkFrame, encodeFrame, decodeFrame, makeChallenge, makeHello, makeReceipt,
  verifyHello, verifyReceipt, PIN_REQUEST_PREFIX, pinRequestBytes, makePinRequest, verifyPinRequest,
} from '../../src/pin/frames.js';
import { generateKeyPair, exportPublicKey, importPrivateJwk, publicFromPrivateJwk, sign as ecdsaSign } from '../../src/chain/crypto.js';
import { b64url, utf8 } from '../../src/chain/canonical.js';

const VECTORS = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'vectors', 'pin.json'), 'utf8')).vectors;
const vec = (id) => {
  const v = VECTORS.find((x) => x.id === id);
  assert.ok(v, 'vector ' + id);
  return v;
};

const IH = 'ab'.repeat(20);
const IH2 = 'cd'.repeat(20);
const AT = Date.UTC(2026, 9, 20, 12, 0, 0);
const N = b64url.encode(Uint8Array.from({ length: 16 }, (_, i) => 255 - i));

async function keys() {
  const { privateKey, publicKey } = await generateKeyPair();
  return { privateKey, pub: await exportPublicKey(publicKey) };
}

test('constants: the extension name, the frame cap, the 16-byte nonce, the 5-minute window and the two prefixes of SZ 3.1.6', () => {
  assert.equal(EXT_NAME, 'mw_pin1');
  assert.equal(FRAME_MAX_BYTES, 1024);
  assert.equal(NONCE_BYTES, 16);
  assert.equal(SKEW_MS, 300000);
  assert.equal(HELLO_PREFIX, 'mw-pin1-hello\n');
  assert.equal(RECEIPT_PREFIX, 'mw-pin1-receipt\n');
  assert.deepEqual(FRAME_TYPES, ['chal', 'hello', 'rcpt']);
  assert.ok(utf8.encode(HELLO_PREFIX + IH + '\n' + N + '\n' + Number.MAX_SAFE_INTEGER).length <= SIGNABLE_MAX_BYTES);
});

test('the signed byte strings are exactly prefix, infohash, nonce or total, and time, separated by newlines', () => {
  assert.equal(utf8.decode(helloBytes(IH, N, AT)), 'mw-pin1-hello\n' + IH + '\n' + N + '\n' + AT);
  assert.equal(utf8.decode(receiptBytes(IH, 5242880, AT)), 'mw-pin1-receipt\n' + IH + '\n5242880\n' + AT);
  assert.throws(() => helloBytes(IH.toUpperCase(), N, AT), TypeError, 'one spelling of an infohash');
  assert.throws(() => helloBytes(IH, 'AAAA', AT), TypeError, 'a nonce is 16 bytes');
  assert.throws(() => helloBytes(IH, N, -1), TypeError);
  assert.throws(() => helloBytes(IH, N, 1.5), TypeError);
  assert.throws(() => receiptBytes(IH, 0, AT), TypeError, 'a receipt is for at least one byte');
  assert.throws(() => receiptBytes(IH, 2 ** 53, AT), TypeError);
});

test('challenge, hello and receipt round trip through encodeFrame and decodeFrame, fields in a fixed order', async () => {
  const k = await keys();
  const chal = makeChallenge({ random: (n) => new Uint8Array(n).fill(7) });
  assert.deepEqual(chal, { t: 'chal', n: b64url.encode(new Uint8Array(16).fill(7)) });
  assert.equal(makeChallenge().n.length, 22, 'WebCrypto randomness by default');
  assert.notEqual(makeChallenge().n, makeChallenge().n);
  const hello = await makeHello({ key: k.pub, ih: IH, n: chal.n, at: AT }, k.privateKey);
  const rcpt = await makeReceipt({ key: k.pub, ih: IH2, total: 1234, at: AT }, k.privateKey);
  for (const f of [chal, hello, rcpt]) {
    const bytes = encodeFrame(f);
    assert.ok(bytes.length <= FRAME_MAX_BYTES);
    const d = decodeFrame(bytes);
    assert.equal(d.ok, true, f.t);
    assert.deepEqual(d.frame, f);
    assert.deepEqual(decodeFrame(utf8.decode(bytes)).frame, f, 'a string decodes too');
  }
  assert.deepEqual(Object.keys(JSON.parse(utf8.decode(encodeFrame(Object.assign({ sig: hello.sig }, hello))))), ['t', 'key', 'ih', 'n', 'at', 'sig']);
  // a signer function that returns bytes or base64url works as well as a key (a pinned page signs through 'pin.sign')
  const viaFn = await makeHello({ key: k.pub, ih: IH, n: chal.n, at: AT }, (bytes) => ecdsaSign(k.privateKey, bytes));
  const viaB64 = await makeHello({ key: k.pub, ih: IH, n: chal.n, at: AT }, async (bytes) => b64url.encode(await ecdsaSign(k.privateKey, bytes)));
  for (const f of [viaFn, viaB64]) assert.equal((await verifyHello(f, { expectKey: k.pub, ih: IH, n: chal.n, now: AT })).ok, true);
  await assert.rejects(makeHello({ key: k.pub, ih: IH, n: chal.n, at: AT }, async () => new Uint8Array(10)), TypeError);
  await assert.rejects(makeHello({ key: k.pub, ih: IH, n: chal.n, at: AT }, 'not a signer'), TypeError);
  await assert.rejects(makeHello({ key: 'p256:short', ih: IH, n: chal.n, at: AT }, k.privateKey), TypeError);
});

test('decodeFrame refuses what is too large, not JSON, an unknown type, extra fields and bad fields, and never throws', async () => {
  const k = await keys();
  const hello = await makeHello({ key: k.pub, ih: IH, n: N, at: AT }, k.privateKey);
  const big = JSON.stringify(Object.assign({}, hello, { pad: 'x'.repeat(FRAME_MAX_BYTES) }));
  assert.equal(decodeFrame(utf8.encode(big)).reason, 'too-large');
  assert.equal(decodeFrame(big).reason, 'too-large');
  const cases = [
    [new Uint8Array([0xff, 0xfe]), 'malformed'],
    ['not json', 'malformed'],
    ['[1,2]', 'malformed'],
    ['null', 'malformed'],
    ['{"t":"ping"}', 'unknown-type'],
    ['{"n":"' + N + '"}', 'unknown-type'],
    [JSON.stringify({ t: 'chal', n: N, extra: 1 }), 'extra-field'],
    ['{"t":"chal","n":"' + N + '","__proto__":{"x":1}}', 'extra-field'],
    [JSON.stringify({ t: 'chal', n: 'AAAA' }), 'bad-n'],
    [JSON.stringify({ t: 'chal', n: N.slice(0, 21) + 'B' }), 'bad-n'], // non-canonical trailing bits
    [JSON.stringify(Object.assign({}, hello, { key: 'p256:x' })), 'bad-key'],
    [JSON.stringify(Object.assign({}, hello, { ih: IH.toUpperCase() })), 'bad-ih'],
    [JSON.stringify(Object.assign({}, hello, { at: -5 })), 'bad-at'],
    [JSON.stringify(Object.assign({}, hello, { at: '12' })), 'bad-at'],
    [JSON.stringify(Object.assign({}, hello, { sig: hello.sig.slice(2) })), 'bad-sig'],
    [JSON.stringify({ t: 'rcpt', key: k.pub, ih: IH, total: 0, at: AT, sig: hello.sig }), 'bad-total'],
    [JSON.stringify({ t: 'rcpt', key: k.pub, ih: IH, n: N, total: 1, at: AT, sig: hello.sig }), 'extra-field'],
  ];
  for (const [input, reason] of cases) {
    const d = decodeFrame(typeof input === 'string' ? utf8.encode(input) : input);
    assert.equal(d.ok, false, String(input));
    assert.equal(d.reason, reason, String(input));
  }
  assert.equal(decodeFrame(42).reason, 'malformed');
  assert.equal(decodeFrame(undefined).reason, 'malformed');
  assert.throws(() => encodeFrame({ t: 'chal', n: 'short' }), TypeError);
  assert.equal(checkFrame(hello).ok, true);
  assert.equal(checkFrame(Object.create(hello)).reason, 'malformed', 'only plain objects');
});

test('verifyHello: the expected key, this wire\'s infohash, the challenge sent, the 5-minute window, a valid signature', async () => {
  const k = await keys();
  const other = await keys();
  const hello = await makeHello({ key: k.pub, ih: IH, n: N, at: AT }, k.privateKey);
  const ok = (o) => verifyHello(hello, Object.assign({ expectKey: k.pub, ih: IH, n: N, now: AT }, o));
  assert.deepEqual(await ok({}), { ok: true, reason: null });
  assert.equal((await ok({ now: AT + SKEW_MS })).ok, true, 'exactly 5 minutes later');
  assert.equal((await ok({ now: AT - SKEW_MS })).ok, true, 'exactly 5 minutes earlier');
  assert.equal((await ok({ now: AT + SKEW_MS + 1 })).reason, 'skew');
  assert.equal((await ok({ now: AT - SKEW_MS - 1 })).reason, 'skew');
  assert.equal((await ok({ now: AT + 60000, skewMs: 1000 })).reason, 'skew', 'a narrower window');
  assert.equal((await ok({ now: NaN })).reason, 'skew');
  assert.equal((await ok({ expectKey: other.pub })).reason, 'other-key');
  assert.equal((await ok({ expectKey: undefined })).reason, 'no-expected-key', 'no key named: nothing is trusted');
  assert.equal((await ok({ ih: IH2 })).reason, 'other-ih');
  assert.equal((await ok({ n: makeChallenge().n })).reason, 'other-n', 'an answer to another challenge (a replay)');
  const rcpt = await makeReceipt({ key: k.pub, ih: IH, total: 10, at: AT }, k.privateKey);
  assert.equal((await verifyHello(rcpt, { expectKey: k.pub, ih: IH, n: N, now: AT })).reason, 'wrong-type');
  const forged = await makeHello({ key: k.pub, ih: IH, n: N, at: AT }, other.privateKey);
  assert.equal((await verifyHello(forged, { expectKey: k.pub, ih: IH, n: N, now: AT })).reason, 'signature');
  const tampered = Object.assign({}, hello, { at: AT + 1 });
  assert.equal((await verifyHello(tampered, { expectKey: k.pub, ih: IH, n: N, now: AT })).reason, 'signature');
  assert.equal((await verifyHello('nonsense', { expectKey: k.pub, ih: IH, n: N, now: AT })).reason, 'malformed');
});

test('verifyReceipt: the expected key and infohash, the window, the length when the verifier knows it, a valid signature', async () => {
  const k = await keys();
  const other = await keys();
  const rcpt = await makeReceipt({ key: k.pub, ih: IH2, total: 5242880, at: AT }, k.privateKey);
  const v = (o) => verifyReceipt(rcpt, Object.assign({ expectKey: k.pub, ih: IH2, now: AT + 1000 }, o));
  assert.deepEqual(await v({}), { ok: true, reason: null });
  assert.equal((await v({ total: 5242880 })).ok, true);
  assert.equal((await v({ total: 5242881 })).reason, 'other-total');
  assert.equal((await v({ ih: IH })).reason, 'other-ih');
  assert.equal((await v({ expectKey: other.pub })).reason, 'other-key');
  assert.equal((await v({ now: AT + SKEW_MS + 1 })).reason, 'skew');
  const hello = await makeHello({ key: k.pub, ih: IH2, n: N, at: AT }, k.privateKey);
  assert.equal((await verifyReceipt(hello, { expectKey: k.pub, ih: IH2, now: AT })).reason, 'wrong-type');
  // a hello signature does not make a receipt: the prefixes keep the two purposes apart
  const swapped = { t: 'rcpt', key: k.pub, ih: IH2, total: 5242880, at: AT, sig: hello.sig };
  assert.equal((await verifyReceipt(swapped, { expectKey: k.pub, ih: IH2, now: AT })).reason, 'signature');
});

test('isPinSignable: only exactly one hello or one receipt string, in one spelling; parseSignable returns its fields', async () => {
  assert.deepEqual(parseSignable(helloBytes(IH, N, AT)), { kind: 'hello', ih: IH, n: N, at: AT });
  assert.deepEqual(parseSignable(receiptBytes(IH, 77, 0)), { kind: 'receipt', ih: IH, total: 77, at: 0 });
  assert.equal(isPinSignable(helloBytes(IH, N, Number.MAX_SAFE_INTEGER)), true);
  const refused = [
    'mw-block-v1\n' + IH,
    'mw-pointer-v1\nv=mw1',
    'mw-pin-status-v1\n{}',
    'mw-signin-v1\n{}',
    '',
    'mw-pin1-hello\n' + IH + '\n' + N + '\n' + AT + '\n',
    'mw-pin1-hello\n' + IH + '\n' + N + '\n' + AT + 'x',
    'mw-pin1-hello\r\n' + IH + '\n' + N + '\n' + AT,
    'mw-pin1-hello\n' + IH.toUpperCase() + '\n' + N + '\n' + AT,
    'mw-pin1-hello\n' + IH.slice(1) + '\n' + N + '\n' + AT,
    'mw-pin1-hello\n' + IH + '\n' + N + '=\n' + AT,
    'mw-pin1-hello\n' + IH + '\n' + N.slice(0, 21) + 'B\n' + AT,
    'mw-pin1-hello\n' + IH + '\n' + N + '\n00',
    'mw-pin1-hello\n' + IH + '\n' + N + '\n-1',
    'mw-pin1-hello\n' + IH + '\n' + N + '\n9007199254740992',
    'mw-pin1-hello\n' + IH + '\n' + N + '\n1.0',
    'mw-pin1-receipt\n' + IH + '\n0\n' + AT,
    'mw-pin1-receipt\n' + IH + '\n01\n' + AT,
    'mw-pin1-receipt\n' + IH + '\n' + N + '\n' + AT,
    'mw-pin1-receipt\n' + IH + '\n1\n' + AT + '\nmw-pin1-receipt\n' + IH + '\n1\n' + AT,
    'mw-pin1-hello\n' + IH + '\n' + N + '\n' + AT + 'mw-pin1-receipt\n' + IH + '\n1\n' + AT,
  ];
  for (const s of refused) assert.equal(isPinSignable(utf8.encode(s)), false, JSON.stringify(s));
  assert.equal(isPinSignable(new Uint8Array([0xc3, 0x28])), false, 'invalid UTF-8');
  assert.equal(isPinSignable(new Uint8Array(SIGNABLE_MAX_BYTES + 1).fill(0x61)), false);
  assert.equal(isPinSignable('mw-pin1-receipt\n' + IH + '\n1\n' + AT), false, 'bytes only, not a string');
  assert.equal(isPinSignable(null), false);
  assert.equal(isPinSignable(helloBytes(IH, N, AT).buffer), true, 'an ArrayBuffer is bytes');
});

test('golden vectors (test/vectors/pin.json): the keys, the challenge, a hello and a receipt verify; every negative fails for its reason', async () => {
  const k1 = vec('pin-key-001');
  const k2 = vec('pin-key-002-other');
  assert.equal(await publicFromPrivateJwk(k1.input.jwk), k1.expect.pub);
  assert.equal(await publicFromPrivateJwk(k2.input.jwk), k2.expect.pub);
  await importPrivateJwk(k1.input.jwk); // a usable signing key
  const chal = vec('pin-chal-001');
  const nonce = b64url.encode(Uint8Array.from(Buffer.from(chal.input.nonceHex, 'hex')));
  assert.equal(utf8.decode(encodeFrame({ t: 'chal', n: nonce })), chal.expect.frame);
  for (const id of ['pin-hello-001', 'pin-rcpt-001']) {
    const v = vec(id);
    const d = decodeFrame(utf8.encode(v.expect.frame));
    assert.equal(d.ok, true, id);
    assert.equal(utf8.decode(encodeFrame(d.frame)), v.expect.frame, id + ': the frame re-encodes byte for byte');
    const signed = d.frame.t === 'hello' ? helloBytes(v.input.ih, v.input.n, v.input.at) : receiptBytes(v.input.ih, v.input.total, v.input.at);
    assert.equal(utf8.decode(signed), v.expect.signingInput, id);
    assert.equal(isPinSignable(signed), v.expect.signable, id);
    const res = d.frame.t === 'hello'
      ? await verifyHello(d.frame, { expectKey: v.input.expectKey, ih: v.input.ih, n: v.input.n, now: v.input.now })
      : await verifyReceipt(d.frame, { expectKey: v.input.expectKey, ih: v.input.ih, now: v.input.now, total: v.input.total });
    assert.deepEqual(res, v.expect.verify, id);
  }
  const negHello = async (id) => {
    const v = vec(id);
    const d = decodeFrame(utf8.encode(v.input.frame));
    assert.equal(d.ok, true, id + ' parses');
    const fn = d.frame.t === 'hello' ? verifyHello : verifyReceipt;
    assert.deepEqual(await fn(d.frame, { expectKey: v.input.expectKey, ih: v.input.ih, n: v.input.n, now: v.input.now }), v.expect.verify, id);
    return v;
  };
  const wrong = await negHello('pin-neg-001-wrong-prefix');
  assert.equal(isPinSignable(utf8.encode(wrong.input.signedBytes)), wrong.expect.signable);
  await negHello('pin-neg-002-skew');
  await negHello('pin-neg-003-other-key');
  await negHello('pin-neg-004-forged-receipt');
  const big = vec('pin-neg-005-oversize-frame');
  assert.deepEqual(decodeFrame(utf8.encode(big.input.frame)), big.expect.decode);
  const un = vec('pin-neg-009-unsignable');
  assert.deepEqual(un.input.texts.map((t) => isPinSignable(utf8.encode(t))), un.expect.signable);
});

// Code review v0.3 (security lens finding 12): a file pin request is signed by its author, for one ledger, at a time.
test('file pin requests: the author signs the five queue fields, the ledger and a time; tampering, another ledger or an old time fail; the pin key never signs one', async () => {
  const { privateKey, pub } = await keys();
  const SITE = 'mw1:pinFramesTestLedger0000000';
  const fields = { site: SITE, ih: IH, size: 1234, name: 'photo.jpg', sha256: 'ef'.repeat(32), at: AT };
  const bytes = pinRequestBytes(fields);
  assert.equal(utf8.decode(bytes), PIN_REQUEST_PREFIX + SITE + '\n' + IH + '\n1234\n' + 'ef'.repeat(32) + '\n' + AT + '\nphoto.jpg');
  assert.equal(isPinSignable(bytes), false, 'the pin key signs hello and receipt strings only');
  const r = await makePinRequest(Object.assign({ author: pub }, fields), privateKey);
  assert.deepEqual(Object.keys(r).sort(), ['at', 'author', 'ih', 'name', 'sha256', 'sig', 'size']);
  assert.deepEqual(await verifyPinRequest(r, { site: SITE, now: AT + 1000 }), { ok: true, reason: null });
  assert.equal((await verifyPinRequest(r, { site: SITE + 'x', now: AT })).reason, 'signature', 'another ledger');
  assert.equal((await verifyPinRequest(r, { site: SITE, now: AT + SKEW_MS + 1 })).reason, 'skew');
  for (const [k, v] of [['size', 1235], ['name', 'photo.exe'], ['ih', IH2], ['sha256', 'ee'.repeat(32)], ['at', AT + 60000]]) {
    assert.equal((await verifyPinRequest(Object.assign({}, r, { [k]: v }), { site: SITE, now: AT })).reason, 'signature', k);
  }
  const other = await keys();
  assert.equal((await verifyPinRequest(Object.assign({}, r, { author: other.pub }), { site: SITE, now: AT })).reason, 'signature', 'another author');
  assert.equal((await verifyPinRequest({ ih: IH, size: 1, author: pub }, { site: SITE, now: AT })).reason, 'unsigned');
  assert.equal((await verifyPinRequest(Object.assign({}, r, { sig: 'short' }), { site: SITE, now: AT })).reason, 'bad-field');
  assert.equal((await verifyPinRequest(Object.assign({}, r, { size: -1 }), { site: SITE, now: AT })).reason, 'bad-field');
  assert.equal((await verifyPinRequest(null, { site: SITE })).reason, 'malformed');
  // name and sha256 are optional: absent, they sign as empty
  const bare = await makePinRequest({ site: SITE, ih: IH, size: 9, at: AT, author: pub }, privateKey);
  assert.deepEqual(Object.keys(bare).sort(), ['at', 'author', 'ih', 'sig', 'size']);
  assert.equal((await verifyPinRequest(bare, { site: SITE, now: AT })).ok, true);
  assert.throws(() => pinRequestBytes(Object.assign({}, fields, { ih: 'AB'.repeat(20) })), TypeError);
});
