// w1-13 A6: two real browser contexts exchange a torrent over WebRTC through a local bittorrent-tracker WS tracker,
// once with the official webpack bundle and once with our esbuild bundle (seeder uses preloadedStore + skipVerify, like the real loader).
// Usage: node docs/research/labs/w1-13-lab/a6-p2p-bundle.mjs [engine=chromium]   (BUNDLES=path1,path2 to override)
import { chromium, webkit } from 'playwright'
import Server from 'bittorrent-tracker/server'
import { makeSite, startPageServer, closeServer, WT_MIN } from './lib.mjs'
import { fileURLToPath } from 'node:url'

const engine = process.argv[2] ?? 'chromium'
const here = fileURLToPath(new URL('.', import.meta.url))
const bundles = (process.env.BUNDLES ? process.env.BUNDLES.split(',') : [WT_MIN, here + 'out/wt-slimnodebug.js'])
const site = await makeSite()
// concatenated payload in torrent order
const order = site.parsed.files.map(f => f.path)
const all = Buffer.concat(order.map(p => Buffer.from(site.files.get(p))))
const tracker = new Server({ udp: false, http: false, ws: true, stats: false })
tracker.on('warning', e => console.error('tracker warning:', e.message))
await new Promise(r => tracker.listen(0, '127.0.0.1', r))
const wsUrl = `ws://127.0.0.1:${tracker.http.address().port}`

const html = `<!doctype html><meta charset="utf-8"><title>a6</title><script type="module">
import WebTorrent from '/wt.js'
class MemStore { constructor (cl, o) { this.chunkLength = cl; this.length = o.length; this.m = new Map() }
  put (i, b, cb = () => {}) { this.m.set(i, new Uint8Array(b)); queueMicrotask(() => cb(null)) }
  get (i, o, cb) { if (typeof o === 'function') { cb = o; o = {} } const c = this.m.get(i); if (!c) return queueMicrotask(() => cb(new Error('nf'))); const off = (o && o.offset) || 0; const len = (o && o.length != null) ? o.length : c.length - off; queueMicrotask(() => cb(null, c.slice(off, off + len))) }
  close (cb = () => {}) { queueMicrotask(() => cb(null)) } destroy (cb = () => {}) { this.m.clear(); queueMicrotask(() => cb(null)) } }
class PreStore { constructor (all, pl) { this.all = all; this.chunkLength = pl; this.length = all.length }
  put (i, b, cb = () => {}) { queueMicrotask(() => cb(null)) }
  get (i, o, cb) { if (typeof o === 'function') { cb = o; o = {} } const start = i * this.chunkLength; const end = Math.min(start + this.chunkLength, this.all.length); const piece = this.all.subarray(start, end); const off = (o && o.offset) || 0; const len = (o && o.length != null) ? o.length : piece.length - off; queueMicrotask(() => cb(null, piece.slice(off, off + len))) }
  close (cb = () => {}) { queueMicrotask(() => cb(null)) } destroy (cb = () => {}) { queueMicrotask(() => cb(null)) } }
const sha256 = async u8 => [...new Uint8Array(await crypto.subtle.digest('SHA-256', u8))].map(b => b.toString(16).padStart(2, '0')).join('')
window.seed = async ({ wsUrl }) => {
  const [tb, all] = await Promise.all([fetch('/site.torrent').then(r => r.arrayBuffer()), fetch('/site.bin').then(r => r.arrayBuffer())])
  const client = new WebTorrent({ dht: false, lsd: false, tracker: { rtcConfig: { iceServers: [] } } })
  window.seedClient = client
  const t = client.add(new Uint8Array(tb), { preloadedStore: new PreStore(new Uint8Array(all), 16384), skipVerify: true, announce: [wsUrl] })
  await new Promise(r => t.once('ready', r))
  return { infoHash: t.infoHash, done: t.done, progress: t.progress }
}
window.leech = async ({ magnet, timeoutMs, checkPath }) => {
  const rec = { wires: [], warnings: [], errors: [] }
  const client = new WebTorrent({ dht: false, lsd: false, tracker: { rtcConfig: { iceServers: [] } } })
  const t0 = performance.now()
  const t = client.add(magnet, { store: MemStore })
  t.on('wire', w => rec.wires.push({ type: w.type, tMs: Math.round(performance.now() - t0) }))
  t.on('warning', e => rec.warnings.push(String(e.message || e).slice(0, 100)))
  t.on('error', e => rec.errors.push(String(e.message || e).slice(0, 100)))
  t.on('metadata', () => { rec.metadataMs = Math.round(performance.now() - t0) })
  await new Promise(resolve => { const timer = setTimeout(resolve, timeoutMs); t.on('done', () => { rec.doneMs = Math.round(performance.now() - t0); clearTimeout(timer); resolve() }) })
  rec.done = !!rec.doneMs
  if (rec.done) { const f = t.files.find(x => x.path === checkPath); rec.sha = await sha256(new Uint8Array(await f.arrayBuffer())) }
  await new Promise(r => client.destroy(r)); return rec
}
window.__ready = true
</script>`
const sha256hex = async u8 => Buffer.from(await crypto.subtle.digest('SHA-256', u8)).toString('hex')
const checkPath = 'site/data/blob.bin'
const expected = await sha256hex(site.files.get(checkPath))
const flagsMdnsOff = process.env.NOFLAGS ? [] : ['--disable-features=WebRtcHideLocalIpsWithMdns']
const results = []
for (const bundlePath of bundles) {
  const A = await startPageServer({ pageHtml: html, bundlePath, extra: { '/site.torrent': { type: 'application/x-bittorrent', body: site.torrentBytes }, '/site.bin': { type: 'application/octet-stream', body: all } } })
  const launcher = engine === 'webkit' ? webkit : chromium
  const browser = await launcher.launch({ headless: true, ...(engine === 'chromium' ? { args: flagsMdnsOff } : {}) })
  const rec = { bundle: bundlePath.replace(/^.*\/(dist|out)\//, '$1/'), engine, version: browser.version() }
  try {
    const ctxA = await browser.newContext(), ctxB = await browser.newContext()
    const pA = await ctxA.newPage(), pB = await ctxB.newPage()
    pA.on('pageerror', e => (rec.pageErrors ??= []).push(String(e).slice(0, 100))); pB.on('pageerror', e => (rec.pageErrors ??= []).push(String(e).slice(0, 100)))
    for (const p of [pA, pB]) { await p.goto(`${A.origin}/`); await p.waitForFunction(() => window.__ready === true, null, { timeout: 15000 }) }
    rec.seeder = await pA.evaluate(c => window.seed(c), { wsUrl })
    rec.infoHashMatchesCreateTorrent = rec.seeder.infoHash === site.infoHash
    const magnet = `magnet:?xt=urn:btih:${site.infoHash}&dn=site&tr=${encodeURIComponent(wsUrl)}`
    rec.leecher = await pB.evaluate(c => window.leech(c), { magnet, timeoutMs: 25000, checkPath })
    rec.shaMatches = rec.leecher.sha === expected
  } catch (e) { rec.fatal = String(e && e.message || e).split('\n')[0] }
  await browser.close(); await closeServer(A.server)
  results.push(rec)
}
tracker.close()
console.log(JSON.stringify(results, null, 1)); process.exit(0)
