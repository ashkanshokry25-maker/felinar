// E1: how deterministic is create-torrent 6.1.3 for a CI build output directory?
// Run: node e1-determinism.mjs   (imports the project's pinned create-torrent / parse-torrent)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const PROJ = '$HOME/Documents/Projects/magnet-web/node_modules';
const { default: createTorrent } = await import(pathToFileURL(`${PROJ}/create-torrent/index.js`).href);
const { default: parseTorrent } = await import(pathToFileURL(`${PROJ}/parse-torrent/index.js`).href);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mwe1-'));
const files = {
  'index.html': '<!doctype html><title>x</title><script src="js/app.js"></script>\n',
  'about.html': '<h1>about</h1>\n',
  '404.html': '<h1>404</h1>\n',
  'css/app.css': 'body{margin:0}\n',
  'js/app.js': 'console.log(1)\n',
  'img/peer.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]),
  'data/about.json': '{"a":1}\n',
  '.well-known/security.txt': 'Contact: mailto:sec@example.com\n',
  '.well-known/assetlinks.json': '[]\n',
  '_headers': '/*\n  X-Test: 1\n',
  '.htaccess': 'Options -Indexes\n',
  '.DS_Store': 'junk',
};
function materialize(dir, order, mtimeBase) {
  fs.mkdirSync(dir, { recursive: true });
  let i = 0;
  for (const rel of order) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, files[rel]);
    const t = new Date(mtimeBase + (i++) * 1000);
    fs.utimesSync(p, t, t);
  }
}
const names = Object.keys(files);
const A = path.join(root, 'a', 'dist');
const B = path.join(root, 'b-other-place', 'dist');
materialize(A, names, Date.parse('2026-01-01T00:00:00Z'));
materialize(B, [...names].reverse(), Date.parse('2026-06-01T00:00:00Z')); // reverse creation order, other mtimes, other abs path

console.log('--- raw fs.readdirSync order (this filesystem) ---');
console.log('A root:', fs.readdirSync(A).join(' '));
console.log('B root:', fs.readdirSync(B).join(' '));

function listTorrent(buf) {
  const t = parseTorrent.toTorrentFile ? null : null; // placeholder for lints
  return buf;
}
async function summarize(buf) {
  const p = await parseTorrent(buf);
  return { infoHash: p.infoHash, name: p.name, n: p.files.length, files: p.files.map(f => f.path.replace(/^[^/]+\//, '')), pieceLength: p.pieceLength };
}
const mk = (input, opts) => new Promise((res, rej) => createTorrent(input, opts, (e, b) => e ? rej(e) : res(b)));

console.log('\n--- (1) directory-path input, default filters ---');
const base = { name: 'site', pieceLength: 262144, announce: [], creationDate: new Date('2026-10-17T00:00:00Z') };
const tA = await summarize(await mk(A, base));
const tB = await summarize(await mk(B, base));
console.log('A:', tA.infoHash, tA.n, 'files:', tA.files.join(', '));
console.log('B:', tB.infoHash, tB.n, 'files:', tB.files.join(', '));
console.log('same infohash A vs B (dir input, reversed creation order + other mtimes + other path)?', tA.infoHash === tB.infoHash);
console.log('.well-known present in dir-input torrent?', tA.files.some(f => f.startsWith('.well-known')));
console.log('dotfiles/_headers present?', ['.htaccess', '_headers', '.DS_Store'].map(n => `${n}:${tA.files.includes(n)}`).join(' '));

console.log('\n--- (2) explicit sorted Blob list incl. dotfiles (what a CI publisher should do) ---');
function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // byte-wise on UTF-16 code units; use Buffer.compare for strict UTF-8 order
async function explicit(dir, name, extra = {}) {
  const rels = walk(dir).filter(r => !r.endsWith('.DS_Store')).sort(cmp);
  const blobs = [];
  for (const r of rels) { const b = await fs.openAsBlob(path.join(dir, r)); b.fullPath = `${name}/${r}`; blobs.push(b); }
  return mk(blobs, { name, pieceLength: 262144, announce: [], ...extra });
}
const e1 = await summarize(await explicit(A, 'site', { creationDate: new Date('2026-10-17T00:00:00Z') }));
const e2 = await summarize(await explicit(B, 'site', { creationDate: new Date('2026-10-17T00:00:00Z') }));
console.log('A:', e1.infoHash, e1.n, 'files:', e1.files.join(', '));
console.log('same infohash A vs B?', e1.infoHash === e2.infoHash, '| .well-known included?', e1.files.some(f => f.startsWith('.well-known')));

console.log('\n--- (3) .torrent BYTES: creationDate pinned vs not ---');
const bytesA1 = await explicit(A, 'site', { creationDate: new Date('2026-10-17T00:00:00Z') });
const bytesA2 = await explicit(A, 'site', { creationDate: new Date('2026-10-17T00:00:00Z') });
console.log('pinned creationDate: identical bytes?', Buffer.compare(bytesA1, bytesA2) === 0);
const u1 = await explicit(A, 'site'); await new Promise(r => setTimeout(r, 1100)); const u2 = await explicit(A, 'site');
console.log('unpinned creationDate: identical bytes?', Buffer.compare(u1, u2) === 0, '| same infohash?', (await summarize(u1)).infoHash === (await summarize(u2)).infoHash);
const z = await explicit(A, 'site', { creationDate: new Date(0) });
const zp = (await import(pathToFileURL(`${PROJ}/bencode/index.js`).href)).default.decode(z);
console.log('creationDate=new Date(0) gotcha -> "creation date" written =', zp['creation date'], '(0 is falsy -> Date.now() used)');

console.log('\n--- (4) default piece length chosen by create-torrent for small sites ---');
const pl = b => Math.max(16384, 1 << Math.log2(b < 1024 ? 1 : b / 1024) + 0.5 | 0);
for (const mb of [0.5, 1, 5, 10, 32, 100, 500]) console.log(`${String(mb).padStart(5)} MiB site -> default piece ${pl(mb * 1048576) / 1024} KiB -> ${Math.ceil(mb * 1048576 / pl(mb * 1048576))} pieces (vs ${Math.ceil(mb * 1048576 / 262144)} at 256 KiB)`);

console.log('\n--- (5) default announce list added when announce is not set ---');
const dflt = await mk(await Promise.all(walk(A).filter(r => !r.endsWith('.DS_Store')).sort(cmp).map(async r => { const b = await fs.openAsBlob(path.join(A, r)); b.fullPath = `site/${r}`; return b; })), { name: 'site', pieceLength: 262144 });
const pd = await parseTorrent(dflt);
console.log('trackers baked in by default:', pd.announce.length, pd.announce.join(' '));

fs.rmSync(root, { recursive: true, force: true });
