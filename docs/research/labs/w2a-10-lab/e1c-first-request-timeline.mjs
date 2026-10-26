// E1c: timeline of the first web-seed requests with an emulated 100 ms server latency (RTT proxy).
// Question: does the "validateWire" first request (last piece) delay the first useful piece by one RTT?
import WebTorrent from 'webtorrent'
import MemoryChunkStore from 'memory-chunk-store'
import fs from 'node:fs'
import { makeFiles, buildTorrent, startSeed } from './lib-site.mjs'
const PL = 65536
const files = makeFiles([['index.html', 30000], ['app.css', 20000], ['app.js', 150000], ['img1.png', 400000], ['img2.png', 400000]])
const torrentBuf = await buildTorrent(files, { pieceLength: PL })
const out = []
for (const [label, maxWebConns, deselect] of [['default (selected whole torrent), maxWebConns=4', 4, false], ['deselect:true + select(index.html..app.js), maxWebConns=4', 4, true]]) {
  const t0 = { v: 0 }
  const seed = await startSeed({ files, pieceLength: PL, torrentBuf, delayMs: 100, onRequest: () => {} })
  const client = new WebTorrent({ dht: false, lsd: false, utp: false, natUpnp: false, natPmp: false, tracker: false })
  t0.v = Date.now()
  const torrent = client.add(torrentBuf, { store: MemoryChunkStore, urlList: [seed.base], announce: [], maxWebConns, deselect })
  const done = {}
  torrent.on('ready', () => {
    for (const f of torrent.files) f.on('done', () => { done[f.name] = Date.now() - t0.v })
    if (deselect) for (const n of ['index.html', 'app.css', 'app.js']) torrent.files.find(f => f.name === n).select()
  })
  await new Promise(r => { const t = setTimeout(r, 4000); torrent.once('done', () => { clearTimeout(t); r() }); if (deselect) torrent.on('idle', () => { clearTimeout(t); r() }) })
  const tl = seed.log.slice(0, 12).map(e => `+${e.t - t0.v}ms ${e.path}[${e.start}-${e.end}] piece ${e.piece}`)
  console.log('\n' + label); console.log(tl.join('\n')); console.log('files done (ms since add):', JSON.stringify(done))
  out.push({ label, timeline: tl, done, requests: seed.log.length })
  await client.destroy(); await seed.close()
}
fs.writeFileSync(new URL('./results/e1c-first-request-timeline.json', import.meta.url), JSON.stringify({ pieceLength: PL, serverDelayMs: 100, out }, null, 1))
process.exit(0)
