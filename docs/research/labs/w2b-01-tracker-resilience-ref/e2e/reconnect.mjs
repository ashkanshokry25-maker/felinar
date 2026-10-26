// How long does the stock WebTorrent tracker client stay out after its tracker restarts? N independent pages (= N independent socket pools).
// node reconnect.mjs stock|patched [N]      patched = per-instance override of _startReconnectTimer (full-jitter 1 s -> 60 s)
import { makeSite, startWebSeed, startPageServer, startTracker, launch, sleep } from './lib.mjs'
const mode = process.argv[2] || 'stock'; const N = Number(process.argv[3] || 10)
const site = await makeSite(); const seed = await startWebSeed(site); const pageSrv = await startPageServer(); const browser = await launch()
const PORT = 18991; const MPORT = 19791
let trk = await startTracker({ METRICS_PORT: String(MPORT) }, { port: PORT })
const enc = encodeURIComponent
const magnet = `magnet:?xt=urn:btih:${site.infoHash}&dn=${site.name}&ws=${enc(seed.base + '/ws/')}&xs=${enc(seed.base + '/site.torrent')}&tr=${enc('ws://127.0.0.1:' + PORT)}`
const conns = async () => { try { const t = await (await fetch(`http://127.0.0.1:${MPORT}/metrics`)).text(); return Number(/^mwt_connections ([0-9]+)/m.exec(t)[1]) } catch (_) { return -1 } }
const pages = []
for (let i = 0; i < N; i++) {
  const ctx = await browser.newContext(); const p = await ctx.newPage(); await p.goto(pageSrv.base + '/p' + i + '.html')
  await p.evaluate(async ({ magnet, mode }) => {
    const { default: WebTorrent } = await import('/wt.js')
    const c = new WebTorrent({ tracker: { rtcConfig: { iceServers: [] } } }); const t = c.add(magnet, {}); window.__t = t
    if (mode === 'patched') {
      const patch = () => { const tr = t.discovery && t.discovery.tracker && t.discovery.tracker._trackers; if (!tr) return setTimeout(patch, 50); for (const x of tr) { x._startReconnectTimer = function () { const ms = 500 + Math.random() * Math.min(60000, 1000 * 2 ** this.retries); this.reconnecting = true; clearTimeout(this.reconnectTimer); this.reconnectTimer = setTimeout(() => { this.retries++; this._openSocket() }, ms) } } }
      patch()
    }
  }, { magnet, mode })
  pages.push(p)
}
const t0 = Date.now()
while ((await conns()) < N && Date.now() - t0 < 30000) await sleep(200)
console.log(`mode=${mode} connected=${await conns()}/${N}`)
await sleep(3000)
trk.stop(); await sleep(2000)
const tKill = Date.now()
trk = await startTracker({ METRICS_PORT: String(MPORT) }, { port: PORT })
const tUp = Date.now()
let last = 0; const times = []
while (Date.now() - tUp < (mode === 'stock' ? 400000 : 90000)) {
  const c = await conns()
  while (c > last && last < N) { last++; times.push(Math.round((Date.now() - tUp) / 1000)) }
  if (last >= N) break
  await sleep(500)
}
console.log(JSON.stringify({ mode, N, reconnectedAfterSeconds: times, notReconnected: N - last, median: times.length ? times[Math.floor(times.length / 2)] : null, max: times.length ? Math.max(...times) : null }))
await browser.close(); trk.stop(); process.exit(0)
