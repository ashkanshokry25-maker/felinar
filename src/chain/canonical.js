// RFC 8785 (JSON Canonicalization Scheme) serialiser plus the byte/string helpers shared by
// every chain module. Runs unchanged in Node >= 22 and in browsers: TextEncoder/TextDecoder and
// Uint8Array only (no Buffer, no node: imports).

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
const strictTextDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// ---------------------------------------------------------------------------------------------
// RFC 8785
// ---------------------------------------------------------------------------------------------

// Escapes for the only characters JCS escapes (RFC 8785 §3.2.2.2): U+0000..U+001F get the short
// JSON escape where one exists and lowercase \u00xx otherwise; '"' and '\' are the other two.
const ESCAPES = [];
for (let c = 0; c < 0x20; c++) ESCAPES[c] = '\\u00' + c.toString(16).padStart(2, '0');
ESCAPES[0x08] = '\\b';
ESCAPES[0x09] = '\\t';
ESCAPES[0x0a] = '\\n';
ESCAPES[0x0c] = '\\f';
ESCAPES[0x0d] = '\\r';
ESCAPES[0x22] = '\\"';
ESCAPES[0x5c] = '\\\\';

/**
 * canonicalize(value) → string per RFC 8785: object keys sorted recursively by UTF-16 code
 * units, no whitespace, numbers per ES Number::toString, minimal string escaping.
 *
 * Throws TypeError for anything that is not plain JSON data: undefined (anywhere, including
 * object values and array holes), functions, symbols, BigInt, NaN/±Infinity, non-plain objects
 * (Date, Map, Set, typed arrays, class instances, boxed primitives), symbol-keyed properties,
 * lone surrogates (RFC 8785 §3.2.2.2 says these MUST be an error) and circular references.
 * toJSON methods are ignored, never called.
 */
export function canonicalize(value) {
  return serialize(value, new Set());
}

function serialize(value, ancestors) {
  switch (typeof value) {
    case 'string':
      return quote(value);
    case 'number':
      return serializeNumber(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object': {
      if (value === null) return 'null';
      if (ancestors.has(value)) throw new TypeError('canonicalize: circular structure');
      const isArray = Array.isArray(value);
      if (!isArray && !isPlainObject(value)) {
        throw new TypeError('canonicalize: unsupported object ' + describe(value));
      }
      ancestors.add(value);
      const out = isArray ? serializeArray(value, ancestors) : serializeObject(value, ancestors);
      ancestors.delete(value);
      return out;
    }
    default:
      // undefined, function, symbol, bigint
      throw new TypeError('canonicalize: unsupported value of type ' + typeof value);
  }
}

function serializeArray(arr, ancestors) {
  let out = '[';
  for (let i = 0; i < arr.length; i++) {
    if (i > 0) out += ',';
    out += serialize(arr[i], ancestors);
  }
  return out + ']';
}

function serializeObject(obj, ancestors) {
  if (Object.getOwnPropertySymbols(obj).length > 0) {
    throw new TypeError('canonicalize: symbol-keyed properties are not representable in JSON');
  }
  // Array.prototype.sort without a comparator orders strings by UTF-16 code units, which is
  // exactly the RFC 8785 §3.2.3 rule (so U+1F600 sorts before U+FB33 because 0xD83D < 0xFB33).
  const keys = Object.keys(obj).sort();
  let out = '{';
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (i > 0) out += ',';
    out += quote(key) + ':' + serialize(obj[key], ancestors);
  }
  return out + '}';
}

function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function describe(value) {
  const ctor = value.constructor && value.constructor.name;
  return ctor || Object.prototype.toString.call(value);
}

function serializeNumber(n) {
  if (!Number.isFinite(n)) throw new TypeError('canonicalize: non-finite number ' + String(n));
  // ES Number::toString is what JSON.stringify uses for finite numbers; -0 must become "0"
  // (RFC 8785 Appendix B), which String(-0) already gives but we make explicit.
  return n === 0 ? '0' : String(n);
}

function quote(str) {
  let out = '"';
  let start = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x20 || c === 0x22 || c === 0x5c) {
      if (i > start) out += str.slice(start, i);
      out += ESCAPES[c];
      start = i + 1;
    } else if (c >= 0xd800 && c <= 0xdfff) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (c > 0xdbff || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError('canonicalize: lone surrogate U+' + c.toString(16).toUpperCase());
      }
      i++; // well-formed pair, emitted as-is
    }
  }
  out += str.slice(start);
  return out + '"';
}

// ---------------------------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------------------------

/** Normalises Uint8Array | ArrayBuffer | any ArrayBufferView to a Uint8Array view (no copy). */
export function asBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('expected Uint8Array, ArrayBuffer or ArrayBufferView');
}

export const utf8 = {
  encode(str) {
    if (typeof str !== 'string') throw new TypeError('utf8.encode expects a string');
    return textEncoder.encode(str);
  },
  // Lenient by default (invalid sequences → U+FFFD, like every browser); { fatal: true } throws.
  decode(bytes, { fatal = false } = {}) {
    return (fatal ? strictTextDecoder : textDecoder).decode(asBytes(bytes));
  },
};

const HEX_CHARS = [];
for (let i = 0; i < 256; i++) HEX_CHARS.push(i.toString(16).padStart(2, '0'));
const HEX_VALUES = new Int8Array(128).fill(-1);
for (let i = 0; i < 16; i++) {
  HEX_VALUES['0123456789abcdef'.charCodeAt(i)] = i;
  HEX_VALUES['0123456789ABCDEF'.charCodeAt(i)] = i;
}

function hexValue(code) {
  const v = code < 128 ? HEX_VALUES[code] : -1;
  if (v < 0) throw new TypeError('hex.decode: invalid hex string');
  return v;
}

export const hex = {
  /** Lowercase hex. */
  encode(bytes) {
    const u8 = asBytes(bytes);
    let out = '';
    for (let i = 0; i < u8.length; i++) out += HEX_CHARS[u8[i]];
    return out;
  },
  /** Accepts either case; throws TypeError on odd length or non-hex characters. */
  decode(str) {
    if (typeof str !== 'string' || str.length % 2 !== 0) {
      throw new TypeError('hex.decode: invalid hex string');
    }
    const out = new Uint8Array(str.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = (hexValue(str.charCodeAt(2 * i)) << 4) | hexValue(str.charCodeAt(2 * i + 1));
    }
    return out;
  },
};

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_VALUES = new Int8Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64_VALUES[B64_ALPHABET.charCodeAt(i)] = i;

export const b64url = {
  /** RFC 4648 §5 base64url, no padding. */
  encode(bytes) {
    const u8 = asBytes(bytes);
    const n = u8.length;
    let out = '';
    let i = 0;
    for (; i + 3 <= n; i += 3) {
      const x = (u8[i] << 16) | (u8[i + 1] << 8) | u8[i + 2];
      out += B64_ALPHABET[x >>> 18] + B64_ALPHABET[(x >>> 12) & 63] +
        B64_ALPHABET[(x >>> 6) & 63] + B64_ALPHABET[x & 63];
    }
    if (n - i === 1) {
      const x = u8[i] << 16;
      out += B64_ALPHABET[x >>> 18] + B64_ALPHABET[(x >>> 12) & 63];
    } else if (n - i === 2) {
      const x = (u8[i] << 16) | (u8[i + 1] << 8);
      out += B64_ALPHABET[x >>> 18] + B64_ALPHABET[(x >>> 12) & 63] + B64_ALPHABET[(x >>> 6) & 63];
    }
    return out;
  },
  /**
   * Strict decoder: only the URL-safe alphabet ('+' and '/' are rejected), optional trailing
   * '=' padding tolerated, and the unused trailing bits must be zero so that every byte string
   * has exactly one accepted spelling (encode(decode(s)) === s). Throws TypeError otherwise.
   */
  decode(str) {
    if (typeof str !== 'string') throw new TypeError('b64url.decode expects a string');
    let s = str;
    if (s.endsWith('==')) s = s.slice(0, -2);
    else if (s.endsWith('=')) s = s.slice(0, -1);
    const len = s.length;
    const rem = len % 4;
    if (rem === 1) throw new TypeError('b64url.decode: invalid length');
    const value = (idx) => {
      const c = s.charCodeAt(idx);
      const v = c < 128 ? B64_VALUES[c] : -1;
      if (v < 0) throw new TypeError('b64url.decode: invalid character');
      return v;
    };
    const out = new Uint8Array((len >> 2) * 3 + (rem === 2 ? 1 : rem === 3 ? 2 : 0));
    let o = 0;
    let i = 0;
    for (; i + 4 <= len; i += 4) {
      const x = (value(i) << 18) | (value(i + 1) << 12) | (value(i + 2) << 6) | value(i + 3);
      out[o++] = x >>> 16;
      out[o++] = (x >>> 8) & 255;
      out[o++] = x & 255;
    }
    if (rem === 2) {
      const a = value(i);
      const b = value(i + 1);
      if (b & 0x0f) throw new TypeError('b64url.decode: non-canonical encoding');
      out[o++] = (a << 2) | (b >> 4);
    } else if (rem === 3) {
      const a = value(i);
      const b = value(i + 1);
      const c = value(i + 2);
      if (c & 0x03) throw new TypeError('b64url.decode: non-canonical encoding');
      out[o++] = (a << 2) | (b >> 4);
      out[o++] = ((b & 15) << 4) | (c >> 2);
    }
    return out;
  },
};

export function concatBytes(...parts) {
  const views = parts.map(asBytes);
  let total = 0;
  for (const v of views) total += v.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const v of views) {
    out.set(v, offset);
    offset += v.length;
  }
  return out;
}

/** UTF-8 byte length of a string, identical to utf8.encode(str).length without allocating. */
export function byteLength(str) {
  if (typeof str !== 'string') throw new TypeError('byteLength expects a string');
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length &&
      (str.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3; // BMP character, or a lone surrogate which TextEncoder emits as U+FFFD
  }
  return n;
}
