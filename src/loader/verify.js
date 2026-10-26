// Verification of cached bytes before they are served or uploaded (ARCHITECTURE §7.3,
// DESIGN-REVIEW item 9): the infohash of a stored .torrent, and SHA-1 of every piece covering a
// file. Verified piece indices are memoised in memory only (a Set the caller owns), never
// persisted. Runs in windows, workers, the Service Worker and Node >= 22.

import { parseTorrentFile, sliceForPiece, pieceRangesForFile, sha1 } from '../common/torrent-file.js';
import { normalizeBtih } from '../common/magnet.js';

/** verifyInfoHash(torrentFile, btih) → true only if the .torrent parses and sha1(info) === btih. Never throws. */
export async function verifyInfoHash(torrentFile, btih) {
  const expected = normalizeBtih(btih);
  if (!expected) return false;
  try {
    const parsed = await parseTorrentFile(torrentFile);
    return parsed.infoHash === expected;
  } catch (_) {
    return false;
  }
}

function notFound(path) {
  const err = new Error('missing file data for ' + path);
  err.code = 'E_MISSING';
  err.notFound = true;
  return err;
}

// blobs: Map<path, Blob | Uint8Array | ArrayBuffer>, or a function (path) → one of those (or a
// Promise of one), so callers such as the Service Worker can load files lazily.
async function sourceFor(blobs, path) {
  if (!blobs) return null;
  if (typeof blobs === 'function') return (await blobs(path)) || null;
  if (typeof blobs.get === 'function') return blobs.get(path) || null;
  return null;
}

function sizeOf(source) {
  if (source instanceof Uint8Array) return source.length;
  if (source instanceof ArrayBuffer) return source.byteLength;
  if (ArrayBuffer.isView(source)) return source.byteLength;
  if (source && typeof source.size === 'number') return source.size;
  return -1;
}

async function readRange(source, start, end) {
  if (source instanceof Uint8Array) return source.subarray(start, end);
  if (source instanceof ArrayBuffer) return new Uint8Array(source, start, end - start);
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset + start, end - start);
  if (source && typeof source.slice === 'function') {
    const part = source.slice(start, end);
    if (typeof part.arrayBuffer === 'function') return new Uint8Array(await part.arrayBuffer());
    return new Uint8Array(await new Response(part).arrayBuffer()); // engines without Blob.arrayBuffer
  }
  throw new TypeError('unsupported file data source');
}

/** Length in bytes of piece `index` (the last piece is usually shorter). */
export function pieceSize(parsed, index) {
  return index === parsed.pieceCount - 1 ? parsed.lastPieceLength : parsed.pieceLength;
}

/**
 * readPieceRange(parsed, blobs, index, offset, length) → Uint8Array with bytes
 * [offset, offset + length) of piece `index`, assembled from the files it spans. Pad files read
 * as zeros. Throws (code 'E_MISSING') when a needed file is absent or has the wrong size.
 */
export async function readPieceRange(parsed, blobs, index, offset, length) {
  const size = pieceSize(parsed, index);
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > size) {
    throw new RangeError('readPieceRange: range outside piece ' + index);
  }
  const out = new Uint8Array(length);
  if (length === 0) return out;
  const pieceStart = index * parsed.pieceLength;
  const want0 = pieceStart + offset;
  const want1 = want0 + length;
  const reads = [];
  for (const s of sliceForPiece(parsed, index)) {
    const file = parsed.files[s.fileIndex];
    const abs0 = file.offset + s.start;
    const abs1 = file.offset + s.end;
    const lo = Math.max(abs0, want0);
    const hi = Math.min(abs1, want1);
    if (hi <= lo || file.pad) continue; // outside the wanted range, or zero-filled padding
    reads.push((async () => {
      const source = await sourceFor(blobs, file.path);
      if (!source || sizeOf(source) !== file.length) throw notFound(file.path);
      const bytes = await readRange(source, lo - file.offset, hi - file.offset);
      if (bytes.length !== hi - lo) throw notFound(file.path);
      out.set(bytes, lo - want0);
    })());
  }
  await Promise.all(reads);
  return out;
}

/** readPiece(parsed, blobs, index) → the whole piece (unverified). */
export function readPiece(parsed, blobs, index) {
  return readPieceRange(parsed, blobs, index, 0, pieceSize(parsed, index));
}

/** checkPiece(parsed, index, bytes) → true when sha1(bytes) equals the torrent's hash for that piece. */
export async function checkPiece(parsed, index, bytes) {
  if (bytes.length !== pieceSize(parsed, index)) return false;
  const digest = await sha1(bytes);
  const base = index * 20;
  for (let i = 0; i < 20; i++) {
    if (digest[i] !== parsed.pieces[base + i]) return false;
  }
  return true;
}

/** verifyPiece(parsed, blobs, index) → boolean; false also when data is missing. Never throws. */
export async function verifyPiece(parsed, blobs, index) {
  try {
    return await checkPiece(parsed, index, await readPiece(parsed, blobs, index));
  } catch (_) {
    return false;
  }
}

const pathIndexCache = new WeakMap();

/** Index of the non-pad file at site-relative `path` (one leading '/' tolerated), or -1. */
export function fileIndexForPath(parsed, path) {
  let map = pathIndexCache.get(parsed);
  if (!map) {
    map = new Map();
    parsed.files.forEach((f, i) => {
      if (!f.pad && !map.has(f.path)) map.set(f.path, i);
    });
    pathIndexCache.set(parsed, map);
  }
  const p = typeof path === 'string' && path.charAt(0) === '/' ? path.slice(1) : path;
  const i = map.get(p);
  return i === undefined ? -1 : i;
}

const CONCURRENCY = 4;

/**
 * verifyFile(parsed, blobs, path, verified) → boolean: SHA-1 of every piece covering the file
 * (pieces shared with neighbouring files included, so their bytes are needed too), skipping
 * pieces already in `verified` and adding the ones that pass. False for an unknown path, a pad
 * file, missing data, or any mismatch. A zero-length file is trivially verified.
 */
export async function verifyFile(parsed, blobs, path, verified) {
  const fileIndex = fileIndexForPath(parsed, path);
  if (fileIndex < 0) return false;
  const { first, last } = pieceRangesForFile(parsed, fileIndex);
  const todo = [];
  for (let i = first; i <= last; i++) if (!(verified && verified.has(i))) todo.push(i);
  let ok = true;
  let next = 0;
  const worker = async () => {
    while (ok && next < todo.length) {
      const index = todo[next++];
      if (await verifyPiece(parsed, blobs, index)) {
        if (verified) verified.add(index);
      } else {
        ok = false;
      }
    }
  };
  const workers = [];
  for (let w = 0; w < Math.min(CONCURRENCY, todo.length); w++) workers.push(worker());
  await Promise.all(workers);
  return ok;
}
