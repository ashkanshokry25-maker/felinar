// the SITE's own service worker (what Workbox/next-pwa/vite-plugin-pwa would emit)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('fetch', () => {});
