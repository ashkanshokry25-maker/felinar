// Custom SW: serves /site/<infohash>/<path> straight from Cache Storage (no page round-trip, no client race).
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  const m = url.pathname.match(/^\/site\/([0-9a-f]{40})\/(.*)$/)
  if (!m) return
  event.respondWith((async () => {
    let p = decodeURIComponent(m[2])
    if (p === '' || p.endsWith('/')) p += 'index.html'
    const cache = await caches.open('site-' + m[1])
    const hit = await cache.match('/site/' + m[1] + '/' + p)
    if (!hit) return new Response('404 not in cache', { status: 404, headers: { 'content-type': 'text/plain' } })
    const h = new Headers(hit.headers)
    h.set('x-content-type-options', 'nosniff')
    h.set('cache-control', 'no-store')
    return new Response(hit.body, { status: 200, headers: h })
  })())
})
