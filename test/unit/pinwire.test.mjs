// Unit tests for src/loader/pinwire.js (v0.3 C2, lane seed-engine; SZ 3.1.6): the mw_pin1 frames and signing strings,
// a verifier page and the pin's own page on fake wires (chal once per wire, hello, anchorWire, receipts), refusals
// (another key, clock skew, oversized or malformed frames, receipts before hello), the responder only with the
// window.__mwPinCall bridge whose key is _mw.cfg.pin, the signed heartbeat (hashed items, age, size, 10 minute
// fetch interval), and test/vectors/pin.json when lane pin-node has landed it. Run: node --test test/unit/pinwire.test.mjs
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  createPinWire, createPinPageHost, PinWire, fetchHeartbeat, EXT_NAME, FRAME_MAX, SKEW_MS, HEARTBEAT_EVERY_MS, HEARTBEAT_MAX_AGE_MS,
  helloBytes, receiptBytes, statusBytes, statusItem, encodeFrame, decodeFrame,
  verifyHelloSZ, verifyReceiptSZ, verifyStatusSZ, SZ_CODEC, loadPinCodec
} from '../../src/loader/pinwire.js'
import { generateKeyPair, exportPublicKey, sign } from '../../src/chain/crypto.js'
import { b64url, utf8, canonicalize } from '../../src/chain/canonical.js'
import { createSha256 } from '../../src/files/validate.js'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const IH = 'ab'.repeat(20)
const OTHER_IH = 'cd'.repeat(20)
const NOW = 1_800_000_000_000

async function keypair () {
  const { publicKey, privateKey } = await generateKeyPair()
  return { pub: await exportPublicKey(publicKey), priv: privateKey }
}
const PIN = await keypair()
const ROGUE = await keypair()

const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)) }
/** until(fn, ms): fn() polled until it is truthy (code review v0.3, round 2: the signatures run on the thread pool, so a loaded run needs more than settle()). */
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; for (;;) { const v = fn(); if (v || Date.now() > end) return v; await new Promise((resolve) => setTimeout(resolve, 5)) } }

class Emitter {
  constructor () { this._l = new Map() }
  on (t, fn) { if (!this._l.has(t)) this._l.set(t, []); this._l.get(t).push(fn); return this }
  once (t, fn) { const w = (...a) => { this.removeListener(t, w); fn(...a) }; return this.on(t, w) }
  removeListener (t, fn) { const l = this._l.get(t); if (l) { const i = l.indexOf(fn); if (i !== -1) l.splice(i, 1) } return this }
  emit (t, ...a) { for (const fn of (this._l.get(t) || []).slice()) fn(...a); return true }
}

/** A bittorrent-protocol wire stand-in with the BEP 10 surface: use(), extended(), the extended handshake. */
function fakeWire () {
  const w = new Emitter()
  w.type = 'webrtc'
  w.destroyed = false
  w.extendedMapping = {}
  w._ext = {}
  w._nextExt = 1
  w.peerExtendedMapping = {}
  w._extendedHandshakeSent = false
  w.frames = [] // frames this side sent
  w.use = function (Ext) {
    const name = Ext.prototype.name
    const h = new Ext(this)
    this.extendedMapping[this._nextExt++] = name
    this._ext[name] = h
    this[name] = h
  }
  w.extended = function (name, bytes) {
    const peer = this.peer
    try { this.frames.push(JSON.parse(utf8.decode(bytes))) } catch (_) { this.frames.push(bytes) }
    if (!peer || peer.destroyed || !this.peerExtendedMapping[name]) return
    const h = peer._ext[name]
    if (h) setImmediate(() => h.onMessage(bytes))
  }
  w.handshakeExt = function () {
    this._extendedHandshakeSent = true
    const m = {}
    for (const [id, name] of Object.entries(this.extendedMapping)) m[name] = Number(id)
    const peer = this.peer
    peer.peerExtendedMapping = m
    for (const h of Object.values(peer._ext)) h.onExtendedHandshake({ m })
  }
  w._sendExtendedHandshake = function () { this.resent = (this.resent || 0) + 1; this.handshakeExt() }
  w.destroy = function () { if (this.destroyed) return; this.destroyed = true; this.emit('close') }
  return w
}

function pair () {
  const a = fakeWire()
  const b = fakeWire()
  a.peer = b
  b.peer = a
  return [a, b]
}

class FakeTM extends EventTarget {
  constructor () { super(); this.ext = null; this.anchored = []; this.ignored = []; this._pinSource = null; this.notes = []; this.local = new Map() }
  registerWireExtension (name, handler, opts) { this.ext = { name, handler, opts }; return () => { this.ext = null } }
  anchorWire (w) { this.anchored.push(w); return true }
  ignoreWire (w, reason) { this.ignored.push([w, reason]); w.destroy(); return true }
  setPinSource (s) { this._pinSource = s }
  notePin (ih) { this.notes.push(ih) }
  localState (ih) { return this.local.get(ih) || null }
  wire (w, kind = 'file', infoHash = IH, late = false) { this.ext.handler.onWire(w, kind, { late, infoHash }) }
  complete (ih, length, pieces = 4) {
    this.local.set(ih, { complete: true, length, pieces })
    this.dispatchEvent(new CustomEvent('evidence', { detail: { infoHash: ih, evidence: { local: true } } }))
  }
}

/** The pin's own page: window.__mwPinCall as tools/pin.mjs exposes it (top frame; refuses all but the two forms). */
function pinWindow (keys = PIN, { top = true, signLog = [] } = {}) {
  const win = {}
  win.top = top ? win : {}
  win.__mwPinCall = async (op, arg) => {
    if (op === 'pin.key') return keys.pub
    if (op === 'pin.sign') {
      const bytes = b64url.decode(arg)
      const text = utf8.decode(bytes)
      if (!/^mw-pin1-(hello|receipt)\n/.test(text)) throw new Error('E_POLICY: not a pin form')
      signLog.push(text.split('\n')[0])
      return b64url.encode(await sign(keys.priv, bytes))
    }
    throw new Error('E_BAD_REQUEST')
  }
  return win
}

function setup ({ browserKey = PIN.pub, pinKeys = PIN, pinCfg = PIN.pub, browserNow = () => NOW, pinNow = () => NOW, pinWin = undefined, codec = SZ_CODEC, pinCodec = codec } = {}) {
  const btm = new FakeTM()
  const ptm = new FakeTM()
  const browser = createPinWire({ tm: btm, pinKey: () => browserKey, win: {}, now: browserNow, codec }).attach()
  const signLog = []
  const pin = createPinWire({ tm: ptm, pinKey: () => pinCfg, win: pinWin === undefined ? pinWindow(pinKeys, { signLog }) : pinWin, now: pinNow, codec: pinCodec }).attach()
  return { btm, ptm, browser, pin, signLog }
}

async function connect (s, { kind = 'file', ih = IH } = {}) {
  const [bw, pw] = pair()
  s.btm.wire(bw, kind, ih)
  s.ptm.wire(pw, kind, ih)
  await s.pin.ready
  bw.handshakeExt()
  pw.handshakeExt()
  await settle()
  return { bw, pw }
}

describe('frames and signing strings (SZ 3.1.6)', () => {
  test('byte strings, JSON frames of at most 1 KiB, hashed heartbeat items', () => {
    assert.equal(EXT_NAME, 'mw_pin1')
    assert.equal(FRAME_MAX, 1024)
    assert.equal(SKEW_MS, 300000)
    assert.equal(utf8.decode(helloBytes(IH, 'nnn', 5)), 'mw-pin1-hello\n' + IH + '\nnnn\n5')
    assert.equal(utf8.decode(receiptBytes(IH, 12, 7)), 'mw-pin1-receipt\n' + IH + '\n12\n7')
    const st = { v: 1, t: 'mw-pin-status', key: 'k', site: 's', at: 1, items: [], monthBytes: 0, monthCap: 0, sig: 'x' }
    assert.equal(utf8.decode(statusBytes(st)), 'mw-pin-status-v1\n' + canonicalize({ v: 1, t: 'mw-pin-status', key: 'k', site: 's', at: 1, items: [], monthBytes: 0, monthCap: 0 }))
    const d = createSha256().update(utf8.encode('mw-pin-status-v1|' + IH)).digest()
    assert.equal(statusItem(IH), b64url.encode(d.subarray(0, 16)))
    assert.equal(statusItem(IH).length, 22)
    assert.deepEqual(decodeFrame(encodeFrame({ t: 'chal', n: 'x' })), { t: 'chal', n: 'x' })
    assert.equal(encodeFrame({ t: 'x', pad: 'a'.repeat(FRAME_MAX) }), null)
    assert.equal(decodeFrame(new Uint8Array(FRAME_MAX + 1).fill(32)), null)
    for (const bad of ['[1]', '"t"', 'nope', '{"t":5}', '']) assert.equal(decodeFrame(utf8.encode(bad)), null, bad)
  })

  test('verifyHelloSZ and verifyReceiptSZ: the right key, infohash, nonce and clock only', async () => {
    const n = b64url.encode(new Uint8Array(16).fill(7))
    const at = NOW
    const sig = b64url.encode(await sign(PIN.priv, helloBytes(IH, n, at)))
    const hello = { t: 'hello', key: PIN.pub, ih: IH, n, at, sig }
    assert.deepEqual(await verifyHelloSZ(hello, { expectKey: PIN.pub, ih: IH, n, now: NOW }), { ok: true, reason: null })
    assert.equal((await verifyHelloSZ(hello, { expectKey: ROGUE.pub, ih: IH, n, now: NOW })).reason, 'key')
    assert.equal((await verifyHelloSZ(hello, { expectKey: PIN.pub, ih: OTHER_IH, n, now: NOW })).reason, 'ih')
    assert.equal((await verifyHelloSZ(hello, { expectKey: PIN.pub, ih: IH, n: b64url.encode(new Uint8Array(16)), now: NOW })).reason, 'nonce')
    assert.equal((await verifyHelloSZ(hello, { expectKey: PIN.pub, ih: IH, n, now: NOW + SKEW_MS + 1 })).reason, 'skew')
    assert.equal((await verifyHelloSZ(Object.assign({}, hello, { at: at + 1 }), { expectKey: PIN.pub, ih: IH, n, now: NOW })).reason, 'sig')
    const rogue = Object.assign({}, hello, { key: ROGUE.pub, sig: b64url.encode(await sign(ROGUE.priv, helloBytes(IH, n, at))) })
    assert.equal((await verifyHelloSZ(rogue, { expectKey: PIN.pub, ih: IH, n, now: NOW })).reason, 'key', 'a valid signature by another key')
    const rsig = b64url.encode(await sign(PIN.priv, receiptBytes(IH, 4096, at)))
    const rcpt = { t: 'rcpt', key: PIN.pub, ih: IH, total: 4096, at, sig: rsig }
    assert.equal((await verifyReceiptSZ(rcpt, { expectKey: PIN.pub, ih: IH, now: NOW })).ok, true)
    assert.equal((await verifyReceiptSZ(Object.assign({}, rcpt, { total: 4097 }), { expectKey: PIN.pub, ih: IH, now: NOW })).reason, 'sig')
    assert.equal((await verifyReceiptSZ(rcpt, { expectKey: PIN.pub, ih: IH, now: NOW - SKEW_MS - 1 })).reason, 'skew')
    assert.equal((await verifyReceiptSZ({ t: 'rcpt' }, { expectKey: PIN.pub, ih: IH, now: NOW })).reason, 'shape')
    // A hello signature never verifies as a receipt (distinct prefixes, R 2.10.3).
    assert.equal((await verifyReceiptSZ(Object.assign({}, rcpt, { sig }), { expectKey: PIN.pub, ih: IH, now: NOW })).reason, 'sig')
  })

  test('the codec loader falls back to the SZ codec per function while src/pin has not landed', async () => {
    const c = await loadPinCodec()
    for (const k of ['helloBytes', 'receiptBytes', 'verifyHello', 'verifyReceipt', 'verifyStatus']) assert.equal(typeof c[k], 'function', k)
    assert.ok(c.source === 'src/pin' || c.source === 'pinwire')
    if (!existsSync(ROOT + 'src/pin/frames.js')) assert.equal(c.source, 'pinwire')
  })
})

describe('a verifier page and the pin page on fake wires', () => {
  test('chal once per wire, hello from _mw.cfg.pin authenticates and anchors the pin wire; the receipt follows completion', async () => {
    const s = setup()
    const { bw, pw } = await connect(s)
    const chals = bw.frames.filter((f) => f.t === 'chal')
    assert.equal(chals.length, 1, 'one chal per wire')
    assert.equal(b64url.decode(chals[0].n).length, 16)
    assert.equal(pw.frames.filter((f) => f.t === 'hello').length, 1, 'the pin answered')
    assert.equal(s.browser.isPinWire(bw), true)
    assert.deepEqual(s.browser.pinWires(IH), [bw])
    assert.deepEqual(s.btm.anchored, [bw], 'anchorWire: the pin keeps its slot')
    assert.equal(s.browser.receipt(IH), null, 'no receipt before the pin holds every piece')
    assert.deepEqual(s.signLog, ['mw-pin1-hello'])
    s.ptm.complete(IH, 65536)
    await settle()
    const r = await until(() => s.browser.receipt(IH))
    assert.deepEqual(s.signLog, ['mw-pin1-hello', 'mw-pin1-receipt'], 'the bridge signed only the two forms')
    assert.equal(r.total, 65536)
    assert.equal(r.key, PIN.pub)
    assert.ok(s.btm.notes.includes(IH), 'the manager re-evaluates the item (hand-off, super-seed stop)')
    const ev = s.browser.evidence(IH)
    assert.equal(ev.configured, true)
    assert.equal(ev.receipt.at, NOW)
    assert.equal(s.btm._pinSource, s.browser, 'attach() makes it the pin source')
    // The pin page also challenged the browser, which is no responder: no hello comes back.
    assert.equal(bw.frames.filter((f) => f.t === 'hello').length, 0)
  })

  test('the default codec (lane pin-node\'s src/pin when present) interoperates with the SZ codec both ways', async () => {
    for (const [codec, pinCodec] of [[null, null], [SZ_CODEC, null], [null, SZ_CODEC]]) {
      const s = setup({ codec, pinCodec })
      const { bw } = await connect(s)
      assert.equal(s.browser.isPinWire(bw), true)
      s.ptm.complete(IH, 32768)
      await settle()
      assert.equal((await until(() => s.browser.receipt(IH))).total, 32768)
    }
  })

  test('a pin that already holds the item sends the receipt right after hello; the total must match this copy', async () => {
    const s = setup()
    s.ptm.local.set(IH, { complete: true, length: 4096, pieces: 1 })
    s.btm.local.set(IH, { complete: true, length: 9999, pieces: 3 })
    await connect(s)
    assert.equal(s.browser.receipt(IH), null, 'a receipt for another length is refused')
    const s2 = setup()
    s2.ptm.local.set(IH, { complete: true, length: 4096, pieces: 1 })
    s2.btm.local.set(IH, { complete: true, length: 4096, pieces: 1 })
    await connect(s2)
    const receipt = await until(() => s2.browser.receipt(IH))
    assert.ok(receipt, 'the receipt arrived')
    assert.equal(receipt.total, 4096)
  })

  test('another key or a skewed clock is refused; three strikes close the wire', async () => {
    const wrong = setup({ browserKey: ROGUE.pub })
    const a = await connect(wrong)
    assert.equal(wrong.browser.isPinWire(a.bw), false, 'hello signed by a key other than _mw.cfg.pin')
    assert.equal(wrong.btm.anchored.length, 0)
    const skew = setup({ pinNow: () => NOW + SKEW_MS + 60000 })
    const b = await connect(skew)
    assert.equal(skew.browser.isPinWire(b.bw), false, 'the pin clock is 6 minutes ahead')
    const s = setup()
    const c = await connect(s)
    for (let i = 0; i < 3; i++) c.pw.extended(EXT_NAME, new Uint8Array(FRAME_MAX + 1))
    await settle()
    assert.equal(s.btm.ignored.length, 1, 'oversized frames: ignoreWire after 3 strikes')
    assert.match(s.btm.ignored[0][1], /^mw_pin1:size/)
  })

  test('a receipt before hello counts for nothing; garbage and over-long sequences are dropped', async () => {
    const s = setup({ pinWin: null }) // no bridge: the pin side never authenticates
    const { bw, pw } = await connect(s)
    const rsig = b64url.encode(await sign(PIN.priv, receiptBytes(IH, 10, NOW)))
    pw.extended(EXT_NAME, encodeFrame({ t: 'rcpt', key: PIN.pub, ih: IH, total: 10, at: NOW, sig: rsig }))
    await settle()
    assert.equal(s.browser.receipt(IH), null)
    pw.extended(EXT_NAME, utf8.encode('not json'))
    pw.extended(EXT_NAME, encodeFrame({ t: 'future-kind', x: 1 }))
    await settle()
    assert.equal(s.btm.ignored.length, 0, 'one malformed frame and an unknown type are not three strikes')
    assert.equal(bw.destroyed, false)
  })

  test('responder only with the bridge: none, another key, or a child frame never answers', async () => {
    for (const [label, win] of [['no bridge', {}], ['another key', pinWindow(ROGUE)], ['child frame', pinWindow(PIN, { top: false })]]) {
      const s = setup({ pinWin: win })
      const { pw } = await connect(s)
      assert.equal(s.pin.responder, false, label)
      assert.equal(pw.frames.filter((f) => f.t === 'hello').length, 0, label)
    }
    const ok = setup()
    await ok.pin.ready
    assert.equal(ok.pin.responder, true)
    assert.ok(ok.pin instanceof PinWire)
  })

  test('a late wire gets the extension and an additive handshake; the pin key arriving later starts the chal', async () => {
    let key = null
    const btm = new FakeTM()
    const browser = createPinWire({ tm: btm, pinKey: () => key, win: {}, now: () => NOW, codec: SZ_CODEC }).attach()
    const [bw, pw] = pair()
    const ptm = new FakeTM()
    const pin = createPinWire({ tm: ptm, pinKey: () => PIN.pub, win: pinWindow(PIN), now: () => NOW, codec: SZ_CODEC }).attach()
    ptm.wire(pw)
    pw.handshakeExt()
    bw.peerExtendedMapping = Object.assign({}, bw.peerExtendedMapping)
    bw._extendedHandshakeSent = true
    btm.wire(bw, 'file', IH, true)
    assert.equal(bw.resent, 1, 'the handshake is sent again with mw_pin1 in it')
    await pin.ready
    await settle()
    assert.equal(bw.frames.filter((f) => f.t === 'chal').length, 0, 'no _mw.cfg.pin: no chal')
    key = PIN.pub
    await browser.refresh()
    await settle()
    assert.equal(bw.frames.filter((f) => f.t === 'chal').length, 1)
    assert.equal(browser.isPinWire(bw), true)
  })

  test('pinProgress reads the authenticated pin wire\'s bitfield', async () => {
    const s = setup()
    s.btm.local.set(IH, { complete: true, length: 4 * 16384, pieces: 4 })
    const { bw } = await connect(s)
    bw.peerPieces = { get: (i) => i < 3 }
    assert.equal(s.browser.pinProgress(IH), 75)
    assert.equal(s.browser.pinProgress(OTHER_IH), null)
  })
})

describe('the signed heartbeat', () => {
  async function signedStatus (keys, { at = NOW - 60000, ihs = [IH], items = null, site = 'mw1:site' } = {}) {
    const obj = { v: 1, t: 'mw-pin-status', key: keys.pub, site, at, items: items || ihs.map(statusItem), monthBytes: 1000, monthCap: 5000 }
    obj.sig = b64url.encode(await sign(keys.priv, statusBytes(obj)))
    return obj
  }

  function fetcher (body, log = []) {
    return async (url, init) => {
      log.push({ url, init })
      const bytes = typeof body === 'string' ? utf8.encode(body) : utf8.encode(JSON.stringify(body))
      return { ok: true, status: 200, headers: { get: () => String(bytes.length) }, body: null, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
    }
  }

  test('verifyStatusSZ: key, age, hashed items only', async () => {
    const ok = await verifyStatusSZ(await signedStatus(PIN), { expectKey: PIN.pub, now: NOW })
    assert.equal(ok.ok, true)
    assert.equal(ok.has(IH), true)
    assert.equal(ok.has(OTHER_IH), false)
    assert.equal((await verifyStatusSZ(await signedStatus(PIN), { expectKey: ROGUE.pub, now: NOW })).reason, 'key')
    assert.equal((await verifyStatusSZ(await signedStatus(PIN, { at: NOW - HEARTBEAT_MAX_AGE_MS - 1 }), { expectKey: PIN.pub, now: NOW })).reason, 'age')
    assert.equal((await verifyStatusSZ(await signedStatus(PIN, { items: [IH] }), { expectKey: PIN.pub, now: NOW })).reason, 'cleartext', 'an infohash in the clear')
    assert.equal((await verifyStatusSZ(await signedStatus(PIN, { items: new Array(4097).fill(statusItem(IH)) }), { expectKey: PIN.pub, now: NOW })).reason, 'items')
    const forged = await signedStatus(PIN)
    forged.items = [statusItem(OTHER_IH)]
    assert.equal((await verifyStatusSZ(forged, { expectKey: PIN.pub, now: NOW })).reason, 'sig')
    assert.equal((await verifyStatusSZ(await signedStatus(PIN), { expectKey: PIN.pub, now: NOW, site: 'mw1:other' })).reason, 'site')
  })

  test('fetchHeartbeat: <ws>/pin-status.json, at most every 10 minutes, cached, listed items only (both codecs)', async () => {
    for (const codec of [SZ_CODEC, null]) await heartbeatRun(codec)
  })

  async function heartbeatRun (codec) {
    let t = NOW
    const log = []
    const body = await signedStatus(PIN)
    const pw = createPinWire({ tm: new FakeTM(), pinKey: () => PIN.pub, win: {}, now: () => t, fetch: fetcher(body, log), codec, site: 'mw1:site' })
    const hb = await pw.fetchHeartbeat('https://site.example/ws')
    assert.equal(log[0].url, 'https://site.example/ws/pin-status.json')
    assert.equal(log[0].init.cache, 'no-store')
    assert.equal(hb.at, body.at)
    assert.equal(pw.evidence(IH).heartbeat.has, true)
    assert.equal(pw.evidence(OTHER_IH).heartbeat.has, false)
    t += HEARTBEAT_EVERY_MS - 1
    await pw.fetchHeartbeat('https://site.example/ws/')
    assert.equal(log.length, 1, 'not again within 10 minutes')
    t += 2
    await pw.fetchHeartbeat('https://site.example/ws/')
    assert.equal(log.length, 2)
    await pw.fetchHeartbeat('https://site.example/ws/', { force: true })
    assert.equal(log.length, 3)
  }

  test('the module-level fetchHeartbeat: one read, verified, no cache; reasons for every refusal', async () => {
    const body = await signedStatus(PIN)
    const ok = await fetchHeartbeat('https://site.example/ws/', { pinKey: PIN.pub, fetch: fetcher(body), now: () => NOW, site: 'mw1:site' })
    assert.equal(ok.ok, true)
    assert.equal(ok.heartbeat.has(IH), true)
    assert.equal(ok.heartbeat.monthCap, 5000)
    assert.equal((await fetchHeartbeat('https://site.example/ws/', { pinKey: null, fetch: fetcher(body) })).reason, 'no-key')
    assert.equal((await fetchHeartbeat('::bad', { pinKey: PIN.pub, fetch: fetcher(body) })).reason, 'bad-url')
    assert.equal((await fetchHeartbeat('https://site.example/ws/', { pinKey: PIN.pub, fetch: async () => ({ ok: false, status: 404 }) })).reason, 'http-404')
    assert.equal((await fetchHeartbeat('https://site.example/ws/', { pinKey: PIN.pub, fetch: async () => { throw new TypeError('offline') } })).reason, 'unreachable')
    assert.equal((await fetchHeartbeat('https://site.example/ws/', { pinKey: PIN.pub, fetch: fetcher(body), now: () => NOW, site: 'mw1:other' })).ok, false)
  })

  test('a heartbeat signed by another key, oversized or not JSON is never kept', async () => {
    const warnings = []
    const rogue = createPinWire({ tm: new FakeTM(), pinKey: () => PIN.pub, win: {}, now: () => NOW, fetch: fetcher(await signedStatus(ROGUE)), codec: SZ_CODEC })
    rogue.on('warning', (w) => warnings.push(w.reason))
    assert.equal(await rogue.fetchHeartbeat('https://site.example/ws/'), null)
    const big = createPinWire({ tm: new FakeTM(), pinKey: () => PIN.pub, win: {}, now: () => NOW, fetch: fetcher('x'.repeat(262145)), codec: SZ_CODEC })
    big.on('warning', (w) => warnings.push(w.reason))
    assert.equal(await big.fetchHeartbeat('https://site.example/ws/'), null)
    const junk = createPinWire({ tm: new FakeTM(), pinKey: () => PIN.pub, win: {}, now: () => NOW, fetch: fetcher('{nope'), codec: SZ_CODEC })
    junk.on('warning', (w) => warnings.push(w.reason))
    assert.equal(await junk.fetchHeartbeat('https://site.example/ws/'), null)
    assert.deepEqual(warnings, ['key', 'too-large', 'json'])
    const nokey = createPinWire({ tm: new FakeTM(), pinKey: () => null, win: {}, now: () => NOW, fetch: async () => { throw new Error('must not fetch') }, codec: SZ_CODEC })
    assert.equal(await nokey.fetchHeartbeat('https://site.example/ws/'), null, 'no _mw.cfg.pin: nothing is fetched')
  })
})

describe('test/vectors/pin.json (lane pin-node)', () => {
  const file = ROOT + 'test/vectors/pin.json'
  const vectors = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).vectors : null

  test('the signing strings, frames and heartbeat vectors verify with the SZ codec and with the loaded codec', async (t) => {
    if (!vectors) return t.skip('test/vectors/pin.json has not landed yet (lane pin-node)')
    const codec = await loadPinCodec()
    let checked = 0
    for (const v of vectors) {
      const i = v.input || {}
      const e = v.expect || {}
      if (v.id.startsWith('pin-hello') || v.id.startsWith('pin-rcpt')) {
        const hello = v.id.startsWith('pin-hello')
        const bytes = hello ? helloBytes(i.ih, i.n, i.at) : receiptBytes(i.ih, i.total, i.at)
        assert.equal(utf8.decode(bytes), e.signingInput, v.id)
        const frame = decodeFrame(utf8.encode(e.frame))
        for (const c of [SZ_CODEC, codec]) {
          const r = hello
            ? await c.verifyHello(frame, { expectKey: i.expectKey, ih: i.ih, n: i.n, now: i.now })
            : await c.verifyReceipt(frame, { expectKey: i.expectKey, ih: i.ih, now: i.now })
          assert.equal(r.ok, true, v.id + ' with ' + c.source)
        }
        checked++
      } else if (v.id === 'pin-status-001') {
        for (const [ih, id] of Object.entries(e.itemIds)) assert.equal(statusItem(ih), id, 'item id of ' + ih)
        const obj = JSON.parse(e.file)
        assert.equal(utf8.decode(statusBytes(obj)), e.signingInput)
        for (const c of [SZ_CODEC, codec]) {
          const r = await c.verifyStatus(obj, { expectKey: i.expectKey, now: i.now, site: i.site })
          assert.equal(r.ok, true, v.id + ' with ' + c.source)
        }
        checked++
      } else if (v.id.startsWith('pin-neg') && i.frame && e.verify) {
        const frame = decodeFrame(utf8.encode(i.frame))
        for (const c of [SZ_CODEC, codec]) {
          const r = frame.t === 'hello'
            ? await c.verifyHello(frame, { expectKey: i.expectKey, ih: i.ih, n: i.n, now: i.now })
            : await c.verifyReceipt(frame, { expectKey: i.expectKey, ih: i.ih, now: i.now })
          assert.equal(r.ok, false, v.id + ' with ' + c.source)
        }
        checked++
      } else if (v.id.startsWith('pin-neg') && i.frame && e.decode) {
        assert.equal(decodeFrame(utf8.encode(i.frame)), null, v.id)
        checked++
      } else if (v.id.startsWith('pin-neg') && i.file) {
        const obj = JSON.parse(i.file)
        for (const c of [SZ_CODEC, codec]) {
          const r = await c.verifyStatus(obj, { expectKey: i.expectKey, now: i.now, site: i.site })
          assert.equal(r.ok, false, v.id + ' with ' + c.source)
        }
        checked++
      }
    }
    t.diagnostic('pin.json vectors checked: ' + checked + ' (codec ' + codec.source + ')')
    assert.ok(checked >= 10)
  })
})

describe('createPinPageHost and the site ledger deny list (review round MAL53-3)', () => {
  const FakeStore = function () {}
  const fakeTm = () => {
    const joined = []
    return {
      joined,
      async addFileTorrent (o) {
        const h = { ih: o.infoHash, left: false, uploaded: 7, done: true, async leave () { this.left = true } }
        joined.push(h)
        return h
      }
    }
  }
  const SHA = 'ef'.repeat(32)

  test('start refuses a denied infohash or declared SHA-256 and joins no swarm', async () => {
    const tm = fakeTm()
    const denied = new Set([IH, SHA])
    const host = createPinPageHost({ tm, storeClass: () => FakeStore, isDenied: async (id) => denied.has(id) })
    assert.equal(await host.start({ ih: IH }), 'denied')
    assert.equal(await host.start({ ih: OTHER_IH, sha256: SHA.toUpperCase() }), 'denied', 'the declared hash counts, in any case')
    assert.equal(tm.joined.length, 0)
    assert.deepEqual(host.status().files, [])
  })

  test('a later _deny/ entry makes the host leave an item it already holds (start, sweep and status)', async () => {
    const tm = fakeTm()
    const denied = new Set()
    const discarded = []
    const host = createPinPageHost({ tm, storeClass: () => FakeStore, isDenied: async (id) => denied.has(id), discard: async (ih) => { discarded.push(ih) } })
    assert.equal(await host.start({ ih: IH }), 'seeding')
    assert.equal(await host.start({ ih: OTHER_IH, sha256: SHA }), 'seeding')
    assert.deepEqual(tm.joined.map((h) => h.ih), [IH, OTHER_IH])
    // sweep(): the deny of a held infohash leaves that swarm and forgets the item
    denied.add(IH)
    assert.deepEqual(await host.sweep(), [IH])
    assert.equal(tm.joined[0].left, true)
    assert.equal(tm.joined[1].left, false)
    assert.deepEqual(host.status().files.map((f) => f.ih), [OTHER_IH])
    assert.equal(await host.start({ ih: IH }), 'denied', 'and it is not joined again')
    assert.equal(tm.joined.length, 2)
    // status() runs the sweep in the background (tools/pin.mjs reads it every two seconds): a deny of the hash the held item
    // declared ends it too
    denied.add(SHA)
    await until(() => { host.status(); return tm.joined[1].left })
    assert.equal(tm.joined[1].left, true)
    assert.deepEqual(host.status().files, [])
    assert.deepEqual(discarded, [IH, OTHER_IH], 'a denied item\'s stored bytes are handed to discard()')
    assert.equal(await host.stop(OTHER_IH), 'not-held')
  })

  test('start() of a held item checks the deny list again; a check that throws is not a deny; no isDenied, no sweep', async () => {
    const tm = fakeTm()
    let deny = false
    const host = createPinPageHost({ tm, storeClass: () => FakeStore, isDenied: async () => { if (deny === 'throw') throw new Error('no ledger'); return deny } })
    assert.equal(await host.start({ ih: IH }), 'seeding')
    deny = 'throw'
    assert.equal(await host.start({ ih: IH }), 'seeding', 'a failed check keeps the item')
    assert.deepEqual(await host.sweep(), [])
    deny = true
    assert.equal(await host.start({ ih: IH }), 'denied', 'a held item the ledger now denies is left')
    assert.equal(tm.joined[0].left, true)
    assert.deepEqual(host.status().files, [])
    const plain = createPinPageHost({ tm: fakeTm(), storeClass: () => FakeStore })
    assert.equal(await plain.start({ ih: IH }), 'seeding')
    assert.deepEqual(await plain.sweep(), [])
    assert.equal(plain.status().files.length, 1)
  })
})
