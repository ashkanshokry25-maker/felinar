// Bencode (BEP 3) encoder and decoder that keeps byte-exact spans, so the infohash can be taken
// as sha1 over the original `info` bytes. Shared by Node >= 22 and browsers: Uint8Array and
// TextEncoder/TextDecoder only (no Buffer, no node: imports).
//
// decode() is strict where the grammar is: integers without leading zeros or "-0", string
// lengths without leading zeros, no trailing bytes, dictionary keys that are valid UTF-8 and
// unique, nesting depth at most MAX_DEPTH. It tolerates unsorted dictionary keys (many decoders
// do); callers that need canonical bytes compare encode(decode(x).value) with x, as
// torrent-file.js does for the info dictionary.

const textEncoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export const MAX_DEPTH = 256;

const C_I = 0x69; // i
const C_L = 0x6c; // l
const C_D = 0x64; // d
const C_E = 0x65; // e
const C_COLON = 0x3a;
const C_MINUS = 0x2d;
const C_0 = 0x30;
const C_9 = 0x39;

function asBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

/** Bytewise comparison of two Uint8Arrays (memcmp order, shorter prefix first). */
export function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** True when both byte arrays hold the same bytes. */
export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// encode
// ---------------------------------------------------------------------------------------------

function isPlainObject(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * encode(value) → Uint8Array.
 * - Uint8Array / ArrayBuffer / any ArrayBufferView → byte string; string → its UTF-8 bytes.
 * - number → integer (must be a safe integer; floats are a TypeError, never truncated);
 *   bigint → integer; boolean → i1e / i0e.
 * - Array → list (null/undefined elements are a TypeError).
 * - plain object or Map (string or byte keys) → dictionary with keys sorted bytewise;
 *   entries whose value is null or undefined are omitted.
 * Anything else (functions, symbols, class instances, cycles) is a TypeError.
 */
export function encode(value) {
  const chunks = [];
  let total = 0;
  const push = (bytes) => {
    chunks.push(bytes);
    total += bytes.length;
  };
  const pushAscii = (str) => push(textEncoder.encode(str));
  const ancestors = new Set();

  const encodeBytes = (bytes) => {
    pushAscii(bytes.length + ':');
    push(bytes);
  };

  const walk = (v) => {
    if (typeof v === 'string') return encodeBytes(textEncoder.encode(v));
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) throw new TypeError('bencode.encode: only safe integers are allowed, got ' + v);
      return pushAscii('i' + (v === 0 ? '0' : String(v)) + 'e');
    }
    if (typeof v === 'bigint') return pushAscii('i' + v.toString() + 'e');
    if (typeof v === 'boolean') return pushAscii(v ? 'i1e' : 'i0e');
    if (v === null || typeof v !== 'object') {
      throw new TypeError('bencode.encode: unsupported value of type ' + (v === null ? 'null' : typeof v));
    }
    const bytes = asBytes(v);
    if (bytes) return encodeBytes(bytes);
    if (ancestors.has(v)) throw new TypeError('bencode.encode: circular structure');
    ancestors.add(v);
    if (Array.isArray(v)) {
      push(new Uint8Array([C_L]));
      for (let i = 0; i < v.length; i++) {
        if (v[i] === null || v[i] === undefined) {
          throw new TypeError('bencode.encode: list element ' + i + ' is ' + v[i]);
        }
        walk(v[i]);
      }
      push(new Uint8Array([C_E]));
    } else if (v instanceof Map || isPlainObject(v)) {
      const entries = [];
      const source = v instanceof Map ? Array.from(v.entries()) : Object.keys(v).map((k) => [k, v[k]]);
      for (const [key, val] of source) {
        if (val === null || val === undefined) continue;
        let keyBytes;
        if (typeof key === 'string') keyBytes = textEncoder.encode(key);
        else keyBytes = asBytes(key);
        if (!keyBytes) throw new TypeError('bencode.encode: dictionary keys must be strings or bytes');
        entries.push([keyBytes, val]);
      }
      entries.sort((a, b) => compareBytes(a[0], b[0]));
      push(new Uint8Array([C_D]));
      for (let i = 0; i < entries.length; i++) {
        if (i > 0 && compareBytes(entries[i - 1][0], entries[i][0]) === 0) {
          throw new TypeError('bencode.encode: duplicate dictionary key');
        }
        encodeBytes(entries[i][0]);
        walk(entries[i][1]);
      }
      push(new Uint8Array([C_E]));
    } else {
      throw new TypeError('bencode.encode: unsupported object ' + ((v.constructor && v.constructor.name) || 'Object'));
    }
    ancestors.delete(v);
  };

  walk(value);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// decode
// ---------------------------------------------------------------------------------------------

function fail(message, pos) {
  const err = new Error('bencode.decode: ' + message + ' at byte ' + pos);
  err.code = 'E_BENCODE';
  err.offset = pos;
  return err;
}

function setOwn(obj, key, value) {
  // defineProperty instead of assignment: a key named "__proto__" must stay an own data property.
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * decode(u8) → { value, spans }.
 * value: byte strings become Uint8Array copies, integers become numbers (BigInt outside the
 * safe-integer range), lists become arrays, dictionaries become plain objects with UTF-8 keys.
 * spans: Map from object path to [start, end) byte offsets of that value's encoding. The root
 * value is ''; every value reachable from the root through dictionaries only gets the path of
 * its keys joined with '.' (e.g. 'info', 'info.pieces'); list elements are not recorded.
 * Throws an Error with code 'E_BENCODE' on malformed input.
 */
export function decode(u8) {
  const data = asBytes(u8);
  if (!data) throw new TypeError('bencode.decode expects a Uint8Array, ArrayBuffer or ArrayBufferView');
  const spans = new Map();
  let pos = 0;

  // Reads an unsigned decimal ending at `terminator`; returns its value (Number) and moves pos.
  const readLength = () => {
    const start = pos;
    while (pos < data.length && data[pos] >= C_0 && data[pos] <= C_9) pos++;
    if (pos === start) throw fail('expected a string length', start);
    if (data[start] === C_0 && pos - start > 1) throw fail('string length with a leading zero', start);
    if (pos >= data.length || data[pos] !== C_COLON) throw fail("expected ':' after a string length", pos);
    if (pos - start > 15) throw fail('string length too large', start);
    let n = 0;
    for (let i = start; i < pos; i++) n = n * 10 + (data[i] - C_0);
    pos++; // ':'
    if (n > data.length - pos) throw fail('string runs past the end of the input', start);
    return n;
  };

  const readBytes = () => {
    const n = readLength();
    const out = data.slice(pos, pos + n);
    pos += n;
    return out;
  };

  const readInteger = () => {
    const start = pos;
    pos++; // 'i'
    let negative = false;
    if (data[pos] === C_MINUS) {
      negative = true;
      pos++;
    }
    const digitsStart = pos;
    while (pos < data.length && data[pos] >= C_0 && data[pos] <= C_9) pos++;
    const nDigits = pos - digitsStart;
    if (nDigits === 0) throw fail('integer without digits', start);
    if (pos >= data.length || data[pos] !== C_E) throw fail("expected 'e' after an integer", pos);
    if (data[digitsStart] === C_0 && (nDigits > 1 || negative)) {
      throw fail(negative ? 'negative zero' : 'integer with a leading zero', start);
    }
    let text = '';
    for (let i = digitsStart; i < pos; i++) text += String.fromCharCode(data[i]);
    pos++; // 'e'
    if (nDigits <= 15) {
      const n = Number(text);
      return negative ? -n : n;
    }
    const big = BigInt(text);
    const signed = negative ? -big : big;
    const asNumber = Number(signed);
    return Number.isSafeInteger(asNumber) ? asNumber : signed;
  };

  const readValue = (path, depth) => {
    if (depth > MAX_DEPTH) throw fail('nesting deeper than ' + MAX_DEPTH, pos);
    if (pos >= data.length) throw fail('unexpected end of input', pos);
    const start = pos;
    const c = data[pos];
    let value;
    if (c === C_I) {
      value = readInteger();
    } else if (c >= C_0 && c <= C_9) {
      value = readBytes();
    } else if (c === C_L) {
      pos++;
      value = [];
      while (true) {
        if (pos >= data.length) throw fail('unterminated list', start);
        if (data[pos] === C_E) {
          pos++;
          break;
        }
        value.push(readValue(null, depth + 1));
      }
    } else if (c === C_D) {
      pos++;
      value = {};
      const seen = new Set();
      while (true) {
        if (pos >= data.length) throw fail('unterminated dictionary', start);
        if (data[pos] === C_E) {
          pos++;
          break;
        }
        const keyPos = pos;
        if (!(data[pos] >= C_0 && data[pos] <= C_9)) throw fail('dictionary key is not a byte string', keyPos);
        const keyBytes = readBytes();
        let key;
        try {
          key = strictDecoder.decode(keyBytes);
        } catch (_) {
          throw fail('dictionary key is not valid UTF-8', keyPos);
        }
        if (seen.has(key)) throw fail('duplicate dictionary key "' + key + '"', keyPos);
        seen.add(key);
        const childPath = path === null ? null : (path === '' ? key : path + '.' + key);
        setOwn(value, key, readValue(childPath, depth + 1));
      }
    } else {
      throw fail('unexpected byte 0x' + c.toString(16).padStart(2, '0'), pos);
    }
    if (path !== null) spans.set(path, [start, pos]);
    return value;
  };

  const value = readValue('', 0);
  if (pos !== data.length) throw fail('trailing bytes after the root value', pos);
  return { value, spans };
}
