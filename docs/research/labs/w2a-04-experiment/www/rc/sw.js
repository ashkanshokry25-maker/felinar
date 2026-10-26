let last = null
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return
  last = { resulting: e.resultingClientId || '', client: e.clientId || '', url: e.request.url, t: Date.now() }
  e.respondWith(fetch(e.request))
})
self.addEventListener('message', (e) => {
  e.waitUntil((async () => {
    const got = last && last.resulting ? await self.clients.get(last.resulting) : null
    e.ports[0].postMessage({ resulting: last && last.resulting, source: e.source && e.source.id, idsMatch: !!(last && last.resulting && e.source && e.source.id === last.resulting), clientsGetFoundIt: !!got, hasResultingProp: 'resultingClientId' in FetchEvent.prototype })
  })())
})
