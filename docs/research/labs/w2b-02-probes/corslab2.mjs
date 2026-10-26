// CORS lab: what do real browsers send in the preflight for WebTorrent 3.0.21's web-seed fetch, and which allow-header policies pass?
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../../package.json', import.meta.url));
const { chromium, firefox, webkit } = require('playwright');
const BODY = Buffer.alloc(100, 97);
const variants = {
  star:        { acah: 'Authorization, *' },                                            // BUD-01 minimum (primal, ditto, 24242.io, nostr.media)
  band_like:   { acah: 'Authorization,Accept,Range,Cache-Control,If-Modified-Since,Content-Disposition,Content-Encoding,Content-Language,Content-Type,Content-Length,Expires,x-nb-no-redirect,x-nb-bypass-cache,x-content-type,x-content-length,x-sha-256,Referer' },
  jumble_like: { acah: 'Authorization,Content-Type,X-SHA-256,X-Content-Length,X-Content-Type' },
  star_plus_ct:{ acah: 'Authorization,Content-Type,*' },                                 // hzrd149 / yakihonne / f7z
  echo:        { acah: null },                                                          // reflect Access-Control-Request-Headers (satellite)
};
const log = [];
const blob = http.createServer((req, res) => {
  const v = req.url.split('/')[1]; const cfg = variants[v];
  const h = { 'Access-Control-Allow-Origin': '*' };
  if (req.method === 'OPTIONS') {
    log.push({ variant: v, ua: req.headers['user-agent']?.slice(0, 30), acrm: req.headers['access-control-request-method'], acrh: req.headers['access-control-request-headers'] });
    h['Access-Control-Allow-Headers'] = cfg.acah ?? req.headers['access-control-request-headers'] ?? '';
    h['Access-Control-Allow-Methods'] = 'GET, HEAD, PUT, DELETE';
    res.writeHead(204, h); return res.end();
  }
  const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
  if (m) { const s = +m[1], e = Math.min(+m[2], 99); h['Content-Range'] = `bytes ${s}-${e}/100`; h['Accept-Ranges'] = 'bytes'; res.writeHead(206, h); return res.end(BODY.subarray(s, e + 1)); }
  res.writeHead(200, h); res.end(BODY);
});
const page = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>lab</title>'); });
await new Promise(r => blob.listen(0, '127.0.0.1', r)); await new Promise(r => page.listen(0, '127.0.0.1', r));
const bp = blob.address().port, pp = page.address().port;
const results = [];
for (const [name, type] of [['chromium', chromium], ['webkit', webkit]]) {
  let browser;
  try { browser = await type.launch({ headless: true }); } catch (e) { results.push({ engine: name, error: String(e).slice(0, 120) }); continue; }
  const ctx = await browser.newContext(); const p = await ctx.newPage();
  await p.goto(`http://127.0.0.1:${pp}/`);
  const ver = browser.version();
  for (const v of Object.keys(variants)) {
    for (const mode of ['ua only (xs fetch)', 'webtorrent3 (cache-control+user-agent+range)', 'range only']) {
      const r = await p.evaluate(async ({ url, mode }) => {
        const headers = mode.startsWith('ua only') ? { 'user-agent': 'WebTorrent/3.0.21 (https://webtorrent.io)' } : mode.startsWith('webtorrent3') ? { 'Cache-Control': 'no-store', 'user-agent': 'WebTorrent/3.0.21 (https://webtorrent.io)', range: 'bytes=0-9' }
          : mode === 'range only' ? { range: 'bytes=0-9' } : { 'Cache-Control': 'no-store', range: 'bytes=0-9' };
        try { const res = await fetch(url, { cache: 'no-store', method: 'GET', headers, signal: AbortSignal.timeout(5000) }); const b = new Uint8Array(await res.arrayBuffer()); return { ok: res.ok, status: res.status, len: b.length }; }
        catch (e) { return { err: String(e).slice(0, 60) }; }
      }, { url: `http://127.0.0.1:${bp}/${v}/blob`, mode });
      results.push({ engine: `${name} ${ver}`, variant: v, mode, result: r.err ? 'FAIL ' + r.err : `ok status=${r.status} bytes=${r.len}` });
    }
  }
  await browser.close();
}
const seenAcrh = {}; for (const l of log) { const k = l.variant; (seenAcrh[k] ??= new Set()).add(l.acrh); }
console.log('--- Access-Control-Request-Headers seen per variant (all engines):');
for (const [k, s] of Object.entries(seenAcrh)) console.log(k.padEnd(13), [...s].join(' | '));
console.log('--- results:');
for (const r of results) console.log(JSON.stringify(r));
blob.close(); page.close();
