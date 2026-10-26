// Unit tests for src/chain/canonical.js (RFC 8785 JCS + byte helpers).
// Non-ASCII and control characters are built with String.fromCharCode so no escape processing
// by editors or tooling can alter the fixtures; the expectations come from the RFC's own UTF-8
// hex dump (§3.2.4), its sorting test data (§3.2.3) and its Appendix B number table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  canonicalize, utf8, hex, b64url, concatBytes, byteLength, asBytes,
} from '../../src/chain/canonical.js';

const chars = (...codes) => String.fromCharCode(...codes);
const BS = chars(0x5c); // backslash
const QU = chars(0x22); // double quote

// RFC 8785 §3.2.2 sample input. Its "string" member is the JSON text
//   "<U+20AC>$<U+000F><U+000A>A'<U+0042><U+0022><U+005C><escaped backslash><escaped quote><escaped slash>"
// which parses to these 12 UTF-16 code units.
const RFC_INPUT = {
  numbers: [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
  string: chars(0x20ac, 0x24, 0x0f, 0x0a, 0x41, 0x27, 0x42, 0x22, 0x5c, 0x5c, 0x22, 0x2f),
  literals: [null, true, false],
};

// RFC 8785 §3.2.4: the UTF-8 bytes of the canonical form of RFC_INPUT, verbatim from the RFC.
const RFC_EXPECTED_HEX = [
  '7b 22 6c 69 74 65 72 61 6c 73 22 3a 5b 6e 75 6c 6c 2c 74 72',
  '75 65 2c 66 61 6c 73 65 5d 2c 22 6e 75 6d 62 65 72 73 22 3a',
  '5b 33 33 33 33 33 33 33 33 33 2e 33 33 33 33 33 33 33 2c 31',
  '65 2b 33 30 2c 34 2e 35 2c 30 2e 30 30 32 2c 31 65 2d 32 37',
  '5d 2c 22 73 74 72 69 6e 67 22 3a 22 e2 82 ac 24 5c 75 30 30',
  '30 66 5c 6e 41 27 42 5c 22 5c 5c 5c 5c 5c 22 2f 22 7d',
].join(' ').replace(/ /g, '');

// RFC 8785 §3.2.3: the same canonical form written out as text.
const RFC_EXPECTED_TEXT =
  '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"' +
  chars(0x20ac) + '$' + BS + 'u000f' + BS + 'nA' + "'" + 'B' + BS + QU + BS + BS + BS + BS + BS + QU + '/' + QU + '}';

test('RFC 8785 §3.2.2–3.2.4 sample canonicalizes to the RFC byte sequence', () => {
  // The fixture must equal what JSON.parse makes of the RFC's own string literal.
  const rfcStringJson = QU + BS + 'u20ac$' + BS + 'u000F' + BS + 'u000aA' + "'" + BS + 'u0042' +
    BS + 'u0022' + BS + 'u005c' + BS + BS + BS + QU + BS + '/' + QU;
  assert.equal(JSON.parse(rfcStringJson), RFC_INPUT.string);
  const expectedBytes = hex.decode(RFC_EXPECTED_HEX);
  assert.equal(utf8.decode(expectedBytes), RFC_EXPECTED_TEXT);

  const out = canonicalize(RFC_INPUT);
  assert.equal(out, RFC_EXPECTED_TEXT);
  assert.deepEqual(utf8.encode(out), expectedBytes);
  assert.equal(hex.encode(utf8.encode(out)), RFC_EXPECTED_HEX);
  // Insertion order of the properties is irrelevant.
  const reordered = { string: RFC_INPUT.string, literals: RFC_INPUT.literals, numbers: RFC_INPUT.numbers };
  assert.equal(canonicalize(reordered), RFC_EXPECTED_TEXT);
});

test('RFC 8785 §3.2.3 sorting test data: UTF-16 code unit order, not code point order', () => {
  const input = {};
  input[chars(0x20ac)] = 'Euro Sign';
  input[chars(0x0d)] = 'Carriage Return';
  input[chars(0xfb33)] = 'Hebrew Letter Dalet With Dagesh';
  input['1'] = 'One';
  input[chars(0xd83d, 0xde00)] = 'Emoji: Grinning Face';
  input[chars(0x80)] = 'Control';
  input[chars(0xf6)] = 'Latin Small Letter O With Diaeresis';
  const expected = '{' +
    QU + BS + 'r' + QU + ':"Carriage Return",' +
    '"1":"One",' +
    QU + chars(0x80) + QU + ':"Control",' +
    QU + chars(0xf6) + QU + ':"Latin Small Letter O With Diaeresis",' +
    QU + chars(0x20ac) + QU + ':"Euro Sign",' +
    QU + chars(0xd83d, 0xde00) + QU + ':"Emoji: Grinning Face",' +
    QU + chars(0xfb33) + QU + ':"Hebrew Letter Dalet With Dagesh"}';
  const out = canonicalize(input);
  assert.equal(out, expected);
  const values = [...out.matchAll(/:"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(values, [
    'Carriage Return', 'One', 'Control', 'Latin Small Letter O With Diaeresis',
    'Euro Sign', 'Emoji: Grinning Face', 'Hebrew Letter Dalet With Dagesh',
  ]);
});

test('key sorting ignores JS property enumeration order (integer-like keys)', () => {
  assert.equal(canonicalize({ 1: 'a', '!': 'b', A: 'c', 10: 'd', 9: 'e' }), '{"!":"b","1":"a","10":"d","9":"e","A":"c"}');
  // RFC 8785 §3.2.3 "plain English" example: "" < "a" < "aa" < "ab".
  assert.equal(canonicalize({ ab: 3, aa: 2, a: 1, '': 0 }), '{"":0,"a":1,"aa":2,"ab":3}');
});

test('nested objects are sorted recursively; arrays keep their order', () => {
  const input = { b: [{ z: 1, a: 2 }, 3, [{ y: [], x: {} }]], a: { y: null, x: [true, false] } };
  assert.equal(canonicalize(input), '{"a":{"x":[true,false],"y":null},"b":[{"a":2,"z":1},3,[{"x":{},"y":[]}]]}');
  assert.equal(canonicalize({}), '{}');
  assert.equal(canonicalize([]), '[]');
  assert.equal(canonicalize([[], {}, [[]]]), '[[],{},[[]]]');
  assert.equal(canonicalize(null), 'null');
  assert.equal(canonicalize(true), 'true');
  assert.equal(canonicalize(false), 'false');
});

function doubleFromHex(h) {
  return new DataView(hex.decode(h).buffer).getFloat64(0, false);
}

test('numbers: RFC 8785 Appendix B samples serialize per ES Number::toString', () => {
  const samples = [
    ['0000000000000000', '0'], ['8000000000000000', '0'],
    ['0000000000000001', '5e-324'], ['8000000000000001', '-5e-324'],
    ['7fefffffffffffff', '1.7976931348623157e+308'], ['ffefffffffffffff', '-1.7976931348623157e+308'],
    ['4340000000000000', '9007199254740992'], ['c340000000000000', '-9007199254740992'],
    ['4430000000000000', '295147905179352830000'],
    ['44b52d02c7e14af5', '9.999999999999997e+22'], ['44b52d02c7e14af6', '1e+23'],
    ['44b52d02c7e14af7', '1.0000000000000001e+23'],
    ['444b1ae4d6e2ef4e', '999999999999999700000'], ['444b1ae4d6e2ef4f', '999999999999999900000'],
    ['444b1ae4d6e2ef50', '1e+21'],
    ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'], ['3eb0c6f7a0b5ed8d', '0.000001'],
    ['41b3de4355555553', '333333333.3333332'], ['41b3de4355555554', '333333333.33333325'],
    ['41b3de4355555555', '333333333.3333333'], ['41b3de4355555556', '333333333.3333334'],
    ['41b3de4355555557', '333333333.33333343'],
    ['becbf647612f3696', '-0.0000033333333333333333'],
    ['43143ff3c1cb0959', '1424953923781206.2'],
  ];
  for (const [ieee, expected] of samples) {
    assert.equal(canonicalize(doubleFromHex(ieee)), expected, ieee);
    assert.equal(canonicalize([doubleFromHex(ieee)]), '[' + expected + ']', ieee);
  }
  assert.ok(Number.isNaN(doubleFromHex('7fffffffffffffff')));
  assert.throws(() => canonicalize(doubleFromHex('7fffffffffffffff')), TypeError);
  assert.equal(doubleFromHex('7ff0000000000000'), Infinity);
  assert.throws(() => canonicalize(doubleFromHex('7ff0000000000000')), TypeError);
});

test('numbers: everyday values and negative zero', () => {
  assert.equal(canonicalize(0), '0');
  assert.equal(canonicalize(-0), '0');
  assert.equal(canonicalize(1.0), '1');
  assert.equal(canonicalize(100), '100');
  assert.equal(canonicalize(-42), '-42');
  assert.equal(canonicalize(0.1 + 0.2), '0.30000000000000004');
  assert.equal(canonicalize(1e21), '1e+21');
  assert.equal(canonicalize(123456789012345680000), '123456789012345680000');
  assert.equal(canonicalize(-1.5e-7), '-1.5e-7');
  assert.equal(canonicalize(1e-7), '1e-7');
  assert.equal(canonicalize(0.000001), '0.000001');
  assert.equal(canonicalize(Number.MAX_SAFE_INTEGER), '9007199254740991');
  assert.equal(canonicalize(-Number.MAX_SAFE_INTEGER), '-9007199254740991');
  assert.equal(canonicalize(2 ** 53), '9007199254740992');
  assert.equal(canonicalize(Date.UTC(2026, 9, 14)), '1791936000000');
  assert.equal(canonicalize({ n: -0 }), '{"n":0}');
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(() => canonicalize(bad), TypeError);
    assert.throws(() => canonicalize({ v: bad }), TypeError);
    assert.throws(() => canonicalize([1, [bad]]), TypeError);
  }
});

test('strings: control characters, quote and backslash are the only escapes', () => {
  const short = { 8: 'b', 9: 't', 10: 'n', 12: 'f', 13: 'r' };
  for (let c = 0; c < 0x20; c++) {
    const expected = short[c] ? BS + short[c] : BS + 'u00' + c.toString(16).padStart(2, '0');
    assert.equal(canonicalize(chars(c)), QU + expected + QU, 'U+' + c.toString(16));
    assert.equal(canonicalize('a' + chars(c) + 'b'), QU + 'a' + expected + 'b' + QU, 'U+' + c.toString(16));
    const key = {};
    key[chars(c)] = 1;
    assert.equal(canonicalize(key), '{' + QU + expected + QU + ':1}', 'key U+' + c.toString(16));
  }
  assert.equal(canonicalize(QU), QU + BS + QU + QU);
  assert.equal(canonicalize(BS), QU + BS + BS + QU);
  assert.equal(canonicalize(BS + BS), QU + BS + BS + BS + BS + QU);
  assert.equal(canonicalize('/'), '"/"');
  assert.equal(canonicalize(''), '""');
  assert.equal(canonicalize('plain ascii 123'), '"plain ascii 123"');
  // Everything outside U+0000..U+001F other than quote and backslash is emitted as-is,
  // including DEL, C1 controls, line/paragraph separators, BOM and astral characters.
  for (const c of [0x7f, 0x80, 0x9f, 0xa0, 0xe9, 0x2028, 0x2029, 0xfeff, 0xfffd, 0xffff]) {
    assert.equal(canonicalize(chars(c)), QU + chars(c) + QU, 'U+' + c.toString(16));
  }
  assert.equal(canonicalize(String.fromCodePoint(0x1f600)), QU + chars(0xd83d, 0xde00) + QU);
  assert.equal(canonicalize(String.fromCodePoint(0x10ffff)), QU + String.fromCodePoint(0x10ffff) + QU);
  // Hex digits are lowercase.
  assert.equal(canonicalize(chars(0x1f, 0x0b, 0x1e)), QU + BS + 'u001f' + BS + 'u000b' + BS + 'u001e' + QU);
});

test('strings: lone surrogates are rejected (RFC 8785 §3.2.2.2), well-formed pairs accepted', () => {
  const bad = [
    chars(0xd800), chars(0xdbff), chars(0xdc00), chars(0xdfff),
    chars(0xd800, 0x41), 'a' + chars(0xd800), chars(0xdc00, 0xd800), chars(0xd83d, 0xd83d, 0xde00),
    'ok' + chars(0xdead) + 'ok',
  ];
  for (const s of bad) {
    assert.throws(() => canonicalize(s), TypeError, JSON.stringify(s));
    assert.throws(() => canonicalize({ s }), TypeError);
    assert.throws(() => canonicalize([s]), TypeError);
    const key = {};
    key[s] = 1;
    assert.throws(() => canonicalize(key), TypeError, 'as key ' + JSON.stringify(s));
  }
  const good = chars(0xd83d, 0xde00) + chars(0xdbff, 0xdfff) + chars(0xd800, 0xdc00);
  assert.equal(canonicalize(good), QU + good + QU);
});

test('rejects every non-JSON value with TypeError', () => {
  class Thing { constructor() { this.a = 1; } }
  const circularObject = { a: 1 };
  circularObject.self = circularObject;
  const circularArray = [1];
  circularArray.push(circularArray);
  const deepCycle = { a: { b: { c: {} } } };
  deepCycle.a.b.c.back = deepCycle.a;
  const symbolKeyed = { a: 1 };
  symbolKeyed[Symbol('k')] = 2;
  const sparse = [1, , 3]; // eslint-disable-line no-sparse-arrays
  const cases = [
    undefined, () => 1, function named() {}, Symbol('s'), 10n, -1n,
    new Date(0), new Map(), new Set(), new Uint8Array(1), new ArrayBuffer(1), new DataView(new ArrayBuffer(1)),
    new Thing(), Object.create({ inherited: 1 }), new Number(1), new String('x'), new Boolean(true), /re/,
    new Error('e'), Promise.resolve(), new WeakMap(),
    { a: undefined }, [undefined], sparse, { toJSON() { return 1; } }, { nested: { deeper: () => 1 } },
    [1, [2, [3, [Symbol('deep')]]]], symbolKeyed, circularObject, circularArray, deepCycle,
  ];
  for (const value of cases) {
    assert.throws(() => canonicalize(value), TypeError, String(value && value.constructor && value.constructor.name));
    assert.throws(() => canonicalize({ wrapped: value }), TypeError);
    assert.throws(() => canonicalize([value]), TypeError);
  }
});

test('accepts null-prototype objects and ignores toJSON', () => {
  const bare = Object.create(null);
  bare.b = 2;
  bare.a = [Object.assign(Object.create(null), { z: null })];
  assert.equal(canonicalize(bare), '{"a":[{"z":null}],"b":2}');
  assert.equal(canonicalize({ toJSON: 1 }), '{"toJSON":1}');
  assert.equal(canonicalize(JSON.parse('{"__proto__": 1, "x": 2}')), '{"__proto__":1,"x":2}');
});

// --- property tests -------------------------------------------------------------------------

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomString(r) {
  const n = Math.floor(r() * 8);
  let s = '';
  for (let i = 0; i < n; i++) {
    const pick = r();
    if (pick < 0.35) s += chars(Math.floor(r() * 0x80));
    else if (pick < 0.65) s += chars(0x80 + Math.floor(r() * (0xd800 - 0x80)));
    else if (pick < 0.85) s += String.fromCodePoint(0x10000 + Math.floor(r() * 0x100000));
    else s += chars(0xe000 + Math.floor(r() * 0x2000));
  }
  return s;
}

function randomNumber(r) {
  const pick = r();
  if (pick < 0.4) return Math.floor(r() * 2e6) - 1e6;
  if (pick < 0.7) return (r() - 0.5) * 10 ** Math.floor(r() * 40 - 20);
  return r();
}

function randomValue(r, depth) {
  const pick = r();
  if (depth > 3 || pick < 0.5) {
    const p = r();
    if (p < 0.3) return randomString(r);
    if (p < 0.6) return randomNumber(r);
    if (p < 0.7) return null;
    if (p < 0.85) return r() < 0.5;
    return Math.floor(r() * 100);
  }
  if (pick < 0.75) {
    const n = Math.floor(r() * 5);
    const arr = [];
    for (let i = 0; i < n; i++) arr.push(randomValue(r, depth + 1));
    return arr;
  }
  const n = Math.floor(r() * 6);
  const obj = {};
  for (let i = 0; i < n; i++) obj[randomString(r)] = randomValue(r, depth + 1);
  return obj;
}

// Deep copy with object keys inserted in a random order.
function reinsertShuffled(v, r) {
  if (Array.isArray(v)) return v.map((x) => reinsertShuffled(x, r));
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v);
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [keys[i], keys[j]] = [keys[j], keys[i]];
    }
    const out = {};
    for (const k of keys) out[k] = reinsertShuffled(v[k], r);
    return out;
  }
  return v;
}

// Independent reference: explicit recursive key sort + JSON.stringify for scalars (which is
// JCS-identical for finite numbers and well-formed strings).
function refCanon(v) {
  if (Array.isArray(v)) return '[' + v.map(refCanon).join(',') + ']';
  if (v !== null && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + refCanon(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

test('property: matches an independent reference, is order-independent and idempotent', () => {
  const r = rng(0x5eed);
  for (let i = 0; i < 400; i++) {
    const value = randomValue(r, 0);
    const out = canonicalize(value);
    assert.equal(out, refCanon(value));
    assert.equal(canonicalize(reinsertShuffled(value, r)), out);
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed, value);
    assert.equal(canonicalize(parsed), out);
    assert.equal(byteLength(out), utf8.encode(out).length);
  }
});

// --- helpers --------------------------------------------------------------------------------

test('hex: lowercase encode, case-insensitive decode, strict validation', () => {
  assert.equal(hex.encode(new Uint8Array([0, 1, 0xab, 0xff])), '0001abff');
  assert.equal(hex.encode(new Uint8Array(0)), '');
  assert.deepEqual(hex.decode('0001abff'), new Uint8Array([0, 1, 0xab, 0xff]));
  assert.deepEqual(hex.decode('ABFF'), new Uint8Array([0xab, 0xff]));
  assert.deepEqual(hex.decode(''), new Uint8Array(0));
  // Views and buffers: offsets are respected.
  assert.equal(hex.encode(new Uint8Array([9, 1, 2, 3]).subarray(1)), '010203');
  assert.equal(hex.encode(new Uint8Array([1, 2]).buffer), '0102');
  assert.equal(hex.encode(new DataView(new Uint8Array([7, 8, 9]).buffer, 1)), '0809');
  assert.equal(hex.encode(Buffer.from([0xde, 0xad])), 'dead');
  for (const bad of ['0', 'abc', 'zz', '0g', ' 00', '00 ', 'ÿÿ', 0, null, undefined, {}, [0]]) {
    assert.throws(() => hex.decode(bad), TypeError, String(bad));
  }
  const r = rng(1);
  for (let i = 0; i < 100; i++) {
    const bytes = new Uint8Array(Math.floor(r() * 70));
    for (let j = 0; j < bytes.length; j++) bytes[j] = Math.floor(r() * 256);
    const s = hex.encode(bytes);
    assert.equal(s, Buffer.from(bytes).toString('hex'));
    assert.deepEqual(hex.decode(s), bytes);
    assert.deepEqual(hex.decode(s.toUpperCase()), bytes);
  }
});

test('b64url: unpadded URL-safe encoding, strict canonical decoding', () => {
  assert.equal(b64url.encode(new Uint8Array(0)), '');
  assert.equal(b64url.encode(new Uint8Array([0x41])), 'QQ');
  assert.equal(b64url.encode(new Uint8Array([0x41, 0x42])), 'QUI');
  assert.equal(b64url.encode(new Uint8Array([0x41, 0x42, 0x43])), 'QUJD');
  assert.equal(b64url.encode(new Uint8Array([0xfb, 0xff, 0xbf])), '-_-_');
  assert.deepEqual(b64url.decode('QQ'), new Uint8Array([0x41]));
  assert.deepEqual(b64url.decode('QQ=='), new Uint8Array([0x41]));
  assert.deepEqual(b64url.decode('QUI='), new Uint8Array([0x41, 0x42]));
  assert.deepEqual(b64url.decode('-_-_'), new Uint8Array([0xfb, 0xff, 0xbf]));
  assert.deepEqual(b64url.decode(''), new Uint8Array(0));
  // Non-zero trailing bits, standard alphabet, bad lengths and bad characters are rejected.
  for (const bad of ['QR', 'QUJ', '+w', '/w', 'QUJ=D', 'Q', 'QUJDQ', 'QU I', 'QUI\n', 'Q*', 'QQ===', 5, null, undefined, new Uint8Array(1)]) {
    assert.throws(() => b64url.decode(bad), TypeError, JSON.stringify(bad));
  }
  const r = rng(2);
  for (let i = 0; i < 300; i++) {
    const bytes = new Uint8Array(i < 70 ? i : Math.floor(r() * 200));
    for (let j = 0; j < bytes.length; j++) bytes[j] = Math.floor(r() * 256);
    const s = b64url.encode(bytes);
    assert.equal(s, Buffer.from(bytes).toString('base64url'));
    assert.match(s, /^[A-Za-z0-9_-]*$/);
    assert.deepEqual(b64url.decode(s), bytes);
    assert.deepEqual(b64url.decode(Buffer.from(bytes).toString('base64url')), bytes);
    assert.equal(b64url.encode(b64url.decode(s)), s);
  }
  assert.equal(b64url.encode(new Uint8Array([1, 2, 3, 4]).subarray(1, 3)), 'AgM');
});

test('utf8: round trips, BOM preserved, lenient by default, fatal on request', () => {
  for (const s of ['', 'abc', 'h' + chars(0xe9) + 'llo', String.fromCodePoint(0x1f600, 0x10ffff), chars(0xfeff) + 'x', chars(0x7ff, 0x800, 0xffff)]) {
    const bytes = utf8.encode(s);
    assert.ok(bytes instanceof Uint8Array);
    assert.equal(utf8.decode(bytes), s);
    assert.equal(utf8.decode(bytes.buffer), s);
    assert.equal(utf8.decode(bytes, { fatal: true }), s);
    assert.deepEqual(bytes, new Uint8Array(Buffer.from(s, 'utf8')));
  }
  assert.equal(utf8.decode(new Uint8Array([0xe2, 0x82, 0xac])), chars(0x20ac));
  assert.equal(utf8.decode(new Uint8Array([0x61, 0xff, 0x62])), 'a' + chars(0xfffd) + 'b');
  assert.throws(() => utf8.decode(new Uint8Array([0x61, 0xff, 0x62]), { fatal: true }), TypeError);
  assert.throws(() => utf8.decode(new Uint8Array([0xed, 0xa0, 0x80]), { fatal: true }), TypeError); // encoded surrogate
  assert.throws(() => utf8.encode(123), TypeError);
  assert.throws(() => utf8.encode(undefined), TypeError);
  assert.throws(() => utf8.decode('text'), TypeError);
  // Lone surrogates encode as U+FFFD, like every browser TextEncoder.
  assert.deepEqual(utf8.encode(chars(0xd800)), new Uint8Array([0xef, 0xbf, 0xbd]));
});

test('concatBytes: copies in order, accepts buffers and views, never aliases inputs', () => {
  const a = new Uint8Array([1, 2]);
  const b = new Uint8Array([3]);
  const c = new Uint8Array([4, 5, 6]);
  const out = concatBytes(a, b, c);
  assert.deepEqual(out, new Uint8Array([1, 2, 3, 4, 5, 6]));
  a[0] = 99;
  assert.equal(out[0], 1);
  assert.deepEqual(concatBytes(), new Uint8Array(0));
  assert.deepEqual(concatBytes(new Uint8Array(0), new Uint8Array(0)), new Uint8Array(0));
  assert.deepEqual(concatBytes(new Uint8Array([7]).buffer, new DataView(new Uint8Array([8, 9]).buffer, 1), Buffer.from([10])), new Uint8Array([7, 9, 10]));
  assert.throws(() => concatBytes(new Uint8Array(1), 'x'), TypeError);
  assert.throws(() => concatBytes([1, 2]), TypeError);
});

test('byteLength equals the UTF-8 encoded length for every kind of string', () => {
  const fixed = [
    '', 'abc', 'h' + chars(0xe9) + 'llo', chars(0x7f), chars(0x80), chars(0x7ff), chars(0x800), chars(0xffff),
    String.fromCodePoint(0x10000), String.fromCodePoint(0x10ffff), chars(0xd800), chars(0xdc00),
    chars(0xd800, 0x41), 'a' + chars(0xd800), chars(0xdc00, 0xd800), chars(0xd83d, 0xd83d, 0xde00),
  ];
  for (const s of fixed) assert.equal(byteLength(s), utf8.encode(s).length, JSON.stringify(s));
  const r = rng(3);
  for (let i = 0; i < 500; i++) {
    const n = Math.floor(r() * 12);
    let s = '';
    for (let j = 0; j < n; j++) s += chars(Math.floor(r() * 0x10000)); // includes random surrogates
    assert.equal(byteLength(s), utf8.encode(s).length, JSON.stringify(s));
  }
  assert.throws(() => byteLength(1), TypeError);
  assert.throws(() => byteLength(null), TypeError);
});

test('asBytes: identity for Uint8Array, zero-copy views for buffers and other views', () => {
  const u8 = new Uint8Array([1, 2, 3]);
  assert.equal(asBytes(u8), u8);
  const ab = new ArrayBuffer(4);
  const view = asBytes(ab);
  assert.equal(view.buffer, ab);
  assert.equal(view.length, 4);
  const dv = new DataView(new Uint8Array([5, 6, 7, 8]).buffer, 1, 2);
  assert.deepEqual(asBytes(dv), new Uint8Array([6, 7]));
  assert.equal(asBytes(dv).buffer, dv.buffer);
  assert.deepEqual(asBytes(new Uint16Array([0x0201])), new Uint8Array(new Uint16Array([0x0201]).buffer));
  for (const bad of ['abc', 1, null, undefined, [1, 2], {}]) assert.throws(() => asBytes(bad), TypeError);
});
