// w1-13 A4: can a plain Node process (webtorrent 3.0.21 + built-in node-datachannel WebRTC, NO config) seed to browsers?
// Node 24 seeder + official browser bundle leecher in Chromium and WebKit, through a local bittorrent-tracker WS tracker.
// Usage: node docs/research/labs/w1-13-lab/a4-node-seed.mjs [chromium,webkit]
import net from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
// Lab hygiene: bind the TCP listener of the Node client to loopback only (WebTorrent binds all interfaces by default).
const origListen = net.Server.prototype.listen
net.Server.prototype.listen = function (...a) {
  const cb = typeof a[a.length - 1] === 'function' ? a.pop() : undefined
  if (typeof a[0] === 'number' || a[0] === undefined) a = [a[0] ?? 0, '127.0.0.1']
  return origListen.apply(this, cb ? [...a, cb] : a)
}
const { default: WebTorrent } = await import('webtorrent')
const { default: Server } = await import('bittorrent-tracker/server')
const { chromium, firefox, webkit } = await import('playwright')
const { makeSite, startPageServer, closeServer, sleep } = await import('./lib.mjs')

const engines = (process.argv[2] ?? 'chromium,webkit').split(',')
const site = await makeSite()
const scratch = mkdtempSync(join(tmpdir(), 'w113-seed-'))
for (const [p, u8] of site.files) { const f = join(scratch, 'src', p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, u8) }

// tracker
const tracker = new Server({ udp: false, http: false, ws: true, stats: false, interval: 60000 })
tracker.on('warning', e => console.error('tracker warning:', e.message))
tracker.on('error', e => console.error('tracker error:', e.message))
await new Promise(r => tracker.listen(0, '127.0.0.1', r))
const wsUrl = `ws://127.0.0.1:${tracker.http.address().port}`

// Node seeder: default WebRTC (webrtc-polyfill -> node-datachannel), nothing else configured
const LOOP = process.env.LOOPBACK === '1' // lab-only: this sandbox blocks UDP to the LAN IP, so force libdatachannel onto 127.0.0.1
const seeder = new WebTorrent({ dht: false, lsd: false, natUpnp: false, natPmp: false, utp: false, ...(LOOP ? { tracker: { rtcConfig: { iceServers: [], bindAddress: '127.0.0.1' } } } : {}) })
seeder.on('error', e => console.error('seeder client error:', e.message))
const nodeTorrent = await new Promise((resolve, reject) => {
  const t = seeder.seed(join(scratch, 'src', 'site'), { name: 'site', announce: [wsUrl], pieceLength: 16384, path: join(scratch, 'store') }, resolve)
  t.on('error', reject)
})
const info = {
  node: process.version, webtorrent: '3.0.21', infoHashNodeSeeder: nodeTorrent.infoHash, infoHashLabMemoryObjects: site.infoHash,
  sameInfoHashAcrossNodeDirAndMemoryInput: nodeTorrent.infoHash === site.infoHash,
  nodePeerIdPrefix: Buffer.from(seeder.peerId, 'hex').toString().slice(0, 8), torrentFiles: nodeTorrent.files.length
}

const pageHtml = `<!doctype html><meta charset="utf-8"><title>a4</title><script type="module">
import WebTorrent from '/wt.js'
class MemStore { constructor (cl, o) { this.chunkLength = cl; this.length = o.length; this.m = new Map() }
  put (i, b, cb = () => {}) { this.m.set(i, new Uint8Array(b)); queueMicrotask(() => cb(null)) }
  get (i, o, cb) { if (typeof o === 'function') { cb = o; o = {} } const c = this.m.get(i); if (!c) return queueMicrotask(() => cb(new Error('nf'))); const off = (o && o.offset) || 0; const len = (o && o.length != null) ? o.length : c.length - off; queueMicrotask(() => cb(null, c.slice(off, off + len))) }
  close (cb = () => {}) { queueMicrotask(() => cb(null)) } destroy (cb = () => {}) { this.m.clear(); queueMicrotask(() => cb(null)) } }
const sha256 = async u8 => [...new Uint8Array(await crypto.subtle.digest('SHA-256', u8))].map(b => b.toString(16).padStart(2, '0')).join('')
window.leech = async ({ magnet, timeoutMs, checkPath }) => {
  const rec = { wires: [], warnings: [], errors: [] }
  // LOOPBACK mode: the browser creates no offers (numwant 0) and only answers the Node seeder's offers; see doc F-NODE3 (glare + sandbox LAN-UDP block)
  const client = new WebTorrent({ dht: false, lsd: false, tracker: { rtcConfig: { iceServers: [] }, ...(window.__answerOnly ? { getAnnounceOpts: () => ({ numwant: 0 }) } : {}) } })
  client.on('error', e => rec.errors.push(String(e.message || e)))
  const t0 = performance.now()
  const t = client.add(magnet, { store: MemStore })
  t.on('wire', w => rec.wires.push({ type: w.type, peerIdPrefix: (() => { try { return new TextDecoder().decode(Uint8Array.from(w.peerId.match(/../g).map(h => parseInt(h, 16))).slice(0, 8)) } catch { return '?' } })(), remoteAddress: w.remoteAddress ?? null, tMs: Math.round(performance.now() - t0) }))
  t.on('warning', e => rec.warnings.push(String(e.message || e).slice(0, 120)))
  t.on('error', e => rec.errors.push(String(e.message || e).slice(0, 120)))
  t.on('metadata', () => { rec.metadataMs = Math.round(performance.now() - t0) })
  await new Promise(resolve => { const timer = setTimeout(resolve, timeoutMs); t.on('done', () => { rec.doneMs = Math.round(performance.now() - t0); clearTimeout(timer); resolve() }) })
  rec.done = !!rec.doneMs
  if (rec.done) { const f = t.files.find(x => x.path === checkPath); rec.sha = await sha256(new Uint8Array(await f.arrayBuffer())); rec.numPeers = t.numPeers }
  await new Promise(r => client.destroy(r))
  return rec
}
window.__ready = true
</script>`
const A = await startPageServer({ pageHtml })
const sha256hex = async u8 => Buffer.from(await crypto.subtle.digest('SHA-256', u8)).toString('hex')
const checkPath = 'site/data/blob.bin'
const expected = await sha256hex(site.files.get(checkPath))
const launch = {
  chromium: () => chromium.launch({ headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns', ...(process.env.LOOPBACK === '1' ? ['--allow-loopback-in-peer-connection'] : [])] }),
  chromium_default_mdns: () => chromium.launch({ headless: true }),
  webkit: () => webkit.launch({ headless: true }),
  firefox: () => firefox.launch({ headless: true })
}
const results = {}
for (const name of engines) {
  const r = { attempts: [] }
  try {
    const browser = await launch[name]()
    r.version = browser.version()
    for (let i = 0; i < 2; i++) {
      const ctx = await browser.newContext(); const page = await ctx.newPage()
      if (process.env.LOOPBACK === '1') await page.addInitScript(() => { window.__answerOnly = true })
      await page.goto(`${A.origin}/`); await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 })
      const magnet = `magnet:?xt=urn:btih:${nodeTorrent.infoHash}&dn=site&tr=${encodeURIComponent(wsUrl)}`
      const rec = await page.evaluate(c => window.leech(c), { magnet, timeoutMs: 20000, checkPath })
      rec.shaMatches = rec.sha === expected
      r.attempts.push(rec); await ctx.close()
    }
    await browser.close()
  } catch (e) { r.fatal = String(e && e.message || e).split('\n')[0] }
  results[name] = r
}
info.seederUploaded = nodeTorrent.uploaded
console.log(JSON.stringify({ info, trackerSwarm: Object.keys(tracker.torrents).length, results }, null, 1))
await new Promise(r => seeder.destroy(r)); tracker.close(); await closeServer(A.server); rmSync(scratch, { recursive: true, force: true })
process.exit(0)
