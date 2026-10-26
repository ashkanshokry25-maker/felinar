// Proof-of-work fee for ledger blocks (ARCHITECTURE 6.1): a block is valid only when
// leadingZeroBits(h) >= e.bits, where h = sha256(utf8(canonical(e))) and e.bits is committed
// inside the hashed entry (NIP-13 style), so a lucky hash never claims more work than targeted.
// The fee is a cost for scripts, not a security boundary (DESIGN-REVIEW item 4).
//
// Mining uses the synchronous JS SHA-256 with a midstate over the whole 64-byte blocks before the
// nonce. It runs in batches of MINE_BATCH attempts and yields to the event loop about every
// 16 ms, so an AbortSignal (or the PoW worker's cancel message) is honoured promptly and an
// inline fallback on the main thread does not freeze the page. Verification uses WebCrypto.
//
// The nonce is NONCE_WIDTH base36 characters ('0'-'9', 'a'-'z') searched in order from all
// zeros, so mining the same entry twice gives the same nonce. Shared code: no Buffer, no node:.

import { canonicalize, utf8, hex, asBytes } from './canonical.js';
import { sha256 } from './crypto.js';
import { sha256Sync, sha256Midstate, sha256Resume } from './sha256-sync.js';

export const NONCE_WIDTH = 12;
export const MINE_BATCH = 256;
export const PROGRESS_EVERY = 2000;
export const MAX_BITS = 256;

const NONCE_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const NONCE_CODES = new Uint8Array(NONCE_ALPHABET.length);
for (let i = 0; i < NONCE_ALPHABET.length; i++) NONCE_CODES[i] = NONCE_ALPHABET.charCodeAt(i);
const RADIX = NONCE_ALPHABET.length;
const YIELD_EVERY_MS = 16;
const HEX64 = /^[0-9a-f]{64}$/;

const now = (typeof performance === 'object' && performance !== null && typeof performance.now === 'function')
  ? () => performance.now()
  : () => Date.now();

/** The error every abort path rejects with: { name: 'AbortError', code: 'E_POW_ABORTED' }. */
export function powAbortedError(message = 'proof of work aborted') {
  const err = new Error(message);
  err.name = 'AbortError';
  err.code = 'E_POW_ABORTED';
  return err;
}

/** Number of leading zero bits of a byte string (8 per zero byte, then clz of the first non-zero byte). */
export function leadingZeroBits(u8) {
  const bytes = asBytes(u8);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

// True when the first `bits` bits of the digest are zero (early exit for the mining loop).
function meetsTarget(digest, bits) {
  let i = 0;
  let rest = bits;
  for (; rest >= 8; rest -= 8, i++) if (digest[i] !== 0) return false;
  return rest === 0 || (digest[i] >>> (8 - rest)) === 0;
}

/** { hashU8, hashHex } of utf8(canonical(entry)) via WebCrypto. */
export async function hashEntry(entry) {
  const hashU8 = await sha256(utf8.encode(canonicalize(entry)));
  return { hashU8, hashHex: hex.encode(hashU8) };
}

/** True when hashHex is 64 lowercase hex digits with at least `bits` leading zero bits. */
export async function verifyPow(hashHex, bits) {
  if (typeof hashHex !== 'string' || !HEX64.test(hashHex)) return false;
  if (!Number.isInteger(bits) || bits < 0) return false;
  return leadingZeroBits(hex.decode(hashHex)) >= bits;
}

// A macrotask boundary without setTimeout's 4 ms clamping: setImmediate in Node, a fresh
// MessageChannel in browsers and workers (closed after use so it never keeps a process alive).
function yieldToEventLoop() {
  if (typeof setImmediate === 'function') return new Promise((resolve) => setImmediate(resolve));
  if (typeof MessageChannel === 'function') {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(0);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * mine(entry, bits, { signal, onProgress, sha }) -> { entry, h }: finds the first nonce (in
 * base36 order) for which sha256(utf8(canonical({ ...entry, nonce }))) has `bits` leading zero
 * bits. The returned entry is a copy of `entry` with the nonce set; h is its lowercase hex hash.
 * onProgress(hashesTried) fires about every PROGRESS_EVERY hashes. A custom `sha` (bytes ->
 * digest bytes, or a Promise of them) disables the midstate fast path. Rejects with
 * powAbortedError() when `signal` aborts.
 */
export async function mine(entry, bits, { signal = null, onProgress = null, sha = sha256Sync } = {}) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError('mine: entry must be a plain object');
  }
  if (!Number.isInteger(bits) || bits < 0 || bits > MAX_BITS) {
    throw new TypeError('mine: bits must be an integer from 0 to ' + MAX_BITS);
  }
  if (typeof sha !== 'function') throw new TypeError('mine: sha must be a function');
  if (signal && signal.aborted) throw powAbortedError();

  // Locate the nonce in the canonical bytes by canonicalising with two different nonces of the
  // same width: everything before the first differing character is the prefix.
  const zeros = '0'.repeat(NONCE_WIDTH);
  const ones = '1'.repeat(NONCE_WIDTH);
  const a = canonicalize(Object.assign({}, entry, { nonce: zeros }));
  const b = canonicalize(Object.assign({}, entry, { nonce: ones }));
  let at = 0;
  while (at < a.length && a.charCodeAt(at) === b.charCodeAt(at)) at++;
  if (a.length !== b.length || a.slice(at, at + NONCE_WIDTH) !== zeros ||
    b.slice(at, at + NONCE_WIDTH) !== ones || a.slice(at + NONCE_WIDTH) !== b.slice(at + NONCE_WIDTH)) {
    throw new Error('mine: cannot locate the nonce in the canonical entry');
  }
  const prefix = utf8.encode(a.slice(0, at));
  const suffix = utf8.encode(a.slice(at + NONCE_WIDTH));
  const fast = sha === sha256Sync;
  const mid = fast ? sha256Midstate(prefix) : null;
  const head = fast ? prefix.length - mid.length : prefix.length;
  const msg = new Uint8Array(head + NONCE_WIDTH + suffix.length);
  msg.set(prefix.subarray(prefix.length - head), 0);
  msg.set(suffix, head + NONCE_WIDTH);
  const digits = new Uint8Array(NONCE_WIDTH);
  for (let i = 0; i < NONCE_WIDTH; i++) msg[head + i] = NONCE_CODES[0];
  const out = new Uint8Array(32);

  let hashes = 0;
  let nextProgress = PROGRESS_EVERY;
  let lastYield = now();
  for (;;) {
    for (let n = 0; n < MINE_BATCH; n++) {
      let digest;
      if (fast) {
        digest = sha256Resume(mid, msg, out);
      } else {
        digest = sha(msg);
        if (digest && typeof digest.then === 'function') digest = await digest;
        digest = asBytes(digest);
      }
      hashes++;
      if (meetsTarget(digest, bits)) {
        let nonce = '';
        for (let i = 0; i < NONCE_WIDTH; i++) nonce += NONCE_ALPHABET[digits[i]];
        return { entry: Object.assign({}, entry, { nonce }), h: hex.encode(digest) };
      }
      // Odometer increment of the nonce, written straight into the message bytes.
      let i = NONCE_WIDTH - 1;
      for (;;) {
        if (i < 0) throw new Error('mine: nonce space exhausted');
        const d = digits[i] + 1;
        if (d < RADIX) {
          digits[i] = d;
          msg[head + i] = NONCE_CODES[d];
          break;
        }
        digits[i] = 0;
        msg[head + i] = NONCE_CODES[0];
        i--;
      }
    }
    if (signal && signal.aborted) throw powAbortedError();
    if (onProgress && hashes >= nextProgress) {
      nextProgress = (Math.floor(hashes / PROGRESS_EVERY) + 1) * PROGRESS_EVERY;
      try {
        onProgress(hashes);
      } catch (_) {
        // A failing progress callback must not stop the miner.
      }
    }
    if (now() - lastYield >= YIELD_EVERY_MS) {
      await yieldToEventLoop();
      lastYield = now();
      if (signal && signal.aborted) throw powAbortedError();
    }
  }
}
