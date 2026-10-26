// Announce/offer policies for small swarms, measured with the real WebTorrent 3.0.21 bundle in Chromium.
// 3 local trackers (hardened tracker.mjs, ANNOUNCE_INTERVAL_S=10 so one minute = 6 announce cycles; scale x12 for the real 120 s).
// Phases per policy: (1) page A alone for 30 s, (2) page B joins -> time to B's first WebRTC wire, (3) both connected, 30 s steady state.
// Counted per page: RTCPeerConnection constructions (instrumented) and WebSocket frames sent/received on the tracker sockets.
import { makeSite, startWebSeed, startPageServer, startTracker, launch, sleep } from './lib.mjs'
const INTERVAL = 10
const site = await makeSite(); const seed = await startWebSeed(site); const pageSrv = await startPageServer()
const trackers = []
for (let i = 0; i < 3; i++) trackers.push(await startTracker({ ANNOUNCE_INTERVAL_S: String(INTERVAL), METRICS_PORT: String(19700 + i) }))
const browser = await launch()
const enc = encodeURIComponent
const trs = trackers.map((t) => `&tr=${enc('ws://127.0.0.1:' + t.port)}`).join('')
const magnet = `magnet:?xt=urn:btih:${site.infoHash}&dn=${site.name}&ws=${enc(seed.base + '/ws/')}&xs=${enc(seed.base + '/site.torrent')}${trs}`
const policies = [
  ['P0 stock: numwant 50 capped to 5 offers per tracker per announce', 'stock'],
  ['P1 fixed numwant 2', 'fixed2'],
  ['P2 adaptive by connected WebRTC peers: numwant 3 while < 2, else 0', 'adaptive'],
  ['P3 = P2 + keepalive announce every INTERVAL/2 (per-instance setInterval cap)', 'adaptive+cap'],
  ['P4 count-aware probe-then-offer: numwant 0 until a tracker reports other peers (complete+incomplete-1), then 3 until min(2, others) WebRTC peers are connected', 'probe']
]
// in-page code: install the policy on a client/torrent
const INSTALL = `(name, c, t, capMs) => {
  const rp = () => t.wires.filter((w) => w.type === 'webrtc').length   // WebRTC peers only (the web seed is also a wire)
  const st = { others: null, lastUpdate: 0 }
  const base = () => (rp() >= 2 ? 0 : 3)
  const aware = () => (st.others === null ? 0 : (rp() >= Math.min(2, st.others) ? 0 : 3))
  if (name === 'fixed2') c.tracker.getAnnounceOpts = () => ({ numwant: 2 })
  if (name === 'adaptive' || name === 'adaptive+cap') c.tracker.getAnnounceOpts = () => ({ numwant: base() })
  if (name === 'probe') c.tracker.getAnnounceOpts = () => ({ numwant: aware() })
  const poll = () => {
    const d = t.discovery && t.discovery.tracker
    if (!d || !d._trackers || !d._trackers.length) return setTimeout(poll, 10)
    if (name === 'adaptive+cap') for (const x of d._trackers) { const orig = x.setInterval.bind(x); x.setInterval = (ms) => orig(Math.min(ms == null ? 30000 : ms, capMs)); x.setInterval(capMs) }
    if (name === 'probe') d.on('update', (r) => {
      const o = (r.complete || 0) + (r.incomplete || 0) - 1   // the tracker counts us too
      st.others = o
      if (o > 0 && rp() < Math.min(2, o) && Date.now() - st.lastUpdate > 3000) { st.lastUpdate = Date.now(); d.update() }
    })
  }
  poll()
}`
const out = []
const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null)
const ctxOpts = async () => {
  const ctx = await browser.newContext()
  await ctx.addInitScript(() => {
    const Orig = window.RTCPeerConnection
    window.__rtc = { n: 0 }
    window.RTCPeerConnection = function (...a) { window.__rtc.n++; return new Orig(...a) }
    window.RTCPeerConnection.prototype = Orig.prototype
    Object.setPrototypeOf(window.RTCPeerConnection, Orig)
  })
  return ctx
}
const track = (page) => {
  const f = { sent: 0, sentBytes: 0, recvBytes: 0, announces: 0, offerBytes: [] }
  page.on('websocket', (ws) => {
    ws.on('framesent', (e) => { const s = typeof e.payload === 'string' ? e.payload : e.payload.toString(); f.sent++; f.sentBytes += s.length; if (s.includes('"action":"announce"')) { f.announces++; const m = (s.match(/"offer_id"/g) || []).length; if (m && !s.includes('"answer"')) f.offerBytes.push(Math.round(s.length / m)) } })
    ws.on('framereceived', (e) => { const s = typeof e.payload === 'string' ? e.payload : e.payload.toString(); f.recvBytes += s.length })
  })
  return f
}
const start = (page, policy) => page.evaluate(async ({ magnet, policy, INSTALL, capMs }) => {
  const { default: WebTorrent } = await import('/wt.js')
  const c = new WebTorrent({ tracker: { rtcConfig: { iceServers: [] } } })
  const t = c.add(magnet, {})
  window.__c = c; window.__t = t; window.__t0 = performance.now(); window.__wire = null
  t.on('wire', (w) => { if (w.type === 'webrtc' && window.__wire === null) window.__wire = Math.round(performance.now() - window.__t0) })
  // eslint-disable-next-line no-eval
  ;(0, eval)(INSTALL)(policy, c, t, capMs)
}, { magnet, policy, INSTALL, capMs: INTERVAL * 500 })
const rtcN = (p) => p.evaluate(() => window.__rtc.n)
for (const [label, policy] of policies) {
  const ctxA = await ctxOpts(); const ctxB = await ctxOpts()
  const pA = await ctxA.newPage(); const fA = track(pA); await pA.goto(pageSrv.base + '/a.html')
  await start(pA, policy)
  await sleep(4000)
  const a0 = await rtcN(pA); const fa0 = { sent: fA.sent, bytes: fA.sentBytes, recv: fA.recvBytes, ann: fA.announces }
  await sleep(30000) // phase 1: alone
  const a1 = await rtcN(pA); const fa1 = { sent: fA.sent, bytes: fA.sentBytes, recv: fA.recvBytes, ann: fA.announces }
  const pB = await ctxB.newPage(); const fB = track(pB); await pB.goto(pageSrv.base + '/b.html')
  await start(pB, policy)
  let bWire = null; const tj = Date.now()
  while (Date.now() - tj < 20000 && bWire === null) { bWire = await pB.evaluate(() => window.__wire); if (bWire === null) await sleep(50) }
  await sleep(6000)
  const aS0 = await rtcN(pA); const bS0 = await rtcN(pB); const fas0 = { sent: fA.sent, bytes: fA.sentBytes, recv: fA.recvBytes, ann: fA.announces }
  await sleep(30000) // phase 3: both connected
  const aS1 = await rtcN(pA); const bS1 = await rtcN(pB); const fas1 = { sent: fA.sent, bytes: fA.sentBytes, recv: fA.recvBytes, ann: fA.announces }
  const peersA = await pA.evaluate(() => window.__t.numPeers)
  const r = {
    policy: label,
    alone30s: { rtcPeerConnections: a1 - a0, announceFrames: fa1.ann - fa0.ann, bytesSentToTrackers: fa1.bytes - fa0.bytes, bytesReceivedFromTrackers: fa1.recv - fa0.recv },
    timeToFirstWebRtcWireForJoinerMs: bWire,
    connected30s: { peersA, rtcPeerConnectionsPageA: aS1 - aS0, rtcPeerConnectionsPageB: bS1 - bS0, announceFramesA: fas1.ann - fas0.ann, bytesSentA: fas1.bytes - fas0.bytes, bytesReceivedA: fas1.recv - fas0.recv },
    medianOfferJsonBytes: med([...fA.offerBytes, ...fB.offerBytes])
  }
  out.push(r); console.log(JSON.stringify(r))
  await ctxA.close(); await ctxB.close()
}
await browser.close(); for (const t of trackers) t.stop(); process.exit(0)
