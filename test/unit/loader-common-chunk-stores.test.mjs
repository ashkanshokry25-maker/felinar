import test from 'node:test';
import assert from 'node:assert/strict';
// webtorrent pulls in webrtc-polyfill and the native node-datachannel binding, which a clean install never has
// (install scripts stay off): stub WebRTC first, then load webtorrent (see no-native-webrtc.mjs).
import './no-native-webrtc.mjs';
import { MemoryChunkStore } from '../../src/loader/memory-chunk-store.js';
import { BlobChunkStore } from '../../src/loader/blob-chunk-store.js';
import { parseTorrentFile } from '../../src/common/torrent-file.js';
import { threeFileSite, paddedTorrent, blobMap, PIECE } from './common-fixtures.test.mjs';

const { default: WebTorrent } = await import('webtorrent');

const call = (fn) => new Promise((resolve, reject) => fn((err, value) => (err ? reject(err) : resolve(value))));
const get = (store, index, opts) => call((cb) => (opts === undefined ? store.get(index, cb) : store.get(index, opts, cb)));
const put = (store, index, buf) => call((cb) => store.put(index, buf, cb));
const hex = (u8) => Buffer.from(u8).toString('hex');

function concatFiles(files) {
  return new Uint8Array(Buffer.concat(files.map((f) => Buffer.from(f.data))));
}

// ------------------------------------------------------------------------------------------
// MemoryChunkStore
// ------------------------------------------------------------------------------------------

test('MemoryChunkStore: put/get, the last chunk is shorter, lengths enforced', async () => {
  const s = new MemoryChunkStore(10, { length: 25 });
  assert.equal(s.chunkLength, 10);
  assert.equal(s.lastChunkIndex, 2);
  assert.equal(s.lastChunkLength, 5);
  await put(s, 0, new Uint8Array(10).fill(1));
  await put(s, 1, new Uint8Array(10).fill(2));
  await put(s, 2, new Uint8Array(5).fill(3));
  assert.deepEqual(await get(s, 2), new Uint8Array(5).fill(3));
  await assert.rejects(put(s, 2, new Uint8Array(10)), /Last chunk length must be 5/);
  await assert.rejects(put(s, 1, new Uint8Array(5)), /Chunk length must be 10/);
  await assert.rejects(put(s, 3, new Uint8Array(10)), /out of range/);
  await assert.rejects(put(s, -1, new Uint8Array(10)), /out of range/);
  await assert.rejects(put(s, 0, 'nope'), /Uint8Array/);
});

test('MemoryChunkStore: offsets, length 0 means to the end, bounds, not-found', async () => {
  const s = new MemoryChunkStore(8, { length: 16 });
  const data = Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
  await put(s, 0, data);
  assert.deepEqual(await get(s, 0, { offset: 2, length: 3 }), Uint8Array.from([2, 3, 4]));
  assert.deepEqual(await get(s, 0, { offset: 5 }), Uint8Array.from([5, 6, 7]));
  assert.deepEqual(await get(s, 0, { offset: 6, length: 0 }), Uint8Array.from([6, 7]));
  assert.deepEqual(await get(s, 0, null), data);
  await assert.rejects(get(s, 0, { offset: 6, length: 4 }), /out of bounds/);
  await assert.rejects(get(s, 1), (err) => err.notFound === true);
});

test('MemoryChunkStore: unknown total length, asynchronous callbacks, close/destroy', async () => {
  const s = new MemoryChunkStore(4);
  assert.equal(s.length, Infinity);
  await put(s, 7, new Uint8Array(4));
  let sync = true;
  const p = new Promise((resolve) => s.get(7, () => resolve(sync)));
  sync = false;
  assert.equal(await p, false, 'callbacks never run synchronously');
  await call((cb) => s.destroy(cb));
  await assert.rejects(get(s, 7), /closed/);
  await assert.rejects(put(s, 0, new Uint8Array(4)), /closed/);
  await assert.rejects(call((cb) => s.close(cb)), /closed/);
  assert.throws(() => new MemoryChunkStore(0), /chunk length/);
  // WebTorrent passes more keys than we use
  const w = new MemoryChunkStore(16384, { torrent: {}, files: [], length: 16385, name: 'x', addUID: false, max: 20 });
  assert.equal(w.lastChunkLength, 1);
});

// ------------------------------------------------------------------------------------------
// BlobChunkStore
// ------------------------------------------------------------------------------------------

test('BlobChunkStore: whole pieces across 3 files, the short last piece, ranges inside pieces', async () => {
  const site = await threeFileSite();
  const parsed = await parseTorrentFile(site.torrentFile);
  const all = concatFiles(site.files);
  const store = new BlobChunkStore(PIECE, { parsed, blobs: blobMap(site.files) });
  assert.equal(store.length, 35000);
  assert.equal(store.lastChunkLength, 35000 - 2 * PIECE);
  for (let i = 0; i < parsed.pieceCount; i++) {
    const piece = await get(store, i);
    assert.equal(hex(piece), hex(all.subarray(i * PIECE, Math.min((i + 1) * PIECE, all.length))), 'piece ' + i);
  }
  assert.deepEqual([...store.verifiedPieces].sort(), [0, 1, 2]);
  // a range of piece 1 that crosses the css/app.css → img/a.png boundary (at piece offset 13616)
  const cross = await get(store, 1, { offset: 13000, length: 2000 });
  assert.equal(hex(cross), hex(all.subarray(PIECE + 13000, PIECE + 15000)));
  // WebTorrent's 16 KiB block requests and the last-piece read used by _verifyPiece
  assert.equal((await get(store, 2, { length: parsed.lastPieceLength })).length, parsed.lastPieceLength);
  await assert.rejects(get(store, 2, { offset: 0, length: PIECE }), /out of bounds/);
  await assert.rejects(get(store, 3), (err) => err.notFound === true);
});

test('BlobChunkStore: verifies each piece once, then reads only the requested range', async () => {
  const site = await threeFileSite();
  const parsed = await parseTorrentFile(site.torrentFile);
  const map = blobMap(site.files);
  const reads = [];
  const lazy = async (path) => {
    reads.push(path);
    return map.get(path);
  };
  const store = new BlobChunkStore(PIECE, { parsed, blobs: lazy });
  const [a, b] = await Promise.all([get(store, 0, { offset: 0, length: 100 }), get(store, 0, { offset: 100, length: 100 })]);
  assert.equal(a.length, 100);
  assert.equal(b.length, 100);
  assert.deepEqual(reads.sort(), ['css/app.css', 'index.html'], 'concurrent first reads share one verification');
  assert.ok(store.verifiedPieces.has(0));
  reads.length = 0;
  await get(store, 0, { offset: 0, length: 100 });
  assert.deepEqual(reads, ['index.html'], 'a verified piece reads only the files under the range');
});

test('BlobChunkStore: a flipped byte makes the piece fail and it is never returned', async () => {
  const site = await threeFileSite();
  const parsed = await parseTorrentFile(site.torrentFile);
  const map = blobMap(site.files);
  const css = new Uint8Array(site.files[1].data);
  css[7000] ^= 0x01; // inside piece 1 (file offset 10000 + 7000 = 17000)
  map.set('css/app.css', new Blob([css]));
  const failed = [];
  const store = new BlobChunkStore(PIECE, { parsed, blobs: map, onVerifyFailed: (i) => failed.push(i) });
  await assert.rejects(get(store, 1, { offset: 0, length: 16 }), (err) => err.message === 'piece verification failed' && err.code === 'E_VERIFY' && err.index === 1);
  await assert.rejects(get(store, 1), /piece verification failed/, 'fails fast the second time');
  assert.deepEqual(failed, [1], 'reported once');
  assert.ok(!store.verifiedPieces.has(1));
  assert.ok((await get(store, 0)).length === PIECE, 'piece 0 (untouched part of the file) is fine');
  assert.ok((await get(store, 2)).length > 0);
  // verify:false is the caller's explicit opt-out: bytes pass unchecked
  const unchecked = new BlobChunkStore(PIECE, { parsed, blobs: map, verify: false });
  assert.equal((await get(unchecked, 1)).length, PIECE);
});

test('BlobChunkStore: pad files read as zeros and verify; zero-length files are skipped', async () => {
  const pt = paddedTorrent();
  const parsed = await parseTorrentFile(pt.torrentFile);
  const map = blobMap(pt.files);
  assert.ok(![...map.keys()].some((k) => k.startsWith('.pad/')), 'no Blob for pad files');
  const store = new BlobChunkStore(PIECE, { parsed, blobs: map });
  for (let i = 0; i < parsed.pieceCount; i++) {
    const piece = await get(store, i);
    assert.equal(hex(piece), hex(pt.all.subarray(i * PIECE, Math.min((i + 1) * PIECE, pt.all.length))));
  }
  assert.equal(store.verifiedPieces.size, parsed.pieceCount);
});

test('BlobChunkStore: missing or wrong-size data, misuse, close', async () => {
  const site = await threeFileSite();
  const parsed = await parseTorrentFile(site.torrentFile);
  const map = blobMap(site.files);
  map.delete('img/a.png');
  const store = new BlobChunkStore(PIECE, { parsed, blobs: map });
  await assert.rejects(get(store, 2), (err) => err.code === 'E_MISSING' && err.notFound === true);
  const short = blobMap(site.files);
  short.set('index.html', new Blob([new Uint8Array(9999)]));
  await assert.rejects(get(new BlobChunkStore(PIECE, { parsed, blobs: short }), 0), /missing file data for index.html/);
  assert.throws(() => new BlobChunkStore(PIECE * 2, { parsed, blobs: map }), /piece length/);
  assert.throws(() => new BlobChunkStore(PIECE, { blobs: map }), TypeError);
  await put(store, 0, new Uint8Array(PIECE)); // ignored, never an error
  await call((cb) => store.close(cb));
  await assert.rejects(get(store, 0), /closed/);
  await assert.rejects(put(store, 0, new Uint8Array(PIECE)), /closed/);
});

// ------------------------------------------------------------------------------------------
// with WebTorrent 3.0.21 itself (Node, two clients over loopback TCP, no trackers, no DHT)
// ------------------------------------------------------------------------------------------

const WT_OPTS = { dht: false, tracker: false, lsd: false, utp: false, natUpnp: false, natPmp: false, webSeeds: false };

async function seedAndFetch(site, blobs, { waitMs = 15000, onVerifyFailed } = {}) {
  const parsed = await parseTorrentFile(site.torrentFile);
  const seeder = new WebTorrent(WT_OPTS);
  const leecher = new WebTorrent(WT_OPTS);
  const store = new BlobChunkStore(parsed.pieceLength, { parsed, blobs, onVerifyFailed });
  const ta = seeder.add(site.torrentFile, { preloadedStore: store, skipVerify: true, private: true });
  await new Promise((resolve) => (seeder.listening ? resolve() : seeder.once('listening', resolve)));
  const tb = leecher.add(site.torrentFile, { store: MemoryChunkStore, private: true });
  tb.once('ready', () => tb.addPeer('127.0.0.1:' + seeder.torrentPort));
  const done = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), waitMs);
    tb.once('done', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  return { parsed, seeder, leecher, ta, tb, store, done };
}

function destroyAll(...clients) {
  return Promise.all(clients.map((c) => new Promise((resolve) => c.destroy(() => resolve()))));
}

test('WebTorrent seeds from BlobChunkStore (preloadedStore + skipVerify) into MemoryChunkStore', { timeout: 30000 }, async () => {
  const site = await threeFileSite({ announce: [], urlList: [] });
  const { seeder, leecher, ta, tb, store, done } = await seedAndFetch(site, blobMap(site.files));
  try {
    assert.equal(done, true);
    assert.equal(ta.infoHash, tb.infoHash);
    for (const file of tb.files) {
      const got = new Uint8Array(await file.arrayBuffer());
      const want = site.files.find((f) => 'site/' + f.path === file.path).data;
      assert.equal(hex(got), hex(want), file.path);
    }
    assert.equal(store.verifiedPieces.size, 3, 'every uploaded piece was verified first');
  } finally {
    await destroyAll(seeder, leecher);
  }
});

test('WebTorrent never uploads a cached piece that fails verification', { timeout: 30000 }, async () => {
  const site = await threeFileSite({ announce: [], urlList: [] });
  const map = blobMap(site.files);
  const css = new Uint8Array(site.files[1].data);
  css[100] ^= 0xff; // piece 0
  map.set('css/app.css', new Blob([css]));
  const failed = [];
  const { seeder, leecher, tb, done } = await seedAndFetch(site, map, { waitMs: 2500, onVerifyFailed: (i) => failed.push(i) });
  try {
    assert.equal(done, false, 'the download cannot complete');
    assert.equal(tb.bitfield.get(0), false, 'the bad piece never arrived');
    assert.equal(tb.bitfield.get(2), true, 'good pieces still flow');
    assert.ok(failed.includes(0));
  } finally {
    await destroyAll(seeder, leecher);
  }
});
