// .torrent parsing and piece math (BitTorrent v1, BEP 3 with BEP 47 pad files), plus the
// deterministic single-file "anchor" torrent of ARCHITECTURE §5.5. Shared by Node >= 22 and
// browsers: crypto.subtle for SHA-1, Uint8Array only (no Buffer, no node: imports).
//
// Paths are site-relative: for a multi-file torrent the torrent name (the directory every
// BitTorrent client prefixes) is NOT part of `path`; for a single-file torrent the path is the
// name. WebTorrent's `file.path` is `<name>/<path>` for multi-file torrents (see
// cache.js siteRelativePath for the mapping back).

import { decode, encode, equalBytes } from './bencode.js';
import { hex, asBytes } from '../chain/canonical.js';

/** Largest accepted piece length (32 MiB): every verifier reads one whole piece into memory. */
export const MAX_PIECE_LENGTH = 32 * 1024 * 1024;
/** Largest accepted file count; a site this size is far beyond every byte cap anyway. */
export const MAX_FILES = 100000;

const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const utf8Lenient = new TextDecoder('utf-8', { ignoreBOM: true });

function badTorrent(message) {
  const err = new Error('invalid torrent: ' + message);
  err.code = 'E_BAD_TORRENT';
  return err;
}

function isDict(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array);
}

function isSafeUint(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function text(bytes, what) {
  if (!(bytes instanceof Uint8Array)) throw badTorrent(what + ' is not a byte string');
  try {
    return utf8Strict.decode(bytes);
  } catch (_) {
    throw badTorrent(what + ' is not valid UTF-8');
  }
}

// One path segment as it may appear in a site URL: no separators, no NUL, never '.' or '..'.
function checkSegment(seg, what) {
  if (seg === '' || seg === '.' || seg === '..' || /[/\\\0]/.test(seg)) {
    throw badTorrent(what + ' has an invalid path segment ' + JSON.stringify(seg));
  }
  return seg;
}

/** sha1(u8) → Uint8Array(20) via WebCrypto. */
export async function sha1(u8) {
  const bytes = asBytes(u8);
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-1', bytes));
}

function uniqueStrings(list) {
  const out = [];
  const seen = new Set();
  for (const s of list) {
    if (typeof s !== 'string' || !s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function lenientText(v) {
  return v instanceof Uint8Array ? utf8Lenient.decode(v).trim() : null;
}

/**
 * parseTorrentFile(u8) → { infoHash, name, pieceLength, pieces, pieceCount, length,
 *   lastPieceLength, files: [{ path, length, offset, pad }], announce, urlList, infoBytes,
 *   multiFile, private }
 *
 * infoHash = hex(sha1(infoBytes)) where infoBytes are the original bytes of the `info` value.
 * The info dictionary must be canonically encoded (sorted keys, canonical integers), so the
 * hash equals what parse-torrent/WebTorrent compute by re-encoding it. Files keep the order of
 * `info.files`; offsets are cumulative and include pad files (BEP 47: attr containing 'p', or a
 * path of the form `.pad/<n>`), which are flagged `pad: true` and must never be served.
 * Throws an Error with code 'E_BAD_TORRENT' for anything malformed or unsafe.
 */
export async function parseTorrentFile(u8) {
  let bytes;
  try {
    bytes = asBytes(u8);
  } catch (_) {
    throw badTorrent('expected bytes');
  }
  let decoded;
  try {
    decoded = decode(bytes);
  } catch (err) {
    throw badTorrent(err.message);
  }
  const root = decoded.value;
  if (!isDict(root)) throw badTorrent('root is not a dictionary');
  const info = root.info;
  if (!isDict(info)) throw badTorrent('missing info dictionary');
  const span = decoded.spans.get('info');
  const infoBytes = bytes.slice(span[0], span[1]);
  if (!equalBytes(encode(info), infoBytes)) throw badTorrent('info dictionary is not canonically encoded');

  const nameBytes = info['name.utf-8'] !== undefined ? info['name.utf-8'] : info.name;
  if (nameBytes === undefined) throw badTorrent('missing info.name');
  const name = checkSegment(text(nameBytes, 'info.name'), 'info.name');

  const pieceLength = info['piece length'];
  if (!isSafeUint(pieceLength) || pieceLength === 0) throw badTorrent('invalid piece length');
  if (pieceLength > MAX_PIECE_LENGTH) throw badTorrent('piece length above ' + MAX_PIECE_LENGTH);

  const pieces = info.pieces;
  if (!(pieces instanceof Uint8Array) || pieces.length % 20 !== 0) throw badTorrent('info.pieces is not a list of SHA-1 hashes');
  const pieceCount = pieces.length / 20;

  const multiFile = info.files !== undefined;
  if (multiFile && info.length !== undefined) throw badTorrent('info has both files and length');
  const files = [];
  let total = 0;
  if (multiFile) {
    if (!Array.isArray(info.files) || info.files.length === 0) throw badTorrent('info.files is not a non-empty list');
    if (info.files.length > MAX_FILES) throw badTorrent('more than ' + MAX_FILES + ' files');
    const seen = new Set();
    for (let i = 0; i < info.files.length; i++) {
      const entry = info.files[i];
      const what = 'info.files[' + i + ']';
      if (!isDict(entry)) throw badTorrent(what + ' is not a dictionary');
      if (!isSafeUint(entry.length)) throw badTorrent(what + '.length is invalid');
      const rawPath = entry['path.utf-8'] !== undefined ? entry['path.utf-8'] : entry.path;
      if (!Array.isArray(rawPath) || rawPath.length === 0) throw badTorrent(what + '.path is not a non-empty list');
      const segments = rawPath.map((seg) => checkSegment(text(seg, what + '.path'), what));
      const attr = entry.attr instanceof Uint8Array ? utf8Lenient.decode(entry.attr) : '';
      const pad = attr.indexOf('p') >= 0 ||
        (segments.length === 2 && segments[0] === '.pad' && /^[0-9]+$/.test(segments[1]));
      const path = segments.join('/');
      if (!pad) {
        if (seen.has(path)) throw badTorrent('duplicate file path ' + JSON.stringify(path));
        seen.add(path);
      }
      files.push({ path, length: entry.length, offset: total, pad });
      total += entry.length;
      if (!Number.isSafeInteger(total)) throw badTorrent('total length overflows');
    }
  } else {
    if (!isSafeUint(info.length)) throw badTorrent('info.length is invalid');
    files.push({ path: name, length: info.length, offset: 0, pad: false });
    total = info.length;
  }

  if (pieceCount !== Math.ceil(total / pieceLength)) {
    throw badTorrent('piece count ' + pieceCount + ' does not match length ' + total);
  }

  let announce = [];
  const list = root['announce-list'];
  if (Array.isArray(list) && list.length > 0) {
    for (const tier of list) {
      if (!Array.isArray(tier)) continue;
      for (const url of tier) announce.push(lenientText(url));
    }
  } else if (root.announce instanceof Uint8Array) {
    announce.push(lenientText(root.announce));
  }
  announce = uniqueStrings(announce);

  let urlList = [];
  const ul = root['url-list'];
  if (ul instanceof Uint8Array) urlList.push(lenientText(ul));
  else if (Array.isArray(ul)) for (const url of ul) urlList.push(lenientText(url));
  urlList = uniqueStrings(urlList);

  return {
    infoHash: hex.encode(await sha1(infoBytes)),
    name,
    pieceLength,
    pieces,
    pieceCount,
    length: total,
    lastPieceLength: pieceCount === 0 ? 0 : (total - (pieceCount - 1) * pieceLength),
    files,
    announce,
    urlList,
    infoBytes,
    multiFile,
    private: info.private === 1,
  };
}

/**
 * pieceRangesForFile(parsed, fileIndex) → { first, last }: inclusive indices of the pieces
 * that hold any byte of the file. A zero-length file covers no piece: last === first - 1.
 */
export function pieceRangesForFile(parsed, fileIndex) {
  const file = parsed.files[fileIndex];
  if (!file) throw new RangeError('pieceRangesForFile: no file at index ' + fileIndex);
  const first = Math.floor(file.offset / parsed.pieceLength);
  if (file.length === 0) return { first, last: first - 1 };
  return { first, last: Math.floor((file.offset + file.length - 1) / parsed.pieceLength) };
}

// Index of the first file whose byte range ends after `position` (files are sorted by offset).
function firstFileEndingAfter(files, position) {
  let lo = 0;
  let hi = files.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (files[mid].offset + files[mid].length > position) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * sliceForPiece(parsed, index) → [{ fileIndex, start, end }]: the byte ranges [start, end)
 * inside each file, in torrent order, that make up piece `index`. Zero-length files never
 * appear; pad files do (check parsed.files[fileIndex].pad and fill them with zeros).
 */
export function sliceForPiece(parsed, index) {
  if (!Number.isInteger(index) || index < 0 || index >= parsed.pieceCount) {
    throw new RangeError('sliceForPiece: no piece at index ' + index);
  }
  const start = index * parsed.pieceLength;
  const end = Math.min(start + parsed.pieceLength, parsed.length);
  const files = parsed.files;
  const out = [];
  for (let i = firstFileEndingAfter(files, start); i < files.length && files[i].offset < end; i++) {
    const f = files[i];
    if (f.length === 0) continue;
    const s = Math.max(start, f.offset);
    const e = Math.min(end, f.offset + f.length);
    if (e > s) out.push({ fileIndex: i, start: s - f.offset, end: e - f.offset });
  }
  return out;
}

/**
 * buildSingleFileTorrent({ name, content, pieceLength, announce = [] }) → { torrentFile, infoHash }
 * Deterministic: info = { length, name, 'piece length', pieces } and nothing else (no creation
 * date), so every node builds byte-identical files and create-torrent produces the same
 * infohash for the same name, content and piece length. `announce` only adds the top-level
 * `announce` / `announce-list` keys, which do not change the infohash.
 */
export async function buildSingleFileTorrent({ name, content, pieceLength, announce = [] } = {}) {
  if (typeof name !== 'string') throw new TypeError('buildSingleFileTorrent: name must be a string');
  checkSegment(name, 'name');
  const bytes = asBytes(content);
  if (!Number.isSafeInteger(pieceLength) || pieceLength <= 0 || pieceLength > MAX_PIECE_LENGTH) {
    throw new TypeError('buildSingleFileTorrent: invalid pieceLength');
  }
  const pieceCount = Math.ceil(bytes.length / pieceLength);
  const pieces = new Uint8Array(pieceCount * 20);
  for (let i = 0; i < pieceCount; i++) {
    const chunk = bytes.subarray(i * pieceLength, Math.min((i + 1) * pieceLength, bytes.length));
    pieces.set(await sha1(chunk), i * 20);
  }
  const info = { length: bytes.length, name, 'piece length': pieceLength, pieces };
  const torrent = { info };
  const trackers = uniqueStrings(Array.isArray(announce) ? announce : []);
  if (trackers.length > 0) {
    torrent.announce = trackers[0];
    torrent['announce-list'] = trackers.map((url) => [url]);
  }
  return { torrentFile: encode(torrent), infoHash: hex.encode(await sha1(encode(info))) };
}
