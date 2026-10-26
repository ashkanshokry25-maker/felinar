// E1: same-origin sandbox iframe vs opaque-origin sandbox iframe vs unsandboxed iframe, against a visitor's non-extractable key in IndexedDB,
// plus Service Worker control of each frame. Usage: node e1.mjs chromium|webkit
import * as pw from '$HOME/Documents/Projects/magnet-web/node_modules/playwright/index.mjs';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const engine = process.argv[2];
const root = path.join(process.cwd(), 'pages');
const types = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8' };
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/who') { res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }).end('network'); return; }
  const p = path.join(root, decodeURIComponent(u.pathname));
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404).end('nf'); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' }); fs.createReadStream(p).pipe(res);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const origin = `http://localhost:${srv.address().port}`;
const browser = await pw[engine].launch({ headless: true });
const ctx = await browser.newContext(); const page = await ctx.newPage();
await page.goto(origin + '/index.html');
const out = { engine, version: browser.version(), origin };
// loader: create identity + register SW
out.setup = await page.evaluate(async () => {
  const r = {};
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const db = await new Promise((res, rej) => { const q = indexedDB.open('mw-exp', 1); q.onupgradeneeded = () => q.result.createObjectStore('identity'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  await new Promise((res, rej) => { const tx = db.transaction('identity', 'readwrite'); tx.objectStore('identity').put({ privateKey: pair.privateKey, publicKey: pair.publicKey }, 'me'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  r.stored = true; r.privExtractable = pair.privateKey.extractable;
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  r.swActive = !!reg.active;
  return r;
});
await page.reload(); // so the loader itself is SW-controlled
out.loaderControlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
out.frames = await page.evaluate(async () => {
  const run = (tag, sandbox) => new Promise((resolve) => {
    const f = document.createElement('iframe'); if (sandbox !== null) f.setAttribute('sandbox', sandbox);
    f.src = '/site.html?tag=' + tag;
    const t = setTimeout(() => resolve({ timeout: true }), 8000);
    const h = (e) => { if (e.data && e.data.lab === 'site-result' && e.data.tag === tag) { clearTimeout(t); window.removeEventListener('message', h); resolve(e.data.out); } };
    window.addEventListener('message', h); document.body.appendChild(f);
  });
  return {
    'sandbox=allow-scripts allow-same-origin': await run('same', 'allow-scripts allow-same-origin'),
    'sandbox=allow-scripts': await run('opaque', 'allow-scripts'),
    'no sandbox': await run('plain', null),
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close(); srv.close();
