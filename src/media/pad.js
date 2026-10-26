// src/media/pad.js: size buckets for private files and media (R 2.9.5, MF-56; ARCHITECTURE 15.7).
// Pure; Node 22, browsers and workers.
//
// An exact ciphertext size fingerprints a known file, so private files and media are padded to a
// bucket: at or above 2 MiB the buckets are 2^k x (1 + j/8) for j in 0..7 (padding stays below
// 12.5 percent of the bucket, arithmetic, and every bucket is a whole number of 256 KiB pieces);
// below 2 MiB they are the powers of two from 64 KiB (a whole number of 64 KiB pieces).
//
//   bucketBytes(n)            the smallest bucket >= n (n a non-negative safe integer)
//   isBucket(n)               true when n is itself a bucket
//   recordsFor(n, record)     the bucket of n expressed in whole records of `record` bytes

export const MIN_BUCKET = 65536;
export const LARGE_MIN = 2 * 1024 * 1024;
export const STEPS = 8; // eighths of a power of two

function check(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('pad: size must be a non-negative safe integer');
}

/** bucketBytes(n) -> the smallest bucket at or above n. */
export function bucketBytes(n) {
  check(n);
  if (n <= MIN_BUCKET) return MIN_BUCKET;
  if (n <= LARGE_MIN) {
    let b = MIN_BUCKET;
    while (b < n) b *= 2;
    return b;
  }
  let pow = LARGE_MIN;
  while (pow * 2 <= n) pow *= 2;
  // pow <= n < 2 * pow; pow / STEPS is a whole number of bytes for every pow >= 2 MiB.
  const step = pow / STEPS;
  const j = Math.ceil((n - pow) / step);
  return pow + j * step; // j = 8 gives 2 * pow, the next power of two
}

/** isBucket(n) -> true when bucketBytes(n) === n. */
export function isBucket(n) {
  return Number.isSafeInteger(n) && n > 0 && bucketBytes(n) === n;
}

/**
 * recordsFor(n, record) -> how many `record`-byte units fill the bucket of n bytes. `record` must
 * divide every bucket (any power of two up to 64 KiB does; 256 KiB divides the buckets from 2 MiB).
 */
export function recordsFor(n, record) {
  check(n);
  if (!Number.isSafeInteger(record) || record <= 0) throw new RangeError('pad: record must be a positive integer');
  const b = bucketBytes(n);
  if (b % record !== 0) throw new RangeError('pad: record size ' + record + ' does not divide the bucket ' + b);
  return b / record;
}
