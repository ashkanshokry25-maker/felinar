// Relay stamp (R 2.7.3, MF-32): a frame is relayed or opened only when
//   leadingZeroBits(SHA-256(utf8("mw-relay-v1") | frameId | stampNonce)) >= bits
// with bits = 10 for frames without the stranger flag and the recipient's chatBits (default 20) for
// stranger frames. The stamp binds the frame through frameId (which covers type, version, flags, day
// and body), so a nonce copied onto another frame fails. Every relay and every recipient checks it in
// one hash before anything else. Frames whose day is not today or yesterday (UTC) are dropped, except held mail
// (HELD answers), which keeps its original day and is accepted for the 7 days of the hold (dayWithin).
//
// The work is a cost for scripts, not a security boundary. Shared code: no Buffer, no node: imports.

import { utf8, concatBytes } from '../chain/canonical.js';
import { sha256Sync } from '../chain/sha256-sync.js';
import { leadingZeroBits, powAbortedError } from '../chain/pow.js';
import {
  STAMP_PREFIX, STAMP_BITS_CONTACT, STAMP_BITS_STRANGER_DEFAULT, STAMP_BITS_MAX, NONCE_BYTES, DAY_MS, FLAG_STRANGER,
  REPLAY_FUTURE_MS,
} from './limits.js';

const PREFIX = utf8.encode(STAMP_PREFIX);
const YIELD_EVERY_MS = 16;
const BATCH = 512;

const clock = (typeof performance === 'object' && performance && typeof performance.now === 'function')
  ? () => performance.now()
  : () => Date.now();

function yieldNow() {
  if (typeof setImmediate === 'function') return new Promise((r) => setImmediate(r));
  return new Promise((r) => setTimeout(r, 0));
}

/** The stamp digest: SHA-256("mw-relay-v1" | frameId | nonce). */
export function stampDigest(frameIdBytes, nonce) {
  return sha256Sync(concatBytes(PREFIX, frameIdBytes, nonce));
}

/** Leading zero bits of the stamp digest (the "work" holders use to rank frames). */
export function stampWork(frameIdBytes, nonce) {
  return leadingZeroBits(stampDigest(frameIdBytes, nonce));
}

/** check(frameId, nonce, bits) -> boolean; never throws. */
export function check(frameIdBytes, nonce, bits) {
  try {
    if (!(frameIdBytes instanceof Uint8Array) || frameIdBytes.length !== 32) return false;
    if (!(nonce instanceof Uint8Array) || nonce.length !== NONCE_BYTES) return false;
    if (!Number.isInteger(bits) || bits < 0 || bits > STAMP_BITS_MAX) return false;
    return leadingZeroBits(stampDigest(frameIdBytes, nonce)) >= bits;
  } catch (_) {
    return false;
  }
}

/** Bits a frame must carry: 10, or the recipient's chatBits (default 20) for the stranger flag. */
export function requiredBits(flags, chatBits = STAMP_BITS_STRANGER_DEFAULT) {
  if (flags & FLAG_STRANGER) {
    const b = Number.isInteger(chatBits) && chatBits >= STAMP_BITS_CONTACT && chatBits <= STAMP_BITS_MAX
      ? chatBits : STAMP_BITS_STRANGER_DEFAULT;
    return b;
  }
  return STAMP_BITS_CONTACT;
}

/**
 * mint(frameId, bits, { signal, onProgress, start }) -> Promise<Uint8Array(8)>: the first nonce (as a
 * big-endian counter from `start`, default 0) whose digest has `bits` leading zero bits. Yields to the
 * event loop about every 16 ms; rejects with { name: 'AbortError', code: 'E_POW_ABORTED' } on abort.
 */
export async function mint(frameIdBytes, bits, { signal = null, onProgress = null, start = 0 } = {}) {
  if (!(frameIdBytes instanceof Uint8Array) || frameIdBytes.length !== 32) throw new TypeError('mint: frameId must be 32 bytes');
  if (!Number.isInteger(bits) || bits < 0 || bits > STAMP_BITS_MAX) throw new TypeError('mint: bits 0 to ' + STAMP_BITS_MAX);
  if (!Number.isSafeInteger(start) || start < 0) throw new TypeError('mint: start must be a safe non-negative integer');
  if (signal && signal.aborted) throw powAbortedError('stamp aborted');
  const msg = concatBytes(PREFIX, frameIdBytes, new Uint8Array(NONCE_BYTES));
  const off = PREFIX.length + 32;
  let counter = start;
  let tried = 0;
  let last = clock();
  for (;;) {
    for (let i = 0; i < BATCH; i++, counter++, tried++) {
      let c = counter;
      for (let j = NONCE_BYTES - 1; j >= 0; j--) {
        msg[off + j] = c % 256;
        c = Math.floor(c / 256);
      }
      if (leadingZeroBits(sha256Sync(msg)) >= bits) return msg.slice(off, off + NONCE_BYTES);
    }
    if (clock() - last >= YIELD_EVERY_MS) {
      if (onProgress) {
        try { onProgress(tried); } catch (_) { /* a progress hook must not break minting */ }
      }
      await yieldNow();
      last = clock();
      if (signal && signal.aborted) throw powAbortedError('stamp aborted');
    }
  }
}

/** UTC days since 1970 for a time in ms. */
export function utcDay(nowMs) {
  return Math.floor(nowMs / DAY_MS);
}

/** The 16-bit header day for a time in ms. */
export function headerDay(nowMs) {
  return utcDay(nowMs) % 65536;
}

/**
 * True when a header day is today or yesterday (UTC), modulo 65536, or tomorrow while the next UTC midnight is at most
 * REPLAY_FUTURE_MS away (review round, DS-8: a sender whose clock runs a few minutes fast is not cut off at midnight; the
 * replay window already takes t up to 5 minutes ahead).
 */
export function dayAcceptable(day, nowMs) {
  const today = headerDay(nowMs);
  if (day === today || day === (today + 65535) % 65536) return true;
  return day === (today + 1) % 65536 && (utcDay(nowMs) + 1) * DAY_MS - nowMs <= REPLAY_FUTURE_MS;
}

/**
 * True when a header day is today or one of the `days` days before it (UTC, modulo 65536): held mail keeps the day it
 * was stamped on, so frames that come back in HELD are checked against the hold TTL instead of the live relay rule.
 */
export function dayWithin(day, nowMs, days) {
  if (!Number.isInteger(day) || day < 0 || day > 65535) return false;
  const back = (headerDay(nowMs) - day + 65536) % 65536;
  return back <= days;
}

/** The full day number for an accepted header day: the nearest of yesterday, today and tomorrow (DS-8). */
export function fullDay(day, nowMs) {
  const today = utcDay(nowMs);
  if ((today % 65536) === day) return today;
  if (((today + 1) % 65536) === day) return today + 1;
  return today - 1;
}
