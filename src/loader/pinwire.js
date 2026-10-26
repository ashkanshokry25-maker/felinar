// src/loader/pinwire.js: the browser side of mw_pin1 (v0.3 C2, lane seed-engine; docs/research/v03/
// SEEDING-AND-ZERO-SETUP-DESIGN.md 3.1.6 and 3.1.5 E4; V03-DESIGN-REVIEW 2.5.5 (_mw.cfg.pin is the pin's key), 2.10.3
// (distinct signing prefixes)). The pin node is infrastructure the owner or a hub runs (tools/pin.mjs, lane pin-node);
// a member's browser never becomes one.
//
// mw_pin1 is a BEP 10 extension on site and file torrent wires, JSON frames of at most 1 KiB:
//   chal  { t: 'chal', n }                              n = 16 random bytes, b64url; sent once per wire
//   hello { t: 'hello', key, ih, n, at, sig }           sig over "mw-pin1-hello\n" + ih + "\n" + n + "\n" + at
//   rcpt  { t: 'rcpt', key, ih, total, at, sig }        sig over "mw-pin1-receipt\n" + ih + "\n" + total + "\n" + at
// ECDSA P-256, raw P1363 signatures, |now - at| at most 5 minutes, key = _mw.cfg.pin.
//
// Verifier role (every page whose site names a pin): sends chal once per wire when the remote advertises mw_pin1,
// verifies hello against _mw.cfg.pin (then anchorWire: the pin keeps its slot), records receipts per infohash (E4,
// "Kept by the site"). Responder role only in the pin's own page: the top frame has window.__mwPinCall (tools/pin.mjs
// exposes it) and its 'pin.key' equals _mw.cfg.pin; hello and rcpt are signed through 'pin.sign', so the key never
// enters the page, and the Node signer refuses anything but these two forms (src/pin/frames.js isPinSignable). The
// responder answers each wire's first chal with hello and sends rcpt once the item is complete and verified here.
// fetchHeartbeat(wsBase) reads <ws base>/pin-status.json at most every 10 minutes and keeps it when its signature
// and age (15 minutes) check out: items are hashed (b64url of the first 16 bytes of SHA-256("mw-pin-status-v1|" + ih)),
// so private infohashes never appear in the clear.
//
// Codec: the frames and heartbeat modules of lane pin-node (src/pin/frames.js, src/pin/heartbeat.js) when present,
// else the SZ 3.1.6 implementation below (the same byte strings and checks; unit-tested against test/vectors/pin.json).
//
//   createPinWire({ tm, pinKey, win, fetch, now, random, codec, site, log }) -> PinWire
//     attach(tm?) / detach() / refresh() / key / responder / ready
//     evidence(ih, now) -> { configured, receipt, heartbeat } (the pin argument of availability.evidence)
//     receipt(ih) / isPinWire(wire) / pinWires(ih?) / pinProgress(ih) / fetchHeartbeat(wsBase, { force }) / heartbeat()
//   fetchHeartbeat(wsBase, { pinKey, fetch, now, site, codec }) -> Promise<{ ok, reason, heartbeat }> (one read, no cache)
//     on('receipt' | 'pin-wire' | 'heartbeat' | 'warning', fn) -> off
//   createPinPageHost({ tm, storeClass, announce }) -> { start, stop, status }: window.__mwPinHost of the pin's page

import { verify } from '../chain/crypto.js'
import { canonicalize, utf8, b64url } from '../chain/canonical.js'
import { createSha256 } from '../files/validate.js'
import { readCappedBody } from '../common/read-capped.js'

export const EXT_NAME = 'mw_pin1'
export const FRAME_MAX = 1024
export const NONCE_BYTES = 16
export const SKEW_MS = 300000
export const HEARTBEAT_MAX_AGE_MS = 900000
export const HEARTBEAT_EVERY_MS = 600000
export const HEARTBEAT_MAX_BYTES = 262144
export const HEARTBEAT_MAX_ITEMS = 4096
export const MAX_FRAMES_PER_WIRE = 16
export const STRIKES = 3

const IH_RE = /^[0-9a-f]{40}$/
const B64URL_RE = /^[A-Za-z0-9_-]+$/

function noop () {}

// ---- SZ 3.1.6 byte strings and checks (the codec when lane pin-node's modules are absent) ---------------

/** helloBytes(ih, n, at) -> utf8("mw-pin1-hello\n" + ih + "\n" + n + "\n" + at). */
export function helloBytes (ih, n, at) { return utf8.encode('mw-pin1-hello\n' + ih + '\n' + n + '\n' + at) }

/** receiptBytes(ih, total, at) -> utf8("mw-pin1-receipt\n" + ih + "\n" + total + "\n" + at). */
export function receiptBytes (ih, total, at) { return utf8.encode('mw-pin1-receipt\n' + ih + '\n' + total + '\n' + at) }

/** statusBytes(obj) -> utf8("mw-pin-status-v1\n" + JCS(obj without sig)). */
export function statusBytes (obj) {
  const o = Object.assign({}, obj)
  delete o.sig
  return utf8.encode('mw-pin-status-v1\n' + canonicalize(o))
}

/** statusItem(ih) -> b64url of the first 16 bytes of SHA-256(utf8("mw-pin-status-v1|" + ih)): a heartbeat item. */
export function statusItem (ih) {
  const d = createSha256().update(utf8.encode('mw-pin-status-v1|' + String(ih).toLowerCase())).digest()
  return b64url.encode(d.subarray(0, 16))
}

/** encodeFrame(obj) -> Uint8Array, or null when the JSON is above FRAME_MAX bytes. */
export function encodeFrame (obj) {
  let bytes
  try { bytes = utf8.encode(JSON.stringify(obj)) } catch (_) { return null }
  return bytes.length > FRAME_MAX ? null : bytes
}

/** decodeFrame(bytes) -> a frame object with a string t, or null (too long, not JSON, not an object). */
export function decodeFrame (bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : (bytes && ArrayBuffer.isView(bytes) ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : (bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : null))
  if (!u8 || u8.length === 0 || u8.length > FRAME_MAX) return null
  let obj
  try { obj = JSON.parse(utf8.decode(u8)) } catch (_) { return null }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || typeof obj.t !== 'string') return null
  return obj
}

function isNonce (n) {
  if (typeof n !== 'string' || !B64URL_RE.test(n)) return false
  try { return b64url.decode(n).length === NONCE_BYTES } catch (_) { return false }
}

function isAt (at) { return Number.isSafeInteger(at) && at >= 0 }

/** verifyHelloSZ(frame, { expectKey, ih, n, now, skewMs }) -> Promise<{ ok, reason }>. */
export async function verifyHelloSZ (frame, { expectKey, ih, n, now = Date.now(), skewMs = SKEW_MS } = {}) {
  if (!frame || frame.t !== 'hello' || typeof frame.key !== 'string' || typeof frame.sig !== 'string' || !isAt(frame.at)) return { ok: false, reason: 'shape' }
  if (!expectKey || frame.key !== expectKey) return { ok: false, reason: 'key' }
  if (frame.ih !== ih || !IH_RE.test(String(frame.ih))) return { ok: false, reason: 'ih' }
  if (frame.n !== n || !isNonce(frame.n)) return { ok: false, reason: 'nonce' }
  if (Math.abs(now - frame.at) > skewMs) return { ok: false, reason: 'skew' }
  const ok = await verify(frame.key, helloBytes(frame.ih, frame.n, frame.at), frame.sig)
  return ok ? { ok: true, reason: null } : { ok: false, reason: 'sig' }
}

/** verifyReceiptSZ(frame, { expectKey, ih, now, skewMs }) -> Promise<{ ok, reason }>. */
export async function verifyReceiptSZ (frame, { expectKey, ih, now = Date.now(), skewMs = SKEW_MS } = {}) {
  if (!frame || frame.t !== 'rcpt' || typeof frame.key !== 'string' || typeof frame.sig !== 'string' || !isAt(frame.at) || !Number.isSafeInteger(frame.total) || frame.total < 0) return { ok: false, reason: 'shape' }
  if (!expectKey || frame.key !== expectKey) return { ok: false, reason: 'key' }
  if (frame.ih !== ih || !IH_RE.test(String(frame.ih))) return { ok: false, reason: 'ih' }
  if (Math.abs(now - frame.at) > skewMs) return { ok: false, reason: 'skew' }
  const ok = await verify(frame.key, receiptBytes(frame.ih, frame.total, frame.at), frame.sig)
  return ok ? { ok: true, reason: null } : { ok: false, reason: 'sig' }
}

/**
 * verifyStatusSZ(obj, { expectKey, now, maxAgeMs, site }) -> Promise<{ ok, reason, age, has(ih) }>: a heartbeat
 * { v: 1, t: 'mw-pin-status', key, site, at, items, monthBytes, monthCap, sig } signed by the pin key, at most
 * maxAgeMs old (and not more than the skew window in the future), at most 4,096 hashed items, never an infohash.
 */
export async function verifyStatusSZ (obj, { expectKey, now = Date.now(), maxAgeMs = HEARTBEAT_MAX_AGE_MS, site = null } = {}) {
  const none = { ok: false, reason: 'shape', age: null, has: () => false }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj.v !== 1 || obj.t !== 'mw-pin-status' || typeof obj.key !== 'string' || typeof obj.sig !== 'string' || !isAt(obj.at)) return none
  if (!Array.isArray(obj.items) || obj.items.length > HEARTBEAT_MAX_ITEMS) return Object.assign({}, none, { reason: 'items' })
  for (const it of obj.items) {
    if (typeof it !== 'string' || !B64URL_RE.test(it) || it.length !== 22) return Object.assign({}, none, { reason: IH_RE.test(String(it)) ? 'cleartext' : 'items' })
  }
  if (!expectKey || obj.key !== expectKey) return Object.assign({}, none, { reason: 'key' })
  if (site !== null && site !== undefined && obj.site !== site) return Object.assign({}, none, { reason: 'site' })
  const age = now - obj.at
  if (age > maxAgeMs || -age > SKEW_MS) return Object.assign({}, none, { reason: 'age', age })
  let ok = false
  try { ok = await verify(obj.key, statusBytes(obj), obj.sig) } catch (_) { ok = false }
  if (!ok) return Object.assign({}, none, { reason: 'sig', age })
  const items = new Set(obj.items)
  return { ok: true, reason: null, age, has: (ih) => items.has(statusItem(ih)) }
}

/** The SZ 3.1.6 codec (verifiers are async; byte builders are pure). */
export const SZ_CODEC = Object.freeze({ helloBytes, receiptBytes, verifyHello: verifyHelloSZ, verifyReceipt: verifyReceiptSZ, verifyStatus: verifyStatusSZ, source: 'pinwire' })

let PIN_MODULES = null
/** loadPinCodec() -> Promise<codec>: lane pin-node's src/pin/frames.js and heartbeat.js when they load, else SZ_CODEC per function. */
export function loadPinCodec () {
  if (!PIN_MODULES) {
    PIN_MODULES = Promise.all([
      import('../pin/frames.js').catch(() => null),
      import('../pin/heartbeat.js').catch(() => null)
    ]).then(([f, h]) => {
      const pick = (mod, name) => (mod && typeof mod[name] === 'function' ? mod[name] : SZ_CODEC[name])
      const own = !!(f && typeof f.verifyHello === 'function' && typeof f.verifyReceipt === 'function')
      return Object.freeze({
        helloBytes: pick(f, 'helloBytes'),
        receiptBytes: pick(f, 'receiptBytes'),
        verifyHello: pick(f, 'verifyHello'),
        verifyReceipt: pick(f, 'verifyReceipt'),
        verifyStatus: pick(h, 'verifyStatus'),
        source: own ? 'src/pin' : 'pinwire'
      })
    })
  }
  return PIN_MODULES
}

function toBytes (buf) {
  if (buf instanceof Uint8Array) return buf
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf)
  if (buf && ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  return null
}

function advertises (handshake, name) {
  const m = handshake && handshake.m
  return !!(m && typeof m === 'object' && m[name] !== undefined && m[name] !== null && Number(m[name]) > 0)
}

function sigOf (r) {
  if (typeof r === 'string') return r
  if (r && typeof r === 'object') return typeof r.sig === 'string' ? r.sig : (typeof r.signature === 'string' ? r.signature : null)
  return null
}

function keyOf (r) {
  if (typeof r === 'string') return r
  if (r && typeof r === 'object' && typeof r.key === 'string') return r.key
  return null
}

function bitsHeld (wire, pieces) {
  const pp = wire && wire.peerPieces
  if (!pp || typeof pp.get !== 'function' || !(pieces > 0)) return 0
  let n = 0
  for (let i = 0; i < pieces; i++) { try { if (pp.get(i)) n++ } catch (_) { /* a broken bitfield */ } }
  return n
}

/**
 * PinWire({ tm, pinKey, win, fetch, now, random, codec, site, log }): one per page.
 *   tm      the TorrentManager (registerWireExtension, anchorWire, ignoreWire; optional setPinSource, notePin,
 *           localState, addEventListener('evidence'))
 *   pinKey  _mw.cfg.pin: a 'p256:' key string or a function returning it (read on every use; null = no pin)
 *   win     the window (the responder bridge is win.__mwPinCall in the top frame only)
 *   fetch   for the heartbeat; codec: a codec object or a Promise of one (default loadPinCodec())
 */
export class PinWire {
  constructor ({ tm = null, pinKey = null, win = null, fetch: fetchImpl = null, now = () => Date.now(), random = null, codec = null, site = null, log = null } = {}) {
    this.tm = tm
    this._pinKey = pinKey
    this._win = win
    this._fetch = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null)
    this._now = typeof now === 'function' ? now : () => Date.now()
    this._random = typeof random === 'function' ? random : (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))
    this._site = site
    this._log = typeof log === 'function' ? log : noop
    this._codec = null
    this._codecReady = Promise.resolve(codec || loadPinCodec()).then((c) => { this._codec = c || SZ_CODEC; return this._codec }, () => { this._codec = SZ_CODEC; return SZ_CODEC })
    this._wires = new Map() // wire -> state
    this._receipts = new Map() // ih -> { key, ih, total, at, receivedAt }
    this._hb = null
    this._hbFetchedAt = -Infinity
    this._hbPending = null
    this._listeners = new Map()
    this._off = null
    this._offEvidence = null
    this._responder = false
    this._responderKey = null
    this._responderCheck = null
    this.attached = false
  }

  get key () {
    let k = null
    try { k = typeof this._pinKey === 'function' ? this._pinKey() : this._pinKey } catch (_) { k = null }
    return typeof k === 'string' && k.length ? k : null
  }

  /** True when this page is the site's pin node (the bridge answered 'pin.key' with _mw.cfg.pin). */
  get responder () { return this._responder && this._responderKey !== null && this._responderKey === this.key }

  /** Resolves once the codec is loaded and the responder check ran (tests and diagnostics). */
  get ready () { return Promise.all([this._codecReady, this._responderCheck || Promise.resolve()]).then(() => this) }

  on (event, fn) {
    if (typeof fn !== 'function') return noop
    if (!this._listeners.has(event)) this._listeners.set(event, new Set())
    this._listeners.get(event).add(fn)
    return () => { const s = this._listeners.get(event); if (s) s.delete(fn) }
  }

  _emit (event, data) {
    const s = this._listeners.get(event)
    if (!s) return
    for (const fn of Array.from(s)) { try { fn(data) } catch (_) { /* a listener's problem */ } }
  }

  /** attach(tm?) -> this: registers mw_pin1 on 'site' and 'file' wires and becomes the manager's pin source. */
  attach (tm = this.tm) {
    if (this.attached) return this
    this.tm = tm
    if (!tm || typeof tm.registerWireExtension !== 'function') throw new TypeError('PinWire.attach needs a TorrentManager with registerWireExtension')
    const self = this
    this._off = tm.registerWireExtension(EXT_NAME, {
      onWire (wire, kind, info) { self._useOnWire(wire, kind, info || {}) }
    }, { swarms: ['site', 'file'] })
    if (typeof tm.setPinSource === 'function') tm.setPinSource(this)
    if (typeof tm.addEventListener === 'function') {
      const onEvidence = (e) => {
        const d = e && e.detail
        if (d && d.infoHash && d.evidence && d.evidence.local) this._receiptsFor(d.infoHash)
      }
      tm.addEventListener('evidence', onEvidence)
      this._offEvidence = () => { try { tm.removeEventListener('evidence', onEvidence) } catch (_) { /* gone */ } }
    }
    this.attached = true
    this.refresh()
    return this
  }

  detach () {
    if (this._off) { try { this._off() } catch (_) { /* gone */ } this._off = null }
    if (this._offEvidence) { this._offEvidence(); this._offEvidence = null }
    if (this.tm && typeof this.tm.setPinSource === 'function' && this.tm._pinSource === this) this.tm.setPinSource(null)
    this.attached = false
    this._wires.clear()
  }

  /** refresh(): _mw.cfg.pin may have changed: check the responder bridge again and challenge ready wires. */
  refresh () {
    this._responderCheck = this._checkResponder()
    return this._responderCheck.then(() => {
      for (const st of this._wires.values()) this._challenge(st)
      for (const ih of new Set(Array.from(this._wires.values()).map((s) => s.ih))) this._receiptsFor(ih)
    })
  }

  _bridge () {
    const w = this._win
    try {
      if (!w || w.top !== w || typeof w.__mwPinCall !== 'function') return null
      return (op, arg) => w.__mwPinCall(op, arg)
    } catch (_) { return null } // a cross-origin top frame
  }

  async _checkResponder () {
    const call = this._bridge()
    const key = this.key
    if (!call || !key) { this._responder = false; this._responderKey = null; return false }
    try {
      const got = keyOf(await call('pin.key'))
      this._responderKey = got
      this._responder = got === key
    } catch (_) {
      this._responder = false
      this._responderKey = null
    }
    return this._responder
  }

  // ---- wires ------------------------------------------------------------------------------------

  _useOnWire (wire, kind, info) {
    if (!wire || wire.type === 'webSeed' || wire.destroyed || this._wires.has(wire) || typeof wire.use !== 'function') return
    const ih = typeof info.infoHash === 'string' ? info.infoHash.toLowerCase() : (wire.__mwInfoHash || null)
    const self = this
    const st = { wire, kind, ih, ready: false, nonce: null, authed: null, answered: false, remoteN: null, rcptSent: false, frames: 0, strikes: 0, queue: Promise.resolve() }
    class MwPinExtension {
      constructor (w) { this.wire = w }
      onHandshake () {}
      onExtendedHandshake (h) { if (advertises(h, EXT_NAME)) self._onReady(st) }
      onMessage (buf) { return self._onMessage(st, buf) }
    }
    MwPinExtension.prototype.name = EXT_NAME
    const late = info.late === true || wire._extendedHandshakeSent === true
    try { wire.use(MwPinExtension) } catch (_) { return }
    this._wires.set(wire, st)
    if (typeof wire.once === 'function') wire.once('close', () => { this._wires.delete(wire) })
    if (late) {
      if (typeof wire._sendExtendedHandshake === 'function') { try { wire._sendExtendedHandshake() } catch (_) { /* closing */ } }
      const mapping = wire.peerExtendedMapping
      if (mapping && mapping[EXT_NAME]) this._onReady(st)
    }
  }

  _send (st, frame) {
    const bytes = encodeFrame(frame)
    if (!bytes || st.wire.destroyed || typeof st.wire.extended !== 'function') return false
    try { st.wire.extended(EXT_NAME, bytes); return true } catch (_) { return false }
  }

  _onReady (st) {
    if (st.ready) return
    st.ready = true
    this._challenge(st)
  }

  _challenge (st) {
    if (!st.ready || st.nonce !== null || !st.ih || !this.key || st.wire.destroyed) return
    st.nonce = b64url.encode(this._random(NONCE_BYTES))
    this._send(st, { t: 'chal', n: st.nonce })
  }

  _strike (st, reason) {
    st.strikes++
    this._emit('warning', { code: 'pin-frame', reason, infoHash: st.ih })
    if (st.strikes >= STRIKES && this.tm && typeof this.tm.ignoreWire === 'function') this.tm.ignoreWire(st.wire, 'mw_pin1:' + reason)
  }

  _onMessage (st, buf) {
    if (st.wire.destroyed) return undefined
    if (++st.frames > MAX_FRAMES_PER_WIRE) return undefined
    const bytes = toBytes(buf)
    if (!bytes || bytes.length > FRAME_MAX) { this._strike(st, 'size'); return undefined }
    const frame = decodeFrame(bytes)
    if (!frame) { this._strike(st, 'malformed'); return undefined }
    st.queue = st.queue.then(() => this._handle(st, frame)).then(undefined, () => undefined)
    return st.queue
  }

  async _handle (st, frame) {
    const codec = this._codec || await this._codecReady
    if (frame.t === 'chal') return this._answer(st, frame)
    if (frame.t === 'hello') {
      if (st.nonce === null || st.authed) return undefined
      const key = this.key
      const r = await codec.verifyHello(frame, { expectKey: key, ih: st.ih, n: st.nonce, now: this._now(), skewMs: SKEW_MS })
      if (!r || !r.ok) { this._strike(st, 'hello-' + ((r && r.reason) || 'bad')); return undefined }
      st.authed = { key, at: frame.at }
      try { st.wire.__mwPin = true } catch (_) { /* frozen */ }
      if (this.tm && typeof this.tm.anchorWire === 'function') this.tm.anchorWire(st.wire)
      this._emit('pin-wire', { ih: st.ih, wire: st.wire })
      this._notify(st.ih)
      return undefined
    }
    if (frame.t === 'rcpt') {
      if (!st.authed) return undefined // a receipt counts only on a wire the pin authenticated first
      const key = this.key
      const local = this._localState(st.ih)
      const total = local && Number.isSafeInteger(local.length) && local.length > 0 ? local.length : null
      if (total !== null && frame.total !== total) { this._strike(st, 'rcpt-total'); return undefined }
      const r = await codec.verifyReceipt(frame, { expectKey: key, ih: st.ih, now: this._now(), skewMs: SKEW_MS, total })
      if (!r || !r.ok) { this._strike(st, 'rcpt-' + ((r && r.reason) || 'bad')); return undefined }
      const rec = { key, ih: st.ih, total: frame.total, at: frame.at, receivedAt: this._now() }
      const prev = this._receipts.get(st.ih)
      if (!prev || prev.at < rec.at) this._receipts.set(st.ih, rec)
      this._emit('receipt', { ih: st.ih, receipt: rec })
      this._notify(st.ih)
      return undefined
    }
    return undefined // other types: a later version's frames, ignored
  }

  _notify (ih) {
    if (this.tm && typeof this.tm.notePin === 'function') { try { this.tm.notePin(ih) } catch (_) { /* the manager's problem */ } }
  }

  _localState (ih) {
    if (!this.tm || typeof this.tm.localState !== 'function') return null
    try { return this.tm.localState(ih) } catch (_) { return null }
  }

  // ---- responder (the pin's own page) -------------------------------------------------------------

  async _sign (bytes) {
    const call = this._bridge()
    if (!call) return null
    try { return sigOf(await call('pin.sign', b64url.encode(bytes))) } catch (_) { return null }
  }

  async _answer (st, frame) {
    if (st.answered || !isNonce(frame.n)) return undefined
    if (this._responderCheck) await this._responderCheck
    if (!this.responder || !st.ih) return undefined
    st.answered = true
    st.remoteN = frame.n
    const codec = this._codec || SZ_CODEC
    const at = this._now()
    let bytes
    try { bytes = codec.helloBytes(st.ih, frame.n, at) } catch (_) { return undefined } // the codec refuses bad input
    const sig = await this._sign(bytes)
    if (!sig) return undefined
    this._send(st, { t: 'hello', key: this.key, ih: st.ih, n: frame.n, at, sig })
    return this._receipt(st)
  }

  async _receipt (st) {
    if (!this.responder || !st.answered || st.rcptSent || st.wire.destroyed) return undefined
    const local = this._localState(st.ih)
    if (!local || local.complete !== true || !Number.isSafeInteger(local.length) || local.length <= 0) return undefined
    st.rcptSent = true
    const codec = this._codec || SZ_CODEC
    const at = this._now()
    let bytes
    try { bytes = codec.receiptBytes(st.ih, local.length, at) } catch (_) { st.rcptSent = false; return undefined }
    const sig = await this._sign(bytes)
    if (!sig) { st.rcptSent = false; return undefined }
    this._send(st, { t: 'rcpt', key: this.key, ih: st.ih, total: local.length, at, sig })
    return undefined
  }

  _receiptsFor (ih) {
    if (!this.responder) return
    const id = String(ih).toLowerCase()
    for (const st of this._wires.values()) if (st.ih === id) this._receipt(st).catch(() => undefined)
  }

  // ---- evidence ------------------------------------------------------------------------------------

  /** isPinWire(wire) -> true when the wire answered our chal with a valid hello from _mw.cfg.pin. */
  isPinWire (wire) {
    const st = this._wires.get(wire)
    return !!(st && st.authed && st.authed.key === this.key && !wire.destroyed)
  }

  /** pinWires(ih?) -> authenticated open wires (of one infohash, or all). */
  pinWires (ih = null) {
    const id = ih ? String(ih).toLowerCase() : null
    const out = []
    for (const [w, st] of this._wires) if (this.isPinWire(w) && (!id || st.ih === id)) out.push(w)
    return out
  }

  /** pinProgress(ih, pieces) -> 0..100: the share of pieces the best authenticated pin wire reports, or null. */
  pinProgress (ih, pieces = null) {
    let n = Number(pieces)
    if (!(n > 0)) { const l = this._localState(ih); n = l && l.pieces > 0 ? l.pieces : 0 }
    if (!(n > 0)) return null
    let best = null
    for (const w of this.pinWires(ih)) best = Math.max(best === null ? 0 : best, Math.floor(bitsHeld(w, n) * 100 / n))
    return best
  }

  /** receipt(ih) -> { key, ih, total, at, receivedAt } from the current pin key, or null. */
  receipt (ih) {
    const r = this._receipts.get(String(ih).toLowerCase())
    return r && r.key === this.key ? r : null
  }

  /** heartbeat() -> the last verified heartbeat { at, key, has(ih), monthBytes, monthCap, checkedAt } of the current key, or null. */
  heartbeat () {
    return this._hb && this._hb.key === this.key ? this._hb : null
  }

  /** evidence(ih, now) -> { configured, receipt, heartbeat }: the pin argument of availability.evidence(). */
  evidence (ih, now = this._now()) {
    const id = String(ih).toLowerCase()
    const hb = this.heartbeat()
    return {
      configured: this.key !== null,
      receipt: this.receipt(id),
      heartbeat: hb ? { at: hb.at, has: hb.has(id) } : null,
      checkedAt: now
    }
  }

  /**
   * fetchHeartbeat(wsBase, { force }) -> Promise<heartbeat | null>: <ws base>/pin-status.json, at most every 10 minutes
   * (force skips the wait), read with a 256 KiB cap, kept only when verifyStatus accepts it for _mw.cfg.pin.
   */
  fetchHeartbeat (wsBase, { force = false } = {}) {
    const key = this.key
    if (!key || !this._fetch || typeof wsBase !== 'string' || !wsBase) return Promise.resolve(this.heartbeat())
    const now = this._now()
    if (!force && now - this._hbFetchedAt < HEARTBEAT_EVERY_MS) return this._hbPending || Promise.resolve(this.heartbeat())
    if (this._hbPending) return this._hbPending
    this._hbFetchedAt = now
    this._hbPending = (async () => {
      try {
        const codec = await this._codecReady
        const r = await fetchHeartbeat(wsBase, { pinKey: key, fetch: this._fetch, now: () => this._now(), site: this._site, codec })
        if (!r.ok) { this._emit('warning', { code: 'pin-heartbeat', reason: r.reason }); return this.heartbeat() }
        this._hb = r.heartbeat
        this._emit('heartbeat', { at: r.heartbeat.at })
        if (this.tm && typeof this.tm.notePin === 'function') { try { this.tm.notePin(null) } catch (_) { /* the manager's problem */ } }
        return this._hb
      } finally {
        this._hbPending = null
      }
    })()
    return this._hbPending
  }
}

/**
 * fetchHeartbeat(wsBase, { pinKey, fetch, now, site, codec }) -> Promise<{ ok, reason, heartbeat }>: one read of
 * <ws base>/pin-status.json (cache: no-store, no credentials, at most 256 KiB), verified for pinKey (_mw.cfg.pin) and
 * the site's ledger id, at most 15 minutes old. heartbeat = { at, key, has(ih), monthBytes, monthCap, checkedAt }. Never
 * throws; reasons: 'no-key', 'no-fetch', 'bad-url', 'http-<status>', 'too-large', 'json', 'unreachable' and the
 * codec's. PinWire.fetchHeartbeat() adds the 10 minute interval and the cache.
 */
export async function fetchHeartbeat (wsBase, { pinKey = null, fetch: fetchImpl = null, now = () => Date.now(), site = null, codec = null } = {}) {
  const fail = (reason) => ({ ok: false, reason, heartbeat: null })
  const key = typeof pinKey === 'function' ? pinKey() : pinKey
  if (typeof key !== 'string' || !key) return fail('no-key')
  const f = fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null)
  if (!f) return fail('no-fetch')
  const clock = typeof now === 'function' ? now : () => Date.now()
  let url
  try { url = new URL('pin-status.json', String(wsBase).endsWith('/') ? String(wsBase) : String(wsBase) + '/').href } catch (_) { return fail('bad-url') }
  try {
    const res = await f(url, { method: 'GET', cache: 'no-store', credentials: 'omit' })
    if (!res || !res.ok) return fail('http-' + (res ? res.status : 'none'))
    const bytes = await readCappedBody(res, HEARTBEAT_MAX_BYTES)
    if (!bytes) return fail('too-large')
    let obj
    try { obj = JSON.parse(utf8.decode(bytes)) } catch (_) { return fail('json') }
    const c = codec || await loadPinCodec()
    const v = await c.verifyStatus(obj, { expectKey: key, now: clock(), maxAgeMs: HEARTBEAT_MAX_AGE_MS, site })
    if (!v || !v.ok) return fail((v && v.reason) || 'bad')
    // The items are covered by the signature just checked; membership is computed here (SZ 3.1.6 hashing, sync), so a
    // codec whose has() is asynchronous cannot turn a listed item into "not listed".
    const items = new Set(Array.isArray(obj.items) ? obj.items : [])
    const has = (ih) => items.has(statusItem(ih))
    return { ok: true, reason: null, heartbeat: { at: obj.at, key, has, monthBytes: Number.isFinite(obj.monthBytes) ? obj.monthBytes : null, monthCap: Number.isFinite(obj.monthCap) ? obj.monthCap : null, checkedAt: clock() } }
  } catch (_) {
    return fail('unreachable')
  }
}

/** createPinWire(opts) -> PinWire (not attached: call attach()). */
export function createPinWire (opts = {}) {
  return new PinWire(opts)
}

/**
 * createPinPageHost({ tm, storeClass, announce, torrentFiles, isDenied }) -> { start, stop, sweep, status }: the page side of the pin node, for
 * window.__mwPinHost in the pin's own page (tools/pin.mjs pageSeeder calls it; docs/deviations/pin-node.md):
 *   start({ ih, name, size, state, sha256 }) -> 'seeding' | 'denied' | 'bad-ih' | 'error'   join and keep that file torrent (lane K; the
 *       bytes stay in the profile's store: storeClass(ih) is an abstract-chunk-store class, retained across rebuilds)
 *   stop(ih) -> 'stopped' | 'not-held'                                  leave the swarm, keep the bytes
 *   status() -> { files: [{ ih, uploaded, complete }] }                 uploaded: piece bytes sent since start (cumulative)
 * announce() gives the site's own tracker list. The page never opens or renders a pinned file (R 2.8.6).
 * torrentFiles ({ get(ih) -> bytes | null, put(ih, bytes) }, optional) keeps each item's .torrent (its info dictionary)
 * next to the bytes, so a pin that starts again while nobody else who has the item is online still seeds it (rows-media
 * D-2); addFileTorrent checks the kept bytes against the infohash, and a copy that does not match is not used.
 * isDenied(id) (optional; review round R 5.3, MAL53-3): an item the site's ledger denies (_deny/) by its infohash or by the
 * SHA-256 its pin request declared (meta.sha256, meta.sha256Actual; 64 hex) is never joined: 'denied'. A held item is checked
 * again on every start() and by sweep(), which status() runs in the background (tools/pin.mjs reads status() every two
 * seconds): a later _deny/ entry makes the host leave that swarm and forget the item, so status() stops listing it.
 *   sweep() -> Promise<[ih]>   the held items it left because the ledger now denies them
 * discard(ih) (optional): called after the host leaves an item because the ledger denies it, so the page can delete the
 * item's bytes and kept .torrent from the profile's store (a plain stop() keeps them).
 */
export function createPinPageHost ({ tm, storeClass, announce = () => [], torrentFiles = null, isDenied = null, discard = null } = {}) {
  if (!tm || typeof tm.addFileTorrent !== 'function') throw new TypeError('createPinPageHost needs a TorrentManager')
  if (typeof storeClass !== 'function') throw new TypeError('createPinPageHost needs storeClass(ih)')
  const held = new Map() // ih -> FileTorrentHandle
  const idsOf = new Map() // ih -> [ih, declared SHA-256 ...]: what a _deny/ entry may name (review round MAL53-3)
  const denied = async (ids) => {
    if (typeof isDenied !== 'function') return false
    for (const id of ids) {
      try { if (await isDenied(id)) return true } catch (_) { /* a failed check is not a deny */ }
    }
    return false
  }
  const leave = async (ih, deny = false) => {
    const h = held.get(ih)
    held.delete(ih)
    idsOf.delete(ih)
    if (h) { try { await h.leave({ now: true }) } catch (_) { /* gone */ } }
    if (deny && typeof discard === 'function') { try { await discard(ih) } catch (_) { /* the swarm is left either way */ } }
  }
  const runSweep = async () => {
    const left = []
    if (typeof isDenied !== 'function') return left
    for (const ih of Array.from(held.keys())) {
      if (!held.has(ih)) continue
      if (await denied(idsOf.get(ih) || [ih])) { await leave(ih, true); left.push(ih) }
    }
    return left
  }
  // Sweeps run one after another; each sweep() call checks again after the one before it, so a deny that lands mid-sweep is seen.
  let chain = Promise.resolve()
  const sweep = () => (chain = chain.then(runSweep, runSweep))
  let background = false // status() starts at most one sweep at a time
  return {
    async start (meta = {}) {
      const ih = typeof (meta && meta.ih) === 'string' ? meta.ih.toLowerCase() : ''
      if (!IH_RE.test(ih)) return 'bad-ih'
      const ids = [ih]
      for (const k of ['sha256', 'sha256Actual']) {
        const v = meta && typeof meta[k] === 'string' ? meta[k].toLowerCase() : ''
        if (/^[0-9a-f]{64}$/.test(v) && ids.indexOf(v) < 0) ids.push(v)
      }
      const live = held.get(ih)
      if (await denied(Array.from(new Set(ids.concat(idsOf.get(ih) || []))))) {
        // MAL53-3: a later _deny/ entry also ends an item this host already holds.
        if (live) await leave(ih, true)
        return 'denied'
      }
      if (live && !live.left) {
        idsOf.set(ih, Array.from(new Set((idsOf.get(ih) || [ih]).concat(ids))))
        return 'seeding'
      }
      try {
        const list = typeof announce === 'function' ? announce() : announce
        const opts = { infoHash: ih, store: storeClass(ih), announce: Array.isArray(list) ? list : [], retain: true, lane: 'K' }
        let kept = null
        if (torrentFiles && typeof torrentFiles.get === 'function') {
          try { kept = await torrentFiles.get(ih) } catch (_) { kept = null }
        }
        let h = null
        if (kept && kept.length) {
          try { h = await tm.addFileTorrent(Object.assign({}, opts, { torrentFile: kept })) } catch (_) { h = null } // not this item's: by infohash
        }
        if (!h) h = await tm.addFileTorrent(opts)
        held.set(ih, h)
        idsOf.set(ih, ids)
        if (!(kept && kept.length) && torrentFiles && typeof torrentFiles.put === 'function' && typeof h.metadata === 'function') {
          Promise.resolve().then(() => h.metadata()).then((bytes) => (bytes && bytes.length ? torrentFiles.put(ih, bytes) : null)).catch(() => {})
        }
        return 'seeding'
      } catch (_) {
        return 'error'
      }
    },
    async stop (ih) {
      const id = typeof ih === 'string' ? ih.toLowerCase() : ''
      if (!held.has(id)) return 'not-held'
      await leave(id)
      return 'stopped'
    },
    sweep,
    status () {
      if (typeof isDenied === 'function' && held.size && !background) {
        background = true
        sweep().catch(() => {}).then(() => { background = false })
      }
      const files = []
      for (const [ih, h] of held) files.push({ ih, uploaded: Number(h.uploaded) || 0, complete: h.done === true })
      return { files }
    }
  }
}
