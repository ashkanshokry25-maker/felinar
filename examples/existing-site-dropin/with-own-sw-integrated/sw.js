/* The same hand-written worker as ../with-own-sw/sw.js, with the two lines that let felinar serve
   files from the visitor's device through it (ARCHITECTURE 3.4.4): import the core first, and give it
   the first look at every fetch. owns(event) is synchronous and true only for files of the stamped
   version that are complete in IndexedDB, and for /_mw/ws/*; the site's own routes run unchanged for
   everything else. */
importScripts('/_mw/sw-core.js');

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
  if (self.mw.owns(event)) return event.respondWith(self.mw.handle(event));
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
