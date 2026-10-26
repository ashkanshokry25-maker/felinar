// Unit tests for src/loader/superseed.js (v0.3 C2, lane seed-engine; S1 D4, BEP 16): the masked first message,
// one revealed piece per wire at a time, rarest first, pin wires first, the stop rules (receipt, a complete peer),
// and a simulation with fake wires: the bytes this device uploads before the first complete copy elsewhere stay
// under 110% of the item (a plain seed uploads more in the same swarm). Run: node --test test/unit/superseed.test.mjs
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import Wire from 'bittorrent-protocol'
import { SuperSeed, emptyBitfield } from '../../src/loader/superseed.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

class Emitter {
  constructor () { this._l = new Map() }
  on (t, fn) { if (!this._l.has(t)) this._l.set(t, []); this._l.get(t).push(fn); return this }
  removeListener (t, fn) { const l = this._l.get(t); if (l) { const i = l.indexOf(fn); if (i !== -1) l.splice(i, 1) } return this }
  emit (t, ...a) { for (const fn of (this._l.get(t) || []).slice()) fn(...a); return true }
}

class Bits {
  constructor (n, all = false) { this.bits = new Uint8Array(n).fill(all ? 1 : 0) }
  get (i) { return !!this.bits[i] }
  set (i, v = true) { this.bits[i] = v ? 1 : 0 }
}

/** Our side of a connection to one peer: what we send is recorded; remote* helpers play the peer. */
function fakeWire ({ pieces, fast = false, onSend = null } = {}) {
  const w = new Emitter()
  w.type = 'webrtc'
  w.destroyed = false
  w.hasFast = fast
  w.peerPieces = new Bits(pieces)
  w.sent = []
  const record = (m) => { w.sent.push(m); if (onSend) onSend(m) }
  w.bitfield = function (bf) { record(['bitfield', Array.from(ArrayBuffer.isView(bf) ? bf : bf.buffer)]) }
  w.have = function (i) { record(['have', i]) }
  w.haveAll = function () { record(['haveAll']) }
  w.haveNone = function () { record(['haveNone']) }
  w.remoteHave = (i) => { if (w.peerPieces.get(i)) return; w.peerPieces.set(i); w.emit('have', i) }
  w.remoteBitfield = (list) => { w.peerPieces = new Bits(pieces); for (const i of list) w.peerPieces.set(i); w.emit('bitfield', w.peerPieces) }
  w.close = () => { w.destroyed = true; w.emit('close') }
  return w
}

/** webtorrent's _onWireWithMetadata for a complete seed: haveAll on a Fast wire, else the full bitfield. */
function sendFirst (w, pieces) {
  if (w.hasFast) w.haveAll()
  else w.bitfield(new Uint8Array(Math.ceil(pieces / 8)).fill(255))
}

const haves = (w) => w.sent.filter((m) => m[0] === 'have').map((m) => m[1])

describe('the masked first message and one piece at a time', () => {
  test('emptyBitfield: ceil(pieces / 8) zero bytes', () => {
    assert.deepEqual(Array.from(emptyBitfield(9)), [0, 0])
    assert.equal(emptyBitfield(0).length, 0)
  })

  test('the full bitfield webtorrent sends after the wire event goes out empty, then one have', () => {
    const ss = new SuperSeed({ pieces: 10 })
    const w = fakeWire({ pieces: 10 })
    assert.equal(ss.addWire(w), true)
    sendFirst(w, 10)
    assert.deepEqual(w.sent[0], ['bitfield', [0, 0]], 'the remote is told we have nothing')
    assert.equal(haves(w).length, 1, 'then exactly one piece')
    const first = haves(w)[0]
    w.have(5) // the library's own announcement (a verified download) is dropped while super-seeding
    assert.equal(haves(w).length, 1)
    w.remoteHave(first) // the peer reports the piece: the next one is revealed
    assert.equal(haves(w).length, 2)
    assert.notEqual(haves(w)[1], first)
  })

  test('a Fast Extension wire: haveAll becomes haveNone, then reveals', () => {
    const ss = new SuperSeed({ pieces: 4 })
    const w = fakeWire({ pieces: 4, fast: true })
    ss.addWire(w)
    sendFirst(w, 4)
    assert.deepEqual(w.sent.slice(0, 2).map((m) => m[0]), ['haveNone', 'have'])
  })

  test('rarest first: pieces another wire holds or was shown go last', () => {
    const ss = new SuperSeed({ pieces: 4 })
    const a = fakeWire({ pieces: 4 })
    const b = fakeWire({ pieces: 4 })
    ss.addWire(a)
    ss.addWire(b)
    b.remoteBitfield([0, 1])
    sendFirst(a, 4)
    sendFirst(b, 4)
    const ra = haves(a)[0]
    const rb = haves(b)[0]
    assert.ok(ra === 2 || ra === 3, 'a gets a piece nobody holds')
    assert.ok(rb === 2 || rb === 3, 'b gets a piece it lacks and nobody holds')
    assert.notEqual(ra, rb, 'the piece shown to a is in flight: b gets the other')
  })

  test('web seeds and wires without the protocol methods are never wrapped', () => {
    const ss = new SuperSeed({ pieces: 4 })
    assert.equal(ss.addWire({ type: 'webSeed', bitfield () {}, have () {} }), false)
    assert.equal(ss.addWire({ type: 'webrtc' }), false)
    assert.equal(ss.addWire(null), false)
    assert.throws(() => new SuperSeed({ pieces: 0 }), TypeError)
  })
})

describe('pin wires first and the stop rules', () => {
  test('while an authenticated pin wire is not complete only it gets reveals; the others wait', () => {
    const pins = new Set()
    const ss = new SuperSeed({ pieces: 3, isPin: (w) => pins.has(w) })
    const pin = fakeWire({ pieces: 3 })
    const bo = fakeWire({ pieces: 3 })
    pins.add(pin)
    ss.addWire(pin)
    ss.addWire(bo)
    sendFirst(bo, 3)
    sendFirst(pin, 3)
    assert.equal(haves(pin).length, 1)
    assert.equal(haves(bo).length, 0, 'the visitor waits for the pin')
    pin.remoteHave(haves(pin)[0])
    pin.remoteHave(haves(pin)[1])
    assert.equal(haves(bo).length, 0)
  })

  test('a receipt stops it: every wire is told each remaining piece it lacks; the wrappers are removed', () => {
    const ss = new SuperSeed({ pieces: 5 })
    const w = fakeWire({ pieces: 5 })
    const orig = w.bitfield
    ss.addWire(w)
    sendFirst(w, 5)
    w.remoteBitfield([4])
    const before = haves(w)
    ss.noteReceipt()
    assert.equal(ss.active, false)
    assert.equal(ss.reason, 'receipt')
    const told = new Set(haves(w))
    for (const i of [0, 1, 2, 3]) assert.ok(told.has(i), 'piece ' + i)
    assert.equal(haves(w).filter((i) => i === 4).length, 0, 'not the piece it reported')
    assert.equal(new Set(before).size, before.length)
    assert.equal(w.bitfield, orig, 'the original method is back')
    w.have(4)
    assert.equal(haves(w).at(-1), 4, 'announcements pass through again')
    assert.equal(ss.addWire(fakeWire({ pieces: 5 })), false, 'no new wires once stopped')
  })

  test('a complete peer bitfield stops it; a wire whose first message has not gone out sends the real bitfield', () => {
    let stopped = null
    const ss = new SuperSeed({ pieces: 2, onStop: (e) => { stopped = e.reason } })
    const late = fakeWire({ pieces: 2 })
    const done = fakeWire({ pieces: 2 })
    ss.addWire(late)
    ss.addWire(done)
    done.remoteBitfield([0, 1])
    assert.equal(stopped, 'peer-complete')
    sendFirst(late, 2)
    assert.deepEqual(late.sent[0], ['bitfield', [255]], 'unmasked after the stop')
  })

  test('a wire that closes is forgotten: its reveal no longer counts as in flight and its events are ignored', () => {
    const ss = new SuperSeed({ pieces: 2 })
    const a = fakeWire({ pieces: 2 })
    ss.addWire(a)
    sendFirst(a, 2)
    assert.equal(ss.stats().inflight, 1)
    a.close()
    assert.equal(ss.stats().inflight, 0)
    assert.equal(ss.stats().wires, 0)
    a.remoteBitfield([0, 1]) // a closed wire cannot stop super-seeding
    assert.equal(ss.active, true)
    const b = fakeWire({ pieces: 2 })
    ss.addWire(b)
    sendFirst(b, 2)
    assert.equal(haves(b).length, 1)
    assert.equal(ss.stats().wires, 1)
  })
})

// ---- simulation ----------------------------------------------------------------------------------

function lcg (seed) {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
}

/**
 * One swarm, P pieces, N peers that start empty, and this device as the only seed. Each tick: every peer picks the
 * rarest piece it lacks among the pieces it knows a holder of (this device per its bitfield and haves, or another
 * peer), then a random holder of it: a peer sends it at once; this device queues the request and serves one per tick
 * (a phone's budget). A peer pipelines up to `pipeline` requests at this device (as WebTorrent does) and cancels one
 * when the piece comes from elsewhere first. Peers report every piece they get to this device (have). Ends at the
 * first peer with every piece. Returns the bytes this device uploaded divided by the item size.
 */
function simulate ({ P = 64, N = 4, superSeed = true, seed = 1, pin = false, pipeline = 4, maxTicks = 20000 } = {}) {
  const rand = lcg(seed)
  const pins = new Set()
  const ss = superSeed ? new SuperSeed({ pieces: P, isPin: (w) => pins.has(w) }) : null
  const peers = []
  for (let k = 0; k < N; k++) {
    const p = { have: new Uint8Array(P), known: new Uint8Array(P), reqs: new Set(), w: null }
    p.w = fakeWire({
      pieces: P,
      onSend: (m) => {
        if (m[0] === 'have') p.known[m[1]] = 1
        else if (m[0] === 'haveAll') p.known.fill(1)
        else if (m[0] === 'bitfield') for (let i = 0; i < P; i++) p.known[i] = (m[1][i >> 3] >> (7 - (i & 7))) & 1
      }
    })
    peers.push(p)
  }
  if (pin) pins.add(peers[0].w)
  for (const p of peers) { if (ss) ss.addWire(p.w); sendFirst(p.w, P) }
  const queue = []
  let uploaded = 0
  const give = (p, i) => {
    if (p.have[i]) return
    p.have[i] = 1
    p.reqs.delete(i)
    p.w.remoteHave(i)
  }
  const complete = () => peers.some((p) => p.have.every((x) => x === 1))
  for (let tick = 0; tick < maxTicks && !complete(); tick++) {
    for (const p of peers) {
      let best = -1
      let bestRare = Infinity
      let bestTie = 0
      for (let i = 0; i < P; i++) {
        if (p.have[i] || p.reqs.has(i)) continue
        const holders = peers.filter((q) => q !== p && q.have[i]).length
        const seedHas = p.known[i] === 1
        if (!holders && !seedHas) continue
        if (!holders && p.reqs.size >= pipeline) continue // its pipeline at this device is full
        const rare = holders + (seedHas ? 1 : 0)
        const tie = rand()
        if (rare < bestRare || (rare === bestRare && tie < bestTie)) { best = i; bestRare = rare; bestTie = tie }
      }
      if (best < 0) continue
      const sources = peers.filter((q) => q !== p && q.have[best])
      const seedOk = p.known[best] === 1 && p.reqs.size < pipeline
      const useSeed = seedOk && Math.floor(rand() * (sources.length + 1)) === sources.length
      if (useSeed) { p.reqs.add(best); queue.push({ p, i: best }) } else if (sources.length) give(p, best)
    }
    while (queue.length) {
      const { p, i } = queue.shift()
      if (p.have[i] || !p.reqs.has(i)) continue // cancelled: the piece came from another peer first
      uploaded++
      give(p, i)
      break
    }
  }
  assert.ok(complete(), 'the simulation reached a complete copy')
  return { ratio: uploaded / P, ss }
}

describe('simulation: bytes uploaded before the first complete copy', () => {
  test('super-seeding stays under 110% of the item across 40 random swarms; a plain seed uploads more', (t) => {
    let worst = 0
    let plainTotal = 0
    let superTotal = 0
    for (let seed = 1; seed <= 40; seed++) {
      for (const [P, N] of [[64, 4], [32, 3], [128, 6]]) {
        const s = simulate({ P, N, superSeed: true, seed }).ratio
        const plain = simulate({ P, N, superSeed: false, seed }).ratio
        worst = Math.max(worst, s)
        superTotal += s
        plainTotal += plain
      }
    }
    t.diagnostic('super-seed worst ' + worst.toFixed(3) + ', mean ' + (superTotal / 120).toFixed(3) + '; plain seed mean ' + (plainTotal / 120).toFixed(3) + ' (120 simulated swarms)')
    assert.ok(worst < 1.10, 'worst super-seed ratio ' + worst.toFixed(3))
    assert.ok(plainTotal > superTotal, 'plain ' + (plainTotal / 120).toFixed(3) + ' vs super ' + (superTotal / 120).toFixed(3) + ' on average')
  })

  test('with an authenticated pin wire the pin gets every piece once: exactly 100% before its complete copy', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const { ratio, ss } = simulate({ P: 48, N: 4, superSeed: true, seed, pin: true })
      assert.ok(ratio <= 1.0 + 1e-9, 'seed ' + seed + ': ' + ratio)
      assert.equal(ss.stats().duplicates, 0)
    }
  })
})

describe('a real bittorrent-protocol 5.0.9 wire', () => {
  test('what goes out is the masked bitfield, then one have; the prototype methods are back after the stop', async () => {
    const w = new Wire()
    w.on('error', () => {})
    const chunks = []
    w.on('data', (c) => chunks.push(new Uint8Array(c)))
    const ss = new SuperSeed({ pieces: 10 })
    assert.equal(ss.addWire(w), true)
    assert.ok(Object.prototype.hasOwnProperty.call(w, 'bitfield'), 'an own-property wrapper over the prototype method')
    w.bitfield(new Uint8Array([0xff, 0xc0])) // what webtorrent sends for a complete 10-piece seed
    await new Promise((resolve) => setImmediate(resolve))
    const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
    let o = 0
    for (const c of chunks) { all.set(c, o); o += c.length }
    assert.deepEqual(Array.from(all.subarray(0, 7)), [0, 0, 0, 3, 5, 0, 0], 'bitfield: length 3, id 5, two zero bytes')
    assert.deepEqual(Array.from(all.subarray(7, 12)), [0, 0, 0, 5, 4], 'then a have (length 5, id 4)')
    assert.equal(all.length, 16)
    ss.stop('test')
    assert.equal(Object.prototype.hasOwnProperty.call(w, 'bitfield'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(w, 'have'), false)
    assert.equal(w.bitfield, Wire.prototype.bitfield)
    w.destroy()
  })
})

describe('the vendored webtorrent sends its first message after the wire event', () => {
  test('lib/torrent.js and the dist bundle: emit("wire") comes before _onWireWithMetadata, which sends haveAll/haveNone/bitfield', () => {
    const lib = readFileSync(ROOT + 'node_modules/webtorrent/lib/torrent.js', 'utf8')
    const emitAt = lib.indexOf("this.emit('wire', wire, addr)")
    const callAt = lib.indexOf('this._onWireWithMetadata(wire)', emitAt)
    assert.ok(emitAt > 0 && callAt > emitAt, 'the wire event is emitted first')
    assert.match(lib.slice(callAt - 200, callAt), /queueMicrotask/, 'and the bitfield follows in a microtask')
    assert.match(lib, /else wire\.bitfield\(this\.bitfield\)/)
    const dist = readFileSync(ROOT + 'node_modules/webtorrent/dist/webtorrent.min.js', 'utf8')
    assert.match(dist, /this\.emit\("wire",e,t\),this\.ready&&\w+\(\(\)=>\{this\._onWireWithMetadata\(e\)\}\)/)
    assert.match(dist, /e\.hasFast&&this\._hasAllPieces\(\)\?e\.haveAll\(\):e\.hasFast&&this\._hasNoPieces\(\)\?e\.haveNone\(\):e\.bitfield\(this\.bitfield\)/)
  })
})
