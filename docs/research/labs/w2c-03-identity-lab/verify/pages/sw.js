self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.pathname === '/who') e.respondWith(new Response('sw', { headers: { 'content-type': 'text/plain' } }));
});
