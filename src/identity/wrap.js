// Wrapping of the identity secrets at the identity origin (R 2.2.4, 2.2.5; MF-17).
//
//   blob = { v: 2, kind: 'prf' | 'pass', credId?, salt?, kdf?, iv, ct }   (b64url byte fields)
//   prf:  K_unlock = HKDF(prfOutput, salt = "", info = "mw-idp-wrap-v1", L = 32)
//   pass: K_unlock = Argon2id(pass, salt, m, t, p) or PBKDF2-SHA-256(pass, salt, iter), 32 bytes
//         kdf = { name: 'argon2id', m, t, p } or { name: 'pbkdf2-sha256', iter }
//   ct = AES-256-GCM(K_unlock, iv = 12 random bytes, AAD = "mw-idp-wrap-v1\n" + JCS(header))
//   header = the blob without iv and ct
//
// The header is bound as AAD, so a blob whose kind, credId, salt or kdf was swapped fails to open,
// and a forged or foreign blob fails AEAD (escrow copies held by site origins, R 2.2.5). A wrong
// passphrase or PRF output fails closed with E_UNWRAP; there is no silent KDF downgrade: the KDF
// is named in the header and the caller shows it. Pure: Node >= 22 and browsers.

import { argon2idAsync, ARGON2ID_DEFAULTS } from './argon2.js';
import { hkdf } from './derive.js';
import { b64url, utf8, canonicalize } from '../chain/canonical.js';

export const WRAP_INFO = 'mw-idp-wrap-v1';
export const PBKDF2_ITERATIONS = 600000;
export const BLOB_VERSION = 2;

// Bounds accepted when opening a blob (a header is attacker-controlled before the AEAD check).
const LIMITS = { argon2: { mMin: 8, mMax: 1048576, tMax: 16, pMax: 8 }, pbkdf2: { min: 1000, max: 10000000 } };

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error('WebCrypto (crypto.subtle) is unavailable');
  return c.subtle;
}

const unwrapError = () => Object.assign(new Error('the identity could not be unlocked'), { code: 'E_UNWRAP' });

function aad(header) {
  return utf8.encode(WRAP_INFO + '\n' + canonicalize(header));
}

function asSecret(secrets) {
  if (!(secrets instanceof Uint8Array) || secrets.length === 0 || secrets.length > 4096) {
    throw new TypeError('secrets must be 1 to 4096 bytes');
  }
  return secrets;
}

/** packSecrets({ rootStar, kVault }) -> Uint8Array(64); unpackSecrets reverses it. */
export function packSecrets({ rootStar, kVault }) {
  if (!(rootStar instanceof Uint8Array) || rootStar.length !== 32) throw new TypeError('rootStar must be 32 bytes');
  if (!(kVault instanceof Uint8Array) || kVault.length !== 32) throw new TypeError('kVault must be 32 bytes');
  const out = new Uint8Array(64);
  out.set(rootStar, 0);
  out.set(kVault, 32);
  return out;
}

export function unpackSecrets(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 64) throw unwrapError();
  return { rootStar: bytes.slice(0, 32), kVault: bytes.slice(32, 64) };
}

async function aesKey(raw) {
  return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function seal(rawKey, header, secrets) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(rawKey);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad(header) }, key, secrets));
  return Object.assign({}, header, { iv: b64url.encode(iv), ct: b64url.encode(ct) });
}

async function open(rawKey, blob) {
  const header = headerOf(blob);
  try {
    const key = await aesKey(rawKey);
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: b64url.decode(blob.iv), additionalData: aad(header) }, key, b64url.decode(blob.ct));
    return new Uint8Array(pt);
  } catch (_) {
    throw unwrapError();
  }
}

function headerOf(blob) {
  if (!blob || typeof blob !== 'object' || blob.v !== BLOB_VERSION) throw unwrapError();
  if (typeof blob.iv !== 'string' || typeof blob.ct !== 'string') throw unwrapError();
  const allowed = new Set(['v', 'kind', 'credId', 'salt', 'kdf', 'iv', 'ct']);
  for (const k of Object.keys(blob)) if (!allowed.has(k)) throw unwrapError();
  const header = {};
  for (const k of Object.keys(blob)) if (k !== 'iv' && k !== 'ct') header[k] = blob[k];
  return header;
}

/** prfKey(prfOutput) -> Uint8Array(32) = HKDF(prf, info "mw-idp-wrap-v1"). */
export async function prfKey(prfOutput) {
  const prf = prfOutput instanceof ArrayBuffer ? new Uint8Array(prfOutput) : prfOutput;
  if (!(prf instanceof Uint8Array) || prf.length < 16) throw new TypeError('PRF output must be at least 16 bytes');
  return hkdf(prf, new Uint8Array(0), WRAP_INFO, 32);
}

/** wrapWithPrf(prfOutput, secrets, { credId? }) -> blob { v: 2, kind: 'prf', credId?, iv, ct }. */
export async function wrapWithPrf(prfOutput, secrets, { credId } = {}) {
  const header = { v: BLOB_VERSION, kind: 'prf' };
  if (credId !== undefined) {
    if (typeof credId !== 'string' || !/^[A-Za-z0-9_-]{1,1400}$/.test(credId)) throw new TypeError('credId must be base64url');
    header.credId = credId;
  }
  return seal(await prfKey(prfOutput), header, asSecret(secrets));
}

/** unwrapWithPrf(prfOutput, blob) -> secrets bytes; E_UNWRAP on any failure. */
export async function unwrapWithPrf(prfOutput, blob) {
  if (!blob || blob.kind !== 'prf') throw unwrapError();
  return open(await prfKey(prfOutput), blob);
}

function normalizePass(pass) {
  if (typeof pass !== 'string' || pass.length === 0) throw new TypeError('passphrase must be a non-empty string');
  return utf8.encode(pass.normalize('NFC'));
}

function kdfSpec(kdf, params) {
  if (kdf === 'argon2id') {
    const p = Object.assign({}, ARGON2ID_DEFAULTS, params || {});
    return { name: 'argon2id', m: p.m, t: p.t, p: p.p };
  }
  if (kdf === 'pbkdf2') {
    const iter = params && params.iter !== undefined ? params.iter : PBKDF2_ITERATIONS;
    return { name: 'pbkdf2-sha256', iter };
  }
  throw new TypeError("kdf must be 'argon2id' or 'pbkdf2'");
}

/**
 * passphraseKey(pass, salt, kdf, { onProgress }) -> Uint8Array(32) for a kdf header object. Shared with the
 * backup file (vault.js). Throws E_UNWRAP for a header outside the accepted bounds. Argon2id runs in slices that
 * yield to the event loop (argon2idAsync), so the identity page paints and responds while it works.
 */
export async function passphraseKey(pass, salt, kdf, { onProgress = null } = {}) {
  const pw = normalizePass(pass);
  if (!(salt instanceof Uint8Array) || salt.length < 16) throw unwrapError();
  if (kdf && kdf.name === 'argon2id') {
    const L = LIMITS.argon2;
    const ok = [kdf.m, kdf.t, kdf.p].every(Number.isInteger) && kdf.m >= L.mMin && kdf.m <= L.mMax &&
      kdf.t >= 1 && kdf.t <= L.tMax && kdf.p >= 1 && kdf.p <= L.pMax && kdf.m >= 8 * kdf.p;
    if (!ok) throw unwrapError();
    return argon2idAsync({ password: pw, salt, m: kdf.m, t: kdf.t, p: kdf.p, tagLength: 32 }, { onProgress });
  }
  if (kdf && kdf.name === 'pbkdf2-sha256') {
    if (!Number.isInteger(kdf.iter) || kdf.iter < LIMITS.pbkdf2.min || kdf.iter > LIMITS.pbkdf2.max) throw unwrapError();
    const base = await subtle().importKey('raw', pw, 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await subtle().deriveBits({ name: 'PBKDF2', salt, iterations: kdf.iter, hash: 'SHA-256' }, base, 256));
  }
  throw unwrapError();
}

/**
 * wrapWithPassphrase(pass, secrets, { kdf: 'argon2id' | 'pbkdf2', params? })
 *   -> blob { v: 2, kind: 'pass', salt, kdf, iv, ct }
 * Defaults: Argon2id m = 65536 KiB, t = 3, p = 1; PBKDF2-SHA-256 600,000 iterations. The caller
 * picks 'pbkdf2' only where Argon2id cannot run and says so on the card (MF-17).
 */
export async function wrapWithPassphrase(pass, secrets, { kdf = 'argon2id', params, onProgress = null } = {}) {
  const spec = kdfSpec(kdf, params);
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const key = await passphraseKey(pass, salt, spec, { onProgress });
  return seal(key, { v: BLOB_VERSION, kind: 'pass', salt: b64url.encode(salt), kdf: spec }, asSecret(secrets));
}

/** unwrapWithPassphrase(pass, blob, { onProgress }) -> secrets bytes; a wrong passphrase gives E_UNWRAP. */
export async function unwrapWithPassphrase(pass, blob, { onProgress = null } = {}) {
  if (!blob || blob.kind !== 'pass' || typeof blob.salt !== 'string') throw unwrapError();
  let salt;
  try {
    salt = b64url.decode(blob.salt);
  } catch (_) {
    throw unwrapError();
  }
  const key = await passphraseKey(pass, salt, blob.kdf, { onProgress });
  return open(key, blob);
}

/** describeKdf(blob) -> 'argon2id' | 'pbkdf2-sha256' | 'prf' | null: what the card names. */
export function describeKdf(blob) {
  if (!blob || typeof blob !== 'object') return null;
  if (blob.kind === 'prf') return 'prf';
  return blob.kdf && typeof blob.kdf.name === 'string' ? blob.kdf.name : null;
}
