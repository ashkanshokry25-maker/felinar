// Shared helpers for the w1-13 browser experiments (no deps beyond the project's node_modules).
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import createTorrent from 'create-torrent'
import parseTorrent from 'parse-torrent'

export const ROOT = fileURLToPath(new URL('../../../../', import.meta.url)) // project root with trailing slash
export const WT_MIN = ROOT + 'node_modules/webtorrent/dist/webtorrent.min.js'
export const sleep = ms => new Promise(r => setTimeout(r, ms))
export const ct = (input, opts) => new Promise((resolve, reject) => createTorrent(input, opts, (e, t) => e ? reject(e) : resolve(t)))

// deterministic pseudo-random bytes (xorshift32)
export function prng (n, seed = 123456789) {
  const b = new Uint8Array(n); let x = seed >>> 0 || 1
  for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; b[i] = x & 255 }
  return b
}
export const enc = s => new TextEncoder().encode(s)

/** Build a small multi-file "site" and its torrent (16 KiB pieces, no announce). */
export async function makeSite ({ pieceLength = 16384, name = 'site' } = {}) {
  const spec = [
    ['index.html', enc('<!doctype html><title>x</title><h1>hello</h1>' + 'x'.repeat(2000))],
    ['js/app.js', enc('console.log("app");\n' + '// pad\n'.repeat(4000))],
    ['css/style.css', enc('body{margin:0}\n'.repeat(300))],
    ['img/photo.bin', prng(60000, 42)],
    ['data/blob.bin', prng(40000, 7)]
  ]
  const files = spec.map(([p, u8]) => { const f = u8.slice(); f.name = p.split('/').pop(); f.fullPath = name + '/' + p; return f })
  const torrentBytes = await ct(files, { name, pieceLength, announce: [], creationDate: new Date(1700000000000) })
  const parsed = await parseTorrent(torrentBytes)
  const byPath = new Map(spec.map(([p, u8]) => [name + '/' + p, u8]))
  return { name, files: byPath, torrentBytes, infoHash: parsed.infoHash, parsed, totalLength: parsed.length }
}

/** Origin B: serves site.torrent and a Range-capable web seed, with selectable CORS behaviour per URL prefix. */
export function startOrigin ({ site, log, host = '127.0.0.1' }) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const m = u.pathname.match(/^\/m\/([a-z0-9-]+)\/([A-Za-z0-9_-]+)(\/.*)$/)
    const rec = {
      t: Date.now(), method: req.method, path: u.pathname, status: 0,
      origin: req.headers.origin ?? null, acrh: req.headers['access-control-request-headers'] ?? null,
      acrm: req.headers['access-control-request-method'] ?? null, ua: req.headers['user-agent'] ?? null,
      range: req.headers.range ?? null, cacheControl: req.headers['cache-control'] ?? null,
      secFetchMode: req.headers['sec-fetch-mode'] ?? null, secFetchSite: req.headers['sec-fetch-site'] ?? null,
      run: m?.[2] ?? null, mode: m?.[1] ?? null
    }
    const finish = (status, headers, body) => { rec.status = status; log.push(rec); res.writeHead(status, headers); res.end(body) }
    if (!m) return finish(404, { 'content-type': 'text/plain' }, 'nope')
    const [, mode, , rest] = m
    const cors = {}
    if (mode === 'acao' || mode === 'full' || mode === 'full-star') cors['access-control-allow-origin'] = '*'
    if (req.method === 'OPTIONS') {
      const h = { ...cors }
      if (mode === 'acao') h['access-control-allow-methods'] = 'GET, HEAD, OPTIONS'
      if (mode === 'full') { h['access-control-allow-methods'] = 'GET, HEAD, OPTIONS'; h['access-control-allow-headers'] = req.headers['access-control-request-headers'] ?? ''; h['access-control-max-age'] = '600' }
      if (mode === 'full-star') { h['access-control-allow-methods'] = 'GET, HEAD, OPTIONS'; h['access-control-allow-headers'] = '*'; h['access-control-max-age'] = '600' }
      return finish(204, h, '')
    }
    let body, type = 'application/octet-stream'
    if (rest === '/t/site.torrent') { body = site.torrentBytes; type = 'application/x-bittorrent' } else if (rest.startsWith('/ws/')) {
      const rel = decodeURIComponent(rest.slice(4)); body = site.files.get(rel)
    }
    if (!body) return finish(404, { ...cors, 'content-type': 'text/plain' }, 'not found')
    const headers = { ...cors, 'content-type': type, 'cache-control': 'no-store', 'accept-ranges': 'bytes' }
    const range = req.headers.range && /^bytes=(\d+)-(\d*)$/.exec(req.headers.range)
    if (range) {
      const a = Number(range[1]); const b = range[2] === '' ? body.length - 1 : Math.min(Number(range[2]), body.length - 1)
      headers['content-range'] = `bytes ${a}-${b}/${body.length}`
      return finish(206, headers, Buffer.from(body.subarray(a, b + 1)))
    }
    return finish(200, headers, Buffer.from(body))
  })
  return new Promise(resolve => server.listen(0, host, () => resolve({ server, port: server.address().port, origin: `http://${host}:${server.address().port}` })))
}

/** Origin A: serves a page + the official webtorrent bundle (or another bundle path) at /wt.js. */
export function startPageServer ({ pageHtml, bundlePath = WT_MIN, extra = {}, host = 'localhost', site = null, log = null }) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (site && u.pathname.startsWith('/ws/')) { // same-origin web seed (Range capable), no CORS headers at all
      const rec = { t: Date.now(), method: req.method, path: u.pathname, origin: req.headers.origin ?? null, acrh: req.headers['access-control-request-headers'] ?? null, range: req.headers.range ?? null, run: 'same-origin', mode: 'same-origin' }
      const body = site.files.get(decodeURIComponent(u.pathname.slice(4)))
      if (!body) { rec.status = 404; log?.push(rec); res.writeHead(404); return res.end('nf') }
      const headers = { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'accept-ranges': 'bytes' }
      const range = req.headers.range && /^bytes=(\d+)-(\d*)$/.exec(req.headers.range)
      if (range) { const a = Number(range[1]); const b = range[2] === '' ? body.length - 1 : Math.min(Number(range[2]), body.length - 1); headers['content-range'] = `bytes ${a}-${b}/${body.length}`; rec.status = 206; log?.push(rec); res.writeHead(206, headers); return res.end(Buffer.from(body.subarray(a, b + 1))) }
      rec.status = 200; log?.push(rec); res.writeHead(200, headers); return res.end(Buffer.from(body))
    }
    if (u.pathname === '/' || u.pathname === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(pageHtml) }
    if (u.pathname === '/wt.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }); return res.end(readFileSync(bundlePath)) }
    if (extra[u.pathname]) { const e = extra[u.pathname]; res.writeHead(200, { 'content-type': e.type, 'cache-control': 'no-store', ...(e.headers ?? {}) }); return res.end(e.body) }
    res.writeHead(404); res.end('404')
  })
  return new Promise(resolve => server.listen(0, host === 'localhost' ? '127.0.0.1' : host, () => resolve({ server, port: server.address().port, origin: `http://${host}:${server.address().port}` })))
}
export const closeServer = s => new Promise(r => s.close(() => r()))
