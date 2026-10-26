// Build a VALID hybrid (BEP 52 + BEP 47) torrent by hand, then test webtorrent 3.0.21 + parse-torrent 11 against it.
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import bencode from '$HOME/Documents/Projects/magnet-web/node_modules/bencode/index.js'
import parseTorrent from '$HOME/Documents/Projects/magnet-web/node_modules/parse-torrent/index.js'
import { HardenedWebConn } from './hardened-conn.mjs'
import WebTorrent from '$HOME/Documents/Projects/magnet-web/node_modules/webtorrent/index.js'

const PL = 16384 // piece length = 16 KiB so the piece layer == leaf layer
const sha1 = b => crypto.createHash('sha1').update(b).digest()
const sha256 = b => crypto.createHash('sha256').update(b).digest()
const ZERO = Buffer.alloc(32)
function leaves (data) { const out = []; for (let o = 0; o < data.length; o += 16384) out.push(sha256(data.subarray(o, Math.min(o + 16384, data.length)))); return out }
function root (ls) { if (ls.length === 1) return ls[0]; let n = 1; while (n < ls.length) n <<= 1; let layer = ls.concat(Array(n - ls.length).fill(ZERO)); while (layer.length > 1) { const nx = []; for (let i = 0; i < layer.length; i += 2) nx.push(sha256(Buffer.concat([layer[i], layer[i + 1]]))); layer = nx } return layer[0] }

const files = [ ['a.txt', crypto.randomBytes(100000)], ['b.txt', crypto.randomBytes(50000)], ['c.txt', crypto.randomBytes(5000)] ]
// v1 file list with BEP 47 padding so every file starts on a piece boundary
const v1files = []; const tree = {}; const layers = {}; let concat = []
files.forEach(([name, data], i) => {
  v1files.push({ length: data.length, path: [name] }); concat.push(data)
  const ls = leaves(data); const r = root(ls)
  tree[name] = { '': { length: data.length, 'pieces root': r } }
  if (data.length > PL) layers[r.toString('latin1')] = Buffer.concat(ls)
  const rem = data.length % PL
  if (rem && i < files.length - 1) { const pad = PL - rem; v1files.push({ attr: 'p', length: pad, path: ['.pad', String(pad)] }); concat.push(Buffer.alloc(pad)) }
})
const whole = Buffer.concat(concat)
const pieces = []; for (let o = 0; o < whole.length; o += PL) pieces.push(sha1(whole.subarray(o, Math.min(o + PL, whole.length))))
const info = { name: 'site', 'piece length': PL, pieces: Buffer.concat(pieces), files: v1files, 'file tree': tree, 'meta version': 2 }
const torrent = { info, 'piece layers': layers, 'creation date': 0 }
const buf = Buffer.from(bencode.encode(torrent))
const infoEnc = Buffer.from(bencode.encode(info))
console.log('expected btih (sha1(info)) :', sha1(infoEnc).toString('hex'))
console.log('expected btmh (sha256(info)):', '1220' + sha256(infoEnc).toString('hex'))
const parsed = await parseTorrent(buf)
console.log('parse-torrent infoHash      :', parsed.infoHash, '| infoHashV2:', parsed.infoHashV2 || '(none)')
console.log('parse-torrent files         :', parsed.files.map(f => `${f.path}(${f.length})`).join(', '))
console.log('pieces:', parsed.pieces.length, ' total length:', parsed.length, ' whole padded length:', whole.length)

async function run (padMode) {
  const hits = {}
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url); hits[u] = (hits[u] || 0) + 1
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || ''); const s = m ? +m[1] : 0
    const seg = u.split('/').slice(2).join('/') // strip /site
    let body = null
    const f = files.find(([n]) => n === seg); if (f) body = f[1]
    if (!body && seg.startsWith('.pad/')) { if (padMode === 'zeros') body = Buffer.alloc(+seg.split('/')[1]) }
    if (!body) { res.writeHead(404); return res.end('nf') }
    const e = m ? +m[2] : body.length - 1; const slice = body.subarray(s, e + 1)
    res.writeHead(206, { 'content-length': slice.length, 'content-range': `bytes ${s}-${e}/${body.length}` }); res.end(slice)
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-'))
  const client = new WebTorrent({ dht: false, lsd: false, tracker: false, utp: false, natUpnp: false, natPmp: false, torrentPort: 0 })
  const t = client.add(buf, { path: dir, urlList: [], announce: [] })
  t.once('ready', () => t.addWebSeed(new HardenedWebConn(`http://127.0.0.1:${srv.address().port}`, t, { baseDelay: 200 })))
  const warns = []; t.on('warning', w => warns.push(String(w.message || w)))
  const t0 = Date.now()
  const done = await new Promise(res => { t.on('done', () => res(true)); setTimeout(() => res(false), 12000) })
  console.log(JSON.stringify({ padMode, done, ms: Date.now() - t0, downloaded: t.downloaded, of: t.length, torrentFiles: t.files.map(f => f.path), btih: t.infoHash, padRequests: Object.keys(hits).filter(k => k.includes('.pad')).map(k => `${k}:${hits[k]}`).slice(0, 6), warn: warns.slice(0, 2) }))
  await new Promise(r => client.destroy(r)); srv.close(); fs.rmSync(dir, { recursive: true, force: true })
}
await run('404')
process.exit(0)
