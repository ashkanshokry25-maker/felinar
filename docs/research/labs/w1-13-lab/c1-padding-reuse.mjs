// w1-13 C1: BEP 47 padding files vs. cross-version piece reuse on a synthetic site (deterministic PRNG).
// Builds v1 and v2 of a ~200-file site with create-torrent (pads are synthetic zero "files" under .pad/<n>, then `attr:'p'` is patched in),
// and measures (a) size overhead of padding, (b) how many v2 pieces already exist (by SHA-1) in v1, (c) bytes a v1 visitor must still fetch.
import createTorrent from 'create-torrent'
import parseTorrent from 'parse-torrent'
import bencode from 'bencode'
import { prng } from './lib.mjs'

const ct = (input, opts) => new Promise((res, rej) => createTorrent(input, opts, (e, t) => e ? rej(e) : res(t)))
function mkRng (seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296 } }

// ---- synthetic site: log-normal sizes (median ~6 KB), a few large media files ----
function makeSite (seed = 1) {
  const r = mkRng(seed); const files = []
  for (let i = 0; i < 200; i++) {
    const kind = i % 40 === 0 ? 'img' : i % 7 === 0 ? 'js' : i % 3 === 0 ? 'css' : 'html'
    const size = kind === 'img' ? 150000 + Math.floor(r() * 350000) : Math.max(300, Math.floor(Math.exp(8.7 + 1.1 * (r() + r() + r() - 1.5) * 1.7)))
    files.push({ path: `site/${kind}/f${String(i).padStart(3, '0')}.${kind === 'img' ? 'bin' : kind}`, bytes: prng(size, 1000 + i) })
  }
  return files
}
const v1 = makeSite(1)
// v2: edit 6 files (size changes: +1..+900 bytes), add 4 new files, delete 2
const r2 = mkRng(99); const v2 = v1.map(f => ({ ...f }))
for (const idx of [3, 17, 58, 101, 150, 187]) { const extra = prng(1 + Math.floor(r2() * 900), 5000 + idx); const nb = new Uint8Array(v2[idx].bytes.length + extra.length); nb.set(v2[idx].bytes); nb.set(extra, v2[idx].bytes.length); v2[idx].bytes = nb }
for (let k = 0; k < 4; k++) v2.push({ path: `site/html/new${k}.html`, bytes: prng(2000 + k * 777, 9000 + k) })
v2.splice(120, 1); v2.splice(40, 1)
const sortByPath = a => [...a].sort((x, y) => (x.path < y.path ? -1 : 1))

async function build (files, pieceLength, pad) {
  const input = []
  let off = 0
  const sorted = sortByPath(files)
  sorted.forEach((f, i) => {
    const u = f.bytes.slice(); u.name = f.path.split('/').pop(); u.fullPath = f.path; input.push(u)
    off += f.bytes.length
    if (pad && i < sorted.length - 1) {
      const rem = off % pieceLength
      if (rem !== 0) { const n = pieceLength - rem; const z = new Uint8Array(n); z.name = String(n); z.fullPath = `site/.pad/${n}`; input.push(z); off += n }
    }
  })
  const buf = await ct(input, { name: 'site', pieceLength, announce: [], creationDate: new Date(1700000000000) })
  const d = bencode.decode(buf)
  if (pad) for (const e of d.info.files) { const p = e.path.map(x => Buffer.from(x).toString()); if (p[0] === '.pad') e.attr = Buffer.from('p') }
  const patched = Buffer.from(bencode.encode(d))
  const parsed = await parseTorrent(patched)
  return { parsed, torrent: patched, padFiles: parsed.files.filter(f => /\/\.pad\//.test(f.path)).length, content: files.reduce((s, f) => s + f.bytes.length, 0) }
}
const rows = []
for (const pieceLength of [16384, 65536, 262144]) {
  for (const pad of [false, true]) {
    const a = await build(v1, pieceLength, pad), b = await build(v2, pieceLength, pad)
    const have = new Set(a.parsed.pieces)
    const reused = b.parsed.pieces.filter(h => have.has(h)).length
    const total = b.parsed.pieces.length
    const bytesTotal = b.parsed.length
    const padBytesV2 = b.parsed.files.filter(f => /\/\.pad\//.test(f.path)).reduce((s, f) => s + f.length, 0)
    // bytes that must be fetched for v2 by a v1 holder (piece granularity; zero-pad-only pieces are free for BEP47-aware clients but cost for WebTorrent)
    const fetchBytes = (total - reused) * pieceLength
    rows.push({ pieceLength, pad, v1Pieces: a.parsed.pieces.length, v2Pieces: total, v2TorrentBytes: bytesTotal, contentBytes: b.content, padFiles: b.padFiles, padBytes: padBytesV2, sizeOverheadPct: +(100 * padBytesV2 / b.content).toFixed(1), reusedPieces: reused, reusePct: +(100 * reused / total).toFixed(1), approxBytesToFetch: fetchBytes, infoHashV2: b.parsed.infoHash, torrentFileBytes: b.torrent.length })
  }
}
console.log(JSON.stringify({ site: { files: v1.length, contentBytesV1: v1.reduce((s, f) => s + f.bytes.length, 0), editedFiles: 6, newFiles: 4, deletedFiles: 2 }, rows }, null, 1))
