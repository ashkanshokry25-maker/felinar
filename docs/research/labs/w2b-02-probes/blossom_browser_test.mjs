// Real browsers -> live public Blossom servers, exactly WebTorrent 3.0.21 webconn.js fetch options. READ-ONLY (GET with Range 0-9).
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
const require = createRequire(new URL('../../../../package.json', import.meta.url));
const { chromium, webkit } = require('playwright');
const pairs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const page = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>lab</title>'); });
await new Promise(r => page.listen(0, '127.0.0.1', r)); const pp = page.address().port;
const out = [];
for (const [name, type] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await type.launch({ headless: true }); const p = await (await browser.newContext()).newPage(); await p.goto(`http://127.0.0.1:${pp}/`);
  for (const [host, blobs] of Object.entries(pairs)) {
    let done = false;
    for (const b of blobs) {
      const r = await p.evaluate(async ({ url }) => {
        const t0 = performance.now();
        try { const res = await fetch(url, { cache: 'no-store', method: 'GET', headers: { 'Cache-Control': 'no-store', 'user-agent': 'WebTorrent/3.0.21 (https://webtorrent.io)', range: 'bytes=0-9' }, signal: AbortSignal.timeout(10000) });
          const buf = new Uint8Array(await res.arrayBuffer()); return { ok: res.ok, status: res.status, len: buf.length, url: res.url.replace(/[0-9a-f]{64}/, '<sha>'), redirected: res.redirected, ms: Math.round(performance.now() - t0) };
        } catch (e) { return { err: String(e).slice(0, 50), ms: Math.round(performance.now() - t0) }; }
      }, { url: `https://${host}/${b}` });
      if (r.err || (r.ok && r.status !== 404) || b === blobs[blobs.length - 1]) { out.push({ engine: name + ' ' + browser.version(), host, sha: b.slice(0, 8), ...r }); done = true; break; }
      if (r.status === 404) continue;
      out.push({ engine: name, host, sha: b.slice(0, 8), ...r }); done = true; break;
    }
  }
  await browser.close();
}
for (const o of out) console.log(JSON.stringify(o));
page.close();
