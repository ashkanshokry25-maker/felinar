// Shared fixtures for the common-* and loader-common-* tests (it is also a tiny test file itself,
// so `node --test test/unit` can pick it up harmlessly). Built with independent tools:
// create-torrent, the bencode package and node:crypto.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import createTorrent from 'create-torrent';
import bencodePkg from 'bencode';

export const PIECE = 16384;

export function makeBytes(n, seed) {
  const out = new Uint8Array(n);
  let x = (seed * 2654435761) >>> 0;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

export function sha1Hex(u8) {
  return createHash('sha1').update(u8).digest('hex');
}

export function createTorrentAsync(input, opts) {
  return new Promise((resolve, reject) => {
    createTorrent(input, opts, (err, buf) => (err ? reject(err) : resolve(new Uint8Array(buf))));
  });
}

/**
 * A 3-file site (10000 + 20000 + 5000 bytes, 16 KiB pieces): piece 0 spans index.html and the
 * start of css/app.css, piece 1 spans the end of css/app.css and the start of img/a.png, piece 2
 * (2232 bytes, the short last piece) is inside img/a.png.
 */
export async function threeFileSite({ announce = ['wss://tracker.example'], urlList = ['https://seed.example/ws/'] } = {}) {
  const files = [
    { path: 'index.html', data: makeBytes(10000, 1) },
    { path: 'css/app.css', data: makeBytes(20000, 2) },
    { path: 'img/a.png', data: makeBytes(5000, 3) },
  ];
  const input = files.map((f) => {
    const b = Buffer.from(f.data);
    b.name = 'site/' + f.path;
    b.fullPath = 'site/' + f.path;
    return b;
  });
  const torrentFile = await createTorrentAsync(input, {
    pieceLength: PIECE, announceList: announce.map((u) => [u]), urlList, createdBy: 'test', creationDate: new Date(1700000000000),
  });
  return { name: 'site', files, torrentFile, pieceLength: PIECE };
}

/**
 * A torrent with BEP 47 pad files, encoded by hand with the bencode package:
 *   a.txt 10000, pad (attr p, path .pad/6384), b.txt 20000, pad (path .pad/12768, no attr),
 *   empty.txt 0, c.txt 100.  Pads align b.txt and c.txt to piece boundaries.
 */
export function paddedTorrent() {
  const files = [
    { path: ['a.txt'], data: makeBytes(10000, 11) },
    { path: ['.pad', '6384'], data: new Uint8Array(6384), attr: 'p' },
    { path: ['b.txt'], data: makeBytes(20000, 12) },
    { path: ['.pad', '12768'], data: new Uint8Array(12768) },
    { path: ['empty.txt'], data: new Uint8Array(0) },
    { path: ['c.txt'], data: makeBytes(100, 13) },
  ];
  const all = Buffer.concat(files.map((f) => Buffer.from(f.data)));
  const hashes = [];
  for (let off = 0; off < all.length; off += PIECE) {
    hashes.push(createHash('sha1').update(all.subarray(off, Math.min(off + PIECE, all.length))).digest());
  }
  const info = {
    name: 'padded',
    'piece length': PIECE,
    pieces: Buffer.concat(hashes),
    files: files.map((f) => (f.attr ? { length: f.data.length, path: f.path, attr: f.attr } : { length: f.data.length, path: f.path })),
  };
  const torrentFile = new Uint8Array(bencodePkg.encode({ announce: 'wss://t.example', info }));
  const infoHash = createHash('sha1').update(bencodePkg.encode(info)).digest('hex');
  return { torrentFile, infoHash, files, all: new Uint8Array(all), pieceLength: PIECE };
}

/** Map<site path, Blob> for non-pad files. */
export function blobMap(files) {
  const m = new Map();
  for (const f of files) {
    const path = Array.isArray(f.path) ? f.path.join('/') : f.path;
    if (path.startsWith('.pad/')) continue;
    m.set(path, new Blob([f.data]));
  }
  return m;
}

// Registered only when this file is the test entry point, not when another test imports it.
const isEntry = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) test('fixtures: deterministic bytes and torrents', async () => {
  assert.deepEqual(makeBytes(16, 5), makeBytes(16, 5));
  assert.notDeepEqual(makeBytes(16, 5), makeBytes(16, 6));
  const a = await threeFileSite();
  const b = await threeFileSite();
  assert.deepEqual(a.torrentFile, b.torrentFile);
  assert.equal(paddedTorrent().infoHash.length, 40);
});
