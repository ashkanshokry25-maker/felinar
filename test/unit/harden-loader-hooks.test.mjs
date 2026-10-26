// harden-loader (v0.3 hooks, INTERFACES "src/loader/torrent.js (hook added by the hardening wave)"; R 2.7.1, 2.8;
// MF-39, MF-44, MF-45): addFileTorrent with an injected store retained across rebuild(), own trackers only,
// leave() once saved, the per-upload exception; joinLane; registerWireExtension only on the listed swarms,
// after the wire guard. Run: node --test test/unit/harden-loader-hooks.test.mjs
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { TorrentManager, FileTorrentHandle, LaneHandle } from '../../src/loader/torrent.js'
import { CONFIG } from '../../src/loader/config.js'

const BTIH = 'a'.repeat(40)
const FILE = 'f'.repeat(40)
const INFO = new Uint8Array([0x64, 0x31, 0x3a, 0x61, 0x69, 0x31, 0x65, 0x65]) // d1:ai1ee
const TORRENT = new Uint8Array([9, 9, 9])
const FILE_PARSED = { infoHash: FILE, name: 'clip.bin', pieceLength: 16384, length: 40000, files: [{ path: 'clip.bin', length: 40000, offset: 0 }], infoBytes: INFO, announce: ['wss://tracker.webtorrent.dev'], urlList: ['https://ws.example/'] }

class Emitter {
  constructor () { this._l = new Map() }
  on (t, fn) { if (!this._l.has(t)) this._l.set(t, []); this._l.get(t).push(fn); return this }
  once (t, fn) { const w = (...a) => { this.removeListener(t, w); fn(...a) }; return this.on(t, w) }
  removeListener (t, fn) { const l = this._l.get(t); if (l) { const i = l.indexOf(fn); if (i !== -1) l.splice(i, 1) } return this }
  emit (t, ...a) { for (const fn of (this._l.get(t) || []).slice()) fn(...a); return true }
}

class FakeTorrent extends Emitter {
  constructor (source, opts) { super(); this.source = source; this.opts = opts; this.destroyed = false; this.infoHash = FILE }
  destroy (opts) { this.destroyed = true; this.destroyOpts = opts; this.emit('close') }
  // webtorrent's _onMetadata: builds the store from opts.store, or uses opts.preloadedStore.
  metadata (pieceLength = 16384, length = 40000) {
    this.store = this.opts.preloadedStore || new this.opts.store(pieceLength, { length, files: [] })
    this.bitfield = { buffer: new Uint8Array([0b11000000]) }
    this.emit('metadata')
  }
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
  w.chokes = 0
  w._onMessageLength = function () { return 'orig' }
  w._parse = function () {}
  w.choke = function () { this.chokes++ }
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

/** An abstract-chunk-store stand-in (lane media supplies IdbChunkStore); counts instances. */
class FakeIdbStore {
  constructor (chunkLength, opts = {}) { this.chunkLength = chunkLength; this.opts = opts; this.length = opts.length; this.data = new Map(); this.closed = false; FakeIdbStore.made.push(this) }
  put (i, b, cb) { this.data.set(i, b); cb && cb(null) }
  get (i, o, cb) { if (typeof o === 'function') cb = o; cb(null, this.data.get(i)) }
  close (cb) { this.closed = true; cb && cb(null) }
  destroy (cb) { this.closed = true; cb && cb(null) }
}
FakeIdbStore.made = []

function makeConsent (initial) {
  let allowed = initial
  const fns = new Set()
  return { peersAllowed: () => allowed, onChange: (fn) => fns.add(fn), set (v) { allowed = v; for (const fn of fns) fn() } }
}

function manager ({ consent = makeConsent(true), policy = {}, clock = new FakeClock() } = {}) {
  FakeWebTorrent.instances = []
  FakeIdbStore.made = []
  const tm = new TorrentManager({
    WebTorrent: FakeWebTorrent,
    config: CONFIG,
    policy: Object.assign({ maxConns: 30, uploadsEnabled: true, uploadLimit: 1048576, hostOnly: false, leaveVersionSwarm: false }, policy),
    consent,
    deps: {
      MemoryChunkStore: class {},
      BlobChunkStore: class {},
      parseTorrentFile: async (u8) => {
        if (u8 === TORRENT || (u8 && u8.length === 3 && u8[0] === 9)) return FILE_PARSED
        if (u8 && u8.length === 2) return { infoHash: BTIH, infoBytes: INFO }
        throw new Error('not a torrent')
      }
    },
    timers: clock,
    fetch: async () => { throw new TypeError('no network in unit tests') },
    baseUrl: 'https://site.example/page',
    lifecycle: false,
    random: () => 0.5
  })
  return { tm, clock, consent }
}

const lastTorrent = () => { const c = FakeWebTorrent.instances[FakeWebTorrent.instances.length - 1]; return c.torrents[c.torrents.length - 1] }

describe('addFileTorrent', () => {
  test('adds the info dictionary only, private, with the site\'s own trackers; the public defaults are dropped', async () => {
    const { tm } = manager()
    const warnings = []
    tm.addEventListener('warning', (e) => warnings.push(e.detail))
    const h = await tm.addFileTorrent({ torrentFile: TORRENT, store: FakeIdbStore, announce: ['wss://own.example/', CONFIG.trackers[0], 'wss://own.example', CONFIG.trackers[2], 'https://not-a-tracker.example'], retain: true })
    assert.ok(h instanceof FileTorrentHandle)
    assert.equal(h.infoHash, FILE)
    assert.equal(h.kind, 'file')
    assert.deepEqual(h.announce, ['wss://own.example'], 'own tracker only (MF-44), deduped')
    const t = h.torrent
    assert.equal(t.opts.private, true)
    assert.deepEqual(t.opts.announce, ['wss://own.example'])
    assert.equal(new TextDecoder().decode(t.source), 'd4:info' + new TextDecoder().decode(INFO) + 'e', 'the .torrent\'s own announce and url-list are not used')
    assert.deepEqual(warnings.filter((w) => w.code === 'file-public-tracker-dropped').map((w) => w.count), [4])
    assert.equal(await tm.addFileTorrent({ infoHash: FILE, store: FakeIdbStore }), h, 'the same infohash returns the live handle')
    tm.destroy()
  })

  test('the injected store survives rebuild() with its bitfield (MF-45); retain: false starts over', async () => {
    const { tm } = manager()
    const h = await tm.addFileTorrent({ torrentFile: TORRENT, store: FakeIdbStore, announce: ['wss://own.example'] })
    const t1 = h.torrent
    t1.metadata()
    assert.equal(FakeIdbStore.made.length, 1)
    const inner = FakeIdbStore.made[0]
    assert.equal(inner.opts.name, FILE, 'the store is named after the infohash')
    assert.equal(inner.chunkLength, 16384)
    t1.store.put(0, new Uint8Array([1, 2, 3]))
    tm.rebuild() // a 10 s app switch on a phone, consent change, host-only toggle
    assert.equal(t1.destroyed, true)
    assert.equal(inner.closed, false, 'destroying the torrent closes only its view')
    const t2 = h.torrent
    assert.notEqual(t2, t1)
    assert.ok(t2.opts.preloadedStore, 'resumes from the retained store')
    assert.deepEqual(Array.from(t2.opts.bitfield), [0b11000000], 'with the pieces it had')
    t2.metadata()
    assert.equal(FakeIdbStore.made.length, 1, 'no second store')
    await new Promise((resolve) => t2.store.get(0, {}, (err, buf) => { assert.equal(err, null); assert.deepEqual(Array.from(buf), [1, 2, 3]); resolve() }))
    // retain: false: the next rebuild builds a new store and no bitfield.
    const h2 = await tm.addFileTorrent({ infoHash: 'e'.repeat(40), store: FakeIdbStore, announce: ['wss://own.example'], retain: false })
    h2.torrent.metadata()
    tm.rebuild()
    assert.equal(h2.torrent.opts.preloadedStore, undefined)
    assert.equal(h2.torrent.opts.bitfield, undefined)
    assert.equal(typeof h2.torrent.opts.store, 'function')
    tm.destroy()
  })

  test('a store instance is accepted and retained the same way', async () => {
    const { tm } = manager()
    const store = new FakeIdbStore(16384, { length: 40000 })
    const h = await tm.addFileTorrent({ infoHash: FILE, store, announce: ['wss://own.example'] })
    assert.ok(h.torrent.opts.preloadedStore)
    h.torrent.opts.preloadedStore.close()
    assert.equal(store.closed, false, 'webtorrent closing its view leaves the instance open')
    assert.equal(h.store, store)
    tm.destroy()
  })

  test('leave() leaves the swarm once saved; leave({ now: true }) at once; no rejoin after rebuild', async () => {
    const { tm } = manager()
    const h = await tm.addFileTorrent({ torrentFile: TORRENT, store: FakeIdbStore, announce: ['wss://own.example'] })
    const t = h.torrent
    let left = false
    const p = h.leave().then((v) => { left = v })
    await flush()
    assert.equal(left, false, 'waits for the file to be saved')
    assert.equal(t.destroyed, false)
    t.emit('done')
    await p
    assert.equal(left, true)
    assert.equal(h.done, true)
    assert.equal(h.left, true)
    assert.deepEqual(t.destroyOpts, { destroyStore: false }, 'the saved data stays in the store')
    tm.rebuild()
    const live = FakeWebTorrent.instances.flatMap((c) => c.torrents).filter((x) => !x.destroyed)
    assert.equal(live.length, 0, 'not rejoined')
    const h2 = await tm.addFileTorrent({ infoHash: 'e'.repeat(40), store: FakeIdbStore, announce: ['wss://own.example'] })
    await h2.leave({ now: true })
    assert.equal(h2.left, true)
    tm.destroy()
  })

  test('waits for peer consent; rejects bad input', async () => {
    const consent = makeConsent(false)
    const { tm } = manager({ consent })
    const h = await tm.addFileTorrent({ infoHash: FILE, store: FakeIdbStore, announce: ['wss://own.example'] })
    assert.equal(h.torrent, null, 'no swarm before consent')
    consent.set(true)
    assert.ok(h.torrent, 'joins on consent')
    await assert.rejects(tm.addFileTorrent({ infoHash: FILE }), TypeError)
    await assert.rejects(tm.addFileTorrent({ store: FakeIdbStore }), TypeError)
    await assert.rejects(tm.addFileTorrent({ infoHash: 'xyz', store: FakeIdbStore }), TypeError)
    await assert.rejects(tm.addFileTorrent({ torrentFile: new Uint8Array(262145), store: FakeIdbStore }), (e) => e.code === 'E_BAD_TORRENT')
    await assert.rejects(tm.addFileTorrent({ torrentFile: TORRENT, infoHash: BTIH, store: FakeIdbStore }), (e) => e.code === 'E_BAD_TORRENT')
    await assert.rejects(tm.addFileTorrent({ torrentFile: new Uint8Array([7]), store: FakeIdbStore }), (e) => e.code === 'E_BAD_TORRENT')
    tm.destroy()
  })

  test('per-upload exception (MF-45): uploads off locks every wire except that file\'s; hidden locks it too', async () => {
    const { tm } = manager({ policy: { uploadsEnabled: false, uploadLimit: 0 } })
    const h = await tm.addFileTorrent({ infoHash: FILE, store: FakeIdbStore, announce: ['wss://own.example'], uploadException: true })
    const other = await tm.addFileTorrent({ infoHash: 'e'.repeat(40), store: FakeIdbStore, announce: ['wss://own.example'] })
    const mine = fakeWire({ peerId: 'bo' })
    const theirs = fakeWire({ peerId: 'cy' })
    h.torrent.emit('wire', mine)
    other.torrent.emit('wire', theirs)
    assert.equal(mine.__mwLock, undefined, 'the exempt infohash uploads')
    assert.ok(theirs.__mwLock, 'everything else stays choke-locked')
    const client = FakeWebTorrent.instances[0]
    assert.equal(client.throttles[client.throttles.length - 1], CONFIG.policy.mobileOptInUploadLimit, 'shaped at the opt-in rate')
    tm.setHiddenLock(true)
    assert.ok(mine.__mwLock, 'hidden: locked')
    tm.setHiddenLock(false)
    assert.equal(mine.__mwLock, null, 'visible again: the exception holds')
    h.setUploadException(false)
    assert.ok(mine.__mwLock)
    assert.equal(client.throttles[client.throttles.length - 1], -1)
    tm.destroy()
  })
})

describe('registerWireExtension', () => {
  async function withSwarms (tm, clock) {
    tm.download({ record: { btih: BTIH, signed: true, tr: ['wss://own.example'] } }).catch(() => {})
    await flush(); await flush()
    const site = FakeWebTorrent.instances[0].torrents[0]
    const p = tm.addRendezvous('mw1:abc', ['wss://own.example'])
    await untilJoinScheduled(tm)
    await clock.advance(CONFIG.ledger.joinJitterMs + 1)
    return { site, rv: await p }
  }

  test('onWire runs only for rendezvous wires (default), synchronously, after the length guard and before "wire"', async () => {
    const { tm, clock } = manager()
    const { site, rv } = await withSwarms(tm, clock)
    const seen = []
    const off = tm.registerWireExtension('mw_chat1', { onWire (wire, kind, opts) { seen.push({ id: wire.peerId, kind, guarded: wire.__mwGuard === true, late: opts.late }) } })
    const order = []
    tm.addEventListener('wire', (e) => order.push(['wire', e.detail.wire.peerId, seen.length]))
    site.emit('wire', fakeWire({ peerId: 'site-peer' }))
    rv.emit('wire', fakeWire({ peerId: 'rv-peer' }))
    rv.emit('wire', fakeWire({ type: 'webSeed' }))
    assert.deepEqual(seen, [{ id: 'rv-peer', kind: 'rendezvous', guarded: true, late: false }])
    assert.deepEqual(order.find((o) => o[1] === 'rv-peer'), ['wire', 'rv-peer', 1], 'before the wire event (extended handshake not sent yet)')
    off()
    rv.emit('wire', fakeWire({ peerId: 'after-off' }))
    assert.equal(seen.length, 1, 'unregistered')
    tm.destroy()
  })

  test('existing wires get one late call; other swarm lists; names are checked', async () => {
    const { tm, clock } = manager()
    const { site, rv } = await withSwarms(tm, clock)
    const early = fakeWire({ peerId: 'early' })
    rv.emit('wire', early)
    site.emit('wire', fakeWire({ peerId: 's1' }))
    const calls = []
    tm.registerWireExtension('mw_test1', { onWire (w, kind, o) { calls.push([w.peerId, kind, o.late]) } }, { swarms: ['rendezvous', 'site'] })
    assert.deepEqual(calls.sort(), [['early', 'rendezvous', true], ['s1', 'site', true]])
    rv.emit('wire', early) // the same wire again is not a second call
    assert.equal(calls.length, 2)
    assert.throws(() => tm.registerWireExtension('mw_test1', { onWire () {} }), (e) => e.code === 'E_EXISTS')
    for (const bad of ['ut_metadata', 'mw_chain1', 'Bad-Name', '', 'x'.repeat(40)]) assert.throws(() => tm.registerWireExtension(bad, { onWire () {} }), TypeError, bad)
    assert.throws(() => tm.registerWireExtension('mw_x', {}), TypeError)
    assert.throws(() => tm.registerWireExtension('mw_x', { onWire () {} }, { swarms: ['dht'] }), TypeError)
    assert.throws(() => tm.registerWireExtension('mw_x', { onWire () {} }, { swarms: [] }), TypeError)
    // A throwing extension is contained (a warning), the wire stays.
    const warnings = []
    tm.addEventListener('warning', (e) => warnings.push(e.detail.code))
    tm.registerWireExtension('mw_boom', { onWire () { throw new Error('boom') } })
    const w = fakeWire({ peerId: 'z' })
    rv.emit('wire', w)
    assert.ok(warnings.includes('extension-error'))
    assert.equal(w.destroyed, false)
    tm.destroy()
  })

  test('an oversized message is cut by the guard on an extension wire (the guard comes first)', async () => {
    const { tm, clock } = manager()
    const { rv } = await withSwarms(tm, clock)
    let guardedAtCall = null
    tm.registerWireExtension('mw_chat1', { onWire (w) { guardedAtCall = w._onMessageLength.name } })
    const w = fakeWire({ peerId: 'big' })
    rv.emit('wire', w)
    assert.equal(guardedAtCall, 'mwGuardedMessageLength')
    w._onMessageLength(new Uint8Array([0, 4, 0, 1])) // 262,145 bytes
    assert.equal(w.destroyed, true)
    tm.destroy()
  })
})

describe('joinLane', () => {
  test('chat and group lanes: own trackers only, left 1, rejoined after rebuild, counted in the budget', async () => {
    const { tm } = manager()
    const l = tm.joinLane({ kind: 'chat', infoHash: 'c'.repeat(40), announce: ['wss://own.example', CONFIG.trackers[1]] })
    assert.ok(l instanceof LaneHandle)
    assert.deepEqual(l.announce, ['wss://own.example'])
    const t = l.torrent
    assert.equal(t.source, 'c'.repeat(40))
    assert.deepEqual(t.opts.announce, ['wss://own.example'])
    assert.equal(t.opts.private, true)
    assert.equal(t.opts.getAnnounceOpts().left, 1)
    const w = fakeWire({ peerId: 'c1' })
    let cancelled = false
    w.ut_metadata = { cancel () { cancelled = true } }
    t.emit('wire', w)
    w.emit('extended', 'handshake', {})
    assert.equal(cancelled, true, 'nobody holds metadata for a lane')
    assert.equal(tm.budget.bySwarm.chat.counted, 1)
    tm.rebuild()
    assert.notEqual(l.torrent, t)
    assert.ok(l.torrent)
    assert.equal(tm.joinLane({ kind: 'chat', infoHash: 'c'.repeat(40) }), l)
    l.leave()
    assert.equal(l.left, true)
    const silent = tm.joinLane({ kind: 'group', infoHash: 'd'.repeat(40), announce: [CONFIG.trackers[0]] })
    assert.equal(silent.torrent, null, 'no own tracker, no announce to the public ones')
    assert.throws(() => tm.joinLane({ kind: 'site', infoHash: 'c'.repeat(40) }), TypeError)
    assert.throws(() => tm.joinLane({ kind: 'chat', infoHash: 'nope' }), TypeError)
    tm.destroy()
  })
})
