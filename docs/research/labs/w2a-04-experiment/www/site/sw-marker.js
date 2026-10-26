self.addEventListener('install',e=>{self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(self.clients.claim())});
self.addEventListener('fetch',e=>{ e.respondWith((async()=>{const r=await fetch(e.request);const h=new Headers(r.headers);h.set('x-sw','1');return new Response(r.body,{status:r.status,headers:h})})()); });
