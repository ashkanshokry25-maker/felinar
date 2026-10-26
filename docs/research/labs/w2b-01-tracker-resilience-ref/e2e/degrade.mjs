// Experiment: what does a real WebTorrent 3.0.21 browser client do when every tracker is down?
// Scenarios differ only in the magnet link. The web seed (HTTP, Range, CORS) and the .torrent live on a separate origin.
import { makeSite, startWebSeed, startPageServer, startBlackHole, startMuteWs, deadPort, startTracker, launch, sleep } from './lib.mjs'

const site = await makeSite()
const seed = await startWebSeed(site)
const pageSrv = await startPageServer()
const dead = await deadPort()
const hole = await startBlackHole()
const mute = await startMuteWs()
const live = await startTracker({ ANNOUNCE_INTERVAL_S: '120' })
const browser = await launch()
console.log('browser:', process.env.BROWSER || 'chromium', browser.version(), process.env.MEMSTORE === '1' ? '(custom in-memory chunk store)' : '(default chunk store)')

const enc = encodeURIComponent
const base = `magnet:?xt=urn:btih:${site.infoHash}&dn=${site.name}`
const ws = `&ws=${enc(seed.base + '/ws/')}`
const xs = `&xs=${enc(seed.base + '/site.torrent')}`
const tr = (u) => `&tr=${enc(u)}`
const scenarios = [
  ['A magnet only, dead tracker (connection refused), NO ws, NO xs', base + tr(`ws://127.0.0.1:${dead}`), 15000],
  ['B ws only (no xs), dead tracker', base + ws + tr(`ws://127.0.0.1:${dead}`), 15000],
  ['C ws + xs, dead tracker (connection refused)', base + ws + xs + tr(`ws://127.0.0.1:${dead}`), 15000],
  ['D ws + xs, tracker host is a TCP black hole', base + ws + xs + tr(`ws://127.0.0.1:${hole.port}`), 15000],
  ['E ws + xs, tracker completes the handshake but never answers', base + ws + xs + tr(`ws://127.0.0.1:${mute.port}`), 15000],
  ['F ws + xs, tracker alive (hardened) but no other peers', base + ws + xs + tr(`ws://127.0.0.1:${live.port}`), 15000],
  ['G ws + xs, NO tracker at all', base + ws + xs, 15000],
  ['H ws + xs, wss tracker with unresolvable host', base + ws + xs + tr('wss://tracker.invalid'), 15000],
  ['I xs only (no ws), dead tracker', base + xs + tr(`ws://127.0.0.1:${dead}`), 15000]
]
const results = []
for (const [label, magnet, waitMs] of scenarios) {
  const page = await browser.newPage()
  await page.goto(pageSrv.base + '/p.html')
  const r = await page.evaluate(async ({ magnet, waitMs, memstore }) => {
    const { default: WebTorrent } = await import('/wt.js')
    const t0 = performance.now(); const ev = []
    const log = (e, x) => ev.push({ t: Math.round(performance.now() - t0), e, ...x })
    const client = new WebTorrent({ tracker: { rtcConfig: { iceServers: [] } } })
    class MemStore { // minimal abstract-chunk-store (put/get take an optional opts argument), to take OPFS/IndexedDB differences out of the experiment
      constructor (chunkLength) { this.chunkLength = chunkLength; this.chunks = [] }
      put (i, buf, opts, cb) { if (typeof opts === 'function') cb = opts; this.chunks[i] = new Uint8Array(buf); queueMicrotask(() => cb(null)) }
      get (i, opts, cb) { if (typeof opts === 'function') { cb = opts; opts = {} } const b = this.chunks[i]; if (!b) return queueMicrotask(() => cb(new Error('Chunk not found'))); const o = (opts && opts.offset) || 0; const out = b.slice(o, opts && opts.length != null ? o + opts.length : undefined); queueMicrotask(() => cb(null, out)) }
      close (cb) { if (cb) queueMicrotask(() => cb(null)) }
      destroy (cb) { this.chunks = []; if (cb) queueMicrotask(() => cb(null)) }
    }
    const torrent = client.add(magnet, memstore ? { store: MemStore } : {})
    torrent.on('metadata', () => log('metadata'))
    torrent.on('wire', (w) => log('wire', { type: w.type }))
    torrent.on('done', () => log('done', { bytes: torrent.downloaded }))
    torrent.on('noPeers', (s) => log('noPeers', { src: s }))
    torrent.on('warning', (e) => log('warning', { msg: String(e.message).slice(0, 90) }))
    torrent.on('error', (e) => log('error', { msg: String(e.message).slice(0, 90) }))
    await new Promise((r) => setTimeout(r, waitMs))
    const out = { ev: ev.slice(0, 14), progress: Math.round(torrent.progress * 100), done: torrent.done, peers: torrent.numPeers }
    client.destroy()
    return out
  }, { magnet, waitMs, memstore: process.env.MEMSTORE === '1' })
  results.push({ label, ...r })
  console.log(JSON.stringify({ label, done: r.done, progress: r.progress, firstMetadataMs: (r.ev.find((x) => x.e === 'metadata') || {}).t ?? null, firstWire: (r.ev.find((x) => x.e === 'wire') || {}), doneMs: (r.ev.find((x) => x.e === 'done') || {}).t ?? null, events: r.ev.map((x) => `${x.t}:${x.e}${x.type ? '(' + x.type + ')' : ''}${x.src ? '(' + x.src + ')' : ''}${x.msg ? '[' + x.msg + ']' : ''}`) }))
  await page.close()
}
console.log('web seed HTTP requests served:', seed.srv.hits)
await browser.close(); live.stop(); process.exit(0)
