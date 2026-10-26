// src/dropin/polyfills.js: guarded polyfills for drop-in pages (ARCHITECTURE §5.1, §3.4;
// DESIGN-REVIEW item 16). The shell installs the same set from boot.js, a classic ES5 script that
// cannot be imported; drop-in pages never run boot.js, and the vendored webtorrent bundle calls
// Uint8Array.prototype.toHex/toBase64, Uint8Array.fromHex/fromBase64 (Chrome 140, Firefox 133,
// Safari 18.2) and AbortSignal.timeout (Safari 16) without guards. Nothing is defined when the
// browser already has the feature, and nothing else on the host page is touched.
//
//   installPolyfills(scope = globalThis) → string[]   names that were missing and are now defined
//   selfTest(scope = globalThis) → string[]           failed checks (empty = the globals behave)
//   impl                                              the implementations, testable without globals

const HEX = '0123456789abcdef';
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function isUint8Array(value) {
  return Object.prototype.toString.call(value) === '[object Uint8Array]';
}

function optionsObject(options) {
  if (options === undefined) return {};
  if (options === null || (typeof options !== 'object' && typeof options !== 'function')) {
    throw new TypeError('options must be an object');
  }
  return options;
}

function alphabetOf(opts) {
  const alphabet = opts.alphabet;
  if (alphabet === undefined) return 'base64';
  if (alphabet !== 'base64' && alphabet !== 'base64url') throw new TypeError('alphabet must be "base64" or "base64url"');
  return alphabet;
}

function hexValue(code) {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 102) return code - 87;
  if (code >= 65 && code <= 70) return code - 55;
  return -1;
}

function toHex() {
  if (!isUint8Array(this)) throw new TypeError('Uint8Array.prototype.toHex called on an incompatible receiver');
  let out = '';
  for (let k = 0; k < this.length; k++) out += HEX.charAt(this[k] >> 4) + HEX.charAt(this[k] & 15);
  return out;
}

function fromHex(string) {
  if (typeof string !== 'string') throw new TypeError('Uint8Array.fromHex expects a string');
  if (string.length % 2 !== 0) throw new SyntaxError('Uint8Array.fromHex: odd number of hex digits');
  const out = new Uint8Array(string.length / 2);
  for (let k = 0; k < out.length; k++) {
    const hi = hexValue(string.charCodeAt(2 * k));
    const lo = hexValue(string.charCodeAt(2 * k + 1));
    if (hi < 0 || lo < 0) throw new SyntaxError('Uint8Array.fromHex: invalid hex digit');
    out[k] = hi * 16 + lo;
  }
  return out;
}

function toBase64(options) {
  if (!isUint8Array(this)) throw new TypeError('Uint8Array.prototype.toBase64 called on an incompatible receiver');
  const opts = optionsObject(options);
  const table = alphabetOf(opts) === 'base64url' ? B64URL : B64;
  const omitPadding = Boolean(opts.omitPadding);
  let out = '';
  const n = this.length;
  let k = 0;
  let x;
  for (; k + 2 < n; k += 3) {
    x = (this[k] << 16) | (this[k + 1] << 8) | this[k + 2];
    out += table.charAt((x >> 18) & 63) + table.charAt((x >> 12) & 63) + table.charAt((x >> 6) & 63) + table.charAt(x & 63);
  }
  if (n - k === 1) {
    x = this[k] << 16;
    out += table.charAt((x >> 18) & 63) + table.charAt((x >> 12) & 63) + (omitPadding ? '' : '==');
  } else if (n - k === 2) {
    x = (this[k] << 16) | (this[k + 1] << 8);
    out += table.charAt((x >> 18) & 63) + table.charAt((x >> 12) & 63) + table.charAt((x >> 6) & 63) + (omitPadding ? '' : '=');
  }
  return out;
}

function isAsciiWhitespace(code) {
  return code === 9 || code === 10 || code === 12 || code === 13 || code === 32;
}

// DecodeBase64Chunk from the TC39 proposal: a 2- or 3-character final chunk may carry extra bits,
// which only the 'strict' mode rejects.
function decodeChunk(chunk, throwOnExtraBits, bytes) {
  const len = chunk.length;
  const x = (chunk[0] << 18) | (chunk[1] << 12) | ((len > 2 ? chunk[2] : 0) << 6) | (len > 3 ? chunk[3] : 0);
  const b0 = (x >> 16) & 255;
  const b1 = (x >> 8) & 255;
  const b2 = x & 255;
  if (len === 2) {
    if (throwOnExtraBits && b1 !== 0) throw new SyntaxError('Uint8Array.fromBase64: extra bits in the last chunk');
    bytes.push(b0);
  } else if (len === 3) {
    if (throwOnExtraBits && b2 !== 0) throw new SyntaxError('Uint8Array.fromBase64: extra bits in the last chunk');
    bytes.push(b0, b1);
  } else {
    bytes.push(b0, b1, b2);
  }
}

function decodeBase64(string, alphabet, lastChunkHandling) {
  const bytes = [];
  let chunk = [];
  let index = 0;
  const length = string.length;
  for (;;) {
    while (index < length && isAsciiWhitespace(string.charCodeAt(index))) index++;
    if (index === length) {
      if (chunk.length > 0) {
        if (lastChunkHandling === 'stop-before-partial') return bytes;
        if (lastChunkHandling !== 'loose' || chunk.length === 1) throw new SyntaxError('Uint8Array.fromBase64: incomplete last chunk');
        decodeChunk(chunk, false, bytes);
      }
      return bytes;
    }
    let ch = string.charAt(index);
    index++;
    if (ch === '=') {
      if (chunk.length < 2) throw new SyntaxError('Uint8Array.fromBase64: unexpected padding');
      while (index < length && isAsciiWhitespace(string.charCodeAt(index))) index++;
      if (chunk.length === 2) {
        if (index === length) {
          if (lastChunkHandling === 'stop-before-partial') return bytes;
          throw new SyntaxError('Uint8Array.fromBase64: incomplete padding');
        }
        if (string.charAt(index) === '=') {
          index++;
          while (index < length && isAsciiWhitespace(string.charCodeAt(index))) index++;
        }
      }
      if (index < length) throw new SyntaxError('Uint8Array.fromBase64: data after padding');
      decodeChunk(chunk, lastChunkHandling === 'strict', bytes);
      return bytes;
    }
    if (alphabet === 'base64url') {
      if (ch === '+' || ch === '/') throw new SyntaxError('Uint8Array.fromBase64: invalid base64url character');
      if (ch === '-') ch = '+';
      else if (ch === '_') ch = '/';
    }
    const value = B64.indexOf(ch);
    if (value < 0) throw new SyntaxError('Uint8Array.fromBase64: invalid character');
    chunk.push(value);
    if (chunk.length === 4) {
      decodeChunk(chunk, false, bytes);
      chunk = [];
    }
  }
}

function fromBase64(string, options) {
  if (typeof string !== 'string') throw new TypeError('Uint8Array.fromBase64 expects a string');
  const opts = optionsObject(options);
  const alphabet = alphabetOf(opts);
  let last = opts.lastChunkHandling;
  if (last === undefined) last = 'loose';
  if (last !== 'loose' && last !== 'strict' && last !== 'stop-before-partial') {
    throw new TypeError('lastChunkHandling must be "loose", "strict" or "stop-before-partial"');
  }
  return new Uint8Array(decodeBase64(string, alphabet, last));
}

// The timer is unref'd where that exists (Node tests); browsers return a number and have no unref.
function timeout(ms) {
  if (typeof ms !== 'number' || !(ms >= 0) || ms === Infinity) throw new TypeError('AbortSignal.timeout expects a non-negative finite number');
  const controller = new AbortController();
  const timer = setTimeout(() => {
    let reason;
    try {
      reason = new DOMException('The operation timed out.', 'TimeoutError');
    } catch (_) {
      reason = new Error('The operation timed out.');
      reason.name = 'TimeoutError';
    }
    try {
      controller.abort(reason);
    } catch (_) {
      controller.abort();
    }
  }, ms);
  if (timer && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
  return controller.signal;
}

export const impl = Object.freeze({ toHex, fromHex, toBase64, fromBase64, timeout });

function define(target, name, fn, label, done) {
  if (!target || typeof target[name] === 'function') return;
  try {
    Object.defineProperty(target, name, { value: fn, writable: true, configurable: true, enumerable: false });
    done.push(label);
  } catch (_) { /* frozen intrinsic: selfTest reports it */ }
}

/** installPolyfills(scope) → the names that were missing and are now defined. */
export function installPolyfills(scope = globalThis) {
  const done = [];
  const U8 = scope.Uint8Array;
  if (typeof U8 === 'function') {
    define(U8.prototype, 'toHex', toHex, 'Uint8Array.prototype.toHex', done);
    define(U8.prototype, 'toBase64', toBase64, 'Uint8Array.prototype.toBase64', done);
    define(U8, 'fromHex', fromHex, 'Uint8Array.fromHex', done);
    define(U8, 'fromBase64', fromBase64, 'Uint8Array.fromBase64', done);
  }
  if (typeof scope.AbortSignal === 'function' && typeof scope.AbortController === 'function') {
    define(scope.AbortSignal, 'timeout', timeout, 'AbortSignal.timeout', done);
  }
  return done;
}

function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}

function throwsSyntaxError(fn) {
  try {
    fn();
  } catch (e) {
    return e instanceof SyntaxError;
  }
  return false;
}

/** selfTest(scope) → failed check names; runs on whatever implementation is present (native or ours). */
export function selfTest(scope = globalThis) {
  const failed = [];
  try {
    const U8 = scope.Uint8Array;
    const bytes = new U8([0, 1, 127, 128, 254, 255]);
    if (bytes.toHex() !== '00017f80feff') failed.push('toHex'); // lint-floor-ignore: installPolyfills() ran first
    if (!sameBytes(U8.fromHex('00017F80feff'), bytes)) failed.push('fromHex');
    if (!throwsSyntaxError(() => U8.fromHex('abc'))) failed.push('fromHex odd length');
    if (!throwsSyntaxError(() => U8.fromHex('zz'))) failed.push('fromHex non-hex');
    const b = new U8([251, 255]);
    if (b.toBase64() !== '+/8=') failed.push('toBase64'); // lint-floor-ignore: installPolyfills() ran first
    if (b.toBase64({ alphabet: 'base64url' }) !== '-_8=') failed.push('toBase64 base64url'); // lint-floor-ignore: installPolyfills() ran first
    if (b.toBase64({ alphabet: 'base64url', omitPadding: true }) !== '-_8') failed.push('toBase64 omitPadding'); // lint-floor-ignore: installPolyfills() ran first
    if (!sameBytes(U8.fromBase64('+/8='), b)) failed.push('fromBase64');
    if (!sameBytes(U8.fromBase64('-_8', { alphabet: 'base64url' }), b)) failed.push('fromBase64 base64url');
    if (!throwsSyntaxError(() => U8.fromBase64('-_8='))) failed.push('fromBase64 alphabet');
    if (!throwsSyntaxError(() => U8.fromBase64('Zg='))) failed.push('fromBase64 padding');
    const signal = scope.AbortSignal.timeout(60000);
    if (!signal || signal.aborted !== false) failed.push('AbortSignal.timeout');
  } catch (e) {
    failed.push('exception: ' + (e && e.message));
  }
  return failed;
}
