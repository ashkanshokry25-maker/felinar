// Identity derivation (R 2.2.1 to 2.2.3, ARCHITECTURE 15.1): the 12-word phrase, root*, the
// per-label seeds and keys, the check code, and the label choice. Runs at the identity origin
// only; no site origin ever calls it with a root. Pure: Node >= 22 and browsers, WebCrypto only.
//
//   root (16 bytes) <-> 12 BIP-39 English words (encoding only; 4-bit checksum)
//   root*  = HKDF-SHA-256(ikm = root [|| Argon2id(extra)], salt = "mw/id/v2", info = "", L = 32)
//   labelSeed(label)  = HKDF(root*, salt = "mw/id/v2", info = "seed|" + label, L = 32)
//   signScalar(seed, i) = scalar(HKDF(seed, salt = "", info = "sign|" + i, L = 48))
//   recoverScalar(root*, label) = scalar(HKDF(root*, salt = "", info = "recover|" + label, L = 48))
//   K_name(seed) = HKDF(seed, salt = "", info = "name|1", L = 32)
//   K_vaultHash(root*) = HKDF(root*, salt = "", info = "vault-id|2", L = 32)
//   checkCode(root*) = base32(SHA-256("mw-check-v1" || root*))[:8]
//   scalar(x) = (x mod (n - 1)) + 1 over the 48-byte big-endian x
//
// An empty HKDF salt is the RFC 5869 default (HashLen zero bytes); the salt "mw/id/v2" is used
// where R 2.2.1 and 2.2.2 name it. Labels: 'o|' + origin, 'l|' + ledgerId, 'h|' + hub suffix.

import { BIP39_ENGLISH, wordIndex } from './bip39-english.js';
import { publicFromScalar, bytesToBigInt, bigIntToBytes, N } from './p256.js';
import { argon2idAsync, ARGON2ID_DEFAULTS } from './argon2.js';
import { sha256Sync } from '../chain/sha256-sync.js';
import { b64url, utf8, concatBytes } from '../chain/canonical.js';
import { encode as base32 } from '../common/base32.js';

export const ID_SALT = 'mw/id/v2';
export const EXTRA_SALT_PREFIX = 'mw/extra/v1';
export const CHECK_PREFIX = 'mw-check-v1';
export const ROOT_BYTES = 16;
export const PHRASE_WORDS = 12;
export const KEY_MODES = Object.freeze(['pairwise', 'ledger', 'hub', 'linked']);
/** Most origins a pointer's org= list may name for the ledger label (R 2.2.3). */
export const MAX_ORG_ORIGINS = 4;

function idError(code, message) {
  return Object.assign(new Error(message), { code });
}

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error('WebCrypto (crypto.subtle) is unavailable');
  return c.subtle;
}

function bytes(x, name, len) {
  if (!(x instanceof Uint8Array)) throw new TypeError(name + ' must be a Uint8Array');
  if (len !== undefined && x.length !== len) throw new TypeError(name + ' must be ' + len + ' bytes');
  return x;
}

/** hkdf(ikm, salt, info, length) -> Uint8Array(length); salt and info are strings or bytes. */
export async function hkdf(ikm, salt, info, length) {
  const s = typeof salt === 'string' ? utf8.encode(salt) : salt;
  const i = typeof info === 'string' ? utf8.encode(info) : info;
  const key = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info: i }, key, length * 8);
  return new Uint8Array(bits);
}

// ---------------------------------------------------------------------------------------------
// Phrase
// ---------------------------------------------------------------------------------------------

function normalizeWords(words) {
  const list = typeof words === 'string' ? words.normalize('NFKD').trim().toLowerCase().split(/\s+/) :
    Array.isArray(words) ? words.map((w) => String(w).normalize('NFKD').trim().toLowerCase()) : null;
  if (!list) throw new TypeError('phraseToRoot expects a string or an array of words');
  // Review round UX-4: the kit shows the words as a numbered list, so "1. abandon 2, ability;" is read as the words alone
  // (list numbers, and the dots, commas and brackets around a word, are dropped; no BIP-39 word holds a digit or a mark).
  return list
    .map((w) => w.replace(/^\(?\d+[.):]?\)?/, '').replace(/^[.,;:()"'-]+|[.,;:()"'-]+$/g, ''))
    .filter((w) => w.length > 0);
}

/**
 * phraseToRoot(words) -> Uint8Array(16). words: a string or an array of 12 BIP-39 English words.
 * Throws E_PHRASE_LENGTH, E_PHRASE_WORD (with .index) or E_PHRASE_CHECKSUM.
 */
export function phraseToRoot(words) {
  const list = normalizeWords(words);
  if (list.length !== PHRASE_WORDS) throw idError('E_PHRASE_LENGTH', 'a recovery phrase has 12 words');
  let acc = 0n;
  for (let i = 0; i < list.length; i++) {
    const v = wordIndex(list[i]);
    if (v < 0) throw Object.assign(idError('E_PHRASE_WORD', 'word ' + (i + 1) + ' is not in the word list'), { index: i });
    acc = (acc << 11n) | BigInt(v);
  }
  const checksum = Number(acc & 0xfn);
  const root = bigIntToBytes(acc >> 4n, ROOT_BYTES);
  if ((sha256Sync(root)[0] >> 4) !== checksum) throw idError('E_PHRASE_CHECKSUM', 'these words do not form a valid phrase');
  return root;
}

/** rootToPhrase(root) -> string[12]. */
export function rootToPhrase(root) {
  bytes(root, 'root', ROOT_BYTES);
  let acc = (bytesToBigInt(root) << 4n) | BigInt(sha256Sync(root)[0] >> 4);
  const out = new Array(PHRASE_WORDS);
  for (let i = PHRASE_WORDS - 1; i >= 0; i--) {
    out[i] = BIP39_ENGLISH[Number(acc & 0x7ffn)];
    acc >>= 11n;
  }
  return out;
}

/** newRoot() -> 16 bytes from the CSPRNG. */
export function newRoot() {
  return globalThis.crypto.getRandomValues(new Uint8Array(ROOT_BYTES));
}

// ---------------------------------------------------------------------------------------------
// root* and the derivation tree
// ---------------------------------------------------------------------------------------------

/** extraSalt(root) = SHA-256("mw/extra/v1" || root). */
export function extraSalt(root) {
  return sha256Sync(concatBytes(utf8.encode(EXTRA_SALT_PREFIX), root));
}

/**
 * rootStar(root, extra?, { argon2 }) -> Uint8Array(32). extra (the optional extra word) is
 * NFKD-normalised and run through Argon2id m = 64 MiB, t = 3, p = 1 with salt extraSalt(root);
 * an empty or absent extra means no extra word. argon2 overrides the parameters (tests only).
 */
export async function rootStar(root, extra, { argon2 = ARGON2ID_DEFAULTS } = {}) {
  bytes(root, 'root', ROOT_BYTES);
  let ikm = root;
  if (typeof extra === 'string' && extra.length > 0) {
    const stretched = await argon2idAsync({ password: utf8.encode(extra.normalize('NFKD')), salt: extraSalt(root), m: argon2.m, t: argon2.t, p: argon2.p, tagLength: 32 });
    ikm = concatBytes(root, stretched);
  } else if (extra !== undefined && extra !== null && extra !== '') {
    throw new TypeError('extra must be a string');
  }
  return hkdf(ikm, ID_SALT, '', 32);
}

/** labelSeed(root*, label) -> Uint8Array(32); never leaves the identity origin. */
export async function labelSeed(rs, label) {
  bytes(rs, 'root*', 32);
  checkLabel(label);
  return hkdf(rs, ID_SALT, 'seed|' + label, 32);
}

/** scalar(x) -> Uint8Array(32): (x mod (n - 1)) + 1 for a 48-byte big-endian x; never 0 or n. */
export function scalar(x) {
  bytes(x, 'scalar input', 48);
  return bigIntToBytes((bytesToBigInt(x) % (N - 1n)) + 1n, 32);
}

/** signScalar(seed, i) -> Uint8Array(32), the P-256 signing scalar of rotation index i (from 1). */
export async function signScalar(seed, i) {
  bytes(seed, 'seed', 32);
  if (!Number.isSafeInteger(i) || i < 1) throw new RangeError('rotation index starts at 1');
  return scalar(await hkdf(seed, new Uint8Array(0), 'sign|' + i, 48));
}

/** recoverScalar(root*, label) -> Uint8Array(32); never leaves the identity origin. */
export async function recoverScalar(rs, label) {
  bytes(rs, 'root*', 32);
  checkLabel(label);
  return scalar(await hkdf(rs, new Uint8Array(0), 'recover|' + label, 48));
}

/** kName(seed) -> Uint8Array(32), the HMAC key for hint tags and blinded ids of a label. */
export async function kName(seed) {
  bytes(seed, 'seed', 32);
  return hkdf(seed, new Uint8Array(0), 'name|1', 32);
}

/** kVaultHash(root*) -> Uint8Array(32): names the vault; never opens it. */
export async function kVaultHash(rs) {
  bytes(rs, 'root*', 32);
  return hkdf(rs, new Uint8Array(0), 'vault-id|2', 32);
}

/** checkCode(root*) -> 8 characters [a-z2-7]. */
export async function checkCode(rs) {
  bytes(rs, 'root*', 32);
  return base32(sha256Sync(concatBytes(utf8.encode(CHECK_PREFIX), rs))).slice(0, 8);
}

/** publicKeyOf(d) -> 'p256:' + b64url(04 || x || y) for a 32-byte scalar. */
export function publicKeyOf(d) {
  return 'p256:' + b64url.encode(publicFromScalar(bytes(d, 'scalar', 32)));
}

/** scalarToJwk(d) -> { kty: 'EC', crv: 'P-256', d, x, y } (base64url fields). */
export function scalarToJwk(d) {
  const pub = publicFromScalar(bytes(d, 'scalar', 32));
  return { kty: 'EC', crv: 'P-256', d: b64url.encode(d), x: b64url.encode(pub.subarray(1, 33)), y: b64url.encode(pub.subarray(33, 65)) };
}

/**
 * importScalar(d, usage = 'sign') -> CryptoKey, non-extractable: an ECDSA signing key ('sign')
 * or an ECDH key ('ecdh'). exportKey on it throws.
 */
export async function importScalar(d, usage = 'sign') {
  const jwk = scalarToJwk(d);
  if (usage === 'sign') return subtle().importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  if (usage === 'ecdh') return subtle().importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  throw new TypeError('usage must be sign or ecdh');
}

/**
 * deriveLabel(root*, label, { i = 1 }) -> { label, seed, d, pub, recoverPub, kName }: the whole
 * per-label set the identity origin computes before building a key bundle.
 */
export async function deriveLabel(rs, label, { i = 1 } = {}) {
  const seed = await labelSeed(rs, label);
  const d = await signScalar(seed, i);
  const r = await recoverScalar(rs, label);
  return { label, i, seed, d, pub: publicKeyOf(d), recoverPub: publicKeyOf(r), kName: await kName(seed) };
}

// ---------------------------------------------------------------------------------------------
// Labels (R 2.2.3)
// ---------------------------------------------------------------------------------------------

function checkLabel(label) {
  if (typeof label !== 'string' || !/^[olh]\|./.test(label) || label.length > 300) {
    throw new TypeError('label must be o|<origin>, l|<ledgerId> or h|<hub suffix>');
  }
}

/** normalizeOrigin(origin) -> 'scheme://host[:port]' lowercase, or throws TypeError. */
export function normalizeOrigin(origin) {
  if (typeof origin !== 'string') throw new TypeError('origin must be a string');
  let u;
  try {
    u = new URL(origin);
  } catch (_) {
    throw new TypeError('origin is not a URL: ' + origin);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new TypeError('origin must be http or https');
  if (u.origin === 'null' || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
    throw new TypeError('not an origin: ' + origin);
  }
  if (origin.replace(/\/$/, '') !== u.origin) throw new TypeError('origin is not in serialised form: ' + origin);
  return u.origin;
}

function linkedLabelOf(links, origin) {
  if (!links) return null;
  if (links instanceof Map) return links.get(origin) || null;
  if (Array.isArray(links)) {
    const hit = links.find((l) => l && l.origin === origin);
    return hit ? hit.label : null;
  }
  if (typeof links === 'object') return Object.prototype.hasOwnProperty.call(links, origin) ? links[origin] : null;
  return null;
}

/**
 * labelFor({ origin, pointer?, hubScope?, links?, verifyPointer, isPublicSuffix })
 *   -> Promise<{ label, keyMode, ledger?, reason? }>
 *
 * origin: event.origin of the verified opener (never page text).
 * pointer: the signed MW-PTR/1 record text the request carried, or absent.
 * hubScope: { suffix, optIn, shared } for a hub host; shared: true for a shared-origin hub.
 * links: the person's "same identity" choices ({ origin: label } object, Map or [{ origin, label }]).
 * verifyPointer(pointerText, origin) -> Promise<{ ok, ledgerId, owner, lo, rotVerified, host, org }>
 *   injected (src/common/pointer.js is changing in another lane): ok means the signature and
 *   freshness checks passed; host is the pointer's own host; org is its org= list of origins.
 * isPublicSuffix(suffix) -> boolean, against the Public Suffix List snapshot in the IdO build.
 *
 * Order: shared-origin hub ('visit-only', no persistent key) > linked (the person's choice) > hub
 * (opt-in on a PSL suffix the host sits directly under) > ledger (verified pointer, lineage and
 * origin listed) > origin (default). Every refusal falls back to the origin label; `reason` says
 * why the ledger label was not used ('not-listed' drives the card line "This address is not one
 * of this site's addresses").
 */
export async function labelFor({ origin, pointer, hubScope, links, verifyPointer, isPublicSuffix } = {}) {
  const o = normalizeOrigin(origin);
  const host = new URL(o).host;
  const originLabel = { label: 'o|' + o, keyMode: 'pairwise' };
  if (hubScope && hubScope.shared === true) return { label: null, keyMode: 'visit-only' };

  const linked = linkedLabelOf(links, o);
  if (typeof linked === 'string' && /^[olh]\|./.test(linked) && linked !== originLabel.label) {
    return { label: linked, keyMode: 'linked' };
  }

  if (hubScope && hubScope.optIn === true && typeof hubScope.suffix === 'string') {
    const suffix = hubScope.suffix.toLowerCase();
    const hostname = new URL(o).hostname;
    const first = hostname.endsWith('.' + suffix) ? hostname.slice(0, -suffix.length - 1) : null;
    if (first && /^[a-z2-7]{32}$/.test(first) && typeof isPublicSuffix === 'function' && isPublicSuffix(suffix) === true) {
      return { label: 'h|' + suffix, keyMode: 'hub' };
    }
  }

  if (typeof pointer === 'string' && pointer.length > 0) {
    if (typeof verifyPointer !== 'function') return Object.assign(originLabel, { reason: 'no-verifier' });
    let v;
    try {
      v = await verifyPointer(pointer, o);
    } catch (_) {
      v = null;
    }
    if (!v || v.ok !== true || typeof v.ledgerId !== 'string' || !v.ledgerId) return Object.assign(originLabel, { reason: 'unverified' });
    const lineage = !v.lo || v.lo === v.owner || v.rotVerified === true;
    if (!lineage) return Object.assign(originLabel, { reason: 'lineage' });
    const org = Array.isArray(v.org) ? v.org : [];
    if (org.length > MAX_ORG_ORIGINS) return Object.assign(originLabel, { reason: 'org-too-long' });
    let listed = typeof v.host === 'string' && v.host.toLowerCase() === host;
    for (const entry of org) {
      try {
        if (normalizeOrigin(String(entry).toLowerCase()) === o) listed = true;
      } catch (_) {
        // an unparsable org= entry lists nothing
      }
    }
    if (!listed) return Object.assign(originLabel, { reason: 'not-listed' });
    return { label: 'l|' + v.ledgerId, keyMode: 'ledger', ledger: v.ledgerId };
  }
  return originLabel;
}
