// Tiny lab: static server (per-route headers/delay hooks) + ws tracker + report sink. Ephemeral ports.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server as Tracker } from 'bittorrent-tracker'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const WWW = path.join(__dirname, 'www')
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function startLab ({ headersFor = () => ({}), delayFor = () => 0, withTracker = true, www = WWW } = {}) {
  const lab = { reports: [], hits: [], port: 0, trackerPort: 0, origin: '', tracker: null, trackerEvents: [] }
  let tracker = null
  if (withTracker) {
    tracker = new Tracker({ udp: false, http: false, ws: true, stats: false })
    await new Promise((resolve, reject) => { tracker.on('error', reject); tracker.listen(0, '127.0.0.1', resolve) })
    lab.trackerPort = tracker.http.address().port
    lab.tracker = tracker
    for (const ev of ['start', 'update', 'complete', 'stop']) tracker.on(ev, (addr, params) => lab.trackerEvents.push({ ev, t: Date.now(), peer: String(params && params.peer_id || '').slice(0, 8), offers: params && params.offers ? params.offers.length : undefined, answer: params && params.answer ? 1 : undefined, numwant: params && params.numwant }))
  }
  const server = http.createServer(async (req, res) => {
    req.on('error', () => {}); res.on('error', () => {})
    const url = new URL(req.url, lab.origin)
    lab.hits.push({ t: Date.now(), path: url.pathname + url.search, dest: req.headers['sec-fetch-dest'], mode: req.headers['sec-fetch-mode'], swHeader: req.headers['service-worker'], range: req.headers.range })
    if (url.pathname === '/__report') {
      let body = ''
      try { for await (const c of req) body += c } catch { /* client aborted (pagehide beacon) */ }
      try { lab.reports.push(JSON.parse(body)) } catch { if (body) lab.reports.push({ raw: body }) }
      try { res.writeHead(204); res.end() } catch {}
      return
    }
    let p = path.join(www, decodeURIComponent(url.pathname))
    if (!p.startsWith(www)) { res.writeHead(403); return res.end() }
    if (p.endsWith(path.sep) || (fs.existsSync(p) && fs.statSync(p).isDirectory())) p = path.join(p, 'index.html')
    if (!fs.existsSync(p)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found') }
    const d = delayFor(url, req)
    if (d) await sleep(d)
    const buf = fs.readFileSync(p)
    const headers = { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-cache', 'content-length': buf.length, ...headersFor(url, req, lab) }
    res.writeHead(200, headers); res.end(buf)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  lab.port = server.address().port
  lab.origin = `http://127.0.0.1:${lab.port}`
  lab.close = async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); if (tracker) await new Promise((r) => tracker.close(r)) }
  return lab
}
