// The pin node's signed heartbeat (SEEDING-AND-ZERO-SETUP-DESIGN 3.1.6, evidence tier E4 of 3.1.5):
//
//   { v: 1, t: 'mw-pin-status', key, site, at, items, monthBytes, monthCap, sig }
//
// written by tools/pin.mjs --status and published at <ws base>/pin-status.json. key is the pin's 'p256:' key
// (_mw.cfg.pin), site the ledger id of the site it pins ('mw1:...', so a hub pin's heartbeat for one site
// does not count for another), at the pin's clock in milliseconds, items one id per infohash the pin holds
// whole and seeds: itemId(ih) = base64url of the first 16 bytes of SHA-256(utf8('mw-pin-status-v1|' + ih)),
// so the file names no infohash in the clear and a private media swarm stays private (a reader learns only
// whether an infohash it already knows is listed). monthBytes is what the pinned files uploaded in this UTC
// calendar month, monthCap the --month-cap in bytes or null. sig is the 64-byte raw ECDSA P-256 signature
// (base64url) over statusBytes(obj) = utf8('mw-pin-status-v1\n' + JCS(obj without sig)) (RFC 8785).
//
// A verifier accepts a heartbeat at most STATUS_MAX_AGE_MS (15 minutes) old and at most STATUS_SKEW_MS
// (5 minutes) ahead of its clock. Caps: 256 KiB of JSON, 4,096 items.
//
// Shared code: Node >= 22 and browsers, WebCrypto for signatures, no Buffer, no node: imports.

import { canonicalize, utf8, b64url, asBytes } from '../chain/canonical.js';
import { sha256Sync } from '../chain/sha256-sync.js';
import { isPublicKeyString, sign as ecdsaSign, verify as ecdsaVerify } from '../chain/crypto.js';

export const STATUS_TYPE = 'mw-pin-status';
export const STATUS_VERSION = 1;
/** Prefix of the signed bytes. */
export const STATUS_PREFIX = 'mw-pin-status-v1\n';
/** Prefix of the hashed item ids (a hash input, never signed). */
export const ITEM_PREFIX = 'mw-pin-status-v1|';
/** The file name under the web seed base. */
export const STATUS_FILE = 'pin-status.json';
export const STATUS_MAX_BYTES = 256 * 1024;
export const STATUS_MAX_ITEMS = 4096;
/** A heartbeat older than this is no evidence (E4: "at most 15 minutes old"). */
export const STATUS_MAX_AGE_MS = 900000;
/** How far ahead of the verifier's clock a heartbeat may be. */
export const STATUS_SKEW_MS = 300000;
/** Longest site id (a ledger id is 31 characters, 'btih:' + 40 is 45). */
export const SITE_MAX = 128;

const ITEM_BYTES = 16;
const SIGNATURE_BYTES = 64;
const FIELDS = Object.freeze(['v', 't', 'key', 'site', 'at', 'items', 'monthBytes', 'monthCap', 'sig']);
const IH_ANY_RE = /^[0-9a-fA-F]{40}$/;
const ITEM_RE = /^[A-Za-z0-9_-]{22}$/;
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;
const SITE_RE = /^[\x21-\x7e]+$/;

const isUint = (x) => Number.isSafeInteger(x) && x >= 0;

function isPlainObject(x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

function isPrivateKey(x) {
  return x !== null && typeof x === 'object' && x.type === 'private' && typeof x.algorithm === 'object';
}

function decodesTo(str, re, length) {
  if (typeof str !== 'string' || !re.test(str)) return false;
  try {
    return b64url.decode(str).length === length;
  } catch (_) {
    return false;
  }
}

/** itemId(ih) -> the 22-character id of an infohash in a heartbeat. TypeError unless ih is 40 hex characters. */
export function itemId(ih) {
  if (typeof ih !== 'string' || !IH_ANY_RE.test(ih)) throw new TypeError('itemId: an infohash is 40 hexadecimal characters');
  return b64url.encode(sha256Sync(utf8.encode(ITEM_PREFIX + ih.toLowerCase())).subarray(0, ITEM_BYTES));
}

/**
 * makeStatus({ key, site, at, ihs, monthBytes = 0, monthCap = null }) -> the unsigned heartbeat
 * { v: 1, t: 'mw-pin-status', key, site, at, items, monthBytes, monthCap }. items are the ids of ihs, sorted
 * and without duplicates (their order tells nothing). TypeError or RangeError on bad input.
 */
export function makeStatus({ key, site, at, ihs = [], monthBytes = 0, monthCap = null } = {}) {
  if (!isPublicKeyString(key)) throw new TypeError('makeStatus: key must be a p256: public key');
  if (typeof site !== 'string' || !site || site.length > SITE_MAX || !SITE_RE.test(site)) throw new TypeError('makeStatus: site must be 1 to ' + SITE_MAX + ' printable ASCII characters (the ledger id)');
  if (!isUint(at)) throw new TypeError('makeStatus: at must be a whole number of milliseconds');
  if (!Array.isArray(ihs)) throw new TypeError('makeStatus: ihs must be an array of infohashes');
  if (!isUint(monthBytes)) throw new TypeError('makeStatus: monthBytes must be a whole number of bytes');
  if (monthCap !== null && !(Number.isSafeInteger(monthCap) && monthCap >= 1)) throw new TypeError('makeStatus: monthCap must be a number of bytes or null');
  const items = Array.from(new Set(ihs.map(itemId))).sort();
  if (items.length > STATUS_MAX_ITEMS) throw new RangeError('makeStatus: at most ' + STATUS_MAX_ITEMS + ' items');
  return { v: STATUS_VERSION, t: STATUS_TYPE, key, site, at, items, monthBytes, monthCap };
}

/**
 * checkStatus(obj, { signed = true }) -> { ok: true } | { ok: false, reason }: the shape (no signature check).
 * Reasons: 'malformed', 'extra-field', 'wrong-version', 'wrong-type', 'bad-key', 'bad-site', 'bad-at',
 * 'bad-items', 'too-many-items', 'cleartext-infohash' (an item spelled as an infohash), 'bad-item',
 * 'duplicate-item', 'bad-month-bytes', 'bad-month-cap', 'bad-sig'.
 */
export function checkStatus(obj, { signed = true } = {}) {
  if (!isPlainObject(obj)) return { ok: false, reason: 'malformed' };
  for (const k of Object.keys(obj)) if (FIELDS.indexOf(k) < 0) return { ok: false, reason: 'extra-field' };
  if (obj.v !== STATUS_VERSION) return { ok: false, reason: 'wrong-version' };
  if (obj.t !== STATUS_TYPE) return { ok: false, reason: 'wrong-type' };
  if (!isPublicKeyString(obj.key)) return { ok: false, reason: 'bad-key' };
  if (typeof obj.site !== 'string' || !obj.site || obj.site.length > SITE_MAX || !SITE_RE.test(obj.site)) return { ok: false, reason: 'bad-site' };
  if (!isUint(obj.at)) return { ok: false, reason: 'bad-at' };
  if (!Array.isArray(obj.items)) return { ok: false, reason: 'bad-items' };
  if (obj.items.length > STATUS_MAX_ITEMS) return { ok: false, reason: 'too-many-items' };
  const seen = new Set();
  for (const it of obj.items) {
    if (typeof it === 'string' && IH_ANY_RE.test(it)) return { ok: false, reason: 'cleartext-infohash' };
    if (!decodesTo(it, ITEM_RE, ITEM_BYTES)) return { ok: false, reason: 'bad-item' };
    if (seen.has(it)) return { ok: false, reason: 'duplicate-item' };
    seen.add(it);
  }
  if (!isUint(obj.monthBytes)) return { ok: false, reason: 'bad-month-bytes' };
  if (obj.monthCap !== null && !(Number.isSafeInteger(obj.monthCap) && obj.monthCap >= 1)) return { ok: false, reason: 'bad-month-cap' };
  if (signed) {
    if (!decodesTo(obj.sig, SIG_RE, SIGNATURE_BYTES)) return { ok: false, reason: 'bad-sig' };
  } else if (obj.sig !== undefined) {
    return { ok: false, reason: 'extra-field' };
  }
  return { ok: true };
}

function withoutSig(obj) {
  const out = {};
  for (const k of FIELDS) if (k !== 'sig' && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/** statusBytes(obj) -> Uint8Array: utf8('mw-pin-status-v1\n' + JCS(obj without sig)). TypeError for a bad shape. */
export function statusBytes(obj) {
  if (isPlainObject(obj)) {
    for (const k of Object.keys(obj)) if (FIELDS.indexOf(k) < 0) throw new TypeError('statusBytes: not a heartbeat (extra-field)');
  }
  const body = isPlainObject(obj) ? withoutSig(obj) : obj;
  const c = checkStatus(body, { signed: false });
  if (!c.ok) throw new TypeError('statusBytes: not a heartbeat (' + c.reason + ')');
  return utf8.encode(STATUS_PREFIX + canonicalize(body));
}

/** encodeStatus(obj) -> the JSON text of a heartbeat file (one line). RangeError above STATUS_MAX_BYTES. */
export function encodeStatus(obj) {
  const text = JSON.stringify(obj) + '\n';
  if (utf8.encode(text).length > STATUS_MAX_BYTES) throw new RangeError('a heartbeat is at most ' + STATUS_MAX_BYTES + ' bytes');
  return text;
}

/**
 * signStatus(obj, signer) -> Promise<the heartbeat with sig>. signer: a private CryptoKey, or a function
 * (bytes) -> Promise<signature as 64 bytes or base64url>. The key must be the one named in obj.key; nothing
 * here can check that, verifyStatus does.
 */
export async function signStatus(obj, signer) {
  const bytes = statusBytes(obj);
  let sig;
  if (isPrivateKey(signer)) sig = await ecdsaSign(signer, bytes);
  else if (typeof signer === 'function') sig = await signer(bytes);
  else throw new TypeError('signStatus: the signer is a function (bytes -> signature) or a private CryptoKey');
  const sigText = typeof sig === 'string' ? sig : b64url.encode(asBytes(sig));
  if (!decodesTo(sigText, SIG_RE, SIGNATURE_BYTES)) throw new TypeError('signStatus: the signer returned a signature that is not 64 bytes');
  const out = Object.assign(withoutSig(obj), { sig: sigText });
  encodeStatus(out); // the size cap
  return out;
}

/**
 * parseStatus(input) -> { ok: true, status } | { ok: false, reason }: the heartbeat from the file's text or
 * bytes (or an object). Reasons: 'too-large', 'malformed', and those of checkStatus. Never throws.
 */
export function parseStatus(input) {
  let obj = input;
  if (typeof input === 'string' || input instanceof Uint8Array || input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    let text;
    if (typeof input === 'string') {
      if (utf8.encode(input).length > STATUS_MAX_BYTES) return { ok: false, reason: 'too-large' };
      text = input;
    } else {
      const u8 = asBytes(input);
      if (u8.length > STATUS_MAX_BYTES) return { ok: false, reason: 'too-large' };
      try {
        text = utf8.decode(u8, { fatal: true });
      } catch (_) {
        return { ok: false, reason: 'malformed' };
      }
    }
    try {
      obj = JSON.parse(text);
    } catch (_) {
      return { ok: false, reason: 'malformed' };
    }
  } else {
    try {
      if (utf8.encode(JSON.stringify(obj) || '').length > STATUS_MAX_BYTES) return { ok: false, reason: 'too-large' };
    } catch (_) {
      return { ok: false, reason: 'malformed' };
    }
  }
  const c = checkStatus(obj);
  return c.ok ? { ok: true, status: obj } : { ok: false, reason: c.reason };
}

const never = () => false;

/**
 * verifyStatus(input, { expectKey, site, now, maxAgeMs = 900000, skewMs = 300000 })
 *   -> Promise<{ ok, reason, age, count, has(ih), status }>
 * input is the parsed object or the file's text or bytes. ok when the heartbeat is well formed, from expectKey
 * (the site's _mw.cfg.pin), for site (the verifier's ledger id; checked when given), at most maxAgeMs old and
 * at most skewMs ahead, with a valid signature. has(ih) tells whether an infohash is listed (always false when
 * not ok); age is now - at in milliseconds (null when unreadable); count the number of items. Reasons: those
 * of parseStatus, 'no-expected-key', 'other-key', 'other-site', 'stale', 'future', 'signature'. Never throws.
 */
export async function verifyStatus(input, { expectKey, site = null, now = Date.now(), maxAgeMs = STATUS_MAX_AGE_MS, skewMs = STATUS_SKEW_MS } = {}) {
  const fail = (reason, status = null) => ({ ok: false, reason, age: status ? now - status.at : null, count: status ? status.items.length : 0, has: never, status });
  const p = parseStatus(input);
  if (!p.ok) return fail(p.reason);
  const s = p.status;
  if (!isPublicKeyString(expectKey)) return fail('no-expected-key', s);
  if (s.key !== expectKey) return fail('other-key', s);
  if (site !== null && site !== undefined && s.site !== site) return fail('other-site', s);
  const maxAge = Number.isFinite(maxAgeMs) && maxAgeMs >= 0 ? maxAgeMs : STATUS_MAX_AGE_MS;
  const skew = Number.isFinite(skewMs) && skewMs >= 0 ? skewMs : STATUS_SKEW_MS;
  if (!Number.isFinite(now)) return fail('stale', s);
  const age = now - s.at;
  if (age > maxAge) return fail('stale', s);
  if (-age > skew) return fail('future', s);
  let bytes;
  try {
    bytes = statusBytes(s);
  } catch (_) {
    return fail('malformed', s);
  }
  if (!(await ecdsaVerify(s.key, bytes, s.sig))) return fail('signature', s);
  const set = new Set(s.items);
  const has = (ih) => {
    try {
      return set.has(itemId(ih));
    } catch (_) {
      return false;
    }
  };
  return { ok: true, reason: null, age, count: s.items.length, has, status: s };
}

/** statusUrl(wsBase) -> the heartbeat's URL under a web seed base ('https://example.com/ws/' -> '.../ws/pin-status.json'). */
export function statusUrl(wsBase) {
  const base = String(wsBase);
  return new URL(STATUS_FILE, base.endsWith('/') ? base : base + '/').href;
}
