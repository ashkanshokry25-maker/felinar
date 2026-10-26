// Memory footprint of the loader's download path for a site of N MiB (desktop Chromium 156 as a proxy; ratios matter, absolutes do not transfer to phones).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../../node_modules/playwright/index.mjs';
import { Server as TrackerServer } from '../../../../node_modules/bittorrent-tracker/index.js';
const here = path.dirname(fileURLToPath(import.meta.url));
const WTJS = path.resolve(here, '../../../../node_modules/webtorrent/dist/webtorrent.min.js');
const sizes = (process.argv[2] || '24,48,128').split(',').map(Number);
const stores = (process.argv[3] || 'mem').split(',');
const srv = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/webtorrent.min.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(fs.readFileSync(WTJS)); }
  if (/^\/wt-(seed|dl)\.html$/.test(u)) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(fs.readFileSync(path.join(here, 'www', u.slice(1)))); }
  res.writeHead(404); res.end('nf');
}).listen(0, '127.0.0.1');
await new Promise(r => srv.once('listening', r));
const port = srv.address().port;
const tracker = new TrackerServer({ udp: false, http: false, ws: true, stats: false });
await new Promise((res, rej) => { tracker.on('error', rej); tracker.listen(0, '127.0.0.1', res); });
const TR = 'ws://127.0.0.1:' + tracker.ws.address().port;
const browser = await chromium.launch({ headless: true, args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--js-flags=--expose-gc'] });
const rssMB = (pids) => { if (!pids.length) return 0; const out = execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')]).toString().trim().split('\n').map(s => parseInt(s, 10) || 0); return out.reduce((a, b) => a + b, 0) / 1024; };
async function procs(ctx) {
  const b = await browser.newBrowserCDPSession();
  const info = await b.send('SystemInfo.getProcessInfo');
  await b.detach();
  return info.processInfo.map(p => ({ pid: p.id, type: p.type }));
}
const results = [];
for (const store of stores) for (const MB of sizes) {
  const ctxA = await browser.newContext(); const pageA = await ctxA.newPage();
  await pageA.goto('http://127.0.0.1:' + port + '/wt-seed.html?mb=' + MB + '&tr=' + encodeURIComponent(TR));
  await pageA.waitForFunction(() => window.__result, null, { timeout: 120000 });
  const ra = await pageA.evaluate(() => window.__result);
  if (!ra.magnet) { console.log('seeder failed', JSON.stringify(ra)); continue; }
  const before = new Set((await procs()).filter(p => p.type === 'renderer').map(p => p.pid));
  const ctxB = await browser.newContext(); const pageB = await ctxB.newPage();
  const after = (await procs()).filter(p => p.type === 'renderer').map(p => p.pid);
  const bPids = after.filter(p => !before.has(p));
  const marks = [];
  await pageB.exposeFunction('__mark', async (label) => {
    const all = (await procs()).map(p => p.pid);
    const bRss = rssMB(bPids.filter(p => all.includes(p)));
    const total = rssMB(all);
    const m = { label, downloaderRendererMB: Math.round(bRss), totalChromiumMB: Math.round(total) };
    marks.push(m); return m;
  });
  await pageB.goto('http://127.0.0.1:' + port + '/wt-dl.html?magnet=' + encodeURIComponent(ra.magnet) + '&tr=' + encodeURIComponent(TR) + '&store=' + store);
  await pageB.waitForFunction(() => window.__result, null, { timeout: 180000 });
  const rb = await pageB.evaluate(() => window.__result);
  results.push({ store, MB, pieceLength: ra.pieceLength, downloadMs: rb.downloadMs, length: rb.length, blobSize: rb.blobSize, errors: rb.errors, thrown: rb.thrown, marks });
  console.log('\n== store=' + store + ' site=' + MB + ' MiB  pieceLength=' + ra.pieceLength + '  downloadMs=' + rb.downloadMs + '  errors=' + JSON.stringify(rb.errors) + (rb.thrown ? ' THROWN ' + rb.thrown : ''));
  for (const m of marks) console.log('   ' + m.label.padEnd(52) + ' downloader-renderer RSS ' + String(m.downloaderRendererMB).padStart(5) + ' MB   total Chromium RSS ' + String(m.totalChromiumMB).padStart(5) + ' MB');
  await ctxB.close(); await ctxA.close();
}
fs.writeFileSync(path.join(here, 'mem-results.json'), JSON.stringify(results, null, 1));
tracker.close(); await browser.close(); srv.close();
