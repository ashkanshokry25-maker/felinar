// VERIFY claim 2 counter-test: do PROTOTYPE-level hooks, installed AFTER import('/webtorrent.min.js'), still observe the traffic?
import http from 'node:http'
import fs from 'node:fs'
import { createRequire } from 'node:module'
const PROJ = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '') // <repo root>
const require = createRequire(PROJ + '/package.json')
const { Server } = await import(PROJ + '/node_modules/bittorrent-tracker/index.js')
const { chromium } = await import(PROJ + '/node_modules/playwright/index.mjs')
const WT = PROJ + '/node_modules/webtorrent/dist/webtorrent.min.js'
const PAGE = `<!doctype html><meta charset="utf-8"><script type="module">
const MODE = new URLSearchParams(location.search).get('mode')   // proto-after | proto-before | ctor-after
const TR = 'ws://127.0.0.1:18420'
const diag = { ws: new Map(), pc: new Map(), t0: performance.now() }
const T = () => Math.round(performance.now() - diag.t0)
function trackWS (ws) {
  if (diag.ws.has(ws)) return diag.ws.get(ws)
  const rec = { url: ws.url, firstSeenAt: T(), readyStateWhenSeen: ws.readyState, in: {}, out: {}, tracker: [] }
  diag.ws.set(ws, rec)
  ws.addEventListener('close', (e) => { rec.code = e.code })
  ws.addEventListener('message', (ev) => { try { const j = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)); const a = j.action || '?'; rec.in[a] = (rec.in[a] || 0) + 1; if (j.action === 'announce' && j.complete != null) rec.tracker.push({ complete: j.complete, incomplete: j.incomplete, interval: j.interval }) } catch (_) {} })
  return rec
}
function trackPC (pc) {
  if (diag.pc.has(pc)) return
  const rec = { firstSeenAt: T(), ice: [], conn: [], cand: {} }
  diag.pc.set(pc, rec)
  pc.addEventListener('iceconnectionstatechange', () => rec.ice.push(pc.iceConnectionState))
  pc.addEventListener('connectionstatechange', () => rec.conn.push(pc.connectionState))
  pc.addEventListener('icecandidate', (e) => { if (e.candidate) { const m = / typ (\\w+)/.exec(e.candidate.candidate); const t = m ? m[1] : '?'; rec.cand[t] = (rec.cand[t] || 0) + 1 } })
}
function installProto () {
  const origSend = WebSocket.prototype.send
  WebSocket.prototype.send = function (d) { const rec = trackWS(this); try { const j = JSON.parse(d); rec.out[j.action || '?'] = (rec.out[j.action || '?'] || 0) + 1 } catch (_) {} return origSend.call(this, d) }
  for (const m of ['createDataChannel', 'createOffer', 'setLocalDescription', 'setRemoteDescription', 'createAnswer', 'addIceCandidate']) {
    const o = RTCPeerConnection.prototype[m]
    RTCPeerConnection.prototype[m] = function (...a) { trackPC(this); return o.apply(this, a) }
  }
}
function installCtor () {
  const NativeWS = window.WebSocket
  window.WebSocket = class extends NativeWS { constructor (u, p) { super(u, p); trackWS(this) } }
  const NativePC = window.RTCPeerConnection
  window.RTCPeerConnection = class extends NativePC { constructor (c) { super(c); trackPC(this) } }
}
if (MODE === 'proto-before') installProto()
const { default: WebTorrent } = await import('/webtorrent.min.js')
if (MODE === 'proto-after') installProto()
if (MODE === 'ctor-after') installCtor()
const opts = { dht: false, lsd: false, utPex: false, tracker: { announce: [TR], rtcConfig: { iceServers: [] } } }
const A = new WebTorrent(opts); const B = new WebTorrent(opts)
const file = new File([new Uint8Array(400000).map((_, i) => (i * 7) % 251)], 'a.bin')
const seeded = await new Promise((res) => A.seed(file, { announce: [TR], name: 'poc' }, res))
const tB = B.add(seeded.magnetURI, { announce: [TR] })
const done = await Promise.race([new Promise((r) => tB.on('done', () => r(true))), new Promise((r) => setTimeout(() => r(false), 20000))])
await new Promise((r) => setTimeout(r, 800))
window.__result = { mode: MODE, done, wsCount: diag.ws.size, pcCount: diag.pc.size,
  ws: [...diag.ws.values()].map((w) => ({ url: w.url, readyStateWhenFirstSeen: w.readyStateWhenSeen, in: w.in, out: w.out, tracker: w.tracker.slice(0, 2) })),
  pcConnected: [...diag.pc.values()].filter((p) => p.conn.includes('connected')).length,
  pcWithCandidates: [...diag.pc.values()].filter((p) => Object.keys(p.cand).length).length }
</script>`
const tracker = new Server({ udp: false, http: false, ws: true, stats: false })
await new Promise((res, rej) => { tracker.on('error', rej); tracker.listen(18420, '127.0.0.1', res) })
const web = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); if (u.pathname === '/webtorrent.min.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); fs.createReadStream(WT).pipe(res) } else { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE) } }).listen(18421, '127.0.0.1')
const browser = await chromium.launch({ headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] })
console.log('Chromium', browser.version())
for (const mode of ['ctor-after', 'proto-after', 'proto-before']) {
  const page = await (await browser.newContext()).newPage()
  page.on('pageerror', (e) => console.log('pageerror', String(e).slice(0, 200)))
  await page.goto('http://127.0.0.1:18421/?mode=' + mode)
  await page.waitForFunction(() => window.__result, null, { timeout: 40000 }).catch(() => {})
  console.log(mode.padEnd(13), JSON.stringify(await page.evaluate(() => window.__result || null)))
  await page.close()
}
await browser.close(); web.close(); tracker.close(); process.exit(0)
