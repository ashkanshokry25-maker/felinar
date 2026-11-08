// src/loader/apps-link.js: the client of the pair socket (ARCHITECTURE 15.21, mw-pair-v1). One WebSocket to the first rendezvous
// URL of the door's apps block, JSON text frames of at most 8,192 bytes with v: 1, an action and an optional rid (the client's
// request id, echoed in the direct reply), reconnect with back off, timers for knocks, and events for what the rendezvous pushes.
// The same socket carries the relay lane (plan relay-first-2026-11-07, 3.5): after an accept both people join a lane the rendezvous
// minted and every sealed frame of their conversation goes through it, so a conversation does not depend on a direct link.
//
//   createLink({ url, WebSocketImpl, setTimeoutFn, clearTimeoutFn, random, backoffMs, knockSilentMs, knockExpireMs,
//                requestTimeoutMs, keepaliveMs, pongWaitMs, log, report, now, relayBudget, messageBudget, heldPerLane }) -> PairLink
//
//   link.state            'idle' (not started or closed) | 'connecting' | 'open' | 'backoff' (waiting to retry)
//   link.connect()        starts the socket (also ends a back off wait at once); nothing is opened before the first call
//   link.close()          stops for good: no reconnect, pending requests fail with reason 'closed'
//   link.on(event, fn)    -> off. Events (the payload is one object):
//     state     { state }                              every change of link.state
//     open      {}                                     the socket opened (first time and after every reconnect)
//     gone      {}                                     the socket was lost: its codes, knocks and lanes are released at the rendezvous
//     request   { kind, knock, channel, box }          a requester knocked on a code this socket owns (pair-request, room-request)
//     accepted  { kind, knock, lane, channel, box, proof }  the owner accepted this socket's knock; box is the owner's sealed hello and
//                                                      proof the owner's signature over the channel and the knock (null when none came:
//                                                      the service does not act on an accept without a valid one)
//     rejected  { kind, knock, reason }                'rejected' | 'expired' | 'closed' | 'gone' (also raised locally at 10 minutes)
//     cancelled { kind, knock }                        a requester withdrew its knock
//     closed    { kind, channel, reason }              the rendezvous ended a code this socket owns ('expired' after 24 hours)
//     silent    { kind, knock }                        30 seconds without an answer to this socket's knock ("unknown code")
//     relayed   { lane, kind, bytes }                  a sealed frame came through the relay lane (bytes: the push's f, base64url decoded)
//     joined    { lane, kind, peers }                  another socket joined a lane this socket is in; peers = the others in it now
//     left      { lane, kind, peers }                  another socket left such a lane or was lost; peers = the others in it now
//     A push whose lane is not 40 lowercase hex, whose f is not 4 to 7,700 characters of base64url that decode, or whose peers is not a
//     whole number from 0 to 64 is dropped without a word. The three carry no knock, so they are handled before the knock check.
//   Typed calls (kind is 'pair' or 'room'; each resolves to { ok: true, ... } or { ok: false, reason }):
//     openCode({ kind, channel, box }) -> { ok, lane }   closeCode({ kind, channel }) -> { ok }
//     knock({ kind, channel, box }) -> { ok, knock }     accept({ kind, knock, proof }) -> { ok, lane }
//     reject({ kind, knock }) -> { ok }                  cancel({ kind, knock }) -> { ok } (no reply exists; nothing is awaited)
//     join(lane, kind) -> { ok, peers }        joins the relay lane; peers = the other sockets in it. A second join is the same answer.
//     relay(lane, kind, bytes) -> { ok, peers } sends one frame (a Uint8Array) to the others of the lane; peers = the sockets it was
//                                              written to, 0 when alone (the frame reached nobody). Over 7,700 characters of base64url
//                                              (5,775 bytes) it is refused here with 'too-big', before anything is sent.
//     leave(lane, kind) -> { ok }              leaves the lane; ok on a timeout (3 seconds) and when the socket is not open, as closeCode,
//                                              after it drops the lane's frames that wait for the socket's minute (dropHeld below)
//   request(action, fields, { timeoutMs }) -> { ok: true, reply } | { ok: false, reason } is the untyped call under them (all of the
//   above go through it, so sent, reply and timeout below report them).
//   dropHeld(lane) -> n: the relayed frames of that lane that wait for the socket's minute are dropped, each answered 'closed'.
// Failure replies ({ 'failure reason': text }) become reason slugs ('channel taken' -> 'channel-taken'). Reasons the link adds:
// 'link-down' (the socket did not open in time), 'closed' (lost or closed while waiting, or its lane was left while it waited), 'timeout',
// 'too-big', 'bad-reply', 'invalid-lane' and 'kind' (a call with a lane or a kind that could not be one: refused before anything is sent),
// 'invalid-frame', and 'too-many-relays' for a frame that would wait behind heldPerLane others of its lane (the socket's minute, below).
// The relay lane's own reasons are the rendezvous' texts as slugs: invalid-lane, unknown-lane, lane-full, too-many-lanes,
// relay-is-off-on-this-rendezvous, invalid-frame, too-many-relays, relay-is-busy, too-many-messages (all on REPORT_REASONS).
//
// Keepalive: with keepaliveMs > 0 (the service passes 50,000; the class default is 0, no ping) the exact text
// {"v":1,"action":"pair-ping"} goes every period, with no rid, and is neither a request nor a report. The rendezvous answers
// {"action":"pair-pong"} (the platform does, without waking the object). A pong is expected within pongWaitMs (10 seconds); when
// nothing at all came from the socket in that time (no pong and no other frame) the socket is half open (a laptop that slept, a phone
// that changed networks): the link treats it as lost and reconnects with its back off. A pong is no event and no report.
//
// The socket's minute: the rendezvous counts what one socket sends in a sliding minute (120 relayed frames, then 'too many relays'; 150
// messages of any kind, then it closes the socket), and every lane of the page shares the socket. So the link counts what its socket sent in
// the last BUDGET_WINDOW_MS (65 seconds) and keeps under relayBudget relayed frames (RELAY_BUDGET, 100) and messageBudget frames in all
// (MESSAGE_BUDGET, 120): a request that would go over waits in the link, relayed frames in the order they came, until there is room, and fails
// with 'closed' when the socket goes first. At most heldPerLane (HELD_PER_LANE, 8) relayed frames of one lane wait; the next is refused at once
// with 'too-many-relays', and leaving the lane drops what waits for it. A ping and send() are counted, never held. A page therefore does not
// trip those caps by itself while the network delivers at an even pace: the rendezvous counts a frame when it arrives, so a network that holds
// frames back and then delivers them at once can still take a socket over them. The ms of a reply is timed from the moment the request was
// sent, after any wait.
//
// report(name, fields) is optional (usage reports, docs/OBSERVABILITY.md; the page adds a prefix to every name). It hears, as flat
// objects of words and counts: state { state, prev }, open { attempt }, gone { why }, backoff { attempt, ms, why }, sent { action }
// (a frame went out), reply { action, ok, reason, ms } (the ms of a pair-relay reply is the relay round trip), timeout { action, ms }
// and push { name } (a push that passed its checks, a relayed one included). Only the names of this protocol's actions and pushes and
// short reason slugs appear: never a box, a proof, a channel, a knock token, a frame, a lane or an address. A report that throws is
// ignored. now() -> ms (default Date.now) times the replies.
//
// The socket is opened only after connect(); the rendezvous learns channels, knock timing, lane ids, the sealed frames' sizes and times,
// and the socket's address (as any relay does), never names, keys, texts or which identity talks to which (the boxes are sealed
// under the code, the frames under keys the rendezvous does not have).
//
// Shared code: the WebSocket class is injected (default globalThis.WebSocket), no DOM access at module scope.

import { b64url, utf8 } from '../chain/canonical.js'
import { secureRandom } from '../chat/tags.js'
import { randomBytes, isChannel } from './apps-crypto.js'

export const MAX_PAIR_BYTES = 8192
export const PROTOCOL_V = 1
export const BACKOFF_MS = Object.freeze([1000, 2000, 4000, 8000, 15000, 30000])
export const KNOCK_SILENT_MS = 30000
export const KNOCK_EXPIRE_MS = 600000
export const REQUEST_TIMEOUT_MS = 15000
export const OPEN_WAIT_MS = 10000
export const KEEPALIVE_MS = 50000 // one ping per 50 seconds, under the minute at which a hidden tab's timers are throttled (plan 3.4)
export const PONG_WAIT_MS = 10000
export const LEAVE_TIMEOUT_MS = 3000
export const FRAME_CHARS_MAX = 7700 // the base64url characters of one relayed frame (5,775 bytes), so that the request stays under 8,192 bytes
export const PEERS_MAX = 64
export const PING_TEXT = '{"v":1,"action":"pair-ping"}'
// The socket's own minute, kept under the caps the rendezvous counts per socket (plan 3.2: 120 relayed frames and 150 messages a minute). The
// margins cover what the link sends without holding it (a ping, a cancel) and some unevenness on the way, not a stalled minute (finding C-12
// of verify round 1).
export const RELAY_BUDGET = 100
export const MESSAGE_BUDGET = 120
// The link counts a frame for 65 seconds, 5 more than the rendezvous counts it from its arrival, so that a delay that shrinks by up to 5 seconds
// between two of the link's minutes cannot put both into one minute of the rendezvous (finding C-12 of verify round 1).
export const BUDGET_WINDOW_MS = 65000
// The relayed frames of one lane that may wait for the minute: a conversation that makes the page owe more frames than the minute allows (an ack
// for every message of a contact that writes at the rendezvous' cap) would otherwise queue without end, and every other lane of the page would
// wait behind it (finding A-6 of verify round 1). Over it a frame is refused at once with 'too-many-relays', even at a pace the rendezvous would
// still take (finding C-13 of verify round 2).
export const HELD_PER_LANE = 8

const LANE_RE = /^[0-9a-f]{40}$/
const TOKEN_RE = /^[A-Za-z0-9_-]{1,32}$/
const PROOF_RE = /^[A-Za-z0-9_-]{86}$/
const FRAME_RE = /^[A-Za-z0-9_-]{4,7700}$/
const RELAY_ACTION_RE = /^(?:pair|room)-relay$/
const KINDS = new Set(['pair', 'room'])
const REASONS = new Set(['rejected', 'expired', 'closed', 'gone'])
const PUSH_RE = /^(pair|room)-(request|accepted|rejected|cancelled|close|relayed|joined|left)$/

function noop () {}

/**
 * reportWord(v) -> v when it is a short slug (letters, digits, hyphens and underscores, up to 48 characters), else 'other': what a
 * usage report may carry of a text that came from outside (a failure reason of the rendezvous, a reason of a peer's frame).
 */
export function reportWord (v) {
  const s = v === undefined || v === null ? '' : String(v)
  return /^[A-Za-z0-9_-]{1,48}$/.test(s) ? s : 'other'
}

/**
 * The failure reasons a usage report may name, as reasonCode() writes them: the ones this project's rendezvous answers with (deploy/rtc-worker
 * pair.js and rtc.js) and the ones the link adds itself. A rendezvous is anyone's to run and its failure reason is its own text, which may
 * hold a name or an address ("Ferdle Morrow 203.0.113.5 asked" is a slug of letters, digits and hyphens that no mask knows), so a reason that
 * is not on this list is reported as 'other'. The service still gets the slug whole, to map it to an error of its own.
 */
const REPORT_REASONS = new Set([
  'box-invalid', 'invalid-channel', 'channel-taken', 'too-many-codes', 'too-many-lanes', 'too-many-requests', 'unknown-code', 'invalid-knock',
  'unknown-knock', 'proof-invalid', 'invalid-rid', 'unsupported-version', 'invalid-action', 'socket-already-used-for-another-protocol',
  'message-too-large', 'invalid-message-not-json', 'pairing-is-off-on-this-rendezvous', 'internal-error',
  // the relay lane (plan 3.1 and 3.5; too-many-lanes above is the ninth): the texts of the rendezvous as slugs
  'invalid-lane', 'unknown-lane', 'lane-full', 'relay-is-off-on-this-rendezvous', 'invalid-frame', 'too-many-relays', 'relay-is-busy', 'too-many-messages',
  'link-down', 'closed', 'timeout', 'too-big', 'bad-reply', 'failed', 'rejected', 'expired', 'gone'
])

/** reasonWord(v) -> v when it is a reason on the list above, else 'other': what a usage report may carry of a reason that came from a rendezvous. */
export function reasonWord (v) {
  const s = reportWord(v)
  return REPORT_REASONS.has(s) ? s : 'other'
}

/** reasonCode('channel taken') -> 'channel-taken': the slug of a failure text. */
export function reasonCode (text) {
  const s = String(text === undefined || text === null ? '' : text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return s.slice(0, 64) || 'failed'
}

function checkUrl (url) {
  let u
  try {
    u = new URL(String(url))
  } catch (_) {
    throw new TypeError('the rendezvous must be a wss: URL')
  }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]'
  if (u.protocol !== 'wss:' && !(u.protocol === 'ws:' && loopback)) throw new TypeError('the rendezvous must be a wss: URL (ws: only on loopback)')
  return u.href
}

function boxOk (box) {
  return !!box && typeof box === 'object' && typeof box.iv === 'string' && typeof box.ct === 'string'
}

export class PairLink {
  constructor ({
    url, WebSocketImpl = null, setTimeoutFn = null, clearTimeoutFn = null, random = null, backoffMs = BACKOFF_MS,
    knockSilentMs = KNOCK_SILENT_MS, knockExpireMs = KNOCK_EXPIRE_MS, requestTimeoutMs = REQUEST_TIMEOUT_MS,
    openWaitMs = OPEN_WAIT_MS, keepaliveMs = 0, pongWaitMs = PONG_WAIT_MS, log = null, report = null, now = null,
    relayBudget = RELAY_BUDGET, messageBudget = MESSAGE_BUDGET, heldPerLane = HELD_PER_LANE
  } = {}) {
    this.url = checkUrl(url)
    this.WS = WebSocketImpl || (typeof WebSocket === 'function' ? WebSocket : null)
    this._setT = setTimeoutFn || ((fn, ms) => setTimeout(fn, ms))
    this._clearT = clearTimeoutFn || ((t) => clearTimeout(t))
    this._random = typeof random === 'function' ? random : secureRandom
    this.backoffMs = backoffMs
    this.knockSilentMs = knockSilentMs
    this.knockExpireMs = knockExpireMs
    this.requestTimeoutMs = requestTimeoutMs
    this.openWaitMs = openWaitMs
    this.keepaliveMs = keepaliveMs
    this.pongWaitMs = pongWaitMs
    this._log = typeof log === 'function' ? log : noop
    this._report = typeof report === 'function' ? report : null
    this._now = typeof now === 'function' ? now : () => Date.now()
    this._state = 'idle'
    this._ws = null
    this._stopped = true
    this._attempt = 0
    this._retryTimer = null
    this._keepTimer = null
    this._pongTimer = null
    this._heard = 0 // text frames received on this link: the watchdog of the keepalive asks whether anything came since the ping
    this.relayBudget = relayBudget > 0 ? relayBudget : RELAY_BUDGET
    this.messageBudget = messageBudget > 0 ? messageBudget : MESSAGE_BUDGET
    this.heldPerLane = heldPerLane > 0 ? heldPerLane : HELD_PER_LANE
    this._outT = [] // when each frame this socket sent in the last BUDGET_WINDOW_MS went (every frame: a request, a send, a ping)
    this._relayT = [] // the same for the relayed frames among them
    this._held = [] // { relay, lane, resolve }: requests waiting for room in the socket's minute, in the order they came (lane: a relayed frame's)
    this._heldTimer = null
    this._pending = new Map() // rid -> { resolve, timer }
    this._waiters = [] // { resolve, timer }: calls waiting for the socket to open
    this._knocks = new Map() // kind:knock -> { silent, expire }
    this._listeners = new Map()
  }

  get state () { return this._state }

  on (event, fn) {
    if (typeof fn !== 'function') throw new TypeError('on: fn')
    let set = this._listeners.get(event)
    if (!set) {
      set = new Set()
      this._listeners.set(event, set)
    }
    set.add(fn)
    return () => { set.delete(fn) }
  }

  _emit (event, data) {
    const set = this._listeners.get(event)
    if (!set) return
    for (const fn of Array.from(set)) {
      try { fn(data || {}) } catch (err) { this._log('listener-error', event, err) }
    }
  }

  // A report says what happened and never changes it: a throw in the page's function stops here.
  _rep (name, fields) {
    if (!this._report) return
    try { this._report(name, fields) } catch (_) { /* a report never breaks the socket */ }
  }

  _set (state) {
    if (this._state === state) return
    const prev = this._state
    this._state = state
    this._rep('state', { state, prev })
    this._emit('state', { state })
  }

  _gone (why) {
    this._rep('gone', { why })
    this._emit('gone', {})
  }

  // ---- socket ---------------------------------------------------------------------------------

  connect () {
    this._stopped = false
    if (this._state === 'open' || this._state === 'connecting') return
    if (this._retryTimer !== null) {
      this._clearT(this._retryTimer)
      this._retryTimer = null
    }
    this._openSocket()
  }

  _openSocket () {
    if (!this.WS) {
      this._stopped = true
      this._flushWaiters(false)
      this._set('idle')
      return
    }
    this._set('connecting')
    let ws
    try {
      ws = new this.WS(this.url)
    } catch (_) {
      this._lost('open-failed')
      return
    }
    this._ws = ws
    const on = (name, fn) => {
      if (typeof ws.addEventListener === 'function') ws.addEventListener(name, fn)
      else ws['on' + name] = fn
    }
    on('open', () => {
      if (this._ws !== ws) return
      const tries = this._attempt
      this._attempt = 0
      // the rendezvous counts per socket: a new socket starts a minute of its own
      this._outT.length = 0
      this._relayT.length = 0
      this._set('open')
      this._rep('open', { attempt: tries })
      this._flushWaiters(true)
      this._armKeepalive()
      this._emit('open', {})
    })
    on('message', (ev) => {
      if (this._ws !== ws) return
      this._onText(ev && ev.data)
    })
    on('close', () => { if (this._ws === ws) this._lost('closed') })
    on('error', () => { if (this._ws === ws) this._lost('error') })
  }

  _lost (why) {
    const ws = this._ws
    const wasOpen = this._state === 'open'
    this._ws = null
    if (ws) {
      try { ws.close() } catch (_) { /* already closed */ }
    }
    this._stopKeepalive()
    this._failPending('closed')
    this._failHeld()
    this._clearKnocks()
    if (this._stopped) {
      this._flushWaiters(false)
      this._set('idle')
      if (wasOpen) this._gone(why)
      return
    }
    const list = this.backoffMs
    const base = list[Math.min(this._attempt, list.length - 1)]
    this._attempt++
    const delay = Math.round(base * (0.8 + 0.4 * this._random()))
    this._set('backoff')
    if (wasOpen) this._gone(why)
    this._rep('backoff', { attempt: this._attempt, ms: delay, why })
    this._retryTimer = this._setT(() => {
      this._retryTimer = null
      if (!this._stopped) this._openSocket()
    }, delay)
    this._log('lost', why)
  }

  close () {
    this._stopped = true
    if (this._retryTimer !== null) {
      this._clearT(this._retryTimer)
      this._retryTimer = null
    }
    const wasOpen = this._state === 'open'
    const ws = this._ws
    this._ws = null
    if (ws) {
      try { ws.close(1000) } catch (_) { /* already closed */ }
    }
    this._stopKeepalive()
    this._failPending('closed')
    this._failHeld()
    this._clearKnocks()
    this._flushWaiters(false)
    this._set('idle')
    if (wasOpen) this._gone('stopped')
  }

  _flushWaiters (ok) {
    const list = this._waiters.splice(0)
    for (const w of list) {
      this._clearT(w.timer)
      w.resolve(ok)
    }
  }

  /** whenOpen(ms) -> Promise<boolean>: starts the socket if needed and waits for it to open. */
  whenOpen (ms = this.openWaitMs) {
    if (this._state === 'open') return Promise.resolve(true)
    this.connect()
    return new Promise((resolve) => {
      const w = { resolve, timer: null }
      w.timer = this._setT(() => {
        const at = this._waiters.indexOf(w)
        if (at >= 0) this._waiters.splice(at, 1)
        resolve(false)
      }, ms)
      this._waiters.push(w)
    })
  }

  _stopKeepalive () {
    if (this._keepTimer !== null) {
      this._clearT(this._keepTimer)
      this._keepTimer = null
    }
    if (this._pongTimer !== null) {
      this._clearT(this._pongTimer)
      this._pongTimer = null
    }
  }

  // Plan 3.4: the exact text, no rid, every keepaliveMs while the socket is open, through _sendText (a ping is no request and no report: it
  // is not traffic). The platform answers it without waking the object. The watchdog below asks whether ANYTHING came from the socket in
  // the pongWaitMs after the ping: a pong or any other frame says the socket lives, silence says it is half open and the link reconnects.
  _armKeepalive () {
    if (!(this.keepaliveMs > 0) || this._keepTimer !== null) return
    this._keepTimer = this._setT(() => this._keepTick(), this.keepaliveMs)
  }

  _keepTick () {
    this._keepTimer = null
    if (this._state !== 'open') return
    const mark = this._heard
    if (this._sendText(PING_TEXT)) this._take(false) // counted in the socket's minute (a ping that reaches pair.js counts there: DEC-2), never held
    if (this._pongTimer !== null) this._clearT(this._pongTimer)
    this._pongTimer = this._setT(() => {
      this._pongTimer = null
      if (this._state === 'open' && this._heard === mark) this._lost('no-pong')
    }, this.pongWaitMs)
    this._keepTimer = this._setT(() => this._keepTick(), this.keepaliveMs)
  }

  // ---- sending --------------------------------------------------------------------------------

  _frame (action, fields, rid) {
    const msg = Object.assign({ v: PROTOCOL_V, action }, fields || {})
    if (rid) msg.rid = rid
    const text = JSON.stringify(msg)
    return utf8.encode(text).length > MAX_PAIR_BYTES ? null : text
  }

  _sendText (text) {
    const ws = this._ws
    if (!ws || this._state !== 'open') return false
    try {
      ws.send(text)
      return true
    } catch (_) {
      return false
    }
  }

  /** send(action, fields) -> boolean: one frame without a rid and without waiting (for actions that have no direct reply). */
  send (action, fields) {
    const text = this._frame(action, fields, null)
    if (text === null) return false
    const ok = this._sendText(text)
    if (ok) {
      this._take(false) // counted in the socket's minute, never held (a cancel: the rendezvous already caps the knocks it ends)
      this._rep('sent', { action: reportWord(action) })
    }
    return ok
  }

  /** request(action, fields, { timeoutMs }) -> Promise<{ ok: true, reply } | { ok: false, reason }>. */
  async request (action, fields = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    let at = this._now()
    if (!this.WS) return this._answered(action, at, { ok: false, reason: 'link-down' })
    if (this._state !== 'open') {
      const up = await this.whenOpen()
      if (!up) return this._answered(action, at, { ok: false, reason: 'link-down' })
    }
    const rid = b64url.encode(randomBytes(6))
    const text = this._frame(action, fields, rid)
    if (text === null) return this._answered(action, at, { ok: false, reason: 'too-big' })
    // the socket's minute: a request that would take the socket over the caps of the rendezvous waits here (_hold), and fails as closed when
    // the socket goes first; its time and its timeout then start when it is sent, so the ms of a reply stays the round trip (plan 3.5). With
    // room, and nothing of its kind waiting before it, it goes at once, in this same turn, as it always did (a sign-out writes its leaves
    // before it closes the socket, even while relayed frames wait). A relayed frame that would wait behind heldPerLane others of its lane is
    // refused at once, as the rendezvous refuses one past its cap (finding A-6 of verify round 1).
    const relay = RELAY_ACTION_RE.test(action)
    if (this._held.some((h) => h.relay === relay) || !this._fits(relay)) {
      const lane = relay ? fields.lane : null
      if (relay && this._heldOf(lane) >= this.heldPerLane) return this._answered(action, at, { ok: false, reason: 'too-many-relays' })
      if (!(await this._hold(relay, lane))) return this._answered(action, at, { ok: false, reason: 'closed' })
      at = this._now()
    } else {
      this._take(relay)
    }
    return new Promise((resolve) => {
      const entry = { resolve, timer: null, action, at }
      entry.timer = this._setT(() => {
        if (this._pending.delete(rid)) {
          this._rep('timeout', { action: reportWord(action), ms: timeoutMs })
          resolve({ ok: false, reason: 'timeout' })
        }
      }, timeoutMs)
      this._pending.set(rid, entry)
      if (!this._sendText(text)) {
        this._pending.delete(rid)
        this._clearT(entry.timer)
        resolve(this._answered(action, at, { ok: false, reason: 'link-down' }))
      } else {
        this._rep('sent', { action: reportWord(action) })
      }
    })
  }

  // The one place a request ends other than by timeout: the result is reported (action name, ok, a reason slug, the time it took) and returned.
  _answered (action, at, result) {
    if (this._report) {
      const a = reportWord(action)
      const ms = Math.max(0, this._now() - at)
      if (result.ok) this._rep('reply', { action: a, ok: true, ms })
      else this._rep('reply', { action: a, ok: false, reason: reasonWord(result.reason), ms })
    }
    return result
  }

  _failPending (reason) {
    const list = Array.from(this._pending.values())
    this._pending.clear()
    for (const e of list) {
      this._clearT(e.timer)
      e.resolve(this._answered(e.action, e.at, { ok: false, reason }))
    }
  }

  // ---- the socket's minute (finding A-3 of verify round 0; A-6 and C-12 of verify round 1) -------------------------------------
  //
  // The rendezvous counts what one socket sends in a sliding minute (plan 3.2): past 120 relayed frames it refuses them, past 150 messages of any
  // kind it closes the socket, and the page loses every lane, code and knock at once. Every lane of the page shares this socket, so the link
  // keeps its own count, under those caps (relayBudget, messageBudget): a request that would go over waits here until a frame of the count runs
  // out, the relayed frames in the order they came (a request of another kind is not held behind them while there is room for it), at most
  // heldPerLane of one lane (the next is refused at once, and dropHeld drops a lane's when the page leaves it). The link counts a frame for
  // BUDGET_WINDOW_MS from its send, the rendezvous for a minute from its arrival: so a page does not trip the caps by itself while the network
  // delivers at an even pace, or gets faster by up to 5 seconds. A ping and a send() are counted and never held.

  _fits (relay) {
    const t = this._now()
    while (this._outT.length && t - this._outT[0] >= BUDGET_WINDOW_MS) this._outT.shift()
    while (this._relayT.length && t - this._relayT[0] >= BUDGET_WINDOW_MS) this._relayT.shift()
    return this._outT.length < this.messageBudget && (!relay || this._relayT.length < this.relayBudget)
  }

  /** How many relayed frames of this lane wait for the minute. */
  _heldOf (lane) {
    let n = 0
    for (const h of this._held) if (h.relay && h.lane === lane) n++
    return n
  }

  _take (relay) {
    const t = this._now()
    this._outT.push(t)
    if (relay) this._relayT.push(t)
  }

  /** _hold(relay, lane) -> Promise<boolean>: true when the request may go (its place in the minute is taken), false when the socket went first or its lane was left. */
  _hold (relay, lane = null) {
    return new Promise((resolve) => {
      this._held.push({ relay, lane, resolve })
      this._pump()
    })
  }

  _pump () {
    if (this._heldTimer !== null) {
      this._clearT(this._heldTimer)
      this._heldTimer = null
    }
    for (let i = 0; i < this._held.length;) {
      const h = this._held[i]
      if (!this._fits(h.relay)) {
        i++
        continue
      }
      this._held.splice(i, 1)
      this._take(h.relay)
      h.resolve(true)
    }
    if (!this._held.length || !this._outT.length) return
    // the next look is when the oldest frame of the count runs out (each relayed frame is in _outT too, so that one is never later)
    this._heldTimer = this._setT(() => {
      this._heldTimer = null
      this._pump()
    }, Math.max(1, this._outT[0] + BUDGET_WINDOW_MS - this._now()))
  }

  _failHeld () {
    if (this._heldTimer !== null) {
      this._clearT(this._heldTimer)
      this._heldTimer = null
    }
    for (const h of this._held.splice(0)) h.resolve(false)
  }

  /**
   * dropHeld(lane) -> n: the relayed frames of a lane the page leaves do not go when the minute has room, and they no longer keep the frames of
   * the other lanes waiting (finding A-6 of verify round 1). Each is answered 'closed'; the frames of every other lane keep their place.
   */
  dropHeld (lane) {
    const out = this._held.filter((h) => h.relay && h.lane === lane)
    if (!out.length) return 0
    this._held = this._held.filter((h) => !out.includes(h))
    for (const h of out) h.resolve(false)
    this._pump() // only the timer can change: nothing else fits now that did not before
    return out.length
  }

  // ---- receiving ------------------------------------------------------------------------------

  _onText (data) {
    if (typeof data !== 'string') return
    this._heard++ // any frame proves the socket lives (the keepalive's watchdog), whatever it says
    if (data.length > MAX_PAIR_BYTES) return
    let m
    try {
      m = JSON.parse(data)
    } catch (_) {
      return
    }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.action !== 'string') return
    if (typeof m.rid === 'string' && this._pending.has(m.rid)) {
      const e = this._pending.get(m.rid)
      this._pending.delete(m.rid)
      this._clearT(e.timer)
      if (Object.prototype.hasOwnProperty.call(m, 'failure reason')) e.resolve(this._answered(e.action, e.at, { ok: false, reason: reasonCode(m['failure reason']), reply: m }))
      else e.resolve(this._answered(e.action, e.at, { ok: true, reply: m }))
      return
    }
    if (m.action === 'pair-pong') return // the answer to a ping: it fed the watchdog above and is no event and no report
    const hit = PUSH_RE.exec(m.action)
    if (!hit) return
    const kind = hit[1]
    const what = hit[2]
    // the pushes of the relay lane carry no knock: they are checked here, before the knock check below (plan 3.5)
    if (what === 'relayed' || what === 'joined' || what === 'left') {
      this._onLanePush(kind, what, m, hit[0])
      return
    }
    if (what === 'close') {
      // the rendezvous ends a code this socket owns (it runs out after 24 hours); a reply to our own close carries a rid and never gets here
      if (isChannel(m.channel)) {
        this._rep('push', { name: hit[0] })
        this._emit('closed', { kind, channel: m.channel, reason: typeof m.reason === 'string' ? m.reason.slice(0, 32) : 'closed' })
      }
      return
    }
    if (typeof m.knock !== 'string' || !TOKEN_RE.test(m.knock)) return
    if (what === 'request') {
      if (!isChannel(m.channel) || !boxOk(m.box)) return
      this._rep('push', { name: hit[0] })
      this._emit('request', { kind, knock: m.knock, channel: m.channel, box: { iv: m.box.iv, ct: m.box.ct } })
    } else if (what === 'accepted') {
      if (!LANE_RE.test(String(m.lane)) || !isChannel(m.channel) || !boxOk(m.box)) return
      this._dropKnock(kind, m.knock)
      this._rep('push', { name: hit[0] })
      this._emit('accepted', { kind, knock: m.knock, lane: m.lane, channel: m.channel, box: { iv: m.box.iv, ct: m.box.ct }, proof: typeof m.proof === 'string' && PROOF_RE.test(m.proof) ? m.proof : null })
    } else if (what === 'rejected') {
      this._dropKnock(kind, m.knock)
      this._rep('push', { name: hit[0] })
      this._emit('rejected', { kind, knock: m.knock, reason: REASONS.has(m.reason) ? m.reason : 'rejected' })
    } else if (what === 'cancelled') {
      this._rep('push', { name: hit[0] })
      this._emit('cancelled', { kind, knock: m.knock })
    }
  }

  // A push of the relay lane. Its lane must be 40 lowercase hex, a frame 4 to 7,700 characters that decode strictly, a count a whole number
  // from 0 to PEERS_MAX: anything else is dropped without an event and without a report. Only the name of the push is ever reported.
  _onLanePush (kind, what, m, name) {
    if (typeof m.lane !== 'string' || !LANE_RE.test(m.lane)) return
    if (what === 'relayed') {
      if (typeof m.f !== 'string' || !FRAME_RE.test(m.f)) return
      let bytes
      try {
        bytes = b64url.decode(m.f)
      } catch (_) {
        return
      }
      this._rep('push', { name })
      this._emit('relayed', { lane: m.lane, kind, bytes })
      return
    }
    if (!Number.isInteger(m.peers) || m.peers < 0 || m.peers > PEERS_MAX) return
    this._rep('push', { name })
    this._emit(what, { lane: m.lane, kind, peers: m.peers })
  }

  // ---- knock timers ---------------------------------------------------------------------------

  _trackKnock (kind, knock) {
    const key = kind + ':' + knock
    this._dropKnock(kind, knock)
    const rec = { silent: null, expire: null }
    rec.silent = this._setT(() => {
      rec.silent = null
      this._emit('silent', { kind, knock })
    }, this.knockSilentMs)
    rec.expire = this._setT(() => {
      this._knocks.delete(key)
      this._emit('rejected', { kind, knock, reason: 'expired' })
    }, this.knockExpireMs)
    this._knocks.set(key, rec)
  }

  _dropKnock (kind, knock) {
    const key = kind + ':' + knock
    const rec = this._knocks.get(key)
    if (!rec) return
    if (rec.silent !== null) this._clearT(rec.silent)
    if (rec.expire !== null) this._clearT(rec.expire)
    this._knocks.delete(key)
  }

  _clearKnocks () {
    for (const rec of this._knocks.values()) {
      if (rec.silent !== null) this._clearT(rec.silent)
      if (rec.expire !== null) this._clearT(rec.expire)
    }
    this._knocks.clear()
  }

  // ---- typed calls ----------------------------------------------------------------------------

  async openCode ({ kind, channel, box }) {
    if (!KINDS.has(kind)) return { ok: false, reason: 'kind' }
    const r = await this.request(kind + '-open', { channel, box })
    if (!r.ok) return { ok: false, reason: r.reason }
    if (kind === 'room') {
      const lane = r.reply.lane
      if (!LANE_RE.test(String(lane))) return { ok: false, reason: 'bad-reply' }
      return { ok: true, lane }
    }
    return { ok: true, lane: null }
  }

  async closeCode ({ kind, channel }) {
    if (!KINDS.has(kind)) return { ok: false, reason: 'kind' }
    if (this._state !== 'open') return { ok: true }
    const r = await this.request(kind + '-close', kind === 'room' ? { channel } : {}, { timeoutMs: 3000 })
    return { ok: r.ok || r.reason === 'timeout', reason: r.ok ? undefined : r.reason }
  }

  async knock ({ kind, channel, box }) {
    if (!KINDS.has(kind)) return { ok: false, reason: 'kind' }
    const r = await this.request(kind + '-knock', { channel, box })
    if (!r.ok) return { ok: false, reason: r.reason }
    const knock = r.reply.knock
    if (typeof knock !== 'string' || !TOKEN_RE.test(knock)) return { ok: false, reason: 'bad-reply' }
    this._trackKnock(kind, knock)
    return { ok: true, knock }
  }

  async accept ({ kind, knock, proof }) {
    if (!KINDS.has(kind)) return { ok: false, reason: 'kind' }
    const r = await this.request(kind + '-accept', { knock, proof })
    if (!r.ok) return { ok: false, reason: r.reason }
    if (kind === 'pair') {
      const lane = r.reply.lane
      if (!LANE_RE.test(String(lane))) return { ok: false, reason: 'bad-reply' }
      return { ok: true, lane }
    }
    return { ok: true, lane: null }
  }

  async reject ({ kind, knock }) {
    if (!KINDS.has(kind)) return { ok: false, reason: 'kind' }
    const r = await this.request(kind + '-reject', { knock })
    return r.ok ? { ok: true } : { ok: false, reason: r.reason }
  }

  async cancel ({ kind, knock }) {
    if (!KINDS.has(kind)) return { ok: false, reason: 'kind' }
    this._dropKnock(kind, knock)
    this.send(kind + '-cancel', { knock })
    return { ok: true }
  }

  // ---- the relay lane (plan 3.5) --------------------------------------------------------------

  /** join(lane, kind) -> { ok: true, peers } | { ok: false, reason }: peers = the other sockets in the lane. */
  async join (lane, kind) {
    if (!KINDS.has(kind)) return { ok: false, reason: 'kind' }
    if (typeof lane !== 'string' || !LANE_RE.test(lane)) return { ok: false, reason: 'invalid-lane' }
    const r = await this.request(kind + '-join', { lane })
    if (!r.ok) return { ok: false, reason: r.reason }
    const peers = r.reply.peers
    if (!Number.isInteger(peers) || peers < 0 || peers > PEERS_MAX) return { ok: false, reason: 'bad-reply' }
    return { ok: true, peers }
  }

  /**
   * relay(lane, kind, bytes) -> { ok: true, peers } | { ok: false, reason }: one sealed frame to the others of the lane (base64url without
   * padding in f). peers = the sockets it was written to; 0 means nobody was there and the caller keeps the frame. A frame that cannot be
   * sent is refused here, and told in a report as a reply, before anything leaves: 'too-big' over 7,700 characters, 'invalid-frame' under 4.
   */
  async relay (lane, kind, bytes) {
    if (!KINDS.has(kind)) return { ok: false, reason: 'kind' }
    if (typeof lane !== 'string' || !LANE_RE.test(lane)) return { ok: false, reason: 'invalid-lane' }
    const action = kind + '-relay'
    const at = this._now()
    if (!(bytes instanceof Uint8Array)) return this._answered(action, at, { ok: false, reason: 'invalid-frame' })
    const f = b64url.encode(bytes)
    if (f.length > FRAME_CHARS_MAX) return this._answered(action, at, { ok: false, reason: 'too-big' })
    if (f.length < 4) return this._answered(action, at, { ok: false, reason: 'invalid-frame' })
    const r = await this.request(action, { lane, f })
    if (!r.ok) return { ok: false, reason: r.reason }
    const peers = r.reply.peers
    if (!Number.isInteger(peers) || peers < 0 || peers > PEERS_MAX) return { ok: false, reason: 'bad-reply' }
    return { ok: true, peers }
  }

  /**
   * leave(lane, kind) -> { ok }: ok on a timeout and when the socket is not open (the rendezvous drops the lanes of a closed socket). The lane's
   * frames that wait for the socket's minute are dropped first, whatever the state of the socket (dropHeld).
   */
  async leave (lane, kind) {
    if (!KINDS.has(kind)) return { ok: false, reason: 'kind' }
    if (typeof lane !== 'string' || !LANE_RE.test(lane)) return { ok: false, reason: 'invalid-lane' }
    this.dropHeld(lane)
    if (this._state !== 'open') return { ok: true }
    const r = await this.request(kind + '-leave', { lane }, { timeoutMs: LEAVE_TIMEOUT_MS })
    if (r.ok) return { ok: true }
    return r.reason === 'timeout' ? { ok: true, reason: 'timeout' } : { ok: false, reason: r.reason }
  }
}

export function createLink (opts) {
  return new PairLink(opts)
}
