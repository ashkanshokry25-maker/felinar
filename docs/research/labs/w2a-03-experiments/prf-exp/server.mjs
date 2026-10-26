import http from 'node:http';
import fs from 'node:fs';
const here = new URL('.', import.meta.url).pathname;
const siteHtml = fs.readFileSync(here + 'site.html');
const shell = (mode) => `<!doctype html><meta charset="utf-8"><title>shell</title><body><div id="s">boot</div><script>
(async () => {
  await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) { await new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r)); }
  const f = document.createElement('iframe');
  f.id = 'site';
  const mode = ${JSON.stringify(mode)};
  if (mode === 'same') f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-top-navigation-by-user-activation');
  if (mode === 'opaque') f.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups');
  f.src = '/_mw/s/abc/index.html';
  f.style = 'width:90vw;height:70vh';
  document.body.appendChild(f);
  document.getElementById('s').textContent = 'iframe mounted mode=' + mode;
})();
</script>`;
const sw = `self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.pathname === '/_mw/s/abc/index.html') {
    e.respondWith(fetch('/__site.html').then(r => r.text()).then(t => new Response(t, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })));
  }
});`;
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/sw.js') { res.writeHead(200, { 'content-type': 'text/javascript', 'service-worker-allowed': '/' }); return res.end(sw); }
  if (u.pathname === '/__site.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(siteHtml); }
  if (u.pathname === '/' || u.pathname === '/index.html') { const mode = u.searchParams.get('mode') || 'same'; res.writeHead(200, { 'content-type': 'text/html' }); return res.end(shell(mode)); }
  if (u.pathname === '/top') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(siteHtml); }
  res.writeHead(404); res.end('nf');
});
srv.listen(0, '127.0.0.1', () => { console.log('PORT ' + srv.address().port); });
