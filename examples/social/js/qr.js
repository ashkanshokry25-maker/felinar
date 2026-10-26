// A small QR Code encoder (ISO/IEC 18004), byte mode only: versions 1 to 40, error correction L, M, Q and H, all eight masks
// tried with the standard penalty rules. It exists for the QR invite in Settings (R 3.4): the person's link, with the pointer in
// the fragment, as a code another phone scans. Pure functions, no DOM; the view draws the result as one SVG path.
// The structure follows the public-domain tables and procedure of the specification; test/example/social-lib.test.mjs checks
// the Reed-Solomon step against published codewords and pins complete symbols by hash.

const ECC = Object.freeze({ L: { ord: 0, bits: 1 }, M: { ord: 1, bits: 0 }, Q: { ord: 2, bits: 3 }, H: { ord: 3, bits: 2 } });
// Per error correction level (L, M, Q, H) and version (index 0 unused): error correction codewords per block, and number of blocks.
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

const bit = (x, i) => ((x >>> i) & 1) !== 0;

function alignmentPositions(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2, size = ver * 4 + 17;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}
/** Number of data modules (bits that carry codewords) in a symbol of this version, function patterns excluded. */
function rawDataModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
export function dataCodewords(ver, ecc) {
  const e = ECC[ecc].ord;
  return Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[e][ver] * NUM_BLOCKS[e][ver];
}
/** The most bytes a symbol of this version can hold in byte mode at this level. */
export function capacityBytes(ver, ecc) {
  const bits = dataCodewords(ver, ecc) * 8 - 4 - (ver < 10 ? 8 : 16);
  return Math.max(0, Math.floor(bits / 8));
}

// ---- Reed-Solomon over GF(256) with the reducing polynomial 0x11D
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
  return z;
}
export function rsDivisor(degree) {
  const out = new Array(degree).fill(0);
  out[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) { out[j] = gfMul(out[j], root); if (j + 1 < degree) out[j] ^= out[j + 1]; }
    root = gfMul(root, 0x02);
  }
  return out;
}
/** rsRemainder(data, divisor): the error correction codewords of one block. */
export function rsRemainder(data, divisor) {
  const out = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ out.shift();
    out.push(0);
    divisor.forEach((coef, i) => { out[i] ^= gfMul(coef, factor); });
  }
  return out;
}

function addEccAndInterleave(data, ver, ecc) {
  const e = ECC[ecc].ord, blocks = NUM_BLOCKS[e][ver], eccLen = ECC_PER_BLOCK[e][ver];
  const raw = Math.floor(rawDataModules(ver) / 8), shortBlocks = blocks - (raw % blocks), shortLen = Math.floor(raw / blocks);
  const divisor = rsDivisor(eccLen), parts = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1));
    k += dat.length;
    const rem = rsRemainder(dat, divisor);
    if (i < shortBlocks) dat.push(0);
    parts.push(dat.concat(rem));
  }
  const out = [];
  for (let i = 0; i < parts[0].length; i++) parts.forEach((p, j) => { if (i !== shortLen - eccLen || j >= shortBlocks) out.push(p[i]); });
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function penalty(m, size) {
  let p = 0, dark = 0;
  const runs = (get) => {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) { run++; if (run === 5) p += 3; else if (run > 5) p += 1; } else run = 1;
      }
      // Finder-like 1:1:3:1:1 patterns with a light margin of four modules (rule 3), either direction.
      for (let b = 0; b + 11 <= size; b++) {
        const w = [];
        for (let k = 0; k < 11; k++) w.push(get(a, b + k) ? 1 : 0);
        const s = w.join('');
        if (s === '10111010000' || s === '00001011101') p += 40;
      }
    }
  };
  runs((y, x) => m[y][x]);
  runs((x, y) => m[y][x]);
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const c = m[y][x];
    if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
  }
  for (const row of m) for (const c of row) if (c) dark++;
  const total = size * size, k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  return p + Math.max(0, k) * 10;
}

/**
 * encodeQr(text, { ecc = 'M', minVersion = 1, maxVersion = 40, mask = -1 }) -> { version, size, mask, ecc, modules }
 * modules[y][x] is true for a dark module. Throws RangeError when the text does not fit in version maxVersion.
 */
export function encodeQr(text, opts = {}) {
  const ecc = opts.ecc || 'M';
  if (!ECC[ecc]) throw new RangeError('unknown error correction level ' + ecc);
  const bytes = Array.from(new TextEncoder().encode(String(text)));
  let ver = opts.minVersion || 1;
  const maxVersion = opts.maxVersion || 40;
  while (ver <= maxVersion && bytes.length > capacityBytes(ver, ecc)) ver++;
  if (ver > maxVersion) throw new RangeError('the text is too long for a QR code of version ' + maxVersion + ' at level ' + ecc);
  // Bit stream: mode 0100 (bytes), character count, the bytes, terminator, padding to the capacity.
  const bits = [];
  const put = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(4, 4);
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capBits = dataCodewords(ver, ecc) * 8;
  put(0, Math.min(4, capBits - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capBits; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  const codewords = addEccAndInterleave(data, ver, ecc);

  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x, y, dark) => { modules[y][x] = dark; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
      if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const pos = alignmentPositions(ver), last = pos.length - 1;
  pos.forEach((px, i) => pos.forEach((py, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  const formatBits = (mask) => {
    const d = (ECC[ecc].bits << 3) | mask;
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const b = ((d << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(b, i));
    setFn(8, 7, bit(b, 6)); setFn(8, 8, bit(b, 7)); setFn(7, 8, bit(b, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(b, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(b, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(b, i));
    setFn(8, size - 8, true);
  };
  formatBits(0); // reserve the area; the real bits are drawn after the mask is chosen
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const b = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3), c = Math.floor(i / 3);
      setFn(a, c, bit(b, i)); setFn(c, a, bit(b, i));
    }
  }
  // Codewords, two columns at a time from the right, alternating upward and downward.
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (!fn[y][x] && k < codewords.length * 8) { modules[y][x] = bit(codewords[k >>> 3], 7 - (k & 7)); k++; }
    }
  }
  const apply = (mask) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x]; };
  let best = opts.mask >= 0 && opts.mask < 8 ? opts.mask : -1;
  if (best < 0) {
    let low = Infinity;
    for (let m = 0; m < 8; m++) {
      apply(m); formatBits(m);
      const p = penalty(modules, size);
      if (p < low) { low = p; best = m; }
      apply(m); // undo
    }
  }
  apply(best); formatBits(best);
  return { version: ver, size, mask: best, ecc, modules };
}

/** qrPath(symbol, { border = 4 }) -> { d, size }: one SVG path (runs of dark modules, 1 unit per module) and the viewBox size. */
export function qrPath(symbol, opts = {}) {
  const border = opts.border == null ? 4 : opts.border;
  let d = '';
  symbol.modules.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      if (!row[x]) { x++; continue; }
      let n = 1;
      while (x + n < row.length && row[x + n]) n++;
      d += 'M' + (x + border) + ' ' + (y + border) + 'h' + n + 'v1h-' + n + 'z';
      x += n;
    }
  });
  return { d, size: symbol.size + border * 2 };
}
