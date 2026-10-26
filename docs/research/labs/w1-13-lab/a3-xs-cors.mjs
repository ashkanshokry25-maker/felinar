// w1-13 A3: does WebTorrent 3.0.21 (official dist bundle) fetch `xs=` / `.torrent` URLs / web seeds cross-origin
// in Chromium, Firefox and WebKit (Playwright 1.64.1), and which CORS preflights does each engine send?
// Usage: node docs/research/labs/w1-13-lab/a3-xs-cors.mjs [chromium,firefox,webkit]
import { chromium, firefox, webkit } from 'playwright'
import { makeSite, startOrigin, startPageServer, closeServer, sleep } from './lib.mjs'

const engines = (process.argv[2] ?? 'chromium,firefox,webkit').split(',')
const site = await makeSite()
const log = []
const B = await startOrigin({ site, log })

const pageHtml = `<!doctype html><meta charset="utf-8"><title>a3</title><script type="module">
import WebTorrent from '/wt.js'
class MemStore { // minimal callback-style abstract-chunk-store
  constructor (cl, o) { this.chunkLength = cl; this.length = o.length; this.m = new Map() }
  put (i, b, cb = () => {}) { this.m.set(i, new Uint8Array(b)); queueMicrotask(() => cb(null)) }
  get (i, o, cb) { if (typeof o === 'function') { cb = o; o = {} } const c = this.m.get(i); if (!c) return queueMicrotask(() => cb(new Error('Chunk not found'))); const off = (o && o.offset) || 0; const len = (o && o.length != null) ? o.length : c.length - off; queueMicrotask(() => cb(null, c.slice(off, off + len))) }
  close (cb = () => {}) { queueMicrotask(() => cb(null)) }
  destroy (cb = () => {}) { this.m.clear(); queueMicrotask(() => cb(null)) }
}
const sha256 = async u8 => [...new Uint8Array(await crypto.subtle.digest('SHA-256', u8))].map(b => b.toString(16).padStart(2, '0')).join('')
window.features = () => ({
  ua: navigator.userAgent, secure: isSecureContext,
  toHex: typeof Uint8Array.prototype.toHex, fromHex: typeof Uint8Array.fromHex, toBase64: typeof Uint8Array.prototype.toBase64,
  abortTimeout: typeof AbortSignal.timeout, rtc: typeof RTCPeerConnection, subtle: typeof crypto?.subtle?.digest,
  opfs: typeof navigator.storage?.getDirectory, sw: 'serviceWorker' in navigator, bigint: typeof BigInt
})
window.runScenario = async cfg => {
  const rec = { warnings: [], errors: [], status: 'timeout', ms: null }
  const client = new WebTorrent({ tracker: false, dht: false, lsd: false, utPex: false })
  client.on('error', e => rec.errors.push('client:' + String(e.message || e).slice(0, 160)))
  const t0 = performance.now()
  try {
    let id = cfg.id
    if (cfg.torrentBytes) id = new Uint8Array(cfg.torrentBytes)
    const t = client.add(id, { store: MemStore, urlList: cfg.urlList })
    t.on('warning', e => rec.warnings.push(String(e.message || e).slice(0, 160)))
    t.on('error', e => rec.errors.push('torrent:' + String(e.message || e).slice(0, 160)))
    await new Promise(resolve => {
      const timer = setTimeout(resolve, cfg.timeoutMs)
      const fin = status => { rec.status = status; rec.ms = Math.round(performance.now() - t0); clearTimeout(timer); resolve() }
      t.on('metadata', () => { rec.gotMetadata = true; rec.files = t.files.length; if (cfg.stopAt === 'metadata') fin('metadata') })
      t.on('done', () => fin('done'))
      t.on('error', () => fin('error'))
    })
    if (rec.status === 'done') {
      const f = t.files.find(x => x.path === cfg.checkPath)
      if (f) rec.sha256Match = (await sha256(new Uint8Array(await f.arrayBuffer()))) === cfg.checkSha256
    }
  } catch (e) { rec.fatal = String(e && e.message || e) }
  await new Promise(r => client.destroy(r))
  return rec
}
window.__ready = true
</script>`
const BUNDLE = process.env.BUNDLE ? new URL(process.env.BUNDLE, 'file://' + process.cwd() + '/').pathname : undefined // default = official dist/webtorrent.min.js
const A = await startPageServer({ pageHtml, site, log, ...(BUNDLE ? { bundlePath: BUNDLE } : {}) })

const enc = encodeURIComponent
const sha256hex = async u8 => Buffer.from(await crypto.subtle.digest('SHA-256', u8)).toString('hex')
const checkPath = 'site/data/blob.bin'
const checkSha = await sha256hex(site.files.get(checkPath))
const results = {}
const launchers = { chromium, firefox, webkit }

async function runEngine (name) {
  const browser = await launchers[name].launch({ headless: true })
  const out = { version: browser.version(), scenarios: {} }
  try {
    for (const mode of ['none', 'acao', 'full', 'full-star']) {
      const scen = [
        ['xs_only', run => ({ id: `magnet:?xt=urn:btih:${site.infoHash}&dn=site&xs=${enc(`${B.origin}/m/${mode}/${run}/t/site.torrent`)}`, stopAt: 'metadata', timeoutMs: 5000 })],
        ['xs_plus_ws', run => ({ id: `magnet:?xt=urn:btih:${site.infoHash}&dn=site&xs=${enc(`${B.origin}/m/${mode}/${run}/t/site.torrent`)}&ws=${enc(`${B.origin}/m/${mode}/${run}/ws`)}`, timeoutMs: 8000 })],
        ['torrent_url_as_id', run => ({ id: `${B.origin}/m/${mode}/${run}/t/site.torrent`, stopAt: 'metadata', timeoutMs: 5000 })],
        ['torrent_url_as_id_plus_urlList', run => ({ id: `${B.origin}/m/${mode}/${run}/t/site.torrent`, urlList: [`${B.origin}/m/${mode}/${run}/ws`], timeoutMs: 8000 })],
        ['torrent_bytes_plus_urlList (webseed only)', run => ({ torrentBytes: [...site.torrentBytes], urlList: [`${B.origin}/m/${mode}/${run}/ws`], timeoutMs: 8000 })]
      ]
      if (mode === 'none') scen.push(['SAME-ORIGIN webseed (ws on the page origin, no CORS headers)', run => ({ torrentBytes: [...site.torrentBytes], urlList: [`${A.origin}/ws`], timeoutMs: 8000, sameOrigin: true })])
      for (const [label, mk] of scen) {
        const run = `r${Math.random().toString(36).slice(2, 9)}`
        const ctx = await browser.newContext()
        const page = await ctx.newPage()
        const consoleErrors = []
        page.on('pageerror', e => consoleErrors.push(String(e).slice(0, 200)))
        await page.goto(`${A.origin}/`)
        await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 })
        if (!out.features) out.features = await page.evaluate(() => window.features())
        const cfg = { ...mk(run), checkPath, checkSha256: checkSha }
        const tStart = Date.now()
        const rec = await page.evaluate(c => window.runScenario(c), cfg)
        await ctx.close()
        const reqs = cfg.sameOrigin ? log.filter(r => r.run === 'same-origin' && r.t >= tStart) : log.filter(r => r.run === run)
        const pre = reqs.filter(r => r.method === 'OPTIONS')
        const gets = reqs.filter(r => r.method === 'GET')
        out.scenarios[`${mode} / ${label}`] = {
          status: rec.status, ms: rec.ms, sha256Match: rec.sha256Match, warnings: rec.warnings.slice(0, 2), errors: rec.errors.slice(0, 2), pageErrors: consoleErrors.slice(0, 1),
          preflights: pre.length, preflightRequestedHeaders: [...new Set(pre.map(r => r.acrh))],
          getCount: gets.length, getStatuses: [...new Set(gets.map(r => r.status))].join(','),
          getHadUserAgentHeader: gets.some(r => /WebTorrent/.test(r.ua || '')), uaSample: gets[0]?.ua?.slice(0, 60) ?? null,
          rangeSample: gets.find(r => r.range)?.range ?? null, cacheControlSample: gets.find(r => r.cacheControl)?.cacheControl ?? null
        }
      }
    }
  } catch (e) { out.fatal = String(e && e.stack || e) }
  await browser.close()
  return out
}
for (const name of engines) {
  try { results[name] = await runEngine(name) } catch (e) { results[name] = { fatal: String(e && e.stack || e) } }
}
await closeServer(A.server); await closeServer(B.server)
console.log(JSON.stringify({ infoHash: site.infoHash, results }, null, 1))
