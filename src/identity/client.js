// src/identity/client.js: the site-origin side of sign-in (R 2.3.1, 2.3.3, 2.2.5, 2.4.1; MF-02, MF-06, MF-07,
// MF-09; INTERFACES v0.3 client.js). It opens the identity origin (IdO) in a top-level window, sends one
// request, and receives a key bundle encrypted to a fresh page key, a mw-signin-v1 proof, or both. It never
// sees the root, the phrase, the PRF output or another site's keys. The protocol pieces both sides use (request
// validation, the ECIES seal) live here too; the IdO bundle imports them, no site origin imports src/idp.
//
//   signIn({ purpose, pointer, challenge, want, ... }) -> { bundle?, proof?, record?, erased? }
//       popup: window.open(IdO + '/signin', 'mw-idp', 'popup,width=420,height=640'), called before any await so
//       the click's activation is kept; E_POPUP_BLOCKED when the browser blocks it (redirect: true navigates the
//       page to IdO/signin#<request> instead and finishes at /_mw/idp-return); E_IDP_UNREACHABLE when the page
//       never answers; E_USER_CANCELLED when the person closes it or cancels; E_RATE inside the 10 s cooldown.
//   completeRedirect({ win }) -> { bundle?, proof?, record?, erased?, returnTo } | null   (at /_mw/idp-return)
//   openIdentity({ intent }) -> 'done' | 'cancelled'      (the IdO's own settings window)
//
// Messages (popup): IdO -> opener { v: 1, t: 'mw-idp-ready', build }; opener -> IdO the request (below) with
// targetOrigin = the IdO origin; optional rounds { t: 'mw-idp-count', pub } -> { t: 'mw-idp-count-res', count }
// (the "Found N posts" line after a restore) and { t: 'mw-idp-legacy', epk } -> { t: 'mw-idp-legacy-res', sealed }
// (a 0.2.1 key moving into the vault, R 2.2.7); IdO -> opener { v: 1, t: 'mw-signin-res', requestId, ok, ... }.
//
// Request (R 2.3.2 plus the fields of docs/deviations/idp.md item 2):
//   { v: 1, t: 'mw-signin-req', requestId, purpose: 'site' | 'server', pointer?, scope?, challenge?,
//     want: one of WANT_SETS, epk?, shared?, hubDefault? (ticks the hub box only on a page whose template the IdO build lists; review round UX-12), create?, owner?,
//     escrow?: { root?, vault? }, record?, legacy?: { pub, ledger, name? } }
//   redirect only: origin (the page's own origin), ret (= origin + '/_mw/idp-return')
// Nothing in the request can choose the label, the key mode, "same identity", the domain or the origin of a
// proof: those come from the IdO and the browser (an unknown field is refused, so no parameter can ask).
//
// Shared code: Node >= 22 and browsers.

import { b64url, utf8 } from '../chain/canonical.js';
import { isPublicKeyString, publicKeyBytes, encodePublicKey } from '../chain/crypto.js';
import { statementProblem } from './signin.js';

export const PROTOCOL_VERSION = 1;
export const BUNDLE_PREFIX = 'mw-idp-bundle-v1';
export const RECORD_PREFIX = 'mw-idp-record-v1';
export const LEGACY_PREFIX = 'mw-idp-legacy-v1';
export const SIGNIN_COOLDOWN_MS = 10000;
export const READY_TIMEOUT_MS = 20000;
export const ANSWER_TIMEOUT_MS = 600000;
export const POPUP_FEATURES = 'popup,width=420,height=640';
export const POPUP_NAME = 'mw-idp';
export const RETURN_PATH = '/_mw/idp-return';
export const WANTS = Object.freeze(['keys', 'proof', 'record', 'erase']);
/**
 * The combinations of R 2.3.2 (code review v0.3, security 7): keys, a proof, both, the private record alone, or an
 * erase alone. A proof never rides with the record read, whose card shows no statement.
 */
export const WANT_SETS = Object.freeze([['keys'], ['proof'], ['keys', 'proof'], ['record'], ['erase']].map((w) => Object.freeze(w)));
export const OWNER_ACTIONS = Object.freeze(['policy', 'checkpoint', 'withdraw', 'delete']);
export const REQUEST_FIELDS = Object.freeze(['v', 't', 'requestId', 'purpose', 'pointer', 'scope', 'challenge', 'want', 'epk', 'shared', 'hubDefault',
  'create', 'owner', 'escrow', 'record', 'legacy']);
export const REDIRECT_FIELDS = Object.freeze(['origin', 'ret']);
export const MAX_BLOB_CHARS = 400000;

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

function subtle(cryptoApi) {
  const c = cryptoApi || globalThis.crypto;
  if (!c || !c.subtle) throw clientError('E_UNSUPPORTED', 'WebCrypto is unavailable');
  return c.subtle;
}

function clientError(code, message) {
  return Object.assign(new Error(message || code), { code });
}

// ---------------------------------------------------------------------------------------------
// Field rules shared with the identity origin
// ---------------------------------------------------------------------------------------------

/** isOrigin(s) -> true for a serialised https origin, or http on a loopback host (tests, development). */
export function isOrigin(s) {
  if (typeof s !== 'string' || s.length > 300) return false;
  let u;
  try {
    u = new URL(s);
  } catch (_) {
    return false;
  }
  if (u.origin !== s) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname.endsWith('.localhost'));
}

function b64urlLen(s, min, max) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) return false;
  try {
    const n = b64url.decode(s).length;
    return n >= min && n <= max;
  } catch (_) {
    return false;
  }
}

function plainObject(x) {
  return Boolean(x) && typeof x === 'object' && !Array.isArray(x) && (Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null);
}

function jsonSize(x) {
  try {
    return JSON.stringify(x).length;
  } catch (_) {
    return Infinity;
  }
}

/**
 * validateRequest(req, { transport = 'popup' }) -> { ok: true, req } | { ok: false, code, reason }
 * The strict request rules (both sides run them; the IdO trusts only its own run). transport 'redirect'
 * requires origin and ret (ret = origin + '/_mw/idp-return'); 'popup' refuses them (the origin is the
 * browser's event.origin there).
 */
export function validateRequest(req, { transport = 'popup' } = {}) {
  const bad = (reason) => ({ ok: false, code: 'E_BAD_REQUEST', reason });
  if (!plainObject(req)) return bad('shape');
  const allowed = transport === 'redirect' ? REQUEST_FIELDS.concat(REDIRECT_FIELDS) : REQUEST_FIELDS;
  for (const k of Object.keys(req)) if (allowed.indexOf(k) < 0) return bad('field ' + k);
  if (req.v !== PROTOCOL_VERSION || req.t !== 'mw-signin-req') return bad('version');
  if (!b64urlLen(req.requestId, 16, 32)) return bad('requestId');
  if (req.purpose !== 'site' && req.purpose !== 'server') return bad('purpose');
  if (!Array.isArray(req.want) || req.want.length === 0 || req.want.length > WANTS.length) return bad('want');
  const want = new Set(req.want);
  if (want.size !== req.want.length || req.want.some((w) => WANTS.indexOf(w) < 0)) return bad('want');
  if (want.has('erase') && want.size !== 1) return bad('erase is a request of its own');
  if (!WANT_SETS.some((w) => w.length === want.size && w.every((x) => want.has(x)))) return bad('want combination');
  if (req.purpose === 'server' && (!want.has('proof') || want.has('record') || want.has('erase'))) return bad('server sign-in wants a proof');
  // A verifier's challenge belongs to a server sign-in only: a site proof carries a nonce from the identity origin,
  // so it can never pass a server's verifier (R 2.3.2 "rejected by construction").
  if (req.challenge !== undefined && req.purpose !== 'server') return bad('a challenge comes with a server sign-in');
  const sealed = want.has('keys') || want.has('record') || want.has('erase');
  if (sealed && !isPublicKeyString(req.epk)) return bad('epk');
  if (req.epk !== undefined && !isPublicKeyString(req.epk)) return bad('epk');
  if (req.pointer !== undefined && (typeof req.pointer !== 'string' || req.pointer.length === 0 || req.pointer.length > 2048)) return bad('pointer');
  if (req.scope !== undefined && (typeof req.scope !== 'string' || !/^(btih:[0-9a-f]{40}|[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?)$/.test(req.scope))) return bad('scope');
  if (req.scope !== undefined && req.pointer === undefined) return bad('scope without a pointer');
  if (req.challenge !== undefined) {
    const c = req.challenge;
    if (!plainObject(c)) return bad('challenge');
    for (const k of Object.keys(c)) if (['nonce', 'statement', 'exp', 'nbf', 'resources'].indexOf(k) < 0) return bad('challenge field ' + k);
    if (c.nonce !== undefined && !b64urlLen(c.nonce, 16, 64)) return bad('challenge nonce');
    // Review round PHISH-11: the statement rules of mw-signin-v1 section 5 (at most 280 characters, NFC, no control or bidi
    // characters) hold before any card shows it, not only when the proof is built after the card and the passkey.
    if (c.statement !== undefined && (typeof c.statement !== 'string' || statementProblem(c.statement) !== null)) return bad('statement');
    if (jsonSize(c) > 4096) return bad('challenge size');
  }
  for (const k of ['shared', 'hubDefault', 'create']) if (req[k] !== undefined && typeof req[k] !== 'boolean') return bad(k);
  if (req.owner !== undefined) {
    if (!plainObject(req.owner) || Object.keys(req.owner).length !== 1 || OWNER_ACTIONS.indexOf(req.owner.what) < 0) return bad('owner');
    if (!want.has('keys')) return bad('owner actions come with keys');
  }
  if (req.escrow !== undefined) {
    if (!plainObject(req.escrow) || Object.keys(req.escrow).some((k) => k !== 'root' && k !== 'vault')) return bad('escrow');
    if (jsonSize(req.escrow) > MAX_BLOB_CHARS) return bad('escrow size');
  }
  if (req.record !== undefined && (!plainObject(req.record) || jsonSize(req.record) > MAX_BLOB_CHARS)) return bad('record');
  if (req.legacy !== undefined) {
    const l = req.legacy;
    if (!plainObject(l) || !isPublicKeyString(l.pub) || Object.keys(l).some((k) => ['pub', 'ledger', 'name'].indexOf(k) < 0)) return bad('legacy');
    if (l.ledger !== undefined && l.ledger !== null && (typeof l.ledger !== 'string' || l.ledger.length > 64)) return bad('legacy ledger');
    if (l.name !== undefined && (typeof l.name !== 'string' || l.name.length > 48)) return bad('legacy name');
  }
  if (transport === 'redirect') {
    if (!isOrigin(req.origin)) return bad('origin');
    if (!returnUrlOk(req.ret, req.origin)) return bad('ret');
    // Review round SEC-2, PHISH-9: the origin of a redirect request is page text, so it carries only a key sign-in or the
    // record read; a proof, an erase, an owner action, a page creation or a legacy key needs the popup, where the browser
    // names the origin.
    if (!redirectOk(req)) return bad('not by redirect');
  }
  return { ok: true, req };
}

/** redirectOk(req) -> true for what the redirect transport may carry: purpose site, want keys and/or record, nothing else. */
export function redirectOk(req) {
  const want = Array.isArray(req && req.want) ? req.want : [];
  if (!req || req.purpose !== 'site' || req.challenge !== undefined) return false;
  if (want.some((w) => w !== 'keys' && w !== 'record')) return false;
  return req.create === undefined && req.owner === undefined && req.legacy === undefined;
}

/** returnUrlOk(ret, origin) -> true only for exactly origin + '/_mw/idp-return' (R 2.3.1: bound to the origin). */
export function returnUrlOk(ret, origin) {
  if (typeof ret !== 'string' || !isOrigin(origin)) return false;
  let u;
  try {
    u = new URL(ret);
  } catch (_) {
    return false;
  }
  return u.origin === origin && u.pathname === RETURN_PATH && !u.search && !u.hash && u.username === '' && u.password === '' && u.href === origin + RETURN_PATH;
}

/** validateResponse(res, requestId) -> true for a well-formed answer to that request. */
export function validateResponse(res, requestId) {
  if (!plainObject(res) || res.v !== PROTOCOL_VERSION || res.t !== 'mw-signin-res' || res.requestId !== requestId) return false;
  if (res.ok === false) return typeof res.code === 'string' && /^E_[A-Z_]{2,40}$/.test(res.code);
  if (res.ok !== true) return false;
  for (const k of ['bundle', 'record']) if (res[k] !== undefined && !sealedShape(res[k])) return false;
  if (res.proof !== undefined && !plainObject(res.proof)) return false;
  return true;
}

function sealedShape(x) {
  return plainObject(x) && x.v === 1 && isPublicKeyString(x.epk) && b64urlLen(x.iv, 12, 12) && typeof x.ct === 'string' && x.ct.length <= 1 << 20;
}

// ---------------------------------------------------------------------------------------------
// ECIES (R 2.3.3): ephemeral ECDH P-256, HKDF-SHA-256 (info prefix + '|' + origin), AES-256-GCM
// ---------------------------------------------------------------------------------------------

async function ecdhBits(cryptoApi, privateKey, theirPub) {
  const pub = await subtle(cryptoApi).importKey('raw', publicKeyBytes(theirPub), ECDH, false, []);
  return new Uint8Array(await subtle(cryptoApi).deriveBits({ name: 'ECDH', public: pub }, privateKey, 256));
}

async function boxKey(cryptoApi, shared, prefix, origin) {
  const base = await subtle(cryptoApi).importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return subtle(cryptoApi).deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8.encode(prefix + '|' + origin) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function boxAad(prefix, origin, requestId, epk) {
  return utf8.encode(prefix + '\n' + origin + '\n' + requestId + '\n' + epk);
}

/**
 * seal(prefix, recipientPub, value, { origin, requestId, cryptoApi }) -> { v: 1, epk, iv, ct }
 * value is JSON. info = prefix + '|' + origin; AAD = prefix \n origin \n requestId \n epk. Used for the key
 * bundle (BUNDLE_PREFIX, IdO to page), the record (RECORD_PREFIX) and a legacy key (LEGACY_PREFIX, page to IdO).
 */
export async function seal(prefix, recipientPub, value, { origin, requestId, cryptoApi } = {}) {
  if (!isPublicKeyString(recipientPub)) throw new TypeError('seal: recipient must be a p256: key');
  if (!isOrigin(origin)) throw new TypeError('seal: origin');
  const s = subtle(cryptoApi);
  const eph = await s.generateKey(ECDH, true, ['deriveBits']);
  const epk = encodePublicKey(new Uint8Array(await s.exportKey('raw', eph.publicKey)));
  const key = await boxKey(cryptoApi, await ecdhBits(cryptoApi, eph.privateKey, recipientPub), prefix, origin);
  const iv = (cryptoApi || globalThis.crypto).getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await s.encrypt({ name: 'AES-GCM', iv, additionalData: boxAad(prefix, origin, requestId, epk) }, key, utf8.encode(JSON.stringify(value))));
  return { v: 1, epk, iv: b64url.encode(iv), ct: b64url.encode(ct) };
}

/** open(prefix, privateKey, sealed, { origin, requestId, cryptoApi }) -> value; E_DECRYPT on any failure. */
export async function open(prefix, privateKey, sealed, { origin, requestId, cryptoApi } = {}) {
  if (!sealedShape(sealed)) throw clientError('E_DECRYPT', 'not a sealed box');
  try {
    const key = await boxKey(cryptoApi, await ecdhBits(cryptoApi, privateKey, sealed.epk), prefix, origin);
    const pt = await subtle(cryptoApi).decrypt({ name: 'AES-GCM', iv: b64url.decode(sealed.iv), additionalData: boxAad(prefix, origin, requestId, sealed.epk) }, key, b64url.decode(sealed.ct));
    return JSON.parse(utf8.decode(new Uint8Array(pt), { fatal: true }));
  } catch (_) {
    throw clientError('E_DECRYPT', 'the answer could not be opened with this page\'s key');
  }
}

/** newBoxKey(cryptoApi) -> { privateKey (non-extractable), pub } for one request. */
export async function newBoxKey(cryptoApi, { extractable = false } = {}) {
  const s = subtle(cryptoApi);
  const pair = await s.generateKey(ECDH, extractable, ['deriveBits']);
  const pub = encodePublicKey(new Uint8Array(await s.exportKey('raw', pair.publicKey)));
  return { privateKey: pair.privateKey, pub };
}

// ---------------------------------------------------------------------------------------------
// Local caches sealed under K_local (R 2.12): the site's copy of its private record, readable by the IdO,
// which holds K_local in the vault, when the site passes it back (record merge, R 2.6.1)
// ---------------------------------------------------------------------------------------------

export const LOCAL_PREFIX = 'mw-local-cache-v1';

async function aesKeyOf(key, cryptoApi) {
  if (key && typeof key === 'object' && typeof key.type === 'string' && key.algorithm) return key;
  const raw = typeof key === 'string' ? b64url.decode(key) : key;
  if (!(raw instanceof Uint8Array) || raw.length !== 32) throw new TypeError('a 32-byte AES key or a CryptoKey');
  return subtle(cryptoApi).importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** sealLocal(key, label, name, value) -> { v: 1, iv, ct }: AES-256-GCM, AAD "mw-local-cache-v1\n" + label + "\n" + name. */
export async function sealLocal(key, label, name, value, { cryptoApi } = {}) {
  const iv = (cryptoApi || globalThis.crypto).getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle(cryptoApi).encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(LOCAL_PREFIX + '\n' + label + '\n' + name) },
    await aesKeyOf(key, cryptoApi), utf8.encode(JSON.stringify(value))));
  return { v: 1, iv: b64url.encode(iv), ct: b64url.encode(ct) };
}

/** openLocal(key, label, name, blob) -> value, or null when the blob does not open (wrong key, label or name). */
export async function openLocal(key, label, name, blob, { cryptoApi } = {}) {
  if (!plainObject(blob) || blob.v !== 1 || !b64urlLen(blob.iv, 12, 12) || typeof blob.ct !== 'string') return null;
  try {
    const pt = await subtle(cryptoApi).decrypt({ name: 'AES-GCM', iv: b64url.decode(blob.iv), additionalData: utf8.encode(LOCAL_PREFIX + '\n' + label + '\n' + name) },
      await aesKeyOf(key, cryptoApi), b64url.decode(blob.ct));
    return JSON.parse(utf8.decode(new Uint8Array(pt), { fatal: true }));
  } catch (_) {
    return null;
  }
}

/**
 * mergeRecords(...records) -> { f, ft, t }: the private record merged per field (R 2.6.1). A record is
 * { f: { name: value }, ft: { name: ms }, t }; ft without f[name] is a removal. For each field the newest ft
 * wins, so a write on one device never drops newer fields written on another. Records without ft (t only)
 * count every field at t.
 */
export function mergeRecords(...records) {
  const out = { f: {}, ft: {}, t: 0 };
  for (const r of records) {
    if (!plainObject(r) || !plainObject(r.f) || !Number.isSafeInteger(r.t)) continue;
    const ft = plainObject(r.ft) ? r.ft : {};
    const names = new Set(Object.keys(r.f).concat(Object.keys(ft)));
    for (const name of names) {
      const at = Number.isSafeInteger(ft[name]) ? ft[name] : r.t;
      if (out.ft[name] !== undefined && out.ft[name] >= at) continue;
      out.ft[name] = at;
      if (Object.prototype.hasOwnProperty.call(r.f, name)) out.f[name] = r.f[name];
      else delete out.f[name];
    }
    if (r.t > out.t) out.t = r.t;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The identity origin address
// ---------------------------------------------------------------------------------------------

const CONFIG = { idp: null };

/** configure({ idp }): the default identity origin for this page (the loader passes its configuration). */
export function configure({ idp } = {}) {
  if (idp !== undefined && idp !== null && !isOrigin(idp)) throw new TypeError('configure: idp must be an https origin');
  if (idp !== undefined) CONFIG.idp = idp;
}

function pointerIdp(pointer) {
  if (typeof pointer !== 'string') return null;
  // Review round PHISH-10: only a signed record names an identity origin (an unsigned text is anyone's).
  if (!/(?:^|;)\s*sig=[A-Za-z0-9_-]{16,}/.test(pointer)) return null;
  const m = /(?:^|;)\s*idp=([^;\s]+)/.exec(pointer);
  return m && isOrigin(m[1]) ? m[1] : null;
}

/**
 * resolveIdp({ idp, doc, pointer }) -> origin | null: an explicit address, then configure(), then
 * <meta name="mw-idp" content="https://...">, then the pointer's idp= (the owner's suggestion). Without a pointer,
 * the page's own stamped pointer (<meta name="mw-pointer">, drop-in pages, publish --idp) is that suggestion: the
 * sign-in widget on an existing site passes none (v0.3 final integration; before, a forum page published with
 * --idp and without the mw-idp meta answered E_IDP_UNREACHABLE).
 */
export function resolveIdp({ idp, doc, pointer, trustPointer = true } = {}) {
  if (idp !== undefined && idp !== null) return isOrigin(idp) ? idp : null;
  if (CONFIG.idp) return CONFIG.idp;
  const d = doc || (typeof document !== 'undefined' ? document : null);
  let stamped = null;
  if (d && typeof d.querySelector === 'function') {
    try {
      const meta = d.querySelector('meta[name="mw-idp"]');
      const v = meta && meta.getAttribute('content');
      if (v && isOrigin(v.trim())) return v.trim();
      const tag = d.querySelector('meta[name="mw-pointer"]');
      stamped = tag ? tag.getAttribute('content') : null;
    } catch (_) {
      // no DOM
    }
  }
  // Review round PTR-10: a pointer that arrived by link (a hub label, a door) never chooses the identity origin; only the
  // page's own pointer (its DNS record or page tag, or the stamp of a drop-in page) may suggest one. trustPointer: false
  // (src/identity/service.js on a hub label or a door) skips the suggestion: then the operator's mw-idp meta, or nothing.
  if (trustPointer === false) return null;
  return pointerIdp(typeof pointer === 'string' ? pointer : stamped);
}

/**
 * withoutReferrer(win, fn) -> fn(): review round PRIV-4, HUB-9: the sign-in window and the redirect leave from the site's
 * page, whose own referrer policy would otherwise tell the identity origin's host which site is signing in (a drop-in page
 * often sends strict-origin-when-cross-origin). A <meta name="referrer" content="no-referrer"> is put in the page for the
 * moment the navigation starts (its policy is taken then), and the page's own policy comes back after it.
 */
export function withoutReferrer(win, fn) {
  const doc = win && win.document;
  let meta = null;
  try {
    if (doc && typeof doc.createElement === 'function' && (doc.head || doc.documentElement)) {
      meta = doc.createElement('meta');
      meta.setAttribute('name', 'referrer');
      meta.setAttribute('content', 'no-referrer');
      meta.setAttribute('data-mw-noreferrer', '1');
      (doc.head || doc.documentElement).appendChild(meta);
    }
  } catch (_) {
    meta = null;
  }
  const restore = () => {
    try { if (meta && meta.parentNode) meta.parentNode.removeChild(meta); } catch (_) { /* gone */ }
  };
  try {
    return fn();
  } finally {
    // The navigation's referrer is fixed when it starts; the page keeps no-referrer a moment longer for engines that start
    // it in a task of their own.
    try {
      const h = setTimeout(restore, 1000);
      if (h && typeof h.unref === 'function') h.unref();
    } catch (_) {
      restore();
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Cooldown (R 2.3.9: sign-in fatigue; R 2.11.2 E_RATE)
// ---------------------------------------------------------------------------------------------

const LAST_OPEN = new Map();

function cooldownKind({ purpose, want }) {
  const w = Array.isArray(want) ? want : [];
  if (w.indexOf('erase') >= 0) return 'erase';
  if (purpose === 'server') return 'server';
  if (w.indexOf('keys') < 0 && w.indexOf('record') >= 0) return 'record';
  return 'signin';
}

/** resetCooldown(): tests only. */
export function resetCooldown() {
  LAST_OPEN.clear();
}

// ---------------------------------------------------------------------------------------------
// Popup flow
// ---------------------------------------------------------------------------------------------

function windowOf(opts) {
  const w = opts.win || (typeof window !== 'undefined' ? window : null);
  if (!w) throw clientError('E_UNSUPPORTED', 'no window');
  return w;
}

function randomId(cryptoApi) {
  return b64url.encode((cryptoApi || globalThis.crypto).getRandomValues(new Uint8Array(16)));
}

const LATE_FIELDS = ['challenge', 'escrow', 'record', 'legacy', 'pointer', 'scope'];

/**
 * resolveLate(opts) -> a copy of opts with every promise field resolved: the challenge, the escrow blobs, the
 * local record and the legacy key description may be promises (an IndexedDB read or a server fetch started in
 * the same click), so window.open can run before them, inside the click's activation.
 */
export async function resolveLate(opts) {
  const out = Object.assign({}, opts);
  for (const k of LATE_FIELDS) {
    const v = out[k];
    if (v && typeof v.then === 'function') {
      try {
        out[k] = await v;
      } catch (err) {
        if (k === 'challenge') throw Object.assign(new Error('the server sent no challenge'), { code: (err && err.code) || 'E_NONCE_REQUIRED' });
        out[k] = undefined; // a failed escrow or record read only means there is none to pass back
      }
    }
    if (out[k] === null) out[k] = undefined;
  }
  return out;
}

/**
 * fitEscrow(escrow) -> the escrow that fits a request (code review v0.3, security 8): an oversized vault copy is
 * dropped (the identity origin keeps its own), never the whole sign-in; null when nothing fits.
 */
export function fitEscrow(escrow) {
  if (!plainObject(escrow)) return null;
  const out = {};
  if (escrow.root !== undefined) out.root = escrow.root;
  if (escrow.vault !== undefined) out.vault = escrow.vault;
  if (jsonSize(out) <= MAX_BLOB_CHARS) return Object.keys(out).length ? out : null;
  delete out.vault;
  return Object.keys(out).length && jsonSize(out) <= MAX_BLOB_CHARS ? out : null;
}

function buildRequest(opts, requestId, epk) {
  const want = Array.isArray(opts.want) && opts.want.length ? opts.want.slice() : ['keys'];
  const req = { v: PROTOCOL_VERSION, t: 'mw-signin-req', requestId, purpose: opts.purpose === 'server' ? 'server' : 'site', want };
  if (epk) req.epk = epk;
  for (const k of ['pointer', 'scope', 'challenge', 'shared', 'create', 'owner', 'escrow', 'record']) if (opts[k] !== undefined && opts[k] !== null) req[k] = opts[k];
  if (req.escrow !== undefined) {
    const fit = fitEscrow(req.escrow);
    if (fit) req.escrow = fit;
    else delete req.escrow;
  }
  // A local record over the cap is not sent (the identity origin would refuse it); the site keeps its copy.
  if (req.record !== undefined && (!plainObject(req.record) || jsonSize(req.record) > MAX_BLOB_CHARS)) delete req.record;
  if (opts.legacy && opts.legacy.pub) {
    req.legacy = { pub: opts.legacy.pub };
    if (opts.legacy.ledger !== undefined) req.legacy.ledger = opts.legacy.ledger;
    if (typeof opts.legacy.name === 'string' && opts.legacy.name) req.legacy.name = opts.legacy.name.slice(0, 48);
  }
  return req;
}

async function finishAnswer(res, ctx) {
  if (res.ok !== true) throw clientError(res.code || 'E_USER_CANCELLED', 'the identity page answered ' + (res.code || 'no'));
  const out = {};
  const params = { origin: ctx.origin, requestId: ctx.requestId, cryptoApi: ctx.cryptoApi };
  if (res.bundle) out.bundle = await open(BUNDLE_PREFIX, ctx.privateKey, res.bundle, params);
  if (res.record) out.record = await open(RECORD_PREFIX, ctx.privateKey, res.record, params);
  if (res.proof) out.proof = res.proof;
  if (res.erased === true) out.erased = true;
  return out;
}

/**
 * opensInPlace(win) -> true where a sign-in window cannot keep its link to the page: an iOS Home Screen web app
 * (navigator.standalone, or display-mode standalone on iOS) opens another origin outside the app and loses the opener
 * (G-ID-7). signIn then starts with the redirect round trip (code review v0.3, browser).
 */
export function opensInPlace(win) {
  try {
    const nav = win && win.navigator;
    if (!nav) return false;
    if (nav.standalone === true) return true;
    const ios = /iPad|iPhone|iPod/.test(String(nav.userAgent || '')) || (nav.platform === 'MacIntel' && Number(nav.maxTouchPoints) > 1);
    return Boolean(ios && typeof win.matchMedia === 'function' && win.matchMedia('(display-mode: standalone)').matches);
  } catch (_) {
    return false;
  }
}

/**
 * signIn(opts) -> Promise<{ bundle?, proof?, record?, erased? }>
 * opts: { purpose = 'site', pointer, scope, challenge, want = ['keys'], shared, create, owner, escrow, record,
 *         legacy: { pub, ledger, name, exportKey() -> Promise<jwk> }, countPosts(pub) -> Promise<number | null>,
 *         redirect, returnTo, idp, win, cryptoApi, now, readyTimeoutMs, answerTimeoutMs, pollMs }
 * redirect: true starts with the redirect round trip, false never does; left out, a key sign-in (no proof) starts with
 * it where opensInPlace(win). challenge, escrow, record, legacy, pointer and scope may be promises (resolveLate).
 * Call it from a click: window.open runs before the first await.
 */
export function signIn(opts = {}) {
  let win;
  try {
    win = windowOf(opts);
  } catch (err) {
    return Promise.reject(err);
  }
  const now = opts.now || (() => Date.now());
  const kind = cooldownKind(opts);
  const last = LAST_OPEN.get(kind);
  if (last !== undefined && now() - last < SIGNIN_COOLDOWN_MS) return Promise.reject(clientError('E_RATE', 'wait a few seconds before trying again'));
  const idp = resolveIdp({ idp: opts.idp, doc: win.document, pointer: opts.pointer, trustPointer: opts.trustPointer });
  if (!idp) return Promise.reject(clientError('E_IDP_UNREACHABLE', 'no identity page is configured for this site'));
  // A key sign-in where no popup can keep its opener goes by redirect at once; a proof, an erase, a page creation or an
  // owner action never does (the identity origin refuses them by redirect: review round SEC-2, PHISH-9).
  const want = Array.isArray(opts.want) && opts.want.length ? opts.want : ['keys'];
  const redirectable = redirectOk({ purpose: opts.purpose === 'server' ? 'server' : 'site', want, create: opts.create || undefined, owner: opts.owner || undefined });
  if (opts.redirect === true || (opts.redirect !== false && redirectable && opensInPlace(win))) {
    LAST_OPEN.set(kind, now());
    return startRedirect(opts, win, idp);
  }
  let popup = null;
  try {
    popup = withoutReferrer(win, () => win.open(idp + '/signin', POPUP_NAME, POPUP_FEATURES));
  } catch (_) {
    popup = null;
  }
  if (!popup) return Promise.reject(clientError('E_POPUP_BLOCKED', 'the browser blocked the sign-in window; call this from a click'));
  LAST_OPEN.set(kind, now());
  return runPopup(opts, win, idp, popup);
}

async function runPopup(opts, win, idp, popup) {
  const cryptoApi = opts.cryptoApi;
  const origin = win.location.origin;
  const requestId = randomId(cryptoApi);
  const want = Array.isArray(opts.want) && opts.want.length ? opts.want : ['keys'];
  const needsKey = want.some((w) => w !== 'proof');
  const setT = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimeout || ((h) => clearTimeout(h));
  const keyPromise = needsKey ? newBoxKey(cryptoApi) : Promise.resolve(null);
  let box = null;
  let ready = false;
  let settled = false;
  let request = null;
  let resolved = opts;
  return new Promise((resolve, reject) => {
    const timers = [];
    const cleanup = () => {
      settled = true;
      win.removeEventListener('message', onMessage);
      for (const t of timers) clearT(t);
    };
    const fail = (code, msg) => {
      if (settled) return;
      cleanup();
      try { if (!popup.closed) popup.close(); } catch (_) { /* cross-origin close may throw */ }
      reject(clientError(code, msg));
    };
    const post = (msg) => {
      try { popup.postMessage(msg, idp); } catch (_) { /* the window went away */ }
    };
    async function onMessage(event) {
      if (settled || !event || event.source !== popup || event.origin !== idp) return;
      const data = event.data;
      if (!plainObject(data) || data.v !== PROTOCOL_VERSION) return;
      try {
        if (data.t === 'mw-idp-ready') {
          if (ready) return;
          ready = true;
          try {
            box = await keyPromise;
          } catch (err) {
            fail('E_UNSUPPORTED', 'this browser cannot make the page key');
            return;
          }
          // Promise fields (a server challenge, escrow blobs, the local record, a legacy key) resolve here, after
          // the window opened: window.open must run inside the click's activation.
          let late;
          try {
            late = await resolveLate(opts);
          } catch (err) {
            fail((err && err.code) || 'E_NONCE_REQUIRED', (err && err.message) || 'the server sent no challenge');
            return;
          }
          resolved = late;
          request = buildRequest(late, requestId, box ? box.pub : undefined);
          const v = validateRequest(request);
          if (!v.ok) {
            fail('E_BAD_REQUEST', 'the request was refused here: ' + v.reason);
            return;
          }
          post(request);
          return;
        }
        if (!ready || data.requestId !== requestId) return;
        if (data.t === 'mw-idp-count') {
          let count = null;
          if (typeof opts.countPosts === 'function' && isPublicKeyString(data.pub)) {
            try {
              const n = await opts.countPosts(data.pub);
              count = Number.isSafeInteger(n) && n >= 0 ? n : null;
            } catch (_) {
              count = null;
            }
          }
          post({ v: PROTOCOL_VERSION, t: 'mw-idp-count-res', requestId, count });
          return;
        }
        if (data.t === 'mw-idp-legacy') {
          let sealed = null;
          const legacy = resolved.legacy;
          if (legacy && typeof legacy.exportKey === 'function' && isPublicKeyString(data.epk)) {
            try {
              const jwk = await legacy.exportKey();
              sealed = await seal(LEGACY_PREFIX, data.epk, { jwk }, { origin, requestId, cryptoApi });
            } catch (_) {
              sealed = null;
            }
          }
          post({ v: PROTOCOL_VERSION, t: 'mw-idp-legacy-res', requestId, sealed });
          return;
        }
        if (data.t === 'mw-signin-res') {
          if (!validateResponse(data, requestId)) {
            fail('E_BAD_REQUEST', 'the identity page sent a malformed answer');
            return;
          }
          cleanup();
          finishAnswer(data, { origin, requestId, privateKey: box && box.privateKey, cryptoApi }).then(resolve, reject);
        }
      } catch (err) {
        fail('E_IDP_UNREACHABLE', (err && err.message) || 'sign-in failed');
      }
    }
    win.addEventListener('message', onMessage);
    timers.push(setT(() => { if (!ready) fail('E_IDP_UNREACHABLE', 'the identity page did not answer'); }, opts.readyTimeoutMs || READY_TIMEOUT_MS));
    timers.push(setT(() => fail('E_USER_CANCELLED', 'the sign-in window stayed open too long'), opts.answerTimeoutMs || ANSWER_TIMEOUT_MS));
    const poll = () => {
      if (settled) return;
      let closed = false;
      try { closed = popup.closed === true; } catch (_) { closed = false; }
      if (closed) {
        fail(ready ? 'E_USER_CANCELLED' : 'E_IDP_UNREACHABLE', ready ? 'the sign-in window was closed' : 'the identity page could not be opened');
        return;
      }
      timers.push(setT(poll, opts.pollMs || 400));
    };
    timers.push(setT(poll, opts.pollMs || 400));
  });
}

// ---------------------------------------------------------------------------------------------
// Redirect round trip (R 2.3.1, G-ID-7, E-ID-11)
// ---------------------------------------------------------------------------------------------

const PENDING_DB = 'mw-idp-pending';
const PENDING_STORE = 'p';
const PENDING_SESSION_KEY = 'mw-idp-pending';
const PENDING_TTL_MS = 30 * 60 * 1000;

function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function pendingDb(idb) {
  const openReq = idb.open(PENDING_DB, 1);
  openReq.onupgradeneeded = () => {
    if (!openReq.result.objectStoreNames.contains(PENDING_STORE)) openReq.result.createObjectStore(PENDING_STORE);
  };
  return idbReq(openReq);
}

/** savePendingIdb(win, rec, privateKey) -> true when IndexedDB kept the record (with a non-extractable CryptoKey). */
async function savePendingIdb(win, rec, privateKey) {
  const idb = win.indexedDB;
  if (!idb) return false;
  try {
    const db = await pendingDb(idb);
    try {
      await idbReq(db.transaction(PENDING_STORE, 'readwrite').objectStore(PENDING_STORE).put(Object.assign({}, rec, { privateKey }), rec.requestId));
      return true;
    } finally {
      db.close();
    }
  } catch (_) {
    return false; // no IndexedDB, or a CryptoKey that cannot be cloned there (iOS DataCloneError)
  }
}

/** savePendingSession(win, rec, jwk): the fallback, a JWK of a one-request key in sessionStorage (never a proof). */
function savePendingSession(win, rec, jwk) {
  if (!win.sessionStorage) throw clientError('E_UNSUPPORTED', 'this browser cannot keep the sign-in key across the redirect');
  win.sessionStorage.setItem(PENDING_SESSION_KEY, JSON.stringify(Object.assign({}, rec, { jwk })));
}

async function takePending(win, requestId, cryptoApi) {
  let rec = null;
  const idb = win.indexedDB;
  if (idb) {
    try {
      const db = await pendingDb(idb);
      try {
        const store = db.transaction(PENDING_STORE, 'readwrite').objectStore(PENDING_STORE);
        rec = await idbReq(store.get(requestId));
        await idbReq(db.transaction(PENDING_STORE, 'readwrite').objectStore(PENDING_STORE).delete(requestId));
      } finally {
        db.close();
      }
    } catch (_) {
      rec = null;
    }
  }
  if (!rec && win.sessionStorage) {
    try {
      const s = JSON.parse(win.sessionStorage.getItem(PENDING_SESSION_KEY) || 'null');
      if (s && s.requestId === requestId) {
        rec = s;
        rec.privateKey = s.jwk ? await subtle(cryptoApi).importKey('jwk', s.jwk, ECDH, false, ['deriveBits']) : null;
        delete rec.jwk;
      }
    } catch (_) {
      rec = null;
    }
    try { win.sessionStorage.removeItem(PENDING_SESSION_KEY); } catch (_) { /* ignore */ }
  }
  return rec;
}

/** encodeFragment(obj) -> b64url(UTF-8 JSON); decodeFragment reverses it (null on garbage). */
export function encodeFragment(obj) {
  return b64url.encode(utf8.encode(JSON.stringify(obj)));
}

export function decodeFragment(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 300000 || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    return JSON.parse(utf8.decode(b64url.decode(text), { fatal: true }));
  } catch (_) {
    return null;
  }
}

async function startRedirect(opts, win, idp) {
  const cryptoApi = opts.cryptoApi;
  const origin = win.location.origin;
  const requestId = randomId(cryptoApi);
  const want = Array.isArray(opts.want) && opts.want.length ? opts.want : ['keys'];
  const needsKey = want.some((w) => w !== 'proof');
  let returnTo = typeof opts.returnTo === 'string' ? opts.returnTo : win.location.href;
  try {
    if (new URL(returnTo, win.location.href).origin !== origin) returnTo = origin + '/';
  } catch (_) {
    returnTo = origin + '/';
  }
  const rec = { requestId, want: want.slice(), purpose: opts.purpose === 'server' ? 'server' : 'site', returnTo, t: (opts.now || Date.now)() };
  let box = null;
  if (needsKey) {
    box = await newBoxKey(cryptoApi);
    if (!(await savePendingIdb(win, rec, box.privateKey))) {
      // IndexedDB cannot hold the key: an extractable one-request key goes to sessionStorage instead.
      box = await newBoxKey(cryptoApi, { extractable: true });
      savePendingSession(win, rec, await subtle(cryptoApi).exportKey('jwk', box.privateKey));
    }
  } else if (!(await savePendingIdb(win, rec, null))) {
    savePendingSession(win, rec, null);
  }
  // A legacy key never travels by redirect: there is no channel to ask for it after the person's choice.
  const late = await resolveLate(Object.assign({}, opts, { legacy: null }));
  const req = buildRequest(late, requestId, box ? box.pub : undefined);
  req.origin = origin;
  req.ret = origin + RETURN_PATH;
  const v = validateRequest(req, { transport: 'redirect' });
  if (!v.ok) throw clientError('E_BAD_REQUEST', 'the request was refused here: ' + v.reason);
  withoutReferrer(win, () => win.location.assign(idp + '/signin#' + encodeFragment(req)));
  return new Promise(() => {}); // the page is leaving
}

async function peekPending(win, requestId) {
  const idb = win.indexedDB;
  if (idb) {
    try {
      const db = await pendingDb(idb);
      try {
        const rec = await idbReq(db.transaction(PENDING_STORE, 'readonly').objectStore(PENDING_STORE).get(requestId));
        if (rec) return rec;
      } finally {
        db.close();
      }
    } catch (_) {
      // fall back to the session copy
    }
  }
  try {
    const s = win.sessionStorage ? JSON.parse(win.sessionStorage.getItem(PENDING_SESSION_KEY) || 'null') : null;
    return s && s.requestId === requestId ? s : null;
  } catch (_) {
    return null;
  }
}

const DEFERRED_KEY = 'mw-idp-answer';

async function openAnswer(win, res, cryptoApi) {
  const rec = await takePending(win, res.requestId, cryptoApi);
  if (!rec) throw clientError('E_BAD_REQUEST', 'this answer belongs to no sign-in started here');
  if ((Date.now() - (rec.t || 0)) > PENDING_TTL_MS) throw clientError('E_USER_CANCELLED', 'the sign-in took too long');
  if (!validateResponse(res, rec.requestId)) throw clientError('E_BAD_REQUEST', 'the identity page sent a malformed answer');
  const out = await finishAnswer(res, { origin: win.location.origin, requestId: rec.requestId, privateKey: rec.privateKey, cryptoApi });
  out.returnTo = rec.returnTo;
  return out;
}

/**
 * completeRedirect({ win, cryptoApi, defer }) -> { bundle?, proof?, record?, erased?, returnTo } | { deferred, returnTo } | null
 * Call it on /_mw/idp-return: it reads and removes the fragment at once, finds the pending request by its
 * requestId and opens the answer with that request's page key. null when the fragment holds no answer.
 * defer: true (drop-in mode, where /_mw/idp-return is a page of its own): the still-encrypted answer is kept in
 * this tab's sessionStorage and the page at returnTo opens it with takeDeferredAnswer(); an answer carrying a
 * proof is never kept there (MF-14) and is refused with E_POPUP_BLOCKED.
 */
export async function completeRedirect({ win: w, cryptoApi, defer = false } = {}) {
  const win = w || (typeof window !== 'undefined' ? window : null);
  if (!win || !win.location) return null;
  const hash = String(win.location.hash || '').replace(/^#/, '');
  try {
    if (win.history && typeof win.history.replaceState === 'function') win.history.replaceState(null, '', win.location.pathname);
  } catch (_) {
    // the fragment stays; it holds nothing a site could not already see
  }
  const res = decodeFragment(hash);
  if (!plainObject(res) || typeof res.requestId !== 'string') return null;
  if (!defer) return openAnswer(win, res, cryptoApi);
  if (res.proof !== undefined) {
    await takePending(win, res.requestId, cryptoApi);
    throw clientError('E_POPUP_BLOCKED', 'a signed statement cannot travel back through this page; allow the sign-in window instead');
  }
  const rec = await peekPending(win, res.requestId);
  if (!rec || !validateResponse(res, res.requestId)) throw clientError('E_BAD_REQUEST', 'this answer belongs to no sign-in started here');
  if (!win.sessionStorage) throw clientError('E_UNSUPPORTED', 'this browser cannot hand the answer back to the page');
  win.sessionStorage.setItem(DEFERRED_KEY, JSON.stringify(res));
  return { deferred: true, returnTo: rec.returnTo };
}

/** takeDeferredAnswer({ win, cryptoApi }) -> the opened answer (as completeRedirect) or null; the stash is removed. */
export async function takeDeferredAnswer({ win: w, cryptoApi } = {}) {
  const win = w || (typeof window !== 'undefined' ? window : null);
  if (!win || !win.sessionStorage) return null;
  let res = null;
  try {
    res = JSON.parse(win.sessionStorage.getItem(DEFERRED_KEY) || 'null');
  } catch (_) {
    res = null;
  }
  try { win.sessionStorage.removeItem(DEFERRED_KEY); } catch (_) { /* ignore */ }
  if (!plainObject(res) || typeof res.requestId !== 'string') return null;
  return openAnswer(win, res, cryptoApi);
}

// ---------------------------------------------------------------------------------------------
// The identity page itself (settings, recovery kit, device link)
// ---------------------------------------------------------------------------------------------

/**
 * openIdentity({ intent, idp, win, pollMs }) -> 'done' | 'cancelled'. intent: 'kit' | 'backup' |
 * undefined (a fragment hint the IdO reads; it changes nothing by itself). E_POPUP_BLOCKED outside a click.
 */
export function openIdentity(opts = {}) {
  let win;
  try {
    win = windowOf(opts);
  } catch (err) {
    return Promise.reject(err);
  }
  const idp = resolveIdp({ idp: opts.idp, doc: win.document, pointer: opts.pointer, trustPointer: opts.trustPointer });
  if (!idp) return Promise.reject(clientError('E_IDP_UNREACHABLE', 'no identity page is configured for this site'));
  // Review round PHISH-4, PHISH-5: a site never opens the restore or device-link screens (the identity page refuses them in a
  // window a site opened); the kit and the backup file stay.
  const intent = ['kit', 'backup'].indexOf(opts.intent) >= 0 ? '#' + opts.intent : '';
  let w = null;
  try {
    w = withoutReferrer(win, () => win.open(idp + '/' + intent, 'mw-idp-home', 'popup,width=480,height=720'));
  } catch (_) {
    w = null;
  }
  if (!w) return Promise.reject(clientError('E_POPUP_BLOCKED', 'the browser blocked the identity window; call this from a click'));
  const setT = opts.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = () => {
      let closed = false;
      try { closed = w.closed === true; } catch (_) { closed = false; }
      if (closed) resolve(Date.now() - started > 1500 ? 'done' : 'cancelled');
      else setT(poll, opts.pollMs || 500);
    };
    setT(poll, opts.pollMs || 500);
  });
}
