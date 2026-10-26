// A small P-256 (secp256r1, FIPS 186-4 D.1.2.3) point multiply over BigInt, used only to compute
// the public point of a derived scalar so that WebCrypto can import it as a JWK (WebCrypto needs
// x and y next to d, and has no "public key from private scalar" call). It replaces the
// @noble/curves dependency the INTERFACES contract named (deviation entry, docs/deviations/idcore.md):
// that package is not installed and this build adds no packages.
//
// Not constant time: BigInt arithmetic leaks timing. It runs at the identity origin on the
// person's own device, once per derived key; the signing itself is done by WebCrypto. Tests
// cross-check it against node:crypto ECDH (test/unit/identity-core-derive.test.mjs).
// Shared by Node >= 22 and browsers.

export const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
export const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const A = P - 3n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
const GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;

const mod = (a, m = P) => {
  const r = a % m;
  return r < 0n ? r + m : r;
};

function inv(a, m = P) {
  // Extended Euclid; m is prime and a != 0 mod m.
  let [r0, r1] = [mod(a, m), m];
  let [s0, s1] = [1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  if (r0 !== 1n) throw new RangeError('p256: value not invertible');
  return mod(s0, m);
}

// Jacobian coordinates (X, Y, Z) with x = X / Z^2, y = Y / Z^3; Z = 0 is the point at infinity.
const INF = [0n, 1n, 0n];

function dbl([X, Y, Z]) {
  if (Z === 0n || Y === 0n) return INF;
  const YY = mod(Y * Y);
  const S = mod(4n * X * YY);
  const ZZ = mod(Z * Z);
  const M = mod(3n * (X - ZZ) * (X + ZZ)); // a = -3
  const X3 = mod(M * M - 2n * S);
  const Y3 = mod(M * (S - X3) - 8n * YY * YY);
  const Z3 = mod(2n * Y * Z);
  return [X3, Y3, Z3];
}

function add(p1, p2) {
  const [X1, Y1, Z1] = p1;
  const [X2, Y2, Z2] = p2;
  if (Z1 === 0n) return p2;
  if (Z2 === 0n) return p1;
  const Z1Z1 = mod(Z1 * Z1);
  const Z2Z2 = mod(Z2 * Z2);
  const U1 = mod(X1 * Z2Z2);
  const U2 = mod(X2 * Z1Z1);
  const S1 = mod(Y1 * Z2 * Z2Z2);
  const S2 = mod(Y2 * Z1 * Z1Z1);
  if (U1 === U2) return S1 === S2 ? dbl(p1) : INF;
  const H = mod(U2 - U1);
  const R = mod(S2 - S1);
  const HH = mod(H * H);
  const HHH = mod(H * HH);
  const V = mod(U1 * HH);
  const X3 = mod(R * R - HHH - 2n * V);
  const Y3 = mod(R * (V - X3) - S1 * HHH);
  const Z3 = mod(Z1 * Z2 * H);
  return [X3, Y3, Z3];
}

function toAffine([X, Y, Z]) {
  if (Z === 0n) throw new RangeError('p256: point at infinity');
  const zi = inv(Z);
  const zi2 = mod(zi * zi);
  return [mod(X * zi2), mod(Y * zi2 * zi)];
}

/** bytesToBigInt(u8) -> BigInt, big-endian. */
export function bytesToBigInt(u8) {
  let x = 0n;
  for (let i = 0; i < u8.length; i++) x = (x << 8n) | BigInt(u8[i]);
  return x;
}

/** bigIntToBytes(x, len) -> Uint8Array(len), big-endian; RangeError when x does not fit. */
export function bigIntToBytes(x, len) {
  if (x < 0n) throw new RangeError('p256: negative value');
  const out = new Uint8Array(len);
  let v = x;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  if (v !== 0n) throw new RangeError('p256: value does not fit in ' + len + ' bytes');
  return out;
}

/** isOnCurve(x, y) -> boolean, for affine BigInt coordinates. */
export function isOnCurve(x, y) {
  if (x < 0n || x >= P || y < 0n || y >= P) return false;
  return mod(y * y - (x * x * x + A * x + B)) === 0n;
}

/** multiplyBase(k) -> [x, y] affine BigInts of k * G, for 1 <= k < n. */
export function multiplyBase(k) {
  if (typeof k !== 'bigint' || k <= 0n || k >= N) throw new RangeError('p256: scalar out of range');
  let acc = INF;
  let base = [GX, GY, 1n];
  let e = k;
  while (e > 0n) {
    if (e & 1n) acc = add(acc, base);
    base = dbl(base);
    e >>= 1n;
  }
  return toAffine(acc);
}

/**
 * publicFromScalar(d) -> Uint8Array(65), the uncompressed point 04 || x || y of d * G, where d is
 * a 32-byte big-endian scalar in [1, n - 1].
 */
export function publicFromScalar(d) {
  if (!(d instanceof Uint8Array) || d.length !== 32) throw new TypeError('p256: scalar must be 32 bytes');
  const [x, y] = multiplyBase(bytesToBigInt(d));
  const out = new Uint8Array(65);
  out[0] = 0x04;
  out.set(bigIntToBytes(x, 32), 1);
  out.set(bigIntToBytes(y, 32), 33);
  return out;
}
