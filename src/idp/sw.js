// src/idp/sw.js: the identity origin's own Service Worker (R 2.3.9 "Linkability by the IdO host"; ARCHITECTURE
// 15.1). It keeps the bundle in Cache Storage so most sign-ins make no request to the IdO host; the host still
// sees popup loads that miss the cache and the browser's update checks of this file (stated as a recipient).
//
//   createIdpWorker({ buildId, precache, caches, fetchFn, scope }) -> { install(), activate(), handle(request) }
//   precache: paths relative to the worker's scope ('./', './index.html', './signin/', ..., './idp.js')
//
// Only same-origin GET requests are answered from the cache; everything else goes to the network untouched.
// A new build is taken when every IdO window has closed (no skipWaiting), so one sign-in never mixes builds.
// tools/build-idp.mjs replaces self.__MW_IDP_BUILD__ and self.__MW_IDP_PRECACHE__ and bundles this file as a
// classic script; the exports are for the unit tests.

const BUILD_ID = typeof self !== 'undefined' && self.__MW_IDP_BUILD__ ? self.__MW_IDP_BUILD__ : 'dev';
const PRECACHE = typeof self !== 'undefined' && self.__MW_IDP_PRECACHE__ ? self.__MW_IDP_PRECACHE__ : ['./', './index.html', './signin/', './signin/index.html', './idp.js', './idp.css'];
export const CACHE_PREFIX = 'mw-idp-';

/** Navigation paths and the cached document that answers each (relative to the scope). */
export const NAV_ALIASES = Object.freeze({ '': './index.html', 'index.html': './index.html', signin: './signin/index.html', 'signin/': './signin/index.html' });

export function createIdpWorker({ buildId = BUILD_ID, precache = PRECACHE, caches: cacheStorage, fetchFn, scope }) {
  const name = CACHE_PREFIX + buildId;
  const base = new URL(scope);

  async function install() {
    const cache = await cacheStorage.open(name);
    await cache.addAll(precache.map((p) => new URL(p, base).href));
  }

  async function activate() {
    const keys = await cacheStorage.keys();
    await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== name).map((k) => cacheStorage.delete(k)));
  }

  /** handle(request) -> Promise<Response> | null (null: let the browser fetch it). */
  function handle(request) {
    if (!request || request.method !== 'GET') return null;
    let url;
    try {
      url = new URL(request.url);
    } catch (_) {
      return null;
    }
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return null;
    const rel = url.pathname.slice(base.pathname.length);
    const target = Object.prototype.hasOwnProperty.call(NAV_ALIASES, rel) ? NAV_ALIASES[rel] : './' + rel;
    const known = precache.some((p) => new URL(p, base).pathname === new URL(target, base).pathname);
    if (!known) return null;
    return (async () => {
      const cache = await cacheStorage.open(name);
      const hit = await cache.match(new URL(target, base).href, { ignoreSearch: true });
      if (hit) return hit;
      return fetchFn(request);
    })();
  }

  return { name, install, activate, handle };
}

if (typeof ServiceWorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof ServiceWorkerGlobalScope) {
  const worker = createIdpWorker({ caches: self.caches, fetchFn: (r) => fetch(r), scope: self.registration.scope });
  self.addEventListener('install', (event) => event.waitUntil(worker.install()));
  self.addEventListener('activate', (event) => event.waitUntil(worker.activate().then(() => self.clients.claim())));
  self.addEventListener('fetch', (event) => {
    const answer = worker.handle(event.request);
    if (answer) event.respondWith(answer);
  });
}
