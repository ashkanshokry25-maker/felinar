// Reading a ledger snapshot named by the pointer's cs= (ARCHITECTURE §6.7, DESIGN-REVIEW S2), shared by
// the shell (src/loader/app.js) and drop-in (src/dropin/ledger.js). Code review round 1: the body is
// read with a cap, the fetch has a timeout, gzip inflates with its own cap, and browsers without
// DecompressionStream (Safari and iOS 15.4 to 16.3) inflate with src/common/inflate.js.

import { gunzip } from './inflate.js';
import { readCappedBody, readStreamCapped } from './read-capped.js';

function tooLarge(what) {
  const err = new Error('snapshot too large (' + what + ')');
  err.code = 'E_TOO_LARGE';
  return err;
}

/**
 * readSnapshot({ url, fetch, maxBytes, maxInflatedBytes, timeoutMs, DecompressionStream, Blob,
 *   setTimeoutFn, clearTimeoutFn }) → Promise<Block[]>
 * Throws on HTTP errors, a body over maxBytes, an inflated body over maxInflatedBytes, a timeout,
 * bad gzip or JSON that is not an array.
 */
export async function readSnapshot({
  url, fetch, maxBytes, maxInflatedBytes, timeoutMs = 0, DecompressionStream: DS = null, Blob: BlobCtor = null, // lint-floor-ignore: optional, inflate.js otherwise
  setTimeoutFn = null, clearTimeoutFn = null,
} = {}) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const set = typeof setTimeoutFn === 'function' ? setTimeoutFn : setTimeout;
  const clear = typeof clearTimeoutFn === 'function' ? clearTimeoutFn : clearTimeout;
  const timer = ctl && timeoutMs > 0 ? set(() => { try { ctl.abort(); } catch (_) { /* ignore */ } }, timeoutMs) : null;
  try {
    const res = await fetch(url, ctl ? { credentials: 'omit', signal: ctl.signal } : { credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    let bytes = await readCappedBody(res, maxBytes);
    if (bytes === null) throw tooLarge('more than ' + maxBytes + ' bytes');
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      if (typeof DS === 'function' && typeof BlobCtor === 'function') {
        const stream = new BlobCtor([bytes]).stream().pipeThrough(new DS('gzip'));
        bytes = await readStreamCapped(stream.getReader(), maxInflatedBytes);
      } else {
        try {
          bytes = gunzip(bytes, { maxOutput: maxInflatedBytes });
        } catch (err) {
          if (err && /output larger/.test(err.message)) bytes = null;
          else throw err;
        }
      }
      if (bytes === null) throw tooLarge('inflates to more than ' + maxInflatedBytes + ' bytes');
    }
    const blocks = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(blocks)) throw new Error('snapshot is not an array of blocks');
    return blocks;
  } finally {
    if (timer !== null) clear(timer);
  }
}
