// In-page helpers for the topic-12 experiments (served by lab.mjs at /page-lib.js).
// Everything the orchestrator needs is hung off window.lab so page.evaluate() can call it.
import WebTorrent from '/webtorrent.min.js'

const now = () => performance.now()
const lab = (window.lab = { WebTorrent, clients: {}, torrents: {}, wires: [], logs: [], announces: [], pings: {}, t0: now() })
lab.log = (...a) => lab.logs.push([Math.round(now() - lab.t0), ...a.map(x => (typeof x === 'string' ? x : JSON.stringify(x)))])

// ---- capture the announce payloads that actually leave the page (tracker WebSocket) -------------------------
const origSend = WebSocket.prototype.send
WebSocket.prototype.send = function (d) {
  try {
    let s = d
    if (typeof d !== 'string' && d && (d.byteLength !== undefined)) s = new TextDecoder().decode(d)
    if (typeof s === 'string' && s.indexOf('"action":"announce"') !== -1) {
      const j = JSON.parse(s)
      lab.announces.push({
        t: Math.round(now() - lab.t0), url: this.url, event: j.event,
        left: j.left === undefined ? '<absent>' : j.left, uploaded: j.uploaded, downloaded: j.downloaded,
        numwant: j.numwant, nOffers: j.offers ? j.offers.length : 0, hasAnswer: !!j.answer,
        ih: j.info_hash ? [...j.info_hash].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('') : null
      })
    }
  } catch (_) { /* ignore */ }
  return origSend.apply(this, arguments)
}

// ---- tiny in-memory abstract-chunk-store (same as the 01 lab) -------------------------------------------------
class MemStore {
  constructor (chunkLength, opts) { this.chunkLength = chunkLength; this.chunks = new Map(); this.length = opts.length }
  put (i, buf, cb = () => {}) { this.chunks.set(i, new Uint8Array(buf)); queueMicrotask(() => cb(null)) }
  get (i, o, cb) {
    if (typeof o === 'function') { cb = o; o = {} }
    const c = this.chunks.get(i)
    if (!c) { const e = new Error('Chunk not found'); e.notFound = true; return queueMicrotask(() => cb(e)) }
    const off = (o && o.offset) || 0; const len = (o && o.length) || (c.length - off)
    queueMicrotask(() => cb(null, c.slice(off, off + len)))
  }
  close (cb = () => {}) { queueMicrotask(() => cb(null)) }
  destroy (cb = () => {}) { this.chunks.clear(); queueMicrotask(() => cb(null)) }
}
lab.MemStore = MemStore

lab.mk = (id, opts = {}) => {
  const c = new WebTorrent({ dht: false, lsd: false, utPex: false, tracker: { rtcConfig: { iceServers: [] } }, ...opts })
  c.on('error', e => lab.log('client error', String(e && e.message || e)))
  lab.clients[id] = c
  return c.peerId
}

// ---- ping/pong wire extension -----------------------------------------------------------------------------------
// frame: [type u8][seq u32][sentAt f64][pad...]   type 1 = ping, 2 = pong, 3 = bulk data (counted only)
const encFrame = (type, seq, t, size) => {
  const u = new Uint8Array(Math.max(13, size | 0)); const dv = new DataView(u.buffer)
  u[0] = type; dv.setUint32(1, seq); dv.setFloat64(5, t); return u
}
const stat = tag => (lab.pings[tag] ??= { sent: 0, recv: 0, rtts: [], inBytes: 0, inMsgs: 0 })
const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null
const r1 = x => x === null ? null : Math.round(x * 10) / 10
lab.summ = tag => {
  const s = stat(tag); const a = s.rtts.slice().sort((x, y) => x - y)
  return { tag, sent: s.sent, recv: s.recv, lost: s.sent - s.recv, min: r1(a[0] ?? null), p50: r1(pct(a, 0.5)), p90: r1(pct(a, 0.9)), p99: r1(pct(a, 0.99)), max: r1(a[a.length - 1] ?? null), mean: a.length ? r1(a.reduce((x, y) => x + y, 0) / a.length) : null, inBytes: s.inBytes, inMsgs: s.inMsgs }
}
lab.reset = tag => { lab.pings[tag] = { sent: 0, recv: 0, rtts: [], inBytes: 0, inMsgs: 0 } }

const makeExt = tag => {
  class Ext {
    constructor (wire) {
      this.wire = wire
      if (lab.reqq) wire.extendedHandshake.reqq = lab.reqq // BEP 10 'reqq': caps the peer's request pipeline (webtorrent honours it)
      if (lab.fakeMetaSize) wire.extendedHandshake.metadata_size = lab.fakeMetaSize // e12: pretend to hold 10 MB of metadata
      if (lab.cancelMeta) { try { wire.ut_metadata.cancel() } catch (_) { /* ignore */ } } // e12 mitigation: stop ut_metadata fetching on this wire
      if (lab.countMetaReq) { const um = wire.ut_metadata; const orig = um._request.bind(um); um._request = piece => { lab.metaReqs = (lab.metaReqs || 0) + 1; return orig(piece) } }
      this.rec = { tag, wire, tAttach: now(), tHs: null, hs: null, errors: 0, type: wire.type }
      lab.wires.push(this.rec)
    }
    onExtendedHandshake (hs) { this.rec.tHs = now(); this.rec.hs = hs }
    onMessage (buf) {
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
      if (buf[0] === 1) {
        const out = buf.slice(); out[0] = 2
        try { this.wire.extended('mw_x', out) } catch (e) { this.rec.errors++ }
      } else if (buf[0] === 2) {
        const s = stat(tag); s.recv++; s.rtts.push(now() - dv.getFloat64(5))
      } else if (buf[0] === 3) { const s = stat(tag); s.inBytes += buf.length; s.inMsgs++ }
    }
  }
  Ext.prototype.name = 'mw_x'
  return Ext
}

// send one ping on every ready wire carrying `tag`; resolves summary after the in-flight pongs settle
lab.pingLoop = (tag, intervalMs, durationMs, size = 64, settleMs = 1500) => new Promise(resolve => {
  lab.reset(tag); const s = stat(tag); const t0 = now(); let seq = 0
  const h = setInterval(() => {
    for (const r of lab.wires) {
      if (r.tag !== tag || !r.tHs || r.wire.destroyed) continue
      try { r.wire.extended('mw_x', encFrame(1, seq++, now(), size)); s.sent++ } catch (e) { r.errors++ }
    }
    if (now() - t0 >= durationMs) { clearInterval(h); setTimeout(() => resolve(lab.summ(tag)), settleMs) }
  }, intervalMs)
})
// fire-and-forget pinger that several tags can share (alternating) while a transfer runs
lab.startPingers = (tags, intervalMs, size = 64) => {
  tags.forEach(t => lab.reset(t))
  let seq = 0; let k = 0
  lab.pingTimer = setInterval(() => {
    const tag = tags[k++ % tags.length]; const s = stat(tag)
    for (const r of lab.wires) {
      if (r.tag !== tag || !r.tHs || r.wire.destroyed) continue
      try { r.wire.extended('mw_x', encFrame(1, seq++, now(), size)); s.sent++ } catch (e) { r.errors++ }
    }
  }, intervalMs)
}
lab.stopPingers = (tags, settleMs = 1500) => new Promise(resolve => {
  clearInterval(lab.pingTimer)
  setTimeout(() => resolve(tags.map(t => lab.summ(t))), settleMs)
})

// ---- swarm helpers -----------------------------------------------------------------------------------------------
lab.joinRv = (cid, rvHex, trackerUrl, tag, opts = {}) => {
  const c = lab.clients[cid]
  const t = c.add(rvHex, { announce: [trackerUrl], ...opts }) // bare 40-hex infohash: no metadata anywhere, ever
  t.on('wire', w => w.use(makeExt(tag)))
  t.on('warning', e => lab.log('warning', tag, String(e && e.message || e)))
  t.on('error', e => lab.log('error', tag, String(e && e.message || e)))
  lab.torrents[tag + ':' + cid] = t
  return t.infoHash
}
lab.seedBytes = (cid, bytes, name, trackerUrl, tag, opts = {}) => new Promise(resolve => {
  const c = lab.clients[cid]; const buf = new Uint8Array(bytes)
  let x = (0x9e3779b9 ^ bytes) >>> 0
  for (let i = 0; i < bytes; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; buf[i] = x & 255 }
  const t = c.seed(new File([buf], name), { name, announce: [trackerUrl], store: MemStore, pieceLength: 262144, ...opts })
  t.on('wire', w => w.use(makeExt(tag)))
  lab.torrents[tag + ':' + cid] = t
  t.once('ready', () => resolve(t.infoHash))
})
lab.seedText = (cid, text, trackerUrl, tag, opts = {}) => new Promise(resolve => {
  // bugout-style rendezvous: a one-file torrent named and filled with the identifier string
  const c = lab.clients[cid]
  const t = c.seed(new File([text], text), { name: text, announce: [trackerUrl], store: MemStore, ...opts })
  t.on('wire', w => w.use(makeExt(tag)))
  t.on('warning', e => lab.log('warning', tag, String(e && e.message || e)))
  lab.torrents[tag + ':' + cid] = t
  t.once('ready', () => resolve({ infoHash: t.infoHash, length: t.length, pieceLength: t.pieceLength, name: t.name }))
})
lab.addMagnet = (cid, ih, trackerUrl, tag, store = true) => {
  const c = lab.clients[cid]
  const t = c.add(`magnet:?xt=urn:btih:${ih}&tr=${encodeURIComponent(trackerUrl)}`, store ? { store: MemStore } : {})
  t.on('wire', w => w.use(makeExt(tag)))
  t.on('warning', e => lab.log('warning', tag, String(e && e.message || e)))
  lab.torrents[tag + ':' + cid] = t
  return t.infoHash
}
lab.wireInfo = () => lab.wires.map(r => ({
  tag: r.tag, type: r.wire.type, destroyed: !!r.wire.destroyed, hsMs: r.tHs === null ? null : Math.round(r.tHs - r.tAttach),
  peerIdPrefix: String(r.wire.peerId || '').slice(0, 8), mapping: r.wire.peerExtendedMapping, errors: r.errors,
  myMapping: r.wire.extendedMapping
}))
lab.wireCount = tag => lab.wires.filter(r => r.tag === tag && !r.wire.destroyed && r.tHs).length
lab.torrentInfo = key => {
  const t = lab.torrents[key]; if (!t) return null
  return { infoHash: t.infoHash, ready: t.ready, hasMetadata: !!t.metadata, numPeers: t.numPeers, wires: t.wires.length, done: t.done, progress: Math.round(t.progress * 1000) / 1000, downloaded: t.downloaded, received: t.received, uploaded: t.uploaded, length: t.length ?? null }
}
lab.throttle = (cid, rate) => lab.clients[cid].throttleUpload(rate)
lab.waitFor = (fn, timeoutMs, stepMs = 50) => new Promise(resolve => {
  const t0 = now(); const h = setInterval(() => {
    let v = false; try { v = fn() } catch (_) { /* ignore */ }
    if (v) { clearInterval(h); resolve({ ok: true, ms: Math.round(now() - t0) }) } else if (now() - t0 > timeoutMs) { clearInterval(h); resolve({ ok: false, ms: Math.round(now() - t0) }) }
  }, stepMs)
})
lab.destroyAll = async () => { for (const c of Object.values(lab.clients)) { try { await new Promise(r => c.destroy(r)) } catch (_) { /* ignore */ } } }
window.__labReady = true
