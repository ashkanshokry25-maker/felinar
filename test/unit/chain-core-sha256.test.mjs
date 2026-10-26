// Unit tests for src/chain/sha256-sync.js (pure-JS SHA-256 used for mining and DAG digests).
// WebCrypto (crypto.subtle) is the oracle; node:crypto only cross-checks the long vector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Sync, sha256Midstate, sha256Resume } from '../../src/chain/sha256-sync.js';
import { hex, utf8 } from '../../src/chain/canonical.js';

const subtle = globalThis.crypto.subtle;

async function subtleHex(bytes) {
  return hex.encode(new Uint8Array(await subtle.digest('SHA-256', bytes)));
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBytes(rand, n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(rand() * 256);
  return out;
}

test('sha256Sync: FIPS 180-4 / NIST vectors', () => {
  const vectors = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
    ['abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1'],
  ];
  for (const [msg, want] of vectors) {
    assert.equal(hex.encode(sha256Sync(utf8.encode(msg))), want, JSON.stringify(msg));
    assert.equal(hex.encode(sha256Sync(msg)), want, 'string input is hashed as UTF-8');
  }
  const million = new Uint8Array(1000000).fill(0x61);
  assert.equal(hex.encode(sha256Sync(million)), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
  assert.equal(hex.encode(sha256Sync(million)), createHash('sha256').update(million).digest('hex'));
});

test('sha256Sync matches crypto.subtle on 200 random inputs, including block-boundary sizes', async () => {
  const rand = mulberry32(0x5eed256);
  const sizes = [0, 1, 2, 31, 32, 33, 55, 56, 57, 63, 64, 65, 111, 112, 119, 120, 127, 128, 129, 1000];
  while (sizes.length < 200) sizes.push(Math.floor(rand() * 2048));
  assert.equal(sizes.length, 200);
  for (const n of [0, 55, 56, 64, 1000]) assert.ok(sizes.includes(n), 'covers size ' + n);
  for (const n of sizes) {
    const bytes = randomBytes(rand, n);
    const digest = sha256Sync(bytes);
    assert.ok(digest instanceof Uint8Array);
    assert.equal(digest.length, 32);
    assert.equal(hex.encode(digest), await subtleHex(bytes), 'length ' + n);
  }
});

test('sha256Sync: input forms and fresh output buffers', async () => {
  const rand = mulberry32(7);
  const bytes = randomBytes(rand, 300);
  const want = await subtleHex(bytes);
  assert.equal(hex.encode(sha256Sync(bytes.buffer)), want, 'ArrayBuffer');
  assert.equal(hex.encode(sha256Sync(new DataView(bytes.buffer))), want, 'DataView');
  const padded = new Uint8Array(310);
  padded.set(bytes, 5);
  assert.equal(hex.encode(sha256Sync(padded.subarray(5, 305))), want, 'offset view hashes only its window');
  // Non-ASCII text is UTF-8 encoded (built with fromCharCode so the file stays ASCII).
  const text = 'caf' + String.fromCharCode(0xe9) + ' ' + String.fromCharCode(0x2603);
  assert.equal(hex.encode(sha256Sync(text)), await subtleHex(utf8.encode(text)));
  const a = sha256Sync(bytes);
  const b = sha256Sync(new Uint8Array(1));
  assert.notEqual(a, b, 'every call returns its own buffer');
  assert.equal(hex.encode(a), want, 'an earlier digest is not overwritten by later calls');
  assert.throws(() => sha256Sync(123), TypeError);
  assert.throws(() => sha256Sync(null), TypeError);
});

test('sha256Midstate + sha256Resume equal the one-shot digest for every split', async () => {
  const rand = mulberry32(99);
  for (const total of [0, 10, 63, 64, 65, 127, 128, 200, 640, 1000]) {
    const bytes = randomBytes(rand, total);
    const want = await subtleHex(bytes);
    for (const cut of [0, 1, 55, 63, 64, 65, 128, 129, 300, total]) {
      if (cut > total) continue;
      const mid = sha256Midstate(bytes.subarray(0, cut));
      assert.equal(mid.length % 64, 0);
      assert.equal(mid.length, cut - (cut % 64), 'only whole blocks are consumed');
      const out = new Uint8Array(32);
      const got = sha256Resume(mid, bytes.subarray(mid.length), out);
      assert.equal(got, out, 'writes into the given buffer');
      assert.equal(hex.encode(got), want, `total ${total} cut ${cut}`);
      // The midstate is reusable: a second resume gives the same digest.
      assert.equal(hex.encode(sha256Resume(mid, bytes.subarray(mid.length))), want);
    }
  }
  const mid = sha256Midstate('x'.repeat(130));
  assert.equal(mid.length, 128);
  assert.equal(hex.encode(sha256Resume(mid, 'xx')), await subtleHex(utf8.encode('x'.repeat(130))));
});

test('sha256Resume rejects malformed midstates and output buffers', () => {
  assert.throws(() => sha256Resume(null, new Uint8Array(0)), TypeError);
  assert.throws(() => sha256Resume({ state: new Int32Array(8), length: 3 }, new Uint8Array(0)), TypeError);
  assert.throws(() => sha256Resume({ state: new Int32Array(7), length: 0 }, new Uint8Array(0)), TypeError);
  assert.throws(() => sha256Resume(sha256Midstate(''), new Uint8Array(0), new Uint8Array(16)), TypeError);
});
