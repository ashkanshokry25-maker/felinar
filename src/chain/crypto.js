// ECDSA P-256 / SHA-256 identity primitives over globalThis.crypto.subtle. Shared by Node >= 22
// and browsers (no Buffer, no node: imports). Signatures are the 64-byte raw r||s that WebCrypto
// produces.
//
// Public keys are algorithm-tagged strings (v0.2.1, DIGEST-AMENDMENTS A2): 'p256:' followed by the
// base64url (no padding, canonical) of the 65-byte uncompressed point, 92 characters in all. The
// tag is part of every serialised key (block authors, owner, ban and allow ops, policy lists, the
// pointer's owner=, the HELLO owner, ledger ids derived from the owner), so a later algorithm
// (for example 'ed25519:') can be added without a format break. Untagged v0.2 keys are refused
// everywhere; fromUntaggedP256() exists only to convert old test fixtures and locally stored
// v0.2 identities, never for input that arrives over the wire. An unknown tag is reported as
// "unsupported key type", never silently accepted.

import { hex, b64url, utf8, asBytes } from './canonical.js';

const KEY_ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_ALG = { name: 'ECDSA', hash: { name: 'SHA-256' } };

export const RAW_PUBLIC_KEY_BYTES = 65;
export const SIGNATURE_BYTES = 64;
/** The only key algorithm v1 generates and verifies. */
export const P256_TAG = 'p256';
export const P256_PREFIX = 'p256:';
/** Key algorithms this version verifies (an unknown tag is "unsupported key type"). */
export const KEY_ALGORITHMS = Object.freeze([P256_TAG]);
/** b64url length of a 65-byte key: ceil(65 * 8 / 6) without padding. */
export const PUBLIC_KEY_B64URL_LENGTH = 87;
/** Length of a tagged P-256 key string: 'p256:' + 87. */
export const PUBLIC_KEY_STRING_LENGTH = P256_PREFIX.length + PUBLIC_KEY_B64URL_LENGTH;

const TAG_RE = /^([a-z][a-z0-9]{0,15}):/;
const B64URL_BODY_RE = /^[A-Za-z0-9_-]+$/;

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new Error('WebCrypto (crypto.subtle) is unavailable: a secure context (https:// or localhost) is required');
  }
  return c.subtle;
}

function isCryptoKey(value) {
  return value !== null && typeof value === 'object' && typeof value.type === 'string' &&
    typeof value.extractable === 'boolean' && typeof value.algorithm === 'object';
}

// Data arguments may be bytes or a string, which is UTF-8 encoded.
function toData(data) {
  return typeof data === 'string' ? utf8.encode(data) : asBytes(data);
}

export async function sha256(data) {
  return new Uint8Array(await subtle().digest('SHA-256', toData(data)));
}

/** Non-extractable by default; the public half of a WebCrypto pair is always exportable. */
export async function generateKeyPair({ extractable = false } = {}) {
  const { publicKey, privateKey } = await subtle().generateKey(KEY_ALG, Boolean(extractable), ['sign', 'verify']);
  return { publicKey, privateKey };
}

/**
 * keyAlgorithm(value) → the algorithm tag of a key string ('p256' for 'p256:...', 'ed25519' for
 * 'ed25519:...'), or null when the value is not a string with a tag. Syntactic only: it does not
 * check the key body or whether the algorithm is supported.
 */
export function keyAlgorithm(value) {
  if (typeof value !== 'string') return null;
  const m = TAG_RE.exec(value);
  return m ? m[1] : null;
}

/** 'p256:' + b64url(raw) for a 65-byte uncompressed P-256 point; TypeError otherwise. */
export function encodePublicKey(raw) {
  const u8 = asBytes(raw);
  if (u8.length !== RAW_PUBLIC_KEY_BYTES || u8[0] !== 0x04) {
    throw new TypeError('public key must be a 65-byte uncompressed P-256 point');
  }
  return P256_PREFIX + b64url.encode(u8);
}

/**
 * fromUntaggedP256(b64) → 'p256:' + b64. ONLY for converting v0.2 test fixtures and identities a
 * browser stored before v0.2.1; anything received from peers, pointers or files must already be
 * tagged. Returns tagged input unchanged; TypeError when the result is not a valid P-256 key.
 */
export function fromUntaggedP256(b64) {
  if (typeof b64 !== 'string') throw new TypeError('public key must be a string');
  const tagged = keyAlgorithm(b64) === null ? P256_PREFIX + b64 : b64;
  publicKeyBytes(tagged);
  return tagged;
}

/**
 * Decodes a tagged public key and checks the shape (tag 'p256', 87 canonical base64url
 * characters, 65 bytes, 0x04 prefix) → raw bytes. TypeError otherwise; an unknown tag gives
 * "unsupported key type: <tag>", an untagged string "public key must be algorithm-tagged".
 */
export function publicKeyBytes(pub) {
  if (typeof pub !== 'string') throw new TypeError('public key must be a string (p256:<base64url>)');
  const alg = keyAlgorithm(pub);
  if (alg === null) throw new TypeError('public key must be algorithm-tagged (p256:<base64url>)');
  if (alg !== P256_TAG) throw new TypeError('unsupported key type: ' + alg);
  const body = pub.slice(P256_PREFIX.length);
  if (body.length !== PUBLIC_KEY_B64URL_LENGTH || !B64URL_BODY_RE.test(body)) {
    throw new TypeError('public key must be p256: followed by 87 base64url characters');
  }
  const raw = b64url.decode(body); // strict: one spelling per key
  if (raw.length !== RAW_PUBLIC_KEY_BYTES || raw[0] !== 0x04) {
    throw new TypeError('public key must be a 65-byte uncompressed P-256 point');
  }
  return raw;
}

/** Synchronous shape check of a tagged P-256 key (does not prove the point is on the curve). */
export function isPublicKeyString(value) {
  if (typeof value !== 'string' || value.length !== PUBLIC_KEY_STRING_LENGTH) return false;
  try {
    publicKeyBytes(value);
    return true;
  } catch {
    return false;
  }
}

/** The tagged key string of a public CryptoKey ('p256:' + 87 base64url characters). */
export async function exportPublicKey(publicKey) {
  if (!isCryptoKey(publicKey) || publicKey.type !== 'public') {
    throw new TypeError('exportPublicKey expects a public CryptoKey');
  }
  return encodePublicKey(new Uint8Array(await subtle().exportKey('raw', publicKey)));
}

// Verifying a long chain re-imports the same few author keys thousands of times; cache the
// import promises (CryptoKeys are immutable, so sharing them is safe). Failed imports are evicted.
const KEY_CACHE_MAX = 256;
const keyCache = new Map();

export async function importPublicKey(pub) {
  const cached = keyCache.get(pub);
  if (cached) return cached;
  const raw = publicKeyBytes(pub);
  const pending = subtle().importKey('raw', raw, KEY_ALG, true, ['verify']);
  keyCache.set(pub, pending);
  if (keyCache.size > KEY_CACHE_MAX) keyCache.delete(keyCache.keys().next().value);
  try {
    return await pending;
  } catch (err) {
    keyCache.delete(pub);
    throw err;
  }
}

/** Returns the raw 64-byte r||s signature (IEEE P1363 layout, WebCrypto's ECDSA default). */
export async function sign(privateKey, data) {
  if (!isCryptoKey(privateKey) || privateKey.type !== 'private') {
    throw new TypeError('sign expects a private CryptoKey');
  }
  return new Uint8Array(await subtle().sign(SIGN_ALG, privateKey, toData(data)));
}

/**
 * verify(pub, data, sig) → boolean. `pub` is a tagged public key string (or an imported
 * CryptoKey), `sig` is the 64-byte raw signature as bytes or b64url. Never throws: any malformed
 * input, untagged or unsupported key, wrong length or WebCrypto error is simply `false`.
 */
export async function verify(pub, data, sig) {
  try {
    const key = isCryptoKey(pub) ? pub : await importPublicKey(pub);
    const sigBytes = typeof sig === 'string' ? b64url.decode(sig) : asBytes(sig);
    if (sigBytes.length !== SIGNATURE_BYTES) return false;
    return (await subtle().verify(SIGN_ALG, key, sigBytes, toData(data))) === true;
  } catch {
    return false;
  }
}

/** JWK with only the fields that matter ({ kty, crv, x, y, d }); rejects for non-extractable keys. */
export async function exportPrivateJwk(privateKey) {
  if (!isCryptoKey(privateKey) || privateKey.type !== 'private') {
    throw new TypeError('exportPrivateJwk expects a private CryptoKey');
  }
  const jwk = await subtle().exportKey('jwk', privateKey);
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d };
}

function checkJwk(jwk, { needPrivate }) {
  if (jwk === null || typeof jwk !== 'object' || jwk.kty !== 'EC' || jwk.crv !== 'P-256' ||
    typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new TypeError('expected a P-256 EC JWK with string x and y');
  }
  if (needPrivate && typeof jwk.d !== 'string') throw new TypeError('JWK has no private scalar d');
}

/** Imports a private JWK as a signing key; non-extractable unless asked. Extra JWK fields are ignored. */
export async function importPrivateJwk(jwk, { extractable = false } = {}) {
  checkJwk(jwk, { needPrivate: true });
  const clean = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d };
  return subtle().importKey('jwk', clean, KEY_ALG, Boolean(extractable), ['sign']);
}

/** Tagged public key derived from a (private or public) JWK by importing it without `d`. */
export async function publicFromPrivateJwk(jwk) {
  checkJwk(jwk, { needPrivate: false });
  const publicJwk = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
  const key = await subtle().importKey('jwk', publicJwk, KEY_ALG, true, ['verify']);
  return exportPublicKey(key);
}

/** First 8 lowercase hex characters of sha256(raw 65-byte public key); the tag is not hashed. */
export async function fingerprint(pub) {
  const raw = isCryptoKey(pub) ? publicKeyBytes(await exportPublicKey(pub)) : publicKeyBytes(pub);
  return hex.encode(await sha256(raw)).slice(0, 8);
}

/**
 * shortKey(pub) → 8 characters for display when a fingerprint (async) is not at hand: the first 8
 * characters of the base64url body (the tag is skipped). '' for anything that is not a string.
 */
export function shortKey(pub) {
  if (typeof pub !== 'string') return '';
  const alg = keyAlgorithm(pub);
  return (alg === null ? pub : pub.slice(alg.length + 1)).slice(0, 8);
}
