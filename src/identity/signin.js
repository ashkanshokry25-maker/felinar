// mw-signin-v1 (R 2.3.2, docs/specs/mw-signin-v1.md) and local proofs (R 2.4.2): the shared
// builder and strict parser used by the identity origin, the loader and the tests.
// packages/verify/verify.js is the independent single-file verifier for servers; it does not
// import this module. Pure: Node >= 22 and browsers, WebCrypto only.
//
//   c = { v: 1, t: 'mw-signin', domain, origin, ledger, pub, keyMode, nonce, statement,
//         resources, iat, nbf, exp, requestId, idp, build }
//   proof = { c, alg: 'ES256-P1363', sig: b64url(ECDSA-P256-SHA-256(utf8("mw-signin-v1\n" + JCS(c)))) }
//
// domain, origin, ledger, pub, keyMode, iat, idp and build come from the identity origin (the
// caller of buildChallenge passes what the browser and its own state report), never from the page.

import { canonicalize, b64url, utf8, byteLength } from '../chain/canonical.js';
import { sign, verify, isPublicKeyString } from '../chain/crypto.js';

export const SIGNIN_PREFIX = 'mw-signin-v1\n';
export const LOCAL_PREFIX = 'mw-local-v1\n';
export const MAX_AGE_MS = 300000;
export const LOCAL_MAX_AGE_MS = 900000;
export const MAX_PROOF_BYTES = 4096;
export const MAX_STATEMENT_CHARS = 280;
export const MAX_RESOURCES = 4;
export const ALG = 'ES256-P1363';
export const KEY_MODES = Object.freeze(['pairwise', 'ledger', 'hub', 'linked']);
export const CHALLENGE_FIELDS = Object.freeze(['v', 't', 'domain', 'origin', 'ledger', 'pub', 'keyMode', 'nonce', 'statement', 'resources', 'iat', 'nbf', 'exp', 'requestId', 'idp', 'build']);
const LOCAL_FIELDS = Object.freeze(['v', 't', 'origin', 'pub', 'epoch', 'nonce', 'iat', 'exp']);

const signinError = (code, message) => Object.assign(new Error(message), { code });

// ---------------------------------------------------------------------------------------------
// Field rules
// ---------------------------------------------------------------------------------------------

/** b64urlBytes(s, min, max) -> true when s is canonical base64url of min..max bytes. */
export function b64urlBytes(s, min, max) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) return false;
  try {
    const n = b64url.decode(s).length;
    return n >= min && n <= max;
  } catch (_) {
    return false;
  }
}

/** serialOrigin(s) -> the serialised origin when s already is one (http or https), else null. */
export function serialOrigin(s) {
  if (typeof s !== 'string' || s.length > 300) return null;
  try {
    const u = new URL(s);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.origin !== s) return null;
    return u.origin;
  } catch (_) {
    return null;
  }
}

/** domainOf(origin) -> host of the origin, lowercase, with the port when it is not the default. */
export function domainOf(origin) {
  return new URL(origin).host;
}

/**
 * statementProblem(s) -> null when s is a valid statement, else a short reason: not a string,
 * longer than 280 characters (code points), not NFC, a lone surrogate, a control character
 * (C0, DEL, C1, U+2028, U+2029) or a bidi control (U+061C, U+200E, U+200F, U+202A..U+202E,
 * U+2066..U+2069).
 */
export function statementProblem(s) {
  if (typeof s !== 'string') return 'type';
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d < 0xdc00 || d > 0xdfff) return 'surrogate';
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return 'surrogate';
    } else if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) {
      return 'control';
    } else if (c === 0x061c || c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) {
      return 'bidi';
    }
    count++;
  }
  if (count > MAX_STATEMENT_CHARS) return 'length';
  if (s.normalize('NFC') !== s) return 'nfc';
  return null;
}

function resourcesOk(r) {
  if (!Array.isArray(r) || r.length > MAX_RESOURCES) return false;
  for (const x of r) {
    if (typeof x !== 'string' || x.length > 1024 || !x.startsWith('https://')) return false;
    try {
      new URL(x); // eslint-disable-line no-new
    } catch (_) {
      return false;
    }
  }
  return true;
}

const uint = (n) => Number.isSafeInteger(n) && n >= 0;

// ---------------------------------------------------------------------------------------------
// Strict JSON (duplicate keys refused)
// ---------------------------------------------------------------------------------------------

/** strictJsonParse(text) -> value; SyntaxError on bad JSON, a duplicate key or depth over 16. */
export function strictJsonParse(text) {
  let i = 0;
  const fail = (m) => { throw new SyntaxError('JSON: ' + m + ' at ' + i); };
  const ws = () => { while (i < text.length && ' \t\n\r'.indexOf(text[i]) >= 0) i++; };
  const value = (depth) => {
    if (depth > 16) fail('too deep');
    ws();
    const ch = text[i];
    if (ch === '{') {
      i++;
      const obj = {};
      const seen = new Set();
      ws();
      if (text[i] === '}') { i++; return obj; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail('key expected');
        const k = str();
        if (seen.has(k)) fail('duplicate key ' + JSON.stringify(k));
        seen.add(k);
        ws();
        if (text[i] !== ':') fail('colon expected');
        i++;
        const v = value(depth + 1);
        Object.defineProperty(obj, k, { value: v, enumerable: true, writable: true, configurable: true });
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return obj; }
        fail('comma expected');
      }
    }
    if (ch === '[') {
      i++;
      const arr = [];
      ws();
      if (text[i] === ']') { i++; return arr; }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return arr; }
        fail('comma expected');
      }
    }
    if (ch === '"') return str();
    const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i, i + 40));
    if (m && m[0].length > 0) { i += m[0].length; return Number(m[0]); }
    for (const [lit, v] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(lit, i)) { i += lit.length; return v; }
    }
    return fail('value expected');
  };
  const str = () => {
    i++;
    let out = '';
    for (;;) {
      if (i >= text.length) fail('unterminated string');
      const c = text.charCodeAt(i);
      if (c === 0x22) { i++; return out; }
      if (c < 0x20) fail('control character in string');
      if (c === 0x5c) {
        const e = text[i + 1];
        const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (e === 'u') {
          const h = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(h)) fail('bad escape');
          out += String.fromCharCode(parseInt(h, 16));
          i += 6;
        } else if (map[e] !== undefined) {
          out += map[e];
          i += 2;
        } else {
          fail('bad escape');
        }
      } else {
        out += text[i];
        i++;
      }
    }
  };
  if (typeof text !== 'string') throw new TypeError('strictJsonParse expects a string');
  const v = value(0);
  ws();
  if (i !== text.length) fail('trailing data');
  return v;
}

// ---------------------------------------------------------------------------------------------
// Builder and signer
// ---------------------------------------------------------------------------------------------

function randomB64(n) {
  return b64url.encode(globalThis.crypto.getRandomValues(new Uint8Array(n)));
}

/**
 * buildChallenge({ origin, ledger, pub, keyMode, purpose, challenge, now, requestId, idp, build })
 *   -> c (the object the identity origin signs)
 * origin: event.origin of the verified opener; ledger: the ledgerId for keyMode 'ledger', else
 * null; challenge: the page's { nonce, statement, exp?, nbf?, resources? } (verifier-issued for
 * purpose 'server'; for purpose 'site' its nonce is ignored and the identity origin draws one).
 * Throws E_NONCE_REQUIRED (server purpose without a nonce), E_STATEMENT,
 * E_CHALLENGE (bad field or an exp/nbf window that is already over) or TypeError.
 */
export function buildChallenge({ origin, ledger = null, pub, keyMode, purpose = 'site', challenge = null, now = Date.now(), requestId, idp, build }) {
  const o = serialOrigin(origin);
  if (!o) throw new TypeError('origin must be a serialised http or https origin');
  if (!isPublicKeyString(pub)) throw new TypeError('pub must be a p256: key');
  if (KEY_MODES.indexOf(keyMode) < 0) throw new TypeError('keyMode must be one of ' + KEY_MODES.join(', '));
  if (keyMode === 'ledger' ? typeof ledger !== 'string' || !ledger || ledger.length > 64 : ledger !== null) {
    throw new TypeError("ledger is set exactly when keyMode is 'ledger'");
  }
  if (purpose !== 'site' && purpose !== 'server') throw new TypeError("purpose must be 'site' or 'server'");
  if (!b64urlBytes(requestId, 16, 32)) throw signinError('E_CHALLENGE', 'requestId must be 16 to 32 bytes base64url');
  const idpOrigin = serialOrigin(idp);
  if (!idpOrigin) throw new TypeError('idp must be a serialised origin');
  if (typeof build !== 'string' || !/^[\x21-\x7e]{1,64}$/.test(build)) throw new TypeError('build must be 1 to 64 printable ASCII characters');
  if (!uint(now)) throw new TypeError('now must be a ms timestamp');
  const ch = challenge || {};
  if (purpose === 'server' && (typeof ch.nonce !== 'string' || !ch.nonce)) throw signinError('E_NONCE_REQUIRED', 'a server sign-in needs a nonce issued by the verifier');
  // purpose 'site': the nonce is always the identity origin's own, never one the page passed (code review v0.3,
  // security 7), so a site proof can never pass a server's verifier, whatever the page sent.
  const nonce = purpose === 'server' ? ch.nonce : randomB64(16);
  if (!b64urlBytes(nonce, 16, 64)) throw signinError('E_CHALLENGE', 'nonce must be 16 to 64 bytes base64url');
  const statement = ch.statement === undefined ? '' : ch.statement;
  const problem = statementProblem(statement);
  if (problem) throw Object.assign(signinError('E_STATEMENT', 'statement refused: ' + problem), { problem });
  const resources = ch.resources === undefined ? [] : ch.resources;
  if (!resourcesOk(resources)) throw signinError('E_CHALLENGE', 'resources: at most 4 https URLs');
  if (ch.exp !== undefined && !uint(ch.exp)) throw signinError('E_CHALLENGE', 'exp must be a ms timestamp');
  if (ch.nbf !== undefined && !uint(ch.nbf)) throw signinError('E_CHALLENGE', 'nbf must be a ms timestamp');
  const iat = now;
  const exp = Math.min(ch.exp !== undefined ? ch.exp : Infinity, iat + MAX_AGE_MS);
  const nbf = ch.nbf !== undefined ? ch.nbf : iat;
  if (exp <= iat) throw signinError('E_CHALLENGE', 'the challenge has expired');
  if (nbf >= exp) throw signinError('E_CHALLENGE', 'nbf is not before exp');
  return {
    v: 1, t: 'mw-signin', domain: domainOf(o), origin: o, ledger, pub, keyMode, nonce, statement,
    resources: resources.slice(), iat, nbf, exp, requestId, idp: idpOrigin, build,
  };
}

/** signingInput(c) -> "mw-signin-v1\n" + JCS(c). */
export function signingInput(c) {
  return SIGNIN_PREFIX + canonicalize(c);
}

/** signChallenge(c, signKey) -> { c, alg: 'ES256-P1363', sig }; signKey is a private ECDSA CryptoKey. */
export async function signChallenge(c, signKey) {
  const sig = await sign(signKey, utf8.encode(signingInput(c)));
  return { c, alg: ALG, sig: b64url.encode(sig) };
}

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

function exactKeys(obj, keys) {
  const own = Object.keys(obj);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

const bad = (reason) => ({ ok: false, reason });

/**
 * parseProof(input) -> { ok: true, proof } | { ok: false, reason }
 * input: the proof as JSON text (preferred: duplicate keys can only be seen in text) or an object.
 * Reasons: 'parse' (over 4 KiB, bad JSON, a duplicate key, a missing or unknown field, a wrong
 * type), 'version', 'alg', 'sig' (not 64 raw bytes, DER included), 'statement'. The returned
 * proof is a fresh copy holding only the known fields.
 */
export function parseProof(input) {
  let obj;
  if (typeof input === 'string') {
    if (byteLength(input) > MAX_PROOF_BYTES) return bad('parse');
    try {
      obj = strictJsonParse(input);
    } catch (_) {
      return bad('parse');
    }
  } else {
    try {
      if (byteLength(canonicalize(input)) > MAX_PROOF_BYTES) return bad('parse');
    } catch (_) {
      return bad('parse');
    }
    obj = input;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !exactKeys(obj, ['c', 'alg', 'sig'])) return bad('parse');
  const c = obj.c;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return bad('parse');
  if (c.v !== 1 || c.t !== 'mw-signin') return bad('version');
  if (!exactKeys(c, CHALLENGE_FIELDS)) return bad('parse');
  if (obj.alg !== ALG) return bad('alg');
  if (!b64urlBytes(obj.sig, 64, 64)) return bad('sig');
  if (typeof c.domain !== 'string' || c.domain.length > 300 || !serialOrigin(c.origin)) return bad('parse');
  if (c.ledger !== null && (typeof c.ledger !== 'string' || !c.ledger || c.ledger.length > 64)) return bad('parse');
  if (!isPublicKeyString(c.pub) || KEY_MODES.indexOf(c.keyMode) < 0) return bad('parse');
  if (!b64urlBytes(c.nonce, 16, 64) || !b64urlBytes(c.requestId, 16, 32)) return bad('parse');
  if (statementProblem(c.statement)) return bad('statement');
  if (!resourcesOk(c.resources)) return bad('parse');
  if (!uint(c.iat) || !uint(c.nbf) || !uint(c.exp)) return bad('parse');
  if (!serialOrigin(c.idp) || typeof c.build !== 'string' || !/^[\x21-\x7e]{1,64}$/.test(c.build)) return bad('parse');
  const copy = {};
  for (const k of CHALLENGE_FIELDS) copy[k] = k === 'resources' ? c.resources.slice() : c[k];
  return { ok: true, proof: { c: copy, alg: ALG, sig: obj.sig } };
}

/** verifySignature(proof) -> Promise<boolean>: the ES256 signature over signingInput(proof.c). */
export async function verifySignature(proof) {
  return verify(proof.c.pub, utf8.encode(signingInput(proof.c)), proof.sig);
}

// ---------------------------------------------------------------------------------------------
// Local proofs (R 2.4.2): in-tab, at most 15 minutes, tied to a revocation epoch
// ---------------------------------------------------------------------------------------------

/**
 * makeLocalProof({ signKey, pub, origin, epoch, now, ttlMs = 900000 })
 *   -> { c: { v: 1, t: 'mw-local', origin, pub, epoch, nonce, iat, exp }, alg, sig }
 * signed over "mw-local-v1\n" + JCS(c). Keep it in memory only (never in storage).
 */
export async function makeLocalProof({ signKey, pub, origin, epoch, now = Date.now(), ttlMs = LOCAL_MAX_AGE_MS }) {
  const o = serialOrigin(origin);
  if (!o) throw new TypeError('origin must be a serialised origin');
  if (!isPublicKeyString(pub)) throw new TypeError('pub must be a p256: key');
  if (!uint(epoch)) throw new TypeError('epoch must be a non-negative integer');
  if (!uint(ttlMs) || ttlMs < 1 || ttlMs > LOCAL_MAX_AGE_MS) throw new RangeError('ttlMs must be 1..900000');
  const c = { v: 1, t: 'mw-local', origin: o, pub, epoch, nonce: randomB64(16), iat: now, exp: now + ttlMs };
  const sig = await sign(signKey, utf8.encode(LOCAL_PREFIX + canonicalize(c)));
  return { c, alg: ALG, sig: b64url.encode(sig) };
}

/**
 * verifyLocalProof(proof, { origin, epoch, now, skewMs = 5000 }) -> { ok: true, pub } | { ok: false, reason }
 * Reasons: 'parse', 'version', 'origin', 'revoked' (made before the current epoch: the person
 * signed out since), 'epoch', 'too-long', 'not-yet-valid', 'expired', 'sig'.
 */
export async function verifyLocalProof(proof, { origin, epoch, now = Date.now(), skewMs = 5000 } = {}) {
  if (!proof || typeof proof !== 'object' || !exactKeys(proof, ['c', 'alg', 'sig'])) return bad('parse');
  const c = proof.c;
  if (!c || typeof c !== 'object' || c.v !== 1 || c.t !== 'mw-local') return bad('version');
  if (!exactKeys(c, LOCAL_FIELDS) || proof.alg !== ALG || !b64urlBytes(proof.sig, 64, 64)) return bad('parse');
  if (!isPublicKeyString(c.pub) || !uint(c.epoch) || !uint(c.iat) || !uint(c.exp) || !b64urlBytes(c.nonce, 16, 16)) return bad('parse');
  if (c.origin !== origin) return bad('origin');
  if (c.epoch < epoch) return bad('revoked');
  if (c.epoch !== epoch) return bad('epoch');
  if (c.exp - c.iat > LOCAL_MAX_AGE_MS || c.exp <= c.iat) return bad('too-long');
  if (c.iat > now + skewMs) return bad('not-yet-valid');
  if (c.exp <= now) return bad('expired');
  const ok = await verify(c.pub, utf8.encode(LOCAL_PREFIX + canonicalize(c)), proof.sig);
  return ok ? { ok: true, pub: c.pub } : bad('sig');
}
