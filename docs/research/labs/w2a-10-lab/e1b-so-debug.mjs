// E1b: why did so= not restrict the download in E1/S9? Inspect torrent.so around metadata arrival.
import WebTorrent from 'webtorrent'
import MemoryChunkStore from 'memory-chunk-store'
import { makeFiles, buildTorrent, startSeed, parseTorrent } from './lib-site.mjs'
const PL = 16384
const files = makeFiles([['big0.bin', 300000], ['big1.bin', 300000], ['mid.js', 40000], ['big2.bin', 300000], ['hot.css', 20000], ['big3.bin', 200000]])
const torrentBuf = await buildTorrent(files, { pieceLength: PL })
const parsed = await parseTorrent(torrentBuf)
console.log('parseTorrent(.torrent) has own key "so":', Object.prototype.hasOwnProperty.call(parsed, 'so'), '| value:', parsed.so)
async function run (label, makeId, opts = {}) {
  const seed = await startSeed({ files, pieceLength: PL, torrentBuf, delayMs: 8 })
  const client = new WebTorrent({ dht: false, lsd: false, utp: false, natUpnp: false, natPmp: false, tracker: false })
  const id = makeId(seed)
  const torrent = client.add(id, { store: MemoryChunkStore, announce: [], maxWebConns: 1, ...opts })
  console.log(`\n[${label}] right after add(): torrent.so =`, JSON.stringify(torrent.so), '| xs =', !!torrent.xs)
  torrent.on('metadata', () => console.log(`[${label}] on metadata: torrent.so =`, JSON.stringify(torrent.so)))
  torrent.on('ready', () => console.log(`[${label}] on ready: torrent.so =`, JSON.stringify(torrent.so), '| selections:', JSON.stringify(torrent._selections._items.map(s => `${s.from}-${s.to}@${s.priority}`))))
  await new Promise(r => { const t = setTimeout(r, 2500); torrent.once('done', () => { clearTimeout(t); r() }) })
  console.log(`[${label}] done=${torrent.done} progress=${torrent.progress.toFixed(3)} filesDone=${torrent.files.filter(f => f.done).map(f => f.name)}`)
  console.log(`[${label}] web-seed requests: ${seed.log.length}, pieces: ${[...new Set(seed.log.map(e => e.piece))].sort((a, b) => a - b).join(',')}`)
  await client.destroy(); await seed.close()
}
await run('magnet+xs+ws, so=2,4', s => `magnet:?xt=urn:btih:${parsed.infoHash}&xs=${encodeURIComponent(`http://127.0.0.1:${s.port}/t.torrent`)}&ws=${encodeURIComponent(s.base)}&so=2,4`)
await run('magnet+xs+ws, so=2,4, deselect:false explicit', s => `magnet:?xt=urn:btih:${parsed.infoHash}&xs=${encodeURIComponent(`http://127.0.0.1:${s.port}/t.torrent`)}&ws=${encodeURIComponent(s.base)}&so=2,4`, { deselect: false })
// metadata given up-front (a .torrent buffer) plus a so list passed some other way?
await run('torrent buffer + opts.so (not documented)', s => torrentBuf, { so: [2, 4], urlList: ['http://127.0.0.1:1/ws/'] })
process.exit(0)
