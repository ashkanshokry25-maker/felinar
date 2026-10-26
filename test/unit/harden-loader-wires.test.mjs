// harden-loader (v0.3, V03-DESIGN-REVIEW 2.7.1, 2.16.4; MF-39, MF-74, MF-75; ARCHITECTURE 15.10): caps by wire,
// ignored and idle wires closed, anchors and random tie eviction, 'no-progress', the ut_metadata limiter on the
// phone class, one wire budget per tab (priority and per-class totals).
// Run: node --test test/unit/harden-loader-wires.test.mjs
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import Wire from 'bittorrent-protocol'
import utMetadata from 'ut_metadata'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { TorrentManager, throttleUtMetadata, evictionOrder, SWARM_KINDS } from '../../src/loader/torrent.js'
import { computePolicy, wireBudgetFor, allocateWireBudget, budgetVictim, deviceClassOf, SWARM_PRIORITY } from '../../src/loader/policy.js'
import { CONFIG } from '../../src/loader/config.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BTIH = 'a'.repeat(40)

// ---- fakes (the shapes of test/unit/loader-app-torrent.test.mjs) ------------------------------------------------

class Emitter {
  constructor () { this._l = new Map() }
  on (t, fn) { if (!this._l.has(t)) this._l.set(t, []); this._l.get(t).push(fn); return this }
  once (t, fn) { const w = (...a) => { this.removeListener(t, w); fn(...a) }; return this.on(t, w) }
  removeListener (t, fn) { const l = this._l.get(t); if (l) { const i = l.indexOf(fn); if (i !== -1) l.splice(i, 1) } return this }
  emit (t, ...a) { for (const fn of (this._l.get(t) || []).slice()) fn(...a); return true }
}

class FakeTorrent extends Emitter {
  constructor (source, opts) { super(); this.source = source; this.opts = opts; this.destroyed = false; this.files = []; this.infoHash = BTIH }
  destroy (opts) { this.destroyed = true; this.destroyOpts = opts; this.emit('close') }
  addWebSeed () {}
}

class FakeWebTorrent extends Emitter {
  constructor (opts) { super(); this.opts = opts; this.torrents = []; this.destroyed = false; FakeWebTorrent.instances.push(this) }
  add (source, opts) { const t = new FakeTorrent(source, opts); this.torrents.push(t); return t }
  destroy () { this.destroyed = true; for (const t of this.torrents) if (!t.destroyed) t.destroy() }
  throttleUpload (r) { this.throttles = (this.throttles || []).concat(r) }
}
FakeWebTorrent.instances = []

function fakeWire ({ type = 'webrtc', peerId = null } = {}) {
  const w = new Emitter()
  w.type = type
  w.peerId = peerId
  w.destroyed = false
  w._onMessageLength = function () { return 'orig' }
  w._parse = function () {}
  w.choke = function () {}
  w.unchoke = function () {}
  w.setTimeout = function () {}
  w.setKeepAlive = function () {}
  w.destroy = function () { if (this.destroyed) return; this.destroyed = true; this.emit('close') }
  return w
}

class FakeClock {
  constructor () { this.t = 1000; this.timers = new Map(); this.id = 0 }
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

const deps = {
  MemoryChunkStore: class { constructor (c, o) { this.chunkLength = c; this.length = o.length } put (i, b, cb) { cb(null) } get (i, o, cb) { cb(null, new Uint8Array(1)) } close (cb) { cb && cb(null) } destroy (cb) { cb && cb(null) } },
  BlobChunkStore: class {},
  parseTorrentFile: async () => ({ infoHash: BTIH, name: 'x', pieceLength: 16384, length: 10, files: [{ path: 'x', length: 10, offset: 0 }], infoBytes: new Uint8Array([0x64, 0x65]) })
}

function manager ({ policy = {}, random = () => 0.5, clock = new FakeClock() } = {}) {
  FakeWebTorrent.instances = []
  const tm = new TorrentManager({
    WebTorrent: FakeWebTorrent,
    config: CONFIG,
    policy: Object.assign({ maxConns: 30, uploadsEnabled: true, uploadLimit: 1048576, hostOnly: false, leaveVersionSwarm: false }, policy),
    consent: { peersAllowed: () => true, onChange () {} },
    deps,
    timers: clock,
    fetch: async () => { throw new TypeError('no network in unit tests') },
    baseUrl: 'https://site.example/page',
    lifecycle: false,
    random
  })
  return { tm, clock }
}

async function siteTorrent (tm) {
  tm.download({ record: { btih: BTIH, signed: true, tr: ['wss://own.example'] } }).catch(() => {})
  await flush(); await flush()
  return FakeWebTorrent.instances[0].torrents[0]
}

async function rendezvousTorrent (tm, clock) {
  const p = tm.addRendezvous('mw1:abc', ['wss://own.example'])
  // The rendezvous infohash is a WebCrypto digest: wait until the jittered join is scheduled.
  for (let i = 0; i < 200 && !(tm.rendezvous && tm.rendezvous.joinTimer); i++) await flush()
  await clock.advance(CONFIG.ledger.joinJitterMs + 1)
  return p
}

function handshake (wires) { for (const w of wires) w.emit('extended', 'handshake', {}) }

// ---- caps by wire (MF-74) ---------------------------------------------------------------------------------------

describe('caps count wires, never peer ids', () => {
  test('one peer id on many wires is capped like many peers', async () => {
    const { tm } = manager({ policy: { maxConns: 3 } }) // soft 3, hard 5
    const t = await siteTorrent(tm)
    const wires = Array.from({ length: 9 }, () => fakeWire({ peerId: 'same-id' }))
    for (const w of wires) t.emit('wire', w)
    assert.deepEqual(t.opts.getAnnounceOpts(), { numwant: 0 }, 'the soft cap counts wires')
    handshake(wires)
    assert.equal(wires.filter((w) => !w.destroyed).length, 5, 'held to the hard cap of 5 wires')
    assert.equal(tm.swarmWires('site'), 5)
    assert.equal(tm.peers, 1, 'the peer count (display) still counts visitors')
    tm.destroy()
  })

  test('the emergency bound refuses the eleventh wire of one id before any handshake (2 x hard)', async () => {
    const { tm } = manager({ policy: { maxConns: 3 } })
    const t = await siteTorrent(tm)
    const wires = Array.from({ length: 12 }, () => fakeWire({ peerId: 'same-id' }))
    for (const w of wires) t.emit('wire', w)
    assert.equal(wires.filter((w) => w.destroyed).length, 2)
    tm.destroy()
  })

  test('random eviction among equal scores (no tenure tie-break); anchors keep their slots', async () => {
    const order = (seed) => {
      let x = seed
      return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648 }
    }
    const survivors = new Set()
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const { tm } = manager({ policy: { maxConns: 2 }, random: order(seed) }) // soft 2, hard 3
      const t = await siteTorrent(tm)
      const wires = Array.from({ length: 4 }, (_, i) => fakeWire({ peerId: 'p' + i }))
      for (const w of wires) t.emit('wire', w)
      handshake(wires)
      survivors.add(wires.map((w) => (w.destroyed ? 0 : 1)).join(''))
      tm.destroy()
    }
    assert.ok(survivors.size > 1, 'which equal wire goes depends on the random draw, not on its age')
    // Anchored wires (a verified piece) survive a flood of newcomers, up to anchorShare of the cap.
    const { tm } = manager({ policy: { maxConns: 2 } }) // hard 3: one anchor slot (floor(3 x 0.5))
    const t = await siteTorrent(tm)
    const honest = fakeWire({ peerId: 'honest' })
    t.emit('wire', honest)
    honest.emit('extended', 'handshake', {})
    honest.emit('piece', 7, 0, new Uint8Array(16))
    t.emit('verified', 7)
    const flood = Array.from({ length: 5 }, (_, i) => fakeWire({ peerId: 'syb' + i }))
    for (const w of flood) { w.downloaded = 1e6; t.emit('wire', w) }
    handshake(flood)
    assert.equal(honest.destroyed, false, 'the anchored wire keeps its slot against higher-scoring newcomers')
    assert.equal(flood.filter((w) => !w.destroyed).length, 2)
    tm.destroy()
  })

  test('evictionOrder: anchors protected up to anchorSlots, then lowest score, ties at random', () => {
    const e = (id, score, anchored = false) => ({ id, score, anchored })
    const list = [e('a', 5, true), e('b', 9, true), e('c', 0), e('d', 0), e('f', 100)]
    const drop = evictionOrder(list, { keep: 3, anchorSlots: 1, random: () => 0.5 })
    assert.deepEqual(drop.map((x) => x.id).sort(), ['c', 'd'])
    const drop2 = evictionOrder(list, { keep: 1, anchorSlots: 1, random: () => 0.5 })
    assert.equal(drop2.length, 4)
    assert.ok(!drop2.some((x) => x.id === 'b'), 'the best anchor is kept')
    assert.deepEqual(evictionOrder(list, { keep: 9 }), [])
  })
})

// ---- ignored and idle wires (MF-74) -----------------------------------------------------------------------------

describe('ignored and idle wires are closed', () => {
  test('ignoreWire() closes the wire at once; its peer id is not banned', async () => {
    const ctx = manager()
    const rv = await rendezvousTorrent(ctx.tm, ctx.clock)
    const w = fakeWire({ peerId: 'liar' })
    rv.emit('wire', w)
    assert.equal(ctx.tm.ignoreWire(w, 'invalid-frames'), true)
    assert.equal(w.destroyed, true)
    assert.equal(ctx.tm.failures.ignored, 1)
    assert.equal(ctx.tm.ignoreWire(w), false, 'once')
    const again = fakeWire({ peerId: 'liar' })
    rv.emit('wire', again)
    assert.equal(again.destroyed, false, 'a later wire with the same self-declared id is not refused (ids can be claimed)')
    ctx.tm.destroy()
  })

  test('a wire flagged __mwIgnored by an extension is closed by the periodic check', async () => {
    const { tm, clock } = manager()
    const rv = await rendezvousTorrent(tm, clock)
    const w = fakeWire({ peerId: 'x' })
    rv.emit('wire', w)
    w.__mwIgnored = true
    await clock.advance(CONFIG.wireLimits.checkMs + 1)
    assert.equal(w.destroyed, true)
    assert.equal(tm.failures.ignored, 1)
    tm.destroy()
  })

  test('idle close: 2 min of nothing but keep-alives after the handshake; messages and anchors keep a wire', async () => {
    const { tm, clock } = manager()
    const t = await siteTorrent(tm)
    const silent = fakeWire({ peerId: 's' })
    const keepAliveOnly = fakeWire({ peerId: 'k' })
    const chatty = fakeWire({ peerId: 'c' })
    const anchored = fakeWire({ peerId: 'a' })
    for (const w of [silent, keepAliveOnly, chatty, anchored]) t.emit('wire', w)
    tm.anchorWire(anchored)
    await clock.advance(60000)
    keepAliveOnly.emit('keep-alive')
    chatty.emit('have', 3)
    await clock.advance(60000 + CONFIG.wireLimits.checkMs)
    assert.equal(CONFIG.wireLimits.idleMs, 120000)
    assert.equal(silent.destroyed, true, 'silent 2 min after the handshake')
    assert.equal(keepAliveOnly.destroyed, true, 'keep-alives do not count')
    assert.equal(chatty.destroyed, false)
    assert.equal(anchored.destroyed, false)
    assert.equal(tm.failures.idle, 2)
    tm.destroy()
  })
})

// ---- no progress (MF-74: "peers but no progress" polls cs=) ------------------------------------------------------

test("'no-progress': a swarm with wires but nothing arriving; backs off; progress resets it", async () => {
  const { tm, clock } = manager()
  const rv = await rendezvousTorrent(tm, clock)
  const events = []
  tm.addEventListener('no-progress', (e) => events.push(e.detail))
  const w = fakeWire({ peerId: 'r1' })
  rv.emit('wire', w)
  tm.anchorWire(w) // anchored: not closed as idle, but no block since
  await clock.advance(CONFIG.wireLimits.noProgressMs + CONFIG.wireLimits.checkMs)
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'rendezvous')
  assert.equal(events[0].wires, 1)
  await clock.advance(CONFIG.wireLimits.noProgressMs)
  assert.equal(events.length, 1, 'the next one waits twice as long')
  await clock.advance(CONFIG.wireLimits.noProgressMs + CONFIG.wireLimits.checkMs)
  assert.equal(events.length, 2)
  tm.noteProgress('rendezvous') // the ledger says it is in sync
  await clock.advance(CONFIG.wireLimits.noProgressMs - CONFIG.wireLimits.checkMs)
  assert.equal(events.length, 2)
  tm.destroy()
})

// ---- ut_metadata limiter (MF-75) --------------------------------------------------------------------------------

describe('ut_metadata flood on the phone class', () => {
  const METADATA = new TextEncoder().encode('d6:lengthi10e4:name1:x12:piece lengthi16384e6:pieces20:' + 'a'.repeat(20) + 'e')

  function metadataWire () {
    const w = new Wire()
    w.on('error', () => {})
    w.use(utMetadata(METADATA))
    w.peerId = 'flooder'
    return w
  }

  const request = (piece) => new TextEncoder().encode('d8:msg_typei0e5:piecei' + piece + 'ee')

  test('beyond 4 requests per wire per minute are dropped once the metadata is complete; 60 s later 4 more', async () => {
    const policy = computePolicy({ isMobile: true, networkType: 'cellular' })
    assert.equal(policy.class, 'mobileMetered')
    assert.equal(policy.uploadsEnabled, false, 'the choke lock is on: ut_metadata answers would bypass it')
    const { tm, clock } = manager({ policy })
    const t = await siteTorrent(tm)
    const w = metadataWire()
    await w.ut_metadata.setMetadata(METADATA)
    assert.equal(w.ut_metadata._metadataComplete, true)
    let answered = 0
    w.ut_metadata._data = function () { answered++ }
    t.emit('wire', w)
    assert.equal(w.ut_metadata.__mwThrottle, true, 'installed on every peer wire')
    for (let i = 0; i < 50; i++) w.ut_metadata.onMessage(request(0))
    assert.equal(answered, 4)
    assert.equal(tm.failures.utMetadataDropped, 46)
    await clock.advance(60001)
    for (let i = 0; i < 10; i++) w.ut_metadata.onMessage(request(0))
    assert.equal(answered, 8)
    tm.destroy()
    w.destroy() // the real wire's keep-alive interval
  })

  test('before the metadata is complete requests are only rejected (cheap) and not counted', () => {
    const w = new Wire()
    w.on('error', () => {})
    w.use(utMetadata())
    let rejects = 0
    w.ut_metadata._reject = function () { rejects++ }
    assert.equal(throttleUtMetadata(w, { perMinute: 4, now: () => 0 }), true)
    assert.equal(throttleUtMetadata(w), false, 'once')
    for (let i = 0; i < 10; i++) w.ut_metadata.onMessage(request(0))
    assert.equal(rejects, 10)
    assert.equal(throttleUtMetadata(fakeWire()), false, 'no ut_metadata, nothing installed')
  })

  test('the patch point _onRequest exists in the vendored webtorrent bundle', () => {
    const bundle = readFileSync(ROOT + 'node_modules/webtorrent/dist/webtorrent.min.js', 'utf8')
    assert.match(bundle, /_onRequest\(\w+\)\{if\(!this\._metadataComplete\)/)
    assert.ok(bundle.includes('this.emit("verified",'), 'the verified event that anchors wires')
  })
})

// ---- one wire budget per tab (MF-39) ----------------------------------------------------------------------------

describe('one wire budget per tab across every swarm', () => {
  test('per-class totals: desktop 40, phones 8 (chosen), by device class', () => {
    assert.equal(wireBudgetFor('desktop'), 40)
    assert.equal(wireBudgetFor('phone'), 8)
    assert.equal(wireBudgetFor({ isMobile: true }), 8)
    assert.equal(wireBudgetFor('mobileUnknown'), 8)
    assert.equal(deviceClassOf({ isMobile: false, networkType: 'cellular' }), 'desktop', 'a desktop on a metered network keeps 40')
    assert.equal(computePolicy({ isMobile: true }).wireBudget, 8)
    assert.equal(computePolicy({ isMobile: false }).wireBudget, 40)
    assert.equal(computePolicy({ isMobile: false, saveData: true }).wireBudget, 40)
    assert.deepEqual(SWARM_PRIORITY, ['site', 'rendezvous', 'hub', 'chat', 'group', 'file']) // 'hub': review round R 5.3, SCALE-6
    assert.deepEqual(SWARM_KINDS.slice().sort(), SWARM_PRIORITY.slice().sort())
  })

  test('allocation and victims follow site > rendezvous > chat > group > file, floors first', () => {
    assert.deepEqual(allocateWireBudget(8, { site: 12, rendezvous: 5, file: 6 }), { site: 5, rendezvous: 2, hub: 0, chat: 0, group: 0, file: 1 })
    assert.deepEqual(allocateWireBudget(40, { site: 45, rendezvous: 9 }), { site: 38, rendezvous: 2, hub: 0, chat: 0, group: 0, file: 0 })
    assert.deepEqual(allocateWireBudget(3, { site: 5, rendezvous: 5, chat: 5 }), { site: 2, rendezvous: 1, hub: 0, chat: 0, group: 0, file: 0 })
    assert.equal(budgetVictim({ site: 4, rendezvous: 2, file: 2 }, 8), null)
    assert.equal(budgetVictim({ site: 4, rendezvous: 2, file: 3 }, 8), 'file')
    assert.equal(budgetVictim({ site: 4, rendezvous: 3, file: 1, chat: 1 }, 8), 'rendezvous', 'file and chat are at their floor')
    assert.equal(budgetVictim({ site: 7, rendezvous: 2, file: 1 }, 8), 'site')
    assert.equal(budgetVictim({ site: 2, rendezvous: 2, chat: 1, group: 1, file: 1 }, 6), 'file', 'all at floor: the lowest priority')
  })

  test('phone tab: site, rendezvous and file wires share 8; the file swarm gives way first', async () => {
    const policy = computePolicy({ isMobile: true, networkType: 'wifi' }) // mobileUnmetered: site soft 8 hard 12; rendezvous 3/5
    const { tm, clock } = manager({ policy })
    const site = await siteTorrent(tm)
    const rv = await rendezvousTorrent(tm, clock)
    const handle = await tm.addFileTorrent({ infoHash: 'f'.repeat(40), store: deps.MemoryChunkStore, announce: ['wss://own.example'] })
    const file = handle.torrent
    const fileWires = Array.from({ length: 3 }, (_, i) => fakeWire({ peerId: 'f' + i }))
    for (const w of fileWires) file.emit('wire', w)
    handshake(fileWires)
    const rvWires = Array.from({ length: 3 }, (_, i) => fakeWire({ peerId: 'r' + i }))
    for (const w of rvWires) rv.emit('wire', w)
    handshake(rvWires)
    assert.equal(tm.budget.used, 6)
    const siteWires = Array.from({ length: 5 }, (_, i) => fakeWire({ peerId: 's' + i }))
    for (const w of siteWires) site.emit('wire', w)
    assert.deepEqual(site.opts.getAnnounceOpts(), { numwant: 0 }, 'no offers once the tab is at its budget')
    handshake(siteWires)
    const b = tm.budget
    assert.equal(b.total, 8)
    assert.equal(b.used, 8)
    assert.equal(b.bySwarm.site.counted, 5, 'the site, highest priority, loses nothing')
    assert.equal(b.bySwarm.rendezvous.counted, 2, 'the rendezvous gives up wires down to its floor once files are at theirs')
    assert.equal(b.bySwarm.file.counted, 1, 'files go first, down to their floor of 1')
    assert.equal(fileWires.filter((w) => w.destroyed).length, 2)
    assert.equal(rvWires.filter((w) => w.destroyed).length, 1)
    assert.equal(siteWires.filter((w) => w.destroyed).length, 0)
    assert.equal(tm.failures.budget, 3)
    assert.deepEqual(Object.keys(b.bySwarm).sort(), SWARM_KINDS.slice().sort())
    assert.equal(b.bySwarm.site.allot + b.bySwarm.rendezvous.allot + b.bySwarm.file.allot <= 8, true)
    tm.destroy()
  })

  test('desktop tab: 40 wires in all, whatever the per-swarm caps', async () => {
    const { tm, clock } = manager({ policy: computePolicy({ isMobile: false, networkType: 'wifi' }) }) // site hard 45
    const site = await siteTorrent(tm)
    const rv = await rendezvousTorrent(tm, clock)
    const rvWires = Array.from({ length: 6 }, (_, i) => fakeWire({ peerId: 'r' + i }))
    for (const w of rvWires) rv.emit('wire', w)
    handshake(rvWires)
    const siteWires = Array.from({ length: 44 }, (_, i) => fakeWire({ peerId: 's' + i }))
    for (const w of siteWires) site.emit('wire', w)
    handshake(siteWires)
    assert.equal(tm.budget.total, 40)
    assert.equal(tm.budget.used, 40)
    assert.equal(tm.budget.bySwarm.rendezvous.counted, 2, 'the rendezvous keeps its floor')
    assert.equal(tm.budget.bySwarm.site.counted, 38)
    tm.destroy()
  })
})
