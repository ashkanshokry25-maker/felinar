// Unit tests for src/pin/heartbeat.js (the pin heartbeat of SEEDING-AND-ZERO-SETUP-DESIGN 3.1.6, evidence tier E4): hashed item ids,
// the signed bytes, round trips, the 15-minute age and 5-minute future windows, the key and site checks, the caps (256 KiB, 4,096
// items), the refusal of an infohash in the clear, and the golden vectors in test/vectors/pin.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import {
  STATUS_TYPE, STATUS_VERSION, STATUS_PREFIX, ITEM_PREFIX, STATUS_FILE, STATUS_MAX_BYTES, STATUS_MAX_ITEMS, STATUS_MAX_AGE_MS, STATUS_SKEW_MS,
  itemId, makeStatus, checkStatus, statusBytes, encodeStatus, signStatus, parseStatus, verifyStatus, statusUrl,
} from '../../src/pin/heartbeat.js';
import { generateKeyPair, exportPublicKey, sign as ecdsaSign } from '../../src/chain/crypto.js';
import { b64url, utf8, canonicalize } from '../../src/chain/canonical.js';

const VECTORS = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'vectors', 'pin.json'), 'utf8')).vectors;
const vec = (id) => {
  const v = VECTORS.find((x) => x.id === id);
  assert.ok(v, 'vector ' + id);
  return v;
};

const SITE = 'mw1:testLedgerAbcdefghijklmnopq';
const AT = Date.UTC(2026, 9, 20, 12, 0, 0);
const ih = (k) => k.toString(16).padStart(2, '0').repeat(20);

async function keys() {
  const { privateKey, publicKey } = await generateKeyPair();
  return { privateKey, pub: await exportPublicKey(publicKey) };
}

test('constants: the type, the version, the two prefixes, the file name and the caps of SZ 3.1.6', () => {
  assert.equal(STATUS_TYPE, 'mw-pin-status');
  assert.equal(STATUS_VERSION, 1);
  assert.equal(STATUS_PREFIX, 'mw-pin-status-v1\n');
  assert.equal(ITEM_PREFIX, 'mw-pin-status-v1|');
  assert.equal(STATUS_FILE, 'pin-status.json');
  assert.equal(STATUS_MAX_BYTES, 262144);
  assert.equal(STATUS_MAX_ITEMS, 4096);
  assert.equal(STATUS_MAX_AGE_MS, 900000);
  assert.equal(STATUS_SKEW_MS, 300000);
});

test('itemId is base64url of the first 16 bytes of SHA-256("mw-pin-status-v1|" + infohash), lowercase infohash, never the infohash', () => {
  const x = ih(0xab);
  const expected = b64url.encode(createHash('sha256').update('mw-pin-status-v1|' + x).digest().subarray(0, 16));
  assert.equal(itemId(x), expected);
  assert.equal(itemId(x.toUpperCase()), expected, 'one id per infohash whatever its case');
  assert.equal(itemId(x).length, 22);
  assert.ok(!itemId(x).includes(x.slice(0, 8)));
  assert.notEqual(itemId(ih(1)), itemId(ih(2)));
  for (const bad of ['', 'zz'.repeat(20), x.slice(1), null, 7]) assert.throws(() => itemId(bad), TypeError);
});

test('makeStatus hashes, sorts and dedupes the items; statusBytes is the prefix plus JCS of the heartbeat without sig', async () => {
  const k = await keys();
  const s = makeStatus({ key: k.pub, site: SITE, at: AT, ihs: [ih(3), ih(1), ih(3).toUpperCase(), ih(2)], monthBytes: 5, monthCap: null });
  assert.deepEqual(Object.keys(s).sort(), ['at', 'items', 'key', 'monthBytes', 'monthCap', 'site', 't', 'v']);
  assert.equal(s.items.length, 3);
  assert.deepEqual(s.items, [itemId(ih(1)), itemId(ih(2)), itemId(ih(3))].sort());
  assert.ok(!JSON.stringify(s).includes(ih(1)), 'no infohash in the clear');
  assert.equal(utf8.decode(statusBytes(s)), 'mw-pin-status-v1\n' + canonicalize(s));
  const signed = await signStatus(s, k.privateKey);
  assert.equal(utf8.decode(statusBytes(signed)), utf8.decode(statusBytes(s)), 'sig is not signed');
  assert.deepEqual(makeStatus({ key: k.pub, site: SITE, at: 0 }).items, []);
  assert.equal(makeStatus({ key: k.pub, site: SITE, at: 0 }).monthCap, null);
  const bad = [
    { key: 'p256:x', site: SITE, at: AT },
    { key: k.pub, site: '', at: AT },
    { key: k.pub, site: 'has space', at: AT },
    { key: k.pub, site: 'x'.repeat(129), at: AT },
    { key: k.pub, site: SITE, at: -1 },
    { key: k.pub, site: SITE, at: AT, ihs: 'abc' },
    { key: k.pub, site: SITE, at: AT, ihs: ['nope'] },
    { key: k.pub, site: SITE, at: AT, monthBytes: -1 },
    { key: k.pub, site: SITE, at: AT, monthCap: 0 },
  ];
  for (const b of bad) assert.throws(() => makeStatus(b), TypeError, JSON.stringify(b));
  assert.throws(() => makeStatus({ key: k.pub, site: SITE, at: AT, ihs: Array.from({ length: STATUS_MAX_ITEMS + 1 }, (_, i) => i.toString(16).padStart(40, '0')) }), RangeError);
  assert.throws(() => statusBytes(Object.assign({}, s, { extra: 1 })), TypeError);
});

test('signStatus and verifyStatus round trip from the object, the file text and the bytes; has(ih) answers for listed infohashes only', async () => {
  const k = await keys();
  const s = await signStatus(makeStatus({ key: k.pub, site: SITE, at: AT, ihs: [ih(1), ih(2)], monthBytes: 100, monthCap: 1000 }), k.privateKey);
  const text = encodeStatus(s);
  assert.ok(text.endsWith('\n'));
  for (const input of [s, text, utf8.encode(text)]) {
    const v = await verifyStatus(input, { expectKey: k.pub, site: SITE, now: AT + 1000 });
    assert.equal(v.ok, true, typeof input);
    assert.equal(v.reason, null);
    assert.equal(v.age, 1000);
    assert.equal(v.count, 2);
    assert.equal(v.has(ih(1)), true);
    assert.equal(v.has(ih(2).toUpperCase()), true);
    assert.equal(v.has(ih(3)), false);
    assert.equal(v.has('not an infohash'), false);
  }
  assert.equal((await verifyStatus(s, { expectKey: k.pub, now: AT })).ok, true, 'site is checked only when given');
  // a signer function works as well as a key
  const viaFn = await signStatus(makeStatus({ key: k.pub, site: SITE, at: AT }), (bytes) => ecdsaSign(k.privateKey, bytes));
  assert.equal((await verifyStatus(viaFn, { expectKey: k.pub, site: SITE, now: AT })).ok, true);
  await assert.rejects(signStatus(makeStatus({ key: k.pub, site: SITE, at: AT }), async () => 'short'), TypeError);
  await assert.rejects(signStatus(makeStatus({ key: k.pub, site: SITE, at: AT }), 42), TypeError);
  assert.equal(statusUrl('https://example.com/ws/'), 'https://example.com/ws/pin-status.json');
  assert.equal(statusUrl('https://example.com/ws'), 'https://example.com/ws/pin-status.json');
  assert.equal(statusUrl('http://127.0.0.1:8080/ws/site/'), 'http://127.0.0.1:8080/ws/site/pin-status.json');
});

test('verifyStatus: 15 minutes old at most, 5 minutes ahead at most, the named key, the named site, an intact signature', async () => {
  const k = await keys();
  const other = await keys();
  const s = await signStatus(makeStatus({ key: k.pub, site: SITE, at: AT, ihs: [ih(9)] }), k.privateKey);
  const v = (o) => verifyStatus(s, Object.assign({ expectKey: k.pub, site: SITE, now: AT }, o));
  assert.equal((await v({ now: AT + STATUS_MAX_AGE_MS })).ok, true, 'exactly 15 minutes');
  const stale = await v({ now: AT + STATUS_MAX_AGE_MS + 1 });
  assert.equal(stale.reason, 'stale');
  assert.equal(stale.has(ih(9)), false, 'a stale heartbeat lists nothing');
  assert.equal(stale.age, STATUS_MAX_AGE_MS + 1);
  assert.equal((await v({ now: AT + 60000, maxAgeMs: 30000 })).reason, 'stale', 'a stricter reader');
  assert.equal((await v({ now: AT - STATUS_SKEW_MS })).ok, true);
  assert.equal((await v({ now: AT - STATUS_SKEW_MS - 1 })).reason, 'future');
  assert.equal((await v({ expectKey: other.pub })).reason, 'other-key');
  assert.equal((await v({ expectKey: null })).reason, 'no-expected-key');
  assert.equal((await v({ site: 'mw1:otherLedgerAbcdefghijklmno' })).reason, 'other-site');
  const forged = await signStatus(makeStatus({ key: k.pub, site: SITE, at: AT, ihs: [ih(9)] }), other.privateKey);
  assert.equal((await verifyStatus(forged, { expectKey: k.pub, site: SITE, now: AT })).reason, 'signature');
  for (const change of [{ at: AT + 1 }, { monthBytes: 1 }, { items: [itemId(ih(8))] }, { site: SITE + 'x' }]) {
    const t = Object.assign({}, s, change);
    const r = await verifyStatus(t, { expectKey: k.pub, now: AT });
    assert.equal(r.reason, 'signature', JSON.stringify(change));
  }
});

test('the shape checks refuse an infohash in the clear, extra fields, bad items, oversize files and too many items', async () => {
  const k = await keys();
  const s = await signStatus(makeStatus({ key: k.pub, site: SITE, at: AT, ihs: [ih(1)] }), k.privateKey);
  const shape = (change) => checkStatus(Object.assign({}, s, change)).reason;
  assert.equal(checkStatus(s).ok, true);
  assert.equal(shape({ items: [ih(1)] }), 'cleartext-infohash');
  assert.equal(shape({ items: [ih(1).toUpperCase()] }), 'cleartext-infohash');
  assert.equal(shape({ ihs: [ih(1)] }), 'extra-field', 'no other field may carry infohashes');
  assert.equal(shape({ items: ['short'] }), 'bad-item');
  assert.equal(shape({ items: [s.items[0], s.items[0]] }), 'duplicate-item');
  assert.equal(shape({ items: 'x' }), 'bad-items');
  assert.equal(shape({ v: 2 }), 'wrong-version');
  assert.equal(shape({ t: 'mw-pin-status2' }), 'wrong-type');
  assert.equal(shape({ key: 'p256:x' }), 'bad-key');
  assert.equal(shape({ site: '' }), 'bad-site');
  assert.equal(shape({ at: 1.5 }), 'bad-at');
  assert.equal(shape({ monthBytes: -1 }), 'bad-month-bytes');
  assert.equal(shape({ monthCap: 0 }), 'bad-month-cap');
  assert.equal(shape({ sig: 'abc' }), 'bad-sig');
  assert.equal(checkStatus([]).reason, 'malformed');
  const many = Array.from({ length: STATUS_MAX_ITEMS + 1 }, (_, i) => b64url.encode(createHash('sha256').update(String(i)).digest().subarray(0, 16)));
  assert.equal(shape({ items: many }), 'too-many-items');
  assert.equal(parseStatus('x'.repeat(STATUS_MAX_BYTES + 1)).reason, 'too-large');
  assert.equal(parseStatus(new Uint8Array(STATUS_MAX_BYTES + 1)).reason, 'too-large');
  assert.equal(parseStatus('{not json').reason, 'malformed');
  assert.equal(parseStatus(new Uint8Array([0xff])).reason, 'malformed');
  assert.equal((await verifyStatus('[]', { expectKey: k.pub, now: AT })).reason, 'malformed');
  // the largest legal heartbeat (4,096 items, the longest site id) stays far below 256 KiB
  const full = makeStatus({ key: k.pub, site: 'x'.repeat(128), at: Number.MAX_SAFE_INTEGER, ihs: Array.from({ length: STATUS_MAX_ITEMS }, (_, i) => i.toString(16).padStart(40, '0')), monthBytes: Number.MAX_SAFE_INTEGER, monthCap: Number.MAX_SAFE_INTEGER });
  const fullSigned = await signStatus(full, k.privateKey);
  const size = utf8.encode(encodeStatus(fullSigned)).length;
  assert.ok(size < STATUS_MAX_BYTES / 2, 'a full heartbeat is ' + size + ' bytes');
  assert.throws(() => encodeStatus({ pad: 'x'.repeat(STATUS_MAX_BYTES) }), RangeError);
});

test('golden vectors (test/vectors/pin.json): the heartbeat verifies with its item ids and signed bytes; the negatives fail for their reasons', async () => {
  const v = vec('pin-status-001');
  const r = await verifyStatus(v.expect.file, { expectKey: v.input.expectKey, site: v.input.site, now: v.input.now });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual({ ok: r.ok, reason: r.reason, age: r.age, count: r.count }, v.expect.verify);
  for (const [x, listed] of Object.entries(v.expect.has)) assert.equal(r.has(x), listed, x);
  for (const [x, id] of Object.entries(v.expect.itemIds)) assert.equal(itemId(x), id);
  const rebuilt = makeStatus({ key: v.input.expectKey, site: v.input.site, at: v.input.at, ihs: v.input.ihs, monthBytes: v.input.monthBytes, monthCap: v.input.monthCap });
  assert.deepEqual(rebuilt.items, v.expect.items);
  assert.equal(STATUS_PREFIX + canonicalize(rebuilt), v.expect.signingInput, 'the signed bytes are reproduced exactly');
  assert.equal(utf8.decode(statusBytes(JSON.parse(v.expect.file))), v.expect.signingInput);
  for (const id of ['pin-neg-006-cleartext-infohash', 'pin-neg-007-stale-status', 'pin-neg-008-other-site']) {
    const n = vec(id);
    const res = await verifyStatus(n.input.file, { expectKey: n.input.expectKey, site: n.input.site, now: n.input.now });
    assert.deepEqual({ ok: res.ok, reason: res.reason }, n.expect.verify, id);
  }
});
