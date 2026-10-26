// Shared helpers for the w2a-10 experiments (Node, webtorrent 3.0.21 from the project's node_modules).
import http from 'node:http'
import createTorrent from 'create-torrent'
import parseTorrent from 'parse-torrent'
import crypto from 'node:crypto'

export function det (n, seed) { // deterministic pseudo-random bytes (so SHA-1 is stable and data is incompressible)
  const out = Buffer.alloc(n)
  let x = (seed * 2654435761) >>> 0 || 1
  for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; out[i] = x & 255 }
  return out
}

export function makeFiles (spec, name = 'site') { // spec: [[path, size], ...] in the order given
  return spec.map(([p, size], i) => {
    const b = det(size, i + 7)
    b.name = p.split('/').pop()
    b.fullPath = name + '/' + p
    return b
  })
}

export function buildTorrent (files, { name = 'site', pieceLength = 16384, urlList } = {}) {
  return new Promise((resolve, reject) => {
    createTorrent(files, { name, pieceLength, announce: [], creationDate: new Date(0), urlList }, (err, buf) => err ? reject(err) : resolve(buf))
  })
}

// Web-seed server: BEP 19 multi-file layout <base>/<name>/<path>, Range support, per-request log.
export function startSeed ({ files, name = 'site', pieceLength, torrentBuf, delayMs = 10, honourRange = true, onRequest }) {
  const byPath = new Map(files.map(f => [f.fullPath, f]))
  const offsets = new Map(); let off = 0
  for (const f of files) { offsets.set(f.fullPath, off); off += f.length }
  const log = []; let seq = 0; let inflight = 0; let maxInflight = 0
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const p = decodeURIComponent(url.pathname)
    if (p === '/t.torrent') { res.setHeader('Access-Control-Allow-Origin', '*'); res.end(torrentBuf); return }
    const m = p.match(/^\/ws\/(.+)$/)
    const f = m && byPath.get(m[1])
    if (!f) { res.statusCode = 404; res.end('nf'); return }
    const range = req.headers.range && /bytes=(\d+)-(\d+)?/.exec(req.headers.range)
    const total = f.length
    let start = 0; let end = total - 1
    if (range && honourRange) { start = +range[1]; end = range[2] !== undefined ? Math.min(+range[2], total - 1) : total - 1 }
    const abs = offsets.get(f.fullPath) + start
    const entry = { seq: seq++, t: Date.now(), path: m[1], start, end, piece: Math.floor(abs / pieceLength), range: req.headers.range || null }
    log.push(entry); inflight++; maxInflight = Math.max(maxInflight, inflight)
    if (onRequest) onRequest(entry)
    setTimeout(() => {
      const body = f.subarray(start, end + 1)
      res.statusCode = (range && honourRange) ? 206 : 200
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Accept-Ranges', 'bytes')
      if (range && honourRange) res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`)
      res.setHeader('Content-Length', body.length)
      res.end(body, () => { inflight-- })
    }, delayMs)
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    resolve({ server, port, base: `http://127.0.0.1:${port}/ws/`, log, get maxInflight () { return maxInflight }, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r) }) })
  }))
}

export function sha1 (b) { return crypto.createHash('sha1').update(b).digest('hex') }
export { parseTorrent }
