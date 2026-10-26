// src/media/format.js: the private media format (R 2.9.4, 2.9.5; MF-56; ARCHITECTURE 15.7; INTERFACES
// "v0.3 (proposed)" src/media/*). Pure apart from WebCrypto; Node 22, browsers and workers (the Service
// Worker imports it to decrypt chunks).
//
//   P (piece length)  = 262,144 bytes when the padded size is at least 2 MiB, else 65,536 bytes
//   C (chunk payload) = P - 16
//   chunk i plaintext = the i-th C bytes of its region (poster, then media), zero-filled at the end
//   nonce_i           = base (8 bytes) || uint32_be(i)
//   AAD_i             = "mw-media-v1" || fid (16) || 0x01 (version) || uint32_be(i) || uint32_be(total) || region (1)
//   chunk i on disk   = AES-256-GCM(fk, nonce_i, plaintext_i, AAD_i), exactly P bytes = torrent piece i
//   padding chunks    = encryptions of zero chunks with region = pad
//   total (pieces)    = the bucket of src/media/pad.js divided by P
//
// Region bytes: poster 0x01, media 0x02, pad 0x03. Region ranges in a plan and a manifest are
// half-open chunk index ranges [first, end): poster [0, n), media [n, n + m), pad [n + m, total).
//
//   plan({ posterBytes, mediaBytes })          -> { P, C, regions, chunks, total, paddedBytes }
//   encryptChunk(fk, base, fid, i, total, region, plaintext) -> Uint8Array(P)
//   decryptChunk(fk, base, fid, i, total, region, ciphertext) -> Uint8Array(C)   (throws E_DECRYPT)
//   nonceFor(base, i) / aadFor(fid, i, total, region)
//   newSecrets(random?) -> { fid, fk, base, swarmNonce }
//   buildManifest(fields) / checkManifest(M) / regionOf(M, i) / partInfo(M, part) / chunkSpan(M, part, start, end)
//   mimeFits(kind, mime); POSTER_MIMES   (checkManifest: mime in the media allow-list and of the item's kind,
//                                         pmime '' or a poster image type; E_DECRYPT otherwise)

import { bucketBytes, LARGE_MIN } from './pad.js';
import { MEDIA_MIMES } from './sniff.js';
import { utf8, hex, b64url, asBytes } from '../chain/canonical.js';

export const PIECE_LARGE = 262144;
export const PIECE_SMALL = 65536;
export const TAG_BYTES = 16;
export const VERSION = 1;
export const AAD_PREFIX = 'mw-media-v1';
export const REGION = Object.freeze({ poster: 1, media: 2, pad: 3 });
export const FID_BYTES = 16;
export const FK_BYTES = 32;
export const BASE_BYTES = 8;
export const NONCE_BYTES = 16; // x-mw-nonce in the info dictionary
export const MAX_CHUNKS = 16384; // the file-torrent piece bound (R 2.8.3)
export const KINDS = Object.freeze(['video', 'image']);
/**
 * The types a manifest may name (R 2.9.2; code review v0.3): the media allow-list of src/media/sniff.js for the item,
 * matching its kind, and the image types a poster is made in. A grant comes from another person, so its mime is
 * never trusted further than this: a type that can run script (text/html, image/svg+xml) is refused.
 */
export const POSTER_MIMES = Object.freeze(['image/jpeg', 'image/webp', 'image/png']);
export function mimeFits(kind, mime) {
  if (MEDIA_MIMES.indexOf(mime) < 0) return false;
  return kind === 'video' ? mime.indexOf('video/') === 0 : kind === 'image' ? mime.indexOf('image/') === 0 : false;
}

const AAD_PREFIX_BYTES = utf8.encode(AAD_PREFIX);
const REGION_BYTES = new Set([REGION.poster, REGION.media, REGION.pad]);

/** An Error with a stable code (the SDK error codes of R 2.11.2). */
export function mediaError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function subtle() {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
  if (!c || !c.subtle) throw mediaError('E_UNSUPPORTED', 'WebCrypto is not available');
  return c.subtle;
}

function u32(n) {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError('format: index out of range');
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

function chunksFor(bytes, C) {
  return bytes > 0 ? Math.ceil(bytes / C) : 0;
}

function planWith(P, posterBytes, mediaBytes) {
  const C = P - TAG_BYTES;
  const posterChunks = chunksFor(posterBytes, C);
  const mediaChunks = Math.max(1, chunksFor(mediaBytes, C));
  const chunks = posterChunks + mediaChunks;
  const needed = chunks * P;
  let paddedBytes = bucketBytes(needed);
  if (P === PIECE_LARGE && paddedBytes < LARGE_MIN) paddedBytes = LARGE_MIN;
  return {
    P,
    C,
    regions: { poster: [0, posterChunks], media: [posterChunks, chunks] },
    chunks,
    total: paddedBytes / P,
    paddedBytes,
  };
}

/**
 * plan({ posterBytes, mediaBytes }) -> { P, C, regions: { poster: [i0, i1), media: [i0, i1) }, chunks, total, paddedBytes }
 * P is 256 KiB when the padded size is at least 2 MiB, else 64 KiB. `chunks` counts the data chunks;
 * chunks [chunks, total) are padding. Reproduces the R 2.9.5 worked example: 20 MiB of media with a
 * 48 KiB poster gives 82 data chunks, 88 pieces and 23,068,672 bytes.
 */
export function plan({ posterBytes = 0, mediaBytes } = {}) {
  for (const n of [posterBytes, mediaBytes]) {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('plan: sizes must be non-negative safe integers');
  }
  const small = planWith(PIECE_SMALL, posterBytes, mediaBytes);
  const out = small.paddedBytes < LARGE_MIN ? small : planWith(PIECE_LARGE, posterBytes, mediaBytes);
  if (out.total > MAX_CHUNKS) throw mediaError('E_LIMIT', 'more than ' + MAX_CHUNKS + ' pieces');
  return out;
}

/** nonceFor(base, i) -> base (8 bytes) || uint32_be(i). */
export function nonceFor(base, i) {
  const b = asBytes(base);
  if (b.length !== BASE_BYTES) throw new RangeError('format: base must be 8 bytes');
  const out = new Uint8Array(12);
  out.set(b, 0);
  out.set(u32(i), 8);
  return out;
}

/** aadFor(fid, i, total, region) -> "mw-media-v1" || fid || 0x01 || uint32_be(i) || uint32_be(total) || region. */
export function aadFor(fid, i, total, region) {
  const f = asBytes(fid);
  if (f.length !== FID_BYTES) throw new RangeError('format: fid must be 16 bytes');
  if (!REGION_BYTES.has(region)) throw new RangeError('format: unknown region ' + region);
  if (!(i < total)) throw new RangeError('format: chunk index past the total');
  const out = new Uint8Array(AAD_PREFIX_BYTES.length + FID_BYTES + 1 + 4 + 4 + 1);
  let o = 0;
  out.set(AAD_PREFIX_BYTES, o); o += AAD_PREFIX_BYTES.length;
  out.set(f, o); o += FID_BYTES;
  out[o++] = VERSION;
  out.set(u32(i), o); o += 4;
  out.set(u32(total), o); o += 4;
  out[o] = region;
  return out;
}

const keyCache = new WeakMap();

/** importChunkKey(fk) -> a non-extractable AES-GCM CryptoKey (fk: 32 raw bytes or a CryptoKey). */
export async function importChunkKey(fk) {
  if (fk && typeof fk === 'object' && typeof fk.type === 'string' && fk.algorithm) return fk; // a CryptoKey
  const raw = asBytes(fk);
  if (raw.length !== FK_BYTES) throw new RangeError('format: fk must be 32 bytes');
  const cached = keyCache.get(raw);
  if (cached) return cached;
  const key = await subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  keyCache.set(raw, key);
  return key;
}

/**
 * encryptChunk(fk, base, fid, i, total, region, plaintext) -> Uint8Array(P), P = plaintext.length + 16.
 * The plaintext must be exactly C bytes (the caller zero-fills the end of a region).
 */
export async function encryptChunk(fk, base, fid, i, total, region, plaintext) {
  const pt = asBytes(plaintext);
  if (pt.length !== PIECE_LARGE - TAG_BYTES && pt.length !== PIECE_SMALL - TAG_BYTES) {
    throw new RangeError('encryptChunk: plaintext must be exactly C bytes (' + (PIECE_SMALL - TAG_BYTES) + ' or ' + (PIECE_LARGE - TAG_BYTES) + ')');
  }
  const key = await importChunkKey(fk);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv: nonceFor(base, i), additionalData: aadFor(fid, i, total, region), tagLength: 128 }, key, pt);
  return new Uint8Array(ct);
}

/** decryptChunk(fk, base, fid, i, total, region, ciphertext) -> Uint8Array(C); E_DECRYPT when it does not open. */
export async function decryptChunk(fk, base, fid, i, total, region, ciphertext) {
  const ct = asBytes(ciphertext);
  if (ct.length !== PIECE_LARGE && ct.length !== PIECE_SMALL) throw mediaError('E_DECRYPT', 'chunk ' + i + ' has the wrong size');
  const key = await importChunkKey(fk);
  try {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: nonceFor(base, i), additionalData: aadFor(fid, i, total, region), tagLength: 128 }, key, ct);
    return new Uint8Array(pt);
  } catch (_) {
    throw mediaError('E_DECRYPT', 'chunk ' + i + ' does not open');
  }
}

function randomBytes(n, random) {
  if (typeof random === 'function') {
    const out = asBytes(random(n));
    if (out.length !== n) throw new RangeError('format: random(n) returned the wrong length');
    return out;
  }
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** newSecrets(random?) -> { fid (16), fk (32), base (8), swarmNonce (16) }, all random (R 2.9.4). */
export function newSecrets(random) {
  return {
    fid: randomBytes(FID_BYTES, random),
    fk: randomBytes(FK_BYTES, random),
    base: randomBytes(BASE_BYTES, random),
    swarmNonce: randomBytes(NONCE_BYTES, random),
  };
}

/**
 * buildManifest(fields) -> M = { v: 1, fid, kind, mime, len, duration?, w, h, P, base, regions, total, ih,
 *   info?, ws?, name, t, plen, pmime } (R 2.9.4; plen and pmime describe the poster, see docs/deviations/media.md).
 * Binary fields (fid, base) are base64url; ih is 40 lowercase hex characters.
 */
export function buildManifest(f) {
  const M = {
    v: 1,
    fid: typeof f.fid === 'string' ? f.fid : b64url.encode(f.fid),
    kind: f.kind,
    mime: f.mime,
    len: f.len,
    w: f.w || 0,
    h: f.h || 0,
    P: f.P,
    base: typeof f.base === 'string' ? f.base : b64url.encode(f.base),
    regions: { poster: f.regions.poster.slice(), media: f.regions.media.slice() },
    total: f.total,
    ih: f.ih,
    name: f.name,
    t: f.t,
    plen: f.plen || 0,
    pmime: f.pmime || '',
  };
  if (f.duration !== undefined && f.duration !== null) M.duration = f.duration;
  if (f.info) M.info = f.info;
  if (f.ws) M.ws = f.ws;
  checkManifest(M);
  return M;
}

const MANIFEST_KEYS = new Set(['v', 'fid', 'kind', 'mime', 'len', 'duration', 'w', 'h', 'P', 'base', 'regions', 'total', 'ih', 'info', 'ws', 'name', 't', 'plen', 'pmime']);
const isUint = (n) => Number.isSafeInteger(n) && n >= 0;

/** checkManifest(M) -> M; throws E_DECRYPT (a manifest that does not describe a valid item). */
export function checkManifest(M) {
  const bad = (why) => { throw mediaError('E_DECRYPT', 'manifest: ' + why); };
  if (!M || typeof M !== 'object') bad('not an object');
  for (const k of Object.keys(M)) if (!MANIFEST_KEYS.has(k)) bad('unknown field ' + k);
  if (M.v !== 1) bad('version');
  let fid;
  let base;
  try {
    fid = b64url.decode(M.fid);
    base = b64url.decode(M.base);
  } catch (_) {
    bad('fid or base');
  }
  if (fid.length !== FID_BYTES || base.length !== BASE_BYTES) bad('fid or base length');
  if (KINDS.indexOf(M.kind) < 0) bad('kind');
  if (typeof M.mime !== 'string' || !mimeFits(M.kind, M.mime)) bad('mime');
  if (typeof M.pmime !== 'string' || (M.pmime !== '' && POSTER_MIMES.indexOf(M.pmime) < 0)) bad('poster mime');
  if (!isUint(M.len) || !isUint(M.plen) || !isUint(M.w) || !isUint(M.h)) bad('sizes');
  if (M.P !== PIECE_LARGE && M.P !== PIECE_SMALL) bad('piece length');
  if (!isUint(M.total) || M.total < 1 || M.total > MAX_CHUNKS) bad('total');
  if (M.total * M.P !== bucketBytes(M.total * M.P)) bad('total is not a bucket');
  if (typeof M.ih !== 'string' || !/^[0-9a-f]{40}$/.test(M.ih)) bad('ih');
  const r = M.regions;
  if (!r || !Array.isArray(r.poster) || !Array.isArray(r.media)) bad('regions');
  const [p0, p1] = r.poster;
  const [m0, m1] = r.media;
  if (!(p0 === 0 && isUint(p1) && p1 === m0 && isUint(m1) && m1 > m0 && m1 <= M.total)) bad('region bounds');
  const C = M.P - TAG_BYTES;
  if (chunksFor(M.len, C) > m1 - m0 || (M.len > 0 && Math.ceil(M.len / C) !== m1 - m0)) bad('media length');
  if (chunksFor(M.plen, C) !== p1 - p0) bad('poster length');
  if (M.plen > 0 && (typeof M.pmime !== 'string' || !M.pmime)) bad('poster mime');
  if (M.duration !== undefined && !(typeof M.duration === 'number' && Number.isFinite(M.duration) && M.duration >= 0)) bad('duration');
  if (typeof M.name !== 'string' || M.name.length > 96) bad('name');
  if (!isUint(M.t)) bad('t');
  return M;
}

/** regionOf(M | plan, i) -> REGION.poster | REGION.media | REGION.pad */
export function regionOf(M, i) {
  const r = M.regions;
  if (i >= r.poster[0] && i < r.poster[1]) return REGION.poster;
  if (i >= r.media[0] && i < r.media[1]) return REGION.media;
  if (i >= 0 && i < M.total) return REGION.pad;
  throw new RangeError('regionOf: chunk ' + i + ' is outside the item');
}

/** partInfo(M, part) -> { first, end, size, mime } for 'media' (default) or 'poster'. */
export function partInfo(M, part) {
  if (part === 'poster') return { first: M.regions.poster[0], end: M.regions.poster[1], size: M.plen, mime: M.pmime };
  return { first: M.regions.media[0], end: M.regions.media[1], size: M.len, mime: M.mime };
}

/**
 * chunkSpan(M, part, start, end) -> { first, last, skip } for the inclusive byte range [start, end] of
 * the part: chunk indices first..last (inclusive) and the offset of `start` inside chunk `first`.
 * Offset o of a part lives in chunk regionStart + floor(o / C) (R 2.9.6 seeking).
 */
export function chunkSpan(M, part, start, end) {
  const info = partInfo(M, part);
  const C = M.P - TAG_BYTES;
  if (!(isUint(start) && isUint(end) && start <= end && end < info.size)) throw new RangeError('chunkSpan: range outside the part');
  return { first: info.first + Math.floor(start / C), last: info.first + Math.floor(end / C), skip: start % C };
}

/** idOf(M) -> the item id the SDK uses: hex(fid), 32 characters. */
export function idOf(M) {
  return hex.encode(b64url.decode(M.fid));
}
