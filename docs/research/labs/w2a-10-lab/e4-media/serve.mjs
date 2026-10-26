// Static server with correct Range support (baseline "net" variant and file source for the SW).
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
const TYPES = { html: 'text/html', js: 'text/javascript', mp4: 'video/mp4', m4a: 'audio/mp4', webm: 'video/webm', mp3: 'audio/mpeg' }
export function start (root) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); let p = path.join(root, decodeURIComponent(u.pathname)); if (!fs.existsSync(p) && process.env.MEDIA_DIR && u.pathname.startsWith('/media/')) p = path.join(process.env.MEDIA_DIR, decodeURIComponent(u.pathname.slice(7)))
    if ((!p.startsWith(root) && !(process.env.MEDIA_DIR && p.startsWith(process.env.MEDIA_DIR))) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; return res.end('nf') }
    const size = fs.statSync(p).size; const type = TYPES[p.split('.').pop()] || 'application/octet-stream'
    const m = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range)
    res.setHeader('Content-Type', type); res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Cache-Control', 'no-store')
    if (m) {
      let s = m[1] === '' ? size - +m[2] : +m[1]; let e = (m[1] === '' || m[2] === '') ? size - 1 : Math.min(+m[2], size - 1)
      res.statusCode = 206; res.setHeader('Content-Range', `bytes ${s}-${e}/${size}`); res.setHeader('Content-Length', e - s + 1)
      fs.createReadStream(p, { start: s, end: e }).pipe(res)
    } else { res.setHeader('Content-Length', size); fs.createReadStream(p).pipe(res) }
  })
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })))
}
