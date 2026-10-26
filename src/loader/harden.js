// src/loader/harden.js: pure helpers the loader (src/loader/app.js) uses for the v0.3 hardening of its own
// state (V03-DESIGN-REVIEW MF-28, MF-30, MF-31, 2.16.4, 2.17.5; ARCHITECTURE 15.4). No DOM; browser globals
// are not read. Shared by Node >= 22 (tests) and browsers: crypto.subtle, TextEncoder and Uint8Array only.
//
//  - Signed pins and refusals: the loader's TOFU pins and the visitor's refusals of a key change are signed
//    by a per-device ECDSA P-256 key whose private half is non-extractable, so a stored pin or refusal that
//    same-origin code rewrote without that key fails verification. A refusal expires after 7 days.
//  - Withdrawals bind at most 30 days after they were signed (seq); owners re-sign them to keep a site
//    withdrawn, so an old withdrawal replayed to a device that was offline does not take a site down for good.
//  - isReadOnlyHubLedger: on a hub, ledgers without an owner (unsigned records, 'btih:' ledger ids) are
//    shown read-only: nobody can moderate them (HUB H10).
//  - rotationDecision: what to do with an owner key change, with the inputs of the "owner changed N minutes
//    ago" text; a rotation is delayed for first-time visitors unless nx= matches (MF-28).
//  - loaderFloorOk: the pointer's ml= floor (SC-6).
//  - parseHostFingerprintLink: '#host:name@<fp>' links carry the owner key fingerprint, so a first visit does
//    not have to trust DNS alone (PTR A3).
//  - pslHubCheck: a subdomain hub that is not on the Public Suffix List gets no persistent identity (PTR A8).
//  - clampTimerMs and clampTtlSeconds (from doh.js) for every timer armed from external data (MF-30).

import { CONFIG } from './config.js'
import { canonicalize, b64url, utf8 } from '../chain/canonical.js'
import { generateKeyPair, exportPublicKey, sign, verify, isPublicKeyString, sha256 } from '../chain/crypto.js'
import { normalizeScope, ledgerOwnerOf, nextKeyCommitment, isLoaderVersion } from '../common/pointer.js'
import { clampTimerMs, clampTtlSeconds, MAX_TIMER_MS, AD_WORDING } from './doh.js'

export { clampTimerMs, clampTtlSeconds, MAX_TIMER_MS, AD_WORDING }

const H = CONFIG.harden
/** Refusals of a key change expire after this long (7 days). */
export const REFUSAL_TTL_MS = H.refusalTtlMs
/** A withdrawal binds at most this long after it was signed (30 days). */
export const WITHDRAWAL_MAX_MS = H.withdrawalMaxMs
/** Owners re-sign a withdrawal when less than this is left (7 days, chosen). */
export const WITHDRAWAL_RESIGN_MARGIN_MS = H.withdrawalResignMarginMs
/** A rotation first seen without a pin waits this long unless nx= matches (24 h, chosen). */
export const ROTATION_DELAY_MS = H.rotationDelayMs
/** Signing inputs of the device-signed state (distinct prefixes, each ending in a newline). */
export const PIN_PREFIX = 'mw-pin-v1\n'
export const REFUSAL_PREFIX = 'mw-refusal-v1\n'

const MINUTE_MS = 60000
const FP_RE = /^[A-Za-z0-9_-]{16,43}$/

function isUint (n) { return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 }

// ---------------------------------------------------------------------------------------------
// device key, signed pins and refusals (MF-30)
// ---------------------------------------------------------------------------------------------

/**
 * createDeviceKey() → Promise<{ privateKey, publicKey, pub }>: a fresh ECDSA P-256 pair whose private key is
 * non-extractable (exportKey throws); pub is the tagged public key string. The caller stores the CryptoKey
 * objects in IndexedDB (structured clone keeps them non-extractable) and creates a new key when none is there.
 */
export async function createDeviceKey () {
  const { privateKey, publicKey } = await generateKeyPair({ extractable: false })
  return { privateKey, publicKey, pub: await exportPublicKey(publicKey) }
}

function body (obj) {
  const out = {}
  for (const k of Object.keys(obj)) if (k !== 'sig') out[k] = obj[k]
  return out
}

async function signObject (prefix, obj, privateKey) {
  const input = utf8.encode(prefix + canonicalize(obj))
  return b64url.encode(await sign(privateKey, input))
}

async function verifyObject (prefix, obj, pub) {
  if (!obj || typeof obj.sig !== 'string' || !obj.sig) return false
  let input
  try { input = utf8.encode(prefix + canonicalize(body(obj))) } catch (_) { return false }
  return verify(pub, input, obj.sig)
}

/**
 * signPin(deviceKey, { scope, owner, seq, firstSeen, now }) → Promise<pin>, pin = { v: 1, t: 'pin', scope,
 * owner, seq, firstSeen, at, by, sig }: the TOFU pin of a scope (owner key and seq floor), signed by the device
 * key over PIN_PREFIX + RFC 8785 JSON of the other fields. `by` is the device public key.
 */
export async function signPin (deviceKey, { scope, owner, seq = 0, firstSeen = null, now = Date.now() } = {}) {
  if (!deviceKey || !deviceKey.privateKey || !isPublicKeyString(deviceKey.pub)) throw new TypeError('signPin: a device key from createDeviceKey() is required')
  if (!isPublicKeyString(owner)) throw new TypeError('signPin: owner must be a tagged P-256 public key')
  if (!isUint(seq)) throw new TypeError('signPin: seq must be a non-negative safe integer')
  const at = Math.floor(Number(now))
  const pin = { v: 1, t: 'pin', scope: normalizeScope(scope), owner, seq, firstSeen: isUint(firstSeen) ? firstSeen : at, at, by: deviceKey.pub }
  pin.sig = await signObject(PIN_PREFIX, pin, deviceKey.privateKey)
  return pin
}

/**
 * verifyPin(pin, devicePub, { scope }) → Promise<{ ok, reason }>. reason: 'malformed', 'other-device' (signed by
 * another key than devicePub), 'other-scope', 'bad-sig'. A pin that fails is treated as absent (the visitor is
 * asked again), never as a reason to accept a key.
 */
export async function verifyPin (pin, devicePub, { scope = null } = {}) {
  if (!pin || typeof pin !== 'object' || pin.v !== 1 || pin.t !== 'pin' || !isPublicKeyString(pin.owner) || !isUint(pin.seq) || !isUint(pin.at)) return { ok: false, reason: 'malformed' }
  if (pin.by !== devicePub) return { ok: false, reason: 'other-device' }
  if (scope !== null) {
    let want
    try { want = normalizeScope(scope) } catch (_) { return { ok: false, reason: 'other-scope' } }
    if (pin.scope !== want) return { ok: false, reason: 'other-scope' }
  }
  if (!(await verifyObject(PIN_PREFIX, pin, devicePub))) return { ok: false, reason: 'bad-sig' }
  return { ok: true, reason: null }
}

/**
 * signRefusal(deviceKey, { scope, owner, now, ttlMs }) → Promise<refusal>, refusal = { v: 1, t: 'refusal', scope,
 * owner (the refused key), at, exp, by, sig }. exp = at + min(ttlMs, REFUSAL_TTL_MS): a refusal never lasts
 * more than 7 days, so a refusal made under a spoofed key does not lock the visitor out of the real owner's
 * site for good.
 */
export async function signRefusal (deviceKey, { scope, owner, now = Date.now(), ttlMs = REFUSAL_TTL_MS } = {}) {
  if (!deviceKey || !deviceKey.privateKey || !isPublicKeyString(deviceKey.pub)) throw new TypeError('signRefusal: a device key from createDeviceKey() is required')
  if (!isPublicKeyString(owner)) throw new TypeError('signRefusal: owner must be a tagged P-256 public key')
  const at = Math.floor(Number(now))
  const ttl = Math.min(REFUSAL_TTL_MS, Math.max(0, Math.floor(Number(ttlMs) || 0)))
  const refusal = { v: 1, t: 'refusal', scope: normalizeScope(scope), owner, at, exp: at + ttl, by: deviceKey.pub }
  refusal.sig = await signObject(REFUSAL_PREFIX, refusal, deviceKey.privateKey)
  return refusal
}

/**
 * verifyRefusal(refusal, devicePub, { now, scope }) → Promise<{ ok, reason, expiresAt }>. reason: 'malformed',
 * 'other-device', 'other-scope', 'too-long' (exp - at above 7 days), 'bad-sig', 'expired'. Only ok refusals
 * suppress the key-change prompt.
 */
export async function verifyRefusal (refusal, devicePub, { now = Date.now(), scope = null } = {}) {
  const r = refusal
  if (!r || typeof r !== 'object' || r.v !== 1 || r.t !== 'refusal' || !isPublicKeyString(r.owner) || !isUint(r.at) || !isUint(r.exp)) return { ok: false, reason: 'malformed', expiresAt: null }
  if (r.by !== devicePub) return { ok: false, reason: 'other-device', expiresAt: r.exp }
  if (scope !== null) {
    let want
    try { want = normalizeScope(scope) } catch (_) { return { ok: false, reason: 'other-scope', expiresAt: r.exp } }
    if (r.scope !== want) return { ok: false, reason: 'other-scope', expiresAt: r.exp }
  }
  if (r.exp - r.at > REFUSAL_TTL_MS || r.exp < r.at) return { ok: false, reason: 'too-long', expiresAt: r.exp }
  if (!(await verifyObject(REFUSAL_PREFIX, r, devicePub))) return { ok: false, reason: 'bad-sig', expiresAt: r.exp }
  if (now >= r.exp) return { ok: false, reason: 'expired', expiresAt: r.exp }
  return { ok: true, reason: null, expiresAt: r.exp }
}

// ---------------------------------------------------------------------------------------------
// withdrawals (MF-30)
// ---------------------------------------------------------------------------------------------

/**
 * withdrawalState(record, { now, maxMs, resignMarginMs }) → { binding, expiresAt, resignDue, tooLong }.
 * A withdrawal (st= other than ok) binds until min(exp, seq + 30 days) (seq is the Unix time it was signed,
 * as publish and withdraw write it). binding: now is before that; tooLong: the record's own exp is more than
 * 30 days after its seq (tools must not sign that; the loader clamps it); resignDue: the owner should re-sign
 * (less than resignMarginMs left). A record that is not a withdrawal, or lacks seq or exp, never binds.
 */
export function withdrawalState (record, { now = Date.now(), maxMs = WITHDRAWAL_MAX_MS, resignMarginMs = WITHDRAWAL_RESIGN_MARGIN_MS } = {}) {
  const none = { binding: false, expiresAt: null, resignDue: false, tooLong: false }
  if (!record || typeof record !== 'object' || !record.withdrawn || !isUint(record.seq) || !isUint(record.exp)) return none
  const cap = Math.min(maxMs, WITHDRAWAL_MAX_MS)
  const signedAt = record.seq * 1000
  const expiresAt = Math.min(record.exp * 1000, signedAt + cap)
  return {
    binding: now < expiresAt,
    expiresAt,
    resignDue: now >= expiresAt - Math.max(0, resignMarginMs),
    tooLong: record.exp * 1000 - signedAt > cap
  }
}

// ---------------------------------------------------------------------------------------------
// hubs: ownerless ledgers read-only (MF-31, HUB H10), PSL check (PTR A8)
// ---------------------------------------------------------------------------------------------

/**
 * isReadOnlyHubLedger({ hub, record, ledgerId }) → true when the page is served by a hub (shared origin or a
 * hub subdomain) and the ledger has no owner: an unsigned record (bare magnet, pointer without sig and owner)
 * or a 'btih:' ledger id. Such a ledger cannot be moderated, so the hub loader shows it read-only.
 */
export function isReadOnlyHubLedger ({ hub = false, record = null, ledgerId = null } = {}) {
  if (!hub) return false
  if (typeof ledgerId === 'string' && ledgerId.startsWith('btih:')) return true
  const signed = !!(record && typeof record.sig === 'string' && record.sig && ledgerOwnerOf(record))
  return !signed
}

function normalizeHost (host) {
  if (typeof host !== 'string') return null
  let h = host.trim().toLowerCase()
  if (h.endsWith('.')) h = h.slice(0, -1)
  if (!h || h.charAt(0) === '[' || /^[0-9.]+$/.test(h)) return null
  try { h = normalizeScope(h) } catch (_) { return null }
  return h.startsWith('btih:') ? null : h
}

/**
 * publicSuffixOf(host, suffixList) → the public suffix of host under the PSL algorithm (rules, '*.' wildcards,
 * '!' exceptions; the implicit rule '*' when nothing matches), or null for an invalid host. suffixList is an
 * array of rules (lowercase, punycode), for example a snapshot of the PSL private section.
 */
export function publicSuffixOf (host, suffixList) {
  const h = normalizeHost(host)
  if (!h) return null
  const labels = h.split('.')
  const rules = new Set()
  const exceptions = new Set()
  for (const raw of Array.isArray(suffixList) ? suffixList : []) {
    if (typeof raw !== 'string') continue
    const r = raw.trim().toLowerCase()
    if (!r || r.startsWith('//')) continue
    if (r.charAt(0) === '!') exceptions.add(r.slice(1))
    else rules.add(r)
  }
  let best = labels.length >= 1 ? labels[labels.length - 1] : null // implicit '*'
  let bestLen = 1
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join('.')
    const n = labels.length - i
    if (exceptions.has(candidate)) {
      // An exception rule wins: the suffix is the candidate minus its first label.
      return labels.slice(i + 1).join('.') || null
    }
    const wild = i + 1 <= labels.length ? '*.' + labels.slice(i + 1).join('.') : null
    if ((rules.has(candidate) || (wild && labels.length - i >= 2 && rules.has(wild))) && n > bestLen) {
      best = candidate
      bestLen = n
    }
  }
  return best
}

/**
 * pslHubCheck(host, suffixList) → { persistentIdentity, listed, publicSuffix, registrable } (PTR A8; R 2.17.5).
 * Call it for the host of a subdomain hub site (label.hub.example). The site's label is its own site to the
 * browser (separate storage, passkey RP IDs, cookies) only when the hub's domain is a public suffix, so
 * persistent identity and passkeys are allowed only when host is exactly one label under a listed suffix:
 * listed = the public suffix comes from a rule in suffixList (not the implicit '*'), registrable = suffix plus
 * one label. Anything else (the hub is not listed, the host is the hub itself, an IP literal) disables them.
 */
export function pslHubCheck (host, suffixList) {
  const h = normalizeHost(host)
  const off = { persistentIdentity: false, listed: false, publicSuffix: null, registrable: null }
  if (!h) return off
  const suffix = publicSuffixOf(h, suffixList)
  if (!suffix || suffix === h) return Object.assign(off, { publicSuffix: suffix })
  const labels = h.split('.')
  const suffixLabels = suffix.split('.').length
  const registrable = labels.slice(labels.length - suffixLabels - 1).join('.')
  const listed = suffixLabels > 1 || (Array.isArray(suffixList) && suffixList.some((r) => typeof r === 'string' && r.trim().toLowerCase() === suffix))
  return { persistentIdentity: listed && registrable === h, listed, publicSuffix: suffix, registrable }
}

// ---------------------------------------------------------------------------------------------
// owner key changes (MF-28)
// ---------------------------------------------------------------------------------------------

/**
 * rotationDecision({ prev, next, firstVisit, now, rotOk, delayMs }) → Promise<{ decision, reason, minutesAgo,
 * changedAt, until, nx }> with decision 'accept' | 'delay' | 'confirm'.
 *   prev: the record this visitor accepted before (or another trusted earlier record, for example the one a
 *         '#host:name@<fp>' link or a snapshot named), or null on a first visit; next: the verified candidate;
 *   rotOk: verifyPointer said the change is vouched (rotated: true) against the visitor's pin.
 * Rules: the same owner (and no rotation recorded in next) is 'accept'. prev committed nx=: a next owner that
 * hashes to it is 'accept' ('nx-match'), any other is 'confirm' ('nx-mismatch'; verifyPointer refuses it too).
 * A returning visitor (not firstVisit): a vouched change is 'accept' ('rotated', show the notice), an unvouched
 * one 'confirm' ('owner-changed'). A first-time visitor who meets a rotation (next.rot with lo= another key)
 * younger than delayMs (24 h, chosen) gets 'delay' until changedAt + delayMs ('recent-rotation'), else 'accept'.
 * changedAt is next.seq in ms (publish writes the Unix time), never later than now; minutesAgo feeds the text
 * "owner changed N minutes ago" (strings.js).
 */
export async function rotationDecision ({ prev = null, next, firstVisit = false, now = Date.now(), rotOk = false, delayMs = ROTATION_DELAY_MS } = {}) {
  if (!next || typeof next !== 'object' || !isPublicKeyString(next.owner)) throw new TypeError('rotationDecision: next must be a verified record with an owner')
  const changedAt = isUint(next.seq) ? Math.min(next.seq * 1000, now) : now
  const minutesAgo = Math.max(0, Math.floor((now - changedAt) / MINUTE_MS))
  const out = (decision, reason, more) => Object.assign({ decision, reason, minutesAgo, changedAt, until: null, nx: 'none' }, more || {})
  const prevOwner = prev && isPublicKeyString(prev.owner) ? prev.owner : null
  const recordedRotation = typeof next.rot === 'string' && !!next.rot && typeof next.lo === 'string' && next.lo !== next.owner
  const changed = prevOwner ? prevOwner !== next.owner : recordedRotation
  if (!changed) return out('accept', 'same-owner', { minutesAgo: null, changedAt: null })
  if (prevOwner && typeof prev.nx === 'string' && prev.nx) {
    const match = (await nextKeyCommitment(next.owner)) === prev.nx
    return match ? out('accept', 'nx-match', { nx: 'match' }) : out('confirm', 'nx-mismatch', { nx: 'mismatch' })
  }
  if (!firstVisit && prevOwner) return rotOk ? out('accept', 'rotated') : out('confirm', 'owner-changed')
  const wait = Math.max(0, Math.min(Number(delayMs) || 0, MAX_TIMER_MS))
  if (now - changedAt < wait) return out('delay', 'recent-rotation', { until: changedAt + wait })
  return out('accept', 'rotation-aged')
}

// ---------------------------------------------------------------------------------------------
// loader floor (SC-6)
// ---------------------------------------------------------------------------------------------

/** compareVersions(a, b) → -1 | 0 | 1 for 'x.y.z' strings (numeric per part); NaN when either is not one. */
export function compareVersions (a, b) {
  if (!isLoaderVersion(a) || !isLoaderVersion(b)) return NaN
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  return 0
}

/**
 * loaderFloorOk(ml, version = CONFIG.version) → true when this loader may mount the site: no ml= (null,
 * undefined or ''), or version >= ml. A malformed ml= or version fails closed (false): the loader refuses to
 * mount and offers the update (the pointer parser already refuses a malformed ml=).
 */
export function loaderFloorOk (ml, version = CONFIG.version) {
  if (ml === null || ml === undefined || ml === '') return true
  const c = compareVersions(version, ml)
  return c === 0 || c === 1
}

// ---------------------------------------------------------------------------------------------
// '#host:name@<fp>' links (MF-30, PTR A3)
// ---------------------------------------------------------------------------------------------

/**
 * parseHostFingerprintLink(hash) → { host, fp } | null. Accepts '#host:<name>@<fp>' (or the same without '#'):
 * name is a DNS name (normalized like a pointer scope: lowercase A-label, no trailing dot), fp is 16 to 43
 * b64url characters, a prefix of ownerFingerprint(owner). Anything else is null (the link is ignored, the
 * loader never guesses).
 */
export function parseHostFingerprintLink (hash) {
  if (typeof hash !== 'string') return null
  let s = hash.trim()
  if (s.charAt(0) === '#') s = s.slice(1)
  if (!s.startsWith('host:')) return null
  s = s.slice(5)
  const at = s.lastIndexOf('@')
  if (at <= 0) return null
  const name = s.slice(0, at)
  const fp = s.slice(at + 1)
  if (!FP_RE.test(fp) || /[^A-Za-z0-9.-]/.test(name)) return null
  const host = normalizeHost(name)
  if (!host || host.indexOf('.') < 0) return null
  return { host, fp }
}

/** ownerFingerprint(owner) → Promise<string>: b64url(sha256(utf8(owner))), 43 characters (the nx= form). */
export async function ownerFingerprint (owner) {
  if (!isPublicKeyString(owner)) throw new TypeError('ownerFingerprint: owner must be a tagged P-256 public key')
  return b64url.encode(await sha256(utf8.encode(owner)))
}

/** fingerprintMatches(fp, owner) → Promise<boolean>: fp (16 to 43 b64url characters) is a prefix of ownerFingerprint(owner). */
export async function fingerprintMatches (fp, owner) {
  if (typeof fp !== 'string' || !FP_RE.test(fp) || !isPublicKeyString(owner)) return false
  return (await ownerFingerprint(owner)).startsWith(fp)
}
