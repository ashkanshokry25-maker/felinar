// VERIFY-LAB COPY of w2c-01-lab/webseed-matrix.mjs: port 8139, full (untruncated) console CORS message, plus the OPTIONS preflight requests/responses Chromium actually sent.
// Runs WebTorrent 3.0.21's real browser web-seed code in headless Chromium against public hosts.
// usage: node webseed-matrix.mjs <outdir-with-torrents> <results.json> [patch0|patch1|both]
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire('$HOME/Documents/Projects/magnet-web/package.json')
const { chromium } = require('playwright')
const [outdir, resultsFile, which = 'both'] = process.argv.slice(2)
const WT = '$HOME/Documents/Projects/magnet-web/node_modules/webtorrent/dist/webtorrent.min.js'
const H = 'b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553'
const TX = 'nBOEA5n1P9qCVyJL2QD7DWMzCzpMUikE8Ee2-Ev8IqQ'
const SB = 'tqjyia4z6u75vasxejf5sah3bvrtgcz2jrjcsbhqi63pqs74eksa'
const CID = 'bafybeifx7yeb55armcsxwwitkymga5xf53dxiarykms3ygqic223w5sk3m'
const SHA = { 'bitcoin.pdf': H, 'arweave.png': 'ba85c4fa3f162f09fa6ecc53722f23bc1633b70922a0e3b74952283d897c26d2', 'gwcheck.txt': '7530010a7ec61daef2e028720f102a75d40af932528e742eb10cdae4de8d7004' }
const entries = [
  ['bitcoin.pdf', 'blossom cdn.hzrd149.com', `https://cdn.hzrd149.com/${H}`],
  ['bitcoin.pdf', 'blossom nostr.download', `https://nostr.download/${H}`],
  ['bitcoin.pdf', 'blossom cdn.satellite.earth (302)', `https://cdn.satellite.earth/${H}`],
  ['bitcoin.pdf', 'blossom blossom.primal.net (ignores Range)', `https://blossom.primal.net/${H}`],
  ['arweave.png', 'arweave ardrive.net apex (302->sandbox)', `https://ardrive.net/${TX}`],
  ['arweave.png', 'arweave sandbox host ardrive.net', `https://${SB}.ardrive.net/${TX}`],
  ['arweave.png', 'arweave arweave.net apex (302->sandbox)', `https://arweave.net/${TX}`],
  ['arweave.png', 'arweave sandbox host arweave.net', `https://${SB}.arweave.net/${TX}`],
  ['arweave.png', 'arweave vilenarios.com apex', `https://vilenarios.com/${TX}`],
  ['gwcheck.txt', 'ipfs ipfs.filebase.io', `https://ipfs.filebase.io/ipfs/${CID}`],
  ['gwcheck.txt', 'ipfs ipfs.orbitor.dev', `https://ipfs.orbitor.dev/ipfs/${CID}`],
  ['gwcheck.txt', 'ipfs gateway.pinata.cloud', `https://gateway.pinata.cloud/ipfs/${CID}`],
  ['gwcheck.txt', 'ipfs subdomain ipfs.storry.tv', `https://${CID}.ipfs.storry.tv/`]
]
const page_html = `<!doctype html><meta charset=utf-8><title>m</title><script type="module">
const q = new URLSearchParams(location.search); const patch = q.get('patch') === '1'; const log = []
const origFetch = self.fetch.bind(self)
self.fetch = async (u, init) => {
  const url = String(u && u.url || u); let headers = (init && init.headers) ? { ...init.headers } : {}
  const rec = { url: url.slice(0, 90), hdr: Object.keys(headers).join(','), cache: init && init.cache }
  if (patch) { for (const k of Object.keys(headers)) if (['cache-control','user-agent'].includes(k.toLowerCase())) delete headers[k]; init = { ...init, headers }; rec.hdr = Object.keys(headers).join(',') }
  const t0 = performance.now()
  try { const r = await origFetch(u, init); rec.status = r.status; rec.cr = r.headers.get('content-range'); rec.ms = Math.round(performance.now() - t0); log.push(rec); return r }
  catch (e) { rec.err = String(e).slice(0, 80); rec.ms = Math.round(performance.now() - t0); log.push(rec); throw e }
}
const { default: WebTorrent } = await import('/webtorrent.min.js')
const name = q.get('t'), ws = q.get('ws'), want = q.get('sha'), timeout = +q.get('timeout') || 20000
const buf = new Uint8Array(await (await origFetch('/t/' + name + '.torrent')).arrayBuffer())
const client = new WebTorrent({ tracker: false })
const warns = []
const t = client.add(buf, { urlList: [ws], announce: [] })
t.on('warning', w => warns.push(String(w && w.message || w)))
t.on('error', e => warns.push('ERROR ' + e))
const t0 = performance.now()
const done = await new Promise(res => { t.on('done', () => res(true)); setTimeout(() => res(false), timeout) })
let shaOk = null
if (done) { const ab = await t.files[0].arrayBuffer(); const d = await crypto.subtle.digest('SHA-256', ab); shaOk = [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('') === want }
window.__result = { done, ms: Math.round(performance.now() - t0), downloaded: t.downloaded, shaOk, wires: t.wires.map(w => w.type), nWarn: warns.length, warn0: warns[0] || null, nFetch: log.length, fetch0: log[0] || null, fetchErrs: log.filter(l => l.err).length, fetchOk: log.filter(l => l.status).length, statuses: [...new Set(log.map(l => l.status))].join('/') }
client.destroy()
</script>`
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/') { res.setHeader('content-type', 'text/html'); return res.end(page_html) }
  if (u.pathname === '/webtorrent.min.js') { res.setHeader('content-type', 'text/javascript'); return res.end(fs.readFileSync(WT)) }
  if (u.pathname.startsWith('/t/')) { res.setHeader('content-type', 'application/x-bittorrent'); return res.end(fs.readFileSync(path.join(outdir, u.pathname.slice(3)))) }
  res.statusCode = 404; res.end('nf')
}).listen(8139, '127.0.0.1')
const browser = await chromium.launch()
const variants = which === 'both' ? [0, 1] : [which === 'patch1' ? 1 : 0]
const results = []
async function run (entry, patch) {
  const [t, label, url] = entry
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const cons = []
  const pre = []
  page.on('request', r => { if (r.method() === 'OPTIONS') pre.push({ req: r.url().slice(0, 70), acrh: r.headers()['access-control-request-headers'] }) })
  page.on('response', r => { if (r.request().method() === 'OPTIONS') { const h = r.headers(); pre.push({ resp: r.url().slice(0, 70), status: r.status(), acah: h['access-control-allow-headers'] || null, redirectTo: h.location ? h.location.slice(0, 60) : null }) } })
  page.on('console', m => { const x = m.text(); if (/CORS|blocked|Access to fetch|ERR_/.test(x)) cons.push(x) })
  const qs = new URLSearchParams({ t, ws: url, sha: SHA[t], patch: String(patch), timeout: '18000' })
  await page.goto('http://127.0.0.1:8139/?' + qs)
  let r = null
  try { await page.waitForFunction(() => window.__result, null, { timeout: 40000 }); r = await page.evaluate(() => window.__result) } catch (e) { r = { error: String(e).slice(0, 100) } }
  await ctx.close()
  const out = { label, patch, ...r, cors: cons[0] || null, preflight: pre.slice(0, 4) }
  results.push(out)
  console.log(JSON.stringify(out))
}
const jobs = []
for (const v of variants) for (const e of entries) jobs.push([e, v])
const CONC = 4
let i = 0
await Promise.all(Array.from({ length: CONC }, async () => { while (i < jobs.length) { const j = jobs[i++]; await run(j[0], j[1]) } }))
fs.writeFileSync(resultsFile, JSON.stringify(results, null, 1))
await browser.close(); server.close()
