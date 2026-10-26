// E6: what does webtorrent 3.0.21 do when a web seed serves bytes that fail the piece hash (e.g. a release prefix overwritten in place)?
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const MODS = '$HOME/Documents/Projects/magnet-web/node_modules';
const { default: createTorrent } = await import(pathToFileURL(`${MODS}/create-torrent/index.js`).href);
const { default: WebTorrent } = await import(pathToFileURL(`${MODS}/webtorrent/index.js`).href);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mwe6-')); const tree = path.join(root, 'r', 'rel1', 'site');
fs.mkdirSync(tree, { recursive: true });
const big = Buffer.alloc(200000); for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 255;
fs.writeFileSync(path.join(tree, 'a.bin'), big); fs.writeFileSync(path.join(tree, 'b.txt'), 'hello\n'.repeat(5000));
const blobs = []; for (const r of ['a.bin', 'b.txt']) { const b = await fs.openAsBlob(path.join(tree, r)); b.fullPath = `site/${r}`; blobs.push(b); }
const tbuf = await new Promise((res, rej) => createTorrent(blobs, { name: 'site', pieceLength: 16384, announce: [], creationDate: new Date('2026-10-17T00:00:00Z') }, (e, b) => e ? rej(e) : res(b)));
fs.writeFileSync(path.join(root, 'r', 'rel1', 'site.torrent'), tbuf);

let corrupt = true; const reqs = [];
const srv = http.createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const p = path.join(root, decodeURIComponent(req.url)); if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  let body = fs.readFileSync(p); const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
  if (m) {
    const a = +m[1], b = Math.min(+m[2], body.length - 1); let part = Buffer.from(body.subarray(a, b + 1));
    if (corrupt && req.url.endsWith('a.bin') && a < 16384) { part[0] ^= 0xff; reqs.push({ t: Date.now(), range: `${a}-${b}`, bad: true }); }   // in-place overwrite / transformed bytes
    res.writeHead(206, { ...cors, 'content-range': `bytes ${a}-${b}/${body.length}`, 'content-length': part.length }); return res.end(part);
  }
  res.writeHead(200, { ...cors, 'content-length': body.length }); res.end(body);
});
await new Promise(r => srv.listen(0, '127.0.0.1', r)); const port = srv.address().port;
const base = `http://127.0.0.1:${port}/r/rel1/`;
const client = new WebTorrent({ dht: false, lsd: false, utp: false, natUpnp: false, natPmp: false, tracker: false, webSeeds: true });
let warnings = 0; const t0 = Date.now();
const { default: parseTorrent } = await import(pathToFileURL(`${MODS}/parse-torrent/index.js`).href);
const parsed = await parseTorrent(tbuf);
const magnet = `magnet:?xt=urn:btih:${parsed.infoHash}&xs=${encodeURIComponent(base + 'site.torrent')}&ws=${encodeURIComponent(base)}`;
const torrent = client.add(magnet, { path: path.join(root, 'dl') });
torrent.on('warning', e => { if (/failed verification/.test(String(e.message))) warnings++; });
let doneAt = null; torrent.on('done', () => { doneAt = Date.now() - t0; });
await new Promise(r => setTimeout(r, 4000));
console.log(`phase 1 (web seed serves a corrupted first piece for 4 s): corrupted Range requests=${reqs.length}, 'failed verification' warnings=${warnings}, done=${torrent.done}, progress=${(torrent.progress * 100).toFixed(1)}%, webSeed wires still attached=${torrent.wires.filter(w => w.type === 'webSeed').length}`);
const mid = reqs.length; corrupt = false;
await new Promise(r => setTimeout(r, 4000));
console.log(`phase 2 (seed fixed): done=${torrent.done} after ${doneAt ?? 'n/a'} ms, total corrupted requests=${reqs.length} (phase-1 rate ~${(mid / 4).toFixed(1)}/s)`);
client.destroy(); srv.close(); fs.rmSync(root, { recursive: true, force: true }); setTimeout(() => process.exit(0), 200);
