// Unit tests for src/idp/sw.js, the identity origin's Service Worker (ARCHITECTURE 15.1), with a fake Cache Storage and a fake
// fetch. The 2026-11-01 defect: on a host with clean URLs (Cloudflare Pages) ./index.html and ./signin/index.html answer with a
// redirect, cache.addAll stored the redirected responses, and a browser refuses a redirected cached response for a navigation
// (net::ERR_FAILED on every sign-in after the first). The worker now stores plain copies and never serves a redirected hit.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createIdpWorker, NAV_ALIASES, CACHE_PREFIX } from '../../src/idp/sw.js';

const SCOPE = 'https://id.example/';
const PRECACHE = ['./', './index.html', './signin/', './signin/index.html', './idp.js', './idp.css'];

/** A response as fetch() returns it after following a redirect: redirected is true (read-only on the prototype, so shadowed). */
function fetched(body, { status = 200, redirected = false, headers = {} } = {}) {
  const res = new Response(body, { status, headers });
  if (redirected) Object.defineProperty(res, 'redirected', { value: true });
  return res;
}

/** The network of a host with clean URLs: /index.html and /signin/index.html redirect to / and /signin/. */
function cleanUrlHost() {
  const docHeaders = { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'", 'content-encoding': 'br', 'content-length': '999' };
  const calls = [];
  const fetchFn = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    const path = new URL(url).pathname;
    if (path === '/' || path === '/index.html') return fetched('<!doctype html><title>home</title>', { redirected: path !== '/', headers: docHeaders });
    if (path === '/signin/' || path === '/signin/index.html') return fetched('<!doctype html><title>sign in</title>', { redirected: path !== '/signin/', headers: docHeaders });
    if (path === '/idp.js') return fetched('// idp', { headers: { 'content-type': 'text/javascript' } });
    if (path === '/idp.css') return fetched('body{}', { headers: { 'content-type': 'text/css' } });
    return fetched('not found', { status: 404 });
  };
  return { fetchFn, calls };
}

/** A Cache Storage: match(url, { ignoreSearch }) by URL, put(url, response). */
function fakeCaches() {
  const stores = new Map();
  const cacheFor = (name) => {
    if (!stores.has(name)) {
      const entries = new Map();
      stores.set(name, {
        entries,
        async put(url, res) { entries.set(typeof url === 'string' ? url : url.url, res); },
        async match(url, opts = {}) {
          const key = typeof url === 'string' ? url : url.url;
          const strip = (u) => (opts.ignoreSearch ? u.split('?')[0] : u);
          for (const [k, v] of entries) if (strip(k) === strip(key)) return v.clone();
          return undefined;
        },
        async addAll(urls) { throw new Error('addAll must not be used: ' + urls.join(',')); },
        async keys() { return Array.from(entries.keys()); },
      });
    }
    return stores.get(name);
  };
  return {
    stores,
    async open(name) { return cacheFor(name); },
    async keys() { return Array.from(stores.keys()); },
    async delete(name) { return stores.delete(name); },
  };
}

const nav = (path) => new Request(SCOPE.replace(/\/$/, '') + path, { method: 'GET' });

test('install stores one plain 200 copy per precache path: no redirect flag, no encoding or length header, the document headers kept', async () => {
  const host = cleanUrlHost();
  const caches = fakeCaches();
  const w = createIdpWorker({ buildId: 'b1', precache: PRECACHE, caches, fetchFn: host.fetchFn, scope: SCOPE });
  await w.install();
  assert.equal(w.name, CACHE_PREFIX + 'b1');
  const cache = await caches.open(w.name);
  assert.deepEqual(Array.from(cache.entries.keys()).sort(), PRECACHE.map((p) => new URL(p, SCOPE).href).sort(), 'every path under the name the list gives');
  for (const [url, res] of cache.entries) {
    assert.equal(res.redirected, false, url + ' is stored without a redirect');
    assert.equal(res.status, 200, url);
    assert.equal(res.headers.get('content-encoding'), null, url + ' keeps no encoding header');
    assert.equal(res.headers.get('content-length'), null, url);
  }
  const signin = cache.entries.get(SCOPE + 'signin/index.html');
  assert.equal(signin.headers.get('content-security-policy'), "default-src 'none'", 'the document headers (the CSP) are kept');
  assert.equal(await signin.clone().text(), '<!doctype html><title>sign in</title>');
  assert.equal(host.calls.length, PRECACHE.length);
});

test('a navigation to /signin, /signin/ or /index.html is answered from the cache with a plain response (the 2026-11-01 ERR_FAILED)', async () => {
  const host = cleanUrlHost();
  const caches = fakeCaches();
  const w = createIdpWorker({ buildId: 'b1', precache: PRECACHE, caches, fetchFn: host.fetchFn, scope: SCOPE });
  await w.install();
  const before = host.calls.length;
  for (const path of ['/signin', '/signin/', '/signin?x=1', '/', '/index.html']) {
    const res = await w.handle(nav(path));
    assert.ok(res, path + ' is answered');
    assert.equal(res.redirected, false, path + ': a redirected response is refused by the browser for a navigation');
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), path.startsWith('/signin') ? /sign in/ : /home/, path);
  }
  assert.equal(host.calls.length, before, 'every one of them came from the cache');
  assert.equal(w.handle(nav('/other')), null, 'an unknown path goes to the browser');
  assert.equal(w.handle(new Request(SCOPE + 'signin/', { method: 'POST' })), null, 'only GET');
  assert.deepEqual(Object.keys(NAV_ALIASES), ['', 'index.html', 'signin', 'signin/']);
});

test('a hit left by an older install that still carries a redirect is served as a plain copy; a miss goes to the network', async () => {
  const host = cleanUrlHost();
  const caches = fakeCaches();
  const w = createIdpWorker({ buildId: 'b1', precache: PRECACHE, caches, fetchFn: host.fetchFn, scope: SCOPE });
  const cache = await caches.open(w.name);
  await cache.put(SCOPE + 'signin/index.html', fetched('<!doctype html><title>old</title>', { redirected: true, headers: { 'content-type': 'text/html' } }));
  const res = await w.handle(nav('/signin'));
  assert.equal(res.redirected, false);
  assert.equal(await res.text(), '<!doctype html><title>old</title>');
  assert.equal(res.headers.get('content-type'), 'text/html');
  const miss = await w.handle(nav('/idp.js'));
  assert.equal(await miss.text(), '// idp', 'a precache path that is not cached yet comes from the network');
});

test('install fails when a precache file does not answer 200; activate drops the other mw-idp-* caches only', async () => {
  const host = cleanUrlHost();
  const caches = fakeCaches();
  const w = createIdpWorker({ buildId: 'b2', precache: PRECACHE.concat(['./missing.js']), caches, fetchFn: host.fetchFn, scope: SCOPE });
  await assert.rejects(w.install(), /missing\.js answered 404/);
  await caches.open(CACHE_PREFIX + 'old');
  await caches.open('other-app');
  const w2 = createIdpWorker({ buildId: 'b2', precache: PRECACHE, caches, fetchFn: host.fetchFn, scope: SCOPE });
  await w2.install();
  await w2.activate();
  assert.deepEqual((await caches.keys()).sort(), [CACHE_PREFIX + 'b2', 'other-app']);
});
