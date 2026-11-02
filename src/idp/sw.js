// src/idp/sw.js: the identity origin's own Service Worker (R 2.3.9 "Linkability by the IdO host"; ARCHITECTURE
// 15.1). It keeps the bundle in Cache Storage so most sign-ins make no request to the IdO host; the host still
// sees popup loads that miss the cache and the browser's update checks of this file (stated as a recipient).
//
//   createIdpWorker({ buildId, precache, caches, fetchFn, scope }) -> { install(), activate(), handle(request) }
//   precache: paths relative to the worker's scope ('./', './index.html', './signin/', ..., './idp.js')
//
// Only same-origin GET requests are answered from the cache; everything else goes to the network untouched. Where the browser has
// the Static Routing API (Chromium 123 and later) a request to another origin is also told to skip this worker (staticRoute): the
// worker answers nothing for it, and the usage report the page sends to its report host as its window closes or goes away is lost
// when that request first has to be handed to a worker (Chromium 156, 2026-11-02: 0 of 6 pagehide beacons arrived on a navigation with
// the worker in control, 6 of 6 with this rule or without a worker).
// A new build is taken when every IdO window has closed (no skipWaiting), so one sign-in never mixes builds.
// tools/build-idp.mjs replaces self.__MW_IDP_BUILD__ and self.__MW_IDP_PRECACHE__ and bundles this file as a
// classic script; the exports are for the unit tests.

const BUILD_ID = typeof self !== 'undefined' && self.__MW_IDP_BUILD__ ? self.__MW_IDP_BUILD__ : 'dev';
const PRECACHE = typeof self !== 'undefined' && self.__MW_IDP_PRECACHE__ ? self.__MW_IDP_PRECACHE__ : ['./', './index.html', './signin/', './signin/index.html', './idp.js', './idp.css'];
export const CACHE_PREFIX = 'mw-idp-';

/** Navigation paths and the cached document that answers each (relative to the scope). */
export const NAV_ALIASES = Object.freeze({ '': './index.html', 'index.html': './index.html', signin: './signin/index.html', 'signin/': './signin/index.html' });

/**
 * staticRoute(location) -> the one Static Routing rule of this worker: a request to any origin but this one goes straight to the
 * network, without waking the worker. The page makes none today except a usage report (docs/OBSERVABILITY.md), and this worker answers
 * none of them either way.
 */
export function staticRoute(loc) {
  return { condition: { not: { urlPattern: { protocol: String(loc.protocol).replace(/:$/, ''), hostname: loc.hostname, port: loc.port } } }, source: 'network' };
}

/** installRoutes(event, location) -> true when the rule was registered; a browser without the API, or one that refuses the rule, gets none and the install goes on. */
export function installRoutes(event, loc) {
  try {
    if (event && typeof event.addRoutes === 'function') {
      event.addRoutes(staticRoute(loc));
      return true;
    }
  } catch (_) {
    // no static routing here: requests to another origin pass through the worker, which answers none of them
  }
  return false;
}

export function createIdpWorker({ buildId = BUILD_ID, precache = PRECACHE, caches: cacheStorage, fetchFn, scope }) {
  const name = CACHE_PREFIX + buildId;
  const base = new URL(scope);

  /**
   * The precache, one plain 200 copy per path. A host with clean URLs (Cloudflare Pages) answers ./index.html and
   * ./signin/index.html with a redirect to ./ and ./signin/, and a cached response that came through a redirect is refused by
   * the browser for a navigation (net::ERR_FAILED on every sign-in after the first, seen on 2026-11-01), so the copy is stored
   * without the redirect, under the path the list names. A file that does not answer 200 fails the install, as addAll did.
   */
  async function install() {
    const cache = await cacheStorage.open(name);
    for (const p of precache) {
      const url = new URL(p, base).href;
      const res = await fetchFn(url);
      if (!res || !res.ok) throw new Error('precache: ' + url + ' answered ' + (res ? res.status : 'nothing'));
      await cache.put(url, await plainCopy(res));
    }
  }

  /** plainCopy(res) -> a Response with the same status, body and headers, but no redirect history and no encoding headers. */
  async function plainCopy(res) {
    const headers = new Headers();
    res.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (k === 'content-encoding' || k === 'content-length' || k === 'transfer-encoding') return;
      headers.set(key, value);
    });
    return new Response(await res.arrayBuffer(), { status: res.status, statusText: res.statusText, headers });
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
      if (hit) return hit.redirected ? plainCopy(hit) : hit; // a copy from an older install may still carry a redirect
      return fetchFn(request);
    })();
  }

  return { name, install, activate, handle };
}

if (typeof ServiceWorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof ServiceWorkerGlobalScope) {
  const worker = createIdpWorker({ caches: self.caches, fetchFn: (r) => fetch(r), scope: self.registration.scope });
  self.addEventListener('install', (event) => {
    installRoutes(event, self.location);
    event.waitUntil(worker.install());
  });
  self.addEventListener('activate', (event) => event.waitUntil(worker.activate().then(() => self.clients.claim())));
  self.addEventListener('fetch', (event) => {
    const answer = worker.handle(event.request);
    if (answer) event.respondWith(answer);
  });
}
