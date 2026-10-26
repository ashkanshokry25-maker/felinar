// Web-seed fault injection against the installed webtorrent@3.0.21 (Node build, no peers/trackers): how does it react to hosts that ignore Range, 403, corrupt bytes?
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import WebTorrent from '../../../../node_modules/webtorrent/index.js';
import createTorrent from '../../../../node_modules/create-torrent/index.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsc-'));
const FILE = path.join(dir, 'blob.bin'); const SIZE = 3 * 1024 * 1024; // 3 MiB = 12 pieces of 256 KiB
const data = crypto.randomBytes(SIZE); fs.writeFileSync(FILE, data);
const torrentBuf = await new Promise((res, rej) => createTorrent(FILE, { pieceLength: 262144, name: 'blob.bin' }, (e, t) => (e ? rej(e) : res(t))));

async function scenario(mode) {
  const stats = { requests: 0, bytes: 0, statuses: {} };
  const server = http.createServer((req, res) => {
    stats.requests++;
    const range = req.headers.range;
    const send = (status, buf, hdr = {}) => { stats.statuses[status] = (stats.statuses[status] || 0) + 1; stats.bytes += buf.length; res.writeHead(status, { 'content-type': 'application/octet-stream', 'content-length': buf.length, ...hdr }); res.end(buf); };
    if (mode === 'honors-range') { const m = /bytes=(\d+)-(\d+)/.exec(range || ''); if (m) { const s = +m[1], e = Math.min(+m[2], SIZE - 1); return send(206, data.subarray(s, e + 1), { 'content-range': `bytes ${s}-${e}/${SIZE}`, 'accept-ranges': 'bytes' }); } return send(200, data); }
    if (mode === 'ignores-range') return send(200, data); // some hosts/proxies/CDN configs do this
    if (mode === 'forbidden-403') return send(403, Buffer.from('nope'));
    if (mode === 'corrupt-bytes') { const m = /bytes=(\d+)-(\d+)/.exec(range || ''); const s = +m[1], e = Math.min(+m[2], SIZE - 1); const b = Buffer.from(data.subarray(s, e + 1)); b[0] ^= 0xff; return send(206, b, { 'content-range': `bytes ${s}-${e}/${SIZE}` }); }
    if (mode === 'short-body-206') { const m = /bytes=(\d+)-(\d+)/.exec(range || ''); const s = +m[1], e = Math.min(+m[2], SIZE - 1); const b = data.subarray(s, Math.max(s + 1, Math.floor((s + e) / 2))); return send(206, b, { 'content-range': `bytes ${s}-${e}/${SIZE}` }); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = new WebTorrent({ dht: false, lsd: false, tracker: false, utp: false, natUpnp: false, natPmp: false, webSeeds: true });
  const t0 = Date.now(); let warnings = []; let done = false;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsc-out-'));
  await new Promise((resolve) => {
    const torrent = client.add(torrentBuf, { path: outDir, store: undefined });
    torrent.on('warning', (w) => warnings.push(String(w.message || w).slice(0, 80)));
    torrent.on('error', (e) => warnings.push('ERR ' + String(e.message || e).slice(0, 80)));
    torrent.on('ready', () => torrent.addWebSeed(`http://127.0.0.1:${server.address().port}/blob.bin`));
    torrent.on('done', () => { done = true; resolve(); });
    setTimeout(resolve, 15000);
  });
  const t = client.torrents[0];
  console.log(JSON.stringify({ mode, done, elapsedMs: Date.now() - t0, progress: t ? +t.progress.toFixed(3) : null, requests: stats.requests, MiBServed: +(stats.bytes / 1048576).toFixed(1), statuses: stats.statuses, uniqueWarnings: [...new Set(warnings)].slice(0, 3), warningCount: warnings.length }));
  client.destroy(); server.close();
}
for (const m of ['honors-range', 'ignores-range', 'forbidden-403', 'corrupt-bytes', 'short-body-206']) await scenario(m);
process.exit(0);
