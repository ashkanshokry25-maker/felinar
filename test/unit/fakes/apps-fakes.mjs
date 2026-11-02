// test/unit/fakes/apps-fakes.mjs: fakes for the apps on the door page (reusable by the unit tests of the service, the view and the rendezvous).
//
//   FakeRendezvous   the pair protocol (ARCHITECTURE 15.21, mw-pair-v1) in memory: codes, knocks, accept, reject, cancel, close, rooms,
//                    socket loss, expiry, lane allowance. Records every frame it was sent (rdv.raw) so a test can prove what
//                    the rendezvous never saw. rdv.socketClass() is a WebSocket stand-in that talks to it.
//   CoreRendezvous   the same surface on top of the REAL pairing core of the rendezvous (deploy/rtc-worker/pair.js createPairing),
//                    so a test can run the client against the server's own state machine (null when pair.js is not there).
//   FakeLink         src/loader/apps-link.js PairLink on a FakeSocket of a FakeRendezvous (the real client code, a fake server);
//                    link.drop() loses the socket from the server's side, link.rdv is the server.
//   FakeNetwork      the swarms: two managers that join the same lane (and are allowed by the rendezvous, when one is given)
//                    get a wire pair; net.frames records every extended frame (what an eavesdropper on a wire sees).
//   FakeTm           the part of TorrentManager the apps use: registerWireExtension, joinLane (-> FakeLane), ignoreWire,
//                    setIceServers, EventTarget. tm.joined logs every joinLane call (nothing may be there before approval).
//   FakeWire         a bittorrent-protocol wire stand-in with use(), extended(), the extended handshake, destroy().
//   FakeIdentity     { info(), keys(), state(), onChange(fn) } with signIn(person) and signOut().
//   makePerson(name) real WebCrypto keys: { name, keys: { pub, sign, chat: { pub, ecdh } } }.
//   makeWorld()      a clock, a rendezvous, a network and make(name) -> { apps, person, identity, tm, link, ... } for each person.
//   FakeApps         a stand-in for the service (same method names, records calls, settable state) for UI tests.
//   until, flush, settle: small helpers for the real asynchronous WebCrypto work next to a fake clock.
//
// Nothing here opens a socket or a port. No names, hosts or addresses of real deployments.

import { generateKeyPair, exportPublicKey, sign } from '../../../src/chain/crypto.js'
import { generateChatKey } from '../../../src/chat/seal.js'
import { PairLink } from '../../../src/loader/apps-link.js'
import { createApps } from '../../../src/loader/apps.js'
import { isChannel, EXT_NAME } from '../../../src/loader/apps-crypto.js'
import { createClock } from '../dropin-fake-timers.mjs'

const enc = new TextEncoder()
const LANE_RE = /^[0-9a-f]{40}$/

export const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)) }
export const flush = settle

/** until(fn, what, ms): polls fn() in real time until it is truthy and returns it; past ms it throws and names what it waited for. */
export async function until (fn, what = 'a condition', ms = 8000) {
  const end = Date.now() + ms
  for (;;) {
    let v
    try { v = fn() } catch (_) { v = null }
    if (v) return v
    if (Date.now() > end) throw new Error('timed out after ' + ms + ' ms waiting for ' + what)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

function hex40 (rand) {
  let s = ''
  for (let i = 0; i < 40; i++) s += '0123456789abcdef'[Math.floor(rand() * 16)]
  return s
}

function token (rand) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'
  let s = ''
  for (let i = 0; i < 16; i++) s += A[Math.floor(rand() * 64)]
  return s
}

// ---------------------------------------------------------------------------------------------
// The rendezvous
// ---------------------------------------------------------------------------------------------

export class FakeRendezvous {
  constructor ({ now = () => Date.now(), random = Math.random, knockPerMin = 10, pendingPerChannel = 16 } = {}) {
    this.now = now
    this.rand = random
    this.knockPerMin = knockPerMin
    this.pendingPerChannel = pendingPerChannel
    this.conns = new Set()
    this.sockets = new Set()
    this.channels = new Map() // channel -> { kind, conn, box, lane, knocks: Set }
    this.knocks = new Map() // knock -> { kind, channel, requester, box, at }
    this.lanes = new Map() // lane -> expiry ms (allowed for announces)
    this.raw = [] // every text frame received, as sent
    this.log = [] // { conn, action, channel }
    this.refuse = false // true: new sockets fail to open
    this.nextConn = 1
  }

  connect () {
    const conn = { id: this.nextConn++, deliver: null, closed: false, knockTimes: [] }
    this.conns.add(conn)
    return conn
  }

  isAllowed (lane) {
    const exp = this.lanes.get(lane)
    return exp !== undefined && exp > this.now()
  }

  _send (conn, obj) {
    if (!conn || conn.closed || !conn.deliver) return
    const text = JSON.stringify(obj)
    setImmediate(() => { if (!conn.closed && conn.deliver) conn.deliver(text) })
  }

  handleText (conn, text) {
    this.raw.push(text)
    let m
    try { m = JSON.parse(text) } catch (_) { return }
    if (enc.encode(text).length > 8192) {
      this._send(conn, { action: m && m.action ? m.action : 'error', 'failure reason': 'message too large' })
      return
    }
    this.handle(conn, m)
  }

  handle (conn, m) {
    if (!m || typeof m !== 'object' || typeof m.action !== 'string') return
    const rid = typeof m.rid === 'string' && m.rid.length <= 16 ? m.rid : undefined
    const reply = (obj) => this._send(conn, rid ? Object.assign({}, obj, { rid }) : obj)
    const fail = (reason) => reply({ action: m.action, 'failure reason': reason })
    this.log.push({ conn: conn.id, action: m.action, channel: m.channel })
    if (m.v !== 1) return fail('bad version')
    const hit = /^(pair|room)-([a-z]+)$/.exec(m.action)
    if (!hit) return fail('invalid action')
    const kind = hit[1]
    const verb = hit[2]
    const boxOk = (b) => b && typeof b === 'object' && typeof b.iv === 'string' && typeof b.ct === 'string' && enc.encode(JSON.stringify({ iv: b.iv, ct: b.ct })).length <= 2048
    if (verb === 'open') {
      if (!isChannel(m.channel) || !boxOk(m.box)) return fail('box invalid')
      const taken = this.channels.get(m.channel)
      if (taken && taken.conn !== conn) return fail('channel taken')
      if (kind === 'pair') {
        for (const [ch, rec] of Array.from(this.channels)) if (rec.conn === conn && rec.kind === 'pair') this._release(ch, 'closed')
      } else {
        let n = 0
        for (const rec of this.channels.values()) if (rec.conn === conn && rec.kind === 'room') n++
        if (n >= 4 && !taken) return fail('too many codes')
        if (taken) this._release(m.channel, 'closed')
      }
      const lane = kind === 'room' ? hex40(this.rand) : null
      if (lane) this.lanes.set(lane, this.now() + 86400000)
      this.channels.set(m.channel, { kind, conn, box: { iv: m.box.iv, ct: m.box.ct }, lane, knocks: new Set() })
      return reply(kind === 'room' ? { action: 'room-open', channel: m.channel, lane } : { action: 'pair-open', channel: m.channel })
    }
    if (verb === 'knock') {
      const ch = this.channels.get(m.channel)
      if (!isChannel(m.channel) || !boxOk(m.box)) return fail('box invalid')
      if (!ch || ch.kind !== kind) return fail('unknown code')
      const t = this.now()
      conn.knockTimes = conn.knockTimes.filter((x) => t - x < 60000)
      if (conn.knockTimes.length >= this.knockPerMin || ch.knocks.size >= this.pendingPerChannel) return fail('too many requests')
      conn.knockTimes.push(t)
      const knock = token(this.rand)
      this.knocks.set(knock, { kind, channel: m.channel, requester: conn, box: { iv: m.box.iv, ct: m.box.ct }, at: t })
      ch.knocks.add(knock)
      reply({ action: kind + '-knock', knock })
      this._send(ch.conn, { action: kind + '-request', knock, channel: m.channel, box: { iv: m.box.iv, ct: m.box.ct } })
      return undefined
    }
    if (verb === 'accept' || verb === 'reject') {
      const k = this.knocks.get(m.knock)
      const ch = k ? this.channels.get(k.channel) : null
      if (!k || !ch || ch.conn !== conn || k.kind !== kind) return fail('unknown knock')
      if (verb === 'accept' && !(typeof m.proof === 'string' && /^[A-Za-z0-9_-]{86}$/.test(m.proof))) return fail('proof invalid')
      this.knocks.delete(m.knock)
      ch.knocks.delete(m.knock)
      if (verb === 'reject') {
        this._send(k.requester, { action: kind + '-rejected', knock: m.knock, reason: 'rejected' })
        return reply({ action: kind + '-reject', knock: m.knock })
      }
      const lane = kind === 'pair' ? hex40(this.rand) : ch.lane
      if (kind === 'pair') this.lanes.set(lane, this.now() + 86400000)
      this._send(k.requester, { action: kind + '-accepted', knock: m.knock, lane, channel: k.channel, box: ch.box, proof: m.proof })
      return reply(kind === 'pair' ? { action: 'pair-accepted', knock: m.knock, lane } : { action: 'room-accepted', knock: m.knock })
    }
    if (verb === 'cancel') {
      const k = this.knocks.get(m.knock)
      if (!k || k.requester !== conn) return undefined
      this.knocks.delete(m.knock)
      const ch = this.channels.get(k.channel)
      if (ch) {
        ch.knocks.delete(m.knock)
        this._send(ch.conn, { action: kind + '-cancelled', knock: m.knock })
      }
      return undefined
    }
    if (verb === 'close') {
      let target = null
      for (const [c, rec] of this.channels) if (rec.conn === conn && rec.kind === kind && (kind === 'pair' || c === m.channel)) target = c
      if (target) this._release(target, 'closed')
      return reply({ action: kind + '-close' })
    }
    return fail('invalid action')
  }

  _release (channel, reason) {
    const rec = this.channels.get(channel)
    if (!rec) return
    this.channels.delete(channel)
    for (const knock of Array.from(rec.knocks)) {
      const k = this.knocks.get(knock)
      this.knocks.delete(knock)
      if (k) this._send(k.requester, { action: k.kind + '-rejected', knock, reason })
    }
  }

  closeConn (conn) {
    if (conn.closed) return
    for (const [ch, rec] of Array.from(this.channels)) if (rec.conn === conn) this._release(ch, 'gone')
    for (const [knock, k] of Array.from(this.knocks)) {
      if (k.requester !== conn) continue
      this.knocks.delete(knock)
      const ch = this.channels.get(k.channel)
      if (ch) {
        ch.knocks.delete(knock)
        this._send(ch.conn, { action: k.kind + '-cancelled', knock })
      }
    }
    conn.closed = true
    this.conns.delete(conn)
  }

  /** expire(ms): knocks older than ms end with reason 'expired' (the rendezvous keeps a knock for 10 minutes). */
  expire (ms = 600000) {
    const t = this.now()
    for (const [knock, k] of Array.from(this.knocks)) {
      if (t - k.at < ms) continue
      this.knocks.delete(knock)
      const ch = this.channels.get(k.channel)
      if (ch) ch.knocks.delete(knock)
      this._send(k.requester, { action: k.kind + '-rejected', knock, reason: 'expired' })
    }
  }

  /** dropAll(): the server loses every socket (a restart). */
  dropAll () {
    for (const s of Array.from(this.sockets)) s._serverClose()
  }

  /** counts() -> { codes, knocks, lanes } (codes is also given as channels). */
  counts () {
    return { codes: this.channels.size, channels: this.channels.size, knocks: this.knocks.size, lanes: this.lanes.size }
  }

  /** socketClass() -> a class that stands in for WebSocket and talks to this rendezvous. */
  socketClass () {
    const rdv = this
    return class FakeSocket {
      constructor (url) {
        this.url = url
        this.readyState = 0
        this.sent = []
        this._l = { open: [], message: [], close: [], error: [] }
        this.conn = rdv.connect()
        this.conn.deliver = (text) => this._emit('message', { data: text })
        rdv.sockets.add(this)
        setImmediate(() => {
          if (this.readyState !== 0) return
          if (rdv.refuse) {
            this.readyState = 3
            rdv.closeConn(this.conn)
            rdv.sockets.delete(this)
            this._emit('error', {})
            this._emit('close', {})
            return
          }
          this.readyState = 1
          this._emit('open', {})
        })
      }

      addEventListener (type, fn) { this._l[type].push(fn) }

      _emit (type, ev) { for (const fn of this._l[type].slice()) fn(ev) }

      send (text) {
        if (this.readyState !== 1) throw new Error('socket is not open')
        this.sent.push(text)
        rdv.handleText(this.conn, text)
      }

      close () {
        if (this.readyState >= 2) return
        this.readyState = 2
        rdv.closeConn(this.conn)
        rdv.sockets.delete(this)
        setImmediate(() => { this.readyState = 3; this._emit('close', {}) })
      }

      _serverClose () {
        if (this.readyState === 3) return
        this.readyState = 3
        rdv.closeConn(this.conn)
        rdv.sockets.delete(this)
        this._emit('close', {})
      }
    }
  }
}

// The real pairing core, when pair.js is there (lane pair-core). Tests that need it import it through this dynamic import so a
// missing file skips the interop tests instead of breaking the whole file.
let realCore = null
try {
  realCore = await import('../../../deploy/rtc-worker/pair.js')
} catch (_) {
  realCore = null
}

/** CoreRendezvous: a FakeRendezvous whose protocol is the real createPairing state machine. null when pair.js cannot be loaded. */
export const CoreRendezvous = realCore
  ? class CoreRendezvous extends FakeRendezvous {
    constructor (opts = {}) {
      super(opts)
      this.core = realCore.createPairing({
        now: this.now,
        random: (n) => crypto.getRandomValues(new Uint8Array(n)),
        allowLane: (lane, exp) => { this.lanes.set(lane, exp); return true }
      })
    }

    handle (conn, m) {
      if (!m || typeof m !== 'object' || !realCore.isPairAction(m.action)) return
      this.log.push({ conn: conn.id, action: m.action, channel: m.channel })
      const out = this.core.message(conn, m)
      for (const [to, obj] of out.replies) this._send(to, obj)
    }

    closeConn (conn) {
      if (conn.closed) return
      for (const [to, obj] of this.core.close(conn)) this._send(to, obj)
      conn.closed = true
      this.conns.delete(conn)
    }

    /** expire(ms): the core's own sweep, run ms ahead of the clock (default: past the knock lifetime). */
    expire (ms = 600000) {
      for (const [to, obj] of this.core.sweep(this.now() + ms)) this._send(to, obj)
    }

    counts () {
      const st = this.core.stats()
      return { codes: st.codes, channels: st.codes, knocks: st.knocks, lanes: this.lanes.size }
    }
  }
  : null

/** FakeLink: the real PairLink client on a fake socket of a FakeRendezvous (drop() = the server loses this socket). */
export class FakeLink extends PairLink {
  constructor (rdv, opts = {}) {
    super(Object.assign({ url: 'wss://rendezvous.invalid/', WebSocketImpl: rdv.socketClass() }, opts))
    this.rdv = rdv
  }

  /** The server closes this link's socket; the client backs off and reconnects on its timers. */
  drop () {
    const ws = this._ws
    if (ws && typeof ws._serverClose === 'function') ws._serverClose()
  }
}

// ---------------------------------------------------------------------------------------------
// Managers, wires, swarms
// ---------------------------------------------------------------------------------------------

class Emitter {
  constructor () { this._l = new Map() }

  on (t, fn) {
    if (!this._l.has(t)) this._l.set(t, [])
    this._l.get(t).push(fn)
    return this
  }

  once (t, fn) {
    const w = (...a) => { this.removeListener(t, w); fn(...a) }
    return this.on(t, w)
  }

  removeListener (t, fn) {
    const l = this._l.get(t)
    if (l) {
      const i = l.indexOf(fn)
      if (i !== -1) l.splice(i, 1)
    }
    return this
  }

  emit (t, ...a) {
    for (const fn of (this._l.get(t) || []).slice()) fn(...a)
    return true
  }
}

/** A bittorrent-protocol wire stand-in: use(), extended(), the extended handshake, destroy(). */
export class FakeWire extends Emitter {
  constructor (net, label) {
    super()
    this.net = net
    this.label = label
    this.type = 'webrtc'
    this.destroyed = false
    this.extendedMapping = {}
    this._ext = {}
    this._nextExt = 1
    this.peerExtendedMapping = {}
    this._extendedHandshakeSent = false
    this.sent = [] // [name, Uint8Array] this side wrote
    this.peer = null
    this.infoHash = null
    this.queue = []
    this.draining = false
  }

  use (Ext) {
    const name = Ext.prototype.name
    const h = new Ext(this)
    this.extendedMapping[this._nextExt++] = name
    this._ext[name] = h
    this[name] = h
  }

  extended (name, bytes) {
    if (this.destroyed) throw new Error('wire destroyed')
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    this.sent.push([name, u8])
    this.net.frames.push({ infoHash: this.infoHash, from: this.label, name, bytes: u8 })
    const peer = this.peer
    if (!peer || peer.destroyed || !this.peerExtendedMapping[name]) return
    if (this.net.drops && this.net.drops(this, u8)) return
    this.queue.push(() => { const h = peer._ext[name]; if (h && !peer.destroyed) return h.onMessage(u8); return undefined })
    this._drain()
  }

  _drain () {
    if (this.draining) return
    this.draining = true
    setImmediate(() => {
      this.draining = false
      const q = this.queue.splice(0)
      for (const fn of q) {
        try { fn() } catch (_) { /* a handler's problem */ }
      }
      if (this.queue.length) this._drain()
    })
  }

  handshakeExt () {
    this._extendedHandshakeSent = true
    const m = {}
    for (const [id, name] of Object.entries(this.extendedMapping)) m[name] = Number(id)
    const peer = this.peer
    if (!peer || peer.destroyed) return
    peer.peerExtendedMapping = m
    for (const h of Object.values(peer._ext)) {
      if (typeof h.onExtendedHandshake === 'function') h.onExtendedHandshake({ m })
    }
  }

  _sendExtendedHandshake () {
    this.resent = (this.resent || 0) + 1
    this.handshakeExt()
  }

  destroy () {
    if (this.destroyed) return
    this.destroyed = true
    const peer = this.peer
    this.emit('close')
    if (peer && !peer.destroyed) setImmediate(() => peer.destroy())
  }
}

/** The LaneHandle a joinLane returns. */
export class FakeLane {
  constructor (tm, { kind, infoHash, announce }) {
    this.tm = tm
    this.kind = kind
    this.infoHash = infoHash
    this.announce = announce.slice()
    this.left = false
    this._torrent = { infoHash }
  }

  get torrent () { return this._torrent }

  leave () {
    if (this.left) return false
    this.left = true
    this.tm._left(this)
    return true
  }
}

/** The part of TorrentManager the apps use. */
export class FakeTm extends EventTarget {
  constructor (net, name = 'tm') {
    super()
    this.net = net
    this.name = name
    this.extensions = new Map()
    this.lanes = new Map()
    this.joined = [] // every joinLane call: { kind, infoHash, announce }
    this.ignored = []
    this.iceServers = null
    this.wires = new Set()
    this.destroyed = false
    this.failJoin = false
  }

  registerWireExtension (extName, handler, { swarms = ['rendezvous'] } = {}) {
    if (typeof extName !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(extName)) throw new TypeError('invalid extension name')
    if (!handler || typeof handler.onWire !== 'function') throw new TypeError('handler.onWire must be a function')
    if (this.extensions.has(extName)) throw Object.assign(new Error('registerWireExtension: ' + extName + ' is registered already'), { code: 'E_EXISTS' })
    const ext = { name: extName, handler, swarms: new Set(Array.isArray(swarms) ? swarms : [swarms]) }
    this.extensions.set(extName, ext)
    for (const rec of this.wires) {
      if (!rec.wire.destroyed && ext.swarms.has(rec.kind)) this._callExt(ext, rec, true)
    }
    return () => { if (this.extensions.get(extName) === ext) this.extensions.delete(extName) }
  }

  joinLane ({ kind, infoHash, announce = [] } = {}) {
    if (this.failJoin) throw new TypeError('joinLane failed')
    if (kind !== 'chat' && kind !== 'group' && kind !== 'hub') throw new TypeError("joinLane: kind must be 'chat', 'group' or 'hub'")
    if (typeof infoHash !== 'string' || !LANE_RE.test(infoHash)) throw new TypeError('joinLane: infoHash must be 40 hex characters')
    this.joined.push({ kind, infoHash, announce: announce.slice() })
    const existing = this.lanes.get(infoHash)
    if (existing && !existing.left) return existing
    const lane = new FakeLane(this, { kind, infoHash, announce })
    this.lanes.set(infoHash, lane)
    this.net._joined(this, lane)
    return lane
  }

  _left (lane) {
    if (this.lanes.get(lane.infoHash) === lane) this.lanes.delete(lane.infoHash)
    this.net._left(this, lane)
  }

  ignoreWire (wire, reason = 'ignored') {
    this.ignored.push([wire, reason])
    wire.destroy()
    return true
  }

  setIceServers (list) { this.iceServers = list }

  destroy () {
    this.destroyed = true
    for (const lane of Array.from(this.lanes.values())) lane.leave()
  }

  // net -> tm: a wire exists
  _addWire (wire, kind, infoHash) {
    const rec = { wire, kind, infoHash }
    this.wires.add(rec)
    wire.once('close', () => this.wires.delete(rec))
    for (const ext of this.extensions.values()) if (ext.swarms.has(kind)) this._callExt(ext, rec, false)
  }

  _callExt (ext, rec, late) {
    try { ext.handler.onWire(rec.wire, rec.kind, { late, infoHash: rec.infoHash }) } catch (_) { /* a handler's problem */ }
  }
}

/** The swarms: managers that join one lane (and are allowed by the rendezvous, when there is one) get wires. */
export class FakeNetwork {
  constructor ({ rdv = null } = {}) {
    this.rdv = rdv
    this.tms = new Set()
    this.members = new Map() // infoHash -> Set<{ tm, lane }>
    this.pairs = new Map() // infoHash -> Map<key, { a, b, wa, wb }>
    this.frames = [] // every extended frame written on any wire (what an eavesdropper sees)
    this.refused = [] // lanes a manager joined that the rendezvous does not allow
    this.paused = false
    this.canConnect = () => true
    this.drops = null // (wire, bytes) -> true to lose a frame
  }

  tm (name) {
    const tm = new FakeTm(this, name)
    this.tms.add(tm)
    return tm
  }

  _joined (tm, lane) {
    let set = this.members.get(lane.infoHash)
    if (!set) {
      set = new Set()
      this.members.set(lane.infoHash, set)
    }
    set.add({ tm, lane })
    this.connect(lane.infoHash)
  }

  _left (tm, lane) {
    const set = this.members.get(lane.infoHash)
    if (set) for (const m of Array.from(set)) if (m.lane === lane) set.delete(m)
    const pairs = this.pairs.get(lane.infoHash)
    if (pairs) {
      for (const [key, p] of Array.from(pairs)) {
        if (p.a === tm || p.b === tm) {
          pairs.delete(key)
          // a manager leaving a lane closes its wires after what was already written has been delivered (a graceful close)
          setImmediate(() => { p.wa.destroy(); p.wb.destroy() })
        }
      }
    }
  }

  /** connect(infoHash): wires for every pair of managers on the lane that have none (also called after resume()). */
  connect (infoHash) {
    if (this.paused) return
    const set = this.members.get(infoHash)
    if (!set) return
    if (this.rdv && !this.rdv.isAllowed(infoHash)) {
      if (!this.refused.includes(infoHash)) this.refused.push(infoHash)
      return
    }
    const list = Array.from(set)
    let pairs = this.pairs.get(infoHash)
    if (!pairs) {
      pairs = new Map()
      this.pairs.set(infoHash, pairs)
    }
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const A = list[i]
        const B = list[j]
        if (A.tm === B.tm || !this.canConnect(A.tm, B.tm, infoHash)) continue
        const key = A.tm.name + '|' + B.tm.name
        const existing = pairs.get(key)
        if (existing && !existing.wa.destroyed && !existing.wb.destroyed) continue
        this._wire(A, B, infoHash, pairs, key)
      }
    }
  }

  _wire (A, B, infoHash, pairs, key) {
    const wa = new FakeWire(this, A.tm.name)
    const wb = new FakeWire(this, B.tm.name)
    wa.peer = wb
    wb.peer = wa
    wa.infoHash = infoHash
    wb.infoHash = infoHash
    pairs.set(key, { a: A.tm, b: B.tm, wa, wb })
    A.tm._addWire(wa, A.lane.kind, infoHash)
    B.tm._addWire(wb, B.lane.kind, infoHash)
    setImmediate(() => {
      if (wa.destroyed || wb.destroyed) return
      wa.handshakeExt()
      wb.handshakeExt()
    })
  }

  /** dropLane(infoHash): every wire of the lane closes (a network failure); connect() or resume() brings them back. */
  dropLane (infoHash) {
    const pairs = this.pairs.get(infoHash)
    if (!pairs) return
    for (const p of Array.from(pairs.values())) {
      p.wa.destroy()
      p.wb.destroy()
    }
    pairs.clear()
  }

  dropAll () {
    for (const ih of Array.from(this.pairs.keys())) this.dropLane(ih)
  }

  pause () { this.paused = true }

  resume () {
    this.paused = false
    for (const ih of Array.from(this.members.keys())) this.connect(ih)
  }

  /** wiresOf(infoHash) -> live FakeWire pairs of the lane. */
  wiresOf (infoHash) {
    const pairs = this.pairs.get(infoHash)
    return pairs ? Array.from(pairs.values()).filter((p) => !p.wa.destroyed) : []
  }
}

// ---------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------

/** makePerson(name) -> { name, keys: { pub, sign(bytes), chat: { pub, ecdh } } } with real WebCrypto keys. */
export async function makePerson (name) {
  const { publicKey, privateKey } = await generateKeyPair()
  const pub = await exportPublicKey(publicKey)
  const chat = await generateChatKey()
  return { name, keys: { pub, chat, sign: (bytes) => sign(privateKey, bytes) } }
}

export class FakeIdentity {
  constructor (person = null) {
    this.person = person
    this.listeners = new Set()
  }

  info () { return this.person ? { pub: this.person.keys.pub, short: this.person.keys.pub.slice(5, 13), name: this.person.name || null, mode: 'visit' } : null }

  keys () { return this.person ? this.person.keys : null }

  state () { return this.person ? 'signed-in' : 'guest' }

  onChange (fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  _notify () { for (const fn of Array.from(this.listeners)) fn({ state: this.state(), info: this.info() }) }

  signIn (person) {
    this.person = person
    this._notify()
  }

  signOut () {
    this.person = null
    this._notify()
  }
}

/**
 * makeWorld({ rendezvous, core }) -> { clock, rdv, net, make(name, opts), advance(ms) }. core: true runs the real pairing core.
 * make(name, { limits, signedIn = true, tmLoader }) -> { apps, person, identity, tm, link, loadCalls } with the service wired to a
 * FakeLink (the real client on the fake rendezvous), a FakeTm on the shared network, a manual clock and real keys.
 */
export function makeWorld ({ rendezvous = 'wss://rendezvous.invalid/', startAt = 1800000000000, core = false } = {}) {
  const clock = createClock(startAt)
  if (core && !CoreRendezvous) throw new Error('deploy/rtc-worker/pair.js is not available')
  const rdv = core ? new CoreRendezvous({ now: clock.now }) : new FakeRendezvous({ now: clock.now })
  const net = new FakeNetwork({ rdv })
  const world = {
    clock, rdv, net,
    advance (ms) { clock.advance(ms) },
    async make (name, { limits = {}, signedIn = true, withLink = true } = {}) {
      const person = await makePerson(name)
      const identity = new FakeIdentity(signedIn ? person : null)
      const tm = net.tm(name)
      const loadCalls = []
      const loadTm = async () => { loadCalls.push(clock.now()); return tm }
      const link = withLink
        ? new FakeLink(rdv, { setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, random: () => 0.5 })
        : null
      const apps = createApps({
        api: { identity }, config: { rendezvous: [rendezvous], stun: [], idp: null }, loadTm, now: clock.now, link,
        setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, random: () => 0.5, limits: Object.assign({ byeGraceMs: 0, blockedRejectDelayMs: [10, 20] }, limits)
      })
      return { name, apps, person, identity, tm, link, loadCalls }
    }
  }
  return world
}

// ---------------------------------------------------------------------------------------------
// A stand-in for the service (UI tests)
// ---------------------------------------------------------------------------------------------

const API_METHODS = [
  'openCode', 'newCode', 'closeCode', 'knock', 'cancelKnock', 'accept', 'reject', 'send', 'resend', 'cancelSend', 'edit', 'remove',
  'react', 'markRead', 'markUnread', 'typing', 'block', 'unblock', 'setCfg', 'setNickname', 'setFlags', 'setFlag', 'retry',
  'setMessageFlag', 'setDraft', 'setNote', 'addSnippet', 'removeSnippet', 'search', 'exportJson', 'exportData', 'verifyCode', 'clear',
  'leave', 'createRoom', 'joinRoom', 'acceptMember', 'rejectMember', 'sendRoom', 'leaveRoom', 'markRoomRead'
]
// the calls that answer at once, not with a Promise
const SYNC_METHODS = new Set(['search', 'exportJson', 'exportData', 'setDraft', 'setNote', 'addSnippet', 'removeSnippet'])

/** FakeApps: the service's method names; every call is recorded in .calls and answered from .results[name] (default { ok: true }). */
export class FakeApps {
  constructor (state = {}) {
    this.calls = []
    this.results = {}
    this.listeners = new Set()
    this._state = Object.assign({
      signedIn: false, me: null, ready: false, link: 'closed', tm: false, notice: null, code: null,
      conversations: [], rooms: [], requests: [], snippets: [], blocked: []
    }, state)
    for (const name of API_METHODS) {
      this[name] = (...args) => {
        this.calls.push([name, ...args])
        const r = this.results[name]
        const v = typeof r === 'function' ? r(...args) : (r === undefined ? { ok: true } : r)
        return SYNC_METHODS.has(name) ? v : Promise.resolve(v)
      }
    }
  }

  state () { return this._state }

  /** set(patch): merges into the state and tells the listeners. */
  set (patch) {
    this._state = Object.assign({}, this._state, patch)
    for (const fn of Array.from(this.listeners)) fn(this._state)
  }

  onChange (fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  destroy () { this.listeners.clear() }
}

export { createClock, EXT_NAME }
