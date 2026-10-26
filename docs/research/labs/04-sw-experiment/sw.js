// Experiment service worker (own code). Logs what it sees; distinguishes document vs iframe destination.
const BOOT = Date.now();
const seen = [];
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const html = (body) => new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const siteDoc = (from, dest, extra = '') => `<!doctype html><meta charset=utf-8><title>site</title><p>from=${from} dest=${dest}</p>
<script>
(async () => {
  const out = { type: 'frame-report', from: '${from}', swDest: '${dest}', path: location.pathname + location.search };
  try { out.ctrl = !!navigator.serviceWorker.controller; } catch (e) { out.ctrl = 'ERR:' + e.name; }
  try { out.origin = location.origin; } catch (e) {}
  try { const r = await fetch('/__who'); out.who = await r.text(); } catch (e) { out.who = 'ERR:' + e.name + ':' + e.message; }
  parent.postMessage(out, '*');
})();
</script>${extra}`;

const shellDoc = (path) => `<!doctype html><meta charset=utf-8><title>shell</title><p>SHELL (dest=document)</p>
<iframe id=f src="${path}" style="width:90%;height:100px"></iframe>
<script>
addEventListener('message', async (ev) => {
  if (ev.data && ev.data.type === 'frame-report') {
    await fetch('/report', { method: 'POST', body: JSON.stringify({ name: 'D-shell-dispatch', data: { shell: 'document-served-by-sw', iframeReport: ev.data } }) });
    await fetch('/report', { method: 'POST', body: JSON.stringify({ name: 'ready-for-reload-tests', data: {} }) });
  }
});
</script>`;

async function pageStream(event) {
  const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  const port = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no host page answered')), 5000);
    for (const c of wins) {
      const mc = new MessageChannel();
      mc.port1.onmessage = () => { clearTimeout(t); resolve(mc.port1); };
      c.postMessage({ type: 'stream-open', url: event.request.url }, [mc.port2]);
    }
  });
  return new Response(new ReadableStream({
    pull(controller) {
      return new Promise((resolve) => {
        port.onmessage = ({ data }) => { if (data) controller.enqueue(data); else controller.close(); resolve(); };
        port.postMessage('pull');
      });
    },
    cancel() {}
  }), { headers: { 'Content-Type': 'application/octet-stream', 'x-boot': String(BOOT) } });
}

self.addEventListener('fetch', (event) => {
  const r = event.request;
  const u = new URL(r.url);
  if (u.origin !== location.origin) return;
  if (u.pathname === '/report' || u.pathname === '/sw.js' || u.pathname === '/') return; // network
  seen.push({ p: u.pathname + u.search, mode: r.mode, dest: r.destination, t: Date.now() });
  if (u.pathname === '/__uptime') {
    return event.respondWith(new Response(JSON.stringify({ boot: BOOT, now: Date.now(), seen: seen.splice(0) }), { headers: { 'Content-Type': 'application/json' } }));
  }
  if (u.pathname === '/__who') {
    return event.respondWith(new Response('sw', { headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' } }));
  }
  if (u.pathname.startsWith('/site/')) return event.respondWith(html(siteDoc('sw', r.destination)));
  if (u.pathname.startsWith('/app/')) {
    if (r.destination === 'document') return event.respondWith(html(shellDoc(u.pathname + u.search)));
    return event.respondWith(html(siteDoc('sw', r.destination)));
  }
  if (u.pathname === '/__pagestream') return event.respondWith(pageStream(event));
});
