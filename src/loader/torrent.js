// src/loader/torrent.js: TorrentManager (INTERFACES "src/loader/torrent.js", ARCHITECTURE §1, §5.4,
// §5.5, §8, §13; DESIGN-REVIEW items 10, 12, 13, 14, 15, 18, 19, S1, S4, S5; v0.2.1 DIGEST-AMENDMENTS B1,
// B2, B4, B5, B6).
//
// Facts from webtorrent 3.0.21 / bittorrent-protocol 5.0.9 / bittorrent-tracker 11.2.3 this file
// relies on (verified in node_modules):
//  - Torrent emits 'wire' from _onWire right after the remote handshake and before our extended
//    handshake is sent; the extended handshake is never re-sent. Listeners are therefore attached
//    synchronously on the Torrent returned by client.add() (and a 'torrent' event lets the ledger
//    attach its extension in the same tick). wire.extendedHandshake.reqq set there is advertised.
//  - bittorrent-protocol queues `this._parse(4, this._onMessageLength)` right after the 'handshake'
//    listeners return, so an own-property wrapper installed inside 'wire' sees every length prefix.
//    The prefix is read unsigned here (the library reads it signed, so 0x80000000 and above look like
//    keep-alives and 0x7FFFFFFF is buffered without limit) and anything above
//    CONFIG.wire.maxMessageBytes destroys the wire before a byte is buffered. A periodic watchdog on
//    the private _bufferSize field is the second line (a unit test fails if the field disappears).
//  - The upload throttle sits on every outbound byte of a wire (handshake, requests, extension
//    frames): "uploads off" is a choke lock, never throttleUpload(0).
//  - With per-torrent `private: true` the client-level tracker list is never appended, so the
//    announce list is exactly what we pass (signed tr= list, defaults only for unsigned pointers).
//  - Web seeds attach only after metadata; xs= (fetched here first) makes a peerless cold start work.
//    A host that ignores Range or serves wrong bytes makes stock WebTorrent re-request the piece at
//    once (23,240 requests in 4 s measured): the web-seed circuit breaker below stops that host.
//  - WebSocket trackers close idle sockets after about 125 to 188 s, and tracker.openwebtorrent.com
//    closes the socket on scrape: the keepalive is an offer-free announce (numwant: 0) on any socket
//    silent for CONFIG.wire.keepaliveAnnounceMs (sockets are pooled per tracker URL). After a tracker
//    blip the stock client waits 10 s x 2^n + U(0, 5 min) (median 174 s measured) and ignores
//    announce() meanwhile: a per-instance _startReconnectTimer brings it back in 1 to 2 s.
//  - WebRTC wires are not capped by client.maxConns (it gates only TCP dials): soft and hard caps per
//    swarm are enforced here after the extended handshake, and numwant drops to 0 at the soft cap.
//  - A torrent without metadata announces left = NaN (JSON null, a seeder for the reference tracker)
//    and runs ut_metadata.fetch() on every wire: the ledger rendezvous swarm announces left: 1 and
//    cancels ut_metadata on its wires.
//
// v0.3 hardening (harden-loader; V03-DESIGN-REVIEW 2.7.1, 2.16.4; MF-39, MF-44, MF-45, MF-74 to MF-76):
//  - caps count wires, never peer ids (one remote that reuses a peer id on many wires fills as many slots
//    as it has wires); up to wireLimits.anchorShare of a swarm's hard cap is kept for anchored wires (they
//    delivered verified pieces, or a caller vouched with anchorWire(): valid ledger blocks); eviction is
//    the lowest score first with random order among equal scores (no tenure tie-break to game);
//  - one wire budget per tab across every swarm (policy.wireBudget: desktop 40, phones 8, chosen), priority
//    site > rendezvous > chat > group > file: over budget the lowest priority swarm above its floor loses a wire;
//  - wires closed: ignored ones (ignoreWire(), or wire.__mwIgnored set by an extension), and wires with no
//    message but keep-alives for wireLimits.idleMs (2 min) after the handshake; 'no-progress' { kind } fires
//    when a swarm has wires but nothing arrives (lane sdk polls cs= on it);
//  - ut_metadata requests beyond 4 per wire per minute are dropped once the metadata is complete (the
//    library answers each with up to 16 KiB, past the choke lock);
//  - unsigned records: ws= and xs= go through filterWebseeds (src/common/magnet.js, MF-76);
//  - hooks for other lanes: addFileTorrent() (injected abstract-chunk-store, own trackers only, stores kept
//    across rebuild()), joinLane() (chat and group lanes) and registerWireExtension() (an extension on the
//    wires of chosen swarm kinds, installed after the 262,144-byte wire guard);
//  - every timer the manager arms is clamped to 2^31 - 1 ms (MF-30).
//
// v0.3 C2 smart seeding (lane seed-engine; docs/research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md 3.1; every insertion
// below is marked "C2 seed-engine"; changes in docs/deviations/seed-engine.md):
//  - setSeedBudget(budget) (a seedBudget() result of src/loader/seed-budget.js) turns on per-lane token buckets: the
//    site torrent is lane K; a file torrent is H when its handle has the per-upload exception (an own upload), K when
//    the person chose to keep sharing, else E (addFileTorrent({ lane }), handle.lane, handle.setLane()). A lane whose
//    bucket, session cap or month cap (K and E only) is used up has its wires choke-locked (lockWire) and unlocked when
//    the bucket is full again (1 s of the rate: about 1 s of hysteresis); the client throttle is the sum of the rates
//    of the lanes with an unlocked wire, never throttleUpload(0). Without a budget nothing of this applies: v0.2.1 and
//    v0.3 behaviour (uploadsEnabled, the per-upload exception) is unchanged. Wires outside the lanes (ledger
//    rendezvous, chat and group lanes) keep the v0.3 rules: ledger gossip stays outside the lanes;
//  - uploaded piece bytes feed the seed meters (src/loader/seed-meters.js) by lane, with local = a host-to-host
//    candidate pair (src/loader/localwire.js isLocalPair on the simple-peer connection's stats, read once after
//    connect; false when unreadable): local bytes have the local row and stay out of the month cap;
//  - src/loader/seed-planner.js planSeeding orders which items get budget (E by copy deficit, pinned and incomplete E
//    items idle) and gives each its share of the lane rate; setHiddenLock keeps H wires unlocked only with
//    budget.hiddenH (owner decision SZ-2, default off);
//  - complete bitfields per infohash give the E1 evidence of src/loader/availability.js; evidenceFor(ih) adds the pin
//    source (src/loader/pinwire.js: receipts, heartbeat) and emits 'evidence' { infoHash, kind, evidence } when what a
//    label would show changes; an H handle moves to K at a pin receipt or two complete peer copies (SZ 3.1.2);
//  - behind CONFIG.seed.superSeed (default false) an H torrent on a phone is super-seeded (src/loader/superseed.js).

import { CONFIG } from './config.js'
import { readCappedBody } from '../common/read-capped.js'
import { filterWebseeds } from '../common/magnet.js'
import { wireBudgetFor, budgetVictim, allocateWireBudget, budgetPriority } from './policy.js'
// C2 seed-engine: the seed planner and local-wire test of lane seed-policy, the meters, availability, super-seeding.
import { planSeeding as defaultPlanSeeding } from './seed-planner.js'
import { isLocalPair as defaultIsLocalPair } from './localwire.js'
import { createSeedMeters } from './seed-meters.js'
import { evidence as availabilityEvidence, sameEvidence } from './availability.js'
import { SuperSeed } from './superseed.js'

const BTIH_RE = /^[0-9a-f]{40}$/
const MAX_TORRENT_FILE_BYTES = 8 * 1024 * 1024
/** setTimeout's largest honoured delay; larger values overflow to 0 (v0.3, MF-30). */
const MAX_TIMER_MS = 2147483647
/**
 * Swarm kinds a wire can belong to (v0.3). 'site' and 'rendezvous' as before; 'chat', 'group' lanes; 'file' torrents;
 * 'hub' the follow lane of a hub page (review round R 5.3, SCALE-6), with its own cap and, while it syncs, first place.
 */
export const SWARM_KINDS = Object.freeze(['site', 'rendezvous', 'hub', 'chat', 'group', 'file'])
/**
 * The swarms that use the site's own STUN servers only (R 2.7.1, MF-44; code review v0.3 conformance): chat, groups,
 * files and private media never gather ICE through the public default STUN operators of the ledger and content swarms.
 */
export const OWN_STUN_KINDS = Object.freeze(['chat', 'group', 'file'])
const OWN_STUN_SET = new Set(OWN_STUN_KINDS)
const STUN_URL_RE = /^stuns?:[A-Za-z0-9.[\]:-]{1,253}$/

/**
 * laneIceServersOf(list) -> [{ urls }]: the site's own STUN servers as iceServers (at most 4; 'stun:' or 'stuns:' URLs,
 * strings or { urls } objects). Anything else is dropped; an empty result means "no STUN server" (host candidates only),
 * never the shared defaults.
 */
export function laneIceServersOf (list) {
  const out = []
  for (const x of Array.isArray(list) ? list : []) {
    const urls = typeof x === 'string' ? x : (x && typeof x === 'object' ? x.urls : null)
    const one = Array.isArray(urls) ? urls[0] : urls
    if (typeof one === 'string' && STUN_URL_RE.test(one.trim()) && out.length < 4) out.push({ urls: one.trim() })
  }
  return out
}
/** Extension names other lanes may not register (the library's own, and the ledger's, attached elsewhere). */
const RESERVED_EXTENSIONS = new Set(['ut_metadata', 'ut_pex', 'lt_donthave', 'mw_chain1', 'mw_chain2'])
const EXTENSION_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/
// Wire events that count as the remote saying something (keep-alives do not, so an idle wire stays idle).
const ACTIVITY_EVENTS = ['choke', 'unchoke', 'interested', 'uninterested', 'have', 'bitfield', 'request', 'piece', 'cancel', 'extended', 'port', 'download']

function clampMs (ms) {
  const n = Number(ms)
  if (!Number.isFinite(n)) return n === Infinity ? MAX_TIMER_MS : 0
  return Math.min(MAX_TIMER_MS, Math.max(0, n))
}

export { readCappedBody } // re-exported for the tests (src/common/read-capped.js)

/** The worker's own /_mw/ws/ rewrite on this origin (drop-in), which answers pad files itself. */
function isOwnRewrite (url, origin) {
  try {
    const u = new URL(url)
    return !!origin && u.origin === origin && u.pathname.indexOf('/_mw/ws/') === 0
  } catch (_) { return false }
}
const PIECE_FAIL_RE = /Piece (\d+) failed verification/
const WEBSEED_ATTRIBUTION_MS = 15000 // a hash failure counts against the web seed that sent the piece this recently

export const TORRENT_ERRORS = Object.freeze(['E_TOO_LARGE', 'E_TIMEOUT', 'E_NO_PEERS', 'E_ABORTED', 'E_BAD_TORRENT'])

export function makeError (code, message, extra) {
  const err = new Error(message || code)
  err.code = code
  if (extra) Object.assign(err, extra)
  return err
}

function noop () {}
const microtask = typeof queueMicrotask === 'function' ? queueMicrotask : (fn) => Promise.resolve().then(fn)
function errText (err) { return (err && err.message) || String(err) }

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

function uniqueTrackerUrls (list) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw !== 'string') continue
    const url = raw.trim().replace(/\/+$/, '')
    if (!/^wss?:\/\/[^\s]+$/i.test(url) || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

/**
 * announceListFor(record, defaults) → tracker URLs for client.add({ announce, private: true }).
 * Signed pointer: exactly its tr= list (possibly empty). Unsigned pointer or bare magnet: its tr=
 * entries followed by the defaults (DESIGN-REVIEW item 12).
 */
export function announceListFor (record, defaults = CONFIG.trackers) {
  const tr = uniqueTrackerUrls(record && record.tr)
  if (record && record.signed) return tr
  return uniqueTrackerUrls(tr.concat(Array.isArray(defaults) ? defaults : []))
}

// v0.3 (MF-76): the ws= and xs= lists an unsigned record may use (filterWebseeds: at most 4 ws= and 2 xs=,
// https on public hosts or the page's own origin). Signed records keep theirs.
function filteredLists (record, base) {
  const ws = (record && Array.isArray(record.ws)) ? record.ws : []
  const xs = (record && Array.isArray(record.xs)) ? record.xs : []
  if (record && record.signed) return { ws, xs }
  let origin = null
  try { origin = base ? new URL(base).origin : null } catch (_) { origin = null }
  const f = filterWebseeds({ ws, xs }, { origin, signed: false, base: base || null })
  return { ws: f.ws, xs: f.xs }
}

/**
 * xs= URLs resolved against the page (drop-in uses a root-relative xs), http(s) only. v0.3: an unsigned
 * record's list goes through filterWebseeds first (MF-76).
 */
export function xsUrls (record, base) {
  const out = []
  for (const raw of filteredLists(record, base).xs) {
    try {
      const u = new URL(String(raw), base || undefined)
      if (u.protocol === 'https:' || u.protocol === 'http:') out.push(u.href)
    } catch (_) { /* skip malformed */ }
  }
  return out
}

/** ws= URLs resolved against the page, http(s) only; an unsigned record's list is filtered first (v0.3, MF-76). */
export function webseedBases (record, base) {
  const out = []
  for (const raw of filteredLists(record, base).ws) {
    try {
      const u = new URL(String(raw), base || undefined)
      if (u.protocol === 'https:' || u.protocol === 'http:') out.push(u.href)
    } catch (_) { /* skip malformed */ }
  }
  return out
}

/**
 * orderWebseeds(urls, origin) → the web seeds cheapest first (v0.2.1 B4): the page's own origin first
 * (the static host the visitor already loads from, no CORS), then the pointer's order (the owner lists
 * the cheaper hosts first).
 */
export function orderWebseeds (urls, origin) {
  const list = Array.isArray(urls) ? urls.filter((u) => typeof u === 'string') : []
  const own = []
  const other = []
  for (const u of list) {
    let same = false
    try { same = !!origin && new URL(u).origin === origin } catch (_) { same = false }
    ;(same ? own : other).push(u)
  }
  return own.concat(other)
}

/**
 * The URL webtorrent's web-seed connection requests for the first non-empty file (webconn.js):
 * single-file torrents use the ws URL verbatim, multi-file ones '<ws>/<torrent name>/<path>'.
 */
export function webseedFileUrl (wsBase, parsed) {
  if (!wsBase || !parsed || !Array.isArray(parsed.files)) return null
  const files = parsed.files
  if (files.length <= 1) return wsBase
  const file = files.find((f) => f && !f.pad && f.length > 0) || files.find((f) => f && !f.pad)
  if (!file) return null
  return wsBase + (wsBase.endsWith('/') ? '' : '/') + parsed.name + '/' + String(file.path).replace(/^\/+/, '')
}

/** 'd4:info' + <info bytes> + 'e': same infohash, no announce or url-list to merge. */
export function minimalTorrentBytes (infoBytes) {
  const head = [0x64, 0x34, 0x3a, 0x69, 0x6e, 0x66, 0x6f] // d4:info
  const out = new Uint8Array(head.length + infoBytes.length + 1)
  out.set(head, 0)
  out.set(infoBytes, head.length)
  out[out.length - 1] = 0x65 // e
  return out
}

export function computeSource ({ fromCache = false, peerBytes = 0, webseedBytes = 0 } = {}) {
  if (fromCache) return 'cache'
  if (peerBytes > 0 && webseedBytes > 0) return 'mixed'
  if (webseedBytes > 0) return 'webseed'
  if (peerBytes > 0) return 'peers'
  return null
}

/** State of one bittorrent-tracker WebSocketTracker (socket pooled per URL). */
export function trackerStateOf (t) {
  if (!t) return 'closed'
  if (t.reconnecting) return 'reconnecting'
  if (t.destroyed) return 'closed'
  return t.socket && t.socket.connected ? 'open' : 'connecting'
}

/**
 * classifyFailures(input) → [{ row, count?, detail? }] for the diagnostics panel (ARCHITECTURE §5.10,
 * DESIGN-REVIEW S5). Rows: 'no-webseed', 'webseed-broken', 'tracker-unreachable', 'nat',
 * 'nobody-online'. input: { peersAllowed, hostOnly, trackers: { url: state }, iceFailed, peers,
 * swarm: { reported, others }, hasWebseed, webseed: 'ok'|reason|null, elapsedMs, done, graceMs }.
 */
export function classifyFailures ({
  peersAllowed = true, hostOnly = false, trackers = {}, iceFailed = 0, peers = 0, swarm = null,
  hasWebseed = true, webseed = null, elapsedMs = 0, done = false, graceMs = 5000
} = {}) {
  const rows = []
  if (!hasWebseed) rows.push({ row: 'no-webseed' })
  if (webseed && webseed !== 'ok') rows.push({ row: 'webseed-broken', detail: webseed })
  if (!peersAllowed || hostOnly) return rows
  const urls = Object.keys(trackers || {})
  const open = urls.filter((u) => trackers[u] === 'open').length
  if (elapsedMs >= graceMs && open === 0) {
    rows.push({ row: 'tracker-unreachable', count: urls.length - open, detail: urls.length ? (urls.length - open) + '/' + urls.length : 'none' })
  }
  if (iceFailed > 0 && peers === 0) rows.push({ row: 'nat', count: iceFailed })
  if (!done && peers === 0 && swarm && swarm.reported && swarm.others <= 0) rows.push({ row: 'nobody-online' })
  return rows
}

/** Unsigned big-endian 32-bit length prefix (bittorrent-protocol reads it signed). */
export function messageLength (buffer) {
  return ((buffer[0] << 24) | (buffer[1] << 16) | (buffer[2] << 8) | buffer[3]) >>> 0
}

/**
 * rendezvousInfoHash(ledgerId) → Promise<40 hex>: sha1hex(utf8("mw-ledger/1/" + ledgerId)), the bare
 * infohash of the ledger rendezvous swarm (v0.2.1 B2; research w1-12 R1). Not a torrent: nobody seeds it,
 * and visitors of every site version of one ledger meet there.
 */
export async function rendezvousInfoHash (ledgerId, { prefix = CONFIG.ledger.rendezvousPrefix } = {}) {
  if (typeof ledgerId !== 'string' || !ledgerId) throw new TypeError('rendezvousInfoHash needs a ledger id')
  const subtle = globalThis.crypto && globalThis.crypto.subtle
  if (!subtle) throw makeError('E_TORRENT', 'WebCrypto is unavailable')
  const digest = new Uint8Array(await subtle.digest('SHA-1', new TextEncoder().encode(prefix + ledgerId)))
  let hex = ''
  for (const b of digest) hex += (b < 16 ? '0' : '') + b.toString(16)
  return hex
}

/**
 * reqqFor(uploadLimitBps, cfg) → the request-queue length we advertise on content wires (v0.2.1 B6;
 * research w1-12 R3): clamp(round(limit x 0.25 / 16 KiB), 4, 32), 32 when unshaped. It bounds how much
 * piece data a peer queues ahead of a ledger frame on the same wire (head-of-line delay).
 */
export function reqqFor (uploadLimitBps, cfg = CONFIG.wireGuard) {
  const lim = Number(uploadLimitBps)
  if (!Number.isFinite(lim) || lim < 0) return cfg.reqqUnlimited
  if (lim === 0) return cfg.reqqMin
  return Math.max(cfg.reqqMin, Math.min(cfg.reqqMax, Math.round(lim * 0.25 / 16384)))
}

/**
 * wireScore(wire) → higher is more useful (v0.2.1 B6): a peer that speaks the ledger extension first,
 * then the bytes exchanged with it. Over the hard cap the lowest score goes first, newest first on ties.
 */
export function wireScore (wire) {
  if (!wire) return 0
  const mapping = wire.peerExtendedMapping || {}
  const chain = mapping.mw_chain1 ? 1e12 : 0
  return chain + (Number(wire.downloaded) || 0) + (Number(wire.uploaded) || 0)
}

/**
 * installTrackerShim(t, { timers, random, now, baseMs, jitterMs, maxMs }) → true when installed on one
 * bittorrent-tracker WebSocketTracker (v0.2.1 B1; research w2b-01 F7, R4). Internal API of
 * bittorrent-tracker 11.2.3, pinned by build.lock.json and covered by unit tests:
 *  - _startReconnectTimer: 500 ms + U(0, min(60 s, 1 s x 2^retries)) instead of 10 s x 2^n + U(0, 5 min);
 *    never reopens a socket for a destroyed tracker client.
 *  - _send: remembers when this instance last sent (keepalive bookkeeping).
 *  - setInterval: a server interval that did not change does not restart the regular announce timer, so
 *    offer-free keepalive announces in between never postpone the regular announce.
 *  - destroy (v0.2.1 verifier fix): bittorrent-tracker clears the announce interval there but keeps the
 *    cleared id in this.interval; the shim forgets the interval it saw, so the first response after a
 *    reconnect starts the regular announce timer again (it used to stay stopped for good).
 *  - _openSocket (v0.2.1 verifier fix): bittorrent-tracker registers 'connect' only on a socket it creates;
 *    an instance that joins a pooled socket that is still connecting (the site and the rendezvous swarm on one
 *    tracker URL, both reconnecting within the shim's short window) never re-announced. The shim adds the
 *    missing 'connect' hook; _onSocketConnect() does nothing once the instance is no longer reconnecting.
 */
export function installTrackerShim (t, { timers = null, random = Math.random, now = () => Date.now(), baseMs = 500, jitterMs = 1000, maxMs = 60000 } = {}) {
  if (!t || t.__mwShim || typeof t._startReconnectTimer !== 'function' || typeof t._openSocket !== 'function') return false
  const tm = timers || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) }
  t.__mwShim = true
  t.__mwInstalledAt = now()
  t._startReconnectTimer = function mwFastReconnect () {
    const retries = Math.max(0, Number(this.retries) || 0)
    const ms = Math.round(baseMs + random() * Math.min(maxMs, jitterMs * Math.pow(2, Math.min(retries, 16))))
    this.reconnecting = true
    if (this.reconnectTimer) {
      try { tm.clearTimeout(this.reconnectTimer) } catch (_) { /* not ours */ }
      try { clearTimeout(this.reconnectTimer) } catch (_) { /* not a host timer */ }
    }
    const timer = tm.setTimeout(() => {
      if (this.reconnectTimer !== timer) return
      this.reconnectTimer = null
      if (!this.reconnecting || (this.client && this.client.destroyed)) return
      this.retries = retries + 1
      try { this._openSocket() } catch (_) { /* the next close schedules another try */ }
    }, ms)
    this.reconnectTimer = timer
    this.__mwReconnectMs = ms
  }
  if (typeof t._send === 'function') {
    const send = t._send
    t._send = function mwSend (params) {
      this.__mwLastSend = now()
      return send.call(this, params)
    }
  }
  if (typeof t.setInterval === 'function') {
    const setInt = t.setInterval
    t.setInterval = function mwSetInterval (ms) {
      if (ms !== undefined && ms !== null && ms === this.__mwIntervalMs && this.interval) return
      this.__mwIntervalMs = ms
      return setInt.call(this, ms)
    }
  }
  if (typeof t.destroy === 'function') {
    const destroy = t.destroy
    t.destroy = function mwDestroy (...args) {
      this.__mwIntervalMs = null // the interval is cleared below: the next setInterval() must start it again
      return destroy.apply(this, args)
    }
  }
  const openSocket = t._openSocket
  t._openSocket = function mwOpenSocket (...args) {
    const r = openSocket.apply(this, args)
    const s = this.socket
    if (this.reconnecting && s && !s.connected && typeof s.once === 'function') {
      const self = this
      s.once('connect', () => {
        if (self.socket === s && self.reconnecting && !self.destroyed && typeof self._onSocketConnect === 'function') self._onSocketConnect()
      })
    }
    return r
  }
  return true
}

/**
 * keepaliveAnnounce(t) → true when sent: an offer-free announce (numwant 0, no event) on one tracker
 * instance. bittorrent-tracker merges getAnnounceOpts() after explicit options, so numwant is forced
 * after the defaults are built.
 */
export function keepaliveAnnounce (t) {
  if (!t || typeof t.announce !== 'function' || !t.client || typeof t.client._defaultAnnounceOpts !== 'function') return false
  const opts = Object.assign({}, t.client._defaultAnnounceOpts(), { numwant: 0 })
  delete opts.event
  t.announce(opts)
  return true
}

/**
 * guardWire(wire, { maxBytes, bufferBytes, onDrop }) → true when installed. Wraps wire._onMessageLength
 * (the patch point checked by a unit test against the vendored bundle): the length prefix is read
 * unsigned and a peer announcing more than maxBytes is destroyed before a byte of the message is
 * buffered. wire._write is wrapped too: a buffer that passes bufferBytes in any parse state (the private
 * _bufferSize field) also destroys the wire (DESIGN-REVIEW item 10, research w1-11 F11, digest P0-5).
 * Returns false (and installs nothing) when _onMessageLength is missing: the caller fails closed.
 */
export function guardWire (wire, { maxBytes = CONFIG.wire.maxMessageBytes, bufferBytes = CONFIG.wireGuard.bufferWatchdogBytes, onDrop = noop } = {}) {
  if (!wire || wire.__mwGuard) return false
  const original = wire._onMessageLength
  if (typeof original !== 'function') return false
  wire.__mwGuard = true
  const limit = Math.max(bufferBytes, maxBytes + 64)
  const drop = (self, length, reason) => {
    self.__mwDropped = true
    try { if (typeof self._parse === 'function') self._parse(Number.MAX_VALUE, noop); else self._parserSize = Number.MAX_VALUE } catch (_) { /* ignore */ }
    try { onDrop(length, reason) } catch (_) { /* diagnostics only */ }
    try { self.destroy() } catch (_) { /* already closing */ }
  }
  wire._onMessageLength = function mwGuardedMessageLength (buffer) {
    const length = messageLength(buffer)
    if (length > maxBytes) return drop(this, length, 'length')
    return original.call(this, buffer)
  }
  const write = wire._write
  if (typeof write === 'function') {
    wire._write = function mwGuardedWrite (data, cb) {
      if (this.destroyed || this.__mwDropped) return cb(null)
      write.call(this, data, cb)
      if (typeof this._bufferSize === 'number' && this._bufferSize > limit) drop(this, this._bufferSize, 'buffer')
    }
  }
  return true
}

/**
 * bufferOverflow(wire, bytes) → true when the wire's private receive buffer (_bufferSize, bittorrent-protocol
 * 5.0.9) holds more than bytes (v0.2.1 B5 watchdog). A wire without the field reports false; the unit
 * test "the _bufferSize field exists" fails first if an upgrade removes it.
 */
export function bufferOverflow (wire, bytes = CONFIG.wireGuard.bufferWatchdogBytes) {
  return !!(wire && typeof wire._bufferSize === 'number' && wire._bufferSize > bytes)
}

/**
 * throttleUtMetadata(wire, { perMinute, now, onDrop }) → true when installed (v0.3, MF-75). Wraps
 * wire.ut_metadata._onRequest (ut_metadata 4, the patch point a unit test checks in the vendored bundle):
 * once the metadata is complete, requests beyond perMinute in any 60 s window are dropped without an
 * answer (each answer is up to 16 KiB and is sent past the choke lock). Before the metadata is complete the
 * library only rejects, which costs nothing, so those are not counted.
 */
export function throttleUtMetadata (wire, { perMinute = CONFIG.wireLimits.utMetadataPerMinute, now = () => Date.now(), onDrop = noop } = {}) {
  const ext = wire && wire.ut_metadata
  if (!ext || ext.__mwThrottle || typeof ext._onRequest !== 'function') return false
  const original = ext._onRequest
  const times = []
  const limit = Math.max(0, Math.floor(Number(perMinute) || 0))
  ext.__mwThrottle = true
  ext._onRequest = function mwThrottledMetadataRequest (piece) {
    if (this._metadataComplete) {
      const t = now()
      while (times.length && t - times[0] >= 60000) times.shift()
      if (times.length >= limit) {
        try { onDrop(piece) } catch (_) { /* diagnostics only */ }
        return undefined
      }
      times.push(t)
    }
    return original.call(this, piece)
  }
  return true
}

/**
 * fileMetadataBound(expectedLength, maxBytes) → the largest info dictionary a file torrent of that length can honestly
 * have (review round R 5.3, MAL53-6): 20 bytes of piece hash per 16 KiB piece (the smallest piece length WebTorrent makes)
 * plus 1 KiB for the name and the other keys, never above maxBytes (the 256 KiB .torrent limit, R 2.8.3). Without a
 * length (an unknown listing) it is maxBytes.
 */
export function fileMetadataBound (expectedLength, maxBytes = 262144) {
  const max = Math.max(1024, Math.floor(Number(maxBytes) || 262144))
  const len = Number(expectedLength)
  if (!Number.isFinite(len) || len <= 0) return max
  return Math.min(max, 20 * Math.ceil(len / 16384) + 1024)
}

/**
 * guardMetadataSize(wire, { maxBytes, onRefuse }) → true when installed (MAL53-6). ut_metadata accepts a metadata_size up
 * to 10 MB from any peer, and WebTorrent builds a Piece, a reservation slot and a bitfield bit per piece of what arrives
 * before the files and media lanes can compare it with the listing (500,000 pieces, +104 MB of heap, measured). A file
 * wire whose extended handshake announces more than maxBytes gets no request: ut_metadata is cancelled, the wire is
 * destroyed and onRefuse(size) counts it.
 */
export function guardMetadataSize (wire, { maxBytes = 262144, onRefuse = noop } = {}) {
  const ext = wire && wire.ut_metadata
  if (!ext || ext.__mwMetaGuard || typeof ext.onExtendedHandshake !== 'function') return false
  const original = ext.onExtendedHandshake
  ext.__mwMetaGuard = true
  ext.onExtendedHandshake = function mwGuardedExtendedHandshake (handshake) {
    const size = handshake && handshake.metadata_size
    if (!this._metadataComplete && typeof size === 'number' && size > maxBytes) {
      try { this.cancel() } catch (_) { /* ignore */ }
      try { onRefuse(size) } catch (_) { /* diagnostics only */ }
      try { wire.destroy() } catch (_) { /* gone */ }
      return undefined
    }
    return original.call(this, handshake)
  }
  return true
}

/**
 * evictionOrder(entries, { keep, anchorSlots, random }) → the entries to drop so that `keep` remain (pure,
 * v0.3 MF-74). entries: [{ w, score, anchored }]. Up to anchorSlots anchored entries (highest score first)
 * are protected; the others go lowest score first, and entries with equal scores are ordered at random
 * (no tenure tie-break: a newcomer cannot be sure to outlive an honest wire, nor the reverse).
 */
export function evictionOrder (entries, { keep = 0, anchorSlots = 0, random = Math.random } = {}) {
  const list = Array.isArray(entries) ? entries.slice() : []
  const surplus = list.length - Math.max(0, keep)
  if (surplus <= 0) return []
  const anchored = list.filter((e) => e.anchored).sort((a, b) => b.score - a.score)
  const protectedSet = new Set(anchored.slice(0, Math.max(0, Math.floor(anchorSlots))))
  const keyed = list.map((e) => ({ e, r: random() }))
  keyed.sort((a, b) => {
    const pa = protectedSet.has(a.e) ? 1 : 0
    const pb = protectedSet.has(b.e) ? 1 : 0
    return (pa - pb) || (a.e.score - b.e.score) || (a.r - b.r)
  })
  return keyed.slice(0, surplus).map((k) => k.e)
}

// ---- choke lock ("uploads off") ---------------------------------------------------------------
// bittorrent-protocol ignores piece requests while amChoking; webtorrent unchokes on the first
// 'interested' and in its 10 s rechoke loop, so unchoke() is shadowed while the lock holds.

export function lockWire (wire) {
  if (!wire || wire.type === 'webSeed' || wire.__mwLock) return false
  wire.__mwLock = { own: Object.prototype.hasOwnProperty.call(wire, 'unchoke'), unchoke: wire.unchoke }
  try { if (typeof wire.choke === 'function') wire.choke() } catch (_) { /* wire closing */ }
  wire.unchoke = function mwLockedUnchoke () {}
  return true
}

export function unlockWire (wire) {
  const lock = wire && wire.__mwLock
  if (!lock) return false
  if (lock.own) wire.unchoke = lock.unchoke
  else delete wire.unchoke
  wire.__mwLock = null
  try { if (wire.peerInterested && typeof wire.unchoke === 'function') wire.unchoke() } catch (_) { /* ignore */ }
  return true
}

// ---- C2 seed-engine: lane token buckets (SZ 3.1.3) -----------------------------------------------
// One bucket per lane (and per local lane, and per planned item with a share below 1): it holds burstMs of its rate
// (at least 32 KiB) and refills continuously; a debit that empties it drains the bucket (its wires are choke-locked)
// until it is full again, which takes burstMs: about 1 s of hysteresis. A rate of Infinity never drains, 0 is locked.

/** The seed lanes in spending order (src/loader/seed-budget.js SEED_LANES). */
export const SEED_LANE_IDS = Object.freeze(['H', 'K', 'E'])
const SEED_BURST_MS = 1000
const SEED_MIN_BUCKET = 32768
/** E1: holders seen on a wire within this window count (availability.js WINDOWS.bitfieldMs). */
const HOLDER_WINDOW_MS = 60000
/** H ends at a pin receipt or this many complete peer copies (SZ 3.1.2). */
const HANDOFF_PEER_COPIES = 2
const LANE_RANK = { E: 0, K: 1, H: 2 }
/** At most this many seek ranges stay in front of a file torrent's whole-file selection (older ones are dropped). */
export const PRIORITY_RANGES_MAX = 8

/** createBucket(rate, now, burstMs) -> { rate, cap, tokens, at, drained, timer } (bytes per second; full at start). */
export function createBucket (rate, now, burstMs = SEED_BURST_MS) {
  const r = Number(rate)
  const finite = Number.isFinite(r)
  const cap = finite ? Math.max(SEED_MIN_BUCKET, Math.floor(Math.max(0, r) * burstMs / 1000)) : Infinity
  return { rate: finite ? Math.max(0, r) : (r === Infinity ? Infinity : 0), cap, tokens: cap, at: Number(now) || 0, drained: false, timer: null }
}

/** bucketLevel(b, now) -> the tokens after refilling to now (updates the bucket). */
export function bucketLevel (b, now) {
  if (!b) return 0
  const t = Number(now) || 0
  if (b.rate === Infinity) { b.tokens = Infinity; b.at = t; return Infinity }
  if (t > b.at) b.tokens = Math.min(b.cap, b.tokens + b.rate * (t - b.at) / 1000)
  b.at = Math.max(b.at, t)
  if (b.drained && b.tokens >= b.cap) b.drained = false
  return b.tokens
}

/** bucketTake(b, bytes, now) -> true when this debit drained the bucket. */
export function bucketTake (b, bytes, now) {
  if (!b || b.rate === Infinity) return false
  bucketLevel(b, now)
  b.tokens -= Math.max(0, Number(bytes) || 0)
  if (b.tokens <= 0 && !b.drained) { b.drained = true; return true }
  return false
}

/** bucketRefillMs(b, now) -> ms until a drained bucket is full again (Infinity for a rate of 0). */
export function bucketRefillMs (b, now) {
  if (!b || !b.drained) return 0
  bucketLevel(b, now)
  if (!b.drained) return 0
  if (!(b.rate > 0)) return Infinity
  return Math.ceil((b.cap - b.tokens) * 1000 / b.rate)
}

/** peerPiecesHeld(wire, pieces) -> how many of the first `pieces` pieces the remote reports (its bitfield and haves). */
export function peerPiecesHeld (wire, pieces) {
  const pp = wire && wire.peerPieces
  const n = Math.floor(Number(pieces) || 0)
  if (!pp || typeof pp.get !== 'function' || n <= 0) return 0
  let held = 0
  for (let i = 0; i < n; i++) { try { if (pp.get(i)) held++ } catch (_) { /* a broken bitfield */ } }
  return held
}

function normalizeSeedBudget (budget) {
  const num = (v, dflt) => {
    if (v === Infinity) return Infinity
    if (v === null || v === undefined) return dflt
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  const lanes = {}
  for (const l of SEED_LANE_IDS) {
    const x = (budget.lanes && budget.lanes[l]) || {}
    lanes[l] = { rate: num(x.rate, 0), session: num(x.session, Infinity) }
  }
  const m = budget.month || {}
  const lo = budget.local || null
  const local = lo && typeof lo === 'object'
    ? { H: num(lo.H, 0), K: num(lo.K, 0), E: num(lo.E, 0), session: num(lo.session, Infinity), on: lo.on !== false }
    : { H: lanes.H.rate, K: lanes.K.rate, E: lanes.E.rate, session: Infinity, on: true }
  return {
    row: typeof budget.row === 'string' ? budget.row : null,
    lanes,
    month: { cap: num(m.cap, Infinity), lanes: Array.isArray(m.lanes) ? m.lanes.filter((l) => SEED_LANE_IDS.indexOf(l) >= 0) : ['K', 'E'] },
    local,
    hiddenH: budget.hiddenH === true,
    raw: budget
  }
}

// ---- chunk store wrappers ---------------------------------------------------------------------

/**
 * Keeps a MemoryChunkStore alive across torrent destruction so rebuild() (consent given, host-only
 * toggled, tab visible again) resumes a download with preloadedStore + bitfield instead of starting
 * over. close()/destroy() only close this view.
 */
export class RetainedStore {
  constructor (inner, chunkLength) {
    this.inner = inner
    this.chunkLength = chunkLength || inner.chunkLength
    this.length = inner.length
    this.closed = false
  }

  put (index, buf, cb = noop) {
    if (this.closed) return microtask(() => cb(new Error('Storage is closed')))
    this.inner.put(index, buf, cb)
  }

  get (index, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = null }
    cb = cb || noop
    if (this.closed) return microtask(() => cb(new Error('Storage is closed')))
    this.inner.get(index, opts || {}, cb)
  }

  close (cb = noop) { this.closed = true; microtask(() => cb(null)) }
  destroy (cb = noop) { this.closed = true; microtask(() => cb(null)) }
}

function retainingStoreClass (MemoryChunkStore, holder) {
  return class RetainingStore {
    constructor (chunkLength, opts = {}) {
      if (!holder.inner) holder.inner = new MemoryChunkStore(chunkLength, { length: opts.length })
      holder.chunkLength = chunkLength
      return new RetainedStore(holder.inner, chunkLength)
    }
  }
}

// v0.3 (MF-45): the same for an injected abstract-chunk-store class (lane media's IdbChunkStore). The store
// gets webtorrent's options (length, files, ...) plus name = the infohash unless one is given.
function retainingInjectedStoreClass (Store, holder, infoHash) {
  return class RetainingInjectedStore {
    constructor (chunkLength, opts = {}) {
      if (!holder.inner) holder.inner = new Store(chunkLength, Object.assign({ name: infoHash }, opts || {}))
      holder.chunkLength = chunkLength
      return new RetainedStore(holder.inner, chunkLength)
    }
  }
}

/** Reports a BlobChunkStore verification failure (corrupt cached bytes) once per piece. */
function guardedStore (inner, chunkLength, onCorrupt) {
  return {
    chunkLength: chunkLength || inner.chunkLength,
    get length () { return inner.length },
    put (index, buf, cb = noop) { inner.put(index, buf, cb) },
    get (index, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = null }
      cb = cb || noop
      inner.get(index, opts || {}, (err, buf) => {
        if (err && /verif/i.test(errText(err))) { try { onCorrupt(index, err) } catch (_) { /* ignore */ } }
        cb(err, buf)
      })
    },
    close (cb = noop) { inner.close(cb) },
    destroy (cb = noop) { inner.destroy(cb) }
  }
}

const FALLBACK_TYPES = { html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', txt: 'text/plain', wasm: 'application/wasm', webmanifest: 'application/manifest+json' }
function typeFor (path, wfType) {
  if (wfType && wfType !== 'application/octet-stream') return wfType
  const ext = (/\.([a-z0-9]+)$/i.exec(String(path)) || [])[1]
  return FALLBACK_TYPES[(ext || '').toLowerCase()] || 'application/octet-stream'
}

function relativeWtPath (wfPath, multi) {
  const segs = String(wfPath || '').split('/').filter(Boolean)
  if (multi && segs.length > 1) segs.shift()
  return segs.join('/')
}

const DEFAULT_TIMERS = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
  now: () => Date.now()
}

// ---------------------------------------------------------------------------------------------
// v0.3 hook handles: file torrents and chat / group lanes
// ---------------------------------------------------------------------------------------------

function handleEmit (target, type, detail) {
  try { target.dispatchEvent(new CustomEvent(type, { detail })) } catch (err) {
    if (typeof console !== 'undefined') console.error('[mw torrent] listener for ' + type + ' failed', err)
  }
}

/**
 * FileTorrentHandle (v0.3, R 2.8; returned by TorrentManager.addFileTorrent). EventTarget with 'torrent'
 * { torrent } (each time the swarm is (re)joined), 'done', 'error' { error } and 'left'. Fields: infoHash,
 * kind ('file'), announce (the own trackers in use), retain, uploadException, done, left; getters torrent
 * (the live webtorrent Torrent or null) and store (the injected store instance, once created).
 *
 * v0.3 integration (docs/deviations/integration-v03.md, I-3): the lanes media and files call an
 * EventEmitter-style surface, so the handle also has on/once/off ('verified' gives the piece index, 'done',
 * 'error' gives the error, 'left', 'torrent' gives the torrent), metadata() (the .torrent bytes once the info
 * dictionary is known, for validateFileTorrent before any byte is used), prioritize(i0, i1), the getters
 * downloaded and numPeers, and stopSeeding() and destroy(), which both leave the swarm at once (the store is
 * never destroyed here: the lanes destroy their own stores).
 */
export class FileTorrentHandle extends EventTarget {
  constructor (tm, { infoHash, parsed, announce, store, retain, uploadException, lane = null, expectedLength = null }) {
    super()
    this._tm = tm
    this.infoHash = infoHash
    this.kind = 'file'
    this.announce = announce.slice()
    this.retain = retain !== false
    this.uploadException = !!uploadException
    // MAL53-6: the listing's length (bytes; for media, total chunks x piece), which bounds the metadata a peer may announce.
    this.expectedLength = Number.isSafeInteger(expectedLength) && expectedLength > 0 ? expectedLength : null
    this.done = false
    this.left = false
    this._parsed = parsed || null
    this._storeArg = store
    this._holder = { inner: null, chunkLength: 0 }
    this._bitfield = null
    this._torrent = null
    this._leaveOnDone = false
    this._leaveWaiters = []
    // C2 seed-engine: the seed lane (H own upload, K kept, E echo), set explicitly or derived from uploadException.
    this._lane = SEED_LANE_IDS.indexOf(lane) >= 0 ? lane : null
    if (this._lane === 'H') this.uploadException = true
    this.handedOff = false // H ended: a pin receipt or two complete peer copies (then lane K)
    this.addedAt = typeof tm._t.now === 'function' ? tm._t.now() : Date.now()
    this._uploaded = 0 // piece bytes this page sent to peers for this item (the pin page's status(), SZ 3.1.6)
    // Seek ranges in front of the whole-file selection (prioritize); each goes once its pieces verify.
    this._prio = []
    this.addEventListener('verified', (ev) => this._prioVerified(ev && ev.detail ? ev.detail.index : null))
    this.addEventListener('torrent', () => { this._prio = [] }) // a rejoined swarm starts without them
  }

  get torrent () { return this._torrent }
  get store () { return typeof this._storeArg === 'function' ? this._holder.inner : this._storeArg }

  /** Per-upload exception (MF-45): this infohash's wires upload even while the device policy keeps uploads off. */
  setUploadException (on) {
    this.uploadException = !!on
    if (!this.uploadException && this._lane === 'H') this._lane = null // C2 seed-engine: H is the per-upload exception
    this._tm._applyFileLock(this)
    this._tm._applyUploadThrottle()
    this._tm._seedReplanSoon() // C2 seed-engine
  }

  // ---- C2 seed-engine: lanes and availability evidence (SZ 3.1.2, 3.1.5) ------------------------------------

  /** The seed lane: 'H' (own upload: the per-upload exception), 'K' (kept), or 'E' (echo, the default). */
  get lane () { return this._lane || (this.uploadException ? 'H' : 'E') }

  /**
   * setLane(lane) -> the lane in effect: 'H' sets the per-upload exception, 'K' or 'E' clears it. The lanes call
   * setLane('K') when the person turns on "Help share this file" or "Keep available".
   */
  setLane (lane) {
    if (SEED_LANE_IDS.indexOf(lane) < 0) throw new TypeError("setLane: lane must be 'H', 'K' or 'E'")
    const before = this.lane
    this._lane = lane
    this.uploadException = lane === 'H'
    if (lane === 'H') this.handedOff = false
    if (before !== lane) handleEmit(this, 'lane', { lane, reason: 'set' })
    this._tm._applyFileLock(this)
    this._tm._applyUploadThrottle()
    this._tm._seedReplanSoon()
    return this.lane
  }

  /** Piece bytes this page sent to peers for this item since it was added (cumulative across rebuilds). */
  get uploaded () { return this._uploaded }

  /** evidence({ now }) -> availability.evidence() of this item (src/loader/availability.js) plus infoHash and pinPct. */
  evidence (opts) { return this._tm.evidenceFor(this.infoHash, opts) }

  /** evidenceInputs({ now }) -> the arguments evidence() was computed from (a lane may add its own web seed probe). */
  evidenceInputs (opts) { return this._tm.evidenceInputs(this.infoHash, opts) }

  /**
   * leave({ now = false }) → Promise<true>: leaves the swarm once the file is saved (complete), or at once
   * with now: true. The torrent is destroyed without destroying the store; the handle is not rejoined.
   */
  leave ({ now = false } = {}) { return this._tm._leaveFile(this, { now }) }

  // --- the EventEmitter-style surface of the media and files lanes (integration I-3) ---------------------

  /** on(type, fn) → this. fn gets the piece index ('verified'), the error ('error'), the torrent ('torrent') or the detail. */
  on (type, fn) {
    if (typeof fn !== 'function') return this
    if (!this._compat) this._compat = new Map()
    const wrapped = (ev) => {
      const d = ev && ev.detail
      if (type === 'verified') fn(d && d.index)
      else if (type === 'error') fn(d && d.error)
      else if (type === 'torrent') fn(d && d.torrent)
      else fn(d)
    }
    const list = this._compat.get(fn) || []
    list.push({ type, wrapped })
    this._compat.set(fn, list)
    this.addEventListener(type, wrapped)
    return this
  }

  /** once(type, fn) → this: like on(), for one event. */
  once (type, fn) {
    if (typeof fn !== 'function') return this
    const one = (arg) => { this.off(type, one); fn(arg) }
    return this.on(type, one)
  }

  /** off(type, fn) → this. */
  off (type, fn) {
    const list = this._compat && this._compat.get(fn)
    if (!list) return this
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].type !== type) continue
      this.removeEventListener(type, list[i].wrapped)
      list.splice(i, 1)
    }
    if (!list.length) this._compat.delete(fn)
    return this
  }

  /**
   * metadata({ timeoutMs }) → Promise<Uint8Array>: the .torrent bytes (the info dictionary in a minimal
   * .torrent) as soon as they are known: at once for a handle added from a .torrent, else when the swarm sent
   * the info dictionary. E_FILE_UNAVAILABLE after timeoutMs (config.fileTorrent.metadataTimeoutMs, else
   * 60 s) or when the handle leaves first.
   */
  metadata ({ timeoutMs } = {}) {
    const now = this._metadataBytes()
    if (now) return Promise.resolve(now)
    const cfg = this._tm.config && this._tm.config.fileTorrent
    const wait = Number.isFinite(timeoutMs) ? timeoutMs : ((cfg && cfg.metadataTimeoutMs) || 60000)
    return new Promise((resolve, reject) => {
      let timer = null
      const finish = (fn, v) => {
        this.removeEventListener('metadata', onMeta)
        this.removeEventListener('left', onLeft)
        if (timer !== null) this._tm._t.clearTimeout(timer)
        fn(v)
      }
      const onMeta = () => { const b = this._metadataBytes(); if (b) finish(resolve, b) }
      const onLeft = () => finish(reject, makeError('E_FILE_UNAVAILABLE', 'the swarm was left before its info dictionary arrived'))
      this.addEventListener('metadata', onMeta)
      this.addEventListener('left', onLeft)
      timer = this._tm._t.setTimeout(() => finish(reject, makeError('E_FILE_UNAVAILABLE', 'no peer sent the info dictionary in ' + wait + ' ms')), wait)
    })
  }

  _metadataBytes () {
    if (this._parsed && this._parsed.infoBytes) return minimalTorrentBytes(this._parsed.infoBytes)
    const t = this._torrent
    // WebTorrent builds a torrentFile the moment a magnet is added, without an info dictionary until the metadata has
    // arrived (torrent.info is set then). v0.3 final integration: metadata() resolved at once with those bytes, so every
    // file or media item fetched by infohash failed its check ('missing info dictionary', E_FILE_HASH; seen in E-FI-1).
    if (!t || !t.info) return null
    const tf = t.torrentFile
    if (tf && tf.length) return tf instanceof Uint8Array ? new Uint8Array(tf.buffer, tf.byteOffset, tf.byteLength) : new Uint8Array(tf)
    return null
  }

  /**
   * prioritize(i0, i1): fetch these pieces first (R 2.9.6: a seek moves its one or two pieces to the front). In WebTorrent
   * 3.0.21 critical() only allows hot-swapping a slow peer's request, and select() merges into the whole-file selection,
   * so the pieces came in file order (code review v0.3, correctness: a seek to 90 percent waited for everything before it).
   * A stream selection at priority 1 is fetched before the whole file; it is removed once its pieces verify, by
   * deprioritize() when the request is abandoned, and the oldest goes beyond PRIORITY_RANGES_MAX.
   */
  prioritize (i0, i1) {
    const t = this._torrent
    if (!t) return this
    const a = Math.max(0, Math.floor(Number(i0)) || 0)
    const b = Math.max(a, Math.floor(Number(i1)) || a)
    try {
      const n = Array.isArray(t.pieces) ? t.pieces.length : 0
      const have = typeof t.bitfield === 'object' && t.bitfield && typeof t.bitfield.get === 'function'
      let missing = !have
      if (have) for (let i = a; i <= b && i < n; i++) if (!t.bitfield.get(i)) { missing = true; break }
      if (typeof t._select === 'function' && b < n && missing && !this._prio.some((r) => r.from === a && r.to === b)) {
        t._select(a, b, 1, null, true)
        this._prio.push({ from: a, to: b, torrent: t })
        while (this._prio.length > PRIORITY_RANGES_MAX) this._dropPrio(this._prio[0])
      }
      if (typeof t.critical === 'function') t.critical(a, b)
    } catch (_) { /* no metadata yet */ }
    return this
  }

  /** deprioritize(i0, i1): a seek range nobody waits for any more (a cancelled stream) leaves the front. */
  deprioritize (i0, i1) {
    const a = Math.max(0, Math.floor(Number(i0)) || 0)
    const b = Math.max(a, Math.floor(Number(i1)) || a)
    for (const r of this._prio.slice()) if (r.from <= b && r.to >= a) this._dropPrio(r)
    return this
  }

  /** priorityRanges -> [{ from, to }] in front of the whole file now (tests, diagnostics). */
  get priorityRanges () { return this._prio.map((r) => ({ from: r.from, to: r.to })) }

  _dropPrio (r) {
    const k = this._prio.indexOf(r)
    if (k < 0) return
    this._prio.splice(k, 1)
    const t = r.torrent
    if (t && t === this._torrent && typeof t._deselect === 'function' && !t.destroyed) {
      try { t._deselect(r.from, r.to, true) } catch (_) { /* the torrent is gone */ }
    }
  }

  _prioVerified (index) {
    const t = this._torrent
    if (!t || !Number.isInteger(index) || !this._prio.length) return
    const bf = t.bitfield
    for (const r of this._prio.slice()) {
      if (index < r.from || index > r.to) continue
      let all = true
      if (bf && typeof bf.get === 'function') for (let i = r.from; i <= r.to; i++) if (!bf.get(i)) { all = false; break }
      if (all) this._dropPrio(r)
    }
  }

  get downloaded () { const t = this._torrent; return t && Number.isFinite(t.downloaded) ? t.downloaded : 0 }
  get numPeers () { const t = this._torrent; return t && Number.isFinite(t.numPeers) ? t.numPeers : 0 }

  /** stopSeeding() → Promise<true>: leaves the swarm at once; the store stays. */
  stopSeeding () { return this.leave({ now: true }) }

  /** destroy({ keepStore }) → Promise<true>: leaves the swarm at once. The store is kept either way (the lanes own it). */
  destroy () { return this.leave({ now: true }) }
}

/**
 * LaneHandle (v0.3; TorrentManager.joinLane): a chat or group lane swarm. Fields kind, infoHash, announce, left, ownStun;
 * getter torrent; leave(). ownStun false: the ledger-sync lane of a hub (kind 'hub' since review round R 5.3, SCALE-6; 'group'
 * with ledgerSync before), a ledger swarm, so it keeps the shared STUN list.
 */
export class LaneHandle extends EventTarget {
  constructor (tm, { kind, infoHash, announce, ownStun = true, wanted = null, syncing = null }) {
    super()
    this._tm = tm
    this.kind = kind
    // SCALE-6 (kind 'hub'): wanted() the wires the lane asks for (MultiGossip.wantedWires), syncing() true while
    // follows are due or syncing; both read on every budget decision.
    this._wanted = typeof wanted === 'function' ? wanted : null
    this._syncing = typeof syncing === 'function' ? syncing : null
    this.infoHash = infoHash
    this.announce = announce.slice()
    this.left = false
    this.ownStun = ownStun !== false
    this._torrent = null
  }

  get torrent () { return this._torrent }
  leave () { return this._tm._leaveLane(this) }
}

// ---------------------------------------------------------------------------------------------
// TorrentManager
// ---------------------------------------------------------------------------------------------

function defaultLifecycle () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null
  if (typeof window.addEventListener !== 'function' || typeof document.addEventListener !== 'function') return null
  return { win: window, doc: document }
}

/**
 * new TorrentManager({ WebTorrent, config, policy, consent, lifecycle }) where consent = { peersAllowed(),
 * onChange(fn) } and lifecycle = { win, doc } (default: the page's window and document; false = none).
 * Events (CustomEvent detail): 'torrent' { torrent, kind } (synchronous, before any wire; kind 'site' or
 * 'rendezvous'), 'wire' { wire, torrent, kind } (synchronous), 'progress', 'peers' { count, webseeds },
 * 'done' { manifest }, 'error' { error }, 'status' { code, ... }, 'warning' { code, ... },
 * 'tracker' { url, state }, 'sync' { failures }.
 */
export class TorrentManager extends EventTarget {
  constructor ({ WebTorrent, config = CONFIG, policy = null, consent = null, deps = null, timers = null, fetch: fetchImpl = null, baseUrl = null, lifecycle = undefined, random = null } = {}) {
    super()
    if (typeof WebTorrent !== 'function') throw new TypeError('TorrentManager needs the WebTorrent class')
    this.WebTorrent = WebTorrent
    this.config = config
    this.policy = Object.assign({ maxConns: config.policy.desktop.maxConns, uploadsEnabled: true, uploadLimit: config.policy.desktop.uploadLimit, hostOnly: false, leaveVersionSwarm: false }, policy || {})
    this.consent = consent
    this._injected = deps || {}
    this._deps = null
    // Injected timers may be a class instance (methods on its prototype), so bind each one;
    // Object.assign would copy only own properties and silently fall back to the real timers.
    this._t = {}
    for (const k of Object.keys(DEFAULT_TIMERS)) {
      this._t[k] = timers && typeof timers[k] === 'function' ? timers[k].bind(timers) : DEFAULT_TIMERS[k]
    }
    // v0.3 (MF-30): every delay is clamped to 2^31 - 1 ms (a larger one would fire at once, in a loop).
    const rawSetTimeout = this._t.setTimeout
    const rawSetInterval = this._t.setInterval
    this._t.setTimeout = (fn, ms) => rawSetTimeout(fn, clampMs(ms))
    this._t.setInterval = (fn, ms) => rawSetInterval(fn, clampMs(ms))
    this._random = typeof random === 'function' ? random : Math.random
    this._fetch = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null)
    this._base = baseUrl || (typeof location !== 'undefined' ? location.href : undefined)
    let origin = null
    try { origin = this._base ? new URL(this._base).origin : null } catch (_) { origin = null }
    this._origin = origin

    this.client = null
    this.site = null // { mode: 'download'|'seed', record, parsed, manifest, blobs, torrent, stopped }
    this.rendezvous = null // { ledgerId, trackers, infoHash, torrent, joinTimer, glare }
    this._download = null
    this._clientPeers = false
    this._clientAt = 0
    this._rtcConfig = null
    this._iceServers = null
    // The site's own STUN for chat, group, file and media swarms (setLaneIceServers); none until the site names some.
    this._laneRtc = { iceServers: [] }
    this.uploadsEnabled = !!this.policy.uploadsEnabled
    this.hostOnly = !!this.policy.hostOnly
    this.hiddenLocked = false
    this.suspended = false
    this.destroyed = false
    this._leftVersionSwarm = false

    this._wireInfo = new Map() // wire → { torrent, kind, web, at, seq, counted }
    this._wireSeq = 0
    this._pendingPeers = new Map() // peer id → simple-peer object, until its wire handshakes
    this._corruptReported = false
    this._guardMissingReported = false
    this.peerBytes = 0
    this.webseedBytes = 0
    // Piece bytes this page sent to other visitors (progress.uploaded; post-wave fix H): counted from the
    // 'upload' events of peer wires only, never from WebTorrent's torrent.uploaded (see _onWire).
    this.uploadedBytes = 0
    this._downloaded = 0
    this._total = 0
    this._peerCount = 0
    this._webseedCount = 0
    this._progressTimer = null
    this._pollTimer = null
    this._keepaliveTimer = null
    this._watchdogTimer = null
    this._lastKickAnnounce = -Infinity
    this._webseeds = new Map() // ws URL → { failures: [ms], backoffUntil, timer, code }
    this._webseedPieces = new Map() // piece index → { url, at }: who sent it last (hash-failure attribution)
    this._failures = { trackers: {}, iceFailed: 0, dropped: 0, capped: 0, keepalives: 0, webseed: null, noWebseed: false, webseedBackoff: {}, swarm: { site: null, rendezvous: null }, lastIceError: null, ignored: 0, idle: 0, budget: 0, utMetadataDropped: 0 }
    this._lastFailureKey = ''
    // v0.3 hooks and limits (harden-loader).
    this._extensions = new Map() // name → { name, handler, swarms: Set<kind> }
    this._files = new Map() // infoHash → FileTorrentHandle
    this._lanes = new Map() // infoHash → LaneHandle
    this._hkTimer = null
    this._stall = {} // kind → { since, lastEmit, delay }
    // C2 seed-engine: lane budgets, meters, evidence and super-seeding (SZ 3.1). deps may inject planSeeding,
    // isLocalPair and seedMeters (unit tests mock lane seed-policy's modules at this boundary).
    const inj = this._injected
    this._seedFns = {
      planSeeding: typeof inj.planSeeding === 'function' ? inj.planSeeding : defaultPlanSeeding,
      isLocalPair: typeof inj.isLocalPair === 'function' ? inj.isLocalPair : defaultIsLocalPair
    }
    this._meters = inj.seedMeters && typeof inj.seedMeters.add === 'function' ? inj.seedMeters : createSeedMeters({ storage: null, now: () => this._t.now() })
    this._seed = null // { budget, buckets, localBuckets, items, plan, timers, exhausted } once setSeedBudget() ran
    this._seedReplanQueued = false
    this._pinSource = null
    this._holders = new Map() // infoHash → Map(wire → { id, complete, at, open })
    this._evidence = new Map() // infoHash → the evidence last emitted
    this._evidenceDirty = new Set()
    this._evidenceTimer = null
    this._superseeds = new Map() // infoHash → SuperSeed
    this._webseedSeen = null // { ok, at, infoHash }: the last web seed probe of the site torrent that passed (E3)

    if (consent && typeof consent.onChange === 'function') {
      consent.onChange(() => this._onConsentChange())
    }
    this._lifecycleOff = this._installLifecycle(lifecycle === undefined ? defaultLifecycle() : lifecycle)
  }

  // ----- read-only state ----------------------------------------------------------------------

  get wires () {
    const out = []
    for (const [wire, info] of this._wireInfo) if (!info.web && !wire.destroyed) out.push(wire)
    return out
  }

  /** @deprecated v0.2 name of the ledger swarm handle (one release): the rendezvous swarm. */
  get anchor () { return this.rendezvous }

  get peers () { return this._peerCount }
  get downloaded () { return this._downloaded }
  get total () { return this._total }
  get source () {
    if (this.site && this.site.mode === 'seed' && this.site.fromCache) return 'cache'
    return computeSource({ peerBytes: this.peerBytes, webseedBytes: this.webseedBytes })
  }

  get failures () {
    const f = this._failures
    return { trackers: Object.assign({}, f.trackers), iceFailed: f.iceFailed, dropped: f.dropped, capped: f.capped, keepalives: f.keepalives, webseed: f.webseed, noWebseed: f.noWebseed, webseedBackoff: Object.assign({}, f.webseedBackoff), swarm: Object.assign({}, f.swarm), lastIceError: f.lastIceError, ignored: f.ignored, idle: f.idle, budget: f.budget, utMetadataDropped: f.utMetadataDropped }
  }

  /** Wires per swarm (v0.3: every peer wire counts, web seeds excluded) for diagnostics and tests. */
  swarmWires (kind) { return this._swarmCount(kind, null, { countAll: true }) }

  /**
   * budget → { total, used, pending, free, priority, bySwarm } (v0.3, MF-39). One wire budget per tab
   * across every swarm: total = policy.wireBudget (desktop 40, phones 8, chosen); used = counted wires
   * (after their extended handshake or capGraceMs), pending = wires not counted yet. bySwarm[kind] =
   * { wires, counted, floor, cap, allot }: cap is the swarm's own hard cap, allot what allocateWireBudget
   * gives it now (floors first, then priority site > rendezvous > chat > group > file).
   */
  get budget () {
    const total = this._budgetTotal()
    const counted = this._countByKind(false)
    const all = this._countByKind(true)
    const floors = (this.config.wireBudget && this.config.wireBudget.floors) || {}
    const demands = {}
    for (const kind of SWARM_KINDS) if (this._swarmActive(kind)) demands[kind] = this._caps(kind).hard
    const allot = allocateWireBudget(total, demands, this._budgetConfig())
    const bySwarm = {}
    let used = 0
    let pending = 0
    for (const kind of SWARM_KINDS) {
      used += counted[kind]
      pending += all[kind] - counted[kind]
      bySwarm[kind] = { wires: all[kind], counted: counted[kind], floor: Number(floors[kind]) || 0, cap: this._caps(kind).hard, allot: allot[kind] || 0 }
    }
    const priority = budgetPriority(this._budgetConfig())
    return { total, used, pending, free: Math.max(0, total - used), priority, bySwarm }
  }

  /** Inputs for classifyFailures(), filled from the live state. */
  diagnostics (now = this._t.now()) {
    const site = this._failures.swarm.site
    let others = null
    if (site) {
      others = 0
      for (const url of Object.keys(site)) others = Math.max(others, (site[url].complete || 0) + (site[url].incomplete || 0) - 1)
    }
    const started = this._download ? this._download.startedAt : (this._clientAt || now)
    return {
      peersAllowed: this._peersAllowed(),
      hostOnly: this.hostOnly,
      trackers: Object.assign({}, this._failures.trackers),
      iceFailed: this._failures.iceFailed,
      peers: this._peerCount,
      swarm: site ? { reported: true, others } : null,
      hasWebseed: !this._failures.noWebseed,
      webseed: this._failures.webseed,
      elapsedMs: Math.max(0, now - (started || now)),
      done: !!(this.site && this.site.mode === 'seed')
    }
  }

  // ----- infrastructure -----------------------------------------------------------------------

  _emit (type, detail) {
    try { this.dispatchEvent(new CustomEvent(type, { detail })) } catch (err) {
      if (typeof console !== 'undefined') console.error('[mw torrent] listener for ' + type + ' failed', err)
    }
  }

  _status (code, extra) { this._emit('status', Object.assign({ code }, extra || {})) }
  _warning (code, extra) { this._emit('warning', Object.assign({ code }, extra || {})) }

  async _loadDeps () {
    if (this._deps) return this._deps
    const d = Object.assign({}, this._injected)
    if (!d.MemoryChunkStore) d.MemoryChunkStore = (await import('./memory-chunk-store.js')).MemoryChunkStore
    if (!d.BlobChunkStore) d.BlobChunkStore = (await import('./blob-chunk-store.js')).BlobChunkStore
    if (!d.parseTorrentFile) {
      const tf = await import('../common/torrent-file.js')
      d.parseTorrentFile = d.parseTorrentFile || tf.parseTorrentFile
    }
    this._deps = d
    return d
  }

  _peersAllowed () {
    if (this.hostOnly || this.suspended || this.destroyed) return false
    if (this.consent && typeof this.consent.peersAllowed === 'function') {
      try { return !!this.consent.peersAllowed() } catch (_) { return false }
    }
    return true
  }

  _announceFor (record) {
    return this._peersAllowed() ? announceListFor(record, this.config.trackers) : []
  }

  /**
   * setIceServers(list): the probe-gated STUN list (v0.2.1 B7). The shared rtcConfig object is changed in
   * place, so new peer connections use it without a rebuild (object identity survives webtorrent,
   * torrent-discovery and bittorrent-tracker; simple-peer copies it per connection). Never empty.
   */
  setIceServers (iceServers) {
    const list = Array.isArray(iceServers) && iceServers.length ? iceServers.slice() : this.config.stun.slice()
    this._iceServers = list
    if (this._rtcConfig) this._rtcConfig.iceServers = list.slice()
  }

  /**
   * setLaneIceServers(list): the site's own STUN servers (publish --stun, /.mw/site.json) for the chat, group, file and
   * media swarms (R 2.7.1: the public default STUN operators are never their fallback; with none, those swarms use host
   * candidates only). Changed in place, so connections made later use it; the ledger and content swarms keep the
   * probe-gated defaults of setIceServers.
   */
  setLaneIceServers (list) {
    this._laneRtc.iceServers = laneIceServersOf(list)
  }

  /** laneIceServers -> the STUN list the chat, group, file and media swarms use (a copy). */
  get laneIceServers () {
    return this._laneRtc.iceServers.map((x) => Object.assign({}, x))
  }

  /**
   * _useLaneRtc(torrent): this torrent's tracker client gets the lane rtcConfig. WebTorrent 3 builds each torrent's
   * discovery from client.tracker in Torrent._startDiscovery (synchronously, after the torrent id parsed): for that one
   * call, client.tracker carries the lane rtcConfig, so the tracker client of this torrent (torrent-discovery keeps the
   * options for a rebuilt tracker too) makes every offer and answer with the site's own STUN. Returns false when the
   * torrent has no such method (another WebTorrent version: then nothing is changed and a warning is raised).
   */
  _useLaneRtc (torrent) {
    const orig = torrent && torrent._startDiscovery
    if (typeof orig !== 'function') {
      if (!this._laneRtcWarned) { this._laneRtcWarned = true; this._warning('lane-stun-unsupported', {}) }
      return false
    }
    const rtc = this._laneRtc
    torrent._startDiscovery = function laneDiscovery () {
      const c = this.client
      const saved = c ? c.tracker : undefined
      if (saved && typeof saved === 'object') c.tracker = Object.assign({}, saved, { rtcConfig: rtc })
      try {
        return orig.apply(this, arguments)
      } finally {
        if (c && saved && typeof saved === 'object') c.tracker = saved
      }
    }
    return true
  }

  _ensureClient () {
    if (this.destroyed) throw makeError('E_ABORTED', 'TorrentManager destroyed')
    if (this.client) return this.client
    const peers = this._peersAllowed()
    // C2 seed-engine: with a seed budget the throttle follows the lanes with an unlocked wire (none yet: unshaped).
    const limit = this._seed ? this._laneThrottle() : (this.uploadsEnabled && this.policy.uploadLimit > 0 ? Math.round(this.policy.uploadLimit) : -1)
    // TURN is off in v1 (B7): the config holds STUN servers only, gated by the connectivity probe.
    this._rtcConfig = { iceServers: (this._iceServers || this.config.stun).slice() }
    const client = new this.WebTorrent({
      // tracker: false = host only (no tracker sockets, no WebRTC); otherwise our STUN list.
      tracker: peers ? { rtcConfig: this._rtcConfig } : false,
      dht: false,
      lsd: false,
      utPex: false,
      natUpnp: false,
      natPmp: false,
      webSeeds: true,
      maxConns: Math.max(this._caps('site').hard, this._caps('rendezvous').hard),
      uploadLimit: limit
    })
    client.on('error', (err) => this._emit('error', { error: makeError('E_TORRENT', errText(err)) }))
    this.client = client
    this._clientPeers = peers
    this._clientAt = this._t.now()
    this._failures.trackers = {}
    if (peers) {
      this._pollTimer = this._t.setInterval(() => this._pollTrackers(), this.config.timeoutsExtra.trackerPollMs)
      this._keepaliveTimer = this._t.setInterval(() => this._keepalive(), this.config.tracker.keepaliveCheckMs)
      this._watchdogTimer = this._t.setInterval(() => this._watchdog(), this.config.wireGuard.bufferWatchdogMs)
      this._hkTimer = this._t.setInterval(() => this._housekeep(), this._limits().checkMs)
    }
    return client
  }

  _limits () {
    return Object.assign({ idleMs: 120000, checkMs: 5000, noProgressMs: 60000, noProgressMaxMs: 900000, anchorShare: 0.5, utMetadataPerMinute: 4 }, this.config.wireLimits || {})
  }

  _destroyClient () {
    const client = this.client
    this.client = null
    if (this._pollTimer) { this._t.clearInterval(this._pollTimer); this._pollTimer = null }
    if (this._keepaliveTimer) { this._t.clearInterval(this._keepaliveTimer); this._keepaliveTimer = null }
    if (this._watchdogTimer) { this._t.clearInterval(this._watchdogTimer); this._watchdogTimer = null }
    if (this._hkTimer) { this._t.clearInterval(this._hkTimer); this._hkTimer = null }
    // v0.3 (MF-45): file torrents keep their stores (and their bitfields, when retained) across the rebuild.
    for (const h of this._files.values()) {
      const t = h._torrent
      h._torrent = null
      if (!t) continue
      if (h.retain) {
        try { if (t.bitfield && t.bitfield.buffer) h._bitfield = new Uint8Array(t.bitfield.buffer) } catch (_) { /* no metadata yet */ }
      } else {
        h._bitfield = null
        h._holder.inner = null
      }
    }
    for (const l of this._lanes.values()) l._torrent = null
    this._stall = {}
    const ctx = this._download
    if (ctx && ctx.torrent) {
      try { if (ctx.torrent.bitfield && ctx.torrent.bitfield.buffer) ctx.bitfield = new Uint8Array(ctx.torrent.bitfield.buffer) } catch (_) { /* no metadata yet */ }
      ctx.torrent = null
    }
    if (this.site) this.site.torrent = null
    if (this.rendezvous) {
      this.rendezvous.torrent = null
      this._clearRendezvousTimers(this.rendezvous)
    }
    this._wireInfo.clear()
    this._pendingPeers.clear()
    this._webseedPieces.clear()
    if (client && !client.destroyed) { try { client.destroy() } catch (_) { /* already destroyed */ } }
    this._recount()
  }

  _add (source, opts, kind, { ownStun = true } = {}) {
    const client = this._ensureClient()
    const torrent = client.add(source, Object.assign({ private: true }, opts))
    // Chat, group, file and media swarms: the site's own STUN only (R 2.7.1, MF-44). Discovery starts after this returns.
    if (OWN_STUN_SET.has(kind) && ownStun !== false) this._useLaneRtc(torrent)
    // Synchronous on purpose: wire extensions must be registered before any extended handshake.
    torrent.on('wire', (wire) => this._onWire(wire, torrent, kind))
    torrent.on('peer', (peer) => this._onPeer(peer))
    torrent.on('warning', (err) => this._onTorrentWarning(torrent, kind, err))
    torrent.on('download', () => this._scheduleProgress())
    torrent.on('upload', () => this._scheduleProgress())
    // v0.3 (MF-74): a verified piece anchors the wires that sent its blocks.
    torrent.on('verified', (index) => this._onVerified(torrent, kind, index))
    // The tracker client exists right after 'infoHash' (torrent-discovery starts synchronously there):
    // install the connection shim at once rather than at the next poll.
    torrent.once('infoHash', () => microtask(() => this._shimTrackers(torrent, kind)))
    this._emit('torrent', { torrent, kind })
    return torrent
  }

  _onTorrentWarning (torrent, kind, err) {
    const message = errText(err)
    const m = PIECE_FAIL_RE.exec(message)
    if (m) this._onPieceFailed(torrent, Number(m[1]))
    this._warning('torrent', { kind, message })
  }

  // ----- lifecycle: kick on return, lock uploads while hidden (B1, C2) ---------------------------

  _installLifecycle (lc) {
    if (!lc || !lc.win || !lc.doc) return null
    const { win, doc } = lc
    const onVisibility = () => this._onVisibility(doc.visibilityState)
    const onPageShow = () => this.kick('pageshow')
    const onOnline = () => this.kick('online')
    try {
      doc.addEventListener('visibilitychange', onVisibility)
      win.addEventListener('pageshow', onPageShow)
      win.addEventListener('online', onOnline)
    } catch (_) { return null }
    if (doc.visibilityState === 'hidden') this._hiddenAt = this._t.now()
    return () => {
      try { doc.removeEventListener('visibilitychange', onVisibility) } catch (_) { /* gone */ }
      try { win.removeEventListener('pageshow', onPageShow) } catch (_) { /* gone */ }
      try { win.removeEventListener('online', onOnline) } catch (_) { /* gone */ }
    }
  }

  _onVisibility (state) {
    if (this.destroyed) return
    if (state === 'hidden') {
      this._hiddenAt = this._t.now()
      if (this.policy.hiddenAction === 'lock') this.setHiddenLock(true)
      try { if (typeof this._meters.flush === 'function') this._meters.flush() } catch (_) { /* C2 seed-engine: the month record */ }
      return
    }
    this._hiddenAt = null
    this.setHiddenLock(false)
    this.kick('visible')
  }

  /**
   * setHiddenLock(on): while a phone page is hidden every wire is choke-locked (C2: "on hidden record the
   * time and lock uploads"); peers and gossip stay connected until the OS suspends the page.
   */
  setHiddenLock (on) {
    const next = !!on
    if (next === this.hiddenLocked) return
    this.hiddenLocked = next
    // C2 seed-engine: with a seed budget the lanes decide; H wires stay unlocked while hidden only with budget.hiddenH (SZ-2).
    if (this._seed) { this._applyLocks(); this._applyUploadThrottle(); return }
    if (next) this._lockAll()
    else if (this.uploadsEnabled) this._unlockAll()
    else this._lockAll() // keeps the locks, unlocks per-upload exceptions again (v0.3)
  }

  /**
   * kick(reason) → number of tracker sockets reopened (B1). Trackers waiting in their reconnect back-off
   * reopen now (retries reset); then, at most every kickMinIntervalMs and never right after a (re)build,
   * every tracker client re-announces with the swarm's numwant. Called on visibilitychange (visible),
   * pageshow and online.
   */
  kick (reason = 'manual') {
    if (this.destroyed || this.suspended || !this.client) return 0
    const now = this._t.now()
    let reopened = 0
    for (const { tc } of this._trackerClients()) {
      if (!tc || tc.destroyed) continue
      for (const t of Array.isArray(tc._trackers) ? tc._trackers : []) {
        if (!t || !t.reconnecting || (t.client && t.client.destroyed) || typeof t._openSocket !== 'function') continue
        // Already attached to a (pooled) socket that is still connecting: opening again would count it twice in
        // bittorrent-tracker's socket pool (the closed socket then stays pooled after the next blip and every
        // instance attaches to a dead socket) and double its listeners. The shim's connect hook finishes it.
        if (t.socket && !t.destroyed) continue
        if (t.reconnectTimer) {
          try { this._t.clearTimeout(t.reconnectTimer) } catch (_) { /* not ours */ }
          try { clearTimeout(t.reconnectTimer) } catch (_) { /* not a host timer */ }
          t.reconnectTimer = null
        }
        t.retries = 0
        try { t._openSocket(); reopened++ } catch (_) { /* the next close retries */ }
      }
    }
    const cfg = this.config.tracker
    if (now - this._lastKickAnnounce >= cfg.kickMinIntervalMs && now - (this._clientAt || 0) >= 2000) {
      this._lastKickAnnounce = now
      for (const { tc } of this._trackerClients()) {
        if (!tc || tc.destroyed || typeof tc.update !== 'function') continue
        try { tc.update() } catch (_) { /* socket closing */ }
      }
    }
    if (reopened) this._status('kick', { reason, reopened })
    return reopened
  }

  // ----- wires --------------------------------------------------------------------------------

  _onWire (wire, torrent, kind) {
    if (!wire || this._wireInfo.has(wire)) return
    const web = wire.type === 'webSeed'
    const now = this._t.now()
    // v0.3: lastRx is the last message other than a keep-alive (idle close), pieces the piece indices this wire
    // sent blocks of (anchoring on 'verified'), exts the extensions already called for it.
    const info = { torrent, kind, web, at: now, seq: ++this._wireSeq, counted: false, lastRx: now, anchored: false, pieces: new Set(), exts: new Set() }
    this._wireInfo.set(wire, info)
    wire.on('download', (bytes) => {
      if (web) this.webseedBytes += bytes
      else this.peerBytes += bytes
      if (Number(bytes) > 0) this._markProgress(kind)
      this._scheduleProgress()
    })
    // progress.uploaded counts the piece data this page sent to other visitors: bittorrent-protocol emits
    // 'upload' on a wire for piece payloads only. WebTorrent's torrent.uploaded counts every byte any wire
    // writes, including the handshake, extended handshake, interested, request and have messages that the
    // page writes to a web seed's in-memory connection (178 B for the guestbook before any choice, with no
    // peer, tracker or STUN contact) and the protocol overhead of every peer wire, so it is not used.
    if (!web) {
      wire.on('upload', (bytes) => {
        this.uploadedBytes += Number(bytes) || 0
        this._scheduleProgress()
      })
      // C2 seed-engine: the same piece bytes feed the lane meters and buckets.
      wire.on('upload', (bytes) => this._seedUpload(wire, info, Number(bytes) || 0))
    }
    wire.once('close', () => {
      const had = this._wireInfo.get(wire)
      this._wireInfo.delete(wire)
      this._recount()
      if (had && !had.web && had.kind === 'rendezvous') this._onRendezvousWireClosed()
      if (had && !had.web && this._seed) this._applyUploadThrottle() // C2 seed-engine: a lane may have no open wire now
    })
    if (web) {
      this._guardWebseed(wire, torrent)
    } else {
      const guarded = guardWire(wire, {
        maxBytes: this.config.wire.maxMessageBytes,
        bufferBytes: this.config.wireGuard.bufferWatchdogBytes,
        onDrop: (length, reason) => {
          this._failures.dropped++
          this._warning(reason === 'buffer' ? 'wire-buffer-overflow' : 'wire-message-too-long', { length })
          this._failuresChanged()
        }
      })
      if (!guarded && !wire.__mwGuard) {
        // Fail closed (production digest P0-15): without the patch point there is no length cap.
        if (!this._guardMissingReported) {
          this._guardMissingReported = true
          this._warning('wire-guard-missing', { message: 'bittorrent-protocol has no _onMessageLength: peer wires are refused' })
        }
        try { wire.destroy() } catch (_) { /* ignore */ }
        return
      }
      try { wire.setTimeout(this.config.wire.timeoutMs, true) } catch (_) { /* ignore */ }
      try { wire.setKeepAlive(true) } catch (_) { /* ignore */ }
      // v0.3 (MF-74): what the remote says, keep-alives aside, keeps the wire from the idle close.
      if (typeof wire.on === 'function') {
        for (const ev of ACTIVITY_EVENTS) wire.on(ev, () => { info.lastRx = this._t.now() })
        wire.on('piece', (index) => {
          if (info.pieces.size >= 256) info.pieces.clear()
          info.pieces.add(Number(index))
        })
      }
      // v0.3 (MF-75): ut_metadata answers past 4 per minute per wire are dropped once the metadata is complete.
      throttleUtMetadata(wire, {
        perMinute: this._limits().utMetadataPerMinute,
        now: () => this._t.now(),
        onDrop: () => { this._failures.utMetadataDropped++ }
      })
      if (kind === 'rendezvous' || kind === 'chat' || kind === 'group' || kind === 'hub') {
        // Nobody holds metadata for the rendezvous infohash; a hostile metadata_size would otherwise cost
        // about 10 MB and 1,800 messages per wire (research w1-12 F20a).
        try { if (wire.ut_metadata && typeof wire.ut_metadata.cancel === 'function') wire.ut_metadata.cancel() } catch (_) { /* ignore */ }
      }
      // C2 seed-engine: the handle of a file wire (its seed lane), known once here.
      if (kind === 'file') info.handle = this._handleOfTorrent(torrent)
      // MAL53-6: a file wire may announce at most the info dictionary its listing's length allows (256 KiB at most).
      if (kind === 'file') {
        const maxT = (this.config.fileTorrent && this.config.fileTorrent.maxTorrentFileBytes) || 262144
        guardMetadataSize(wire, {
          maxBytes: fileMetadataBound(info.handle ? info.handle.expectedLength : null, maxT),
          onRefuse: (size) => { this._failures.metadataRefused = (this._failures.metadataRefused || 0) + 1; this._warning('file-metadata-too-large', { infoHash: info.handle ? info.handle.infoHash : null, size }) }
        })
      }
      try {
        if (wire.extendedHandshake && typeof wire.extendedHandshake === 'object') {
          const lane = kind === 'rendezvous' || kind === 'chat' || kind === 'group' || kind === 'hub'
          // C2 seed-engine: with a seed budget a site or file wire advertises reqq for its lane's rate.
          const upRate = this._seed && this._laneOfInfo(info) ? this._laneRate(this._laneOfInfo(info), false) : (this.uploadsEnabled ? this.policy.uploadLimit : 0)
          wire.extendedHandshake.reqq = lane ? this.config.wireGuard.reqqRendezvous : reqqFor(upRate === Infinity ? -1 : upRate, this.config.wireGuard)
        }
      } catch (_) { /* ignore */ }
      const simplePeer = wire.peerId ? this._pendingPeers.get(wire.peerId) : null // C2 seed-engine: for the local-wire test
      if (wire.peerId) this._pendingPeers.delete(wire.peerId)
      // Emergency bound before the handshake: twice the hard cap of the swarm is never exceeded, and (v0.3)
      // neither is twice the tab's wire budget across every swarm.
      if (this._swarmCount(kind, wire, { countAll: true }) >= this._caps(kind).hard * 2 || this._totalWires(wire, true) >= this._budgetTotal() * 2) {
        this._failures.capped++
        try { wire.destroy() } catch (_) { /* ignore */ }
        return
      }
      if (this._shouldLock(wire, info)) lockWire(wire) // C2 seed-engine: the v0.3 rule, or the lanes with a seed budget
      // C2 seed-engine: holders (E1), the H hand-off, super-seeding, the local-wire test, the lane throttle.
      if (kind === 'site' || kind === 'file') {
        this._watchHolder(wire, info)
        this._maybeSuperSeed(wire, info)
        this._detectLocal(wire, info, simplePeer)
      }
      if (this._seed) this._applyUploadThrottle()
      // Caps apply after the extended handshake (or after capGraceMs without one); then the tab's budget (v0.3).
      const count = () => {
        if (info.counted) return
        info.counted = true
        this._enforceCap(kind)
        this._enforceBudget()
      }
      if (typeof wire.on === 'function') {
        wire.on('extended', (ext) => { if (ext === 'handshake') count() })
      }
      info.graceTimer = this._t.setTimeout(count, this.config.policy.capGraceMs || 10000)
      wire.once('close', () => { if (info.graceTimer) this._t.clearTimeout(info.graceTimer) })
      if (kind === 'rendezvous' && this.rendezvous) {
        this.rendezvous.glare.retries = 0
        this.rendezvous.glare.lastWireAt = this._t.now()
      }
      const st = this._stallState(kind)
      if (st.since === null) st.since = now
      // v0.3 hook: extensions registered for this swarm kind, after the length guard is in place.
      for (const ext of this._extensions.values()) if (ext.swarms.has(kind)) this._callExtension(ext, wire, info, false)
    }
    this._recount()
    this._emit('wire', { wire, torrent, kind })
  }

  // ----- v0.3: anchors, ignored and idle wires, no-progress, budget (harden-loader) -------------------

  _callExtension (ext, wire, info, late) {
    if (info.exts.has(ext.name) || wire.destroyed) return
    info.exts.add(ext.name)
    // C2 seed-engine: infoHash added (mw_pin1 signs per infohash; a wire's extension never sees the BEP 3 handshake).
    const infoHash = this._ihOfInfo(info)
    try { ext.handler.onWire(wire, info.kind, { late, infoHash }) } catch (err) {
      this._warning('extension-error', { name: ext.name, message: errText(err) })
    }
  }

  /**
   * registerWireExtension(name, { onWire(wire, swarmKind, { late }) }, { swarms = ['rendezvous'] }) → unregister()
   * (v0.3 hook for lane chat: mw_chat1 on rendezvous wires). onWire runs synchronously from the 'wire' event of
   * every peer wire of the listed swarm kinds, after the 262,144-byte length guard is installed and before the
   * extended handshake goes out (so wire.use(...) there is advertised); wires that already exist get one call
   * with late: true (their handshake is out: BEP 10 allows an additive one). Web-seed wires never. Throws
   * TypeError for a bad or reserved name (ut_metadata, ut_pex, lt_donthave, mw_chain1, mw_chain2), an unknown
   * swarm kind or a missing onWire; Error E_EXISTS when the name is registered already.
   */
  registerWireExtension (name, handler, { swarms = ['rendezvous'] } = {}) {
    if (typeof name !== 'string' || !EXTENSION_NAME_RE.test(name) || RESERVED_EXTENSIONS.has(name)) {
      throw new TypeError('registerWireExtension: invalid or reserved extension name ' + JSON.stringify(name))
    }
    if (!handler || typeof handler.onWire !== 'function') throw new TypeError('registerWireExtension: handler.onWire must be a function')
    const list = Array.isArray(swarms) ? swarms : [swarms]
    if (!list.length || list.some((k) => SWARM_KINDS.indexOf(k) < 0)) throw new TypeError('registerWireExtension: swarms must be a non-empty list of ' + SWARM_KINDS.join(', '))
    if (this._extensions.has(name)) throw makeError('E_EXISTS', 'registerWireExtension: ' + name + ' is registered already')
    const ext = { name, handler, swarms: new Set(list) }
    this._extensions.set(name, ext)
    for (const [w, info] of Array.from(this._wireInfo)) {
      if (info.web || w.destroyed || !w.__mwGuard || !ext.swarms.has(info.kind)) continue
      this._callExtension(ext, w, info, true)
    }
    return () => { if (this._extensions.get(name) === ext) this._extensions.delete(name) }
  }

  /**
   * anchorWire(wire) → true when the wire is now anchored (v0.3, MF-74): it delivered valid data (the ledger
   * calls it for a wire that sent a valid block; verified pieces anchor their wires by themselves). Anchored
   * wires keep up to anchorShare of their swarm's hard cap through cap and budget eviction, and are exempt
   * from the idle close. Also marks progress for the wire's swarm.
   */
  anchorWire (wire) {
    const info = this._wireInfo.get(wire)
    if (!info || info.web || wire.destroyed) return false
    info.anchored = true
    info.lastRx = this._t.now()
    this._markProgress(info.kind)
    return true
  }

  /**
   * ignoreWire(wire, reason = 'ignored') → true when closed (v0.3, MF-74): a wire whose peer the ledger (or an
   * extension) ignores keeps no slot. Only the wire is closed; the self-declared peer id is never banned (a
   * swarm member could claim an honest visitor's id). Extensions may instead set wire.__mwIgnored = true; the
   * periodic check closes it.
   */
  ignoreWire (wire, reason = 'ignored') {
    const info = this._wireInfo.get(wire)
    if (!info || info.web || wire.destroyed) return false
    this._failures.ignored++
    this._warning('wire-ignored', { kind: info.kind, reason: String(reason) })
    try { wire.destroy() } catch (_) { /* closing */ }
    this._failuresChanged()
    return true
  }

  /** noteProgress(kind): the caller saw progress in that swarm (for example, the ledger is in sync), so no 'no-progress' is due. */
  noteProgress (kind) { if (SWARM_KINDS.indexOf(kind) >= 0) this._markProgress(kind) }

  _stallState (kind) {
    let st = this._stall[kind]
    if (!st) { st = { since: null, lastEmit: 0, delay: this._limits().noProgressMs }; this._stall[kind] = st }
    return st
  }

  _markProgress (kind) {
    const st = this._stallState(kind)
    st.since = this._t.now()
    st.lastEmit = 0
    st.delay = this._limits().noProgressMs
  }

  _onVerified (torrent, kind, index) {
    const i = Number(index)
    let any = false
    for (const [w, info] of this._wireInfo) {
      if (info.web || w.destroyed || info.torrent !== torrent || !info.pieces.has(i)) continue
      info.anchored = true
      info.pieces.delete(i)
      any = true
    }
    this._markProgress(kind)
    return any
  }

  /** Swarm kinds whose 'no-progress' matters: content swarms until complete, and the ledger rendezvous. */
  _swarmComplete (kind) {
    if (kind === 'site') return !!(this.site && this.site.mode === 'seed')
    if (kind === 'file') {
      for (const h of this._files.values()) if (!h.left && !h.done) return false
      return true
    }
    return false
  }

  /**
   * Periodic (wireLimits.checkMs): closes wires flagged __mwIgnored and wires idle for idleMs (nothing but
   * keep-alives since the handshake or the last message; anchored wires excepted), then emits 'no-progress'
   * { kind, wires, sinceMs } for site, rendezvous and file swarms that have wires but no progress for
   * noProgressMs (then 2x, 4x, ... up to noProgressMaxMs while it lasts).
   */
  _housekeep () {
    if (this.destroyed) return
    const now = this._t.now()
    const lim = this._limits()
    for (const [w, info] of Array.from(this._wireInfo)) {
      if (info.web || w.destroyed) continue
      if (w.__mwIgnored) { this.ignoreWire(w, 'flagged'); continue }
      if (info.anchored) continue
      const idle = now - Math.max(info.at, info.lastRx || 0)
      if (idle < lim.idleMs) continue
      this._failures.idle++
      this._warning('wire-idle', { kind: info.kind, idleMs: idle })
      try { w.destroy() } catch (_) { /* closing */ }
      this._failuresChanged()
    }
    for (const kind of ['site', 'rendezvous', 'file']) {
      const st = this._stallState(kind)
      const n = this._swarmCount(kind, null, { countAll: true })
      if (n === 0 || this._swarmComplete(kind)) { st.since = null; st.lastEmit = 0; st.delay = lim.noProgressMs; continue }
      if (st.since === null) { st.since = now; continue }
      const from = st.lastEmit || st.since
      if (now - from < st.delay) continue
      st.lastEmit = now
      st.delay = Math.min(st.delay * 2, lim.noProgressMaxMs)
      this._emit('no-progress', { kind, wires: n, sinceMs: now - st.since })
    }
    this._seedTick(now) // C2 seed-engine: E1 window, month change, re-plan
  }

  /** The config the budget functions read: with hubFirst while a hub lane syncs (SCALE-6), else this.config. */
  _budgetConfig () {
    let syncing = false
    for (const l of this._lanes.values()) {
      if (l.left || l.kind !== 'hub' || !l._syncing) continue
      try { if (l._syncing()) { syncing = true; break } } catch (_) { /* a lane's bug */ }
    }
    if (!syncing) return this.config
    return Object.assign({}, this.config, { wireBudget: Object.assign({}, this.config.wireBudget || {}, { hubFirst: true }) })
  }

  _budgetTotal () {
    const own = Number(this.policy && this.policy.wireBudget)
    if (Number.isFinite(own) && own > 0) return Math.floor(own)
    const p = this.policy || {}
    const device = p.deviceClass || (p.class && p.class !== 'desktop' ? 'phone' : 'desktop')
    return wireBudgetFor(device, this.config)
  }

  _countByKind (countAll) {
    const out = {}
    for (const k of SWARM_KINDS) out[k] = 0
    for (const [w, info] of this._wireInfo) {
      if (info.web || w.destroyed || (!countAll && !info.counted)) continue
      out[info.kind] = (out[info.kind] || 0) + 1
    }
    return out
  }

  _totalWires (except = null, countAll = false) {
    let n = 0
    for (const [w, info] of this._wireInfo) {
      if (w === except || info.web || w.destroyed || (!countAll && !info.counted)) continue
      n++
    }
    return n
  }

  _swarmActive (kind) {
    if (kind === 'site') return !!(this.site && (this.site.torrent || this.site.mode === 'download'))
    if (kind === 'rendezvous') return !!this.rendezvous
    if (kind === 'file') { for (const h of this._files.values()) if (!h.left) return true; return false }
    for (const l of this._lanes.values()) if (!l.left && l.kind === kind) return true
    return false
  }

  _anchorSlots (kind) {
    const share = Number(this._limits().anchorShare)
    return Math.floor(this._caps(kind).hard * (Number.isFinite(share) && share >= 0 && share <= 1 ? share : 0.5))
  }

  _entries (kind) {
    const list = []
    for (const [w, info] of this._wireInfo) {
      if (info.web || w.destroyed || info.kind !== kind || !info.counted) continue
      list.push({ w, score: wireScore(w), anchored: !!info.anchored, seq: info.seq })
    }
    return list
  }

  /** v0.3 (MF-39): over the tab's budget, the lowest priority swarm above its floor gives up its least useful wire. */
  _enforceBudget () {
    const total = this._budgetTotal()
    let dropped = 0
    for (let guard = 0; guard < 512; guard++) {
      const kind = budgetVictim(this._countByKind(false), total, this._budgetConfig())
      if (!kind) break
      const entries = this._entries(kind)
      const victims = evictionOrder(entries, { keep: entries.length - 1, anchorSlots: this._anchorSlots(kind), random: this._random })
      if (!victims.length) break
      this._failures.budget++
      dropped++
      try { victims[0].w.destroy() } catch (_) { /* closing */ }
      if (!victims[0].w.destroyed) { this._wireInfo.delete(victims[0].w); this._recount() }
    }
    if (dropped) this._failuresChanged()
    return dropped
  }

  _uploadExempt (info) {
    if (!info || info.kind !== 'file') return false
    for (const h of this._files.values()) if (h._torrent === info.torrent) return !!h.uploadException
    return false
  }

  _applyFileLock (h) {
    for (const [w, info] of this._wireInfo) {
      if (info.web || w.destroyed || info.torrent !== h._torrent || !h._torrent) continue
      if (this._seed) { if (this._shouldLock(w, info)) lockWire(w); else unlockWire(w); continue } // C2 seed-engine
      if (this.hiddenLocked || (!this.uploadsEnabled && !h.uploadException)) lockWire(w)
      else unlockWire(w)
    }
  }

  // ---- C2 seed-engine: lanes, buckets, meters (SZ 3.1.2 to 3.1.4) -----------------------------------------

  /**
   * setSeedBudget(budget) -> boolean: a seedBudget() result of src/loader/seed-budget.js ({ row, lanes: { H, K, E:
   * { rate, session } }, month: { cap, lanes }, local: { H, K, E, session, on }, hiddenH }); null turns the lanes off
   * (the v0.3 rules again). Recomputed by the loader on charging, level, network, visibility, dock and call changes: a
   * lane whose rate did not change keeps its bucket.
   */
  setSeedBudget (budget) {
    const prev = this._seed
    if (!budget || typeof budget !== 'object' || !budget.lanes || typeof budget.lanes !== 'object') {
      if (prev) this._clearSeedTimers(prev)
      this._seed = null
      this._applyLocks()
      this._applyUploadThrottle()
      return false
    }
    const b = normalizeSeedBudget(budget)
    const now = this._t.now()
    const keep = (old, rate) => (old && old.rate === rate ? old : createBucket(rate, now))
    const buckets = {}
    const localBuckets = {}
    for (const l of SEED_LANE_IDS) {
      buckets[l] = keep(prev && prev.buckets[l], b.lanes[l].rate)
      localBuckets[l] = keep(prev && prev.localBuckets[l], b.local[l])
    }
    if (prev) {
      for (const l of SEED_LANE_IDS) {
        if (prev.buckets[l] !== buckets[l] && prev.buckets[l].timer) this._t.clearTimeout(prev.buckets[l].timer)
        if (prev.localBuckets[l] !== localBuckets[l] && prev.localBuckets[l].timer) this._t.clearTimeout(prev.localBuckets[l].timer)
      }
    }
    this._seed = { budget: b, buckets, localBuckets, items: prev ? prev.items : new Map(), plan: prev ? prev.plan : { order: [], idle: new Set(), share: {} }, exhausted: new Set() }
    this._seedReplan()
    return true
  }

  /** setSeedMeters(meters): the loader's createSeedMeters() on its per-origin pref store (an in-memory one by default). */
  setSeedMeters (meters) {
    if (!meters || typeof meters.add !== 'function' || typeof meters.sessionUsed !== 'function' || typeof meters.monthUsed !== 'function') throw new TypeError('setSeedMeters: meters need add, sessionUsed and monthUsed')
    this._meters = meters
    if (this._seed) { this._seed.exhausted.clear(); this._applyLocks(); this._applyUploadThrottle() }
  }

  get meters () { return this._meters }

  /**
   * seeding -> { active, row, lanes: { H, K, E: { rate, session, used, local, open } }, month: { used, cap }, local }
   * (read-only, for mw.net.seeding() of lane wire-ui; counters are local only, ARCHITECTURE 8).
   */
  get seeding () {
    const s = this._seed
    const m = this._meters
    const used = (l, local) => { try { return Number(m.sessionUsed(l, { local })) || 0 } catch (_) { return 0 } }
    let month = 0
    try { month = Number(m.monthUsed()) || 0 } catch (_) { month = 0 }
    const lanes = {}
    for (const l of SEED_LANE_IDS) {
      lanes[l] = {
        rate: s ? s.budget.lanes[l].rate : null,
        session: s ? s.budget.lanes[l].session : null,
        used: used(l, false),
        local: used(l, true),
        open: s ? this._laneOpen(l, false, null) : null
      }
    }
    return { active: !!s, row: s ? s.budget.row : null, lanes, month: { used: month, cap: s ? s.budget.month.cap : null }, local: s ? Object.assign({}, s.budget.local) : null }
  }

  _clearSeedTimers (s) {
    if (!s) return
    const all = [].concat(SEED_LANE_IDS.map((l) => s.buckets[l]), SEED_LANE_IDS.map((l) => s.localBuckets[l]), Array.from(s.items.values()))
    for (const b of all) if (b && b.timer) { this._t.clearTimeout(b.timer); b.timer = null }
  }

  _handleOfTorrent (torrent) {
    if (!torrent) return null
    for (const h of this._files.values()) if (h._torrent === torrent) return h
    return null
  }

  /** The infohash a wire belongs to: its file handle's, else its torrent's. */
  _ihOfInfo (info) {
    if (!info) return null
    if (info.handle && typeof info.handle.infoHash === 'string') return info.handle.infoHash
    const t = info.torrent
    return t && typeof t.infoHash === 'string' ? t.infoHash.toLowerCase() : null
  }

  /** The seed lane of a wire: the site torrent is K, a file torrent its handle's lane; other swarms have none. */
  _laneOfInfo (info) {
    if (!info || info.web) return null
    if (info.kind === 'site') return 'K'
    if (info.kind === 'file') {
      const h = info.handle && info.handle._torrent === info.torrent ? info.handle : this._handleOfTorrent(info.torrent)
      return h ? h.lane : 'E'
    }
    return null
  }

  /** A host-to-host wire, counted on the local row (unless the budget says local wires count like others). */
  _isLocalInfo (info) {
    return !!(info && info.local === true && !(this._seed && this._seed.budget.local.on === false))
  }

  _laneRate (lane, local) {
    const s = this._seed
    if (!s) return 0
    return local ? s.budget.local[lane] : s.budget.lanes[lane].rate
  }

  _sessionUsed (lane, local) {
    try { return Number(this._meters.sessionUsed(lane, { local })) || 0 } catch (_) { return 0 }
  }

  _monthUsed () {
    try { return Number(this._meters.monthUsed()) || 0 } catch (_) { return 0 }
  }

  /** Whether a lane (local or not) may upload now; with an infohash, also that item's plan and share. */
  _laneOpen (lane, local, ih) {
    const s = this._seed
    if (!s) return true
    const rate = this._laneRate(lane, local)
    if (!(rate > 0)) return false
    if (local) {
      if (this._sessionUsed(lane, true) >= s.budget.local.session) return false
    } else {
      if (this._sessionUsed(lane, false) >= s.budget.lanes[lane].session) return false
      if (s.budget.month.lanes.indexOf(lane) >= 0 && this._monthUsed() >= s.budget.month.cap) return false
    }
    const now = this._t.now()
    const b = local ? s.localBuckets[lane] : s.buckets[lane]
    bucketLevel(b, now)
    if (b.drained) return false
    if (ih) {
      if (s.plan.idle.has(ih)) return false
      const ib = local ? null : s.items.get(ih)
      if (ib) { bucketLevel(ib, now); if (ib.drained) return false }
    }
    return true
  }

  /** The one lock rule: v0.3 (hidden, uploads off unless the per-upload exception) or, with a budget, the lanes. */
  _shouldLock (wire, info) {
    if (!info || info.web) return false
    const lane = this._seed ? this._laneOfInfo(info) : null
    if (!lane) {
      if (this.hiddenLocked) return true
      return !this.uploadsEnabled && !this._uploadExempt(info)
    }
    if (this.hiddenLocked && !(lane === 'H' && this._seed.budget.hiddenH)) return true
    const ih = this._ihOfInfo(info)
    return !this._laneOpen(lane, this._isLocalInfo(info), ih)
  }

  /** Every peer wire locked or unlocked by _shouldLock. */
  _applyLocks () {
    for (const [w, info] of this._wireInfo) {
      if (info.web || w.destroyed) continue
      if (this._shouldLock(w, info)) lockWire(w)
      else unlockWire(w)
    }
  }

  /**
   * The client throttle with a seed budget: the sum of the rates of the lanes (and local lanes) that have an unlocked
   * wire, plus the shaping floor when other swarms have wires (ledger gossip stays outside the lanes), at least the
   * floor; -1 (unshaped) when no lane wire may upload (they are choke-locked; never throttleUpload(0)).
   */
  _laneThrottle () {
    const s = this._seed
    if (!s) return -1
    const floor = Number(this.config.policy && this.config.policy.minShapingBytes) || 32768
    const seen = new Set()
    let sum = 0
    let others = false
    for (const [w, info] of this._wireInfo) {
      if (info.web || w.destroyed) continue
      const lane = this._laneOfInfo(info)
      if (!lane) { others = true; continue }
      if (this._shouldLock(w, info)) continue
      const local = this._isLocalInfo(info)
      const key = (local ? 'local:' : '') + lane
      if (seen.has(key)) continue
      seen.add(key)
      sum += this._laneRate(lane, local)
    }
    if (!(sum > 0) || !Number.isFinite(sum)) return -1
    return Math.max(floor, Math.round(sum + (others ? floor : 0)))
  }

  /** Uploaded piece bytes of one wire: the meters, then the lane, local lane and item buckets; a drained one locks. */
  _seedUpload (wire, info, bytes) {
    if (!(bytes > 0) || this.destroyed || !info || info.web) return
    const lane = this._laneOfInfo(info)
    if (!lane) return
    if (info.handle && info.handle._torrent === info.torrent) info.handle._uploaded += bytes
    const local = this._isLocalInfo(info)
    try { this._meters.add(lane, bytes, { local }) } catch (_) { /* the meters' problem */ }
    const s = this._seed
    if (!s) return
    const now = this._t.now()
    let changed = false
    const b = local ? s.localBuckets[lane] : s.buckets[lane]
    if (bucketTake(b, bytes, now)) { changed = true; this._armRefill(b) }
    const ih = this._ihOfInfo(info)
    const ib = !local && ih ? s.items.get(ih) : null
    if (ib && bucketTake(ib, bytes, now)) { changed = true; this._armRefill(ib) }
    // Session and month caps: lock once when first reached (a later budget or a new month opens them again).
    const capKey = (local ? 'local:' : '') + lane
    if (!s.exhausted.has(capKey) && !this._laneOpenCaps(lane, local)) { s.exhausted.add(capKey); changed = true }
    if (changed) { this._applyLocks(); this._applyUploadThrottle() }
  }

  _laneOpenCaps (lane, local) {
    const s = this._seed
    if (local) return this._sessionUsed(lane, true) < s.budget.local.session
    if (this._sessionUsed(lane, false) >= s.budget.lanes[lane].session) return false
    if (s.budget.month.lanes.indexOf(lane) >= 0 && this._monthUsed() >= s.budget.month.cap) return false
    return true
  }

  _armRefill (b) {
    if (!b || b.timer || !(b.rate > 0) || b.rate === Infinity) return
    const ms = bucketRefillMs(b, this._t.now())
    if (!Number.isFinite(ms)) return
    b.timer = this._t.setTimeout(() => {
      b.timer = null
      if (this.destroyed) return
      bucketLevel(b, this._t.now())
      if (b.drained) { this._armRefill(b); return }
      this._applyLocks()
      this._applyUploadThrottle()
    }, Math.max(1, ms))
  }

  /** Queues one re-plan (planSeeding) for the end of this tick. */
  _seedReplanSoon () {
    if (!this._seed || this._seedReplanQueued || this.destroyed) return
    this._seedReplanQueued = true
    microtask(() => { this._seedReplanQueued = false; if (this._seed && !this.destroyed) this._seedReplan() })
  }

  /** The items planSeeding orders: the site torrent (K) and every live file torrent with its lane. */
  _seedItems (now) {
    for (const h of Array.from(this._files.values())) this._handoffCheck(h) // re-lane ended hand-offs before planning
    const items = []
    const s = this.site
    const siteIh = s ? ((s.parsed && s.parsed.infoHash) || (s.record && s.record.btih) || null) : null
    if (siteIh && (s.torrent || s.mode === 'download')) {
      const st = this.localState(siteIh)
      items.push({ ih: siteIh, lane: 'K', bytes: (st && st.length) || 0, complete: s.mode === 'seed', copies: this._copies(siteIh, now), pinned: this._pinned(siteIh, now), openedAt: 0, own: false })
    }
    for (const h of this._files.values()) {
      if (h.left) continue
      const st = this.localState(h.infoHash)
      items.push({ ih: h.infoHash, lane: h.lane, bytes: (st && st.length) || 0, complete: !!(st && st.complete), copies: this._copies(h.infoHash, now), pinned: this._pinned(h.infoHash, now), openedAt: h.addedAt, own: h.lane === 'H' })
    }
    return items
  }

  /** planSeeding over the live items, then per-item buckets for shares below 1, then locks and the throttle. */
  _seedReplan () {
    const s = this._seed
    if (!s) { this._applyLocks(); this._applyUploadThrottle(); return }
    const now = this._t.now()
    const items = this._seedItems(now)
    let plan = null
    try { plan = this._seedFns.planSeeding({ items, budget: s.budget.raw, now, config: this.config }) } catch (err) {
      this._warning('seed-plan-error', { message: errText(err) })
      plan = null
    }
    if (!plan || !Array.isArray(plan.order)) plan = { order: items.map((i) => i.ih), idle: [], share: {} }
    s.plan = { order: plan.order.slice(), idle: new Set(Array.isArray(plan.idle) ? plan.idle : []), share: Object.assign({}, plan.share || {}) }
    const byIh = new Map(items.map((i) => [i.ih, i]))
    const next = new Map()
    for (const ih of s.plan.order) {
      const f = Number(s.plan.share[ih])
      const it = byIh.get(ih)
      if (!it || !(f > 0 && f < 1)) continue
      const rate = this._laneRate(it.lane, false) * f
      const old = s.items.get(ih)
      next.set(ih, old && old.rate === rate ? old : createBucket(rate, now))
    }
    for (const [ih, b] of s.items) if (next.get(ih) !== b && b.timer) this._t.clearTimeout(b.timer)
    s.items = next
    this._applyLocks()
    this._applyUploadThrottle()
  }

  // ---- C2 seed-engine: local wires, holders (E1), evidence, hand-off, super-seeding --------------------------

  /** Reads the selected candidate pair of a WebRTC wire once (simple-peer's RTCPeerConnection); local = false when unreadable. */
  _detectLocal (wire, info, simplePeer) {
    info.local = false
    const sp = simplePeer
    if (!sp || typeof sp !== 'object') return
    const pc = sp._pc
    let read = null
    if (pc && typeof pc.getStats === 'function') read = () => pc.getStats()
    else if (typeof sp.getStats === 'function') read = () => new Promise((resolve, reject) => { sp.getStats((err, r) => (err ? reject(err) : resolve(r))) })
    if (!read) return
    Promise.resolve().then(read).then((stats) => {
      if (wire.destroyed || this.destroyed || this._wireInfo.get(wire) !== info) return
      let r = null
      try { r = this._seedFns.isLocalPair(stats) } catch (_) { r = null }
      info.local = !!(r && r.local === true)
      info.localReason = r && typeof r.reason === 'string' ? r.reason : 'unknown'
      if (info.local && this._seed) { this._applyLocks(); this._applyUploadThrottle() }
    }, () => { info.local = false; info.localReason = 'no-stats' })
  }

  _piecesOf (ih) {
    const st = this.localState(ih)
    return st && st.pieces > 0 ? st.pieces : 0
  }

  _watchHolder (wire, info) {
    const ih = this._ihOfInfo(info)
    if (!ih || typeof wire.on !== 'function') return
    let recs = this._holders.get(ih)
    if (!recs) { recs = new Map(); this._holders.set(ih, recs) }
    // sent: the piece bytes this device uploaded on this wire (review round R 5.3, DS-4: evidence this device can check).
    const rec = { id: wire.peerId || null, complete: false, at: this._t.now(), open: true, n: 0, held: 0, sent: 0 }
    recs.set(wire, rec)
    wire.on('upload', (bytes) => {
      const before = rec.sent
      rec.sent += Number(bytes) || 0
      if (!rec.complete) return
      const st = this.localState(ih)
      const len = st && Number(st.length) > 0 ? Number(st.length) : 0
      if (len && before < len && rec.sent >= len) this._markEvidence(ih) // a served copy: the hand-off may end now
    })
    // Counted incrementally: bittorrent-protocol emits 'have' only for a piece the remote did not report before, so a
    // site of thousands of pieces costs one full count per bitfield, not one per have.
    // MP-10: have-all and have-none set the count in O(1); a full count of a bitfield runs at most once per 250 ms per
    // wire (a remote may repeat a 5-byte message thousands of times a second), the rest coalesce into one later count.
    let lastFull = -Infinity
    let pending = null
    const update = (full, index, set = null) => {
      if (recs !== this._holders.get(ih)) return
      const n = this._piecesOf(ih)
      if (set !== null) { rec.n = n; rec.held = set === 'all' ? n : 0 } else if (full || rec.n !== n) {
        const t = this._t.now()
        if (t - lastFull < 250) {
          if (!pending) pending = this._t.setTimeout(() => { pending = null; if (rec.open) update(true) }, 250 - (t - lastFull))
          return
        }
        lastFull = t
        rec.n = n
        rec.held = peerPiecesHeld(wire, n)
      } else if (Number(index) >= 0 && Number(index) < n) rec.held++
      const was = rec.complete
      rec.complete = n > 0 && rec.held >= n
      rec.at = this._t.now()
      if (rec.complete !== was) this._markEvidence(ih)
      else if (this._pinSource && this._isPinWire(wire)) this._markEvidence(ih) // the hand-off percentage moved
    }
    wire.on('bitfield', () => update(true))
    wire.on('have', (index) => update(false, index))
    wire.on('have-all', () => update(true, -1, 'all'))
    wire.on('have-none', () => update(true, -1, 'none'))
    wire.once('close', () => {
      if (pending) { try { this._t.clearTimeout(pending) } catch (_) { /* fired */ } pending = null }
      rec.open = false
      rec.at = this._t.now()
      if (rec.complete) this._markEvidence(ih)
    })
  }

  /**
   * Distinct complete holders seen within the E1 window (live wires now, closed ones until 60 s after closing). served: only
   * holders that got at least the whole item's bytes from this device on that wire (DS-4: a bitfield or have-all is a claim;
   * bytes this device sent are evidence it can check), so two wires that claim have-all at once do not end lane H.
   */
  _copies (ih, now = this._t.now(), { served = false } = {}) {
    const recs = this._holders.get(ih)
    const ids = new Set()
    let live = 0
    let need = 0
    if (served) {
      const st = this.localState(ih)
      need = st && Number(st.length) > 0 ? Number(st.length) : Infinity
    }
    if (recs) {
      for (const [w, r] of recs) {
        const open = r.open && !w.destroyed
        if (open) live++
        if (!r.complete || (!open && now - r.at > HOLDER_WINDOW_MS)) continue
        if (served && !(r.sent >= need)) continue
        ids.add(r.id !== null ? 'id:' + r.id : w)
      }
    }
    const kind = this._files.has(ih) ? 'file' : 'site'
    return { complete: ids.size, atLeast: live >= this._caps(kind).soft || this._totalWires(null, true) >= this._budgetTotal() }
  }

  _pinned (ih, now = this._t.now()) {
    const p = this._pinEvidence(ih, now)
    if (!p) return false
    if (p.receipt) return true
    return !!(p.heartbeat && p.heartbeat.has === true && now - Number(p.heartbeat.at) <= 900000)
  }

  _pinEvidence (ih, now) {
    const src = this._pinSource
    if (!src || typeof src.evidence !== 'function') return { configured: false, receipt: null, heartbeat: null }
    try { return src.evidence(ih, now) || { configured: false, receipt: null, heartbeat: null } } catch (_) { return { configured: false, receipt: null, heartbeat: null } }
  }

  _isPinWire (wire) {
    const src = this._pinSource
    try { return !!(src && typeof src.isPinWire === 'function' && src.isPinWire(wire)) } catch (_) { return false }
  }

  /**
   * setPinSource(src): the page's src/loader/pinwire.js PinWire ({ evidence(ih, now), isPinWire(wire),
   * pinProgress(ih, pieces) }); null removes it. PinWire.attach() calls this.
   */
  setPinSource (src) {
    this._pinSource = src && typeof src === 'object' ? src : null
    this.notePin(null)
  }

  /** notePin(ih | null): the pin source has news (a receipt, an authenticated wire, a heartbeat): evidence again. */
  notePin (infoHash = null) {
    const list = infoHash ? [String(infoHash).toLowerCase()] : this._knownInfoHashes()
    for (const ih of list) {
      this._markEvidence(ih)
      const ss = this._superseeds.get(ih)
      if (ss) ss.pinChanged()
    }
    this._seedReplanSoon()
  }

  _knownInfoHashes () {
    const out = new Set(this._files.keys())
    const s = this.site
    if (s && s.parsed && s.parsed.infoHash) out.add(s.parsed.infoHash)
    else if (s && s.record && s.record.btih) out.add(s.record.btih)
    for (const ih of this._holders.keys()) out.add(ih)
    return Array.from(out)
  }

  /**
   * localState(ih) -> { kind: 'site' | 'file', complete, length, pieces } | null: what this page holds of an item
   * (complete = every piece verified here: E0).
   */
  localState (infoHash) {
    const ih = typeof infoHash === 'string' ? infoHash.toLowerCase() : ''
    const s = this.site
    const siteIh = s ? ((s.parsed && s.parsed.infoHash) || (s.record && s.record.btih) || null) : null
    if (s && siteIh === ih) {
      const p = s.parsed || (this._download && this._download.parsed) || {}
      const pieces = Number(p.pieceCount) > 0 ? Number(p.pieceCount) : (p.pieceLength > 0 && p.length > 0 ? Math.ceil(p.length / p.pieceLength) : 0)
      return { kind: 'site', complete: s.mode === 'seed', length: Number(p.length) || 0, pieces }
    }
    const h = this._files.get(ih)
    if (!h) return null
    const t = h._torrent
    const p = h._parsed
    let length = p && Number(p.length) > 0 ? Number(p.length) : 0
    if (!length && t) { try { length = Number(t.length) || 0 } catch (_) { length = 0 } }
    let pieces = 0
    if (t && Array.isArray(t.pieces)) pieces = t.pieces.length
    if (!pieces && p) pieces = Number(p.pieceCount) > 0 ? Number(p.pieceCount) : (p.pieceLength > 0 && length > 0 ? Math.ceil(length / p.pieceLength) : 0)
    if (!pieces && t && t.pieceLength > 0 && length > 0) pieces = Math.ceil(length / t.pieceLength)
    return { kind: 'file', complete: !!(h.done || (t && t.done)), length, pieces }
  }

  /**
   * evidenceInputs(ih, { now }) -> { local, wires, webseed, pin, now, capped, pinPct }: the arguments of
   * availability.evidence() for an item (open wires report now; closed ones their close time), plus pinPct (the share
   * of the item the authenticated pin wire reports, for "Sending to the site: {pct}%", or null).
   */
  evidenceInputs (infoHash, { now } = {}) {
    const ih = typeof infoHash === 'string' ? infoHash.toLowerCase() : ''
    const t = Number.isFinite(now) ? now : this._t.now()
    const st = this.localState(ih)
    const wires = []
    const recs = this._holders.get(ih)
    if (recs) for (const [w, r] of recs) wires.push({ id: r.id, complete: r.complete, at: r.open && !w.destroyed ? t : r.at })
    const copies = this._copies(ih, t)
    const ws = this._webseedSeen && this._webseedSeen.infoHash === ih ? { ok: true, at: this._webseedSeen.at } : null
    return { local: !!(st && st.complete), wires, webseed: ws, pin: this._pinEvidence(ih, t), now: t, capped: copies.atLeast, pinPct: this._pinPct(ih) }
  }

  /** evidenceFor(ih, { now }) -> availability.evidence() plus { infoHash, pinPct } (pinPct: the pin wire's share, or null). */
  evidenceFor (infoHash, opts = {}) {
    const ih = typeof infoHash === 'string' ? infoHash.toLowerCase() : ''
    const ev = availabilityEvidence(this.evidenceInputs(ih, opts))
    ev.infoHash = ih
    ev.pinPct = this._pinPct(ih)
    return ev
  }

  _pinPct (ih) {
    const src = this._pinSource
    if (!src || typeof src.pinProgress !== 'function') return null
    try {
      const v = src.pinProgress(ih, this._piecesOf(ih))
      return Number.isFinite(v) ? v : null
    } catch (_) { return null }
  }

  _markEvidence (ih) {
    if (!ih || this.destroyed) return
    this._evidenceDirty.add(ih)
    if (this._evidenceTimer) return
    this._evidenceTimer = this._t.setTimeout(() => { this._evidenceTimer = null; this._flushEvidence() }, (this.config.ui && this.config.ui.progressIntervalMs) || 250)
  }

  /** Emits 'evidence' for the items whose label would change; ends hand-offs and super-seeding where the evidence says so. */
  _flushEvidence () {
    if (this.destroyed) return
    const list = Array.from(this._evidenceDirty)
    this._evidenceDirty.clear()
    let replan = false
    for (const ih of list) {
      const h = this._files.get(ih) || null
      if (this._handoffCheck(h)) replan = true
      const ev = this.evidenceFor(ih)
      const prev = this._evidence.get(ih)
      if (prev && sameEvidence(prev, ev) && prev.pinPct === ev.pinPct) continue
      this._evidence.set(ih, ev)
      const kind = h ? 'file' : 'site'
      this._emit('evidence', { infoHash: ih, kind, evidence: ev })
      if (h) handleEmit(h, 'evidence', { evidence: ev })
      replan = true
    }
    if (replan) this._seedReplanSoon()
  }

  /** H ends at a pin receipt or two complete peer copies (SZ 3.1.2): the handle moves to K (super-seeding stops). */
  _handoffCheck (h) {
    if (!h || h.left || h.handedOff || h.lane !== 'H') return false
    const now = this._t.now()
    const receipt = !!this._pinEvidence(h.infoHash, now).receipt
    const peers = this._copies(h.infoHash, now, { served: true }).complete
    if (!receipt && peers < HANDOFF_PEER_COPIES) return false
    h.handedOff = true
    h._lane = 'K'
    h.uploadException = false
    const ss = this._superseeds.get(h.infoHash)
    if (ss) ss.stop(receipt ? 'receipt' : 'handoff')
    handleEmit(h, 'lane', { lane: 'K', reason: receipt ? 'receipt' : 'peers' })
    this._status('handoff-done', { infoHash: h.infoHash, reason: receipt ? 'receipt' : 'peers' })
    this._applyFileLock(h)
    this._applyUploadThrottle()
    return true
  }

  _isPhone () {
    const p = this.policy || {}
    return (p.deviceClass || (p.class && p.class !== 'desktop' ? 'phone' : 'desktop')) !== 'desktop'
  }

  /** Behind CONFIG.seed.superSeed: an H torrent on a phone is super-seeded (BEP 16) until a receipt or a complete peer. */
  _maybeSuperSeed (wire, info) {
    if (info.kind !== 'file') return
    const seedCfg = this.config && this.config.seed
    if (!seedCfg || seedCfg.superSeed !== true || !this._isPhone()) return
    const h = info.handle
    if (!h || h.left || h.handedOff || h.lane !== 'H' || h._superseedDone) return
    let ss = this._superseeds.get(h.infoHash)
    if (!ss) {
      const pieces = this._piecesOf(h.infoHash)
      if (!(pieces > 0)) return
      const torrent = info.torrent
      ss = new SuperSeed({
        pieces,
        has: (i) => {
          const bf = h._torrent && h._torrent.bitfield
          if (bf && typeof bf.get === 'function') { try { return !!bf.get(i) } catch (_) { return false } }
          return h.done === true
        },
        isPin: (w) => this._isPinWire(w),
        // MP-15: the pin-first deadline runs on this manager's clock.
        now: () => this._t.now(),
        setTimeout: (fn, ms) => this._t.setTimeout(fn, ms),
        clearTimeout: (t) => this._t.clearTimeout(t),
        onStop: ({ reason }) => {
          if (this._superseeds.get(h.infoHash) === ss) this._superseeds.delete(h.infoHash)
          h._superseedDone = true
          this._status('superseed-stopped', { infoHash: h.infoHash, reason })
        }
      })
      if (torrent) this._superseeds.set(h.infoHash, ss)
    }
    if (ss.active) ss.addWire(wire)
  }

  /** Periodic (with _housekeep): drops holders closed for more than 60 s, re-checks a new month, re-plans. */
  _seedTick (now) {
    for (const [ih, recs] of this._holders) {
      let changed = false
      for (const [w, r] of recs) {
        if ((r.open && !w.destroyed) || now - r.at <= HOLDER_WINDOW_MS) continue
        recs.delete(w)
        if (r.complete) changed = true
      }
      if (!recs.size && !this._files.has(ih) && !(this.site && this.site.parsed && this.site.parsed.infoHash === ih)) this._holders.delete(ih)
      if (changed) this._markEvidence(ih)
    }
    const s = this._seed
    if (s) {
      // A lane whose cap was reached opens again only when the budget or the month changes.
      for (const key of Array.from(s.exhausted)) {
        const local = key.indexOf('local:') === 0
        const lane = local ? key.slice(6) : key
        if (this._laneOpenCaps(lane, local)) s.exhausted.delete(key)
      }
      this._seedReplan()
    }
  }

  /** Uploads off with a per-upload exception active: the exempt wires are shaped at mobileOptInUploadLimit (MF-45). */
  _applyUploadThrottle () {
    if (!this.client || typeof this.client.throttleUpload !== 'function') return
    // C2 seed-engine: with a seed budget, the sum of the lanes with an unlocked wire (never 0: -1 with every lane locked).
    if (this._seed) { try { this.client.throttleUpload(this._laneThrottle()) } catch (_) { /* ignore */ } return }
    let limit = this.uploadsEnabled && this.policy.uploadLimit > 0 ? Math.round(this.policy.uploadLimit) : -1
    if (!this.uploadsEnabled) {
      for (const h of this._files.values()) if (!h.left && h.uploadException) { limit = this.config.policy.mobileOptInUploadLimit || 131072; break }
    }
    try { this.client.throttleUpload(limit) } catch (_) { /* ignore */ }
  }

  /** Caps per swarm (v0.2.1 B6): content from the policy, rendezvous 6/9 desktop, 3/5 mobile; v0.3 chat, group, file. */
  _caps (kind) {
    const p = this.policy || {}
    if (kind === 'hub') {
      // SCALE-6: the lane's own ask (desktop 40, phones 8 while syncing and 2 once current), never above the tab budget.
      let want = null
      for (const l of this._lanes.values()) {
        if (l.left || l.kind !== 'hub' || !l._wanted) continue
        let n = null
        try { n = Number(l._wanted()) } catch (_) { n = null }
        if (Number.isFinite(n) && n >= 0) want = Math.max(want === null ? 0 : want, Math.floor(n))
      }
      const def = ((this.config.wireBudget && this.config.wireBudget.swarmCaps) || {}).hub
      const total = this._budgetTotal()
      const hard = Math.min(total, want !== null ? want : (def && def.hard > 0 ? def.hard : total))
      return { soft: Math.max(0, Math.min(hard, def && def.soft > 0 && want === null ? def.soft : hard)), hard: Math.max(0, hard) }
    }
    if (kind === 'chat' || kind === 'group' || kind === 'file') {
      const own = p[kind] && p[kind].soft > 0 ? p[kind] : null
      const def = ((this.config.wireBudget && this.config.wireBudget.swarmCaps) || {})[kind] || { soft: 3, hard: 4 }
      const c = own || def
      return { soft: c.soft, hard: Math.max(c.soft, c.hard || c.soft) }
    }
    if (kind === 'rendezvous') {
      if (p.rendezvous && p.rendezvous.soft > 0) return { soft: p.rendezvous.soft, hard: Math.max(p.rendezvous.soft, p.rendezvous.hard || p.rendezvous.soft) }
      const rv = this.config.policy.rendezvous || {}
      return Object.assign({ soft: 6, hard: 9 }, p.class && p.class !== 'desktop' ? rv.mobile : rv.desktop)
    }
    if (p.content && p.content.soft > 0) return { soft: p.content.soft, hard: Math.max(p.content.soft, p.content.hard || p.content.soft) }
    const soft = Math.max(1, Number(p.maxConns) || 1)
    const extra = Number(this.config.policy.contentHardExtra)
    return { soft, hard: soft + Math.max(1, Math.ceil(soft * (Number.isFinite(extra) ? extra : 0.5))) }
  }

  /**
   * Wires (web seeds excluded) of one swarm; countAll includes wires not counted yet. v0.3 (MF-74): every wire
   * counts, never the self-declared peer id (one remote on many wires takes that many slots).
   */
  _swarmCount (kind, except = null, { countAll = false } = {}) {
    let n = 0
    for (const [w, info] of this._wireInfo) {
      if (w === except || info.web || w.destroyed || info.kind !== kind) continue
      if (!countAll && !info.counted) continue
      n++
    }
    return n
  }

  _numwantFor (kind) {
    const caps = this._caps(kind)
    const lane = kind === 'rendezvous' || kind === 'chat' || kind === 'group' || kind === 'hub' || kind === 'file'
    const max = lane ? 3 : Math.max(0, Math.min(5, this.policy.numwant === undefined ? 3 : Number(this.policy.numwant) || 0))
    // v0.3 (MF-39): no new offers while the tab's wire budget is full.
    if (this._totalWires(null, true) >= this._budgetTotal()) return 0
    return Math.max(0, Math.min(max, caps.soft - this._swarmCount(kind, null, { countAll: true })))
  }

  /**
   * Over the hard cap: drop counted wires until at the cap (v0.3, MF-74): up to anchorShare of the cap is kept
   * for anchored wires, the rest go lowest score first, in random order among equal scores (evictionOrder).
   */
  _enforceCap (kind) {
    const { hard } = this._caps(kind)
    const list = this._entries(kind)
    if (list.length <= hard) return 0
    let dropped = 0
    for (const item of evictionOrder(list, { keep: hard, anchorSlots: this._anchorSlots(kind), random: this._random })) {
      this._failures.capped++
      dropped++
      try { item.w.destroy() } catch (_) { /* closing */ }
    }
    if (dropped) this._failuresChanged()
    return dropped
  }

  _onPeer (peer) {
    // WebRTC peers arrive as simple-peer objects; web seeds as URL strings (ignored).
    if (!peer || typeof peer !== 'object' || typeof peer.once !== 'function' || !peer.id) return
    const id = peer.id
    this._pendingPeers.set(id, peer)
    peer.once('error', (err) => { this._failures.lastIceError = (err && (err.code || err.message)) || 'error' })
    peer.once('close', () => {
      if (this._pendingPeers.get(id) !== peer) return
      this._pendingPeers.delete(id)
      this._failures.iceFailed++ // closed before its BitTorrent handshake: ICE or NAT failure
      this._failuresChanged()
    })
  }

  _recount () {
    const ids = new Set()
    let webseeds = 0
    for (const [wire, info] of this._wireInfo) {
      if (wire.destroyed) continue
      if (info.web) webseeds++
      else ids.add(wire.peerId || wire)
    }
    const count = ids.size
    if (count !== this._peerCount || webseeds !== this._webseedCount) {
      this._peerCount = count
      this._webseedCount = webseeds
      this._emit('peers', { count, webseeds })
      this._scheduleProgress()
      this._failuresChanged()
    }
  }

  // v0.3 (MF-45): wires of a file torrent with a per-upload exception stay unlocked while uploads are off
  // (never while the page is hidden).
  _lockAll () {
    for (const [wire, info] of this._wireInfo) {
      if (!this.hiddenLocked && this._uploadExempt(info)) unlockWire(wire)
      else lockWire(wire)
    }
  }

  _unlockAll () { for (const wire of this._wireInfo.keys()) unlockWire(wire) }

  /** B5: the periodic buffer watchdog (every bufferWatchdogMs). */
  _watchdog () {
    const limit = this.config.wireGuard.bufferWatchdogBytes
    for (const [wire, info] of this._wireInfo) {
      if (info.web || wire.destroyed || wire.__mwDropped) continue
      if (!bufferOverflow(wire, limit)) continue
      const size = wire._bufferSize
      wire.__mwDropped = true
      this._failures.dropped++
      this._warning('wire-buffer-overflow', { length: size })
      try { wire.destroy() } catch (_) { /* closing */ }
      this._failuresChanged()
    }
  }

  // ----- progress -----------------------------------------------------------------------------

  _scheduleProgress () {
    if (this._progressTimer || this.destroyed) return
    this._progressTimer = this._t.setTimeout(() => {
      this._progressTimer = null
      this._flushProgress()
    }, this.config.ui.progressIntervalMs)
  }

  _flushProgress () {
    const t = (this._download && this._download.torrent) || (this.site && this.site.torrent)
    let downloaded = this._downloaded
    let speedDown = 0
    let speedUp = 0
    if (t) {
      try { if (!(this.site && this.site.mode === 'seed')) downloaded = t.downloaded || downloaded } catch (_) { /* webtorrent #3104 */ }
      try { speedDown = t.downloadSpeed || 0 } catch (_) { speedDown = 0 }
      try { speedUp = t.uploadSpeed || 0 } catch (_) { speedUp = 0 }
      try { if (t.length) this._total = t.length } catch (_) { /* no metadata */ }
    }
    this._downloaded = downloaded
    this._emit('progress', {
      downloaded,
      total: this._total,
      progress: this._total ? Math.min(1, downloaded / this._total) : 0,
      peers: this._peerCount,
      webseeds: this._webseedCount,
      downloadSpeed: speedDown,
      uploadSpeed: speedUp,
      uploaded: this.uploadedBytes,
      peerBytes: this.peerBytes,
      webseedBytes: this.webseedBytes,
      source: this.source
    })
  }

  // ----- trackers: diagnostics, connection shim, keepalive (B1) ---------------------------------

  _trackerClients () {
    const out = []
    const add = (torrent, kind) => {
      const tc = torrent && torrent.discovery && torrent.discovery.tracker
      if (tc) out.push({ tc, kind, torrent })
    }
    add(this._download && this._download.torrent, 'site')
    if (!(this._download && this._download.torrent)) add(this.site && this.site.torrent, 'site')
    add(this.rendezvous && this.rendezvous.torrent, 'rendezvous')
    for (const h of this._files.values()) add(h._torrent, 'file')
    for (const l of this._lanes.values()) add(l._torrent, l.kind)
    return out
  }

  _shimTrackers (torrent, kind) {
    const tc = torrent && torrent.discovery && torrent.discovery.tracker
    if (!tc) return 0
    this._hookTrackerClient(tc, kind)
    const cfg = this.config.tracker
    let n = 0
    for (const t of Array.isArray(tc._trackers) ? tc._trackers : []) {
      if (installTrackerShim(t, { timers: this._t, random: this._random, now: () => this._t.now(), baseMs: cfg.reconnectBaseMs, jitterMs: cfg.reconnectJitterMs, maxMs: cfg.reconnectMaxMs })) n++
    }
    return n
  }

  _hookTrackerClient (tc, kind) {
    if (!tc || tc.__mwHooked || typeof tc.on !== 'function') return
    tc.__mwHooked = true
    const record = (data) => {
      if (!data || !data.announce) return
      const bucket = this._failures.swarm[kind] || (this._failures.swarm[kind] = {})
      bucket[data.announce] = { complete: Number(data.complete) || 0, incomplete: Number(data.incomplete) || 0, at: this._t.now() }
      this._failuresChanged()
    }
    tc.on('update', record)
    tc.on('scrape', record)
  }

  _pollTrackers () {
    const states = {}
    for (const { tc, kind, torrent } of this._trackerClients()) {
      this._hookTrackerClient(tc, kind)
      this._shimTrackers(torrent, kind)
      for (const t of Array.isArray(tc._trackers) ? tc._trackers : []) {
        if (t && t.announceUrl && states[t.announceUrl] !== 'open') states[t.announceUrl] = trackerStateOf(t)
      }
    }
    const prev = this._failures.trackers
    for (const url of Object.keys(states)) {
      if (prev[url] === states[url]) continue
      this._emit('tracker', { url, state: states[url] })
    }
    const changed = Object.keys(states).length !== Object.keys(prev).length || Object.keys(states).some((u) => prev[u] !== states[u])
    this._failures.trackers = states
    if (changed) this._failuresChanged()
    this._glareCheck()
  }

  /**
   * B1 keepalive: every socket (pooled per tracker URL, shared by our torrents) that has been silent for
   * keepaliveAnnounceMs gets one offer-free announce (numwant 0) from one of our tracker instances. A scrape
   * is never sent (tracker.openwebtorrent.com closes the socket on scrape).
   */
  _keepalive () {
    const now = this._t.now()
    const every = this.config.wire.keepaliveAnnounceMs
    const byUrl = new Map()
    for (const { tc } of this._trackerClients()) {
      for (const t of Array.isArray(tc._trackers) ? tc._trackers : []) {
        if (!t || !t.announceUrl) continue
        if (!byUrl.has(t.announceUrl)) byUrl.set(t.announceUrl, [])
        byUrl.get(t.announceUrl).push(t)
      }
    }
    for (const [, list] of byUrl) {
      const open = list.filter((t) => trackerStateOf(t) === 'open')
      if (!open.length) continue
      let last = 0
      for (const t of list) last = Math.max(last, t.__mwLastSend || t.__mwInstalledAt || 0)
      if (now - last < every) continue
      try {
        if (keepaliveAnnounce(open[0])) {
          if (!open[0].__mwLastSend || open[0].__mwLastSend < now) open[0].__mwLastSend = now
          this._failures.keepalives++
        }
      } catch (_) { /* socket closing */ }
    }
  }

  _failuresChanged () {
    const f = this._failures
    const key = JSON.stringify([f.trackers, f.iceFailed, f.dropped, f.capped, f.webseed, f.noWebseed, Object.keys(f.webseedBackoff), this._peerCount, f.swarm.site ? Object.keys(f.swarm.site).length : 0])
    if (key === this._lastFailureKey) return
    this._lastFailureKey = key
    this._emit('sync', { failures: this.failures })
  }

  // ----- web seed probe -----------------------------------------------------------------------

  /**
   * probeWebseed(wsBase, parsed) → { ok, reason }. Sends the request the (patched, v0.2.1 B3) web-seed
   * connection sends: GET with Range: bytes=0-0 only, cache: 'no-store'. A Range-only request needs no
   * CORS preflight, so this checks exactly what the engine will meet. 206 = usable, 200 = no Range support.
   */
  async probeWebseed (wsBase, parsed) {
    const url = webseedFileUrl(wsBase, parsed)
    if (!url) return { ok: false, reason: 'no-file' }
    if (!this._fetch) return { ok: false, reason: 'no-fetch' }
    const ctl = typeof AbortController === 'function' ? new AbortController() : null
    const timer = ctl ? this._t.setTimeout(() => { try { ctl.abort() } catch (_) { /* ignore */ } }, this.config.timeouts.xsMs) : null
    try {
      const res = await this._fetch(url, {
        method: 'GET',
        cache: 'no-store',
        headers: { range: 'bytes=0-0' },
        signal: ctl ? ctl.signal : undefined
      })
      if (res.status === 206) {
        try { await res.arrayBuffer() } catch (_) { /* body not needed */ }
        return { ok: true, reason: null }
      }
      try { if (res.body && typeof res.body.cancel === 'function') res.body.cancel() } catch (_) { /* ignore */ }
      return { ok: false, reason: res.ok ? 'no-range' : 'http-' + res.status }
    } catch (_) {
      return { ok: false, reason: 'unreachable' }
    } finally {
      if (timer) this._t.clearTimeout(timer)
    }
  }

  /**
   * _probeAll(record, parsed, { onGood }) → Promise<string[]>: every web seed of the pointer is probed
   * at once, each with its own timeout (code review round 1: they used to be probed one after the
   * other, 10 s each, before any tracker or peer was contacted). onGood(list) runs each time one more
   * passes, with the passing ones cheapest first (orderWebseeds). A torrent with BEP 47 pad files keeps
   * only the worker's own /_mw/ws/ rewrite (which answers pad files with zeros): another host has no
   * file at a pad path, so every piece touching one would fail there (warning 'webseed-pad').
   */
  _probeAll (record, parsed, { onGood = null } = {}) {
    let bases = orderWebseeds(webseedBases(record, this._base), this._origin)
    if (parsed && Array.isArray(parsed.files) && parsed.files.some((f) => f && f.pad && f.length > 0)) {
      const kept = bases.filter((u) => isOwnRewrite(u, this._origin))
      for (const u of bases) if (kept.indexOf(u) < 0) this._warning('webseed-pad', { url: u })
      bases = kept
    }
    if (!bases.length) {
      this._failuresChanged()
      return Promise.resolve([])
    }
    const rank = new Map(bases.map((u, i) => [u, i]))
    const good = []
    return Promise.all(bases.map((base) => {
      this._status('probing-webseed', { url: base })
      return this.probeWebseed(base, parsed).then((r) => {
        if (r.ok) {
          good.push(base)
          good.sort((a, b) => rank.get(a) - rank.get(b))
          this._failures.webseed = 'ok'
          // C2 seed-engine: E3 evidence (the web seed answered a probe) for the site torrent.
          if (parsed && parsed.infoHash) { this._webseedSeen = { ok: true, at: this._t.now(), infoHash: parsed.infoHash }; this._markEvidence(parsed.infoHash) }
          if (onGood) { try { onGood(good.slice()) } catch (_) { /* the caller's problem */ } }
        } else {
          if (this._failures.webseed !== 'ok') this._failures.webseed = r.reason
          this._warning('webseed-broken', { url: base, reason: r.reason })
        }
      })
    })).then(() => {
      this._failuresChanged()
      return good.slice()
    })
  }

  // A web seed that passed its probe while a download runs: it starts a torrent that waited for one
  // (consent pending), or joins the running torrent unless a web seed is already in use (B4: one at a
  // time; the others stay in ctx.urlList for the fail-over).
  _webseedsChanged (ctx, good) {
    if (!ctx || ctx.settled || this._download !== ctx) return
    ctx.urlList = good
    if (ctx.waiting) {
      this._startDownload()
      return
    }
    const t = ctx.torrent
    if (!t || t.destroyed) return
    const active = this._activeWebseeds(ctx)
    if (!active.length || ctx.webseedInUse === active[0]) return
    if (ctx.webseedInUse && !this.webseedBlocked(ctx.webseedInUse)) return
    try { t.addWebSeed(active[0]) } catch (_) { /* duplicate or destroyed */ }
    ctx.webseedInUse = active[0]
  }

  // ----- web-seed circuit breaker (B4) ----------------------------------------------------------

  _webseedState (url) {
    let st = this._webseeds.get(url)
    if (!st) { st = { failures: [], backoffUntil: 0, timer: null, code: null }; this._webseeds.set(url, st) }
    return st
  }

  /** True while a web seed sits out its back-off. */
  webseedBlocked (url, now = this._t.now()) {
    const st = this._webseeds.get(url)
    return !!(st && st.backoffUntil > now)
  }

  /** The one web seed in use: the cheapest of the probed list that is not in back-off (B4). */
  _activeWebseeds (ctx) {
    const list = ctx && Array.isArray(ctx.urlList) ? ctx.urlList : []
    const now = this._t.now()
    const first = list.find((u) => !this.webseedBlocked(u, now))
    return first ? [first] : []
  }

  _guardWebseed (wire, torrent) {
    const url = wire.url || wire.connId
    if (!url || typeof wire.httpRequest !== 'function' || wire.__mwWebseed) return
    wire.__mwWebseed = true
    const original = wire.httpRequest
    const self = this
    wire.httpRequest = function mwGuardedHttpRequest (pieceIndex, offset, length, cb) {
      if (self.webseedBlocked(url)) return cb(makeError('E_WEBSEED_BACKOFF', 'web seed in back-off'))
      return original.call(this, pieceIndex, offset, length, (err, data) => {
        let failure = err
        // A host that ignores Range (200 with the whole file) or cuts the range wrongly returns a body
        // of the wrong length: refuse it before it reaches the piece (no hash-failure hot loop).
        if (!failure && data && typeof data.length === 'number' && data.length !== length) {
          failure = makeError('E_WEBSEED_RANGE', 'web seed returned ' + data.length + ' bytes for a ' + length + ' byte range')
        }
        if (failure) {
          self._webseedFailure(url, failure.code || 'E_WEBSEED_HTTP', torrent)
          return cb(failure, null)
        }
        self._webseedPieces.set(pieceIndex, { url, at: self._t.now() })
        return cb(null, data)
      })
    }
  }

  _onPieceFailed (torrent, index) {
    const now = this._t.now()
    let record = this._webseedPieces.get(index)
    if (record) this._webseedPieces.delete(index)
    if (record && now - record.at > WEBSEED_ATTRIBUTION_MS) record = null
    // Precise attribution is the per-wire httpRequest wrapper; when it did not record this piece (the
    // wire wrapper may attach after the first request), fall back to the active web seed, but only when no
    // peer wire could have served the bad bytes (webtorrent bans a peer that fails verification itself).
    if (!record) {
      if (this._peerWireCount() > 0) return
      const active = this._activeWebseedUrls()
      if (!active.length) return
      record = { url: active[0], at: now }
    }
    this._webseedFailure(record.url, 'E_WEBSEED_BYTES', torrent)
  }

  /** Non-web, non-destroyed wires (peers) across the swarms. */
  _peerWireCount () {
    let n = 0
    for (const [w, info] of this._wireInfo) if (!info.web && !w.destroyed) n++
    return n
  }

  /** The web seeds of the current site record that are attached and not in back-off (cheapest first). */
  _activeWebseedUrls () {
    const record = (this._download && this._download.record) || (this.site && this.site.record) || null
    if (!record) return []
    const now = this._t.now()
    return orderWebseeds(webseedBases(record, this._base), this._origin).filter((u) => !this.webseedBlocked(u, now))
  }

  /**
   * One failure of a web seed. failureLimit failures within failureWindowMs: the web seed leaves every
   * torrent for backoffMs (nothing is requested from that host meanwhile), a warning names it, and the
   * next web seed of the pointer (cheapest first) takes over.
   */
  _webseedFailure (url, code, torrent) {
    const cfg = this.config.webseed
    const now = this._t.now()
    const st = this._webseedState(url)
    if (st.backoffUntil > now) return
    st.failures = st.failures.filter((at) => now - at < cfg.failureWindowMs)
    st.failures.push(now)
    st.code = code
    if (st.failures.length < cfg.failureLimit) return
    st.failures = []
    st.backoffUntil = now + cfg.backoffMs
    this._failures.webseed = code === 'E_WEBSEED_BYTES' || code === 'E_WEBSEED_RANGE' ? 'wrong-bytes' : 'unreachable'
    this._failures.webseedBackoff[url] = { code, until: st.backoffUntil }
    for (const t of new Set([torrent, this._download && this._download.torrent, this.site && this.site.torrent])) {
      if (!t || t.destroyed || typeof t.removePeer !== 'function') continue
      try { t.removePeer(url) } catch (_) { /* not attached */ }
    }
    if (st.timer) this._t.clearTimeout(st.timer)
    st.timer = this._t.setTimeout(() => this._webseedRetry(url), cfg.backoffMs)
    this._warning('webseed-backoff', { url, reason: code, until: st.backoffUntil, backoffMs: cfg.backoffMs })
    this._failuresChanged()
    // Fail over to the next web seed of the pointer, if any.
    const ctx = this._download
    if (ctx && !ctx.settled && ctx.torrent && !ctx.torrent.destroyed) {
      for (const next of this._activeWebseeds(ctx)) {
        if (next === url) continue
        try { ctx.torrent.addWebSeed(next) } catch (_) { /* duplicate */ }
        ctx.webseedInUse = next
      }
    }
  }

  _webseedRetry (url) {
    const st = this._webseeds.get(url)
    if (!st || this.destroyed) return
    st.timer = null
    st.backoffUntil = 0
    delete this._failures.webseedBackoff[url]
    this._failuresChanged()
    const ctx = this._download
    if (!ctx || ctx.settled || !ctx.torrent || ctx.torrent.destroyed) return
    const active = this._activeWebseeds(ctx)
    if (!active.includes(url)) return
    try { ctx.torrent.addWebSeed(url) } catch (_) { /* duplicate */ }
    this._status('webseed-retry', { url })
  }

  // ----- torrent file (xs) --------------------------------------------------------------------

  async _parseChecked (bytes, btih, deps) {
    try {
      const parsed = await deps.parseTorrentFile(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
      if (parsed && parsed.infoHash === btih) return parsed
      this._warning('torrent-mismatch', { expected: btih, got: parsed && parsed.infoHash })
    } catch (err) {
      this._warning('torrent-invalid', { message: errText(err) })
    }
    return null
  }

  async _fetchTorrent (url, btih, deps, signal, cancelled = null) {
    if (!this._fetch) return { parsed: null, mismatch: false }
    const ctl = typeof AbortController === 'function' ? new AbortController() : null
    const abort = () => { try { if (ctl) ctl.abort() } catch (_) { /* ignore */ } }
    const timer = this._t.setTimeout(abort, this.config.timeouts.xsMs)
    if (signal) signal.addEventListener('abort', abort, { once: true })
    try {
      this._status('fetching-torrent', { url })
      const res = await this._fetch(url, { signal: ctl ? ctl.signal : undefined, credentials: 'omit' })
      if (!res.ok) {
        this._warning('xs-failed', { url, reason: 'http-' + res.status })
        return { parsed: null, mismatch: false }
      }
      // Code review round 1: read with a cap (a hostile xs= host could otherwise send any size before
      // the check; on a hub that host is the link author's).
      const buf = await readCappedBody(res, MAX_TORRENT_FILE_BYTES)
      if (buf === null) {
        this._warning('xs-failed', { url, reason: 'too-large' })
        return { parsed: null, mismatch: false }
      }
      const parsed = await deps.parseTorrentFile(buf)
      if (!parsed || parsed.infoHash !== btih) {
        this._warning('torrent-mismatch', { url, expected: btih, got: parsed && parsed.infoHash })
        return { parsed: null, mismatch: true }
      }
      return { parsed, mismatch: false }
    } catch (err) {
      if (!(cancelled && cancelled())) this._warning('xs-failed', { url, reason: errText(err) })
      return { parsed: null, mismatch: false }
    } finally {
      this._t.clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', abort)
    }
  }

  // ----- download -----------------------------------------------------------------------------

  /**
   * download({ record, torrentFile, maxBytes, signal }) → { torrent, manifest, blobs, parsed }
   * Torrent bytes come from torrentFile (stored) or xs= first, then client.add(bytes | magnet,
   * { store: MemoryChunkStore, announce: exact, private: true, urlList: web seeds that passed the
   * probe }). The web seed starts at once; trackers and peers only while consent allows them.
   * Rejects with E_TOO_LARGE, E_TIMEOUT, E_NO_PEERS (only when the pointer has neither xs nor ws),
   * E_ABORTED or E_BAD_TORRENT.
   */
  async download ({ record, torrentFile = null, maxBytes = Infinity, signal = null } = {}) {
    if (this.destroyed) throw makeError('E_ABORTED', 'TorrentManager destroyed')
    if (!record || !BTIH_RE.test(String(record.btih || ''))) throw makeError('E_BAD_TORRENT', 'The pointer has no valid infohash')
    if (signal && signal.aborted) throw makeError('E_ABORTED', 'Download aborted before it started')
    if (this._download && !this._download.settled) this._settleDownload(makeError('E_ABORTED', 'Replaced by a new download'))
    const deps = await this._loadDeps()
    if (this.site && this.site.torrent) this.stopSite()
    const btih = record.btih
    const xs = xsUrls(record, this._base)
    const ws = webseedBases(record, this._base)
    this._failures.noWebseed = !(xs.length || ws.length)
    if (this._failures.noWebseed) this._warning('no-webseed', {})
    this.site = { mode: 'download', record, parsed: null, manifest: null, blobs: null, torrent: null, fromCache: false }
    this.peerBytes = 0
    this.webseedBytes = 0
    this.uploadedBytes = 0
    this._downloaded = 0

    let parsed = null
    let mismatches = 0
    if (torrentFile) parsed = await this._parseChecked(torrentFile, btih, deps)
    if (!parsed && xs.length) {
      // Every xs= at once; the first whose infohash matches wins (code review round 1).
      const r = await this._fetchFirstTorrent(xs, btih, deps, signal)
      parsed = r.parsed
      mismatches = r.mismatches
    }
    if (signal && signal.aborted) throw makeError('E_ABORTED', 'Download aborted')
    if (!parsed && mismatches > 0 && mismatches === xs.length && announceListFor(record, this.config.trackers).length === 0) {
      throw makeError('E_BAD_TORRENT', 'Every torrent file from xs= has a different infohash than the pointer')
    }
    if (parsed) {
      this._total = parsed.length
      if (Number.isFinite(maxBytes) && parsed.length > maxBytes) {
        throw makeError('E_TOO_LARGE', 'Site is ' + parsed.length + ' bytes, above the ' + maxBytes + ' byte limit', { length: parsed.length, maxBytes })
      }
    }
    // Code review round 1 (§5.4 "trackers and web seed start together"): the torrent starts now (with
    // peers when consent allows them); the web seeds join as their probes pass.
    return new Promise((resolve, reject) => {
      const ctx = this._download = {
        record, parsed, urlList: [], maxBytes, signal, resolve, reject, deps,
        holder: { inner: null, chunkLength: 0 }, bitfield: null, torrent: null,
        settled: false, everWire: false, gotMetadata: !!parsed, startedAt: this._t.now(),
        timers: [], blobPromises: new Map(), hasHttp: xs.length > 0 || ws.length > 0, webseedInUse: null,
        probing: !!parsed && ws.length > 0
      }
      if (signal) {
        ctx.onAbort = () => this._settleDownload(makeError('E_ABORTED', 'Download aborted'))
        signal.addEventListener('abort', ctx.onAbort, { once: true })
      }
      this._startDownload()
      if (parsed) {
        this._probeAll(record, parsed, { onGood: (good) => this._webseedsChanged(ctx, good) }).then(() => {
          ctx.probing = false
          // Nothing to start a waiting (consent pending) download with: say so once every probe is in.
          if (!ctx.settled && ctx.waiting && !ctx.urlList.length) this._status('waiting-consent')
        })
      }
    })
  }

  /** Every xs= fetched in parallel; the first that parses to the pointer's btih wins, the rest are stopped. */
  _fetchFirstTorrent (xs, btih, deps, signal) {
    if (xs.length === 1) return this._fetchTorrent(xs[0], btih, deps, signal).then((r) => ({ parsed: r.parsed, mismatches: r.mismatch ? 1 : 0 }))
    return new Promise((resolve) => {
      const ctl = typeof AbortController === 'function' ? new AbortController() : null
      const stop = () => { try { if (ctl) ctl.abort() } catch (_) { /* ignore */ } }
      if (signal) {
        if (signal.aborted) stop()
        else signal.addEventListener('abort', stop, { once: true })
      }
      let left = xs.length
      let mismatches = 0
      let done = false
      const finish = (value) => {
        if (done) return
        done = true
        if (signal) signal.removeEventListener('abort', stop)
        resolve(value)
      }
      for (const url of xs) {
        this._fetchTorrent(url, btih, deps, ctl ? ctl.signal : signal, () => done).then((r) => {
          if (r.mismatch) mismatches++
          if (r.parsed) {
            finish({ parsed: r.parsed, mismatches })
            stop()
          }
        }, () => {}).then(() => {
          left--
          if (left === 0) finish({ parsed: null, mismatches })
        })
      }
    })
  }

  _startDownload () {
    const ctx = this._download
    if (!ctx || ctx.settled || this.suspended || this.destroyed) return
    const peers = this._peersAllowed()
    const http = !!(ctx.parsed && this._activeWebseeds(ctx).length)
    if (!peers && !http) {
      ctx.waiting = true
      this._status('waiting-consent')
      return
    }
    ctx.waiting = false
    const urlList = this._activeWebseeds(ctx)
    ctx.webseedInUse = urlList.length ? urlList[0] : null
    const opts = { announce: this._announceFor(ctx.record), private: true, urlList, getAnnounceOpts: () => ({ numwant: this._numwantFor('site') }) }
    if (ctx.holder.inner && ctx.bitfield) {
      opts.preloadedStore = new RetainedStore(ctx.holder.inner, ctx.holder.chunkLength)
      opts.bitfield = ctx.bitfield
    } else {
      opts.store = retainingStoreClass(ctx.deps.MemoryChunkStore, ctx.holder)
    }
    const source = ctx.parsed ? minimalTorrentBytes(ctx.parsed.infoBytes) : 'magnet:?xt=urn:btih:' + ctx.record.btih
    let torrent
    try {
      torrent = this._add(source, opts, 'site')
    } catch (err) {
      this._settleDownload(makeError('E_BAD_TORRENT', errText(err)))
      return
    }
    ctx.torrent = torrent
    this.site.torrent = torrent
    this._seedReplanSoon() // C2 seed-engine: the site torrent joins the plan (lane K)
    this._status(peers ? 'connecting' : 'webseed-only')
    const current = () => ctx.torrent === torrent && !ctx.settled

    torrent.on('wire', () => { if (current()) { ctx.everWire = true; this._clearTimer(ctx, 'noPeers') } })
    torrent.on('error', (err) => { if (current()) this._settleDownload(makeError('E_BAD_TORRENT', errText(err))) })
    torrent.on('metadata', () => {
      if (!current()) return
      ctx.gotMetadata = true
      this._clearTimer(ctx, 'metadata')
      this._clearTimer(ctx, 'noPeers')
      try { this._total = torrent.length } catch (_) { /* ignore */ }
      if (Number.isFinite(ctx.maxBytes) && torrent.length > ctx.maxBytes) {
        this._settleDownload(makeError('E_TOO_LARGE', 'Site is ' + torrent.length + ' bytes, above the ' + ctx.maxBytes + ' byte limit', { length: torrent.length, maxBytes: ctx.maxBytes }))
        return
      }
      if (!ctx.parsed) this._afterMagnetMetadata(ctx, torrent)
      this._status('downloading', { name: torrent.name })
      this._watchFiles(ctx, torrent)
      this._armStall(ctx)
    })
    torrent.on('download', () => { if (current()) this._armStall(ctx) })
    torrent.on('done', () => { if (current()) this._finishDownload(ctx, torrent) })
    if (ctx.gotMetadata) this._armStall(ctx)
    this._armStartTimers(ctx)
  }

  // Magnet path: metadata arrived from peers; parse it for piece math and probe the web seeds now.
  _afterMagnetMetadata (ctx, torrent) {
    Promise.resolve().then(async () => {
      try {
        const parsed = await ctx.deps.parseTorrentFile(new Uint8Array(torrent.torrentFile))
        if (ctx.settled || parsed.infoHash !== ctx.record.btih) return
        ctx.parsed = parsed
        await this._probeAll(ctx.record, parsed, { onGood: (good) => { if (ctx.torrent === torrent) this._webseedsChanged(ctx, good) } })
      } catch (err) {
        this._warning('torrent-invalid', { message: errText(err) })
      }
    })
  }

  _watchFiles (ctx, torrent) {
    const files = Array.isArray(torrent.files) ? torrent.files : []
    files.forEach((file, i) => {
      if (!file || typeof file.once !== 'function') return
      const take = () => {
        if (ctx.blobPromises.has(i) || ctx.settled) return
        ctx.blobPromises.set(i, file.length === 0 ? Promise.resolve(new Blob([])) : file.blob())
        ctx.blobPromises.get(i).catch(() => ctx.blobPromises.delete(i))
      }
      if (file.done) take()
      else file.once('done', take)
    })
  }

  _clearTimer (ctx, name) {
    const t = ctx.timers[name]
    if (t) { this._t.clearTimeout(t); ctx.timers[name] = null }
  }

  _clearAllTimers (ctx) {
    for (const name of Object.keys(ctx.timers)) this._clearTimer(ctx, name)
  }

  _armStartTimers (ctx) {
    const to = this.config.timeouts
    if (!ctx.gotMetadata) {
      this._clearTimer(ctx, 'metadata')
      ctx.timers.metadata = this._t.setTimeout(() => {
        if (ctx.settled || ctx.gotMetadata || !ctx.everWire) return
        this._settleDownload(makeError('E_TIMEOUT', 'Peers connected but sent no metadata within ' + Math.round(to.metadataMs / 1000) + ' s'))
      }, to.metadataMs)
    }
    this._clearTimer(ctx, 'noPeers')
    ctx.timers.noPeers = this._t.setTimeout(() => {
      if (ctx.settled || ctx.everWire || ctx.gotMetadata) return
      if (!ctx.hasHttp) {
        this._settleDownload(makeError('E_NO_PEERS', 'No other visitor is online and the pointer has no web seed or torrent URL'))
      } else {
        this._settleDownload(makeError('E_TIMEOUT', 'Neither the web seed nor any peer answered within ' + Math.round(to.noPeersMs / 1000) + ' s'))
      }
    }, to.noPeersMs)
  }

  _armStall (ctx) {
    this._clearTimer(ctx, 'stall')
    const ms = this.config.timeoutsExtra.stallMs
    ctx.timers.stall = this._t.setTimeout(() => {
      if (ctx.settled) return
      const t = ctx.torrent
      if (t && t.done) return
      this._settleDownload(makeError('E_TIMEOUT', 'No download progress for ' + Math.round(ms / 1000) + ' s', { downloaded: this._downloaded, total: this._total }))
    }, ms)
  }

  async _finishDownload (ctx, torrent) {
    if (ctx.finishing) return
    ctx.finishing = true
    this._clearAllTimers(ctx)
    try {
      const parsed = ctx.parsed || await ctx.deps.parseTorrentFile(new Uint8Array(torrent.torrentFile))
      if (parsed.infoHash !== ctx.record.btih) throw makeError('E_BAD_TORRENT', 'Downloaded metadata has a different infohash')
      const { manifest, blobs } = await this._collect(ctx, torrent, parsed)
      if (ctx.settled) return
      this._downloaded = parsed.length
      this._total = parsed.length
      this.site = { mode: 'seed', record: ctx.record, parsed, manifest, blobs, torrent, fromCache: false }
      this._markEvidence(parsed.infoHash) // C2 seed-engine: complete here (E0); K plans it
      this._seedReplanSoon()
      this._flushProgress()
      this._status('seeding')
      ctx.settled = true
      if (ctx.signal && ctx.onAbort) ctx.signal.removeEventListener('abort', ctx.onAbort)
      this._download = null
      this._emit('done', { manifest })
      ctx.resolve({ torrent, manifest, blobs, parsed })
      this._maybeLeaveVersionSwarm()
    } catch (err) {
      this._settleDownload(err && err.code ? err : makeError('E_BAD_TORRENT', 'Could not read the downloaded files: ' + errText(err)))
    }
  }

  async _collect (ctx, torrent, parsed) {
    const wtFiles = Array.isArray(torrent.files) ? torrent.files : []
    const multi = parsed.files.length > 1
    const byPath = new Map()
    wtFiles.forEach((f, i) => byPath.set(relativeWtPath(f.path, multi), { f, i }))
    const aligned = wtFiles.length === parsed.files.length
    const files = []
    const blobs = new Map()
    for (let i = 0; i < parsed.files.length; i++) {
      const pf = parsed.files[i]
      if (pf.pad) continue
      const hit = aligned ? { f: wtFiles[i], i } : byPath.get(pf.path)
      if (!hit || !hit.f) throw new Error('file missing from the torrent: ' + pf.path)
      let blob = ctx.blobPromises.has(hit.i) ? await ctx.blobPromises.get(hit.i) : null
      if (!blob) blob = pf.length === 0 ? new Blob([]) : await hit.f.blob()
      const type = typeFor(pf.path, hit.f.type)
      if (blob.type !== type) blob = new Blob([blob], { type })
      files.push({ path: pf.path, length: pf.length, type, offset: pf.offset })
      blobs.set(pf.path, blob)
    }
    const now = Date.now()
    const manifest = {
      btih: parsed.infoHash,
      kind: 'site',
      name: parsed.name,
      torrentFile: minimalTorrentBytes(parsed.infoBytes),
      files,
      pieceLength: parsed.pieceLength,
      total: parsed.length,
      savedAt: now,
      lastVisit: now,
      complete: true
    }
    return { manifest, blobs }
  }

  _settleDownload (err) {
    const ctx = this._download
    if (!ctx || ctx.settled) return
    ctx.settled = true
    this._clearAllTimers(ctx)
    if (ctx.signal && ctx.onAbort) ctx.signal.removeEventListener('abort', ctx.onAbort)
    const torrent = ctx.torrent
    ctx.torrent = null
    ctx.holder.inner = null
    if (torrent) { try { torrent.destroy({ destroyStore: true }) } catch (_) { /* already destroyed */ } }
    if (this.site && this.site.mode === 'download') this.site = null
    this._download = null
    this._emit('error', { error: err })
    ctx.reject(err)
  }

  // ----- seeding ------------------------------------------------------------------------------

  /**
   * seedFromCache({ manifest, blobs, parsed, record }) → torrent | null. BlobChunkStore with
   * skipVerify (pieces are SHA-1 checked on first read, before upload) and an infohash check against
   * the resolved pointer. Returns null while peers are not allowed; seeding starts on consent.
   */
  async seedFromCache ({ manifest, blobs, parsed = null, record = null } = {}) {
    if (this.destroyed) throw makeError('E_ABORTED', 'TorrentManager destroyed')
    const deps = await this._loadDeps()
    const btih = (record && record.btih) || (manifest && manifest.btih)
    if (!manifest || !(manifest.torrentFile instanceof Uint8Array)) throw makeError('E_BAD_TORRENT', 'The cached site has no torrent file')
    const p = parsed || await deps.parseTorrentFile(manifest.torrentFile)
    if (!p || p.infoHash !== btih) throw makeError('E_BAD_TORRENT', 'The cached torrent does not match the pointer infohash')
    this.site = { mode: 'seed', record: record || (this.site && this.site.record) || null, parsed: p, manifest, blobs, torrent: null, fromCache: true }
    this._downloaded = p.length
    this._total = p.length
    this._corruptReported = false
    this._leftVersionSwarm = false
    if (!this._peersAllowed()) {
      this._status('seed-deferred')
      return null
    }
    return this._startSeed()
  }

  _startSeed () {
    const s = this.site
    if (!s || s.mode !== 'seed' || !s.parsed || !s.blobs || s.stopped || this._leftVersionSwarm) return null
    if (!this._peersAllowed() || s.torrent) return s.torrent || null
    const deps = this._deps
    const inner = new deps.BlobChunkStore(s.parsed.pieceLength, { parsed: s.parsed, blobs: s.blobs, verify: true })
    const store = guardedStore(inner, s.parsed.pieceLength, (index) => this._onCorrupt(s, index))
    const torrent = this._add(minimalTorrentBytes(s.parsed.infoBytes), {
      preloadedStore: store,
      skipVerify: true,
      announce: announceListFor(s.record, this.config.trackers),
      getAnnounceOpts: () => ({ numwant: this._numwantFor('site') })
    }, 'site')
    s.torrent = torrent
    torrent.on('infoHash', () => {
      if (torrent.infoHash !== s.parsed.infoHash) this._warning('E_BAD_TORRENT', { message: 'seeded infohash differs' })
    })
    this._markEvidence(s.parsed.infoHash) // C2 seed-engine: the site torrent (lane K) is E0 here
    this._seedReplanSoon()
    torrent.on('error', (err) => this._warning('seed-error', { message: errText(err) }))
    this._status('seeding')
    this._flushProgress()
    this._maybeLeaveVersionSwarm()
    return torrent
  }

  _onCorrupt (site, index) {
    if (this._corruptReported) return
    this._corruptReported = true
    this._warning('E_CACHE_CORRUPT', { btih: site.parsed && site.parsed.infoHash, piece: index })
    const t = site.torrent
    site.torrent = null
    site.stopped = true
    if (t) { try { t.destroy({ destroyStore: false }) } catch (_) { /* ignore */ } }
  }

  /** Stops serving the current site version at once (takedown or update, §5.8); the rendezvous stays. */
  stopSite () {
    if (!this.site) return
    this.site.stopped = true
    const t = this.site.torrent
    this.site.torrent = null
    if (t) { try { t.destroy({ destroyStore: false }) } catch (_) { /* ignore */ } }
  }

  _maybeLeaveVersionSwarm () {
    const s = this.site
    if (!this.policy.leaveVersionSwarm || !s || s.mode !== 'seed' || !this.rendezvous) return
    this._leftVersionSwarm = true
    const t = s.torrent
    s.torrent = null
    if (t) { try { t.destroy({ destroyStore: false }) } catch (_) { /* ignore */ } }
  }

  // ----- ledger rendezvous swarm (v0.2.1 B2; research w1-12 R1, R2) -------------------------------

  /**
   * addRendezvous(ledgerId, trackers) → Promise<torrent | null>. Joins the bare infohash
   * sha1hex("mw-ledger/1/" + ledgerId) with the site torrent's exact announce list, after a random 0 to
   * 1.5 s join jitter. Never seeded and never completed: announces carry left: 1 (a leecher, so trackers
   * that pair only leechers with seeders still introduce visitors) and numwant clamp(soft - wires, 0, 3).
   * Ledger gossip (mw_chain1) attaches through the 'torrent' event as on the site torrent. Resolves with
   * the torrent once added, or null while peers are not allowed (it joins on consent).
   */
  async addRendezvous (ledgerId, trackers) {
    if (this.destroyed) return null
    const infoHash = await rendezvousInfoHash(ledgerId, { prefix: this.config.ledger.rendezvousPrefix })
    if (this.destroyed) return null
    if (this.rendezvous) this._leaveRendezvous()
    this.rendezvous = { ledgerId, trackers: uniqueTrackerUrls(trackers), infoHash, torrent: null, joinTimer: null, joinWaiters: [], glare: { retries: 0, timer: null, lastTry: 0, startedAt: 0, lastWireAt: 0 } }
    return this._joinRendezvous()
  }

  /** @deprecated v0.2 name (one release): addAnchor(ledgerId, trackers) is addRendezvous(ledgerId, trackers). */
  addAnchor (ledgerId, trackers) {
    return this.addRendezvous(ledgerId, trackers)
  }

  /** Schedules the jittered join; resolves with the torrent (or null when it cannot start). */
  _joinRendezvous () {
    const r = this.rendezvous
    if (!r) return Promise.resolve(null)
    if (r.torrent) return Promise.resolve(r.torrent)
    if (!this._peersAllowed() || !r.trackers.length) return Promise.resolve(null)
    return new Promise((resolve) => {
      r.joinWaiters.push(resolve)
      if (r.joinTimer) return
      const delay = Math.floor(this._random() * (this.config.ledger.joinJitterMs || 0))
      r.joinTimer = this._t.setTimeout(() => {
        r.joinTimer = null
        const t = this.rendezvous === r ? this._startRendezvous() : null
        const waiters = r.joinWaiters.splice(0)
        for (const fn of waiters) fn(t || null)
      }, delay)
    })
  }

  _startRendezvous () {
    const r = this.rendezvous
    if (!r || r.torrent || this.destroyed || this.suspended || !this._peersAllowed() || !r.trackers.length) return r ? r.torrent : null
    let torrent
    try {
      torrent = this._add(r.infoHash, {
        announce: r.trackers.slice(),
        // left: 1 always (a bare infohash would announce NaN, read as a seeder); numwant follows the caps.
        getAnnounceOpts: () => ({ left: 1, numwant: this._numwantFor('rendezvous') })
      }, 'rendezvous')
    } catch (err) {
      this._warning('rendezvous-error', { message: errText(err) })
      return null
    }
    r.torrent = torrent
    r.glare.startedAt = this._t.now()
    r.glare.retries = 0
    torrent.on('error', (err) => this._warning('rendezvous-error', { message: errText(err) }))
    return torrent
  }

  _clearRendezvousTimers (r) {
    if (!r) return
    if (r.joinTimer) { this._t.clearTimeout(r.joinTimer); r.joinTimer = null }
    if (r.glare && r.glare.timer) { this._t.clearTimeout(r.glare.timer); r.glare.timer = null }
    const waiters = r.joinWaiters ? r.joinWaiters.splice(0) : []
    for (const fn of waiters) fn(null)
  }

  _leaveRendezvous () {
    const r = this.rendezvous
    if (!r) return
    this._clearRendezvousTimers(r)
    const t = r.torrent
    r.torrent = null
    if (t) { try { t.destroy() } catch (_) { /* ignore */ } }
  }

  /** Others reported in the rendezvous swarm (largest complete + incomplete - 1 over its trackers). */
  _rendezvousOthers () {
    const bucket = this._failures.swarm.rendezvous
    if (!bucket) return 0
    let others = 0
    for (const url of Object.keys(bucket)) others = Math.max(others, (bucket[url].complete || 0) + (bucket[url].incomplete || 0) - 1)
    return others
  }

  _scheduleRendezvousAnnounce (reason) {
    const r = this.rendezvous
    if (!r || !r.torrent || r.glare.timer) return
    const delay = Math.floor(this._random() * (this.config.ledger.glareJitterMs || 0))
    r.glare.timer = this._t.setTimeout(() => {
      r.glare.timer = null
      const tc = r.torrent && r.torrent.discovery && r.torrent.discovery.tracker
      if (!tc || typeof tc.update !== 'function') return
      try { tc.update() } catch (_) { /* socket closing */ }
      this._status('rendezvous-reannounce', { reason })
    }, delay)
  }

  /**
   * Glare watchdog (polled with the trackers): peers are reported in the rendezvous swarm but no rendezvous
   * wire exists glareWatchMs after the join or the last try: re-announce after 0 to glareJitterMs, at most
   * glareRetries times (two visitors that joined together crossed offers; research w1-12 R2).
   */
  _glareCheck () {
    const r = this.rendezvous
    if (!r || !r.torrent) return
    const cfg = this.config.ledger
    const now = this._t.now()
    if (this._swarmCount('rendezvous', null, { countAll: true }) > 0) return
    if (r.glare.retries >= cfg.glareRetries || r.glare.timer) return
    if (this._rendezvousOthers() <= 0) return
    if (now - Math.max(r.glare.startedAt, r.glare.lastTry) < cfg.glareWatchMs) return
    r.glare.retries++
    r.glare.lastTry = now
    this._scheduleRendezvousAnnounce('glare')
  }

  /** A rendezvous wire closed: below the soft cap a jittered announce looks for a replacement. */
  _onRendezvousWireClosed () {
    const r = this.rendezvous
    if (!r || !r.torrent || this.destroyed) return
    if (this._swarmCount('rendezvous', null, { countAll: true }) >= this._caps('rendezvous').soft) return
    this._scheduleRendezvousAnnounce('wire-closed')
  }

  // ----- policy, consent, lifecycle -----------------------------------------------------------

  setUploadsEnabled (enabled) {
    this.uploadsEnabled = !!enabled
    this._applyUploadThrottle()
    if (this._seed) { this._applyLocks(); return } // C2 seed-engine: lane wires follow the budget, other swarms this flag
    if (this.uploadsEnabled && !this.hiddenLocked) this._unlockAll()
    else this._lockAll()
  }

  setHostOnly (hostOnly) {
    const next = !!hostOnly
    if (next === this.hostOnly) return
    this.hostOnly = next
    this.rebuild()
  }

  setPolicy (policy) {
    const prevLeave = this.policy.leaveVersionSwarm
    this.policy = Object.assign({}, this.policy, policy || {})
    if (this.client) this.client.maxConns = Math.max(this._caps('site').hard, this._caps('rendezvous').hard)
    // Lower caps take effect at once: the surplus counted wires go, lowest score first.
    this._enforceCap('site')
    this._enforceCap('rendezvous')
    if (typeof this.policy.hostOnly === 'boolean' && this.policy.hostOnly !== this.hostOnly) {
      this.hostOnly = this.policy.hostOnly
      this.setUploadsEnabled(!!this.policy.uploadsEnabled)
      this.rebuild()
      return
    }
    this.setUploadsEnabled(!!this.policy.uploadsEnabled)
    if (this.policy.leaveVersionSwarm) this._maybeLeaveVersionSwarm()
    else if (prevLeave && this._leftVersionSwarm) {
      this._leftVersionSwarm = false
      if (this.client) this._startSeed()
    }
  }

  _onConsentChange () {
    if (this.destroyed || this.suspended) return
    if (this._peersAllowed() !== this._clientPeers || (!this.client && this._peersAllowed())) { this.rebuild(); return }
    // Social fixer (E-SO-2, E-SO-3): the loader's setConsent awaits the stored record before it calls this, so a client can be
    // built with peers allowed in between (_clientPeers already true, no rebuild). Lanes and file torrents that joined while
    // consent was pending (_startLane, _startFile: no peers) never started then; they start here.
    if (!this._peersAllowed()) return
    for (const h of Array.from(this._files.values())) if (!h.left && !h._torrent) this._startFile(h)
    for (const l of Array.from(this._lanes.values())) if (!l.left && !l._torrent) this._startLane(l)
  }

  /** Suspends: closes sockets and peer connections, keeps everything needed to resume. */
  pause () {
    if (this.destroyed || this.suspended) return
    this.suspended = true
    if (this._download) this._clearAllTimers(this._download)
    this._destroyClient()
    this._status('paused')
  }

  resume () {
    if (this.destroyed || !this.suspended) return
    this.suspended = false
    this._restart()
  }

  /** Destroys and recreates the client (resets tracker backoff and dead peers); keeps progress. */
  rebuild () {
    if (this.destroyed) return
    this.suspended = false
    if (this._download) this._clearAllTimers(this._download)
    this._destroyClient()
    this._restart()
  }

  _restart () {
    if (this.destroyed || this.suspended) return
    if (this._download && !this._download.settled) this._startDownload()
    else if (this.site && this.site.mode === 'seed') this._startSeed()
    // A rebuilt client re-joins the rendezvous swarm (jittered); the ledger re-attaches through 'torrent'.
    if (this.rendezvous) this._joinRendezvous()
    // v0.3: file torrents resume from their retained stores; lanes re-join.
    for (const h of Array.from(this._files.values())) if (!h.left) this._startFile(h)
    for (const l of Array.from(this._lanes.values())) if (!l.left) this._startLane(l)
    if (!this._peersAllowed()) this._status(this.hostOnly ? 'host-only' : 'waiting-consent')
  }

  destroy () {
    if (this.destroyed) return
    if (this._download && !this._download.settled) this._settleDownload(makeError('E_ABORTED', 'TorrentManager destroyed'))
    this.destroyed = true
    if (this._progressTimer) { this._t.clearTimeout(this._progressTimer); this._progressTimer = null }
    // C2 seed-engine: bucket and evidence timers, super-seeding.
    if (this._seed) this._clearSeedTimers(this._seed)
    if (this._evidenceTimer) { this._t.clearTimeout(this._evidenceTimer); this._evidenceTimer = null }
    for (const ss of this._superseeds.values()) { try { ss.stop('destroyed') } catch (_) { /* ignore */ } }
    this._superseeds.clear()
    if (this.rendezvous) this._clearRendezvousTimers(this.rendezvous)
    for (const st of this._webseeds.values()) if (st.timer) { this._t.clearTimeout(st.timer); st.timer = null }
    if (this._lifecycleOff) { try { this._lifecycleOff() } catch (_) { /* gone */ } this._lifecycleOff = null }
    this._destroyClient()
    for (const h of this._files.values()) {
      h.left = true
      for (const fn of h._leaveWaiters.splice(0)) fn(true)
    }
    this._files.clear()
    for (const l of this._lanes.values()) l.left = true
    this._lanes.clear()
    this._extensions.clear()
    this.site = null
    this.rendezvous = null
  }

  // ----- v0.3 hooks: file torrents and lanes (harden-loader; R 2.7.1, 2.8; MF-39, MF-44, MF-45) ----------

  /** The site's own trackers only: the public defaults (CONFIG.trackers) are dropped (MF-44). */
  _ownTrackers (announce) {
    const defaults = new Set(uniqueTrackerUrls(this.config.trackers))
    const list = uniqueTrackerUrls(announce)
    const own = list.filter((u) => !defaults.has(u))
    const raw = Array.isArray(announce) ? announce.length : 0
    return { list: own, dropped: Math.max(0, raw - own.length) }
  }

  /**
   * addFileTorrent({ torrentFile | infoHash, store, announce, retain = true, uploadException = false, expectedLength })
   *   → Promise<FileTorrentHandle> (v0.3 hook for lane media; R 2.8, MF-44, MF-45).
   * store: an abstract-chunk-store class (new Store(chunkLength, { name: infoHash, length, ... }), lane media's
   * IdbChunkStore) or instance. announce: the site's own tracker list; public default trackers are dropped
   * (warning 'file-public-tracker-dropped', never a fallback). The torrent is private (only that list) and is
   * added from the info dictionary alone (the .torrent's own announce and url-list are ignored); a .torrent
   * above 256 KiB or with another infohash than `infoHash` is E_BAD_TORRENT. retain (default true): the store
   * and its bitfield survive rebuild() like RetainedStore, so a 10 s app switch resumes instead of starting
   * over. The swarm waits for peer consent like the others. handle.leave() leaves it once the file is saved.
   * Adding the same infohash again returns the live handle.
   */
  async addFileTorrent ({ torrentFile = null, infoHash = null, store = null, announce = [], retain = true, uploadException = false, lane = null, expectedLength = null } = {}) {
    if (this.destroyed) throw makeError('E_ABORTED', 'TorrentManager destroyed')
    if (!store || (typeof store !== 'function' && (typeof store.put !== 'function' || typeof store.get !== 'function'))) {
      throw new TypeError('addFileTorrent: store must be an abstract-chunk-store class or instance')
    }
    // C2 seed-engine: lane 'H' | 'K' | 'E' (default: H with uploadException, else E).
    if (lane !== null && lane !== undefined && SEED_LANE_IDS.indexOf(lane) < 0) throw new TypeError("addFileTorrent: lane must be 'H', 'K' or 'E'")
    let parsed = null
    let ih = typeof infoHash === 'string' ? infoHash.trim().toLowerCase() : null
    if (torrentFile) {
      const bytes = torrentFile instanceof Uint8Array ? torrentFile : (torrentFile instanceof ArrayBuffer ? new Uint8Array(torrentFile) : (ArrayBuffer.isView(torrentFile) ? new Uint8Array(torrentFile.buffer, torrentFile.byteOffset, torrentFile.byteLength) : null))
      if (!bytes) throw new TypeError('addFileTorrent: torrentFile must be bytes')
      const max = (this.config.fileTorrent && this.config.fileTorrent.maxTorrentFileBytes) || 262144
      if (bytes.length > max) throw makeError('E_BAD_TORRENT', 'The .torrent is ' + bytes.length + ' bytes, above the ' + max + ' byte limit')
      const deps = await this._loadDeps()
      try { parsed = await deps.parseTorrentFile(bytes) } catch (err) { throw makeError('E_BAD_TORRENT', 'The .torrent does not parse: ' + errText(err)) }
      if (!parsed || !BTIH_RE.test(String(parsed.infoHash || '')) || !parsed.infoBytes) throw makeError('E_BAD_TORRENT', 'The .torrent has no valid info dictionary')
      if (ih && ih !== parsed.infoHash) throw makeError('E_BAD_TORRENT', 'The .torrent has another infohash than the one given')
      ih = parsed.infoHash
    } else if (!ih || !BTIH_RE.test(ih)) {
      throw new TypeError('addFileTorrent: torrentFile or a 40-hex infoHash is required')
    }
    if (this.destroyed) throw makeError('E_ABORTED', 'TorrentManager destroyed')
    const existing = this._files.get(ih)
    if (existing && !existing.left) {
      // C2 seed-engine: adding again with a lane promotes it (E to K to H), never demotes.
      const want = lane || (uploadException ? 'H' : null)
      if (want && LANE_RANK[want] > LANE_RANK[existing.lane]) existing.setLane(want)
      return existing
    }
    const { list, dropped } = this._ownTrackers(announce)
    if (dropped) this._warning('file-public-tracker-dropped', { infoHash: ih, count: dropped })
    const h = new FileTorrentHandle(this, { infoHash: ih, parsed, announce: list, store, retain, uploadException, lane, expectedLength })
    this._files.set(ih, h)
    this._startFile(h)
    this._applyUploadThrottle()
    this._seedReplanSoon() // C2 seed-engine
    return h
  }

  _startFile (h) {
    if (!h || h.left || h._torrent || this.destroyed || this.suspended) return h ? h._torrent : null
    if (!this._peersAllowed()) { this._status('file-deferred', { infoHash: h.infoHash }); return null }
    const opts = { announce: h.announce.slice(), private: true, getAnnounceOpts: () => ({ numwant: this._numwantFor('file') }) }
    const pieceLength = h._parsed && h._parsed.pieceLength
    const injectedClass = typeof h._storeArg === 'function'
    const inner = injectedClass ? h._holder.inner : h._storeArg
    if (inner && h._bitfield && h.retain) {
      opts.preloadedStore = new RetainedStore(inner, h._holder.chunkLength || inner.chunkLength || pieceLength)
      opts.bitfield = h._bitfield
    } else if (injectedClass) {
      opts.store = retainingInjectedStoreClass(h._storeArg, h._holder, h.infoHash)
    } else {
      opts.preloadedStore = new RetainedStore(inner, inner.chunkLength || pieceLength)
    }
    const source = h._parsed ? minimalTorrentBytes(h._parsed.infoBytes) : 'magnet:?xt=urn:btih:' + h.infoHash
    let torrent
    try {
      torrent = this._add(source, opts, 'file')
    } catch (err) {
      this._warning('file-error', { infoHash: h.infoHash, message: errText(err) })
      handleEmit(h, 'error', { error: makeError('E_BAD_TORRENT', errText(err)) })
      return null
    }
    h._torrent = torrent
    // integration I-3: piece and metadata events for the media and files lanes (on('verified'), metadata()).
    if (typeof torrent.on === 'function') {
      torrent.on('verified', (index) => { if (h._torrent === torrent) handleEmit(h, 'verified', { index }) })
      torrent.on('metadata', () => { if (h._torrent === torrent) handleEmit(h, 'metadata', { infoHash: h.infoHash }) })
    }
    torrent.on('done', () => {
      if (h._torrent !== torrent) return
      h.done = true
      this._markProgress('file')
      handleEmit(h, 'done', { infoHash: h.infoHash })
      // C2 seed-engine: E0 from now on (a pin page answers with its receipt); E items become plannable.
      this._markEvidence(h.infoHash)
      this._seedReplanSoon()
      if (h._leaveOnDone) this._finishLeaveFile(h)
    })
    torrent.on('error', (err) => { if (h._torrent === torrent) handleEmit(h, 'error', { error: makeError('E_TORRENT', errText(err)) }) })
    handleEmit(h, 'torrent', { torrent })
    return torrent
  }

  _leaveFile (h, { now = false } = {}) {
    if (!h || h.left) return Promise.resolve(true)
    return new Promise((resolve) => {
      h._leaveWaiters.push(resolve)
      if (now || h.done) this._finishLeaveFile(h)
      else h._leaveOnDone = true
    })
  }

  _finishLeaveFile (h) {
    if (h.left) return
    h.left = true
    h._leaveOnDone = false
    const t = h._torrent
    h._torrent = null
    if (t) { try { t.destroy({ destroyStore: false }) } catch (_) { /* gone */ } }
    if (this._files.get(h.infoHash) === h) this._files.delete(h.infoHash)
    // C2 seed-engine: no more super-seeding, holders or plan entry for an item this page left.
    const ss = this._superseeds.get(h.infoHash)
    if (ss) { this._superseeds.delete(h.infoHash); ss.stop('left') }
    this._holders.delete(h.infoHash)
    this._evidence.delete(h.infoHash)
    this._seedReplanSoon()
    this._applyUploadThrottle()
    for (const fn of h._leaveWaiters.splice(0)) fn(true)
    handleEmit(h, 'left', { infoHash: h.infoHash })
  }

  /**
   * joinLane({ kind: 'chat' | 'group' | 'hub', infoHash, announce, ledgerSync, wanted, syncing }) → LaneHandle (v0.3 hook for
   * lane chat; R 2.7.1). kind 'hub' (SCALE-6): the hub follow lane, capped by wanted() and first in the budget while
   * syncing() is true; it keeps the shared STUN list like ledgerSync.
   * A bare infohash like the rendezvous swarm (never seeded, left: 1, ut_metadata cancelled), announced only
   * to the site's own trackers (the public defaults are dropped, MF-44). Waits for peer consent and for at
   * least one own tracker; re-joins after rebuild(). Its wires count in the tab's wire budget at 'chat' or
   * 'group' priority. Joining the same infohash again returns the live handle.
   */
  joinLane ({ kind, infoHash, announce = [], ledgerSync = false, wanted = null, syncing = null } = {}) {
    if (this.destroyed) throw makeError('E_ABORTED', 'TorrentManager destroyed')
    if (kind !== 'chat' && kind !== 'group' && kind !== 'hub') throw new TypeError("joinLane: kind must be 'chat', 'group' or 'hub'")
    const ih = typeof infoHash === 'string' ? infoHash.trim().toLowerCase() : ''
    if (!BTIH_RE.test(ih)) throw new TypeError('joinLane: infoHash must be 40 hex characters')
    const existing = this._lanes.get(ih)
    if (existing && !existing.left) return existing
    const { list, dropped } = this._ownTrackers(announce)
    if (dropped) this._warning('lane-public-tracker-dropped', { kind, count: dropped })
    const l = new LaneHandle(this, { kind, infoHash: ih, announce: list, ownStun: ledgerSync !== true && kind !== 'hub', wanted, syncing })
    this._lanes.set(ih, l)
    this._startLane(l)
    return l
  }

  _startLane (l) {
    if (!l || l.left || l._torrent || this.destroyed || this.suspended) return l ? l._torrent : null
    if (!this._peersAllowed()) return null
    if (!l.announce.length) { this._status('lane-no-tracker', { kind: l.kind }); return null }
    let torrent
    try {
      torrent = this._add(l.infoHash, { announce: l.announce.slice(), getAnnounceOpts: () => ({ left: 1, numwant: this._numwantFor(l.kind) }) }, l.kind, { ownStun: l.ownStun })
    } catch (err) {
      this._warning('lane-error', { kind: l.kind, message: errText(err) })
      return null
    }
    l._torrent = torrent
    handleEmit(l, 'torrent', { torrent })
    return torrent
  }

  _leaveLane (l) {
    if (!l || l.left) return false
    l.left = true
    const t = l._torrent
    l._torrent = null
    if (t) { try { t.destroy() } catch (_) { /* gone */ } }
    if (this._lanes.get(l.infoHash) === l) this._lanes.delete(l.infoHash)
    return true
  }
}
