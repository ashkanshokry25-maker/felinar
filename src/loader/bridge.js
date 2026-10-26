// src/loader/bridge.js: the shell side of the site SDK (ARCHITECTURE 9 and 15.9; R 2.11; DESIGN-REVIEW items 3, 8).
// The site frame posts { mw: 'hello' } with a MessagePort; requests arrive on that port as
// { id, method, params } and are answered with { id, ok, result | error: { code, message } };
// pushes are { event, data }. The method table, validation, gating and limits are src/loader/api.js (MwApi), the
// same object the drop-in binding uses; this module is the transport: the handshake, the port, write progress
// and cancellation, state pushes, and the activation tracker on the site frame.
// Nothing touches the DOM at import time; window and origin are injectable for Node tests.
//
// v0.2.1 (DIGEST-AMENDMENTS A4) and v0.3 (R 2.11.1): LOADER_ONLY_METHODS (identity.export, identity.import,
// identity.root, consent.accept, link.accept, keys.export, media.key) are unknown methods (E_BAD_REQUEST). UI
// methods need a click in the site frame: the Bridge watches the frame's window for trusted input events (a
// site cannot fake isTrusted) and answers E_NEEDS_GESTURE without one; a flag in the params proves nothing.
//
// Writes and their fee (code review round 1, DESIGN-REVIEW item 4): every write runs with its own
// AbortSignal. While the proof-of-work fee is computed the Bridge pushes { event: 'pow', data:
// { id, hashes, bits } } (id = the write request's id; the SDK extends its timeout while these
// arrive) and shows it on the loader's status line (ui.setWriteProgress). { method: 'write.cancel',
// params: { id } } aborts the write with that request id (the SDK sends it when it gives up), so a
// write the site saw fail is never stored or published; the write answers E_POW_ABORTED.
// Results the port cannot carry (functions) are reduced: files.fetch answers { handle, name, size, mime, blob }
// with the Blob typed application/octet-stream (R 2.8.5, MF-48).
// v0.3 C2 (lane wire-ui): mw.calls and mw.net.seeding / dock / keep are rows of the same table (src/loader/api.js); the
// 'calls' push carries the calls service's ring, state, peer and ended events, plain data only (SZ 3.5 "SDK").

import {
  MwApi, ActivationTracker, READ_METHODS, WRITE_METHODS, UI_METHODS, CONTROL_METHODS, ERROR_CODES, PUSH_EVENTS, DEFAULT_LIMITS,
  METHOD_ARGS, isPlainJson, validateEnvelope as apiValidateEnvelope, validateParams, mapError, RateLimiter, apiError,
  plainOnly, C2_CALL_METHODS
} from './api.js'

export { READ_METHODS, WRITE_METHODS, UI_METHODS, CONTROL_METHODS, ERROR_CODES, PUSH_EVENTS, DEFAULT_LIMITS, isPlainJson, validateParams, mapError, RateLimiter }
export const BRIDGE_METHODS = Object.freeze(READ_METHODS.concat(WRITE_METHODS, UI_METHODS, CONTROL_METHODS))
/** Transport pushes (not site events): 'wait' { id } every waitPushMs while a request is still being answered. */
export const TRANSPORT_EVENTS = Object.freeze(['wait'])
export const WAIT_PUSH_MS = 20000

const BRIDGE_SET = new Set(BRIDGE_METHODS)
const WRITE_SET = new Set(WRITE_METHODS)
const UI_SET = new Set(UI_METHODS)

/** validateEnvelope(msg, { maxBytes }) for the Bridge: the API methods plus write.cancel. */
export function validateEnvelope (msg, { maxBytes = DEFAULT_LIMITS.maxRequestBytes } = {}) {
  return apiValidateEnvelope(msg, { maxBytes, methods: BRIDGE_SET })
}

/** argsToParams(method, args): the v0.2.1 positional form (tests, older callers) as the params object. */
export function argsToParams (method, args) {
  if (!Array.isArray(args)) return args && typeof args === 'object' ? args : {}
  const names = METHOD_ARGS[method] || []
  const out = {}
  names.forEach((n, i) => {
    if (args[i] === undefined) return
    if (n === '...') { if (args[i] && typeof args[i] === 'object') Object.assign(out, args[i]) } else out[n] = args[i]
  })
  return out
}

const CALL_METHOD_SET = new Set(C2_CALL_METHODS)

/**
 * portSafe(method, result) -> what a MessagePort can carry (no functions; files.fetch gets its Blob). C2 wire-ui: a
 * calls.* result is reduced to plain JSON here as well as in MwApi, so no MediaStream or track can cross the port.
 */
export async function portSafe (method, result) {
  if (CALL_METHOD_SET.has(method)) return plainOnly(result)
  if (!result || typeof result !== 'object') return result
  if (method === 'files.fetch' && typeof result.blob === 'function') {
    const blob = await result.blob()
    return { handle: result.handle, name: result.name, size: result.size, mime: result.mime || 'application/octet-stream', blob }
  }
  if (Array.isArray(result)) return result
  let out = null
  for (const k of Object.keys(result)) {
    if (typeof result[k] === 'function') {
      if (!out) out = Object.assign({}, result)
      delete out[k]
    }
  }
  return out || result
}

/**
 * new Bridge({ iframe, node, torrentManager, consent, ui, info, limits, identity, win, origin, now, api, activation })
 *  api: the loader's MwApi (src/loader/app.js keeps one for the page and mounts the services on it); without
 *    one the Bridge makes its own from the other options (tests, older callers).
 *  activation: the loader's ActivationTracker; the Bridge watches the site frame's window with it.
 *  node: ChainNode (or the follower-tab proxy) or null until it opens (setNode()).
 *  consent: { state() -> 'pending'|'accepted'|'host-only', request?() -> Promise<state> }; the site never accepts.
 *  ui: loader-owned UI hooks { openConsent(), prompt(kind, data), setWriteProgress(p) } (src/loader/ui.js).
 *  info: object or () -> object with { siteId, btih, mode, name, files, owner, unmoderated, source }.
 *  identity: the 0.2.1 key provider { current() -> { pub, short, name } } (when no identity service is mounted).
 */
export class Bridge {
  constructor ({ iframe, node = null, torrentManager = null, consent = null, ui = null, info = {}, limits = {}, identity = null, win = null, origin = null, now = () => Date.now(), api = null, activation = null } = {}) {
    if (!iframe) throw new TypeError('Bridge needs the site iframe')
    this.iframe = iframe
    this.win = win || (typeof window !== 'undefined' ? window : null)
    this.origin = origin || (this.win && this.win.location ? this.win.location.origin : null)
    this.now = now
    this.limits = Object.assign({}, DEFAULT_LIMITS, limits || {})
    this.tracker = activation || (api && api.tracker) || new ActivationTracker({ now, nav: this.win && this.win.navigator ? this.win.navigator : null })
    this.ownsApi = !api
    this.api = api || new MwApi({ node, torrentManager, consent, ui, info, identity, limits, now, activation: this.tracker })
    if (!api) {
      // A Bridge-made MwApi keeps the node and manager it was given; one the loader made already has them.
      if (node) this.api.setNode(node)
      if (torrentManager) this.api.setTorrentManager(torrentManager)
    }
    this.ui = ui || this.api.ui
    this.port = null
    this.attached = false
    this.stats = { handshakes: 0, requests: 0, rejected: 0, rateLimited: 0 }
    this._unsubscribe = null
    this._tmHandlers = []
    this._statePending = false
    this._stateTimer = null
    this._lastStatePush = 0
    this._inflight = new Map() // write request id -> AbortController
    this._offPush = null
    this._unwatch = null
    this._onFrameLoad = () => this._watchFrame()
    this._onMessage = (ev) => this.handleWindowMessage(ev)
  }

  get node () { return this.api.node }
  set node (n) { this.api.node = n }
  get tm () { return this.api.tm }
  set tm (t) { this.api.tm = t }

  attach () {
    if (this.attached) return this
    this.attached = true
    if (this.win) this.win.addEventListener('message', this._onMessage)
    this._offPush = this.api.addPushListener((event, data) => this.push(event, data))
    this._watchFrame()
    try { if (this.iframe && typeof this.iframe.addEventListener === 'function') this.iframe.addEventListener('load', this._onFrameLoad) } catch (_) { /* no frame events */ }
    this._bindNode()
    this._bindTorrent(this.tm)
    return this
  }

  destroy () {
    if (!this.attached) return
    this.attached = false
    if (this.win) this.win.removeEventListener('message', this._onMessage)
    if (this._offPush) { this._offPush(); this._offPush = null }
    if (this._unwatch) { this._unwatch(); this._unwatch = null }
    try { if (this.iframe && typeof this.iframe.removeEventListener === 'function') this.iframe.removeEventListener('load', this._onFrameLoad) } catch (_) { /* gone */ }
    this._closePort()
    if (this._unsubscribe) { try { this._unsubscribe() } catch (_) { /* ignore */ } this._unsubscribe = null }
    for (const [type, fn] of this._tmHandlers) { try { this.tm.removeEventListener(type, fn) } catch (_) { /* ignore */ } }
    this._tmHandlers = []
    if (this._stateTimer) { clearTimeout(this._stateTimer); this._stateTimer = null }
    for (const ctl of this._inflight.values()) { try { ctl.abort() } catch (_) { /* done */ } }
    this._inflight.clear()
    if (this.ownsApi) this.api.destroy()
  }

  /** The trusted input of the site frame: re-attached after each navigation inside the frame (a new Window). */
  _watchFrame () {
    if (this._unwatch) { this._unwatch(); this._unwatch = null }
    let w = null
    try { w = this.iframe.contentWindow } catch (_) { w = null }
    if (w && this.tracker && typeof this.tracker.watch === 'function') this._unwatch = this.tracker.watch(w)
  }

  /** Late binding: the ledger opens after the site renders. node null + failed = no ledger here. */
  setNode (node, { failed = false } = {}) {
    if (this._unsubscribe) { try { this._unsubscribe() } catch (_) { /* ignore */ } this._unsubscribe = null }
    this.api.setNode(node, { failed })
    if (this.attached) this._bindNode()
    this.pushState()
  }

  setTorrentManager (tm) {
    for (const [type, fn] of this._tmHandlers) { try { this.tm.removeEventListener(type, fn) } catch (_) { /* ignore */ } }
    this._tmHandlers = []
    this.api.setTorrentManager(tm)
    if (this.attached) this._bindTorrent(tm)
  }

  push (event, data) {
    if (!this.port) return false
    try {
      this.port.postMessage({ event, data })
      return true
    } catch (_) { return false }
  }

  pushState () {
    if (!this.port) return
    const now = this.now()
    const due = this._lastStatePush + this.limits.statePushMs
    if (now >= due && !this._stateTimer) {
      this._lastStatePush = now
      const snap = this.snapshot()
      if (snap) {
        this.push('state', snap)
        this.push('sync', { height: snap.height || 0, peers: snap.peers || 0, inSync: snap.inSync || 0 })
      }
      return
    }
    if (this._stateTimer) return
    this._stateTimer = setTimeout(() => {
      this._stateTimer = null
      this.pushState()
    }, Math.max(0, due - now))
  }

  snapshot () { return this.api.snapshot() }

  // ----- window side --------------------------------------------------------------------------

  handleWindowMessage (ev) {
    // `event.source === iframe.contentWindow` only proves the message came from the browsing
    // context inside our frame. It is NOT an origin check: after a cross-origin navigation the
    // frame keeps the same WindowProxy. The origin must be compared as well.
    if (!ev || ev.source !== this.iframe.contentWindow) return false
    if (ev.origin !== this.origin) return false
    const data = ev.data
    if (!data || typeof data !== 'object' || data.mw !== 'hello') return false
    const port = ev.ports && ev.ports[0]
    if (!port || typeof port.postMessage !== 'function') return false
    this.stats.handshakes++
    this._watchFrame()
    this._adopt(port)
    return true
  }

  _adopt (port) {
    this._closePort()
    this.port = port
    port.onmessage = (e) => { this.handleRequest(e && e.data) }
    if (typeof port.start === 'function') port.start()
    try { port.postMessage({ mw: 'ready', proto: 1 }) } catch (_) { /* detached */ }
    this._lastStatePush = 0
    this.pushState()
    this.push('peers', { count: this.tm ? this.tm.peers : 0 })
  }

  _closePort () {
    const old = this.port
    this.port = null
    if (!old) return
    try { old.onmessage = null } catch (_) { /* ignore */ }
    try { old.close() } catch (_) { /* ignore */ }
  }

  // ----- requests -----------------------------------------------------------------------------

  async handleRequest (msg) {
    this.stats.requests++
    const env = validateEnvelope(msg, { maxBytes: this.limits.maxRequestBytes })
    if (!env.ok) { this.stats.rejected++; return this._respond(env.id, undefined, env.error) }
    if (env.method === 'write.cancel') {
      const p = validateParams('write.cancel', env.params)
      if (!p.ok) { this.stats.rejected++; return this._respond(env.id, undefined, p.error) }
      return this._respond(env.id, this._cancel(p.args[0]))
    }
    let opts
    let ctl = null
    // A request that waits for the person (a card, the identity page, a guest's sign-in prompt) is kept alive in
    // the SDK by 'wait' pushes (the SDK's 30 s answer timer restarts on each, for at most 10 minutes).
    const waitMs = this.limits.waitPushMs || WAIT_PUSH_MS
    const keep = setInterval(() => this.push('wait', { id: env.id }), waitMs)
    if (keep && typeof keep.unref === 'function') keep.unref()
    if (WRITE_SET.has(env.method) || UI_SET.has(env.method)) {
      ctl = typeof AbortController === 'function' ? new AbortController() : null
      if (ctl) this._inflight.set(env.id, ctl)
      opts = { signal: ctl ? ctl.signal : null, onProgress: (p) => this._writeProgress(env.id, p) }
    }
    try {
      const res = await this.api.request(env.method, env.params, opts)
      if (!res.ok) {
        this.stats.rejected++
        if (res.reason === 'rate') this.stats.rateLimited++
        this._respond(env.id, undefined, res.error)
      } else {
        this._respond(env.id, await portSafe(env.method, res.result))
      }
      if (env.method === 'ready') this.pushState()
    } catch (err) {
      this.stats.rejected++
      this._respond(env.id, undefined, mapError(err))
    } finally {
      clearInterval(keep)
      if (ctl) {
        if (this._inflight.get(env.id) === ctl) this._inflight.delete(env.id)
        this._writeProgress(env.id, null)
      }
    }
  }

  _cancel (id) {
    const ctl = this._inflight.get(id)
    if (!ctl) return false
    ctl.abort()
    return true
  }

  /**
   * dispatch(method, args, opts) -> result (throws { code, message }): one call through the method table, for
   * tests and loader code. args is the positional SDK form (METHOD_ARGS) or a params object.
   */
  async dispatch (method, args, opts) {
    if (method === 'write.cancel') return this._cancel(Array.isArray(args) ? args[0] : args && args.id)
    const res = await this.api.request(method, argsToParams(method, args), opts)
    if (!res.ok) throw res.error || apiError('E_INTERNAL', 'failed')
    return res.result
  }

  // The fee of a write in progress: pushed to the site and shown on the loader's status line.
  _writeProgress (id, p) {
    if (p) this.push('pow', { id, hashes: Number(p.hashes) || 0, bits: Number(p.bits) || 0 })
    const ui = this.ui
    if (ui && typeof ui.setWriteProgress === 'function') {
      try { ui.setWriteProgress(p ? { hashes: Number(p.hashes) || 0, bits: Number(p.bits) || 0 } : null) } catch (_) { /* no UI */ }
    }
  }

  _respond (id, result, error) {
    if (!this.port || id === null || id === undefined) return false
    const msg = error ? { id, ok: false, error } : { id, ok: true, result }
    try {
      this.port.postMessage(msg)
      return true
    } catch (_) {
      try { this.port.postMessage({ id, ok: false, error: apiError('E_INTERNAL', 'result could not be sent') }) } catch (_) { /* detached */ }
      return false
    }
  }

  // ----- wiring -------------------------------------------------------------------------------

  _bindNode () {
    const node = this.node
    if (!node || typeof node.subscribe !== 'function' || this._unsubscribe) return
    try { this._unsubscribe = node.subscribe(() => this.pushState()) } catch (_) { this._unsubscribe = null }
  }

  _bindTorrent (tm) {
    if (!tm || typeof tm.addEventListener !== 'function') return
    const handlers = [
      ['peers', (e) => { this.push('peers', { count: e.detail ? e.detail.count : 0 }); this.pushState() }],
      ['progress', (e) => this.push('progress', e.detail || {})],
      ['status', (e) => this.push('status', e.detail || {})]
    ]
    for (const [type, fn] of handlers) tm.addEventListener(type, fn)
    this._tmHandlers = handlers
  }
}
