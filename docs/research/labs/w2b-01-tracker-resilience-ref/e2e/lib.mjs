// Shared helpers for the browser experiments (Playwright Chromium + the project's webtorrent 3.0.21 bundle).
import http from 'node:http'
import net from 'node:net'
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const PROJECT = process.env.MW_PROJECT || join(import.meta.dirname, '..', '..', '..', '..', '..') // repo root: e2e -> ref -> labs -> research -> docs -> root
const imp = (rel) => import(pathToFileURL(join(PROJECT, 'node_modules', rel)).href)
const { WebSocketServer } = await imp('ws/wrapper.mjs')
export const { default: createTorrent } = await imp('create-torrent/index.js')
export const { default: parseTorrent } = await imp('parse-torrent/index.js')
export const { chromium } = await imp('playwright/index.mjs')
export const WT_BUNDLE = join(PROJECT, 'node_modules/webtorrent/dist/webtorrent.min.js')
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A tiny site (3 files, ~470 KB) and its .torrent (pieceLength 64 KiB so there are several pieces).
export async function makeSite (dir = mkdtempSync(join(tmpdir(), 'mw-site-')), name = 'site') {
  const root = join(dir, name); mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>t</title><h1>hello</h1>' + '<p>x</p>'.repeat(500))
  writeFileSync(join(root, 'app.js'), 'console.log("app");\n'.repeat(3000))
  writeFileSync(join(root, 'big.bin'), randomBytes(400 * 1024))
  const files = ['index.html', 'app.js', 'big.bin'].map((f) => join(root, f))
  const torrentFile = await new Promise((res, rej) => createTorrent(root, { name, pieceLength: 64 * 1024 }, (e, t) => (e ? rej(e) : res(t))))
  const parsed = await parseTorrent(torrentFile)
  return { dir, root, name, torrentFile, infoHash: parsed.infoHash, length: parsed.length, files }
}

// Web seed + .torrent host on its own origin (cross-origin from the page, like S3/CloudFront): CORS + Range.
export function startWebSeed (site, { port = 0, cors = true } = {}) {
  const srv = http.createServer((req, res) => {
    const h = cors ? { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'range, cache-control, user-agent', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges', 'Access-Control-Max-Age': '86400' } : {}
    if (req.method === 'OPTIONS') { res.writeHead(204, h); return res.end() }
    srv.hits = (srv.hits || 0) + 1
    const u = decodeURIComponent(req.url.split('?')[0])
    if (u === '/site.torrent') { res.writeHead(200, { ...h, 'Content-Type': 'application/x-bittorrent', 'Content-Length': site.torrentFile.length }); return res.end(site.torrentFile) }
    const m = /^\/ws\/(.+)$/.exec(u)
    const fp = m && join(site.dir, m[1])
    let st
    try { st = fp && statSync(fp) } catch (_) { st = null }
    if (!st || !st.isFile() || !fp.startsWith(site.dir)) { res.writeHead(404, h); return res.end('nf') }
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '')
    if (range) {
      const a = range[1] === '' ? 0 : Number(range[1]); const b = range[2] === '' ? st.size - 1 : Math.min(Number(range[2]), st.size - 1)
      res.writeHead(206, { ...h, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${a}-${b}/${st.size}`, 'Content-Length': b - a + 1, 'Content-Type': 'application/octet-stream' })
      return createReadStream(fp, { start: a, end: b }).pipe(res)
    }
    res.writeHead(200, { ...h, 'Accept-Ranges': 'bytes', 'Content-Length': st.size, 'Content-Type': 'application/octet-stream' })
    createReadStream(fp).pipe(res)
  })
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r({ srv, port: srv.address().port, base: `http://127.0.0.1:${srv.address().port}` })))
}

// The page origin: serves the webtorrent bundle and an empty page.
export function startPageServer () {
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/wt.js')) { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(readFileSync(WT_BUNDLE)) }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>page</title>')
  })
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port, base: `http://127.0.0.1:${srv.address().port}` })))
}

// TCP black hole: accepts connections and never answers (a tracker host that drops packets / half-open firewall).
export function startBlackHole () {
  const srv = net.createServer((s) => { s.on('data', () => {}); s.on('error', () => {}) })
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })))
}
// WebSocket server that completes the handshake and then ignores everything (alive but mute tracker).
export function startMuteWs () {
  const srv = http.createServer(); const wss = new WebSocketServer({ server: srv })
  wss.on('connection', (ws) => { ws.on('message', () => {}) })
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })))
}
// A port nothing listens on.
export async function deadPort () {
  const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p
}

// Spawn the reference tracker (tracker.mjs) as a child process.
export function startTracker (env = {}, { port = 0 } = {}) {
  const proc = spawn(process.execPath, [join(import.meta.dirname, '..', 'tracker', 'tracker.mjs')], { env: { ...process.env, PORT: String(port), METRICS_PORT: '0', OPEN: '1', LOG_LEVEL: 'info', ...env }, stdio: ['ignore', 'pipe', 'inherit'] })
  return new Promise((resolve, reject) => {
    let b = ''
    proc.stdout.on('data', (d) => { b += d; for (const l of b.split('\n')) { try { const j = JSON.parse(l); if (j.msg === 'listening') resolve({ proc, port: j.port, stop: () => proc.kill('SIGKILL') }) } catch (_) {} } })
    proc.on('exit', () => reject(new Error('tracker exited')))
  })
}

const pw = await imp('playwright/index.mjs')
export async function launch (name = process.env.BROWSER || 'chromium') {
  if (name === 'chromium') return pw.chromium.launch({ headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--no-sandbox'] })
  if (name === 'firefox') return pw.firefox.launch({ headless: true, firefoxUserPrefs: { 'media.peerconnection.ice.obfuscate_host_addresses': false } })
  if (name === 'webkit') return pw.webkit.launch({ headless: true })
  throw new Error('unknown browser ' + name)
}
