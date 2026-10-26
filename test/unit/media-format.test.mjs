// Unit tests for src/media/format.js and src/media/pad.js (R 2.9.5; U-MD-1 media vectors with the
// reordered, truncated and cross-file negatives; U-MD-2 bucket arithmetic and padding chunks that
// cannot be told from data chunks) and for src/files/encrypt.js (the F2 STREAM records of R 2.8.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import {
  plan, encryptChunk, decryptChunk, nonceFor, aadFor, REGION, PIECE_LARGE, PIECE_SMALL, TAG_BYTES,
  buildManifest, checkManifest, regionOf, partInfo, chunkSpan, newSecrets, idOf,
} from '../../src/media/format.js';
import { bucketBytes, isBucket, recordsFor, LARGE_MIN } from '../../src/media/pad.js';
import { encryptStream, decryptStream, streamPlan, RECORD_BYTES, RECORD_PAYLOAD } from '../../src/files/encrypt.js';
import { hex } from '../../src/chain/canonical.js';

const V = JSON.parse(readFileSync(new URL('../vectors/media.json', import.meta.url), 'utf8'));
const byId = (id) => V.vectors.find((v) => v.id === id);
const sha = (u8) => createHash('sha256').update(u8).digest('hex');

function pattern(C, len, i) {
  const o = new Uint8Array(C);
  for (let j = 0; j < len; j++) o[j] = (j * 31 + i * 7 + 1) & 255;
  return o;
}

test('PIECE_LARGE and PIECE_SMALL; the R 2.9.5 worked example (20 MiB + 48 KiB poster: 82 chunks, 88 pieces, 23,068,672 bytes)', () => {
  assert.equal(PIECE_LARGE, 262144);
  assert.equal(PIECE_SMALL, 65536);
  const p = plan({ posterBytes: 48 * 1024, mediaBytes: 20 * 1024 * 1024 });
  assert.equal(p.P, 262144);
  assert.equal(p.C, 262128);
  assert.equal(p.chunks, 82);
  assert.equal(p.chunks * p.P, 21495808, 'data chunks take 21,495,808 bytes');
  assert.equal(p.total, 88);
  assert.equal(p.paddedBytes, 23068672);
  assert.equal(p.paddedBytes, 2 ** 24 * 1.375);
  assert.deepEqual(p.regions, { poster: [0, 1], media: [1, 82] });
  assert.equal(p.total - p.chunks, 6, 'six padding pieces');
  const plain = 20971520 + 49152;
  assert.equal(((p.paddedBytes - plain) / plain * 100).toFixed(1), '9.7', 'padding overhead 9.7 percent of the plaintext');
  assert.equal(p.total * 20, 1760, 'piece hashes: 88 x 20 bytes');
});

test('U-MD-2 plan vectors and bucket vectors', () => {
  for (const v of V.vectors.filter((x) => x.id.startsWith('media-plan-'))) {
    assert.deepEqual(plan(v.input), v.expect, v.id);
  }
  for (const [n, b] of byId('media-bucket-001').buckets) assert.equal(bucketBytes(n), b, 'bucket of ' + n);
});

test('U-MD-2 bucket arithmetic: below 12.5 percent of padding at or above 2 MiB, whole pieces, powers of two below', () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let k = 0; k < 2000; k++) {
    const n = Math.floor(LARGE_MIN + rnd() * 200 * 1024 * 1024);
    const b = bucketBytes(n);
    assert.ok(b >= n);
    assert.ok((b - n) / b < 0.125, 'padding below 12.5 percent for ' + n);
    assert.equal(b % PIECE_LARGE, 0, 'a whole number of 256 KiB pieces');
    assert.ok(isBucket(b));
    assert.equal(bucketBytes(b), b, 'a bucket is its own bucket');
  }
  for (let k = 0; k < 500; k++) {
    const n = Math.floor(rnd() * LARGE_MIN);
    const b = bucketBytes(n);
    assert.ok(b >= Math.max(n, 65536));
    assert.equal(b & (b - 1), 0, 'a power of two below 2 MiB');
    assert.equal(b % PIECE_SMALL, 0);
  }
  assert.equal(recordsFor(1, 65536), 1);
  assert.throws(() => bucketBytes(-1), RangeError);
  assert.throws(() => plan({ mediaBytes: 4 * 1024 * 1024 * 1024 }), (e) => e.code === 'E_LIMIT', 'over 16,384 pieces');
  for (let k = 0; k < 300; k++) {
    const p = plan({ posterBytes: Math.floor(rnd() * 200000), mediaBytes: Math.floor(rnd() * 30 * 1024 * 1024) });
    assert.equal(p.paddedBytes, p.total * p.P);
    assert.equal(p.P, p.paddedBytes >= LARGE_MIN ? PIECE_LARGE : PIECE_SMALL, 'P follows the padded size');
    assert.ok(p.chunks <= p.total);
  }
});

test('U-MD-1 chunk vectors: nonces, AAD, ciphertext digests; every chunk opens to its plaintext', async () => {
  const v = byId('media-chunks-001');
  const fk = hex.decode(v.keys.fk);
  const base = hex.decode(v.keys.base);
  const fid = hex.decode(v.keys.fid);
  const C = v.plan.P - TAG_BYTES;
  assert.deepEqual(plan({ posterBytes: 100, mediaBytes: C + 10 }), v.plan);
  for (const c of v.chunks) {
    assert.equal(hex.encode(nonceFor(base, c.i)), c.nonce, 'nonce ' + c.i);
    assert.equal(hex.encode(aadFor(fid, c.i, v.plan.total, c.region)), c.aad, 'aad ' + c.i);
    assert.equal(c.aad.slice(0, 22), hex.encode(new TextEncoder().encode('mw-media-v1')));
    const ct = await encryptChunk(fk, base, fid, c.i, v.plan.total, c.region, pattern(C, c.dataBytes, c.i));
    assert.equal(ct.length, v.plan.P, 'exactly one piece');
    assert.equal(sha(ct), c.ctSha256, 'ciphertext ' + c.i);
    assert.equal(hex.encode(ct.subarray(0, 32)), c.ctHead);
    assert.equal(hex.encode(ct.subarray(ct.length - 16)), c.tag);
    const pt = await decryptChunk(fk, base, fid, c.i, v.plan.total, c.region, ct);
    assert.deepEqual(pt, pattern(C, c.dataBytes, c.i));
  }
});

test('U-MD-1 negatives: reordered, truncated, cross-file and wrong-region chunks fail with E_DECRYPT', async () => {
  const v = byId('media-chunks-001');
  const fk = hex.decode(v.keys.fk);
  const base = hex.decode(v.keys.base);
  const fid = hex.decode(v.keys.fid);
  const C = v.plan.P - TAG_BYTES;
  const cts = [];
  for (const c of v.chunks) cts.push(await encryptChunk(fk, base, fid, c.i, v.plan.total, c.region, pattern(C, c.dataBytes, c.i)));
  const negatives = V.vectors.filter((x) => x.id.startsWith('media-negative-'));
  assert.equal(negatives.length, 4);
  for (const n of negatives) {
    await assert.rejects(decryptChunk(fk, base, hex.decode(n.as.fid), n.as.i, n.as.total, n.as.region, cts[n.from]), (e) => e.code === n.expect, n.id);
  }
  const flipped = cts[1].slice();
  flipped[100] ^= 1;
  await assert.rejects(decryptChunk(fk, base, fid, 1, v.plan.total, REGION.media, flipped), (e) => e.code === 'E_DECRYPT', 'a flipped bit');
  await assert.rejects(decryptChunk(fk, base, fid, 1, v.plan.total, REGION.media, cts[1].subarray(0, 1000)), (e) => e.code === 'E_DECRYPT', 'a short chunk');
  const otherKey = fk.slice();
  otherKey[0] ^= 1;
  await assert.rejects(decryptChunk(otherKey, base, fid, 1, v.plan.total, REGION.media, cts[1]), (e) => e.code === 'E_DECRYPT', 'another key');
});

test('U-MD-2 padding chunks look like data chunks: same size, no structure, byte frequencies alike', async () => {
  const s = newSecrets();
  const p = plan({ posterBytes: 0, mediaBytes: 3 * 65520 });
  assert.ok(p.total > p.chunks, 'this plan has padding');
  const zeros = new Uint8Array(p.C);
  const data = new Uint8Array(p.C); // all-zero media: the worst case for telling regions apart
  const pad = await encryptChunk(s.fk, s.base, s.fid, p.total - 1, p.total, REGION.pad, zeros);
  const dat = await encryptChunk(s.fk, s.base, s.fid, 0, p.total, REGION.media, data);
  assert.equal(pad.length, dat.length);
  const freq = (u8) => {
    const f = new Array(256).fill(0);
    for (const b of u8) f[b]++;
    let chi = 0;
    const e = u8.length / 256;
    for (const x of f) chi += (x - e) * (x - e) / e;
    return chi;
  };
  assert.ok(freq(pad) < 400 && freq(dat) < 400, 'both look uniform (chi-square over 255 degrees of freedom)');
  assert.notEqual(sha(pad), sha(dat));
  assert.deepEqual(await decryptChunk(s.fk, s.base, s.fid, p.total - 1, p.total, REGION.pad, pad), zeros);
});

test('manifest: the vector checks; regionOf, partInfo, chunkSpan (offset to chunk); idOf', () => {
  const M = byId('media-manifest-001').manifest;
  assert.equal(checkManifest(M), M);
  assert.equal(regionOf(M, 0), REGION.poster);
  assert.equal(regionOf(M, 1), REGION.media);
  assert.equal(regionOf(M, 2), REGION.media);
  assert.equal(regionOf(M, 3), REGION.pad);
  assert.throws(() => regionOf(M, 4), RangeError);
  assert.deepEqual(partInfo(M, 'poster'), { first: 0, end: 1, size: 100, mime: 'image/jpeg' });
  assert.deepEqual(partInfo(M, 'media'), { first: 1, end: 3, size: 65530, mime: 'video/mp4' });
  assert.deepEqual(chunkSpan(M, 'media', 0, 1), { first: 1, last: 1, skip: 0 });
  assert.deepEqual(chunkSpan(M, 'media', 65519, 65520), { first: 1, last: 2, skip: 65519 });
  assert.deepEqual(chunkSpan(M, 'media', 65525, 65529), { first: 2, last: 2, skip: 5 });
  assert.throws(() => chunkSpan(M, 'media', 0, 65530), RangeError);
  assert.equal(idOf(M).length, 32);
  for (const [field, value] of [['v', 2], ['total', 5], ['P', 1000], ['ih', 'x'], ['extra', 1], ['len', 200000], ['kind', 'audio']]) {
    const bad = JSON.parse(JSON.stringify(M));
    bad[field] = value;
    assert.throws(() => checkManifest(bad), (e) => e.code === 'E_DECRYPT', field);
  }
  const rebuilt = buildManifest(Object.assign({}, M));
  assert.deepEqual(rebuilt, M);
});

test('newSecrets: fid 16, fk 32, base 8, swarmNonce 16 random bytes, different every time', () => {
  const a = newSecrets();
  const b = newSecrets();
  assert.deepEqual([a.fid.length, a.fk.length, a.base.length, a.swarmNonce.length], [16, 32, 8, 16]);
  assert.notDeepEqual(a.fk, b.fk);
});

// ------------------------------------------------------------------------------------- files/encrypt.js

function streamOf(bytes, piece = 7777) {
  let off = 0;
  return new ReadableStream({
    pull(c) {
      if (off >= bytes.length) return c.close();
      c.enqueue(bytes.slice(off, off + piece));
      off += piece;
    },
  });
}

async function collect(stream) {
  const reader = stream.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    n += value.length;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

test('F2 STREAM records: round trip at several sizes, padded to the bucket, nothing in the clear', async () => {
  const fk = newSecrets().fk;
  for (const n of [0, 1, RECORD_PAYLOAD - 8, RECORD_PAYLOAD - 7, 3 * RECORD_PAYLOAD + 5, 300000]) {
    const pt = new Uint8Array(n);
    for (let i = 0; i < n; i++) pt[i] = (i * 13) & 255;
    const ct = await collect(await encryptStream(streamOf(pt), fk, { length: n }));
    assert.equal(ct.length % RECORD_BYTES, 0);
    assert.equal(ct.length, streamPlan(n).bytes);
    assert.equal(ct.length, bucketBytes(ct.length), 'the ciphertext is a bucket');
    const back = await collect(await decryptStream(streamOf(ct, 10000), fk));
    assert.deepEqual(back, pt, 'size ' + n);
  }
});

test('F2 STREAM records: truncation, reordering, extension and another key fail with E_DECRYPT', async () => {
  const fk = newSecrets().fk;
  const pt = new Uint8Array(3 * RECORD_PAYLOAD);
  const ct = await collect(await encryptStream(streamOf(pt), fk, { length: pt.length }));
  const recs = ct.length / RECORD_BYTES;
  assert.ok(recs >= 4);
  const fail = async (bytes, why, key = fk) => assert.rejects(collect(await decryptStream(streamOf(bytes), key)), (e) => e.code === 'E_DECRYPT', why);
  await fail(ct.subarray(0, ct.length - RECORD_BYTES), 'one record short (no final record)');
  const swapped = ct.slice();
  swapped.set(ct.subarray(RECORD_BYTES, 2 * RECORD_BYTES), 0);
  swapped.set(ct.subarray(0, RECORD_BYTES), RECORD_BYTES);
  await fail(swapped, 'records swapped');
  const longer = new Uint8Array(ct.length + RECORD_BYTES);
  longer.set(ct, 0);
  longer.set(ct.subarray(0, RECORD_BYTES), ct.length);
  await fail(longer, 'a record after the final one');
  await fail(ct.subarray(0, ct.length - 5), 'a partial record');
  const other = fk.slice();
  other[3] ^= 1;
  await fail(ct, 'another key', other);
});
