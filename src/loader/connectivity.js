// src/loader/connectivity.js: ICE hygiene and the connectivity probe (v0.2.1, DIGEST-AMENDMENTS B7;
// production digest P0-6, P0-7; research w2b-03 F-20, F-21, F-24, R-02, R-04).
//
// Facts this module is built on (research w2b-03, measured in Chromium 156 and WebKit 27.2):
//  - One dead ICE server stalls every non-trickle offer by 5 s (simple-peer's ICECOMPLETE_TIMEOUT) and
//    holds iceGatheringState at 'gathering' for about 40 s. bittorrent-tracker creates its peers with
//    trickle: false and never passes iceCompleteTimeout, and the vendored bundle captures
//    window.RTCPeerConnection when it is imported (webrtc-polyfill), so the only lever without rebuilding
//    the bundle is a wrapper installed before the import: installOfferTimeout().
//  - libwebrtc adds one server-reflexive candidate per distinct reflexive address, so two STUN servers
//    on different IPs expose a destination-dependent mapping ("hard" NAT). Identical mappings collapse into
//    one candidate, so "both answered the same" and "the second is silent" look alike until gathering
//    completes (Chromium) or a confirm window passes (WebKit never completes).
//  - The probe talks to the STUN servers, which are third parties: it runs only after consent (C1) and
//    never in host-only mode. It never blocks rendering and never waits for 'complete'.
//
// Everything browser-specific is injected, so the module runs in Node tests with a fake RTCPeerConnection.

export const PROBE_CLASSES = Object.freeze(['easy-mapping', 'easy-probable', 'hard', 'udp-blocked-or-no-stun', 'relay-only-reachable', 'unknown-single-stun', 'no-webrtc'])

const DEFAULT_TIMERS = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  now: () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())
}

function timersFrom (timers) {
  const t = {}
  for (const k of Object.keys(DEFAULT_TIMERS)) t[k] = timers && typeof timers[k] === 'function' ? timers[k].bind(timers) : DEFAULT_TIMERS[k]
  return t
}

function urlsOf (entry) {
  if (!entry) return []
  if (typeof entry === 'string') return [entry]
  return [].concat(entry.urls || []).filter((u) => typeof u === 'string')
}

/** Flat list of the STUN URLs of an iceServers list (TURN entries are skipped). */
export function stunUrlsOf (iceServers) {
  const out = []
  for (const entry of Array.isArray(iceServers) ? iceServers : []) {
    for (const u of urlsOf(entry)) if (/^stuns?:/i.test(u) && !out.includes(u)) out.push(u)
  }
  return out
}

/**
 * probeConnectivity({ RTCPeerConnection, stun, turn, budgetMs, settleMs, confirmMs, timers }) → Promise<report>
 * One throw-away RTCPeerConnection with every STUN URL (and TURN entries when configured), a data channel
 * and an offer; candidates are collected for at most budgetMs, never waiting for 'complete'.
 * report = { cls, udp, mappingVaries, gatherComplete, turnConfigured, turnOk, ipv6Srflx, answered: [stun urls],
 *   srflx: [{ key, url, t }], relay: [{ url, proto, t }], errors: [{ code, url, text, t }], tFirstSrflx, tRelay,
 *   tDone, reason }. Reflexive addresses are compared, never reported or stored.
 */
export async function probeConnectivity ({
  RTCPeerConnection: PC = (typeof RTCPeerConnection === 'function' ? RTCPeerConnection : null),
  stun = [], turn = [], budgetMs = 2500, settleMs = 150, confirmMs = 600, policy = 'all', timers = null
} = {}) {
  const t = timersFrom(timers)
  const t0 = t.now()
  const now = () => Math.round(t.now() - t0)
  const stunUrls = []
  for (const entry of stun) for (const u of urlsOf(entry)) if (!stunUrls.includes(u)) stunUrls.push(u)
  const turnEntries = (Array.isArray(turn) ? turn : []).map((x) => (typeof x === 'string' ? { urls: x } : x)).filter(Boolean)
  const turnUrls = []
  for (const entry of turnEntries) turnUrls.push(...urlsOf(entry))
  const report = {
    cls: 'unknown', udp: null, mappingVaries: null, gatherComplete: false, turnConfigured: turnUrls.length > 0, turnOk: false,
    ipv6Srflx: false, answered: [], srflx: [], relay: [], errors: [], tFirstSrflx: null, tRelay: null, tDone: null, reason: null
  }
  if (typeof PC !== 'function') {
    report.cls = 'no-webrtc'
    report.reason = 'no-RTCPeerConnection'
    report.tDone = now()
    return report
  }
  let pc
  try {
    pc = new PC({ iceServers: stunUrls.map((urls) => ({ urls })).concat(turnEntries), iceTransportPolicy: policy })
  } catch (e) {
    report.reason = 'RTCPeerConnection-ctor:' + ((e && e.name) || 'error')
    report.cls = 'no-webrtc'
    report.tDone = now()
    return report
  }
  const bySrflxUrl = new Map()
  const relayByUrl = new Map()
  let gatherDone = false
  let confirmed = false
  let confirmTimer = null
  let settleTimer = null
  let budgetTimer = null
  let finished = false
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })
  const finish = (why) => {
    if (finished) return
    finished = true
    resolveDone(why)
  }
  const maybeFinish = () => {
    if (finished || settleTimer !== null) return
    const stunAnswered = stunUrls.length === 0 || bySrflxUrl.size >= stunUrls.length || (confirmed && bySrflxUrl.size >= 1)
    const turnAnswered = turnUrls.length === 0 || relayByUrl.size > 0 || report.errors.some((e) => turnUrls.includes(e.url))
    if (gatherDone) finish('complete')
    else if (stunAnswered && turnAnswered) settleTimer = t.setTimeout(() => finish('early'), settleMs)
  }
  const onCandidate = (e) => {
    // A synthetic end-of-candidates from installOfferTimeout() is not a real 'complete'.
    if (finished || (e && e.mwSynthetic)) return
    if (!e || !e.candidate) { gatherDone = true; maybeFinish(); return }
    const c = e.candidate
    const url = c.url || e.url || null
    const type = c.type || (/ typ (\w+)/.exec(c.candidate || '') || [])[1]
    if (type === 'srflx') {
      const address = c.address || c.ip || ''
      const port = c.port
      if (report.tFirstSrflx === null) {
        report.tFirstSrflx = now()
        confirmTimer = t.setTimeout(() => { confirmed = true; maybeFinish() }, confirmMs)
      }
      const key = address + ':' + port
      report.srflx.push({ key, url, t: now() })
      if (address.includes(':')) report.ipv6Srflx = true
      if (url) bySrflxUrl.set(url, key)
    } else if (type === 'relay') {
      if (report.tRelay === null) report.tRelay = now()
      report.relay.push({ url, proto: c.relayProtocol || null, t: now() })
      if (url) relayByUrl.set(url, true)
    }
    maybeFinish()
  }
  const onError = (e) => {
    if (finished) return
    report.errors.push({ code: e && e.errorCode, url: e && e.url, text: e && e.errorText, t: now() })
    maybeFinish()
  }
  if (typeof pc.addEventListener === 'function') {
    pc.addEventListener('icecandidate', onCandidate)
    pc.addEventListener('icecandidateerror', onError)
  } else {
    pc.onicecandidate = onCandidate
    pc.onicecandidateerror = onError
  }
  budgetTimer = t.setTimeout(() => finish('budget'), budgetMs)
  try {
    pc.createDataChannel('probe')
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
  } catch (e) {
    report.reason = 'offer:' + ((e && e.name) || 'error')
  }
  const why = await done
  report.reason = report.reason || why
  report.tDone = now()
  report.gatherComplete = gatherDone
  for (const timer of [confirmTimer, settleTimer, budgetTimer]) if (timer !== null) t.clearTimeout(timer)
  report.turnOk = report.relay.length > 0
  report.answered = Array.from(bySrflxUrl.keys())
  report.cls = classifyReport(report, { stunCount: stunUrls.length, policy })
  try { pc.close() } catch (_) { /* already closed */ }
  return report
}

/** classifyReport(report, { stunCount }) → one of PROBE_CLASSES (research w2b-03 F-20, F-34). */
export function classifyReport (report, { stunCount = 2, policy = 'all' } = {}) {
  const srflx = Array.isArray(report.srflx) ? report.srflx : []
  const relay = Array.isArray(report.relay) ? report.relay : []
  report.udp = srflx.length > 0
  if (!srflx.length && !relay.length) return policy === 'relay' ? 'relay-only-reachable' : 'udp-blocked-or-no-stun'
  const v4 = srflx.filter((s) => typeof s.key === 'string' && s.key.split(':').length === 2)
  if (v4.length >= 2) {
    const keys = new Set(v4.map((s) => s.key))
    const ips = new Set(v4.map((s) => s.key.split(':')[0]))
    report.mappingVaries = keys.size > 1 && ips.size === 1
    return report.mappingVaries ? 'hard' : 'easy-mapping'
  }
  if (srflx.length >= 1) {
    report.mappingVaries = stunCount >= 2 ? false : null
    if (stunCount < 2) return 'unknown-single-stun'
    return report.gatherComplete ? 'easy-mapping' : 'easy-probable'
  }
  return 'relay-only-reachable'
}

/**
 * gateIceServers(configured, report) → the iceServers the WebRTC client gets (research w2b-03 R-02 a, d).
 * Only STUN servers that answered the probe are used; when gathering completed every configured server
 * answered (identical mappings collapse into one candidate). TURN is off in v1 and is never added here.
 * Never returns an empty list: with no answer at all (UDP blocked, or no probe) the configured STUN list is
 * kept, because WebKit with zero ICE servers emits no offer at all (F-24).
 */
export function gateIceServers (configured, report) {
  const all = (Array.isArray(configured) ? configured : []).filter((e) => urlsOf(e).some((u) => /^stuns?:/i.test(u)))
  if (!report || report.cls === 'no-webrtc' || report.gatherComplete) return all.slice()
  const answered = new Set(Array.isArray(report.answered) ? report.answered : [])
  if (!answered.size) return all.slice()
  const kept = all.filter((e) => urlsOf(e).some((u) => answered.has(u)))
  return kept.length ? kept : all.slice()
}

/**
 * installOfferTimeout(win, { timeoutMs, timers }) → true when installed.
 * Wraps win.RTCPeerConnection so that a non-trickle offer or answer leaves at most timeoutMs after the
 * first ICE candidate: the wrapper delivers a synthetic end-of-candidates event ({ candidate: null,
 * mwSynthetic: true }) to the page's onicecandidate handler, which simple-peer treats like the browser's
 * own (it then sends the SDP with the candidates gathered so far). Must run before webtorrent.min.js is
 * imported. A wrapper function (not a subclass), so it also composes with test harness wrappers that
 * return a native connection from their constructor.
 */
export function installOfferTimeout (win, { timeoutMs = 1500, timers = null } = {}) {
  const Base = win && win.RTCPeerConnection
  if (typeof Base !== 'function' || Base.__mwOfferTimeout) return false
  const t = timersFrom(timers)
  const Wrapped = function RTCPeerConnection (...args) {
    const pc = new Base(...args)
    try { patchOfferTimeout(pc, { timeoutMs, timers: t }) } catch (_) { /* leave the connection unpatched */ }
    return pc
  }
  Wrapped.prototype = Base.prototype
  Object.setPrototypeOf(Wrapped, Base)
  Object.defineProperty(Wrapped, '__mwOfferTimeout', { value: timeoutMs })
  win.RTCPeerConnection = Wrapped
  return true
}

/** patchOfferTimeout(pc, { timeoutMs, timers }): the per-connection half of installOfferTimeout(). */
export function patchOfferTimeout (pc, { timeoutMs = 1500, timers = null } = {}) {
  if (!pc || pc.__mwOfferTimeout || typeof pc.addEventListener !== 'function') return false
  const t = timersFrom(timers)
  let handler = null
  let timer = null
  let ended = false
  const deliver = (event) => {
    if (typeof handler === 'function') {
      try { handler.call(pc, event) } catch (err) { if (typeof console !== 'undefined') console.error(err) }
    }
  }
  pc.addEventListener('icecandidate', (event) => {
    if (event && event.candidate) {
      if (timer === null && !ended) {
        timer = t.setTimeout(() => {
          timer = null
          if (ended) return
          ended = true
          deliver({ candidate: null, mwSynthetic: true, type: 'icecandidate', target: pc })
        }, timeoutMs)
      }
      deliver(event)
      return
    }
    // The real end of candidates: cancel the timer; deliver it only when the synthetic one did not go out.
    if (timer !== null) { t.clearTimeout(timer); timer = null }
    if (ended) return
    ended = true
    deliver(event)
  })
  Object.defineProperty(pc, 'onicecandidate', {
    configurable: true,
    enumerable: true,
    get () { return handler },
    set (fn) { handler = typeof fn === 'function' ? fn : null }
  })
  Object.defineProperty(pc, '__mwOfferTimeout', { value: timeoutMs })
  return true
}

/**
 * connectivityRow(report) → { row, text } | null for the diagnostics panel (ARCHITECTURE §5.10):
 * 'connectivity' with the class and the first-answer time; null before a probe ran.
 */
export function connectivityRow (report) {
  if (!report || !report.cls) return null
  const parts = [report.cls]
  if (report.tFirstSrflx !== null && report.tFirstSrflx !== undefined) parts.push('first answer ' + report.tFirstSrflx + ' ms')
  if (Array.isArray(report.answered)) parts.push(report.answered.length + ' STUN answered')
  if (report.ipv6Srflx) parts.push('IPv6')
  return { row: 'connectivity', text: parts.join(', ') }
}
