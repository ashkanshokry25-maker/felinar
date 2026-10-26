// Argon2id (RFC 9106, version 0x13) and BLAKE2b (RFC 7693) in plain JavaScript. Used for the
// passphrase wrapping and the optional extra word at the identity origin (R 2.2.1, 2.2.4).
// The design calls for WebAssembly; this build has no Argon2 package and adds none, so it runs
// as JS (deviation entry, docs/deviations/idcore.md, with the measured time). Checked against the
// RFC 9106 section 5.3 test vector in test/unit/identity-core-wrap.test.mjs.
//
// 64-bit words are kept as (lo, hi) pairs of 32-bit integers in Uint32Array, low word first.
// Shared by Node >= 22 and browsers; no imports.

// ---------------------------------------------------------------------------------------------
// BLAKE2b
// ---------------------------------------------------------------------------------------------

const IV = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

class Blake2b {
  constructor(outLen) {
    if (!Number.isInteger(outLen) || outLen < 1 || outLen > 64) throw new RangeError('blake2b: output length 1..64');
    this.outLen = outLen;
    this.h = new Uint32Array(IV);
    this.h[0] ^= 0x01010000 ^ outLen; // parameter block: digest length, key length 0, fanout 1, depth 1
    this.buf = new Uint8Array(128);
    this.bufLen = 0;
    this.t = 0; // bytes compressed so far (fits in a double for any input used here)
    this.v = new Uint32Array(32);
    this.m = new Uint32Array(32);
  }

  update(input) {
    let i = 0;
    while (i < input.length) {
      if (this.bufLen === 128) {
        this.t += 128;
        this.compress(false);
        this.bufLen = 0;
      }
      const n = Math.min(128 - this.bufLen, input.length - i);
      this.buf.set(input.subarray(i, i + n), this.bufLen);
      this.bufLen += n;
      i += n;
    }
    return this;
  }

  digest() {
    this.t += this.bufLen;
    this.buf.fill(0, this.bufLen);
    this.compress(true);
    const out = new Uint8Array(this.outLen);
    for (let i = 0; i < this.outLen; i++) out[i] = this.h[i >> 2] >>> (8 * (i & 3));
    return out;
  }

  compress(last) {
    const { v, m, h, buf } = this;
    for (let i = 0; i < 32; i++) {
      m[i] = buf[4 * i] | (buf[4 * i + 1] << 8) | (buf[4 * i + 2] << 16) | (buf[4 * i + 3] << 24);
    }
    for (let i = 0; i < 16; i++) v[i] = h[i];
    for (let i = 0; i < 16; i++) v[16 + i] = IV[i];
    v[24] ^= this.t >>> 0;
    v[25] ^= Math.floor(this.t / 0x100000000) >>> 0;
    if (last) {
      v[28] = ~v[28];
      v[29] = ~v[29];
    }
    for (let r = 0; r < 12; r++) {
      const s = SIGMA[r % 10];
      bg(v, m, 0, 8, 16, 24, s[0], s[1]);
      bg(v, m, 2, 10, 18, 26, s[2], s[3]);
      bg(v, m, 4, 12, 20, 28, s[4], s[5]);
      bg(v, m, 6, 14, 22, 30, s[6], s[7]);
      bg(v, m, 0, 10, 20, 30, s[8], s[9]);
      bg(v, m, 2, 12, 22, 24, s[10], s[11]);
      bg(v, m, 4, 14, 16, 26, s[12], s[13]);
      bg(v, m, 6, 8, 18, 28, s[14], s[15]);
    }
    for (let i = 0; i < 16; i++) h[i] ^= v[i] ^ v[16 + i];
  }
}

// 64-bit add of (v[a], v[a+1]) += (v[b], v[b+1]) in place.
function add64(v, a, b) {
  const lo = v[a] + v[b];
  v[a + 1] = v[a + 1] + v[b + 1] + (lo > 0xffffffff ? 1 : 0);
  v[a] = lo;
}

function add64m(v, a, m, x) {
  const lo = v[a] + m[x];
  v[a + 1] = v[a + 1] + m[x + 1] + (lo > 0xffffffff ? 1 : 0);
  v[a] = lo;
}

// Rotate right (v[d], v[d+1]) ^= (v[a], v[a+1]) by n bits, for n in {16, 24, 32, 63}.
function xorRot(v, d, a, n) {
  const lo = v[d] ^ v[a];
  const hi = v[d + 1] ^ v[a + 1];
  if (n === 32) {
    v[d] = hi;
    v[d + 1] = lo;
  } else if (n < 32) {
    v[d] = (lo >>> n) | (hi << (32 - n));
    v[d + 1] = (hi >>> n) | (lo << (32 - n));
  } else {
    const k = n - 32; // 31 for n = 63
    v[d] = (hi >>> k) | (lo << (32 - k));
    v[d + 1] = (lo >>> k) | (hi << (32 - k));
  }
}

function bg(v, m, a, b, c, d, x, y) {
  add64(v, a, b);
  add64m(v, a, m, 2 * x);
  xorRot(v, d, a, 32);
  add64(v, c, d);
  xorRot(v, b, c, 24);
  add64(v, a, b);
  add64m(v, a, m, 2 * y);
  xorRot(v, d, a, 16);
  add64(v, c, d);
  xorRot(v, b, c, 63);
}

/** blake2b(input, outLen = 64) -> Uint8Array(outLen), unkeyed BLAKE2b. */
export function blake2b(input, outLen = 64) {
  return new Blake2b(outLen).update(input).digest();
}

// ---------------------------------------------------------------------------------------------
// Argon2id
// ---------------------------------------------------------------------------------------------

const ARGON2_VERSION = 0x13;
const TYPE_ID = 2;
const SYNC_POINTS = 4;
const BLOCK_WORDS = 256; // 1024 bytes as 32-bit words

function le32(n) {
  return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
}

function concat(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** H' of RFC 9106 section 3.3: variable-length hash. */
function hPrime(input, outLen) {
  const prefixed = concat([le32(outLen), input]);
  if (outLen <= 64) return blake2b(prefixed, outLen);
  const out = new Uint8Array(outLen);
  const r = Math.ceil(outLen / 32) - 2;
  let v = blake2b(prefixed, 64);
  out.set(v.subarray(0, 32), 0);
  for (let i = 1; i < r; i++) {
    v = blake2b(v, 64);
    out.set(v.subarray(0, 32), 32 * i);
  }
  const last = blake2b(v, outLen - 32 * r);
  out.set(last, 32 * r);
  return out;
}

// 32 x 32 -> 64-bit multiply, returned through MUL (lo, hi).
const MUL = new Uint32Array(2);
function mul32(a, b) {
  const a0 = a & 0xffff;
  const a1 = a >>> 16;
  const b0 = b & 0xffff;
  const b1 = b >>> 16;
  const p00 = a0 * b0;
  const p01 = a0 * b1;
  const p10 = a1 * b0;
  const p11 = a1 * b1;
  const mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
  MUL[0] = (p00 & 0xffff) | (mid << 16);
  MUL[1] = p11 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16);
}

// a = a + b + 2 * lo(a) * lo(b) on word pairs of r.
function fBlaMka(r, a, b) {
  mul32(r[a], r[b]);
  // 2 * product
  const pl = MUL[0];
  const ph = (MUL[1] << 1) | (pl >>> 31);
  const pl2 = (pl << 1) >>> 0;
  let lo = r[a] + r[b];
  let hi = r[a + 1] + r[b + 1] + (lo > 0xffffffff ? 1 : 0);
  lo >>>= 0;
  const lo2 = lo + pl2;
  hi = hi + ph + (lo2 > 0xffffffff ? 1 : 0);
  r[a] = lo2;
  r[a + 1] = hi;
}

function gb(r, a, b, c, d) {
  fBlaMka(r, a, b);
  xorRot(r, d, a, 32);
  fBlaMka(r, c, d);
  xorRot(r, b, c, 24);
  fBlaMka(r, a, b);
  xorRot(r, d, a, 16);
  fBlaMka(r, c, d);
  xorRot(r, b, c, 63);
}

// P on 16 words given as word-pair offsets o[0..15] into r.
function permute(r, o0, o1, o2, o3, o4, o5, o6, o7, o8, o9, o10, o11, o12, o13, o14, o15) {
  gb(r, o0, o4, o8, o12);
  gb(r, o1, o5, o9, o13);
  gb(r, o2, o6, o10, o14);
  gb(r, o3, o7, o11, o15);
  gb(r, o0, o5, o10, o15);
  gb(r, o1, o6, o11, o12);
  gb(r, o2, o7, o8, o13);
  gb(r, o3, o4, o9, o14);
}

const R = new Uint32Array(BLOCK_WORDS);
const Z = new Uint32Array(BLOCK_WORDS);

/**
 * G(X, Y) into `out` at offset outOff: R = X ^ Y, Z = P(rows), P(columns), result = Z ^ R; with
 * xor, the result is XORed into the existing block (version 0x13 passes after the first).
 */
function compress(mem, xOff, yMem, yOff, out, outOff, xor) {
  for (let i = 0; i < BLOCK_WORDS; i++) R[i] = mem[xOff + i] ^ yMem[yOff + i];
  Z.set(R);
  // Rows: 8 rows of 16 words (128 bytes): word pairs 16i .. 16i + 15.
  for (let i = 0; i < 8; i++) {
    const b = 32 * i;
    permute(Z, b, b + 2, b + 4, b + 6, b + 8, b + 10, b + 12, b + 14, b + 16, b + 18, b + 20, b + 22, b + 24, b + 26, b + 28, b + 30);
  }
  // Columns: register j of each row is the 16-byte pair of words (2j, 2j + 1) in that row.
  for (let i = 0; i < 8; i++) {
    const b = 4 * i;
    permute(Z, b, b + 2, b + 32, b + 34, b + 64, b + 66, b + 96, b + 98, b + 128, b + 130, b + 160, b + 162, b + 192, b + 194, b + 224, b + 226);
  }
  if (xor) {
    for (let i = 0; i < BLOCK_WORDS; i++) out[outOff + i] ^= Z[i] ^ R[i];
  } else {
    for (let i = 0; i < BLOCK_WORDS; i++) out[outOff + i] = Z[i] ^ R[i];
  }
}

function bytesToWords(bytes, words, off) {
  for (let i = 0; i < BLOCK_WORDS; i++) {
    words[off + i] = bytes[4 * i] | (bytes[4 * i + 1] << 8) | (bytes[4 * i + 2] << 16) | (bytes[4 * i + 3] << 24);
  }
}

function wordsToBytes(words, off) {
  const out = new Uint8Array(1024);
  for (let i = 0; i < BLOCK_WORDS; i++) {
    const w = words[off + i];
    out[4 * i] = w;
    out[4 * i + 1] = w >>> 8;
    out[4 * i + 2] = w >>> 16;
    out[4 * i + 3] = w >>> 24;
  }
  return out;
}

const asU8 = (x, name) => {
  if (x === undefined || x === null) return new Uint8Array(0);
  if (typeof x === 'string') return new TextEncoder().encode(x);
  if (x instanceof Uint8Array) return x;
  throw new TypeError('argon2id: ' + name + ' must be bytes or a string');
};

/**
 * argon2id({ password, salt, secret?, ad?, m, t, p, tagLength = 32 }) -> Uint8Array(tagLength)
 * m in KiB (at least 8 * p), t passes, p lanes (computed one after another: no threads).
 */
export function argon2id(opts) {
  const it = argon2Steps(opts, 0);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

/**
 * argon2idAsync(opts, { sliceBlocks = 1024, onProgress, yieldFn }) -> Promise<Uint8Array>: the same result as
 * argon2id, computed in slices of sliceBlocks memory blocks with a yield to the event loop between them, so the page
 * paints its busy card and keeps responding while the passphrase is stretched (code review v0.3, browser: the
 * synchronous run froze the identity page for 2 to 3 seconds on an M3, longer on phones). onProgress(fraction 0..1)
 * after each slice. yieldFn defaults to scheduler.yield(), else a MessageChannel round, else setTimeout(0).
 */
export async function argon2idAsync(opts, { sliceBlocks = 1024, onProgress = null, yieldFn = yieldToEventLoop } = {}) {
  const it = argon2Steps(opts, Math.max(1, sliceBlocks | 0));
  let r = it.next();
  while (!r.done) {
    if (typeof onProgress === 'function') {
      try { onProgress(r.value); } catch (_) { /* a progress line must not stop the KDF */ }
    }
    await yieldFn();
    r = it.next();
  }
  return r.value;
}

/** yieldToEventLoop() -> a promise settled after the event loop had a turn (rendering included in a browser). */
export function yieldToEventLoop() {
  const g = globalThis;
  if (g.scheduler && typeof g.scheduler.yield === 'function') return g.scheduler.yield();
  if (typeof g.MessageChannel === 'function') {
    return new Promise((resolve) => {
      const ch = new g.MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.close();
        ch.port2.close();
        resolve();
      };
      ch.port2.postMessage(0);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function* argon2Steps({ password, salt, secret, ad, m, t, p, tagLength = 32 }, sliceBlocks) {
  const P = asU8(password, 'password');
  const S = asU8(salt, 'salt');
  const K = asU8(secret, 'secret');
  const X = asU8(ad, 'ad');
  if (S.length < 8) throw new RangeError('argon2id: salt must be at least 8 bytes');
  if (!Number.isInteger(p) || p < 1 || p > 255) throw new RangeError('argon2id: p must be 1..255');
  if (!Number.isInteger(t) || t < 1 || t > 64) throw new RangeError('argon2id: t must be 1..64');
  if (!Number.isInteger(m) || m < 8 * p || m > 4194304) throw new RangeError('argon2id: m must be 8p..4194304 KiB');
  if (!Number.isInteger(tagLength) || tagLength < 4 || tagLength > 1024) throw new RangeError('argon2id: tag length 4..1024');

  const h0 = blake2b(concat([
    le32(p), le32(tagLength), le32(m), le32(t), le32(ARGON2_VERSION), le32(TYPE_ID),
    le32(P.length), P, le32(S.length), S, le32(K.length), K, le32(X.length), X,
  ]), 64);

  const mBlocks = 4 * p * Math.floor(m / (4 * p));
  const laneLen = mBlocks / p;
  const segLen = laneLen / SYNC_POINTS;
  const mem = new Uint32Array(mBlocks * BLOCK_WORDS);
  const blockOff = (lane, col) => (lane * laneLen + col) * BLOCK_WORDS;

  for (let l = 0; l < p; l++) {
    bytesToWords(hPrime(concat([h0, le32(0), le32(l)]), 1024), mem, blockOff(l, 0));
    bytesToWords(hPrime(concat([h0, le32(1), le32(l)]), 1024), mem, blockOff(l, 1));
  }

  const zero = new Uint32Array(BLOCK_WORDS);
  const input = new Uint32Array(BLOCK_WORDS);
  const address = new Uint32Array(BLOCK_WORDS);
  const totalBlocks = t * mBlocks;
  let doneBlocks = 0;

  for (let pass = 0; pass < t; pass++) {
    for (let slice = 0; slice < SYNC_POINTS; slice++) {
      for (let lane = 0; lane < p; lane++) {
        const dataIndependent = pass === 0 && slice < SYNC_POINTS / 2;
        if (dataIndependent) {
          input.fill(0);
          input[0] = pass;
          input[2] = lane;
          input[4] = slice;
          input[6] = mBlocks;
          input[8] = t;
          input[10] = TYPE_ID;
        }
        let start = 0;
        if (pass === 0 && slice === 0) {
          start = 2;
          if (dataIndependent) nextAddresses(input, address, zero);
        }
        for (let idx = start; idx < segLen; idx++) {
          const col = slice * segLen + idx;
          const prevCol = col === 0 ? laneLen - 1 : col - 1;
          const prevOff = blockOff(lane, prevCol);
          let j1;
          let j2;
          if (dataIndependent) {
            if (idx % 128 === 0) nextAddresses(input, address, zero);
            j1 = address[2 * (idx % 128)];
            j2 = address[2 * (idx % 128) + 1];
          } else {
            j1 = mem[prevOff];
            j2 = mem[prevOff + 1];
          }
          let refLane = j2 % p;
          if (pass === 0 && slice === 0) refLane = lane;
          const sameLane = refLane === lane;
          let area;
          if (pass === 0) {
            if (slice === 0) area = idx - 1;
            else if (sameLane) area = slice * segLen + idx - 1;
            else area = slice * segLen + (idx === 0 ? -1 : 0);
          } else if (sameLane) {
            area = laneLen - segLen + idx - 1;
          } else {
            area = laneLen - segLen + (idx === 0 ? -1 : 0);
          }
          // relative = area - 1 - (area * ((j1 * j1) >> 32) >> 32), computed exactly.
          const xf = mulHigh(j1, j1);
          const y = mulHigh(area, xf);
          const rel = area - 1 - y;
          const startPos = pass !== 0 && slice !== SYNC_POINTS - 1 ? (slice + 1) * segLen : 0;
          const refCol = (startPos + rel) % laneLen;
          compress(mem, prevOff, mem, blockOff(refLane, refCol), mem, blockOff(lane, col), pass !== 0);
          if (sliceBlocks && ++doneBlocks % sliceBlocks === 0) yield doneBlocks / totalBlocks;
        }
      }
    }
  }

  const fin = new Uint32Array(BLOCK_WORDS);
  for (let l = 0; l < p; l++) {
    const off = blockOff(l, laneLen - 1);
    for (let i = 0; i < BLOCK_WORDS; i++) fin[i] ^= mem[off + i];
  }
  return hPrime(wordsToBytes(fin, 0), tagLength);
}

// High 32 bits of a 32 x 32 product, exactly.
function mulHigh(a, b) {
  mul32(a >>> 0, b >>> 0);
  return MUL[1] >>> 0;
}

function nextAddresses(input, address, zero) {
  // Counter is the 64-bit word 6 (words 12, 13).
  input[12] = (input[12] + 1) >>> 0;
  if (input[12] === 0) input[13] = (input[13] + 1) >>> 0;
  compress(zero, 0, input, 0, address, 0, false);
  compress(zero, 0, address, 0, address, 0, false);
}

/** ARGON2ID_DEFAULTS: the identity origin's parameters (R 2.2.4): m = 64 MiB, t = 3, p = 1. */
export const ARGON2ID_DEFAULTS = Object.freeze({ m: 65536, t: 3, p: 1 });
