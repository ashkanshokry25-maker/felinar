import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];            // corpus site dir (with pagefind/ inside)
const wasmMime = process.argv[3] === 'wasm';
const log = [];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
const sw = `self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
const MIME = ${JSON.stringify(MIME)};
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  const m = /^\\/_mw\\/s\\/abc\\/(.*)$/.exec(u.pathname);
  if (!m) return;
  let p = decodeURIComponent(m[1]) || 'index.html';
  e.respondWith((async () => {
    const r = await fetch('/__files/' + p.split('/').map(encodeURIComponent).join('/'));
    if (!r.ok) return new Response('not found', { status: 404 });
    const buf = await r.arrayBuffer();
    const ext = (p.match(/\\.[^./]+$/) || [''])[0];
    let ct = MIME[ext] || 'application/octet-stream';
    ${wasmMime ? "if (ext === '.pagefind') ct = 'application/wasm';" : ''}
    return new Response(buf, { headers: { 'content-type': ct, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  })());
});`;
const shell = `<!doctype html><meta charset="utf-8"><title>shell</title><body><script>
(async () => {
  await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r));
  const f = document.createElement('iframe'); f.id = 'site';
  f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-top-navigation-by-user-activation');
  f.src = '/_mw/s/abc/__harness.html'; document.body.appendChild(f);
})();
</script>`;
const harness = `<!doctype html><meta charset="utf-8"><title>harness</title><body><script type="module">
const r = { origin: location.origin, steps: [] };
try {
  const t0 = performance.now();
  const pagefind = await import('./pagefind/pagefind.js');
  r.steps.push(['import', Math.round(performance.now() - t0)]);
  await pagefind.options({ basePath: '/_mw/s/abc/pagefind/' });
  const t1 = performance.now();
  await pagefind.init();
  r.steps.push(['init', Math.round(performance.now() - t1)]);
  for (const q of ['smtpd access restrictions', 'printer', 'zzzznotaword']) {
    const t2 = performance.now();
    const s = await pagefind.search(q);
    const first = s.results.length ? await s.results[0].data() : null;
    r.steps.push([q, { hits: s.results.length, ms: Math.round(performance.now() - t2), firstUrl: first && first.url, firstTitle: first && first.meta && first.meta.title, excerptLen: first && first.excerpt && first.excerpt.length }]);
  }
  r.perf = performance.getEntriesByType('resource').map(e => [e.name.replace(location.origin, ''), e.transferSize, e.decodedBodySize]);
} catch (e) { r.error = e.name + ': ' + e.message; }
window.__result = r;
</script>`;
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/sw.js') { res.writeHead(200, { 'content-type': 'text/javascript', 'service-worker-allowed': '/' }); return res.end(sw); }
  if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(shell); }
  if (u.pathname === '/__log') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(log)); }
  if (u.pathname === '/__clearlog') { log.length = 0; res.writeHead(200); return res.end('ok'); }
  if (u.pathname === '/__files/__harness.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(harness); }
  if (u.pathname.startsWith('/__files/')) {
    const rel = decodeURIComponent(u.pathname.slice('/__files/'.length));
    const fp = path.join(root, rel);
    if (!fp.startsWith(root) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); return res.end('nf'); }
    const b = fs.readFileSync(fp); log.push([rel, b.length]);
    res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(b);
  }
  res.writeHead(404); res.end('nf');
});
srv.listen(0, '127.0.0.1', () => console.log('PORT ' + srv.address().port));
