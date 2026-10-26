import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode } from '../../src/common/base32.js';

const te = new TextEncoder();

test('base32: RFC 4648 section 10 vectors, lowercase and unpadded', () => {
  const vectors = [['', ''], ['f', 'my'], ['fo', 'mzxq'], ['foo', 'mzxw6'], ['foob', 'mzxw6yq'], ['fooba', 'mzxw6ytb'], ['foobar', 'mzxw6ytboi']];
  for (const [plain, enc] of vectors) {
    assert.equal(encode(te.encode(plain)), enc);
    assert.deepEqual(decode(enc), te.encode(plain));
    assert.deepEqual(decode(enc.toUpperCase()), te.encode(plain), 'upper case accepted');
  }
});

test('base32: padding tolerated on decode, never emitted', () => {
  assert.deepEqual(decode('MZXW6YQ='), te.encode('foob'));
  assert.deepEqual(decode('my======'), te.encode('f'));
  assert.ok(!encode(te.encode('f')).includes('='));
});

test('base32: round trip of random lengths', () => {
  for (let n = 0; n < 70; n++) {
    const bytes = new Uint8Array(n).map((_, i) => (i * 97 + n * 13) & 255);
    const s = encode(bytes);
    assert.match(s, /^[a-z2-7]*$/);
    assert.equal(s.length, Math.ceil((n * 8) / 5));
    assert.deepEqual(decode(s), bytes);
  }
});

test('base32: a 20-byte btih is exactly 32 characters', () => {
  const btih = new Uint8Array(20).fill(0xab);
  assert.equal(encode(btih).length, 32);
});

test('base32: strict decoding', () => {
  assert.throws(() => decode('m1'), TypeError, 'digit 1 is not in the alphabet');
  assert.throws(() => decode('mzx'), TypeError, 'impossible length (3 mod 8)');
  assert.throws(() => decode('m'), TypeError, 'impossible length (1 mod 8)');
  assert.throws(() => decode('mz'), TypeError, 'non-zero trailing bits ("mz" is not canonical for one byte)');
  assert.throws(() => decode('mzxé'), TypeError);
  assert.throws(() => decode(42), TypeError);
  assert.throws(() => encode('foo'), TypeError);
});
