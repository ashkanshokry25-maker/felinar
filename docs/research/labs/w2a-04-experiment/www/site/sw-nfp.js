self.addEventListener('install',e=>{self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil((async()=>{await self.registration.navigationPreload.enable();await self.clients.claim()})())});
self.addEventListener('fetch',e=>{ if(e.request.mode==='navigate') e.respondWith((async()=>(await e.preloadResponse)||fetch(e.request))()); });
