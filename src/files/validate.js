// src/files/validate.js: untrusted file-torrent metadata (R 2.8.3, MF-55; DS F18, PEER B9) and the
// incremental plaintext SHA-256 of public files (E_FILE_HASH; MAL A13, DS F11). Pure; Node 22,
// browsers and workers.
//
// The uploader made the torrent, so its piece hashes prove nothing about what the listing promised. A
// file torrent must have exactly one file, a length equal to the listing or grant (and at most the
// lane's per-file cap, whatever the listing says), a piece length from 16 KiB to 4 MiB, at most 16,384
// pieces, no pad files, no path components, and a .torrent of at most 256 KiB. A private torrent also
// carries a 16-byte x-mw-nonce (R 2.9.4).
//
//   LIMITS
//   checkTorrentBytes(torrentFile) -> throws E_FILE_HASH { reason: 'torrent-size' } above 256 KiB
//   validateInfo(info, { length, maxBytes, pieceLength?, privateSwarm? }) -> { length, pieceLength, pieceCount, name }
//   validateFileTorrent(torrentFile, opts) -> Promise<{ infoHash, info, ... }>
//   createSha256() -> { update(bytes), digest() -> Uint8Array(32), hex() }   incremental, synchronous

import { decode, encode } from '../common/bencode.js';
import { hex } from '../chain/canonical.js';

export const LIMITS = Object.freeze({
  minPieceLength: 16384,
  maxPieceLength: 4194304,
  maxPieces: 16384,
  maxTorrentBytes: 262144,
  nonceBytes: 16,
});

/** fileError(code, reason, message) -> Error with .code and .reason */
export function fileError(code, reason, message) {
  const err = new Error(message || reason || code);
  err.code = code;
  err.reason = reason;
  return err;
}

const meta = (reason, message) => fileError('E_FILE_HASH', reason, 'file metadata: ' + (message || reason));
const isDict = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array);
const isUint = (n) => Number.isSafeInteger(n) && n >= 0;

/** checkTorrentBytes(torrentFile): a .torrent above 256 KiB is refused before parsing. */
export function checkTorrentBytes(torrentFile) {
  const n = torrentFile && typeof torrentFile.length === 'number' ? torrentFile.length : (torrentFile && torrentFile.byteLength);
  if (!isUint(n) || n === 0) throw meta('torrent-size', 'no torrent bytes');
  if (n > LIMITS.maxTorrentBytes) throw meta('torrent-size', 'the .torrent is larger than 256 KiB');
}

function nameOf(info) {
  const raw = info['name.utf-8'] !== undefined ? info['name.utf-8'] : info.name;
  if (!(raw instanceof Uint8Array)) throw meta('name', 'missing name');
  let s;
  try {
    s = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch (_) {
    throw meta('name', 'the name is not UTF-8');
  }
  if (s === '' || s === '.' || s === '..' || /[/\\\0]/.test(s)) throw meta('path', 'the name has a path component');
  return s;
}

/**
 * validateInfo(info, { length, maxBytes, pieceLength, privateSwarm }) -> { length, pieceLength, pieceCount, name }.
 * `length` is what the listing or grant says; `maxBytes` the lane's per-file cap.
 */
export function validateInfo(info, { length, maxBytes = Infinity, pieceLength, privateSwarm = false } = {}) {
  if (!isDict(info)) throw meta('info', 'missing info dictionary');
  if (info.files !== undefined) throw meta('files', 'more than one file, pad files or paths');
  if (info.attr !== undefined || info.symlink !== undefined || info['file tree'] !== undefined || info['meta version'] !== undefined) {
    throw meta('files', 'pad files, links or v2 trees are not allowed');
  }
  const name = nameOf(info);
  if (!isUint(info.length)) throw meta('length', 'invalid length');
  if (!isUint(length) || info.length !== length) throw meta('length', 'the length does not match the listing');
  if (info.length > maxBytes) throw meta('length', 'over the per-file cap');
  const pl = info['piece length'];
  if (!isUint(pl) || pl < LIMITS.minPieceLength || pl > LIMITS.maxPieceLength) throw meta('piece-length', 'piece length outside 16 KiB to 4 MiB');
  if (pieceLength !== undefined && pl !== pieceLength) throw meta('piece-length', 'unexpected piece length');
  if (!(info.pieces instanceof Uint8Array) || info.pieces.length % 20 !== 0) throw meta('pieces', 'bad piece table');
  const pieceCount = info.pieces.length / 20;
  if (pieceCount > LIMITS.maxPieces) throw meta('pieces', 'more than 16,384 pieces');
  if (pieceCount !== Math.ceil(info.length / pl)) throw meta('pieces', 'the piece table does not match the length');
  if (privateSwarm) {
    const n = info['x-mw-nonce'];
    if (!(n instanceof Uint8Array) || n.length !== LIMITS.nonceBytes) throw meta('nonce', 'a private swarm needs x-mw-nonce');
  }
  return { length: info.length, pieceLength: pl, pieceCount, name };
}

/**
 * validateFileTorrent(torrentFile, opts) -> { infoHash, info, length, pieceLength, pieceCount, name, pieces }.
 * opts as validateInfo plus infoHash (the expected btih, lowercase hex).
 */
export async function validateFileTorrent(torrentFile, opts = {}) {
  checkTorrentBytes(torrentFile);
  const bytes = torrentFile instanceof Uint8Array ? torrentFile : new Uint8Array(torrentFile);
  let decoded;
  try {
    decoded = decode(bytes);
  } catch (err) {
    throw meta('bencode', err.message);
  }
  const root = decoded.value;
  if (!isDict(root) || !isDict(root.info)) throw meta('info', 'missing info dictionary');
  const span = decoded.spans.get('info');
  const infoBytes = bytes.slice(span[0], span[1]);
  const again = encode(root.info);
  if (again.length !== infoBytes.length || again.some((b, i) => b !== infoBytes[i])) throw meta('bencode', 'info is not canonical');
  const checked = validateInfo(root.info, opts);
  const infoHash = hex.encode(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-1', infoBytes)));
  if (opts.infoHash && opts.infoHash.toLowerCase() !== infoHash) throw meta('infohash', 'the torrent is not the listed one');
  return Object.assign({ infoHash, info: root.info, pieces: root.info.pieces }, checked);
}

// ---------------------------------------------------------------------------------------------
// incremental SHA-256 (FIPS 180-4): the public-file check runs over the chunk store piece by piece
// ---------------------------------------------------------------------------------------------

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function compress(H, W, b, o) {
  for (let t = 0; t < 16; t++) W[t] = (b[o + 4 * t] << 24) | (b[o + 4 * t + 1] << 16) | (b[o + 4 * t + 2] << 8) | b[o + 4 * t + 3];
  for (let t = 16; t < 64; t++) {
    const x = W[t - 15];
    const y = W[t - 2];
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
  }
  let a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
  for (let t = 0; t < 64; t++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + S1 + ch + K[t] + W[t]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const mj = (a & bb) ^ (a & c) ^ (bb & c);
    const t2 = (S0 + mj) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
  }
  H[0] = (H[0] + a) | 0; H[1] = (H[1] + bb) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
  H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
}

/** createSha256() -> an incremental hasher: update(bytes) any number of times, then digest() once. */
export function createSha256() {
  const H = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Int32Array(64);
  const block = new Uint8Array(64);
  let fill = 0;
  let total = 0;
  let done = null;
  const api = {
    update(data) {
      if (done) throw new Error('sha256: update after digest');
      const b = data instanceof Uint8Array ? data : new Uint8Array(data.buffer ? data.buffer : data, data.byteOffset || 0, data.byteLength);
      total += b.length;
      let o = 0;
      if (fill > 0) {
        const take = Math.min(64 - fill, b.length);
        block.set(b.subarray(0, take), fill);
        fill += take;
        o = take;
        if (fill === 64) {
          compress(H, W, block, 0);
          fill = 0;
        }
      }
      for (; o + 64 <= b.length; o += 64) compress(H, W, b, o);
      if (o < b.length) {
        block.set(b.subarray(o), 0);
        fill = b.length - o;
      }
      return api;
    },
    digest() {
      if (done) return done.slice();
      const bits = total * 8;
      block[fill++] = 0x80;
      if (fill > 56) {
        block.fill(0, fill);
        compress(H, W, block, 0);
        fill = 0;
      }
      block.fill(0, fill, 56);
      const hi = Math.floor(bits / 4294967296);
      const lo = bits >>> 0;
      block[56] = hi >>> 24; block[57] = (hi >>> 16) & 255; block[58] = (hi >>> 8) & 255; block[59] = hi & 255;
      block[60] = lo >>> 24; block[61] = (lo >>> 16) & 255; block[62] = (lo >>> 8) & 255; block[63] = lo & 255;
      compress(H, W, block, 0);
      const out = new Uint8Array(32);
      for (let i = 0; i < 8; i++) {
        out[4 * i] = H[i] >>> 24; out[4 * i + 1] = (H[i] >>> 16) & 255; out[4 * i + 2] = (H[i] >>> 8) & 255; out[4 * i + 3] = H[i] & 255;
      }
      done = out;
      return out.slice();
    },
    hex() {
      return hex.encode(api.digest());
    },
  };
  return api;
}
