// E1: in which order does webtorrent 3.0.21 ask a web seed for pieces, per selection API?
// Run: PATH=$HOME/.local/share/node/current/bin:$PATH node docs/research/labs/w2a-10-lab/e1-selection-order.mjs
import WebTorrent from 'webtorrent'
import MemoryChunkStore from 'memory-chunk-store'
import fs from 'node:fs'
import { makeFiles, buildTorrent, startSeed, parseTorrent } from './lib-site.mjs'

const PL = 16384
const SPEC = [['big0.bin', 300000], ['big1.bin', 300000], ['mid.js', 40000], ['big2.bin', 300000], ['hot.css', 20000], ['big3.bin', 200000]]
const files = makeFiles(SPEC)
const torrentBuf = await buildTorrent(files, { pieceLength: PL })
const parsed = await parseTorrent(torrentBuf)
const numPieces = parsed.pieces.length
const fileInfo = parsed.files.map(f => ({ name: f.name, offset: f.offset, length: f.length, firstPiece: Math.floor(f.offset / PL), lastPiece: Math.floor((f.offset + f.length - 1) / PL) }))
console.log('torrent: pieces', numPieces, 'pieceLength', PL, 'infoHash', parsed.infoHash)
console.table(fileInfo)

function compress (arr) { // collapse consecutive duplicates and render runs like 3-7
  const out = []; let prev = null
  for (const x of arr) { if (x !== prev) out.push(x); prev = x }
  const runs = []; let s = out[0]; let p = out[0]
  for (let i = 1; i <= out.length; i++) {
    const v = out[i]
    if (v === p + 1) { p = v; continue }
    runs.push(s === p ? String(s) : `${s}-${p}`); s = v; p = v
  }
  return runs.join(' ')
}

async function scenario (label, { opts = {}, hook, viaMagnet = null, waitMs = 6000, maxWebConns = 1 } = {}) {
  const seed = await startSeed({ files, pieceLength: PL, torrentBuf, delayMs: 8 })
  const client = new WebTorrent({ dht: false, lsd: false, utp: false, natUpnp: false, natPmp: false, tracker: false })
  const t0 = Date.now(); const doneAt = {}
  const result = { label, maxWebConns, numPieces }
  try {
    const addOpts = { store: MemoryChunkStore, urlList: [seed.base], announce: [], maxWebConns, ...opts }
    const id = viaMagnet ? viaMagnet(seed) : torrentBuf
    const torrent = client.add(id, addOpts)
    torrent.on('error', e => { result.error = String(e) })
    torrent.on('ready', () => {
      for (const f of torrent.files) f.on('done', () => { doneAt[f.name] = Date.now() - t0 })
      if (hook) hook(torrent)
    })
    await new Promise(resolve => {
      const to = setTimeout(resolve, waitMs)
      torrent.once('done', () => { clearTimeout(to); resolve() })
    })
    result.torrentDone = torrent.done
    result.progress = +torrent.progress.toFixed(4)
    result.order = compress(seed.log.map(e => e.piece))
    result.firstPieces = seed.log.slice(0, 10).map(e => e.piece)
    result.requests = seed.log.length
    result.maxInflight = seed.maxInflight
    result.fileDoneMs = doneAt
    result.filesDone = torrent.files.filter(f => f.done).map(f => f.name)
    result.filesNotDone = torrent.files.filter(f => !f.done).map(f => f.name)
    result.selectionsLeft = torrent._selections._items.map(s => `${s.from}-${s.to}@${s.priority}${s.isStreamSelection ? 's' : ''}`)
    result.criticalFlags = torrent._critical.map((v, i) => v ? i : null).filter(v => v !== null).join(',') || null
  } catch (e) { result.error = String(e && e.stack || e) } finally {
    await client.destroy(); await seed.close()
  }
  console.log('\n' + label); console.log(JSON.stringify(result, null, 1))
  return result
}

const idx = n => fileInfo.findIndex(f => f.name === n)
const results = []
results.push(await scenario('S0 default (sequential, whole torrent selected at priority 0)'))
results.push(await scenario('S0b default, maxWebConns 4 (library default)', { maxWebConns: 4 }))
results.push(await scenario('S1 default + hot.css.select(10) (last-but-one file)', { hook: t => t.files[idx('hot.css')].select(10) }))
results.push(await scenario('S1b default + torrent.select(hot.css pieces, priority 10)', { hook: t => t.select(fileInfo[idx('hot.css')].firstPiece, fileInfo[idx('hot.css')].lastPiece, 10) }))
results.push(await scenario('S2 deselect:true, then hot.css.select(5) then torrent.select(0,N-1,0)', { opts: { deselect: true }, hook: t => { t.files[idx('hot.css')].select(5); t.select(0, numPieces - 1, 0) } }))
results.push(await scenario('S3 deselect:true, non-adjacent: hot.css p3, mid.js p2, big0 p1', { opts: { deselect: true }, hook: t => { t.files[idx('hot.css')].select(3); t.files[idx('mid.js')].select(2); t.files[idx('big0.bin')].select(1) } }))
results.push(await scenario('S3b deselect:true, hot.css p3 + mid.js p2 + (rest p0 last)', { opts: { deselect: true }, hook: t => { t.files[idx('hot.css')].select(3); t.files[idx('mid.js')].select(2); t.select(0, numPieces - 1, 0) } }))
results.push(await scenario('S3c deselect:true, rest p0 FIRST then hot.css p3 + mid.js p2', { opts: { deselect: true }, hook: t => { t.select(0, numPieces - 1, 0); t.files[idx('hot.css')].select(3); t.files[idx('mid.js')].select(2) } }))
results.push(await scenario('S4 default + stream selection: hot.css.createReadStream() (not consumed)', { hook: t => { const s = t.files[idx('hot.css')].createReadStream(); s.on('error', () => {}) ; s.pause?.() } }))
results.push(await scenario('S4b default + stream selection: hot.css + mid.js createReadStream()', { hook: t => { for (const n of ['hot.css', 'mid.js']) { const s = t.files[idx(n)].createReadStream(); s.on('error', () => {}) } } }))
results.push(await scenario('S5 default + torrent.critical(hot.css pieces)', { hook: t => t.critical(fileInfo[idx('hot.css')].firstPiece, fileInfo[idx('hot.css')].lastPiece) }))
results.push(await scenario("S6 strategy:'rarest' (single web seed)", { opts: { strategy: 'rarest' } }))
results.push(await scenario('S7 default + hot.css.select(10) AFTER first pieces arrive (t+60ms)', { hook: t => setTimeout(() => t.files[idx('hot.css')].select(10), 60) }))
results.push(await scenario('S8 deselect mid.js (middle file) after ready', { hook: t => t.files[idx('mid.js')].deselect() }))
results.push(await scenario('S9 so=magnet: select only file 2 (mid.js) and 4 (hot.css)', {
  viaMagnet: seed => `magnet:?xt=urn:btih:${parsed.infoHash}&xs=${encodeURIComponent(`http://127.0.0.1:${seed.port}/t.torrent`)}&ws=${encodeURIComponent(seed.base)}&so=2,4`
}))
fs.writeFileSync(new URL('./results/e1-selection-order.json', import.meta.url), JSON.stringify({ node: process.version, pieceLength: PL, numPieces, fileInfo, results }, null, 1))
console.log('\nwrote results/e1-selection-order.json')
process.exit(0)
