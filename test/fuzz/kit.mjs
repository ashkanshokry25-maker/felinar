// test/fuzz/kit.mjs: the pieces the fuzz targets share (V03-DESIGN-REVIEW 2.19, MF-43, MF-73). Not part
// of npm test.
//
//   Rng, hash32          a seeded generator per input: new Rng(hash32(seed, target, iteration)), so one
//                        iteration replays alone and a longer run extends a shorter one
//   edge values          the numbers every numeric field is driven to: 0, -1 and 2^53-1 first (PEER A1)
//   lengthNear           lengths at, around and beyond a stated maximum, and random ones
//   Raw, stringify       a number spelled the way the fuzzer wants in JSON text (1e2, 01, -0, ...)
//   numberPaths, setAt   mutate the numeric leaves of a JSON-like value
//   mutateBytes          generic byte mutations for inputs with no structure to respect
//   describe             a short printable form of an input, for a failure report
//   fixtures             ECDSA identities and P-256 ECDH points (WebCrypto, local)
//
// Nothing here talks to a network or reads a file. Node >= 22.

import { b64url } from '../../src/chain/canonical.js';
import { generateKeyPair, exportPublicKey } from '../../src/chain/crypto.js';

export const MAX_SAFE = Number.MAX_SAFE_INTEGER;
/** The three values the brief names for every numeric field. */
export const EDGE_MUST = Object.freeze([0, -1, MAX_SAFE]);
export const EDGE_MORE = Object.freeze([
  1, 2, 255, 256, 65535, 65536, 2 ** 31 - 1, 2 ** 31, 2 ** 32 - 1, 2 ** 32, MAX_SAFE + 1, -MAX_SAFE, 0.5, 1.5, 1e21, 1e300,
]);
/** Only reachable when the value is passed as an object, not as JSON text (JSON has no spelling for them). */
export const EDGE_OBJECT_ONLY = Object.freeze([NaN, Infinity, -Infinity, -0]);

export const HEXCH = '0123456789abcdef';
export const B64CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const PRINTABLE = (() => {
  let s = '';
  for (let c = 0x20; c < 0x7f; c++) s += String.fromCharCode(c);
  return s;
})();

/** FNV-1a over the UTF-8 of the parts (joined by NUL), then the murmur3 finaliser. -> uint32. */
export function hash32(...parts) {
  let h = 0x811c9dc5;
  const bytes = new TextEncoder().encode(parts.map(String).join('\u0000'));
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** mulberry32 with the helpers the generators use. Deterministic for a given seed. */
export class Rng {
  constructor(seed) {
    this.a = seed >>> 0;
  }

  next() {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** 0 .. n-1 */
  int(n) {
    return n <= 1 ? 0 : Math.floor(this.next() * n);
  }

  /** lo .. hi, both included */
  range(lo, hi) {
    return lo + this.int(hi - lo + 1);
  }

  chance(p) {
    return this.next() < p;
  }

  pick(list) {
    return list[this.int(list.length)];
  }

  /** weighted([[weight, value], ...]) */
  weighted(pairs) {
    let total = 0;
    for (const p of pairs) total += p[0];
    let r = this.next() * total;
    for (const p of pairs) {
      r -= p[0];
      if (r < 0) return p[1];
    }
    return pairs[pairs.length - 1][1];
  }

  bytes(n) {
    const u = new Uint8Array(n);
    for (let i = 0; i < n; i++) u[i] = this.int(256);
    return u;
  }

  chars(n, alphabet) {
    let s = '';
    for (let i = 0; i < n; i++) s += alphabet[this.int(alphabet.length)];
    return s;
  }

  hex(n) {
    return this.chars(n, HEXCH);
  }

  /** n characters of the base64url alphabet (not necessarily a canonical encoding) */
  b64(n) {
    return this.chars(n, B64CH);
  }

  /** the canonical base64url of k random bytes */
  b64Bytes(k) {
    return b64url.encode(this.bytes(k));
  }

  ascii(n) {
    return this.chars(n, PRINTABLE);
  }

  /** Text with the awkward parts of Unicode: astral, combining, bidi, zero-width, controls, lone surrogates. */
  text(n) {
    let s = '';
    for (let i = 0; i < n; i++) {
      const k = this.int(14);
      if (k <= 5) s += PRINTABLE[this.int(PRINTABLE.length)];
      else if (k === 6) s += String.fromCharCode(0xe0 + this.int(0x20)); // Latin-1 letters
      else if (k === 7) s += String.fromCodePoint(0x4e00 + this.int(0x200)); // CJK
      else if (k === 8) s += String.fromCodePoint(0x1f600 + this.int(0x40)); // astral
      else if (k === 9) s += '\u0301'; // combining acute: NFC changes
      else if (k === 10) s += this.pick(['\u202e', '\u2066', '\u200e', '\u200f', '\u061c', '\u200b', '\ufeff']);
      else if (k === 11) s += String.fromCharCode(this.int(0x20)); // C0
      else if (k === 12) s += this.pick(['\u007f', '\u0085', '\u009f', '\u2028', '\u2029']);
      else s += String.fromCharCode(0xd800 + this.int(0x800)); // lone surrogate (or a pair by chance)
    }
    return s;
  }

  /** Fisher-Yates, in place; deterministic for a seed on every engine (Array.prototype.sort with a random comparator is not). */
  shuffle(list) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = list[i];
      list[i] = list[j];
      list[j] = t;
    }
    return list;
  }

  /** an independent generator derived from this one and a label */
  fork(label) {
    return new Rng(hash32(this.a, label));
  }
}

/**
 * edgeNumber(rng, { limit, objectMode }) -> a number to drive a field to: 0, -1 and 2^53-1 most of
 * the time, then the stated maximum and its neighbours, then the other edges, then a random length.
 */
export function edgeNumber(rng, { limit = null, objectMode = false } = {}) {
  const r = rng.next();
  if (r < 0.4) return rng.pick(EDGE_MUST);
  if (limit !== null && r < 0.65) return limit + rng.pick([-1, 0, 1, 2]);
  if (r < 0.85) return rng.pick(objectMode ? EDGE_MORE.concat(EDGE_OBJECT_ONLY) : EDGE_MORE);
  return limit !== null ? rng.int(2 * limit + 3) : rng.int(100000);
}

/** lengthNear(rng, limit) -> 0, 1, limit - 1, limit, limit + 1 or a random length up to 2 * limit + 1. */
export function lengthNear(rng, limit) {
  const r = rng.next();
  if (r < 0.12) return 0;
  if (r < 0.2) return 1;
  if (r < 0.65) return Math.max(0, limit + rng.pick([-1, 0, 1]));
  return rng.int(2 * limit + 2);
}

// ---------------------------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------------------------

/** A number (or any token) spelled exactly as given when the value is written as JSON text. */
export class Raw {
  constructor(text) {
    this.text = String(text);
  }
}

/** Alternative spellings of the number n in JSON text: valid ones and the ones a strict parser must refuse. */
export function spellings(rng, n) {
  const s = String(Math.abs(n));
  const sign = n < 0 ? '-' : '';
  const list = [
    sign + s, sign + s + '.0', sign + s + 'e0', sign + s + 'E+0', sign + '0' + s, '+' + s, sign + s + '.', sign + '.' + s,
    '0x' + Math.abs(n).toString(16), sign + s + '0'.repeat(rng.int(30)), '-0', '1e2', '1E2', '0.5', '1e999', '-1e999',
  ];
  return rng.pick(list);
}

/** JSON.stringify that writes Raw values verbatim. */
export function stringify(value) {
  const raws = [];
  const text = JSON.stringify(value, (k, v) => {
    if (v instanceof Raw) {
      raws.push(v.text);
      return '@@RAW' + (raws.length - 1) + '@@';
    }
    return v;
  });
  if (text === undefined) return undefined;
  return raws.length === 0 ? text : text.replace(/"@@RAW(\d+)@@"/g, (m, i) => raws[Number(i)]);
}

export function clone(value) {
  return structuredClone(value);
}

/** Paths (arrays of keys) to every number leaf of a JSON-like value. */
export function numberPaths(value, path = [], out = []) {
  if (typeof value === 'number') out.push(path);
  else if (Array.isArray(value)) value.forEach((v, i) => numberPaths(v, path.concat([i]), out));
  else if (value && typeof value === 'object' && !(value instanceof Uint8Array) && !(value instanceof Raw)) {
    for (const k of Object.keys(value)) numberPaths(value[k], path.concat([k]), out);
  }
  return out;
}

export function getAt(root, path) {
  let v = root;
  for (const k of path) v = v[k];
  return v;
}

/** Sets root[path] = value in place; returns root (or value for an empty path). */
export function setAt(root, path, value) {
  if (path.length === 0) return value;
  let v = root;
  for (let i = 0; i < path.length - 1; i++) v = v[path[i]];
  v[path[path.length - 1]] = value;
  return root;
}

/** A nested value `depth` levels deep: arrays, or objects with the key `k`. */
export function nested(depth, leaf = 0, kind = 'array') {
  let v = leaf;
  for (let i = 0; i < depth; i++) v = kind === 'array' ? [v] : { k: v };
  return v;
}

/** Random JSON-like data (null, booleans, numbers, strings, arrays, objects). */
export function randomJson(rng, depth = 0) {
  const k = depth > 3 ? rng.int(5) : rng.int(8);
  switch (k) {
    case 0: return null;
    case 1: return rng.chance(0.5);
    case 2: return rng.pick([0, 1, -1, 1.5, 1e21, 1e-7, 5e-324, 1.7976931348623157e308, -0, 123456789012, 0.1 + 0.2, 2 ** 53, 100, 1e300]);
    case 3: return rng.text(rng.int(12));
    case 4: return rng.ascii(rng.int(8));
    case 5: return Array.from({ length: rng.int(5) }, () => randomJson(rng, depth + 1));
    default: {
      const o = {};
      const n = rng.int(5);
      for (let i = 0; i < n; i++) o[rng.pick([rng.ascii(rng.range(1, 6)), rng.text(rng.range(1, 4)), '\ud83d\ude00', '\ufb33', 'a', 'B', '10', '9'])] = randomJson(rng, depth + 1);
      return o;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// bytes
// ---------------------------------------------------------------------------------------------

function splice(b, at, del, ins) {
  const out = new Uint8Array(b.length - del + ins.length);
  out.set(b.subarray(0, at), 0);
  out.set(ins, at);
  out.set(b.subarray(at + del), at + ins.length);
  return out;
}

/** Generic byte mutations (flip, set, insert, delete, duplicate, truncate, append, swap), 1 to 4 rounds. */
export function mutateBytes(rng, input, { maxLen = 20000 } = {}) {
  let b = Uint8Array.from(input);
  const rounds = rng.range(1, 4);
  for (let r = 0; r < rounds; r++) {
    switch (rng.int(8)) {
      case 0: if (b.length) b[rng.int(b.length)] ^= 1 << rng.int(8); break;
      case 1: if (b.length) b[rng.int(b.length)] = rng.pick([0, 1, 0x7f, 0x80, 0xff, rng.int(256)]); break;
      case 2: b = splice(b, rng.int(b.length + 1), 0, rng.bytes(rng.range(1, 16))); break;
      case 3: if (b.length) { const at = rng.int(b.length); b = splice(b, at, Math.min(rng.range(1, 16), b.length - at), new Uint8Array(0)); } break;
      case 4: if (b.length) { const at = rng.int(b.length); const len = Math.min(rng.range(1, 32), b.length - at); b = splice(b, at, 0, b.slice(at, at + len)); } break;
      case 5: b = b.slice(0, rng.int(b.length + 1)); break;
      case 6: b = splice(b, b.length, 0, rng.bytes(rng.range(1, 64))); break;
      default: if (b.length > 1) { const i = rng.int(b.length); const j = rng.int(b.length); const t = b[i]; b[i] = b[j]; b[j] = t; }
    }
  }
  return b.length > maxLen ? b.subarray(0, maxLen) : b;
}

export function hexOf(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
  return s;
}

export function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export const utf8 = new TextEncoder();
export const utf8Strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// ---------------------------------------------------------------------------------------------
// printing
// ---------------------------------------------------------------------------------------------

function replacer(key, v) {
  if (typeof v === 'bigint') return v.toString() + 'n';
  if (v instanceof Uint8Array) return 'u8:' + hexOf(v.length > 64 ? v.subarray(0, 64) : v) + (v.length > 64 ? '...(' + v.length + ' bytes)' : '');
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  if (Object.is(v, -0)) return '-0';
  if (v === undefined) return '<undefined>';
  if (v instanceof Raw) return '<raw ' + v.text + '>';
  return v;
}

/** A short printable form of an input (strings quoted, bytes in hex, bigints with n). */
export function describe(value, max = 400) {
  let text;
  try {
    if (typeof value === 'string') text = JSON.stringify(value);
    else if (value instanceof Uint8Array) text = 'hex:' + hexOf(value) + ' (' + value.length + ' bytes)';
    else text = JSON.stringify(value, replacer);
  } catch (_) {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  return text.length > max ? text.slice(0, max) + '... (' + text.length + ' chars)' : text;
}

// ---------------------------------------------------------------------------------------------
// fixtures (WebCrypto, in-process)
// ---------------------------------------------------------------------------------------------

/** A key string with the right shape (tag, 65 bytes, 0x04 prefix); not a point on the curve, which the shape checks do not ask for. */
export function fakePub(rng) {
  const raw = rng.bytes(65);
  raw[0] = 4;
  return 'p256:' + b64url.encode(raw);
}

/** { privateKey, pub }: an ECDSA P-256 identity the chain and sign-in code accept. */
export async function ecdsaIdentity() {
  const kp = await generateKeyPair();
  return { privateKey: kp.privateKey, pub: await exportPublicKey(kp.publicKey) };
}

/** n raw uncompressed P-256 points (65 bytes) that are on the curve. */
export async function ecdhPoints(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const kp = await globalThis.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    out.push(new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', kp.publicKey)));
  }
  return out;
}
