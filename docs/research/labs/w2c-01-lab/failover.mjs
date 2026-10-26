// Local multi-web-seed failover experiment with webtorrent 3.0.21 in Node. No external network.
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebTorrent from '$HOME/Documents/Projects/magnet-web/node_modules/webtorrent/index.js'
import createTorrent from '$HOME/Documents/Projects/magnet-web/node_modules/create-torrent/index.js'

const DATA = crypto.randomBytes(2 * 1024 * 1024) // 2 MiB random
DATA.name = 'site.bundle'
const PIECE = 65536
const torrentBuf = await new Promise((res, rej) => createTorrent(DATA, { name: 'site.bundle', pieceLength: PIECE, announceList: [], creationDate: new Date(0) }, (e, b) => e ? rej(e) : res(b)))

function mkServer (behavior) {
  const stats = { req: 0, bytes: 0, ok: 0 }
  const srv = http.createServer((req, res) => {
    stats.req++
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '')
    const s = m ? +m[1] : 0; const e = m ? +m[2] : DATA.length - 1
    const slice = DATA.subarray(s, e + 1)
    const send = (code, body, extra = {}) => { res.writeHead(code, { 'content-length': body.length, ...extra }); stats.bytes += body.length; res.end(body) }
    switch (behavior) {
      case 'good': stats.ok++; return send(206, slice, { 'content-range': `bytes ${s}-${e}/${DATA.length}`, 'accept-ranges': 'bytes' })
      case 'e404': return send(404, Buffer.from('not found'))
      case 'e503': return send(503, Buffer.from('busy'))
      case 'corrupt206': { const b = Buffer.from(slice); b[0] ^= 0xff; return send(206, b, { 'content-range': `bytes ${s}-${e}/${DATA.length}` }) }
      case 'ignorerange': return send(200, DATA)
      case 'html200': return send(200, Buffer.from('<html>gateway error page</html>'))
      case 'slow': setTimeout(() => { stats.ok++; send(206, slice, { 'content-range': `bytes ${s}-${e}/${DATA.length}` }) }, 3000); return
      case 'flaky': if (Math.random() < 0.5) return send(503, Buffer.from('flaky')); stats.ok++; return send(206, slice, { 'content-range': `bytes ${s}-${e}/${DATA.length}` })
      case 'hang': return // never respond
    }
  })
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, stats, url: `http://127.0.0.1:${srv.address().port}/site.bundle`, behavior })))
}

async function scenario (name, behaviors, { timeoutMs = 45000, maxWebConns } = {}) {
  const servers = await Promise.all(behaviors.map(mkServer))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-'))
  const client = new WebTorrent({ dht: false, lsd: false, tracker: false, utp: false, natUpnp: false, natPmp: false, torrentPort: 0, dhtPort: 0 })
  const warns = []
  const t0 = Date.now()
  const opts = { path: dir, urlList: servers.map(s => s.url), announce: [] }
  if (maxWebConns) opts.maxWebConns = maxWebConns
  const t = client.add(torrentBuf, opts)
  t.on('warning', w => warns.push(String(w.message || w)))
  t.on('error', e => warns.push('ERROR ' + e))
  const done = await new Promise(res => { t.on('done', () => res(true)); setTimeout(() => res(false), timeoutMs) })
  const ms = Date.now() - t0
  let verified = null
  if (done) { verified = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'site.bundle'))).digest('hex') === crypto.createHash('sha256').update(DATA).digest('hex') }
  const row = { scenario: name, done, ms, downloaded: t.downloaded, verified, pieceFailWarnings: warns.filter(w => /failed verification/.test(w)).length, otherWarn: warns.filter(w => !/failed verification/.test(w)).slice(0, 2), servers: servers.map(s => `${s.behavior}:req=${s.stats.req},ok=${s.stats.ok},MB=${(s.stats.bytes / 1048576).toFixed(1)}`) }
  console.log(JSON.stringify(row))
  await new Promise(r => client.destroy(r)); servers.forEach(s => s.srv.close()); fs.rmSync(dir, { recursive: true, force: true })
}

const only = process.argv[2]
const extra = process.env.EXTRA === '1'
const all = [
  ['good only', ['good']],
  ['404 + good', ['e404', 'good']],
  ['good + 404', ['good', 'e404']],
  ['503 + good', ['e503', 'good']],
  ['hang + good', ['hang', 'good']],
  ['slow(3s) + good', ['slow', 'good']],
  ['corrupt206 + good', ['corrupt206', 'good']],
  ['html200 + good', ['html200', 'good']],
  ['ignorerange + good', ['ignorerange', 'good']],
  ['flaky + good', ['flaky', 'good']],
  ['corrupt206 only (10s)', ['corrupt206'], { timeoutMs: 10000 }],
  ['ignorerange only (10s)', ['ignorerange'], { timeoutMs: 10000 }],
  ['404 only (25s)', ['e404'], { timeoutMs: 25000 }]
]
const more = [
  ['ignorerange + good (run2, 20s)', ['ignorerange', 'good'], { timeoutMs: 20000 }],
  ['ignorerange + good (run3, 20s)', ['ignorerange', 'good'], { timeoutMs: 20000 }],
  ['ignorerange + good maxWebConns=1 (20s)', ['ignorerange', 'good'], { timeoutMs: 20000, maxWebConns: 1 }],
  ['good + ignorerange (20s)', ['good', 'ignorerange'], { timeoutMs: 20000 }],
  ['html200 + good (run2)', ['html200', 'good'], { timeoutMs: 20000 }],
  ['corrupt206 + ignorerange + good (20s)', ['corrupt206', 'ignorerange', 'good'], { timeoutMs: 20000 }]
]
for (const [n, b, o] of (extra ? more : all)) { if (only && !n.includes(only)) continue; await scenario(n, b, o) }
process.exit(0)
