// src/idp/qr.js: a QR code encoder and decoder bundled in the identity origin (R 2.3.8, 2.13 "Camera QR
// scan (BarcodeDetector) absent in Safari and Firefox: bundled JS decoder"). Only the device link uses it
// (mwlink:2:... payloads, which never carry a site name or a ledger id).
//
//   encode(text | bytes, { ecl = 'M', minVersion = 1, maxVersion = 40, mask }) -> { version, size, ecl, mask, modules }
//       modules: Uint8Array(size * size), 1 = dark, row-major (modules[y * size + x])
//   toImageData(qr, { scale = 4, margin = 4 }) -> { width, height, data: Uint8ClampedArray RGBA }
//   decode(imageData) -> { text, bytes, version, ecl } | null      (RGBA pixels, any rotation, mild perspective)
//   decodeMatrix({ size, modules }) -> { text, bytes, version, ecl, mask, corrected } | null
//
// Encoder: byte mode only (UTF-8), Reed-Solomon over GF(256) with 0x11d, the 8 masks scored with the usual
// four penalty rules. Decoder: a block-average binarizer, finder patterns by the 1:1:3:1:1 run ratio, the
// alignment pattern for version 2 and up, a perspective transform, format and version information with BCH
// nearest-match, Reed-Solomon correction (Berlekamp-Massey, Chien, Forney) and the numeric, alphanumeric and
// byte segment modes (ECI headers are skipped; Kanji is refused). The tables follow ISO/IEC 18004 (the same
// two arrays most implementations use). Pure: Node >= 22 and browsers; no DOM.

export const ECL = Object.freeze({ L: 1, M: 0, Q: 3, H: 2 }); // format bits of each level
const ECL_INDEX = { L: 0, M: 1, Q: 2, H: 3 };
const ECL_BY_BITS = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' };

// Index 0 is padding. Rows: L, M, Q, H.
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

// ---------------------------------------------------------------------------------------------
// GF(256), polynomial 0x11d, generator 2
// ---------------------------------------------------------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function tables() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gmul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function gdiv(a, b) {
  if (b === 0) throw new RangeError('qr: division by zero');
  if (a === 0) return 0;
  return EXP[(LOG[a] + 255 - LOG[b]) % 255];
}

function gpow(e) {
  return EXP[((e % 255) + 255) % 255];
}

/** Generator polynomial of degree n (roots 2^0 .. 2^(n-1)), highest degree first without the leading 1. */
function rsDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gmul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gmul(root, 2);
  }
  return result;
}

/** rsRemainder(data, divisor) -> the ECC codewords of a block (exported for the vector test). */
export function rsRemainder(data, divisor) {
  const n = divisor.length;
  const result = new Uint8Array(n);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[n - 1] = 0;
    for (let i = 0; i < n; i++) result[i] ^= gmul(divisor[i], factor);
  }
  return result;
}

/** rsEcc(data, n) -> n ECC codewords for the data codewords (highest degree first). */
export function rsEcc(data, n) {
  return rsRemainder(data, rsDivisor(n));
}

// Polynomials below are low degree first.
function polyEval(p, x) {
  let y = 0;
  for (let i = p.length - 1; i >= 0; i--) y = gmul(y, x) ^ p[i];
  return y;
}

/**
 * rsCorrect(block, nsym) -> number of corrected codewords, or -1 when the block cannot be corrected.
 * block: Uint8Array of data then ECC codewords, corrected in place.
 */
export function rsCorrect(block, nsym) {
  const n = block.length;
  const S = new Uint8Array(nsym);
  let any = false;
  for (let j = 0; j < nsym; j++) {
    const x = gpow(j);
    let y = 0;
    for (let k = 0; k < n; k++) y = gmul(y, x) ^ block[k];
    S[j] = y;
    if (y) any = true;
  }
  if (!any) return 0;
  // Berlekamp-Massey
  let C = [1];
  let B = [1];
  let L = 0;
  let m = 1;
  let b = 1;
  for (let i = 0; i < nsym; i++) {
    let d = S[i];
    for (let k = 1; k <= L; k++) d ^= gmul(C[k] || 0, S[i - k]);
    if (d === 0) {
      m++;
      continue;
    }
    const coef = gdiv(d, b);
    const next = C.slice();
    while (next.length < B.length + m) next.push(0);
    for (let k = 0; k < B.length; k++) next[k + m] ^= gmul(coef, B[k]);
    if (2 * L <= i) {
      B = C;
      L = i + 1 - L;
      b = d;
      m = 1;
    } else {
      m++;
    }
    C = next;
  }
  while (C.length > 1 && C[C.length - 1] === 0) C.pop();
  if (L * 2 > nsym || C.length - 1 !== L) return -1;
  // Chien search: position k has degree n - 1 - k, X = 2^(n-1-k).
  const positions = [];
  for (let k = 0; k < n; k++) {
    const xinv = gpow(-(n - 1 - k));
    if (polyEval(C, xinv) === 0) positions.push(k);
  }
  if (positions.length !== L) return -1;
  // Omega = S(x) * Lambda(x) mod x^nsym
  const omega = new Uint8Array(nsym);
  for (let i = 0; i < nsym; i++) {
    let v = 0;
    for (let k = 0; k <= i && k < C.length; k++) v ^= gmul(C[k], S[i - k]);
    omega[i] = v;
  }
  // Lambda'(x): odd terms survive
  const deriv = [];
  for (let i = 1; i < C.length; i++) deriv[i - 1] = i % 2 === 1 ? C[i] : 0;
  for (const k of positions) {
    const X = gpow(n - 1 - k);
    const xinv = gdiv(1, X);
    const den = polyEval(deriv, xinv);
    if (den === 0) return -1;
    const mag = gmul(X, gdiv(polyEval(omega, xinv), den));
    block[k] ^= mag;
  }
  for (let j = 0; j < nsym; j++) {
    const x = gpow(j);
    let y = 0;
    for (let k = 0; k < n; k++) y = gmul(y, x) ^ block[k];
    if (y) return -1;
  }
  return positions.length;
}

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

function rawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

/** dataCodewords(version, ecl) -> how many data codewords the symbol holds. */
export function dataCodewords(ver, ecl) {
  const e = ECL_INDEX[ecl];
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[e][ver] * NUM_BLOCKS[e][ver];
}

function alignmentPositions(ver) {
  if (ver === 1) return [];
  const size = ver * 4 + 17;
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.floor((ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

function formatBits(eclBits, mask) {
  const data = (eclBits << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(ver) {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}

const FORMAT_TABLE = (() => {
  const out = [];
  for (let data = 0; data < 32; data++) out.push({ data, bits: formatBits(data >> 3, data & 7) });
  return out;
})();

const VERSION_TABLE = (() => {
  const out = [];
  for (let v = 7; v <= 40; v++) out.push({ v, bits: versionBits(v) });
  return out;
})();

function popcount(x) {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}

/** Function-module layout of a version: { size, fn: Uint8Array (1 = function module), dark: Uint8Array }. */
function functionLayout(ver) {
  const size = ver * 4 + 17;
  const fn = new Uint8Array(size * size);
  const dark = new Uint8Array(size * size);
  const set = (x, y, d) => {
    fn[y * size + x] = 1;
    dark[y * size + x] = d ? 1 : 0;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const align = alignmentPositions(ver);
  const n = align.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) set(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  // Format areas (reserved; drawn with real bits later) and the dark module.
  for (let i = 0; i <= 8; i++) {
    if (!fn[8 * size + i]) set(i, 8, false);
    if (!fn[i * size + 8]) set(8, i, false);
  }
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, false);
  for (let i = 0; i < 8; i++) set(8, size - 1 - i, false);
  set(8, size - 8, true);
  if (ver >= 7) {
    const bits = versionBits(ver);
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit);
      set(b, a, bit);
    }
  }
  return { size, fn, dark };
}

function drawFormat(modules, size, eclBits, mask) {
  const bits = formatBits(eclBits, mask);
  const bit = (i) => (bits >>> i) & 1;
  const put = (x, y, v) => { modules[y * size + x] = v; };
  for (let i = 0; i <= 5; i++) put(8, i, bit(i));
  put(8, 7, bit(6));
  put(8, 8, bit(7));
  put(7, 8, bit(8));
  for (let i = 9; i < 15; i++) put(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) put(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) put(8, size - 15 + i, bit(i));
  put(8, size - 8, 1);
}

function maskBit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: throw new RangeError('qr: mask 0..7');
  }
}

/** The zigzag order of the data modules: calls visit(x, y) for every non-function module in reading order. */
function zigzag(size, fn, visit) {
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y * size + x]) visit(x, y);
      }
    }
  }
}

/** The interleaving plan: for each position of the codeword stream, [block index, index in block]. */
function blockPlan(ver, ecl) {
  const e = ECL_INDEX[ecl];
  const numBlocks = NUM_BLOCKS[e][ver];
  const eccLen = ECC_PER_BLOCK[e][ver];
  const raw = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const blocks = [];
  for (let i = 0; i < numBlocks; i++) {
    const dataLen = shortLen - eccLen + (i < numShort ? 0 : 1);
    blocks.push({ dataLen, eccLen, len: dataLen + eccLen });
  }
  const order = [];
  // Data codewords, column by column, then ECC codewords column by column.
  const maxData = shortLen - eccLen + 1;
  for (let i = 0; i < maxData; i++) for (let j = 0; j < numBlocks; j++) if (i < blocks[j].dataLen) order.push([j, i]);
  for (let i = 0; i < eccLen; i++) for (let j = 0; j < numBlocks; j++) order.push([j, blocks[j].dataLen + i]);
  return { blocks, order, raw, eccLen };
}

function penalty(m, size) {
  let score = 0;
  // Rule 1: runs of 5 or more in rows and columns.
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      let run = 1;
      let prev = pass === 0 ? m[a * size] : m[a];
      for (let b = 1; b < size; b++) {
        const v = pass === 0 ? m[a * size + b] : m[b * size + a];
        if (v === prev) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
          prev = v;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }
  // Rule 2: 2x2 blocks.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = m[y * size + x];
      if (v === m[y * size + x + 1] && v === m[(y + 1) * size + x] && v === m[(y + 1) * size + x + 1]) score += 3;
    }
  }
  // Rule 3: finder-like 1011101 with four light modules on one side.
  const P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      for (let b = 0; b + 11 <= size; b++) {
        let ok1 = true;
        let ok2 = true;
        for (let k = 0; k < 11 && (ok1 || ok2); k++) {
          const v = pass === 0 ? m[a * size + b + k] : m[(b + k) * size + a];
          if (v !== P1[k]) ok1 = false;
          if (v !== P2[k]) ok2 = false;
        }
        if (ok1) score += 40;
        if (ok2) score += 40;
      }
    }
  }
  // Rule 4: dark proportion.
  let dark = 0;
  for (let i = 0; i < m.length; i++) dark += m[i];
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  score += Math.max(0, k) * 10;
  return score;
}

function utf8Bytes(text) {
  return new TextEncoder().encode(text);
}

/**
 * encode(input, { ecl = 'M', minVersion = 1, maxVersion = 40, mask }) -> { version, size, ecl, mask, modules }
 * input: a string (UTF-8) or a Uint8Array. Throws RangeError when the data does not fit version 40.
 */
export function encode(input, { ecl = 'M', minVersion = 1, maxVersion = 40, mask } = {}) {
  if (!Object.prototype.hasOwnProperty.call(ECL_INDEX, ecl)) throw new RangeError('qr: ecl must be L, M, Q or H');
  const bytes = typeof input === 'string' ? utf8Bytes(input) : input;
  if (!(bytes instanceof Uint8Array)) throw new TypeError('qr: encode takes a string or a Uint8Array');
  let ver = 0;
  for (let v = Math.max(1, minVersion); v <= Math.min(40, maxVersion); v++) {
    const countBits = v <= 9 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataCodewords(v, ecl) * 8) {
      ver = v;
      break;
    }
  }
  if (!ver) throw new RangeError('qr: ' + bytes.length + ' bytes do not fit a QR code at level ' + ecl);
  const capacity = dataCodewords(ver, ecl);
  const bits = [];
  const push = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  push(0x4, 4);
  push(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity * 8 - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  const data = new Uint8Array(capacity);
  let i = 0;
  for (; i * 8 < bits.length; i++) {
    let v = 0;
    for (let k = 0; k < 8; k++) v = (v << 1) | bits[i * 8 + k];
    data[i] = v;
  }
  for (let pad = 0xec; i < capacity; i++, pad ^= 0xec ^ 0x11) data[i] = pad;
  // Blocks and interleaving.
  const plan = blockPlan(ver, ecl);
  const divisor = rsDivisor(plan.eccLen);
  const blocks = [];
  let k = 0;
  for (const b of plan.blocks) {
    const d = data.subarray(k, k + b.dataLen);
    k += b.dataLen;
    const block = new Uint8Array(b.len);
    block.set(d, 0);
    block.set(rsRemainder(d, divisor), b.dataLen);
    blocks.push(block);
  }
  const stream = new Uint8Array(plan.raw);
  plan.order.forEach(([bi, ii], n) => { stream[n] = blocks[bi][ii]; });
  const layout = functionLayout(ver);
  const { size, fn } = layout;
  const base = Uint8Array.from(layout.dark);
  let bit = 0;
  zigzag(size, fn, (x, y) => {
    const byte = bit >>> 3;
    base[y * size + x] = byte < stream.length ? (stream[byte] >>> (7 - (bit & 7))) & 1 : 0;
    bit++;
  });
  const eclBits = ECL[ecl];
  let best = null;
  const masks = mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [mask];
  for (const mk of masks) {
    const m = Uint8Array.from(base);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y * size + x] && maskBit(mk, x, y)) m[y * size + x] ^= 1;
    drawFormat(m, size, eclBits, mk);
    const score = masks.length === 1 ? 0 : penalty(m, size);
    if (!best || score < best.score) best = { score, mask: mk, modules: m };
  }
  return { version: ver, size, ecl, mask: best.mask, modules: best.modules };
}

/** toImageData(qr, { scale, margin }) -> RGBA pixels (black on white) for tests and canvas drawing. */
export function toImageData(qr, { scale = 4, margin = 4 } = {}) {
  const dim = (qr.size + 2 * margin) * scale;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.modules[y * qr.size + x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        const row = ((y + margin) * scale + dy) * dim;
        for (let dx = 0; dx < scale; dx++) {
          const p = (row + (x + margin) * scale + dx) * 4;
          data[p] = 0;
          data[p + 1] = 0;
          data[p + 2] = 0;
        }
      }
    }
  }
  return { width: dim, height: dim, data };
}

// ---------------------------------------------------------------------------------------------
// Decoding a module matrix
// ---------------------------------------------------------------------------------------------

function readFormat(get, size) {
  let a = 0;
  let b = 0;
  for (let i = 0; i <= 5; i++) a |= get(8, i) << i;
  a |= get(8, 7) << 6;
  a |= get(8, 8) << 7;
  a |= get(7, 8) << 8;
  for (let i = 9; i < 15; i++) a |= get(14 - i, 8) << i;
  for (let i = 0; i < 8; i++) b |= get(size - 1 - i, 8) << i;
  for (let i = 8; i < 15; i++) b |= get(8, size - 15 + i) << i;
  let best = null;
  for (const f of FORMAT_TABLE) {
    const d = Math.min(popcount(f.bits ^ a), popcount(f.bits ^ b));
    if (!best || d < best.d) best = { d, data: f.data };
  }
  if (!best || best.d > 3) return null;
  return { ecl: ECL_BY_BITS[best.data >> 3], mask: best.data & 7 };
}

function readVersion(get, size) {
  let a = 0;
  let b = 0;
  for (let i = 0; i < 18; i++) {
    const x = size - 11 + (i % 3);
    const y = Math.floor(i / 3);
    a |= get(x, y) << i;
    b |= get(y, x) << i;
  }
  let best = null;
  for (const v of VERSION_TABLE) {
    const d = Math.min(popcount(v.bits ^ a), popcount(v.bits ^ b));
    if (!best || d < best.d) best = { d, v: v.v };
  }
  return best && best.d <= 3 ? best.v : null;
}

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

function parseSegments(data, ver) {
  let pos = 0;
  const total = data.length * 8;
  const read = (n) => {
    if (pos + n > total) throw new RangeError('qr: truncated segment');
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = (v << 1) | ((data[(pos + i) >>> 3] >>> (7 - ((pos + i) & 7))) & 1);
    }
    pos += n;
    return v >>> 0;
  };
  const group = ver <= 9 ? 0 : ver <= 26 ? 1 : 2;
  const out = [];
  while (pos + 4 <= total) {
    const mode = read(4);
    if (mode === 0) break;
    if (mode === 0x7) {
      // ECI: 1, 2 or 3 bytes; the assignment is ignored (UTF-8 is assumed).
      const first = read(8);
      if ((first & 0x80) === 0) continue;
      if ((first & 0xc0) === 0x80) { read(8); continue; }
      read(16);
      continue;
    }
    if (mode === 0x1) {
      let count = read([10, 12, 14][group]);
      while (count >= 3) {
        const v = read(10);
        if (v > 999) throw new RangeError('qr: bad numeric group');
        out.push(...String(v).padStart(3, '0').split('').map((c) => c.charCodeAt(0)));
        count -= 3;
      }
      if (count === 2) {
        const v = read(7);
        if (v > 99) throw new RangeError('qr: bad numeric group');
        out.push(...String(v).padStart(2, '0').split('').map((c) => c.charCodeAt(0)));
      } else if (count === 1) {
        const v = read(4);
        if (v > 9) throw new RangeError('qr: bad numeric group');
        out.push(48 + v);
      }
    } else if (mode === 0x2) {
      let count = read([9, 11, 13][group]);
      while (count >= 2) {
        const v = read(11);
        const a = Math.floor(v / 45);
        const b = v % 45;
        if (a >= 45) throw new RangeError('qr: bad alphanumeric pair');
        out.push(ALNUM.charCodeAt(a), ALNUM.charCodeAt(b));
        count -= 2;
      }
      if (count === 1) {
        const v = read(6);
        if (v >= 45) throw new RangeError('qr: bad alphanumeric character');
        out.push(ALNUM.charCodeAt(v));
      }
    } else if (mode === 0x4) {
      const count = read([8, 16, 16][group]);
      for (let i = 0; i < count; i++) out.push(read(8));
    } else {
      throw new RangeError('qr: unsupported segment mode ' + mode);
    }
  }
  return Uint8Array.from(out);
}

/**
 * decodeMatrix({ size, modules }) -> { text, bytes, version, ecl, mask, corrected } | null
 * modules: Uint8Array(size * size), 1 = dark. Returns null when the symbol cannot be read.
 */
export function decodeMatrix({ size, modules }) {
  if (!Number.isInteger(size) || size < 21 || size > 177 || (size - 17) % 4 !== 0) return null;
  if (!modules || modules.length !== size * size) return null;
  let ver = (size - 17) / 4;
  const get = (x, y) => (modules[y * size + x] ? 1 : 0);
  const format = readFormat(get, size);
  if (!format) return null;
  if (ver >= 7) {
    const v = readVersion(get, size);
    if (v === null || v !== ver) return null;
  }
  const { fn } = functionLayout(ver);
  const plan = blockPlan(ver, format.ecl);
  const stream = new Uint8Array(plan.raw);
  let bit = 0;
  zigzag(size, fn, (x, y) => {
    const byte = bit >>> 3;
    if (byte < stream.length) {
      let v = get(x, y);
      if (maskBit(format.mask, x, y)) v ^= 1;
      stream[byte] |= v << (7 - (bit & 7));
    }
    bit++;
  });
  const blocks = plan.blocks.map((b) => new Uint8Array(b.len));
  plan.order.forEach(([bi, ii], n) => { blocks[bi][ii] = stream[n]; });
  let corrected = 0;
  const data = [];
  for (let i = 0; i < blocks.length; i++) {
    const c = rsCorrect(blocks[i], plan.eccLen);
    if (c < 0) return null;
    corrected += c;
    for (let k = 0; k < plan.blocks[i].dataLen; k++) data.push(blocks[i][k]);
  }
  let bytes;
  try {
    bytes = parseSegments(Uint8Array.from(data), ver);
  } catch (_) {
    return null;
  }
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return { text, bytes, version: ver, ecl: format.ecl, mask: format.mask, corrected };
}

// ---------------------------------------------------------------------------------------------
// Decoding pixels
// ---------------------------------------------------------------------------------------------

/** binarize({ width, height, data }) -> Uint8Array (1 = dark) with a block-average threshold. */
export function binarize({ width, height, data }) {
  const n = width * height;
  const lum = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) lum[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
  const out = new Uint8Array(n);
  const B = 8;
  const bw = Math.ceil(width / B);
  const bh = Math.ceil(height / B);
  if (bw < 5 || bh < 5) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += lum[i];
    const mean = sum / n;
    for (let i = 0; i < n; i++) out[i] = lum[i] < mean ? 1 : 0;
    return out;
  }
  const avg = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let sum = 0;
      let count = 0;
      let min = 255;
      let max = 0;
      for (let y = by * B; y < Math.min(height, by * B + B); y++) {
        for (let x = bx * B; x < Math.min(width, bx * B + B); x++) {
          const v = lum[y * width + x];
          sum += v;
          count++;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      let a = sum / count;
      if (max - min <= 24) {
        // Low contrast: assume background (light) unless the neighbours say otherwise.
        a = min / 2;
        if (by > 0 && bx > 0) {
          const nb = (avg[(by - 1) * bw + bx] + 2 * avg[by * bw + bx - 1] + avg[(by - 1) * bw + bx - 1]) / 4;
          if (min < nb) a = nb;
        }
      }
      avg[by * bw + bx] = a;
    }
  }
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let sum = 0;
      let count = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const yy = Math.min(bh - 1, Math.max(0, by + dy));
          const xx = Math.min(bw - 1, Math.max(0, bx + dx));
          sum += avg[yy * bw + xx];
          count++;
        }
      }
      const threshold = sum / count;
      for (let y = by * B; y < Math.min(height, by * B + B); y++) {
        for (let x = bx * B; x < Math.min(width, bx * B + B); x++) out[y * width + x] = lum[y * width + x] <= threshold ? 1 : 0;
      }
    }
  }
  return out;
}

function ratioOk(c) {
  const total = c[0] + c[1] + c[2] + c[3] + c[4];
  if (total < 7) return false;
  const m = total / 7;
  const v = m / 2;
  return Math.abs(m - c[0]) < v && Math.abs(m - c[1]) < v && Math.abs(3 * m - c[2]) < 3 * v && Math.abs(m - c[3]) < v && Math.abs(m - c[4]) < v;
}

function crossCheck(bits, width, height, cx, cy, dx, dy, maxCount, originalTotal) {
  // Walks from (cx, cy) in direction (dx, dy) and back, counting the five runs dark-light-dark-light-dark.
  const at = (x, y) => (x >= 0 && y >= 0 && x < width && y < height ? bits[y * width + x] : -1);
  const c = [0, 0, 0, 0, 0];
  let x = cx;
  let y = cy;
  while (at(x, y) === 1) { c[2]++; x -= dx; y -= dy; }
  if (at(x, y) === -1) return null;
  while (at(x, y) === 0 && c[1] <= maxCount) { c[1]++; x -= dx; y -= dy; }
  if (at(x, y) === -1 || c[1] > maxCount) return null;
  while (at(x, y) === 1 && c[0] <= maxCount) { c[0]++; x -= dx; y -= dy; }
  if (c[0] > maxCount) return null;
  x = cx + dx;
  y = cy + dy;
  while (at(x, y) === 1) { c[2]++; x += dx; y += dy; }
  if (at(x, y) === -1) return null;
  while (at(x, y) === 0 && c[3] < maxCount) { c[3]++; x += dx; y += dy; }
  if (at(x, y) === -1 || c[3] >= maxCount) return null;
  while (at(x, y) === 1 && c[4] < maxCount) { c[4]++; x += dx; y += dy; }
  if (c[4] >= maxCount) return null;
  const total = c[0] + c[1] + c[2] + c[3] + c[4];
  if (5 * Math.abs(total - originalTotal) >= 2 * originalTotal) return null;
  if (!ratioOk(c)) return null;
  // Centre along this direction: the end position minus half of the last three runs.
  const end = dx !== 0 ? x : y;
  return { center: end - (c[4] + c[3]) - c[2] / 2, total };
}

function findFinders(bits, width, height) {
  const candidates = [];
  const skip = Math.max(1, Math.floor(height / 300));
  for (let y = 0; y < height; y += skip) {
    const c = [0, 0, 0, 0, 0];
    let state = 0;
    for (let x = 0; x <= width; x++) {
      const v = x < width ? bits[y * width + x] : 0;
      if (v === 1) {
        if (state % 2 === 1) state++;
        c[state]++;
      } else if (state % 2 === 0) {
        if (state === 4) {
          if (ratioOk(c)) {
            const total = c[0] + c[1] + c[2] + c[3] + c[4];
            const centerX = Math.floor(x - c[4] - c[3] - c[2] / 2);
            const vert = crossCheck(bits, width, height, centerX, y, 0, 1, c[2], total);
            if (vert) {
              const cy = Math.floor(vert.center);
              const horiz = crossCheck(bits, width, height, centerX, cy, 1, 0, c[2], total);
              if (horiz) {
                const ms = (vert.total + horiz.total) / 14;
                const px = horiz.center;
                const py = vert.center;
                let merged = false;
                for (const cand of candidates) {
                  if (Math.abs(cand.x - px) <= ms && Math.abs(cand.y - py) <= ms && Math.abs(cand.ms - ms) <= Math.max(1, ms * 0.5)) {
                    cand.x = (cand.x * cand.count + px) / (cand.count + 1);
                    cand.y = (cand.y * cand.count + py) / (cand.count + 1);
                    cand.ms = (cand.ms * cand.count + ms) / (cand.count + 1);
                    cand.count++;
                    merged = true;
                    break;
                  }
                }
                if (!merged) candidates.push({ x: px, y: py, ms, count: 1 });
              }
            }
            c[0] = c[2]; c[1] = c[3]; c[2] = c[4]; c[3] = 1; c[4] = 0;
            state = 3;
          } else {
            c[0] = c[2]; c[1] = c[3]; c[2] = c[4]; c[3] = 1; c[4] = 0;
            state = 3;
          }
        } else {
          state++;
          if (state < 5) c[state]++;
        }
      } else {
        c[state]++;
      }
    }
  }
  return candidates;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pickThree(candidates) {
  const list = candidates.slice().sort((a, b) => b.count - a.count).slice(0, 8);
  let best = null;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      for (let k = j + 1; k < list.length; k++) {
        const t = [list[i], list[j], list[k]];
        const ms = (t[0].ms + t[1].ms + t[2].ms) / 3;
        if (t.some((p) => Math.abs(p.ms - ms) > ms * 0.5)) continue;
        const d = [dist(t[1], t[2]), dist(t[0], t[2]), dist(t[0], t[1])];
        const hyp = Math.max(d[0], d[1], d[2]);
        const legs = d.filter((x) => x !== hyp);
        if (legs.length !== 2) continue;
        const legRatio = Math.abs(legs[0] - legs[1]) / Math.max(legs[0], legs[1]);
        const hypRatio = Math.abs(hyp - Math.hypot(legs[0], legs[1])) / hyp;
        if (legs[0] < 7 * ms) continue;
        const score = legRatio + hypRatio - Math.min(t[0].count, t[1].count, t[2].count) * 0.01;
        if (legRatio < 0.35 && hypRatio < 0.2 && (!best || score < best.score)) best = { score, t, d };
      }
    }
  }
  if (!best) return null;
  const [p0, p1, p2] = best.t;
  const [d0, d1, d2] = best.d;
  // The corner opposite the longest side is the top-left finder.
  let tl;
  let a;
  let b;
  if (d0 >= d1 && d0 >= d2) { tl = p0; a = p1; b = p2; } else if (d1 >= d0 && d1 >= d2) { tl = p1; a = p0; b = p2; } else { tl = p2; a = p0; b = p1; }
  const cross = (a.x - tl.x) * (b.y - tl.y) - (a.y - tl.y) * (b.x - tl.x);
  return cross > 0 ? { tl, tr: a, bl: b } : { tl, tr: b, bl: a };
}

function perspective(src, dst) {
  // src and dst: [x0,y0, x1,y1, x2,y2, x3,y3]; returns a function mapping src to dst.
  const sq = (p) => {
    const [x0, y0, x1, y1, x2, y2, x3, y3] = p;
    const dx3 = x0 - x1 + x2 - x3;
    const dy3 = y0 - y1 + y2 - y3;
    if (Math.abs(dx3) < 1e-12 && Math.abs(dy3) < 1e-12) {
      return [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0, 1];
    }
    const dx1 = x1 - x2;
    const dx2 = x3 - x2;
    const dy1 = y1 - y2;
    const dy2 = y3 - y2;
    const den = dx1 * dy2 - dx2 * dy1;
    const a13 = (dx3 * dy2 - dx2 * dy3) / den;
    const a23 = (dx1 * dy3 - dx3 * dy1) / den;
    return [x1 - x0 + a13 * x1, x3 - x0 + a23 * x3, x0, y1 - y0 + a13 * y1, y3 - y0 + a23 * y3, y0, a13, a23, 1];
  };
  // sq maps the unit square to the quad (row-major 3x3 as [a11,a21,a31,a12,a22,a32,a13,a23,a33] in ZXing's
  // column convention); compose dst o inverse(src).
  const toMatrix = (m) => [[m[0], m[1], m[2]], [m[3], m[4], m[5]], [m[6], m[7], m[8]]];
  const A = toMatrix(sq(dst));
  const S = toMatrix(sq(src));
  const inv = (M) => {
    const [[a, b, c], [d, e, f], [g, h, i]] = M;
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    return [
      [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
      [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
      [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
    ];
  };
  const mul = (X, Y) => X.map((row, r) => [0, 1, 2].map((c) => row[0] * Y[0][c] + row[1] * Y[1][c] + row[2] * Y[2][c]));
  const M = mul(A, inv(S));
  return (x, y) => {
    const w = M[2][0] * x + M[2][1] * y + M[2][2];
    return [(M[0][0] * x + M[0][1] * y + M[0][2]) / w, (M[1][0] * x + M[1][1] * y + M[1][2]) / w];
  };
}

function sampleGrid(bits, width, height, map, size) {
  const modules = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [px, py] = map(x + 0.5, y + 0.5);
      const ix = Math.floor(px);
      const iy = Math.floor(py);
      if (ix < 0 || iy < 0 || ix >= width || iy >= height) return null;
      modules[y * size + x] = bits[iy * width + ix];
    }
  }
  return modules;
}

/**
 * runAlong(bits, from, to) -> the pixel length of the finder pattern measured through its centre along the
 * line from `from` towards `to` and the other way (about 7 modules), or NaN. Walking out of the dark core
 * there are three transitions (light ring, dark ring, quiet light) on each side: the third ends the pattern.
 */
function runAlong(bits, width, height, from, to) {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  if (!(len > 0)) return NaN;
  const ux = (to.x - from.x) / len;
  const uy = (to.y - from.y) / len;
  const oneWay = (sx, sy) => {
    let state = 0; // 0 dark core, 1 light ring, 2 dark ring
    for (let t = 0; t < len; t += 0.5) {
      const x = Math.floor(from.x + sx * t);
      const y = Math.floor(from.y + sy * t);
      if (x < 0 || y < 0 || x >= width || y >= height) return state === 2 ? t : NaN;
      const dark = bits[y * width + x] === 1;
      if (state === 0 && !dark) state = 1;
      else if (state === 1 && dark) state = 2;
      else if (state === 2 && !dark) return t;
    }
    return NaN;
  };
  return oneWay(ux, uy) + oneWay(-ux, -uy);
}

function moduleSizeAlong(bits, width, height, a, b) {
  const s1 = runAlong(bits, width, height, a, b);
  const s2 = runAlong(bits, width, height, b, a);
  const sizes = [s1, s2].filter((s) => Number.isFinite(s) && s > 0).map((s) => s / 7);
  if (!sizes.length) return NaN;
  return sizes.reduce((x, y) => x + y, 0) / sizes.length;
}

function findAlignment(bits, width, height, guess, ms, radiusModules, axes) {
  // Scores positions near the guess by sampling the 5x5 alignment pattern along the symbol's own axes (module
  // vectors ex, ey from the finder centres): dark centre, light ring, dark ring (26 at best). Returns up to four
  // distinct candidates scoring 22 or more, best first; decode() tries each.
  const { ex, ey } = axes;
  const at = (x, y) => {
    const ix = Math.round(x);
    const iy = Math.round(y);
    return ix >= 0 && iy >= 0 && ix < width && iy < height ? bits[iy * width + ix] : 0;
  };
  const radius = Math.max(4, Math.ceil(ms * radiusModules));
  const step = Math.max(1, ms / 3);
  const found = [];
  for (let dy = -radius; dy <= radius; dy += step) {
    for (let dx = -radius; dx <= radius; dx += step) {
      const cx = guess.x + dx;
      const cy = guess.y + dy;
      if (!at(cx, cy)) continue;
      let score = 2;
      for (let a = -2; a <= 2; a++) {
        for (let b = -2; b <= 2; b++) {
          const r = Math.max(Math.abs(a), Math.abs(b));
          if (r === 0) continue;
          const v = at(cx + a * ex.x + b * ey.x, cy + a * ex.y + b * ey.y);
          score += r === 1 ? (v ? -1 : 1) : (v ? 1 : -1);
        }
      }
      if (score < 22) continue;
      const d = Math.hypot(dx, dy);
      found.push({ score, x: cx, y: cy, d });
    }
  }
  // The best few distinct positions (at least 3 modules apart), best score first, then nearest to the guess.
  found.sort((p, q) => q.score - p.score || p.d - q.d);
  const out = [];
  for (const f of found) {
    if (out.every((o) => Math.hypot(o.x - f.x, o.y - f.y) > 3 * ms)) out.push(f);
    if (out.length >= 4) break;
  }
  return out;
}

/**
 * decode(imageData) -> { text, bytes, version, ecl } | null
 * imageData: { width, height, data } RGBA (a canvas ImageData or toImageData output). Tries the estimated
 * dimension and its neighbours, with and without the alignment pattern.
 */
export function decode(imageData) {
  if (!imageData || !Number.isInteger(imageData.width) || !Number.isInteger(imageData.height)) return null;
  const { width, height } = imageData;
  if (width < 21 || height < 21 || width * height > 4096 * 4096) return null;
  const bits = binarize(imageData);
  const found = findFinders(bits, width, height);
  if (found.length < 3) return null;
  const three = pickThree(found);
  if (!three) return null;
  const { tl, tr, bl } = three;
  const msRow = (tl.ms + tr.ms + bl.ms) / 3;
  // Module sizes measured along the two sides (rotation stretches row runs; the sides do not).
  let msX = moduleSizeAlong(bits, width, height, tl, tr);
  let msY = moduleSizeAlong(bits, width, height, tl, bl);
  if (!Number.isFinite(msX)) msX = msRow;
  if (!Number.isFinite(msY)) msY = msRow;
  const est = Math.round((dist(tl, tr) / msX + dist(tl, bl) / msY) / 2) + 7;
  const dims = [];
  const base = est % 4 === 1 ? est : est % 4 === 0 ? est + 1 : est % 4 === 2 ? est - 1 : est - 2;
  for (const d of [base, base + 4, base - 4, base + 8, base - 8]) if (d >= 21 && d <= 177 && dims.indexOf(d) < 0) dims.push(d);
  for (const size of dims) {
    const brx = tr.x - tl.x + bl.x;
    const bry = tr.y - tl.y + bl.y;
    const attempts = [];
    if (size > 21) {
      const k = 1 - 3 / (size - 7);
      const guess = { x: tl.x + k * (brx - tl.x), y: tl.y + k * (bry - tl.y) };
      const modMs = (dist(tl, tr) + dist(tl, bl)) / 2 / (size - 7);
      const axes = {
        ex: { x: (tr.x - tl.x) / (size - 7), y: (tr.y - tl.y) / (size - 7) },
        ey: { x: (bl.x - tl.x) / (size - 7), y: (bl.y - tl.y) / (size - 7) },
      };
      const seen = [];
      for (const r of [4, 8, 16]) {
        for (const al of findAlignment(bits, width, height, guess, modMs, r, axes)) {
          if (seen.some((p) => Math.hypot(p.x - al.x, p.y - al.y) < modMs)) continue;
          seen.push(al);
          attempts.push([3.5, 3.5, size - 3.5, 3.5, size - 6.5, size - 6.5, 3.5, size - 3.5, al.x, al.y]);
        }
        if (seen.length >= 6) break;
      }
    }
    attempts.push([3.5, 3.5, size - 3.5, 3.5, size - 3.5, size - 3.5, 3.5, size - 3.5, brx, bry]);
    for (const a of attempts) {
      const map = perspective(a.slice(0, 8), [tl.x, tl.y, tr.x, tr.y, a[8], a[9], bl.x, bl.y]);
      const modules = sampleGrid(bits, width, height, map, size);
      if (!modules) continue;
      const r = decodeMatrix({ size, modules });
      if (r) return { text: r.text, bytes: r.bytes, version: r.version, ecl: r.ecl };
    }
  }
  return null;
}
