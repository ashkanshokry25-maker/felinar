/* A hand-written Service Worker of an existing site (no Workbox): cache-first for /css/*, the
   network for everything else, and a tiny stats endpoint so a test can see that it kept working.
   Drop-in mode must leave this worker alone (ARCHITECTURE 3.4.4): /_mw/mw.js sees it with
   getRegistration('/') and does not register /mw-sw.js over it. */
const CACHE = 'own-sw-v1';
const stats = { installs: 0, activations: 0, cssHits: 0, cssMisses: 0, other: 0 };

self.addEventListener('install', () => {
  stats.installs++;
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  stats.activations++;
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/__own-sw/stats') {
    event.respondWith(new Response(JSON.stringify(stats), { headers: { 'Content-Type': 'application/json' } }));
    return;
  }
  if (url.pathname.startsWith('/css/')) {
    event.respondWith(caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(request);
      if (hit) {
        stats.cssHits++;
        return hit;
      }
      stats.cssMisses++;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    }));
    return;
  }
  stats.other++;
});
