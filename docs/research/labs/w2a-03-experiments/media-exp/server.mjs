import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2];
const swlog = [];
const swSrc = (mode) => `self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  const m = /^\\/_mw\\/s\\/abc\\/(.*)$/.exec(u.pathname);
  if (!m) return;
  const p = decodeURIComponent(m[1]);
  const range = e.request.headers.get('range');
  fetch('/__swlog?p=' + encodeURIComponent(p) + '&range=' + encodeURIComponent(range || '-') + '&dest=' + e.request.destination).catch(() => {});
  e.respondWith((async () => {
    const r = await fetch('/__files/' + encodeURIComponent(p));
    if (!r.ok) return new Response('nf', { status: 404 });
    const buf = new Uint8Array(await r.arrayBuffer());
    const ct = p.endsWith('.mp4') ? 'video/mp4' : p.endsWith('.webm') ? 'video/webm' : p.endsWith('.html') ? 'text/html' : 'application/octet-stream';
    if (${JSON.stringify(mode)} === 'range' && range) {
      const mm = /^bytes=(\\d*)-(\\d*)$/.exec(range);
      if (mm) {
        let start = mm[1] === '' ? Math.max(0, buf.length - parseInt(mm[2], 10)) : parseInt(mm[1], 10);
        let end = mm[1] === '' ? buf.length - 1 : (mm[2] === '' ? buf.length - 1 : Math.min(parseInt(mm[2], 10), buf.length - 1));
        if (start >= buf.length) return new Response(null, { status: 416, headers: { 'content-range': 'bytes */' + buf.length } });
        const slice = buf.slice(start, end + 1);
        return new Response(slice, { status: 206, headers: { 'content-type': ct, 'content-range': 'bytes ' + start + '-' + end + '/' + buf.length, 'content-length': String(slice.length), 'accept-ranges': 'bytes' } });
      }
    }
    return new Response(buf, { status: 200, headers: Object.assign({ 'content-type': ct, 'content-length': String(buf.length) }, ${JSON.stringify(mode)} === 'range' ? { 'accept-ranges': 'bytes' } : {}) });
  })());
});`;
const shell = (file) => `<!doctype html><meta charset="utf-8"><title>shell</title><body><script>
(async () => {
  await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r));
  const f = document.createElement('iframe'); f.id = 'site';
  f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads allow-top-navigation-by-user-activation');
  f.src = '/_mw/s/abc/__harness.html?file=' + ${JSON.stringify(file)}; document.body.appendChild(f);
})();
</script>`;
const harness = `<!doctype html><meta charset="utf-8"><title>h</title><body><video id="v" muted playsinline preload="auto" style="width:320px"></video><script>
const q = new URLSearchParams(location.search); const file = q.get('file');
const v = document.getElementById('v'); const r = { file, events: [] };
const t0 = performance.now(); const ev = (n) => r.events.push(n + '@' + Math.round(performance.now() - t0));
['loadedmetadata','canplay','seeked','error','stalled','abort','emptied'].forEach(n => v.addEventListener(n, () => ev(n)));
v.src = '/_mw/s/abc/' + file;
const done = () => { r.duration = v.duration; r.readyState = v.readyState; r.networkState = v.networkState; r.error = v.error ? (v.error.code + ':' + (v.error.message || '')) : null; r.currentTime = v.currentTime; r.seekable = v.seekable.length ? [v.seekable.start(0), v.seekable.end(0)] : null; window.__result = r; };
v.addEventListener('loadedmetadata', () => { try { v.currentTime = 4; } catch (e) { r.seekErr = String(e); } setTimeout(done, 2500); });
v.addEventListener('error', () => setTimeout(done, 200));
setTimeout(() => { if (!window.__result) done(); }, 9000);
</script>`;
const mode = process.argv[3];
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/sw.js') { res.writeHead(200, { 'content-type': 'text/javascript', 'service-worker-allowed': '/' }); return res.end(swSrc(mode)); }
  if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(shell(u.searchParams.get('file'))); }
  if (u.pathname === '/__swlog') { swlog.push([u.searchParams.get('p'), u.searchParams.get('range'), u.searchParams.get('dest')]); res.writeHead(204); return res.end(); }
  if (u.pathname === '/__getlog') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(swlog)); }
  if (u.pathname === '/__files/__harness.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(harness); }
  if (u.pathname.startsWith('/__files/')) {
    const fp = path.join(root, decodeURIComponent(u.pathname.slice(9)));
    if (!fs.existsSync(fp)) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(fs.readFileSync(fp));
  }
  res.writeHead(404); res.end('nf');
});
srv.listen(0, '127.0.0.1', () => console.log('PORT ' + srv.address().port));
