// VERIFY lab (claim 4): edge cases the original lab did not run against HardenedWebConn (imported unmodified from w2c-01-lab).
//  A. intermittently corrupt host: "caps a bad host at 5 requests then drops it" only counts CONSECUTIVE integrity failures; any success resets.
//  B. repeat of the original hostile scenarios 5x to get a timing distribution for "20-80 ms".
//  C. BEP 47 pad file with attr:'p' but NOT at the recommended .pad/N path (the connection detects pads by path regex only).
// usage: node hardened-extra.mjs A|B|C
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebTorrent from '$HOME/Documents/Projects/magnet-web/node_modules/webtorrent/index.js'
import createTorrent from '$HOME/Documents/Projects/magnet-web/node_modules/create-torrent/index.js'
import bencode from '$HOME/Documents/Projects/magnet-web/node_modules/bencode/index.js'
import { HardenedWebConn } from '../w2c-01-lab/hardened-conn.mjs'

const which = process.argv[2] || 'A'
const opts = { dht: false, lsd: false, tracker: false, utp: false, natUpnp: false, natPmp: false, torrentPort: 0, dhtPort: 0, webSeeds: false }
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex')

function serverFor (DATA, behavior) {
  const stats = { req: 0, bytes: 0, corruptSent: 0, goodSent: 0 }
  let n = 0
  const srv = http.createServer((req, res) => {
    stats.req++; n++
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '')
    const s = m ? +m[1] : 0; const e = m ? +m[2] : DATA.length - 1
    const slice = DATA.subarray(s, e + 1)
    const send = (code, body, h = {}) => { res.writeHead(code, { 'content-length': body.length, ...h }); stats.bytes += body.length; res.end(body) }
    const cr = { 'content-range': `bytes ${s}-${e}/${DATA.length}` }
    const corrupt = () => { const b = Buffer.from(slice); b[0] ^= 0xff; stats.corruptSent++; return send(206, b, cr) }
    const good = () => { stats.goodSent++; return send(206, slice, cr) }
    switch (behavior) {
      case 'good': return good()
      case 'corrupt206': return corrupt()
      case 'alt-corrupt': return n % 2 === 1 ? corrupt() : good() // every odd request corrupt, every even request good
      case 'corrupt-4of5': return n % 5 === 0 ? good() : corrupt() // 1 in 5 good: never 5 consecutive failures
      case 'ignorerange': return send(200, DATA)
      case 'e404': return send(404, Buffer.from('nf'))
    }
  })
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, stats, behavior, url: `http://127.0.0.1:${srv.address().port}/site.bundle` })))
}

async function runScenario (label, DATA, torrentBuf, behaviors, timeoutMs, baseDelay = 200) {
  const servers = []; for (const b of behaviors) servers.push(await serverFor(DATA, b))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'he-'))
  const client = new WebTorrent(opts)
  const events = []
  const t = client.add(torrentBuf, { path: dir, announce: [] })
  t.once('ready', () => { for (const s of servers) t.addWebSeed(new HardenedWebConn(s.url, t, { baseDelay, onEvent: e => events.push(e) })) })
  const t0 = Date.now()
  const done = await new Promise(res => { t.on('done', () => res(true)); setTimeout(() => res(false), timeoutMs) })
  const ms = Date.now() - t0
  const verified = done ? sha256(fs.readFileSync(path.join(dir, 'site.bundle'))) === sha256(DATA) : null
  const row = { label, done, verified, ms, servers: servers.map(s => `${s.behavior}:req=${s.stats.req},corruptSent=${s.stats.corruptSent},goodSent=${s.stats.goodSent}`), dropped: events.filter(e => e.type === 'dropped').length, failEvents: events.filter(e => e.type === 'fail').length }
  console.log(JSON.stringify(row))
  await new Promise(r => client.destroy(r)); servers.forEach(s => s.srv.close()); fs.rmSync(dir, { recursive: true, force: true })
  return row
}

if (which === 'A' || which === 'B') {
  const size = which === 'A' ? 8 * 1024 * 1024 : 2 * 1024 * 1024
  const DATA = crypto.randomBytes(size); DATA.name = 'site.bundle'
  const torrentBuf = await new Promise((res, rej) => createTorrent(DATA, { name: 'site.bundle', pieceLength: 65536, announceList: [], creationDate: new Date(0) }, (e, b) => e ? rej(e) : res(b)))
  if (which === 'A') {
    console.log(`# A: ${size >> 20} MiB, ${size / 65536} pieces, baseDelay 200 ms. Strict-corrupt control vs intermittent-corrupt hosts, alone (so the torrent can only finish through them).`)
    await runScenario('control: corrupt206 alone (always bad)', DATA, torrentBuf, ['corrupt206'], 8000)
    await runScenario('alt-corrupt alone (every 2nd response good)', DATA, torrentBuf, ['alt-corrupt'], 30000)
    await runScenario('corrupt-4of5 alone (only every 5th response good)', DATA, torrentBuf, ['corrupt-4of5'], 30000)
    await runScenario('corrupt-4of5 + good', DATA, torrentBuf, ['corrupt-4of5', 'good'], 15000)
  } else {
    console.log('# B: original hostile scenarios, 5 repetitions each, ms to done')
    for (const sc of [['404 + good', ['e404', 'good']], ['corrupt206 + good', ['corrupt206', 'good']], ['ignorerange + good', ['ignorerange', 'good']], ['corrupt206 + ignorerange + good', ['corrupt206', 'ignorerange', 'good']], ['good only', ['good']]]) {
      const ms = []
      for (let i = 0; i < 5; i++) { const r = await runScenario(sc[0] + ' #' + (i + 1), DATA, torrentBuf, sc[1], 20000, 200); ms.push(r.done ? r.ms : -1) }
      console.log(JSON.stringify({ summary: sc[0], msRuns: ms, min: Math.min(...ms), max: Math.max(...ms) }))
    }
  }
} else if (which === 'C') {
  // hybrid-like v1 torrent: 3 files with BEP 47 padding entries (attr 'p'), pad path either the recommended .pad/N or a non-standard _padding/x<N>
  const PL = 16384
  const files = [['a.txt', crypto.randomBytes(100000)], ['b.txt', crypto.randomBytes(50000)], ['c.txt', crypto.randomBytes(5000)]]
  for (const padDir of ['.pad', '_padding']) {
    const v1files = []; const concat = []
    files.forEach(([name, data], i) => {
      v1files.push({ length: data.length, path: [name] }); concat.push(data)
      const rem = data.length % PL
      if (rem && i < files.length - 1) { const pad = PL - rem; v1files.push({ attr: 'p', length: pad, path: [padDir, padDir === '.pad' ? String(pad) : 'x' + pad] }); concat.push(Buffer.alloc(pad)) }
    })
    const whole = Buffer.concat(concat); const pieces = []
    for (let o = 0; o < whole.length; o += PL) pieces.push(crypto.createHash('sha1').update(whole.subarray(o, Math.min(o + PL, whole.length))).digest())
    const info = { name: 'site', 'piece length': PL, pieces: Buffer.concat(pieces), files: v1files }
    const buf = Buffer.from(bencode.encode({ info, 'creation date': 0 }))
    const hits = {}
    const srv = http.createServer((req, res) => {
      const u = decodeURIComponent(req.url); hits[u] = (hits[u] || 0) + 1
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || ''); const s = m ? +m[1] : 0
      const seg = u.split('/').slice(2).join('/'); const f = files.find(([n]) => n === seg)
      if (!f) { res.writeHead(404); return res.end('nf') } // pads are NOT served: a correct client must synthesize them
      const body = f[1]; const e = m ? +m[2] : body.length - 1; const slice = body.subarray(s, e + 1)
      res.writeHead(206, { 'content-length': slice.length, 'content-range': `bytes ${s}-${e}/${body.length}` }); res.end(slice)
    })
    await new Promise(r => srv.listen(0, '127.0.0.1', r))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-'))
    const client = new WebTorrent(opts)
    const t = client.add(buf, { path: dir, announce: [] })
    t.once('ready', () => t.addWebSeed(new HardenedWebConn(`http://127.0.0.1:${srv.address().port}`, t, { baseDelay: 200 })))
    const t0 = Date.now()
    const done = await new Promise(res => { t.on('done', () => res(true)); setTimeout(() => res(false), 8000) })
    console.log(JSON.stringify({ padDir, padFilePaths: t.files.filter(f => /pad/.test(f.path)).map(f => f.path), done, ms: Date.now() - t0, downloaded: t.downloaded, of: t.length, padRequestsToHost: Object.entries(hits).filter(([k]) => /pad/.test(k)).map(([k, v]) => `${k}:${v}`) }))
    await new Promise(r => client.destroy(r)); srv.close(); fs.rmSync(dir, { recursive: true, force: true })
  }
}
process.exit(0)
