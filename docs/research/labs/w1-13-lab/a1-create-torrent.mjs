// w1-13 A1: create-torrent 6.1.3 behaviour: piece length by size, determinism, info dict contents.
// Run from anywhere inside the project: node docs/research/labs/w1-13-lab/a1-create-torrent.mjs
import createTorrent from 'create-torrent'
import parseTorrent from 'parse-torrent'
import bencode from 'bencode'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const calcPieceLength = require('piece-length')
const ct = (input, opts) => new Promise((resolve, reject) => createTorrent(input, opts, (e, t) => e ? reject(e) : resolve(t)))
const hex = u8 => Buffer.from(u8).toString('hex')
const out = {}

// ---- 1. piece length by total size (formula + caps) ----
const KiB = 1024, MiB = KiB * 1024, GiB = MiB * 1024
const sizes = [0, 1, 1023, 1024, 100 * KiB, 1 * MiB, 8 * MiB, 16 * MiB, 24 * MiB, 32 * MiB, 64 * MiB, 128 * MiB, 256 * MiB, 512 * MiB, 1 * GiB, 2 * GiB, 4 * GiB, 8 * GiB, 16 * GiB, 64 * GiB, 256 * GiB, 1024 * GiB]
out.pieceLengthTable = sizes.map(sz => {
  const raw = calcPieceLength(sz)
  const used = Math.min(raw, 4 * MiB)
  return { bytes: sz, calc: raw, usedWithDefaultMax4MiB: used, pieces: sz === 0 ? 0 : Math.ceil(sz / used) }
})

// ---- 2. real create-torrent output for a few in-memory sizes (confirm formula) ----
const mk = (n, name) => { const b = new Uint8Array(n); b.name = name; return b }
out.realPieceLengths = []
for (const sz of [100 * KiB, 1 * MiB, 20 * MiB, 64 * MiB, 200 * MiB]) {
  const t = await ct(mk(sz, 'blob.bin'), { announce: [] })
  const p = await parseTorrent(t)
  out.realPieceLengths.push({ bytes: sz, pieceLength: p.pieceLength, pieces: p.pieces.length, torrentFileBytes: t.length })
}

// ---- 3. determinism with array-of-files input ----
function site (extra = {}) {
  const files = [
    ['site/index.html', '<h1>hi</h1>'], ['site/css/app.css', 'body{}'], ['site/js/app.js', 'console.log(1)'],
    ['site/.well-known/security.txt', 'Contact: x'], ['site/empty.txt', ''], ['site/.DS_Store', 'junk'], ['site/ünï/cödé.txt', 'unicode']
  ].map(([p, c]) => { const u = new TextEncoder().encode(c); u.name = p.split('/').pop(); u.fullPath = p; return u })
  return files
}
const base = { name: 'site', pieceLength: 16384, announce: [] }
const runs = []
for (let i = 0; i < 3; i++) { const t = await ct(site(), { ...base, creationDate: new Date(1700000000000) }); runs.push(t) }
const parsedBase = await parseTorrent(runs[0])
out.determinism = {
  sameInputThreeRunsIdenticalBytesWithPinnedDate: runs.every(r => Buffer.compare(r, runs[0]) === 0),
  infoHash: parsedBase.infoHash,
  fileListInTorrent: parsedBase.files.map(f => ({ path: f.path, length: f.length })),
  note: '.DS_Store dropped by isJunkPath (dot-prefixed AND in junk list); .well-known/security.txt kept in array mode; zero-length file kept'
}
// default (unpinned) date: two runs one second apart
const t1 = await ct(site(), base); await sleep(1100); const t2 = await ct(site(), base)
out.determinism.unpinnedDateBytesDiffer = Buffer.compare(t1, t2) !== 0
out.determinism.unpinnedDateInfoHashSame = (await parseTorrent(t1)).infoHash === (await parseTorrent(t2)).infoHash
// creationDate edge cases
const edge = {}
for (const [label, cd] of [['new Date(0)', new Date(0)], ['0', 0], ['new Date(1)', new Date(1)], ['new Date(1000)', new Date(1000)], ['1700000000 (seconds as number)', 1700000000]]) {
  const t = await ct(site(), { ...base, creationDate: cd })
  const dec = bencode.decode(t)
  edge[label] = Number(dec['creation date'])
}
out.creationDateEdgeCases = { nowSeconds: Math.floor(Date.now() / 1000), ...edge }
// top-level & info keys
const dec0 = bencode.decode(runs[0])
out.topLevelKeys = Object.keys(dec0).sort()
out.infoKeys = Object.keys(dec0.info).sort()
out.infoFileEntryKeys = Object.keys(dec0.info.files[0]).sort()

// options matrix: what changes the infohash
const variants = {
  baseline: base,
  comment: { ...base, comment: 'hello' },
  createdBy: { ...base, createdBy: 'magnet-web/1' },
  announceList: { ...base, announceList: [['wss://t.example/announce']] },
  urlList: { ...base, urlList: ['https://cdn.example/ws/'] },
  urlListString: { ...base, urlList: 'https://cdn.example/ws/' },
  privateTrue: { ...base, private: true },
  privateFalse: { ...base, private: false },
  infoSource: { ...base, info: { source: 'magnet-web' } },
  sslCert: { ...base, sslCert: 'abc' },
  pieceLength32k: { ...base, pieceLength: 32768 },
  nameOther: { ...base, name: 'other' },
  filterJunkOff: { ...base, filterJunkFiles: false }
}
out.optionEffects = {}
for (const [k, o] of Object.entries(variants)) {
  const t = await ct(site(), { ...o, creationDate: new Date(1700000000000) })
  const p = await parseTorrent(t)
  out.optionEffects[k] = { infoHash: p.infoHash, sameAsBaseline: p.infoHash === parsedBase.infoHash, torrentBytes: t.length, files: p.files.length }
}
// default announce list when neither announce nor announceList is given
const tDef = await ct(site(), { name: 'site', pieceLength: 16384, creationDate: new Date(1700000000000) })
out.defaultAnnounce = (await parseTorrent(tDef)).announce
// file order effect
const reversed = site().reverse()
out.orderEffect = { reversedInfoHash: (await parseTorrent(await ct(reversed, { ...base, creationDate: new Date(1700000000000) }))).infoHash, baseline: parsedBase.infoHash }
// piece boundaries: piece spans files (no padding)
const pf = await parseTorrent(runs[0])
out.pieceSpanning = { totalLength: pf.length, pieceLength: pf.pieceLength, pieces: pf.pieces.length, fileOffsets: pf.files.map(f => [f.path, f.offset, f.length]) }

// ---- 4. directory (string path) input: ordering, hidden files, NFC/NFD ----
const tmp = mkdtempSync(join(tmpdir(), 'w113-'))
const mkdir1 = (order) => {
  const d = join(tmp, 'd' + Math.random().toString(36).slice(2))
  mkdirSync(d)
  for (const n of order) writeFileSync(join(d, n), 'content of ' + n)
  mkdirSync(join(d, 'sub')); writeFileSync(join(d, 'sub', 'z.txt'), 'z'); writeFileSync(join(d, 'sub', 'a.txt'), 'a')
  mkdirSync(join(d, '.well-known')); writeFileSync(join(d, '.well-known', 'security.txt'), 'sec')
  writeFileSync(join(d, '.htaccess'), 'x'); writeFileSync(join(d, '.nojekyll'), '')
  return d
}
const dA = mkdir1(['zeta.txt', 'alpha.txt', 'mid.txt', 'Beta.txt', 'index.html'])
const dB = mkdir1(['index.html', 'Beta.txt', 'mid.txt', 'alpha.txt', 'zeta.txt'])
const tA = await ct(dA, { name: 'site', pieceLength: 16384, announce: [], creationDate: new Date(1700000000000) })
const tB = await ct(dB, { name: 'site', pieceLength: 16384, announce: [], creationDate: new Date(1700000000000) })
const pA = await parseTorrent(tA), pB = await parseTorrent(tB)
out.directoryInput = {
  readdirOrderA: readdirSync(dA), readdirOrderB: readdirSync(dB),
  filesInTorrentA: pA.files.map(f => f.path), filesInTorrentB: pB.files.map(f => f.path),
  sameInfoHashDespiteCreationOrder: pA.infoHash === pB.infoHash,
  hiddenFilesDroppedInDirectoryMode: !pA.files.some(f => /\.well-known|\.htaccess|\.nojekyll/.test(f.path)),
  note: 'string/directory input: every dot-file and dot-directory is skipped (notHidden filter), order = fs.readdir order'
}
rmSync(tmp, { recursive: true, force: true })

// ---- 5. single-file vs multi-file torrent, name rules ----
const one = await ct(mk(5000, 'only.bin'), { announce: [], pieceLength: 16384 })
const dOne = bencode.decode(one)
out.singleFile = { infoKeys: Object.keys(dOne.info).sort(), name: Buffer.from(dOne.info.name).toString() }
const noName = await ct([mk(10, 'a.txt'), mk(10, 'b.txt')], { announce: [], pieceLength: 16384 })
out.autoName = { twoFilesNoPrefix: Buffer.from(bencode.decode(noName).info.name).toString() }
const withPrefix = await ct(['a/x.txt', 'a/y.txt'].map(p => { const u = new Uint8Array(3); u.name = p.split('/')[1]; u.fullPath = p; return u }), { announce: [], pieceLength: 16384 })
out.autoNameCommonPrefix = Buffer.from(bencode.decode(withPrefix).info.name).toString()

console.log(JSON.stringify(out, null, 2))
