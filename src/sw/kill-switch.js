// src/sw/kill-switch.js: the self-unregistering worker (ARCHITECTURE §7.1, DESIGN-REVIEW item 20).
// To take felinar's Service Worker off every returning visitor, deploy this file (build output
// dist/mw-sw-kill.js) as /mw-sw.js and purge the CDN. On the next update check the browser installs
// it; it clears our mw-* caches, takes control of open pages, unregisters, and reloads each
// top-level page the old worker controlled, which then loads straight from the host. It has no fetch
// handler, so nothing is intercepted meanwhile, and it leaves IndexedDB alone (a later deploy can
// reuse the saved sites). Deploy it together with the plain site: a host that keeps serving the
// shell gets a shell page that registers this script on every view (no reload loop, but no site).
// Classic script, no imports, ES2017.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Reload only the pages an earlier worker of this registration controlled (they belong to this
    // worker now). A page that loaded without a worker was served by the host already; reloading it
    // would only make it register this script again, and a host that still serves the shell would
    // then reload forever.
    let pages = [];
    try {
      pages = await self.clients.matchAll({ type: 'window' });
    } catch (_) { /* no clients API */ }
    try {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name.indexOf('mw-') === 0).map((name) => caches.delete(name)));
    } catch (_) { /* Cache API unavailable */ }
    try {
      await self.clients.claim();
    } catch (_) { /* nothing to claim */ }
    try {
      await self.registration.unregister();
    } catch (_) { /* already gone */ }
    for (const page of pages) {
      if (page.frameType === 'nested') continue; // reloading the top-level page reloads its frames
      try {
        if (typeof page.navigate === 'function') await page.navigate(page.url);
        else page.postMessage({ proto: 1, type: 'mw-reload' });
      } catch (_) {
        try {
          page.postMessage({ proto: 1, type: 'mw-reload' });
        } catch (_e) { /* page closed */ }
      }
    }
  })());
});
