// Synchronous SHA-256 (FIPS 180-4) in plain JavaScript.
//
// Used by the proof-of-work miner (pow.js, inside the PoW worker) and by dag.js for the
// synchronous root() and window digests. Block verification uses WebCrypto (crypto.js); a
// WebCrypto call per hash is several times slower than an inline loop for mining
// (docs/research/06 F36-F38), which is why this module exists.
//
// Runs unchanged in Node >= 22, browsers and workers: Uint8Array/Int32Array only, no Buffer,
// no node: imports. All functions are synchronous and never re-entered, so the scratch buffers
// below are shared safely. Every returned digest is a fresh Uint8Array unless the caller passes
// its own `out` buffer to sha256Resume.

import { utf8, asBytes } from './canonical.js';

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

const IV = new Int32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

// Scratch space shared by the synchronous functions below.
const W = new Int32Array(64);
const PAD = new Uint8Array(128);
const STATE = new Int32Array(8);

function toBytes(data) {
  return typeof data === 'string' ? utf8.encode(data) : asBytes(data);
}

// One 64-byte block starting at bytes[offset] folded into state (eight int32 words).
function compress(state, bytes, offset) {
  const w = W;
  for (let i = 0; i < 16; i++) {
    const j = offset + (i << 2);
    w[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
  }
  for (let i = 16; i < 64; i++) {
    const x = w[i - 15];
    const y = w[i - 2];
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
  }
  let a = state[0];
  let b = state[1];
  let c = state[2];
  let d = state[3];
  let e = state[4];
  let f = state[5];
  let g = state[6];
  let h = state[7];
  for (let i = 0; i < 64; i++) {
    const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const ch = (e & f) ^ (~e & g);
    const t1 = (h + s1 + ch + K[i] + w[i]) | 0;
    const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (s0 + maj) | 0;
    h = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  state[0] = (state[0] + a) | 0;
  state[1] = (state[1] + b) | 0;
  state[2] = (state[2] + c) | 0;
  state[3] = (state[3] + d) | 0;
  state[4] = (state[4] + e) | 0;
  state[5] = (state[5] + f) | 0;
  state[6] = (state[6] + g) | 0;
  state[7] = (state[7] + h) | 0;
}

// Pads the unprocessed tail bytes[offset, offset + length) (length < 64) of a message of `total`
// bytes, runs the last one or two blocks and writes the big-endian digest into out.
function finish(state, bytes, offset, length, total, out) {
  const pad = PAD;
  pad.fill(0);
  for (let i = 0; i < length; i++) pad[i] = bytes[offset + i];
  pad[length] = 0x80;
  const end = length < 56 ? 64 : 128;
  // 64-bit big-endian bit length; exact for messages below 2^50 bytes.
  const hi = Math.floor(total / 0x20000000);
  const lo = (total * 8) >>> 0;
  pad[end - 8] = hi >>> 24;
  pad[end - 7] = (hi >>> 16) & 255;
  pad[end - 6] = (hi >>> 8) & 255;
  pad[end - 5] = hi & 255;
  pad[end - 4] = lo >>> 24;
  pad[end - 3] = (lo >>> 16) & 255;
  pad[end - 2] = (lo >>> 8) & 255;
  pad[end - 1] = lo & 255;
  compress(state, pad, 0);
  if (end === 128) compress(state, pad, 64);
  for (let i = 0; i < 8; i++) {
    const v = state[i];
    out[i * 4] = v >>> 24;
    out[i * 4 + 1] = (v >>> 16) & 255;
    out[i * 4 + 2] = (v >>> 8) & 255;
    out[i * 4 + 3] = v & 255;
  }
  return out;
}

/**
 * sha256Sync(data) -> Uint8Array(32). `data` is a Uint8Array, ArrayBuffer, any ArrayBufferView,
 * or a string (hashed as UTF-8). Pure JavaScript, synchronous.
 */
export function sha256Sync(data) {
  const bytes = toBytes(data);
  const state = STATE;
  state.set(IV);
  const n = bytes.length;
  const full = n - (n & 63);
  for (let off = 0; off < full; off += 64) compress(state, bytes, off);
  return finish(state, bytes, full, n - full, n, new Uint8Array(32));
}

/**
 * Midstate for repeated hashing of messages that share a prefix (the miner varies only the
 * nonce). Processes the whole 64-byte blocks of `prefix` and returns
 * { state: Int32Array(8), length } where length (a multiple of 64) is the number of prefix bytes
 * consumed. The caller hashes the rest of the message with sha256Resume.
 */
export function sha256Midstate(prefix) {
  const bytes = toBytes(prefix);
  const state = new Int32Array(IV);
  const full = bytes.length - (bytes.length & 63);
  for (let off = 0; off < full; off += 64) compress(state, bytes, off);
  return { state, length: full };
}

/**
 * sha256Resume(mid, rest, out?) -> digest of (the bytes mid consumed) + rest. `mid` comes from
 * sha256Midstate and is not modified. Writes into `out` (32 bytes) when given, which lets the
 * mining loop run without allocating.
 */
export function sha256Resume(mid, rest, out) {
  if (!mid || !(mid.state instanceof Int32Array) || mid.state.length !== 8 ||
    !Number.isSafeInteger(mid.length) || mid.length < 0 || (mid.length & 63) !== 0) {
    throw new TypeError('sha256Resume expects a midstate from sha256Midstate');
  }
  const bytes = toBytes(rest);
  const target = out === undefined ? new Uint8Array(32) : out;
  if (!(target instanceof Uint8Array) || target.length < 32) {
    throw new TypeError('sha256Resume: out must be a Uint8Array of at least 32 bytes');
  }
  const state = STATE;
  state.set(mid.state);
  const n = bytes.length;
  const full = n - (n & 63);
  for (let off = 0; off < full; off += 64) compress(state, bytes, off);
  return finish(state, bytes, full, n - full, mid.length + n, target);
}
