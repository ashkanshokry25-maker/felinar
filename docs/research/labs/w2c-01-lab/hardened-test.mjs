import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebTorrent from '$HOME/Documents/Projects/magnet-web/node_modules/webtorrent/index.js'
import createTorrent from '$HOME/Documents/Projects/magnet-web/node_modules/create-torrent/index.js'
import { HardenedWebConn } from './hardened-conn.mjs'

const DATA = crypto.randomBytes(2 * 1024 * 1024); DATA.name = 'site.bundle'
const torrentBuf = await new Promise((res, rej) => createTorrent(DATA, { name: 'site.bundle', pieceLength: 65536, announceList: [], creationDate: new Date(0) }, (e, b) => e ? rej(e) : res(b)))
function mk (behavior) {
  const stats = { req: 0, bytes: 0 }
  const srv = http.createServer((req, res) => {
    stats.req++
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || ''); const s = m ? +m[1] : 0; const e = m ? +m[2] : DATA.length - 1
    const slice = DATA.subarray(s, e + 1)
    const send = (code, body, h = {}) => { res.writeHead(code, { 'content-length': body.length, ...h }); stats.bytes += body.length; res.end(body) }
    if (behavior === 'good') return send(206, slice, { 'content-range': `bytes ${s}-${e}/${DATA.length}` })
    if (behavior === 'e404') return send(404, Buffer.from('nf'))
    if (behavior === 'corrupt206') { const b = Buffer.from(slice); b[0] ^= 0xff; return send(206, b, { 'content-range': `bytes ${s}-${e}/${DATA.length}` }) }
    if (behavior === 'ignorerange') return send(200, DATA)
    if (behavior === 'gzip206') return send(206, slice, { 'content-range': `bytes ${s}-${e}/${DATA.length}`, 'content-encoding': 'gzip' })
  })
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, stats, behavior, url: `http://127.0.0.1:${srv.address().port}/site.bundle` })))
}
async function scenario (name, behaviors, timeoutMs = 20000) {
  const servers = await Promise.all(behaviors.map(mk))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-'))
  const client = new WebTorrent({ dht: false, lsd: false, tracker: false, utp: false, natUpnp: false, natPmp: false, torrentPort: 0 })
  const events = []
  const t = client.add(torrentBuf, { path: dir, urlList: [], announce: [] })
  t.once('ready', () => { for (const s of servers) t.addWebSeed(new HardenedWebConn(s.url, t, { baseDelay: 200, onEvent: e => events.push(e) })) })
  const t0 = Date.now()
  const done = await new Promise(res => { t.on('done', () => res(true)); setTimeout(() => res(false), timeoutMs) })
  const ok = done && crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'site.bundle'))).digest('hex') === crypto.createHash('sha256').update(DATA).digest('hex')
  console.log(JSON.stringify({ scenario: name, done, verified: ok, ms: Date.now() - t0, downloaded: t.downloaded, servers: servers.map(s => `${s.behavior}:req=${s.stats.req},MB=${(s.stats.bytes / 1048576).toFixed(1)}`), dropped: events.filter(e => e.type === 'dropped').length, failEvents: events.filter(e => e.type === 'fail').length, firstFail: (events.find(e => e.type === 'fail') || {}).reason }))
  await new Promise(r => client.destroy(r)); servers.forEach(s => s.srv.close()); fs.rmSync(dir, { recursive: true, force: true })
}
await scenario('good only', ['good'])
await scenario('404 + good', ['e404', 'good'])
await scenario('corrupt206 + good', ['corrupt206', 'good'])
await scenario('corrupt206 only (10s)', ['corrupt206'], 10000)
await scenario('ignorerange + good', ['ignorerange', 'good'])
await scenario('ignorerange only (10s)', ['ignorerange'], 10000)
await scenario('gzip206 + good', ['gzip206', 'good'])
await scenario('corrupt206 + ignorerange + good', ['corrupt206', 'ignorerange', 'good'])
process.exit(0)
