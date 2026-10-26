// src/idp/passkey.js: the identity origin's one passkey (R 2.2.4, 2.13; MF-08, MF-09; test U-ID-3).
//
//   One discoverable credential per person per identity origin: RP ID = this host, user.id 16 random bytes,
//   user.name and displayName a nickname the person chooses (default "felinar identity"),
//   userVerification 'required', PRF eval first = SHA-256("mw-idp-prf-v1") requested at create(). When create()
//   returns the PRF output it is used at once; otherwise one get() asks for it (MF-09: one platform prompt for a
//   returning person, at most two at enrolment). The caller's self-test reuses the same output.
//   K_unlock = HKDF(prf, info "mw-idp-wrap-v1") is computed by src/identity/wrap.js; this module only talks to
//   navigator.credentials. The PRF salt is fixed per identity origin and never leaves it.
//
//   capabilities(env) -> { webauthn, platform, prf }          prf: true | false | null (unknown before create)
//   create({ nickname, env, salt }) -> { credId, prf | null, prfEnabled, uv }
//   get({ credId?, env, salt }) -> { credId, prf | null, uv }
//   prfFor({ credId, created, env }) -> the PRF output (a get() when create() gave none) or null
//
// salt: prfSalt() computed before the person's press (MF-09, code review v0.3 browser): WebKit lets WebAuthn run only
// inside the gesture, and a SubtleCrypto digest between the press and navigator.credentials can end it; with salt
// given, the credentials call is the first await after the press.
//
// env: { navigator, PublicKeyCredential, crypto, location } (defaults: the globals). Errors carry codes:
// E_UNSUPPORTED (no WebAuthn), E_USER_CANCELLED (NotAllowedError, the person closed the prompt), E_PASSKEY.

import { b64url, utf8 } from '../chain/canonical.js';

export const PRF_LABEL = 'mw-idp-prf-v1';
export const RP_NAME = 'felinar identity';
export const DEFAULT_NICKNAME = 'felinar identity';
export const TIMEOUT_MS = 120000;

const passkeyError = (code, message, cause) => Object.assign(new Error(message), { code, cause });

function envOf(env) {
  const e = env || {};
  return {
    nav: e.navigator || (typeof navigator !== 'undefined' ? navigator : null),
    PKC: e.PublicKeyCredential !== undefined ? e.PublicKeyCredential : (typeof PublicKeyCredential !== 'undefined' ? PublicKeyCredential : null),
    crypto: e.crypto || globalThis.crypto,
    rpId: e.rpId || (e.location ? e.location.hostname : (typeof location !== 'undefined' ? location.hostname : null)),
  };
}

/** prfSalt(cryptoApi) -> SHA-256("mw-idp-prf-v1") (32 bytes). */
export async function prfSalt(cryptoApi = globalThis.crypto) {
  return new Uint8Array(await cryptoApi.subtle.digest('SHA-256', utf8.encode(PRF_LABEL)));
}

/**
 * capabilities(env) -> { webauthn, platform, prf }. getClientCapabilities() where it exists (Chrome 133,
 * Safari 17.4, Firefox 135); otherwise prf is null and only create() tells (R 2.13).
 */
export async function capabilities(env) {
  const { nav, PKC } = envOf(env);
  const webauthn = Boolean(PKC && nav && nav.credentials && typeof nav.credentials.create === 'function');
  if (!webauthn) return { webauthn: false, platform: false, prf: false };
  let platform = null;
  try {
    if (typeof PKC.isUserVerifyingPlatformAuthenticatorAvailable === 'function') platform = await PKC.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch (_) {
    platform = null;
  }
  let prf = null;
  try {
    if (typeof PKC.getClientCapabilities === 'function') {
      const caps = await PKC.getClientCapabilities();
      if (caps && typeof caps['extension:prf'] === 'boolean') prf = caps['extension:prf'];
    }
  } catch (_) {
    prf = null;
  }
  return { webauthn, platform, prf };
}

function toBytes(x) {
  if (!x) return null;
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  return null;
}

/** uvFlag(authenticatorData) -> true | false | null: bit 2 of the flags byte (offset 32). */
export function uvFlag(authData) {
  const b = toBytes(authData);
  if (!b || b.length < 33) return null;
  return (b[32] & 0x04) !== 0;
}

function mapError(err) {
  const name = err && err.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return passkeyError('E_USER_CANCELLED', 'the passkey prompt was closed', err);
  if (name === 'NotSupportedError' || name === 'SecurityError') return passkeyError('E_UNSUPPORTED', 'passkeys are not available here: ' + (err && err.message), err);
  if (name === 'InvalidStateError') return passkeyError('E_PASSKEY', 'this device already has a passkey for this identity page', err);
  return passkeyError('E_PASSKEY', 'the passkey did not work: ' + ((err && err.message) || String(err)), err);
}

function prfResult(cred) {
  let ext = null;
  try {
    ext = typeof cred.getClientExtensionResults === 'function' ? cred.getClientExtensionResults() : null;
  } catch (_) {
    ext = null;
  }
  const prf = ext && ext.prf ? ext.prf : null;
  const enabled = prf && typeof prf.enabled === 'boolean' ? prf.enabled : null;
  const first = prf && prf.results ? toBytes(prf.results.first) : null;
  return { enabled, first: first && first.length >= 16 ? new Uint8Array(first) : null };
}

/**
 * create({ nickname, env, timeoutMs }) -> { credId, prf, prfEnabled, uv }
 * prf: the PRF output when create() returned it (Uint8Array), else null; prfEnabled: what the browser said
 * (true, false, or null when it said nothing).
 */
export async function create({ nickname = DEFAULT_NICKNAME, env, timeoutMs = TIMEOUT_MS, salt = null } = {}) {
  const { nav, PKC, crypto, rpId } = envOf(env);
  if (!PKC || !nav || !nav.credentials || typeof nav.credentials.create !== 'function') throw passkeyError('E_UNSUPPORTED', 'this browser has no passkeys');
  if (!rpId) throw passkeyError('E_UNSUPPORTED', 'no RP ID');
  const name = String(nickname || DEFAULT_NICKNAME).normalize('NFC').slice(0, 64) || DEFAULT_NICKNAME;
  const publicKey = {
    rp: { id: rpId, name: RP_NAME },
    user: { id: crypto.getRandomValues(new Uint8Array(16)), name, displayName: name },
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    attestation: 'none',
    timeout: timeoutMs,
    extensions: { prf: { eval: { first: salt instanceof Uint8Array ? salt : await prfSalt(crypto) } } },
  };
  let cred;
  try {
    cred = await nav.credentials.create({ publicKey });
  } catch (err) {
    throw mapError(err);
  }
  if (!cred || !cred.rawId) throw passkeyError('E_PASSKEY', 'no credential was made');
  const { enabled, first } = prfResult(cred);
  let uv = null;
  try {
    if (cred.response && typeof cred.response.getAuthenticatorData === 'function') uv = uvFlag(cred.response.getAuthenticatorData());
  } catch (_) {
    uv = null;
  }
  return { credId: b64url.encode(toBytes(cred.rawId)), prf: first, prfEnabled: enabled, uv };
}

/**
 * get({ credId, env, timeoutMs }) -> { credId, prf, uv }. Without credId the browser offers its discoverable
 * credentials for this RP ID (the IdO lost its storage but the person still has the passkey).
 */
export async function get({ credId, env, timeoutMs = TIMEOUT_MS, salt = null } = {}) {
  const { nav, PKC, crypto, rpId } = envOf(env);
  if (!PKC || !nav || !nav.credentials || typeof nav.credentials.get !== 'function') throw passkeyError('E_UNSUPPORTED', 'this browser has no passkeys');
  const publicKey = {
    rpId,
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    userVerification: 'required',
    timeout: timeoutMs,
    extensions: { prf: { eval: { first: salt instanceof Uint8Array ? salt : await prfSalt(crypto) } } },
  };
  if (typeof credId === 'string' && credId) publicKey.allowCredentials = [{ type: 'public-key', id: b64url.decode(credId) }];
  let cred;
  try {
    cred = await nav.credentials.get({ publicKey });
  } catch (err) {
    throw mapError(err);
  }
  if (!cred || !cred.rawId) throw passkeyError('E_PASSKEY', 'no credential answered');
  const { first } = prfResult(cred);
  const uv = cred.response ? uvFlag(cred.response.authenticatorData) : null;
  return { credId: b64url.encode(toBytes(cred.rawId)), prf: first, uv };
}

/**
 * prfFor({ created, env }) -> { prf, uv, credId } after create(): the create() output when it carried PRF,
 * otherwise exactly one get() for the new credential when the browser reported PRF as enabled (MF-09). prf null
 * means this passkey cannot unlock
 * here (the caller falls back to a passphrase and shows the clean-up sentence).
 */
export async function prfFor({ created, env, timeoutMs } = {}) {
  if (!created) throw new TypeError('prfFor needs the create() result');
  if (created.prf) return { prf: created.prf, uv: created.uv !== false, credId: created.credId };
  // Only a browser that said PRF is enabled gets the second prompt; silence means the extension is unknown there.
  if (created.prfEnabled !== true) return { prf: null, uv: created.uv !== false, credId: created.credId };
  const got = await get({ credId: created.credId, env, timeoutMs });
  return { prf: got.prf, uv: got.uv !== false, credId: created.credId };
}
