import test from 'node:test';
import assert from 'node:assert/strict';
import parseTorrent from 'parse-torrent';
import bencodePkg from 'bencode';
import {
  parseTorrentFile, pieceRangesForFile, sliceForPiece, buildSingleFileTorrent, sha1, MAX_PIECE_LENGTH,
} from '../../src/common/torrent-file.js';
import { encode, decode } from '../../src/common/bencode.js';
import { PIECE, makeBytes, sha1Hex, createTorrentAsync, threeFileSite, paddedTorrent } from './common-fixtures.test.mjs';

const te = new TextEncoder();
const hexOf = (u8) => Buffer.from(u8).toString('hex');

// Rebuild piece `index` from the files with sliceForPiece (pads as zeros).
function assemble(parsed, filesData, index) {
  const parts = sliceForPiece(parsed, index).map(({ fileIndex, start, end }) => {
    const f = parsed.files[fileIndex];
    return f.pad ? new Uint8Array(end - start) : filesData.get(f.path).subarray(start, end);
  });
  return Buffer.concat(parts.map((p) => Buffer.from(p)));
}

test('sha1: FIPS 180 vectors', async () => {
  assert.equal(hexOf(await sha1(te.encode('abc'))), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(hexOf(await sha1(new Uint8Array(0))), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
});

test('parseTorrentFile: 3-file torrent from create-torrent matches parse-torrent', async () => {
  const site = await threeFileSite();
  const ours = await parseTorrentFile(site.torrentFile);
  const theirs = await parseTorrent(site.torrentFile);
  assert.equal(ours.infoHash, theirs.infoHash);
  assert.equal(ours.infoHash, sha1Hex(ours.infoBytes));
  assert.equal(ours.name, 'site');
  assert.equal(ours.pieceLength, PIECE);
  assert.equal(ours.pieceCount, 3);
  assert.equal(ours.pieceCount, theirs.pieces.length);
  assert.equal(hexOf(ours.pieces), theirs.pieces.join(''));
  assert.equal(ours.length, 35000);
  assert.equal(ours.length, theirs.length);
  assert.equal(ours.lastPieceLength, theirs.lastPieceLength);
  assert.equal(ours.lastPieceLength, 35000 - 2 * PIECE);
  assert.equal(ours.multiFile, true);
  assert.equal(ours.private, false);
  assert.deepEqual(ours.announce, theirs.announce);
  assert.deepEqual(ours.urlList, theirs.urlList);
  assert.equal(ours.files.length, theirs.files.length);
  ours.files.forEach((f, i) => {
    assert.equal('site/' + f.path, theirs.files[i].path, 'site-relative path = parse-torrent path without the name prefix');
    assert.equal(f.length, theirs.files[i].length);
    assert.equal(f.offset, theirs.files[i].offset);
    assert.equal(f.pad, false);
  });
  assert.deepEqual(ours.files.map((f) => f.path), ['index.html', 'css/app.css', 'img/a.png']);
  // the info span is exactly the bytes parse-torrent re-encodes
  assert.deepEqual(ours.infoBytes, new Uint8Array(bencodePkg.encode(theirs.info)));
});

test('piece math: boundary-crossing pieces of the 3-file torrent', async () => {
  const site = await threeFileSite();
  const parsed = await parseTorrentFile(site.torrentFile);
  assert.deepEqual(pieceRangesForFile(parsed, 0), { first: 0, last: 0 });
  assert.deepEqual(pieceRangesForFile(parsed, 1), { first: 0, last: 1 });
  assert.deepEqual(pieceRangesForFile(parsed, 2), { first: 1, last: 2 });
  assert.deepEqual(sliceForPiece(parsed, 0), [
    { fileIndex: 0, start: 0, end: 10000 }, { fileIndex: 1, start: 0, end: 6384 },
  ]);
  assert.deepEqual(sliceForPiece(parsed, 1), [
    { fileIndex: 1, start: 6384, end: 20000 }, { fileIndex: 2, start: 0, end: 2768 },
  ]);
  assert.deepEqual(sliceForPiece(parsed, 2), [{ fileIndex: 2, start: 2768, end: 5000 }]);
  const data = new Map(site.files.map((f) => [f.path, f.data]));
  for (let i = 0; i < parsed.pieceCount; i++) {
    const piece = assemble(parsed, data, i);
    assert.equal(sha1Hex(piece), hexOf(parsed.pieces.subarray(i * 20, i * 20 + 20)), 'piece ' + i);
  }
  assert.throws(() => sliceForPiece(parsed, 3), RangeError);
  assert.throws(() => sliceForPiece(parsed, -1), RangeError);
  assert.throws(() => pieceRangesForFile(parsed, 9), RangeError);
});

test('parseTorrentFile: hand-built torrent with pad files (attr p and .pad/<n>)', async () => {
  const pt = paddedTorrent();
  const parsed = await parseTorrentFile(pt.torrentFile);
  assert.equal(parsed.infoHash, pt.infoHash);
  assert.equal(parsed.infoHash, (await parseTorrent(pt.torrentFile)).infoHash);
  assert.equal(parsed.name, 'padded');
  assert.deepEqual(parsed.files.map((f) => [f.path, f.length, f.offset, f.pad]), [
    ['a.txt', 10000, 0, false],
    ['.pad/6384', 6384, 10000, true],
    ['b.txt', 20000, 16384, false],
    ['.pad/12768', 12768, 36384, true],
    ['empty.txt', 0, 49152, false],
    ['c.txt', 100, 49152, false],
  ]);
  assert.equal(parsed.pieceCount, 4);
  assert.equal(parsed.lastPieceLength, 100);
  // b.txt starts a piece thanks to the pad; the pad covers the end of piece 0
  assert.deepEqual(sliceForPiece(parsed, 0), [{ fileIndex: 0, start: 0, end: 10000 }, { fileIndex: 1, start: 0, end: 6384 }]);
  assert.deepEqual(sliceForPiece(parsed, 2), [{ fileIndex: 2, start: 16384, end: 20000 }, { fileIndex: 3, start: 0, end: 12768 }]);
  assert.deepEqual(sliceForPiece(parsed, 3), [{ fileIndex: 5, start: 0, end: 100 }], 'zero-length files never appear');
  assert.deepEqual(pieceRangesForFile(parsed, 4), { first: 3, last: 2 }, 'a zero-length file covers no piece');
  assert.deepEqual(pieceRangesForFile(parsed, 5), { first: 3, last: 3 });
  const data = new Map(pt.files.filter((f) => !f.path[0].startsWith('.pad')).map((f) => [f.path.join('/'), f.data]));
  for (let i = 0; i < parsed.pieceCount; i++) {
    assert.equal(sha1Hex(assemble(parsed, data, i)), hexOf(parsed.pieces.subarray(i * 20, i * 20 + 20)), 'piece ' + i + ' with zero-filled pads');
  }
});

test('parseTorrentFile: single-file torrent uses the name as its path', async () => {
  const data = makeBytes(40000, 9);
  const b = Buffer.from(data);
  const tf = await createTorrentAsync(b, { name: 'movie.mp4', pieceLength: PIECE, announceList: [] });
  const parsed = await parseTorrentFile(tf);
  const theirs = await parseTorrent(tf);
  assert.equal(parsed.infoHash, theirs.infoHash);
  assert.equal(parsed.multiFile, false);
  assert.deepEqual(parsed.files, [{ path: 'movie.mp4', length: 40000, offset: 0, pad: false }]);
  assert.equal(theirs.files[0].path, 'movie.mp4');
  assert.deepEqual(parsed.announce, []);
});

test('buildSingleFileTorrent: anchor torrent infohash equals create-torrent for the same input', async () => {
  for (const ledgerId of ['mw1:3zyCQrvXtcZzsx0f6XI3yIsNbwY', 'btih:' + 'ab'.repeat(20)]) {
    const content = te.encode('mw-ledger/' + ledgerId);
    const ours = await buildSingleFileTorrent({ name: 'mw-ledger', content, pieceLength: 16384 });
    const ct = await createTorrentAsync(Buffer.from(content), { name: 'mw-ledger', pieceLength: 16384 });
    assert.equal(ours.infoHash, (await parseTorrent(ct)).infoHash);
    assert.equal(ours.infoHash, (await parseTorrent(ours.torrentFile)).infoHash, 'parse-torrent agrees on our bytes');
    const parsed = await parseTorrentFile(ours.torrentFile);
    assert.equal(parsed.infoHash, ours.infoHash);
    assert.deepEqual(parsed.files, [{ path: 'mw-ledger', length: content.length, offset: 0, pad: false }]);
    // deterministic: same input, same bytes
    const again = await buildSingleFileTorrent({ name: 'mw-ledger', content, pieceLength: 16384 });
    assert.deepEqual(again.torrentFile, ours.torrentFile);
  }
});

test('buildSingleFileTorrent: multi-piece content and announce keys outside info', async () => {
  const content = makeBytes(40000, 4);
  const plain = await buildSingleFileTorrent({ name: 'blob.bin', content, pieceLength: 16384 });
  const withTr = await buildSingleFileTorrent({ name: 'blob.bin', content, pieceLength: 16384, announce: ['wss://a.example', 'wss://b.example', 'wss://a.example'] });
  const ct = await createTorrentAsync(Buffer.from(content), { name: 'blob.bin', pieceLength: 16384 });
  assert.equal(plain.infoHash, (await parseTorrent(ct)).infoHash);
  assert.equal(withTr.infoHash, plain.infoHash);
  const parsed = await parseTorrentFile(withTr.torrentFile);
  assert.deepEqual(parsed.announce, ['wss://a.example', 'wss://b.example']);
  assert.equal(parsed.pieceCount, 3);
  await assert.rejects(buildSingleFileTorrent({ name: 'a/b', content, pieceLength: 16384 }), /invalid path segment/);
  await assert.rejects(buildSingleFileTorrent({ name: 'x', content, pieceLength: 0 }), TypeError);
});

async function rejectsBad(torrentValue, pattern) {
  const bytes = new Uint8Array(bencodePkg.encode(torrentValue));
  await assert.rejects(parseTorrentFile(bytes), (err) => err.code === 'E_BAD_TORRENT' && (!pattern || pattern.test(err.message)));
}

test('parseTorrentFile: refuses malformed and unsafe torrents', async () => {
  const pieces20 = Buffer.alloc(20);
  const okInfo = { name: 'site', 'piece length': PIECE, pieces: pieces20, files: [{ length: 5, path: ['a'] }] };
  await assert.rejects(parseTorrentFile(te.encode('not bencode')), (e) => e.code === 'E_BAD_TORRENT');
  await assert.rejects(parseTorrentFile('d4:infodee'), (e) => e.code === 'E_BAD_TORRENT');
  await rejectsBad({ announce: 'x' }, /missing info/);
  await rejectsBad({ info: { ...okInfo, name: undefined } }, /name/);
  await rejectsBad({ info: { ...okInfo, 'piece length': 0 } }, /piece length/);
  await rejectsBad({ info: { ...okInfo, 'piece length': MAX_PIECE_LENGTH * 2 } }, /piece length/);
  await rejectsBad({ info: { ...okInfo, pieces: Buffer.alloc(19) } }, /pieces/);
  await rejectsBad({ info: { ...okInfo, pieces: Buffer.alloc(40) } }, /piece count/);
  await rejectsBad({ info: { ...okInfo, files: [{ length: 5, path: ['..', 'etc'] }] } }, /path segment/);
  await rejectsBad({ info: { ...okInfo, files: [{ length: 5, path: ['a', ''] }] } }, /path segment/);
  await rejectsBad({ info: { ...okInfo, files: [{ length: 5, path: ['a/b'] }] } }, /path segment/);
  await rejectsBad({ info: { ...okInfo, files: [{ length: 5, path: ['a\\b'] }] } }, /path segment/);
  await rejectsBad({ info: { ...okInfo, files: [{ length: 2, path: ['a'] }, { length: 3, path: ['a'] }] } }, /duplicate/);
  await rejectsBad({ info: { ...okInfo, files: [{ length: -1, path: ['a'] }] } }, /length/);
  await rejectsBad({ info: { ...okInfo, files: [] } }, /files/);
  await rejectsBad({ info: { ...okInfo, length: 5 } }, /both/);
  await rejectsBad({ info: { ...okInfo, name: '..' } }, /path segment/);
  // non-canonical info (unsorted keys) would hash differently in WebTorrent: refused
  const raw = 'd4:infod4:name1:x12:piece lengthi16384e6:pieces20:' + 'a'.repeat(20) + '6:lengthi5eee';
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  assert.doesNotThrow(() => decode(bytes));
  await assert.rejects(parseTorrentFile(bytes), /canonical/);
});

test('parseTorrentFile: a pad-only duplicate path is allowed, url-list as a single string', async () => {
  const pieces = Buffer.alloc(20);
  const info = {
    name: 'p', 'piece length': PIECE, pieces,
    files: [{ length: 1, path: ['x'] }, { length: 1, path: ['.pad', '1'], attr: 'p' }, { length: 1, path: ['.pad', '1'], attr: 'p' }],
  };
  const tf = new Uint8Array(bencodePkg.encode({ info, 'url-list': 'https://ws.example/' }));
  const parsed = await parseTorrentFile(tf);
  assert.deepEqual(parsed.files.map((f) => f.pad), [false, true, true]);
  assert.deepEqual(parsed.urlList, ['https://ws.example/']);
  assert.equal(parsed.lastPieceLength, 3);
  // info re-encodes canonically with our encoder too
  assert.deepEqual(encode(decode(tf).value.info), parsed.infoBytes);
});
