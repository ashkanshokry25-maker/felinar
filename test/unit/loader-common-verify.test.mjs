import test from 'node:test';
import assert from 'node:assert/strict';
import bencodePkg from 'bencode';
import {
  verifyInfoHash, verifyFile, verifyPiece, readPiece, readPieceRange, checkPiece, pieceSize, fileIndexForPath,
} from '../../src/loader/verify.js';
import { parseTorrentFile } from '../../src/common/torrent-file.js';
import { encode as b32 } from '../../src/common/base32.js';
import { threeFileSite, paddedTorrent, blobMap, makeBytes, createTorrentAsync, PIECE } from './common-fixtures.test.mjs';

test('verifyInfoHash: sha1(info) against the btih from the pointer', async () => {
  const site = await threeFileSite();
  const parsed = await parseTorrentFile(site.torrentFile);
  assert.equal(await verifyInfoHash(site.torrentFile, parsed.infoHash), true);
  assert.equal(await verifyInfoHash(site.torrentFile, parsed.infoHash.toUpperCase()), true);
  assert.equal(await verifyInfoHash(site.torrentFile, b32(Buffer.from(parsed.infoHash, 'hex'))), true);
  assert.equal(await verifyInfoHash(site.torrentFile, 'f'.repeat(40)), false);
  assert.equal(await verifyInfoHash(site.torrentFile, 'nope'), false);
  assert.equal(await verifyInfoHash(new TextEncoder().encode('garbage'), parsed.infoHash), false);
  const tampered = new Uint8Array(site.torrentFile);
  const at = Buffer.from(tampered).indexOf('6:pieces');
  tampered[at + 12] ^= 1; // inside the piece hashes, so inside info
  assert.equal(await verifyInfoHash(tampered, parsed.infoHash), false);
  // bytes outside info (announce, url-list) do not change the infohash
  const reannounced = await createTorrentAsync(site.files.map((f) => Object.assign(Buffer.from(f.data), { fullPath: 'site/' + f.path })),
    { pieceLength: PIECE, announceList: [['wss://other.example']] });
  assert.equal(await verifyInfoHash(reannounced, parsed.infoHash), true);
  // a non-canonical info dictionary is refused even if its raw bytes hash to the btih
  const raw = 'd4:infod4:name1:x12:piece lengthi16384e6:pieces20:' + 'a'.repeat(20) + '6:lengthi5eee';
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  const infoRaw = bytes.subarray(7, bytes.length - 1);
  const { createHash } = await import('node:crypto');
  assert.equal(await verifyInfoHash(bytes, createHash('sha1').update(infoRaw).digest('hex')), false);
});

test('verifyFile: every piece covering the file, memoised in the caller Set', async () => {
  const site = await threeFileSite();
  const parsed = await parseTorrentFile(site.torrentFile);
  const map = blobMap(site.files);
  let reads = 0;
  const lazy = (path) => {
    reads++;
    return Promise.resolve(map.get(path));
  };
  const verified = new Set();
  assert.equal(await verifyFile(parsed, lazy, 'css/app.css', verified), true);
  assert.deepEqual([...verified].sort(), [0, 1], 'app.css spans pieces 0 and 1');
  const before = reads;
  assert.equal(await verifyFile(parsed, lazy, 'index.html', verified), true, 'piece 0 already verified');
  assert.equal(reads, before, 'no reads for memoised pieces');
  assert.equal(await verifyFile(parsed, map, '/img/a.png', verified), true, 'Map source, leading slash tolerated');
  assert.deepEqual([...verified].sort(), [0, 1, 2]);
  assert.equal(await verifyFile(parsed, map, 'missing.html', new Set()), false);
  assert.equal(await verifyFile(parsed, map, 'index.html', null), true, 'no memo Set is fine');
});

test('verifyFile: a flipped byte fails every file that shares the bad piece', async () => {
  const site = await threeFileSite();
  const parsed = await parseTorrentFile(site.torrentFile);
  const map = blobMap(site.files);
  const css = new Uint8Array(site.files[1].data);
  css[10] ^= 0x80; // piece 0, shared with index.html
  map.set('css/app.css', new Blob([css]));
  const verified = new Set();
  assert.equal(await verifyFile(parsed, map, 'index.html', verified), false);
  assert.equal(await verifyFile(parsed, map, 'css/app.css', verified), false);
  assert.equal(await verifyFile(parsed, map, 'img/a.png', verified), true);
  assert.ok(!verified.has(0));
  assert.deepEqual([...verified].sort(), [1, 2]);
  map.delete('img/a.png');
  assert.equal(await verifyFile(parsed, map, 'css/app.css', new Set([0])), false, 'missing neighbour data fails closed');
});

test('verifyFile: pad files are never servable, zero-length files are trivially fine', async () => {
  const pt = paddedTorrent();
  const parsed = await parseTorrentFile(pt.torrentFile);
  const map = blobMap(pt.files);
  const verified = new Set();
  for (const path of ['a.txt', 'b.txt', 'c.txt', 'empty.txt']) assert.equal(await verifyFile(parsed, map, path, verified), true, path);
  assert.equal(await verifyFile(parsed, map, '.pad/6384', verified), false);
  assert.equal(fileIndexForPath(parsed, '.pad/6384'), -1);
  assert.equal(fileIndexForPath(parsed, 'b.txt'), 2);
});

test('readPieceRange, readPiece, checkPiece, verifyPiece, pieceSize', async () => {
  const site = await threeFileSite();
  const parsed = await parseTorrentFile(site.torrentFile);
  const map = blobMap(site.files);
  assert.equal(pieceSize(parsed, 0), PIECE);
  assert.equal(pieceSize(parsed, 2), 35000 - 2 * PIECE);
  const piece = await readPiece(parsed, map, 1);
  assert.equal(await checkPiece(parsed, 1, piece), true);
  assert.equal(await checkPiece(parsed, 0, piece), false);
  assert.equal(await checkPiece(parsed, 2, piece), false, 'wrong length');
  const part = await readPieceRange(parsed, map, 1, 13600, 32);
  assert.deepEqual(part, piece.subarray(13600, 13632));
  assert.equal((await readPieceRange(parsed, map, 1, 5, 0)).length, 0);
  await assert.rejects(readPieceRange(parsed, map, 2, 0, PIECE), RangeError);
  assert.equal(await verifyPiece(parsed, map, 2), true);
  assert.equal(await verifyPiece(parsed, new Map(), 2), false, 'never throws');
  // Uint8Array and ArrayBuffer sources work like Blobs
  const bytesMap = new Map(site.files.map((f) => [f.path, f.data]));
  assert.equal(await verifyPiece(parsed, bytesMap, 0), true);
  const bufMap = new Map(site.files.map((f) => [f.path, f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.length)]));
  assert.equal(await verifyPiece(parsed, bufMap, 1), true);
});

test('verifyFile: a 2 MB file at 256 KiB pieces (debug-panel budget is 50 ms on desktop)', async (t) => {
  const data = makeBytes(2 * 1024 * 1024 + 123, 77);
  const tf = await createTorrentAsync([Object.assign(Buffer.from(data), { fullPath: 'site/big.js' }), Object.assign(Buffer.from('x'), { fullPath: 'site/x.txt' })],
    { pieceLength: 262144 });
  const parsed = await parseTorrentFile(tf);
  const map = new Map([['big.js', new Blob([data])], ['x.txt', new Blob(['x'])]]);
  const t0 = performance.now();
  assert.equal(await verifyFile(parsed, map, 'big.js', new Set()), true);
  const ms = performance.now() - t0;
  t.diagnostic('verifyFile 2 MiB: ' + ms.toFixed(1) + ' ms');
  assert.ok(ms < 2000, 'sanity bound only; the real budget is measured in browsers');
  assert.equal(bencodePkg.decode(tf).info['piece length'], 262144);
});
