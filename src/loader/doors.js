// src/loader/doors.js: doors (v0.3 C2, docs/research/v03/S4-doors.md D1 to D6). The site lives at its key; domains are doors: any
// host that serves the loader can show a site by its link, and a page that already runs (from its Service Worker or an installed
// app) can fetch the site's bytes from other doors when its own address stops answering.
//
// What this module does (pure helpers, Node-testable; every browser global is a parameter):
//   - doorCandidates(): the doors of a site in the order of D3 (current, last good, signed org= then dr=, the ledger's _doors, the
//     link's #mwd= hints; at most 12), each host once;
//   - createDoorHealth(): the health memory (per host: last success, last failure, a 10-minute back-off), kept in a pref;
//   - doorJsonFor() / checkDoorJson() / probeDoor(): /_mw/door.json (every build writes it) and the probe: a no-cors fetch says
//     whether the host answers at all, a CORS read (when the host sends Access-Control-Allow-Origin) says whether the answer is a door
//     (a block page also answers 200) and whether it runs this build;
//   - fetchFirst(): the staggered fetch of RFC 8305 for bytes that are checked by hash (a .torrent by its infohash): 250 ms between
//     starts, at most 3 in flight, 4 s to the first byte and 12 s per door, then the next door;
//   - ledgerDoorsFrom() / readLedgerDoors(): the owner's _doors item ({ v: 1, d: [host, ...] }, at most 24 hosts, 2,048 bytes),
//     owner-authored only (a moderator's item is hidden), at most one accepted change an hour on this device; an invalid item is
//     hidden and its block stays valid (MF-21: a state rule, never validity);
//   - enforceDoorBudget(): copies stored by a door view (manifest.viaDoor) are evicted before any other copy;
//   - doorsPanelModel() / doorsBannerModel(): what Settings and the "not answering" banner show;
//   - mountDoorView() and frameMain(): the door view, a frame with sandbox="allow-scripts" (an opaque origin: no storage, no Service
//     Worker, no cookies of the door), whose own renderer (frameMain, built as /_mw/door-frame.js and written into the frame inline)
//     receives the site's files over a MessagePort and makes its own blob: URLs: a sandboxed frame cannot load blob: URLs that the
//     door page made (measured, Chromium 156 and WebKit 27.2: "Not allowed to load local resource").
//
// What it never does: navigate to another origin by itself (the visitor chooses a door with a click), load the loader from another
// origin (the worker script must be same-origin; cross-door fallback is for bytes only), or promise that a link reroutes itself
// (with door 1 down and nothing cached the browser shows its own error page and no code of ours runs).

import {
  isDoorHost, doorOrigin, hostOfOrigin, parseDoors, isLoopbackDoorHost, DOOR_PAGE_PATH, DOORS_TOTAL_MAX, HINT_MAX
} from '../common/pointer.js'
import { isPublicWebHost } from '../common/magnet.js'
import {
  cleanSitePath, resolveRef, resolveSitePath, rewriteCssText, rewriteSrcset, rewriteModuleSpecifiers
} from './render.js'

/** The chosen constants of S4 D3 (250 ms is the RFC 8305 default "Connection Attempt Delay"). */
export const DOOR_TIMING = Object.freeze({ firstByteMs: 4000, perDoorMs: 12000, staggerMs: 250, inFlight: 3, backoffMs: 10 * 60 * 1000 })
export const DOOR_CANDIDATES_MAX = DOORS_TOTAL_MAX
export const DOOR_KINDS = Object.freeze(['current', 'last-good', 'owner', 'guest', 'ledger', 'hint'])
/** The owner's list of doors in the site ledger (S4 D5). */
export const LEDGER_DOORS_KEY = '_doors'
export const LEDGER_DOORS_MAX = 24
export const LEDGER_DOORS_BYTES = 2048
export const LEDGER_DOORS_INTERVAL_MS = 60 * 60 * 1000
export const DOOR_JSON_PATH = '/_mw/door.json'
export const DOOR_FRAME_PATH = '/_mw/door-frame.js'
export const DOOR_JSON_KIND = 'felinar-door'
/** The door view's frame: scripts only. No allow-same-origin (an opaque origin), no popups, forms or top navigation. */
export const DOOR_SANDBOX = 'allow-scripts'
export const DOOR_HEALTH_PREF = 'doorHealth'
export const DOOR_LAST_GOOD_PREF = 'doorLastGood:'
export const DOOR_LEDGER_PREF = 'doorLedger:'
export const DOOR_HEALTH_MAX = 32
/** At most this many copies stored by door views are kept; beyond it, and before any other copy, the oldest go. */
export const DOOR_COPIES_MAX = 4
/** At most this many door web seeds join the record's own ws= list (each one sees the visitor's IP address). */
export const DOOR_WEBSEEDS_MAX = 3
export const DOOR_JSON_MAX_BYTES = 64 * 1024
export const DOOR_VIEW_READY_MS = 10000

const BTIH_RE = /^[0-9a-f]{40}$/
const HEX64_RE = /^[0-9a-f]{64}$/
const SRI_RE = /^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$/

function own (o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k) }
function errText (err) { return (err && err.message) || String(err) }

// ---------------------------------------------------------------------------------------------
// Candidates (S4 D3)
// ---------------------------------------------------------------------------------------------

/**
 * hintAllowed(host, { pageHost }) → may an unsigned #mwd= hint be contacted? Only a public host (isPublicWebHost: no loopback,
 * private, link-local or LAN name), except that a page on a loopback host may use loopback hints (local development). A link must
 * not make a visitor's browser probe their own network (the MF-76 rule for unsigned records).
 */
export function hintAllowed (host, { pageHost = null } = {}) {
  if (!isDoorHost(host)) return false
  if (isPublicWebHost(new URL('https://' + host + '/').hostname)) return true
  return !!(pageHost && isLoopbackDoorHost(pageHost) && isLoopbackDoorHost(host))
}

/**
 * doorCandidates({ current, lastGood, record, ledgerDoors, hints, pageHost, max }) → [{ host, origin, kind }]: the doors of a site,
 * each host once, in the order of S4 D3: the door this page runs on ('current'), the door the site last loaded from on this device
 * ('last-good'), the owner's org= ('owner') and dr= ('guest') doors, the ledger's _doors ('ledger'), then the link's hints ('hint',
 * only hosts hintAllowed() accepts); at most `max` (12). current and lastGood are door hosts (location.host); a bad host is dropped.
 */
export function doorCandidates ({ current = null, lastGood = null, record = null, ledgerDoors = [], hints = [], pageHost = null, max = DOOR_CANDIDATES_MAX } = {}) {
  const out = []
  const seen = new Set()
  const add = (host, kind) => {
    if (out.length >= max || typeof host !== 'string' || !isDoorHost(host) || seen.has(host)) return
    seen.add(host)
    out.push({ host, origin: doorOrigin(host), kind })
  }
  add(current, 'current')
  add(lastGood, 'last-good')
  const signed = parseDoors(record, [])
  for (const h of signed.owner) add(h, 'owner')
  for (const h of signed.guest) add(h, 'guest')
  for (const h of Array.isArray(ledgerDoors) ? ledgerDoors : []) add(h, 'ledger')
  const page = pageHost || current
  let n = 0
  for (const h of Array.isArray(hints) ? hints : []) {
    if (n >= HINT_MAX) break
    if (!hintAllowed(h, { pageHost: page })) continue
    n++
    add(h, 'hint')
  }
  return out
}

/**
 * byteDoors(candidates, { record, base }) → the candidates that may be asked for this site's bytes (its .torrent and web seed):
 * the owner's org= doors (the owner's own full mirrors), the last door that served this site's .torrent on this device, and a door
 * whose host the signed record itself names in ws= or xs=. A guest door (dr=), a door of the ledger's _doors list or a link's
 * hint may be a loader-only door run by someone else: a request for /_mw/t/<btih>.torrent or /ws/<name>/ would tell it which site
 * the visitor opens, which a light link's fragment otherwise never does (code review v0.3, conformance). Those doors serve the
 * loader only; the site's bytes come from peers or from the doors above.
 */
export function byteDoors (candidates, { record = null, base = undefined } = {}) {
  const trusted = new Set()
  if (record && typeof record === 'object') {
    for (const h of parseDoors(record, []).owner) trusted.add(h)
    const urls = [].concat(Array.isArray(record.ws) ? record.ws : [], Array.isArray(record.xs) ? record.xs : (typeof record.xs === 'string' ? [record.xs] : []))
    for (const u of urls) {
      try { trusted.add(new URL(String(u), base).host) } catch (_) { /* not a URL */ }
    }
  }
  return (Array.isArray(candidates) ? candidates : []).filter((c) => c && c.host && (c.kind === 'owner' || c.kind === 'last-good' || trusted.has(c.host)))
}

/** doorTorrentUrls(candidates, btih) → each door's /_mw/t/<btih>.torrent (the layout of a full door, docs/DEPLOY.md "Doors"). */
export function doorTorrentUrls (candidates, btih) {
  if (!BTIH_RE.test(String(btih || ''))) return []
  return (Array.isArray(candidates) ? candidates : []).filter((c) => c && c.origin).map((c) => c.origin + '/_mw/t/' + btih + '.torrent')
}

/**
 * doorWebseeds(candidates, { health, now, max, exclude }) → web seed base URLs (<door>/ws/) of up to `max` doors that are not in
 * back-off, in candidate order; URLs already in `exclude` (the record's own ws=) are skipped. Bytes from a web seed are checked
 * piece by piece against the torrent, so a wrong door cannot change the site, only waste a request.
 */
export function doorWebseeds (candidates, { health = null, now = Date.now(), max = DOOR_WEBSEEDS_MAX, exclude = [] } = {}) {
  const skip = new Set((Array.isArray(exclude) ? exclude : []).map(String))
  const out = []
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (out.length >= max || !c || !c.origin) continue
    if (health && typeof health.inBackoff === 'function' && health.inBackoff(c.host, now)) continue
    const url = c.origin + '/ws/'
    if (!skip.has(url) && out.indexOf(url) < 0) out.push(url)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Health memory (kept in a pref; small, bounded)
// ---------------------------------------------------------------------------------------------

/**
 * createDoorHealth({ load, save, now, backoffMs, max }) → { ready, get, ok, fail, inBackoff, order, snapshot }.
 * load() → Promise<object|null> (the stored map), save(map) → Promise (best effort). Per host: { ok: ms, fail: ms, reason, until,
 * state, buildId }. fail() starts a back-off of backoffMs (10 minutes); ok() ends it. order(list) puts doors in back-off last, keeping
 * the order otherwise. At most `max` hosts are kept (the least recently updated go).
 */
export function createDoorHealth ({ load = null, save = null, now = () => Date.now(), backoffMs = DOOR_TIMING.backoffMs, max = DOOR_HEALTH_MAX } = {}) {
  let map = Object.create(null)
  const clock = typeof now === 'function' ? now : () => now
  const ready = (async () => {
    if (typeof load !== 'function') return
    try {
      const v = await load()
      if (v && typeof v === 'object') for (const k of Object.keys(v)) if (isDoorHost(k) && v[k] && typeof v[k] === 'object') map[k] = sanitize(v[k])
    } catch (_) { /* start empty */ }
  })()
  function sanitize (e) {
    const num = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0)
    return { ok: num(e.ok), fail: num(e.fail), until: num(e.until), reason: typeof e.reason === 'string' ? e.reason.slice(0, 40) : null, state: typeof e.state === 'string' ? e.state.slice(0, 20) : null, buildId: typeof e.buildId === 'string' ? e.buildId.slice(0, 64) : null, at: num(e.at) }
  }
  function persist () {
    const keys = Object.keys(map)
    if (keys.length > max) {
      keys.sort((a, b) => map[a].at - map[b].at)
      for (const k of keys.slice(0, keys.length - max)) delete map[k]
    }
    if (typeof save === 'function') { try { const p = save(snapshot()); if (p && typeof p.catch === 'function') p.catch(() => {}) } catch (_) { /* best effort */ } }
  }
  function entry (host) {
    if (!map[host]) map[host] = { ok: 0, fail: 0, until: 0, reason: null, state: null, buildId: null, at: 0 }
    return map[host]
  }
  function get (host) { return map[host] ? Object.assign({}, map[host]) : null }
  function ok (host, info = {}) {
    if (!isDoorHost(host)) return
    const e = entry(host)
    const t = clock()
    e.ok = t; e.until = 0; e.reason = null; e.at = t
    e.state = typeof info.state === 'string' ? info.state : 'up'
    if (typeof info.buildId === 'string') e.buildId = info.buildId
    persist()
  }
  function fail (host, reason = 'down') {
    if (!isDoorHost(host)) return
    const e = entry(host)
    const t = clock()
    e.fail = t; e.until = t + backoffMs; e.reason = String(reason).slice(0, 40); e.state = 'down'; e.at = t
    persist()
  }
  function inBackoff (host, at = clock()) { return !!(map[host] && map[host].until > at) }
  function order (list) {
    const t = clock()
    const arr = Array.isArray(list) ? list.slice() : []
    return arr.filter((c) => !inBackoff(c.host, t)).concat(arr.filter((c) => inBackoff(c.host, t)))
  }
  function snapshot () {
    const out = {}
    for (const k of Object.keys(map)) out[k] = Object.assign({}, map[k])
    return out
  }
  return { ready, get, ok, fail, inBackoff, order, snapshot }
}

// ---------------------------------------------------------------------------------------------
// /_mw/door.json: what a door serves, and what a probe reads (S4 D3, D7)
// ---------------------------------------------------------------------------------------------

/**
 * doorJsonFor({ name, version, buildId, files }) → the object build.mjs writes to /_mw/door.json. files: [{ path, bytes, sha256, sri }]
 * with absolute paths ('/_mw/loader.js'); door.json itself is never listed. Sorted by path, so two builds give the same bytes.
 */
export function doorJsonFor ({ name = 'felinar', version, buildId, files = [] } = {}) {
  const list = {}
  for (const f of files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (!f || typeof f.path !== 'string' || !f.path.startsWith('/') || f.path === DOOR_JSON_PATH) continue
    list[f.path] = { bytes: f.bytes, sha256: f.sha256, sri: f.sri }
  }
  return { v: 1, kind: DOOR_JSON_KIND, name, version, buildId, page: DOOR_PAGE_PATH, files: list }
}

/**
 * checkDoorJson(json, own) → { ok, sameBuild, buildId, version, reason }. ok: the shape of a door.json (v 1, kind, a build id, at least
 * the door page, the loader and the worker, each with a sha256 and an SRI value). sameBuild: own is given and every file of own has
 * the same sha256 here (the door serves this very build). reason names the first problem.
 */
export function checkDoorJson (json, ownJson = null) {
  const out = { ok: false, sameBuild: false, buildId: null, version: null, reason: null }
  if (!json || typeof json !== 'object' || Array.isArray(json)) { out.reason = 'not-an-object'; return out }
  if (json.v !== 1 || json.kind !== DOOR_JSON_KIND) { out.reason = 'not-a-door'; return out }
  if (typeof json.buildId !== 'string' || !/^[0-9a-z-]{4,64}$/.test(json.buildId)) { out.reason = 'build-id'; return out }
  const files = json.files && typeof json.files === 'object' && !Array.isArray(json.files) ? json.files : null
  if (!files) { out.reason = 'files'; return out }
  for (const p of [DOOR_PAGE_PATH, '/_mw/loader.js', '/mw-sw.js']) if (!own(files, p)) { out.reason = 'missing ' + p; return out }
  for (const p of Object.keys(files)) {
    const f = files[p]
    if (!p.startsWith('/') || !f || !HEX64_RE.test(String(f.sha256)) || !SRI_RE.test(String(f.sri)) || !Number.isSafeInteger(f.bytes)) { out.reason = 'entry ' + p; return out }
  }
  out.ok = true
  out.buildId = json.buildId
  out.version = typeof json.version === 'string' ? json.version : null
  if (ownJson && ownJson.files && typeof ownJson.files === 'object') {
    const mine = Object.keys(ownJson.files)
    out.sameBuild = mine.length > 0 && ownJson.buildId === json.buildId && mine.every((p) => own(files, p) && files[p].sha256 === ownJson.files[p].sha256)
  }
  return out
}

function timeoutSignal (ms, outer, setT, clearT) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null
  if (!ctl) return { signal: undefined, done () {} }
  const timer = setT(() => { try { ctl.abort() } catch (_) { /* done */ } }, ms)
  const onAbort = () => { try { ctl.abort() } catch (_) { /* done */ } }
  if (outer) { if (outer.aborted) onAbort(); else outer.addEventListener('abort', onAbort, { once: true }) }
  return { signal: ctl.signal, done () { clearT(timer); if (outer) { try { outer.removeEventListener('abort', onAbort) } catch (_) { /* gone */ } } } }
}

async function readCapped (res, maxBytes) {
  const declared = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : 0) || 0
  if (declared > maxBytes) throw new Error('too large')
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.length > maxBytes) throw new Error('too large')
    return buf
  }
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) { try { await reader.cancel() } catch (_) { /* gone */ } throw new Error('too large') }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.length }
  return out
}

/**
 * probeDoor(origin, { fetch, own, sameOrigin, timeoutMs, signal, setTimeout, clearTimeout, now }) → { origin, host, state, buildId, ms, reason }.
 * sameOrigin: the page's own address: one CORS request is enough (it is always readable), and a failure is 'down'.
 * state: 'down' (the no-cors request failed: no answer, no TLS, refused), 'opaque' (it answers, but without CORS the answer cannot be
 * read: reachable, not checked), 'bad' (readable, but not a door.json: a block page, a parked domain, an error page), 'other-build'
 * (a door with another loader build), 'up' (a door with this build, or with any build when `own` is not given). Requests carry no
 * credentials and no referrer and skip the HTTP cache; the door learns the visitor's IP address and the time, never the site.
 * json: the parsed door.json when it was readable and valid (a page keeps its own to compare other doors with: 'other-build').
 */
export async function probeDoor (origin, { fetch: fetchFn = (typeof fetch === 'function' ? fetch.bind(globalThis) : null), own: ownJson = null, sameOrigin = false, timeoutMs = DOOR_TIMING.firstByteMs, signal = null, setTimeout: setT = setTimeout, clearTimeout: clearT = clearTimeout, now = () => Date.now() } = {}) {
  const host = (() => { try { return new URL(origin).host } catch (_) { return null } })()
  const t0 = now()
  const out = { origin, host, state: 'down', buildId: null, ms: 0, reason: null }
  if (!fetchFn || !host) { out.reason = 'no-fetch'; return out }
  const url = origin + DOOR_JSON_PATH
  // A no-cors request may only follow redirects (Chromium rejects any other mode); the shape check below decides either way.
  const base = { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow' }
  let t
  if (!sameOrigin) {
    t = timeoutSignal(timeoutMs, signal, setT, clearT)
    try {
      await fetchFn(url, Object.assign({}, base, { mode: 'no-cors', signal: t.signal }))
    } catch (err) {
      t.done()
      out.ms = now() - t0
      out.reason = errText(err).slice(0, 60)
      return out
    }
    t.done()
  }
  t = timeoutSignal(timeoutMs, signal, setT, clearT)
  let res
  try {
    res = await fetchFn(url, Object.assign({}, base, { mode: sameOrigin ? 'same-origin' : 'cors', signal: t.signal }))
  } catch (err) {
    t.done()
    out.ms = now() - t0
    if (sameOrigin) { out.reason = errText(err).slice(0, 60); return out }
    out.state = 'opaque'
    return out
  }
  try {
    if (!res || res.status !== 200) {
      out.state = 'bad'
      out.reason = 'http-' + (res ? res.status : 0)
      return out
    }
    const bytes = await readCapped(res, DOOR_JSON_MAX_BYTES)
    let json = null
    try { json = JSON.parse(new TextDecoder().decode(bytes)) } catch (_) { json = null }
    const check = checkDoorJson(json, ownJson)
    if (!check.ok) { out.state = 'bad'; out.reason = check.reason; return out }
    out.buildId = check.buildId
    out.json = json
    out.state = !ownJson || check.sameBuild ? 'up' : 'other-build'
    return out
  } catch (err) {
    out.state = 'bad'
    out.reason = errText(err).slice(0, 60)
    return out
  } finally {
    t.done()
    out.ms = now() - t0
  }
}

// ---------------------------------------------------------------------------------------------
// The staggered fetch (RFC 8305 style) for bytes that are checked by hash
// ---------------------------------------------------------------------------------------------

/**
 * fetchFirst(urls, { fetch, verify, staggerMs, inFlight, firstByteMs, perDoorMs, maxBytes, signal, setTimeout, clearTimeout, now,
 * onResult }) → Promise<{ ok, url, bytes, results }>. Starts the first URL at once and the next one every staggerMs while nothing has
 * succeeded, never more than inFlight at once, and at once when one fails. Each attempt must answer within firstByteMs (the response
 * headers) and finish within perDoorMs; its bytes must pass verify(bytes, url) → boolean | Promise<boolean> (a .torrent by its
 * infohash); the first that passes wins and the others are aborted. results: [{ url, ok, reason, ms }] in completion order.
 */
export function fetchFirst (urls, {
  fetch: fetchFn = (typeof fetch === 'function' ? fetch.bind(globalThis) : null), verify = () => true, staggerMs = DOOR_TIMING.staggerMs,
  inFlight = DOOR_TIMING.inFlight, firstByteMs = DOOR_TIMING.firstByteMs, perDoorMs = DOOR_TIMING.perDoorMs, maxBytes = 4 * 1024 * 1024,
  signal = null, setTimeout: setT = setTimeout, clearTimeout: clearT = clearTimeout, now = () => Date.now(), onResult = null, init = {}
} = {}) {
  const list = (Array.isArray(urls) ? urls : []).filter((u, i, a) => typeof u === 'string' && u && a.indexOf(u) === i)
  const results = []
  return new Promise((resolve) => {
    if (!fetchFn || !list.length) { resolve({ ok: false, url: null, bytes: null, results }); return }
    let next = 0
    let running = 0
    let settled = false
    let staggerTimer = null
    const controllers = new Set()
    const finish = (value) => {
      if (settled) return
      settled = true
      if (staggerTimer) clearT(staggerTimer)
      for (const c of controllers) { try { c.abort() } catch (_) { /* done */ } }
      controllers.clear()
      resolve(value)
    }
    if (signal) {
      if (signal.aborted) { finish({ ok: false, url: null, bytes: null, results, aborted: true }); return }
      signal.addEventListener('abort', () => finish({ ok: false, url: null, bytes: null, results, aborted: true }), { once: true })
    }
    const report = (r) => {
      results.push(r)
      if (typeof onResult === 'function') { try { onResult(r) } catch (_) { /* observer */ } }
    }
    const maybeDone = () => {
      if (!settled && running === 0 && next >= list.length) finish({ ok: false, url: null, bytes: null, results })
    }
    const schedule = () => {
      if (settled || next >= list.length) return
      if (staggerTimer) clearT(staggerTimer)
      staggerTimer = setT(() => { staggerTimer = null; launch() }, staggerMs)
    }
    const launch = () => {
      if (settled || next >= list.length) return
      if (running >= inFlight) return
      const url = list[next++]
      running++
      attempt(url).then((r) => {
        running--
        if (settled) return
        report(r)
        if (r.ok) { finish({ ok: true, url, bytes: r.bytes, results }); return }
        launch() // a failure starts the next door at once
        maybeDone()
      })
      schedule()
    }
    const attempt = async (url) => {
      const t0 = now()
      const ctl = typeof AbortController === 'function' ? new AbortController() : null
      if (ctl) controllers.add(ctl)
      let headerTimer = null
      let totalTimer = null
      const stop = (why) => { if (ctl) { ctl.__why = why; try { ctl.abort() } catch (_) { /* done */ } } }
      try {
        headerTimer = setT(() => stop('first-byte'), firstByteMs)
        totalTimer = setT(() => stop('timeout'), perDoorMs)
        const res = await fetchFn(url, Object.assign({ cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', mode: 'cors' }, init, ctl ? { signal: ctl.signal } : {}))
        clearT(headerTimer); headerTimer = null
        if (!res || res.status !== 200) return { url, ok: false, reason: 'http-' + (res ? res.status : 0), ms: now() - t0 }
        const bytes = await readCapped(res, maxBytes)
        let good = false
        try { good = await verify(bytes, url) } catch (_) { good = false }
        return good ? { url, ok: true, reason: null, ms: now() - t0, bytes } : { url, ok: false, reason: 'hash', ms: now() - t0 }
      } catch (err) {
        return { url, ok: false, reason: (ctl && ctl.__why) || (settled ? 'cancelled' : errText(err).slice(0, 60)), ms: now() - t0 }
      } finally {
        if (headerTimer) clearT(headerTimer)
        if (totalTimer) clearT(totalTimer)
        if (ctl) controllers.delete(ctl)
      }
    }
    launch()
  })
}

// ---------------------------------------------------------------------------------------------
// The ledger's _doors (S4 D5): owner-authored, bounded, rate limited on the reader
// ---------------------------------------------------------------------------------------------

function canonicalBytes (value) {
  // _doors values are small plain objects; JSON with sorted keys is RFC 8785 for them (no numbers beyond v: 1, ASCII hosts).
  const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.keys(v).sort().reduce((o, k) => { o[k] = sortKeys(v[k]); return o }, {}) : v)
  return new TextEncoder().encode(JSON.stringify(sortKeys(value))).length
}

/** ledgerDoorsProblem(value) → null when value is a valid _doors item ({ v: 1, d: [1 to 24 distinct door hosts] }, 2,048 bytes), else why not. */
export function ledgerDoorsProblem (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'not-an-object'
  const keys = Object.keys(value)
  if (keys.some((k) => k !== 'v' && k !== 'd')) return 'unknown-field'
  if (value.v !== 1) return 'version'
  if (!Array.isArray(value.d) || value.d.length === 0) return 'no-hosts'
  if (value.d.length > LEDGER_DOORS_MAX) return 'too-many'
  for (const h of value.d) if (!isDoorHost(h)) return 'bad-host'
  if (new Set(value.d).size !== value.d.length) return 'repeated-host'
  if (canonicalBytes(value) > LEDGER_DOORS_BYTES) return 'too-large'
  return null
}

/** ledgerDoorsValue(hosts) → the _doors value to write ({ v: 1, d: hosts }); TypeError when it would be hidden by readers. */
export function ledgerDoorsValue (hosts) {
  const value = { v: 1, d: Array.isArray(hosts) ? hosts.slice() : [] }
  const problem = ledgerDoorsProblem(value)
  if (problem) throw new TypeError('ledgerDoorsValue: ' + problem + ' (at most ' + LEDGER_DOORS_MAX + ' distinct lowercase hosts, ' + LEDGER_DOORS_BYTES + ' bytes)')
  return value
}

/**
 * ledgerDoorsFrom(entry, { owner, previous, now, intervalMs }) → { hosts, accepted, pending, reason, h, ts }.
 * entry: the state's kv entry of _doors ({ v, author, h, ts }) or null. owner: the ledger's owner in effect. previous: what this device
 * accepted before ({ h, ts, acceptedAt, hosts }) or null. An entry that is not by the owner (a moderator may write '_' keys, D5 hides
 * theirs) or whose value is invalid is hidden (hosts from previous stay). A valid new entry replaces previous only when at least
 * intervalMs (one hour) passed since previous was accepted here; until then it is pending and previous stays.
 */
export function ledgerDoorsFrom (entry, { owner = null, previous = null, now = Date.now(), intervalMs = LEDGER_DOORS_INTERVAL_MS } = {}) {
  const prev = previous && typeof previous === 'object' && Array.isArray(previous.hosts) ? previous : null
  const keep = (reason, pending = false) => ({ hosts: prev ? prev.hosts.slice() : [], accepted: prev, pending, reason, h: prev ? prev.h || null : null, ts: prev ? prev.ts || null : null })
  if (!entry || typeof entry !== 'object') return keep(prev ? 'kept' : 'none')
  if (!owner || entry.author !== owner) return keep('not-owner')
  const problem = ledgerDoorsProblem(entry.v)
  if (problem) return keep(problem)
  if (prev && prev.h === entry.h) return keep('same')
  if (prev && typeof prev.acceptedAt === 'number' && now - prev.acceptedAt < intervalMs) return keep('rate', true)
  const accepted = { h: typeof entry.h === 'string' ? entry.h : null, ts: typeof entry.ts === 'number' ? entry.ts : null, acceptedAt: now, hosts: entry.v.d.slice() }
  return { hosts: accepted.hosts.slice(), accepted, pending: false, reason: 'accepted', h: accepted.h, ts: accepted.ts }
}

/** readLedgerDoors(node, opts) → ledgerDoorsFrom(node.state.kv.get('_doors'), { owner: node.owner, ...opts }); hidden on any error. */
export function readLedgerDoors (node, opts = {}) {
  let entry = null
  let owner = null
  try {
    const st = node && node.state
    entry = st && st.kv instanceof Map ? st.kv.get(LEDGER_DOORS_KEY) || null : null
    owner = node ? node.owner : null
  } catch (_) { entry = null }
  return ledgerDoorsFrom(entry, Object.assign({ owner }, opts))
}

// ---------------------------------------------------------------------------------------------
// Storage: copies stored by a door view go first (S4 D4)
// ---------------------------------------------------------------------------------------------

function siteBytesOf (s) {
  let n = 0
  for (const f of (s && Array.isArray(s.files) ? s.files : [])) n += Number(f && f.length) || 0
  return n
}

/**
 * enforceDoorBudget({ cache, budgetBytes, keep, maxCopies }) → { evicted: [btih] }: deletes copies stored by door views
 * (manifest.viaDoor) oldest first while there are more than maxCopies of them or while all stored copies together exceed budgetBytes;
 * then cache.enforceBudget() handles the rest as before. A btih in keep is never deleted.
 */
export async function enforceDoorBudget ({ cache, budgetBytes = Infinity, keep = [], maxCopies = DOOR_COPIES_MAX } = {}) {
  const evicted = []
  if (!cache || typeof cache.listSites !== 'function' || typeof cache.deleteSite !== 'function') return { evicted }
  let sites = []
  try { sites = (await cache.listSites()) || [] } catch (_) { return { evicted } }
  const keepSet = new Set((Array.isArray(keep) ? keep : [keep]).filter(Boolean))
  const stamp = (s) => (typeof s.lastVisit === 'number' ? s.lastVisit : (typeof s.savedAt === 'number' ? s.savedAt : 0))
  let total = 0
  for (const s of sites) total += siteBytesOf(s)
  const door = sites.filter((s) => s && s.viaDoor === true && !keepSet.has(s.btih)).sort((a, b) => stamp(a) - stamp(b))
  let doorCount = sites.filter((s) => s && s.viaDoor === true).length
  for (const s of door) {
    const over = Number.isFinite(budgetBytes) && total > budgetBytes
    if (!over && doorCount <= maxCopies) break
    try {
      await cache.deleteSite(s.btih)
      evicted.push(s.btih)
      total -= siteBytesOf(s)
      doorCount--
    } catch (_) { /* leave it */ }
  }
  return { evicted }
}

// ---------------------------------------------------------------------------------------------
// What Settings and the banner show
// ---------------------------------------------------------------------------------------------

/**
 * doorsPanelModel({ candidates, health, now, current }) → { shown, current, lastGood, owner, guest, ledger, hint } where each list holds
 * { host, url, state } (state from the health memory: 'up', 'other-build', 'opaque', 'down', or null when never checked).
 */
export function doorsPanelModel ({ candidates = [], health = null, now = Date.now() } = {}) {
  const out = { shown: false, current: null, lastGood: null, owner: [], guest: [], ledger: [], hint: [] }
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (!c || !c.host) continue
    const h = health && typeof health.get === 'function' ? health.get(c.host) : null
    const item = { host: c.host, origin: c.origin, state: h ? (h.until > now ? 'down' : h.state) : null }
    if (c.kind === 'current') out.current = item
    else if (c.kind === 'last-good') out.lastGood = item
    else if (out[c.kind]) out[c.kind].push(item)
  }
  out.shown = !!(out.current || out.owner.length || out.guest.length || out.ledger.length || out.hint.length)
  return out
}

/**
 * doorsBannerModel({ candidates, health, now, max }) → { hosts: [{ host, origin, kind }] } the doors the "not answering" banner offers:
 * every candidate except the current door, those in back-off left out, at most `max` (3) buttons. The banner is shown only when the
 * current door failed its probe; it never navigates by itself.
 */
export function doorsBannerModel ({ candidates = [], health = null, now = Date.now(), max = 3 } = {}) {
  const hosts = []
  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (!c || c.kind === 'current' || hosts.length >= max) continue
    if (health && typeof health.inBackoff === 'function' && health.inBackoff(c.host, now)) continue
    hosts.push({ host: c.host, origin: c.origin, kind: c.kind })
  }
  return { hosts }
}

/**
 * doorLinkFor(candidate, { fragment, portable }) → the address to open the site at that door: an owner door's own root (it has the
 * site's page tag or DNS pointer: full mode there) when no portable record is known, else <door>/_mw/open.html#<fragment> (the light
 * link this page was opened with, or one made for it). null when nothing can be opened there.
 */
export function doorLinkFor (candidate, { fragment = null, portable = false } = {}) {
  if (!candidate || !candidate.origin) return null
  if (portable && typeof fragment === 'string' && fragment.replace(/^#/, '')) return candidate.origin + DOOR_PAGE_PATH + '#' + fragment.replace(/^#/, '')
  if (candidate.kind === 'owner') return candidate.origin + '/'
  return null
}

// ---------------------------------------------------------------------------------------------
// The door view (S4 D4): a sandboxed frame with its own renderer
// ---------------------------------------------------------------------------------------------

/**
 * doorFiles(parsed, blobs) → Map<site path, Blob>: the files of a downloaded or stored site under their site paths (no leading slash),
 * pad files left out; the same keys the limited-mode renderer uses.
 */
export function doorFiles (parsed, blobs) {
  const map = new Map()
  const list = parsed && Array.isArray(parsed.files) ? parsed.files : []
  for (const f of list) {
    if (!f || f.pad || typeof f.path !== 'string') continue
    const key = cleanSitePath(f.path)
    const blob = blobs instanceof Map ? blobs.get(f.path) || blobs.get(key) : null
    if (blob) map.set(key, blob)
  }
  if (!list.length && blobs instanceof Map) for (const [k, v] of blobs) map.set(cleanSitePath(k), v)
  return map
}

/**
 * doorFrameHtml(script) → the srcdoc of the door view: an empty document whose only script is the renderer (the text of
 * /_mw/door-frame.js), inline, because a frame without allow-same-origin is not controlled by the door's Service Worker and must work
 * with the door offline. '</script' and '<!--' are escaped so the text cannot end the element early.
 */
export function doorFrameHtml (script) {
  const safe = String(script || '').replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--')
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"></head><body><script>' + safe + '\n</script></body></html>'
}

/**
 * mountDoorView({ container, files, path, routing, frameScript, sdk, base, win, onNavigate, onTitle, onBlockedNavigation, readyMs })
 *   → Promise<{ iframe, door: true, degraded: true, rendered, navigate(path), currentPath(), destroy() }>
 * Mounts the site in a frame with sandbox="allow-scripts" (DOOR_SANDBOX): its origin is opaque, so the site has no storage, no
 * worker and no cookie of the door, and it keeps scripts, crypto, fetch with CORS and WebRTC (S4 F2, measured). The renderer
 * (frameScript) says { mwDoor: 'ready' } with a MessagePort; this side answers on the port with the files (Blobs), the path, the
 * routing manifest, the SDK (a Blob of /_mw/sdk.js, mapped to /_mw/sdk.js inside the frame) and base (the door's origin + '/': relative
 * URLs that are not site files resolve there). A link to another site page comes back as { mwDoor: 'navigate', path } and the frame is
 * reloaded with that page (a fresh global object), so the same iframe element stays (the Bridge keeps its frame); a link to another
 * address comes back as { mwDoor: 'external', url } (onBlockedNavigation). Messages are accepted only from this frame with origin
 * "null". rendered is false when the renderer did not answer within readyMs.
 */
export async function mountDoorView ({ container, files, path = '/', routing = null, frameScript, sdk = null, base = null, win: winIn = null, onNavigate = null, onTitle = null, onBlockedNavigation = null, readyMs = DOOR_VIEW_READY_MS } = {}) {
  if (!container || !container.ownerDocument) throw new TypeError('mountDoorView needs a container element')
  if (typeof frameScript !== 'string' || !frameScript) throw new Error('the door view renderer (' + DOOR_FRAME_PATH + ') is not available')
  const doc = container.ownerDocument
  const win = winIn || doc.defaultView
  const fileList = files instanceof Map ? Array.from(files) : []
  const iframe = doc.createElement('iframe')
  iframe.className = 'mw-site-frame mw-door-frame'
  iframe.setAttribute('title', 'Site')
  iframe.setAttribute('sandbox', DOOR_SANDBOX)
  iframe.setAttribute('referrerpolicy', 'no-referrer')
  const html = doorFrameHtml(frameScript)
  let current = typeof path === 'string' && path ? path : '/'
  let destroyed = false
  let port = null
  let pending = null
  const settle = (value) => {
    if (!pending) return
    const p = pending
    pending = null
    clearTimeout(p.timer)
    p.resolve(value)
  }
  const onFrame = (d) => {
    if (destroyed || !d || typeof d !== 'object') return
    if (d.mwDoor === 'rendered') {
      if (typeof d.path === 'string' && d.path) current = d.path
      if (typeof d.title === 'string' && d.title) {
        try { doc.title = d.title } catch (_) { /* ignore */ }
        if (typeof onTitle === 'function') onTitle(d.title)
      }
      if (typeof onNavigate === 'function') onNavigate(current)
      settle(true)
    } else if (d.mwDoor === 'navigate' && typeof d.path === 'string') {
      navigate(d.path)
    } else if (d.mwDoor === 'external' && typeof d.url === 'string') {
      if (typeof onBlockedNavigation === 'function') onBlockedNavigation({ url: d.url })
    } else if (d.mwDoor === 'title' && typeof d.title === 'string') {
      try { doc.title = d.title } catch (_) { /* ignore */ }
      if (typeof onTitle === 'function') onTitle(d.title)
    } else if (d.mwDoor === 'error') {
      settle(false)
    }
  }
  const onMessage = (ev) => {
    if (destroyed || !ev || ev.source !== iframe.contentWindow || ev.origin !== 'null') return
    const d = ev.data
    if (!d || typeof d !== 'object' || d.mwDoor !== 'ready') return
    const p = ev.ports && ev.ports[0]
    if (!p || typeof p.postMessage !== 'function') return
    if (port) { try { port.close() } catch (_) { /* gone */ } }
    port = p
    port.onmessage = (e) => onFrame(e && e.data)
    try { port.postMessage({ mwDoor: 'render', v: 1, files: fileList, path: current, routing, sdk, base }) } catch (_) { settle(false) }
  }
  win.addEventListener('message', onMessage)
  const load = () => new Promise((resolve) => {
    settle(false)
    pending = { resolve, timer: setTimeout(() => settle(false), readyMs) }
    iframe.srcdoc = html // a new document and a new global object for every page
  })
  const navigate = (p) => {
    if (destroyed) return Promise.resolve(false)
    current = typeof p === 'string' && p ? p : '/'
    return load()
  }
  container.appendChild(iframe)
  const rendered = await load()
  return {
    iframe,
    door: true,
    degraded: true,
    rendered,
    navigate,
    currentPath: () => current,
    destroy () {
      if (destroyed) return
      destroyed = true
      settle(false)
      win.removeEventListener('message', onMessage)
      if (port) { try { port.close() } catch (_) { /* gone */ } }
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe)
    }
  }
}

// ---- the renderer inside the frame (built as /_mw/door-frame.js; the frame's only code) -----------------------------------

const MIME = { html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', txt: 'text/plain', xml: 'application/xml', wasm: 'application/wasm' }

/** doorMimeOf(path, blob) → the blob's own type, else the type of the path's extension, else application/octet-stream. */
export function doorMimeOf (path, blob) {
  if (blob && blob.type) return blob.type
  const ext = (/\.([a-z0-9]+)$/i.exec(path || '') || [])[1]
  return MIME[(ext || '').toLowerCase()] || 'application/octet-stream'
}

function dirOfPath (p) {
  const i = String(p || '').lastIndexOf('/')
  return i === -1 ? '' : p.slice(0, i + 1)
}

/**
 * buildDoorDocument({ g, files, path, routing, base, sdk }) → Promise<{ html, title, path, external }>: the page for `path` with every
 * reference to a site file turned into a blob: URL this frame made (src, href, srcset, poster, CSS url() and @import, module
 * specifiers through one import map where import maps exist), /_mw/sdk.js turned into the SDK the door page passed, other /_mw/
 * references sent to the door, a <base> at the door so anything else resolves there, and the site's own CSP meta tags removed (the
 * door page's policy applies to the frame). Runs inside the frame: g is its window.
 */
export async function buildDoorDocument ({ g, files, path = '/', routing = null, base = '', sdk = null }) {
  const has = (p) => files.has(p)
  const urls = new Map()
  const text = new Map()
  const blobUrl = (blob, type) => g.URL.createObjectURL(blob.type === type ? blob : new g.Blob([blob], { type }))
  const fileUrl = (p) => {
    if (urls.has(p)) return urls.get(p)
    const blob = files.get(p)
    if (!blob) return null
    const u = blobUrl(blob, doorMimeOf(p, blob))
    urls.set(p, u)
    return u
  }
  const read = (p) => {
    if (!text.has(p)) text.set(p, files.get(p).text())
    return text.get(p)
  }
  const sdkUrl = sdk && typeof sdk.size === 'number' ? blobUrl(sdk, 'text/javascript') : null
  const mwUrl = (target) => (target === '_mw/sdk.js' && sdkUrl ? sdkUrl : base + target)
  const cssUrl = async (p, stack = []) => {
    const key = 'css:' + p
    if (urls.has(key)) return urls.get(key)
    if (!files.has(p)) return null
    if (stack.indexOf(p) >= 0) return fileUrl(p)
    const css = await read(p)
    const nested = new Map()
    const imports = []
    String(css).replace(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1/gi, (w, q, ref) => { imports.push(ref); return w })
    for (const ref of imports) {
      const target = resolveRef(p, ref)
      if (target && files.has(target)) nested.set(target, await cssUrl(target, stack.concat(p)))
    }
    const out = rewriteCssText(css, p, (t) => nested.get(t) || fileUrl(t))
    const u = g.URL.createObjectURL(new g.Blob([out], { type: 'text/css' }))
    urls.set(key, u)
    return u
  }
  let importMaps = false
  try { importMaps = !!(g.HTMLScriptElement && typeof g.HTMLScriptElement.supports === 'function' && g.HTMLScriptElement.supports('importmap')) } catch (_) { importMaps = false }
  const keyOf = (p) => base + p
  const mapped = new Map()
  const specifier = (basePath, spec) => {
    if (!(spec.startsWith('/') || spec.startsWith('./') || spec.startsWith('../'))) return null
    const target = resolveRef(basePath, spec)
    if (target === null) return null
    if (('/' + target).startsWith('/_mw/')) return { key: importMaps ? keyOf(target) : mwUrl(target), target: null, mw: target }
    return files.has(target) ? { key: importMaps ? keyOf(target) : null, target, mw: null } : null
  }
  const mapModule = async (p) => {
    if (mapped.has(p)) return mapped.get(p)
    mapped.set(p, null)
    const deps = []
    const out = rewriteModuleSpecifiers(await read(p), (s) => {
      const k = specifier(p, s)
      if (k && k.target) deps.push(k.target)
      return k ? k.key : null
    })
    const u = g.URL.createObjectURL(new g.Blob([out], { type: 'text/javascript' }))
    mapped.set(p, u)
    for (const d of deps) await mapModule(d)
    return u
  }
  const moduleUrl = async (p, stack = []) => {
    if (importMaps) return mapModule(p)
    const key = 'mjs:' + p
    if (urls.has(key)) return urls.get(key)
    if (!files.has(p)) return null
    if (stack.indexOf(p) >= 0) return fileUrl(p) // a cycle without import maps: the plain file (a documented limit)
    const out = await rewriteModule(await read(p), p, stack.concat(p))
    const u = g.URL.createObjectURL(new g.Blob([out], { type: 'text/javascript' }))
    urls.set(key, u)
    return u
  }
  const rewriteModule = async (code, basePath, stack) => {
    if (importMaps) {
      const deps = []
      const out = rewriteModuleSpecifiers(code, (s) => {
        const k = specifier(basePath, s)
        if (k && k.target) deps.push(k.target)
        return k ? k.key : null
      })
      for (const d of deps) await mapModule(d)
      return out
    }
    const specs = new Set()
    rewriteModuleSpecifiers(code, (s) => { specs.add(s); return null })
    const swap = new Map()
    for (const s of specs) {
      const k = specifier(basePath, s)
      if (!k) continue
      if (k.mw) swap.set(s, mwUrl(k.mw))
      else if (k.target) swap.set(s, await moduleUrl(k.target, stack))
    }
    return rewriteModuleSpecifiers(code, (s) => swap.get(s) || null)
  }

  let target = typeof path === 'string' && path ? path : '/'
  let route = resolveSitePath(routing, target, has)
  for (let i = 0; route.redirect && i < 5; i++) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(route.redirect) || route.redirect.startsWith('//')) return { html: '', title: '', path: target, external: route.redirect }
    target = route.redirect
    route = resolveSitePath(routing, target, has)
  }
  if (!route.path || !files.has(route.path)) {
    return { html: '<!doctype html><title>Not found</title><p>Not found</p>', title: 'Not found', path: target, external: null }
  }
  const docPath = route.path
  const page = new g.DOMParser().parseFromString(await read(docPath), 'text/html')
  for (const m of Array.from(page.querySelectorAll('meta[http-equiv]'))) if (/content-security-policy/i.test(m.getAttribute('http-equiv') || '')) m.remove()
  for (const b of Array.from(page.querySelectorAll('base'))) b.remove()
  const baseEl = page.createElement('base')
  baseEl.setAttribute('href', base + dirOfPath(docPath))
  page.head.insertBefore(baseEl, page.head.firstChild)
  let siteMap = null
  if (importMaps) {
    for (const s of Array.from(page.querySelectorAll('script[type="importmap"]'))) {
      if (!siteMap) { try { siteMap = JSON.parse(s.textContent || '{}') } catch (_) { siteMap = null } }
      s.remove()
    }
  }
  const swapAttr = (el, attr) => {
    const t = resolveRef(docPath, el.getAttribute(attr))
    if (t === null) return
    if (('/' + t).startsWith('/_mw/')) { el.setAttribute(attr, mwUrl(t)); return }
    const u = fileUrl(t)
    if (u) el.setAttribute(attr, u)
  }
  for (const link of Array.from(page.querySelectorAll('link[href]'))) {
    const rel = (link.getAttribute('rel') || '').toLowerCase().split(/\s+/)
    const t = resolveRef(docPath, link.getAttribute('href'))
    if (t !== null && rel.indexOf('stylesheet') >= 0 && files.has(t)) {
      link.setAttribute('href', await cssUrl(t))
      link.removeAttribute('integrity')
    } else if (t !== null && rel.indexOf('modulepreload') >= 0 && files.has(t)) {
      link.setAttribute('href', await moduleUrl(t))
      link.removeAttribute('integrity')
    } else if (rel.indexOf('manifest') >= 0 || rel.indexOf('serviceworker') >= 0) {
      link.remove()
    } else {
      swapAttr(link, 'href')
    }
  }
  for (const s of Array.from(page.querySelectorAll('script'))) {
    const type = (s.getAttribute('type') || '').trim().toLowerCase()
    const isModule = type === 'module'
    const isClassic = !type || type === 'text/javascript' || type === 'application/javascript'
    if (!isModule && !isClassic) continue
    s.removeAttribute('integrity')
    if (s.hasAttribute('src')) {
      const t = resolveRef(docPath, s.getAttribute('src'))
      if (t === null) continue
      if (('/' + t).startsWith('/_mw/')) { s.setAttribute('src', mwUrl(t)); continue }
      if (!files.has(t)) continue
      s.setAttribute('src', isModule ? await moduleUrl(t) : fileUrl(t))
    } else if (isModule) {
      s.textContent = await rewriteModule(s.textContent || '', docPath, [docPath])
    }
  }
  for (const el of Array.from(page.querySelectorAll('[src]'))) if (el.tagName !== 'SCRIPT') swapAttr(el, 'src')
  for (const el of Array.from(page.querySelectorAll('[poster]'))) swapAttr(el, 'poster')
  for (const el of Array.from(page.querySelectorAll('[srcset]'))) el.setAttribute('srcset', rewriteSrcset(el.getAttribute('srcset'), docPath, (t) => fileUrl(t)))
  for (const el of Array.from(page.querySelectorAll('style'))) el.textContent = rewriteCssText(el.textContent || '', docPath, (t) => fileUrl(t))
  for (const el of Array.from(page.querySelectorAll('[style]'))) el.setAttribute('style', rewriteCssText(el.getAttribute('style') || '', docPath, (t) => fileUrl(t)))
  for (const el of Array.from(page.querySelectorAll('use[href], image[href]'))) swapAttr(el, 'href')
  if (importMaps) {
    const imports = {}
    const scopes = {}
    const remap = async (value) => {
      if (typeof value !== 'string') return value
      const t = resolveRef(docPath, value)
      if (t === null || !files.has(t)) return value
      return (await mapModule(t)) || value
    }
    if (siteMap && siteMap.imports && typeof siteMap.imports === 'object') for (const [k, v] of Object.entries(siteMap.imports)) imports[k] = await remap(v)
    if (siteMap && siteMap.scopes && typeof siteMap.scopes === 'object') {
      for (const [scope, entries] of Object.entries(siteMap.scopes)) {
        if (!entries || typeof entries !== 'object') continue
        scopes[scope] = {}
        for (const [k, v] of Object.entries(entries)) scopes[scope][k] = await remap(v)
      }
    }
    for (const [p, u] of mapped) if (u) imports[keyOf(p)] = u
    if (sdkUrl) imports[keyOf('_mw/sdk.js')] = sdkUrl
    const map = page.createElement('script')
    map.setAttribute('type', 'importmap')
    map.textContent = JSON.stringify(Object.keys(scopes).length ? { imports, scopes } : { imports })
    page.head.insertBefore(map, baseEl.nextSibling)
  }
  return { html: '<!doctype html>\n' + page.documentElement.outerHTML, title: page.title || '', path: target, external: null }
}

/**
 * frameMain(g): the renderer inside the door view (build.mjs bundles it as /_mw/door-frame.js; mountDoorView writes it into the
 * frame). It sends { mwDoor: 'ready', v: 1 } with a MessagePort to the parent, waits for the files on that port, writes the page
 * into its own document (so the blob: URLs it made belong to the frame's origin), sets window.__mwDoor = true for the SDK, and
 * turns clicks on links into { mwDoor: 'navigate', path } (another site page) or { mwDoor: 'external', url }. Nothing is stored.
 */
export function frameMain (g) {
  if (!g || !g.document || !g.parent || g.parent === g || g.__mwDoorRenderer) return
  g.__mwDoorRenderer = true
  const MC = g.MessageChannel
  if (typeof MC !== 'function') return
  const ch = new MC()
  const port = ch.port1
  let base = ''
  let current = '/'
  const say = (m) => { try { port.postMessage(m) } catch (_) { /* the door page went away */ } }
  const sitePathOf = (href) => {
    if (typeof href !== 'string' || !href) return null
    let u
    try { u = new g.URL(href, base + current.replace(/^\//, '')) } catch (_) { return null }
    let b
    try { b = new g.URL(base) } catch (_) { return null }
    if (u.origin !== b.origin) return { external: u.href }
    if (u.pathname.startsWith('/_mw/')) return { external: u.href }
    return { path: u.pathname + u.search + u.hash }
  }
  const onClick = (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    let n = e.target
    while (n && !(n.tagName === 'A' && n.hasAttribute && n.hasAttribute('href'))) n = n.parentNode
    if (!n) return
    const raw = n.getAttribute('href') || ''
    if (raw.startsWith('#')) return // an anchor on this page: the browser scrolls
    if (/^(javascript|blob|data):/i.test(raw)) return
    const where = sitePathOf(raw)
    if (!where) return
    e.preventDefault()
    if (where.external) say({ mwDoor: 'external', url: where.external })
    else say({ mwDoor: 'navigate', path: where.path })
  }
  port.onmessage = (ev) => {
    const d = ev && ev.data
    if (!d || d.mwDoor !== 'render' || !Array.isArray(d.files)) return
    const files = new Map()
    for (const pair of d.files) if (Array.isArray(pair) && typeof pair[0] === 'string' && pair[1] && typeof pair[1].size === 'number') files.set(cleanSitePath(pair[0]), pair[1])
    base = typeof d.base === 'string' && d.base ? d.base.replace(/\/?$/, '/') : ''
    current = typeof d.path === 'string' && d.path ? d.path : '/'
    buildDoorDocument({ g, files, path: current, routing: d.routing || null, base, sdk: d.sdk || null }).then((out) => {
      if (out.external) { say({ mwDoor: 'external', url: out.external }); say({ mwDoor: 'rendered', title: '', path: current }); return }
      g.__mwDoor = true
      const doc = g.document
      doc.open()
      doc.write(out.html)
      doc.close()
      doc.addEventListener('click', onClick, true)
      say({ mwDoor: 'rendered', title: out.title || doc.title || '', path: out.path || current })
    }, (err) => say({ mwDoor: 'error', message: String((err && err.message) || err).slice(0, 200) }))
  }
  g.parent.postMessage({ mwDoor: 'ready', v: 1 }, '*', [ch.port2])
}

export { hostOfOrigin }
