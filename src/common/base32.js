// RFC 4648 base32 (alphabet a-z2-7), used for hub labels (ARCHITECTURE §3.2) and for the 32-character
// form of a btih in magnet links. Shared by Node >= 22 and browsers: Uint8Array only, no Buffer.

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const VALUES = new Int8Array(128).fill(-1);
for (let i = 0; i < 32; i++) {
  VALUES[ALPHABET.charCodeAt(i)] = i;
  VALUES[ALPHABET.toUpperCase().charCodeAt(i)] = i;
}

// A base32 string of length L carries floor(L * 5 / 8) bytes; these lengths (mod 8) never occur
// in an unpadded encoding because they would leave a whole unused 5-bit group.
const INVALID_REMAINDERS = new Set([1, 3, 6]);

function asBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('base32.encode expects a Uint8Array, ArrayBuffer or ArrayBufferView');
}

/** encode(u8) → lowercase RFC 4648 base32 without '=' padding. */
export function encode(u8) {
  const bytes = asBytes(u8);
  let out = '';
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    acc = (acc << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >>> bits) & 31];
    }
    acc &= (1 << bits) - 1; // keep only the bits not yet emitted (at most 4)
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/**
 * decode(str) → Uint8Array. Either case is accepted and trailing '=' padding is tolerated.
 * Strict otherwise: any other character, an impossible length, or non-zero unused trailing
 * bits throw a TypeError, so every byte string has exactly one accepted spelling per case.
 */
export function decode(str) {
  if (typeof str !== 'string') throw new TypeError('base32.decode expects a string');
  let end = str.length;
  while (end > 0 && str.charCodeAt(end - 1) === 0x3d /* = */) end--;
  if (INVALID_REMAINDERS.has(end % 8)) throw new TypeError('base32.decode: invalid length');
  const out = new Uint8Array(Math.floor((end * 5) / 8));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < end; i++) {
    const c = str.charCodeAt(i);
    const v = c < 128 ? VALUES[c] : -1;
    if (v < 0) throw new TypeError('base32.decode: invalid character');
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
    acc &= (1 << bits) - 1;
  }
  if (acc !== 0) throw new TypeError('base32.decode: non-canonical trailing bits');
  return out;
}
