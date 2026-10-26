// E3: web-seed completion time for a ~5 MiB site vs piece length, maxWebConns, file count and HTTP version (Chromium 156, real webtorrent.min.js).
// The server adds a fixed per-request delay (RTT proxy, no bandwidth cap: loopback), counts requests / in-flight / connections.
// Self-signed cert lives outside the project (SP/w2a10/certs). Run: node docs/research/labs/w2a-10-lab/e3-webseed/run.mjs
import http2 from 'node:http2'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import createTorrent from 'create-torrent'
const here = path.dirname(fileURLToPath(import.meta.url))
const CERTS = process.env.CERTS || '/private/tmp/claude-501/-Users-owner/2e31ae61-4460-4879-804d-f5507c05cdbe/scratchpad/w2a10/certs'
const key = fs.readFileSync(CERTS + '/key.pem'); const cert = fs.readFileSync(CERTS + '/cert.pem')
const WT = fs.readFileSync(path.join(here, '../../../../../node_modules/webtorrent/dist/webtorrent.min.js'))
const DELAY = +(process.env.DELAY || 50)

function rng (seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
function det (n, seed) { const o = Buffer.alloc(n); let x = (seed * 2654435761) >>> 0 || 1; for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; o[i] = x & 255 } return o }
function lognormalSizes (count, median, sigma, cap, seed) { const r = rng(seed); const out = []; for (let i = 0; i < count; i++) { const u1 = Math.max(r(), 1e-9); const u2 = r(); const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); out.push(Math.min(cap, Math.max(200, Math.round(median * Math.exp(sigma * z))))) } return out }
function shape (name) {
  if (name === 'A400') return lognormalSizes(400, 6000, 1.3, 400000, 11).map((s, i) => [`d${i % 12}/f${String(i).padStart(4, '0')}.${['js', 'css', 'html', 'png', 'json', 'svg'][i % 6]}`, s])
  if (name === 'B60') return lognormalSizes(60, 50000, 1.0, 600000, 12).map((s, i) => [`d${i % 5}/f${String(i).padStart(3, '0')}.${['js', 'png', 'html'][i % 3]}`, s])
  if (name === 'C1') return [['bundle.bin', 5 * 1024 * 1024]]
  throw new Error('shape')
}
const SHAPES = (process.env.SHAPES || 'A400,B60,C1').split(',')
const PIECES = (process.env.PIECES || '16384,65536,262144,1048576').split(',').map(Number)
const content = {}; const torrents = {}
for (const sh of SHAPES) {
  const spec = shape(sh).sort((a, b) => a[0] < b[0] ? -1 : 1)
  const files = spec.map(([p, n], i) => { const b = det(n, i + 3); b.name = p.split('/').pop(); b.fullPath = (sh === 'C1' ? '' : 'site/') + p; return b })
  content[sh] = { spec, files, total: spec.reduce((s, [, n]) => s + n, 0) }
  for (const pl of PIECES) {
    torrents[`${sh}-${pl}`] = await new Promise((res, rej) => createTorrent(sh === 'C1' ? files[0] : files, { name: 'site', pieceLength: pl, announce: [], creationDate: new Date(0) }, (e, b) => e ? rej(e) : res(b)))
  }
  console.log(sh, 'files', spec.length, 'bytes', content[sh].total, 'median', spec.map(s => s[1]).sort((a, b) => a - b)[spec.length >> 1])
}
const stats = { requests: 0, inflight: 0, maxInflight: 0, conns: 0, bytes: 0, rangeReqs: 0 }
const reset = () => Object.assign(stats, { requests: 0, inflight: 0, maxInflight: 0, conns: 0, bytes: 0, rangeReqs: 0 })
const PAGE = fs.readFileSync(path.join(here, 'page.html'))
function handler (req, res) {
  const u = new URL(req.url, 'https://localhost'); const p = decodeURIComponent(u.pathname)
  const send = (code, body, type = 'application/octet-stream') => { res.statusCode = code; res.setHeader('Content-Type', type); res.setHeader('Content-Length', body.length); res.setHeader('Cache-Control', 'no-store'); res.end(body) }
  if (p === '/') return send(200, PAGE, 'text/html')
  if (p === '/wt.js') return send(200, WT, 'text/javascript')
  let m
  if ((m = p.match(/^\/t\/(.+)\.torrent$/))) return send(200, torrents[m[1]])
  if ((m = p.match(/^\/t\/(.+)\.json$/))) return send(200, Buffer.from(JSON.stringify(content[m[1]].spec.map(s => s[0]))), 'application/json')
  let sh = null; let rel = null
  if ((m = p.match(/^\/ws\/([A-Z0-9]+)\/site\/(.+)$/))) { sh = m[1]; rel = m[2] }
  else if ((m = p.match(/^\/ws\/([A-Z0-9]+)\/(bundle\.bin)$/))) { sh = m[1]; rel = m[2] }
  else if ((m = p.match(/^\/raw\/([A-Z0-9]+)\/(.+)$/))) { sh = m[1]; rel = m[2] }
  if (rel === null) return send(404, Buffer.from('nf'))
  const f = content[sh] && content[sh].files.find(x => x.fullPath.replace(/^site\//, '') === rel)
  if (!f) return send(404, Buffer.from('nf'))
  stats.requests++; stats.inflight++; stats.maxInflight = Math.max(stats.maxInflight, stats.inflight)
  const rg = req.headers.range && /bytes=(\d+)-(\d+)?/.exec(req.headers.range)
  let s = 0; let e = f.length - 1; if (rg) { s = +rg[1]; e = rg[2] ? Math.min(+rg[2], f.length - 1) : f.length - 1; stats.rangeReqs++ }
  setTimeout(() => {
    const body = f.subarray(s, e + 1); stats.bytes += body.length
    res.statusCode = rg ? 206 : 200; res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Length', body.length)
    if (rg) res.setHeader('Content-Range', `bytes ${s}-${e}/${f.length}`)
    res.end(body, () => { stats.inflight-- })
  }, DELAY)
}
const h2s = http2.createSecureServer({ key, cert, allowHTTP1: false, settings: { maxConcurrentStreams: 128 } }, handler); h2s.on('session', () => { stats.conns++ })
const h1s = https.createServer({ key, cert }, handler); h1s.on('secureConnection', () => { stats.conns++ })
await new Promise(r => h2s.listen(0, '127.0.0.1', r)); await new Promise(r => h1s.listen(0, '127.0.0.1', r))
const ports = { h2: h2s.address().port, h1: h1s.address().port }
console.log('ports', ports, 'delay ms', DELAY)

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ ignoreHTTPSErrors: true })
const rows = []
async function run (label, http, q) {
  reset()
  const page = await ctx.newPage()
  page.on('pageerror', e => console.log('pageerror', String(e).slice(0, 200)))
  await page.goto(`https://localhost:${ports[http]}/?${new URLSearchParams(q)}`)
  await page.waitForFunction('window.__done === true', null, { timeout: 180000 })
  const r = await page.evaluate('window.__result'); await page.close()
  const row = { label, http, ...q, ...r, requests: stats.requests, rangeReqs: stats.rangeReqs, maxInflight: stats.maxInflight, conns: stats.conns, bytes: stats.bytes }
  rows.push(row)
  console.log(label.padEnd(44), http, `total=${r.totalMs}ms first=${r.firstFileMs}ms ready=${r.readyMs}ms reqs=${stats.requests} maxInflight=${stats.maxInflight} conns=${stats.conns} bytes=${stats.bytes}${r.error ? ' ERR ' + r.error : ''}`)
}
const MWC = (process.env.MWC || '4,16').split(',').map(Number)
for (const http of ['h2', 'h1']) {
  for (const sh of SHAPES) {
    await run(`baseline fetch-all ${sh}`, http, { mode: 'fetchall', id: sh, s: sh })
    for (const pl of PIECES) for (const mwc of MWC) {
      if (http === 'h1' && ![16384, 262144].includes(pl)) continue
      await run(`webtorrent ${sh} piece=${pl / 1024}K mwc=${mwc}`, http, { mode: 'wt', id: `${sh}-${pl}`, s: sh, mwc, single: sh === 'C1' ? 1 : 0 })
    }
  }
}
fs.writeFileSync(path.join(here, '..', 'results', process.env.OUT || 'e3-webseed.json'), JSON.stringify({ delayMs: DELAY, chromium: browser.version(), shapes: Object.fromEntries(Object.entries(content).map(([k, v]) => [k, { files: v.spec.length, bytes: v.total }])), rows }, null, 1))
await browser.close(); process.exit(0)
