import test from 'node:test';
import assert from 'node:assert/strict';
import bencodePkg from 'bencode';
import { encode, decode, compareBytes, equalBytes, MAX_DEPTH } from '../../src/common/bencode.js';

const te = new TextEncoder();
const td = new TextDecoder();
const latin = (u8) => Array.from(u8, (b) => String.fromCharCode(b)).join('');
const bytes = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));

test('bencode.encode: BEP 3 examples', () => {
  assert.equal(latin(encode('spam')), '4:spam');
  assert.equal(latin(encode(3)), 'i3e');
  assert.equal(latin(encode(-3)), 'i-3e');
  assert.equal(latin(encode(0)), 'i0e');
  assert.equal(latin(encode(-0)), 'i0e');
  assert.equal(latin(encode(['spam', 'eggs'])), 'l4:spam4:eggse');
  assert.equal(latin(encode({ cow: 'moo', spam: 'eggs' })), 'd3:cow3:moo4:spam4:eggse');
  assert.equal(latin(encode({ spam: ['a', 'b'] })), 'd4:spaml1:a1:bee');
  assert.equal(latin(encode('')), '0:');
  assert.equal(latin(encode(new Uint8Array([0, 255]))), '2:' + String.fromCharCode(0, 255));
  assert.equal(latin(encode(true)), 'i1e');
  assert.equal(latin(encode(12345678901234567890n)), 'i12345678901234567890e');
});

test('bencode.encode: keys sorted bytewise, null/undefined entries omitted', () => {
  assert.equal(latin(encode({ b: 1, a: 2, B: 3, aa: 4 })), 'd1:Bi3e1:ai2e2:aai4e1:bi1ee');
  assert.equal(latin(encode({ a: 1, x: undefined, y: null })), 'd1:ai1ee');
  // UTF-8 byte order: U+FB33 (EF AC B3) sorts before U+1F600 (F0 9F 98 80), unlike UTF-16 order.
  const k1 = String.fromCharCode(0xfb33);
  const k2 = String.fromCodePoint(0x1f600);
  const out = encode({ [k2]: 1, [k1]: 2 });
  assert.equal(td.decode(out), 'd3:' + k1 + 'i2e4:' + k2 + 'i1ee');
  const m = new Map([['z', 1], [te.encode('a'), 2]]);
  assert.equal(latin(encode(m)), 'd1:ai2e1:zi1ee');
});

test('bencode.encode: matches the bencode package for ordinary data', () => {
  const samples = [
    { info: { name: 'site', 'piece length': 16384, pieces: new Uint8Array(40).fill(7), files: [{ length: 3, path: ['a', 'b.txt'] }] } },
    ['x', 1, -2, [new Uint8Array([1, 2, 3])], { k: { j: 'v' } }],
    { 'announce-list': [['wss://a'], ['wss://b']], 'creation date': 1700000000, comment: 'caf' + String.fromCharCode(0xe9) },
  ];
  for (const s of samples) assert.deepEqual(encode(s), new Uint8Array(bencodePkg.encode(s)));
});

test('bencode.encode: rejects what bencode cannot represent', () => {
  assert.throws(() => encode(1.5), TypeError);
  assert.throws(() => encode(Number.MAX_SAFE_INTEGER + 1), TypeError);
  assert.throws(() => encode(NaN), TypeError);
  assert.throws(() => encode(null), TypeError);
  assert.throws(() => encode(undefined), TypeError);
  assert.throws(() => encode([1, null]), TypeError);
  assert.throws(() => encode(() => 1), TypeError);
  assert.throws(() => encode(new Date()), TypeError);
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  assert.throws(() => encode(cyclic), TypeError);
  assert.throws(() => encode(new Map([['a', 1], [te.encode('a'), 2]])), TypeError, 'duplicate key across string and bytes');
});

test('bencode.decode: values, types and round trip', () => {
  const src = bytes('d4:infod4:name4:site12:piece lengthi16384e6:pieces3:abce4:listli1ei-2e3:xyze3:numi42e1:zi9007199254740993ee');
  const { value } = decode(src);
  assert.deepEqual(value.info.name, te.encode('site'));
  assert.equal(value.info['piece length'], 16384);
  assert.deepEqual(value.list[2], te.encode('xyz'));
  assert.equal(value.list[1], -2);
  assert.equal(value.num, 42);
  assert.equal(value.z, 9007199254740993n, 'outside the safe range becomes BigInt');
  assert.deepEqual(encode(value), src, 'canonical input re-encodes byte for byte');
});

test('bencode.decode: spans of the root and of values reached through dictionaries', () => {
  const src = bytes('d8:announce3:url4:infod5:filesld6:lengthi1e4:pathl1:aeee4:name1:xe1:zi1ee');
  const { value, spans } = decode(src);
  assert.deepEqual(spans.get(''), [0, src.length]);
  const [s, e] = spans.get('info');
  assert.equal(latin(src.subarray(s, e)), 'd5:filesld6:lengthi1e4:pathl1:aeee4:name1:xe');
  assert.deepEqual(encode(value.info), src.subarray(s, e));
  const [ns, ne] = spans.get('info.name');
  assert.equal(latin(src.subarray(ns, ne)), '1:x');
  assert.ok(spans.has('info.files'));
  assert.ok(!spans.has('info.files.0'), 'list elements are not recorded');
  assert.deepEqual(spans.get('announce'), [1 + 10, 1 + 10 + 5]);
});

test('bencode.decode: keys decode as UTF-8, values stay bytes; __proto__ stays an own key', () => {
  const src = encode({ ['caf' + String.fromCharCode(0xe9)]: 'v', __proto__x: 1 });
  const { value } = decode(src);
  assert.deepEqual(value['caf' + String.fromCharCode(0xe9)], te.encode('v'));
  const evil = bytes('d9:__proto__d1:ai1eee');
  const parsed = decode(evil).value;
  assert.ok(Object.prototype.hasOwnProperty.call(parsed, '__proto__'));
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype, 'prototype not replaced');
  assert.equal({}.a, undefined, 'no pollution');
});

test('bencode.decode: unsorted keys are tolerated (re-encoding sorts them)', () => {
  const src = bytes('d1:bi1e1:ai2ee');
  const { value } = decode(src);
  assert.deepEqual(Object.keys(value), ['b', 'a']);
  assert.notDeepEqual(encode(value), src);
});

test('bencode.decode: strict grammar', () => {
  const bad = [
    'i03e', 'i-0e', 'ie', 'i-e', 'i1', '03:abc', '4:abc', '-1:a', 'l', 'li1e', 'd1:a', 'd1:ai1e1:ai2ee',
    'di1ei2ee', 'x', '', 'i1ei2e', 'd1:ae', '1:', 'i12345678901234567890123', 'lee',
  ];
  for (const s of bad) {
    assert.throws(() => decode(bytes(s)), (err) => err.code === 'E_BENCODE', JSON.stringify(s));
  }
  assert.throws(() => decode(new Uint8Array([0x64, 0x32, 0x3a, 0xff, 0xfe, 0x69, 0x31, 0x65, 0x65])), /UTF-8/);
  assert.throws(() => decode('d1:ai1ee'), TypeError, 'strings are not bytes');
});

test('bencode.decode: nesting deeper than MAX_DEPTH is refused without a stack overflow', () => {
  const deep = 'l'.repeat(MAX_DEPTH + 2) + 'e'.repeat(MAX_DEPTH + 2);
  assert.throws(() => decode(bytes(deep)), /nesting/);
  const ok = 'l'.repeat(50) + 'e'.repeat(50);
  assert.doesNotThrow(() => decode(bytes(ok)));
  const huge = 'l'.repeat(200000);
  assert.throws(() => decode(bytes(huge)), /nesting/);
});

test('bencode: compareBytes and equalBytes', () => {
  assert.ok(compareBytes(bytes('a'), bytes('b')) < 0);
  assert.ok(compareBytes(bytes('ab'), bytes('a')) > 0);
  assert.equal(compareBytes(bytes('ab'), bytes('ab')), 0);
  assert.ok(equalBytes(bytes('xyz'), bytes('xyz')));
  assert.ok(!equalBytes(bytes('xyz'), bytes('xy')));
});
