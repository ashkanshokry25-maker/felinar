// src/loader/apps-link.js: the client of the pair socket (ARCHITECTURE 15.21, mw-pair-v1). One WebSocket to the first rendezvous
// URL of the door's apps block, JSON text frames of at most 8,192 bytes with v: 1, an action and an optional rid (the client's
// request id, echoed in the direct reply), reconnect with back off, timers for knocks, and events for what the rendezvous pushes.
//
//   createLink({ url, WebSocketImpl, setTimeoutFn, clearTimeoutFn, random, backoffMs, knockSilentMs, knockExpireMs,
//                requestTimeoutMs, keepaliveMs, log, report, now }) -> PairLink
//
//   link.state            'idle' (not started or closed) | 'connecting' | 'open' | 'backoff' (waiting to retry)
//   link.connect()        starts the socket (also ends a back off wait at once); nothing is opened before the first call
//   link.close()          stops for good: no reconnect, pending requests fail with reason 'closed'
//   link.on(event, fn)    -> off. Events (the payload is one object):
//     state     { state }                              every change of link.state
//     open      {}                                     the socket opened (first time and after every reconnect)
//     gone      {}                                     the socket was lost: its codes and knocks are released at the rendezvous
//     request   { kind, knock, channel, box }          a requester knocked on a code this socket owns (pair-request, room-request)
//     accepted  { kind, knock, lane, channel, box, proof }  the owner accepted this socket's knock; box is the owner's sealed hello and
//                                                      proof the owner's signature over the channel and the knock (null when none came:
//                                                      the service does not act on an accept without a valid one)
//     rejected  { kind, knock, reason }                'rejected' | 'expired' | 'closed' | 'gone' (also raised locally at 10 minutes)
//     cancelled { kind, knock }                        a requester withdrew its knock
//     closed    { kind, channel, reason }              the rendezvous ended a code this socket owns ('expired' after 24 hours)
//     silent    { kind, knock }                        30 seconds without an answer to this socket's knock ("unknown code")
//   Typed calls (kind is 'pair' or 'room'; each resolves to { ok: true, ... } or { ok: false, reason }):
//     openCode({ kind, channel, box }) -> { ok, lane }   closeCode({ kind, channel }) -> { ok }
//     knock({ kind, channel, box }) -> { ok, knock }     accept({ kind, knock, proof }) -> { ok, lane }
//     reject({ kind, knock }) -> { ok }                  cancel({ kind, knock }) -> { ok } (no reply exists; nothing is awaited)
//   request(action, fields, { timeoutMs }) -> { ok: true, reply } | { ok: false, reason } is the untyped call under them.
// Failure replies ({ 'failure reason': text }) become reason slugs ('channel taken' -> 'channel-taken'). Reasons the link adds:
// 'link-down' (the socket did not open in time), 'closed' (lost or closed while waiting), 'timeout', 'too-big', 'bad-reply'.
//
// report(name, fields) is optional (usage reports, docs/OBSERVABILITY.md; the page adds a prefix to every name). It hears, as flat
// objects of words and counts: state { state, prev }, open { attempt }, gone { why }, backoff { attempt, ms, why }, sent { action }
// (a frame went out), reply { action, ok, reason, ms }, timeout { action, ms } and push { name } (a push that passed its checks).
// Only the names of this protocol's actions and pushes and short reason slugs appear: never a box, a proof, a channel, a knock token,
// a lane or an address. A report that throws is ignored. now() -> ms (default Date.now) times the replies.
//
// The socket is opened only after connect(); the rendezvous learns channels, knock timing, lane ids and the socket's address
// (as any relay does), never names, keys or which identity talks to which (the boxes are sealed under the code).
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

const LANE_RE = /^[0-9a-f]{40}$/
const TOKEN_RE = /^[A-Za-z0-9_-]{1,32}$/
const PROOF_RE = /^[A-Za-z0-9_-]{86}$/
const KINDS = new Set(['pair', 'room'])
const REASONS = new Set(['rejected', 'expired', 'closed', 'gone'])
const PUSH_RE = /^(pair|room)-(request|accepted|rejected|cancelled|close)$/

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
    openWaitMs = OPEN_WAIT_MS, keepaliveMs = 0, log = null, report = null, now = null
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
    this._log = typeof log === 'function' ? log : noop
    this._report = typeof report === 'function' ? report : null
    this._now = typeof now === 'function' ? now : () => Date.now()
    this._state = 'idle'
    this._ws = null
    this._stopped = true
    this._attempt = 0
    this._retryTimer = null
    this._keepTimer = null
    this._pending = new Map() // rid -> { resolve, timer }
    this._waiters = [] // { resolve, timer }: calls waiting for the socket to open
    this._knocks = new Map() // kind:knock -> { silent, expire }
    this._listeners = new Map()
    this._pingOk = true
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
    if (this._keepTimer !== null) {
      this._clearT(this._keepTimer)
      this._keepTimer = null
    }
    this._failPending('closed')
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
    if (this._keepTimer !== null) {
      this._clearT(this._keepTimer)
      this._keepTimer = null
    }
    this._failPending('closed')
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

  _armKeepalive () {
    if (!(this.keepaliveMs > 0) || !this._pingOk || this._keepTimer !== null) return
    const tick = () => {
      this._keepTimer = null
      if (this._state !== 'open' || !this._pingOk) return
      this.request('pair-ping', {}, { timeoutMs: 5000 }).then((r) => {
        if (!r.ok && r.reason !== 'closed' && r.reason !== 'timeout') this._pingOk = false
      })
      this._keepTimer = this._setT(tick, this.keepaliveMs)
    }
    this._keepTimer = this._setT(tick, this.keepaliveMs)
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
    if (ok) this._rep('sent', { action: reportWord(action) })
    return ok
  }

  /** request(action, fields, { timeoutMs }) -> Promise<{ ok: true, reply } | { ok: false, reason }>. */
  async request (action, fields = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    const at = this._now()
    if (!this.WS) return this._answered(action, at, { ok: false, reason: 'link-down' })
    if (this._state !== 'open') {
      const up = await this.whenOpen()
      if (!up) return this._answered(action, at, { ok: false, reason: 'link-down' })
    }
    const rid = b64url.encode(randomBytes(6))
    const text = this._frame(action, fields, rid)
    if (text === null) return this._answered(action, at, { ok: false, reason: 'too-big' })
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

  // ---- receiving ------------------------------------------------------------------------------

  _onText (data) {
    if (typeof data !== 'string' || data.length > MAX_PAIR_BYTES) return
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
    const hit = PUSH_RE.exec(m.action)
    if (!hit) return
    const kind = hit[1]
    const what = hit[2]
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
}

export function createLink (opts) {
  return new PairLink(opts)
}
