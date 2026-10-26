// EXP-D: does the REAL webtorrent@3.0.21 client keep pieces from a file-prefilled preloadedStore and treat only the rest as missing?
import { pathToFileURL } from 'node:url';
const P = '$HOME/Documents/Projects/magnet-web/node_modules/';
const imp = async (m) => (await import(pathToFileURL(P + m).href));
const WebTorrent = (await imp('webtorrent/index.js')).default;
const createTorrent = (await imp('create-torrent/index.js')).default;
const MemoryChunkStore = (await imp('memory-chunk-store/index.js')).default;
const PL = 64 * 1024;
let seed = 12345; const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
const fill = (n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (rnd() * 256) | 0; return b; };
const files1 = new Map();
for (let i = 0; i < 120; i++) files1.set(`img/${String(i).padStart(3, '0')}.webp`, fill(20000 + ((rnd() * 200000) | 0)));
for (let i = 0; i < 40; i++) files1.set(`p/${String(i).padStart(3, '0')}/index.html`, fill(5000 + ((rnd() * 40000) | 0)));
const files2 = new Map(files1);
const old = files2.get('p/007/index.html'); const grown = new Uint8Array(old.length + 37); grown.set(old); grown.set(fill(37), old.length); files2.set('p/007/index.html', grown); // edited page, +37 B
files2.set('p/040/index.html', fill(30000));                                                                                                          // new page
files2.set('img/150.webp', fill(90000));                                                                                                              // new image
const order = (m) => [...m.keys()].sort();
const inputs = (m) => order(m).map(p => { const v = m.get(p).subarray(0); v.fullPath = 'site/' + p; return v; });
const make = (m) => new Promise((res, rej) => createTorrent(inputs(m), { name: 'site', pieceLength: PL, announce: [], creationDate: new Date(0) }, (e, t) => e ? rej(e) : res(t)));
const t2buf = await make(files2);
const total = order(files2).reduce((s, p) => s + files2.get(p).length, 0);

// prefill: unchanged files copied to their v2 offsets
const pre = new Uint8Array(total); let off = 0; let reusedBytes = 0;
for (const p of order(files2)) { const b2 = files2.get(p), b1 = files1.get(p); if (b1 && b1.length === b2.length && Buffer.compare(b1, b2) === 0) { pre.set(b2, off); reusedBytes += b2.length; } off += b2.length; }
const store = new MemoryChunkStore(PL, { length: total });
const nPieces = Math.ceil(total / PL);
await Promise.all(Array.from({ length: nPieces }, (_, i) => new Promise((res, rej) => store.put(i, Buffer.from(pre.subarray(i * PL, Math.min(total, (i + 1) * PL))), e => e ? rej(e) : res()))));

const client = new WebTorrent({ dht: false, lsd: false, natUpnp: false, natPmp: false, utp: false, tracker: false });
const t = client.add(t2buf, { preloadedStore: store, skipVerify: false, announce: [], path: '/nonexistent-never-written' });
await new Promise((res, rej) => { t.once('ready', res); t.once('error', rej); setTimeout(() => rej(new Error('timeout waiting for ready')), 60000); });
const have = [...Array(t.pieces.length).keys()].filter(i => t.bitfield.get(i)).length;
console.log(JSON.stringify({ webtorrent: '3.0.21', pieces: t.pieces.length, piecesAlreadyVerified: have, pct: +(100 * have / t.pieces.length).toFixed(1), progress: +t.progress.toFixed(4), done: t.done, downloadedBytesCounter: t.downloaded, unchangedFileBytes: reusedBytes, totalBytes: total, missingPieces: t.pieces.length - have, missingMiB: +(((t.pieces.length - have) * PL) / 1048576).toFixed(2), fileLevelDeltaKiB: +(((files2.get('p/007/index.html').length + files2.get('p/040/index.html').length + files2.get('img/150.webp').length) / 1024).toFixed(0)) }, null, 1));
client.destroy(); process.exit(0);
