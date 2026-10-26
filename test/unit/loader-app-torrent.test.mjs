// Unit tests for src/loader/torrent.js (loader-app). Run: node --test test/unit/loader-app-torrent.test.mjs
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Wire from 'bittorrent-protocol'
import { createHash } from 'node:crypto'
import {
  TorrentManager, announceListFor, xsUrls, webseedBases, webseedFileUrl, minimalTorrentBytes, computeSource,
  trackerStateOf, classifyFailures, messageLength, guardWire, lockWire, unlockWire, RetainedStore, makeError,
  rendezvousInfoHash, orderWebseeds, reqqFor, wireScore, installTrackerShim, keepaliveAnnounce, bufferOverflow,
  readCappedBody
} from '../../src/loader/torrent.js'
import { CONFIG } from '../../src/loader/config.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BTIH = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)

// ---- fakes --------------------------------------------------------------------------------------

class Emitter {
  constructor () { this._l = new Map() }
  on (t, fn) { if (!this._l.has(t)) this._l.set(t, []); this._l.get(t).push(fn); return this }
  once (t, fn) { const w = (...a) => { this.removeListener(t, w); fn(...a) }; return this.on(t, w) }
  removeListener (t, fn) { const l = this._l.get(t); if (l) { const i = l.indexOf(fn); if (i !== -1) l.splice(i, 1) } return this }
  emit (t, ...a) { for (const fn of (this._l.get(t) || []).slice()) fn(...a); return true }
  listenerCount (t) { return (this._l.get(t) || []).length }
}

class FakeFile extends Emitter {
  constructor (path, length, content, type) { super(); this.path = path; this.length = length; this.done = false; this.content = content; this.type = type }
  async blob () { return new Blob([this.content], { type: this.type || '' }) }
}

class FakeTorrent extends Emitter {
  constructor (source, opts, client) {
    super()
    this.source = source
    this.opts = opts
    this.client = client
    this.wires = []
    this.files = []
    this.destroyed = false
    this.downloaded = 0
    this.length = 0
    this.done = false
    this.webSeeds = []
    this.discovery = null
    this.infoHash = BTIH
    this.uploaded = 0
  }

  destroy (opts) { this.destroyed = true; this.destroyOpts = opts; this.emit('close') }
  addWebSeed (url) { this.webSeeds.push(url) }
  removePeer (id) { this.removed = (this.removed || []).concat(id) }

  // Simulates webtorrent's metadata step: builds the store from opts.store like _onMetadata does.
  metadata (parsed, files) {
    this.length = parsed.length
    this.name = parsed.name
    this.files = files
    if (typeof this.opts.store === 'function') this.store = new this.opts.store(parsed.pieceLength, { length: parsed.length })
    this.bitfield = { buffer: new Uint8Array([0b10000000]) }
    this.emit('metadata')
  }

  finish () {
    this.done = true
    for (const f of this.files) { f.done = true; f.emit('done') }
    this.emit('done')
  }
}

class FakeWebTorrent extends Emitter {
  constructor (opts) { super(); this.opts = opts; this.torrents = []; this.destroyed = false; FakeWebTorrent.instances.push(this); this.maxConns = opts.maxConns }
  add (source, opts) { const t = new FakeTorrent(source, opts, this); this.torrents.push(t); return t }
  destroy () { if (this.destroyed) throw new Error('client already destroyed'); this.destroyed = true; for (const t of this.torrents) if (!t.destroyed) t.destroy() }
  throttleUpload (rate) { this.throttles = (this.throttles || []).concat(rate) }
}
FakeWebTorrent.instances = []

function fakeWire ({ type = 'webrtc', peerId = null } = {}) {
  const w = new Emitter()
  w.type = type
  w.peerId = peerId
  w.destroyed = false
  w.choked = 0
  w.timeouts = []
  w.keepAlive = []
  w._onMessageLength = function () { return 'orig' }
  w._parse = function (size, parser) { this._parserSize = size; this._parser = parser }
  w.choke = function () { this.choked++ }
  w.unchoke = function () { this.unchoked = (this.unchoked || 0) + 1 }
  w.setTimeout = function (ms, unref) { this.timeouts.push([ms, unref]) }
  w.setKeepAlive = function (v) { this.keepAlive.push(v) }
  w.destroy = function () { this.destroyed = true; this.emit('close') }
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
// The web seeds a torrent was given: at creation (urlList) or later, as their probes passed (addWebSeed).
function attached (t) { return ((t.opts && t.opts.urlList) || []).concat(t.webSeeds || []) }

const INFO = new Uint8Array([0x64, 0x31, 0x3a, 0x61, 0x69, 0x31, 0x65, 0x65]) // d1:ai1ee
const PARSED = {
  infoHash: BTIH,
  name: 'site',
  pieceLength: 16384,
  pieceCount: 1,
  length: 300,
  files: [
    { path: 'index.html', length: 200, offset: 0, pad: false },
    { path: '.pad/0', length: 0, offset: 200, pad: true },
    { path: 'css/app.css', length: 100, offset: 200, pad: false }
  ],
  announce: ['wss://from-torrent.example'],
  urlList: ['https://from-torrent.example/'],
  infoBytes: INFO
}
const TORRENT_BYTES = new Uint8Array([1, 2, 3, 4])

function deps (overrides = {}) {
  const calls = { built: [], blobStores: [] }
  return Object.assign({
    calls,
    MemoryChunkStore: class { constructor (chunkLength, opts) { this.chunkLength = chunkLength; this.length = opts.length; this.data = new Map() } put (i, b, cb) { this.data.set(i, b); cb(null) } get (i, o, cb) { cb(null, this.data.get(i)) } close (cb) { cb && cb(null) } destroy (cb) { cb && cb(null) } },
    BlobChunkStore: class { constructor (chunkLength, opts) { this.chunkLength = chunkLength; this.opts = opts; calls.blobStores.push(this) } put (i, b, cb) { cb(null) } get (i, o, cb) { cb(this.fail ? new Error('piece verification failed') : null, new Uint8Array(1)) } close (cb) { cb && cb(null) } destroy (cb) { cb && cb(null) } },
    parseTorrentFile: async (u8) => {
      if (u8 === TORRENT_BYTES || (u8 && u8.length === 4 && u8[0] === 1)) return PARSED
      if (u8 && u8.length === 9) return { infoHash: OTHER }
      if (u8 && u8.anchor) return { infoHash: 'c'.repeat(40), name: 'mw-ledger', pieceLength: 16384, length: 20, files: [{ path: 'mw-ledger', length: 20, offset: 0 }], infoBytes: INFO }
      return PARSED
    },
    buildSingleFileTorrent: async (args) => { calls.built.push(args); const t = new Uint8Array(3); t.anchor = true; return { torrentFile: t, infoHash: 'c'.repeat(40) } }
  }, overrides)
}

function fetchStub (routes) {
  const log = []
  const f = async (url, init = {}) => {
    log.push({ url, init })
    const r = routes[url]
    if (!r) throw new TypeError('Failed to fetch')
    if (r === 'throw') throw new TypeError('Failed to fetch')
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      body: { cancel () { r.cancelled = true } },
      headers: { get: () => null },
      arrayBuffer: async () => (r.body || new Uint8Array(1)).buffer.slice(0)
    }
  }
  f.log = log
  return f
}

function makeConsent (initial) {
  let allowed = initial
  const fns = new Set()
  return { peersAllowed: () => allowed, onChange: (fn) => fns.add(fn), set (v) { allowed = v; for (const fn of fns) fn() } }
}

function manager ({ consent = makeConsent(true), policy = {}, d = deps(), fetch = fetchStub({}), clock = new FakeClock(), lifecycle = false, random = () => 0.5 } = {}) {
  FakeWebTorrent.instances = []
  const tm = new TorrentManager({ WebTorrent: FakeWebTorrent, config: CONFIG, policy: Object.assign({ maxConns: 30, uploadsEnabled: true, uploadLimit: 1048576, hostOnly: false, leaveVersionSwarm: false }, policy), consent, deps: d, timers: clock, fetch, baseUrl: 'https://site.example/page', lifecycle, random })
  return { tm, clock, d, fetch, consent }
}

/** A bittorrent-tracker WebSocketTracker stand-in with the fields the shim, keepalive and kick use. */
function fakeTracker (url, { connected = true, client = null } = {}) {
  const t = {
    announceUrl: url,
    socket: { connected },
    retries: 0,
    reconnecting: false,
    destroyed: false,
    interval: null,
    sent: [],
    announces: [],
    scrapes: 0,
    opened: 0,
    intervals: [],
    client: client || { destroyed: false, _defaultAnnounceOpts: (o = {}) => Object.assign({ numwant: 50, uploaded: 0, downloaded: 0 }, o, { numwant: 3 }) },
    _send (params) { this.sent.push(params) },
    announce (opts) { this.announces.push(opts); this._send(Object.assign({ action: 'announce' }, opts)) },
    scrape () { this.scrapes++ },
    _openSocket () { this.opened++; this.destroyed = false; this.socket = { connected: true }; this.reconnecting = false },
    _startReconnectTimer () { throw new Error('stock reconnect timer used') },
    setInterval (ms) { this.intervals.push(ms); this.interval = ms ? {} : null }
  }
  return t
}

function trackerClient (trackers) {
  const tc = Object.assign(new Emitter(), { _trackers: trackers, updates: 0, update () { this.updates++ }, _defaultAnnounceOpts: (o) => Object.assign({ uploaded: 0 }, o) })
  return tc
}

const SIGNED = { btih: BTIH, signed: true, tr: ['wss://own.example/', 'wss://own.example', 'https://not-a-tracker'], xs: ['https://cdn.example/site.torrent'], ws: ['https://cdn.example/ws/'], dn: 'Site' }

/** Waits (real event-loop turns, not the fake clock) until addRendezvous has hashed and scheduled its join. */
async function scheduled (tm) {
  await untilJoinScheduled(tm)
}

// ---- pure helpers ---------------------------------------------------------------------------------

describe('pure helpers', () => {
  test('announceListFor: signed pointer uses exactly its tr list (deduped, wss/ws only)', () => {
    assert.deepEqual(announceListFor(SIGNED, ['wss://default.example']), ['wss://own.example'])
    assert.deepEqual(announceListFor({ signed: true, tr: [] }, ['wss://d']), [])
  })

  test('announceListFor: unsigned pointer adds the defaults after its own trackers', () => {
    assert.deepEqual(announceListFor({ signed: false, tr: ['wss://a.example'] }, ['wss://b.example', 'wss://a.example']), ['wss://a.example', 'wss://b.example'])
    assert.deepEqual(announceListFor({ tr: [] }), CONFIG.trackers)
  })

  test('xsUrls and webseedBases resolve relative URLs and keep only http(s)', () => {
    assert.deepEqual(xsUrls({ xs: ['/_mw/t/x.torrent', 'ftp://no', 'https://a.example/b.torrent'] }, 'https://host.example/page'), ['https://host.example/_mw/t/x.torrent', 'https://a.example/b.torrent'])
    assert.deepEqual(webseedBases({ ws: ['/_mw/ws/'] }, 'https://host.example/x'), ['https://host.example/_mw/ws/'])
    assert.deepEqual(xsUrls({}, 'https://x'), [])
  })

  test('webseedFileUrl mirrors webconn.js: verbatim for single-file, <ws>/<name>/<path> otherwise', () => {
    assert.equal(webseedFileUrl('https://s.example/file.bin', { name: 'file.bin', files: [{ path: 'file.bin', length: 5 }] }), 'https://s.example/file.bin')
    assert.equal(webseedFileUrl('https://s.example/ws', PARSED), 'https://s.example/ws/site/index.html')
    assert.equal(webseedFileUrl('https://s.example/ws/', { name: 'n', files: [{ path: 'empty', length: 0 }, { path: 'pad', length: 3, pad: true }, { path: 'a/b.js', length: 4 }] }), 'https://s.example/ws/n/a/b.js')
    assert.equal(webseedFileUrl('', PARSED), null)
  })

  test('minimalTorrentBytes wraps the info dict as d4:info<info>e', () => {
    const out = minimalTorrentBytes(INFO)
    assert.equal(new TextDecoder().decode(out), 'd4:info' + new TextDecoder().decode(INFO) + 'e')
  })

  test('computeSource', () => {
    assert.equal(computeSource({ fromCache: true }), 'cache')
    assert.equal(computeSource({ peerBytes: 1, webseedBytes: 1 }), 'mixed')
    assert.equal(computeSource({ webseedBytes: 1 }), 'webseed')
    assert.equal(computeSource({ peerBytes: 1 }), 'peers')
    assert.equal(computeSource({}), null)
  })

  test('trackerStateOf reads bittorrent-tracker WebSocketTracker fields', () => {
    assert.equal(trackerStateOf({ socket: { connected: true } }), 'open')
    assert.equal(trackerStateOf({ socket: { connected: false } }), 'connecting')
    assert.equal(trackerStateOf({ destroyed: true, reconnecting: true }), 'reconnecting')
    assert.equal(trackerStateOf({ destroyed: true }), 'closed')
    assert.equal(trackerStateOf(null), 'closed')
  })

  test('messageLength reads the prefix unsigned', () => {
    assert.equal(messageLength(new Uint8Array([0xff, 0xff, 0xff, 0xff])), 4294967295)
    assert.equal(messageLength(new Uint8Array([0x7f, 0xff, 0xff, 0xff])), 2147483647)
    assert.equal(messageLength(new Uint8Array([0, 0, 1, 0])), 256)
  })

  test('makeError carries code and extras', () => {
    const e = makeError('E_TOO_LARGE', 'big', { length: 5 })
    assert.equal(e.code, 'E_TOO_LARGE')
    assert.equal(e.length, 5)
  })
})

describe('failure matrix classification (S5)', () => {
  test('no web seed in the pointer', () => {
    assert.deepEqual(classifyFailures({ hasWebseed: false, peersAllowed: false }).map((r) => r.row), ['no-webseed'])
  })
  test('misconfigured web seed', () => {
    assert.deepEqual(classifyFailures({ webseed: 'no-range', peersAllowed: false })[0], { row: 'webseed-broken', detail: 'no-range' })
    assert.equal(classifyFailures({ webseed: 'ok', peersAllowed: false }).length, 0)
  })
  test('tracker unreachable only after the grace period and when no tracker is open', () => {
    const trackers = { 'wss://a': 'reconnecting', 'wss://b': 'connecting' }
    assert.equal(classifyFailures({ trackers, elapsedMs: 1000 }).length, 0)
    const rows = classifyFailures({ trackers, elapsedMs: 6000 })
    assert.equal(rows[0].row, 'tracker-unreachable')
    assert.equal(rows[0].detail, '2/2')
    assert.equal(classifyFailures({ trackers: { 'wss://a': 'open', 'wss://b': 'closed' }, elapsedMs: 9000 }).length, 0)
  })
  test('failed peer connections are likely NAT when nobody connected', () => {
    const rows = classifyFailures({ trackers: { 'wss://a': 'open' }, iceFailed: 3, peers: 0, elapsedMs: 10000 })
    assert.deepEqual(rows, [{ row: 'nat', count: 3 }])
    assert.equal(classifyFailures({ trackers: { 'wss://a': 'open' }, iceFailed: 3, peers: 1 }).length, 0)
  })
  test('nobody online comes from announce complete/incomplete', () => {
    const rows = classifyFailures({ trackers: { 'wss://a': 'open' }, swarm: { reported: true, others: 0 }, peers: 0 })
    assert.deepEqual(rows.map((r) => r.row), ['nobody-online'])
    assert.equal(classifyFailures({ trackers: { 'wss://a': 'open' }, swarm: { reported: true, others: 2 } }).length, 0)
    assert.equal(classifyFailures({ trackers: { 'wss://a': 'open' }, swarm: { reported: true, others: 0 }, done: true }).length, 0)
  })
  test('host only and pending consent report only the web seed rows', () => {
    assert.deepEqual(classifyFailures({ hostOnly: true, hasWebseed: false, trackers: {}, elapsedMs: 99999 }).map((r) => r.row), ['no-webseed'])
  })
})

// ---- wire guard (DESIGN-REVIEW item 10) ---------------------------------------------------------------

describe('message length cap on real bittorrent-protocol wires', () => {
  const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
  const feed = (w, chunk) => new Promise((resolve) => w._write(chunk, resolve))

  for (const prefix of [0x7fffffff, 0xffffffff, 300 * 1024]) {
    test('a peer declaring ' + prefix + ' bytes is dropped at once and nothing is buffered', async () => {
      const w = new Wire()
      w.on('error', () => {})
      let dropped = null
      assert.equal(guardWire(w, { maxBytes: 262144, onDrop: (n) => { dropped = n } }), true)
      w._parse(4, w._onMessageLength)
      const t0 = performance.now()
      await feed(w, u32(prefix))
      for (let i = 0; i < 64; i++) await feed(w, new Uint8Array(16384))
      assert.equal(dropped, prefix)
      assert.equal(w.destroyed || w.__mwDropped, true)
      assert.ok(w._bufferSize <= 16384, 'buffer stays bounded, got ' + w._bufferSize)
      assert.ok(performance.now() - t0 < 1000)
    })
  }

  test('normal messages still parse and a second install is refused', async () => {
    const w = new Wire()
    w.on('error', () => {})
    guardWire(w, { maxBytes: 262144 })
    assert.equal(guardWire(w, { maxBytes: 262144 }), false)
    w._parse(4, w._onMessageLength)
    let unchoked = false
    w.on('unchoke', () => { unchoked = true })
    await feed(w, new Uint8Array([0, 0, 0, 1, 1]))
    assert.equal(unchoked, true)
    assert.equal(w.destroyed, false)
  })

  test('the patch point _onMessageLength exists in the vendored webtorrent bundle', () => {
    const bundle = readFileSync(ROOT + 'node_modules/webtorrent/dist/webtorrent.min.js', 'utf8')
    assert.ok(bundle.includes('_onMessageLength('), 'method definition present')
    assert.ok(bundle.includes('this._parse(4,this._onMessageLength)'), 'parse call through the property')
  })
})

describe('choke lock and retained store', () => {
  test('lockWire chokes and shadows unchoke; unlockWire restores it', () => {
    const w = fakeWire()
    w.peerInterested = true
    assert.equal(lockWire(w), true)
    assert.equal(w.choked, 1)
    w.unchoke()
    assert.equal(w.unchoked, undefined)
    assert.equal(lockWire(w), false)
    assert.equal(unlockWire(w), true)
    assert.equal(w.unchoked, 1, 'interested peer unchoked again')
    assert.equal(unlockWire(w), false)
    assert.equal(lockWire(fakeWire({ type: 'webSeed' })), false, 'web seeds are never locked')
  })

  test('RetainedStore closes only its own view', async () => {
    const inner = { chunkLength: 4, length: 8, data: new Map(), put (i, b, cb) { this.data.set(i, b); cb(null) }, get (i, o, cb) { cb(null, this.data.get(i)) } }
    const a = new RetainedStore(inner)
    await new Promise((resolve) => a.put(0, new Uint8Array([1]), resolve))
    await new Promise((resolve) => a.close(resolve))
    const err = await new Promise((resolve) => a.get(0, resolve))
    assert.match(String(err && err.message), /closed/)
    const b = new RetainedStore(inner)
    const got = await new Promise((resolve) => b.get(0, null, (e, buf) => resolve(buf)))
    assert.deepEqual([...got], [1])
  })
})

// ---- TorrentManager -----------------------------------------------------------------------------

describe('TorrentManager.download', () => {
  test('fetches xs first, probes the web seed, adds bytes with exact trackers, private and urlList', async () => {
    const f = fetchStub({ 'https://cdn.example/site.torrent': { status: 200, body: TORRENT_BYTES }, 'https://cdn.example/ws/site/index.html': { status: 206 } })
    const { tm } = manager({ fetch: f })
    const seen = []
    tm.addEventListener('torrent', (e) => seen.push(e.detail.kind))
    const p = tm.download({ record: SIGNED, maxBytes: 1e6 })
    await flush(); await flush(); await flush()
    const client = FakeWebTorrent.instances[0]
    assert.ok(client, 'client created')
    assert.deepEqual(client.opts.tracker, { rtcConfig: { iceServers: CONFIG.stun } })
    assert.equal(client.opts.dht, false)
    const t = client.torrents[0]
    assert.deepEqual([...t.source], [...minimalTorrentBytes(INFO)])
    assert.equal(t.opts.private, true)
    assert.deepEqual(t.opts.announce, ['wss://own.example'])
    assert.deepEqual(attached(t), ['https://cdn.example/ws/'])
    assert.equal(typeof t.opts.store, 'function')
    assert.deepEqual(seen, ['site'])
    const probe = f.log.find((r) => r.url.includes('/ws/'))
    // v0.2.1 B3/B4: the probe sends what the patched web-seed connection sends, Range only (no preflight).
    assert.deepEqual(probe.init.headers, { range: 'bytes=0-0' })
    assert.equal(probe.init.cache, 'no-store')
    assert.deepEqual(t.opts.getAnnounceOpts(), { numwant: 3 }, 'content numwant below the soft cap')
    t.metadata(PARSED, [new FakeFile('site/index.html', 200, 'x'.repeat(200), 'text/html'), new FakeFile('site/.pad/0', 0, ''), new FakeFile('site/css/app.css', 100, 'y'.repeat(100), '')])
    t.finish()
    const res = await p
    assert.equal(res.manifest.btih, BTIH)
    assert.equal(res.manifest.complete, true)
    assert.deepEqual(res.manifest.files.map((x) => [x.path, x.length, x.offset, x.type]), [['index.html', 200, 0, 'text/html'], ['css/app.css', 100, 200, 'text/css']])
    assert.deepEqual([...res.manifest.torrentFile], [...minimalTorrentBytes(INFO)])
    assert.equal(res.blobs.get('css/app.css').size, 100)
    assert.equal(res.blobs.has('.pad/0'), false, 'pad files are never kept')
    assert.equal(tm.site.mode, 'seed')
  })

  test('a web seed answering 200 to a Range probe is dropped with a warning', async () => {
    const f = fetchStub({ 'https://cdn.example/site.torrent': { status: 200, body: TORRENT_BYTES }, 'https://cdn.example/ws/site/index.html': { status: 200 } })
    const { tm } = manager({ fetch: f })
    const warnings = []
    tm.addEventListener('warning', (e) => warnings.push(e.detail))
    tm.download({ record: SIGNED, maxBytes: 1e6 }).catch(() => {})
    await flush(); await flush(); await flush(); await flush(); await flush()
    assert.deepEqual(attached(FakeWebTorrent.instances[0].torrents[0]), [])
    assert.ok(warnings.some((w) => w.code === 'webseed-broken' && w.reason === 'no-range'))
    assert.equal(tm.failures.webseed, 'no-range')
    tm.destroy()
  })

  test('consent pending: web seed only (no tracker client), then a rebuild with trackers keeps progress', async () => {
    const consent = makeConsent(false)
    const f = fetchStub({ 'https://cdn.example/site.torrent': { status: 200, body: TORRENT_BYTES }, 'https://cdn.example/ws/site/index.html': { status: 206 } })
    const { tm } = manager({ consent, fetch: f })
    const p = tm.download({ record: SIGNED, maxBytes: 1e6 })
    await flush(); await flush(); await flush(); await flush(); await flush()
    const first = FakeWebTorrent.instances[0]
    assert.equal(first.opts.tracker, false, 'no tracker sockets before consent')
    const t1 = first.torrents[0]
    assert.deepEqual(t1.opts.announce, [])
    assert.deepEqual(t1.opts.urlList, ['https://cdn.example/ws/'])
    t1.metadata(PARSED, [new FakeFile('site/index.html', 200, 'a'), new FakeFile('site/.pad/0', 0, ''), new FakeFile('site/css/app.css', 100, 'b')])
    consent.set(true)
    await flush()
    assert.equal(first.destroyed, true)
    const second = FakeWebTorrent.instances[1]
    assert.ok(second.opts.tracker && second.opts.tracker.rtcConfig)
    const t2 = second.torrents[0]
    assert.deepEqual(t2.opts.announce, ['wss://own.example'])
    assert.ok(t2.opts.preloadedStore instanceof RetainedStore, 'download resumes from the retained store')
    assert.deepEqual([...t2.opts.bitfield], [0b10000000])
    t2.metadata(PARSED, [new FakeFile('site/index.html', 200, 'x'.repeat(200)), new FakeFile('site/.pad/0', 0, ''), new FakeFile('site/css/app.css', 100, 'y'.repeat(100))])
    t2.finish()
    const res = await p
    assert.equal(res.manifest.files.length, 2)
  })

  test('post-wave fix H: progress.uploaded is 0 until a peer wire sends piece data; web-seed and protocol bytes never count', async () => {
    const consent = makeConsent(false)
    const f = fetchStub({ 'https://cdn.example/site.torrent': { status: 200, body: TORRENT_BYTES }, 'https://cdn.example/ws/site/index.html': { status: 206 } })
    const { tm, clock } = manager({ consent, fetch: f })
    const seen = []
    tm.addEventListener('progress', (e) => seen.push(e.detail))
    const p = tm.download({ record: SIGNED, maxBytes: 1e6 })
    await flush(); await flush(); await flush(); await flush(); await flush()
    const t1 = FakeWebTorrent.instances[0].torrents[0]
    assert.equal(FakeWebTorrent.instances[0].opts.tracker, false, 'no tracker before the choice')
    t1.metadata(PARSED, [new FakeFile('site/index.html', 200, 'a'), new FakeFile('site/.pad/0', 0, ''), new FakeFile('site/css/app.css', 100, 'b')])
    // Before any choice the only wire is the web seed's in-memory connection. WebTorrent counts what the page's
    // wire writes to it (handshake, extended handshake, interested, request, have: 178 B for the guestbook in
    // Chromium) in torrent.uploaded; none of it leaves the page as an upload to anyone.
    const seed = fakeWire({ type: 'webSeed' })
    t1.emit('wire', seed)
    t1.uploaded = 178
    seed.emit('download', 300)
    seed.emit('upload', 17) // a web seed is not another visitor, whatever its wire reports
    t1.emit('upload', 178)
    await clock.advance(CONFIG.ui.progressIntervalMs + 1)
    assert.ok(seen.length > 0, 'progress was reported')
    assert.deepEqual(seen.map((d) => d.uploaded), seen.map(() => 0), 'nothing uploaded before the choice')
    assert.equal(seen[seen.length - 1].webseedBytes, 300)
    // After "Share and load": a peer wire's protocol overhead does not count either; its piece data does.
    consent.set(true)
    await flush()
    const t2 = FakeWebTorrent.instances[1].torrents[0]
    const peer = fakeWire({ peerId: 'p1' })
    t2.emit('wire', peer)
    t2.uploaded = 650 // handshake, extended handshake, bitfield and have messages to the peer
    t2.emit('upload', 650)
    await clock.advance(CONFIG.ui.progressIntervalMs + 1)
    assert.equal(seen[seen.length - 1].uploaded, 0, 'protocol messages to a peer are not passed-on data')
    peer.emit('upload', 16384) // bittorrent-protocol emits 'upload' with the payload of a piece message
    await clock.advance(CONFIG.ui.progressIntervalMs + 1)
    assert.equal(seen[seen.length - 1].uploaded, 16384)
    tm.destroy()
    await p.catch(() => {})
  })

  test('magnet only and consent pending: nothing starts until consent', async () => {
    const consent = makeConsent(false)
    const { tm } = manager({ consent })
    const statuses = []
    tm.addEventListener('status', (e) => statuses.push(e.detail.code))
    const p = tm.download({ record: { btih: BTIH, signed: false, tr: [], xs: [], ws: [] }, maxBytes: 1e6 })
    await flush(); await flush()
    assert.equal(FakeWebTorrent.instances.length, 0, 'no client, no tracker socket')
    assert.ok(statuses.includes('waiting-consent'))
    consent.set(true)
    await flush()
    const t = FakeWebTorrent.instances[0].torrents[0]
    assert.equal(t.source, 'magnet:?xt=urn:btih:' + BTIH)
    assert.deepEqual(t.opts.announce, CONFIG.trackers, 'defaults only for unsigned pointers')
    tm.destroy()
    await assert.rejects(p, { code: 'E_ABORTED' })
  })

  test('E_TOO_LARGE from the torrent file before any peer connection', async () => {
    const f = fetchStub({ 'https://cdn.example/site.torrent': { status: 200, body: TORRENT_BYTES } })
    const { tm } = manager({ fetch: f })
    await assert.rejects(tm.download({ record: Object.assign({}, SIGNED, { ws: [] }), maxBytes: 100 }), { code: 'E_TOO_LARGE', length: 300, maxBytes: 100 })
    assert.equal(FakeWebTorrent.instances.length, 0)
  })

  test('E_TOO_LARGE on metadata for a magnet download', async () => {
    const { tm } = manager()
    const p = tm.download({ record: { btih: BTIH, signed: false, tr: [] }, maxBytes: 100 })
    await flush(); await flush()
    const t = FakeWebTorrent.instances[0].torrents[0]
    t.metadata(PARSED, [])
    await assert.rejects(p, { code: 'E_TOO_LARGE' })
    assert.equal(t.destroyed, true)
  })

  test('E_NO_PEERS only when the pointer has neither xs nor ws', async () => {
    const { tm, clock } = manager()
    const p = tm.download({ record: { btih: BTIH, signed: true, tr: ['wss://t.example'] }, maxBytes: 1e6 })
    const rejected = assert.rejects(p, { code: 'E_NO_PEERS' }) // attached before the timer fires
    await flush(); await flush()
    await clock.advance(CONFIG.timeouts.noPeersMs + 1)
    await rejected
    tm.destroy()
  })

  test('with xs or ws a silent swarm is E_TIMEOUT, not E_NO_PEERS', async () => {
    const f = fetchStub({})
    const { tm, clock } = manager({ fetch: f })
    const p = tm.download({ record: { btih: BTIH, signed: true, tr: ['wss://t.example'], xs: ['https://dead.example/x.torrent'], ws: [] }, maxBytes: 1e6 })
    const rejected = assert.rejects(p, { code: 'E_TIMEOUT' }) // attached before the timer fires
    await flush(); await flush(); await flush()
    await clock.advance(CONFIG.timeouts.noPeersMs + 1)
    await rejected
    tm.destroy()
  })

  test('E_BAD_TORRENT when every xs has another infohash and there is no tracker', async () => {
    const f = fetchStub({ 'https://cdn.example/site.torrent': { status: 200, body: new Uint8Array(9) } })
    const { tm } = manager({ fetch: f })
    await assert.rejects(tm.download({ record: { btih: BTIH, signed: true, tr: [], xs: ['https://cdn.example/site.torrent'], ws: [] } }), { code: 'E_BAD_TORRENT' })
  })

  test('abort rejects with E_ABORTED and destroys the torrent', async () => {
    const { tm } = manager()
    const ctl = new AbortController()
    const p = tm.download({ record: { btih: BTIH, signed: false, tr: [] }, signal: ctl.signal })
    await flush(); await flush()
    const t = FakeWebTorrent.instances[0].torrents[0]
    ctl.abort()
    await assert.rejects(p, { code: 'E_ABORTED' })
    assert.equal(t.destroyed, true)
  })
})

describe('TorrentManager wires', () => {
  async function started (policy) {
    const ctx = manager({ policy })
    ctx.tm.download({ record: { btih: BTIH, signed: true, tr: ['wss://t.example'] } }).catch(() => {})
    await flush(); await flush()
    ctx.torrent = FakeWebTorrent.instances[0].torrents[0]
    return ctx
  }

  test('every peer wire gets the length guard, a 60 s timeout and keep-alive, synchronously before "wire"', async () => {
    const { tm, torrent } = await started()
    const order = []
    tm.addEventListener('wire', (e) => order.push(e.detail.wire._onMessageLength !== undefined && e.detail.wire.__mwGuard === true))
    const w = fakeWire({ peerId: 'p1' })
    torrent.emit('wire', w)
    assert.deepEqual(order, [true])
    assert.deepEqual(w.timeouts, [[60000, true]])
    assert.deepEqual(w.keepAlive, [true])
    assert.equal(tm.peers, 1)
    tm.destroy()
  })

  test('web-seed wires are not guarded or capped and count as web seeds', async () => {
    const { tm, torrent } = await started()
    const ws = fakeWire({ type: 'webSeed' })
    torrent.emit('wire', ws)
    assert.equal(ws.__mwGuard, undefined)
    assert.equal(tm.peers, 0)
    tm.destroy()
  })

  test('uploads off is a choke lock on every wire, never throttleUpload(0)', async () => {
    const { tm, torrent } = await started({ uploadsEnabled: false, uploadLimit: 0 })
    const w = fakeWire({ peerId: 'p1' })
    torrent.emit('wire', w)
    assert.equal(w.choked, 1)
    assert.ok(w.__mwLock)
    const client = FakeWebTorrent.instances[0]
    assert.equal(client.opts.uploadLimit, -1)
    tm.setUploadsEnabled(true)
    assert.equal(w.__mwLock, null)
    tm.setUploadsEnabled(false)
    assert.ok(!(client.throttles || []).includes(0), 'never throttleUpload(0)')
    tm.destroy()
  })

  test('wire caps (B6): soft cap drives numwant to 0, the hard cap applies after the extended handshake, lowest score first', async () => {
    // maxConns 3 = soft 3, hard 3 + ceil(3 x 0.5) = 5.
    const { tm, torrent } = await started({ maxConns: 3 })
    const wires = [1, 2, 3, 4, 5, 6, 7].map((i) => fakeWire({ peerId: 'p' + i }))
    wires[0].downloaded = 5000 // useful peers score higher
    wires[1].peerExtendedMapping = { mw_chain1: 3 }
    assert.deepEqual(torrent.opts.getAnnounceOpts(), { numwant: 3 })
    for (const w of wires) torrent.emit('wire', w)
    assert.equal(wires.filter((w) => w.destroyed).length, 0, 'nothing is dropped before the extended handshake')
    assert.deepEqual(torrent.opts.getAnnounceOpts(), { numwant: 0 }, 'numwant is 0 at the soft cap')
    for (const w of wires) w.emit('extended', 'handshake', {})
    assert.equal(wires.filter((w) => !w.destroyed).length, 5, 'at the hard cap')
    assert.equal(wires[0].destroyed, false, 'bytes exchanged keep a wire')
    assert.equal(wires[1].destroyed, false, 'a ledger peer is kept')
    // v0.3 (harden-loader, MF-74): equal scores are evicted in random order, not newest first (no tenure tie-break).
    assert.equal(wires.slice(2).filter((w) => w.destroyed).length, 2, 'two of the zero-score wires go')
    assert.equal(tm.failures.capped, 2)
    assert.equal(tm.peers, 5)
    tm.destroy()
  })

  test('wire caps (B6): a wire that never sends its extended handshake is counted after capGraceMs', async () => {
    const { tm, torrent, clock } = await started({ maxConns: 1 }) // soft 1, hard 2
    const wires = [1, 2, 3].map((i) => fakeWire({ peerId: 'q' + i }))
    for (const w of wires) torrent.emit('wire', w)
    assert.equal(wires.filter((w) => w.destroyed).length, 0)
    await clock.advance(CONFIG.policy.capGraceMs + 1)
    assert.equal(wires.filter((w) => w.destroyed).length, 1)
    tm.destroy()
  })

  test('wire caps (B6): the emergency bound refuses wires at twice the hard cap even before handshakes', async () => {
    const { tm, torrent } = await started({ maxConns: 1 }) // hard 2, emergency 4
    const wires = [1, 2, 3, 4, 5, 6].map((i) => fakeWire({ peerId: 'r' + i }))
    for (const w of wires) torrent.emit('wire', w)
    assert.deepEqual(wires.map((w) => w.destroyed), [false, false, false, false, true, true])
    tm.destroy()
  })

  test('the same peer on two wires counts once (peers by unique peerId, web seeds excluded)', async () => {
    const { tm, torrent } = await started()
    torrent.emit('wire', fakeWire({ peerId: 'same' }))
    torrent.emit('wire', fakeWire({ peerId: 'same' }))
    torrent.emit('wire', fakeWire({ type: 'webSeed' }))
    assert.equal(tm.peers, 1)
    tm.destroy()
  })

  test('reqq (B6): content wires advertise clamp(limit x 0.25 / 16 KiB, 4, 32) in their extended handshake', async () => {
    assert.equal(reqqFor(1048576), 16)
    assert.equal(reqqFor(131072), 4)
    assert.equal(reqqFor(-1), 32)
    assert.equal(reqqFor(0), 4)
    assert.equal(reqqFor(16 * 1048576), 32)
    const { tm, torrent } = await started()
    const w = fakeWire({ peerId: 'x' })
    w.extendedHandshake = {}
    torrent.emit('wire', w)
    assert.equal(w.extendedHandshake.reqq, 16)
    tm.destroy()
  })

  test('wireScore: the ledger extension first, then bytes exchanged', () => {
    assert.ok(wireScore({ peerExtendedMapping: { mw_chain1: 2 } }) > wireScore({ downloaded: 1e9 }))
    assert.ok(wireScore({ downloaded: 10 }) > wireScore({}))
    assert.equal(wireScore(null), 0)
  })

  test('ICE failures: peers that close before their handshake are counted', async () => {
    const { tm, torrent } = await started()
    const ok = Object.assign(new Emitter(), { id: 'good' })
    const bad = Object.assign(new Emitter(), { id: 'bad' })
    torrent.emit('peer', ok)
    torrent.emit('peer', bad)
    torrent.emit('peer', 'https://webseed.example/') // web seeds are strings: ignored
    torrent.emit('wire', fakeWire({ peerId: 'good' }))
    bad.emit('error', { code: 'ERR_ICE_CONNECTION_FAILURE' })
    bad.emit('close')
    ok.emit('close')
    assert.equal(tm.failures.iceFailed, 1)
    assert.equal(tm.failures.lastIceError, 'ERR_ICE_CONNECTION_FAILURE')
    tm.destroy()
  })
})

describe('TorrentManager trackers (B1: keepalive announce, fast reconnect, kick)', () => {
  async function seeding (opts = {}) {
    const ctx = manager(opts)
    await ctx.tm.seedFromCache({ manifest: { btih: BTIH, torrentFile: TORRENT_BYTES, files: [] }, blobs: new Map(), record: { btih: BTIH, signed: true, tr: ['wss://t.example'] } })
    ctx.torrent = FakeWebTorrent.instances[0].torrents[0]
    return ctx
  }

  test('no scrape ever; a socket silent for 55 s gets one offer-free announce (numwant 0); state changes are reported', async () => {
    // A seeding torrent: unlike a download it has no start or stall timers that would end it first.
    const { tm, clock, torrent } = await seeding()
    const ws = fakeTracker('wss://t.example')
    const tc = trackerClient([ws])
    torrent.discovery = { tracker: tc }
    torrent.emit('infoHash')
    await flush()
    assert.equal(ws.__mwShim, true, 'the connection shim is installed when the tracker client appears')
    const events = []
    tm.addEventListener('tracker', (e) => events.push(e.detail))
    await clock.advance(2000)
    assert.deepEqual(events, [{ url: 'wss://t.example', state: 'open' }])
    tc.emit('update', { announce: 'wss://t.example', complete: 0, incomplete: 1 })
    assert.deepEqual(tm.diagnostics().swarm, { reported: true, others: 0 })
    await clock.advance(CONFIG.wire.keepaliveAnnounceMs - 2000 - CONFIG.tracker.keepaliveCheckMs)
    assert.equal(ws.announces.length, 0, 'not before 55 s of silence')
    await clock.advance(CONFIG.tracker.keepaliveCheckMs)
    assert.equal(ws.announces.length, 1)
    assert.equal(ws.announces[0].numwant, 0, 'the keepalive carries no offers')
    assert.equal(ws.announces[0].event, undefined)
    assert.equal(ws.scrapes, 0, 'never a scrape (openwebtorrent closes the socket on scrape)')
    // Any other message on the socket postpones the keepalive.
    await clock.advance(30000)
    ws._send({ action: 'announce', numwant: 3 })
    await clock.advance(30000)
    assert.equal(ws.announces.length, 1)
    await clock.advance(30000)
    assert.equal(ws.announces.length, 2)
    assert.ok(tm.failures.keepalives >= 2)
    // Reconnecting sockets are reported and get no keepalive.
    ws.socket.connected = false
    ws.reconnecting = true
    await clock.advance(60000)
    assert.equal(events[events.length - 1].state, 'reconnecting')
    assert.equal(ws.announces.length, 2)
    tm.destroy()
  })

  test('one keepalive per pooled socket: two tracker instances on one URL share it', async () => {
    const { tm, clock, torrent } = await seeding()
    const a = fakeTracker('wss://t.example')
    const b = fakeTracker('wss://t.example')
    torrent.discovery = { tracker: trackerClient([a, b]) }
    torrent.emit('infoHash')
    await flush()
    await clock.advance(CONFIG.wire.keepaliveAnnounceMs + CONFIG.tracker.keepaliveCheckMs)
    assert.equal(a.announces.length + b.announces.length, 1)
    tm.destroy()
  })

  test('keepaliveAnnounce forces numwant 0 after getAnnounceOpts (which bittorrent-tracker merges last)', () => {
    const t = fakeTracker('wss://x')
    assert.equal(keepaliveAnnounce(t), true)
    assert.equal(t.announces[0].numwant, 0)
    assert.equal(keepaliveAnnounce(null), false)
  })

  test('reconnect shim: 500 ms + U(0, min(60 s, 1 s x 2^retries)), never the stock 10 s to 5 min', async () => {
    const clock = new FakeClock()
    const t = fakeTracker('wss://x')
    assert.equal(installTrackerShim(t, { timers: clock, random: () => 0.5, now: () => clock.now() }), true)
    assert.equal(installTrackerShim(t, { timers: clock }), false, 'installed once')
    t.reconnecting = false
    t._startReconnectTimer()
    assert.equal(t.reconnecting, true)
    assert.equal(t.__mwReconnectMs, 1000)
    await clock.advance(999)
    assert.equal(t.opened, 0)
    await clock.advance(1)
    assert.equal(t.opened, 1)
    assert.equal(t.retries, 1)
    // Back-off grows, capped at 60 s of jitter.
    t.retries = 20
    t._startReconnectTimer()
    assert.equal(t.__mwReconnectMs, 500 + 30000)
    // A destroyed tracker client is never reopened.
    t.client.destroyed = true
    await clock.advance(60000)
    assert.equal(t.opened, 1)
  })

  test('the shim keeps the regular announce cadence: an unchanged server interval does not restart the timer', () => {
    const t = fakeTracker('wss://x')
    installTrackerShim(t, { timers: new FakeClock() })
    t.setInterval(120000)
    t.setInterval(120000)
    t.setInterval(120000)
    t.setInterval(180000)
    assert.deepEqual(t.intervals, [120000, 180000])
  })

  test('kick() reopens trackers waiting in back-off at once and re-announces at most every kickMinIntervalMs', async () => {
    const { tm, clock, torrent } = await seeding()
    const ws = fakeTracker('wss://t.example')
    const tc = trackerClient([ws])
    torrent.discovery = { tracker: tc }
    torrent.emit('infoHash')
    await flush()
    await clock.advance(3000)
    // bittorrent-tracker destroys the instance (socket null, destroyed) before it starts the reconnect timer;
    // v0.2.1 verifier: the fake models that, because kick() now leaves alone an instance that is still
    // attached to a connecting socket (see the next test).
    ws.socket = null
    ws.destroyed = true
    ws.retries = 4
    ws._startReconnectTimer()
    assert.equal(tm.kick('online'), 1)
    assert.equal(ws.opened, 1)
    assert.equal(ws.retries, 0)
    assert.equal(tc.updates, 1)
    tm.kick('visible')
    assert.equal(tc.updates, 1, 'no second announce within kickMinIntervalMs')
    await clock.advance(CONFIG.tracker.kickMinIntervalMs)
    tm.kick('visible')
    assert.equal(tc.updates, 2)
    tm.destroy()
  })

  test('kick() never reopens an instance already attached to a connecting pooled socket (no double count in the pool)', async () => {
    const { tm, clock, torrent } = await seeding()
    const waiting = fakeTracker('wss://t.example')
    const attached = fakeTracker('wss://t.example')
    torrent.discovery = { tracker: trackerClient([waiting, attached]) }
    torrent.emit('infoHash')
    await flush()
    await clock.advance(3000)
    // waiting: destroyed by the close, timer pending. attached: its timer fired and it joined the other
    // instance's new socket, which is still connecting (the shim's connect hook finishes it).
    waiting.socket = null
    waiting.destroyed = true
    waiting._startReconnectTimer()
    attached.socket = { connected: false }
    attached.destroyed = false
    attached.reconnecting = true
    assert.equal(tm.kick('visible'), 1)
    assert.equal(waiting.opened, 1)
    assert.equal(attached.opened, 0, 'not opened twice')
    tm.destroy()
  })

  test('lifecycle: visible, pageshow and online kick; a hidden phone page choke-locks every wire (C2)', async () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    const win = new EventTarget()
    const { tm, clock, torrent } = await seeding({ lifecycle: { win, doc }, policy: { hiddenAction: 'lock' } })
    const ws = fakeTracker('wss://t.example')
    const tc = trackerClient([ws])
    torrent.discovery = { tracker: tc }
    torrent.emit('infoHash')
    await flush()
    await clock.advance(3000)
    const w = fakeWire({ peerId: 'p1' })
    torrent.emit('wire', w)
    assert.equal(w.__mwLock, undefined)
    doc.visibilityState = 'hidden'
    doc.dispatchEvent(new Event('visibilitychange'))
    assert.ok(w.__mwLock, 'locked while hidden')
    assert.equal(tm.hiddenLocked, true)
    const late = fakeWire({ peerId: 'p2' })
    torrent.emit('wire', late)
    assert.ok(late.__mwLock, 'a wire that arrives while hidden is locked too')
    tm.setUploadsEnabled(true)
    assert.ok(w.__mwLock, 'turning sharing on while hidden does not unlock')
    doc.visibilityState = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    assert.equal(w.__mwLock, null, 'unlocked on return')
    assert.equal(tc.updates, 1, 'visible kicks')
    // As bittorrent-tracker does on a close: destroy (socket null), then the reconnect timer (v0.2.1 verifier).
    ws.socket = null
    ws.destroyed = true
    ws._startReconnectTimer()
    win.dispatchEvent(new Event('online'))
    assert.equal(ws.opened, 1, 'online reopens at once')
    tm.destroy()
    doc.dispatchEvent(new Event('visibilitychange'))
    win.dispatchEvent(new Event('pageshow'))
  })
})

describe('TorrentManager seeding, rendezvous and lifecycle', () => {
  const manifest = { btih: BTIH, torrentFile: TORRENT_BYTES, files: [] }

  test('seedFromCache checks the infohash against the pointer', async () => {
    const { tm } = manager()
    await assert.rejects(tm.seedFromCache({ manifest, blobs: new Map(), record: { btih: OTHER, signed: true, tr: [] } }), { code: 'E_BAD_TORRENT' })
  })

  test('seedFromCache waits for consent, then adds a BlobChunkStore with skipVerify', async () => {
    const consent = makeConsent(false)
    const { tm, d } = manager({ consent })
    const res = await tm.seedFromCache({ manifest, blobs: new Map([['index.html', new Blob(['x'])]]), record: SIGNED })
    assert.equal(res, null)
    assert.equal(FakeWebTorrent.instances.length, 0)
    consent.set(true)
    const t = FakeWebTorrent.instances[0].torrents[0]
    assert.equal(t.opts.skipVerify, true)
    assert.equal(t.opts.private, true)
    assert.deepEqual(t.opts.announce, ['wss://own.example'])
    assert.equal(d.calls.blobStores[0].opts.verify, true)
    assert.equal(typeof t.opts.preloadedStore.get, 'function')
    tm.destroy()
  })

  test('a corrupt cached piece is reported once and the seed stops', async () => {
    const { tm, d } = manager()
    const warnings = []
    tm.addEventListener('warning', (e) => warnings.push(e.detail.code))
    await tm.seedFromCache({ manifest, blobs: new Map(), record: SIGNED })
    const t = FakeWebTorrent.instances[0].torrents[0]
    d.calls.blobStores[0].fail = true
    const err = await new Promise((resolve) => t.opts.preloadedStore.get(0, (e) => resolve(e)))
    assert.match(err.message, /verification/)
    assert.deepEqual(warnings.filter((w) => w === 'E_CACHE_CORRUPT'), ['E_CACHE_CORRUPT'])
    assert.equal(t.destroyed, true)
    tm.destroy()
  })

  test('rendezvousInfoHash is sha1hex("mw-ledger/1/" + ledgerId)', async () => {
    const want = createHash('sha1').update('mw-ledger/1/mw1:abc').digest('hex')
    assert.equal(await rendezvousInfoHash('mw1:abc'), want)
    assert.match(await rendezvousInfoHash('btih:' + BTIH), /^[0-9a-f]{40}$/)
    await assert.rejects(rendezvousInfoHash(''), TypeError)
  })

  test('addRendezvous (B2): bare infohash, exact trackers, private, left 1, numwant clamp(soft - wires, 0, 3), never seeded', async () => {
    const { tm, clock, d } = manager({ random: () => 1 })
    const seen = []
    tm.addEventListener('torrent', (e) => seen.push(e.detail.kind))
    const p = tm.addRendezvous('mw1:abc', ['wss://own.example/', 'wss://own.example'])
    await scheduled(tm)
    assert.equal(FakeWebTorrent.instances.length, 0, 'not before the join jitter')
    await clock.advance(CONFIG.ledger.joinJitterMs)
    const t = await p
    assert.equal(t.source, createHash('sha1').update('mw-ledger/1/mw1:abc').digest('hex'))
    assert.equal(t.opts.private, true)
    assert.deepEqual(t.opts.announce, ['wss://own.example'])
    assert.equal(t.opts.store, undefined, 'no store: never seeded')
    assert.equal(t.opts.preloadedStore, undefined)
    assert.equal(d.calls.built.length, 0, 'no one-piece anchor torrent is built')
    assert.deepEqual(t.opts.getAnnounceOpts(), { left: 1, numwant: 3 })
    assert.deepEqual(seen, ['rendezvous'])
    assert.equal(tm.anchor, tm.rendezvous, 'deprecated alias')
    const wires = [1, 2, 3, 4, 5, 6].map((i) => {
      const w = fakeWire({ peerId: 'r' + i })
      w.ut_metadata = { cancelled: 0, cancel () { this.cancelled++ } }
      w.extendedHandshake = {}
      t.emit('wire', w)
      return w
    })
    assert.deepEqual(t.opts.getAnnounceOpts(), { left: 1, numwant: 0 }, 'numwant 0 at the rendezvous soft cap (6 on desktop)')
    assert.equal(wires[0].ut_metadata.cancelled, 1, 'ut_metadata is cancelled on rendezvous wires')
    assert.equal(wires[0].extendedHandshake.reqq, CONFIG.wireGuard.reqqRendezvous)
    tm.destroy()
  })

  test('addAnchor (deprecated alias, one release) joins the rendezvous swarm', async () => {
    const { tm, clock } = manager({ random: () => 0 })
    const p = tm.addAnchor('mw1:abc', ['wss://own.example'])
    await scheduled(tm)
    await clock.advance(0)
    const t = await p
    assert.equal(t.source, createHash('sha1').update('mw-ledger/1/mw1:abc').digest('hex'))
    tm.destroy()
  })

  test('rendezvous caps on phones are 3 soft / 5 hard; the surplus goes after the extended handshake', async () => {
    const { tm, clock } = manager({ random: () => 0, policy: { class: 'mobileUnknown', rendezvous: { soft: 3, hard: 5 } } })
    const p = tm.addRendezvous('mw1:abc', ['wss://own.example'])
    await scheduled(tm)
    await clock.advance(0)
    const t = await p
    const wires = [1, 2, 3, 4, 5, 6].map((i) => { const w = fakeWire({ peerId: 'm' + i }); t.emit('wire', w); return w })
    assert.deepEqual(t.opts.getAnnounceOpts(), { left: 1, numwant: 0 })
    for (const w of wires) w.emit('extended', 'handshake', {})
    assert.equal(wires.filter((w) => !w.destroyed).length, 5)
    tm.destroy()
  })

  test('glare watchdog: peers reported but no rendezvous wire after 20 s: a jittered re-announce, at most 3 times', async () => {
    const { tm, clock } = manager({ random: () => 0 })
    const p = tm.addRendezvous('mw1:abc', ['wss://own.example'])
    await scheduled(tm)
    await clock.advance(0)
    const t = await p
    const tc = trackerClient([fakeTracker('wss://own.example')])
    t.discovery = { tracker: tc }
    t.emit('infoHash')
    await flush()
    await clock.advance(2000)
    tc.emit('update', { announce: 'wss://own.example', complete: 0, incomplete: 3 })
    await clock.advance(CONFIG.ledger.glareWatchMs)
    assert.equal(tc.updates, 1)
    for (let i = 0; i < 6; i++) await clock.advance(CONFIG.ledger.glareWatchMs)
    assert.equal(tc.updates, CONFIG.ledger.glareRetries, 'at most glareRetries times')
    tm.destroy()
  })

  test('a rendezvous wire that closes below the soft cap triggers a jittered announce', async () => {
    const { tm, clock } = manager({ random: () => 0 })
    const p = tm.addRendezvous('mw1:abc', ['wss://own.example'])
    await scheduled(tm)
    await clock.advance(0)
    const t = await p
    const tc = trackerClient([fakeTracker('wss://own.example')])
    t.discovery = { tracker: tc }
    const w = fakeWire({ peerId: 'z' })
    t.emit('wire', w)
    w.destroy()
    await clock.advance(1)
    assert.equal(tc.updates, 1)
    tm.destroy()
  })

  test('consent pending: the rendezvous swarm joins only after consent; rebuild re-joins it', async () => {
    const consent = makeConsent(false)
    const { tm, clock } = manager({ consent, random: () => 0 })
    assert.equal(await tm.addRendezvous('mw1:abc', ['wss://own.example']), null)
    assert.equal(FakeWebTorrent.instances.length, 0)
    consent.set(true)
    await clock.advance(0)
    assert.equal(FakeWebTorrent.instances[0].torrents[0].opts.getAnnounceOpts().left, 1)
    tm.rebuild()
    await clock.advance(0)
    assert.equal(FakeWebTorrent.instances[1].torrents.length, 1, 'the rebuilt client re-joins')
    tm.destroy()
  })

  test('cellular with uploads off leaves the version swarm once complete (the rendezvous swarm stays)', async () => {
    const { tm, clock } = manager({ random: () => 0, policy: { leaveVersionSwarm: true, uploadsEnabled: false, uploadLimit: 0 } })
    const p = tm.addRendezvous('mw1:abc', ['wss://own.example'])
    await scheduled(tm)
    await clock.advance(0)
    await p
    const site = await tm.seedFromCache({ manifest, blobs: new Map(), record: SIGNED })
    assert.equal(site.destroyed, true)
    const rv = FakeWebTorrent.instances[0].torrents[0]
    assert.equal(rv.destroyed, false)
    tm.destroy()
  })

  test('pause destroys the client; resume and rebuild re-add the torrents; stopSite stops the seed', async () => {
    const { tm } = manager()
    await tm.seedFromCache({ manifest, blobs: new Map(), record: SIGNED })
    tm.pause()
    assert.equal(FakeWebTorrent.instances[0].destroyed, true)
    assert.equal(tm.suspended, true)
    tm.resume()
    assert.equal(FakeWebTorrent.instances.length, 2)
    assert.equal(FakeWebTorrent.instances[1].torrents.length, 1)
    tm.rebuild()
    assert.equal(FakeWebTorrent.instances.length, 3)
    tm.stopSite()
    assert.equal(FakeWebTorrent.instances[2].torrents[0].destroyed, true)
    tm.rebuild()
    // Nothing left to add: the client is created lazily, so either no new client or an empty one.
    const last = FakeWebTorrent.instances[3]
    assert.ok(!last || last.torrents.length === 0, 'a stopped version is not re-added')
    tm.destroy()
  })

  test('host only: client without tracker, rebuild on toggle', async () => {
    const { tm } = manager()
    await tm.seedFromCache({ manifest, blobs: new Map(), record: SIGNED })
    tm.setHostOnly(true)
    assert.equal(FakeWebTorrent.instances[0].destroyed, true)
    assert.equal(FakeWebTorrent.instances.length, 1, 'nothing to seed without peers')
    tm.setHostOnly(false)
    assert.ok(FakeWebTorrent.instances[1].opts.tracker)
    tm.destroy()
  })
})

// ---- v0.2.1 B5: wire guard details -------------------------------------------------------------

describe('wire guard (B5)', () => {
  const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
  const feed = (w, chunk) => new Promise((resolve) => w._write(chunk, resolve))

  test('the private _bufferSize field exists in bittorrent-protocol and tracks buffered bytes (the watchdog depends on it)', async () => {
    const w = new Wire()
    w.on('error', () => {})
    assert.equal(typeof w._bufferSize, 'number', 'bittorrent-protocol renamed or removed _bufferSize: fix the watchdog')
    assert.equal(w._bufferSize, 0)
    w._parse(4, w._onMessageLength)
    await feed(w, u32(100))
    await feed(w, new Uint8Array(40)) // 40 of the 100 announced bytes
    assert.equal(w._bufferSize, 40)
    assert.equal(bufferOverflow(w, 39), true)
    assert.equal(bufferOverflow(w, 40), false)
    assert.equal(bufferOverflow({}, 0), false, 'a wire without the field never counts as overflowing')
  })

  test('0x7FFFFFFF (the largest length the stock parser buffers) and 0x80000000 are cut before buffering', async () => {
    for (const prefix of [0x7fffffff, 0x80000000, 0xffffffff, 256 * 1024 + 1]) {
      const w = new Wire()
      w.on('error', () => {})
      let dropped = null
      guardWire(w, { maxBytes: 262144, onDrop: (n) => { dropped = n } })
      w._parse(4, w._onMessageLength)
      await feed(w, u32(prefix))
      assert.equal(dropped, prefix >>> 0, 'unsigned read of ' + prefix)
      assert.equal(w._bufferSize, 0)
    }
    const ok = new Wire()
    ok.on('error', () => {})
    let dropped = null
    guardWire(ok, { maxBytes: 262144, onDrop: (n) => { dropped = n } })
    ok._parse(4, ok._onMessageLength)
    await feed(ok, u32(262144))
    assert.equal(dropped, null, 'exactly the cap is allowed')
  })

  test('the periodic watchdog destroys a wire whose buffer passes 512 KiB in any parse state', async () => {
    const { tm, clock } = manager()
    tm.download({ record: { btih: BTIH, signed: true, tr: ['wss://t.example'] } }).catch(() => {})
    await flush(); await flush()
    const torrent = FakeWebTorrent.instances[0].torrents[0]
    const warnings = []
    tm.addEventListener('warning', (e) => warnings.push(e.detail.code))
    const w = fakeWire({ peerId: 'big' })
    torrent.emit('wire', w)
    w._bufferSize = CONFIG.wireGuard.bufferWatchdogBytes - 1
    await clock.advance(CONFIG.wireGuard.bufferWatchdogMs)
    assert.equal(w.destroyed, false)
    w._bufferSize = CONFIG.wireGuard.bufferWatchdogBytes + 1
    await clock.advance(CONFIG.wireGuard.bufferWatchdogMs)
    assert.equal(w.destroyed, true)
    assert.ok(warnings.includes('wire-buffer-overflow'))
    assert.equal(tm.failures.dropped, 1)
    tm.destroy()
  })

  test('fail closed: a peer wire without the _onMessageLength patch point is refused, with one warning', async () => {
    const { tm } = manager()
    tm.download({ record: { btih: BTIH, signed: true, tr: ['wss://t.example'] } }).catch(() => {})
    await flush(); await flush()
    const torrent = FakeWebTorrent.instances[0].torrents[0]
    const warnings = []
    tm.addEventListener('warning', (e) => warnings.push(e.detail.code))
    for (const id of ['a', 'b']) {
      const w = fakeWire({ peerId: id })
      delete w._onMessageLength
      torrent.emit('wire', w)
      assert.equal(w.destroyed, true)
    }
    assert.deepEqual(warnings.filter((c) => c === 'wire-guard-missing'), ['wire-guard-missing'])
    tm.destroy()
  })
})

// ---- v0.2.1 B4: web-seed circuit breaker ---------------------------------------------------------------

describe('web-seed circuit breaker (B4)', () => {
  function webseedWire (url, reply) {
    const w = fakeWire({ type: 'webSeed' })
    w.url = url
    w.requests = 0
    w.httpRequest = function (pieceIndex, offset, length, cb) { this.requests++; reply(pieceIndex, offset, length, cb) }
    return w
  }

  async function downloading (fetchRoutes) {
    const f = fetchStub(Object.assign({ 'https://cdn.example/site.torrent': { status: 200, body: TORRENT_BYTES } }, fetchRoutes))
    const ctx = manager({ fetch: f })
    const record = Object.assign({}, SIGNED, { ws: ['https://cdn.example/ws/', 'https://site.example/_mw/ws/'] })
    ctx.p = ctx.tm.download({ record, maxBytes: 1e6 })
    ctx.p.catch(() => {})
    await flush(); await flush(); await flush(); await flush()
    ctx.torrent = FakeWebTorrent.instances[0].torrents[0]
    return ctx
  }

  test('several ws= are used cheapest first: the page origin, then the pointer order, one at a time', async () => {
    assert.deepEqual(orderWebseeds(['https://cdn.example/ws/', 'https://site.example/_mw/ws/', 'https://b.example/'], 'https://site.example'), ['https://site.example/_mw/ws/', 'https://cdn.example/ws/', 'https://b.example/'])
    const { tm, torrent } = await downloading({ 'https://cdn.example/ws/site/index.html': { status: 206 }, 'https://site.example/_mw/ws/site/index.html': { status: 206 } })
    assert.deepEqual(attached(torrent), ['https://site.example/_mw/ws/'], 'only the cheapest web seed is attached')
    tm.destroy()
  })

  test('a Range-ignoring host (wrong body length) is refused per request and stopped for 5 minutes after 3 failures in 30 s', async () => {
    const { tm, torrent, clock } = await downloading({ 'https://site.example/_mw/ws/site/index.html': { status: 206 }, 'https://cdn.example/ws/site/index.html': { status: 206 } })
    const url = 'https://site.example/_mw/ws/'
    const warnings = []
    tm.addEventListener('warning', (e) => warnings.push(e.detail))
    const w = webseedWire(url, (i, o, len, cb) => cb(null, new Uint8Array(len + 100)))
    torrent.emit('wire', w)
    const results = []
    for (let i = 0; i < 3; i++) await new Promise((resolve) => w.httpRequest(i, 0, 16384, (err, data) => { results.push([err && err.code, data]); resolve() }))
    assert.deepEqual(results.map((r) => r[0]), ['E_WEBSEED_RANGE', 'E_WEBSEED_RANGE', 'E_WEBSEED_RANGE'], 'wrong bytes never reach the piece')
    assert.ok(results.every((r) => r[1] === null))
    const backoff = warnings.find((x) => x.code === 'webseed-backoff')
    assert.ok(backoff, 'a visible warning names the web seed')
    assert.equal(backoff.url, url)
    assert.equal(backoff.reason, 'E_WEBSEED_RANGE')
    assert.equal(backoff.backoffMs, CONFIG.webseed.backoffMs)
    assert.deepEqual(torrent.removed, [url], 'the web seed leaves the torrent')
    assert.deepEqual(attached(torrent), ['https://site.example/_mw/ws/', 'https://cdn.example/ws/'], 'the next web seed takes over')
    assert.equal(tm.webseedBlocked(url), true)
    assert.equal(tm.failures.webseed, 'wrong-bytes')
    // Nothing is requested from that host within the back-off.
    const before = w.requests
    await new Promise((resolve) => w.httpRequest(9, 0, 16384, () => resolve()))
    assert.equal(w.requests, before)
    await clock.advance(CONFIG.webseed.backoffMs - 1)
    assert.equal(tm.webseedBlocked(url), true)
    await clock.advance(1)
    assert.equal(tm.webseedBlocked(url), false, 'retried after the back-off')
    assert.deepEqual(tm.failures.webseedBackoff, {})
    tm.destroy()
  })

  test('failures spread over more than 30 s do not trip the breaker', async () => {
    const { tm, torrent, clock } = await downloading({ 'https://site.example/_mw/ws/site/index.html': { status: 206 } })
    const url = 'https://site.example/_mw/ws/'
    const w = webseedWire(url, (i, o, len, cb) => cb(new Error('Unexpected HTTP status code 503')))
    torrent.emit('wire', w)
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => w.httpRequest(i, 0, 16384, () => resolve()))
      await clock.advance(CONFIG.webseed.failureWindowMs / 2 + 1)
    }
    assert.equal(tm.webseedBlocked(url), false)
    tm.destroy()
  })

  test('hash failures of pieces a web seed sent count against it (a 206 with the wrong bytes)', async () => {
    const { tm, torrent } = await downloading({ 'https://site.example/_mw/ws/site/index.html': { status: 206 } })
    const url = 'https://site.example/_mw/ws/'
    const w = webseedWire(url, (i, o, len, cb) => cb(null, new Uint8Array(len)))
    torrent.emit('wire', w)
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => w.httpRequest(i, 0, 16384, () => resolve()))
      torrent.emit('warning', new Error('Piece ' + i + ' failed verification'))
    }
    assert.equal(tm.webseedBlocked(url), true)
    assert.equal(tm.failures.webseedBackoff[url].code, 'E_WEBSEED_BYTES')
    tm.destroy()
  })
})

describe('ICE servers (B7)', () => {
  test('setIceServers changes the shared rtcConfig in place (new connections only) and is never empty', async () => {
    const { tm } = manager()
    tm.download({ record: { btih: BTIH, signed: true, tr: ['wss://t.example'] } }).catch(() => {})
    await flush(); await flush()
    const rtc = FakeWebTorrent.instances[0].opts.tracker.rtcConfig
    assert.deepEqual(rtc.iceServers, CONFIG.stun)
    assert.ok(!JSON.stringify(rtc).includes('turn:'), 'no TURN in v1')
    tm.setIceServers([CONFIG.stun[1]])
    assert.deepEqual(rtc.iceServers, [CONFIG.stun[1]])
    tm.setIceServers([])
    assert.deepEqual(rtc.iceServers, CONFIG.stun, 'an empty list falls back to the configured STUN servers')
    tm.destroy()
  })
})

// ---- code review round 1: cold start, capped xs= bodies, pad files ----------------------------------

describe('code review round 1: the cold start does not wait for web seeds', () => {
  // A fetch whose answers the test releases by hand; a missing route never answers (a black hole).
  function heldFetch (routes) {
    const log = []
    const f = (url, init = {}) => {
      log.push({ url, init })
      const r = routes[url]
      if (!r) return new Promise(() => {})
      return Promise.resolve(r).then((spec) => ({
        ok: spec.status >= 200 && spec.status < 300,
        status: spec.status,
        body: { cancel () {} },
        headers: { get: () => null },
        arrayBuffer: async () => (spec.body || new Uint8Array(1)).buffer.slice(0)
      }))
    }
    f.log = log
    return f
  }

  test('the client starts before 1 s with two web seeds that never answer; a web seed joins when its probe answers 206', async () => {
    let release
    const answer = new Promise((resolve) => { release = resolve })
    const f = heldFetch({
      'https://cdn.example/site.torrent': { status: 200, body: TORRENT_BYTES },
      'https://slow.example/ws/site/index.html': answer
    })
    const { tm, clock } = manager({ fetch: f })
    const record = Object.assign({}, SIGNED, { ws: ['https://dead.example/ws/', 'https://slow.example/ws/'] })
    tm.download({ record, maxBytes: 1e6 }).catch(() => {})
    for (let i = 0; i < 6; i++) await flush()
    assert.ok(clock.now() - 1000 < 1000, 'no fake time passed')
    const client = FakeWebTorrent.instances[0]
    assert.ok(client && client.torrents[0], 'the torrent (trackers, peers) started at once')
    const t = client.torrents[0]
    assert.deepEqual(attached(t), [], 'no web seed yet')
    const probes = f.log.filter((r) => r.url.endsWith('/site/index.html')).map((r) => r.url)
    assert.deepEqual(probes.sort(), ['https://dead.example/ws/site/index.html', 'https://slow.example/ws/site/index.html'], 'both probes run in parallel')
    release({ status: 206 })
    for (let i = 0; i < 4; i++) await flush()
    assert.deepEqual(attached(t), ['https://slow.example/ws/'], 'added as soon as its probe passed')
    tm.destroy()
  })

  test('a web seed whose probe answers 200 (no Range) is never added', async () => {
    const f = heldFetch({ 'https://cdn.example/site.torrent': { status: 200, body: TORRENT_BYTES }, 'https://cdn.example/ws/site/index.html': { status: 200 } })
    const { tm, clock } = manager({ fetch: f })
    tm.download({ record: SIGNED, maxBytes: 1e6 }).catch(() => {})
    for (let i = 0; i < 6; i++) await flush()
    await clock.advance(30000)
    assert.deepEqual(attached(FakeWebTorrent.instances[0].torrents[0]), [])
    tm.destroy()
  })

  test('several xs= are fetched at once; the first that matches the btih wins', async () => {
    const f = heldFetch({ 'https://b.example/site.torrent': { status: 200, body: TORRENT_BYTES } })
    const { tm } = manager({ fetch: f })
    const record = Object.assign({}, SIGNED, { xs: ['https://a.example/never.torrent', 'https://b.example/site.torrent'], ws: [] })
    tm.download({ record, maxBytes: 1e6 }).catch(() => {})
    for (let i = 0; i < 6; i++) await flush()
    assert.deepEqual(f.log.filter((r) => r.url.endsWith('.torrent')).map((r) => r.url), ['https://a.example/never.torrent', 'https://b.example/site.torrent'])
    const t = FakeWebTorrent.instances[0].torrents[0]
    assert.deepEqual([...t.source], [...minimalTorrentBytes(INFO)], 'started from the second xs= without waiting for the first')
    tm.destroy()
  })
})

test('code review round 1: readCappedBody stops a body past the cap (streamed or declared)', async () => {
  const chunk = new Uint8Array(1024 * 1024)
  let sent = 0
  let cancelled = false
  const stream = {
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          if (sent >= 9) return { done: true }
          sent++
          return { done: false, value: chunk }
        },
        cancel: async () => { cancelled = true }
      })
    }
  }
  assert.equal(await readCappedBody(stream, 8 * 1024 * 1024), null)
  assert.equal(cancelled, true)
  assert.equal(sent, 9, 'read up to the first chunk past 8 MiB, then cancelled')
  const declared = { headers: { get: (k) => (k === 'content-length' ? String(9 * 1024 * 1024) : null) }, body: { cancel: async () => {}, getReader: () => { throw new Error('not read') } } }
  assert.equal(await readCappedBody(declared, 8 * 1024 * 1024), null)
  const small = await readCappedBody({ headers: { get: () => null }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }, 10)
  assert.deepEqual([...small], [1, 2, 3])
})

test('code review round 1: a torrent with pad files keeps only the worker\'s own /_mw/ws/ web seed (others would 404 on pad paths)', async () => {
  const padded = Object.assign({}, PARSED, { files: [PARSED.files[0], { path: '.pad/16184', length: 16184, offset: 200, pad: true }, PARSED.files[2]] })
  const d = deps({ parseTorrentFile: async () => padded })
  const f = fetchStub({ 'https://cdn.example/site.torrent': { status: 200, body: TORRENT_BYTES }, 'https://cdn.example/ws/site/index.html': { status: 206 }, 'https://site.example/_mw/ws/site/index.html': { status: 206 } })
  const { tm } = manager({ fetch: f, d })
  const warnings = []
  tm.addEventListener('warning', (e) => warnings.push(e.detail))
  tm.download({ record: Object.assign({}, SIGNED, { ws: ['https://cdn.example/ws/', 'https://site.example/_mw/ws/'] }), maxBytes: 1e6 }).catch(() => {})
  for (let i = 0; i < 8; i++) await flush()
  assert.deepEqual(attached(FakeWebTorrent.instances[0].torrents[0]), ['https://site.example/_mw/ws/'])
  assert.ok(warnings.some((w) => w.code === 'webseed-pad' && w.url === 'https://cdn.example/ws/'))
  tm.destroy()
})
