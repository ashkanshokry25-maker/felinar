// E4: what request headers does a real browser send for fetch() with a Range header (same-origin and cross-origin)?
// Starts a tiny server that logs request headers and answers like a generic static host; drives Playwright browsers.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
const PW = '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs';
const pw = await import(pathToFileURL(PW).href);

const log = [];
function mk(port, name) {
  const body = Buffer.alloc(1000, 0x61);
  const s = http.createServer((req, res) => {
    log.push({ server: name, method: req.method, url: req.url, origin: req.headers.origin || null, range: req.headers.range || null,
      acceptEncoding: req.headers['accept-encoding'] || '(none)', cacheControl: req.headers['cache-control'] || null,
      acrh: req.headers['access-control-request-headers'] || null, ua: (req.headers['user-agent'] || '').slice(0, 30) });
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, HEAD, OPTIONS' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.url === '/' ) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<!doctype html><title>t</title>'); }
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    if (m) { const a = +m[1], b = +m[2]; res.writeHead(206, { ...cors, 'content-range': `bytes ${a}-${b}/${body.length}`, 'content-length': b - a + 1, 'accept-ranges': 'bytes' }); return res.end(body.subarray(a, b + 1)); }
    res.writeHead(200, { ...cors, 'content-length': body.length, 'accept-ranges': 'bytes' }); res.end(body);
  });
  return new Promise(r => s.listen(port, '127.0.0.1', () => r(s)));
}
const A = await mk(18081, 'A-same-origin'), B = await mk(18082, 'B-cross-origin');

for (const type of ['chromium', 'firefox', 'webkit']) {
  let browser;
  try { browser = await pw[type].launch(); } catch (e) { console.log(`[${type}] not available: ${String(e.message).split('\n')[0]}`); continue; }
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:18081/');
  log.length = 0;
  const out = await page.evaluate(async () => {
    const r = {};
    try { const x = await fetch('/f.bin', { cache: 'no-store', headers: { 'Cache-Control': 'no-store', range: 'bytes=0-99' } }); r.same = x.status; await x.arrayBuffer(); } catch (e) { r.same = 'ERR ' + e.message; }
    try { const x = await fetch('http://127.0.0.1:18082/f.bin', { cache: 'no-store', headers: { 'Cache-Control': 'no-store', range: 'bytes=0-99' } }); r.cross = x.status; await x.arrayBuffer(); } catch (e) { r.cross = 'ERR ' + e.message; }
    try { const x = await fetch('/f2.bin'); r.plain = x.status; await x.arrayBuffer(); } catch (e) { r.plain = 'ERR ' + e.message; }
    return r;
  });
  console.log(`\n[${type} ${browser.version()}] fetch results:`, JSON.stringify(out));
  for (const l of log) console.log(`  ${l.server.padEnd(14)} ${l.method.padEnd(7)} ${l.url.padEnd(8)} range=${l.range} accept-encoding=${l.acceptEncoding} cache-control=${l.cacheControl} ACRH=${l.acrh}`);
  await browser.close();
}
A.close(); B.close();
