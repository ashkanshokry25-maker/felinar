// VERIFY lab (claims 1-2): repeat stock-WebConn failover scenarios N times and dump the wire/reservation state at the end.
// usage: node stall-stats.mjs <scenario> <runs> <timeoutMs>
//   scenario: ignorerange-first | good-first | corrupt-only | e404-only | ignorerange-only | html200-first | short206-first
// Loopback only. Same data shape as w2c-01-lab/failover.mjs (2 MiB random, 64 KiB pieces = 32 pieces).
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebTorrent from '$HOME/Documents/Projects/magnet-web/node_modules/webtorrent/index.js'
import createTorrent from '$HOME/Documents/Projects/magnet-web/node_modules/create-torrent/index.js'

const [scenario = 'ignorerange-first', runs = '3', timeoutMs = '20000'] = process.argv.slice(2)
const DATA = crypto.randomBytes(2 * 1024 * 1024)
DATA.name = 'site.bundle'
const torrentBuf = await new Promise((res, rej) => createTorrent(DATA, { name: 'site.bundle', pieceLength: 65536, announceList: [], creationDate: new Date(0) }, (e, b) => e ? rej(e) : res(b)))
const SC = {
  'ignorerange-first': ['ignorerange', 'good'],
  'good-first': ['good', 'ignorerange'],
  'corrupt-only': ['corrupt206'],
  'e404-only': ['e404'],
  'ignorerange-only': ['ignorerange'],
  'html200-first': ['html200', 'good'],
  'short206-first': ['short206', 'good'] // 206 with correct Content-Range but only 100 bytes of body
}[scenario]
if (!SC) throw new Error('unknown scenario ' + scenario)

function mk (behavior) {
  const stats = { req: 0, bytes: 0 }
  const srv = http.createServer((req, res) => {
    stats.req++
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '')
    const s = m ? +m[1] : 0; const e = m ? +m[2] : DATA.length - 1
    const slice = DATA.subarray(s, e + 1)
    const send = (code, body, h = {}) => { res.writeHead(code, { 'content-length': body.length, ...h }); stats.bytes += body.length; res.end(body) }
    const cr = { 'content-range': `bytes ${s}-${e}/${DATA.length}` }
    switch (behavior) {
      case 'good': return send(206, slice, cr)
      case 'e404': return send(404, Buffer.from('nf'))
      case 'corrupt206': { const b = Buffer.from(slice); b[0] ^= 0xff; return send(206, b, cr) }
      case 'ignorerange': return send(200, DATA)
      case 'html200': return send(200, Buffer.from('<html>gateway error page</html>'))
      case 'short206': return send(206, slice.subarray(0, 100), cr)
    }
  })
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, stats, behavior, url: `http://127.0.0.1:${srv.address().port}/site.bundle` })))
}

const rows = []
for (let i = 1; i <= +runs; i++) {
  const servers = []
  for (const b of SC) servers.push(await mk(b)) // sequential so listen order == URL order
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'))
  const client = new WebTorrent({ dht: false, lsd: false, tracker: false, utp: false, natUpnp: false, natPmp: false, torrentPort: 0, dhtPort: 0 })
  const warns = []
  const t0 = Date.now()
  const t = client.add(torrentBuf, { path: dir, urlList: servers.map(s => s.url), announce: [] })
  t.on('warning', w => warns.push(String(w.message || w)))
  const done = await new Promise(res => { t.on('done', () => res(true)); setTimeout(() => res(false), +timeoutMs) })
  const ms = Date.now() - t0
  const missing = t.pieces.filter(Boolean).length // verified pieces are set to null in torrent.js
  const wires = t.wires.map(w => ({ type: w.type, requests: w.requests.length, speedBps: Math.round(w.downloadSpeed()), downloadedMiB: +(w.downloaded / 1048576).toFixed(1) }))
  const row = { scenario, run: i, done, ms, missingPieces: missing, downloadedB: t.downloaded, wires, warnings: warns.length, reqs: servers.map(s => `${s.behavior}:${s.stats.req}req/${(s.stats.bytes / 1048576).toFixed(0)}MiB`) }
  rows.push(row)
  console.log(JSON.stringify(row))
  await new Promise(r => client.destroy(r)); servers.forEach(s => s.srv.close()); fs.rmSync(dir, { recursive: true, force: true })
}
const doneN = rows.filter(r => r.done).length
console.log(JSON.stringify({ summary: scenario, runs: rows.length, completed: doneN, stuck: rows.length - doneN, requestsMin: Math.min(...rows.map(r => +r.reqs[0].split(':')[1].split('req')[0])), requestsMax: Math.max(...rows.map(r => +r.reqs[0].split(':')[1].split('req')[0])) }))
process.exit(0)
