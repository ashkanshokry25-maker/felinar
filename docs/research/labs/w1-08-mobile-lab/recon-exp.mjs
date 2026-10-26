// Measures how long the vendored WebTorrent/bittorrent-tracker takes to re-announce after the tracker WebSocket is dropped.
// usage: node recon-exp.mjs [N=8] [fast]
//   fast = pin Math.random() to 0 in the pages (variance term 0 => exactly 10 s) and wait only 60 s: a smoke test of this harness.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../../node_modules/playwright/index.mjs';
import { Server as TrackerServer } from '../../../../node_modules/bittorrent-tracker/index.js';
const here = path.dirname(fileURLToPath(import.meta.url));
const WTJS = path.resolve(here, '../../../../node_modules/webtorrent/dist/webtorrent.min.js');
const N = +(process.argv[2] || 8);
const FAST = process.argv[3] === 'fast';
const srv = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/webtorrent.min.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(fs.readFileSync(WTJS)); }
  if (u === '/wt-recon.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(fs.readFileSync(path.join(here, 'www/wt-recon.html'))); }
  res.writeHead(404); res.end('nf');
}).listen(0, '127.0.0.1');
await new Promise(r => srv.once('listening', r));
const port = srv.address().port;
const tracker = new TrackerServer({ udp: false, http: false, ws: true, stats: false });
await new Promise((res, rej) => { tracker.on('error', rej); tracker.listen(0, '127.0.0.1', res); });
const TR = 'ws://127.0.0.1:' + tracker.ws.address().port;
// Observe the raw WebSocket traffic: the server emits no event for announces without an `event` field, so parse messages ourselves.
const socks = new Set();
const firstMsgAfter = new Map(); // infohash hex -> ms since t0 of the first announce received on a NEW connection
let t0 = 0;
tracker.ws.on('connection', (sock) => {
  socks.add(sock); sock.on('close', () => socks.delete(sock));
  const isNew = t0 > 0;
  sock.on('message', (data) => {
    if (!isNew) return;
    try {
      const m = JSON.parse(data.toString());
      if (m && m.action === 'announce' && typeof m.info_hash === 'string') {
        const hex = Buffer.from(m.info_hash, 'binary').toString('hex');
        if (!firstMsgAfter.has(hex)) firstMsgAfter.set(hex, Date.now() - t0);
      }
    } catch (_) { /* ignore */ }
  });
});
const browser = await chromium.launch({ headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
const pages = [];
for (let i = 0; i < N; i++) {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  if (FAST) await page.addInitScript('Math.random = () => 0;');
  await page.goto('http://127.0.0.1:' + port + '/wt-recon.html?i=' + i + '&tr=' + encodeURIComponent(TR));
  await page.waitForFunction(() => window.__result, null, { timeout: 60000 });
  const r = await page.evaluate(() => window.__result);
  pages.push({ i, ctx, page, hash: r.infoHash, err: r.thrown });
}
await new Promise(r => setTimeout(r, 3000));
console.log('pages:', N, FAST ? '(fast mode: Math.random pinned to 0)' : '', 'open tracker sockets:', socks.size);
const victims = [...socks];
t0 = Date.now();
for (const c of victims) c.terminate();
console.log('terminated', victims.length, 'server-side sockets at', new Date(t0).toISOString());
const deadline = t0 + (FAST ? 60 : 6 * 60) * 1000;
while (Date.now() < deadline && firstMsgAfter.size < N) await new Promise(r => setTimeout(r, 500));
const delays = pages.map(p => firstMsgAfter.has(p.hash) ? Math.round(firstMsgAfter.get(p.hash) / 100) / 10 : null);
console.log('re-announce delay after socket drop, seconds, per client:', JSON.stringify(delays));
const got = delays.filter(x => x !== null).sort((a, b) => a - b);
console.log('min', got[0], 'median', got[Math.floor(got.length / 2)], 'max', got[got.length - 1], 'n', got.length, '/', N, ' (theory: 10 s + U(0, 300 s) => 10..310 s; fast mode => ~10 s)');
fs.mkdirSync(path.join(here, 'out'), { recursive: true });
fs.writeFileSync(path.join(here, 'out', FAST ? 'recon-results-fast.json' : 'recon-results.json'), JSON.stringify({ N, fast: FAST, delays }, null, 1));
for (const p of pages) await p.ctx.close();
await browser.close(); tracker.close(); srv.close();
