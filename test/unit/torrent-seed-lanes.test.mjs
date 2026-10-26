// Unit tests for the C2 lanes in src/loader/torrent.js (v0.3 C2, lane seed-engine; SZ 3.1.2 to 3.1.6): lane
// assignment, token buckets that choke-lock a lane and unlock it about 1 s later, session caps, the month cap that
// stops K and E but not H, local wires on the local row and outside the month cap, the hidden lock (H only with
// budget.hiddenH), the client throttle (the sum of the open lanes, never 0), the planner's idle items and shares,
// availability evidence and its events, the H hand-off ending at two complete peer copies or a pin receipt, and
// super-seeding behind CONFIG.seed.superSeed. Lane seed-policy's modules are mocked at the deps boundary where a test
// needs to steer them. Run: node --test test/unit/torrent-seed-lanes.test.mjs
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { TorrentManager, createBucket, bucketTake, bucketLevel, bucketRefillMs, peerPiecesHeld, SEED_LANE_IDS } from '../../src/loader/torrent.js'
import { CONFIG } from '../../src/loader/config.js'
import { seedBudget } from '../../src/loader/seed-budget.js'
import { createPinWire, createPinPageHost } from '../../src/loader/pinwire.js'
import { generateKeyPair, exportPublicKey, sign } from '../../src/chain/crypto.js'
import { b64url, utf8 } from '../../src/chain/canonical.js'

const SITE = 'a'.repeat(40)
const FILE = 'f'.repeat(40)
const MINE = 'e'.repeat(40)
const OTHER = 'd'.repeat(40)
const INFO = new Uint8Array([0x64, 0x31, 0x3a, 0x61, 0x69, 0x31, 0x65, 0x65]) // d1:ai1ee
const TORRENT = new Uint8Array([9, 9, 9])
const KiB = 1024
const MiB = 1024 * 1024

class Emitter {
  constructor () { this._l = new Map() }
  on (t, fn) { if (!this._l.has(t)) this._l.set(t, []); this._l.get(t).push(fn); return this }
  once (t, fn) { const w = (...a) => { this.removeListener(t, w); fn(...a) }; return this.on(t, w) }
  removeListener (t, fn) { const l = this._l.get(t); if (l) { const i = l.indexOf(fn); if (i !== -1) l.splice(i, 1) } return this }
  emit (t, ...a) { for (const fn of (this._l.get(t) || []).slice()) fn(...a); return true }
}

class Bits {
  constructor (n, all = false) { this.n = n; this.bits = new Uint8Array(n).fill(all ? 1 : 0) }
  get buffer () { return this.bits }
  get (i) { return !!this.bits[i] }
  set (i, v = true) { this.bits[i] = v ? 1 : 0 }
}

/** A planner stand-in that serves every item with no share (the lane bucket alone). */
const everyItem = ({ items }) => ({ order: items.map((i) => i.ih), idle: [], share: {} })

let nextIh = 0
class FakeTorrent extends Emitter {
  constructor (source, opts) {
    super()
    this.source = source
    this.opts = opts
    this.destroyed = false
    this.done = false
    if (typeof source === 'string' && /^[0-9a-f]{40}$/.test(source)) this.infoHash = source
    else if (typeof source === 'string' && source.startsWith('magnet:')) this.infoHash = source.slice(-40)
    else this.infoHash = FakeTorrent.next || ('0' + String(++nextIh)).padStart(40, '0')
  }
  destroy (opts) { this.destroyed = true; this.destroyOpts = opts; this.emit('close') }
  finish () { this.done = true; this.bitfield = new Bits(4, true); this.emit('done') }
}

class FakeWebTorrent extends Emitter {
  constructor (opts) { super(); this.opts = opts; this.torrents = []; this.destroyed = false; this.throttles = []; FakeWebTorrent.instances.push(this) }
  add (source, opts) { const t = new FakeTorrent(source, opts); this.torrents.push(t); return t }
  destroy () { this.destroyed = true; for (const t of this.torrents) if (!t.destroyed) t.destroy() }
  throttleUpload (r) { this.throttles.push(r) }
}
FakeWebTorrent.instances = []

function fakeWire ({ type = 'webrtc', peerId = null, pieces = 4 } = {}) {
  const w = new Emitter()
  w.type = type
  w.peerId = peerId
  w.destroyed = false
  w.peerPieces = new Bits(pieces)
  w.sent = []
  w._onMessageLength = function () { return 'orig' }
  w._parse = function () {}
  w.choke = function () {}
  w.unchoke = function () {}
  w.setTimeout = function () {}
  w.setKeepAlive = function () {}
  w.bitfield = function (bf) { this.sent.push(['bitfield', Array.from(ArrayBuffer.isView(bf) ? bf : bf.buffer)]) }
  w.have = function (i) { this.sent.push(['have', i]) }
  w.haveAll = function () { this.sent.push(['haveAll']) }
  w.destroy = function () { if (this.destroyed) return; this.destroyed = true; this.emit('close') }
  w.complete = function (n = pieces) { this.peerPieces = new Bits(n, true); this.emit('bitfield', this.peerPieces) }
  w.up = function (bytes) { this.emit('upload', bytes) }
  return w
}

class FakeClock {
  constructor () { this.t = 1_000_000; this.timers = new Map(); this.id = 0 }
  setTimeout (fn, ms) { const id = ++this.id; this.timers.set(id, { fn, at: this.t + ms, every: 0 }); return id }
  clearTimeout (id) { this.timers.delete(id) }
  setInterval (fn, ms) { const id = ++this.id; this.timers.set(id, { fn, at: this.t + ms, every: ms }); return id }
  clearInterval (id) { this.timers.delete(id) }
  now () { return this.t }
  async advance (ms) {
    const end = this.t + ms
    for (;;) {
      let next = null
      for (const [id, tm] of this.timers) if (tm.at <= end && (!next || tm.at < next[1].at)) next = [id, tm]
      if (!next) break
      const [id, tm] = next
      this.t = tm.at
      if (tm.every) tm.at += tm.every
      else this.timers.delete(id)
      tm.fn()
      await flush()
    }
    this.t = end
    await flush()
  }
}

function flush () { return new Promise((resolve) => setImmediate(resolve)) }

/**
 * untilJoinScheduled(tm): waits in real time until addRendezvous has scheduled the jittered join (or holds a torrent).
 * The rendezvous infohash is a WebCrypto digest on the thread pool: a fixed number of setImmediate turns is not enough
 * when the whole suite runs on a loaded machine (the first CI run on Linux hung here), so this waits up to 10 s of wall time.
 */
async function untilJoinScheduled (tm, deadlineMs = 10000) {
  const until = Date.now() + deadlineMs
  while (!(tm.rendezvous && (tm.rendezvous.joinTimer || tm.rendezvous.torrent))) {
    if (Date.now() > until) throw new Error('the rendezvous join was not scheduled within ' + deadlineMs + ' ms')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

// C2 integrator: waits on real time for cond(). WebCrypto signs and verifies on a worker thread, so a fixed number of
// setImmediate turns was not always enough under the full parallel unit run (the mw_pin1 test failed there and passed alone).
async function until (cond, ms = 5000) {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 2))
}

class FakeStore {
  constructor (chunkLength, opts = {}) { this.chunkLength = chunkLength; this.length = opts.length; this.data = new Map() }
  put (i, b, cb) { this.data.set(i, b); cb && cb(null) }
  get (i, o, cb) { if (typeof o === 'function') cb = o; cb(null, this.data.get(i)) }
  close (cb) { cb && cb(null) }
  destroy (cb) { cb && cb(null) }
}

/** Meters that count like createSeedMeters, with a month figure the test can set. */
function fakeMeters ({ month = 0 } = {}) {
  const session = { H: 0, K: 0, E: 0 }
  const local = { H: 0, K: 0, E: 0 }
  const m = {
    month,
    adds: [],
    add (lane, bytes, { local: isLocal = false } = {}) {
      this.adds.push({ lane, bytes, local: isLocal })
      if (isLocal) local[lane] += bytes
      else { session[lane] += bytes; if (lane !== 'H') this.month += bytes }
    },
    sessionUsed (lane, { local: isLocal = false } = {}) { return isLocal ? local[lane] : session[lane] },
    monthUsed () { return this.month },
    flushed: 0,
    flush () { this.flushed++ }
  }
  return m
}

/** A seed budget in the seedBudget() shape. */
function budget ({ H = MiB, K = MiB, E = 256 * KiB, session = Infinity, month = Infinity, local = null, hiddenH = false, row = 'desktop' } = {}) {
  return {
    row,
    lanes: { H: { rate: H, session: H ? session : 0 }, K: { rate: K, session: K ? session : 0 }, E: { rate: E, session: E ? session : 0 } },
    month: { cap: month, lanes: ['K', 'E'] },
    local: local || { H: MiB, K: 512 * KiB, E: 256 * KiB, session: 128 * MiB, on: true },
    hiddenH,
    defaultOn: true,
    ask: null
  }
}

function manager ({ policy = {}, config = CONFIG, meters = fakeMeters(), planSeeding = undefined, isLocalPair = undefined } = {}) {
  FakeWebTorrent.instances = []
  const clock = new FakeClock()
  const d = {
    MemoryChunkStore: FakeStore,
    BlobChunkStore: FakeStore,
    parseTorrentFile: async (u8) => {
      if (u8 && u8.length === 3 && u8[0] === 9) return { infoHash: MINE, name: 'mine.bin', pieceLength: 16384, length: 65536, pieceCount: 4, files: [{ path: 'mine.bin', length: 65536, offset: 0 }], infoBytes: INFO }
      throw new Error('not a torrent')
    },
    seedMeters: meters
  }
  if (planSeeding) d.planSeeding = planSeeding
  if (isLocalPair) d.isLocalPair = isLocalPair
  const tm = new TorrentManager({
    WebTorrent: FakeWebTorrent,
    config,
    policy: Object.assign({ maxConns: 30, uploadsEnabled: true, uploadLimit: MiB, hostOnly: false, leaveVersionSwarm: false }, policy),
    consent: { peersAllowed: () => true, onChange () {} },
    deps: d,
    timers: clock,
    fetch: async () => { throw new TypeError('no network in unit tests') },
    baseUrl: 'https://site.example/page',
    lifecycle: false,
    random: () => 0.5
  })
  return { tm, clock, meters }
}

const client = () => FakeWebTorrent.instances[FakeWebTorrent.instances.length - 1]
const lastThrottle = () => { const c = client(); return c.throttles[c.throttles.length - 1] }

/** A site torrent in the manager (lane K), started through download() like the loader does. */
async function siteSwarm (tm) {
  tm.download({ record: { btih: SITE, signed: true, tr: ['wss://own.example'] } }).catch(() => {})
  await flush(); await flush()
  return client().torrents.find((t) => t.infoHash === SITE)
}

async function fileSwarm (tm, ih, opts = {}) {
  const h = await tm.addFileTorrent(Object.assign({ infoHash: ih, store: FakeStore, announce: ['wss://own.example'] }, opts))
  return h
}

async function ownUpload (tm, opts = {}) {
  return tm.addFileTorrent(Object.assign({ torrentFile: TORRENT, store: FakeStore, announce: ['wss://own.example'], uploadException: true }, opts))
}

describe('token buckets', () => {
  test('a bucket holds 1 s of its rate (at least 32 KiB), drains, and refills to full', () => {
    const b = createBucket(128 * KiB, 0)
    assert.equal(b.cap, 128 * KiB)
    assert.equal(createBucket(1000, 0).cap, 32768, 'never below 32 KiB')
    assert.equal(bucketTake(b, 100 * KiB, 0), false)
    assert.equal(bucketTake(b, 40 * KiB, 0), true, 'drained')
    assert.equal(b.drained, true)
    assert.equal(bucketRefillMs(b, 0), Math.ceil((128 + 12) * KiB * 1000 / (128 * KiB)))
    bucketLevel(b, 1000)
    assert.equal(b.drained, true, 'not full yet')
    bucketLevel(b, 1100)
    assert.equal(b.drained, false)
    const inf = createBucket(Infinity, 0)
    assert.equal(bucketTake(inf, 1e12, 0), false)
    assert.deepEqual(SEED_LANE_IDS, ['H', 'K', 'E'])
  })

  test('peerPiecesHeld counts what a wire reports', () => {
    const w = fakeWire({ pieces: 8 })
    w.peerPieces.set(1); w.peerPieces.set(5)
    assert.equal(peerPiecesHeld(w, 8), 2)
    assert.equal(peerPiecesHeld({}, 8), 0)
  })
})

describe('lanes', () => {
  test('the site torrent is K; a file is H with the per-upload exception, K when chosen, else E; re-adding promotes', async () => {
    const { tm } = manager()
    const e = await fileSwarm(tm, FILE)
    assert.equal(e.lane, 'E')
    const k = await fileSwarm(tm, OTHER, { lane: 'K' })
    assert.equal(k.lane, 'K')
    const h = await ownUpload(tm)
    assert.equal(h.lane, 'H')
    assert.equal(h.uploadException, true)
    const lanes = []
    e.on('lane', (d) => lanes.push(d.lane))
    assert.equal(await fileSwarm(tm, FILE, { lane: 'K' }), e)
    assert.equal(e.lane, 'K', 'promoted')
    assert.equal(await fileSwarm(tm, FILE, { lane: 'E' }), e)
    assert.equal(e.lane, 'K', 'never demoted')
    assert.deepEqual(lanes, ['K'])
    assert.equal(e.setLane('H'), 'H')
    assert.equal(e.uploadException, true)
    assert.throws(() => e.setLane('X'), TypeError)
    await assert.rejects(tm.addFileTorrent({ infoHash: 'c'.repeat(40), store: FakeStore, lane: 'Z' }), TypeError)
    tm.destroy()
  })

  test('a drained lane is choke-locked and unlocks about 1 s later; other lanes keep going', async () => {
    const { tm, clock } = manager({ planSeeding: everyItem })
    const site = await siteSwarm(tm)
    const e = await fileSwarm(tm, FILE, { lane: 'K' })
    tm.setSeedBudget(budget({ K: 128 * KiB, E: 0 }))
    await flush()
    const sw = fakeWire({ peerId: 's1' })
    site.emit('wire', sw)
    assert.equal(sw.__mwLock, undefined, 'K open')
    const fw = fakeWire({ peerId: 'f1' })
    e.torrent.emit('wire', fw)
    sw.up(100 * KiB)
    assert.equal(sw.__mwLock, undefined)
    sw.up(40 * KiB)
    assert.ok(sw.__mwLock, 'the K bucket is empty: K wires lock')
    assert.ok(fw.__mwLock, 'both K wires share the bucket')
    await clock.advance(1000)
    assert.ok(sw.__mwLock, 'still refilling (hysteresis)')
    await clock.advance(200)
    assert.equal(sw.__mwLock, null, 'full again: unlocked')
    assert.equal(fw.__mwLock, null)
    tm.destroy()
  })

  test('a session cap stops its lane for the page session', async () => {
    const { tm, clock } = manager()
    const site = await siteSwarm(tm)
    tm.setSeedBudget(budget({ K: Infinity, session: 200 * KiB }))
    const w = fakeWire({ peerId: 's1' })
    site.emit('wire', w)
    w.up(150 * KiB)
    assert.equal(w.__mwLock, undefined)
    w.up(60 * KiB)
    assert.ok(w.__mwLock, '210 KiB of a 200 KiB session')
    await clock.advance(60000)
    assert.ok(w.__mwLock, 'stays locked')
    tm.destroy()
  })

  test('the month cap stops K and E, not H (E-PS-3)', async () => {
    const meters = fakeMeters({ month: 300 * MiB })
    const { tm } = manager({ meters, planSeeding: ({ items }) => ({ order: items.map((i) => i.ih), idle: [], share: {} }) })
    const site = await siteSwarm(tm)
    const e = await fileSwarm(tm, FILE)
    const h = await ownUpload(tm)
    tm.setSeedBudget(budget({ month: 256 * MiB }))
    await flush()
    const sw = fakeWire({ peerId: 's' })
    const ew = fakeWire({ peerId: 'e' })
    const hw = fakeWire({ peerId: 'h' })
    site.emit('wire', sw)
    e.torrent.emit('wire', ew)
    h.torrent.emit('wire', hw)
    assert.ok(sw.__mwLock, 'K stops at the month cap')
    assert.ok(ew.__mwLock, 'E stops at the month cap')
    assert.equal(hw.__mwLock, undefined, 'H (own uploads) still goes out')
    hw.up(64 * KiB)
    assert.deepEqual(meters.adds.at(-1), { lane: 'H', bytes: 64 * KiB, local: false })
    assert.equal(meters.month, 300 * MiB, 'H never counts toward the month')
    tm.destroy()
  })

  test('local wires: the local row, the local session, outside the month cap; local.on false counts them like others', async () => {
    const meters = fakeMeters({ month: 10 * MiB })
    const { tm } = manager({ meters, isLocalPair: () => ({ local: true, reason: 'local' }) })
    const site = await siteSwarm(tm)
    tm.setSeedBudget(budget({ K: 128 * KiB, month: 10 * MiB, local: { H: MiB, K: 512 * KiB, E: 256 * KiB, session: 300 * KiB, on: true } }))
    const sp = { id: 'lan1', once () {}, _pc: { getStats: async () => new Map() } }
    site.emit('peer', sp)
    const w = fakeWire({ peerId: 'lan1' })
    site.emit('wire', w)
    assert.ok(w.__mwLock, 'before the stats are read the wire counts as not local: the month cap is used up')
    await flush(); await flush()
    assert.equal(w.__mwLock, null, 'local: outside the month cap, so it opens')
    w.up(200 * KiB)
    assert.deepEqual(meters.adds.at(-1), { lane: 'K', bytes: 200 * KiB, local: true })
    assert.equal(meters.month, 10 * MiB, 'the month figure is untouched')
    assert.equal(w.__mwLock, null, 'the local bucket holds 512 KiB')
    w.up(150 * KiB)
    assert.ok(w.__mwLock, '350 KiB of a 300 KiB local session')
    assert.ok(lastThrottle() === -1, 'no lane wire may upload: unshaped and choke-locked')
    tm.destroy()

    const m2 = fakeMeters()
    const r2 = manager({ meters: m2, isLocalPair: () => ({ local: true, reason: 'local' }) })
    const site2 = await siteSwarm(r2.tm)
    r2.tm.setSeedBudget(budget({ K: 128 * KiB, local: { H: 0, K: 0, E: 0, session: 0, on: false } }))
    site2.emit('peer', { id: 'lan2', once () {}, _pc: { getStats: async () => new Map() } })
    const w2 = fakeWire({ peerId: 'lan2' })
    site2.emit('wire', w2)
    await flush(); await flush()
    assert.equal(w2.__mwLock, undefined, 'counted like any other wire: the K row applies')
    w2.up(KiB)
    assert.equal(m2.adds.at(-1).local, false)
    r2.tm.destroy()
  })

  test('the local-wire test reads simple-peer stats once; unreadable stats mean not local', async () => {
    let calls = 0
    const { tm } = manager({ isLocalPair: () => { calls++; return { local: true } } })
    const site = await siteSwarm(tm)
    site.emit('peer', { id: 'p1', once () {}, getStats (cb) { cb(null, []) } })
    site.emit('peer', { id: 'p2', once () {}, _pc: { getStats: async () => { throw new Error('closed') } } })
    const a = fakeWire({ peerId: 'p1' })
    const b = fakeWire({ peerId: 'p2' })
    site.emit('wire', a)
    site.emit('wire', b)
    await flush(); await flush()
    assert.equal(calls, 1, 'once, for the readable one (the legacy getStats(cb) form)')
    const infoA = tm._wireInfo.get(a)
    const infoB = tm._wireInfo.get(b)
    assert.equal(infoA.local, true)
    assert.equal(infoB.local, false)
    assert.equal(infoB.localReason, 'no-stats')
    tm.destroy()
  })

  test('hidden: every lane locks, H only stays open with budget.hiddenH (SZ-2); meters are flushed', async () => {
    const meters = fakeMeters()
    const { tm } = manager({ meters, policy: { hiddenAction: 'lock' } })
    const site = await siteSwarm(tm)
    const h = await ownUpload(tm)
    tm.setSeedBudget(budget())
    const sw = fakeWire({ peerId: 's' })
    const hw = fakeWire({ peerId: 'h' })
    site.emit('wire', sw)
    h.torrent.emit('wire', hw)
    tm._onVisibility('hidden')
    assert.ok(sw.__mwLock)
    assert.ok(hw.__mwLock, 'SZ-2 off: H locks too')
    assert.equal(meters.flushed, 1, 'the month record is written when the page hides')
    tm._onVisibility('visible')
    assert.equal(hw.__mwLock, null)
    tm.setSeedBudget(budget({ hiddenH: true }))
    tm._onVisibility('hidden')
    assert.ok(sw.__mwLock)
    assert.equal(hw.__mwLock, null, 'SZ-2 on: H keeps sending while hidden')
    tm.destroy()
  })

  test('the client throttle is the sum of the lanes with an unlocked wire, never 0', async () => {
    const { tm, clock } = manager({ planSeeding: everyItem })
    const site = await siteSwarm(tm)
    const h = await ownUpload(tm)
    tm.setSeedBudget(budget({ H: 512 * KiB, K: 256 * KiB, E: 0 }))
    assert.equal(lastThrottle(), -1, 'no lane wire yet')
    site.emit('wire', fakeWire({ peerId: 's' }))
    assert.equal(lastThrottle(), 256 * KiB)
    h.torrent.emit('wire', fakeWire({ peerId: 'h' }))
    assert.equal(lastThrottle(), 768 * KiB)
    const rvp = tm.addRendezvous('mw1:abc', ['wss://own.example'])
    await untilJoinScheduled(tm)
    await clock.advance(CONFIG.ledger.joinJitterMs + 1)
    const rv = await rvp
    rv.emit('wire', fakeWire({ peerId: 'ledger-peer' }))
    assert.equal(lastThrottle(), 768 * KiB + 32768, 'ledger gossip gets the shaping floor on top (outside the lanes)')
    tm.setSeedBudget(budget({ H: 512 * KiB, K: 0, E: 0 }))
    assert.equal(lastThrottle(), 512 * KiB + 32768, 'K closed')
    tm.setSeedBudget(budget({ H: 0, K: 0, E: 0 }))
    assert.equal(lastThrottle(), -1, 'every lane off: choke locks, never throttleUpload(0)')
    assert.ok(!client().throttles.includes(0))
    tm.destroy()
  })

  test('other swarms keep the v0.3 rules; null turns the lanes off again', async () => {
    const { tm } = manager({ policy: { uploadsEnabled: false, uploadLimit: 0 } })
    const h = await ownUpload(tm)
    const e = await fileSwarm(tm, FILE)
    tm.setSeedBudget(budget({ H: 128 * KiB, K: 0, E: 0, row: 'metered' }))
    const hw = fakeWire({ peerId: 'h' })
    const ew = fakeWire({ peerId: 'e' })
    h.torrent.emit('wire', hw)
    e.torrent.emit('wire', ew)
    assert.equal(hw.__mwLock, undefined, 'H with the card goes out on a metered network')
    assert.ok(ew.__mwLock)
    tm.setSeedBudget(null)
    assert.ok(!hw.__mwLock, 'v0.3: the per-upload exception')
    assert.ok(ew.__mwLock, 'v0.3: uploads off')
    assert.equal(lastThrottle(), CONFIG.policy.mobileOptInUploadLimit)
    tm.destroy()
  })
})

describe('the planner', () => {
  test('idle items are locked; a share below 1 gets its own bucket', async () => {
    const plans = []
    const { tm } = manager({
      planSeeding: (args) => {
        plans.push(args)
        return { order: [FILE, OTHER], idle: ['c'.repeat(40)], share: { [FILE]: 0.5, [OTHER]: 0.5 } }
      }
    })
    const a = await fileSwarm(tm, FILE, { lane: 'K' })
    const b = await fileSwarm(tm, OTHER, { lane: 'K' })
    const c = await fileSwarm(tm, 'c'.repeat(40), { lane: 'K' })
    tm.setSeedBudget(budget({ K: 256 * KiB }))
    const last = plans.at(-1)
    assert.equal(typeof last.now, 'number', 'the planner gets the now timestamp')
    assert.deepEqual(last.items.map((i) => i.lane).sort(), ['K', 'K', 'K'])
    const wa = fakeWire({ peerId: 'a' })
    const wb = fakeWire({ peerId: 'b' })
    const wc = fakeWire({ peerId: 'c' })
    a.torrent.emit('wire', wa)
    b.torrent.emit('wire', wb)
    c.torrent.emit('wire', wc)
    assert.ok(wc.__mwLock, 'idle in the plan')
    wa.up(130 * KiB)
    assert.ok(wa.__mwLock, 'half of 256 KiB/s: its own bucket is empty')
    assert.equal(wb.__mwLock, undefined, 'the other item keeps its share')
    tm.destroy()
  })

  test('with lane seed-policy\'s planner: an incomplete E item is idle until it is complete here', async () => {
    const { tm, clock } = manager()
    const e = await fileSwarm(tm, FILE)
    tm.setSeedBudget(seedBudget({ isMobile: false, networkClass: 'wifi' }, {}))
    const w = fakeWire({ peerId: 'x' })
    e.torrent.emit('wire', w)
    assert.ok(w.__mwLock, 'E skips what is not complete here (a partial copy never makes an item available)')
    e.torrent.finish()
    await flush()
    await clock.advance(1)
    assert.equal(w.__mwLock, null, 'complete: E echoes it')
    tm.destroy()
  })
})

describe('evidence and the hand-off', () => {
  test('complete bitfields make E1; an event per change; a closed holder counts for 60 s', async () => {
    const { tm, clock } = manager()
    const h = await ownUpload(tm)
    h.torrent.finish()
    const events = []
    tm.addEventListener('evidence', (e) => events.push(e.detail))
    const handleEvents = []
    h.on('evidence', (d) => handleEvents.push(d.evidence))
    const w = fakeWire({ peerId: 'bo' })
    h.torrent.emit('wire', w)
    await clock.advance(300)
    const first = events.at(-1)
    assert.equal(first.infoHash, MINE)
    assert.equal(first.kind, 'file')
    assert.equal(first.evidence.label, 'avail.onlyHere')
    w.complete()
    await clock.advance(300)
    const ev = events.at(-1).evidence
    assert.equal(ev.label, 'avail.heldBy')
    assert.equal(ev.count, 1)
    assert.equal(ev.reported, true)
    assert.equal(handleEvents.at(-1).count, 1, 'the handle emits it too')
    assert.equal(h.evidence().count, 1)
    const n = events.length
    await clock.advance(300)
    assert.equal(events.length, n, 'no event without a change')
    w.destroy()
    await clock.advance(30000)
    assert.equal(h.evidence().count, 1, 'a holder seen within 60 s still counts')
    await clock.advance(40000)
    assert.equal(h.evidence().count, 0)
    assert.equal(events.at(-1).evidence.label, 'avail.onlyHere', 'the expiry is announced (periodic check)')
    tm.destroy()
  })

  test('H ends at two complete peer copies: the handle moves to K', async () => {
    const { tm, clock } = manager()
    const h = await ownUpload(tm)
    h.torrent.finish()
    const lanes = []
    h.on('lane', (d) => lanes.push(d))
    const a = fakeWire({ peerId: 'a' })
    const b = fakeWire({ peerId: 'b' })
    h.torrent.emit('wire', a)
    h.torrent.emit('wire', b)
    // DS-4 (integrator): have-all claims before any piece was sent end nothing.
    a.complete()
    b.complete()
    await clock.advance(300)
    assert.equal(h.lane, 'H', 'two claimed copies that got nothing from this device are not a hand-off')
    a.up(65536)
    await clock.advance(300)
    assert.equal(h.lane, 'H', 'one served peer copy is not enough')
    b.up(65536)
    b.complete()
    await clock.advance(300)
    assert.equal(h.lane, 'K')
    assert.equal(h.handedOff, true)
    assert.equal(h.uploadException, false)
    assert.deepEqual(lanes, [{ lane: 'K', reason: 'peers' }])
    tm.destroy()
  })

  test('H ends at a pin receipt from the pin source; kept by the site', async () => {
    const { tm, clock } = manager()
    const h = await ownUpload(tm)
    h.torrent.finish()
    let receipt = null
    const pinWires = new Set()
    tm.setPinSource({
      evidence: () => ({ configured: true, receipt, heartbeat: null }),
      isPinWire: (w) => pinWires.has(w),
      pinProgress: () => (pinWires.size ? 50 : null)
    })
    const pw = fakeWire({ peerId: 'pin' })
    h.torrent.emit('wire', pw)
    pinWires.add(pw)
    tm.notePin(MINE)
    await clock.advance(300)
    assert.equal(h.evidence().pinPct, 50, 'the hand-off percentage for "Sending to the site"')
    receipt = { at: clock.now(), total: 65536 }
    tm.notePin(MINE)
    await clock.advance(300)
    assert.equal(h.lane, 'K')
    const ev = h.evidence()
    assert.equal(ev.label, 'avail.keptBySite')
    assert.equal(ev.tier, 'E4')
    tm.destroy()
  })
})

describe('super-seeding (CONFIG.seed.superSeed)', () => {
  const on = Object.assign({}, CONFIG, { seed: Object.assign({}, CONFIG.seed, { superSeed: true }) })

  test('an H torrent on a phone masks its first message and reveals one piece; a receipt stops it', async () => {
    const { tm, clock } = manager({ config: on, policy: { deviceClass: 'phone' } })
    const h = await ownUpload(tm)
    h.torrent.finish()
    let receipt = null
    tm.setPinSource({ evidence: () => ({ configured: true, receipt, heartbeat: null }), isPinWire: () => false })
    const w = fakeWire({ peerId: 'bo', pieces: 4 })
    h.torrent.emit('wire', w)
    w.bitfield(new Bits(4, true)) // what webtorrent sends after the wire event
    assert.deepEqual(w.sent[0], ['bitfield', [0]])
    assert.equal(w.sent.filter((m) => m[0] === 'have').length, 1)
    receipt = { at: clock.now() }
    tm.notePin(MINE)
    await clock.advance(300)
    assert.equal(w.sent.filter((m) => m[0] === 'have').length, 4, 'every piece revealed at the stop')
    assert.equal(tm._superseeds.size, 0)
    tm.destroy()
  })

  test('not on a desktop, not without the flag, not for E or K', async () => {
    const desk = manager({ config: on, policy: { deviceClass: 'desktop' } })
    const h1 = await ownUpload(desk.tm)
    const w1 = fakeWire({ peerId: 'a' })
    h1.torrent.emit('wire', w1)
    w1.bitfield(new Bits(4, true))
    assert.deepEqual(w1.sent[0], ['bitfield', [1, 1, 1, 1]], 'unmasked (the fake bitfield is its buffer)')
    desk.tm.destroy()
    const off = manager({ policy: { deviceClass: 'phone' } })
    const h2 = await ownUpload(off.tm)
    const w2 = fakeWire({ peerId: 'b' })
    h2.torrent.emit('wire', w2)
    assert.equal(off.tm._superseeds.size, 0)
    off.tm.destroy()
    const phone = manager({ config: on, policy: { deviceClass: 'phone' } })
    const k = await fileSwarm(phone.tm, FILE, { lane: 'K' })
    k.torrent.emit('wire', fakeWire({ peerId: 'c' }))
    assert.equal(phone.tm._superseeds.size, 0)
    phone.tm.destroy()
  })
})

describe('read-only state for the SDK', () => {
  test('seeding: lanes with rate, session, used and open; month used and cap; setSeedMeters checks its argument', async () => {
    const meters = fakeMeters({ month: 5 })
    const { tm } = manager({ meters })
    assert.equal(tm.seeding.active, false)
    tm.setSeedBudget(budget({ K: 256 * KiB, month: 1000 }))
    const s = tm.seeding
    assert.equal(s.active, true)
    assert.equal(s.row, 'desktop')
    assert.equal(s.lanes.K.rate, 256 * KiB)
    assert.equal(s.lanes.K.open, true)
    assert.deepEqual(s.month, { used: 5, cap: 1000 })
    assert.throws(() => tm.setSeedMeters({}), TypeError)
    const other = fakeMeters({ month: 2000 })
    tm.setSeedMeters(other)
    assert.equal(tm.seeding.lanes.K.open, false, 'the new meters say the month is used up')
    assert.equal(tm.meters, other)
    tm.destroy()
  })
})

// ---- mw_pin1 through the real manager: extension seam, anchorWire, receipts, the hand-off ---------------------

/** BEP 10 on the lanes' fake wire: use(), extended() to the paired wire, the extended handshake. */
function bep10 (w) {
  w.extendedMapping = {}
  w._ext = {}
  w._nextExt = 1
  w.peerExtendedMapping = {}
  w.use = function (Ext) { const name = Ext.prototype.name; const h = new Ext(this); this.extendedMapping[this._nextExt++] = name; this._ext[name] = h; this[name] = h }
  w.extended = function (name, bytes) {
    const peer = this.peer
    if (!peer || peer.destroyed || !this.peerExtendedMapping[name]) return
    const h = peer._ext[name]
    if (h) setImmediate(() => h.onMessage(bytes))
  }
  w.handshakeExt = function () {
    const m = {}
    for (const [id, name] of Object.entries(this.extendedMapping)) m[name] = Number(id)
    this.peer.peerExtendedMapping = m
    for (const h of Object.values(this.peer._ext)) h.onExtendedHandshake({ m })
  }
  return w
}

describe('mw_pin1 on the real manager', () => {
  test('the pin page authenticates on a file wire, the browser anchors it, the receipt ends H and labels it kept', async () => {
    const { publicKey, privateKey } = await generateKeyPair()
    const pinPub = await exportPublicKey(publicKey)
    const browser = manager()
    const pinSide = manager()
    const h = await ownUpload(browser.tm)
    h.torrent.finish()
    const held = await fileSwarm(pinSide.tm, MINE, { lane: 'K' })
    const win = {}
    win.top = win
    win.__mwPinCall = async (op, arg) => {
      if (op === 'pin.key') return pinPub
      if (op === 'pin.sign') return b64url.encode(await sign(privateKey, b64url.decode(arg)))
      throw new Error('E_BAD_REQUEST')
    }
    const pwB = createPinWire({ tm: browser.tm, pinKey: () => pinPub, win: {}, now: () => browser.clock.now() }).attach()
    const pwP = createPinWire({ tm: pinSide.tm, pinKey: () => pinPub, win, now: () => browser.clock.now() }).attach()
    await pwB.ready
    await pwP.ready
    const bw = bep10(fakeWire({ peerId: 'pin-node' }))
    const pw = bep10(fakeWire({ peerId: 'phone' }))
    bw.peer = pw
    pw.peer = bw
    h.torrent.emit('wire', bw)
    held.torrent.emit('wire', pw)
    bw.handshakeExt()
    pw.handshakeExt()
    for (let i = 0; i < 20; i++) await flush()
    await until(() => pwB.isPinWire(bw))
    assert.equal(pwB.isPinWire(bw), true, 'hello verified for the item\'s infohash')
    assert.equal(browser.tm._wireInfo.get(bw).anchored, true, 'anchorWire: the pin keeps its slot through caps and the idle close')
    assert.equal(h.lane, 'H', 'no receipt yet: the pin does not hold every piece')
    held.torrent.length = 65536 // its metadata (webtorrent sets these once the info dictionary is known)
    held.torrent.pieceLength = 16384
    held.torrent.finish() // the pin now holds every piece, verified
    await pinSide.clock.advance(300) // its evidence event reaches its PinWire: the receipt goes out
    for (let i = 0; i < 20; i++) await flush()
    await until(() => !!pwB.receipt(MINE))
    assert.equal(pwB.receipt(MINE).total, 65536)
    await browser.clock.advance(300)
    assert.equal(h.lane, 'K', 'H ended at the receipt')
    const ev = h.evidence()
    assert.equal(ev.label, 'avail.keptBySite')
    assert.equal(ev.tier, 'E4')
    void utf8
    browser.tm.destroy()
    pinSide.tm.destroy()
  })

  test('createPinPageHost: window.__mwPinHost start, stop and status for tools/pin.mjs', async () => {
    const { tm } = manager()
    const stores = []
    const host = createPinPageHost({ tm, storeClass: (ih) => { stores.push(ih); return FakeStore }, announce: () => ['wss://own.example'] })
    assert.equal(await host.start({ ih: 'nope' }), 'bad-ih')
    assert.equal(await host.start({ ih: FILE.toUpperCase(), name: 'x', size: 10 }), 'seeding')
    assert.equal(await host.start({ ih: FILE }), 'seeding', 'again: the live handle')
    assert.deepEqual(stores, [FILE], 'one store per pinned item')
    const h = tm._files.get(FILE)
    assert.equal(h.lane, 'K')
    const w = fakeWire({ peerId: 'member' })
    h.torrent.emit('wire', w)
    w.up(5000)
    w.up(3000)
    assert.deepEqual(host.status(), { files: [{ ih: FILE, uploaded: 8000, complete: false }] })
    h.torrent.finish()
    assert.equal(host.status().files[0].complete, true)
    assert.equal(await host.stop(FILE), 'stopped')
    assert.equal(h.left, true)
    assert.equal(await host.stop(FILE), 'not-held')
    assert.deepEqual(host.status(), { files: [] })
    assert.throws(() => createPinPageHost({}), TypeError)
    tm.destroy()
  })

  test('integrator (rows-media D-2): the pin keeps the .torrent beside the bytes and starts from it again with nobody online', async () => {
    const calls = []
    const TF = new Uint8Array([100, 101])
    const fakeTm = {
      async addFileTorrent (o) {
        calls.push(o.torrentFile ? 'file' : 'ih')
        return { left: false, uploaded: 0, done: false, metadata: async () => TF, async leave () { this.left = true } }
      }
    }
    const kept = new Map()
    const torrentFiles = { get: async (ih) => kept.get(ih) || null, put: async (ih, b) => { kept.set(ih, b) } }
    const host = createPinPageHost({ tm: fakeTm, storeClass: () => FakeStore, torrentFiles })
    assert.equal(await host.start({ ih: FILE }), 'seeding')
    await until(() => kept.has(FILE))
    assert.deepEqual(Array.from(kept.get(FILE)), [100, 101], 'the info dictionary is kept once it is known')
    assert.equal(await host.stop(FILE), 'stopped')
    assert.equal(await host.start({ ih: FILE }), 'seeding')
    assert.deepEqual(calls, ['ih', 'file'], 'the restart passes the kept .torrent, so no peer has to send the metadata')
    const refusing = { async addFileTorrent (o) { if (o.torrentFile) throw new Error('another infohash'); calls.push('ih2'); return { left: false, metadata: async () => TF } } }
    const host2 = createPinPageHost({ tm: refusing, storeClass: () => FakeStore, torrentFiles })
    assert.equal(await host2.start({ ih: FILE }), 'seeding', 'a kept copy that does not match falls back to the infohash')
    assert.equal(calls[calls.length - 1], 'ih2')
    // MAL53-3: an item the ledger denies is never joined.
    const before = calls.length
    const host3 = createPinPageHost({ tm: fakeTm, storeClass: () => FakeStore, isDenied: async (ih) => ih === FILE })
    assert.equal(await host3.start({ ih: FILE }), 'denied')
    assert.equal(calls.length, before, 'no swarm joined')
  })
})
