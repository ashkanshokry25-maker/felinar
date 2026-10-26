// Real WebTorrent 3.0.21 in two Chromium pages discovers the other peer ONLY through the Durable Object tracker prototype
// (wrangler dev on 127.0.0.1:8787). Page A fills itself from the web seed; page B has no web seed and no xs and must get the
// metadata and every piece from page A over WebRTC.
import { makeSite, startWebSeed, startPageServer, launch, sleep } from './lib.mjs'
const DO = process.argv[2] || 'ws://127.0.0.1:8787'
const site = await makeSite(); const seed = await startWebSeed(site); const pageSrv = await startPageServer(); const browser = await launch()
const enc = encodeURIComponent
const tr = `&tr=${enc(DO + '/' + site.infoHash)}`
const magnetA = `magnet:?xt=urn:btih:${site.infoHash}&dn=${site.name}&ws=${enc(seed.base + '/ws/')}&xs=${enc(seed.base + '/site.torrent')}${tr}`
const magnetB = `magnet:?xt=urn:btih:${site.infoHash}&dn=${site.name}${tr}`
const runIn = (page, magnet, waitMs, label) => page.evaluate(async ({ magnet, waitMs, label }) => {
  const { default: WebTorrent } = await import('/wt.js')
  const t0 = performance.now(); const ev = []
  const log = (e, x) => ev.push({ t: Math.round(performance.now() - t0), e, ...x })
  const client = new WebTorrent({ tracker: { rtcConfig: { iceServers: [] } } })
  window.__client = client
  const torrent = client.add(magnet, {})
  torrent.on('metadata', () => log('metadata'))
  torrent.on('wire', (w) => log('wire', { type: w.type }))
  torrent.on('done', () => log('done', { bytes: torrent.downloaded }))
  torrent.on('warning', (e) => log('warning', { msg: String(e.message).slice(0, 80) }))
  torrent.on('trackerAnnounce', () => log('trackerAnnounce'))
  const end = performance.now() + waitMs
  while (performance.now() < end && !torrent.done) await new Promise((r) => setTimeout(r, 50))
  return { label, ev: ev.slice(0, 16), done: torrent.done, progress: torrent.progress, wires: torrent.wires.map((w) => w.type) }
}, { magnet, waitMs, label })
const pA = await browser.newPage(); await pA.goto(pageSrv.base + '/a.html')
const rA = await runIn(pA, magnetA, 20000, 'A (web seed + DO tracker)')
console.log(JSON.stringify(rA))
const pB = await browser.newPage(); await pB.goto(pageSrv.base + '/b.html')
const rB = await runIn(pB, magnetB, 30000, 'B (DO tracker only)')
console.log(JSON.stringify(rB))
const ok = rA.done && rB.done && rB.wires.includes('webrtc')
console.log(ok ? 'RESULT: B completed the download from A over WebRTC, discovered via the Durable Object tracker' : 'RESULT: FAILED')
await browser.close(); process.exit(ok ? 0 : 1)
