// mw_pin1: the pin node's identity and receipts on site and file torrent wires (SEEDING-AND-ZERO-SETUP-DESIGN
// 3.1.6, 3.1.5 E4; V03-DESIGN-REVIEW 2.5.5, 2.10.3). A BEP 10 extension whose messages are JSON frames of at
// most FRAME_MAX_BYTES (1,024) bytes:
//
//   browser -> pin   { t: 'chal', n }                          n = base64url of 16 random bytes, once per wire
//   pin -> browser   { t: 'hello', key, ih, n, at, sig }        sig over helloBytes(ih, n, at)
//   pin -> browser   { t: 'rcpt', key, ih, total, at, sig }     sig over receiptBytes(ih, total, at), once it holds
//                                                               every piece verified
//
//   helloBytes(ih, n, at)       = utf8('mw-pin1-hello\n' + ih + '\n' + n + '\n' + at)
//   receiptBytes(ih, total, at) = utf8('mw-pin1-receipt\n' + ih + '\n' + total + '\n' + at)
//
// key is the pin's 'p256:' public key (the site names it in _mw.cfg.pin), ih the torrent's infohash (40
// lowercase hex), at the signer's clock in milliseconds since the epoch (a verifier accepts |now - at| up to
// SKEW_MS, 5 minutes), total the torrent's length in bytes, sig the 64-byte raw (IEEE P1363) ECDSA P-256
// signature in base64url. The key never enters a page: a pinned page signs through tools/pin.mjs, whose
// Node signer refuses every byte string isPinSignable() refuses, so a page cannot make the pin key sign a
// block, a pointer or anything else.
//
// decodeFrame() and the verify functions never throw on hostile input: they return { ok: false, reason }.
// encodeFrame(), helloBytes() and receiptBytes() are for local data and throw TypeError on bad input.
//
// Shared code: Node >= 22 and browsers, WebCrypto only, no Buffer, no node: imports.

import { utf8, b64url, asBytes } from '../chain/canonical.js';
import { isPublicKeyString, sign as ecdsaSign, verify as ecdsaVerify } from '../chain/crypto.js';

/** The BEP 10 extension name (registerWireExtension, swarms 'site' and 'file'). */
export const EXT_NAME = 'mw_pin1';
/** Largest frame, in UTF-8 bytes of its JSON. */
export const FRAME_MAX_BYTES = 1024;
/** Random bytes of a challenge. */
export const NONCE_BYTES = 16;
/** Largest |now - at| a verifier accepts, and the Node signer signs (5 minutes). */
export const SKEW_MS = 300000;
export const HELLO_PREFIX = 'mw-pin1-hello\n';
export const RECEIPT_PREFIX = 'mw-pin1-receipt\n';
/** No signable byte string is longer (a hello is 94 bytes at most, a receipt 90). */
export const SIGNABLE_MAX_BYTES = 128;
export const FRAME_TYPES = Object.freeze(['chal', 'hello', 'rcpt']);

const SIGNATURE_BYTES = 64;
const IH_RE = /^[0-9a-f]{40}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;
const UINT_RE = /^(0|[1-9][0-9]{0,15})$/;
const HELLO_RE = /^mw-pin1-hello\n([0-9a-f]{40})\n([A-Za-z0-9_-]{22})\n(0|[1-9][0-9]{0,15})$/;
const RECEIPT_RE = /^mw-pin1-receipt\n([0-9a-f]{40})\n([1-9][0-9]{0,15})\n(0|[1-9][0-9]{0,15})$/;

/** The fields of each frame type, in the order encodeFrame writes them. */
const FIELDS = Object.freeze({
  chal: Object.freeze(['t', 'n']),
  hello: Object.freeze(['t', 'key', 'ih', 'n', 'at', 'sig']),
  rcpt: Object.freeze(['t', 'key', 'ih', 'total', 'at', 'sig']),
});

const isUint = (x) => Number.isSafeInteger(x) && x >= 0;
const isTotal = (x) => Number.isSafeInteger(x) && x >= 1;
const isIh = (x) => typeof x === 'string' && IH_RE.test(x);

function decodesTo(str, re, length) {
  if (typeof str !== 'string' || !re.test(str)) return false;
  try {
    return b64url.decode(str).length === length; // strict: one spelling per byte string
  } catch (_) {
    return false;
  }
}

const isNonce = (x) => decodesTo(x, NONCE_RE, NONCE_BYTES);
const isSig = (x) => decodesTo(x, SIG_RE, SIGNATURE_BYTES);

function isPlainObject(x) {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

function isPrivateKey(x) {
  return x !== null && typeof x === 'object' && x.type === 'private' && typeof x.algorithm === 'object';
}

// ---------------------------------------------------------------------------------------------
// the signed byte strings
// ---------------------------------------------------------------------------------------------

function helloString(ih, n, at) {
  if (!isIh(ih)) throw new TypeError('helloBytes: ih must be 40 lowercase hexadecimal characters');
  if (!isNonce(n)) throw new TypeError('helloBytes: n must be the base64url of 16 bytes');
  if (!isUint(at)) throw new TypeError('helloBytes: at must be a whole number of milliseconds');
  return HELLO_PREFIX + ih + '\n' + n + '\n' + at;
}

function receiptString(ih, total, at) {
  if (!isIh(ih)) throw new TypeError('receiptBytes: ih must be 40 lowercase hexadecimal characters');
  if (!isTotal(total)) throw new TypeError('receiptBytes: total must be the length in bytes (1 or more)');
  if (!isUint(at)) throw new TypeError('receiptBytes: at must be a whole number of milliseconds');
  return RECEIPT_PREFIX + ih + '\n' + total + '\n' + at;
}

/** helloBytes(ih, n, at) -> Uint8Array: what the pin signs in a hello. TypeError on bad input. */
export function helloBytes(ih, n, at) {
  return utf8.encode(helloString(ih, n, at));
}

/** receiptBytes(ih, total, at) -> Uint8Array: what the pin signs in a receipt. TypeError on bad input. */
export function receiptBytes(ih, total, at) {
  return utf8.encode(receiptString(ih, total, at));
}

/**
 * parseSignable(bytes) -> { kind: 'hello', ih, n, at } | { kind: 'receipt', ih, total, at } | null
 * null unless the bytes are exactly helloBytes(...) or receiptBytes(...) of valid fields: one prefix, three
 * fields, one spelling (lowercase infohash, canonical base64url, decimal numbers without signs or leading
 * zeros), nothing before or after. Never throws.
 */
export function parseSignable(bytes) {
  let u8;
  try {
    u8 = asBytes(bytes);
  } catch (_) {
    return null;
  }
  if (u8.length === 0 || u8.length > SIGNABLE_MAX_BYTES) return null;
  let text;
  try {
    text = utf8.decode(u8, { fatal: true });
  } catch (_) {
    return null;
  }
  let m = HELLO_RE.exec(text);
  if (m) {
    const at = Number(m[3]);
    if (!isNonce(m[2]) || !isUint(at) || helloString(m[1], m[2], at) !== text) return null;
    return { kind: 'hello', ih: m[1], n: m[2], at };
  }
  m = RECEIPT_RE.exec(text);
  if (m) {
    const total = Number(m[2]);
    const at = Number(m[3]);
    if (!isTotal(total) || !isUint(at) || receiptString(m[1], total, at) !== text) return null;
    return { kind: 'receipt', ih: m[1], total, at };
  }
  return null;
}

/**
 * isPinSignable(bytes) -> true only for bytes that parse as exactly one hello or one receipt (parseSignable).
 * The Node signer of tools/pin.mjs signs nothing else.
 */
export function isPinSignable(bytes) {
  return parseSignable(bytes) !== null;
}

// ---------------------------------------------------------------------------------------------
// frames
// ---------------------------------------------------------------------------------------------

/**
 * checkFrame(frame) -> { ok: true } | { ok: false, reason }: the shape of a frame (no signature check).
 * Reasons: 'malformed', 'unknown-type', 'extra-field', 'bad-n', 'bad-key', 'bad-ih', 'bad-total', 'bad-at',
 * 'bad-sig'.
 */
export function checkFrame(frame) {
  if (!isPlainObject(frame)) return { ok: false, reason: 'malformed' };
  const fields = typeof frame.t === 'string' && Object.prototype.hasOwnProperty.call(FIELDS, frame.t) ? FIELDS[frame.t] : null;
  if (!fields) return { ok: false, reason: 'unknown-type' };
  for (const k of Object.keys(frame)) if (fields.indexOf(k) < 0) return { ok: false, reason: 'extra-field' };
  if (frame.t === 'chal') return isNonce(frame.n) ? { ok: true } : { ok: false, reason: 'bad-n' };
  if (!isPublicKeyString(frame.key)) return { ok: false, reason: 'bad-key' };
  if (!isIh(frame.ih)) return { ok: false, reason: 'bad-ih' };
  if (frame.t === 'hello' && !isNonce(frame.n)) return { ok: false, reason: 'bad-n' };
  if (frame.t === 'rcpt' && !isTotal(frame.total)) return { ok: false, reason: 'bad-total' };
  if (!isUint(frame.at)) return { ok: false, reason: 'bad-at' };
  if (!isSig(frame.sig)) return { ok: false, reason: 'bad-sig' };
  return { ok: true };
}

/**
 * encodeFrame(frame) -> Uint8Array: the JSON of a valid frame, fields in a fixed order. TypeError for a frame
 * checkFrame refuses, RangeError above FRAME_MAX_BYTES (no valid frame is that large).
 */
export function encodeFrame(frame) {
  const c = checkFrame(frame);
  if (!c.ok) throw new TypeError('mw_pin1: not a valid frame (' + c.reason + ')');
  const ordered = {};
  for (const k of FIELDS[frame.t]) ordered[k] = frame[k];
  const bytes = utf8.encode(JSON.stringify(ordered));
  if (bytes.length > FRAME_MAX_BYTES) throw new RangeError('mw_pin1: a frame is at most ' + FRAME_MAX_BYTES + ' bytes');
  return bytes;
}

/**
 * decodeFrame(bytes) -> { ok: true, frame } | { ok: false, reason }: bytes (or a string) from a wire.
 * Reasons: 'too-large' (more than FRAME_MAX_BYTES), 'malformed' (not UTF-8 JSON of an object), and those of
 * checkFrame. Never throws.
 */
export function decodeFrame(bytes) {
  let text;
  if (typeof bytes === 'string') {
    if (utf8.encode(bytes).length > FRAME_MAX_BYTES) return { ok: false, reason: 'too-large' };
    text = bytes;
  } else {
    let u8;
    try {
      u8 = asBytes(bytes);
    } catch (_) {
      return { ok: false, reason: 'malformed' };
    }
    if (u8.length > FRAME_MAX_BYTES) return { ok: false, reason: 'too-large' };
    try {
      text = utf8.decode(u8, { fatal: true });
    } catch (_) {
      return { ok: false, reason: 'malformed' };
    }
  }
  let frame;
  try {
    frame = JSON.parse(text);
  } catch (_) {
    return { ok: false, reason: 'malformed' };
  }
  const c = checkFrame(frame);
  return c.ok ? { ok: true, frame } : { ok: false, reason: c.reason };
}

/** makeChallenge({ random }) -> { t: 'chal', n }: 16 random bytes from random(16) (default: WebCrypto). */
export function makeChallenge({ random = null } = {}) {
  let bytes;
  if (typeof random === 'function') {
    bytes = asBytes(random(NONCE_BYTES));
  } else {
    bytes = new Uint8Array(NONCE_BYTES);
    globalThis.crypto.getRandomValues(bytes);
  }
  if (bytes.length !== NONCE_BYTES) throw new TypeError('makeChallenge: random(16) must return 16 bytes');
  return { t: 'chal', n: b64url.encode(bytes) };
}

async function signWith(signer, bytes) {
  let sig;
  if (isPrivateKey(signer)) sig = await ecdsaSign(signer, bytes);
  else if (typeof signer === 'function') sig = await signer(bytes);
  else throw new TypeError('mw_pin1: the signer is a function (bytes -> signature) or a private CryptoKey');
  if (typeof sig === 'string') {
    if (!isSig(sig)) throw new TypeError('mw_pin1: the signer returned a signature that is not 64 bytes of base64url');
    return sig;
  }
  const u8 = asBytes(sig);
  if (u8.length !== SIGNATURE_BYTES) throw new TypeError('mw_pin1: the signer returned a signature that is not 64 bytes');
  return b64url.encode(u8);
}

/**
 * makeHello({ key, ih, n, at }, signer) -> Promise<hello frame>. signer: a private CryptoKey, or a function
 * (bytes) -> Promise<signature as 64 bytes or base64url> (a pinned page passes one that calls 'pin.sign').
 */
export async function makeHello({ key, ih, n, at }, signer) {
  if (!isPublicKeyString(key)) throw new TypeError('makeHello: key must be a p256: public key');
  const sig = await signWith(signer, helloBytes(ih, n, at));
  return { t: 'hello', key, ih, n, at, sig };
}

/** makeReceipt({ key, ih, total, at }, signer) -> Promise<rcpt frame>; signer as for makeHello. */
export async function makeReceipt({ key, ih, total, at }, signer) {
  if (!isPublicKeyString(key)) throw new TypeError('makeReceipt: key must be a p256: public key');
  const sig = await signWith(signer, receiptBytes(ih, total, at));
  return { t: 'rcpt', key, ih, total, at, sig };
}

function common(frame, type, { expectKey, ih, now, skewMs }) {
  const c = checkFrame(frame);
  if (!c.ok) return c.reason;
  if (frame.t !== type) return 'wrong-type';
  if (!isPublicKeyString(expectKey)) return 'no-expected-key';
  if (frame.key !== expectKey) return 'other-key';
  if (frame.ih !== ih) return 'other-ih';
  const skew = Number.isFinite(skewMs) && skewMs >= 0 ? skewMs : SKEW_MS;
  if (!Number.isFinite(now) || Math.abs(now - frame.at) > skew) return 'skew';
  return null;
}

/**
 * verifyHello(frame, { expectKey, ih, n, now, skewMs = 300000 }) -> Promise<{ ok, reason }>
 * ok when the frame is a hello from expectKey (the site's _mw.cfg.pin) for this wire's infohash, answering
 * the challenge n this side sent, signed within skewMs of now. Reasons: those of checkFrame, 'wrong-type',
 * 'no-expected-key', 'other-key', 'other-ih', 'other-n', 'skew', 'signature'. Never throws.
 */
export async function verifyHello(frame, { expectKey, ih, n, now = Date.now(), skewMs = SKEW_MS } = {}) {
  const bad = common(frame, 'hello', { expectKey, ih, now, skewMs });
  if (bad) return { ok: false, reason: bad };
  if (frame.n !== n) return { ok: false, reason: 'other-n' };
  const good = await ecdsaVerify(frame.key, helloBytes(frame.ih, frame.n, frame.at), frame.sig);
  return good ? { ok: true, reason: null } : { ok: false, reason: 'signature' };
}

/**
 * verifyReceipt(frame, { expectKey, ih, now, skewMs = 300000, total }) -> Promise<{ ok, reason }>
 * ok when the frame is a receipt from expectKey for infohash ih, signed within skewMs of now; with total
 * (the torrent's length in bytes, when the verifier knows it) the receipt must name the same length.
 * Reasons: as verifyHello, with 'other-total' in place of 'other-n'. Never throws.
 */
export async function verifyReceipt(frame, { expectKey, ih, now = Date.now(), skewMs = SKEW_MS, total = null } = {}) {
  const bad = common(frame, 'rcpt', { expectKey, ih, now, skewMs });
  if (bad) return { ok: false, reason: bad };
  if (total !== null && total !== undefined && frame.total !== total) return { ok: false, reason: 'other-total' };
  const good = await ecdsaVerify(frame.key, receiptBytes(frame.ih, frame.total, frame.at), frame.sig);
  return good ? { ok: true, reason: null } : { ok: false, reason: 'signature' };
}

// ---------------------------------------------------------------------------------------------
// file pin requests (code review v0.3, security lens finding 12)
// ---------------------------------------------------------------------------------------------
//
// A member asks the pin node to keep a file with a request its own site key signs:
//
//   pinRequestBytes({ site, ih, size, sha256, at, name }) =
//     utf8('mw-pin1-request\n' + site + '\n' + ih + '\n' + size + '\n' + (sha256 or '') + '\n' + at + '\n' + name)
//   request = { ih, size, name?, sha256?, author, at, sig }
//
// site is the ledger id (so a request signed for one site is worth nothing on another: hub keys span sites), at the
// author's clock (the pin node takes |now - at| up to SKEW_MS), sig the 64-byte P1363 ECDSA signature by author in
// base64url. Page script can reach the pin node's bridge (a same-origin site frame calls window.top's binding), so the
// node takes a request only when its author signed it, and pins at once only what the site's owner key signed. This
// prefix is not one the pin key signs (isPinSignable): the author signs its own requests.

/** Domain-separation prefix of a file pin request. */
export const PIN_REQUEST_PREFIX = 'mw-pin1-request\n';
const SITE_RE = /^[A-Za-z0-9:._-]{1,128}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** pinRequestBytes({ site, ih, size, sha256, at, name }) -> Uint8Array: what the author signs. TypeError on bad input. */
export function pinRequestBytes({ site, ih, size, sha256 = null, at, name = '' } = {}) {
  if (typeof site !== 'string' || !SITE_RE.test(site)) throw new TypeError('pinRequestBytes: site must be a ledger id');
  if (!isIh(ih)) throw new TypeError('pinRequestBytes: ih must be 40 lowercase hexadecimal characters');
  if (!isTotal(size)) throw new TypeError('pinRequestBytes: size must be the length in bytes (1 or more)');
  if (sha256 !== null && sha256 !== undefined && !(typeof sha256 === 'string' && HEX64.test(sha256))) throw new TypeError('pinRequestBytes: sha256 must be 64 lowercase hexadecimal characters');
  if (!isUint(at)) throw new TypeError('pinRequestBytes: at must be a whole number of milliseconds');
  if (typeof name !== 'string' || name.length > 256) throw new TypeError('pinRequestBytes: name must be a string of at most 256 characters');
  return utf8.encode(PIN_REQUEST_PREFIX + site + '\n' + ih + '\n' + size + '\n' + (sha256 || '') + '\n' + at + '\n' + name);
}

/**
 * makePinRequest({ site, ih, size, name, sha256, at, author }, signer) -> Promise<request>: signer as for makeHello (the
 * author's private CryptoKey, or a function that signs through the identity card).
 */
export async function makePinRequest({ site, ih, size, name = '', sha256 = null, at, author }, signer) {
  if (!isPublicKeyString(author)) throw new TypeError('makePinRequest: author must be a p256: public key');
  const sig = await signWith(signer, pinRequestBytes({ site, ih, size, sha256, at, name }));
  const out = { ih, size, author, at, sig };
  if (name) out.name = name;
  if (sha256) out.sha256 = sha256;
  return out;
}

/**
 * verifyPinRequest(request, { site, now, skewMs = 300000 }) -> Promise<{ ok, reason }>: ok when `author` signed exactly
 * this request for this ledger within skewMs of now. Reasons: 'malformed', 'unsigned', 'bad-author', 'bad-field', 'skew',
 * 'signature'. Never throws.
 */
export async function verifyPinRequest(request, { site, now = Date.now(), skewMs = SKEW_MS } = {}) {
  if (!isPlainObject(request)) return { ok: false, reason: 'malformed' };
  if (request.sig === undefined || request.at === undefined) return { ok: false, reason: 'unsigned' };
  if (!isPublicKeyString(request.author)) return { ok: false, reason: 'bad-author' };
  if (!isSig(request.sig)) return { ok: false, reason: 'bad-field' };
  let bytes;
  try {
    bytes = pinRequestBytes({ site, ih: request.ih, size: request.size, sha256: request.sha256 === undefined ? null : request.sha256, at: request.at, name: request.name === undefined || request.name === null ? '' : request.name });
  } catch (_) {
    return { ok: false, reason: 'bad-field' };
  }
  const skew = Number.isFinite(skewMs) && skewMs >= 0 ? skewMs : SKEW_MS;
  if (!Number.isFinite(now) || Math.abs(now - request.at) > skew) return { ok: false, reason: 'skew' };
  let good = false;
  try {
    good = await ecdsaVerify(request.author, bytes, request.sig);
  } catch (_) {
    good = false;
  }
  return good ? { ok: true, reason: null } : { ok: false, reason: 'signature' };
}
