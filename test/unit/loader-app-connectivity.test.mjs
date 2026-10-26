// Unit tests for src/loader/connectivity.js (v0.2.1 DIGEST-AMENDMENTS B7; research w2b-03 F-20, F-21, F-24,
// R-02, R-04): the STUN probe, probe-gated ICE servers and the non-trickle offer timeout. A fake
// RTCPeerConnection replays candidate sequences; no network is used.
// Run: node --test test/unit/loader-app-connectivity.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  probeConnectivity, classifyReport, gateIceServers, installOfferTimeout, patchOfferTimeout, connectivityRow, stunUrlsOf, PROBE_CLASSES
} from '../../src/loader/connectivity.js'
import { CONFIG } from '../../src/loader/config.js'

const STUN = [{ urls: 'stun:a.example:3478' }, { urls: 'stun:b.example:3478' }]

function candidateEvent (c) {
  return Object.assign(new Event('icecandidate'), { candidate: c })
}

/** A fake RTCPeerConnection that plays `script` (a list of [ms, candidate | null | 'error']) after setLocalDescription. */
function fakePc (script) {
  class FakePC extends EventTarget {
    constructor (config) {
      super()
      this.config = config
      FakePC.instances.push(this)
    }

    createDataChannel () { return {} }
    async createOffer () { return { type: 'offer', sdp: 'v=0' } }
    async setLocalDescription () {
      for (const [ms, c] of script) {
        setTimeout(() => {
          if (this.closed) return
          if (c === 'error') this.dispatchEvent(Object.assign(new Event('icecandidateerror'), { errorCode: 701, url: 'stun:b.example:3478', errorText: 'STUN binding request timed out.' }))
          else this.dispatchEvent(candidateEvent(c))
        }, ms)
      }
    }

    close () { this.closed = true }
  }
  FakePC.instances = []
  return FakePC
}

const srflx = (url, address, port) => ({ type: 'srflx', address, port, url })

test('the classes are the seven of research w2b-03 R-04', () => {
  assert.deepEqual(PROBE_CLASSES, ['easy-mapping', 'easy-probable', 'hard', 'udp-blocked-or-no-stun', 'relay-only-reachable', 'unknown-single-stun', 'no-webrtc'])
})

test('two reflexive ports for one IP: hard NAT (destination-dependent mapping), reported early', async () => {
  const PC = fakePc([[5, srflx('stun:a.example:3478', '198.51.100.7', 40000)], [10, srflx('stun:b.example:3478', '198.51.100.7', 41000)]])
  const t0 = Date.now()
  const r = await probeConnectivity({ RTCPeerConnection: PC, stun: STUN, budgetMs: 2000, settleMs: 20 })
  assert.equal(r.cls, 'hard')
  assert.equal(r.mappingVaries, true)
  assert.deepEqual(r.answered.sort(), ['stun:a.example:3478', 'stun:b.example:3478'])
  assert.ok(Date.now() - t0 < 1000, 'does not wait for the budget once both servers answered')
  assert.equal(PC.instances[0].closed, true, 'the throw-away connection is closed')
  assert.deepEqual(PC.instances[0].config.iceServers.map((s) => s.urls), ['stun:a.example:3478', 'stun:b.example:3478'])
})

test('one reflexive address and gathering complete: easy-mapping; without completion: easy-probable after the confirm window', async () => {
  const done = await probeConnectivity({ RTCPeerConnection: fakePc([[5, srflx('stun:a.example:3478', '198.51.100.7', 40000)], [15, null]]), stun: STUN, budgetMs: 2000 })
  assert.equal(done.cls, 'easy-mapping')
  assert.equal(done.gatherComplete, true)
  const t0 = Date.now()
  const probable = await probeConnectivity({ RTCPeerConnection: fakePc([[5, srflx('stun:a.example:3478', '198.51.100.7', 40000)]]), stun: STUN, budgetMs: 2000, confirmMs: 80, settleMs: 10 })
  assert.equal(probable.cls, 'easy-probable')
  assert.equal(probable.gatherComplete, false)
  assert.ok(Date.now() - t0 < 1000, 'the confirm window, not the 2 s budget')
})

test('nothing answers within the budget: udp-blocked-or-no-stun at the budget, never waiting for complete', async () => {
  const t0 = Date.now()
  const r = await probeConnectivity({ RTCPeerConnection: fakePc([[10, 'error'], [5000, srflx('stun:a.example:3478', '198.51.100.7', 1)]]), stun: STUN, budgetMs: 150 })
  const ms = Date.now() - t0
  assert.equal(r.cls, 'udp-blocked-or-no-stun')
  assert.equal(r.reason, 'budget')
  assert.equal(r.errors[0].code, 701)
  assert.ok(ms >= 140 && ms < 1000, 'stopped at its budget (' + ms + ' ms)')
})

test('a single STUN server cannot classify the mapping; no RTCPeerConnection means no-webrtc', async () => {
  const single = await probeConnectivity({ RTCPeerConnection: fakePc([[5, srflx('stun:a.example:3478', '198.51.100.7', 40000)]]), stun: [STUN[0]], budgetMs: 1000, settleMs: 10 })
  assert.equal(single.cls, 'unknown-single-stun')
  assert.equal((await probeConnectivity({ RTCPeerConnection: null, stun: STUN })).cls, 'no-webrtc')
  const throwing = function () { throw Object.assign(new Error('blocked'), { name: 'NotSupportedError' }) }
  const r = await probeConnectivity({ RTCPeerConnection: throwing, stun: STUN })
  assert.equal(r.cls, 'no-webrtc')
  assert.match(r.reason, /NotSupportedError/)
})

test('a synthetic end-of-candidates from the offer-timeout wrapper is not a real complete', async () => {
  const PC = fakePc([[5, srflx('stun:a.example:3478', '198.51.100.7', 40000)]])
  const orig = PC.prototype.setLocalDescription
  PC.prototype.setLocalDescription = async function () {
    await orig.call(this)
    setTimeout(() => this.dispatchEvent(Object.assign(candidateEvent(null), { mwSynthetic: true })), 10)
  }
  const r = await probeConnectivity({ RTCPeerConnection: PC, stun: STUN, budgetMs: 1000, confirmMs: 60, settleMs: 10 })
  assert.equal(r.gatherComplete, false)
  assert.equal(r.cls, 'easy-probable')
})

test('classifyReport covers the relay and IPv6 cases', () => {
  assert.equal(classifyReport({ srflx: [], relay: [{ url: 'turn:x', proto: 'udp' }] }), 'relay-only-reachable')
  assert.equal(classifyReport({ srflx: [{ key: '1.1.1.1:5' }, { key: '1.1.1.1:5' }], relay: [] }), 'easy-mapping')
  assert.equal(classifyReport({ srflx: [{ key: '1.1.1.1:5' }, { key: '2.2.2.2:5' }], relay: [] }), 'easy-mapping', 'two IPs: multi-homed, not hard')
})

test('gateIceServers: only STUN servers that answered, all of them when gathering completed, never an empty list, never TURN', () => {
  assert.deepEqual(gateIceServers(STUN, { cls: 'easy-probable', answered: ['stun:b.example:3478'], gatherComplete: false }), [STUN[1]])
  assert.deepEqual(gateIceServers(STUN, { cls: 'easy-mapping', answered: ['stun:a.example:3478'], gatherComplete: true }), STUN)
  assert.deepEqual(gateIceServers(STUN, { cls: 'udp-blocked-or-no-stun', answered: [], gatherComplete: false }), STUN)
  assert.deepEqual(gateIceServers(STUN, null), STUN)
  assert.deepEqual(gateIceServers(STUN.concat([{ urls: 'turn:t.example', username: 'u', credential: 'c' }]), { answered: ['stun:a.example:3478'] }), [STUN[0]])
  assert.deepEqual(stunUrlsOf(CONFIG.stun), ['stun:stun.cloudflare.com:3478', 'stun:global.stun.twilio.com:3478'])
  assert.equal(CONFIG.stun.length >= 2, true, 'at least two STUN operators')
  assert.deepEqual(CONFIG.ice.turn, [], 'TURN is off in v1')
})

class FakeClock {
  constructor () { this.t = 0; this.timers = new Map(); this.id = 0 }
  setTimeout (fn, ms) { const id = ++this.id; this.timers.set(id, { fn, at: this.t + ms }); return id }
  clearTimeout (id) { this.timers.delete(id) }
  now () { return this.t }
  advance (ms) {
    this.t += ms
    for (const [id, tm] of Array.from(this.timers)) if (tm.at <= this.t) { this.timers.delete(id); tm.fn() }
  }
}

class RawPC extends EventTarget {
  constructor (config) { super(); this.config = config }
}

test('installOfferTimeout: a non-trickle offer leaves offerTimeoutMs after the first candidate (synthetic end-of-candidates)', () => {
  const clock = new FakeClock()
  const win = { RTCPeerConnection: RawPC }
  assert.equal(installOfferTimeout(win, { timeoutMs: CONFIG.ice.offerTimeoutMs, timers: clock }), true)
  assert.equal(installOfferTimeout(win, { timeoutMs: 1 }), false, 'installed once')
  const pc = new win.RTCPeerConnection({ iceServers: [] })
  assert.ok(pc instanceof win.RTCPeerConnection)
  const got = []
  pc.onicecandidate = (e) => got.push(e.candidate === null ? (e.mwSynthetic ? 'synthetic-end' : 'end') : e.candidate.type)
  pc.dispatchEvent(candidateEvent({ type: 'host' }))
  clock.advance(CONFIG.ice.offerTimeoutMs - 1)
  assert.deepEqual(got, ['host'])
  clock.advance(1)
  assert.deepEqual(got, ['host', 'synthetic-end'])
  pc.dispatchEvent(candidateEvent({ type: 'srflx' }))
  pc.dispatchEvent(candidateEvent(null))
  assert.deepEqual(got, ['host', 'synthetic-end', 'srflx'], 'late candidates still reach the page; the real end is not delivered twice')
  assert.ok(CONFIG.ice.offerTimeoutMs >= 1500 && CONFIG.ice.offerTimeoutMs <= 2000)
})

test('the real end of candidates before the timeout goes through once and cancels the timer', () => {
  const clock = new FakeClock()
  const pc = new RawPC({})
  patchOfferTimeout(pc, { timeoutMs: 1500, timers: clock })
  const got = []
  pc.onicecandidate = (e) => got.push(e.candidate ? 'c' : (e.mwSynthetic ? 'synthetic' : 'end'))
  pc.dispatchEvent(candidateEvent({ type: 'host' }))
  pc.dispatchEvent(candidateEvent(null))
  clock.advance(5000)
  assert.deepEqual(got, ['c', 'end'])
  pc.onicecandidate = null
  assert.equal(pc.onicecandidate, null)
})

test('installOfferTimeout composes with a harness wrapper that returns a native connection from its constructor', () => {
  const clock = new FakeClock()
  const Harness = function RTCPeerConnection (config) { return new RawPC(Object.assign({}, config, { iceServers: [] })) }
  Harness.prototype = RawPC.prototype
  const win = { RTCPeerConnection: Harness }
  installOfferTimeout(win, { timeoutMs: 1500, timers: clock })
  const pc = new win.RTCPeerConnection({ iceServers: STUN })
  assert.deepEqual(pc.config.iceServers, [], 'the harness still strips ICE servers')
  let ended = false
  pc.onicecandidate = (e) => { if (!e.candidate) ended = true }
  pc.dispatchEvent(candidateEvent({ type: 'host' }))
  clock.advance(1500)
  assert.equal(ended, true)
})

test('connectivityRow feeds the diagnostics panel', () => {
  assert.equal(connectivityRow(null), null)
  const row = connectivityRow({ cls: 'hard', tFirstSrflx: 120, answered: ['a', 'b'], ipv6Srflx: false })
  assert.deepEqual(row, { row: 'connectivity', text: 'hard, first answer 120 ms, 2 STUN answered' })
})
