// usage: node mk-torrents.mjs <blobdir> <outdir>
import createTorrent from '$HOME/Documents/Projects/magnet-web/node_modules/create-torrent/index.js'
import parseTorrent from '$HOME/Documents/Projects/magnet-web/node_modules/parse-torrent/index.js'
import fs from 'node:fs'
import path from 'node:path'
const [blobdir, outdir] = process.argv.slice(2)
const specs = [
  { file: 'bitcoin.pdf', pieceLength: 16384 },
  { file: 'arweave.png', pieceLength: 262144 },
  { file: 'gwcheck.txt', pieceLength: 16384 }
]
const meta = {}
for (const s of specs) {
  const data = fs.readFileSync(path.join(blobdir, s.file))
  data.name = s.file
  const buf = await new Promise((res, rej) => createTorrent(data, { name: s.file, pieceLength: s.pieceLength, announceList: [], private: false, creationDate: new Date(0) }, (e, b) => e ? rej(e) : res(b)))
  fs.writeFileSync(path.join(outdir, s.file + '.torrent'), buf)
  const p = await parseTorrent(buf)
  meta[s.file] = { infoHash: p.infoHash, length: p.length, pieceLength: p.pieceLength, pieces: p.pieces.length, announce: p.announce }
}
fs.writeFileSync(path.join(outdir, 'meta.json'), JSON.stringify(meta, null, 2))
console.log(JSON.stringify(meta, null, 2))
