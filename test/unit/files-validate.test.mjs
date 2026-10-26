// Unit tests for src/files/validate.js (R 2.8.3, MF-55; U-FI-1), src/files/preview.js and
// src/media/sniff.js (R 2.8.5, MF-51; U-FI-3: preview sniffing, the 24-megapixel header cap, SVG,
// PDF and HTML never preview, risk tiers by magic bytes), src/files/names.js (U-FI-4: bidi, control
// characters, NFC, the extension shown last), the incremental SHA-256 and the chunk store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { validateFileTorrent, validateInfo, checkTorrentBytes, createSha256, LIMITS } from '../../src/files/validate.js';
import { previewPlan, imageSize, riskTier, PIXEL_CAP, RISK_WARNING, VERIFIED_TEXT, fitWithin } from '../../src/files/preview.js';
import { sniff, mediaType, SNIFF_BYTES } from '../../src/media/sniff.js';
import { cleanName, splitName, displayParts, randomName, downloadName } from '../../src/files/names.js';
import { IdbChunkStore, memoryBackend } from '../../src/files/store-idb.js';
import { encode } from '../../src/common/bencode.js';

const te = new TextEncoder();
const sha1 = (u8) => new Uint8Array(createHash('sha1').update(u8).digest());

function torrent({ length = 100000, pieceLength = 16384, name = 'file.bin', extra = {}, info = null, files = null } = {}) {
  const count = Math.ceil(length / pieceLength);
  const i = info || Object.assign({ length, name: te.encode(name), 'piece length': pieceLength, pieces: new Uint8Array(count * 20) }, extra);
  if (files) {
    delete i.length;
    i.files = files;
  }
  return encode({ info: i });
}

// ---------------------------------------------------------------------------------------------- U-FI-1

test('U-FI-1 a valid single-file torrent passes and its infohash is computed', async () => {
  const t = torrent();
  const r = await validateFileTorrent(t, { length: 100000 });
  assert.equal(r.length, 100000);
  assert.equal(r.pieceLength, 16384);
  assert.equal(r.pieceCount, 7);
  assert.match(r.infoHash, /^[0-9a-f]{40}$/);
  await validateFileTorrent(t, { length: 100000, infoHash: r.infoHash });
  await assert.rejects(validateFileTorrent(t, { length: 100000, infoHash: 'f'.repeat(40) }), (e) => e.code === 'E_FILE_HASH' && e.reason === 'infohash');
});

test('U-FI-1 every metadata rule: one file, the listed length, piece length, piece count, no pad files or paths, 256 KiB', async () => {
  const bad = async (bytes, reason, opts = { length: 100000 }) => assert.rejects(validateFileTorrent(bytes, opts), (e) => e.code === 'E_FILE_HASH' && e.reason === reason, reason);
  await bad(torrent({ files: [{ length: 50000, path: [te.encode('a')] }, { length: 50000, path: [te.encode('b')] }] }), 'files');
  await bad(torrent({ files: [{ length: 100000, path: [te.encode('a')] }] }), 'files');
  await bad(torrent({ extra: { attr: te.encode('p') } }), 'files');
  await bad(torrent({ length: 100001 }), 'length', { length: 100000 });
  await bad(torrent(), 'length', { length: 100000, maxBytes: 99999 });
  await bad(torrent({ pieceLength: 8192 }), 'piece-length');
  await bad(torrent({ pieceLength: 8 * 1024 * 1024, length: 100000 }), 'piece-length');
  // 16,385 pieces need 327,700 bytes of hashes: the 256 KiB .torrent cap binds first (about 13,100 pieces),
  // so the piece-count rule is checked on the info dictionary itself
  await bad(torrent({ length: 16385 * 16384, pieceLength: 16384 }), 'torrent-size', { length: 16385 * 16384 });
  assert.throws(() => validateInfo({ length: 16385 * 16384, name: te.encode('x'), 'piece length': 16384, pieces: new Uint8Array(16385 * 20) }, { length: 16385 * 16384 }), (e) => e.reason === 'pieces');
  await bad(torrent({ info: { length: 100000, name: te.encode('x'), 'piece length': 16384, pieces: new Uint8Array(6 * 20) } }), 'pieces');
  await bad(torrent({ name: 'dir/file.bin' }), 'path');
  await bad(torrent({ name: '..' }), 'path');
  const big = encode({ info: { length: 100000, name: te.encode('x'), 'piece length': 16384, pieces: new Uint8Array(140) }, comment: new Uint8Array(LIMITS.maxTorrentBytes) });
  await bad(big, 'torrent-size');
  assert.throws(() => checkTorrentBytes(new Uint8Array(0)), (e) => e.reason === 'torrent-size');
  await bad(torrent(), 'nonce', { length: 100000, privateSwarm: true });
  const withNonce = torrent({ extra: { 'x-mw-nonce': new Uint8Array(16) } });
  assert.equal((await validateFileTorrent(withNonce, { length: 100000, privateSwarm: true })).length, 100000);
  assert.throws(() => validateInfo({ length: 1, name: te.encode('a'), 'piece length': 16384, pieces: new Uint8Array(20) }, { length: 1, pieceLength: 65536 }), (e) => e.reason === 'piece-length');
  assert.equal(LIMITS.maxPieces, 16384);
});

// ---------------------------------------------------------------------------------------------- sniff and U-FI-3

const PNG = (w, h) => {
  const u = new Uint8Array(33);
  u.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 0);
  new DataView(u.buffer).setUint32(16, w);
  new DataView(u.buffer).setUint32(20, h);
  return u;
};
// A GIF head: the logical screen, then (review round, MAL53-2) the first Image Descriptor, which a decoder grows the screen to.
const GIF = (w, h) => new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0, 0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0]);
const JPEG = (w, h) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
const WEBP_X = (w, h) => {
  const u = new Uint8Array(30);
  u.set(te.encode('RIFF'), 0);
  u.set(te.encode('WEBPVP8X'), 8);
  const a = w - 1;
  const b = h - 1;
  u.set([a & 255, (a >> 8) & 255, (a >> 16) & 255, b & 255, (b >> 8) & 255, (b >> 16) & 255], 24);
  return u;
};
const ascii = (s) => te.encode(s);

test('sniff: magic bytes decide; names never matter; media allow-list; E_MEDIA_TYPE outside it', () => {
  const cases = [
    [PNG(1, 1), 'image/png', 'image'], [GIF(1, 1), 'image/gif', 'image'], [JPEG(1, 1), 'image/jpeg', 'image'], [WEBP_X(1, 1), 'image/webp', 'image'],
    [ascii('\0\0\0\x18ftypisom\0\0\x02\0isomiso2'), 'video/mp4', 'video'], [ascii('\0\0\0\x14ftypqt  \0\0\x02\0qt  '), 'video/quicktime', 'video'],
    [ascii('\0\0\0\x18ftypheic\0\0\0\0mif1heic'), 'image/heic', 'image'],
    [new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 1, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]), 'video/webm', 'video'],
    [ascii('%PDF-1.7\n'), 'application/pdf', 'pdf'], [ascii('<!DOCTYPE html><p>x'), 'text/html', 'html'], [ascii('  <svg xmlns="x">'), 'image/svg+xml', 'svg'],
    [ascii('<?xml version="1.0"?><svg>'), 'image/svg+xml', 'svg'], [ascii('MZ\x90\0'), 'application/x-msdownload', 'executable'],
    [new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2]), 'application/x-executable', 'executable'], [new Uint8Array([0xcf, 0xfa, 0xed, 0xfe]), 'application/x-mach-binary', 'executable'],
    [ascii('#!/bin/sh\nrm -rf'), 'text/x-script', 'script'], [ascii('PK\x03\x04\x14\0'), 'application/zip', 'archive'],
    [new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'application/x-ole-storage', 'macro'], [ascii('{\\rtf1'), 'application/rtf', 'macro'],
    [ascii('hello, world\n'), 'text/plain', 'text'], [new Uint8Array([0, 1, 2, 3, 250]), 'application/octet-stream', 'unknown'],
    [ascii('xar!\0\x1c'), 'application/x-xar', 'installer'],
  ];
  for (const [bytes, mime, kind] of cases) {
    const s = sniff(bytes);
    assert.equal(s.mime, mime, mime);
    assert.equal(s.kind, kind, mime);
  }
  assert.equal(sniff(ascii('MZ')).tier, 'confirm');
  assert.equal(sniff(ascii('PK\x03\x04')).tier, 'confirm');
  assert.equal(sniff(PNG(1, 1)).tier, 'plain');
  assert.equal(mediaType(JPEG(2, 2)).media, true);
  assert.throws(() => mediaType(ascii('<svg>')), (e) => e.code === 'E_MEDIA_TYPE');
  assert.throws(() => mediaType(ascii('\0\0\0\x18ftypheic\0\0\0\0mif1heic')), (e) => e.code === 'E_MEDIA_TYPE', 'HEIC converts, it is not media as is');
  assert.equal(SNIFF_BYTES, 4096);
});

test('U-FI-3 preview: PNG, JPEG, GIF, WebP and UTF-8 text only; the header-first 24-megapixel cap; SVG, PDF and HTML never', () => {
  assert.deepEqual(imageSize(PNG(640, 480), 'image/png'), { w: 640, h: 480 });
  assert.deepEqual(imageSize(GIF(300, 200), 'image/gif'), { w: 300, h: 200 });
  assert.deepEqual(imageSize(JPEG(1024, 768), 'image/jpeg'), { w: 1024, h: 768 });
  assert.deepEqual(imageSize(WEBP_X(5000, 4000), 'image/webp'), { w: 5000, h: 4000 });
  assert.equal(previewPlan(PNG(640, 480)).kind, 'image');
  assert.equal(previewPlan(JPEG(6000, 4000)).kind, 'image', '24 MP exactly is allowed');
  const bomb = previewPlan(PNG(65535, 65535));
  assert.deepEqual([bomb.kind, bomb.reason], ['none', 'too-large'], 'a decode bomb is refused from the header');
  assert.equal(previewPlan(JPEG(6001, 4000)).reason, 'too-large');
  assert.equal(previewPlan(GIF(10000, 10000)).reason, 'too-large');
  assert.equal(previewPlan(WEBP_X(6000, 4001)).reason, 'too-large');
  assert.equal(PIXEL_CAP, 24000000);
  for (const never of ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', '%PDF-1.4\n', '<!doctype html><script>alert(1)</script>', '<html><body>', '<?xml version="1.0"?><svg/>']) {
    assert.equal(previewPlan(ascii(never)).kind, 'none', never);
  }
  assert.equal(previewPlan(ascii('just text, été\n')).kind, 'text');
  assert.equal(previewPlan(new Uint8Array([0xc3, 0x28, 0x41])).kind, 'none', 'invalid UTF-8');
  assert.equal(previewPlan(ascii('\0\0\0\x18ftypheic\0\0\0\0mif1heic')).kind, 'none', 'HEIC: no preview for this format');
  assert.equal(previewPlan(PNG(0, 10)).reason, 'header');
  assert.deepEqual(fitWithin(4000, 3000, 1024), { w: 1024, h: 768 });
  assert.deepEqual(fitWithin(100, 50, 640), { w: 100, h: 50 });
});

test('risk tiers: executables, installers, scripts, macro documents and archives need a second confirmation; owners may block a kind', () => {
  for (const b of [ascii('MZ'), ascii('#!/usr/bin/env python'), ascii('PK\x03\x04'), new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), ascii('xar!')]) {
    const r = riskTier(sniff(b));
    assert.equal(r.tier, 'confirm', r.kind);
    assert.equal(r.warning, RISK_WARNING);
  }
  assert.equal(riskTier(sniff(PNG(1, 1))).tier, 'plain');
  assert.equal(riskTier(sniff(ascii('MZ')), ['executable']).tier, 'blocked');
  assert.equal(VERIFIED_TEXT, 'The bytes match what the sender listed. This does not mean the file is safe.');
});

// ---------------------------------------------------------------------------------------------- U-FI-4

test('U-FI-4 names: bidi and control characters stripped, NFC, path characters replaced, the extension shown last', () => {
  assert.equal(cleanName('invoice\u202Etxt.exe'), 'invoicetxt.exe');
  assert.equal(cleanName('a\u2066b\u2069c\u200Fd\u061Ce'), 'abcde');
  assert.equal(cleanName('zero\u200Bwidth\uFEFF.txt'), 'zerowidth.txt');
  assert.equal(cleanName('line\u2028break\r\n.txt'), 'linebreak.txt');
  assert.equal(cleanName('Cafe\u0301.txt'), 'Caf\u00e9.txt', 'NFC');
  assert.equal(cleanName('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(cleanName('...hidden'), 'hidden');
  assert.equal(cleanName('C:\\x\\y.bat'), 'C__x_y.bat');
  assert.equal(cleanName('a'.repeat(200) + '.jpeg').length, 96);
  assert.ok(cleanName('a'.repeat(200) + '.jpeg').endsWith('.jpeg'), 'the extension survives truncation');
  assert.deepEqual(splitName('photo.final.JPG'), { base: 'photo.final', ext: 'jpg' });
  assert.deepEqual(splitName('.bashrc'), { base: '.bashrc', ext: '' });
  const p = displayParts('holiday.jpg', sniff(ascii('MZ\x90')));
  assert.equal(p.mismatch, true);
  assert.equal(p.ext, 'jpg');
  assert.equal(p.sniffedMime, 'application/x-msdownload');
  assert.equal(downloadName('holiday.jpg', sniff(ascii('MZ\x90'))), 'holiday.jpg.exe', 'a renamed executable is never saved as a photo');
  assert.equal(downloadName('holiday.JPEG', sniff(JPEG(1, 1))), 'holiday.JPEG');
  assert.equal(displayParts('notes.md', sniff(ascii('# notes'))).mismatch, false);
  assert.match(randomName('image', 'jpg'), /^photo-[a-z2-7]{4}\.jpg$/);
  assert.match(randomName('video', 'mp4'), /^video-[a-z2-7]{4}\.mp4$/);
  assert.match(randomName('other', ''), /^file-[a-z2-7]{4}$/);
  assert.equal(randomName('image', 'jpg', (n) => new Uint8Array(n)), 'photo-aaaa.jpg');
});

// ---------------------------------------------------------------------------------------------- hashing and storage

test('createSha256: incremental updates of any size equal the one-shot digest', () => {
  let seed = 1;
  for (const n of [0, 1, 55, 56, 63, 64, 65, 1000, 100000]) {
    const data = new Uint8Array(n).map(() => (seed = (seed * 48271) % 2147483647) & 255);
    const h = createSha256();
    let o = 0;
    while (o < n) {
      const step = Math.min(n - o, 1 + ((o * 7) % 300));
      h.update(data.subarray(o, o + step));
      o += step;
    }
    assert.equal(h.hex(), createHash('sha256').update(data).digest('hex'), 'size ' + n);
  }
  const h = createSha256();
  h.digest();
  assert.throws(() => h.update(new Uint8Array(1)));
});

test('IdbChunkStore (memory backend): abstract-chunk-store put/get, lengths enforced, missing, destroy, factory', async () => {
  const backend = memoryBackend();
  const store = new IdbChunkStore(4, { name: 'ih1', length: 10, backend });
  const put = (i, b) => new Promise((resolve) => store.put(i, b, resolve));
  const get = (i, o) => new Promise((resolve) => store.get(i, o, (err, buf) => resolve({ err, buf })));
  assert.equal(await put(0, new Uint8Array([1, 2, 3, 4])), null);
  assert.match((await put(1, new Uint8Array(3))).message, /Chunk length/);
  assert.equal(await put(2, new Uint8Array([9, 9])), null, 'the last chunk is shorter');
  assert.match((await put(3, new Uint8Array(4))).message, /out of range/);
  assert.deepEqual((await get(0)).buf, new Uint8Array([1, 2, 3, 4]));
  assert.deepEqual((await get(0, { offset: 1, length: 2 })).buf, new Uint8Array([2, 3]));
  assert.equal((await get(1)).err.notFound, true);
  assert.deepEqual(await store.missing(), [1]);
  assert.equal(await store.complete(), false);
  await put(1, new Uint8Array(4));
  assert.equal(await store.complete(), true);
  const Bound = IdbChunkStore.factory({ name: 'ih1', backend });
  const again = new Bound(4, { length: 10 });
  assert.deepEqual(await again.getAsync(2), new Uint8Array([9, 9]), 'a store keeps its chunks across instances (rebuild, reload)');
  await new Promise((resolve) => store.destroy(resolve));
  assert.equal(await again.getAsync(0), undefined);
  assert.throws(() => new IdbChunkStore(4, { backend }), /name/);
  void sha1;
});
