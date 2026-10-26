// A small DEFLATE (RFC 1951) and gzip (RFC 1952) decoder for browsers without DecompressionStream
// (Safari and iOS 15.4 to 16.3, the declared floor; code review round 1: gzip ledger snapshots, the
// default output of tools/snapshot.mjs, were unreadable there). Canonical Huffman codes are decoded
// one bit at a time from per-length counts, as zlib's puff.c does: compact and exact, fast enough for
// a snapshot of a few megabytes. Every output is capped (maxOutput) so a small input cannot inflate
// without bound. Pure functions, no dependencies, ES2017.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
  4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const MAX_BITS = 15;

function fail(message) {
  const err = new Error('inflate: ' + message);
  err.code = 'E_INFLATE';
  return err;
}

// Huffman table from code lengths: counts per length and the symbols in canonical order.
function huffman(lengths, n) {
  const counts = new Uint16Array(MAX_BITS + 1);
  for (let i = 0; i < n; i++) counts[lengths[i]]++;
  counts[0] = 0;
  let left = 1;
  for (let len = 1; len <= MAX_BITS; len++) {
    left <<= 1;
    left -= counts[len];
    if (left < 0) throw fail('over-subscribed code');
  }
  const offs = new Uint16Array(MAX_BITS + 2);
  for (let len = 1; len <= MAX_BITS; len++) offs[len + 1] = offs[len] + counts[len];
  const symbols = new Uint16Array(n);
  for (let i = 0; i < n; i++) if (lengths[i] !== 0) symbols[offs[lengths[i]]++] = i;
  return { counts, symbols };
}

let FIXED = null;
function fixedTables() {
  if (FIXED) return FIXED;
  const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  const d = new Uint8Array(30).fill(5);
  FIXED = { lit: huffman(l, 288), dist: huffman(d, 30) };
  return FIXED;
}

class Output {
  constructor(max, hint) {
    this.max = max;
    this.buf = new Uint8Array(Math.max(1024, Math.min(max, hint || 65536)));
    this.n = 0;
  }

  grow(need) {
    if (need > this.max) throw fail('output larger than ' + this.max + ' bytes');
    if (need <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < need) size *= 2;
    if (size > this.max) size = this.max;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.n));
    this.buf = next;
  }

  byte(b) {
    if (this.n >= this.buf.length) this.grow(this.n + 1);
    this.buf[this.n++] = b;
  }

  copy(dist, len) {
    if (dist > this.n) throw fail('distance too far back');
    this.grow(this.n + len);
    const buf = this.buf;
    let from = this.n - dist;
    for (let i = 0; i < len; i++) buf[this.n++] = buf[from++];
  }

  result() {
    return this.buf.slice(0, this.n);
  }
}

class Bits {
  constructor(bytes, pos) {
    this.bytes = bytes;
    this.pos = pos;
    this.bitbuf = 0;
    this.bitcnt = 0;
  }

  need(n) {
    let val = this.bitbuf;
    while (this.bitcnt < n) {
      if (this.pos >= this.bytes.length) throw fail('unexpected end of data');
      val |= this.bytes[this.pos++] << this.bitcnt;
      this.bitcnt += 8;
    }
    this.bitbuf = val >>> n;
    this.bitcnt -= n;
    return val & ((1 << n) - 1);
  }

  // Decodes one symbol bit by bit (Huffman codes are packed most-significant bit first).
  decode(h) {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= MAX_BITS; len++) {
      code |= this.need(1);
      const count = h.counts[len];
      if (code - first < count) return h.symbols[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw fail('bad Huffman code');
  }

  align() {
    this.bitbuf = 0;
    this.bitcnt = 0;
  }
}

function stored(bits, out) {
  bits.align();
  const b = bits.bytes;
  if (bits.pos + 4 > b.length) throw fail('unexpected end of data');
  const len = b[bits.pos] | (b[bits.pos + 1] << 8);
  const nlen = b[bits.pos + 2] | (b[bits.pos + 3] << 8);
  bits.pos += 4;
  if (len !== (~nlen & 0xffff)) throw fail('stored block length mismatch');
  if (bits.pos + len > b.length) throw fail('unexpected end of data');
  out.grow(out.n + len);
  out.buf.set(b.subarray(bits.pos, bits.pos + len), out.n);
  out.n += len;
  bits.pos += len;
}

function codes(bits, out, lit, dist) {
  for (;;) {
    const sym = bits.decode(lit);
    if (sym < 256) {
      out.byte(sym);
    } else if (sym === 256) {
      return;
    } else {
      const li = sym - 257;
      if (li >= 29) throw fail('bad length symbol');
      const len = LEN_BASE[li] + bits.need(LEN_EXTRA[li]);
      const ds = bits.decode(dist);
      if (ds >= 30) throw fail('bad distance symbol');
      const d = DIST_BASE[ds] + bits.need(DIST_EXTRA[ds]);
      out.copy(d, len);
    }
  }
}

function dynamic(bits, out) {
  const nlen = bits.need(5) + 257;
  const ndist = bits.need(5) + 1;
  const ncode = bits.need(4) + 4;
  if (nlen > 286 || ndist > 30) throw fail('bad code counts');
  const lengths = new Uint8Array(320);
  for (let i = 0; i < ncode; i++) lengths[CLEN_ORDER[i]] = bits.need(3);
  const lencode = huffman(lengths, 19);
  const all = new Uint8Array(nlen + ndist);
  let index = 0;
  while (index < nlen + ndist) {
    let sym = bits.decode(lencode);
    if (sym < 16) {
      all[index++] = sym;
    } else {
      let len = 0;
      let repeat;
      if (sym === 16) {
        if (index === 0) throw fail('repeat with no previous length');
        len = all[index - 1];
        repeat = 3 + bits.need(2);
      } else if (sym === 17) {
        repeat = 3 + bits.need(3);
      } else {
        repeat = 11 + bits.need(7);
      }
      if (index + repeat > nlen + ndist) throw fail('too many code lengths');
      while (repeat--) all[index++] = len;
      sym = len;
    }
  }
  if (all[256] === 0) throw fail('no end-of-block code');
  const lit = huffman(all.subarray(0, nlen), nlen);
  const dist = huffman(all.subarray(nlen), ndist);
  codes(bits, out, lit, dist);
}

/**
 * inflateRaw(bytes, { maxOutput = 64 MiB, start = 0 }) → { data: Uint8Array, end } : decodes one raw
 * DEFLATE stream starting at byte `start`; `end` is the offset of the first byte after it.
 * Throws an Error with code 'E_INFLATE' on malformed data or when the output exceeds maxOutput.
 */
export function inflateRaw(bytes, { maxOutput = 64 * 1024 * 1024, start = 0, hint = 0 } = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('inflateRaw expects a Uint8Array');
  const bits = new Bits(bytes, start);
  const out = new Output(maxOutput, hint || bytes.length * 4);
  let last = 0;
  while (!last) {
    last = bits.need(1);
    const type = bits.need(2);
    if (type === 0) stored(bits, out);
    else if (type === 1) codes(bits, out, fixedTables().lit, fixedTables().dist);
    else if (type === 2) dynamic(bits, out);
    else throw fail('bad block type');
  }
  return { data: out.result(), end: bits.pos };
}

let CRC_TABLE = null;
/** crc32(bytes) → unsigned 32-bit CRC (IEEE, as gzip uses). */
export function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * gunzip(bytes, { maxOutput = 64 MiB }) → Uint8Array: every gzip member of `bytes`, concatenated
 * (RFC 1952), with the CRC-32 and size of each member checked. Throws 'E_INFLATE' errors.
 */
export function gunzip(bytes, { maxOutput = 64 * 1024 * 1024 } = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('gunzip expects a Uint8Array');
  const parts = [];
  let total = 0;
  let pos = 0;
  while (pos < bytes.length) {
    if (bytes.length - pos < 18 || bytes[pos] !== 0x1f || bytes[pos + 1] !== 0x8b) {
      if (parts.length > 0 && bytes.subarray(pos).every((b) => b === 0)) break; // zero padding after the last member
      throw fail('not a gzip member');
    }
    if (bytes[pos + 2] !== 8) throw fail('unknown compression method');
    const flags = bytes[pos + 3];
    let p = pos + 10;
    if (flags & 4) {
      if (p + 2 > bytes.length) throw fail('unexpected end of data');
      p += 2 + (bytes[p] | (bytes[p + 1] << 8));
    }
    if (flags & 8) {
      while (p < bytes.length && bytes[p] !== 0) p++;
      p++;
    }
    if (flags & 16) {
      while (p < bytes.length && bytes[p] !== 0) p++;
      p++;
    }
    if (flags & 2) p += 2;
    if (p > bytes.length) throw fail('unexpected end of data');
    const { data, end } = inflateRaw(bytes, { maxOutput: maxOutput - total, start: p });
    if (end + 8 > bytes.length) throw fail('missing gzip trailer');
    const crc = (bytes[end] | (bytes[end + 1] << 8) | (bytes[end + 2] << 16) | (bytes[end + 3] << 24)) >>> 0;
    const size = (bytes[end + 4] | (bytes[end + 5] << 8) | (bytes[end + 6] << 16) | (bytes[end + 7] << 24)) >>> 0;
    if (crc32(data) !== crc) throw fail('CRC-32 mismatch');
    if ((data.length >>> 0) !== size) throw fail('size mismatch');
    parts.push(data);
    total += data.length;
    pos = end + 8;
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}
