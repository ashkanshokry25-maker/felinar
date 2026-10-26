// w1-13 C2: repeat C1 over 25 random edit sets and add a "pad only big files" strategy. Prints median [min..max] per configuration.
import createTorrent from 'create-torrent'
import parseTorrent from 'parse-torrent'
import { prng } from './lib.mjs'
const ct = (input, opts) => new Promise((res, rej) => createTorrent(input, opts, (e, t) => e ? rej(e) : res(t)))
function mkRng (seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296 } }
function makeSite (seed = 1) {
  const r = mkRng(seed); const files = []
  for (let i = 0; i < 200; i++) {
    const kind = i % 40 === 0 ? 'img' : i % 7 === 0 ? 'js' : i % 3 === 0 ? 'css' : 'html'
    const size = kind === 'img' ? 150000 + Math.floor(r() * 350000) : Math.max(300, Math.floor(Math.exp(8.7 + 1.1 * (r() + r() + r() - 1.5) * 1.7)))
    files.push({ path: `site/${kind}/f${String(i).padStart(3, '0')}.${kind === 'img' ? 'bin' : kind}`, bytes: prng(size, 1000 + i) })
  }
  return files
}
const base = makeSite(1)
function mutate (trial) {
  const r = mkRng(7000 + trial * 31); const v2 = base.map(f => ({ ...f }))
  for (let k = 0; k < 6; k++) { const idx = Math.floor(r() * v2.length); const extra = prng(1 + Math.floor(r() * 900), 5000 + trial * 10 + k); const nb = new Uint8Array(v2[idx].bytes.length + extra.length); nb.set(v2[idx].bytes); nb.set(extra, v2[idx].bytes.length); v2[idx].bytes = nb }
  for (let k = 0; k < 4; k++) v2.push({ path: `site/html/new${trial}_${k}.html`, bytes: prng(2000 + k * 777, 9000 + trial * 10 + k) })
  for (let k = 0; k < 2; k++) v2.splice(Math.floor(r() * v2.length), 1)
  return v2
}
const sortByPath = a => [...a].sort((x, y) => (x.path < y.path ? -1 : 1))
async function pieces (files, pieceLength, strategy) {
  const input = []; let off = 0; const sorted = sortByPath(files)
  sorted.forEach((f, i) => {
    const u = f.bytes.slice(); u.name = f.path.split('/').pop(); u.fullPath = f.path; input.push(u); off += f.bytes.length
    const doPad = strategy === 'all' || (strategy === 'big' && f.bytes.length >= pieceLength)
    if (doPad && i < sorted.length - 1) { const rem = off % pieceLength; if (rem) { const n = pieceLength - rem; const z = new Uint8Array(n); z.name = String(n); z.fullPath = `site/.pad/${n}`; input.push(z); off += n } }
  })
  const p = await parseTorrent(await ct(input, { name: 'site', pieceLength, announce: [], creationDate: new Date(1700000000000) }))
  return { hashes: p.pieces, total: p.length }
}
const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
const out = []
for (const pieceLength of [16384, 65536, 262144]) {
  for (const strategy of ['none', 'big', 'all']) {
    const v1 = await pieces(base, pieceLength, strategy); const have = new Set(v1.hashes)
    const reuse = [], over = [], fetchKB = []
    for (let t = 0; t < 25; t++) {
      const v2f = mutate(t); const v2 = await pieces(v2f, pieceLength, strategy)
      const content = v2f.reduce((s, f) => s + f.bytes.length, 0)
      const reused = v2.hashes.filter(h => have.has(h)).length
      reuse.push(100 * reused / v2.hashes.length); over.push(100 * (v2.total - content) / content); fetchKB.push(Math.round(((v2.hashes.length - reused) * pieceLength) / 1024))
    }
    out.push({ pieceLength, strategy, sizeOverheadPctMedian: +median(over).toFixed(1), reusePctMedian: +median(reuse).toFixed(1), reusePctMin: +Math.min(...reuse).toFixed(1), reusePctMax: +Math.max(...reuse).toFixed(1), kbToFetchMedian: median(fetchKB) })
  }
}
console.log(JSON.stringify(out, null, 1))
