// Unit tests for src/common/inflate.js (DEFLATE and gzip without DecompressionStream, code review round
// 1) and src/common/snapshot-read.js (capped snapshot reads in the shell and drop-in).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, deflateRawSync, constants } from 'node:zlib';

import { inflateRaw, gunzip, crc32 } from '../../src/common/inflate.js';
import { readSnapshot } from '../../src/common/snapshot-read.js';
import { readCappedBody } from '../../src/common/read-capped.js';

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

function samples() {
  const rand = mulberry32(42);
  const text = Buffer.from(JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ h: i.toString(16).padStart(64, '0'), e: { seq: i, op: { t: 'append', l: 'gb' } }, v: 'post ' + i }))));
  const random = Buffer.from(Array.from({ length: 70000 }, () => Math.floor(rand() * 256)));
  const repeats = Buffer.alloc(300000, 'abcabcabd');
  return { empty: Buffer.alloc(0), one: Buffer.from('x'), text, random, repeats };
}

test('inflateRaw and gunzip match node:zlib for stored, fixed and dynamic blocks', () => {
  for (const [name, data] of Object.entries(samples())) {
    for (const level of [0, 1, 6, 9]) {
      const raw = deflateRawSync(data, { level });
      assert.deepEqual(Buffer.from(inflateRaw(new Uint8Array(raw)).data), data, name + ' raw level ' + level);
      const gz = gzipSync(data, { level });
      assert.deepEqual(Buffer.from(gunzip(new Uint8Array(gz))), data, name + ' gzip level ' + level);
    }
    const fixed = deflateRawSync(data, { strategy: constants.Z_FIXED });
    assert.deepEqual(Buffer.from(inflateRaw(new Uint8Array(fixed)).data), data, name + ' fixed Huffman');
  }
});

test('gunzip: two members concatenate; CRC, size and truncation are checked; the output is capped', () => {
  const a = gzipSync(Buffer.from('hello '));
  const b = gzipSync(Buffer.from('world'));
  assert.equal(Buffer.from(gunzip(new Uint8Array(Buffer.concat([a, b])))).toString(), 'hello world');
  const bad = Buffer.from(a);
  bad[bad.length - 8] ^= 1;
  assert.throws(() => gunzip(new Uint8Array(bad)), { code: 'E_INFLATE' });
  assert.throws(() => gunzip(new Uint8Array(a.subarray(0, a.length - 3))), { code: 'E_INFLATE' });
  assert.throws(() => gunzip(new Uint8Array([1, 2, 3])), { code: 'E_INFLATE' });
  // A 1 KiB gzip of zeros inflating to 1 MiB is refused past the cap.
  const bomb = gzipSync(Buffer.alloc(1 << 20));
  assert.ok(bomb.length < 2048);
  assert.throws(() => gunzip(new Uint8Array(bomb), { maxOutput: 64 * 1024 }), /output larger/);
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

function fakeFetch(body, headers = {}) {
  return async () => ({ ok: true, status: 200, headers: { get: (k) => headers[k.toLowerCase()] || null }, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) });
}

test('readSnapshot: plain and gzip snapshots, with and without DecompressionStream; caps and timeout', async () => {
  const blocks = [{ h: 'a'.repeat(64) }, { h: 'b'.repeat(64) }];
  const json = Buffer.from(JSON.stringify(blocks));
  const gz = gzipSync(json);
  const base = { url: 'https://h.example/snap', maxBytes: 1 << 20, maxInflatedBytes: 1 << 20 };
  assert.deepEqual(await readSnapshot(Object.assign({ fetch: fakeFetch(json) }, base)), blocks);
  assert.deepEqual(await readSnapshot(Object.assign({ fetch: fakeFetch(gz) }, base)), blocks, 'gzip without DecompressionStream (Safari 15.4 to 16.3)');
  assert.deepEqual(await readSnapshot(Object.assign({ fetch: fakeFetch(gz), DecompressionStream, Blob }, base)), blocks, 'gzip with DecompressionStream');
  await assert.rejects(readSnapshot(Object.assign({ fetch: fakeFetch(json, { 'content-length': String(2 << 20) }) }, base)), { code: 'E_TOO_LARGE' });
  const bomb = gzipSync(Buffer.alloc(1 << 22, 32));
  await assert.rejects(readSnapshot(Object.assign({ fetch: fakeFetch(bomb) }, base)), { code: 'E_TOO_LARGE' }, 'inflate cap without DecompressionStream');
  await assert.rejects(readSnapshot(Object.assign({ fetch: fakeFetch(bomb), DecompressionStream, Blob }, base)), { code: 'E_TOO_LARGE' }, 'inflate cap with DecompressionStream');
  // A host that never answers: the timeout aborts the fetch.
  const hang = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  await assert.rejects(readSnapshot(Object.assign({ fetch: hang, timeoutMs: 20 }, base)), /aborted/);
});

test('readCappedBody: a stream past the cap is cancelled', async () => {
  let cancelled = false;
  let n = 0;
  const res = { headers: { get: () => null }, body: { getReader: () => ({ read: async () => (n++ < 4 ? { done: false, value: new Uint8Array(1000) } : { done: true }), cancel: async () => { cancelled = true; } }) } };
  assert.equal(await readCappedBody(res, 2500), null);
  assert.equal(cancelled, true);
});
