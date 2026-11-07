// test/unit/fakes/apps-fakes.mjs: fakes for the apps on the door page (reusable by the unit tests of the service, the view and the rendezvous).
//
//   FakeRendezvous   the pair protocol (ARCHITECTURE 15.21, mw-pair-v1) in memory: codes, knocks, accept, reject, cancel, close, rooms,
//                    socket loss, expiry, lane allowance, and the relay lane of plan relay-first-2026-11-07 section 3.1 (join, relay,
//                    leave, ping, with the failure texts and the caps of that plan; rdv.relayLane = false is RELAY_LANE "0"). Records
//                    every frame it was sent (rdv.raw) so a test can prove what the rendezvous never saw. rdv.socketClass() is a
//                    WebSocket stand-in that talks to it.
//   CoreRendezvous   the same surface on top of the REAL pairing core of the rendezvous (deploy/rtc-worker/pair.js createPairing),
//                    so a test can run the client against the server's own state machine (null when pair.js is not there).
//                    coreHasRelay() says whether that core already speaks the relay actions (a ping gets a pong).
//   FakeLink         src/loader/apps-link.js PairLink on a FakeSocket of a FakeRendezvous (the real client code, a fake server);
//                    link.drop() loses the socket from the server's side, link.rdv is the server.
//   FakeNetwork      the swarms: two managers that join the same lane (and are allowed by the rendezvous, when one is given)
//                    get a wire pair; net.frames records every extended frame (what an eavesdropper on a wire sees).
//   FakeTm           the part of TorrentManager the apps use: registerWireExtension, joinLane (-> FakeLane), ignoreWire,
//                    setIceServers, EventTarget. tm.joined logs every joinLane call (nothing may be there before approval).
//   FakeWire         a bittorrent-protocol wire stand-in with use(), extended(), the extended handshake, destroy().
//   FakeIdentity     { info(), keys(), state(), onChange(fn) } with signIn(person) and signOut().
//   FakeHooks        the page's visibility and network events (deps.onVisible, deps.onOnline of the service) with visible() and back() to fire them.
//   makePerson(name) real WebCrypto keys: { name, keys: { pub, sign, chat: { pub, ecdh } } }.
//   makeWorld()      a clock, a rendezvous, a network and make(name) -> { apps, person, identity, tm, link, hooks, ... } for each person.
//                    The world's DEFAULT door config is the legacy one (relay 'none', so direct on: the transport of before the relay
//                    existed, which is what the older tests prove); a test of the relay passes relay and direct explicitly.
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
    // the relay lane (plan relay-first-2026-11-07 section 3.1 and 3.2): who is in which lane, and the caps of the plan
    this.relayLane = true // false: every join and relay answers 'relay is off on this rendezvous' (the Worker var RELAY_LANE "0")
    this.relays = new Map() // lane -> { kind, members: Set<conn> }
    this.caps = { relayPerMin: 120, messagesPerMin: 150, relayDayMax: 20000, lanesPerSocket: 8, pairLaneMembers: 2, roomLaneMembers: 16 }
    this.stats = { relayed: 0, relayBytes: 0, relayBusy: 0, relayRate: 0, joinsRefused: 0, day: -1 }
    this.pongs = true // false: pings get no pong (a socket that is half open)
  }

  connect () {
    const conn = { id: this.nextConn++, deliver: null, closed: false, knockTimes: [], relayTimes: [], joined: new Set() }
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
    // plan 3.1: a ping is answered with a pong that has no rid; it is never a failure, a relay or a join, and it changes nothing
    if (m.action === 'pair-ping') {
      if (this.pongs) this._send(conn, { action: 'pair-pong' })
      return
    }
    const rid = typeof m.rid === 'string' && m.rid.length <= 16 ? m.rid : undefined
    const reply = (obj) => this._send(conn, rid ? Object.assign({}, obj, { rid }) : obj)
    const fail = (reason) => reply({ action: m.action, 'failure reason': reason })
    // plan 3.2: every message but a ping counts against the socket's minute; over the cap the socket gets one failure reply and is closed (1008)
    const t = this.now()
    conn.msgTimes = (conn.msgTimes || []).filter((x) => t - x < 60000)
    if (conn.msgTimes.length >= this.caps.messagesPerMin) {
      fail('too many messages')
      setImmediate(() => this.closeSocketOf(conn))
      return undefined
    }
    conn.msgTimes.push(t)
    this.log.push({ conn: conn.id, action: m.action, channel: m.channel })
    if (m.v !== 1) return fail('bad version')
    const hit = /^(pair|room)-([a-z]+)$/.exec(m.action)
    if (!hit) return fail('invalid action')
    const kind = hit[1]
    const verb = hit[2]
    if (verb === 'join' || verb === 'relay' || verb === 'leave') return this._relayAction(conn, kind, verb, m, rid, reply, fail)
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

  /** closeSocketOf(conn): the server closes the socket of this connection (the Worker's close with code 1008); its lanes and codes are released. */
  closeSocketOf (conn) {
    for (const socket of Array.from(this.sockets)) if (socket.conn === conn) socket._serverClose()
  }

  // ---- the relay lane (plan 3.1): a lane the rendezvous minted after an accept, at most 2 sockets (a room 16), sealed frames fanned out ----

  _day () {
    const d = Math.floor(this.now() / 86400000)
    if (this.stats.day !== d) Object.assign(this.stats, { day: d, relayed: 0, relayBytes: 0, relayBusy: 0, relayRate: 0, joinsRefused: 0 })
    return d
  }

  _relayAction (conn, kind, verb, m, rid, reply, fail) {
    this._day()
    const lane = m.lane
    const laneOk = typeof lane === 'string' && LANE_RE.test(lane)
    if (verb === 'leave') {
      // leaving is always allowed and says nothing unless asked (a rid); a lane the socket is not in is left already
      if (laneOk) this._leaveRelay(conn, lane)
      if (rid) reply({ action: kind + '-leave', lane })
      return undefined
    }
    const refuse = (text) => {
      if (verb === 'join') this.stats.joinsRefused++
      return fail(text)
    }
    if (!this.relayLane) return refuse('relay is off on this rendezvous')
    if (!laneOk) return refuse('invalid lane')
    let rec = this.relays.get(lane)
    if (verb === 'join') {
      if (!this.isAllowed(lane) || (rec && rec.kind !== kind)) return refuse('unknown lane')
      if (rec && rec.members.has(conn)) return reply({ action: kind + '-join', lane, peers: rec.members.size - 1 }) // idempotent: the reply, no push
      if (rec && rec.members.size >= (kind === 'room' ? this.caps.roomLaneMembers : this.caps.pairLaneMembers)) return refuse('lane full')
      if (conn.joined.size >= this.caps.lanesPerSocket) return refuse('too many lanes')
      if (!rec) {
        rec = { kind, members: new Set() }
        this.relays.set(lane, rec)
      }
      rec.members.add(conn)
      conn.joined.add(lane)
      const peers = rec.members.size - 1
      reply({ action: kind + '-join', lane, peers })
      for (const other of rec.members) if (other !== conn) this._send(other, { action: kind + '-joined', lane, peers })
      return undefined
    }
    // relay: the sender must be a member of this kind of lane, the frame base64url of 4 to 7,700 characters
    if (!rec || rec.kind !== kind || !rec.members.has(conn)) return fail('unknown lane')
    const f = m.f
    if (typeof f !== 'string' || !/^[A-Za-z0-9_-]{4,7700}$/.test(f)) return fail('invalid frame')
    const t = this.now()
    conn.relayTimes = conn.relayTimes.filter((x) => t - x < 60000)
    if (conn.relayTimes.length >= this.caps.relayPerMin) {
      this.stats.relayRate++
      return fail('too many relays')
    }
    if (this.stats.relayed >= this.caps.relayDayMax) {
      this.stats.relayBusy++
      return fail('relay is busy')
    }
    conn.relayTimes.push(t)
    let n = 0
    for (const other of rec.members) {
      if (other === conn) continue
      this._send(other, { action: kind + '-relayed', lane, f })
      n++
    }
    this.stats.relayed++
    this.stats.relayBytes += f.length
    if (rid) reply({ action: kind + '-relay', lane, peers: n })
    return undefined
  }

  _leaveRelay (conn, lane) {
    const rec = this.relays.get(lane)
    if (!rec || !rec.members.delete(conn)) return
    conn.joined.delete(lane)
    if (!rec.members.size) this.relays.delete(lane)
    for (const other of rec.members) this._send(other, { action: rec.kind + '-left', lane, peers: rec.members.size - 1 })
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
    for (const lane of Array.from(conn.joined || [])) this._leaveRelay(conn, lane)
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
    return { codes: this.channels.size, channels: this.channels.size, knocks: this.knocks.size, lanes: this.lanes.size, relays: this.relays.size }
  }

  /** relayStats() -> the counts of the Worker's /stats.json for the relay (plan 3.2), for today: no frame, no lane id. */
  relayStats () {
    this._day()
    return Object.assign({ relays: this.relays.size }, this.stats)
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

/**
 * CoreRendezvous: a FakeRendezvous whose protocol is the real createPairing state machine. null when pair.js cannot be loaded.
 * opts.caps go to the core when it is made (the Worker's caps are fixed for the life of its object, so a test sets them here, not
 * later). rdv.relays and conn.joined are read from the core (who is in which lane, from attachmentOf), so a test that looks at the
 * lanes of the rendezvous reads the same shapes on the stub and on the core (integrate step I1: the relay tests run on the core).
 */
export const CoreRendezvous = realCore
  ? class CoreRendezvous extends FakeRendezvous {
    constructor (opts = {}) {
      super(opts)
      if (opts.caps) Object.assign(this.caps, opts.caps)
      this.core = realCore.createPairing({
        now: this.now,
        random: (n) => crypto.getRandomValues(new Uint8Array(n)),
        allowLane: (lane, exp) => { this.lanes.set(lane, exp); return true },
        // plan 3.1: the lane's expiry in ms, 0 when it was never minted or ran out (the relay joins only a lane the rendezvous minted)
        laneExpiry: (lane) => { const exp = this.lanes.get(lane); return exp !== undefined && exp > this.now() ? exp : 0 },
        relay: opts.relayLane !== false,
        caps: opts.caps || {}
      })
      // the stub's own map of lanes is never used here: the view answers from the core
      Object.defineProperty(this, 'relays', { configurable: true, enumerable: true, get: () => this._coreRelays() })
    }

    connect () {
      const conn = super.connect()
      // conn.joined, the lanes this socket is in, as the core keeps them (the stub keeps its own Set there)
      Object.defineProperty(conn, 'joined', { configurable: true, enumerable: true, get: () => new Set((this.core.attachmentOf(conn).l || []).map(([lane]) => lane)) })
      return conn
    }

    /** _coreRelays() -> Map lane -> { kind, members: Set<conn> } of the open sockets, from the core's attachments (plan 3.3: l lists a socket's lanes). */
    _coreRelays () {
      const out = new Map()
      for (const conn of this.conns) {
        for (const [lane, kind] of this.core.attachmentOf(conn).l || []) {
          if (!out.has(lane)) out.set(lane, { kind, members: new Set() })
          out.get(lane).members.add(conn)
        }
      }
      return out
    }

    handle (conn, m) {
      if (!m || typeof m !== 'object' || !realCore.isPairAction(m.action)) return
      if (m.action === 'pair-ping' && !this.pongs) return // a rendezvous that is half open: the ping goes nowhere
      this.log.push({ conn: conn.id, action: m.action, channel: m.channel })
      const out = this.core.message(conn, m)
      for (const [to, obj] of out.replies) this._send(to, obj)
      // a socket over its allowance of messages is closed by the host (code 1008) after the one failure reply (plan 3.2)
      if (out.close) setImmediate(() => this.closeSocketOf(conn))
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
      return { codes: st.codes, channels: st.codes, knocks: st.knocks, lanes: this.lanes.size, relays: st.relays }
    }

    /** relayStats() -> the core's own counts for the relay (relays, relayed, relayBytes, relayBusy, relayRate, joinsRefused): the Worker's /stats.json. */
    relayStats () {
      return this.core.stats()
    }
  }
  : null

/**
 * coreHasRelay() -> true when the real pairing core already speaks the relay lane (a ping is answered with a pong). The tests that run
 * the relay on the core are added to a file only when this says so, so that the file also runs against a core without it.
 */
export function coreHasRelay () {
  if (!realCore) return false
  try {
    const out = realCore.createPairing({ now: () => 0 }).message({}, { v: 1, action: 'pair-ping' })
    return !!out && Array.isArray(out.replies) && out.replies.some(([, obj]) => !!obj && obj.action === 'pair-pong')
  } catch (_) {
    return false
  }
}

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
// The page's own events
// ---------------------------------------------------------------------------------------------

/**
 * FakeHooks: what the page tells the service through deps.onVisible and deps.onOnline (the tab became visible, the network came back).
 * visible() and back() fire the handlers; offs counts the handlers taken off again (destroy() takes both).
 */
export class FakeHooks {
  constructor () {
    this.visibleFns = new Set()
    this.backFns = new Set()
    this.offs = 0
    this.onVisible = (fn) => this._on(this.visibleFns, fn)
    this.onOnline = (fn) => this._on(this.backFns, fn)
  }

  _on (set, fn) {
    set.add(fn)
    return () => { if (set.delete(fn)) this.offs++ }
  }

  visible () { for (const fn of Array.from(this.visibleFns)) fn() }

  back () { for (const fn of Array.from(this.backFns)) fn() }
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
 * makeWorld({ rendezvous, core, config, relayLane, caps }) -> { clock, rdv, net, make(name, opts), advance(ms) }. core: true runs the real pairing core.
 * relayLane: false is the rendezvous with the relay switched off (the Worker var RELAY_LANE "0", the tracker flag --no-relay-lane).
 * caps: the relay's caps of plan 3.2 for this world, set before anything runs (on the core they are fixed from then on, as on the Worker).
 * config: the world's default door settings beyond the three fields of the apps block; the default is the LEGACY door, { relay: 'none' },
 * which the service reads as direct on (plan amendment A2): the transport the older tests prove. A test of the relay passes relay and
 * direct, on the world or on a person.
 * make(name, { limits, signedIn, withLink, config, relay, direct, linkOptions, reports, deps }) -> { apps, person, identity, tm, link,
 * loadCalls, hooks, reports } with the service wired to a FakeLink (the real client on the fake rendezvous), a FakeTm on the shared
 * network, a manual clock, real keys and FakeHooks (deps.onVisible, deps.onOnline). config (and relay, direct) go over the world's
 * config, and a key set to undefined is left out (config: { relay: undefined } is a door with no relay key at all, the new default).
 * linkOptions go to the FakeLink (keepaliveMs, for one); reports: true records every report of the service ('apps.' names) and of
 * its socket ('link.' names) in person.reports, as the page does; deps are more options of createApps.
 */
export function makeWorld ({ rendezvous = 'wss://rendezvous.invalid/', startAt = 1800000000000, core = false, config = null, relayLane = true, caps = null } = {}) {
  const clock = createClock(startAt)
  if (core && !CoreRendezvous) throw new Error('deploy/rtc-worker/pair.js is not available')
  const rdv = core ? new CoreRendezvous({ now: clock.now, relayLane, caps }) : new FakeRendezvous({ now: clock.now })
  if (caps && !core) Object.assign(rdv.caps, caps)
  rdv.relayLane = relayLane !== false
  const net = new FakeNetwork({ rdv })
  const world = {
    clock, rdv, net,
    config: Object.assign({ relay: 'none' }, config || {}),
    advance (ms) { clock.advance(ms) },
    async make (name, { limits = {}, signedIn = true, withLink = true, config: own = null, relay, direct, linkOptions = null, reports = false, deps = null } = {}) {
      const person = await makePerson(name)
      const identity = new FakeIdentity(signedIn ? person : null)
      const tm = net.tm(name)
      const loadCalls = []
      const loadTm = async () => { loadCalls.push(clock.now()); return tm }
      const seen = reports ? [] : null
      const into = (prefix) => (n, f) => { seen.push({ name: prefix + n, fields: JSON.parse(JSON.stringify(f)) }) }
      const link = withLink
        ? new FakeLink(rdv, Object.assign({ setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, random: () => 0.5, now: clock.now }, seen ? { report: into('link.') } : {}, linkOptions || {}))
        : null
      const hooks = new FakeHooks()
      const door = Object.assign({ rendezvous: [rendezvous], stun: [], idp: null }, world.config, own || {})
      if (relay !== undefined) door.relay = relay
      if (direct !== undefined) door.direct = direct
      for (const k of Object.keys(door)) if (door[k] === undefined) delete door[k] // config: { relay: undefined } is a door with no relay key at all
      const apps = createApps(Object.assign({
        api: { identity }, config: door, loadTm, now: clock.now, link,
        setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout, random: () => 0.5,
        onVisible: hooks.onVisible, onOnline: hooks.onOnline,
        limits: Object.assign({ byeGraceMs: 0, blockedRejectDelayMs: [10, 20] }, limits)
      }, seen ? { report: into('apps.') } : {}, deps || {}))
      return { name, apps, person, identity, tm, link, loadCalls, hooks, reports: seen }
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
