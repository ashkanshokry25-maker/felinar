// Does `new WebTorrent({ webSeeds:false })` stop url-list / ws= auto-connections while torrent.addWebSeed(conn) still works?
import http from 'node:http'; import crypto from 'node:crypto'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'
import WebTorrent from '$HOME/Documents/Projects/magnet-web/node_modules/webtorrent/index.js'
import createTorrent from '$HOME/Documents/Projects/magnet-web/node_modules/create-torrent/index.js'
import { HardenedWebConn } from '$HOME/Documents/Projects/magnet-web/docs/research/labs/w2c-01-lab/hardened-conn.mjs'
const DATA = crypto.randomBytes(1 << 20); DATA.name = 'site.bundle'
let stockHits = 0, goodHits = 0
const mk = (kind) => new Promise(r => { const s = http.createServer((req, res) => { const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || ''); const a = m ? +m[1] : 0, b = m ? +m[2] : DATA.length - 1; if (kind === 'stock') stockHits++; else goodHits++; const body = DATA.subarray(a, b + 1); res.writeHead(206, { 'content-length': body.length, 'content-range': `bytes ${a}-${b}/${DATA.length}` }); res.end(body) }); s.listen(0, '127.0.0.1', () => r(s)) })
const sStock = await mk('stock'), sGood = await mk('good')
const urlStock = `http://127.0.0.1:${sStock.address().port}/site.bundle`, urlGood = `http://127.0.0.1:${sGood.address().port}/site.bundle`
// the .torrent itself embeds url-list -> stock WebConn would be auto-created for it
const buf = await new Promise((res, rej) => createTorrent(DATA, { name: 'site.bundle', pieceLength: 65536, announceList: [], urlList: [urlStock], creationDate: new Date(0) }, (e, b) => e ? rej(e) : res(b)))
for (const webSeeds of [true, false]) {
  stockHits = 0; goodHits = 0
  const client = new WebTorrent({ dht: false, lsd: false, tracker: false, utp: false, natUpnp: false, natPmp: false, torrentPort: 0, webSeeds })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsf-'))
  const t = client.add(buf, { path: dir, announce: [] })
  t.once('ready', () => t.addWebSeed(new HardenedWebConn(urlGood, t, { baseDelay: 200 })))
  const done = await new Promise(res => { t.on('done', () => res(true)); setTimeout(() => res(false), 8000) })
  console.log(JSON.stringify({ clientOption_webSeeds: webSeeds, urlListInTorrent: t.urlList, done, hitsOnUrlListHost: stockHits, hitsOnHardenedHost: goodHits }))
  await new Promise(r => client.destroy(r)); fs.rmSync(dir, { recursive: true, force: true })
}
sStock.close(); sGood.close(); process.exit(0)
