// Sealed items, mw-seal-v1 (R 2.6.2, ARCHITECTURE 15.5; MF-72): a value convention inside
// `append('mw.s', v)`, no new op.
//
//   v  = { enc: 'mw-seal-v1', iv: <12 random bytes b64url>, ct: <b64url>, hint?: <4 bytes b64url> }
//   P  = kind (1) | ver (4, big-endian) | seq (2) | count (2) | len (2) | data (len) | zeros,
//        exactly 1,024 bytes, so data holds at most 1,013 bytes
//   kinds 1 rec-index, 2 rec-data, 3 media-own: AES-256-GCM under K_rec[r] or K_own
//   kinds 4 grant, 5 join: the chat lane's sealed box to the recipient (injected sealTo / openFrom)
//   AAD = utf8("mw-seal-v1\n" + ledgerId + "\n" + authorPub)
//   hint = HMAC-SHA-256(K_pair, "hint|" + day)[:4], day = floor(ms / 86,400,000) in decimal
//
// A fresh random IV for every seal, never a counter (two restored devices would repeat it).
// Readers take, per author, the newest items, at most 32 per author count (SDK convention,
// MF-24); items that do not open are skipped. Pure: Node >= 22 and browsers.

import { b64url, utf8 } from '../chain/canonical.js';

export const SEAL_ENC = 'mw-seal-v1';
export const SEAL_LIST = 'mw.s';
export const PLAINTEXT_BYTES = 1024;
export const HEADER_BYTES = 11;
export const MAX_DATA_BYTES = PLAINTEXT_BYTES - HEADER_BYTES; // 1,013
export const MAX_ITEMS_PER_AUTHOR = 32;
export const KINDS = Object.freeze({ REC_INDEX: 1, REC_DATA: 2, MEDIA_OWN: 3, GRANT: 4, JOIN: 5 });
const DAY_MS = 86400000;

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error('WebCrypto (crypto.subtle) is unavailable');
  return c.subtle;
}

const sealError = (code, message) => Object.assign(new Error(message), { code });

function u16(n, name) {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new RangeError(name + ' must be 0..65535');
  return n;
}

/** encodePlain({ kind, ver, seq, count, data }) -> Uint8Array(1024). */
export function encodePlain({ kind, ver = 1, seq = 0, count = 1, data }) {
  if (!Number.isInteger(kind) || kind < 1 || kind > 5) throw new RangeError('kind must be 1..5');
  if (!Number.isInteger(ver) || ver < 0 || ver > 0xffffffff) throw new RangeError('ver must be a uint32');
  u16(seq, 'seq');
  u16(count, 'count');
  const d = typeof data === 'string' ? utf8.encode(data) : data;
  if (!(d instanceof Uint8Array)) throw new TypeError('data must be bytes or a string');
  if (d.length > MAX_DATA_BYTES) throw sealError('E_SEAL_TOO_BIG', 'sealed data holds at most ' + MAX_DATA_BYTES + ' bytes');
  const out = new Uint8Array(PLAINTEXT_BYTES);
  out[0] = kind;
  out[1] = ver >>> 24; out[2] = ver >>> 16; out[3] = ver >>> 8; out[4] = ver;
  out[5] = seq >>> 8; out[6] = seq;
  out[7] = count >>> 8; out[8] = count;
  out[9] = d.length >>> 8; out[10] = d.length;
  out.set(d, HEADER_BYTES);
  return out;
}

/** decodePlain(bytes) -> { kind, ver, seq, count, data } or null (wrong size, bad length, non-zero padding). */
export function decodePlain(p) {
  if (!(p instanceof Uint8Array) || p.length !== PLAINTEXT_BYTES) return null;
  const kind = p[0];
  if (kind < 1 || kind > 5) return null;
  const ver = ((p[1] << 24) | (p[2] << 16) | (p[3] << 8) | p[4]) >>> 0;
  const seq = (p[5] << 8) | p[6];
  const count = (p[7] << 8) | p[8];
  const len = (p[9] << 8) | p[10];
  if (len > MAX_DATA_BYTES) return null;
  for (let i = HEADER_BYTES + len; i < PLAINTEXT_BYTES; i++) if (p[i] !== 0) return null;
  return { kind, ver, seq, count, data: p.slice(HEADER_BYTES, HEADER_BYTES + len) };
}

/** sealAad(ledgerId, authorPub) -> bytes of "mw-seal-v1\n" + ledgerId + "\n" + authorPub. */
export function sealAad(ledgerId, authorPub) {
  if (typeof ledgerId !== 'string' || !ledgerId) throw new TypeError('ledgerId required');
  if (typeof authorPub !== 'string' || !authorPub) throw new TypeError('authorPub required');
  return utf8.encode(SEAL_ENC + '\n' + ledgerId + '\n' + authorPub);
}

async function aesKey(key) {
  if (key && typeof key === 'object' && typeof key.type === 'string' && key.algorithm) return key; // CryptoKey
  const raw = typeof key === 'string' ? b64url.decode(key) : key;
  if (!(raw instanceof Uint8Array) || raw.length !== 32) throw new TypeError('key must be a 32-byte AES key or a CryptoKey');
  return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * seal({ kind, ver, seq, count, data, ledgerId, authorPub, key?, sealTo?, theirChatPub?, hint? })
 *   -> { enc, iv, ct, hint? }
 * Kinds 1 to 3 use key (K_rec[r] or K_own, bytes or CryptoKey). Kinds 4 and 5 call
 * sealTo(theirChatPub, plaintext, { aad, iv }) -> Promise<Uint8Array>, supplied by the chat lane
 * (its deniable sealed box, R 2.7.4); hint (4 bytes) lets the recipient find the item.
 */
export async function seal({ kind, ver, seq, count, data, ledgerId, authorPub, key, sealTo, theirChatPub, hint }) {
  const plain = encodePlain({ kind, ver, seq, count, data });
  const aad = sealAad(ledgerId, authorPub);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  let ct;
  if (kind <= 3) {
    ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad }, await aesKey(key), plain));
  } else {
    if (typeof sealTo !== 'function') throw new TypeError('kinds 4 and 5 need sealTo (the chat lane sealed box)');
    ct = await sealTo(theirChatPub, plain, { aad, iv });
    if (!(ct instanceof Uint8Array)) throw new TypeError('sealTo must return bytes');
  }
  const v = { enc: SEAL_ENC, iv: b64url.encode(iv), ct: b64url.encode(ct) };
  if (hint !== undefined && hint !== null) {
    const h = typeof hint === 'string' ? b64url.decode(hint) : hint;
    if (!(h instanceof Uint8Array) || h.length !== 4) throw new TypeError('hint must be 4 bytes');
    v.hint = b64url.encode(h);
  }
  return v;
}

/** isSealedValue(v) -> true for the value shape (a state rule: other shapes are hidden). */
export function isSealedValue(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (!keys.every((k) => k === 'enc' || k === 'iv' || k === 'ct' || k === 'hint')) return false;
  if (v.enc !== SEAL_ENC || typeof v.iv !== 'string' || typeof v.ct !== 'string') return false;
  try {
    if (b64url.decode(v.iv).length !== 12) return false;
    if (v.hint !== undefined && b64url.decode(v.hint).length !== 4) return false;
    return b64url.decode(v.ct).length >= PLAINTEXT_BYTES;
  } catch (_) {
    return false;
  }
}

/**
 * open({ value, ledgerId, authorPub, key?, openFrom? }) -> { kind, ver, seq, count, data } or null.
 * null for any failure: wrong key, AAD mismatch (another ledger or author), bad shape or padding.
 * openFrom(ct, { aad, iv }) -> Promise<Uint8Array | null> opens kinds 4 and 5 (chat lane).
 */
export async function open({ value, ledgerId, authorPub, key, openFrom }) {
  if (!isSealedValue(value)) return null;
  try {
    const aad = sealAad(ledgerId, authorPub);
    const iv = b64url.decode(value.iv);
    const ct = b64url.decode(value.ct);
    // A self key opens only kinds 1 to 3; the sealed box opens only kinds 4 and 5.
    if (key !== undefined && key !== null) {
      let plain = null;
      try {
        plain = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: aad }, await aesKey(key), ct));
      } catch (_) {
        plain = null;
      }
      const out = plain && decodePlain(plain);
      if (out && out.kind <= 3) return out;
    }
    if (typeof openFrom === 'function') {
      const plain = await openFrom(ct, { aad, iv });
      const out = plain instanceof Uint8Array ? decodePlain(plain) : null;
      if (out && out.kind >= 4) return out;
    }
    return null;
  } catch (_) {
    return null;
  }
}

/** hintFor(kPair, ms) -> 4 bytes = HMAC-SHA-256(K_pair, "hint|" + day)[:4]. */
export async function hintFor(kPair, ms) {
  const raw = typeof kPair === 'string' ? b64url.decode(kPair) : kPair;
  if (!(raw instanceof Uint8Array) || raw.length < 16) throw new TypeError('K_pair must be at least 16 bytes');
  const day = Math.floor(ms / DAY_MS);
  const key = await subtle().importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', key, utf8.encode('hint|' + day))).slice(0, 4);
}

/**
 * findByHint(items, kPair, ms, { days = 1 }) -> the items whose value.hint matches the hint of
 * any day in [day - days, day + days] (clock skew between devices). items: [{ v, ... }].
 */
export async function findByHint(items, kPair, ms, { days = 1 } = {}) {
  const wanted = new Set();
  for (let d = -days; d <= days; d++) wanted.add(b64url.encode(await hintFor(kPair, ms + d * DAY_MS)));
  return items.filter((it) => it && it.v && typeof it.v.hint === 'string' && wanted.has(it.v.hint));
}

/**
 * readEffective(items, { open: (item) -> Promise<decoded | null>, max = 32 })
 *   -> Map<author, [{ item, plain }]> newest first.
 * items: effective ledger entries of the 'mw.s' list ([{ author, ts, h, v }], tombstoned items
 * already removed by the reducer). Per author only the newest `max` items count (whether or not
 * they open); those that open are returned.
 */
export async function readEffective(items, { open: openItem, max = MAX_ITEMS_PER_AUTHOR } = {}) {
  if (typeof openItem !== 'function') throw new TypeError('readEffective needs open(item)');
  const byAuthor = new Map();
  for (const it of items) {
    if (!it || typeof it.author !== 'string' || !isSealedValue(it.v)) continue;
    if (!byAuthor.has(it.author)) byAuthor.set(it.author, []);
    byAuthor.get(it.author).push(it);
  }
  const out = new Map();
  for (const [author, list] of byAuthor) {
    list.sort((a, b) => (b.ts || 0) - (a.ts || 0) || (String(b.h) < String(a.h) ? -1 : String(b.h) > String(a.h) ? 1 : 0));
    const opened = [];
    for (const item of list.slice(0, max)) {
      const plain = await openItem(item);
      if (plain) opened.push({ item, plain });
    }
    out.set(author, opened);
  }
  return out;
}
