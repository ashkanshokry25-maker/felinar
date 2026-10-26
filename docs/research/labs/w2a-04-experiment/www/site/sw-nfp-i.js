const BOOT = Date.now(); const BOOTP = performance.now()
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil((async () => { await self.registration.navigationPreload.enable(); await self.clients.claim() })()))
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return
  const tFetch = Date.now()
  e.respondWith((async () => { const pr = await e.preloadResponse; const r = pr || await fetch(e.request); const h = new Headers(r.headers); h.set('x-sw-boot', String(BOOT)); h.set('x-sw-t', String(tFetch)); h.set('x-sw-preload', pr ? '1' : '0'); return new Response(r.body, { status: r.status, headers: h }) })())
})
