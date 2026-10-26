// src/loader/app.js: the shell loader orchestrator (ARCHITECTURE §3.1 to §3.3, §4, §5, §7.2, §7.4,
// §8; INTERFACES "src/loader/app.js"). Bundled as /_mw/loader.js; boot.js imports it and calls the
// default export. The modules other agents own (cache, doh, verify, pointer, torrent-file, chain/*)
// are loaded with import() inside start(), so the pure helpers exported here (resolveMode,
// resolvePointer, decidePointer, ...) import cleanly in Node tests. esbuild inlines those imports.
//
// Order of operations that matter:
//  1. Consent before any third party (v0.2.1 C1): the TorrentManager only builds tracker sockets while the
//     consent object allows peers; the STUN probe runs only after "Share and load"; the DoH lookup runs
//     only after a choice (a <meta> or cached pointer renders without it; a DNS-only pointer shows the
//     card first). The web seed (plain HTTP to the publisher's host) starts at once.
//  2. A cached, verified site renders before WebTorrent or the ledger start (§5.4).
//  3. The ledger node opens (bounded wait) before torrents are added, so its wire extension is
//     registered synchronously on every Torrent (the extended handshake is never re-sent).
//  4. v0.3 (R 2.11, ARCHITECTURE 15): one MwApi per page (src/loader/api.js) carries the SDK; the tab that runs
//     the site mounts the identity, chat, files and media services on it (the SVC contract) and, in hub mode,
//     the followed ledgers. Guests read; a write opens the sign-in prompt (R 2.4.1). Follower tabs hold no keys.
//     Without the identity service in the build the 0.2.1 per-site key stays (logged; docs/deviations/sdk.md).

import { CONFIG } from './config.js'
import { STRINGS } from './strings.js'
import { detectEnvironment, readBattery, computePolicy, watchLifecycle, watchNetwork, lifecyclePlan, deviceClassOf } from './policy.js'
import {
  registerServiceWorker, mountSite, mountDegraded, pathFromLocation, hubPathFromLocation, splitHubPath,
  postToServiceWorker, pingServiceWorker, requestServiceWorker, watchController, insertCsp, requestDegradedReload
} from './render.js'
import { TorrentManager, classifyFailures, announceListFor } from './torrent.js'
import { probeConnectivity, gateIceServers, installOfferTimeout, connectivityRow, stunUrlsOf } from './connectivity.js'
import { audienceOf, consentModeFor, recipientsKey, makeConsentRecord, consentFromRecord, dnsAllowedBy, consentKeyFor } from './consent.js'
import { Bridge } from './bridge.js'
import { purgeWithdrawn, withdrawalNotice } from '../common/withdrawal.js'
import { readSnapshot } from '../common/snapshot-read.js'
import { isPublicHttpsUrl } from '../common/magnet.js'
import { planVersions } from '../dropin/rules.js'
import { createUI, formatBytes } from './ui.js'
import { MwApi, ActivationTracker, createTorrentSeam, mountV03Services, ownTrackerOf, chatDeviceClass, swPortFor, nodeIdentityOf, setNodeIdentity, siteModeOf, identityHeaderOf, writeRotation, ownerCfgPin } from './api.js'
// C2 wire-ui (research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md 3.1, 3.3, 3.5): the seed meters and dock mode of lane
// seed-policy, the call panel, the seeding texts and the mw.net seeding control.
import { createSeedMeters } from './seed-meters.js'
import { createDock } from './dock.js'
import { createCallUi } from './call-ui.js'
import { seedText } from './strings.js'
import { labelText, capText, carryMeter, meterText, trackerText } from './ui.js'
import { createNetControl, denyChecker, rotationBlocker } from './api.js'
// C2 integrator (lane seed-engine's requests O1 and O2, SZ 3.1.6): the mw_pin1 verifier on every page whose site names a pin,
// the responder and window.__mwPinHost only in the pin's own page (tools/pin.mjs), and the IndexedDB store it keeps files in.
import { createPinWire, createPinPageHost } from './pinwire.js'
import { IdbChunkStore, idbBackend } from '../files/store-idb.js'
import { createHubService, createPersonalSite, decodeGenesis, checkGenesis, hubScope, viewAdapters, refreshPersonalPointer, POINTER_KEY } from './personal-site.js'
// C2 doors (research/v03/S4-doors.md D2 to D6): the light link's fragment, the door candidates and probes, the byte fallback across
// doors, the ledger's _doors, the door view (a sandboxed frame) and the Doors panel. Every insertion point below is marked "C2 doors".
import { parseLinkFragment, normalizeRecordText, formatLightLink, parseLightLink, DOOR_PAGE_PATH, FELINAR_SCHEME, isLoopbackDoorHost } from '../common/pointer.js'
import {
  doorCandidates, createDoorHealth, probeDoor, fetchFirst, doorTorrentUrls, doorWebseeds, readLedgerDoors, enforceDoorBudget, byteDoors,
  doorsPanelModel, doorsBannerModel, doorLinkFor, doorFiles, mountDoorView, hintAllowed, DOOR_TIMING, DOOR_HEALTH_PREF,
  DOOR_LAST_GOOD_PREF, DOOR_LEDGER_PREF, DOOR_FRAME_PATH
} from './doors.js'
import { doorText } from './strings.js'
import { xsUrls, webseedBases } from './torrent.js'
import { DEGRADED_RELOAD_KEY } from './render.js'
import {
  withdrawalState, isReadOnlyHubLedger, rotationDecision, loaderFloorOk, pslHubCheck, clampTimerMs, clampTtlSeconds,
  createDeviceKey, signPin, verifyPin, signRefusal, verifyRefusal, parseHostFingerprintLink, fingerprintMatches
} from './harden.js'

const BTIH_RE = /^[0-9a-f]{40}$/
const BASE32_BTIH_RE = /^[a-z2-7]{32}$/i
const HUB_LABEL_RE = /^([a-z2-7]{32})\.(.+)$/
const IDP_RETURN_PATH = '/_mw/idp-return'

// ---------------------------------------------------------------------------------------------
// Mode detection (ARCHITECTURE §3)
// ---------------------------------------------------------------------------------------------

function normalizeHost (host) {
  if (typeof host !== 'string' || !host.trim()) return null
  try {
    const h = new URL('https://' + host.trim().replace(/\.$/, '') + '/').hostname
    return h && /^[a-z0-9.-]+$/.test(h) && h.includes('.') ? h : null
  } catch (_) { return null }
}

/**
 * parseFragment(hash, search) → { kind: 'magnet'|'btih'|'host'|'record', text, host?, btih?, genesis?, genesisText?, hints?, handler? } | null
 * Hub pointers travel in the fragment (#magnet:?..., #btih:<hex>, #host:example.com, #v=mw1;...)
 * or in ?mw=. The magnet and record texts are left encoded: their own parsers decode values.
 * C2 doors (S4 D2): any number of '#name=value' segments follow the pointer: mwgen (a new personal site's genesis, R 3.3) and
 * mwd (at most 4 unsigned door hints, the hints field); others are ignored. A protocol handler's web+felinar: prefix, literal or
 * percent-encoded by its %s, is removed first. An encoded record (v%3D...) is decoded once and used as it is; a literal one only gets
 * the separator spaces back (normalizeRecordText): a %20 inside a value is what the owner signed (earlier loaders replaced every
 * %20 and broke such values).
 */
export function parseFragment (hash, search) {
  let raw = typeof hash === 'string' ? hash.replace(/^#/, '') : ''
  if (!raw && search) {
    try { raw = new URLSearchParams(search).get('mw') || '' } catch (_) { raw = '' }
  }
  raw = raw.trim()
  if (!raw) return null
  const f = parseLinkFragment(raw) // C2 doors
  const text = f.head
  if (!text) return null
  // v0.3 (R 3.3): a new personal site's genesis travels after the pointer: '#<pointer>#mwgen=<blocks>'.
  const genesis = f.genesis ? decodeGenesis(f.genesis) : null
  const more = (out) => {
    if (f.hints.length && out.kind !== 'host') out.hints = f.hints
    if (f.handler) out.handler = true
    return out
  }
  if (/^magnet:\?/i.test(text) || /^magnet%3a%3f/i.test(text)) {
    const decoded = /^magnet%3a/i.test(text) ? safeDecode(text) : text
    return more({ kind: 'magnet', text: decoded })
  }
  let m = /^btih:([0-9a-f]{40}|[a-z2-7]{32})$/i.exec(text)
  if (m) return more({ kind: 'btih', btih: m[1].toLowerCase(), text: 'magnet:?xt=urn:btih:' + m[1].toLowerCase() })
  m = /^host:(.+)$/i.exec(text)
  if (m) {
    // '#host:<name>@<fp>' (MF-30, PTR A3): the name plus a fingerprint of its owner key; a record signed by another key
    // is refused (resolvePointer). Without '@' the plain '#host:<name>' form.
    const withFp = parseHostFingerprintLink('host:' + safeDecode(m[1]))
    if (withFp) return more({ kind: 'host', host: withFp.host, fp: withFp.fp, text: null })
    const host = normalizeHost(safeDecode(m[1]))
    return host ? more({ kind: 'host', host, text: null }) : null
  }
  if (/^v(=|%3d)mw1/i.test(text)) {
    let record = text
    let decoded = f.decoded
    if (/^v%3d/i.test(record)) { record = safeDecode(record); decoded = true }
    const out = { kind: 'record', text: decoded ? record : normalizeRecordText(record) }
    if (genesis) { out.genesis = genesis; out.genesisText = f.genesis }
    return more(out)
  }
  return null
}

function safeDecode (s) {
  try { return decodeURIComponent(s) } catch (_) { return s }
}

/**
 * resolveMode(loc, { metaPointer, hubMeta, dev }) → one of
 *  { mode: 'redirect', to }                         top-level URL inside /_mw/s/<btih>/ (§3.3 302)
 *  { mode: 'hub-sub', label, hubHost, fragment, path }   <32 base32>.<hub> (§3.2)
 *  { mode: 'hub-root', hubHost, fragment }          wildcard hub root: label redirect (§3.2)
 *  { mode: 'hub-shared', fragment, path }           one-origin demo hub (§3.3)
 *  { mode: 'shell', scope, path }                   per-domain shell (§3.1)
 *  { mode: 'door', fragment, path }                 C2 doors (S4 D4): /_mw/open.html shows any site by its link, in the door view
 * hubMeta comes from <meta name="mw-hub" content="subdomain|shared">. On a dev host (loopback) a
 * pointer fragment without a page pointer opens the shared demo hub, so `npm run demo` needs no flag.
 */
export function resolveMode (loc, { metaPointer = null, hubMeta = null, dev = false } = {}) {
  const hostname = String((loc && loc.hostname) || '').toLowerCase()
  const pathname = String((loc && loc.pathname) || '/')
  const search = String((loc && loc.search) || '')
  const hash = String((loc && loc.hash) || '')
  const hub = typeof hubMeta === 'string' ? hubMeta.trim().toLowerCase() : ''
  // v0.3 (R 2.3.1): the redirect round trip of the sign-in comes back here; the loader finishes it first.
  if (pathname === IDP_RETURN_PATH) return { mode: 'idp-return', path: pathname }
  const split = splitHubPath(pathname)
  if (split) return { mode: 'redirect', to: '/#btih:' + split.btih }
  const fragment = parseFragment(hash, search)
  // C2 doors: the reserved door page of every build; it needs no configuration (no mw-hub meta) and ignores a page tag.
  if (pathname === DOOR_PAGE_PATH) return { mode: 'door', fragment, path: '/' }
  const label = HUB_LABEL_RE.exec(hostname)
  if (label && !metaPointer) {
    return { mode: 'hub-sub', label: label[1], hubHost: label[2], fragment, path: pathFromLocation(loc) }
  }
  if (hub === 'subdomain' && !metaPointer) return { mode: 'hub-root', hubHost: hostname, fragment }
  if ((hub === 'shared' && !metaPointer) || (dev && !metaPointer && fragment)) {
    return { mode: 'hub-shared', fragment, path: hubPathFromLocation(loc) }
  }
  return { mode: 'shell', scope: hostname, path: pathFromLocation(loc, { includeHash: true }) }
}

/**
 * SDK-facing mode name: 'shell' (per-domain), 'hub' (own subdomain) or 'hub-shared'. C2 doors: the door view is 'hub-shared' to a
 * site (one origin shows many sites; the identity there lasts for this visit only), so sites keep the three values they know.
 */
export function sdkMode (mode) {
  return mode === 'hub-sub' ? 'hub' : (mode === 'hub-shared' || mode === 'door') ? 'hub-shared' : 'shell'
}

// ---------------------------------------------------------------------------------------------
// Pointer resolution (ARCHITECTURE §4): vet candidates, then decide in the documented order
// ---------------------------------------------------------------------------------------------

function num (v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : -Infinity
}

/**
 * vetCandidate(text, source, ctx, deps) → candidate
 *  { status: 'ok'|'key-changed'|'rejected', reason, record, raw, source, expired, rotated, trusted }
 * Verification per pointer.js; fresh sources must not be expired and must not roll back `seq`; an
 * expired cached record is still usable (with a banner). A signed record by a key other than the
 * pinned one is accepted silently only with a valid rot=, otherwise it needs the visitor's
 * confirmation. Unsigned records never override a pinned scope.
 */
export async function vetCandidate (text, source, ctx, deps) {
  const base = { source, raw: text, status: 'rejected', reason: null, record: null, expired: false, rotated: false, trusted: false }
  if (typeof text !== 'string' || !text.trim()) return Object.assign(base, { reason: 'empty' })
  let parsed
  try { parsed = deps.parsePointer(text.trim()) } catch (err) { parsed = { ok: false, error: (err && err.message) || 'parse error' } }
  if (!parsed || !parsed.ok || !parsed.record) return Object.assign(base, { reason: 'parse: ' + ((parsed && parsed.error) || 'invalid') })
  const record = parsed.record
  base.record = record
  if (!BTIH_RE.test(String(record.btih || ''))) return Object.assign(base, { reason: 'no-btih' })
  if (ctx.scope && ctx.scope.startsWith('btih:') && ctx.scope !== 'btih:' + record.btih) return Object.assign(base, { reason: 'scope' })
  const now = ctx.now
  const pinned = ctx.pin && ctx.pin.owner ? ctx.pin.owner : null
  if (!record.signed) {
    if (pinned) return Object.assign(base, { reason: 'unsigned-pinned' })
    // Code review round 1: on a hub every record comes from a link (fragment, ?mw=, the DNS of a
    // #host: name, or a copy saved from one), so an unsigned st= is anybody's word: never acted on.
    // A host's own unsigned page tag (shell) may still withdraw that host's site.
    if (record.withdrawn && ctx.mode !== 'shell') return Object.assign(base, { reason: 'unsigned-withdrawal' })
    return Object.assign(base, { status: 'ok', trusted: true })
  }
  const expMs = num(record.exp) * 1000
  const fromCache = source === 'cache'
  const verifyNow = fromCache && Number.isFinite(expMs) ? Math.min(now, expMs - 1000) : now
  const cachedSeq = fromCache ? null : (Number.isFinite(num(ctx.cachedSeq)) ? num(ctx.cachedSeq) : null)
  let v
  const previousRecord = ctx.previousRecord && ctx.previousRecord !== record ? ctx.previousRecord : null
  try { v = await deps.verifyPointer(record, ctx.scope, { now: verifyNow, pinnedOwner: pinned, cachedSeq, previousRecord }) } catch (err) { v = { ok: false, reason: (err && err.message) || 'verify failed' } }
  if (v && !v.ok && v.reason === 'owner-changed' && pinned) {
    // A new key without a valid rot=: the record may still be valid, and the visitor decides. A key
    // the visitor confirms starts a new seq floor (code review round 1), so the old floor is not used.
    let v2
    try { v2 = await deps.verifyPointer(record, ctx.scope, { now: verifyNow, pinnedOwner: null, cachedSeq: null, previousRecord }) } catch (err) { v2 = { ok: false, reason: (err && err.message) || 'verify failed' } }
    if (!v2 || !v2.ok) return Object.assign(base, { reason: (v2 && v2.reason) || 'invalid' })
    const lmk = await ledgerMemoryOf(record, ctx.scope, deps)
    const lineage = await lineageOf(record, ctx.scope, deps, { previousRecord, mem: lmk && lmk.mem })
    return Object.assign(base, { status: 'key-changed', reason: 'owner-changed', lineage, ledgerId: lmk ? lmk.id : null, expired: Number.isFinite(expMs) && expMs <= now })
  }
  if (!v || !v.ok) return Object.assign(base, { reason: (v && v.reason) || 'invalid' })
  // Review round R 5.3 (PTR-4): the seq floor is kept per LEDGER id too (any version, any scope of one ledger), so a link
  // to an older version of the same ledger is refused on a device that accepted a newer one ('seq-rollback').
  const lm = await ledgerMemoryOf(record, ctx.scope, deps)
  const mem = lm && lm.mem
  if (mem && mem.seq <= Math.floor(now / 1000) + SEQ_FUTURE_SLACK_S && num(record.seq) < mem.seq) return Object.assign(base, { reason: 'seq-rollback' })
  // Review round R 5.3 (PTR-1, PTR-2; MF-04): whether this record has earned the ledger its lo= names.
  const lineage = await lineageOf(record, ctx.scope, deps, { previousRecord, mem })
  // Code review round 1: verifyPointer reports a valid rot= as ok + rotated; the record is then
  // trusted (an update can apply, the pin moves with rotatedAt).
  const rotated = !!v.rotated
  return Object.assign(base, { status: 'ok', rotated, lineage, ledgerId: lm ? lm.id : null, ledgerOwner: mem && typeof mem.owner === 'string' ? mem.owner : null, trusted: !pinned || record.owner === pinned || rotated, expired: Number.isFinite(expMs) && expMs <= now })
}

/** refusedKeyFor(scope, owner) → the preference that remembers a refused publisher key change ('keyRefused:<scope>:<owner>'). */
export function refusedKeyFor (scope, owner) {
  return 'keyRefused:' + scope + ':' + owner
}

/**
 * forgetKeyRefusals(cache, scope, owners) → number cleared (review round R 5.3, GATE-1): "Review the publisher key change"
 * clears the remembered refusals of this scope, so the next load asks again. Nothing else of the site is forgotten.
 */
export async function forgetKeyRefusals (cache, scope, owners) {
  if (!cache || typeof cache.setPref !== 'function' || typeof scope !== 'string' || !scope) return 0
  let n = 0
  for (const owner of Array.isArray(owners) ? owners : []) {
    if (typeof owner !== 'string' || !owner) continue
    try { await cache.setPref(refusedKeyFor(scope, owner), false); n++ } catch (_) { /* best effort */ }
  }
  return n
}

/** The per-ledger memory (review round R 5.3, PTR-4, PTR-1): pref 'ledger:<ledgerId>' = { seq, owner, nx, at }. */
export const LEDGER_PREF_PREFIX = 'ledger:'
const SEQ_FUTURE_SLACK_S = 86400 // pointer.js SEQ_FUTURE_MAX_S: a floor further ahead than this is poisoned and ignored

async function ledgerMemoryOf (record, scope, deps) {
  if (!record || !record.signed || typeof deps.ledgerIdFor !== 'function') return null
  let id = null
  try { id = await deps.ledgerIdFor(record, scope) } catch (_) { return null }
  if (typeof id !== 'string' || !id.startsWith('mw1:')) return null
  let m = null
  try { m = deps.cache && typeof deps.cache.getPref === 'function' ? await deps.cache.getPref(LEDGER_PREF_PREFIX + id, null) : null } catch (_) { m = null }
  const mem = m && typeof m === 'object' && Number.isSafeInteger(m.seq) && m.seq >= 0 ? m : null
  return { id, mem }
}

async function lineageOf (record, scope, deps, { previousRecord = null, mem = null } = {}) {
  if (typeof deps.pointerLineage !== 'function') return null
  try {
    return await deps.pointerLineage(record, scope, { previousRecord, knownOwner: mem && mem.owner, knownNx: mem && mem.nx })
  } catch (_) { return 'unproven' }
}

/**
 * lineageAction(mode, resolved) → 'ok' | 'refuse' | 'read-only' | 'flag' (review round R 5.3, PTR-1): what run() does with
 * a signed record whose lo= is unproven. hub-sub: refuse (the address IS that ledger's label); hub-shared and door: mount
 * read only, no restored sign-in, no moderator key, never the current site; shell: the host serves its own page, the
 * identity origin already gives it the origin's own label (src/identity/derive.js lineage), and nothing ledger-bound is
 * stored at a host's origin but by that host's own visitors: 'flag' (logged only).
 */
export function lineageAction (mode, r) {
  if (!r || !r.signed || r.lineage !== 'unproven') return 'ok'
  if (mode === 'hub-sub') return 'refuse'
  if (mode === 'shell') return 'flag'
  return 'read-only'
}

/** lineageOk(lineage): null (a caller without the lineage helper) or a proven lineage (PTR-1). */
export function lineageOk (lineage) {
  return lineage === null || lineage === undefined || lineage === 'owner' || lineage === 'rot' || lineage === 'carried' || lineage === 'unsigned'
}

/**
 * noteLedger(cache, ledgerId, record, lineage, now): remembers the highest seq and its owner accepted for a ledger (PTR-4),
 * only for a signed record with a proven lineage (a squat must neither raise the floor nor name the owner).
 */
export async function noteLedger (cache, ledgerId, record, lineage, now = Date.now()) {
  if (!cache || typeof cache.setPref !== 'function' || typeof ledgerId !== 'string' || !ledgerId.startsWith('mw1:')) return false
  if (!record || !record.signed || !Number.isSafeInteger(record.seq) || !lineageOk(lineage) || (lineage == null && record.lo && record.lo !== record.owner)) return false
  if (record.seq > Math.floor(now / 1000) + SEQ_FUTURE_SLACK_S) return false
  try {
    const old = typeof cache.getPref === 'function' ? await cache.getPref(LEDGER_PREF_PREFIX + ledgerId, null) : null
    if (old && typeof old === 'object' && Number.isSafeInteger(old.seq) && old.seq > record.seq) return false
    await cache.setPref(LEDGER_PREF_PREFIX + ledgerId, { seq: record.seq, owner: record.owner, nx: typeof record.nx === 'string' && record.nx ? record.nx : null, at: now })
    return true
  } catch (_) { return false }
}

/**
 * decidePointer({ mode, fragment, meta, dns, cache }) → { pick } | { confirm } | { pick: null }
 * The resolution-order decision (ARCHITECTURE §4). Shell: <meta> is primary; a valid DNS record
 * wins only when signed by the pinned owner (or a valid rot) and its seq is higher. Hub: the
 * fragment (or DNS for #host:). The cached record is the fallback. A key change needs confirmation
 * and loses to any trusted fresh candidate.
 */
export function decidePointer ({ mode = 'shell', fragment = null, meta = null, dns = null, cache = null } = {}) {
  const ok = (c) => !!(c && c.status === 'ok')
  const changed = (c) => !!(c && c.status === 'key-changed')
  let fresh = null
  if (mode === 'shell') {
    if (ok(meta) && ok(dns)) {
      const dnsWins = !!dns.record.signed && !!dns.trusted && num(dns.record.seq) > num(meta.record.seq)
      fresh = dnsWins ? dns : meta
    } else {
      fresh = ok(meta) ? meta : ok(dns) ? dns : null
    }
  } else {
    fresh = ok(fragment) ? fragment : ok(dns) ? dns : null
  }
  if (fresh) return { pick: fresh }
  const toConfirm = mode === 'shell' ? (changed(meta) ? meta : changed(dns) ? dns : null) : (changed(fragment) ? fragment : changed(dns) ? dns : null)
  if (toConfirm) return { confirm: toConfirm }
  if (ok(cache)) return { pick: cache }
  if (changed(cache)) return { confirm: cache }
  return { pick: null }
}

/** Joins DoH TXT answers (each may still be in quoted-chunk form) into record texts. */
export function txtStrings (answer, joinTxtData) {
  const out = []
  for (const s of (answer && Array.isArray(answer.strings)) ? answer.strings : []) {
    if (typeof s !== 'string') continue
    const t = s.trim()
    out.push(t.startsWith('"') && typeof joinTxtData === 'function' ? joinTxtData(t) : t)
  }
  return out
}

async function dnsCandidate (ctx, deps, { fresh = false } = {}) {
  const host = ctx.dnsHost
  if (!host || !deps.resolveTxt) return { candidate: null, answer: null, error: null }
  if (deps.shouldSkipDoh && deps.shouldSkipDoh(host)) return { candidate: null, answer: null, error: null, skipped: true }
  const name = ctx.config.pointer.txtPrefix + host
  let answer = null
  if (!fresh && deps.cache && deps.cache.getPref) {
    try {
      const cached = await deps.cache.getPref('dns:' + host, null)
      if (cached && cached.ttlUntil > ctx.now && Array.isArray(cached.strings)) answer = cached
    } catch (_) { /* no cached answer */ }
  }
  if (!answer) {
    // v0.2.1 C1: no DoH lookup before a consent choice; a cached answer (local data) is still read.
    if (ctx.dohAllowed === false) return { candidate: null, answer: null, error: null, deferred: true, consentNeeded: true }
    if (!ctx.blockOnDns && !fresh) return { candidate: null, answer: null, error: null, deferred: true }
    try {
      // Review round R 5.3 (PTR-4): an answer holding no record this device would accept (an older seq, another
      // ledger's floor, nothing that verifies) sends the lookup on to the next resolver (doh.js resolveTxt accept).
      const accept = async (res) => {
        for (const text of txtStrings(res, deps.joinTxtData)) {
          if ((await vetCandidate(text, 'dns', ctx, deps)).status !== 'rejected') return true
        }
        return false
      }
      const res = await deps.resolveTxt(name, { timeoutMs: ctx.config.timeouts.dohMs, resolvers: ctx.resolvers || undefined, override: ctx.dohOverride || null, accept })
      const ttlMs = Math.max(ctx.config.pointer.minTtlMs, clampTtlSeconds(Number(res && res.ttl) || 0) * 1000)
      answer = { strings: txtStrings(res, deps.joinTxtData), resolver: res && res.resolver, ad: !!(res && res.ad), ttl: res && res.ttl, ttlUntil: ctx.now + ttlMs }
      if (deps.cache && deps.cache.setPref) { try { await deps.cache.setPref('dns:' + host, answer) } catch (_) { /* best effort */ } }
    } catch (err) {
      return { candidate: null, answer: null, error: err || new Error('DoH failed') }
    }
  }
  const vetted = []
  for (const text of answer.strings || []) {
    const c = await vetCandidate(text, 'dns', ctx, deps)
    if (c.status !== 'rejected') vetted.push(c)
  }
  if (!vetted.length) return { candidate: null, answer, error: null }
  const okOnes = vetted.filter((c) => c.status === 'ok')
  const pool = okOnes.length ? okOnes : vetted
  let best = pool[0]
  if (pool.length > 1 && typeof deps.pickRecord === 'function') {
    const picked = deps.pickRecord(pool.map((c) => c.record))
    best = pool.find((c) => c.record === picked) || best
  }
  best.resolver = answer.resolver
  best.ad = answer.ad
  return { candidate: best, answer, error: null }
}

/**
 * resolvePointer(ctx, deps) → { record, raw, source, scope, signed, pin, firstTime, expired,
 *   rotated, keyChanged, dns, ledgerId, warnings }  (throws { code: 'E_POINTER', tried }, or
 *   { code: 'E_NEEDS_CONSENT' } when only a DoH lookup could find the site and ctx.dohAllowed is false)
 * ctx: { mode, scope, fragment, hostFp, metaText, dnsHost, blockOnDns, dohAllowed, now, config, confirmKeyChange,
 *   dohOverride, resolvers }. deps: pointer.js functions, doh.js functions and cache.js. hostFp: the owner-key fingerprint
 *   of a '#host:<name>@<fp>' link (MF-30): a candidate signed by any other key is refused.
 */
export async function resolvePointer (ctx, deps) {
  const c = Object.assign({ now: Date.now(), config: CONFIG, mode: 'shell' }, ctx)
  const cache = deps.cache || {}
  const scope = c.scope
  const tried = []
  const warnings = []
  let pin = null
  let cached = null
  try { pin = cache.getPin ? await cache.getPin(scope) : null } catch (_) { pin = null }
  try { cached = cache.getPointer ? await cache.getPointer(scope) : null } catch (_) { cached = null }
  c.pin = pin
  // v0.3 (harden-loader request 5): the last accepted record of the scope, for nx= (MF-28). Review round R 5.3 (PTR-11):
  // re-derived from the saved raw text and its owner's signature, never from the stored fields (a same-origin script
  // could rewrite those with a lower seq and no nx=; it cannot sign a record for the owner).
  c.previousRecord = await signedSavedRecord(cached, scope, c.now, deps)
  c.cachedSeq = c.previousRecord ? c.previousRecord.seq : null
  // Review round R 5.3 (PTR-13, PTR A10): the page's mw-doh override is not used for a device's first lookup of a scope.
  if (!pin && !c.previousRecord) c.dohOverride = null

  let fragment = null
  let meta = null
  let dns = null
  let dnsInfo = null
  if (c.mode !== 'shell' && c.fragment && c.fragment.text) {
    fragment = await vetCandidate(c.fragment.text, 'fragment', c, deps)
    if (fragment.status === 'rejected') tried.push('link: ' + fragment.reason)
  }
  if (c.mode === 'shell' && c.metaText) {
    meta = await vetCandidate(c.metaText, 'meta', c, deps)
    if (meta.status === 'rejected') tried.push('page tag: ' + meta.reason)
  }
  if (c.dnsHost) {
    const r = await dnsCandidate(c, deps)
    dnsInfo = r
    dns = r.candidate
    if (r.error) tried.push('DNS: ' + ((r.error && r.error.message) || 'DoH failed'))
    else if (r.answer && !dns) tried.push('DNS: no valid record')
  }
  let cacheCand = null
  if (cached && (cached.raw || (cached.record && cached.record.raw))) {
    cacheCand = await vetCandidate(cached.raw || cached.record.raw, 'cache', c, deps)
    if (cacheCand.status === 'rejected') tried.push('saved copy: ' + cacheCand.reason)
  }
  // Code review round 1 (§4): with no pin yet, the page tag's owner is the anchor. A DNS record
  // signed by another key may win only with a valid rot= from that owner; otherwise it is not
  // trusted to override the page tag (and is never pinned through it).
  if (!pin && meta && dns && meta.status === 'ok' && dns.status === 'ok') await anchorCandidate(dns, meta.record, scope, deps)
  // '#host:<name>@<fp>' (MF-30): the link names the owner key it expects; any record by another key is refused, a key
  // change included (the fingerprint, not this device's pin, is what the visitor was given).
  const fp = typeof c.hostFp === 'string' && c.hostFp ? c.hostFp : null
  if (fp) {
    for (const cand of [fragment, meta, dns, cacheCand]) {
      if (!cand || cand.status === 'rejected' || !cand.record) continue
      // Review round R 5.3 (PTR-2): the fingerprint names the SIGNING key (owner=). lo= is the signer's own word, so a
      // record matches through lo= only when its lineage from lo= is proven (a rot= signed by lo=, or carried).
      const rec = cand.record
      const owner = rec.signed ? rec.owner : null
      let match = !!owner && await fingerprintMatches(fp, owner)
      if (!match && owner && typeof rec.lo === 'string' && rec.lo && rec.lo !== owner && (cand.lineage === 'rot' || cand.lineage === 'carried')) {
        match = await fingerprintMatches(fp, rec.lo)
      }
      if (!match) {
        cand.status = 'rejected'
        cand.reason = 'fingerprint'
        tried.push(cand.source + ': not signed by the key the link names')
      }
    }
  }

  let decision = decidePointer({ mode: c.mode, fragment, meta, dns, cache: cacheCand })
  let keyChanged = false
  const refusedOwners = []
  const previousOwner = pin && pin.owner ? pin.owner : null
  while (decision.confirm) {
    const cand = decision.confirm
    const refusedKey = refusedKeyFor(scope, cand.record.owner)
    let refused = false
    try { refused = cache.getPref ? !!(await cache.getPref(refusedKey, false)) : false } catch (_) { refused = false }
    let accept = false
    if (!refused && typeof c.confirmKeyChange === 'function') {
      accept = !!(await c.confirmKeyChange({ scope, oldOwner: pin && pin.owner, newOwner: cand.record.owner }))
      if (!accept && cache.setPref) { try { await cache.setPref(refusedKey, true) } catch (_) { /* ignore */ } }
    }
    // Review round R 5.3 (GATE-1): the refused keys are returned, so the page can offer to review the decision.
    if (!accept && !refusedOwners.includes(cand.record.owner)) refusedOwners.push(cand.record.owner)
    if (accept) {
      cand.status = 'ok'
      cand.trusted = true
      keyChanged = true
      if (cache.savePin) { try { await cache.savePin(scope, cand.record.owner, { decidedAt: c.now, firstSeen: c.now }) } catch (_) { /* ignore */ } }
      pin = { owner: cand.record.owner, decidedAt: c.now, firstSeen: c.now }
      decision = { pick: cand }
    } else {
      cand.status = 'rejected'
      cand.reason = 'key change refused'
      warnings.push('key-refused')
      decision = decidePointer({ mode: c.mode, fragment, meta, dns, cache: cacheCand })
    }
  }
  const chosen = decision.pick
  if (!chosen) {
    if (dnsInfo && dnsInfo.consentNeeded) {
      // Only a DNS-over-HTTPS lookup could find this site and the visitor has not chosen yet (C1).
      const err = new Error('Finding ' + scope + ' needs a DNS-over-HTTPS lookup, which waits for your choice')
      err.code = 'E_NEEDS_CONSENT'
      err.tried = tried
      throw err
    }
    const err = new Error('No usable pointer for ' + scope + (tried.length ? ': ' + tried.join('; ') : ''))
    err.code = 'E_POINTER'
    err.tried = tried
    err.dohError = !!(dnsInfo && dnsInfo.error)
    throw err
  }
  const record = chosen.record
  // Review round R 5.3 (PTR-5, MF-28): a first visit (no pin for the scope, no memory of the ledger) that meets a recorded
  // rotation (rot= with lo= another key) younger than 24 hours waits; nothing is pinned or saved meanwhile, so a reload
  // is still a first visit. presentOwnerChange shows the wait.
  let rotationHold = null
  if (record.signed && !pin && !chosen.ledgerOwner && typeof record.rot === 'string' && record.rot && typeof record.lo === 'string' && record.lo && record.lo !== record.owner) {
    let d = null
    try { d = await rotationDecision({ prev: null, next: record, firstVisit: true, rotOk: !!chosen.rotated, now: c.now }) } catch (_) { d = null }
    if (d && d.decision === 'delay') rotationHold = d
  }
  let firstTime = false
  if (rotationHold) {
    firstTime = true
  } else if (record.signed && (!pin || pin.owner !== record.owner)) {
    firstTime = !pin
    const extra = { decidedAt: c.now, firstSeen: pin && pin.firstSeen ? pin.firstSeen : c.now }
    if (chosen.rotated) extra.rotatedAt = c.now
    if (cache.savePin) { try { await cache.savePin(scope, record.owner, extra) } catch (_) { /* ignore */ } }
    pin = Object.assign({ owner: record.owner }, extra)
  }
  if (!rotationHold && chosen.source !== 'cache' && cache.savePointer) {
    const ttlUntil = chosen.source === 'dns' && dnsInfo && dnsInfo.answer ? dnsInfo.answer.ttlUntil : null
    try { await cache.savePointer(scope, { record, raw: chosen.raw, source: chosen.source, savedAt: c.now, ttlUntil }) } catch (_) { /* ignore */ }
  }
  if (chosen.expired) warnings.push('expired')
  const exp = num(record.exp)
  if (record.signed && Number.isFinite(exp) && exp * 1000 - c.now < c.config.pointer.expiryWarnDays * 86400000 && exp * 1000 > c.now) warnings.push('expires-soon')
  let ledgerId = null
  if (typeof deps.ledgerIdFor === 'function') ledgerId = await deps.ledgerIdFor(record, scope)
  const lineage = record.signed ? (chosen.lineage === undefined ? null : chosen.lineage) : 'unsigned'
  // PTR-4: the per-ledger floor and owner memory, from a record whose lineage is proven only.
  if (!rotationHold && ledgerId) await noteLedger(cache, ledgerId, record, lineage, c.now)
  return {
    record,
    raw: chosen.raw,
    source: chosen.source,
    scope,
    signed: !!record.signed,
    pin,
    firstTime,
    expired: !!chosen.expired,
    rotated: !!chosen.rotated,
    keyChanged,
    dns: chosen.source === 'dns' ? { resolver: chosen.resolver, ad: !!chosen.ad } : null,
    dnsDeferred: !!(dnsInfo && dnsInfo.deferred),
    dnsNeedsConsent: !!(dnsInfo && dnsInfo.consentNeeded),
    previousRecord: c.previousRecord && c.previousRecord.owner !== record.owner ? c.previousRecord : null,
    previousOwner: previousOwner && previousOwner !== record.owner ? previousOwner : null,
    lineage,
    rotationHold,
    refusedOwners,
    ledgerId,
    warnings,
    tried
  }
}

/**
 * signedSavedRecord(cached, scope, now, deps) → the saved pointer of a scope as its raw text parses and verifies (owner
 * signature, expiry ignored), or null (review round R 5.3, PTR-11). Deps without parsePointer/verifyPointer (tests) fall
 * back to the stored record when it is signed.
 */
async function signedSavedRecord (cached, scope, now, deps) {
  if (!cached) return null
  const raw = typeof cached.raw === 'string' ? cached.raw : (cached.record && typeof cached.record.raw === 'string' ? cached.record.raw : null)
  if (!raw || typeof deps.parsePointer !== 'function' || typeof deps.verifyPointer !== 'function') {
    return cached.record && cached.record.signed ? cached.record : null
  }
  let parsed = null
  try { parsed = deps.parsePointer(raw.trim()) } catch (_) { parsed = null }
  if (!parsed || !parsed.ok || !parsed.record || !parsed.record.signed) return null
  let v = null
  try { v = await deps.verifyPointer(parsed.record, scope, { now, allowExpired: true }) } catch (_) { v = null }
  return v && v.ok ? parsed.record : null
}

/**
 * anchorCandidate(cand, anchorRecord, scope, deps): with no pin, a signed candidate is trusted to
 * replace `anchorRecord` only when it is signed by the same owner or carries a rot= valid from that
 * owner (then rotated); otherwise cand.trusted becomes false (code review round 1). An unsigned
 * anchor anchors nothing.
 */
export async function anchorCandidate (cand, anchorRecord, scope, deps) {
  if (!cand || !cand.record || !cand.record.signed || !anchorRecord || !anchorRecord.signed) return cand
  if (cand.record.owner === anchorRecord.owner) return cand
  let rotated = false
  try { rotated = !!cand.record.rot && await deps.verifyRotation(cand.record, anchorRecord.owner, scope) } catch (_) { rotated = false }
  if (rotated) cand.rotated = true
  else cand.trusted = false
  return cand
}

/**
 * isUpdate(current, candidate, pinOwner) → true when a freshly resolved record should replace the
 * rendered one: signed, trusted (pinned owner or valid rot), a higher seq and a different btih.
 */
export function isUpdate (current, candidate) {
  if (!current || !candidate || candidate.status !== 'ok' || !candidate.record) return false
  const next = candidate.record
  if (!next.signed || !candidate.trusted) return false
  if (current.signed && num(next.seq) <= num(current.seq)) return false
  return next.btih !== current.btih || num(next.seq) > num(current.seq)
}

// ---------------------------------------------------------------------------------------------
// Consent (v0.2.1 C1): the pure rules live in ./consent.js (shared with drop-in mode); re-exported here
// for the tests and callers that imported them from app.js.
// ---------------------------------------------------------------------------------------------

export { audienceOf, consentModeFor, recipientsKey, makeConsentRecord, consentFromRecord, dnsAllowedBy, consentKeyFor }

// ---------------------------------------------------------------------------------------------
// Identity (ARCHITECTURE §6.1, DESIGN-REVIEW items 18, S3)
// ---------------------------------------------------------------------------------------------

function subtle () {
  const c = globalThis.crypto
  if (!c || !c.subtle) throw Object.assign(new Error('WebCrypto is unavailable'), { code: 'E_IDENTITY' })
  return c.subtle
}

function b64urlEncode (bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode (str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) throw Object.assign(new Error('bad base64url'), { code: 'E_IDENTITY' })
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4))
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function deriveWrapKey (passphrase, salt, iterations) {
  const base = await subtle().importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  return subtle().deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

function identityAad (ledgerId, pub) {
  return new TextEncoder().encode('mw-identity-v1\n' + (ledgerId || '') + '\n' + (pub || ''))
}

/** Passphrase-wrapped identity (AES-GCM under PBKDF2-SHA256) as a JSON string. */
export async function exportIdentityText ({ jwk, pub, ledgerId, passphrase, iterations = CONFIG.identity.pbkdf2Iterations }) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) throw Object.assign(new Error(STRINGS.passphraseTooShort), { code: 'E_IDENTITY' })
  if (!jwk || !jwk.d || !pub) throw Object.assign(new Error('this identity cannot be exported'), { code: 'E_IDENTITY' })
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16))
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveWrapKey(passphrase, salt, iterations)
  const plain = new TextEncoder().encode(JSON.stringify({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }))
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: identityAad(ledgerId, pub) }, key, plain))
  return JSON.stringify({ type: 'mw-identity', v: 1, ledger: ledgerId || null, pub, kdf: 'PBKDF2-SHA256', iter: iterations, salt: b64urlEncode(salt), iv: b64urlEncode(iv), ct: b64urlEncode(ct) }, null, 2)
}

/** Reverses exportIdentityText; checks that the decrypted key matches the recorded public key. */
export async function importIdentityText (text, passphrase, { publicFromPrivateJwk } = {}) {
  let obj
  try { obj = JSON.parse(text) } catch (_) { throw Object.assign(new Error(STRINGS.wrongPassphrase), { code: 'E_IDENTITY' }) }
  if (!obj || obj.type !== 'mw-identity' || obj.v !== 1 || obj.kdf !== 'PBKDF2-SHA256') throw Object.assign(new Error(STRINGS.wrongPassphrase), { code: 'E_IDENTITY' })
  const iter = Number(obj.iter)
  if (!Number.isInteger(iter) || iter < 1000 || iter > 10000000) throw Object.assign(new Error(STRINGS.wrongPassphrase), { code: 'E_IDENTITY' })
  let jwk
  try {
    const key = await deriveWrapKey(String(passphrase), b64urlDecode(obj.salt), iter)
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: b64urlDecode(obj.iv), additionalData: identityAad(obj.ledger, obj.pub) }, key, b64urlDecode(obj.ct))
    jwk = JSON.parse(new TextDecoder().decode(plain))
  } catch (_) {
    throw Object.assign(new Error(STRINGS.wrongPassphrase), { code: 'E_IDENTITY' })
  }
  if (typeof publicFromPrivateJwk === 'function') {
    const pub = await publicFromPrivateJwk(jwk)
    if (pub !== obj.pub) throw Object.assign(new Error(STRINGS.wrongPassphrase), { code: 'E_IDENTITY' })
  }
  return { jwk, pub: obj.pub, ledgerId: obj.ledger || null }
}

/**
 * storeKey(cache, crypto, name, { pair, jwk, pub }) → { privateKey, pub, kind }
 * The CryptoKey pair is the whole value of the keys store; a put/get/sign/verify round trip runs
 * first, and when it fails (iOS DataCloneError) the private JWK is stored and imported as a
 * non-extractable key for this session instead.
 */
export async function storeKey (cache, crypto, name, { pair = null, jwk = null, pub, add = false }) {
  // add (code review round 1): never replace a key another tab stored first; null = it did, use that one.
  const put = async (value) => {
    if (add && typeof cache.addKey === 'function') return cache.addKey(name, value)
    await cache.saveKey(name, value)
    return true
  }
  let mine = false
  if (pair) {
    try {
      if (!(await put({ kind: 'cryptokey', privateKey: pair.privateKey, publicKey: pair.publicKey, pub }))) return null
      mine = true
      const back = await cache.getKey(name)
      if (!back || !back.privateKey) throw new Error('round trip lost the key')
      if (add && back.pub !== pub) return null // another tab's key (a cache without addKey): not a failed self-test
      const sig = await crypto.sign(back.privateKey, 'mw-selftest')
      if (!(await crypto.verify(pub, 'mw-selftest', sig))) throw new Error('round trip key does not verify')
      return { privateKey: back.privateKey, pub, kind: 'cryptokey' }
    } catch (_) {
      if (!jwk) jwk = await crypto.exportPrivateJwk(pair.privateKey)
    }
  }
  const value = { kind: 'jwk', jwk, pub }
  if (mine) await cache.saveKey(name, value) // replaces our own unusable record
  else if (!(await put(value))) return null
  const privateKey = await crypto.importPrivateJwk(jwk, { extractable: false })
  return { privateKey, pub, kind: 'jwk' }
}

async function readIdentity (cache, crypto, name) {
  let rec = null
  try { rec = await cache.getKey(name) } catch (_) { rec = null }
  if (rec && rec.kind === 'cryptokey' && rec.privateKey && rec.pub) return { privateKey: rec.privateKey, pub: rec.pub, kind: 'cryptokey', record: rec }
  if (rec && rec.kind === 'jwk' && rec.jwk && rec.pub) {
    const privateKey = await crypto.importPrivateJwk(rec.jwk, { extractable: false })
    return { privateKey, pub: rec.pub, kind: 'jwk', record: rec }
  }
  return null
}

/**
 * Loads (or, with create, makes) the visitor's ledger identity for ledgerId, keyed 'identity:<ledgerId>'.
 * Code review round 1: only the engine tab creates (create: false in followers), and creation is atomic
 * (cache.addKey): when another tab stored a key first, that key is used.
 */
export async function ensureIdentity ({ cache, crypto, ledgerId, create = true }) {
  const name = 'identity:' + ledgerId
  const found = await readIdentity(cache, crypto, name)
  if (found || !create) return found
  // Extractable so Settings can export it (passphrase-wrapped); it never leaves this origin otherwise.
  const pair = await crypto.generateKeyPair({ extractable: true })
  const pub = await crypto.exportPublicKey(pair.publicKey)
  const stored = await storeKey(cache, crypto, name, { pair, pub, add: true })
  if (stored === null) {
    const theirs = await readIdentity(cache, crypto, name)
    if (theirs) return theirs
    throw Object.assign(new Error('the identity another tab created could not be read'), { code: 'E_IDENTITY' })
  }
  return Object.assign(stored, { record: await cache.getKey(name).catch(() => null) })
}

// ---------------------------------------------------------------------------------------------
// One engine per origin (ARCHITECTURE §5.9): Web Locks leader election + BroadcastChannel
// ---------------------------------------------------------------------------------------------

/**
 * electLeader(name, { locks }) → { immediate: Promise<boolean>, becomeLeader: Promise<void>, release() }
 * immediate tells at once whether this tab holds the lock; becomeLeader resolves when it does
 * (now, or when the current leader goes away). Without Web Locks every tab leads.
 */
export function electLeader (name, { locks = (typeof navigator !== 'undefined' ? navigator.locks : null) } = {}) {
  let release = () => {}
  const held = new Promise((resolve) => { release = resolve })
  let resolveImmediate
  let resolveLeader
  const immediate = new Promise((resolve) => { resolveImmediate = resolve })
  const becomeLeader = new Promise((resolve) => { resolveLeader = resolve })
  if (!locks || typeof locks.request !== 'function') {
    resolveImmediate(true)
    resolveLeader()
    return { immediate, becomeLeader, release: () => {} }
  }
  let leader = false
  const take = () => { leader = true; resolveLeader(); return held }
  try {
    locks.request(name, { ifAvailable: true }, (lock) => {
      if (lock) { resolveImmediate(true); return take() }
      resolveImmediate(false)
      locks.request(name, () => take()).catch(() => {})
      return null
    }).catch(() => { if (!leader) { resolveImmediate(true); resolveLeader() } })
  } catch (_) {
    resolveImmediate(true)
    resolveLeader()
  }
  return { immediate, becomeLeader, release: () => release() }
}

const TAB_METHODS = new Set(['put', 'del', 'append', 'profile', 'tombstone', 'ban'])
const TAB_ARITY = { put: 2, append: 2, del: 1, profile: 1, tombstone: 1, ban: 1 }

/** Validates a tab-link message (same-origin BroadcastChannel, still treated as untrusted data). */
export function validTabMessage (m) {
  if (!m || typeof m !== 'object' || m.mw !== 1 || typeof m.t !== 'string' || typeof m.from !== 'string') return false
  switch (m.t) {
    case 'leader': case 'need-state': case 'signed-out': return true
    case 'state': return !!m.snap && typeof m.snap === 'object'
    case 'site': case 'version': case 'need-site': return typeof m.btih === 'string' && BTIH_RE.test(m.btih)
    case 'consent': return m.state === 'accepted' || m.state === 'host-only' || m.state === 'pending'
    case 'call': return typeof m.id === 'string' && TAB_METHODS.has(m.method) && Array.isArray(m.args) && m.args.length <= 2
    case 'result': return typeof m.id === 'string' && typeof m.to === 'string'
    case 'cancel': return typeof m.id === 'string'
    case 'pow': return typeof m.id === 'string' && typeof m.to === 'string' && Number.isFinite(m.hashes)
    default: return false
  }
}

/** Follower-side stand-in for ChainNode: snapshots from the leader, writes forwarded to it. */
export class RemoteNode {
  constructor (link) {
    this.link = link
    this._snap = null
    this._subs = new Set()
    this.peers = 0
    this.inSyncPeers = 0
    this.height = 0
    this.role = 'reader'
    this.identity = null
    this.ownerMismatch = false
    this.unmoderated = false
  }

  get state () { return null }
  snapshot () { return this._snap }
  subscribe (fn) { this._subs.add(fn); return () => this._subs.delete(fn) }

  apply (m) {
    this._snap = m.snap
    this.peers = Number(m.peers) || 0
    this.inSyncPeers = Number(m.inSync) || 0
    this.height = Number(m.snap && m.snap.height) || 0
    if (typeof m.role === 'string') this.role = m.role
    if (m.identity && typeof m.identity === 'object') this.identity = m.identity
    for (const fn of this._subs) { try { fn(this._snap, { reason: 'remote' }) } catch (_) { /* ignore */ } }
  }

  // Writes take ChainNode's { signal, onProgress }: the leader tab mines, reports the fee's progress
  // back and aborts when this tab cancels (code review round 1).
  put (k, v, opts) { return this.link.call('put', [k, v], opts) }
  del (k, opts) { return this.link.call('del', [k], opts) }
  append (l, v, opts) { return this.link.call('append', [l, v], opts) }
  profile (name, opts) { return this.link.call('profile', [name], opts) }
  tombstone (h, opts) { return this.link.call('tombstone', [h], opts) }
  ban (author, opts) { return this.link.call('ban', [author], opts) }
}

/** BroadcastChannel('mw-' + ledgerId) wrapper with request/response for forwarded writes. */
export class TabLink {
  constructor (ledgerId, { Channel = (typeof BroadcastChannel === 'function' ? BroadcastChannel : null), timeoutMs = 60000 } = {}) {
    this.id = Math.random().toString(36).slice(2) + Date.now().toString(36)
    this.channel = Channel ? new Channel('mw-' + ledgerId) : null
    this.handlers = new Set()
    this.pending = new Map()
    this.timeoutMs = timeoutMs
    this.seq = 0
    if (this.channel) this.channel.onmessage = (e) => this._receive(e && e.data)
  }

  on (fn) { this.handlers.add(fn); return () => this.handlers.delete(fn) }

  send (t, data = {}) {
    if (!this.channel) return false
    try { this.channel.postMessage(Object.assign({}, data, { mw: 1, t, from: this.id })); return true } catch (_) { return false }
  }

  /**
   * call(method, args, { signal, onProgress }) → the leader's result. The answer may take as long as
   * the leader keeps reporting progress ('pow'); without news for timeoutMs, or when `signal` aborts,
   * the leader is told to cancel ('cancel') and the call rejects.
   */
  call (method, args, opts) {
    if (!this.channel) return Promise.reject(Object.assign(new Error('no tab link'), { code: 'E_IDENTITY' }))
    const signal = opts && opts.signal && typeof opts.signal.addEventListener === 'function' ? opts.signal : null
    const onProgress = opts && typeof opts.onProgress === 'function' ? opts.onProgress : null
    if (signal && signal.aborted) return Promise.reject(Object.assign(new Error('the write was cancelled'), { name: 'AbortError', code: 'E_POW_ABORTED' }))
    const id = this.id + ':' + (++this.seq)
    return new Promise((resolve, reject) => {
      let onAbort = null
      const settle = (fn, value) => {
        const p = this.pending.get(id)
        if (!p) return
        this.pending.delete(id)
        clearTimeout(p.timer)
        if (signal && onAbort) signal.removeEventListener('abort', onAbort)
        fn(value)
      }
      const expire = () => {
        this.send('cancel', { id })
        settle(reject, Object.assign(new Error('the tab running this site did not answer'), { code: 'E_INTERNAL' }))
      }
      this.pending.set(id, {
        resolve: (v) => settle(resolve, v),
        reject: (e) => settle(reject, e),
        timer: setTimeout(expire, this.timeoutMs),
        expire,
        onProgress
      })
      if (signal) {
        onAbort = () => {
          this.send('cancel', { id })
          settle(reject, Object.assign(new Error('the write was cancelled'), { name: 'AbortError', code: 'E_POW_ABORTED' }))
        }
        signal.addEventListener('abort', onAbort)
      }
      this.send('call', { id, method, args })
    })
  }

  _receive (m) {
    if (!validTabMessage(m) || m.from === this.id) return
    if (m.t === 'result') {
      if (m.to !== this.id) return
      const p = this.pending.get(m.id)
      if (!p) return
      if (m.ok) p.resolve(m.result)
      else p.reject(Object.assign(new Error((m.error && m.error.message) || 'failed'), { code: (m.error && m.error.code) || 'E_INTERNAL' }))
      return
    }
    if (m.t === 'pow') {
      if (m.to !== this.id) return
      const p = this.pending.get(m.id)
      if (!p) return
      clearTimeout(p.timer)
      p.timer = setTimeout(p.expire, this.timeoutMs) // the leader is still working on it
      if (p.onProgress) { try { p.onProgress({ hashes: m.hashes, bits: Number(m.bits) || 0 }) } catch (_) { /* ignore */ } }
      return
    }
    for (const fn of this.handlers) { try { fn(m) } catch (_) { /* ignore */ } }
  }

  close () {
    for (const p of this.pending.values()) clearTimeout(p.timer)
    this.pending.clear()
    try { if (this.channel) this.channel.close() } catch (_) { /* ignore */ }
    this.channel = null
  }
}

// ---------------------------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------------------------

let startPromise = null

/** start(): runs the shell loader once per page (ARCHITECTURE §5). */
export default function start (options = {}) {
  if (startPromise) return startPromise
  startPromise = run(options || {}).catch((err) => {
    if (typeof console !== 'undefined') console.error('[mw] loader failed', err)
    throw err
  })
  return startPromise
}
export { start }

async function loadDeps () {
  const [cache, doh, verify, pointer, torrentFile, crypto, canonical] = await Promise.all([
    import('./cache.js'),
    import('./doh.js'),
    import('./verify.js'),
    import('../common/pointer.js'),
    import('../common/torrent-file.js'),
    import('../chain/crypto.js'),
    import('../chain/canonical.js')
  ])
  return { cache, doh, verify, pointer, torrentFile, crypto, canonical }
}

async function loadChainDeps () {
  const [node, stores, powClient, verifyPool, block] = await Promise.all([
    import('../chain/node.js'),
    import('../chain/stores.js'),
    import('../chain/pow-client.js'),
    import('../chain/verify-pool.js'),
    import('../chain/block.js')
  ])
  return { ChainNode: node.ChainNode, IdbBlockStore: stores.IdbBlockStore, MemoryBlockStore: stores.MemoryBlockStore, createMiner: powClient.createMiner, createVerifierPool: verifyPool.createVerifierPool, createBlock: block.createBlock }
}

function metaContent (doc, name) {
  const m = doc.querySelector('meta[name="' + name + '"]')
  return m ? String(m.getAttribute('content') || '').trim() : ''
}

function withTimeout (promise, ms, fallback) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms) })
  ]).finally(() => clearTimeout(timer))
}

async function safeFingerprint (A, pub) {
  if (!pub) return null
  // v0.2.1 A2: keys are 'p256:' + base64url; the fallback shows the body, never the tag.
  try { return await A.deps.crypto.fingerprint(pub) } catch (_) { return A.deps.crypto && typeof A.deps.crypto.shortKey === 'function' ? A.deps.crypto.shortKey(pub) : String(pub).slice(0, 8) }
}

function errMessage (err) { return (err && err.message) || String(err) }

async function run (options) {
  const win = options.window || window
  const doc = win.document
  const boot = win.__mwBoot || (win.__mwBoot = { ok: true, soft: {}, features: {} })
  boot.started = true
  const config = options.config || CONFIG
  if (!boot.csp) { try { boot.cspKind = boot.degraded ? 'degraded' : 'normal'; boot.csp = insertCsp(boot.cspKind, !!boot.dev, { doc }) } catch (_) { /* ignore */ } }
  const root = doc.getElementById('mw-root') || doc.body
  // v0.3: the in-page cards' Sign in and identity buttons run inside the person's click (lane ui, actions).
  const ui = createUI(root, STRINGS, {
    actions: {
      signIn: (o) => A.api.signInFromCard(o || {}),
      openIdentity: () => A.api.openIdentityFromCard()
    },
    lang: (win.navigator && win.navigator.language) || 'en'
  })
  const A = {
    win, doc, boot, ui, config,
    origin: win.location.origin,
    log: (line) => { try { ui.diagnostics.log(line) } catch (_) { /* ignore */ } },
    consentState: 'pending',
    consentListeners: new Set(),
    consentWaiters: new ConsentWaiters(),
    tabCalls: new Map(), // writes forwarded by follower tabs: from + ' ' + id -> AbortController
    prefs: { share: true, hostOnly: false, shareOnNetwork: false },
    node: null,
    nodeStore: null,
    tm: null,
    bridge: null,
    mount: null,
    destroyed: false,
    startedAt: Date.now()
  }
  // C2 wire-ui: the seeding choices of this page (declarations last for the page only; seedAsked and keeper per origin),
  // the call state the calls service reports (onSeedYield), and the loader-owned call panel (SZ 3.1.3, 3.1.4, 3.5).
  Object.assign(A.prefs, { declaredWifi: false, declaredPlugged: false, seedAsked: false, keeper: false })
  A.callYield = null
  A.callUi = createCallUi({ win, doc, lang: (win.navigator && win.navigator.language) || 'en', cssHref: ((config.paths && config.paths.assets) || '/_mw/') + 'ui.css', log: (line) => A.log('call panel: ' + line), phone: () => Boolean(A.env && A.env.isMobile) })
  A.tracker = new ActivationTracker({ nav: win.navigator || null })
  A.api = createPageApi(A)
  win.addEventListener('error', (e) => A.log('error: ' + (e.message || e.type)))
  win.addEventListener('unhandledrejection', (e) => A.log('unhandled: ' + errMessage(e.reason)))
  // Diagnostics handle for tests and support (the drop-in runtime has window.__mwDropin): read-only. rectOf(label)
  // is the rectangle of a button of the open loader card (its root is closed), as __mwDropin.rectOf: a test clicks
  // it with a real mouse event, since script clicks are ignored (isTrusted). Geometry only, never content.
  const rectOf = (label) => {
    try {
      const cards = A.ui && A.ui.cards
      // C2 wire-ui: or a button of the call panel (its root is closed too)
      return cards && cards.open ? cards.rectOf(label) : (A.callUi ? A.callUi.rectOf(label) : null)
    } catch (_) { return null }
  }
  // C2 integrator (calls request R-3): "same local network" and "Hide my IP from people I call" for this page only, never
  // stored, and only in a development build (loopback or <meta name="mw-dev">). C2 has no switch or strings for them (both
  // start off); two browsers on one machine, as in the e2e suite, have nothing but loopback and private candidates, which
  // the call filter drops unless both people chose "same local network".
  const setCallPrefs = (p) => {
    const o = p && typeof p === 'object' ? p : {}
    A.callPrefs = { sameLan: o.sameLan === true, hideIp: o.hideIp === true }
    return Object.assign({}, A.callPrefs)
  }
  const shellHooks = { version: config.version, inspect: () => inspectShell(A), rectOf }
  if (boot && boot.dev === true) shellHooks.setCallPrefs = setCallPrefs
  try { win.__mwShell = Object.freeze(shellHooks) } catch (_) { /* frozen window */ }
  ui.setStatus(STRINGS.starting)

  const soft = boot.soft || {}
  A.webrtc = soft.webrtc !== false && typeof win.RTCPeerConnection === 'function'
  // boot.forcedDegraded: this tab session runs limited mode (code review round 1; render.js requestDegradedReload).
  A.hasSw = soft.serviceWorker !== false && !boot.forcedDegraded && !!(win.navigator && win.navigator.serviceWorker)
  if (!A.webrtc) ui.setMode({ hostOnly: true })
  if (soft.lockdown) ui.setBanner('lockdown', STRINGS.lockdown, { kind: 'warn' })

  const metaPointer = metaContent(doc, 'mw-pointer') || null
  A.mode = resolveMode(win.location, { metaPointer, hubMeta: metaContent(doc, 'mw-hub') || null, dev: !!boot.dev })
  A.log('mode ' + A.mode.mode)
  if (doorCspReload(A)) return A // C2 doors: the door page runs under the limited-mode policy (one reload), others leave it
  if (A.mode.mode === 'redirect') {
    win.location.replace(A.mode.to)
    return A
  }
  if (A.mode.mode === 'idp-return') {
    // v0.3 (R 2.3.1): the identity origin's answer arrives in this address's fragment. Finish it, put the site's
    // own address back (history only: the working keys stay in this document) and boot the page as usual.
    const back = await finishIdpReturn(A)
    if (!back) return A
    A.mode = resolveMode(win.location, { metaPointer, hubMeta: metaContent(doc, 'mw-hub') || null, dev: !!boot.dev })
    A.log('sign-in answer taken; mode ' + A.mode.mode)
  }

  try {
    A.deps = await loadDeps()
  } catch (err) {
    ui.setStatus(STRINGS.engineMissingTitle, 'error')
    ui.showError({ title: STRINGS.engineMissingTitle, detail: STRINGS.engineMissing + '\n' + errMessage(err), actions: [{ label: STRINGS.reload, primary: true, onClick: () => win.location.reload() }] })
    return A
  }
  if (A.mode.mode === 'hub-root') return runHubRoot(A, metaPointer)
  // C2 doors: the door page without a link offers "Open a link" (S4 D6: iOS and Firefox have no web+felinar: handler).
  if (A.mode.mode === 'door' && !A.mode.fragment) return runDoorPaste(A)

  // Service Worker in parallel with everything else (§5.2); boot.js already called register().
  A.swPromise = A.hasSw
    ? registerServiceWorker({ url: config.paths.sw, readyTimeoutMs: config.timeouts.swReadyMs, proto: config.proto, shell: true, existing: boot.swProbe || null, onWaiting: () => { if (!A.mount) ui.setStatus(STRINGS.preparingEngine) } })
    : Promise.resolve({ ok: false, degraded: true, controlled: false, reloaded: false, error: 'no-service-worker' })
  // The worker verifies every file before it serves it (§7.3); when a stored copy fails, it deletes
  // the copy and tells the pages, and the engine tab downloads the site again and remounts it.
  if (A.hasSw) {
    try {
      win.navigator.serviceWorker.addEventListener('message', (e) => {
        const d = e && e.data
        if (!d || typeof d !== 'object' || d.proto !== config.proto || d.type !== 'mw-site-invalid') return
        if (!A.btih || d.btih !== A.btih) return
        A.log('service worker: stored copy unusable (' + (d.reason || 'invalid') + (d.path ? ' at ' + d.path : '') + ')')
        handleCorruptCache(A)
      })
    } catch (_) { /* no message channel to the worker */ }
  }
  A.swPromise.then((sw) => {
    A.log('service worker ok=' + sw.ok + ' controlled=' + sw.controlled + (sw.error ? ' ' + sw.error : ''))
    if (sw.ok) {
      watchController({ proto: config.proto, onMismatch: () => ui.setBanner('sw', STRINGS.swOutdated, { kind: 'warn', actions: [{ label: STRINGS.reload, onClick: () => win.location.reload() }] }) })
      pingServiceWorker({ proto: config.proto }).then((pong) => {
        if (pong && pong.proto !== config.proto) ui.setBanner('sw', STRINGS.swOutdated, { kind: 'warn', actions: [{ label: STRINGS.reload, onClick: () => win.location.reload() }] })
      })
    }
  })

  A.battery = await readBattery({ onChange: (b) => { A.battery = b; refreshEnvironment(A) } })
  A.env = detectEnvironment({ battery: A.battery })
  await setupSeeding(A) // C2 wire-ui: dock mode, the seed meters and the mw.net control
  await loadPrefs(A)
  await setupDoors(A) // C2 doors: the health memory of doors (a pref), read before anything is fetched
  // v0.3 (MF-30): pins and key-change refusals are signed by this device's non-extractable key.
  await loadDeviceKey(A)
  // The stored consent record (per origin) says whether a DoH lookup may run before the card (C1).
  A.consentRecord = await readConsentRecord(A, consentKeyFor(consentModeOf(A), null)) // C2 doors: per site on a door

  // ---- pointer (§4) ----
  ui.setStatus(STRINGS.resolving)
  try {
    A.resolved = await resolveSitePointer(A, metaPointer)
  } catch (err) {
    if (!(err && err.code === 'E_NEEDS_CONSENT')) {
      presentPointerError(A, err)
      return A
    }
    // Only DNS knows this site and nobody has chosen yet: the card comes first, then the lookup (C1).
    const choice = await askBeforeDns(A)
    if (!choice) return A
    A.preChoice = choice
    try {
      A.resolved = await resolveSitePointer(A, metaPointer, { dohAllowed: true })
    } catch (err2) {
      presentPointerError(A, err2)
      return A
    }
  }
  if (!A.resolved) return A
  const r = A.resolved
  A.record = r.record
  A.btih = r.record.btih
  A.scope = r.scope
  A.ledgerId = r.ledgerId
  A.log('pointer ' + r.source + ' btih=' + A.btih + ' ledger=' + A.ledgerId)
  // v0.3 (SC-6): a loader older than the pointer's ml= floor refuses to mount and offers the update.
  if (!loaderFloorOk(r.record.ml, A.config.version)) {
    presentLoaderTooOld(A, r.record.ml)
    return A
  }
  // v0.3 (MF-31, HUB H10): on a hub, a ledger without an owner is read only (nobody can moderate it).
  A.readOnlyLedger = A.mode.mode !== 'shell' && isReadOnlyHubLedger({ hub: true, record: r.record, ledgerId: r.ledgerId })
  if (A.readOnlyLedger) A.log('ownerless ledger on a hub: read only')
  // Review round R 5.3 (PTR-1, MF-04): a record whose lo= is not proven (no rot= from lo=, no continuity this device saw)
  // does not earn the ledger it names. On a hub address (the label IS that ledger) it is refused; on a shared hub
  // origin or a door it mounts read only, with no restored sign-in, no moderator key and no "current site".
  const lineageAct = lineageAction(A.mode.mode, r)
  A.lineageUnproven = lineageAct === 'refuse' || lineageAct === 'read-only'
  if (lineageAct !== 'ok') {
    A.log('pointer lineage unproven (' + lineageAct + '): lo=' + String(r.record.lo).slice(0, 20) + ' owner=' + String(r.record.owner).slice(0, 20))
    if (lineageAct === 'refuse') {
      ui.setStatus(STRINGS.hubLabelMismatch, 'error')
      ui.showError({ title: STRINGS.pointerNotFoundTitle, detail: await lineageText(A, r.record) })
      return A
    }
    if (lineageAct === 'read-only') {
      A.readOnlyLedger = true
      ui.setBanner('lineage', await lineageText(A, r.record), { kind: 'warn' })
    }
  }
  if (A.mode.mode === 'hub-sub') {
    const label = A.deps.pointer.hubLabelFor(r.record, r.ledgerId)
    if (label !== A.mode.label) {
      ui.setStatus(STRINGS.hubLabelMismatch, 'error')
      ui.showError({ title: STRINGS.pointerNotFoundTitle, detail: STRINGS.hubLabelMismatch })
      return A
    }
    // The pointer is cached now; once the visitor has answered the gate (or no gate is needed) it
    // leaves the address bar so the site's own fragments work. Until then "Show again" reloads the
    // same link (code review round 1).
    A.stripFragment = () => {
      A.stripFragment = null
      if (A.mode.fragment) { try { win.history.replaceState(null, '', A.mode.path) } catch (_) { /* ignore */ } }
    }
  }
  // v0.2.1 A3: a valid withdrawal (st= other than ok) stops here: nothing is served or seeded,
  // every stored version is deleted and the publisher's reason is shown (fail closed). A withdrawal
  // that arrives by a link deletes the stored copy only after a click (code review round 1).
  if (r.record.withdrawn) {
    // v0.3 (MF-30): a withdrawal binds at most 30 days after it was signed; an expired one deletes nothing.
    const ws = withdrawalState(r.record)
    await presentWithdrawal(A, { askFirst: A.mode.mode !== 'shell' && r.source === 'fragment', binding: ws.binding })
    return A
  }
  if (r.record.dn) doc.title = String(r.record.dn)
  await loadDoorMemory(A) // C2 doors: the last good door and the accepted _doors list of this ledger on this origin
  await presentPointer(A)
  // v0.3 (MF-28): an owner key change is shown ("owner changed N minutes ago"); a first visit that meets a fresh
  // rotation waits (rotationDecision), unless nx= vouched for the new key.
  // Review round R 5.3 (PTR-5): a first visit that meets a fresh recorded rotation is held too (r.rotationHold).
  if (r.signed && (r.rotated || r.keyChanged || r.rotationHold)) {
    const held = await presentOwnerChange(A, r)
    if (held) return A
  }

  A.consentState = await readConsent(A)
  recomputePolicy(A)
  updateSubline(A)
  if (peersAllowed(A)) startProbe(A)

  // ---- one engine per origin (§5.9) ----
  A.leader = electLeader('mw-swarm-' + A.ledgerId)
  A.isLeader = await A.leader.immediate
  A.link = new TabLink(A.ledgerId)
  installTabLink(A)
  A.log(A.isLeader ? 'engine tab' : 'follower tab')

  // ---- v0.3: identity, chat, files, media and (hub mode) followed ledgers (R 2.11; the SVC contract) ----
  await setupV03(A)

  installSettings(A)
  installLifecycle(A)

  // ---- cache first (§5.4) ----
  const cached = await lookupCache(A)
  const gate = needsGate(A, !!cached)
  if (A.consentState === 'pending') {
    if (gate) A.gatePromise = openGate(A)
    else showConsentCard(A)
  }
  if (!A.gatePromise && A.stripFragment) A.stripFragment()

  if (A.isLeader) A.ledgerPromise = openLedger(A)
  else A.ledgerPromise = followLedger(A)

  if (cached) {
    if (A.gatePromise && (A.mode.mode === 'hub-shared' || A.mode.mode === 'door')) { // C2 doors: a stored copy waits for the gate too
      const decision = await A.gatePromise
      if (decision === 'cancel') return A
    }
    const rendered = await renderSite(A, cached)
    if (!rendered) return A
    if (A.isLeader) startEngine(A)
    else A.leader.becomeLeader.then(() => promoteToLeader(A))
  } else {
    const site = await obtainSite(A)
    if (!site) return A
    const rendered = await renderSite(A, site)
    if (!rendered) return A
  }
  afterRender(A)
  return A
}

/** inspectShell(A) → plain data about this page's engine (window.__mwShell.inspect()). */
function inspectShell (A) {
  const node = A.node
  const tm = A.tm
  let ledger = null
  if (node) {
    ledger = { height: null, root: null, peers: 0, inSyncPeers: 0, role: null, follower: node === A.followerNode }
    try { ledger.height = node.height } catch (_) { /* closed */ }
    try { if (node.dag && typeof node.dag.root === 'function') ledger.root = node.dag.root() } catch (_) { /* follower */ }
    try { ledger.peers = node.peers || 0; ledger.inSyncPeers = node.inSyncPeers || 0; ledger.role = node.role || null } catch (_) { /* closed */ }
  }
  let lines = []
  try { lines = A.ui.diagnostics.lines() } catch (_) { lines = [] }
  return {
    mode: A.mode ? A.mode.mode : null,
    btih: A.btih || null,
    ledgerId: A.ledgerId || null,
    signed: !!(A.record && A.record.signed),
    pointerSource: A.resolved ? A.resolved.source : null,
    withdrawn: A.withdrawn || null,
    consent: A.consentState,
    leader: !!A.isLeader,
    degraded: !!A.degraded,
    mounted: !!A.mount,
    fromCache: !!A.fromCache,
    source: A.fromCache ? 'cache' : (tm ? tm.source : null),
    peers: tm ? tm.peers : 0,
    // Post-wave fix H: the piece bytes this page passed on to other visitors (progress.uploaded).
    uploaded: tm ? tm.uploadedBytes || 0 : 0,
    uploads: A.policy ? !!A.policy.uploadsEnabled : null,
    hostOnly: A.policy ? !!A.policy.hostOnly : null,
    // v0.2.1 additions (read-only, for tests and support)
    policyClass: A.policy ? A.policy.class : null,
    consentRecord: A.consentRecord ? Object.assign({}, A.consentRecord) : null,
    connectivity: A.connectivity ? { cls: A.connectivity.cls, answered: A.connectivity.answered.slice(), tDone: A.connectivity.tDone } : null,
    iceServers: A.iceServers ? stunUrlsOf(A.iceServers) : null,
    rendezvous: tm && tm.rendezvous ? { infoHash: tm.rendezvous.infoHash, joined: !!tm.rendezvous.torrent, wires: tm.swarmWires('rendezvous') } : null,
    siteWires: tm ? tm.swarmWires('site') : 0,
    wireDrops: tm ? tm.failures.dropped : 0,
    webseedBackoff: tm ? Object.keys(tm.failures.webseedBackoff) : [],
    rebuilds: A.rebuilds || 0,
    verifierPool: A.verifierPool ? A.verifierPool.mode || null : null,
    ledger,
    // v0.3 final integration: the hub follow lane (mw_chain2), read-only, for tests and support.
    hubLane: hubLaneInfo(A),
    // C2 wire-ui (read-only, for tests and support): the seed budget row, lane rates and local counters, dock mode, the
    // keeper tab, the carry meter's counts, and the call panel's state (never media).
    seeding: seedingInfo(A),
    calls: A.callUi ? A.callUi.inspect() : null,
    doors: doorsInfo(A), // C2 doors (read-only): candidates, health memory, the last probe, the banner, the door view
    pin: pinInfo(A), // C2 integrator (read-only): _mw.cfg.pin, whether this page is the pin node, authenticated pin wires, receipts
    log: lines
  }
}

/** pinInfo(A) -> read-only mw_pin1 state for window.__mwShell.inspect() (tests and support); no key material beyond the public key. */
function pinInfo (A) {
  const pw = A.pinWire
  if (!pw) return null
  let wires = 0
  let receipts = 0
  try { wires = pw.pinWires().length } catch (_) { wires = 0 }
  try { receipts = pw._receipts ? pw._receipts.size : 0 } catch (_) { receipts = 0 }
  const hb = pw.heartbeat()
  return { key: pw.key, responder: pw.responder, pinPage: !!A.pinPage, host: typeof A.win.__mwPinHost === 'object' && A.win.__mwPinHost !== null, wires, receipts, heartbeat: hb ? { at: hb.at, checkedAt: hb.checkedAt } : null }
}

function hubLaneInfo (A) {
  if (!A.multi) return null
  const out = { joined: !!A.hubLane, clock: !!A.multiClock, stats: null, held: [], followed: [] }
  try { out.stats = A.multi.stats } catch (_) { out.stats = null }
  try { out.held = Array.from(A.multi._held ? A.multi._held.keys() : []) } catch (_) { out.held = [] }
  try { out.followed = Array.from(A.multi._follow ? A.multi._follow.keys() : []) } catch (_) { out.followed = [] }
  try { out.peers = Array.from(A.multi._peers ? A.multi._peers.keys() : []).map((id) => A.multi.peerInfo(id)) } catch (_) { out.peers = [] }
  // Social fixer (E-SO-2 diagnosis): the lane's own view of the torrent side (kind, wires the manager holds, the cap it asks for).
  try {
    out.kind = A.hubLane ? A.hubLane.kind : null
    out.torrent = !!(A.hubLane && A.hubLane.torrent)
    out.hidden = A.multi.hidden === true
    out.wanted = A.multi.wantedWires
    out.wires = A.tm && A.hubLane ? A.tm.swarmWires(A.hubLane.kind) : 0
    out.sameTm = !!(A.hubLane && A.hubLane._tm === A.tm)
    out.tmCount = A.tmCount || 0
    const f = A.tm ? A.tm.failures : null
    if (f) out.tm = { swarm: (f.swarm || {})[out.kind] || null, iceFailed: f.iceFailed, dropped: f.dropped, capped: f.capped, ignored: f.ignored, budget: f.budget, lastIceError: f.lastIceError }
  } catch (_) { /* diagnostics only */ }
  return out
}

// ---- hub root (wildcard): compute the label and redirect (§3.2) ----------------------------------

async function runHubRoot (A, metaPointer) {
  const { ui, win } = A
  const fragment = A.mode.fragment
  if (!fragment) {
    ui.setStatus(STRINGS.hubLanding)
    ui.showError({ title: STRINGS.pointerNotFoundTitle, detail: STRINGS.hubLanding })
    return A
  }
  ui.setStatus(STRINGS.resolving)
  // Code review round 1: the stored choice of this origin decides whether a #host: link may ask DNS
  // (C1); without one the blocking card comes first, then the lookup, then the redirect.
  A.consentRecord = await readConsentRecord(A, consentKeyFor(A.mode.mode, null))
  try {
    let res
    try {
      res = await resolveSitePointer(A, metaPointer)
    } catch (err) {
      if (!(err && err.code === 'E_NEEDS_CONSENT')) throw err
      const choice = await askBeforeDns(A)
      if (!choice) return A
      await saveConsentRecord(A, choice, { dns: true })
      ui.setStatus(STRINGS.resolving)
      res = await resolveSitePointer(A, metaPointer, { dohAllowed: true })
    }
    const label = A.deps.pointer.hubLabelFor(res.record, res.ledgerId)
    const port = win.location.port ? ':' + win.location.port : ''
    const hash = win.location.hash || ('#' + (A.mode.fragment.text || ''))
    win.location.replace(win.location.protocol + '//' + label + '.' + A.mode.hubHost + port + '/' + hash)
  } catch (err) {
    presentPointerError(A, err)
  }
  return A
}

// ---- prefs, consent, policy -----------------------------------------------------------------------

async function loadPrefs (A) {
  const c = A.deps.cache
  const get = async (k, d) => { try { const v = await c.getPref(k, d); return v === undefined ? d : v } catch (_) { return d } }
  A.prefs.share = (await get('uploads', true)) !== false
  A.prefs.hostOnly = (await get('hostOnly', false)) === true
  A.prefs.shareOnNetwork = (await get('shareOnNetwork:' + A.origin, false)) === true
  // C2 wire-ui: the seed.ask card was answered on this origin (SZ-1), and the desktop keeper tab ("Keep this site").
  A.prefs.seedAsked = (await get('seedAsked:' + A.origin, false)) === true
  A.prefs.keeper = (await get('keeper:' + A.origin, false)) === true
}

async function readConsentRecord (A, key) {
  try {
    const v = await A.deps.cache.getPref(key, null)
    return v && typeof v === 'object' ? v : null
  } catch (_) { return null }
}

/**
 * readConsent(A) → 'accepted' | 'host-only' | 'pending' for the resolved pointer: a choice made in the
 * card before the DNS lookup is stored now (its recipients are known only after resolution); otherwise the
 * stored record counts when its version and recipients match (C1).
 */
async function readConsent (A) {
  const key = consentKeyFor(consentModeOf(A), A.ledgerId) // C2 doors
  if (A.preChoice) {
    await saveConsentRecord(A, A.preChoice, { dns: true })
    return A.preChoice
  }
  const rec = key === consentKeyFor(consentModeOf(A), null) && A.consentRecord ? A.consentRecord : await readConsentRecord(A, key)
  A.consentRecord = rec
  return consentFromRecord(rec, { rcpt: recipientsKey(A.record, A.config), config: A.config })
}

async function saveConsentRecord (A, choice, { dns = false } = {}) {
  // Code review round 3 (N1): an earlier record's DNS permission carries over only on a site found through
  // DNS, where either choice allows the lookup that resolves the pointer. On a page-tag site the lookup is
  // only an update check that "Share and load" covers, so "Load from host only" stores dns: false whatever
  // an older (re-asked) record said.
  const pageTag = !!(A.resolved && A.resolved.dnsNeedsConsent)
  const inherited = !pageTag && dnsAllowedBy(A.consentRecord, A.config)
  const rec = makeConsentRecord({
    choice,
    dns: dns || inherited,
    scope: consentModeOf(A) === 'hub-shared' ? (A.ledgerId || null) : A.origin, // C2 doors: a door keeps one choice per site
    rcpt: A.record ? recipientsKey(A.record, A.config) : '',
    config: A.config
  })
  A.consentRecord = rec
  try { await A.deps.cache.setPref(consentKeyFor(consentModeOf(A), A.ledgerId), rec) } catch (_) { /* best effort */ }
  return rec
}

/** navigator.storage.persist() only from the consent click itself (digest P1-7: never at load). */
function persistFromGesture (A) {
  try {
    A.deps.cache.requestPersist().then((v) => { A.persisted = v; refreshSettings(A) }).catch(() => { A.persisted = null })
  } catch (_) { A.persisted = null }
}

/**
 * askBeforeDns(A) → Promise<'accepted' | 'host-only' | null>: the blocking first-run card shown when only a
 * DNS-over-HTTPS lookup can find the site (no page tag, nothing cached). Both choices allow the lookup,
 * which the card names; Cancel loads nothing.
 */
function askBeforeDns (A) {
  return new Promise((resolve) => {
    A.ui.setStatus(STRINGS.waitingConsent)
    A.ui.showConsentCard({
      blocking: true,
      dns: true,
      dohHost: dohOverrideHost(A),
      hasWebseed: true,
      mobile: !!(A.env && A.env.isMobile),
      onShare: () => { persistFromGesture(A); resolve('accepted') },
      onHostOnly: () => resolve('host-only'),
      onCancel: () => {
        A.ui.setStatus(STRINGS.gateCancelled, 'warn')
        A.ui.setBanner('gate', STRINGS.gateCancelled, { kind: 'info', actions: [{ label: STRINGS.gateShowAgain, onClick: () => A.win.location.reload() }] })
        resolve(null)
      }
    })
  })
}

function recomputePolicy (A) {
  const hostOnly = A.prefs.hostOnly || !A.webrtc || A.consentState === 'host-only'
  // C2 wire-ui (SZ 3.1.3): the seed budget also reads how the network is known, dock mode, the call state and the
  // seeding choices (declarations, the answered seed.ask card); computePolicy's other fields are unchanged by them.
  const dockState = A.dock ? A.dock.state() : null
  A.policy = computePolicy(seedEnvOf(A.env, { prefs: A.prefs, dock: dockState, call: A.callYield }), Object.assign({
    share: A.prefs.share,
    hostOnly,
    shareOnNetwork: A.prefs.shareOnNetwork,
    pointerMax: A.record ? A.record.max : undefined
  }, seedPrefsOf(A.prefs, dockState)), A.config)
  A.ui.setMode({ degraded: !!A.degraded, hostOnly })
  if (A.tm) A.tm.setPolicy(A.policy)
  applySeedBudget(A) // C2 wire-ui
  return A.policy
}

function peersAllowed (A) {
  return A.consentState === 'accepted' && !!A.policy && !A.policy.hostOnly
}

function consentApi (A) {
  return {
    peersAllowed: () => peersAllowed(A),
    onChange: (fn) => { A.consentListeners.add(fn); return () => A.consentListeners.delete(fn) },
    state: () => A.consentState,
    // Loader-internal (v0.2.1 A4: the site-callable SDK no longer has consent.accept).
    accept: async () => { await setConsent(A, 'accepted'); return A.consentState },
    // mw.consent.request(): opens the loader-owned card when no choice exists; resolves with the state.
    request: () => requestConsent(A)
  }
}

/**
 * ConsentWaiters: the pending mw.consent.request() / ui.openConsent() answers of the shell. settle(state)
 * answers all of them: with the visitor's choice (setConsent), or with 'pending' when the card or the
 * gate is closed without one ("Not now", Cancel), so ConsentRequests can apply its cooldown instead of
 * holding a promise that never settles (INTERFACES "src/loader/bridge.js", v0.2.1 A4).
 */
export class ConsentWaiters {
  constructor () { this.waiting = new Set() }
  wait () { return new Promise((resolve) => this.waiting.add(resolve)) }
  settle (state) {
    const all = Array.from(this.waiting)
    this.waiting.clear()
    for (const resolve of all) resolve(state)
    return all.length
  }

  get size () { return this.waiting.size }
}

/** requestConsent(A) → Promise<state>: the card when pending (resolved by the visitor's own click, or 'pending' when closed without one). */
function requestConsent (A) {
  if (A.consentState !== 'pending') return Promise.resolve(A.consentState)
  const answer = A.consentWaiters.wait()
  if (!A.hideNotice && !A.hideGate) showConsentCard(A)
  return answer
}

async function setConsent (A, state, { broadcast = true } = {}) {
  if (A.consentState === state) return
  A.consentState = state
  if (state !== 'pending') await saveConsentRecord(A, state)
  if (A.hideNotice) { A.hideNotice(); A.hideNotice = null }
  recomputePolicy(A)
  for (const fn of Array.from(A.consentListeners)) { try { fn(state) } catch (_) { /* ignore */ } }
  A.consentWaiters.settle(state)
  if (broadcast && A.link) A.link.send('consent', { state })
  if (peersAllowed(A)) startProbe(A)
  // The DoH update check waited for a choice that allows it (C1).
  if (A.resolved && A.resolved.dnsNeedsConsent && dnsAllowedBy(A.consentRecord, A.config)) scheduleUpdateCheck(A, 0)
  updateSubline(A)
  if (A.bridge) A.bridge.push('status', { code: 'consent', state })
}

/**
 * startProbe(A): the STUN connectivity probe (B7), once per page, only with consent to peers. It never
 * blocks rendering; its result gates the ICE server list (only servers that answered) and goes to the
 * diagnostics panel.
 */
function startProbe (A) {
  if (A.probeStarted || !A.webrtc || !peersAllowed(A)) return
  A.probeStarted = true
  const cfg = A.config.ice
  probeConnectivity({
    RTCPeerConnection: A.win.RTCPeerConnection,
    stun: A.config.stun,
    turn: cfg.turn,
    budgetMs: cfg.probeBudgetMs,
    settleMs: cfg.probeSettleMs,
    confirmMs: cfg.probeConfirmMs
  }).then((report) => {
    A.connectivity = report
    A.iceServers = gateIceServers(A.config.stun, report)
    if (A.tm) A.tm.setIceServers(A.iceServers)
    const row = connectivityRow(report)
    if (row) A.ui.diagnostics.set(row.row, { info: true, text: STRINGS.connectivity(report.cls) + ' (' + row.text + ')' })
    A.log('connectivity ' + report.cls + ' in ' + report.tDone + ' ms, ' + report.answered.length + ' STUN answered, ICE servers ' + stunUrlsOf(A.iceServers).join(' '))
  }).catch((err) => A.log('connectivity probe failed: ' + errMessage(err)))
}

function refreshEnvironment (A) {
  A.env = detectEnvironment({ battery: A.battery })
  if (A.record) recomputePolicy(A)
  updateSubline(A)
}

function updateSubline (A) {
  const { ui } = A
  if (!A.env || !A.policy || (!A.env.isMobile && A.policy.class === 'desktop')) { ui.setSubline({}); return }
  // C2: every mobile class downloads only until the visitor allows sharing for this origin.
  if (!A.policy.uploadsEnabled && A.prefs.share && !A.policy.hostOnly && A.prefs.shareOnNetwork !== true) {
    ui.setSubline({ text: A.policy.class === 'mobileMetered' ? STRINGS.mobileDataOnly : STRINGS.mobileDownloadOnly, onTap: () => changeSetting(A, 'shareOnNetwork', { on: true }) })
  } else {
    ui.setSubline({ text: STRINGS.mobileSharing })
  }
}

function needsGate (A, cached) {
  void cached
  if (A.mode.mode === 'hub-shared') return true // §3.3: blocking interstitial before any connection
  // Code review round 1: a stored choice for this origin, not a stored copy, skips the gate (a copy
  // fetched under a gate the visitor then cancelled must not count). C2 doors: on a door the choice is kept per site (ledger).
  if (A.mode.mode === 'hub-sub' || A.mode.mode === 'door') return A.consentState === 'pending'
  // consent=gate, or (v0.2.1 C1) no consent= and an aud= declaring personal data or an EEA/UK/Quebec audience.
  return consentModeFor(A.record, A.config) === 'gate'
}

function hasHttpSource (record) {
  return !!(record && ((record.xs && record.xs.length) || (record.ws && record.ws.length)))
}

/**
 * dnsUpdatesPlanned(A) → true when this page asks DNS-over-HTTPS for a newer pointer once a choice allows it
 * (scheduleUpdateCheck: a hostname that public DNS can answer; never localhost, IP literals or .local).
 * Post-wave fix B: the card and the gate then name the service that "Share and load" (or "Load") covers.
 */
function dnsUpdatesPlanned (A) {
  const skip = A.deps && A.deps.doh && A.deps.doh.shouldSkipDoh
  return !!(A.dnsHost && !(skip && skip(A.dnsHost)))
}

/** dohOverrideHost(A) → the host of an owner's <meta name="mw-doh"> resolver (the only one asked then), or null. */
function dohOverrideHost (A) {
  let template = null
  try { template = A.deps && A.deps.doh && A.deps.doh.dohOverrideFromMeta ? A.deps.doh.dohOverrideFromMeta(A.doc) : null } catch (_) { template = null }
  if (!template) return null
  try { return new URL(String(template).replace(/\{(?:name|type)\}/g, 'x')).host || null } catch (_) { return null }
}

/**
 * showConsentCard(A): the first-run card (C1) with the same-layer choice [Share and load] [Load from host
 * only]; non-blocking: the site renders from its host while it is open. Without a host copy (no xs=/ws=)
 * there is no host-only choice and "Not now" leaves nothing loaded.
 */
function showConsentCard (A) {
  A.hideNotice = A.ui.showConsentCard({
    hasWebseed: hasHttpSource(A.record),
    mobile: !!(A.env && A.env.isMobile),
    dnsUpdate: dnsUpdatesPlanned(A),
    dohHost: dohOverrideHost(A),
    onShare: () => { A.hideNotice = null; persistFromGesture(A); setConsent(A, 'accepted') },
    onHostOnly: () => { A.hideNotice = null; setConsent(A, 'host-only') },
    onCancel: () => { A.hideNotice = null; A.ui.setStatus(STRINGS.consentNotNow, 'warn'); A.consentWaiters.settle('pending') },
    onSettings: () => A.ui.settings.open()
  })
}

function openGate (A) {
  return new Promise((resolve) => {
    const show = async () => {
      const record = A.record
      const shared = A.mode.mode === 'hub-shared'
      const door = A.mode.mode === 'door' // C2 doors: the gate names the site and says what the door view cannot do
      let details = null
      if (shared || door) {
        details = {
          name: record.dn || null,
          btih: record.btih,
          size: A.knownSize,
          trackers: announceListFor(record, A.config.trackers),
          publisher: record.signed ? await safeFingerprint(A, record.owner) : null
        }
      }
      A.refreshGate = (shared || door) && A.knownSize === undefined ? show : null
      A.hideGate = A.ui.showGate({
        hasWebseed: hasHttpSource(record),
        sharedOrigin: shared,
        details,
        note: door ? doorText('door.gateNote', langOf(A)) : null,
        dnsUpdate: dnsUpdatesPlanned(A),
        dohHost: dohOverrideHost(A),
        onLoad: () => { A.refreshGate = null; persistFromGesture(A); setConsent(A, 'accepted'); if (A.stripFragment) A.stripFragment(); resolve('load') },
        onHostOnly: () => { A.refreshGate = null; setConsent(A, 'host-only'); if (A.stripFragment) A.stripFragment(); resolve('host-only') },
        onCancel: () => {
          A.refreshGate = null
          A.consentWaiters.settle('pending') // closed without a choice: a waiting mw.consent.request() answers 'pending'
          if (A.abort) A.abort.abort()
          A.ui.setStatus(STRINGS.gateCancelled, 'warn')
          A.ui.setBanner('gate', STRINGS.gateCancelled, { kind: 'info', actions: [{ label: STRINGS.gateShowAgain, onClick: () => A.win.location.reload() }] })
          resolve('cancel')
        }
      })
    }
    show()
  })
}

// ---- pointer resolution with UI ------------------------------------------------------------------

async function resolveSitePointer (A, metaPointer, { dohAllowed = undefined } = {}) {
  const { deps, mode, win } = A
  const fragment = mode.fragment || null
  let scope = mode.mode === 'shell' ? mode.scope : null
  let dnsHost = mode.mode === 'shell' ? mode.scope : null
  if (mode.mode !== 'shell') {
    if (fragment && fragment.kind === 'host') {
      scope = fragment.host
      dnsHost = fragment.host
    } else if (fragment) {
      let parsed = null
      try { parsed = deps.pointer.parsePointer(fragment.text) } catch (_) { parsed = null }
      if (!parsed || !parsed.ok) throw Object.assign(new Error('The link does not contain a valid pointer'), { code: 'E_POINTER', tried: ['link'] })
      scope = 'btih:' + parsed.record.btih
    } else if (mode.mode === 'hub-sub') {
      let current = null
      try { current = await deps.cache.getMeta('current') } catch (_) { current = null }
      if (current && current.scope) {
        scope = current.scope
        if (!scope.startsWith('btih:')) dnsHost = scope
      }
      if (!scope) throw Object.assign(new Error(STRINGS.hubLanding), { code: 'E_POINTER', tried: [] })
    } else {
      throw Object.assign(new Error(STRINGS.hubLanding), { code: 'E_POINTER', tried: [] })
    }
  }
  const ctx = {
    mode: mode.mode === 'shell' ? 'shell' : 'hub',
    scope,
    fragment: fragment && fragment.kind !== 'host' ? fragment : null,
    // MF-30: '#host:<name>@<fp>' names the owner key the record must be signed by.
    hostFp: fragment && fragment.kind === 'host' && typeof fragment.fp === 'string' ? fragment.fp : null,
    metaText: mode.mode === 'shell' ? metaPointer : null,
    dnsHost,
    // Shell: <meta> is the bootstrap; DNS blocks only when the page carries no pointer (§4).
    blockOnDns: mode.mode !== 'shell' || !metaPointer,
    // v0.2.1 C1: the DoH lookup waits for a choice that allows it (a stored record, or the card).
    dohAllowed: dohAllowed !== undefined ? !!dohAllowed : dnsAllowedBy(A.consentRecord, A.config),
    now: Date.now(),
    config: A.config,
    resolvers: A.config.doh && A.config.doh.length ? A.config.doh : null,
    dohOverride: deps.doh.dohOverrideFromMeta ? deps.doh.dohOverrideFromMeta(A.doc) : null,
    confirmKeyChange: (info) => confirmKeyChange(A, info)
  }
  if (dnsHost && !(deps.doh.shouldSkipDoh && deps.doh.shouldSkipDoh(dnsHost)) && ctx.blockOnDns && ctx.dohAllowed) A.ui.setStatus(STRINGS.lookingUpDns('_magnet.' + dnsHost))
  const res = await resolvePointer(ctx, pointerDeps(A))
  if (res.tried.some((t) => /^DNS/.test(t))) A.ui.diagnostics.set('dns-blocked', { text: res.tried.filter((t) => /^DNS/.test(t)).join('; ') })
  A.dnsHost = dnsHost
  A.pointerCtx = ctx
  void win
  return res
}

function pointerDeps (A) {
  const p = A.deps.pointer
  return {
    parsePointer: p.parsePointer,
    verifyPointer: p.verifyPointer,
    verifyRotation: p.verifyRotation,
    pointerLineage: p.pointerLineage,
    ledgerIdFor: p.ledgerIdFor,
    pickRecord: p.pickRecord,
    joinTxtData: p.joinTxtData,
    resolveTxt: A.deps.doh.resolveTxt,
    shouldSkipDoh: A.deps.doh.shouldSkipDoh,
    cache: A.pinCache || A.deps.cache
  }
}

async function confirmKeyChange (A, { scope, oldOwner, newOwner }) {
  const [oldFp, newFp] = await Promise.all([safeFingerprint(A, oldOwner), safeFingerprint(A, newOwner)])
  return new Promise((resolve) => {
    A.ui.showError({
      title: STRINGS.keyChangedTitle,
      detail: STRINGS.keyChangedDetail({ scope, oldFp: oldFp || '?', newFp: newFp || '?' }),
      actions: [
        { label: STRINGS.keyChangedKeep, primary: true, onClick: () => resolve(false) },
        { label: STRINGS.keyChangedConfirm, onClick: () => resolve(true) }
      ]
    })
  })
}

/** reviewKeyChange(A, resolved): GATE-1, clears the refusals of this scope and reloads (the card asks again). */
async function reviewKeyChange (A, r) {
  const n = await forgetKeyRefusals(pointerDeps(A).cache, r.scope, r.refusedOwners)
  A.log('key change refusals cleared: ' + n)
  try { A.win.location.reload() } catch (_) { /* no window */ }
  return n
}

async function presentPointer (A) {
  const r = A.resolved
  const { ui } = A
  ui.setPointerInfo({
    text: STRINGS.pointerBadge({ source: r.source, resolver: r.dns && r.dns.resolver, ad: r.dns && r.dns.ad, signed: r.signed, pinnedSince: r.signed && r.pin ? r.pin.firstSeen : null }),
    warn: !r.signed,
    title: r.signed ? 'Publisher key ' + (await safeFingerprint(A, r.record.owner)) : STRINGS.unmoderated
  })
  if (r.firstTime) ui.setBanner('first-time', STRINGS.firstTime, { kind: 'info', dismissible: true })
  if (r.warnings.includes('expired')) ui.setBanner('expired', STRINGS.pointerExpired(r.record.exp), { kind: 'warn' })
  if (r.warnings.includes('expires-soon')) A.log(STRINGS.pointerExpiresSoon(r.record.exp))
  // Review round R 5.3 (GATE-1): the refusal can be revisited; the action forgets only the refusal and reloads, so the
  // key-change card comes back (Forget this site is no longer the only way out).
  if (r.warnings.includes('key-refused')) {
    const actions = Array.isArray(r.refusedOwners) && r.refusedOwners.length
      ? [{ label: STRINGS.keyChangedReview || 'Review the key change', onClick: () => reviewKeyChange(A, r) }]
      : []
    ui.setBanner('key', STRINGS.keyChangedRefused, { kind: 'warn', actions })
  }
  if (!r.signed) ui.setBanner('unmoderated', STRINGS.unmoderated, { kind: 'info', dismissible: true })
  if (A.mode.mode === 'hub-shared') ui.setBanner('hub', STRINGS.hubSharedBanner, { kind: 'warn' })
  if (A.mode.mode === 'door') showDoorViewBanner(A) // C2 doors (S4 D4): what this address can and cannot do, and the site's own addresses
}

/**
 * presentWithdrawal(A): the publisher withdrew this site (v0.2.1 A3, ARCHITECTURE 5.8). The
 * withdrawal is already the cached record (resolvePointer saved it); delete every stored version on
 * this origin (one site per origin outside the shared hub), never mount the frame, and show the
 * publisher's reason and contact (only https: and mailto: links, withdrawalNotice).
 */
async function presentWithdrawal (A, { askFirst = false, binding = true } = {}) {
  const notice = withdrawalNotice(A.record)
  if (!binding) {
    // v0.3 (MF-30): older than 30 days and not signed again: nothing is deleted; nothing is served either.
    A.withdrawn = Object.assign({ deleted: 0, expired: true }, notice)
    A.log('a withdrawal older than 30 days: not acted on, nothing deleted')
    A.ui.setStatus(STRINGS.withdrawnTitle, 'error')
    A.ui.showError({ title: STRINGS.withdrawnTitle, detail: STRINGS.withdrawnDetail(Object.assign({ pending: false }, notice)), actions: [] })
    return
  }
  const purge = async () => {
    let deleted = []
    try {
      // C2 doors: a door holds the copies of many sites (and maybe its own): a withdrawal there deletes that ledger's versions only.
      const res = await purgeWithdrawn({ cache: A.deps.cache, ledgerId: A.ledgerId, all: A.mode.mode !== 'hub-shared' && A.mode.mode !== 'door' })
      deleted = res.deleted
    } catch (_) { /* purgeWithdrawn never throws */ }
    A.withdrawn = Object.assign({ deleted: deleted.length }, notice)
    A.log('withdrawn by the publisher: deleted ' + deleted.length + ' stored version(s)')
    return deleted
  }
  // Nothing is served or seeded either way; a withdrawal that came by a link deletes the stored
  // copy only when the visitor clicks (code review round 1).
  if (askFirst) A.withdrawn = Object.assign({ deleted: 0, pending: true }, notice)
  else await purge()
  A.ui.setStatus(STRINGS.withdrawnTitle, 'error')
  const actions = []
  if (askFirst) {
    actions.push({
      label: STRINGS.withdrawnDeleteCopy,
      primary: true,
      onClick: async () => {
        const deleted = await purge()
        A.ui.setStatus(STRINGS.withdrawnDeleted(deleted.length), 'error')
      }
    })
  }
  // Review round R 5.3 (PTR-12): the button names where it goes (the ct= host, or the mail address), not only "the publisher".
  if (notice.ct) actions.push({ label: contactLabel(notice.ct), onClick: () => { try { A.win.open(notice.ct, '_blank', 'noopener') } catch (_) { /* blocked */ } } })
  A.ui.showError({ title: STRINGS.withdrawnTitle, detail: STRINGS.withdrawnDetail(Object.assign({ pending: askFirst }, notice)), actions })
}

/** contactLabel(ct) → 'Contact the publisher (<host or mail address>)' for a withdrawal's ct= (PTR-12). */
export function contactLabel (ct) {
  let where = null
  try {
    const u = new URL(ct)
    where = u.protocol === 'mailto:' ? decodeURIComponent(u.pathname) : u.host
  } catch (_) { where = null }
  return STRINGS.withdrawnContact + (where ? ' (' + where + ')' : '')
}

/**
 * withdrawNow(A, record): a withdrawal found while the page is open (page tag or DNS update; the
 * caller saved it as the scope's record). Peer-to-peer stops at once (the torrent client goes), the
 * frame is removed, other tabs hear of it, and then the boot path's presentWithdrawal runs.
 */
async function withdrawNow (A, record) {
  A.log('withdrawal found while open (seq ' + record.seq + ')')
  if (A.tm) { try { A.tm.destroy() } catch (_) { /* gone */ } A.tm = null }
  if (A.bridge) { try { A.bridge.setTorrentManager(null) } catch (_) { /* gone */ } }
  if (A.mount) { try { A.mount.destroy() } catch (_) { /* gone */ } A.mount = null }
  if (A.link) A.link.send('version', { btih: record.btih })
  A.record = record
  await presentWithdrawal(A)
}

function presentPointerError (A, err) {
  const scope = (A.mode && (A.mode.scope || (A.mode.fragment && A.mode.fragment.host))) || A.win.location.hostname
  const lines = [STRINGS.pointerNotFound(scope)]
  if (err && err.dohError) {
    lines.push(STRINGS.dohBlocked)
    A.ui.diagnostics.set('dns-blocked', { text: (err.tried || []).join('; ') })
  }
  if (err && err.tried && err.tried.length) lines.push(err.tried.join('\n'))
  else if (err && err.message) lines.push(err.message)
  A.ui.setStatus(STRINGS.pointerNotFoundTitle, 'error')
  A.ui.showError({ title: STRINGS.pointerNotFoundTitle, detail: lines.join('\n'), actions: [{ label: STRINGS.retry, primary: true, onClick: () => A.win.location.reload() }] })
}

// ---- cache ----------------------------------------------------------------------------------------

async function lookupCache (A) {
  const { cache, verify, torrentFile } = A.deps
  let site = null
  try { site = await cache.getSite(A.btih) } catch (err) { A.log('cache: ' + errMessage(err)); return null }
  if (!site || !site.complete || !(site.torrentFile instanceof Uint8Array) || !Array.isArray(site.files)) return null
  // The expected btih comes from the resolved pointer, never from IndexedDB alone (§7.3).
  let ok = false
  try { ok = await verify.verifyInfoHash(site.torrentFile, A.btih) } catch (_) { ok = false }
  if (!ok) {
    A.log('cached torrent does not hash to ' + A.btih + '; removed')
    try { await cache.deleteSite(A.btih) } catch (_) { /* ignore */ }
    return null
  }
  const blobs = new Map()
  for (const f of site.files) {
    let blob = null
    try { blob = await cache.getFile(A.btih, f.path) } catch (_) { blob = null }
    if (!blob || typeof blob.size !== 'number' || blob.size !== f.length) {
      A.log('cached copy incomplete at ' + f.path)
      return null
    }
    blobs.set(f.path, blob)
  }
  let parsed
  try { parsed = await torrentFile.parseTorrentFile(site.torrentFile) } catch (_) { return null }
  try { await cache.touchSite(A.btih) } catch (_) { /* ignore */ }
  A.knownSize = parsed.length
  return { manifest: site, blobs, parsed, fromCache: true }
}

/**
 * applySiteStun(A): the site's own STUN servers (/.mw/site.json, publish --stun) go to the chat, group, file and media
 * swarms and to the chat card (R 2.7.1, MF-44): the public default STUN operators are never their fallback.
 */
function applySiteStun (A) {
  const stun = A.routing && Array.isArray(A.routing.stun) ? A.routing.stun.slice(0, 4) : []
  if (A.tm && typeof A.tm.setLaneIceServers === 'function') A.tm.setLaneIceServers(stun)
  if (A.api && typeof A.api.setLaneStun === 'function') A.api.setLaneStun(stun)
}

function readRouting (blobs) {
  const blob = blobs && (blobs.get('.mw/site.json') || blobs.get('/.mw/site.json'))
  if (!blob) return Promise.resolve(null)
  return blob.text().then((t) => {
    const v = JSON.parse(t)
    return v && typeof v === 'object' ? v : null
  }).catch(() => null)
}

async function persistSite (A, res) {
  const { cache } = A.deps
  try {
    // C2 doors (S4 D4): a copy stored by a door view is flagged viaDoor and is evicted before any other copy (enforceDoorBudget).
    await cache.saveSite(A.mode.mode === 'door' ? Object.assign({}, res.manifest, { viaDoor: true }) : res.manifest, res.blobs)
    A.persistFailed = false
  } catch (err) {
    A.persistFailed = true
    A.log('saveSite failed: ' + errMessage(err))
    const quota = err && (err.name === 'QuotaExceededError' || /quota/i.test(errMessage(err)))
    A.ui.setBanner('storage', quota ? STRINGS.storageFull : STRINGS.storageFullTitle + ': ' + errMessage(err), { kind: 'warn' })
    return false
  }
  try { await recordVersion(A, res.manifest.btih) } catch (_) { /* ignore */ }
  try { await enforceDoorBudget({ cache, budgetBytes: A.policy.storageBudget, keep: [res.manifest.btih] }) } catch (_) { /* ignore */ } // C2 doors
  try { await cache.enforceBudget({ budgetBytes: A.policy.storageBudget, keep: [res.manifest.btih] }) } catch (_) { /* ignore */ }
  if (A.link) A.link.send('site', { btih: res.manifest.btih })
  return true
}

// Superseded versions of this ledger are deleted once the new one is stored (§5.8, item 21). Code
// review round 1: a version a page still renders (another tab, the Service Worker's live clients) is
// kept until that page goes, as in drop-in mode (planVersions); pruneVersions() runs again after each
// render, so it goes on a later load.
async function recordVersion (A, btih) {
  const { cache } = A.deps
  const key = 'versions:' + A.ledgerId
  let versions = []
  try { versions = (await cache.getPref(key, [])) || [] } catch (_) { versions = [] }
  if (!Array.isArray(versions)) versions = []
  let live = null
  try {
    const sw = A.swPromise ? await A.swPromise : null
    if (sw && sw.ok && !A.degraded) {
      const reply = await requestServiceWorker('mw-get-clients', {}, { proto: A.config.proto, timeoutMs: A.config.timeoutsExtra.swAckMs, registration: sw.registration })
      live = reply && reply.clients && typeof reply.clients === 'object' ? reply.clients : null
    }
  } catch (_) { live = null }
  const plan = planVersions({ versions: [btih].concat(versions.filter((v) => v !== btih)), current: btih, live: live || {} })
  for (const v of plan.drop) {
    if (!BTIH_RE.test(v)) continue
    try { await cache.deleteSite(v); A.log('removed superseded version ' + v) } catch (_) { /* ignore */ }
  }
  await cache.setPref(key, plan.versions)
}

/** pruneVersions(A): after a render, drops superseded versions no page renders any more. */
async function pruneVersions (A) {
  if (!A.isLeader || !A.btih || A.superseded) return
  try { await recordVersion(A, A.btih) } catch (err) { A.log('version cleanup failed: ' + errMessage(err)) }
}

/**
 * markSuperseded(A, why): this tab renders a version that a newer pointer replaced (its own update
 * check, or another tab's). Its torrent stops announcing and seeding that version at once (§5.8), and
 * it is never seeded again from this page (startEngine, promoteToLeader). Code review round 1.
 */
function markSuperseded (A, why) {
  if (A.superseded) return
  A.superseded = true
  A.log('this page renders a superseded version (' + why + '): no longer shared')
  if (A.tm && A.tm.site && A.tm.site.record && A.tm.site.record.btih === A.btih) { try { A.tm.stopSite() } catch (_) { /* gone */ } }
}

/**
 * The newest pointer another tab saved for this scope, when it names `btih` (a tab-channel message is
 * not trusted by itself: the sending tab stored the record first). → record | null
 */
async function savedRecordNaming (A, btih) {
  let saved = null
  try { saved = await A.deps.cache.getPointer(A.scope) } catch (_) { saved = null }
  const rec = saved && saved.record
  if (!rec || rec.btih !== btih) return null
  if (rec.signed && A.record && A.record.signed && Number(rec.seq) <= Number(A.record.seq)) return null
  return rec
}

/**
 * The engine tab downloads a version a follower needs (it resolved a newer pointer than this tab
 * renders), stores it and tells the tabs; its own rendered version is superseded then. Code review round 1.
 */
async function serveNeededVersion (A, btih) {
  if (A.servingVersion === btih) return
  if (btih === A.btih) { if (A.manifest) A.link.send('site', { btih }); return }
  const record = await savedRecordNaming(A, btih)
  if (!record || record.withdrawn) return
  A.servingVersion = btih
  try {
    const tm = await ensureTorrentManager(A)
    markSuperseded(A, 'a tab needs ' + btih)
    const res = await tm.download({ record, maxBytes: A.policy.maxSiteBytes })
    const { cache } = A.deps
    await cache.saveSite(res.manifest, res.blobs)
    try { await recordVersion(A, btih) } catch (_) { /* ignore */ }
    A.link.send('site', { btih })
    A.log('stored ' + btih + ' for another tab')
  } catch (err) {
    A.log('could not fetch ' + btih + ' for another tab: ' + errMessage(err))
  } finally {
    A.servingVersion = null
  }
}

async function setCurrent (A) {
  const { cache } = A.deps
  if (A.mode.mode === 'hub-shared') return
  if (A.lineageUnproven) return // Review round R 5.3 (PTR-1): never the origin's current site
  const routing = A.routing || null
  let previous = null
  try { previous = await cache.getMeta('current') } catch (_) { previous = null }
  try {
    await cache.setMeta('current', { btih: A.btih, ledgerId: A.ledgerId, routing, scope: A.scope, previous: previous && previous.btih !== A.btih ? previous.btih : (previous && previous.previous) || null })
  } catch (err) { A.log('setMeta current failed: ' + errMessage(err)) }
  const sw = await A.swPromise
  const opts = { proto: A.config.proto, timeoutMs: A.config.timeoutsExtra.swAckMs, registration: sw && sw.registration }
  // Wait for the worker to finish (its ack comes after it has re-read the stored site), so the
  // frame's first request never meets a worker that has not indexed the copy yet. A worker that
  // read too early is asked again (mw-site-saved) a few times.
  let ack = await requestServiceWorker('mw-set-current', { btih: A.btih, ledgerId: A.ledgerId || null }, opts)
  for (let i = 0; ack && ack.ok !== false && !ack.complete && !A.degraded && i < 4; i++) {
    await new Promise((resolve) => setTimeout(resolve, 150 * (i + 1)))
    ack = await requestServiceWorker('mw-site-saved', { btih: A.btih }, opts)
  }
  if (!ack) {
    A.log('service worker did not acknowledge mw-set-current; pinging')
    postToServiceWorker('mw-set-current', { btih: A.btih }, { proto: A.config.proto, registration: sw && sw.registration })
    await pingServiceWorker({ proto: A.config.proto, timeoutMs: A.config.timeoutsExtra.swPingMs, registration: sw && sw.registration })
  } else if (!ack.complete) {
    A.log('service worker has not indexed ' + A.btih + ' (' + (ack.error || 'incomplete') + ')')
  }
}

// ---- obtaining the site (download, or a sibling tab's download) ----------------------------------

async function obtainSite (A) {
  if (!A.isLeader) {
    A.ui.setStatus(STRINGS.connecting)
    // Code review round 1: the engine tab may run another version (a publish happened in between):
    // ask it for this one; if nothing arrives in time (its download failed, it is busy), this tab
    // downloads the copy itself instead of waiting for the lock forever.
    if (A.link) A.link.send('need-site', { btih: A.btih })
    const waitMs = (A.config.timeoutsExtra && A.config.timeoutsExtra.followerSiteMs) || 20000
    let fallbackTimer = null
    const winner = await Promise.race([
      waitForSiteBroadcast(A).then(() => 'site'),
      A.leader.becomeLeader.then(() => 'leader'),
      new Promise((resolve) => { fallbackTimer = setTimeout(() => resolve('timeout'), waitMs) })
    ])
    clearTimeout(fallbackTimer)
    if (winner === 'site') {
      const cached = await lookupCache(A)
      if (cached) {
        A.leader.becomeLeader.then(() => promoteToLeader(A))
        return cached
      }
    }
    if (winner === 'timeout') {
      A.log('the engine tab sent no copy of ' + A.btih + ' in ' + waitMs + ' ms: downloading it in this tab')
      A.leader.becomeLeader.then(() => promoteToLeader(A))
      if (gateHoldsDownload(A) && (await A.gatePromise) === 'cancel') return null
      return downloadSite(A)
    }
    await A.leader.becomeLeader
    A.isLeader = true
    A.ledgerPromise = openLedger(A)
  }
  if (gateHoldsDownload(A)) {
    // Gated and no web seed: nothing loads until the visitor decides (§8). On a hub or a door the hosts of a
    // link are the link author's: they see nothing (no xs= fetch, no web-seed probe, no org= door request)
    // before Load or Host only (code review round 1, C3).
    const decision = await A.gatePromise
    if (decision === 'cancel') return null
  }
  return downloadSite(A)
}

/**
 * gateHoldsDownload(A) → true when a pending gate must be answered before any byte request (§8). Review round R 5.3
 * (PTR-9): every non-shell mode waits, signed or not (signing is free and proves no tie to a ws=/xs=/org= host); in
 * shell mode a record without a web source waits as before.
 */
export function gateHoldsDownload (A) {
  if (!A || !A.gatePromise) return false
  return !hasHttpSource(A.record) || !A.mode || A.mode.mode !== 'shell'
}

function waitForSiteBroadcast (A) {
  return new Promise((resolve) => {
    const off = A.link.on((m) => {
      if (m.t === 'site' && m.btih === A.btih) { off(); resolve() }
    })
  })
}

/**
 * ensureTorrentManager(A) -> Promise<TorrentManager>: one per page. Social fixer (round 1): it is single-flight like the drop-in's
 * (src/dropin/engine.js tmPromise). The boot path, the v0.3 seam and joinHubLane can all call it before the first call's import
 * of the bundle settles, and each built its own TorrentManager, the last one winning A.tm (a latent race; the E-SO-2 miss itself
 * was the consent race in TorrentManager._onConsentChange).
 */
function ensureTorrentManager (A) {
  if (A.tm) return Promise.resolve(A.tm)
  if (!A.tmPending) {
    A.tmPending = createTorrentManager(A)
    A.tmPending.then(() => { A.tmPending = null }, () => { A.tmPending = null })
  }
  return A.tmPending
}

async function createTorrentManager (A) {
  const url = A.config.assets.webtorrent
  // B7: the bundle captures window.RTCPeerConnection when it is imported, so the offer-timeout wrapper
  // (a non-trickle offer leaves 1.5 s after the first candidate instead of 5 s) goes in first.
  try { if (A.webrtc) installOfferTimeout(A.win, { timeoutMs: A.config.ice.offerTimeoutMs }) } catch (err) { A.log('offer timeout wrapper: ' + errMessage(err)) }
  const mod = await import(/* webpackIgnore: true */ url)
  const WebTorrent = mod && (mod.default || mod.WebTorrent)
  if (typeof WebTorrent !== 'function') throw new Error('webtorrent.min.js has no default export')
  const tm = new TorrentManager({ WebTorrent, config: A.config, policy: A.policy, consent: consentApi(A) })
  A.tmCount = (A.tmCount || 0) + 1
  A.tm = tm
  if (A.iceServers) tm.setIceServers(A.iceServers)
  if (A.routing && Array.isArray(A.routing.stun) && typeof tm.setLaneIceServers === 'function') tm.setLaneIceServers(A.routing.stun.slice(0, 4))
  tm.addEventListener('torrent', (e) => attachLedger(A, e.detail.torrent))
  tm.addEventListener('progress', (e) => {
    const d = e.detail || {}
    A.ui.setProgress(d)
    A.ui.setSource(d.source)
    if (d.total && A.knownSize === undefined) {
      A.knownSize = d.total
      if (A.refreshGate) A.refreshGate()
    }
  })
  tm.addEventListener('peers', (e) => {
    A.ui.setPeers((e.detail && e.detail.count) || 0)
    broadcastState(A)
  })
  tm.addEventListener('status', (e) => onTorrentStatus(A, e.detail || {}))
  tm.addEventListener('warning', (e) => onTorrentWarning(A, e.detail || {}))
  tm.addEventListener('tracker', (e) => A.log('tracker ' + e.detail.url + ' ' + e.detail.state))
  tm.addEventListener('sync', () => updateDiagnostics(A))
  // v0.3 (harden-loader request 5): a ledger rendezvous without progress polls the pointer's cs= snapshot.
  tm.addEventListener('no-progress', (e) => {
    const d = e.detail || {}
    if (d.kind !== 'rendezvous' || !A.isLeader) return
    const now = Date.now()
    if (now - (A.lastSnapshotPoll || 0) < 60000) return
    A.lastSnapshotPoll = now
    fetchSnapshot(A)
  })
  if (A.bridge) A.bridge.setTorrentManager(tm)
  else A.api.setTorrentManager(tm)
  if (A.seam) A.seam.attach(tm)
  attachSeeding(A, tm) // C2 wire-ui: the seed meters and budget, the carry meter, the hand-off labels
  attachPinWire(A, tm) // C2 integrator: mw_pin1 (receipts, the heartbeat), and the pin's own page host
  startDiagnostics(A)
  return tm
}

function onTorrentStatus (A, d) {
  const { ui } = A
  const map = {
    'fetching-torrent': STRINGS.fetchingTorrent,
    'waiting-consent': STRINGS.waitingConsent,
    connecting: STRINGS.connecting,
    'webseed-only': STRINGS.downloading(A.record && A.record.dn),
    downloading: STRINGS.downloading(d.name || (A.record && A.record.dn)),
    seeding: A.policy && A.policy.uploadsEnabled ? STRINGS.seeding : STRINGS.uploadsOff,
    'host-only': STRINGS.hostOnlyActive
  }
  const text = map[d.code]
  if (text && (!A.mount || d.code === 'seeding' || d.code === 'host-only')) ui.setStatus(text, d.code === 'seeding' ? 'ok' : 'info')
  A.log('status ' + d.code + (d.url ? ' ' + d.url : ''))
}

function onTorrentWarning (A, d) {
  A.log('warning ' + d.code + (d.message ? ': ' + d.message : '') + (d.reason ? ' (' + d.reason + ')' : ''))
  if (d.code === 'webseed-broken') {
    A.ui.setBanner('webseed', d.reason === 'no-range' ? STRINGS.webseedBroken : STRINGS.webseedUnreachable, { kind: 'warn', dismissible: true })
  } else if (d.code === 'webseed-backoff') {
    let host = d.url
    try { host = new URL(d.url).host } catch (_) { /* keep the URL */ }
    const minutes = Math.max(1, Math.round((d.backoffMs || A.config.webseed.backoffMs) / 60000))
    const wrong = d.reason === 'E_WEBSEED_BYTES' || d.reason === 'E_WEBSEED_RANGE'
    A.ui.setBanner('webseed', wrong ? STRINGS.webseedBackoff(host, minutes) : STRINGS.webseedBackoffDown(host, minutes), { kind: 'warn', dismissible: true })
  } else if (d.code === 'webseed-pad') {
    A.ui.setBanner('webseed', STRINGS.webseedPad, { kind: 'info', dismissible: true })
  } else if (d.code === 'no-webseed') {
    A.ui.setBanner('no-webseed', STRINGS.noWebseed, { kind: 'info', dismissible: true })
  } else if (d.code === 'E_CACHE_CORRUPT') {
    handleCorruptCache(A)
  }
}

async function handleCorruptCache (A) {
  if (A.corruptHandled || !A.manifest) return
  A.corruptHandled = true
  A.ui.setBanner('corrupt', STRINGS.cachedCorrupt, { kind: 'warn' })
  if (!A.isLeader && A.link) {
    // One engine per origin (§5.9): the engine tab downloads the copy again; this tab remounts once
    // the engine tab says the new copy is stored.
    A.log('cached copy of ' + A.btih + ' failed verification: waiting for the engine tab to fetch it again')
    await waitForSiteBroadcast(A)
    const cached = await lookupCache(A)
    if (cached && await renderSite(A, cached)) {
      A.ui.setBanner('corrupt', null)
      A.corruptHandled = false
    }
    return
  }
  A.log('cached copy of ' + A.btih + ' failed verification: deleted, downloading it again')
  try { await A.deps.cache.deleteSite(A.btih) } catch (_) { /* ignore */ }
  // Shell: download again and remount; the SW stops serving the deleted copy.
  const site = await downloadSite(A)
  if (site && await renderSite(A, site)) {
    A.ui.setBanner('corrupt', null)
    A.corruptHandled = false // a later failure of the new copy is handled again
  }
}

async function downloadSite (A) {
  const { ui } = A
  let tm
  try {
    tm = await ensureTorrentManager(A)
  } catch (err) {
    ui.setStatus(STRINGS.engineMissingTitle, 'error')
    ui.showError({ title: STRINGS.engineMissingTitle, detail: STRINGS.engineMissing + '\n' + errMessage(err), actions: [{ label: STRINGS.reload, primary: true, onClick: () => A.win.location.reload() }] })
    return null
  }
  // The ledger's wire extension must be ready before the first wire (bounded wait).
  if (A.ledgerPromise) await withTimeout(A.ledgerPromise, A.config.ledger.nodeOpenMs, null)
  if (A.isLeader) addRendezvous(A) // ledger gossip across versions runs while the site downloads
  ui.setStatus(hasHttpSource(A.record) ? STRINGS.fetchingTorrent : STRINGS.connecting)
  ui.setProgress({ downloaded: 0, total: 0 })
  A.abort = new AbortController()
  try {
    // C2 doors (S4 D3): on a door, the .torrent comes from the first door that has it (staggered, checked by its infohash) and a
    // few doors join the web seeds (each piece checked against the torrent); elsewhere the download is unchanged.
    const plan = await doorDownloadPlan(A, A.abort.signal)
    const res = await tm.download({ record: plan ? plan.record : A.record, torrentFile: plan ? plan.torrentFile : null, maxBytes: A.policy.maxSiteBytes, signal: A.abort.signal })
    // A copy fetched while the gate is open is stored only after Load or Host only; Cancel drops it
    // (code review round 1: otherwise the next open of the link found it cached).
    if (A.gatePromise && A.consentState === 'pending') {
      const decision = await A.gatePromise
      if (decision === 'cancel') {
        try { tm.stopSite() } catch (_) { /* gone */ }
        return null
      }
    }
    await persistSite(A, res)
    return { manifest: res.manifest, blobs: res.blobs, parsed: res.parsed, fromCache: false }
  } catch (err) {
    presentDownloadError(A, err)
    return null
  }
}

function presentDownloadError (A, err) {
  const { ui } = A
  const code = err && err.code
  A.log('download failed: ' + code + ' ' + errMessage(err))
  if (code === 'E_ABORTED') return
  const retry = { label: STRINGS.retry, primary: true, onClick: () => A.win.location.reload() }
  if (code === 'E_TOO_LARGE') {
    ui.setStatus(STRINGS.tooLargeTitle, 'error')
    ui.showError({ title: STRINGS.tooLargeTitle, detail: STRINGS.tooLarge(formatBytes(err.length), formatBytes(err.maxBytes)) })
    return
  }
  if (code === 'E_NO_PEERS') {
    ui.setStatus(STRINGS.noPeersTitle, 'error')
    ui.showError({ title: STRINGS.noPeersTitle, detail: STRINGS.noWebseed + '\n' + STRINGS.matrix['nobody-online'].remedy, actions: [retry] })
    return
  }
  if (code === 'E_TIMEOUT') {
    ui.setStatus(STRINGS.timeoutTitle, 'error')
    ui.showError({ title: STRINGS.timeoutTitle, detail: STRINGS.timeout + '\n' + errMessage(err), actions: [retry] })
    return
  }
  if (code === 'E_BAD_TORRENT') {
    ui.setStatus(STRINGS.badTorrentTitle, 'error')
    ui.showError({ title: STRINGS.badTorrentTitle, detail: STRINGS.badTorrent + '\n' + errMessage(err), actions: [retry] })
    return
  }
  ui.setStatus(STRINGS.genericErrorTitle, 'error')
  ui.showError({ title: STRINGS.genericErrorTitle, detail: errMessage(err), actions: [retry] })
}

// ---- rendering --------------------------------------------------------------------------------------

async function renderSite (A, site) {
  const { ui, doc } = A
  A.manifest = site.manifest
  A.blobs = site.blobs
  A.parsed = site.parsed
  A.fromCache = !!site.fromCache
  A.routing = await readRouting(site.blobs)
  applySiteStun(A)
  if (A.gatePromise && A.consentState === 'pending') {
    const decision = await A.gatePromise
    if (decision === 'cancel') return false
  }
  const sw = await A.swPromise
  if (sw.reloaded) return false
  // C2 doors: the door view never uses the worker (a sandboxed frame is not controlled by it) and never maps the site to this
  // origin's meta.current (setCurrent is not called); the page already runs under the limited-mode policy (doorCspReload).
  A.degraded = A.mode.mode === 'door' || !sw.ok || !!A.persistFailed
  // Code review round 1 (§7.4): limited mode needs the degraded CSP (blob: scripts and styles, <base>);
  // when the decision comes after boot.js fixed the normal one (ready() timed out, register() failed
  // late, storage is full), reload once into limited mode instead of rendering an unstyled site.
  if (A.degraded && A.mode.mode !== 'door' && A.boot && A.boot.cspKind !== 'degraded') {
    const reason = !sw.ok ? (sw.error || 'service worker') : 'storage'
    if (requestDegradedReload({ win: A.win, reason })) {
      A.log('limited mode decided after the CSP was fixed (' + reason + '): reloading once into limited mode')
      ui.setStatus(STRINGS.starting)
      return false
    }
    A.log('limited mode under the normal CSP (the one-time reload was not possible): styles and scripts of the site may be blocked')
  }
  recomputePolicy(A)
  // A remount (a fresh copy after a failed check, a new version) keeps the page the visitor is on.
  let path = A.mode.path
  if (A.mount) {
    try { if (typeof A.mount.currentPath === 'function' && A.mount.currentPath()) path = A.mount.currentPath() } catch (_) { /* keep the load path */ }
    try { A.mount.destroy() } catch (_) { /* ignore */ }
    A.mount = null
  }
  const container = ui.siteContainer
  const handlers = {
    onTitle: (t) => { if (A.bridge) A.bridge.push('status', { code: 'title', title: t }) },
    onBlockedNavigation: (info) => {
      const actions = info && info.url
        ? [{ label: STRINGS.openInNewTab, onClick: () => { try { A.win.open(info.url, '_blank', 'noopener') } catch (_) { /* ignore */ } } }]
        : [{ label: STRINGS.goBack, onClick: () => { if (A.mount) A.mount.navigate('/') } }]
      ui.setBanner('external', STRINGS.externalBlocked, { kind: 'warn', actions, dismissible: true })
    }
  }
  const mode = A.mode.mode === 'hub-shared' ? 'hub-shared' : 'shell'
  if (A.degraded) {
    if (A.fromCache) {
      const verified = new Set()
      for (const f of A.parsed.files) {
        if (f.pad) continue
        let good = false
        try { good = await A.deps.verify.verifyFile(A.parsed, A.blobs, f.path, verified) } catch (_) { good = false }
        if (!good) {
          A.log('cached file failed verification: ' + f.path)
          try { await A.deps.cache.deleteSite(A.btih) } catch (_) { /* ignore */ }
          ui.setBanner('corrupt', STRINGS.cachedCorrupt, { kind: 'warn' })
          const fresh = await downloadSite(A)
          return fresh ? renderSite(A, fresh) : false
        }
      }
    }
    if (A.mode.mode === 'door') {
      A.mount = await mountDoorFrame(A, container, path, handlers) // C2 doors (S4 D4): sandbox="allow-scripts", its own renderer
      if (!A.mount) return false
    } else {
      A.mount = await mountDegraded(Object.assign({ container, parsed: A.parsed, blobs: A.blobs, path, routing: A.routing, mode }, handlers))
      ui.setBanner('limited', STRINGS.limitedMode, { kind: 'warn', dismissible: true })
    }
  } else {
    await setCurrent(A)
    A.mount = mountSite(Object.assign({ container, mode, btih: A.btih, path }, handlers))
  }
  attachBridge(A)
  ui.setStatus(A.fromCache ? STRINGS.loadedCache : STRINGS.loadedSite, 'ok')
  ui.setProgress({ downloaded: A.parsed.length, total: A.parsed.length })
  ui.setSource(A.fromCache ? 'cache' : (A.tm && A.tm.source))
  ui.siteReady(A.config.ui.collapseAfterRenderMs)
  if (doc.title === 'Loading site' && A.record.dn) doc.title = String(A.record.dn)
  refreshCarry(A) // C2 wire-ui: the carry meter after load (SZ 3.1.5 meter.visit, meter.tracker)
  pinTick(A) // C2 integrator: the first heartbeat read after load (then every seed tick, at PinWire's 10-minute pace)
  return true
}

function siteInfo (A) {
  const files = A.manifest && Array.isArray(A.manifest.files) ? A.manifest.files : []
  return {
    siteId: A.ledgerId,
    btih: A.btih,
    mode: sdkMode(A.mode.mode),
    name: (A.manifest && A.manifest.name) || (A.record && A.record.dn) || null,
    files,
    owner: A.record && A.record.signed ? A.record.owner : null,
    unmoderated: !(A.record && A.record.signed),
    source: A.fromCache ? 'cache' : (A.tm ? A.tm.source : null)
  }
}

function identityApi (A) {
  return {
    current: () => A.identityInfo || null,
    export: (passphrase) => exportCurrentIdentity(A, passphrase),
    import: async (text, passphrase) => {
      const res = await importIdentity(A, text, passphrase)
      setTimeout(() => A.win.location.reload(), 300)
      return res
    }
  }
}

function attachBridge (A) {
  if (A.bridge) { try { A.bridge.destroy() } catch (_) { /* ignore */ } A.bridge = null }
  if (!A.mount || !A.mount.iframe) return
  if (A.mode.mode === 'door') guardActivationWatch(A.tracker) // C2 doors: the door view's window is cross-origin to this page
  // v0.3: the Bridge is the transport of the page's MwApi (one method table, the services mounted on it) and
  // watches the site frame for trusted input (the only source of activation for UI methods, R 2.11.1).
  A.bridge = new Bridge({
    iframe: A.mount.iframe,
    api: A.api,
    activation: A.tracker,
    ui: pageUiHooks(A),
    limits: { writesPerMinute: A.config.bridge.writesPerMinute, maxRequestBytes: A.config.bridge.maxRequestBytes, maxListLimit: A.config.bridge.maxListLimit, readyWaitMs: A.config.bridge.readyWaitMs },
    win: A.win,
    // C2 doors: the door view's frame has an opaque origin, so its messages arrive with origin "null" (and only from that frame)
    origin: A.mode.mode === 'door' ? 'null' : A.origin
  })
  A.bridge.attach()
  if (A.nodeSettled && !A.node) A.bridge.setNode(null, { failed: true })
}

// ---- engine (leader tab) ----------------------------------------------------------------------------

async function startEngine (A) {
  let tm
  try { tm = await ensureTorrentManager(A) } catch (err) { A.log('engine unavailable: ' + errMessage(err)); return }
  if (A.ledgerPromise) await withTimeout(A.ledgerPromise, A.config.ledger.nodeOpenMs, null)
  if (A.superseded) {
    // A newer version exists (code review round 1): the rendered one is never announced again.
    A.log('not sharing ' + A.btih + ': a newer version exists')
  } else {
    try {
      await tm.seedFromCache({ manifest: A.manifest, blobs: A.blobs, parsed: A.parsed, record: A.record })
    } catch (err) {
      A.log('seedFromCache failed: ' + errMessage(err))
    }
  }
  addRendezvous(A)
}

/** B2: the ledger rendezvous swarm (bare infohash of the ledger id) with the site torrent's tracker list. */
function addRendezvous (A) {
  if (!A.tm || !A.ledgerId || A.rendezvousAdded) return
  A.rendezvousAdded = true
  A.tm.addRendezvous(A.ledgerId, announceListFor(A.record, A.config.trackers)).catch((err) => A.log('rendezvous swarm: ' + errMessage(err)))
}

async function promoteToLeader (A) {
  if (A.destroyed || A.promoted) return
  A.promoted = true
  A.isLeader = true
  A.log('this tab now runs the engine')
  if (A.followerNode) A.followerNode = null
  A.ledgerPromise = openLedger(A)
  const node = await withTimeout(A.ledgerPromise, A.config.ledger.nodeOpenMs, null)
  if (A.bridge) A.bridge.setNode(node || null, { failed: !node })
  else A.api.setNode(node || null, { failed: !node })
  // v0.3: this tab now holds the services (and, after sign-in, the keys); the follower state it had is dropped.
  await mountLeaderServices(A)
  if (A.manifest) startEngine(A)
}

function attachLedger (A, torrent) {
  const node = A.node
  if (!node || typeof node.attachTorrent !== 'function' || !torrent) return
  try {
    const detach = node.attachTorrent(torrent)
    if (typeof detach === 'function') torrent.once('close', () => { try { detach() } catch (_) { /* ignore */ } })
  } catch (err) {
    A.log('ledger attach failed: ' + errMessage(err))
  }
}

// ---- ledger (§5.5) ----------------------------------------------------------------------------------

// create: false in follower tabs (code review round 1): only the engine tab, which holds the Web Lock,
// creates an identity; a follower shows the one it finds (or the engine tab's, from its 'state').
async function loadIdentity (A, { create = true } = {}) {
  const { cache, crypto } = A.deps
  // Review round R 5.3 (PTR-1): a record with an unproven lo= never gets this ledger's moderator key.
  const moderator = A.lineageUnproven ? null : (A.moderatorMemory || await cache.getKey('moderator:' + A.ledgerId).catch(() => null))
  let identity
  if (moderator && moderator.pub && (moderator.privateKey || moderator.jwk)) {
    const privateKey = moderator.privateKey || await crypto.importPrivateJwk(moderator.jwk, { extractable: false })
    identity = { privateKey, pub: moderator.pub, kind: 'moderator' }
    A.moderatorShort = await safeFingerprint(A, moderator.pub)
    // MF-27: a moderator key stored by v0.2.1 as an extractable JWK is stored again as a non-extractable CryptoKey.
    if (!moderator.privateKey && moderator.jwk) upgradeModeratorKey(A, moderator, privateKey).catch(() => {})
  } else if (A.identityMode === 'v03') {
    // v0.3 (R 2.4.1): no key is made for a guest; the working keys of a sign-in sign (bound in onAuthChange).
    const id = nodeIdentityOf(A.api.identity.keys())
    A.identity = id
    const info = A.api.identity.info()
    A.identityInfo = info ? { pub: info.pub, short: info.short, name: info.name } : null
    A.ui.setIdentity(A.identityInfo)
    return id
  } else {
    identity = await ensureIdentity({ cache, crypto, ledgerId: A.ledgerId, create })
    if (!identity) return null
  }
  A.identity = identity
  A.identityInfo = { pub: identity.pub, short: await safeFingerprint(A, identity.pub), name: null }
  A.ui.setIdentity(A.identityInfo)
  // v0.3: an imported moderator key signs this tab's writes, so the site sees it as the signed-in key.
  if (identity.kind === 'moderator') A.api.identity.setLoaderKey(A.identityInfo)
  return identity
}

async function openLedger (A) {
  try {
    const identity = await loadIdentity(A)
    const chain = await loadChainDeps()
    A.miner = A.miner || chain.createMiner({ workerUrl: A.config.assets.powWorker })
    // Signatures verify in a worker pool (§5.5, item 5; code review round 1: the URL was missing, so
    // every block verified on the main thread); the pool falls back inline where workers fail.
    A.verifierPool = A.verifierPool || chain.createVerifierPool({ size: A.config.ledger.verifierPoolSize, workerUrl: A.config.assets.powWorker })
    const openWith = (store) => {
      A.nodeStore = store
      return chain.ChainNode.open({
        siteId: A.ledgerId,
        expectedOwner: A.record.signed ? A.record.owner : null,
        ledgerOwner: A.record.signed ? (A.record.lo || A.record.owner) : null,
        genesisHash: A.record.gen || null,
        store,
        // v0.3: a guest opens the ledger read only (identity null); a sign-in binds its working keys later.
        identity: identity && identity.privateKey ? { privateKey: identity.privateKey, pub: identity.pub } : null,
        miner: A.miner,
        verifierPool: A.verifierPool,
        config: { minBits: A.config.chain.minBits, ingressRate: A.config.ledger.ingressRate }
      })
    }
    let node
    try {
      node = await openWith(new chain.IdbBlockStore())
    } catch (err) {
      // No IndexedDB for the ledger (E_STORAGE): keep the ledger for this page view in memory; it
      // syncs from peers and the snapshot as usual, it is just not kept on this device.
      if (!(err && err.code === 'E_STORAGE') || typeof chain.MemoryBlockStore !== 'function') throw err
      A.log('ledger storage unavailable (' + errMessage(err) + '); keeping the ledger in memory for this page view')
      node = await openWith(new chain.MemoryBlockStore())
    }
    A.node = node
    A.followerNode = null
    A.nodeSettled = true
    if (node.ownerConflict) A.ui.setBanner('owner', STRINGS.ownerConflict, { kind: 'warn' })
    else if (node.ownerMismatch) A.ui.setBanner('owner', STRINGS.ownerMismatch, { kind: 'warn' })
    node.subscribe(() => onLedgerChange(A))
    await importLinkGenesis(A, node)
    if (A.identityMode === 'v03') await bindKeys(A, A.api.identity.keys())
    holdOwnLedger(A)
    onLedgerChange(A)
    if (A.bridge) A.bridge.setNode(node)
    else A.api.setNode(node)
    if (A.tm) {
      // Torrents added before the node opened still get the extension on their future wires.
      if (A.tm.site && A.tm.site.torrent) attachLedger(A, A.tm.site.torrent)
      if (A.tm.rendezvous && A.tm.rendezvous.torrent) attachLedger(A, A.tm.rendezvous.torrent)
    }
    A.log('ledger open, height ' + node.height)
    return node
  } catch (err) {
    A.nodeSettled = true
    A.log('ledger unavailable: ' + errMessage(err))
    A.ui.setBanner('ledger', STRINGS.ledgerUnavailable, { kind: 'warn', dismissible: true })
    if (A.bridge) A.bridge.setNode(null, { failed: true })
    else A.api.setNode(null, { failed: true })
    return null
  }
}

async function followLedger (A) {
  if (A.identityMode !== 'v03') {
    try { await loadIdentity(A, { create: false }) } catch (err) { A.log('identity: ' + errMessage(err)) }
  }
  const node = new RemoteNode(A.link)
  node.identity = A.identityInfo
  A.followerNode = node
  A.node = node
  A.nodeSettled = true
  node.subscribe(() => onLedgerChange(A))
  A.link.send('need-state')
  if (A.bridge) A.bridge.setNode(node)
  else A.api.setNode(node)
  return node
}

function onLedgerChange (A) {
  const node = A.node
  if (!node) return
  const snap = (() => { try { return node.snapshot() } catch (_) { return null } })()
  const entries = (snap && typeof snap.height === 'number') ? snap.height : (node.height || 0)
  const peers = typeof node.peers === 'number' ? node.peers : (A.tm ? A.tm.peers : 0)
  A.ui.setLedger({ entries, inSync: node.inSyncPeers || 0, peers })
  if (A.identityInfo && snap && snap.profiles) {
    const name = snap.profiles instanceof Map ? snap.profiles.get(A.identityInfo.pub) : snap.profiles[A.identityInfo.pub]
    if (typeof name === 'string' && name !== A.identityInfo.name) {
      A.identityInfo = Object.assign({}, A.identityInfo, { name })
      A.ui.setIdentity(Object.assign({ role: node.role }, A.identityInfo))
    }
  }
  if (snap && snap.bytes && snap.policy && snap.policy.maxChainBytes && snap.bytes >= snap.policy.maxChainBytes) A.ui.setBanner('cap', STRINGS.ledgerCap, { kind: 'info', dismissible: true })
  scheduleLedgerDoors(A) // C2 doors: the owner's _doors item (S4 D5)
  broadcastState(A)
}

function broadcastState (A) {
  if (!A.isLeader || !A.link || !A.node || A.node === A.followerNode) return
  if (A.stateTimer) return
  A.stateTimer = setTimeout(() => {
    A.stateTimer = null
    const node = A.node
    let snap = null
    try { snap = node.snapshot() } catch (_) { snap = null }
    if (!snap) return
    A.link.send('state', { snap, peers: A.tm ? A.tm.peers : 0, inSync: node.inSyncPeers || 0, role: node.role, identity: A.identityInfo, auth: A.api ? A.api.identity.state() : null, mode: A.identityMode || null })
  }, 250)
}

function installTabLink (A) {
  if (!A.tabCalls) A.tabCalls = new Map()
  A.link.on(async (m) => {
    if (m.t === 'consent') {
      if (m.state !== A.consentState) {
        // Code review round 1: a message on the tab channel is not a choice by itself; it is adopted
        // only when the stored per-origin record (the sending tab stored it first) says the same.
        const rec = await readConsentRecord(A, consentKeyFor(A.mode.mode, A.ledgerId))
        const stored = consentFromRecord(rec, { rcpt: recipientsKey(A.record, A.config), config: A.config })
        if (stored !== m.state) { A.log('ignored a sharing choice from another tab that the stored choice does not confirm'); return }
        A.consentRecord = rec
        if (A.hideGate) { A.hideGate(); A.hideGate = null }
        await setConsent(A, m.state, { broadcast: false })
      }
      return
    }
    if (m.t === 'signed-out') {
      if (!A.isLeader || A.node === A.followerNode) onSignedOutBroadcast(A)
      return
    }
    if (m.t === 'state' && A.followerNode) {
      A.followerNode.apply(m)
      A.ui.setPeers(Number(m.peers) || 0)
      if (A.identityMode === 'v03' && (m.auth === 'signed-in' || m.auth === 'guest')) {
        const id = m.identity && typeof m.identity === 'object' && typeof m.identity.pub === 'string' ? { pub: m.identity.pub, short: m.identity.short || null, name: m.identity.name || null, mode: siteModeOf(m.identity.mode) } : null
        A.api.identity.setRemote({ state: m.auth, info: m.auth === 'signed-in' ? id : null })
      }
      // The engine tab signs this tab's writes: show its identity (a follower never creates one).
      if (m.identity && typeof m.identity === 'object' && typeof m.identity.pub === 'string' && (!A.identityInfo || A.identityInfo.pub !== m.identity.pub)) {
        A.identityInfo = { pub: m.identity.pub, short: m.identity.short || null, name: m.identity.name || null }
        A.ui.setIdentity(A.identityInfo)
      }
      return
    }
    if (m.t === 'version' && m.btih !== A.btih) {
      // Code review round 1: authoritative in every tab, once the stored pointer confirms it: the
      // engine tab stops sharing the superseded version at once, and nobody seeds it again.
      const rec = await savedRecordNaming(A, m.btih)
      if (!rec) return
      if (rec.withdrawn) { await withdrawNow(A, rec); return }
      markSuperseded(A, 'another tab found ' + m.btih)
      A.ui.setBanner('update', STRINGS.updateAvailable, { kind: 'info', actions: [{ label: STRINGS.reload, primary: true, onClick: () => A.win.location.reload() }] })
      return
    }
    if (m.t === 'need-site') {
      if (A.isLeader && !A.destroyed) serveNeededVersion(A, m.btih)
      return
    }
    if (!A.isLeader || !A.node || A.node === A.followerNode) return
    if (m.t === 'need-state' || m.t === 'leader') { broadcastState(A); return }
    if (m.t === 'cancel') {
      const ctl = A.tabCalls.get(m.from + ' ' + m.id)
      if (ctl) ctl.abort()
      return
    }
    if (m.t === 'call') {
      const node = A.node
      const key = m.from + ' ' + m.id
      const ctl = typeof AbortController === 'function' ? new AbortController() : null
      if (ctl) A.tabCalls.set(key, ctl)
      const opts = {
        signal: ctl ? ctl.signal : null,
        onProgress: (p) => { A.link.send('pow', { id: m.id, to: m.from, hashes: Number(p.hashes) || 0, bits: Number(p.bits) || 0 }) }
      }
      const args = m.args.slice(0, TAB_ARITY[m.method])
      while (args.length < TAB_ARITY[m.method]) args.push(undefined)
      let reply
      try {
        if ((m.method === 'ban') && node.role !== 'owner' && node.role !== 'moderator') throw Object.assign(new Error('only moderators can ban'), { code: 'E_NOT_MODERATOR' })
        const block = await node[m.method](...args, opts)
        reply = { ok: true, result: block && block.h ? { h: block.h } : (typeof block === 'string' ? block : null) }
      } catch (err) {
        reply = { ok: false, error: { code: (err && err.code) || 'E_INTERNAL', message: errMessage(err) } }
      } finally {
        if (ctl && A.tabCalls.get(key) === ctl) A.tabCalls.delete(key)
      }
      A.link.send('result', Object.assign({ id: m.id, to: m.from }, reply))
    }
  })
}

/** loopbackPair(pageUrl, url) -> true when both the page and url are on loopback hosts (localhost, *.localhost, 127.0.0.1, [::1]). */
export function loopbackPair (pageUrl, url) {
  try {
    const page = new URL(pageUrl)
    const u = new URL(String(url), page.href)
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password && isLoopbackDoorHost(page.host) && isLoopbackDoorHost(u.host)
  } catch (_) { return false }
}

async function fetchSnapshot (A) {
  const cs = A.record && A.record.cs
  if (!cs || !A.node || typeof A.node.importSnapshot !== 'function') return
  // Review round R 5.3 (PTR-8): cs= is fetched only from this page's origin or https on a public host. Integrator: a page that
  // itself runs on a loopback host (local development, the e2e hub of *.localhost) may also read a loopback cs=; a page on a
  // public host never reaches a loopback address this way.
  if (!isPublicHttpsUrl(cs, { base: A.win.location.href, origin: A.origin || A.win.location.origin }) && !loopbackPair(A.win.location.href, cs)) { A.log('snapshot (cs=) refused: not this origin and not a public https host'); return }
  try {
    const url = new URL(cs, A.win.location.href).href
    // Code review round 1: a capped read with a timeout; gzip inflates with a cap, without
    // DecompressionStream (Safari 15.4 to 16.3) through src/common/inflate.js.
    const blocks = await readSnapshot({
      url,
      fetch: (u, init) => A.win.fetch(u, init),
      maxBytes: A.config.ledger.snapshotMaxBytes,
      maxInflatedBytes: A.config.ledger.snapshotMaxInflatedBytes,
      timeoutMs: A.config.ledger.snapshotTimeoutMs,
      DecompressionStream: A.win.DecompressionStream, // lint-floor-ignore: optional, inflate.js otherwise
      Blob: A.win.Blob
    })
    await A.node.importSnapshot(blocks)
    A.log('snapshot: ' + blocks.length + ' blocks offered')
  } catch (err) {
    A.log('snapshot (cs=) failed: ' + errMessage(err))
  }
}

// ---- after render: updates, storage, diagnostics ----------------------------------------------------

function afterRender (A) {
  if (A.ledgerPromise) {
    A.ledgerPromise.then((node) => {
      if (node && A.isLeader && node !== A.followerNode) fetchSnapshot(A)
    })
  }
  pruneVersions(A)
  // persist() is requested only from the consent click itself (digest P1-7: Firefox prompts at load).
  if (A.resolved && (A.resolved.dnsDeferred || A.dnsHost)) scheduleUpdateCheck(A, A.resolved.dnsDeferred ? 0 : A.config.pointer.minTtlMs)
  checkPageTagUpdate(A, 'load')
  afterDoorRender(A) // C2 doors: the last good door, the probe of this address, the ledger's _doors, the Doors panel
}

/**
 * Page-tag update check (shell mode, §4 and §5.8). Shell navigations are answered from the worker's
 * cache, so this document carries the page tag the worker cached when it installed. The worker
 * fetches the host's current shell (mw-shell-check, which also refreshes its cached copy when the
 * build is the same) and returns its page tag; a newer record signed by the pinned owner is handled
 * like a DNS update: "Update available: reload", seeding of the old version stops at once, and the
 * record is kept for the scope so the next load uses it even before the cached shell is replaced.
 */
async function checkPageTagUpdate (A, reason) {
  if (A.destroyed || A.checkingTag || !A.mode || A.mode.mode !== 'shell' || !A.hasSw || !A.record || !A.record.signed || !A.resolved) return
  A.checkingTag = true
  A.lastTagCheck = Date.now()
  try {
    const reply = await requestServiceWorker('mw-shell-check', {}, { proto: A.config.proto, timeoutMs: A.config.timeouts.xsMs || 10000 })
    const text = reply && reply.ok && typeof reply.pointer === 'string' ? reply.pointer : null
    if (!text || text === A.resolved.raw || A.destroyed) return
    const deps = pointerDeps(A)
    // Review round R 5.3 (PTR-3, MF-28): the rendered record is the previous record, so nx= binds updates too.
    const ctx = updateContext(A, { now: Date.now() })
    try { ctx.pin = await deps.cache.getPin(A.scope) } catch (_) { ctx.pin = null }
    const cand = await vetCandidate(text, 'meta', ctx, deps)
    if (!ctx.pin) await anchorCandidate(cand, A.record, A.scope, deps)
    await guardUpdate(cand, A.record, ctx.now)
    if (cand.status === 'rejected' && cand.reason) A.log('page tag update refused: ' + cand.reason)
    if (!isUpdate(A.record, cand)) return
    A.log('update (page tag, ' + reason + '): ' + cand.record.btih + ' seq ' + cand.record.seq)
    try { await deps.cache.savePointer(A.scope, { record: cand.record, raw: cand.raw, source: 'meta', savedAt: Date.now(), ttlUntil: null }) } catch (_) { /* ignore */ }
    if (cand.ledgerId) await noteLedger(deps.cache, cand.ledgerId, cand.record, cand.lineage)
    if (cand.rotated) { try { await deps.cache.savePin(A.scope, cand.record.owner, { decidedAt: Date.now(), rotatedAt: Date.now() }) } catch (_) { /* ignore */ } }
    if (cand.ownerChange) noteOwnerChange(A, cand.ownerChange)
    if (cand.record.withdrawn) { await withdrawNow(A, cand.record); return } // v0.2.1 A3: at once, not after a reload
    A.ui.setBanner('update', STRINGS.updateAvailable, { kind: 'info', actions: [{ label: STRINGS.reload, primary: true, onClick: () => A.win.location.reload() }] })
    // Takedown (§5.8): stop seeding the superseded version at once (in every tab); it is deleted after reload.
    markSuperseded(A, 'page tag update')
    if (A.link) A.link.send('version', { btih: cand.record.btih })
  } catch (err) {
    A.log('page tag check failed: ' + errMessage(err))
  } finally {
    A.checkingTag = false
  }
}

/**
 * updateContext(A, extra) → the vetting context of an update check (review round R 5.3, PTR-3): the context the page
 * resolved with, plus the rendered record as previousRecord (nx=, MF-28) and its seq as the floor. Every vetCandidate
 * call of an update path goes through this (a unit test scans the source for it).
 */
export function updateContext (A, extra = {}) {
  const current = A.record && A.record.signed ? A.record : null
  return Object.assign({}, A.pointerCtx || {}, { pin: null, cachedSeq: current ? current.seq : null, previousRecord: current }, extra)
}

/**
 * guardUpdate(cand, current, now) → cand (review round R 5.3, PTR-3, PTR-1): an update that changes the owner goes through
 * rotationDecision (accept: cand.ownerChange is set for the notice; anything else: rejected), and an update whose lo= is
 * unproven is rejected ('lineage').
 */
export async function guardUpdate (cand, current, now = Date.now()) {
  if (!cand || cand.status !== 'ok' || !cand.record || !cand.record.signed) return cand
  if (cand.lineage === 'unproven') {
    cand.status = 'rejected'
    cand.reason = 'lineage'
    return cand
  }
  if (current && current.signed && current.owner && cand.record.owner !== current.owner) {
    let d = null
    try { d = await rotationDecision({ prev: current, next: cand.record, firstVisit: false, rotOk: !!cand.rotated, now }) } catch (_) { d = null }
    if (!d || d.decision !== 'accept') {
      cand.status = 'rejected'
      cand.reason = (d && d.reason) || 'owner-changed'
    } else {
      cand.ownerChange = d
    }
  }
  return cand
}

function noteOwnerChange (A, d) {
  if (!d || d.minutesAgo === null || d.minutesAgo === undefined) return
  try { Promise.resolve(A.ui.prompt('owner-changed', { minutes: d.minutesAgo })).catch(() => {}) } catch (_) { /* no cards */ }
}

function scheduleUpdateCheck (A, delayMs) {
  if (!A.dnsHost || (A.deps.doh.shouldSkipDoh && A.deps.doh.shouldSkipDoh(A.dnsHost))) return
  // C1: the DNS update channel runs only after a choice that allows the lookup.
  if (!dnsAllowedBy(A.consentRecord, A.config)) return
  if (A.updateTimer) clearTimeout(A.updateTimer)
  A.updateTimer = setTimeout(() => checkForUpdate(A, 'timer'), clampTimerMs(Math.max(0, Number(delayMs) || 0), { min: 0 }))
}

async function checkForUpdate (A, reason) {
  if (A.destroyed || A.checkingUpdate || !A.dnsHost || !dnsAllowedBy(A.consentRecord, A.config)) return
  A.checkingUpdate = true
  A.lastUpdateCheck = Date.now()
  let nextMs = A.config.pointer.minTtlMs
  try {
    // Review round R 5.3 (PTR-3, MF-28): the rendered record is the previous record, so nx= binds updates too.
    const ctx = updateContext(A, { now: Date.now(), blockOnDns: true, dohAllowed: dnsAllowedBy(A.consentRecord, A.config) })
    const deps = pointerDeps(A)
    try { ctx.pin = await deps.cache.getPin(A.scope) } catch (_) { ctx.pin = null }
    const r = await dnsCandidate(ctx, deps, { fresh: true })
    if (r.answer && r.answer.ttlUntil) nextMs = Math.max(A.config.pointer.minTtlMs, r.answer.ttlUntil - Date.now())
    const cand = r.candidate
    if (cand && !ctx.pin) await anchorCandidate(cand, A.record, A.scope, deps)
    if (cand) await guardUpdate(cand, A.record, ctx.now)
    if (cand && cand.status === 'rejected' && cand.reason) A.log('DNS update refused: ' + cand.reason)
    if (cand && isUpdate(A.record, cand)) {
      A.log('update (' + reason + '): ' + cand.record.btih + ' seq ' + cand.record.seq)
      try { await deps.cache.savePointer(A.scope, { record: cand.record, raw: cand.raw, source: 'dns', savedAt: Date.now(), ttlUntil: r.answer.ttlUntil }) } catch (_) { /* ignore */ }
      if (cand.ledgerId) await noteLedger(deps.cache, cand.ledgerId, cand.record, cand.lineage)
      if (cand.rotated) { try { await deps.cache.savePin(A.scope, cand.record.owner, { decidedAt: Date.now(), rotatedAt: Date.now() }) } catch (_) { /* ignore */ } }
      if (cand.ownerChange) noteOwnerChange(A, cand.ownerChange)
      if (cand.record.withdrawn) { await withdrawNow(A, cand.record); return } // v0.2.1 A3: at once, not after a reload
      A.ui.setBanner('update', STRINGS.updateAvailable, { kind: 'info', actions: [{ label: STRINGS.reload, primary: true, onClick: () => A.win.location.reload() }] })
      // Takedown (§5.8): stop seeding the superseded version at once (in every tab); it is deleted after reload.
      markSuperseded(A, 'DNS update')
      if (A.link) A.link.send('version', { btih: cand.record.btih })
    }
  } catch (err) {
    A.log('update check failed: ' + errMessage(err))
  } finally {
    A.checkingUpdate = false
    scheduleUpdateCheck(A, nextMs)
  }
}

function startDiagnostics (A) {
  if (A.diagTimer) return
  A.diagTimer = setInterval(() => updateDiagnostics(A), 2000)
}

function updateDiagnostics (A) {
  if (!A.tm) return
  const input = A.tm.diagnostics()
  input.graceMs = A.config.ui.diagnoseAfterMs
  const rows = classifyFailures(input)
  const seen = new Set()
  for (const row of rows) {
    seen.add(row.row)
    A.ui.diagnostics.set(row.row, { count: row.count, text: row.detail ? String(row.detail) : '' })
  }
  // v0.2.1: web seeds in back-off (B4) and wires closed by the guard (B5).
  const f = A.tm.failures
  const backoff = Object.keys(f.webseedBackoff || {})
  if (backoff.length) {
    seen.add('webseed-backoff')
    A.ui.diagnostics.set('webseed-backoff', { text: backoff.map((u) => { try { return new URL(u).host } catch (_) { return u } }).join(', ') })
  }
  if (f.dropped > 0) {
    seen.add('wire-dropped')
    A.ui.diagnostics.set('wire-dropped', { count: f.dropped })
  }
  const kept = new Set(['dns-blocked', 'connectivity'])
  for (const row of A.ui.diagnostics.rows()) if (!kept.has(row) && !seen.has(row)) A.ui.diagnostics.set(row, null)
  // Within 5 s of no progress, the status line names the most useful row (DESIGN-REVIEW S5).
  if (!A.mount && Date.now() - A.startedAt > A.config.ui.diagnoseAfterMs && rows.length) {
    const webseedOk = input.webseed === 'ok'
    const top = rows.find((r) => r.row === 'tracker-unreachable' && webseedOk) ? null : rows[0]
    if (!top) A.ui.setStatus(STRINGS.peerDiscoveryDown, 'warn')
    else {
      const def = STRINGS.matrix[top.row]
      A.ui.setStatus(typeof def.label === 'function' ? def.label(top.count || 0) : def.label, 'warn')
    }
  }
}

// ---- lifecycle (§8) ---------------------------------------------------------------------------------

// lifecyclePlan moved to ./policy.js (code review round 1: the drop-in runtime uses it too); app.js
// re-exports it at the end of the file.

function installLifecycle (A) {
  const cfg = A.config.policy
  const flush = () => {
    try { if (A.nodeStore && typeof A.nodeStore.flush === 'function') A.nodeStore.flush() } catch (_) { /* ignore */ }
  }
  const apply = (event, extra = {}) => {
    const plan = lifecyclePlan(event, Object.assign({ policy: A.policy, suspended: !!(A.tm && A.tm.suspended) }, extra))
    if (plan.flush) flush()
    if (plan.clearBatteryTimer && A.hiddenTimer) { clearTimeout(A.hiddenTimer); A.hiddenTimer = null }
    if (!A.tm) return plan
    // C2 wire-ui (SZ 3.1.4): a desktop tab in "Keep this site" mode keeps sharing while it is hidden.
    if (plan.batteryTimer && !keeperActive(A)) {
      if (A.hiddenTimer) clearTimeout(A.hiddenTimer)
      A.hiddenTimer = setTimeout(() => { A.hiddenTimer = null; if (A.tm) A.tm.pause() }, cfg.hiddenBatteryMs)
    }
    if (plan.pause) A.tm.pause()
    if (plan.rebuild) {
      A.tm.rebuild()
      A.rebuilds = (A.rebuilds || 0) + 1
      A.log('engine rebuilt (' + event + (extra.hiddenFor ? ', hidden ' + Math.round(extra.hiddenFor / 1000) + ' s' : '') + ')')
    }
    return plan
  }
  // Code review round 1: the network class is detected again on every change of network (Wi-Fi to
  // mobile data and back), on 'online' and when the page becomes visible, not only once.
  A.stopNetwork = watchNetwork({ nav: A.win.navigator, onChange: () => { refreshEnvironment(A); callsNetwork(A) } }) // C2 wire-ui: calls restart ICE
  A.stopLifecycle = watchLifecycle({
    onHidden: () => { A.hiddenAt = Date.now(); apply('hidden'); callsVisible(A, false) }, // C2 wire-ui
    onVisible: (hiddenFor) => {
      A.lastHiddenMs = hiddenFor
      callsVisible(A, true) // C2 wire-ui: tracks the browser paused come back (replaceTrack)
      refreshEnvironment(A)
      apply('visible', { hiddenFor })
      if (Date.now() - (A.lastUpdateCheck || 0) > A.config.pointer.focusRecheckMinMs) checkForUpdate(A, 'visible')
      if (Date.now() - (A.lastTagCheck || 0) > A.config.pointer.focusRecheckMinMs) checkPageTagUpdate(A, 'visible')
      probeThisDoor(A, 'visible') // C2 doors: throttled (at most every 5 minutes after a good answer)
    },
    onPageHide: () => { closeSessions(A); apply('pagehide'); flushSeedMeters(A) }, // C2 wire-ui: the month record
    onPageShow: (persisted) => apply('pageshow', { persisted }),
    onOnline: () => {
      A.ui.setStatus(STRINGS.backOnline, 'ok')
      refreshEnvironment(A)
      apply('online')
    },
    onOffline: () => A.ui.setStatus(STRINGS.offline, 'warn'),
    onFreeze: () => apply('freeze'),
    onResume: () => apply('resume')
  }, { doc: A.doc, win: A.win })
  A.win.addEventListener('focus', () => {
    if (Date.now() - (A.lastUpdateCheck || 0) > A.config.pointer.focusRecheckMinMs) checkForUpdate(A, 'focus')
    if (Date.now() - (A.lastTagCheck || 0) > A.config.pointer.focusRecheckMinMs) checkPageTagUpdate(A, 'focus')
  })
}

// ---- settings ---------------------------------------------------------------------------------------

function installSettings (A) {
  A.ui.settings.onChange((action, payload) => changeSetting(A, action, payload))
}

/**
 * iosHintFor(nav) → true on iPhone, iPod and iPad (iPadOS Safari sends a Macintosh user agent, so a
 * touch screen tells them apart; code review round 1) when the page is not already a Home Screen app.
 */
export function iosHintFor (nav) {
  if (!nav) return false
  const ua = typeof nav.userAgent === 'string' ? nav.userAgent : ''
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && Number(nav.maxTouchPoints) > 1)
  return ios && !nav.standalone
}

async function buildSettingsModel (A) {
  let usage = null
  try { usage = await A.deps.cache.estimateUsage() } catch (_) { usage = null }
  const storage = typeof usage === 'number' ? { usage } : (usage || {})
  const id = A.identityInfo
  const node = A.node
  let entries = null
  try { entries = node ? (node.snapshot() || {}).height || node.height || 0 : null } catch (_) { entries = null }
  return {
    share: A.prefs.share,
    hostOnly: !!(A.policy && A.policy.hostOnly),
    hostOnlyForced: !A.webrtc,
    isMobile: !!(A.env && A.env.isMobile),
    shareOnNetwork: A.prefs.shareOnNetwork,
    storage: { usage: storage.usage || storage.usageBytes || 0, quota: storage.quota || storage.quotaBytes || 0 },
    persisted: A.persisted === true ? true : A.persisted === false ? false : null,
    iosHint: iosHintFor(A.win.navigator),
    canForget: !!A.btih,
    identity: A.identityMode === 'v03'
      ? { short: id ? id.short : null, name: id ? id.name : null, canExport: false, canImport: false, v03: true }
      : (id ? { short: id.short, name: id.name, canExport: !!A.identity && A.identity.kind !== 'moderator', canImport: true } : null),
    moderator: A.moderatorShort ? { short: A.moderatorShort } : null,
    ledger: node ? { entries, inSync: node.inSyncPeers || 0, peers: typeof node.peers === 'number' ? node.peers : 0 } : null,
    version: A.config.version,
    seed: seedModel(A) // C2 wire-ui: declarations, the keeper toggle, dock mode, the month counter
  }
}

async function refreshSettings (A) {
  try { A.ui.settings.setModel(await buildSettingsModel(A)) } catch (err) { A.log('settings: ' + errMessage(err)) }
  refreshDoors(A) // C2 doors: the Doors section
}

async function changeSetting (A, action, payload = {}) {
  const { ui, deps } = A
  const notify = ui.settings.notify
  switch (action) {
    case 'open': return refreshSettings(A)
    case 'consent':
      // "Change your sharing choice" (Settings) and ui.openConsent(): the same first-run card again.
      if (A.record && !A.hideNotice && !A.hideGate) showConsentCard(A)
      return
    case 'close': ui.settings.clearInputs(); return
    case 'openIdentity':
      // v0.3: the loader-owned Settings button (a trusted click there) opens the identity page.
      A.api.openIdentityFromCard().catch((err) => notify('identity', errMessage(err), 'error'))
      return
    case 'share':
      A.prefs.share = !!payload.on
      await deps.cache.setPref('uploads', A.prefs.share)
      recomputePolicy(A)
      ui.setStatus(A.policy.uploadsEnabled ? STRINGS.seeding : STRINGS.uploadsOff, A.policy.uploadsEnabled ? 'ok' : 'warn')
      break
    case 'hostOnly':
      A.prefs.hostOnly = !!payload.on
      await deps.cache.setPref('hostOnly', A.prefs.hostOnly)
      recomputePolicy(A)
      if (A.tm) A.tm.setHostOnly(A.policy.hostOnly)
      ui.setStatus(A.policy.hostOnly ? STRINGS.hostOnlyActive : STRINGS.connecting)
      break
    case 'shareOnNetwork':
      A.prefs.shareOnNetwork = !!payload.on
      await deps.cache.setPref('shareOnNetwork:' + A.origin, A.prefs.shareOnNetwork)
      // C2 wire-ui (seed-policy request): turning it off answers the seed.ask card too (SZ-1: asked once).
      if (!A.prefs.shareOnNetwork && !A.prefs.seedAsked) await markSeedAsked(A)
      recomputePolicy(A)
      break
    // C2 wire-ui (SZ 3.1.3, 3.1.4): "I am on Wi-Fi" and "My phone is plugged in" for this page, the keeper tab, and dock
    // mode, which starts inside this click (dock.js requests the Wake Lock before any await).
    case 'dock':
      toggleDockFromSettings(A)
      return
    case 'declareWifi':
      A.prefs.declaredWifi = !!payload.on
      recomputePolicy(A)
      break
    case 'declarePlugged':
      A.prefs.declaredPlugged = !!payload.on
      recomputePolicy(A)
      break
    case 'keeper':
      try { await setKeeper(A, !!payload.on) } catch (err) { notify('sharing', errMessage(err), 'error') }
      break
    case 'forget':
      try {
        if (A.tm) A.tm.destroy()
        let versions = []
        try { versions = (await deps.cache.getPref('versions:' + A.ledgerId, [])) || [] } catch (_) { versions = [] }
        for (const v of new Set(versions.concat(A.btih ? [A.btih] : []))) { try { await deps.cache.deleteSite(v) } catch (_) { /* ignore */ } }
        await deps.cache.setPref('versions:' + A.ledgerId, [])
        if (A.mount) { try { A.mount.destroy() } catch (_) { /* ignore */ } A.mount = null }
        notify('storage', STRINGS.settingsForgetDone, 'ok')
        ui.setStatus(STRINGS.settingsForgetDone, 'info')
        ui.setBanner('forgotten', STRINGS.settingsForgetDone, { kind: 'info', actions: [{ label: STRINGS.reload, onClick: () => A.win.location.reload() }] })
        refreshSettings(A)
      } catch (err) { notify('storage', errMessage(err), 'error') }
      return
    case 'exportIdentity':
      try {
        const text = await exportCurrentIdentity(A, payload.passphrase)
        ui.download('identity-' + ((A.identityInfo && A.identityInfo.short) || 'site') + '.json', text)
        notify('identity', STRINGS.settingsIdentityExported, 'ok')
      } catch (err) { notify('identity', errMessage(err), 'error') }
      return
    case 'importIdentity':
      try {
        await importIdentity(A, payload.text, payload.passphrase)
        notify('identity', STRINGS.settingsIdentityImported, 'ok')
        setTimeout(() => A.win.location.reload(), 600)
      } catch (err) { notify('identity', errMessage(err), 'error') }
      return
    case 'importModerator':
      try {
        const listed = await importModeratorKey(A, payload.text)
        notify('moderator', listed ? STRINGS.settingsIdentityImported : STRINGS.settingsModeratorNotListed + ' ' + STRINGS.settingsIdentityImported, listed ? 'ok' : 'info')
        setTimeout(() => A.win.location.reload(), 900)
      } catch (err) { notify('moderator', errMessage(err), 'error') }
      return
    case 'removeModerator':
      try {
        await deps.cache.deleteKey('moderator:' + A.ledgerId)
        setTimeout(() => A.win.location.reload(), 300)
      } catch (err) { notify('moderator', errMessage(err), 'error') }
      return
    case 'exportLedger':
      try {
        const blocks = A.node && typeof A.node.exportBlocks === 'function' ? A.node.exportBlocks() : null
        if (!blocks) throw new Error(STRINGS.ledgerUnavailable)
        ui.download('ledger-' + String(A.ledgerId).replace(/[^a-z0-9._-]+/gi, '_') + '.json', JSON.stringify(blocks))
      } catch (err) { notify('ledger', errMessage(err), 'error') }
      return
    case 'copyDoorLink': // C2 doors: "Copy link with doors" (the visitor's click; the link is shown as text when copying fails)
      return copyDoorLink(A, payload && payload.link)
    default:
      return
  }
  updateSubline(A)
  refreshSettings(A)
}

async function exportCurrentIdentity (A, passphrase) {
  const { cache, crypto } = A.deps
  const rec = await cache.getKey('identity:' + A.ledgerId)
  if (!rec || !rec.pub) throw Object.assign(new Error('no identity on this device yet'), { code: 'E_IDENTITY' })
  const jwk = rec.kind === 'jwk' ? rec.jwk : await crypto.exportPrivateJwk(rec.privateKey)
  return exportIdentityText({ jwk, pub: rec.pub, ledgerId: A.ledgerId, passphrase, iterations: A.config.identity.pbkdf2Iterations })
}

async function importIdentity (A, text, passphrase) {
  const { cache, crypto } = A.deps
  const res = await importIdentityText(text, passphrase, { publicFromPrivateJwk: crypto.publicFromPrivateJwk })
  let pair = null
  try {
    const privateKey = await crypto.importPrivateJwk(res.jwk, { extractable: true })
    const publicKey = await globalThis.crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: res.jwk.x, y: res.jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])
    pair = { privateKey, publicKey }
  } catch (_) { pair = null }
  await storeKey(cache, crypto, 'identity:' + A.ledgerId, { pair, jwk: res.jwk, pub: res.pub })
  return { pub: res.pub, short: await safeFingerprint(A, res.pub) }
}

async function importModeratorKey (A, text) {
  const { cache, crypto } = A.deps
  let jwk
  try { jwk = JSON.parse(String(text || '')) } catch (_) { throw Object.assign(new Error('Paste the moderator key file (a JWK).'), { code: 'E_IDENTITY' }) }
  if (jwk && !jwk.d && jwk.privateKey) jwk = jwk.privateKey
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.d !== 'string') throw Object.assign(new Error('Expected a P-256 private JWK.'), { code: 'E_IDENTITY' })
  const pub = await crypto.publicFromPrivateJwk(jwk)
  await storeModeratorKey(A, jwk, pub)
  let listed = false
  try {
    const snap = A.node && A.node.snapshot ? A.node.snapshot() : null
    const mods = snap && snap.policy ? snap.policy.moderators : null
    listed = Array.isArray(mods) ? mods.includes(pub) : (mods instanceof Set ? mods.has(pub) : false)
  } catch (_) { listed = false }
  return listed
}

// ---------------------------------------------------------------------------------------------
// v0.3 (R 2.2 to 2.11, 2.16.4, 3.3; ARCHITECTURE 15): the page's MwApi, identity, services, hub, hardening
// ---------------------------------------------------------------------------------------------

/** pageUiHooks(A): the loader-owned UI the method table uses (consent card, in-page cards, the fee line). */
function pageUiHooks (A) {
  return {
    openConsent: () => requestConsent(A),
    openIdentityExport: () => { try { A.ui.openIdentityExport() } catch (_) { /* no UI */ } },
    prompt: (kind, data) => A.ui.prompt(kind, data),
    // Code review round 1 (item 4): the fee of a write in progress on the status line.
    setWriteProgress: (p) => { try { A.ui.setWriteProgress(p) } catch (_) { /* no UI */ } }
  }
}

/** createPageApi(A): the one MwApi of this page; the Bridge is its transport and the services mount on it. */
function createPageApi (A) {
  const api = newPageApi(A)
  // owner.policy (mod.js) confirms at the identity origin through this hook, as drop-in mode does (v0.3
  // reconciliation: the shell never set it, so a personal site's owner got E_UNSUPPORTED).
  api.ownerConfirm = (card) => ownerConfirm(A, card)
  return api
}

function newPageApi (A) {
  const cfg = A.config
  return new MwApi({
    node: null,
    consent: consentApi(A),
    ui: pageUiHooks(A),
    info: () => siteInfo(A),
    identity: identityApi(A),
    limits: { writesPerMinute: cfg.bridge.writesPerMinute, maxRequestBytes: cfg.bridge.maxRequestBytes, maxListLimit: cfg.bridge.maxListLimit, readyWaitMs: cfg.bridge.readyWaitMs },
    activation: A.tracker,
    tab: () => (A.isLeader === false ? 'follower' : 'leader'),
    hostOnly: () => !!(A.policy && A.policy.hostOnly),
    readOnly: () => !!A.readOnlyLedger,
    lang: (A.win.navigator && A.win.navigator.language) || 'en',
    log: (line) => A.log(line)
  })
}

/**
 * loadV03Modules() -> the v0.3 modules of this build. Each import sits in its own try: esbuild keeps an import() it
 * cannot resolve inside a try block as a runtime import (it fails, the feature stays off) instead of failing the
 * build, so a loader built before a lane landed still loads (docs/deviations/sdk.md, contract-first adapters).
 */
async function loadV03Modules () {
  const out = {}
  try { out.identity = await import('../identity/service.js') } catch (_) { out.identity = null }
  try { out.client = await import('../identity/client.js') } catch (_) { out.client = null }
  try { out.store = await import('../identity/store.js') } catch (_) { out.store = null }
  try { out.migrate = await import('../identity/migrate.js') } catch (_) { out.migrate = null }
  try { out.sealed = await import('../identity/sealed.js') } catch (_) { out.sealed = null }
  try { out.chat = await import('../chat/service.js') } catch (_) { out.chat = null }
  try { out.files = await import('../files/service.js') } catch (_) { out.files = null }
  try { out.media = await import('../media/service.js') } catch (_) { out.media = null }
  try { out.calls = await import('../calls/service.js') } catch (_) { out.calls = null } // C2 wire-ui (lane calls)
  try { out.multi = await import('../chain/multi.js') } catch (_) { out.multi = null }
  try { out.recent = await import('../chain/recent.js') } catch (_) { out.recent = null }
  try { out.wireExt = await import('../chain/wire-ext.js') } catch (_) { out.wireExt = null }
  try { out.psl = await import('../idp/psl.js') } catch (_) { out.psl = null }
  return out
}

/**
 * setupV03(A): which identity this page uses, the PSL check of a subdomain hub, and, in the tab that runs the
 * site, the services. Follower tabs never hold keys: they show the engine tab's auth state and drop it when that
 * tab signs out (E-ID-2b).
 */
async function setupV03 (A) {
  A.v03 = await loadV03Modules()
  A.identityMode = A.v03.identity && typeof A.v03.identity.createIdentityService === 'function' ? 'v03' : 'legacy'
  // v0.3 final integration: the loader and the identity origin read the same list (the bundled snapshot plus the
  // additions of a loopback test build, PSL_TEST_RULES, which is empty in every other build).
  const rules = A.v03.psl && Array.isArray(A.v03.psl.PSL_RULES)
    ? A.v03.psl.PSL_RULES.concat(Array.isArray(A.v03.psl.PSL_TEST_RULES) ? A.v03.psl.PSL_TEST_RULES : [])
    : []
  A.pslOk = A.mode.mode !== 'hub-sub' || pslHubCheck(A.win.location.hostname, rules).persistentIdentity
  if (!A.pslOk) A.log('this hub is not on the Public Suffix List: identities here last for this visit only (R 2.17.5)')
  A.api.identity.onChange((snap) => onAuthChange(A, snap))
  if (A.identityMode === 'legacy') A.log('identity: the 0.2.1 per-site key (the identity service is not in this build)')
  if (A.identityMode === 'v03' && A.v03.store && typeof A.v03.store.onSignedOut === 'function') {
    try {
      A.offSignedOut = A.v03.store.onSignedOut(() => { if (!A.isLeader || A.node === A.followerNode) onSignedOutBroadcast(A) })
    } catch (_) { /* no BroadcastChannel */ }
  }
  if (!A.isLeader) {
    if (A.identityMode === 'v03') A.api.identity.setRemote({ state: 'guest', info: null })
    return
  }
  await mountLeaderServices(A)
}

/** mountLeaderServices(A): the identity, chat, files and media services (and the hub) of the engine tab. */
async function mountLeaderServices (A) {
  if (A.servicesMounted || !A.v03) return
  A.servicesMounted = true
  if (A.api.identity.remote) A.api.identity.setRemote(null)
  A.seam = A.seam || createTorrentSeam({ get: () => A.tm, ensure: () => ensureTorrentManager(A) })
  if (A.tm) A.seam.attach(A.tm)
  const res = await mountV03Services(A.api, {
    modules: A.v03,
    deps: {
      ledgerId: A.ledgerId,
      pointer: A.resolved ? A.resolved.raw : null,
      node: () => (A.node && A.node !== A.followerNode ? A.node : null),
      deviceClass: deviceClassOf(A.env),
      chatDevice: chatDeviceClass(A.env, A.win.navigator),
      hostOnly: () => !!(A.policy && A.policy.hostOnly),
      ownTracker: ownTrackerOf(A.record, A.config.trackers),
      torrents: A.seam,
      swPort: A.hasSw ? swPortFor(A.win.navigator) : null,
      prefs: { get: (k, d) => A.deps.cache.getPref(k, d), set: (k, v) => A.deps.cache.setPref(k, v) },
      download: (url, name) => downloadUrl(A, url, name),
      shareOnNetwork: A.prefs.shareOnNetwork === true,
      ...callDeps(A), // C2 wire-ui: the calls service (SZ 3.5), mounted after chat
      ...pinServiceDeps(A), // C2 integrator: the owner key, the pin evidence and the manager's evidence for files and media
      identityExtra: {
        // R 2.2.3, 2.17.5: a shared-origin hub, or a subdomain hub that is not on the PSL, gets "this visit only". C2 doors: a door too.
        sharedHub: A.mode.mode === 'hub-shared' || A.mode.mode === 'door' || !A.pslOk,
        win: A.win,
        origin: A.origin,
        // The scope the pointer was verified under (lane idp: the identity origin checks it there first).
        scope: () => A.scope || null,
        // R 2.2.7: the 0.2.1 key of this ledger moves into the vault at the first sign-in; its link item is written here.
        legacy: legacyDeps(A),
        // The working keys changed: the ledger signs with them from now on (or with nothing for a guest).
        onKeys: (keys) => { bindKeys(A, keys).catch((err) => A.log('keys: ' + errMessage(err))) }
      }
    }
  })
  if (res.mounted.length) A.log('v0.3 services: ' + res.mounted.join(', '))
  for (const name of Object.keys(res.errors)) A.log('v0.3 service ' + name + ' not mounted: ' + res.errors[name])
  afterServices(A) // C2 wire-ui: the call panel on the calls service; uploads, hand-off labels and the seed.ask moment
  if (A.mode.mode === 'hub-sub') mountHub(A)
  const svc = A.api.service('identity')
  // "Stay signed in" keys of this origin come back once, in the engine tab (lane idp: restore()).
  // Review round R 5.3 (PTR-1): not for a record whose lo= is unproven (the keys belong to the ledger it only claims).
  if (svc && typeof svc.restore === 'function' && !A.pendingSignIn && !A.lineageUnproven) {
    try { await svc.restore() } catch (err) { A.log('restore sign-in: ' + errMessage(err)) }
  }
  await applyPendingSignIn(A)
  await A.api.identity.refresh().catch(() => {})
}

/** applyPendingSignIn(A): the redirect round trip's answer, handed to the identity service once it is mounted. */
async function applyPendingSignIn (A) {
  const res = A.pendingSignIn
  if (!res) return
  A.pendingSignIn = null
  const svc = A.api.service('identity')
  if (!svc || typeof svc.adopt !== 'function') {
    A.log('the identity service of this build cannot take the sign-in answer of the redirect')
    return
  }
  try { await svc.adopt(res) } catch (err) { A.log('sign-in (redirect): ' + errMessage(err)) }
  await A.api.identity.refresh().catch(() => {})
}

/**
 * finishIdpReturn(A) -> true when the page should boot as the address the sign-in started from. The identity
 * origin's answer is in the fragment of /_mw/idp-return (R 2.3.1); client.completeRedirect() reads it and finds the
 * pending request; the address goes back with history.replaceState, so working keys in memory are not lost.
 */
async function finishIdpReturn (A) {
  let client = null
  try { client = await import('../identity/client.js') } catch (_) { client = null }
  const fail = (detail) => {
    A.ui.setStatus(STRINGS.genericErrorTitle, 'error')
    A.ui.showError({ title: STRINGS.genericErrorTitle, detail, actions: [{ label: STRINGS.goBack, primary: true, onClick: () => A.win.location.replace('/') }] })
    return false
  }
  if (!client || typeof client.completeRedirect !== 'function') return fail('This loader cannot finish the sign-in.')
  let res = null
  try { res = await client.completeRedirect({ win: A.win }) } catch (err) { return fail('The sign-in could not be finished (' + errMessage(err) + ').') }
  let to = '/'
  if (res && typeof res.returnTo === 'string' && res.returnTo) {
    try {
      const u = new URL(res.returnTo, A.origin + '/')
      if (u.origin === A.origin && u.pathname !== IDP_RETURN_PATH) to = u.pathname + u.search + u.hash
    } catch (_) { to = '/' }
  }
  try { A.win.history.replaceState(null, '', to) } catch (_) { A.win.location.replace(to); return false }
  A.pendingSignIn = res || null
  return true
}

/** identityHeader(info, keys) -> the shape ui.setIdentityHeader() draws (lane ui): api.js identityHeaderOf (from keys.status). */
function identityHeader (info, keys) {
  return identityHeaderOf(info, keys)
}

/**
 * onAuthChange(A, { state, info }): the working keys moved (sign-in, sign-out, a restored stay-signed-in). The ledger
 * signs with them (or with nothing for a guest), the header shows them, follower tabs hear the state, and a sign-out
 * ends the playback sessions and tells the other tabs.
 */
function onAuthChange (A, snap) {
  const signedIn = snap.state === 'signed-in'
  const keys = A.api.identity.keys()
  const moderator = A.identity && A.identity.kind === 'moderator'
  if (A.identityMode === 'v03') bindKeys(A, signedIn ? keys : null).catch((err) => A.log('keys: ' + errMessage(err)))
  if (!moderator) A.identityInfo = snap.info ? { pub: snap.info.pub, short: snap.info.short, name: snap.info.name, mode: snap.info.mode || null } : null
  try { A.ui.setIdentity(A.identityInfo) } catch (_) { /* no UI */ }
  try {
    A.ui.setIdentityHeader(signedIn && snap.info ? identityHeader(snap.info, keys) : null, {
      onSignOut: () => signOutFromHeader(A, false),
      onRemove: () => signOutFromHeader(A, true)
    })
  } catch (_) { /* no cards */ }
  broadcastState(A)
  if (!signedIn) {
    if (A.wasSignedIn && A.isLeader && A.link) A.link.send('signed-out', {})
    A.wasSignedIn = false
    const media = A.api.service('media')
    if (media && typeof media.signOut === 'function') { try { media.signOut() } catch (_) { /* gone */ } }
    closeSessions(A)
    return
  }
  A.wasSignedIn = true
}

/** onSignedOutBroadcast(A): a follower tab drops what it showed of the engine tab's sign-in (E-ID-2b). */
function onSignedOutBroadcast (A) {
  A.api.identity.setRemote({ state: 'guest', info: null })
  A.identityInfo = null
  if (A.followerNode) A.followerNode.identity = null
  try { A.ui.setIdentity(null) } catch (_) { /* no UI */ }
  try { A.ui.setIdentityHeader(null) } catch (_) { /* no cards */ }
  A.log('another tab signed out: this tab dropped its signed-in state')
}

/** signOutFromHeader(A, forget): the header's Sign out / Remove from this device (loader-owned buttons). */
async function signOutFromHeader (A, forget) {
  const svc = A.api.service('identity')
  if (!svc || !svc.methods || typeof svc.methods['auth.signOut'] !== 'function') return
  try { await svc.methods['auth.signOut']({ forget: !!forget }, { activation: true, tab: 'leader' }) } catch (err) { A.log('sign out: ' + errMessage(err)) }
  await A.api.identity.refresh().catch(() => {})
}

/**
 * legacyDeps(A) -> { get(), remove(), write(item) }: the 0.2.1 key of this ledger for the identity service (lane idp,
 * migrate.js; R 2.2.7). get() reads 'identity:<ledgerId>'; remove() deletes it from this origin (the service calls it
 * once a backup file exists); write({ l, v }) appends the 'mw.link' item as a block authored by the legacy key.
 */
function legacyDeps (A) {
  return {
    get: async () => {
      const rec = await A.deps.cache.getKey('identity:' + A.ledgerId).catch(() => null)
      return rec && rec.pub ? rec : null
    },
    remove: async () => {
      try { await A.deps.cache.deleteKey('identity:' + A.ledgerId) } catch (_) { /* gone already */ }
      A.log('the 0.2.1 key was removed from this device (it is in the identity vault and a backup file exists)')
    },
    write: (item) => writeLegacyItem(A, item)
  }
}

/** writeLegacyItem(A, { l, v }): one append authored by the 0.2.1 key (the mw.link item, R 2.2.7, 2.10.2). */
async function writeLegacyItem (A, item) {
  const node = A.node
  if (!item || typeof item.l !== 'string' || item.v === undefined) throw Object.assign(new Error('not a list item'), { code: 'E_BAD_REQUEST' })
  if (!node || node === A.followerNode || typeof node.ingest !== 'function') throw Object.assign(new Error('the site ledger is not open in this tab'), { code: 'E_POLICY' })
  const legacy = await readIdentity(A.deps.cache, A.deps.crypto, 'identity:' + A.ledgerId)
  if (!legacy) throw Object.assign(new Error('no 0.2.1 key on this device'), { code: 'E_IDENTITY' })
  const chain = await loadChainDeps()
  let bits = 0
  try { bits = Math.max(Number(A.config.chain.minBits) || 0, Number(node.state.policy.bits) || 0) } catch (_) { bits = 0 }
  const block = await chain.createBlock({
    identity: { privateKey: legacy.privateKey, pub: legacy.pub },
    site: A.ledgerId, seq: 1, prev: node.choosePrev(), op: { t: 'append', l: item.l }, value: item.v, ts: Date.now(), bits, miner: A.miner || null
  })
  await node.ingest([block], 'local')
  A.log('the 0.2.1 key signed ' + item.l + ' on this site')
  return { h: block.h }
}

/**
 * bindKeys(A, keys): what the engine tab's ledger signs with. The working keys of the sign-in, or nothing for a guest;
 * on an 'allow' site whose list still names only the 0.2.1 key, that key stays the author until the owner adds the
 * new one (HON M9; migrate.js legacyAuthorFor). A moderator key, when imported, keeps signing.
 */
async function bindKeys (A, keys) {
  if (!A.isLeader || !A.node || A.node === A.followerNode) return
  if (A.identity && A.identity.kind === 'moderator') return
  // Bound at once: the identity service calls onKeys inside the sign-in, before auth.signIn resolves, so the
  // site's first write after the popup is signed (v0.3 reconciliation: an await before this bind let that write
  // fail with E_IDENTITY, seen in the e2e run).
  const id = keys ? nodeIdentityOf(keys) : null
  setNodeIdentity(A.node, id)
  A.identity = id
  // "Replace my keys on all sites": the rotation reaches this ledger, written by the new key (MF-20).
  // Review round R 5.3 (PHISH-7): written now and again on every ledger change (a cold ledger gets the old key's keyinfo
  // later) until the rotation is in the ledger; meanwhile the page says the replacement is not on this site yet.
  if (keys && keys.rotateNotice) retryRotation(A, keys)
  else if (A.rotationRetry) A.rotationRetry()
  // The owner's own personal page signs its pointer again before it expires (code review v0.3, correctness).
  if (keys) maybeRefreshOwnPointer(A, keys).catch((err) => A.log('pointer refresh: ' + errMessage(err)))
  if (keys) holdOwnLedger(A, keys)
  const mig = A.v03 && A.v03.migrate
  if (!keys || !mig || typeof mig.legacyAuthorFor !== 'function') return
  try {
    const rec = await A.deps.cache.getKey('identity:' + A.ledgerId).catch(() => null)
    if (!rec || !rec.pub) return
    const st = A.node.state
    const who = mig.legacyAuthorFor({ policy: st && st.policy, newPub: keys.pub, legacyPub: rec.pub })
    if (who !== rec.pub) return
    const legacy = await readIdentity(A.deps.cache, A.deps.crypto, 'identity:' + A.ledgerId)
    // Still the same sign-in (not signed out or replaced meanwhile): the 0.2.1 key signs on this 'allow' site.
    if (legacy && A.identity === id && A.api.identity.keys() === keys) {
      const legacyId = { privateKey: legacy.privateKey, pub: legacy.pub, kind: 'legacy' }
      setNodeIdentity(A.node, legacyId)
      A.identity = legacyId
    }
  } catch (_) { /* the working key signs */ }
}

/**
 * retryRotation(A, keys, { write }) → stop() (review round R 5.3, PHISH-7): "Replace my keys" reaches this ledger even when
 * the node is cold at sign-in. writeRotation runs now and again on each node change (node.subscribe) until the rotate
 * block is in the ledger state (state.rotations has from → next) or the keys change; a banner says so while it waits.
 */
export function retryRotation (A, keys, { write = writeRotation } = {}) {
  if (A.rotationRetry) { try { A.rotationRetry() } catch (_) { /* ignore */ } }
  const node = A.node
  const n = keys && keys.rotateNotice
  if (!node || !n) return () => {}
  let busy = false
  let done = false
  let unsub = null
  const banner = (text) => { try { if (A.ui && typeof A.ui.setBanner === 'function') A.ui.setBanner('rotation', text, text ? { kind: 'info' } : undefined) } catch (_) { /* no UI */ } }
  const stop = () => {
    done = true
    if (unsub) { try { unsub() } catch (_) { /* ignore */ } unsub = null }
    if (A.rotationRetry === stop) A.rotationRetry = null
    banner(null)
  }
  const inLedger = () => {
    try {
      const st = node.state
      const rot = st && st.rotations instanceof Map ? st.rotations.get(n.from) : null
      return !!(rot && rot.next === n.next)
    } catch (_) { return false }
  }
  const attempt = async () => {
    if (done || busy) return
    if (inLedger()) { stop(); return }
    busy = true
    try {
      // HUB-5: a recovery commitment on this ledger that is not the person's own can never take the rotation; say so once.
      if ((await rotationBlocker(node, keys)) === 'commitment-not-yours') {
        stop()
        try { if (A.ui && typeof A.ui.setBanner === 'function') A.ui.setBanner('rotation', STRINGS.rotationBlocked, { kind: 'warn' }) } catch (_) { /* no UI */ }
        if (typeof A.log === 'function') A.log('key replacement: this site holds a recovery commitment for the old key that is not this person\'s (HUB-5)')
        return
      }
      const b = await write(node, keys, A.ledgerId)
      if (b || inLedger()) {
        if (typeof A.log === 'function') A.log('the new key took over the old one on this site (rotation written)')
        stop()
      }
    } catch (_) { /* the next change tries again */ } finally { busy = false }
  }
  if (typeof node.subscribe === 'function') { try { unsub = node.subscribe(() => { attempt() }) } catch (_) { unsub = null } }
  A.rotationRetry = stop
  attempt().then(() => {
    if (!done) banner(STRINGS.rotationPending || 'Your key replacement is not on this site yet. It is written as soon as this site\'s ledger has caught up.')
  })
  return stop
}

/**
 * maybeRefreshOwnPointer(A, keys): on the owner's own personal page (hub mode, signed in with the pointer's owner key), a
 * pointer with fewer than 30 days left is signed again (personal-site.js refreshPersonalPointer: same ledger, new seq and
 * exp) and written to the ledger's _mw.ptr, where followers pick it up; this device keeps it as its pointer for the page.
 * Before, nothing re-signed it: 90 days after "Create my page" every follow was dropped and the link stopped loading.
 */
async function maybeRefreshOwnPointer (A, keys) {
  if (!keys || !A.mode || A.mode.mode !== 'hub-sub' || !A.record || !A.record.signed || A.record.owner !== keys.pub || A.pointerRefreshing) return null
  A.pointerRefreshing = true
  try {
    const fresh = await refreshPersonalPointer({ keys, record: A.record, now: Date.now() })
    if (!fresh) return null
    const node = A.node && A.node !== A.followerNode ? A.node : null
    if (node && typeof node.put === 'function') await node.put(POINTER_KEY, fresh.text)
    A.record = fresh.record
    if (A.resolved) A.resolved = Object.assign({}, A.resolved, { record: fresh.record, raw: fresh.text })
    try { if (A.deps.cache.savePointer && A.scope) await A.deps.cache.savePointer(A.scope, { record: fresh.record, raw: fresh.text, source: 'refresh', savedAt: Date.now() }) } catch (_) { /* best effort */ }
    A.log('this page\'s pointer was signed again, valid until ' + new Date(fresh.record.exp * 1000).toISOString().slice(0, 10))
    return fresh
  } finally {
    A.pointerRefreshing = false
  }
}

/** importLinkGenesis(A, node): the genesis of a new personal site that came after the pointer in the link (R 3.3). */
async function importLinkGenesis (A, node) {
  const g = A.mode && A.mode.fragment && A.mode.fragment.genesis
  if (!g || !A.record || !A.record.signed || !node || typeof node.importSnapshot !== 'function') return false
  let height = 0
  try { height = node.height || 0 } catch (_) { height = 0 }
  if (height > 0) return false
  try {
    if (!(await checkGenesis(g, A.record, A.ledgerId))) {
      A.log('the genesis in the link does not match its pointer: ignored')
      return false
    }
    await node.importSnapshot(g)
    A.log('genesis from the link: ' + g.length + ' block(s)')
    return true
  } catch (err) {
    A.log('genesis from the link: ' + errMessage(err))
    return false
  }
}

/**
 * ownerConfirm(A, card) -> Promise<boolean>: an owner action (policy, checkpoint, withdraw, delete) or "Create my
 * page" confirmed at the identity origin, never in the page (R 3.3, MF-64): the identity service's ownerAction()
 * (lane idp; wired by the v0.3 reconciliation). Its answer replaces the working keys (a create answer carries
 * nextPubHash); the bundle JSON is never kept here (R 2.3.3).
 */
async function ownerConfirm (A, card) {
  const svc = A.api.service('identity')
  if (!svc || typeof svc.ownerAction !== 'function') throw Object.assign(new Error('owner actions need the identity page, which this loader cannot open'), { code: 'E_UNSUPPORTED' })
  const ok = (await svc.ownerAction(card)) === true
  await A.api.identity.refresh().catch(() => {})
  return ok
}

/** createPage(A, params, ctx): mw.hub.createPage() (R 3.3). */
async function createPage (A, params, ctx) {
  void params
  void ctx
  const keys = A.api.identity.keys()
  if (!keys) throw Object.assign(new Error('sign in first'), { code: 'E_NOT_SIGNED_IN' })
  // Code review v0.3 (round 2, examples-docs request R-1): a personal page belongs to the person's hub key, which signs them in
  // on every label of this hub. A key private to this one label (or this visit only) would own a page it can never sign in at.
  if (keys.keyMode !== 'hub') throw Object.assign(new Error('a personal page needs your one identity for this hub: sign in again and choose it on the identity page'), { code: 'E_POLICY' })
  const chain = await loadChainDeps()
  const genesis = (o) => chain.ChainNode.genesis(o)
  // The identity origin's "Create your page" answer replaces the working keys (same label and key, plus
  // nextPubHash): read them live, after the card.
  const svc = A.api.service('identity')
  const live = () => (svc && typeof svc.keys === 'function' && svc.keys()) || keys
  const merged = {
    get pub () { return live().pub },
    sign: (b) => live().sign(b),
    get rc () { return live().rc || null },
    get nextPubHash () { return live().nextPubHash || null }
  }
  const res = await createPersonalSite({
    keys: merged,
    templateBtih: A.btih,
    hub: { host: A.mode.hubHost, scheme: A.win.location.protocol, port: A.win.location.port },
    confirm: (card) => ownerConfirm(A, card),
    genesis,
    // v0.3 final integration: the new page repeats this page's trackers, web seeds and identity origin (transportOf),
    // or its own origin would have no way to fetch the template.
    transport: A.record
  })
  return { ledgerId: res.ledgerId, label: res.label, url: res.url, pointer: res.text }
}

/** openFollowedLedger(A, { ledgerId, record }) -> a read-only ChainNode of a followed ledger (its own store). */
async function openFollowedLedger (A, { ledgerId, record }) {
  const chain = await loadChainDeps()
  // Code review v0.3 (correctness): a followed ledger is read through the hub lane's recent window (recent.js gives blocks to
  // a node only when it already holds some, so these stay empty); a memory store and no tick timer of its own, so 1,000
  // follows are not 1,000 IndexedDB databases and 1,000 timers. The hub lane (MultiGossip) carries its sync.
  const node = await chain.ChainNode.open({
    siteId: ledgerId,
    expectedOwner: record && record.signed ? record.owner : null,
    ledgerOwner: record && record.signed ? (record.lo || record.owner) : null,
    genesisHash: record && record.gen ? record.gen : null,
    store: new chain.MemoryBlockStore(),
    identity: null,
    miner: null,
    verifierPool: A.verifierPool || null,
    config: { minBits: A.config.chain.minBits, ingressRate: A.config.ledger.ingressRate, tickMs: 0 }
  })
  A.hubLedgers.set(ledgerId, node)
  return node
}

/**
 * mountHub(A): followed ledgers in hub mode (the hub amendment, R 3.1, 3.2.2). The hub lane (MultiGossip, lane
 * chain-net) carries them when it is in the build; each followed ledger has its own read-only node and store.
 */
function mountHub (A) {
  if (A.api.service('hub')) return
  A.hubLedgers = A.hubLedgers || new Map()
  const multiMod = A.v03 && A.v03.multi
  if (multiMod && typeof multiMod.MultiGossip === 'function' && !A.multi) {
    try {
      A.multi = new multiMod.MultiGossip({
        hubSuffix: A.mode.hubHost, shard: 0, ledgers: A.hubLedgers, deviceClass: deviceClassOf(A.env),
        onView: (ledgerId) => { const n = A.hubLedgers.get(ledgerId); if (n && typeof n._notify === 'function') { try { n._notify('remote') } catch (_) { /* closed */ } } }
      })
      startHubLaneClock(A)
      joinHubLane(A).catch((err) => A.log('hub lane: ' + errMessage(err)))
    } catch (err) {
      A.log('hub lane: ' + errMessage(err))
      A.multi = null
    }
  }
  const view = viewAdapters(A.v03 && A.v03.recent)
  const svc = createHubService({
    stateOf: view ? view.stateOf : null,
    snapshotOf: view ? view.snapshotOf : null,
    openLedger: (o) => openFollowedLedger(A, o),
    closeLedger: (ledgerId) => { A.hubLedgers.delete(ledgerId) },
    multi: A.multi || null,
    prefs: { get: (k, d) => A.deps.cache.getPref(k, d), set: (k, v) => A.deps.cache.setPref(k, v) },
    deviceClass: deviceClassOf(A.env),
    // allowExpired: a stored follow whose pointer only expired stays (flagged), and a link to such a page can still be followed:
    // the signature names the owner (code review v0.3, correctness).
    verifyPointer: async (rec, o = {}) => {
      try {
        const v = await A.deps.pointer.verifyPointer(rec, hubScope(rec.btih), { now: Date.now(), allowExpired: o.allowExpired === true })
        return !!(v && v.ok)
      } catch (_) { return false }
    },
    createPage: (params, ctx) => createPage(A, params, ctx)
  })
  A.api.mount('hub', svc)
  svc.load().catch((err) => A.log('followed ledgers: ' + errMessage(err)))
}

/**
 * startHubLaneClock(A): what lane chain-net's contract asks of the loader (docs/deviations/chain-net.md, requests, item 2):
 * MultiGossip.tick() about once a second (request timeouts and retries, the ANN of new heads of held ledgers, window
 * refreshes, the phone wire trim) and setHidden() with the page's visibility. v0.3 final integration: without the tick
 * a member never heard of a post written after the first window of a page they follow (seen in E-SO-2).
 */
function startHubLaneClock (A) {
  if (!A.multi || A.multiClock) return
  const win = A.win && typeof A.win.setInterval === 'function' ? A.win : globalThis
  A.multiClock = win.setInterval(() => {
    if (!A.multi) return
    try { A.multi.tick() } catch (err) { A.log('hub lane tick: ' + errMessage(err)) }
  }, 1000)
  const doc = A.doc
  if (doc && typeof doc.addEventListener === 'function' && typeof A.multi.setHidden === 'function') {
    const onVisibility = () => { try { A.multi.setHidden(doc.visibilityState === 'hidden') } catch (_) { /* destroyed */ } }
    doc.addEventListener('visibilitychange', onVisibility)
    onVisibility()
  }
}

/**
 * joinHubLane(A): the hub follow lane swarm (lane chain-net multi.js: sha1('mw-hub-lane1|' + hub + '|' + shard)) on the
 * hub's own tracker, with the mw_chain2 extension on its wires (wire-ext.js attachToTorrent). The member's own
 * ledger is held in full on the lane. The lane joins as kind 'hub' (review round R 5.3, SCALE-6: own trackers only, never
 * the public defaults, the shared STUN list, its own wire cap from MultiGossip.wantedWires, first in the budget while syncing).
 */
async function joinHubLane (A) {
  if (!A.multi || A.hubLane) return
  const own = ownTrackerOf(A.record, A.config.trackers)
  if (!own) { A.log('hub lane: the hub names no tracker of its own (tr=), so followed ledgers sync from snapshots only'); return }
  const attach = A.v03 && A.v03.wireExt && A.v03.wireExt.attachToTorrent
  const ih = await A.multi.infoHash()
  const tm = A.tm || await ensureTorrentManager(A)
  // ledgerSync: the hub lane is a ledger swarm with its own swarm kind (SCALE-6): the shared STUN list, its own wire cap, and
  // first place in the budget while a followed ledger syncs.
  const lane = tm.joinLane({ kind: 'hub', infoHash: ih, announce: [own], ledgerSync: true, wanted: () => A.multi.wantedWires, syncing: () => A.multi.syncing === true })
  A.hubLane = lane
  const onTorrent = (torrent) => {
    if (!torrent || typeof attach !== 'function') return
    try {
      const detach = attach(torrent, A.multi, { name: A.v03.multi.EXT_NAME_2 || 'mw_chain2', anchorWire: (w) => tm.anchorWire(w), ignoreWire: (w, r) => tm.ignoreWire(w, r), kind: lane.kind })
      if (typeof detach === 'function' && typeof torrent.once === 'function') torrent.once('close', () => { try { detach() } catch (_) { /* gone */ } })
    } catch (err) { A.log('hub lane wires: ' + errMessage(err)) }
  }
  if (lane.torrent) onTorrent(lane.torrent)
  if (typeof lane.addEventListener === 'function') lane.addEventListener('torrent', (e) => onTorrent(e.detail && e.detail.torrent))
  holdOwnLedger(A)
}

/**
 * holdOwnLedger(A, keys?): the member's own page is held in full on the hub lane (ARCHITECTURE 15.8), whichever comes last:
 * the lane, the ledger opening (rows-social D-1: a ledger that opened after the lane was never held, so a post written offline
 * never left) or the sign-in. Review round R 5.3, STALK-3: only the member's own page (the signed pointer's owner is the
 * signed-in key); a page merely viewed is not held, so its id is not broadcast in HAVE. hold() is idempotent.
 */
function holdOwnLedger (A, keys) {
  if (!A.multi || !A.hubLane || !A.hubLedgers || !A.node || A.node === A.followerNode || !A.node.gossip) return
  const k = keys || (A.api && A.api.identity && typeof A.api.identity.keys === 'function' ? A.api.identity.keys() : null)
  if (!k || !k.pub || !A.record || !A.record.signed || A.record.owner !== k.pub) {
    if (k && k.pub && A.record && A.record.signed && !A.heldNote) { A.heldNote = true; A.log('hub lane: this page is not the signed-in key\'s own page, so its ledger is followed, not held (STALK-3)') }
    return
  }
  if (A.heldOwn === A.ledgerId) return
  A.hubLedgers.set(A.ledgerId, A.node)
  try { A.multi.hold(A.ledgerId); A.heldOwn = A.ledgerId; A.log('hub lane: holding this page\'s own ledger in full') } catch (err) { A.log('hub lane hold: ' + errMessage(err)) }
}

/** closeSessions(A): the media and file sessions end when the page goes away (lane media). */
function closeSessions (A) {
  for (const name of ['media', 'files']) {
    const svc = A.api && A.api.service(name)
    if (svc && svc.sessions && typeof svc.sessions.closeAll === 'function') { try { svc.sessions.closeAll() } catch (_) { /* gone */ } }
  }
}

/** downloadUrl(A, url, name): a loader-owned <a download> click (files.save through /_mw/f/, R 2.8.5). */
function downloadUrl (A, url, name) {
  try {
    const a = A.doc.createElement('a')
    a.setAttribute('href', url)
    a.setAttribute('download', name || 'download')
    a.setAttribute('hidden', '')
    const parent = A.doc.body || A.doc.documentElement
    parent.appendChild(a)
    a.click()
    parent.removeChild(a)
    return true
  } catch (_) { return false }
}

/** presentLoaderTooOld(A, ml): the pointer's ml= floor is newer than this loader (SC-6): refuse and offer the update. */
function presentLoaderTooOld (A, ml) {
  A.log('the pointer asks for loader ' + ml + ' or newer; this is ' + A.config.version)
  A.ui.setStatus(STRINGS.genericErrorTitle, 'error')
  A.ui.showError({
    title: 'This site needs a newer version of felinar',
    detail: 'The publisher asks for version ' + ml + ' or newer, and this browser has ' + A.config.version + '. Reload to get the update.',
    actions: [{
      label: STRINGS.reload,
      primary: true,
      onClick: () => {
        requestServiceWorker('mw-shell-check', {}, { proto: A.config.proto, timeoutMs: 10000 }).catch(() => null).then(() => A.win.location.reload())
      }
    }]
  })
}

/**
 * lineageText(A, record) -> the explanation for a record whose lo= is not proven (review round R 5.3, PTR-1): both keys
 * by fingerprint. (A strings.js entry is requested from the strings owner; this text is the fallback.)
 */
async function lineageText (A, record) {
  const [ownerFp, loFp] = await Promise.all([safeFingerprint(A, record.owner), safeFingerprint(A, record.lo)])
  if (STRINGS.lineageUnproven) {
    try { return STRINGS.lineageUnproven({ ownerFp: ownerFp || '?', loFp: loFp || '?' }) } catch (_) { /* fall back */ }
  }
  return 'This link names the site ledger of publisher key ' + (loFp || '?') + ' but is signed by another key, ' + (ownerFp || '?') +
    ', and nothing shows that the first key handed the site over. It is not opened as that site here.'
}

/**
 * presentOwnerChange(A, resolved) -> true when the page must not mount yet. An accepted owner change shows the
 * in-page notice "The owner of this site changed N minutes ago"; a first visit that meets a rotation younger than
 * 24 hours waits (rotationDecision, MF-28).
 */
async function presentOwnerChange (A, r) {
  let d
  // Review round R 5.3 (PTR-5): the pin's owner stands for the previous record when the saved copy is gone, so a returning
  // visitor is never treated as a first visit.
  const prev = r.previousRecord || (r.previousOwner ? { owner: r.previousOwner } : null)
  try { d = r.rotationHold || await rotationDecision({ prev, next: r.record, firstVisit: !!r.firstTime, rotOk: !!r.rotated, now: Date.now() }) } catch (err) {
    A.log('owner change: ' + errMessage(err))
    return false
  }
  if (d.decision === 'delay') {
    const until = d.until ? new Date(d.until).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'later'
    A.ui.setStatus(STRINGS.keyChangedTitle, 'warn')
    A.ui.showError({
      title: STRINGS.keyChangedTitle,
      detail: 'The owner of this site changed its key ' + d.minutesAgo + ' minutes ago. A first visit waits 24 hours after such a change, until ' + until + '.',
      actions: [{ label: STRINGS.retry, primary: true, onClick: () => A.win.location.reload() }]
    })
    return true
  }
  if (d.decision === 'accept' && d.minutesAgo !== null && d.reason !== 'same-owner' && d.reason !== 'rotation-aged') {
    try { Promise.resolve(A.ui.prompt('owner-changed', { minutes: d.minutesAgo })).catch(() => {}) } catch (_) { /* no cards */ }
  }
  return false
}

/**
 * loadDeviceKey(A): this device's non-extractable signing key (MF-30). Pins and key-change refusals are signed with
 * it, so a pin rewritten by code on this origin without the key reads as no pin. A browser that cannot keep the key
 * (iOS DataCloneError) keeps the 0.2.1 unsigned pins (a new key each page view would forget every pin).
 */
async function loadDeviceKey (A) {
  const cache = A.deps.cache
  try {
    let rec = await cache.getKey('device').catch(() => null)
    if (!rec || rec.kind !== 'cryptokey' || !rec.privateKey || !rec.pub) {
      const k = await createDeviceKey()
      await cache.saveKey('device', { kind: 'cryptokey', privateKey: k.privateKey, publicKey: k.publicKey, pub: k.pub })
      rec = await cache.getKey('device')
      if (!rec || !rec.privateKey) throw new Error('the device key did not survive a round trip')
    }
    A.deviceKey = { privateKey: rec.privateKey, publicKey: rec.publicKey, pub: rec.pub }
    A.pinCache = signedPinCache(cache, A.deviceKey, (line) => A.log(line))
  } catch (err) {
    A.deviceKey = null
    A.pinCache = null
    A.log('device key unavailable (' + errMessage(err) + '): pins stay unsigned on this browser')
  }
}

const REFUSED_PREFIX = 'keyRefused:'

/**
 * signedPinCache(cache, deviceKey, log) -> the cache with signed pins and expiring refusals (harden.js signPin,
 * verifyPin, signRefusal, verifyRefusal). A 0.2.1 pin (no signature) is signed once on first read; a pin whose
 * signature fails reads as absent; a 0.2.1 refusal (true) reads as expired; a v0.3 refusal lasts at most 7 days.
 */
export function signedPinCache (cache, dk, log = () => {}) {
  if (!cache || !dk) return cache
  // The cache is a module namespace: in the esbuild bundle its exports are getter-only accessors, so assigning
  // getPin on an object that inherits them throws ("has only a getter") and pins stayed unsigned in every built
  // loader (v0.3 reconciliation; MF-30). Own data properties defined on the new object shadow them instead.
  const wrapped = Object.create(cache)
  const own = (name, fn) => Object.defineProperty(wrapped, name, { value: fn, writable: true, configurable: true, enumerable: true })
  own('getPin', async (scope) => {
    const pin = await cache.getPin(scope)
    if (!pin || !pin.owner) return pin
    if (!pin.signed) {
      try {
        const signed = await signPin(dk, { scope, owner: pin.owner, seq: 0, firstSeen: Number.isSafeInteger(pin.firstSeen) ? pin.firstSeen : null })
        await cache.savePin(scope, pin.owner, Object.assign({}, pin, { signed }))
      } catch (_) { /* the next read tries again */ }
      return pin
    }
    const v = await verifyPin(pin.signed, dk.pub, { scope })
    if (!v.ok || pin.signed.owner !== pin.owner) {
      log('a pin for ' + scope + ' failed its signature (' + (v.reason || 'owner') + '): treated as no pin')
      return null
    }
    return pin
  })
  own('savePin', async (scope, owner, extra = {}) => {
    let signed = null
    try { signed = await signPin(dk, { scope, owner, seq: 0, firstSeen: Number.isSafeInteger(extra.firstSeen) ? extra.firstSeen : null }) } catch (_) { signed = null }
    return cache.savePin(scope, owner, Object.assign({}, extra, { signed }))
  })
  own('getPref', async (key, dflt) => {
    const v = await cache.getPref(key, dflt)
    if (typeof key !== 'string' || !key.startsWith(REFUSED_PREFIX)) return v
    if (v === true) return false
    if (v && typeof v === 'object') {
      const r = await verifyRefusal(v, dk.pub, {})
      return r.ok
    }
    return v
  })
  own('setPref', async (key, value) => {
    if (typeof key === 'string' && key.startsWith(REFUSED_PREFIX) && value === true) {
      const owner = key.slice(-92)
      const scope = key.slice(REFUSED_PREFIX.length, -93)
      try {
        const refusal = await signRefusal(dk, { scope, owner })
        return cache.setPref(key, refusal)
      } catch (_) { return cache.setPref(key, value) }
    }
    return cache.setPref(key, value)
  })
  return wrapped
}

/** storeModeratorKey(A, jwk, pub): a moderator key, non-extractable once imported (MF-27); memory only where it cannot be stored. */
async function storeModeratorKey (A, jwk, pub) {
  const { cache, crypto } = A.deps
  const privateKey = await crypto.importPrivateJwk(jwk, { extractable: false })
  const publicKey = await globalThis.crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])
  const value = { kind: 'cryptokey', privateKey, publicKey, pub }
  try {
    await cache.saveKey('moderator:' + A.ledgerId, value)
    const back = await cache.getKey('moderator:' + A.ledgerId)
    if (!back || !back.privateKey) throw new Error('the key did not survive a round trip')
    A.moderatorMemory = null
  } catch (_) {
    A.moderatorMemory = value
    try { await cache.deleteKey('moderator:' + A.ledgerId) } catch (_e) { /* nothing stored */ }
    A.log('this browser cannot store a non-extractable key: the moderator key is kept for this page view only')
  }
}

/** upgradeModeratorKey(A, record, privateKey): a 0.2.1 moderator JWK stored again as a non-extractable CryptoKey. */
async function upgradeModeratorKey (A, rec, privateKey) {
  const jwk = rec.jwk
  const publicKey = await globalThis.crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])
  await A.deps.cache.saveKey('moderator:' + A.ledgerId, { kind: 'cryptokey', privateKey, publicKey, pub: rec.pub })
  const back = await A.deps.cache.getKey('moderator:' + A.ledgerId)
  if (!back || !back.privateKey) await A.deps.cache.saveKey('moderator:' + A.ledgerId, rec)
  else A.log('moderator key now stored non-extractable')
}

// =====================================================================================================
// v0.3 C2 (lane wire-ui): smart seeding, the carry meter and hand-off labels, dock mode, the keeper tab and calls
// (research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md "SZ" 3.1, 3.3, 3.5). Lane seed-policy's modules decide the budget, lane
// seed-engine's torrent.js enforces it, lane calls' service makes the calls; this block wires them to the page, to
// mw.net and to mw.calls. Every insertion point elsewhere in this file is marked "C2 wire-ui" and listed in
// docs/deviations/wire-ui.md. Counters stay on this device: nothing here is sent anywhere (ARCHITECTURE 8).
// =====================================================================================================

/** networkProofOf(env, prefs, dock) -> 'connection' | 'declared' | 'none': how the network class is known (SZ 3.1.3). */
export function networkProofOf (env, prefs = {}, dock = null) {
  const cls = env && env.networkClass
  if (cls === 'wifi' || cls === 'cellular') return 'connection'
  if ((prefs && prefs.declaredWifi === true) || (dock && dock.on === true && dock.declared === true)) return 'declared'
  return 'none'
}

/**
 * seedEnvOf(env, { prefs, dock, call }) -> the env computePolicy() reads for the seed budget (pure): detectEnvironment()
 * plus networkProof, dock (dock mode is on) and call ({ limited } while a call is connecting or connected, else null).
 */
export function seedEnvOf (env, { prefs = {}, dock = null, call = null } = {}) {
  return Object.assign({}, env || {}, {
    networkProof: networkProofOf(env, prefs, dock),
    dock: !!(dock && dock.on === true),
    call: call && call.active !== false ? { limited: call.limited === true } : null
  })
}

/**
 * seedPrefsOf(prefs, dock) -> the seeding prefs computePolicy() reads (pure): the declarations of this page, which a
 * dock mode started on the person's word ("plugged in, on Wi-Fi") also makes, and whether the seed.ask card was answered.
 */
export function seedPrefsOf (prefs = {}, dock = null) {
  const said = !!(dock && dock.on === true && dock.declared === true)
  return {
    declaredWifi: (prefs && prefs.declaredWifi === true) || said,
    declaredPlugged: (prefs && prefs.declaredPlugged === true) || said,
    seedAsked: !!(prefs && prefs.seedAsked === true)
  }
}

/** staticTurnOf(...candidates) -> the first TURN config with static credentials (R 2.7.8 option a), or null. */
export function staticTurnOf (...candidates) {
  for (const t of candidates) {
    const list = Array.isArray(t) ? t : (t && typeof t === 'object' ? [t] : [])
    const ok = list.filter((x) => x && typeof x === 'object' && x.mode !== 'endpoint' && typeof x.username === 'string' && typeof x.credential === 'string')
    if (ok.length) return ok
  }
  // Option (b), a credential endpoint, is a backend the owner runs: fetching it is not part of C2 (owner decision SZ-5).
  return null
}

/** callPolicyOf(policy) -> { class, metered } for src/calls/service.js (policy classes of src/loader/policy.js). */
export function callPolicyOf (policy) {
  const cls = policy && typeof policy.class === 'string' ? policy.class : 'desktop'
  return { class: cls, metered: cls === 'mobileMetered' }
}

function langOf (A) {
  return (A.win && A.win.navigator && A.win.navigator.language) || 'en'
}

/** batteryManagerOf(nav) -> the BatteryManager (Chromium), or null where the browser has no battery API (iOS, Firefox). */
async function batteryManagerOf (nav) {
  if (!nav || typeof nav.getBattery !== 'function') return null
  try { return (await nav.getBattery()) || null } catch (_) { return null }
}

function keeperActive (A) {
  return A.prefs.keeper === true && !(A.env && A.env.isMobile) && A.prefs.share !== false && !(A.policy && A.policy.hostOnly)
}

async function markSeedAsked (A) {
  A.prefs.seedAsked = true
  try { await A.deps.cache.setPref('seedAsked:' + A.origin, true) } catch (_) { /* this page remembers it */ }
}

/** setupSeeding(A): dock mode (SZ 3.1.4) and the mw.net control (net.seeding, net.dock, net.keep). */
async function setupSeeding (A) {
  const nav = A.win.navigator || null
  A.batteryManager = await batteryManagerOf(nav)
  A.dock = createDock({ nav, doc: A.doc, battery: A.batteryManager, config: A.config })
  A.dock.on('start', () => { recomputePolicy(A); refreshSettings(A) })
  A.dock.on('stop', (st) => {
    recomputePolicy(A)
    refreshSettings(A)
    // Why it ended, unless the person stopped it (SZ 3.1.4: ends on hide, unplug, a low battery or the cap).
    if (st && st.reason && st.reason !== 'user') A.ui.setBanner('dock', seedText('dock.stopped.' + st.reason, langOf(A)), { kind: 'info', dismissible: true })
  })
  A.api.setNet(createNetControl({
    budget: () => (A.policy ? A.policy.seedBudget : null),
    seeding: () => (A.tm ? A.tm.seeding : null),
    meters: () => A.seedMeters || null,
    dock: A.dock,
    keeper: () => keeperActive(A),
    setKeeper: (on) => setKeeper(A, on),
    canKeep: () => (A.prefs.share === false ? 'E_POLICY' : null),
    isMobile: () => !!(A.env && A.env.isMobile),
    follower: () => A.isLeader === false,
    declareNeeded: () => A.batteryManager === null,
    prompt: (kind, data) => A.ui.prompt(kind, data),
    lang: langOf(A),
    dockDefaultMs: A.config.seed && A.config.seed.dockDefaultMs,
    dockCapMs: A.config.seed && A.config.seed.dockCapMs
  }))
}

async function setKeeper (A, on) {
  if (on && A.env && A.env.isMobile) throw Object.assign(new Error('Keep this site is for computers; on a phone keep the screen on instead'), { code: 'E_UNSUPPORTED' })
  if (on && A.prefs.share === false) throw Object.assign(new Error('sharing is off in this browser: turn on "Share with other visitors" first'), { code: 'E_POLICY' })
  A.prefs.keeper = !!on
  try { await A.deps.cache.setPref('keeper:' + A.origin, A.prefs.keeper) } catch (_) { /* this page still keeps it */ }
  refreshSeedUi(A)
  refreshSettings(A)
}

/** toggleDockFromSettings(A): the Settings button, inside the person's click: dock.start() requests the Wake Lock first. */
function toggleDockFromSettings (A) {
  const dock = A.dock
  if (!dock) return
  if (dock.state().on) { dock.stop('user'); return }
  const declared = A.batteryManager === null && A.prefs.declaredWifi === true && A.prefs.declaredPlugged === true
  dock.start({ ms: A.config.seed && A.config.seed.dockDefaultMs, declared }).then((st) => {
    if (st && !st.on && st.reason) A.ui.settings.notify('sharing', seedText('dock.refused.' + st.reason, langOf(A)), 'error')
    else A.ui.settings.notify('sharing', '', 'info')
    refreshSettings(A)
  }, () => {})
}

/** applySeedBudget(A): the current budget to the TorrentManager (lane seed-engine's setSeedBudget), then the bar's lines. */
function applySeedBudget (A) {
  const tm = A.tm
  if (tm && typeof tm.setSeedBudget === 'function' && A.policy) {
    // C2 integrator: the pin's own page (tools/pin.mjs) is infrastructure the owner runs: no member budget there.
    try { tm.setSeedBudget(A.pinPage ? null : (A.policy.seedBudget || null)) } catch (err) { A.log('seed budget: ' + errMessage(err)) }
  }
  refreshSeedUi(A)
}

/** attachSeeding(A, tm): the meters on the per-origin pref store, the budget, and the carry meter's own counts. */
function attachSeeding (A, tm) {
  if (!A.seedMeters) {
    const cache = A.deps && A.deps.cache
    // One writer: only the engine tab of an origin runs a TorrentManager (ARCHITECTURE 5.9).
    A.seedMeters = createSeedMeters({ storage: cache ? { get: (k) => cache.getPref(k, null), set: (k, v) => cache.setPref(k, v) } : null, key: 'seedMeters:' + A.origin })
  }
  if (typeof tm.setSeedMeters === 'function') {
    try { tm.setSeedMeters(A.seedMeters) } catch (err) { A.log('seed meters: ' + errMessage(err)) }
  }
  applySeedBudget(A)
  if (!A.carry) A.carry = { peer: 0, host: 0, senders: new Set(), seq: 0 }
  tm.addEventListener('wire', (e) => noteSiteWire(A, (e && e.detail) || {}))
  tm.addEventListener('evidence', () => scheduleUploads(A))
  if (!A.seedTick) A.seedTick = setInterval(() => seedTick(A), 10000)
}

/** The carry meter counts the site torrent's bytes by source, and the distinct visitors that sent any (SZ 3.1.5). */
function noteSiteWire (A, d) {
  const wire = d.wire
  if (d.kind !== 'site' || !wire || typeof wire.on !== 'function') return
  const c = A.carry
  const web = wire.type === 'webSeed'
  const key = web ? null : (typeof wire.peerId === 'string' && wire.peerId ? wire.peerId : 'wire-' + (++c.seq))
  wire.on('download', (bytes) => {
    const n = Number(bytes)
    if (!(n > 0)) return
    if (web) c.host += n
    else { c.peer += n; c.senders.add(key) }
  })
}

/** trackerSeen(A) -> { n, at }: the site swarm's size as its trackers report it, and when this page first saw that figure. */
function trackerSeen (A) {
  let diag = null
  try { diag = A.tm && typeof A.tm.diagnostics === 'function' ? A.tm.diagnostics() : null } catch (_) { diag = null }
  const sw = diag && diag.swarm
  if (!sw || !sw.reported || typeof sw.others !== 'number') return A.trackerSeen || null
  const n = Math.max(0, sw.others + 1)
  if (!A.trackerSeen || A.trackerSeen.n !== n) A.trackerSeen = { n, at: Number.isFinite(Number(sw.at)) ? Number(sw.at) : Date.now() }
  return A.trackerSeen
}

/** refreshCarry(A): the carry meter after load: this visit's bytes by source (meter.visit) and the tracker report. */
function refreshCarry (A) {
  const lang = langOf(A)
  const c = A.carry
  if (!A.carryVisit && c && !A.fromCache) {
    const m = carryMeter({ peerBytes: c.peer, webseedBytes: c.host, senders: c.senders.size })
    // C2 integrator: the line appears once a visitor carried bytes; "0% of the bytes came from 0 visitors" said nothing and
    // made the expanded bar taller over the site's own top row (e2e E-ID-7: the bar covered the guestbook's Sign in button).
    if (m && m.n > 0) A.carryVisit = meterText(m, lang)
  }
  const tr = trackerSeen(A)
  // C2 integrator: the tracker figure counts this visitor too; it is shown once it counts someone else.
  try { A.ui.setMeter({ visit: A.carryVisit || null, tracker: tr && tr.n >= 2 ? trackerText(tr.n, tr.at, lang) : null }) } catch (_) { /* no UI */ }
}

function monthUsedOf (A) {
  try {
    const s = A.tm ? A.tm.seeding : null
    if (s && s.month) return Number(s.month.used) || 0
  } catch (_) { /* a manager without the getter */ }
  try { return A.seedMeters ? Number(A.seedMeters.monthUsed()) || 0 : 0 } catch (_) { return 0 }
}

function keeperText (A, lang) {
  const b = A.policy && A.policy.seedBudget
  const cap = b && b.month ? b.month.cap : null
  const name = (A.manifest && A.manifest.name) || (A.record && A.record.dn) || null
  const counter = formatBytes(monthUsedOf(A)) + (Number.isFinite(cap) && cap > 0 ? ' / ' + capText(cap, lang) : '')
  return seedText('keeper.on', lang) + ' (' + (name ? String(name).slice(0, 40) + ': ' : '') + counter + ')'
}

/** refreshSeedUi(A): the keeper line, the dim page of dock mode and the month-cap notice (SZ 3.1.4, 3.1.5). */
function refreshSeedUi (A) {
  const ui = A.ui
  if (!ui || typeof ui.setKeeper !== 'function') return
  const lang = langOf(A)
  try {
    ui.setKeeper(keeperActive(A) ? { on: true, text: keeperText(A, lang) } : { on: false })
    const ds = A.dock ? A.dock.state() : null
    ui.setDock(ds && ds.on ? ds : null, { onStop: () => { if (A.dock) A.dock.stop('user') } })
    const b = A.policy && A.policy.seedBudget
    const cap = b && b.month ? b.month.cap : 0
    const keepOrEcho = !!(b && b.lanes && ((b.lanes.K && b.lanes.K.rate > 0) || (b.lanes.E && b.lanes.E.rate > 0)))
    const hit = keepOrEcho && Number.isFinite(cap) && cap > 0 && monthUsedOf(A) >= cap
    if (hit !== !!A.monthHit) {
      A.monthHit = hit
      ui.setBanner('seed-month', hit ? seedText('seed.monthUsed', lang, { cap: capText(cap, lang) }) : null, { kind: 'info', dismissible: true })
    }
  } catch (err) { A.log('seeding lines: ' + errMessage(err)) }
}

function seedModel (A) {
  const mobile = !!(A.env && A.env.isMobile)
  const ds = A.dock ? A.dock.state() : { on: false }
  return {
    // The browser cannot tell: no network type (iOS, Firefox) or no battery API; the person's word then counts.
    declare: mobile ? { wifi: !!(A.env && A.env.networkClass === 'unknown'), plugged: A.batteryManager === null } : null,
    wifi: A.prefs.declaredWifi === true,
    plugged: A.prefs.declaredPlugged === true,
    keeper: { shown: !mobile, on: A.prefs.keeper === true, disabled: A.prefs.share === false || !!(A.policy && A.policy.hostOnly) },
    dock: { shown: mobile, supported: !!(A.dock && A.dock.supported()), on: !!ds.on },
    line: keeperActive(A) ? keeperText(A, langOf(A)) : null
  }
}

function seedingInfo (A) {
  const b = A.policy && A.policy.seedBudget
  const c = A.carry
  let lanes = null
  try { lanes = A.tm && A.tm.seeding ? A.tm.seeding.lanes : null } catch (_) { lanes = null }
  return {
    row: b ? b.row : null,
    ask: b ? b.ask : null,
    rates: b ? { H: b.lanes.H.rate, K: b.lanes.K.rate, E: b.lanes.E.rate } : null,
    lanes,
    monthUsed: monthUsedOf(A),
    dock: A.dock ? A.dock.state() : null,
    keeper: keeperActive(A),
    call: A.callYield ? Object.assign({}, A.callYield) : null,
    carry: c ? { peer: c.peer, host: c.host, senders: c.senders.size } : null
  }
}

/** seedTick(A) every 10 s in the engine tab: the month cap, the keeper counter, the tracker figure, upload labels. */
function seedTick (A) {
  if (A.destroyed) return
  refreshSeedUi(A)
  pinTick(A) // C2 integrator: _mw.cfg.pin changes and the heartbeat (at most every 10 minutes, PinWire's own interval)
  if (A.mount) refreshCarry(A)
  if (A.uploads && A.uploads.size) scheduleUploads(A)
}

// ---- the loader's own upload card: hand-off states and availability labels of own uploads (SZ 3.1.5) ----

function trackUpload (A, kind, key) {
  if (!A.uploads) A.uploads = new Map()
  const id = kind + ':' + key
  if (!A.uploads.has(id)) A.uploads.set(id, { kind, key, since: Date.now(), doneAt: null, row: null })
  while (A.uploads.size > 4) A.uploads.delete(A.uploads.keys().next().value)
}

function scheduleUploads (A) {
  if (!A.uploads || !A.uploads.size || A.uploadsTimer) return
  A.uploadsTimer = setTimeout(() => { A.uploadsTimer = null; refreshUploads(A).catch((err) => A.log('upload card: ' + errMessage(err))) }, 1000)
}

async function refreshUploads (A) {
  const lang = langOf(A)
  const ctx = { activation: false, tab: 'leader' }
  const list = async (svc, method, params) => {
    const s = A.api.service(svc)
    const fn = s && s.methods ? s.methods[method] : null
    if (typeof fn !== 'function') return []
    try { const r = await fn(params, ctx); return Array.isArray(r) ? r : [] } catch (_) { return [] }
  }
  const kinds = new Set(Array.from(A.uploads.values()).map((u) => u.kind))
  const files = kinds.has('files') ? await list('files', 'files.list', {}) : []
  const media = kinds.has('media') ? await list('media', 'media.list', { from: 'mine' }) : []
  const now = Date.now()
  const rows = []
  for (const [id, u] of Array.from(A.uploads)) {
    const item = u.kind === 'files' ? files.find((f) => f && f.ref === u.key) : media.find((m) => m && m.id === u.key)
    if (item && typeof item.label === 'string') {
      const state = item.handoff && item.handoff.state
      if ((state === 'kept' || state === 'sent' || item.label === 'avail.keptBySite') && !u.doneAt) u.doneAt = now
      u.row = { key: id, name: item.name || null, text: labelText(item.label, item.labelParams, lang) }
    }
    // A kept or delivered item stays on the card for a minute; one that never shows a label goes after 30 minutes.
    if ((u.doneAt && now - u.doneAt > 60000) || now - u.since > 1800000) { A.uploads.delete(id); continue }
    if (u.row && u.row.text) rows.push(u.row)
  }
  // Review round R 5.3 (CONF-1): the pin key counts only from an entry written with owner standing (ARCH 15.18, 15.19).
  try { A.ui.setUploads(rows, { note: rows.length && !pinKeyOf(A) ? seedText('avail.noPin', lang) : null }) } catch (_) { /* no UI */ }
  if (A.uploads.size && Array.from(A.uploads.values()).some((u) => !u.doneAt)) {
    if (!A.uploadsPoll) A.uploadsPoll = setTimeout(() => { A.uploadsPoll = null; scheduleUploads(A) }, 2000)
  }
}

/**
 * maybeAskSeed(A): the seed.ask card at the moment of value (the person just posted something, S1 D2: "asked once,
 * when the person posts or keeps something"), only where the budget says so: row 2 with SZ-1 on and not yet answered.
 */
async function maybeAskSeed (A) {
  const b = A.policy && A.policy.seedBudget
  if (!b || b.ask !== 'consent' || A.seedAskOpen || A.prefs.seedAsked) return
  A.seedAskOpen = true
  const lang = langOf(A)
  try {
    const ok = await A.ui.prompt('confirm', { title: '', text: seedText('seed.ask', lang, { cap: capText(b.month && b.month.cap, lang) }) })
    if (ok === true) {
      A.prefs.shareOnNetwork = true
      try { await A.deps.cache.setPref('shareOnNetwork:' + A.origin, true) } catch (_) { /* this page shares */ }
    }
    await markSeedAsked(A)
    recomputePolicy(A)
    updateSubline(A)
    refreshSettings(A)
  } catch (err) {
    A.log('seed.ask: ' + errMessage(err))
  } finally {
    A.seedAskOpen = false
  }
}

function onSeedPush (A, event, data) {
  if (event !== 'files' && event !== 'media') return
  const d = data && typeof data === 'object' ? data : {}
  if (d.type === 'shared') {
    const x = d.data && typeof d.data === 'object' ? d.data : {}
    // Own uploads: files 'shared' { ref, listed }; media 'shared' { id, kind: 'own' } (a share to people has `to`).
    if (event === 'files' && typeof x.ref === 'string') trackUpload(A, 'files', x.ref)
    if (event === 'media' && typeof x.id === 'string' && x.kind === 'own') trackUpload(A, 'media', x.id)
    if ((event === 'files' && x.ref) || (event === 'media' && x.kind === 'own')) maybeAskSeed(A)
  }
  if (A.uploads && A.uploads.size) scheduleUploads(A)
}

/** afterServices(A): the call panel on the calls service, and the upload card and seed.ask moment on the services' pushes. */
function afterServices (A) {
  const calls = A.api.service('calls')
  if (calls && A.callUi) A.callUi.attach(calls)
  if (!A.offSeedPush) A.offSeedPush = A.api.addPushListener((event, data) => onSeedPush(A, event, data))
}

/** callDeps(A): what mountV03Services hands the calls service (SZ 3.5), beside the chat service's SIG seam. */
function callDeps (A) {
  const nav = A.win.navigator || {}
  // The calls connect with the browser's own RTCPeerConnection, not the offer-timeout wrapper WebTorrent gets (B7).
  const R = A.webrtc ? A.win.RTCPeerConnection : null
  const base = R && R.__mwOfferTimeout ? Object.getPrototypeOf(R) : R
  return {
    mode: sdkMode(A.mode.mode),
    policy: () => callPolicyOf(A.policy),
    // The site's own STUN servers (MF-44; /.mw/site.json, written by publish --stun); never a shared default.
    stun: () => (A.routing && Array.isArray(A.routing.stun) ? A.routing.stun.slice(0, 4) : []),
    turn: () => staticTurnOf((A.api.cfg() || {}).turn, A.routing && A.routing.turn),
    // "Same local network" and "Hide my IP from people I call" have no switch in C2 (no strings yet): both off unless this
    // page's window.__mwShell.setCallPrefs set them (C2 integrator: the hook calls' e2e needs, page only).
    callPrefs: () => ({ sameLan: !!(A.callPrefs && A.callPrefs.sameLan === true), hideIp: !!(A.callPrefs && A.callPrefs.hideIp === true) }),
    RTCPeerConnection: typeof base === 'function' ? base : null,
    mediaDevices: nav.mediaDevices || null,
    wakeLock: nav.wakeLock || null,
    mediaSession: nav.mediaSession || null,
    callPrompt: (kind, data) => (A.callUi ? A.callUi.prompt(kind, data) : A.api.prompt(kind, data)),
    onSeedYield: (st) => onCallYield(A, st)
  }
}

/** onCallYield(A, state): the calls service's yield (SZ 3.1.3 row 7): the budget follows the call. */
function onCallYield (A, st) {
  A.callYield = st && st.active ? { active: true, limited: st.limited === true, video: st.video === true, connections: Number(st.connections) || 0 } : null
  if (A.record) recomputePolicy(A)
}

function callsVisible (A, visible) {
  const c = A.api && A.api.service('calls')
  if (c && typeof c.setVisible === 'function') { try { c.setVisible(!!visible) } catch (_) { /* a closed service */ } }
}

function callsNetwork (A) {
  const c = A.api && A.api.service('calls')
  if (c && typeof c.setNetwork === 'function') { try { c.setNetwork() } catch (_) { /* a closed service */ } }
}

function flushSeedMeters (A) {
  try { if (A.seedMeters) A.seedMeters.flush() } catch (_) { /* the month record stays in memory */ }
}

// ---- C2 integrator: mw_pin1 and the pin's own page (SZ 3.1.6; lane seed-engine's requests O1 and O2 to lane wire-ui) ----

/**
 * pinServiceDeps(A) -> what the files and media services read for availability labels (SZ 3.1.5): owner (the pointer's
 * ledger owner key, SZ-6), pinEvidence(ih, now) from the PinWire (E4) and evidenceInputs(ih) from the TorrentManager.
 */
function pinServiceDeps (A) {
  return {
    owner: () => (A.record && A.record.signed ? (A.record.lo || A.record.owner || null) : null),
    pinEvidence: (ih, now) => (A.pinWire ? A.pinWire.evidence(ih, now) : null),
    evidenceInputs: (ih) => (A.tm && typeof A.tm.evidenceInputs === 'function' ? A.tm.evidenceInputs(ih) : null)
  }
}

/**
 * pinKeyOf(A) -> _mw.cfg.pin, the pin node's public key the owner named in the ledger, or null: only from a _mw.cfg written
 * with owner standing (api.js ownerCfgPin; a moderator's _mw.cfg names no pin key).
 */
function pinKeyOf (A) {
  return ownerCfgPin(A.node)
}

/**
 * attachPinWire(A, tm): the verifier role of mw_pin1 on the site and file wires of this page (a chal per wire, the pin's
 * hello checked against _mw.cfg.pin, receipts recorded: "Kept by the site"). The responder role and window.__mwPinHost
 * exist only in the pin's own page, where tools/pin.mjs exposes window.__mwPinCall in the top frame and its 'pin.key'
 * equals _mw.cfg.pin; the key itself never enters a page (it signs through the bridge).
 */
function attachPinWire (A, tm) {
  if (A.pinWire || !tm || typeof tm.registerWireExtension !== 'function') return A.pinWire || null
  try {
    A.pinWire = createPinWire({ tm, pinKey: () => pinKeyOf(A), win: A.win, site: A.ledgerId || null, log: (line) => A.log('pin: ' + line) }).attach()
  } catch (err) {
    A.log('pin wire: ' + errMessage(err))
    A.pinWire = null
    return null
  }
  A.pinKeySeen = pinKeyOf(A)
  A.pinWire.on('receipt', () => scheduleUploads(A))
  A.pinWire.on('heartbeat', () => scheduleUploads(A))
  A.pinWire.on('pin-wire', () => scheduleUploads(A))
  A.pinWire.on('warning', (w) => { if (w && w.code) A.log('pin: ' + w.code + (w.reason ? ' (' + w.reason + ')' : '')) })
  A.pinWire.ready.then(() => setupPinPage(A), () => {})
  // The ledger, and with it _mw.cfg.pin, usually arrives a moment after the manager starts (the cs= snapshot, then gossip):
  // look each second for the first minute, then at the seed tick's pace (the pin's own page answers chal only from then on).
  let early = 0
  const timer = setInterval(() => {
    if (A.destroyed || A.pinPage || ++early > 60 || pinKeyOf(A)) { clearInterval(timer); pinTick(A); return }
  }, 1000)
  return A.pinWire
}

/** setupPinPage(A): this page is the site's pin node: window.__mwPinHost for tools/pin.mjs, and no member budget. */
function setupPinPage (A) {
  const pw = A.pinWire
  if (!pw || !pw.responder || A.pinPage || !A.tm) return
  let backend = null
  const be = () => backend || (backend = idbBackend())
  try {
    const host = createPinPageHost({
      tm: A.tm,
      // Pinned files stay in this browser profile's IndexedDB, one store per item, across reloads (R 2.8.6: never in tab memory).
      storeClass: (ih) => IdbChunkStore.factory({ name: 'pin-' + ih, backend: be() }),
      announce: () => (A.record && Array.isArray(A.record.tr) ? A.record.tr.slice() : []),
      // The item's .torrent beside its bytes, so a restarted pin seeds it with nobody else online (rows-media D-2).
      torrentFiles: { get: (ih) => be().get('pin-torrent-' + ih, 0), put: (ih, bytes) => be().put('pin-torrent-' + ih, 0, bytes) },
      // An item this site's ledger denies (_deny/) is never joined (review round R 5.3, MAL53-3).
      isDenied: denyChecker(() => (A.node && A.node !== A.followerNode ? A.node : null)),
      // After a later deny makes the host leave a held item, its bytes and its .torrent leave this profile too (R4-a, MAL53-3 O-3).
      discard: async (ih) => { await be().deleteName('pin-' + ih); await be().deleteName('pin-torrent-' + ih) }
    })
    // Same-origin site code on the pinned page can reach this object too. It starts only what the node itself lists as pinned and
    // not paused by the month cap ('file.pinned' over tools/pin.mjs's bridge), so a page cannot make the pin node join a swarm a
    // moderator never approved.
    const pinnedNow = async (ih) => {
      let list = []
      try { list = await A.win.__mwPinCall('file.pinned') } catch (_) { list = [] }
      return Array.isArray(list) && list.some((m) => m && m.ih === ih && m.paused !== true)
    }
    A.win.__mwPinHost = Object.freeze({
      async start (meta = {}) {
        const ih = meta && typeof meta.ih === 'string' ? meta.ih.toLowerCase() : ''
        if (!(await pinnedNow(ih))) return 'not-pinned'
        return host.start(meta)
      },
      stop: (ih) => host.stop(ih),
      status: () => host.status()
    })
  } catch (err) {
    A.log('pin page: ' + errMessage(err))
    return
  }
  A.pinPage = true
  applySeedBudget(A)
  A.log('pin: this page is the site\'s pin node (mw_pin1 responder; window.__mwPinHost for tools/pin.mjs)')
}

/** wsBaseOf(A) -> the first web seed base of the pointer (where the owner publishes pin-status.json), or null. */
function wsBaseOf (A) {
  const ws = A.record && Array.isArray(A.record.ws) ? A.record.ws : []
  const origin = A.origin || (A.win && A.win.location && A.win.location.origin) || null
  // Review round R 5.3 (PTR-8): only this origin or https on a public host.
  for (const w of ws) if (typeof w === 'string' && /^https?:\/\//.test(w) && isPublicHttpsUrl(w, { origin })) return w
  return null
}

/** pinTick(A): a changed _mw.cfg.pin re-checks the responder and the wires; the heartbeat is read at PinWire's pace. */
function pinTick (A) {
  const pw = A.pinWire
  if (!pw || A.destroyed) return
  const key = pinKeyOf(A)
  if (key !== A.pinKeySeen) {
    A.pinKeySeen = key
    pw.refresh().then(() => setupPinPage(A), () => {})
  }
  const base = wsBaseOf(A)
  if (key && base && !A.pinPage) pw.fetchHeartbeat(base).then(() => scheduleUploads(A), () => {})
}

// ---- C2 doors (research/v03/S4-doors.md D3 to D6) ------------------------------------------------------------------------------
// The site lives at its key; domains are doors. Insertion points elsewhere in this file are marked "C2 doors". Nothing here
// navigates by itself: another door opens only from the visitor's click (a banner button, a link in the Doors section, the "Open a
// link" box), the door view never uses this origin's worker or meta.current, and bytes from another door are used only after their
// hash checks (a .torrent by its infohash here, every piece in torrent.js).

const DOOR_REPROBE_MS = 5 * 60 * 1000

/**
 * guardActivationWatch(tracker): the door view's frame has an opaque origin, so its window is cross-origin to this page and reading
 * addEventListener on it throws a SecurityError inside ActivationTracker.watch (the Bridge calls it on attach and on every frame load).
 * This tracker's watch() then answers "nothing to watch" instead; activation still comes from navigator.userActivation, which a
 * click in the frame gives to this page too. Request to lane wire-ui: the same try/catch in ActivationTracker.watch itself.
 */
function guardActivationWatch (tracker) {
  if (!tracker || tracker.__doorGuard || typeof tracker.watch !== 'function') return
  const watch = tracker.watch.bind(tracker)
  tracker.watch = (target) => { try { return watch(target) } catch (_) { return () => {} } }
  tracker.__doorGuard = true
}

/** consentModeOf(A): the mode consent.js keys the stored choice by. A door keeps one choice per site, as the shared demo hub does. */
function consentModeOf (A) {
  const m = A.mode && A.mode.mode
  return m === 'door' ? 'hub-shared' : m
}

/**
 * doorCspReload(A) → true when the page reloads. The door view's sandboxed frame inherits this page's policy, which must allow the
 * site's inline and blob: scripts: the door page reloads once into the limited-mode policy (render.js requestDegradedReload, reason
 * 'door'; boot.js then starts it degraded for this tab). Any other page of this origin that inherited that flag in this tab clears
 * it and reloads once into the normal mode, so a door visit never leaves the origin's own site in limited mode.
 */
function doorCspReload (A) {
  let flag = null
  try { flag = A.win.sessionStorage ? A.win.sessionStorage.getItem(DEGRADED_RELOAD_KEY) : null } catch (_) { flag = null }
  if (A.mode.mode === 'door') {
    if (A.boot && A.boot.cspKind === 'degraded') return false
    if (requestDegradedReload({ win: A.win, reason: 'door' })) {
      A.log('door page: reloading once under the limited-mode policy')
      A.ui.setStatus(STRINGS.starting)
      return true
    }
    A.log('door page under the normal policy (the one-time reload was not possible): the site\'s scripts may be blocked in the door view')
    return false
  }
  if (flag === 'door' && A.boot && A.boot.forcedDegraded) {
    try { A.win.sessionStorage.removeItem(DEGRADED_RELOAD_KEY) } catch (_) { return false }
    A.log('this page inherited the door page\'s limited mode in this tab: reloading once in the normal mode')
    try { A.win.location.reload() } catch (_) { return false }
    return true
  }
  return false
}

/**
 * pastedFragment(text) → the fragment /_mw/open.html opens for what a visitor pasted: a light link, a web+felinar: link, a hub link
 * (https://<hub>/#...), a bare record (v=mw1;...), a magnet link or btih:<hex>; null when it names no site.
 */
export function pastedFragment (text) {
  const s = typeof text === 'string' ? text.trim() : ''
  if (!s) return null
  let frag = null
  const p = parseLightLink(s)
  if (p.ok) {
    try {
      frag = formatLightLink({ record: p.record, genesis: p.genesis ? p.genesis.replace(/^mwgen=/, '') : null, hints: p.hints }).slice(FELINAR_SCHEME.length)
    } catch (_) { frag = null }
  } else if (/^(v=mw1|magnet:\?|btih:)/i.test(s)) {
    frag = /^v=/i.test(s) ? encodeURIComponent(s) : s
  }
  if (!frag) return null
  return parseFragment('#' + frag, '') ? frag : null
}

/**
 * sharedFragment(search) → the fragment for a link that arrived through the door manifest's share target (GET ?mw=<url> or
 * ?mwtext=<text that holds a link>), or null. The page then opens that fragment, which shows the gate first (C3): sharing a link
 * never loads anything by itself.
 */
export function sharedFragment (search) {
  let params
  try { params = new URLSearchParams(search || '') } catch (_) { return null }
  for (const name of ['mw', 'mwtext']) {
    const v = params.get(name)
    if (!v) continue
    const direct = pastedFragment(v)
    if (direct) return direct
    const m = /(web\+felinar:\S+|https?:\/\/\S+)/i.exec(v)
    if (m) {
      const found = pastedFragment(m[1])
      if (found) return found
    }
  }
  return null
}

/** runDoorPaste(A): the door page without a link: the "Open a link" box (S4 D6). The page it opens shows the gate (C3). */
function runDoorPaste (A) {
  const shared = sharedFragment(A.win.location.search)
  if (shared) {
    try {
      A.win.location.replace(DOOR_PAGE_PATH + '#' + shared)
      return A
    } catch (_) { /* fall through to the box */ }
  }
  const lang = langOf(A)
  A.ui.setStatus(doorText('door.paste.title', lang))
  A.ui.showLinkPaste({
    lang,
    onOpen: (text) => {
      const frag = pastedFragment(text)
      if (!frag) return false
      try {
        A.win.location.hash = frag
        A.win.location.reload()
      } catch (_) { return false }
      return true
    }
  })
  return A
}

/** setupDoors(A): the health memory of doors (pref DOOR_HEALTH_PREF), in every mode that shows a site. */
async function setupDoors (A) {
  if (A.doorHealth || !A.deps || !A.deps.cache) return
  const cache = A.deps.cache
  A.doorHealth = createDoorHealth({
    load: () => cache.getPref(DOOR_HEALTH_PREF, null),
    save: (m) => cache.setPref(DOOR_HEALTH_PREF, m)
  })
  await A.doorHealth.ready
}

/** loadDoorMemory(A): what this origin remembers for this ledger: the door that served its .torrent last, and the accepted _doors list. */
async function loadDoorMemory (A) {
  if (!A.doorHealth || !A.ledgerId) return
  const get = async (k) => { try { return await A.deps.cache.getPref(k, null) } catch (_) { return null } }
  const last = await get(DOOR_LAST_GOOD_PREF + A.ledgerId)
  A.doorLastGood = typeof last === 'string' ? last : null
  const acc = await get(DOOR_LEDGER_PREF + A.ledgerId)
  A.ledgerDoorsAccepted = acc && typeof acc === 'object' && Array.isArray(acc.hosts) ? acc : null
  A.ledgerDoors = A.ledgerDoorsAccepted ? { hosts: A.ledgerDoorsAccepted.hosts.slice(), reason: 'stored', pending: false } : null
}

/** isPortable(A): the record was verified for the hub scope btih:<hex>, so it verifies on every door (a page tag does not). */
function isPortable (A) {
  return typeof A.scope === 'string' && A.scope.indexOf('btih:') === 0
}

function doorCandidatesOf (A) {
  const host = A.win.location.host
  return doorCandidates({
    current: host,
    lastGood: A.doorLastGood || null,
    record: A.record || null,
    ledgerDoors: A.ledgerDoors && Array.isArray(A.ledgerDoors.hosts) ? A.ledgerDoors.hosts : [],
    hints: (A.mode && A.mode.fragment && A.mode.fragment.hints) || [],
    pageHost: host
  })
}

/** lightFragment(A, hints) → the fragment of a light link for this site (its record, the link's genesis, the given hints), or null. */
function lightFragment (A, hints = []) {
  if (!isPortable(A)) return null
  const text = A.resolved && typeof A.resolved.raw === 'string' && A.resolved.raw.trim() ? A.resolved.raw.trim() : null
  if (!text) return null
  const fr = A.mode && A.mode.fragment
  try {
    return formatLightLink({ record: text, genesis: fr && fr.genesisText ? fr.genesisText : null, hints }).slice(FELINAR_SCHEME.length)
  } catch (_) { return null }
}

/** doorShareLink(A, candidates) → "Copy link with doors": this door's light link with the doors the record does not sign as hints. */
function doorShareLink (A, candidates) {
  if (!isPortable(A)) return null
  const host = A.win.location.host
  // Review round R 5.3 (PTR-14): the link's own hints are not passed on (only doors the ledger lists or this device used).
  const hints = (candidates || []).filter((c) => c.kind === 'ledger' || c.kind === 'last-good').map((c) => c.host).filter((h) => hintAllowed(h, { pageHost: host })).slice(0, 4)
  const frag = lightFragment(A, hints)
  return frag ? A.origin + DOOR_PAGE_PATH + '#' + frag : null
}

/** showDoorViewBanner(A): the door view's line (S4 D4) with buttons to open the site at its own addresses (org=). */
function showDoorViewBanner (A) {
  const lang = langOf(A)
  const actions = []
  const orgs = A.record && Array.isArray(A.record.org) ? A.record.org : []
  for (const o of orgs.slice(0, 3)) {
    let host = null
    try { host = new URL(o).host } catch (_) { host = null }
    if (!host) continue
    actions.push({ label: doorText('door.openAt', lang, { host }), onClick: () => { try { A.win.location.assign(o + '/') } catch (_) { /* ignore */ } } })
  }
  A.ui.setBanner('door-view', doorText('door.view', lang) + ' ' + doorText('door.viewIdentity', lang), { kind: 'info', actions })
}

/** refreshDoors(A): the Doors section of Settings from the candidates and the health memory. */
function refreshDoors (A) {
  if (!A.doorHealth || !A.ui || typeof A.ui.setDoors !== 'function') return
  const cands = doorCandidatesOf(A)
  A.doorCandidates = cands
  const model = doorsPanelModel({ candidates: cands, health: A.doorHealth })
  const portable = isPortable(A)
  const frag = portable ? lightFragment(A, (A.mode.fragment && A.mode.fragment.hints) || []) : null
  for (const kind of ['owner', 'guest', 'ledger', 'hint']) {
    for (const d of model[kind]) d.url = doorLinkFor(cands.find((c) => c.host === d.host), { fragment: frag, portable })
  }
  model.shown = !!A.btih
  model.link = doorShareLink(A, cands)
  model.copied = typeof A.doorCopied === 'boolean' ? A.doorCopied : null
  model.build = { version: A.config.version, id: A.doorBuildId || null }
  try { A.ui.setDoors(model) } catch (err) { A.log('doors panel: ' + errMessage(err)) }
}

/**
 * probeThisDoor(A, reason): this address's /_mw/door.json from the network (the worker passes it through, the HTTP cache is skipped).
 * On a failure the "not answering" banner offers the other doors; on success it goes. After 'load' always, otherwise at most every
 * 5 minutes after a good answer.
 */
async function probeThisDoor (A, reason) {
  if (!A.doorHealth || A.destroyed || A.doorProbing || !A.btih) return
  const host = A.win.location.host
  const h = A.doorHealth.get(host)
  if (reason !== 'load' && !A.doorDown && h && h.ok && Date.now() - h.ok < DOOR_REPROBE_MS) return
  A.doorProbing = true
  try {
    const fetchFn = typeof A.win.fetch === 'function' ? A.win.fetch.bind(A.win) : undefined
    const r = await probeDoor(A.origin, { fetch: fetchFn, sameOrigin: true, timeoutMs: DOOR_TIMING.firstByteMs })
    A.doorProbe = { state: r.state, ms: r.ms, at: Date.now(), reason: r.reason }
    if (r.buildId) A.doorBuildId = r.buildId
    if (r.json) A.ownDoorJson = r.json // this door's own list: other doors are compared with it ('other-build')
    if (r.state === 'up' || r.state === 'other-build' || r.state === 'opaque') {
      A.doorHealth.ok(host, { state: r.state, buildId: r.buildId })
      if (A.doorDown) { A.doorDown = false; A.doorBanner = null; A.ui.setBanner('doors', null) }
    } else {
      A.doorHealth.fail(host, r.reason || r.state)
      A.doorDown = true
      A.log('this address did not answer as a door (' + r.state + (r.reason ? ', ' + r.reason : '') + ')')
      await showNotAnswering(A)
    }
  } catch (err) {
    A.log('door probe: ' + errMessage(err))
  } finally {
    A.doorProbing = false
    refreshDoors(A)
  }
}

/** showNotAnswering(A): the banner of S4 D5, with up to three doors that answered first (each probed, 250 ms apart). */
/** Door kinds the owner signed or accepted (org= owner and guest doors, the ledger's _doors): "The owner lists". */
const OWNER_DOOR_KINDS = new Set(['owner', 'guest', 'ledger'])

/**
 * notAnsweringModel(offer, lang, win) → { text, actions } (review round R 5.3, PTR-14): only doors the owner signed or
 * accepted go in "The owner lists"; the last good door and the link's hints are named apart ("The link names"), and
 * opening a hint asks first, naming its host (it came from whoever wrote the link).
 */
export function notAnsweringModel (offer, lang = 'en', win = null) {
  const owned = offer.filter((x) => OWNER_DOOR_KINDS.has(x.c.kind))
  const other = offer.filter((x) => !OWNER_DOOR_KINDS.has(x.c.kind))
  const hosts = (list) => list.map((x) => x.c.host).join(', ')
  let text
  if (!offer.length) text = doorText('door.notAnsweringNone', lang)
  else if (!owned.length) text = doorText('door.notAnsweringHint', lang, { hosts: hosts(other) })
  else {
    text = doorText('door.notAnswering', lang, { hosts: hosts(owned) })
    if (other.length) text += ' ' + (doorText('door.notAnsweringAlso', lang, { hosts: hosts(other) }) || ('Not from the owner: ' + hosts(other) + '.'))
  }
  const go = (c, url) => () => {
    if (c.kind === 'hint') {
      const ask = doorText('door.confirmHint', lang, { host: c.host }) || ('Open ' + c.host + '? This address came with the link, not from the site\'s owner.')
      try { if (win && typeof win.confirm === 'function' && !win.confirm(ask)) return } catch (_) { return }
    }
    try { win.location.assign(url) } catch (_) { /* ignore */ }
  }
  const actions = owned.concat(other).map(({ c, url }) => ({ label: doorText('door.openAt', lang, { host: c.host }), onClick: go(c, url) }))
  return { text, actions }
}

async function showNotAnswering (A) {
  const lang = langOf(A)
  const cands = doorCandidatesOf(A)
  A.doorCandidates = cands
  const fetchFn = typeof A.win.fetch === 'function' ? A.win.fetch.bind(A.win) : undefined
  const others = A.doorHealth.order(cands.filter((c) => c.kind !== 'current')).slice(0, DOOR_TIMING.inFlight)
  await Promise.all(others.map((c, i) => new Promise((resolve) => setTimeout(resolve, i * DOOR_TIMING.staggerMs))
    .then(() => probeDoor(c.origin, { fetch: fetchFn, timeoutMs: DOOR_TIMING.firstByteMs, own: A.ownDoorJson || null }))
    .then((p) => {
      if (p.state === 'down' || p.state === 'bad') A.doorHealth.fail(c.host, p.reason || p.state)
      else A.doorHealth.ok(c.host, { state: p.state, buildId: p.buildId })
    })
    .catch(() => {})))
  let model = doorsBannerModel({ candidates: cands, health: A.doorHealth })
  if (!model.hosts.length) model = doorsBannerModel({ candidates: cands, health: null }) // nothing answered: still name them
  const portable = isPortable(A)
  const frag = portable ? lightFragment(A, (A.mode.fragment && A.mode.fragment.hints) || []) : null
  const offer = model.hosts.map((c) => ({ c, url: doorLinkFor(c, { fragment: frag, portable }) })).filter((x) => x.url)
  const { text, actions } = notAnsweringModel(offer, lang, A.win)
  A.ui.setBanner('doors', text, { kind: 'warn', actions })
  A.doorBanner = { hosts: offer.map((x) => x.c.host), at: Date.now() }
}

/**
 * doorDownloadPlan(A, signal) → { record, torrentFile } | null (door mode only). The .torrent: the record's own xs= first, then each
 * door's /_mw/t/<btih>.torrent, raced with fetchFirst (250 ms apart, 3 in flight, 4 s to the first byte, 12 s a door) and kept only
 * when it hashes to the record's btih; the door it came from becomes the last good door. Web seeds: up to 3 doors not in back-off
 * join the record's ws= (torrent.js probes them and checks every piece).
 */
async function doorDownloadPlan (A, signal) {
  if (!A.mode || A.mode.mode !== 'door' || !A.record || !A.doorHealth) return null
  // Only doors that serve this site are asked for its bytes (doors.js byteDoors): a guest or hinted door may be loader-only, and
  // a request for the .torrent or a web seed would tell it which site the visitor opens (code review v0.3, conformance).
  const base = A.win.location.href
  const cands = byteDoors(A.doorHealth.order(doorCandidatesOf(A)), { record: A.record, base })
  const btih = A.record.btih
  const hostOf = (u) => { try { return new URL(u).host } catch (_) { return null } }
  const known = new Set(cands.map((c) => c.host))
  let torrentFile = null
  const urls = xsUrls(A.record, base).concat(doorTorrentUrls(cands, btih))
  if (urls.length) {
    const fetchFn = typeof A.win.fetch === 'function' ? A.win.fetch.bind(A.win) : undefined
    const r = await fetchFirst(urls, {
      fetch: fetchFn,
      signal,
      verify: async (bytes) => { try { return await A.deps.verify.verifyInfoHash(bytes, btih) } catch (_) { return false } },
      onResult: (x) => {
        const host = hostOf(x.url)
        if (!host || !known.has(host)) return
        if (x.ok) A.doorHealth.ok(host, { state: 'up' })
        else if (x.reason === 'hash' || x.reason === 'first-byte' || x.reason === 'timeout' || /fetch|network|load/i.test(String(x.reason))) A.doorHealth.fail(host, x.reason)
      }
    })
    if (r.ok) {
      torrentFile = r.bytes
      A.doorTorrentFrom = r.url
      const host = hostOf(r.url)
      if (host && known.has(host)) {
        A.doorLastGood = host
        try { await A.deps.cache.setPref(DOOR_LAST_GOOD_PREF + A.ledgerId, host) } catch (_) { /* best effort */ }
      }
      A.log('doors: .torrent from ' + r.url)
    } else if (!r.aborted) {
      A.log('doors: no door had the .torrent of ' + btih + ' (' + r.results.map((x) => (hostOf(x.url) || '?') + ' ' + x.reason).join(', ') + '); peers may still have it')
    }
  }
  const extra = doorWebseeds(cands, { health: A.doorHealth, exclude: webseedBases(A.record, base) })
  if (extra.length) A.log('doors: web seeds ' + extra.join(', '))
  const record = extra.length ? Object.assign({}, A.record, { ws: (Array.isArray(A.record.ws) ? A.record.ws : []).concat(extra) }) : A.record
  return { record, torrentFile }
}

/** mountDoorFrame(A, container, path, handlers): the door view with the renderer and the SDK from this door (its worker or host). */
async function mountDoorFrame (A, container, path, handlers) {
  const fetchFn = typeof A.win.fetch === 'function' ? A.win.fetch.bind(A.win) : (typeof fetch === 'function' ? fetch : null)
  let frameScript = null
  let sdk = null
  try {
    const res = fetchFn ? await fetchFn(DOOR_FRAME_PATH, { credentials: 'same-origin' }) : null
    if (res && res.ok) frameScript = await res.text()
  } catch (err) { A.log('door view renderer: ' + errMessage(err)) }
  try {
    const res = fetchFn ? await fetchFn('/_mw/sdk.js', { credentials: 'same-origin' }) : null
    if (res && res.ok) sdk = await res.blob()
  } catch (_) { sdk = null }
  if (!frameScript) {
    const lang = langOf(A)
    A.ui.setStatus(doorText('door.viewFailed', lang), 'error')
    A.ui.showError({ title: STRINGS.genericErrorTitle, detail: doorText('door.viewFailed', lang), actions: [{ label: STRINGS.reload, primary: true, onClick: () => A.win.location.reload() }] })
    return null
  }
  const mount = await mountDoorView({
    container, files: doorFiles(A.parsed, A.blobs), path, routing: A.routing, frameScript, sdk, base: A.origin + '/', win: A.win,
    onTitle: handlers.onTitle, onBlockedNavigation: handlers.onBlockedNavigation
  })
  if (!mount.rendered) {
    // Most often the page could not take the limited-mode policy (no sessionStorage for the one-time reload), so the frame's
    // scripts are blocked. The frame stays: a late answer still renders.
    A.log('door view: the renderer did not answer in time (policy ' + ((A.boot && A.boot.cspKind) || '?') + ')')
    A.ui.setBanner('door-failed', doorText('door.viewFailed', langOf(A)), { kind: 'warn', actions: [{ label: STRINGS.reload, onClick: () => A.win.location.reload() }] })
  }
  return mount
}

/** afterDoorRender(A): after a render: the ledger's _doors once the ledger is open, the probe of this address, the Doors panel. */
function afterDoorRender (A) {
  if (!A.doorHealth) return
  if (A.ledgerPromise) A.ledgerPromise.then(() => refreshLedgerDoors(A)).catch(() => {})
  probeThisDoor(A, 'load')
  refreshDoors(A)
}

function scheduleLedgerDoors (A) {
  if (!A.doorHealth || A.ledgerDoorsTimer) return
  A.ledgerDoorsTimer = setTimeout(() => { A.ledgerDoorsTimer = null; refreshLedgerDoors(A) }, 2000)
}

/** refreshLedgerDoors(A): reads _doors (owner-authored, bounded; one accepted change an hour on this device, S4 D5). */
function refreshLedgerDoors (A) {
  const node = A.node
  if (!A.doorHealth || !node || node === A.followerNode) return
  const r = readLedgerDoors(node, { previous: A.ledgerDoorsAccepted || null, now: Date.now() })
  if (r.accepted && r.accepted !== A.ledgerDoorsAccepted) {
    A.ledgerDoorsAccepted = r.accepted
    try { A.deps.cache.setPref(DOOR_LEDGER_PREF + A.ledgerId, r.accepted).catch(() => {}) } catch (_) { /* best effort */ }
  }
  if (r.pending && !A.ledgerDoorsRecheck) A.ledgerDoorsRecheck = setTimeout(() => { A.ledgerDoorsRecheck = null; refreshLedgerDoors(A) }, 60000)
  A.ledgerDoors = { hosts: r.hosts, reason: r.reason, pending: !!r.pending }
  refreshDoors(A)
}

/** copyDoorLink(A): "Copy link with doors" (the visitor's click); the link is computed here, never taken from the page. */
async function copyDoorLink (A) {
  const text = doorShareLink(A, doorCandidatesOf(A))
  let ok = false
  try {
    const clip = A.win.navigator && A.win.navigator.clipboard
    if (text && clip && typeof clip.writeText === 'function') { await clip.writeText(text); ok = true }
  } catch (_) { ok = false }
  A.doorCopied = ok
  refreshDoors(A)
}

/** doorsInfo(A) → read-only door state for window.__mwShell.inspect() (tests and support). */
function doorsInfo (A) {
  if (!A.doorHealth) return null
  return {
    current: A.win.location.host,
    portable: isPortable(A),
    candidates: (A.doorCandidates || []).map((c) => ({ host: c.host, kind: c.kind })),
    health: A.doorHealth.snapshot(),
    probe: A.doorProbe || null,
    down: !!A.doorDown,
    banner: A.doorBanner ? A.doorBanner.hosts.slice() : null,
    view: !!(A.mount && A.mount.door),
    rendered: !!(A.mount && A.mount.door && A.mount.rendered),
    torrentFrom: A.doorTorrentFrom || null,
    lastGood: A.doorLastGood || null,
    ledgerDoors: A.ledgerDoors ? A.ledgerDoors.hosts.slice() : []
  }
}

// C2 doors: the steps above, exported for test/unit/loader-doors.test.mjs only; not an API.
export const __c2Doors = { guardActivationWatch, sharedFragment, consentModeOf, doorCspReload, pastedFragment, runDoorPaste, setupDoors, loadDoorMemory, isPortable, doorCandidatesOf, lightFragment, doorShareLink, showDoorViewBanner, refreshDoors, probeThisDoor, showNotAnswering, doorDownloadPlan, mountDoorFrame, refreshLedgerDoors, copyDoorLink, doorsInfo, persistSite, needsGate }

// C2 wire-ui: the steps above, exported for test/unit/sdk-c2-seeding.test.mjs only; not an API.
export const __c2WireUi = { setupSeeding, attachSeeding, refreshCarry, refreshSeedUi, seedModel, refreshUploads, maybeAskSeed, onSeedPush, afterServices, callDeps, onCallYield, toggleDockFromSettings, setKeeper, keeperActive, noteSiteWire, trackerSeen }

// Internal steps, exported for the unit tests only (test/unit/loader-app-review1.test.mjs); not an API.
export { lifecyclePlan }
export const __test = { needsGate, downloadSite, obtainSite, runHubRoot, presentWithdrawal, startEngine, installTabLink, markSuperseded, recordVersion, showConsentCard, openGate, askBeforeDns, dnsUpdatesPlanned, dohOverrideHost, saveConsentRecord, createPage }

// Started by boot.js's module-script fallback (window.__mwBoot.autostart) when import() was unusable.
if (typeof window !== 'undefined' && window.__mwBoot && window.__mwBoot.autostart && !window.__mwBoot.started) {
  start().catch(() => {})
}
