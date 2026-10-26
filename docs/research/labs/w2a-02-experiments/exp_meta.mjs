// EXP-A: how big is the .torrent info dict as a function of file count, total bytes, piece length?
// Uses the project's own create-torrent 6.1.3 + parse-torrent 11 (imported by absolute path; nothing is installed or written into the project).
import { pathToFileURL } from 'node:url';
const P = '$HOME/Documents/Projects/magnet-web/node_modules/';
const createTorrent = (await import(pathToFileURL(P + 'create-torrent/index.js').href)).default;
const bencode = (await import(pathToFileURL(P + 'bencode/index.js').href)).default;

const pool = new Uint8Array(1 << 20); // 1 MiB of zeros: content is irrelevant to metadata size
function rng(seed) { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32; }

function makeSite(nFiles, seed = 1) {
  const r = rng(seed); const files = [];
  const kinds = [
    // [share, size sampler, path builder]
    [0.04, () => 20e3 + r() * 100e3, i => `${2018 + (i % 8)}/${String(1 + (i % 12)).padStart(2, '0')}/post-${i}/index.html`],
    [0.01, () => 30e3 + r() * 90e3, i => `wp-content/themes/theme/assets/${i % 7 ? 'js' : 'css'}/bundle-${i}.${i % 7 ? 'js' : 'css'}`],
    [0.95, () => 8e3 + r() * r() * 900e3, i => `wp-content/uploads/${2018 + (i % 8)}/${String(1 + (i % 12)).padStart(2, '0')}/IMG_${10000 + i}-${[150, 300, 768, 1024, 1536, 2048][i % 6]}x${[150, 200, 512, 683, 1024, 1365][i % 6]}.webp`],
  ];
  let id = 0;
  for (const [share, size, pathOf] of kinds) {
    const n = Math.round(nFiles * share);
    for (let k = 0; k < n; k++, id++) {
      const len = Math.max(1, Math.min(pool.length, Math.floor(size())));
      const v = pool.subarray(0, len); // new view object per file (create-torrent stores the path on the object)
      v.fullPath = 'site/' + pathOf(id); files.push(v);
    }
  }
  files.sort((a, b) => (a.fullPath < b.fullPath ? -1 : 1));
  return files;
}
function build(files, pieceLength) {
  return new Promise((res, rej) => createTorrent(files, { name: 'site', pieceLength, announce: [], creationDate: new Date(0) }, (e, t) => e ? rej(e) : res(t)));
}
const rows = [];
for (const n of [1000, 5000, 10000, 20000, 50000]) {
  const files = makeSite(n);
  const total = files.reduce((s, f) => s + f.length, 0);
  for (const pl of [16 << 10, 64 << 10, 256 << 10, 1 << 20]) {
    const buf = await build(files.map(f => { const v = f.subarray(0); v.fullPath = f.fullPath; return v; }), pl);
    const d = bencode.decode(buf); const info = bencode.encode(d.info);
    const pieces = d.info.pieces.length / 20;
    rows.push({ files: files.length, MiB: +(total / 1048576).toFixed(0), pieceKiB: pl >> 10, pieces, torrentKB: +(buf.length / 1024).toFixed(0), infoKB: +(info.length / 1024).toFixed(0), pieceHashesKB: +(pieces * 20 / 1024).toFixed(0), fileListKB: +((info.length - pieces * 20) / 1024).toFixed(0), ut_metadata_16KiB_msgs: Math.ceil(info.length / 16384) });
  }
}
console.table(rows);
