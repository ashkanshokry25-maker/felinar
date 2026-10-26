// Pointer record v1 (ARCHITECTURE §4): parse, format, sign, verify, ledger id, hub label, and the
// DNS TXT helpers. Shared by Node >= 22 (tools) and browsers (loader): crypto.subtle,
// TextEncoder and Uint8Array only (no Buffer, no node: imports).
//
// Grammar: split on ';', trim each part, split at the first '=', lowercase the key (ASCII
// [A-Za-z0-9][A-Za-z0-9._-]*), trim the value and keep it verbatim. Repeatable keys: tr, ws, xs.
// Unknown keys are kept in `extra` and signed. Only `dn` is percent-decoded (for display).
// Control characters inside a value are refused: they would make the newline-joined signing
// input ambiguous.
//
// Signing input (UTF-8): "mw-pointer-v1\n" + every pair except sig as "key=value" (value as it
// appears on the wire), sorted by key then value (UTF-16 code unit order, identical to byte order
// for the ASCII that formatPointer emits), joined by "\n", then "\n" + scope.
//
// Records keep the parsed wire pairs in `record.pairs`; signingInput/formatPointer use them as long
// as the record's fields still match them, and otherwise re-encode the fields (so a record whose
// fields were edited is signed and printed consistently).
//
// v0.2.1 (DIGEST-AMENDMENTS A2, A3): the grammar is the profile MW-PTR/1 (INTERFACES): owner= is an
// algorithm-tagged key ('p256:...'); st= is the status key with FAIL-CLOSED semantics: absent or
// 'ok' means active, ANY other value (canonical: 'withdrawn') means the scope is withdrawn, so a
// loader stops serving and seeding it and clears every stored version. A withdrawal names no
// content (publish writes btih=0000...0 so loaders that predate st= fetch nothing); btih may be
// omitted from a withdrawn record and is then read as 40 zeros. why= (the owner's reason, shown to
// visitors, decoded for display like dn), aud= (the declared audience: a comma-separated token list,
// for example general, kids, sensitive, personal, eea, uk, qc; the loader's consent rules read it),
// ct= (abuse and legal contact URL) and lg= (privacy and terms URL) are parsed fields, and like
// every key they are signed. Size budget: SHOULD <= 450 bytes, MUST <= 900 bytes
// (POINTER_SIZE_SHOULD, POINTER_SIZE_MAX); a signed record is usually 2 or 3 TXT strings.
//
// v0.3 freeze fields (V03-DESIGN-REVIEW 2.5.3, MF-04, MF-28, SC-6; ARCHITECTURE 15.4), parsed, formatted
// and signed like every key: org= (repeatable, at most ORG_MAX, each an exact serialized origin such as
// https://shop.example or https://shop.example:8443), nx= (b64url sha256 of the UTF-8 next owner key
// string, nextKeyCommitment), ml= (minimum loader version, 'x.y.z') and idp= (suggested identity origin,
// an exact origin). A record with a malformed one, or more than ORG_MAX org=, does not parse
// ('bad-value'). verifyPointer({ previousRecord }) enforces nx= (see there). The rot= v1 input
// ("mw-rot-v1", not bound to a scope) is deleted (MF-28, PTR A5): only rot= v2 verifies.
//
// v0.3 C2 doors (docs/research/v03/S4-doors.md D2, D3): "the site lives at its key; domains are doors". dr= is one key whose value is
// a comma list of 1 to DOOR_MAX door hosts (lowercase host[:port], no scheme, path or userinfo; https on port 443 is implied, http for a
// loopback host): the guest doors the owner signs for a hub-scope ('btih:<hex>') record, so a record verifies on every door and a door
// cannot be stripped from it (removing one changes the signing input: bad-sig). record.dr is the array of hosts. A malformed dr= does
// not parse ('bad-value'), as org= does; a loader that predates dr= keeps it as an unknown key and signs it, so its verification is
// unchanged. parseDoors() merges the owner doors (org=), the guest doors (dr=) and a link's unsigned hints (#mwd=) into one list of at
// most DOORS_TOTAL_MAX. parseLinkFragment(), formatLightLink() and parseLightLink() read and write the light link:
// https://<door>/_mw/open.html#<record>[#mwgen=<blocks>][#mwd=<host>,<host>] and the same record behind web+felinar:.

import { b64url, utf8, hex, byteLength } from '../chain/canonical.js';
import { sha256, sign, verify, isPublicKeyString } from '../chain/crypto.js';
import { encode as base32Encode } from './base32.js';
import { normalizeBtih, parseMagnet, formatMagnet } from './magnet.js';

export const POINTER_VERSION = 'mw1';
export const SIGNING_PREFIX = 'mw-pointer-v1\n';
// v0.3 (MF-28): the v0.2.1 rot= input "mw-rot-v1\n" (not bound to a scope) is deleted; it is neither
// written nor verified, so the frozen vector ptr-010 now reports owner-changed (see ptr-023).
/** rot= input v2 (code review round 1): bound to the scope and the chain label. The only rot= input. */
export const ROTATION_PREFIX_V2 = 'mw-rot-v2\n';
/** v0.3: at most this many org= entries in one record. */
export const ORG_MAX = 4;
/** v0.3 C2 doors: at most this many hosts in dr= (the guest doors the owner signs). */
export const DOOR_MAX = 8;
/** v0.3 C2 doors: at most this many unsigned door hints (#mwd=) a link carries; the rest are ignored. */
export const HINT_MAX = 4;
/** v0.3 C2 doors: parseDoors() returns at most this many doors (owner, then guest, then hint). */
export const DOORS_TOTAL_MAX = 12;
/** v0.3 C2 doors: the reserved page of every loader build that shows any site by its link (resolveMode 'door'). */
export const DOOR_PAGE_PATH = '/_mw/open.html';
/** v0.3 C2 doors: the scheme of the protocol handler (door deployments only; desktop Chromium and Firefox). */
export const FELINAR_SCHEME = 'web+felinar:';
/** A fresh record may carry a seq at most this many seconds ahead of the verifier's clock (seq is Unix time by default). */
export const SEQ_FUTURE_MAX_S = 86400;
/** exp - now must be at most this many days (ARCHITECTURE §4). */
export const MAX_EXP_DAYS = 400;
/**
 * The longest validity the tools sign (code review round 1): one day under MAX_EXP_DAYS, so a
 * visitor whose clock lags the signer's never refuses a fresh record as exp-too-far.
 */
export const MAX_PUBLISH_EXP_DAYS = MAX_EXP_DAYS - 1;
/** publish --seq / --withdraw --seq: at most this many seconds ahead of the signer's clock. */
export const SEQ_PUBLISH_SLACK_S = 300;
/** publish.mjs default validity. */
export const DEFAULT_EXP_DAYS = 90;
/** The UI warns the owner when fewer days than this are left. */
export const EXP_WARN_DAYS = 14;
/** MW-PTR/1 size budget in UTF-8 bytes of the record text (v0.2.1 A3; IMPROVEMENTS-DIGEST D26). */
export const POINTER_SIZE_SHOULD = 450;
export const POINTER_SIZE_MAX = 900;
/** One DNS character-string holds at most this many bytes (splitTxt). */
export const TXT_STRING_MAX = 255;
/** The infohash a withdrawal carries: loaders that predate st= find nothing to fetch. */
export const ZERO_BTIH = '0'.repeat(40);
/** st= values publish emits: 'ok' (or no st=) is active; anything else is withdrawn (fail closed). */
export const STATUS_OK = 'ok';
export const STATUS_WITHDRAWN = 'withdrawn';
/**
 * aud= content classes (w2b-06 R14). aud= is a token list: these three, plus audience tokens the
 * loader's consent default reads (personal, eea, eu, uk, qc, quebec: CONFIG.consent.gateAudiences).
 */
export const AUDIENCES = Object.freeze(['general', 'kids', 'sensitive']);
/** Reason codes publish --withdraw suggests for why= (free text is allowed and shown as text). */
export const WHY_CODES = Object.freeze(['owner', 'copyright', 'court', 'tos']);

const DAY_MS = 86400 * 1000;
/** Clock-skew margin of the exp-too-far check (code review round 1: a visitor whose clock lags must still accept a 400-day record). */
const EXP_SKEW_MS = DAY_MS;
const REPEATABLE = new Set(['tr', 'ws', 'xs', 'org']);
const SINGLE = new Set(['v', 'st', 'btih', 'dn', 'chain', 'max', 'owner', 'lo', 'gen', 'rot', 'cs', 'consent', 'aud', 'ct', 'lg', 'why', 'nx', 'ml', 'idp', 'dr', 'seq', 'exp', 'sig']);
const UINT_KEYS = new Set(['max', 'seq', 'exp']);
/** Keys decoded for display (percent-encoded like encodeURIComponent on the wire). */
const TEXT_KEYS = new Set(['dn', 'why']);
/** Named in v0.2.1: a record built earlier may still carry them in `extra`; they are read from there too. */
const LATE_FIELDS = ['st', 'aud', 'ct', 'lg', 'why', 'lo', 'nx', 'ml', 'idp'];
/** List fields a record built before they were named may carry in extra (org= since v0.3, dr= since v0.3 C2). */
const LATE_LISTS = ['org', 'dr'];
const STRING_FIELDS = ['v', 'st', 'btih', 'dn', 'chain', 'owner', 'lo', 'gen', 'rot', 'cs', 'consent', 'aud', 'ct', 'lg', 'why', 'nx', 'ml', 'idp', 'sig'];
const KEY_ORDER = ['v', 'st', 'btih', 'dn', 'xs', 'ws', 'tr', 'chain', 'max', 'owner', 'lo', 'gen', 'rot', 'cs', 'consent', 'aud', 'ct', 'lg', 'why', 'org', 'dr', 'nx', 'ml', 'idp', 'seq', 'exp'];
const RAW_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const KEY_RE = /^[a-z0-9][a-z0-9._-]*$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const HEX40_LOWER_RE = /^[0-9a-f]{40}$/;
const UINT_RE = /^(?:0|[1-9][0-9]{0,15})$/;
const NX_RE = /^[A-Za-z0-9_-]{43}$/;
const ML_RE = /^(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,4})\.(?:0|[1-9][0-9]{0,5})$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const DOOR_HOST_CHARS_RE = /^[a-z0-9.:[\]-]+$/;
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

const textEncoder = new TextEncoder();
const lenientDecoder = new TextDecoder('utf-8', { ignoreBOM: true });

// ---------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------

function isUint(n) {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

function parseUint(str) {
  if (!UINT_RE.test(str)) return null;
  const n = Number(str);
  return Number.isSafeInteger(n) ? n : null;
}

function setOwn(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

const HEX_DIGITS = '0123456789ABCDEF';

// Percent-encodes the UTF-8 bytes of `str` except bytes for which keep(byte, index, isEdge) is true.
// TextEncoder turns lone surrogates into U+FFFD, so this never throws (encodeURIComponent would).
function percentEncode(str, keep) {
  const bytes = textEncoder.encode(str);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (keep(b, i === 0 || i === bytes.length - 1)) out += String.fromCharCode(b);
    else out += '%' + HEX_DIGITS[b >> 4] + HEX_DIGITS[b & 15];
  }
  return out;
}

// encodeURIComponent's unreserved set: A-Z a-z 0-9 - _ . ! ~ * ' ( )
function keepUnreserved(b) {
  return (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) ||
    b === 0x2d || b === 0x5f || b === 0x2e || b === 0x21 || b === 0x7e || b === 0x2a ||
    b === 0x27 || b === 0x28 || b === 0x29;
}

// Minimal encoding for values used verbatim (URLs, keys, labels): only what would break the
// grammar or the signing input, or make the record non-ASCII: controls, DEL, non-ASCII, ';',
// '"', and a space at either end (it would be trimmed). '%' and '=' are left alone, so URLs keep
// their meaning.
function keepMinimal(b, isEdge) {
  if (b < 0x20 || b > 0x7e) return false;
  if (b === 0x3b || b === 0x22) return false;
  if (b === 0x20 && isEdge) return false;
  return true;
}

/** The wire spelling formatPointer uses for one field value. */
function wireValue(key, value) {
  if (UINT_KEYS.has(key)) {
    if (!isUint(value)) {
      const n = typeof value === 'string' ? parseUint(value) : null;
      if (n === null) throw new TypeError('pointer: ' + key + ' must be a non-negative safe integer');
      return String(n);
    }
    return String(value);
  }
  if (typeof value !== 'string') throw new TypeError('pointer: ' + key + ' must be a string');
  if (TEXT_KEYS.has(key)) return percentEncode(value, keepUnreserved);
  return percentEncode(value, keepMinimal);
}

function decodeText(raw) {
  try {
    return decodeURIComponent(raw);
  } catch (_) {
    return raw;
  }
}

function emptyRecord(kind) {
  return {
    v: null, st: null, btih: null, dn: null, xs: [], ws: [], tr: [], chain: null, max: null, owner: null, lo: null,
    gen: null, rot: null, cs: null, consent: null, aud: null, ct: null, lg: null, why: null, org: [], dr: [], nx: null,
    ml: null, idp: null, seq: null, exp: null, sig: null, extra: {}, raw: '', signed: false, withdrawn: false, kind, pairs: null,
  };
}

/**
 * isOriginString(value) → true when value is an exact serialized origin (what URL.origin prints):
 * 'https://' + lowercase host + optional non-default port, no path, query, fragment, userinfo or
 * trailing slash. http is accepted only for loopback hosts (local development). v0.3 org= and idp=.
 */
export function isOriginString(value) {
  if (typeof value !== 'string' || !value) return false;
  let u;
  try {
    u = new URL(value);
  } catch (_) {
    return false;
  }
  if (u.origin !== value) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname);
}

/**
 * isDoorHost(value) → true for one door host as dr= and #mwd= name it: the exact host WHATWG URL prints for https://<value>/
 * (lowercase, IDN as its punycode A-label, no default port 443, no leading zeros), with no scheme, path, query, fragment or
 * userinfo, and either a DNS name of at least two labels, 'localhost' or a name under .localhost, an IPv4 literal or a bracketed
 * IPv6 literal, with an optional port. v0.3 C2 doors (S4 D2).
 */
export function isDoorHost(value) {
  if (typeof value !== 'string' || !value || value.length > 261 || !DOOR_HOST_CHARS_RE.test(value)) return false;
  let u;
  try {
    u = new URL('https://' + value + '/');
  } catch (_) {
    return false;
  }
  if (u.host !== value || u.username || u.password || u.pathname !== '/' || u.search || u.hash) return false;
  const h = u.hostname;
  if (h.charAt(0) === '[') return true; // an IPv6 literal, validated by the URL parser
  if (IPV4_RE.test(h)) return true; // a dotted IPv4 literal the URL parser printed itself
  if (h === 'localhost') return true;
  if (h.indexOf('.') < 0 || h.endsWith('.')) return false; // a single label is an intranet name
  return h.split('.').every((label) => DNS_LABEL_RE.test(label));
}

/** isLoopbackDoorHost(host) → true for localhost, a name under .localhost, 127.0.0.1 and [::1] (with or without a port). */
export function isLoopbackDoorHost(host) {
  if (!isDoorHost(host)) return false;
  const name = new URL('https://' + host + '/').hostname;
  return LOOPBACK_HOSTS.has(name) || name.endsWith('.localhost');
}

/** doorOrigin(host) → 'https://' + host, or 'http://' + host for a loopback host (local development); null for a bad host. */
export function doorOrigin(host) {
  if (!isDoorHost(host)) return null;
  return (isLoopbackDoorHost(host) ? 'http://' : 'https://') + host;
}

/** hostOfOrigin(origin) → the door host of an exact origin (org= and idp= values), or null. */
export function hostOfOrigin(origin) {
  if (!isOriginString(origin)) return null;
  const host = new URL(origin).host;
  return isDoorHost(host) ? host : null;
}

/** doorsOf(record) → the dr= hosts of a record (the parsed field, or extra.dr of a record built before dr= was named). */
export function doorsOf(record) {
  if (!record || typeof record !== 'object') return [];
  if (Array.isArray(record.dr) && record.dr.length) return record.dr.slice();
  const extra = record.extra && typeof record.extra === 'object' ? record.extra : null;
  if (extra && hasOwn(extra, 'dr') && typeof extra.dr === 'string') return extra.dr.split(',');
  return [];
}

/** isLoaderVersion(value) → true for 'x.y.z' (decimal, no leading zeros), the ml= syntax. */
export function isLoaderVersion(value) {
  return typeof value === 'string' && ML_RE.test(value);
}

/**
 * nextKeyCommitment(ownerKey) → Promise<string>: b64url(sha256(utf8(ownerKey))) (43 characters), the
 * nx= value that commits a record to its next owner key (v0.3, MF-28).
 */
export async function nextKeyCommitment(ownerKey) {
  if (!isPublicKeyString(ownerKey)) throw new TypeError('nextKeyCommitment: owner must be a tagged P-256 public key (p256:...)');
  return b64url.encode(await sha256(utf8.encode(ownerKey)));
}

// v0.3 freeze fields: null when fine, else the reason a record carrying them does not parse.
function freezeFieldError(r) {
  if (r.org.length > ORG_MAX) return 'at most ' + ORG_MAX + ' org= entries';
  for (const o of r.org) if (!isOriginString(o)) return 'org= must be an exact origin (https://host[:port])';
  if (new Set(r.org).size !== r.org.length) return 'org= entries must differ';
  if (r.nx !== null && !NX_RE.test(r.nx)) return 'nx= must be the b64url sha256 of the next owner key (43 characters)';
  if (r.ml !== null && !isLoaderVersion(r.ml)) return "ml= must be a loader version 'x.y.z'";
  if (r.idp !== null && !isOriginString(r.idp)) return 'idp= must be an exact origin (https://host[:port])';
  // v0.3 C2 doors: dr= is 1 to DOOR_MAX distinct door hosts.
  if (r.dr.length) {
    if (r.dr.length > DOOR_MAX) return 'at most ' + DOOR_MAX + ' hosts in dr=';
    for (const h of r.dr) if (!isDoorHost(h)) return 'dr= must be a comma list of lowercase hosts (host or host:port, no scheme or path)';
    if (new Set(r.dr).size !== r.dr.length) return 'dr= hosts must differ';
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// status (st=), audience (aud=), budget, withdrawal (v0.2.1 A3)
// ---------------------------------------------------------------------------------------------

function statusValue(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.st !== null && record.st !== undefined) return record.st;
  const extra = record.extra && typeof record.extra === 'object' ? record.extra : null;
  return extra && hasOwn(extra, 'st') ? extra.st : null;
}

/**
 * pointerStatus(record) → 'active' | 'withdrawn'. FAIL-CLOSED: no st= or st=ok is active; any
 * other value, an unknown one included (st=withdrawn, st=active, st=paused, a repeated st), is
 * withdrawn. code review round 1: a present but empty st= is withdrawn too (A3 allows only
 * absent or ok). Whether the record is authentic is verifyPointer's job.
 */
export function pointerStatus(record) {
  const st = statusValue(record);
  if (st === null || st === undefined) return 'active';
  return st === STATUS_OK ? 'active' : 'withdrawn';
}

/** isWithdrawn(record) → pointerStatus(record) === 'withdrawn'. */
export function isWithdrawn(record) {
  return pointerStatus(record) === 'withdrawn';
}

/**
 * audienceTokens(record) → the lowercase tokens of aud= (split on commas, whitespace, '+', '|', '/',
 * percent-decoded first), [] when absent. Read from extra too for records built before v0.2.1.
 * What a token means is the loader's consent policy (src/loader/consent.js consentModeFor, one table
 * since code review round 1): general is a content class with no effect; kids, sensitive, personal,
 * eea, eu, uk, qc and quebec make the consent gate the default (CONFIG.consent.gateAudiences).
 */
export function audienceTokens(record) {
  if (!record || typeof record !== 'object') return [];
  let raw = record.aud;
  if ((raw === null || raw === undefined || raw === '') && record.extra && typeof record.extra === 'object' && hasOwn(record.extra, 'aud')) raw = record.extra.aud;
  if (typeof raw !== 'string' || !raw) return [];
  return decodeText(raw).toLowerCase().split(/[\s,+|/]+/).filter(Boolean);
}

/**
 * pointerBudget(text) → { bytes, strings, should, max, withinShould, withinMax } for a record
 * text (or a record, formatted first): UTF-8 bytes, the number of DNS character-strings splitTxt
 * makes, and the MW-PTR/1 budget (SHOULD <= 450 bytes, MUST <= 900 bytes).
 */
export function pointerBudget(textOrRecord) {
  const text = typeof textOrRecord === 'string' ? textOrRecord : formatPointer(textOrRecord);
  const bytes = byteLength(text);
  return {
    bytes,
    strings: splitTxt(text).length,
    should: POINTER_SIZE_SHOULD,
    max: POINTER_SIZE_MAX,
    withinShould: bytes <= POINTER_SIZE_SHOULD,
    withinMax: bytes <= POINTER_SIZE_MAX,
  };
}

/**
 * withdrawalRecord({ owner, seq, exp, why, ct, chain, rot, lo, nx }) → an unsigned record for
 * signPointer: v=mw1; st=withdrawn; btih=<40 zeros> plus the owner key, seq (higher than the
 * record it replaces), exp, and optionally why= (shown to visitors), ct= (contact), chain= (keeps
 * the ledger id of a chain= site), rot=, lo= and nx= (v0.3: a site that committed a next key must
 * keep the same nx= in every record of the same owner, withdrawals included; see verifyPointer).
 * Nothing else: a withdrawal names no content.
 */
export function withdrawalRecord({ owner, seq, exp, why = null, ct = null, chain = null, rot = null, lo = null, nx = null } = {}) {
  if (!isPublicKeyString(owner)) throw new TypeError('withdrawalRecord: owner must be a tagged P-256 public key (p256:...)');
  if (!isUint(seq)) throw new TypeError('withdrawalRecord: seq must be a non-negative safe integer');
  if (!isUint(exp)) throw new TypeError('withdrawalRecord: exp must be a non-negative safe integer (unix seconds)');
  if (lo !== null && lo !== undefined && !isPublicKeyString(lo)) throw new TypeError('withdrawalRecord: lo must be a tagged P-256 public key (p256:...)');
  if (nx !== null && nx !== undefined && !(typeof nx === 'string' && NX_RE.test(nx))) throw new TypeError('withdrawalRecord: nx must be a next-key commitment (43 b64url characters)');
  for (const [k, val] of [['why', why], ['ct', ct], ['chain', chain], ['rot', rot]]) {
    if (val !== null && val !== undefined && typeof val !== 'string') throw new TypeError('withdrawalRecord: ' + k + ' must be a string');
  }
  const r = emptyRecord('pointer');
  r.v = POINTER_VERSION;
  r.st = STATUS_WITHDRAWN;
  r.btih = ZERO_BTIH;
  r.owner = owner;
  r.seq = seq;
  r.exp = exp;
  r.why = why || null;
  r.ct = ct || null;
  r.chain = chain || null;
  r.rot = rot || null;
  r.lo = lo && lo !== owner ? lo : null;
  r.nx = nx || null;
  r.withdrawn = true;
  return r;
}

function failure(error, detail) {
  return { ok: false, error, detail: detail || error };
}

// ---------------------------------------------------------------------------------------------
// parse
// ---------------------------------------------------------------------------------------------

function recordFromPairs(pairs, raw) {
  const r = emptyRecord('pointer');
  r.raw = raw;
  r.pairs = pairs;
  const seen = new Set();
  for (const [key, value] of pairs) {
    if (REPEATABLE.has(key)) {
      r[key].push(value);
    } else if (SINGLE.has(key)) {
      if (seen.has(key)) return failure('duplicate-key', 'duplicate key ' + key);
      seen.add(key);
      if (UINT_KEYS.has(key)) {
        const n = parseUint(value);
        if (n === null) return failure('bad-value', key + ' must be an unsigned decimal integer');
        r[key] = n;
      } else if (TEXT_KEYS.has(key)) {
        r[key] = decodeText(value);
      } else if (key === 'dr') {
        r.dr = value.split(','); // v0.3 C2 doors: checked in freezeFieldError ('' gives [''], a bad host)
      } else {
        r[key] = value;
      }
    } else if (hasOwn(r.extra, key)) {
      const prev = r.extra[key];
      r.extra[key] = Array.isArray(prev) ? prev.concat([value]) : [prev, value];
    } else {
      setOwn(r.extra, key, value);
    }
  }
  const freeze = freezeFieldError(r);
  if (freeze) return failure('bad-value', freeze);
  if (r.v === null) return failure('no-version', 'missing v=' + POINTER_VERSION);
  if (r.v !== POINTER_VERSION) return failure('unsupported-version', 'unsupported version ' + r.v);
  r.withdrawn = pointerStatus(r) === 'withdrawn';
  // Fail closed: a withdrawal parses even without btih (it names no content); read it as zeros.
  if (r.btih === null && r.withdrawn) r.btih = ZERO_BTIH;
  if (r.btih === null) return failure('no-btih', 'missing btih');
  if (!HEX40_LOWER_RE.test(r.btih)) return failure('bad-btih', 'btih must be 40 lowercase hex characters');
  r.signed = typeof r.sig === 'string' && r.sig.length > 0;
  return { ok: true, record: r };
}

function recordFromMagnet(m, raw) {
  const r = emptyRecord('magnet');
  r.raw = raw;
  r.btih = m.btih;
  r.dn = m.dn;
  r.tr = m.tr.slice();
  r.ws = m.ws.slice();
  r.xs = m.xs.slice();
  return { ok: true, record: r };
}

/**
 * parsePointer(text) → { ok: true, record } | { ok: false, error, detail }
 * record = { v, st, btih, dn, xs, ws, tr, chain, max, owner, gen, rot, cs, consent, aud, ct, lg,
 *            why, org, nx, ml, idp, seq, exp, sig, extra, raw, signed, withdrawn, kind: 'pointer'|'magnet', pairs }
 * org is an array (v0.3, at most ORG_MAX exact origins); nx, ml, idp are strings or null.
 * withdrawn = pointerStatus(record) === 'withdrawn' (fail closed: any st= other than 'ok'); a
 * withdrawn record without btih= gets btih = ZERO_BTIH. dn and why are percent-decoded.
 * Also accepts a bare magnet URI and a bare infohash (`btih:<hex>`, 40 hex or 32 base32
 * characters); those give unsigned records with kind 'magnet'. `extra[k]` is a string, or an
 * array of strings when an unknown key repeats. Errors: 'empty', 'malformed', 'duplicate-key',
 * 'bad-value', 'no-version', 'unsupported-version', 'no-btih', 'bad-btih', 'bad-magnet'.
 */
export function parsePointer(text) {
  if (typeof text !== 'string') return failure('empty');
  const raw = text.trim();
  if (!raw) return failure('empty');
  if (/^magnet:/i.test(raw)) {
    const m = parseMagnet(raw);
    return m ? recordFromMagnet(m, raw) : failure('bad-magnet', 'not a valid BitTorrent v1 magnet link');
  }
  if (raw.indexOf('=') < 0) {
    const btih = normalizeBtih(raw);
    if (btih) return recordFromMagnet({ btih, dn: null, tr: [], ws: [], xs: [] }, raw);
  }
  const pairs = [];
  const parts = raw.split(';');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim();
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq < 0) return failure('malformed', 'part ' + (i + 1) + " has no '='");
    const rawKey = part.slice(0, eq).trim();
    if (!RAW_KEY_RE.test(rawKey)) return failure('malformed', 'invalid key ' + JSON.stringify(rawKey));
    const value = part.slice(eq + 1).trim();
    if (CONTROL_RE.test(value)) return failure('malformed', 'control character in the value of ' + rawKey);
    pairs.push([rawKey.toLowerCase(), value]);
  }
  if (pairs.length === 0) return failure('empty');
  return recordFromPairs(pairs, raw);
}

// ---------------------------------------------------------------------------------------------
// wire pairs, signing input, format
// ---------------------------------------------------------------------------------------------

/** Wire pairs derived from the record's fields (sig excluded), in the canonical key order. */
function pairsFromFields(record) {
  const out = [];
  const addSingle = (key, value) => {
    if (value === null || value === undefined || value === '') return;
    out.push([key, wireValue(key, value)]);
  };
  const v = record.v === null || record.v === undefined || record.v === '' ? POINTER_VERSION : record.v;
  addSingle('v', v);
  const extra = record.extra && typeof record.extra === 'object' ? record.extra : {};
  const late = (key) => {
    const own = record[key];
    if (own !== null && own !== undefined && own !== '') return own;
    return hasOwn(extra, key) ? extra[key] : null;
  };
  // A present but empty st= is a withdrawal (fail closed, code review round 1): keep it on the wire.
  if (record.st === '') out.push(['st', '']);
  else addSingle('st', late('st'));
  const btih = typeof record.btih === 'string' ? (normalizeBtih(record.btih) || record.btih) : record.btih;
  addSingle('btih', btih);
  addSingle('dn', record.dn);
  for (const key of ['xs', 'ws', 'tr']) {
    const list = record[key];
    if (list === null || list === undefined) continue;
    if (!Array.isArray(list)) throw new TypeError('pointer: ' + key + ' must be an array');
    for (const value of list) {
      if (typeof value !== 'string') throw new TypeError('pointer: ' + key + ' entries must be strings');
      if (value !== '') out.push([key, wireValue(key, value)]);
    }
  }
  for (const key of ['chain', 'max', 'owner']) addSingle(key, record[key]);
  addSingle('lo', late('lo'));
  for (const key of ['gen', 'rot', 'cs', 'consent']) addSingle(key, record[key]);
  for (const key of ['aud', 'ct', 'lg', 'why']) addSingle(key, late(key));
  // v0.3: org= (repeatable; a record built before v0.3 may carry it in extra), nx=, ml=, idp=.
  const ownOrg = Array.isArray(record.org) && record.org.length > 0;
  const orgList = ownOrg ? record.org : (hasOwn(extra, 'org') ? [].concat(extra.org) : []);
  if (!Array.isArray(record.org) && record.org !== null && record.org !== undefined) throw new TypeError('pointer: org must be an array');
  for (const value of orgList) {
    if (typeof value !== 'string') throw new TypeError('pointer: org entries must be strings');
    if (value !== '') out.push(['org', wireValue('org', value)]);
  }
  // v0.3 C2 doors: dr= (one key, a comma list; a record built before dr= was named may carry it in extra).
  if (!Array.isArray(record.dr) && record.dr !== null && record.dr !== undefined) throw new TypeError('pointer: dr must be an array');
  const ownDr = Array.isArray(record.dr) && record.dr.length > 0;
  if (ownDr) {
    for (const value of record.dr) if (typeof value !== 'string' || !value) throw new TypeError('pointer: dr entries must be non-empty strings');
    out.push(['dr', wireValue('dr', record.dr.join(','))]);
  } else if (hasOwn(extra, 'dr')) {
    if (typeof extra.dr !== 'string') throw new TypeError('pointer: extra.dr must be a string');
    out.push(['dr', wireValue('dr', extra.dr)]);
  }
  for (const key of ['nx', 'ml', 'idp']) addSingle(key, late(key));
  for (const key of ['seq', 'exp']) addSingle(key, record[key]);
  for (const key of Object.keys(extra)) {
    if (key === 'org') {
      if (ownOrg) throw new TypeError('pointer: org is set both as a field and in extra');
      continue; // read above
    }
    if (key === 'dr') {
      if (ownDr) throw new TypeError('pointer: dr is set both as a field and in extra');
      continue; // read above
    }
    if (LATE_FIELDS.indexOf(key) >= 0) {
      const own = record[key];
      if (own === null || own === undefined || own === '') continue; // read above as the named field
      throw new TypeError('pointer: ' + key + ' is set both as a field and in extra');
    }
    if (!KEY_RE.test(key) || SINGLE.has(key) || REPEATABLE.has(key)) {
      throw new TypeError('pointer: invalid extra key ' + JSON.stringify(key));
    }
    const values = Array.isArray(extra[key]) ? extra[key] : [extra[key]];
    for (const value of values) {
      if (typeof value !== 'string') throw new TypeError('pointer: extra.' + key + ' must be a string');
      out.push([key, wireValue(key, value)]);
    }
  }
  return out;
}

function sameList(a, b) {
  const x = Array.isArray(a) ? a : [];
  const y = Array.isArray(b) ? b : [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

function norm(v) {
  return v === undefined || v === '' ? null : v;
}

function sameFields(a, b) {
  for (const key of STRING_FIELDS) if (norm(a[key]) !== norm(b[key])) return false;
  // A record built before v0.2.1 may carry st/aud/ct/lg/why in extra: let pairsFromFields re-encode.
  if (a.extra && typeof a.extra === 'object') for (const key of LATE_FIELDS.concat(LATE_LISTS)) if (hasOwn(a.extra, key)) return false;
  for (const key of ['max', 'seq', 'exp']) if (norm(a[key]) !== norm(b[key])) return false;
  for (const key of ['xs', 'ws', 'tr', 'org', 'dr']) if (!sameList(a[key], b[key])) return false;
  const ea = a.extra || {};
  const eb = b.extra || {};
  const ka = Object.keys(ea).sort();
  const kb = Object.keys(eb).sort();
  if (!sameList(ka, kb)) return false;
  for (const key of ka) {
    const va = Array.isArray(ea[key]) ? ea[key] : [ea[key]];
    const vb = Array.isArray(eb[key]) ? eb[key] : [eb[key]];
    if (!sameList(va, vb)) return false;
  }
  return true;
}

/** Wire pairs without sig: the parsed pairs while they still describe the fields, else re-encoded fields. */
function wirePairs(record) {
  if (!record || typeof record !== 'object') throw new TypeError('pointer: record must be an object');
  if (Array.isArray(record.pairs) && record.pairs.length > 0) {
    const reparsed = recordFromPairs(record.pairs, '');
    if (reparsed.ok && sameFields(reparsed.record, record)) return record.pairs.filter((p) => p[0] !== 'sig');
  }
  return pairsFromFields(record);
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedLines(pairs) {
  return pairs
    .slice()
    .sort((p, q) => compareStrings(p[0], q[0]) || compareStrings(p[1], q[1]))
    .map((p) => p[0] + '=' + p[1])
    .join('\n');
}

/**
 * normalizeScope(scope) → 'btih:<hex>' or the lowercase A-label hostname (WHATWG URL host
 * parsing: IDN to punycode, port and userinfo dropped, one trailing dot removed). Accepts a bare
 * host, a host:port, a full URL, or 'btih:<hex|base32>'. Throws TypeError when invalid.
 */
export function normalizeScope(scope) {
  if (typeof scope !== 'string' || !scope.trim()) throw new TypeError('pointer: scope must be a non-empty string');
  const s = scope.trim();
  const m = /^btih:(.*)$/i.exec(s);
  if (m) {
    const btih = normalizeBtih(m[1]);
    if (!btih) throw new TypeError('pointer: invalid btih scope ' + JSON.stringify(s));
    return 'btih:' + btih;
  }
  let host;
  try {
    host = new URL(s.indexOf('://') >= 0 ? s : 'https://' + s + '/').hostname;
  } catch (_) {
    throw new TypeError('pointer: invalid scope ' + JSON.stringify(s));
  }
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!host) throw new TypeError('pointer: invalid scope ' + JSON.stringify(s));
  return host;
}

/** signingInput(record, scope) → "mw-pointer-v1\n" + sorted "k=v" lines + "\n" + normalized scope. */
export function signingInput(record, scope) {
  return SIGNING_PREFIX + sortedLines(wirePairs(record)) + '\n' + normalizeScope(scope);
}

function keyRank(key) {
  if (key === 'sig') return KEY_ORDER.length + 1;
  const i = KEY_ORDER.indexOf(key);
  return i < 0 ? KEY_ORDER.length : i;
}

function formatPairs(pairs) {
  return pairs
    .map((p, i) => [p, i])
    .sort((a, b) => keyRank(a[0][0]) - keyRank(b[0][0]) || a[1] - b[1])
    .map(([p]) => p[0] + '=' + p[1])
    .join('; ');
}

/**
 * formatPointer(record) → 'v=mw1; btih=...; ...; sig=...' (canonical key order, unknown keys
 * before sig). Field values are percent-encoded only where needed: dn like
 * encodeURIComponent (it is decoded for display), every other value only for controls,
 * non-ASCII, ';', '"' and edge spaces. Works for magnet-kind records too (v defaults to mw1).
 */
export function formatPointer(record) {
  const pairs = wirePairs(record).slice();
  if (typeof record.sig === 'string' && record.sig) pairs.push(['sig', wireValue('sig', record.sig)]);
  return formatPairs(pairs);
}

/**
 * signPointer(record, scope, privateKey) → new signed record (the parse of its formatted text).
 * Requires record.owner (the tagged public key, 'p256:...', matching privateKey, checked by
 * verifying the fresh signature), record.seq and record.exp. The input record is not modified.
 */
export async function signPointer(record, scope, privateKey) {
  if (!record || typeof record !== 'object') throw new TypeError('signPointer: record must be an object');
  if (!isPublicKeyString(record.owner)) throw new TypeError('signPointer: record.owner must be a tagged P-256 public key (p256:...)');
  if (!isUint(record.seq)) throw new TypeError('signPointer: signed records require seq');
  if (!isUint(record.exp)) throw new TypeError('signPointer: signed records require exp');
  const base = Object.assign({}, record, { sig: null, signed: false, pairs: null });
  const pairs = pairsFromFields(base);
  const input = utf8.encode(SIGNING_PREFIX + sortedLines(pairs) + '\n' + normalizeScope(scope));
  const sig = b64url.encode(await sign(privateKey, input));
  if (!(await verify(record.owner, input, sig))) {
    throw new Error('signPointer: the private key does not match record.owner');
  }
  const parsed = parsePointer(formatPairs(pairs.concat([['sig', sig]])));
  if (!parsed.ok) throw new Error('signPointer: the signed record does not parse (' + parsed.detail + ')');
  return parsed.record;
}

/**
 * rotationInput(owner, seq, { scope, chain }) → "mw-rot-v2\n" + normalized scope + "\n" + (chain or '')
 * + "\n" + new owner + "\n" + seq (code review round 1). v0.3 (MF-28): the scope is required; the v1
 * input without it is deleted, so a call without a scope throws TypeError.
 */
export function rotationInput(owner, seq, binding) {
  if (!binding || binding.scope === undefined || binding.scope === null) {
    throw new TypeError('rotationInput: a scope is required (the rot= v1 input is deleted in v0.3)');
  }
  const chain = typeof binding.chain === 'string' ? binding.chain : '';
  return ROTATION_PREFIX_V2 + normalizeScope(binding.scope) + '\n' + chain + '\n' + owner + '\n' + seq;
}

/**
 * signRotation({ owner, seq, scope, chain }, previousPrivateKey) → b64url signature for the rot=
 * value (v2, bound to the scope and chain). v0.3: `scope` is required (TypeError without it).
 */
export async function signRotation({ owner, seq, scope = null, chain = null } = {}, previousPrivateKey) {
  if (!isPublicKeyString(owner)) throw new TypeError('signRotation: owner must be a tagged P-256 public key (p256:...)');
  if (!isUint(seq)) throw new TypeError('signRotation: seq must be a non-negative safe integer');
  if (scope === null || scope === undefined) throw new TypeError('signRotation: a scope is required (the rot= v1 input is deleted in v0.3)');
  return b64url.encode(await sign(previousPrivateKey, utf8.encode(rotationInput(owner, seq, { scope, chain }))));
}

/**
 * verifyRotation(record, previousOwner, scope) → true when record.rot is previousOwner's signature
 * over (scope, chain, owner, seq) (v2). v0.3 (MF-28, PTR A5): the v1 input is no longer accepted, and
 * without a scope nothing verifies (false).
 */
export async function verifyRotation(record, previousOwner, scope = null) {
  if (!record || typeof record.rot !== 'string' || !record.rot) return false;
  if (!isPublicKeyString(record.owner) || !isUint(record.seq) || !isPublicKeyString(previousOwner)) return false;
  if (scope === null || scope === undefined) return false;
  let input = null;
  try {
    input = rotationInput(record.owner, record.seq, { scope, chain: typeof record.chain === 'string' ? record.chain : '' });
  } catch (_) {
    return false;
  }
  return verify(previousOwner, utf8.encode(input), record.rot);
}

/**
 * pointerLineage(record, scope, { previousRecord, knownOwner, knownNx }) → Promise<'owner' | 'rot' | 'carried' | 'unproven' | 'unsigned'>
 * (review round R 5.3, PTR-1, PTR-2; MF-04). Whether a signed record has earned the ledger its lo= names:
 *   'owner'    no lo=, or lo= equals owner= (the ledger id is the signer's own);
 *   'rot'      rot= is lo='s signature over (scope, chain, owner, seq) (one step, as the identity origin checks);
 *   'carried'  previousRecord (the last record this device accepted for the scope) names the same ledger key (its lo=,
 *              or its owner= when it has none), has itself lineage 'owner' or 'rot', and this record continues it: the
 *              same owner, a rot= from its owner, or the owner its nx= committed to (a second rotation, on a device
 *              that saw the first); or knownOwner (the loader's per-ledger memory) is the owner, signed its rot=, or
 *              knownNx commits to the owner;
 *   'unproven' anything else: lo= is the signer's word only. ledgerIdFor/hubLabelFor still hash lo= (the format is
 *              unchanged), so a caller must not let such a record claim the ledger (hub label, keys, current site).
 * The record's own signature is verifyPointer's job; this reads only owner, lo, rot, seq, chain and nx.
 */
export async function pointerLineage(record, scope, { previousRecord = null, knownOwner = null, knownNx = null } = {}) {
  if (!isSignedRecord(record) || !isPublicKeyString(record.owner)) return 'unsigned';
  const lo = typeof record.lo === 'string' && record.lo ? record.lo : null;
  if (!lo || lo === record.owner) return 'owner';
  const s = normalizeScope(scope);
  if (await verifyRotation(record, lo, s)) return 'rot';
  // knownOwner / knownNx: the owner (and its nx=) this device last accepted WITH proven lineage for the same ledger id
  // (the loader's per-ledger memory); a record that continues it is carried, so a site rotated twice keeps working on
  // a device that followed it. A squat cannot use it: the memory names the real owner, whose key it does not hold.
  if (isPublicKeyString(knownOwner)) {
    if (knownOwner === record.owner || await verifyRotation(record, knownOwner, s)) return 'carried';
    if (typeof knownNx === 'string' && knownNx && (await nextKeyCommitment(record.owner)) === knownNx) return 'carried';
  }
  const prev = previousRecord && typeof previousRecord === 'object' && isSignedRecord(previousRecord) ? previousRecord : null;
  // The previous record's ledger key is its lo= or, without one, its owner= (the genesis owner's own record).
  const prevLo = prev && typeof prev.lo === 'string' && prev.lo ? prev.lo : (prev ? prev.owner : null);
  if (!prev || prevLo !== lo || !isPublicKeyString(prev.owner)) return 'unproven';
  const prevOwn = prev.owner === lo || await verifyRotation(prev, lo, s);
  if (!prevOwn) return 'unproven';
  if (prev.owner === record.owner) return 'carried';
  if (await verifyRotation(record, prev.owner, s)) return 'carried';
  if (typeof prev.nx === 'string' && prev.nx && (await nextKeyCommitment(record.owner)) === prev.nx) return 'carried';
  return 'unproven';
}

/** lineageProven(lineage) → true for 'owner', 'rot' and 'carried' (pointerLineage). */
export function lineageProven(lineage) {
  return lineage === 'owner' || lineage === 'rot' || lineage === 'carried';
}

/**
 * verifyPointer(record, scope, { now, pinnedOwner, cachedSeq, allowExpired }) →
 *   { ok, reason, expired, rotated, owner, pinned, expiresAt, status, withdrawn }
 * Checks, in order: 'no-btih', 'unsigned', 'bad-owner' (owner= must be a tagged P-256 key,
 * 'p256:...'), 'missing-exp', 'missing-seq', 'bad-sig', 'expired' (exp <= now; skipped with
 * allowExpired, which callers set for the cached last-known-good record only, then expired:
 * true), 'exp-too-far' (exp - now > 400 days plus a one-day clock margin), 'seq-future' (code review round 1:
 * a fresh record's seq more than SEQ_FUTURE_MAX_S ahead of now in seconds: one record must not set
 * an unbounded floor), 'owner-changed' (owner differs from pinnedOwner and no valid rot from it;
 * rotated: true when rot made the change silent), 'seq-rollback' (seq < cachedSeq; code review round 1: the
 * owner is judged first, so a new key without rot reports owner-changed and the TOFU prompt can
 * appear (a key change the visitor confirms starts a new floor: callers verify it again without
 * cachedSeq); a cachedSeq more than SEQ_FUTURE_MAX_S ahead of now is a poisoned floor and is
 * ignored, so one bad record cannot lock the scope for good). 'unsigned' is returned whatever pinnedOwner
 * says: callers must refuse unsigned records for a pinned scope (pinned: true tells them the
 * scope is pinned). Throws TypeError for a bad scope.
 * status/withdrawn (v0.2.1 A3) come from st= with fail-closed semantics (pointerStatus) and are
 * present on every result. A valid withdrawal is { ok: true, withdrawn: true }: never a failure,
 * because a caller that treated it as one would fall back to a cached version and keep serving
 * it. On ok + withdrawn the caller stops serving and seeding the scope and clears every stored
 * version (ARCHITECTURE 5.8).
 *
 * v0.3 (MF-28): `previousRecord` is the last record the caller accepted for this scope (verified
 * earlier; only its owner and nx fields are read). When it carries nx=:
 *   - a record with another owner key is accepted only if nextKeyCommitment(owner) equals that nx
 *     ('nx-mismatch' otherwise, even with a valid rot=: a stolen current key cannot move the site);
 *     when it matches, the change is silent (rotated: true) without any rot= (the committed key may be
 *     all the owner has left);
 *   - a record of the same owner must carry the same nx ('nx-changed' otherwise): the commitment is
 *     changed only by rotating to the committed key, or a thief holding the current key could first
 *     re-commit to a key of their own.
 * Every result carries nx: 'none' | 'match' | 'mismatch' | 'changed'. The v1 rot= input no longer
 * verifies (owner-changed).
 */
export async function verifyPointer(record, scope, { now = Date.now(), pinnedOwner = null, cachedSeq = null, allowExpired = false, previousRecord = null } = {}) {
  const owner = record && typeof record.owner === 'string' && record.owner ? record.owner : null;
  const expiresAt = record && isUint(record.exp) ? record.exp * 1000 : null;
  const status = pointerStatus(record);
  const out = (ok, reason, more) => Object.assign({
    ok, reason, expired: false, rotated: false, owner, pinned: Boolean(pinnedOwner), expiresAt, status, withdrawn: status === 'withdrawn', nx: 'none',
  }, more || {});
  const normalizedScope = normalizeScope(scope);
  if (!record || typeof record !== 'object' || typeof record.btih !== 'string' || !HEX40_LOWER_RE.test(record.btih)) {
    return out(false, 'no-btih');
  }
  if (typeof record.sig !== 'string' || !record.sig) return out(false, 'unsigned');
  if (!isPublicKeyString(owner)) return out(false, 'bad-owner');
  if (record.lo !== null && record.lo !== undefined && !isPublicKeyString(record.lo)) return out(false, 'bad-owner');
  if (record.exp === null || record.exp === undefined) return out(false, 'missing-exp');
  if (!isUint(record.exp)) return out(false, 'missing-exp');
  if (record.seq === null || record.seq === undefined) return out(false, 'missing-seq');
  if (!isUint(record.seq)) return out(false, 'missing-seq');
  let input;
  try {
    input = SIGNING_PREFIX + sortedLines(wirePairs(record)) + '\n' + normalizedScope;
  } catch (_) {
    return out(false, 'bad-sig');
  }
  if (!(await verify(owner, utf8.encode(input), record.sig))) return out(false, 'bad-sig');
  let expired = false;
  if (expiresAt <= now) {
    if (!allowExpired) return out(false, 'expired', { expired: true });
    expired = true;
  } else if (expiresAt - now > MAX_EXP_DAYS * DAY_MS + EXP_SKEW_MS) {
    return out(false, 'exp-too-far');
  }
  const nowS = Math.floor(now / 1000);
  if (!allowExpired && record.seq > nowS + SEQ_FUTURE_MAX_S) return out(false, 'seq-future');
  // v0.3 nx= (MF-28): judged before the pin, so a valid rot= from a stolen key does not help.
  let nx = 'none';
  const prev = previousRecord && typeof previousRecord === 'object' ? previousRecord : null;
  const prevNx = prev && typeof prev.nx === 'string' && prev.nx ? prev.nx : null;
  const prevOwner = prev && isPublicKeyString(prev.owner) ? prev.owner : null;
  if (prevNx && prevOwner) {
    if (prevOwner === owner) {
      if (record.nx !== prevNx) return out(false, 'nx-changed', { expired, nx: 'changed' });
    } else {
      if ((await nextKeyCommitment(owner)) !== prevNx) return out(false, 'nx-mismatch', { expired, nx: 'mismatch' });
      nx = 'match';
    }
  }
  let rotated = false;
  if (pinnedOwner && pinnedOwner !== owner) {
    if (nx === 'match' && prevOwner === pinnedOwner) rotated = true;
    else if (await verifyRotation(record, pinnedOwner, normalizedScope)) rotated = true;
    else return out(false, 'owner-changed', { expired, nx });
  } else if (nx === 'match') {
    rotated = true;
  }
  const floor = typeof cachedSeq === 'number' && Number.isFinite(cachedSeq) && cachedSeq <= nowS + SEQ_FUTURE_MAX_S ? cachedSeq : null;
  if (floor !== null && record.seq < floor) return out(false, 'seq-rollback', { expired, nx });
  return out(true, null, { expired, rotated, nx });
}

// ---------------------------------------------------------------------------------------------
// ledger id, hub label
// ---------------------------------------------------------------------------------------------

// A record counts as signed when it carries a signature and an owner key (whether that signature
// is valid is verifyPointer's job; callers only use records that passed it).
function isSignedRecord(record) {
  return Boolean(record && typeof record.sig === 'string' && record.sig && typeof record.owner === 'string' && record.owner);
}

/**
 * ledgerOwnerOf(record) → the key the ledger id is bound to: lo= (code review round 1, the ledger's genesis
 * owner, carried after a key rotation) or else owner=.
 */
export function ledgerOwnerOf(record) {
  if (!record) return null;
  if (typeof record.lo === 'string' && record.lo) return record.lo;
  return typeof record.owner === 'string' && record.owner ? record.owner : null;
}

/**
 * ledgerIdFor(record, scope) → Promise<string>
 * signed: "mw1:" + b64url(sha256(utf8(ledgerOwner + "|" + (chain || normalizedScope)))).slice(0, 27)
 * with ledgerOwner = lo= when present, else owner= (code review round 1: after a key
 * rotation the pointer carries lo=<genesis owner>, so the ledger id, its IndexedDB database, its
 * rendezvous swarm and its genesis stay the same; the owner in effect is then checked through rot=
 * and the ledger's own succession chain);
 * unsigned: "btih:" + btih (chain is ignored, the ledger is unmoderated).
 */
export async function ledgerIdFor(record, scope) {
  if (isSignedRecord(record)) {
    const label = record.chain ? record.chain : normalizeScope(scope);
    const digest = await sha256(utf8.encode(ledgerOwnerOf(record) + '|' + label));
    return 'mw1:' + b64url.encode(digest).slice(0, 27);
  }
  const btih = normalizeBtih(record && record.btih);
  if (!btih) throw new TypeError('ledgerIdFor: record has no btih');
  return 'btih:' + btih;
}

export const HUB_LABEL_PREFIX = 'mw-label-v1\n';

/**
 * hubLabelFor(record, ledgerId) → 32 characters [a-z2-7]:
 *   base32(sha256(utf8("mw-label-v1\n" + kind + "\n" + id))).slice(0, 32)
 * kind 'ledger' with id = ledgerId for signed records, kind 'btih' with id = the 40-hex btih for
 * unsigned ones (bare magnets). code review round 1: the two label sets are disjoint, so no
 * unsigned record can claim a signed site's subdomain (v0.2 gave unsigned records base32(btih), the
 * same 160-bit space as a signed label: anyone could pick the btih that decodes from a label).
 */
export function hubLabelFor(record, ledgerId) {
  let kind;
  let id;
  if (isSignedRecord(record)) {
    if (typeof ledgerId !== 'string' || !ledgerId) throw new TypeError('hubLabelFor: a signed record needs its ledger id');
    kind = 'ledger';
    id = ledgerId;
  } else {
    let btih = normalizeBtih(record && record.btih);
    if (!btih && typeof ledgerId === 'string' && ledgerId.startsWith('btih:')) btih = normalizeBtih(ledgerId.slice(5));
    if (!btih) throw new TypeError('hubLabelFor: record has no btih');
    kind = 'btih';
    id = btih;
  }
  return base32Encode(sha256Sync(textEncoder.encode(HUB_LABEL_PREFIX + kind + '\n' + id))).slice(0, 32);
}

// ---------------------------------------------------------------------------------------------
// DNS TXT helpers
// ---------------------------------------------------------------------------------------------

/**
 * splitTxt(value) → string[]: consecutive chunks of at most 255 UTF-8 bytes each (one DNS
 * character-string per chunk), never splitting a code point. '' → [''].
 */
export function splitTxt(value) {
  const s = String(value);
  const chunks = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4; // lone surrogates encode as U+FFFD (3)
    if (curBytes + n > 255) {
      chunks.push(cur);
      cur = '';
      curBytes = 0;
    }
    cur += ch;
    curBytes += n;
  }
  chunks.push(cur);
  return chunks;
}

function isDigit(c) {
  return c >= '0' && c <= '9';
}

/**
 * joinTxtData(data) → string: one TXT record's `data` from a DoH JSON answer.
 * Cloudflare (and AdGuard) send RFC 1035 presentation format: each character-string quoted,
 * separated by spaces, with \" \\ and \DDD (decimal byte) escapes; those strings are decoded to
 * bytes and joined with NO separator, then read as UTF-8. Google and dns.sb send the strings
 * already joined and unquoted; anything that is not a clean sequence of quoted strings is
 * returned unchanged.
 */
export function joinTxtData(data) {
  if (typeof data !== 'string') return '';
  const n = data.length;
  if (n < 2 || data[0] !== '"' || data[n - 1] !== '"') return data;
  const bytes = [];
  const pushChar = (ch) => {
    const enc = textEncoder.encode(ch);
    for (let k = 0; k < enc.length; k++) bytes.push(enc[k]);
  };
  let i = 0;
  while (i < n) {
    while (i < n && (data[i] === ' ' || data[i] === '\t')) i++;
    if (i >= n) break;
    if (data[i] !== '"') return data;
    i++;
    while (i < n && data[i] !== '"') {
      if (data[i] === '\\') {
        i++;
        if (i >= n) return data;
        if (isDigit(data[i]) && isDigit(data[i + 1] || '') && isDigit(data[i + 2] || '')) {
          const value = Number(data.slice(i, i + 3));
          if (value > 255) return data;
          bytes.push(value);
          i += 3;
          continue;
        }
      }
      const cp = data.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      pushChar(ch);
      i += ch.length;
    }
    if (i >= n) return data; // unterminated string
    i++; // closing quote
  }
  return lenientDecoder.decode(new Uint8Array(bytes));
}

// ---------------------------------------------------------------------------------------------
// choosing and using records
// ---------------------------------------------------------------------------------------------

function candidateOf(item) {
  if (item && typeof item === 'object' && hasOwn(item, 'ok') && hasOwn(item, 'record')) {
    return item.ok ? item.record : null;
  }
  return item;
}

// > 0 when a beats b: signed beats unsigned, then the higher seq, then the smaller sig, then the
// smaller formatted text (so the choice never depends on RRset order).
function compareCandidates(a, b) {
  const sa = isSignedRecord(a);
  const sb = isSignedRecord(b);
  if (sa !== sb) return sa ? 1 : -1;
  const qa = sa && isUint(a.seq) ? a.seq : -1;
  const qb = sb && isUint(b.seq) ? b.seq : -1;
  if (qa !== qb) return qa > qb ? 1 : -1;
  const ga = typeof a.sig === 'string' ? a.sig : '';
  const gb = typeof b.sig === 'string' ? b.sig : '';
  if (ga !== gb) return ga < gb ? 1 : -1;
  const ta = typeof a.raw === 'string' ? a.raw : '';
  const tb = typeof b.raw === 'string' ? b.raw : '';
  if (ta !== tb) return ta < tb ? 1 : -1;
  return 0;
}

/**
 * pickRecord(records) → record | null. Among records (or parse results) that the caller has
 * already verified, picks the highest seq, ties to the smallest sig; signed records rank above
 * unsigned ones. Entries without a valid btih and failed parse results are ignored. This does
 * not verify signatures.
 */
export function pickRecord(records) {
  if (!Array.isArray(records)) return null;
  let best = null;
  for (const item of records) {
    const record = candidateOf(item);
    if (!record || typeof record !== 'object' || !normalizeBtih(record.btih)) continue;
    if (best === null || compareCandidates(record, best) > 0) best = record;
  }
  return best;
}

/**
 * magnetFromRecord(record, { defaultTrackers = [], base = null }) → magnet URI with xt, dn,
 * tr..., ws..., xs.... A signed record's tr list is used exactly; defaultTrackers are appended
 * only for unsigned records and bare magnets. With `base`, relative ws/xs URLs (drop-in
 * pointers use /_mw/t/...) are resolved against it. A withdrawn record (st= other than 'ok')
 * has no magnet: Error code 'E_WITHDRAWN' (fail closed).
 */
export function magnetFromRecord(record, { defaultTrackers = [], base = null } = {}) {
  if (!record || typeof record !== 'object') throw new TypeError('magnetFromRecord: record must be an object');
  if (isWithdrawn(record)) {
    const err = new Error('magnetFromRecord: the pointer withdraws this site (st=' + statusValue(record) + ')');
    err.code = 'E_WITHDRAWN';
    throw err;
  }
  const own = Array.isArray(record.tr) ? record.tr : [];
  const tr = isSignedRecord(record) ? own : own.concat(Array.isArray(defaultTrackers) ? defaultTrackers : []);
  const resolve = (url) => {
    if (!base) return url;
    try {
      return new URL(url, base).href;
    } catch (_) {
      return url;
    }
  };
  return formatMagnet({
    btih: record.btih,
    dn: record.dn,
    tr,
    ws: (Array.isArray(record.ws) ? record.ws : []).map(resolve),
    xs: (Array.isArray(record.xs) ? record.xs : []).map(resolve),
  });
}

// ---------------------------------------------------------------------------------------------
// v0.3 C2 doors: the door list of a record, the link fragment, the light link (S4-doors.md D2, D3)
// ---------------------------------------------------------------------------------------------

/**
 * parseDoors(record, hints = []) → { owner, guest, hints, all }: the hosts a record names as doors. owner = the hosts of its
 * org= origins (full mode, shared identity label), guest = its dr= hosts (signed by the owner), hints = the link's unsigned #mwd=
 * hosts (at most HINT_MAX, tried last, only for bytes that are hash-checked). A host appears once, in the first class that names it;
 * hosts that are not door hosts are dropped; at most DOORS_TOTAL_MAX in all. all = [{ host, kind: 'owner'|'guest'|'hint', origin }]
 * in that order. A record that is not a pointer gives only the hints.
 */
export function parseDoors(record, hints = []) {
  const seen = new Set();
  const out = { owner: [], guest: [], hints: [], all: [] };
  const add = (list, host, kind) => {
    if (out.all.length >= DOORS_TOTAL_MAX || typeof host !== 'string' || !isDoorHost(host) || seen.has(host)) return;
    seen.add(host);
    list.push(host);
    out.all.push({ host, kind, origin: doorOrigin(host) });
  };
  if (record && typeof record === 'object') {
    const extra = record.extra && typeof record.extra === 'object' ? record.extra : {};
    const orgs = Array.isArray(record.org) && record.org.length ? record.org : (hasOwn(extra, 'org') ? [].concat(extra.org) : []);
    for (const origin of orgs.slice(0, ORG_MAX)) add(out.owner, hostOfOrigin(origin), 'owner');
    for (const host of doorsOf(record).slice(0, DOOR_MAX)) add(out.guest, host, 'guest');
  }
  const list = Array.isArray(hints) ? hints : [];
  for (const host of list.slice(0, HINT_MAX)) add(out.hints, typeof host === 'string' ? host.trim().toLowerCase() : null, 'hint');
  return out;
}

/** parseHintList(value) → the door hosts of a #mwd= value (a comma list): lowercase, distinct, at most HINT_MAX; others ignored. */
export function parseHintList(value) {
  if (typeof value !== 'string' || !value) return [];
  const out = [];
  for (const raw of value.split(',')) {
    if (out.length >= HINT_MAX) break;
    const host = decodeText(raw).trim().toLowerCase();
    if (isDoorHost(host) && out.indexOf(host) < 0) out.push(host);
  }
  return out;
}

const FELINAR_PREFIX_RE = /^web(?:\+|%2b)felinar(?::|%3a)/i;
const FELINAR_ENCODED_PREFIX_RE = /^web%2bfelinar%3a/i;
const ENCODED_HEAD_RE = /^(?:v%3d|magnet%3a|btih%3a|host%3a)/i;
const SEGMENT_NAME_RE = /^[a-z][a-z0-9]{0,15}$/;

/**
 * normalizeRecordText(text) → a record text that arrived literally in a URL fragment, ready for parsePointer: the browser wrote the
 * spaces after each ';' as %20, so leading %20 (and spaces) of every part are removed. Nothing else is touched: a %20 inside a
 * value (dn=My%20Site) is part of what the owner signed. (The loaders before C2 replaced every %20, which broke such values.)
 */
export function normalizeRecordText(text) {
  if (typeof text !== 'string') return '';
  return text.split(';').map((part) => part.replace(/^(?:%20|\s)+/i, '')).join('; ').trim();
}

/**
 * parseLinkFragment(fragment) → { head, decoded, handler, segments, hints, genesis } for the part of a URL after '#':
 *   - a web+felinar: prefix (literal, or percent-encoded by a protocol handler's %s) is removed; when it was encoded, the rest is
 *     decoded once (the browser escaped the whole link);
 *   - the text is split at each literal '#': the first part is the head (the pointer), each later part a segment name=value
 *     (the first of a name wins; names are lowercase letters and digits);
 *   - a head in an encoded form (v%3D..., magnet%3A..., btih%3A..., host%3A...) is decoded once (decoded: true); a literal head is
 *     left as it is (callers normalize a literal record with normalizeRecordText);
 *   - hints = the #mwd= hosts (parseHintList), genesis = the raw 'mwgen=...' segment text or null (decodeGenesis reads it).
 * Pure; never throws.
 */
export function parseLinkFragment(fragment) {
  let text = typeof fragment === 'string' ? fragment.replace(/^#/, '') : '';
  let handler = false;
  const prefix = FELINAR_PREFIX_RE.exec(text);
  if (prefix) {
    handler = true;
    const encoded = FELINAR_ENCODED_PREFIX_RE.test(text);
    text = text.slice(prefix[0].length);
    if (encoded) text = decodeText(text);
  }
  const parts = text.split('#');
  let head = parts[0].trim();
  let decoded = false;
  if (ENCODED_HEAD_RE.test(head)) {
    head = decodeText(head).trim();
    decoded = true;
  }
  const segments = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim().toLowerCase();
    if (!SEGMENT_NAME_RE.test(name) || hasOwn(segments, name)) continue;
    setOwn(segments, name, part.slice(eq + 1).trim());
  }
  return {
    head,
    decoded,
    handler,
    segments,
    hints: parseHintList(segments.mwd),
    genesis: hasOwn(segments, 'mwgen') ? 'mwgen=' + segments.mwgen : null,
  };
}

// Characters a browser re-encodes in a fragment, and '#', which separates the segments: a record holding one cannot travel in a link.
const LINK_UNSAFE_RE = /[#<>`"\u0000-\u001f\u007f]/;

/**
 * formatLightLink({ door, record, genesis, hints }) → the light link (S4 D2): 'https://<door>/_mw/open.html#' + the record text
 * percent-encoded once (encodeURIComponent, so every value arrives exactly as signed) + '#mwgen=<b64url>' when genesis is given (the
 * text after 'mwgen=', or the whole 'mwgen=...' segment) + '#mwd=<host>,<host>' for the hints (at most HINT_MAX door hosts). With
 * door null it is the protocol-handler form 'web+felinar:<encoded record>[#...]'. record is a record object (formatted here) or its
 * text. A loopback door gets http://. Throws TypeError for a bad door host, an empty record, or a record text holding '#', '<', '>',
 * '`', '"' or a control character (a browser would rewrite it in the fragment and the signature would fail).
 */
export function formatLightLink({ door = null, record, genesis = null, hints = [] } = {}) {
  const text = typeof record === 'string' ? record.trim() : (record && typeof record === 'object' ? formatPointer(record) : '');
  if (!text) throw new TypeError('formatLightLink: a record (object or text) is required');
  if (LINK_UNSAFE_RE.test(text)) throw new TypeError("formatLightLink: the record holds a character that cannot travel in a link fragment ('#', '<', '>', '`', '\"' or a control character)");
  let base;
  if (door === null || door === undefined || door === '') {
    base = FELINAR_SCHEME;
  } else {
    const origin = doorOrigin(door);
    if (!origin) throw new TypeError('formatLightLink: ' + JSON.stringify(door) + ' is not a door host (lowercase host or host:port, no scheme or path)');
    base = origin + DOOR_PAGE_PATH + '#';
  }
  let url = base + encodeURIComponent(text);
  if (genesis) {
    const g = String(genesis).replace(/^mwgen=/, '');
    if (!/^[A-Za-z0-9_-]+$/.test(g)) throw new TypeError('formatLightLink: genesis must be the base64url text of an mwgen= segment');
    url += '#mwgen=' + g;
  }
  const list = [];
  for (const h of Array.isArray(hints) ? hints : []) {
    if (list.length >= HINT_MAX) break;
    if (!isDoorHost(h)) throw new TypeError('formatLightLink: hint ' + JSON.stringify(h) + ' is not a door host');
    if (list.indexOf(h) < 0) list.push(h);
  }
  if (list.length) url += '#mwd=' + list.join(',');
  return url;
}

/**
 * parseLightLink(link) → { ok: true, door, origin, path, record, decoded, handler, hints, genesis } | { ok: false, error }.
 * Accepts https://<door>/_mw/open.html#..., https://<door>/#... (a hub root) and web+felinar:... (door null). record is the pointer
 * text ready for parsePointer (decoded once when it was encoded, else with the fragment's separator spaces restored); the record is
 * not parsed or verified here. errors: 'empty', 'not-a-link', 'path' (another page than / or /_mw/open.html), 'no-record'.
 */
export function parseLightLink(link) {
  if (typeof link !== 'string' || !link.trim()) return { ok: false, error: 'empty' };
  const s = link.trim();
  let door = null;
  let origin = null;
  let path = null;
  let fragment;
  if (FELINAR_PREFIX_RE.test(s) && !/^https?:/i.test(s)) {
    fragment = s;
  } else {
    let u;
    try {
      u = new URL(s);
    } catch (_) {
      return { ok: false, error: 'not-a-link' };
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'not-a-link' };
    if (u.pathname !== '/' && u.pathname !== DOOR_PAGE_PATH) return { ok: false, error: 'path' };
    door = u.host;
    origin = u.origin;
    path = u.pathname;
    fragment = u.hash;
  }
  const f = parseLinkFragment(fragment);
  const record = f.decoded ? f.head : normalizeRecordText(f.head);
  if (!record) return { ok: false, error: 'no-record' };
  return { ok: true, door, origin, path, record, decoded: f.decoded, handler: f.handler, hints: f.hints, genesis: f.genesis };
}

// ---------------------------------------------------------------------------------------------
// synchronous SHA-256 (FIPS 180-4), only for hubLabelFor, which INTERFACES keeps synchronous
// ---------------------------------------------------------------------------------------------

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Sync(bytes) {
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const len = bytes.length;
  const padded = new Uint8Array(Math.ceil((len + 9) / 64) * 64);
  padded.set(bytes);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  const bitLength = len * 8;
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  const W = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let t = 0; t < 16; t++) W[t] = view.getUint32(off + t * 4);
    for (let t = 16; t < 64; t++) {
      const x = W[t - 15];
      const y = W[t - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
    }
    let a = H[0]; let b = H[1]; let c = H[2]; let d = H[3];
    let e = H[4]; let f = H[5]; let g = H[6]; let h = H[7];
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[t] + W[t]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, H[i]);
  return out;
}

/** Exposed for tests only; production code should use crypto.sha256 (WebCrypto). */
export const _sha256SyncForTests = sha256Sync;
