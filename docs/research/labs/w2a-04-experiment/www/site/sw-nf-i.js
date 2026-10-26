const BOOT = Date.now(); const BOOTP = performance.now()
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return
  const tFetch = Date.now()
  e.respondWith((async () => { const r = await fetch(e.request); const h = new Headers(r.headers); h.set('x-sw-boot', String(BOOT)); h.set('x-sw-t', String(tFetch)); h.set('x-sw-uptime', String(Math.round(performance.now() - BOOTP))); return new Response(r.body, { status: r.status, headers: h }) })())
})
