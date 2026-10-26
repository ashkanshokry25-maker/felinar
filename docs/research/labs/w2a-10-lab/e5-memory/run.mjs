// E5: renderer RSS of the download path for N MiB sites: v0.2 design (memory pieces + Blob per file + IDB) vs IndexedDB write-through piece store.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import createTorrent from 'create-torrent'
const here = path.dirname(fileURLToPath(import.meta.url))
const WT = fs.readFileSync(path.join(here, '../../../../../node_modules/webtorrent/dist/webtorrent.min.js'))
const PAGE = fs.readFileSync(path.join(here, 'page.html'))
const SIZES = (process.env.SIZES || '128,512').split(',').map(Number)
const STORES = (process.env.STORES || 'mem,idb').split(',')
const PL = +(process.env.PL || 262144)
const NFILES = 8
const block = Buffer.alloc(4 * 1024 * 1024); { let x = 123456789; for (let i = 0; i < block.length; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; block[i] = x & 255 } }
const torrents = {}; const content = {}
for (const mb of SIZES) {
  const per = Math.floor(mb * 1024 * 1024 / NFILES)
  const files = Array.from({ length: NFILES }, (_, i) => { const b = Buffer.alloc(per); for (let o = 0; o < per; o += block.length) block.copy(b, o, (i * 4099) % 1024, Math.min(block.length, (i * 4099) % 1024 + per - o)); b.name = `v${i}.bin`; b.fullPath = `site/v${i}.bin`; return b })
  content[mb] = files
  torrents[mb] = await new Promise((res, rej) => createTorrent(files, { name: 'site', pieceLength: PL, announce: [], creationDate: new Date(0) }, (e, b) => e ? rej(e) : res(b)))
  console.log('prepared', mb, 'MiB', files.length, 'files, torrent bytes', torrents[mb].length)
}
let cur = null
const RATE = +(process.env.RATE_MBPS || 0) * 1048576   // global bytes/s cap across all connections (0 = unlimited loopback)
let nextFree = 0
const pace = n => { if (!RATE) return Promise.resolve(); const now = Date.now(); const t = Math.max(now, nextFree); nextFree = t + n / RATE * 1000; return new Promise(r => setTimeout(r, t - now)) }
async function sendPaced (res, buf) { for (let o = 0; o < buf.length; o += 65536) { const c = buf.subarray(o, Math.min(o + 65536, buf.length)); await pace(c.length); if (!res.write(c)) await new Promise(r => res.once('drain', r)) } res.end() }
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const p = decodeURIComponent(u.pathname)
  if (p === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(PAGE) }
  if (p === '/wt.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(WT) }
  let m
  if ((m = p.match(/^\/t\/(\d+)\.torrent$/))) return res.end(torrents[+m[1]])
  if ((m = p.match(/^\/ws\/site\/(v\d)\.bin$/))) {
    const f = content[cur].find(x => x.name === m[1] + '.bin'); const rg = /bytes=(\d+)-(\d+)?/.exec(req.headers.range || '')
    const s = rg ? +rg[1] : 0; const e = rg && rg[2] ? Math.min(+rg[2], f.length - 1) : f.length - 1
    res.statusCode = rg ? 206 : 200; res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Content-Length', e - s + 1); if (rg) res.setHeader('Content-Range', `bytes ${s}-${e}/${f.length}`)
    return RATE ? sendPaced(res, f.subarray(s, e + 1)) : res.end(f.subarray(s, e + 1))
  }
  res.statusCode = 404; res.end('nf')
}).listen(0, '127.0.0.1')
await new Promise(r => srv.once('listening', r)); const port = srv.address().port
const browser = await chromium.launch({ headless: true, args: ['--js-flags=--expose-gc'] })
async function rendererPids () { const b = await browser.newBrowserCDPSession(); const info = await b.send('SystemInfo.getProcessInfo'); await b.detach(); return info.processInfo.filter(p => p.type === 'renderer').map(p => p.id) }
const rss = pids => pids.length ? execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')]).toString().trim().split('\n').reduce((a, s) => a + (parseInt(s, 10) || 0), 0) / 1024 : 0
const results = []
for (const store of STORES) for (const mb of SIZES) {
  cur = mb
  const before = new Set(await rendererPids())
  const ctx = await browser.newContext(); const page = await ctx.newPage()
  const marks = []
  await page.exposeFunction('__mark', async label => {
    const mine = (await rendererPids()).filter(p => !before.has(p)); const m = { label, rendererMB: Math.round(rss(mine)) }; marks.push(m); return m
  })
  page.on('pageerror', e => console.log('pageerror', String(e).slice(0, 300)))
  await page.goto(`http://127.0.0.1:${port}/?store=${store}&id=${mb}&mwc=${process.env.MWC || 16}`)
  await page.waitForFunction('window.__result', null, { timeout: 200000 })
  const r = await page.evaluate('window.__result')
  results.push({ ...r, mb, pieceLength: PL, marks })
  console.log(`\n== rate=${process.env.RATE_MBPS || 'unlimited'} MB/s store=${store} site=${mb} MiB pieceLength=${PL / 1024}K pieces=${r.pieces} downloadMs=${r.downloadMs} serveMs=${r.serveMs ?? '-'} ${r.error ? 'ERROR ' + r.error : ''}`)
  for (const m of marks) console.log('   ' + m.label.padEnd(58) + String(m.rendererMB).padStart(6) + ' MB')
  await ctx.close()
}
fs.writeFileSync(path.join(here, '..', 'results', process.env.OUT || 'e5-memory.json'), JSON.stringify({ chromium: browser.version(), results }, null, 1))
await browser.close(); srv.close(); process.exit(0)
