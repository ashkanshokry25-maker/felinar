// Unit tests for src/sw/core.js, src/sw/sw.js and src/sw/kill-switch.js (ARCHITECTURE §3.1-3.4,
// §7.1, §7.3; DESIGN-REVIEW items 6, 7, 8, 9, 17, 20, 21, 23, S11). The core runs against an
// in-memory storage with the createIdbStorage surface, a Cache Storage fake, a Clients fake and a
// fetch stub; torrents are real (built with src/common/bencode.js, parsed by torrent-file.js).
// The IndexedDB reader itself is exercised in a real browser by sw-browser.test.mjs (MW_BROWSER=1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCore, DEFAULT_PATHS, DB_NAME, STORES, fileKey, fileKeyBounds, PROTO, SHELL_CACHE_PREFIX, integrityMatches, DEFAULT_LIMITS } from '../../src/sw/core.js';
import * as cacheJs from '../../src/loader/cache.js';
import { CONFIG } from '../../src/loader/config.js';

import { createHash } from 'node:crypto';
import { encode } from '../../src/common/bencode.js';

const ORIGIN = 'https://site.test';
const te = new TextEncoder();

function sha1(u8) {
  return new Uint8Array(createHash('sha1').update(u8).digest());
}

function bytes(n, seed = 7) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 255;
  return out;
}

/** files: [{ path, data: string | Uint8Array, pad? }] → { torrentFile, infoHash, files: [{ path, data, pad }] } */
function buildTorrent(files, { name = 'site', pieceLength = 16384 } = {}) {
  const list = files.map((f) => ({
    path: f.path,
    data: typeof f.data === 'string' ? te.encode(f.data) : f.data,
    pad: Boolean(f.pad),
  }));
  let total = 0;
  for (const f of list) total += f.data.length;
  const all = new Uint8Array(total);
  let off = 0;
  for (const f of list) {
    all.set(f.data, off);
    off += f.data.length;
  }
  const count = Math.ceil(total / pieceLength);
  const pieces = new Uint8Array(count * 20);
  for (let i = 0; i < count; i++) pieces.set(sha1(all.subarray(i * pieceLength, Math.min(total, (i + 1) * pieceLength))), i * 20);
  const info = {
    files: list.map((f) => {
      const e = { length: f.data.length, path: f.path.split('/') };
      if (f.pad) e.attr = 'p';
      return e;
    }),
    name,
    'piece length': pieceLength,
    pieces,
  };
  const torrentFile = encode({ 'created by': 'felinar test', info });
  const infoHash = Buffer.from(sha1(encode(info))).toString('hex');
  return { torrentFile, infoHash, files: list, pieceLength, total };
}

function memoryStorage() {
  const s = {
    sites: new Map(),
    files: new Map(),
    meta: new Map(),
    docs: new Map(),
    calls: [],
    reads: 0,
    async getSite(btih) {
      return s.sites.get(btih);
    },
    async listSites() {
      return Array.from(s.sites.values());
    },
    async getFile(btih, path) {
      s.reads++;
      return s.files.get(btih + '/' + path);
    },
    async getMeta(key) {
      return s.meta.get(key);
    },
    async setMeta(key, value) {
      s.calls.push(['setMeta', key]);
      s.meta.set(key, JSON.parse(JSON.stringify(value)));
    },
    async deleteSite(btih) {
      s.calls.push(['deleteSite', btih]);
      s.sites.delete(btih);
      for (const k of Array.from(s.files.keys())) if (k.startsWith(btih + '/')) s.files.delete(k);
      for (const [k, v] of Array.from(s.docs.entries())) if (v.btih === btih) s.docs.delete(k);
    },
    async getDoc(url) {
      return s.docs.get(url);
    },
    async putDoc(url, doc, limits) {
      s.calls.push(['putDoc', url]);
      s.docs.set(url, doc);
      const entries = Array.from(s.docs.entries()).sort((a, b) => a[1].savedAt - b[1].savedAt);
      while (entries.length > limits.docsMaxEntries) {
        const [k] = entries.shift();
        if (k !== url) s.docs.delete(k);
      }
    },
  };
  return s;
}

/** Stores a built torrent the way cache.js saveSite does (pad files are not stored). */
function storeSite(storage, t, { kind = 'site', types = {} } = {}) {
  let offset = 0;
  const files = [];
  for (const f of t.files) {
    if (!f.pad) {
      files.push({ path: f.path, length: f.data.length, type: types[f.path] || '', offset });
      storage.files.set(t.infoHash + '/' + f.path, new Blob([f.data]));
    }
    offset += f.data.length;
  }
  storage.sites.set(t.infoHash, {
    btih: t.infoHash, kind, name: 'site', torrentFile: t.torrentFile, files, pieceLength: t.pieceLength,
    total: t.total, savedAt: 1, lastVisit: 1, complete: true,
  });
}

function fakeCaches() {
  const stores = new Map();
  const keyOf = (req) => (typeof req === 'string' ? req : req.url);
  async function snapshot(res) {
    const headers = [];
    res.headers.forEach((v, k) => headers.push([k, v]));
    return { status: res.status, statusText: res.statusText, headers, body: new Uint8Array(await res.arrayBuffer()) };
  }
  const revive = (e) => new Response(e.body.slice(), { status: e.status, statusText: e.statusText, headers: e.headers });
  function cache(name) {
    const map = stores.get(name);
    return {
      async match(req) {
        const e = map.get(keyOf(req));
        return e ? revive(e) : undefined;
      },
      async put(req, res) {
        if (res.status === 206) throw new TypeError('Cache.put: partial response');
        map.set(keyOf(req), await snapshot(res));
      },
      async delete(req) {
        return map.delete(keyOf(req));
      },
      async keys() {
        return Array.from(map.keys()).map((url) => ({ url }));
      },
    };
  }
  return {
    stores,
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      return cache(name);
    },
    async match(req, opts) {
      const names = opts && opts.cacheName ? [opts.cacheName] : Array.from(stores.keys());
      for (const n of names) {
        const map = stores.get(n);
        const e = map && map.get(keyOf(req));
        if (e) return revive(e);
      }
      return undefined;
    },
    async keys() {
      return Array.from(stores.keys());
    },
    async delete(name) {
      return stores.delete(name);
    },
    async has(name) {
      return stores.has(name);
    },
    paths(name) {
      const map = stores.get(name);
      return map ? Array.from(map.keys()).map((u) => new URL(u).pathname).sort() : [];
    },
  };
}

function client(id, { type = 'window', frameType = 'top-level', url = ORIGIN + '/' } = {}) {
  const c = {
    id, type, frameType, url, messages: [],
    postMessage(m) {
      c.messages.push(m);
    },
  };
  return c;
}

function fakeClients(list = []) {
  const clients = {
    list,
    claimed: 0,
    async get(id) {
      return list.find((c) => c.id === id);
    },
    async matchAll(opts) {
      return list.filter((c) => !opts || !opts.type || opts.type === 'all' || c.type === opts.type);
    },
    async claim() {
      clients.claimed++;
    },
  };
  return clients;
}

/** routes: { absoluteUrl: Response | Error | (input, init) => Response }; unknown URLs answer 404. */
function fetchStub(routes = {}) {
  const f = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    f.calls.push({ url, init, input });
    const r = f.routes[url];
    if (r === undefined) return new Response('not found', { status: 404 });
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return r(input, init);
    return r.clone();
  };
  f.routes = routes;
  f.calls = [];
  f.count = (url) => f.calls.filter((c) => c.url === url).length;
  return f;
}

function ev(path, {
  mode = 'no-cors', destination = '', clientId = '', resultingClientId = '', headers = {}, method = 'GET',
  referrer = '', cache = 'default', url = null,
} = {}) {
  const request = {
    url: url || ORIGIN + path, method, mode, destination, headers: new Headers(headers), cache, referrer,
    credentials: 'include', redirect: mode === 'navigate' ? 'manual' : 'follow',
  };
  const waits = [];
  return {
    request,
    clientId,
    resultingClientId,
    waits,
    waitUntil(p) {
      waits.push(Promise.resolve(p));
    },
    async settled() {
      for (let i = 0; i < waits.length; i++) await waits[i].catch(() => {});
    },
  };
}

const nav = (path, o = {}) => ev(path, Object.assign({ mode: 'navigate', destination: 'document' }, o));
const frameNav = (path, o = {}) => ev(path, Object.assign({ mode: 'navigate', destination: 'iframe' }, o));

function makeCore({
  storage = memoryStorage(), caches = fakeCaches(), clients = fakeClients(), fetch = fetchStub(),
  foreign = false, precache = undefined, buildId = 'test', limits = {}, registration = null, integrity = undefined,
} = {}) {
  const logs = [];
  const reg = registration || {
    updates: 0,
    update() {
      reg.updates++;
      return Promise.resolve();
    },
  };
  const core = createCore({
    buildId,
    foreign,
    precache: precache || ['/index.html', '/_mw/boot.js', '/_mw/loader.js', '/_mw/sdk.js', '/_mw/webtorrent.min.js', '/mw-sw.js', 'https://cdn.example/x.js'],
    storage,
    integrity,
    limits: Object.assign({ persistDelayMs: 0, refreshThrottleMs: 0 }, limits),
    env: {
      origin: ORIGIN, caches, clients, fetch, registration: reg,
      skipWaiting: () => Promise.resolve(),
      log: (m) => logs.push(m),
    },
  });
  return { core, storage, caches, clients, fetch, logs, registration: reg };
}

/** owns() must say yes; then the response, after every waitUntil promise settled. */
async function serve(core, event) {
  if (!core.owns(event)) throw new Error('owns() refused ' + event.request.url);
  const res = await core.handle(event);
  await event.settled();
  return res;
}

async function send(core, data, { source = null, port = true } = {}) {
  const replies = [];
  const waits = [];
  const event = {
    data, source,
    ports: port ? [{ postMessage: (m) => replies.push(m) }] : [],
    waitUntil(p) {
      waits.push(p);
    },
  };
  const handled = core.message(event);
  for (let i = 0; i < waits.length; i++) await waits[i];
  return { handled, replies, event };
}

async function text(res) {
  return new TextDecoder().decode(await res.arrayBuffer());
}

// ---------------------------------------------------------------------------------------------
// tests (integration-1: the Wave A file held only the helpers above)
// ---------------------------------------------------------------------------------------------

const SHELL_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>Loading site</title></head><body><div id="mw-root"></div><script src="/_mw/boot.js"></script></body></html>';

function exampleSite(extra = []) {
  return buildTorrent([
    { path: '.mw/site.json', data: JSON.stringify({ index: 'index.html', notFound: '404.html' }) },
    { path: '404.html', data: '<!doctype html><title>Not here</title><h1>404</h1>' },
    { path: 'css/app.css', data: 'body { color: red }' },
    { path: 'index.html', data: '<!doctype html><title>Home</title><h1>Home</h1>' },
    { path: 'media/clip.bin', data: bytes(40000) },
    ...extra,
  ], { pieceLength: 16384 });
}

function shellFetch() {
  return fetchStub({
    [ORIGIN + '/index.html']: new Response(SHELL_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    [ORIGIN + '/_mw/boot.js']: new Response('/* boot */', { headers: { 'Content-Type': 'text/javascript' } }),
    [ORIGIN + '/_mw/loader.js']: new Response('/* loader */', { headers: { 'Content-Type': 'text/javascript' } }),
    [ORIGIN + '/_mw/sdk.js']: new Response('/* sdk */', { headers: { 'Content-Type': 'text/javascript' } }),
  });
}

/** A core in shell mode with the example stored and current: install, activate, mw-set-current. */
async function shellCore(o = {}) {
  const t = o.torrent || exampleSite();
  const storage = o.storage || memoryStorage();
  if (o.store !== false) storeSite(storage, t);
  const clients = fakeClients([client('shell-1')]);
  const made = makeCore(Object.assign({ storage, clients, fetch: shellFetch() }, o.core || {}));
  await made.core.install({ waitUntil() {} });
  await made.core.activate({ waitUntil() {} });
  const r = await send(made.core, { proto: PROTO, type: 'mw-set-current', btih: t.infoHash }, { source: { id: 'shell-1', frameType: 'top-level' } });
  return Object.assign(made, { t, setCurrent: r });
}

test('install precaches the shell files (never webtorrent.min.js, /mw-sw.js or other origins); activate claims and drops old caches', async () => {
  const caches = fakeCaches();
  await caches.open(SHELL_CACHE_PREFIX + 'old');
  const { core, clients, fetch } = makeCore({ caches, fetch: shellFetch() });
  await core.install({ waitUntil() {} });
  assert.deepEqual(caches.paths(SHELL_CACHE_PREFIX + 'test').filter((p) => !p.startsWith('/_mw/__')), ['/_mw/boot.js', '/_mw/loader.js', '/_mw/sdk.js', '/index.html']);
  assert.equal(fetch.count(ORIGIN + '/_mw/webtorrent.min.js'), 0);
  assert.equal(fetch.count('https://cdn.example/x.js'), 0);
  await core.activate({ waitUntil() {} });
  assert.equal(clients.claimed, 1);
  assert.equal(await caches.has(SHELL_CACHE_PREFIX + 'old'), false);
  assert.equal(await caches.has(SHELL_CACHE_PREFIX + 'test'), true);
});

test('owns(): same-origin GET only; /mw-sw.js, /_mw/t/*, /ws/* pass through; /_mw/* and navigations are ours', async () => {
  const { core } = await shellCore();
  assert.equal(core.owns(ev('/x', { method: 'POST' })), false);
  assert.equal(core.owns(ev('/x', { url: 'https://other.test/x' })), false);
  assert.equal(core.owns(ev('/mw-sw.js')), false);
  assert.equal(core.owns(ev('/_mw/t/abc.torrent')), false);
  assert.equal(core.owns(ev('/ws/site/index.html')), false);
  assert.equal(core.owns(ev('/_mw/loader.js')), true);
  assert.equal(core.owns(nav('/anything')), true);
  assert.equal(core.owns(frameNav('/')), true);
});

test('shell: a top-level navigation gets the precached shell with framing headers; the frame gets the site', async () => {
  const { core, t, setCurrent } = await shellCore();
  assert.equal(setCurrent.replies[0].type, 'mw-ack');
  assert.equal(setCurrent.replies[0].ok, true);
  assert.equal(setCurrent.replies[0].complete, true);
  const top = await serve(core, nav('/about', { resultingClientId: 'shell-2' }));
  assert.equal(top.status, 200);
  assert.match(await text(top), /\/_mw\/boot\.js/);
  assert.equal(top.headers.get('X-Frame-Options'), 'DENY');
  assert.match(top.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  const frame = await serve(core, frameNav('/', { resultingClientId: 'frame-1' }));
  assert.equal(frame.status, 200);
  assert.equal(await text(frame), '<!doctype html><title>Home</title><h1>Home</h1>');
  assert.equal(frame.headers.get('X-Frame-Options'), 'SAMEORIGIN');
  assert.match(frame.headers.get('Content-Security-Policy'), /frame-ancestors 'self'/);
  assert.equal(frame.headers.get('Cache-Control'), 'no-store');
  assert.equal(frame.headers.get('X-Content-Type-Options'), 'nosniff');
  const css = await serve(core, ev('/css/app.css', { clientId: 'frame-1', destination: 'style' }));
  assert.equal(css.status, 200);
  assert.match(css.headers.get('Content-Type'), /^text\/css/);
  assert.equal(await text(css), 'body { color: red }');
  const missing = await serve(core, frameNav('/nope', { resultingClientId: 'frame-2' }));
  assert.equal(missing.status, 404);
  assert.match(await text(missing), /Not here/, 'the site 404 page from the routing manifest');
  void t;
});

test('shell: Range requests are sliced from the stored Blob (206, suffix, 416)', async () => {
  const { core, t } = await shellCore();
  await serve(core, frameNav('/', { resultingClientId: 'frame-1' }));
  const clip = t.files.find((f) => f.path === 'media/clip.bin').data;
  const r = await serve(core, ev('/media/clip.bin', { clientId: 'frame-1', headers: { Range: 'bytes=0-1' } }));
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('Content-Range'), 'bytes 0-1/' + clip.length);
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), clip.subarray(0, 2));
  const s = await serve(core, ev('/media/clip.bin', { clientId: 'frame-1', headers: { Range: 'bytes=-10' } }));
  assert.equal(s.status, 206);
  assert.equal(s.headers.get('Content-Range'), 'bytes ' + (clip.length - 10) + '-' + (clip.length - 1) + '/' + clip.length);
  const bad = await serve(core, ev('/media/clip.bin', { clientId: 'frame-1', headers: { Range: 'bytes=999999-' } }));
  assert.equal(bad.status, 416);
  assert.equal(bad.headers.get('Content-Range'), 'bytes */' + clip.length);
});

test('a stored file that fails its piece check: the copy is deleted, pages are told, the frame gets the 503 page', async () => {
  const { core, t, storage, clients } = await shellCore({ store: true });
  const key = t.infoHash + '/index.html';
  const good = new Uint8Array(await storage.files.get(key).arrayBuffer());
  const bad = good.slice();
  bad[3] ^= 0x20;
  storage.files.set(key, new Blob([bad]));
  const res = await serve(core, frameNav('/', { resultingClientId: 'frame-1' }));
  assert.equal(res.status, 503);
  assert.match(await text(res), /Saved files were removed/);
  assert.equal(storage.sites.has(t.infoHash), false, 'deleteSite ran');
  assert.ok(storage.calls.some((c) => c[0] === 'deleteSite' && c[1] === t.infoHash));
  const told = clients.list[0].messages.find((m) => m.type === 'mw-site-invalid');
  assert.ok(told, 'mw-site-invalid was broadcast');
  assert.equal(told.btih, t.infoHash);
  assert.equal(told.proto, PROTO);
  const drops = core.inspect().drops;
  assert.equal(drops.length, 1);
  assert.equal(drops[0].reason, 'mismatch');
});

test('first load: a site saved while the worker still saw no database is found on mw-set-current (no stale "not ready")', async () => {
  // The worker started before the page created the database: reads fail with E_NO_DB and the
  // storage keeps a short negative cache. retry() (called on every forced refresh) clears it.
  const t = exampleSite();
  const inner = memoryStorage();
  let missing = true;
  let retries = 0;
  const storage = Object.assign({}, inner, {
    retry() { retries++; missing = false; },
    async getSite(btih) {
      if (missing) throw Object.assign(new Error('the site database does not exist yet'), { code: 'E_NO_DB' });
      return inner.getSite(btih);
    },
    async listSites() {
      if (missing) throw Object.assign(new Error('the site database does not exist yet'), { code: 'E_NO_DB' });
      return inner.listSites();
    },
  });
  const { core } = makeCore({ storage, clients: fakeClients([client('shell-1')]), fetch: shellFetch(), limits: { refreshThrottleMs: 60000 } });
  await core.install({ waitUntil() {} });
  await core.activate({ waitUntil() {} });
  // A request that names the btih before the copy exists: remembered as missing for the throttle window.
  storeSite(inner, t);
  const r = await send(core, { proto: PROTO, type: 'mw-set-current', btih: t.infoHash }, { source: { id: 'shell-1', frameType: 'top-level' } });
  assert.ok(retries >= 1, 'the forced refresh cleared the negative cache');
  assert.equal(r.replies[0].complete, true, 'the ack says the copy is indexed');
  const frame = await serve(core, frameNav('/', { resultingClientId: 'frame-1' }));
  assert.equal(frame.status, 200);
});

test('a navigation into the site re-reads IndexedDB inside the refresh throttle', async () => {
  const t = exampleSite();
  const storage = memoryStorage();
  const { core } = makeCore({ storage, clients: fakeClients([client('shell-1')]), fetch: shellFetch(), limits: { refreshThrottleMs: 60000 } });
  await core.install({ waitUntil() {} });
  await core.activate({ waitUntil() {} });
  const r = await send(core, { proto: PROTO, type: 'mw-set-current', btih: t.infoHash }, { source: { id: 'shell-1', frameType: 'top-level' } });
  assert.equal(r.replies[0].complete, false, 'nothing stored yet');
  const early = await serve(core, ev('/css/app.css', { clientId: 'frame-0' }));
  assert.equal(early.status, 503, 'a subresource does not force a read: not ready');
  storeSite(storage, t); // the page saves its copy a moment later
  const frame = await serve(core, frameNav('/', { resultingClientId: 'frame-1' }));
  assert.equal(frame.status, 200, 'the navigation forced one read and found the copy');
});

test('messages: mw-ping answers with the build id; another proto or an unknown type is refused', async () => {
  const { core } = makeCore();
  const ping = await send(core, { proto: PROTO, type: 'mw-ping' });
  assert.deepEqual(ping.replies[0].type, 'mw-pong');
  assert.equal(ping.replies[0].buildId, 'test');
  const other = await send(core, { proto: PROTO + 1, type: 'mw-set-current', btih: 'a'.repeat(40) });
  assert.equal(other.replies[0].ok, false);
  assert.equal(other.replies[0].error, 'proto');
  const unknown = await send(core, { proto: PROTO, type: 'mw-bogus' });
  assert.equal(unknown.replies[0].error, 'unknown-type');
  const notOurs = await send(core, { type: 'something-else' });
  assert.equal(notOurs.handled, false);
});

test('shared-origin hub: a top-level navigation into /_mw/s/<btih>/ is sent back to the gate', async () => {
  const { core, t } = await shellCore();
  const res = await serve(core, nav('/_mw/s/' + t.infoHash + '/about.html'));
  assert.equal(res.status, 302);
  assert.match(res.headers.get('Location'), new RegExp('/\\?p=%2Fabout\\.html#btih:' + t.infoHash + '$'));
});

// integration-2: the drop-in web-seed rewrite keeps whole host files per (version, URL).
test('web-seed rewrite: a new version within the 60 s blob cache gets fresh bytes for a changed file', async () => {
  let content = '{ "version": 1 }\n';
  // Two versions of one site, neither stored yet: the worker reads each version's torrent from the
  // host's /_mw/t/ (code review round 1: only paths the requesting page's torrent lists are fetched).
  const t1 = buildTorrent([{ path: 'data.json', data: '{ "version": 1 }\n' }], { name: 'existing-site' });
  const t2 = buildTorrent([{ path: 'data.json', data: '{ "version": 2 }\n' }], { name: 'existing-site' });
  const fetch = fetchStub({
    [ORIGIN + '/data.json']: () => new Response(content, { headers: { 'Content-Type': 'application/json' } }),
    [ORIGIN + '/_mw/t/' + t1.infoHash + '.torrent']: () => new Response(t1.torrentFile),
    [ORIGIN + '/_mw/t/' + t2.infoHash + '.torrent']: () => new Response(t2.torrentFile),
  });
  const { core } = makeCore({ foreign: false, fetch });
  await core.install({ waitUntil() {} });
  await core.activate({ waitUntil() {} });
  const v1 = t1.infoHash;
  const v2 = t2.infoHash;
  assert.equal((await send(core, { proto: PROTO, type: 'mw-map-client', clientId: 'tab-v1', btih: v1 })).replies[0].ok, true);
  assert.equal((await send(core, { proto: PROTO, type: 'mw-map-client', clientId: 'tab-v2', btih: v2 })).replies[0].ok, true);
  const get = async (clientId) => text(await serve(core, ev('/_mw/ws/existing-site/data.json', { clientId, headers: { range: 'bytes=0-15' } })));
  assert.equal(await get('tab-v1'), '{ "version": 1 }');
  assert.equal(await get('tab-v1'), '{ "version": 1 }');
  assert.equal(fetch.count(ORIGIN + '/data.json'), 1, 'one host download per file and version');
  content = '{ "version": 2 }\n'; // the deploy changed the file under the same URL
  assert.equal(await get('tab-v2'), '{ "version": 2 }', 'the v2 page is not handed the bytes kept for v1');
  assert.equal(fetch.count(ORIGIN + '/data.json'), 2);
  assert.equal(await get('tab-v1'), '{ "version": 1 }', 'v1 keeps its own entry while it lives');
});

// integration-2: a returning visitor's cached shell must not pin the page tag of install day.
test('shell revalidation: a same-build shell with a new page tag replaces the cached copy; another build never does', async () => {
  const tagged = (btih, extra = '') => SHELL_HTML.replace('<title>', '<meta name="mw-pointer" content="v=mw1; btih=' + btih + '"><title>').replace('<script src="/_mw/boot.js">', '<script src="/_mw/boot.js"' + extra + '>');
  const made = await shellCore();
  const { core, fetch, caches } = made;
  const cachedText = async () => {
    const res = await caches.match(ORIGIN + '/index.html');
    return res ? res.text() : null;
  };
  // the host now serves the same build with a new page tag
  fetch.routes[ORIGIN + '/index.html'] = new Response(tagged('b'.repeat(40)), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  const res = await serve(core, nav('/'));
  assert.equal(res.status, 200);
  assert.match(await text(res), /mw-root/, 'the navigation is answered from the cache at once');
  assert.match(await cachedText(), /btih=b{40}/, 'the background re-fetch replaced the cached shell');
  // mw-shell-check reports the host's current tag
  fetch.routes[ORIGIN + '/index.html'] = new Response(tagged('c'.repeat(40)), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  const r = await send(core, { proto: PROTO, type: 'mw-shell-check' });
  assert.equal(r.replies[0].of, 'mw-shell-check');
  assert.equal(r.replies[0].ok, true);
  assert.match(r.replies[0].pointer, /btih=c{40}/);
  assert.equal(r.replies[0].replaced, true);
  // a shell of another build (different SRI) is reported but never cached over the precache
  fetch.routes[ORIGIN + '/index.html'] = new Response(tagged('d'.repeat(40), ' integrity="sha384-other" crossorigin="anonymous"'), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  const r2 = await send(core, { proto: PROTO, type: 'mw-shell-check' });
  assert.match(r2.replies[0].pointer, /btih=d{40}/);
  assert.equal(r2.replies[0].replaced, false);
  assert.match(await cachedText(), /btih=c{40}/, 'the cached shell still matches the precached assets');
  // a host that stopped serving the shell (kill switch, plain site) changes nothing
  fetch.routes[ORIGIN + '/index.html'] = new Response('<!doctype html><title>Plain</title><h1>Plain site</h1>', { headers: { 'Content-Type': 'text/html' } });
  const r3 = await send(core, { proto: PROTO, type: 'mw-shell-check' });
  assert.equal(r3.replies[0].ok, false);
  assert.match(await cachedText(), /btih=c{40}/);
  // offline: no answer, no change
  fetch.routes[ORIGIN + '/index.html'] = new Error('offline');
  const r4 = await send(core, { proto: PROTO, type: 'mw-shell-check' });
  assert.equal(r4.replies[0].ok, false);
});

// integration-2: the kill switch (src/sw/kill-switch.js) run in a VM with fake worker globals.
test('kill switch: clears mw-* caches, unregisters, and reloads only the pages an earlier worker controlled', async () => {
  const vm = await import('node:vm');
  const source = readFileSync(new URL('../../src/sw/kill-switch.js', import.meta.url), 'utf8');
  const handlers = {};
  const navigated = [];
  const deleted = [];
  const calls = { claim: 0, unregister: 0, skipWaiting: 0 };
  // controlled: true for pages the old worker controlled (they belong to this worker once it activates)
  const pages = [
    { url: ORIGIN + '/', frameType: 'top-level', controlled: true },
    { url: ORIGIN + '/about.html', frameType: 'nested', controlled: true },
    { url: ORIGIN + '/fresh', frameType: 'top-level', controlled: false }, // loaded from the host, registered us
  ].map((p) => Object.assign(p, { navigate: async (u) => { navigated.push(u); } }));
  const self = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: () => { calls.skipWaiting++; },
    clients: {
      matchAll: async (o = {}) => pages.filter((p) => o.includeUncontrolled || p.controlled),
      claim: async () => { calls.claim++; },
    },
    registration: { unregister: async () => { calls.unregister++; return true; } },
  };
  const caches = {
    keys: async () => ['mw-shell-abc', 'mw-other', 'site-cache'],
    delete: async (name) => { deleted.push(name); return true; },
  };
  vm.runInNewContext(source, { self, caches });
  handlers.install({});
  assert.equal(calls.skipWaiting, 1);
  let work = null;
  handlers.activate({ waitUntil: (p) => { work = p; } });
  await work;
  assert.deepEqual(deleted.sort(), ['mw-other', 'mw-shell-abc'], 'only mw-* caches');
  assert.equal(calls.claim, 1);
  assert.equal(calls.unregister, 1);
  assert.deepEqual(navigated, [ORIGIN + '/'], 'the controlled top-level page is reloaded; a nested frame and an uncontrolled page are not');
});

// ---------------------------------------------------------------------------------------------
// v0.2.1: D1 (navigation deadline, reload-loop guard, keep-alive, versioned protocol, no required
// state in memory), D2 (atomic install with Request.integrity, fail-open navigations), D4 (drop-in
// cold start, no-store pages, the web-seed rewrite)
// ---------------------------------------------------------------------------------------------

function sri(text) {
  return 'sha384-' + createHash('sha384').update(text).digest('base64');
}

const CRITICAL = { '/_mw/boot.js': sri('/* boot */'), '/_mw/loader.js': sri('/* loader */'), '/_mw/sdk.js': sri('/* sdk */') };

function installEvent() {
  const e = { promises: [], waitUntil(p) { e.promises.push(p); } };
  return e;
}

test('D2 integrityMatches: sha256/384/512 SRI values, several candidates, unknown algorithms', async () => {
  const bytes = te.encode('/* boot */');
  assert.equal(await integrityMatches(bytes, sri('/* boot */')), true);
  assert.equal(await integrityMatches(bytes, sri('/* other */')), false);
  assert.equal(await integrityMatches(bytes, sri('/* other */') + ' ' + sri('/* boot */')), true, 'any listed value may match');
  assert.equal(await integrityMatches(bytes, 'sha256-' + createHash('sha256').update('/* boot */').digest('base64')), true);
  assert.equal(await integrityMatches(bytes, 'md5-abc'), true, 'an unknown algorithm is not checked (browsers ignore it too)');
});

test('D2 atomic install: the JS and CSS with a build-time hash are all-or-nothing, fetched with Request.integrity', async () => {
  // all match: the install resolves, the critical files are cached, the fetches carried integrity
  const ok = makeCore({ fetch: shellFetch(), integrity: CRITICAL });
  const e1 = installEvent();
  await ok.core.install(e1);
  await Promise.all(e1.promises);
  assert.deepEqual(ok.caches.paths(SHELL_CACHE_PREFIX + 'test').filter((p) => !p.startsWith('/_mw/__')), ['/_mw/boot.js', '/_mw/loader.js', '/_mw/sdk.js', '/index.html']);
  const call = ok.fetch.calls.find((c) => c.url === ORIGIN + '/_mw/loader.js');
  assert.equal(call.init.integrity, CRITICAL['/_mw/loader.js']);
  assert.equal(call.init.cache, 'no-cache', 'revalidated, not downloaded again (code review round 1)');
  assert.equal(ok.core.inspect().integrity, 3);

  // a stale CDN copy of loader.js: the install rejects, the new cache is deleted, nothing half-filled stays
  const mixed = shellFetch();
  mixed.routes[ORIGIN + '/_mw/loader.js'] = new Response('/* loader of another build */', { headers: { 'Content-Type': 'text/javascript' } });
  const bad = makeCore({ fetch: mixed, integrity: CRITICAL });
  const e2 = installEvent();
  const p = bad.core.install(e2);
  assert.equal(e2.promises.length, 1, 'the work is handed to event.waitUntil');
  await assert.rejects(e2.promises[0], /\/_mw\/loader\.js: the bytes do not match the build/);
  await assert.rejects(p);
  assert.equal(await bad.caches.has(SHELL_CACHE_PREFIX + 'test'), false, 'the half-filled cache is deleted');
  assert.match(bad.core.inspect().installFailed, /loader\.js/);
  assert.ok(bad.logs.some((l) => /install aborted/.test(l)));

  // a missing critical file (404) also aborts
  const gone = shellFetch();
  delete gone.routes[ORIGIN + '/_mw/sdk.js'];
  const missing = makeCore({ fetch: gone, integrity: CRITICAL });
  await assert.rejects(missing.core.install(installEvent()), /\/_mw\/sdk\.js: HTTP 404/);

  // HTML is best-effort: a missing /index.html does not abort the install
  const noIndex = shellFetch();
  delete noIndex.routes[ORIGIN + '/index.html'];
  const lenient = makeCore({ fetch: noIndex, integrity: CRITICAL });
  await lenient.core.install(installEvent());
  assert.equal(await lenient.caches.has(SHELL_CACHE_PREFIX + 'test'), true);

  // without an integrity map (unbuilt development) every entry stays best-effort, as in v0.2
  const dev = makeCore({ fetch: gone });
  await dev.core.install(installEvent());
  assert.deepEqual(dev.caches.paths(SHELL_CACHE_PREFIX + 'test').filter((x) => !x.startsWith('/_mw/__')), ['/_mw/boot.js', '/_mw/loader.js', '/index.html']);
});

test('D2 fail open: a top-level navigation whose handling fails goes to the network, then to the offline page; a shell frame gets the error page', async () => {
  const { core, caches, t } = await shellCore();
  // the cached shell becomes unreadable
  const brokenCaches = Object.assign({}, caches, {
    match: async () => ({ headers: new Headers({ 'content-type': 'text/html' }), get body() { throw new Error('boom'); } }),
    open: caches.open, keys: caches.keys, delete: caches.delete, has: caches.has,
  });
  const fetch = fetchStub({ [ORIGIN + '/about.html']: new Response('<!doctype html><title>host shell</title>', { headers: { 'Content-Type': 'text/html' } }) });
  const broken = makeCore({ caches: brokenCaches, fetch, storage: memoryStorage() });
  await send(broken.core, { proto: PROTO, type: 'mw-set-current', btih: t.infoHash }, { source: { id: 'shell-1', frameType: 'top-level' } });
  const res = await serve(broken.core, nav('/about.html'));
  assert.equal(res.status, 200);
  assert.match(await text(res), /host shell/, 'the host answered (fail open)');
  const offline = makeCore({ caches: brokenCaches, fetch: fetchStub({ [ORIGIN + '/x.html']: new Error('offline') }), storage: memoryStorage() });
  await send(offline.core, { proto: PROTO, type: 'mw-set-current', btih: t.infoHash }, { source: { id: 'shell-1', frameType: 'top-level' } });
  const off = await serve(offline.core, nav('/x.html'));
  assert.equal(off.status, 503);
  assert.match(await text(off), /offline/);
  // a frame navigation of shell mode: never the host (it would answer with the shell itself)
  const storage = memoryStorage();
  storage.retry = () => { throw new Error('boom'); };
  const frameCore = makeCore({ storage, fetch: shellFetch() });
  await frameCore.core.install(installEvent());
  await send(frameCore.core, { proto: PROTO, type: 'mw-set-current', btih: t.infoHash }, { source: { id: 'shell-1', frameType: 'top-level' } }).catch(() => {});
  const frame = await serve(frameCore.core, frameNav('/about.html', { clientId: 'shell-1' }));
  assert.equal(frame.status, 500);
  assert.match(await text(frame), /Something went wrong/);
  assert.equal(frameCore.fetch.count(ORIGIN + '/about.html'), 0);
  void core;
});

// The work behind a timed-out navigation never finishes here (the host hangs): do not wait for it.
async function handleOnly(core, event) {
  if (!core.owns(event)) throw new Error('owns() refused ' + event.request.url);
  return core.handle(event);
}

test('D1 navigation deadline: an answer within the deadline (interstitial that retries); the guard stops the retries', async () => {
  const hang = () => new Promise(() => {});
  const { core, logs } = makeCore({ fetch: fetchStub({ [ORIGIN + '/slow.html']: hang, [ORIGIN + '/slow.html?x=1']: hang }), limits: { navigationDeadlineMs: 40, reloadGuardMax: 2 } });
  await core.init();
  assert.equal(core.inspect().mode, 'dropin');
  const t0 = Date.now();
  const first = await handleOnly(core, nav('/slow.html'));
  assert.ok(Date.now() - t0 < 1000, 'answered at the deadline, not when the host answers');
  assert.equal(first.status, 503);
  assert.equal(first.headers.get('retry-after'), '5');
  const body = await text(first);
  assert.match(body, /<meta http-equiv="refresh" content="5">/);
  assert.match(body, /Still loading/);
  const second = await handleOnly(core, nav('/slow.html'));
  assert.match(await text(second), /http-equiv="refresh"/);
  const third = await handleOnly(core, nav('/slow.html'));
  const thirdBody = await text(third);
  assert.equal(third.status, 503);
  assert.equal(/http-equiv="refresh"/.test(thirdBody), false, 'reload-loop guard: no automatic retry after reloadGuardMax');
  assert.match(thirdBody, /Reload to try again/);
  assert.ok(logs.some((l) => /longer than 40 ms/.test(l)));
  // another URL has its own budget
  const other = await handleOnly(core, nav('/slow.html?x=1'));
  assert.match(await text(other), /http-equiv="refresh"/);
  assert.equal(DEFAULT_LIMITS.navigationDeadlineMs, 25000);
  assert.equal(DEFAULT_LIMITS.coldStartWaitMs, 40);
});

test('D1 keep-alive and versioned protocol: mw-keepalive and GET /_mw/keepalive answer at once; another proto is refused', async () => {
  const { core } = makeCore({ fetch: shellFetch() });
  const r = await send(core, { proto: PROTO, type: 'mw-keepalive' });
  assert.equal(r.handled, true);
  assert.deepEqual(r.replies[0], { proto: PROTO, type: 'mw-ack', of: 'mw-keepalive', ok: true, buildId: 'test' });
  const res = await serve(core, ev('/_mw/keepalive'));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const old = await send(core, { proto: PROTO + 1, type: 'mw-keepalive' });
  assert.equal(old.replies[0].ok, false);
  assert.equal(old.replies[0].error, 'proto');
  assert.equal(old.replies[0].expected, PROTO);
});

test('D1 no required state in worker memory: a restarted worker serves a mapped drop-in client and the shell site from what was persisted', async () => {
  const t = exampleSite();
  const storage = memoryStorage();
  storeSite(storage, t);
  const first = makeCore({ storage, clients: fakeClients([client('page-1')]) });
  await first.core.init();
  await send(first.core, { proto: PROTO, type: 'mw-map-client', clientId: 'page-1', btih: t.infoHash });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(storage.meta.get('clients'), { 'page-1': t.infoHash }, 'the client map is persisted');
  // the worker is stopped: a new instance, same storage, no message
  const restarted = makeCore({ storage });
  const res = await serve(restarted.core, ev('/css/app.css', { clientId: 'page-1', destination: 'style' }));
  assert.equal(res.status, 200);
  assert.equal(await text(res), 'body { color: red }');
  // shell: meta.current and the mode mark (Cache Storage) survive the restart too
  const shell = await shellCore();
  const again = makeCore({ storage: shell.storage, caches: shell.caches, fetch: shellFetch() });
  const site = await serve(again.core, frameNav('/', { resultingClientId: 'frame-9' }));
  assert.equal(site.status, 200);
  assert.match(await text(site), /<h1>Home<\/h1>/);
});

test('D4 cold start: a drop-in subresource waits at most 40 ms for the index, then the host answers; a shell origin waits for the index', async () => {
  const t = exampleSite();
  const slow = (storage, ms) => Object.assign(storage, {
    listSites: () => new Promise((r) => setTimeout(() => r(Array.from(storage.sites.values())), ms)),
  });
  const storage = slow(memoryStorage(), 400);
  storeSite(storage, t);
  storage.meta.set('clients', { 'page-1': t.infoHash });
  const fetch = fetchStub({ [ORIGIN + '/css/app.css']: new Response('host copy', { headers: { 'Content-Type': 'text/css' } }) });
  const { core } = makeCore({ storage, fetch });
  const event = ev('/css/app.css', { clientId: 'page-1', destination: 'style' });
  assert.equal(core.owns(event), true, 'right after a cold start the worker takes the request and decides within the bound');
  const t0 = Date.now();
  const res = await core.handle(event);
  const ms = Date.now() - t0;
  assert.equal(await text(res), 'host copy', 'passed through to the host');
  assert.ok(ms < 300, 'answered after about 40 ms, not after the 400 ms index read (' + ms + ' ms)');
  // after the index is in, the same request comes from IndexedDB
  await core.init();
  const warm = await serve(core, ev('/css/app.css', { clientId: 'page-1', destination: 'style' }));
  assert.equal(await text(warm), 'body { color: red }');

  // shell origin: the mode mark says shell, so the frame's subresource waits for the index
  const shell = await shellCore();
  const sStorage = slow(shell.storage, 150);
  const cold = makeCore({ storage: sStorage, caches: shell.caches, fetch: fetchStub() });
  const sub = await cold.core.handle(ev('/css/app.css', { clientId: 'frame-1', destination: 'style' }));
  assert.equal(await text(sub), 'body { color: red }', 'served from the torrent copy, never the host shell');
});

test('D4 no-store: a drop-in page answered Cache-Control: no-store is never kept and is told to run host-only', async () => {
  const t = exampleSite();
  const page = (cc) => () => new Response('<!doctype html><html><head><meta name="mw-pointer" content="v=mw1; btih=' + t.infoHash + '"></head><body>p</body></html>', {
    headers: Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, cc ? { 'Cache-Control': cc } : {}),
  });
  const storage = memoryStorage();
  storeSite(storage, t);
  const fetch = fetchStub({ [ORIGIN + '/account.html']: page('private, no-store'), [ORIGIN + '/blog.html']: page(null) });
  const { core } = makeCore({ storage, fetch });
  await core.init();
  await serve(core, nav('/account.html', { resultingClientId: 'c-nostore' }));
  await serve(core, nav('/blog.html', { resultingClientId: 'c-plain' }));
  assert.equal(storage.calls.some((c) => c[0] === 'putDoc' && c[1].endsWith('/account.html')), false, 'a no-store page is never kept');
  assert.equal(storage.calls.some((c) => c[0] === 'putDoc' && c[1].endsWith('/blog.html')), true);
  const a = await send(core, { proto: PROTO, type: 'mw-map-client', btih: t.infoHash }, { source: { id: 'c-nostore' } });
  assert.deepEqual(a.replies[0].doc, { noStore: true });
  const b = await send(core, { proto: PROTO, type: 'mw-map-client', btih: t.infoHash }, { source: { id: 'c-plain' } });
  assert.deepEqual(b.replies[0].doc, { noStore: false });
  const unknown = await send(core, { proto: PROTO, type: 'mw-doc-info' }, { source: { id: 'never-seen' } });
  assert.equal(unknown.replies[0].doc, null, 'a page the worker did not see assumes ordinary');
  const info = await send(core, { proto: PROTO, type: 'mw-doc-info' }, { source: { id: 'c-nostore' } });
  assert.deepEqual(info.replies[0].doc, { noStore: true });
});

test('D4 web-seed rewrite: one host fetch for concurrent pieces of a path, no-store answers are not kept, Range is forwarded for large files', async () => {
  const data = bytes(50000);
  const host = (cc) => () => new Response(data, { headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, cc ? { 'Cache-Control': cc } : {}) });
  const t = exampleSite();
  const mapped = async (fetch, extra = {}) => {
    const storage = memoryStorage();
    storeSite(storage, t);
    const made = makeCore(Object.assign({ storage, fetch }, extra));
    await made.core.init();
    await send(made.core, { proto: PROTO, type: 'mw-map-client', clientId: 'p', btih: t.infoHash });
    return made;
  };
  const fetch = fetchStub({ [ORIGIN + '/media/clip.bin']: host(null) });
  const { core } = await mapped(fetch);
  const ranges = ['bytes=0-16383', 'bytes=16384-32767', 'bytes=32768-49999', 'bytes=100-199'];
  const answers = await Promise.all(ranges.map((r) => serve(core, ev('/_mw/ws/site/media/clip.bin', { clientId: 'p', headers: { range: r } }))));
  assert.deepEqual(answers.map((r) => r.status), [206, 206, 206, 206]);
  assert.equal(fetch.count(ORIGIN + '/media/clip.bin'), 1, 'concurrent requests for one path share one host download');
  assert.equal((await answers[3].arrayBuffer()).byteLength, 100);
  await serve(core, ev('/_mw/ws/site/media/clip.bin', { clientId: 'p', headers: { range: 'bytes=0-9' } }));
  assert.equal(fetch.count(ORIGIN + '/media/clip.bin'), 1, 'a later piece within the blob cache window reuses it');

  const noStore = fetchStub({ [ORIGIN + '/media/clip.bin']: host('no-store') });
  const ns = await mapped(noStore);
  await serve(ns.core, ev('/_mw/ws/site/media/clip.bin', { clientId: 'p', headers: { range: 'bytes=0-9' } }));
  await serve(ns.core, ev('/_mw/ws/site/media/clip.bin', { clientId: 'p', headers: { range: 'bytes=10-19' } }));
  assert.equal(noStore.count(ORIGIN + '/media/clip.bin'), 2, 'a no-store answer is never kept by the worker');

  // a file above webseedWholeMaxBytes: the Range goes to the host (206 passed on); a host that answers 200 falls back to slicing
  const storage = memoryStorage();
  storeSite(storage, t);
  const ranged = fetchStub({
    [ORIGIN + '/media/clip.bin']: (input, init) => {
      const r = init && init.headers && init.headers.range;
      if (r === 'bytes=0-99') return new Response(data.subarray(0, 100), { status: 206, headers: { 'Content-Range': 'bytes 0-99/40000', 'Content-Length': '100' } });
      return new Response(data.subarray(0, 40000));
    },
  });
  const big = makeCore({ storage, fetch: ranged, limits: { webseedWholeMaxBytes: 1000 } });
  await big.core.init();
  await send(big.core, { proto: PROTO, type: 'mw-map-client', clientId: 'p', btih: t.infoHash });
  const fwd = await serve(big.core, ev('/_mw/ws/site/media/clip.bin', { clientId: 'p', headers: { range: 'bytes=0-99' } }));
  assert.equal(fwd.status, 206);
  assert.equal(fwd.headers.get('content-range'), 'bytes 0-99/40000');
  const sent = ranged.calls.find((c) => c.init && c.init.headers && c.init.headers.range);
  assert.equal(sent.init.headers.range, 'bytes=0-99', 'the Range was forwarded');
  const fallback = await serve(big.core, ev('/_mw/ws/site/media/clip.bin', { clientId: 'p', headers: { range: 'bytes=200-299' } }));
  assert.equal(fallback.status, 206, 'a 200 for the forwarded Range: sliced from the whole file');
  assert.equal(fallback.headers.get('content-range'), 'bytes 200-299/40000');
});

test('v0.2.1 A3: a drop-in page stamped with a withdrawal is neither mapped nor kept; its requests go to the host', async () => {
  const t = exampleSite();
  const page = (stamp) => () => new Response('<!doctype html><html><head><meta name="mw-pointer" content="' + stamp + '"></head><body>p</body></html>', {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
  const storage = memoryStorage();
  storeSite(storage, t);
  const fetch = fetchStub({
    [ORIGIN + '/gone.html']: page('v=mw1; st=withdrawn; btih=' + t.infoHash),
    [ORIGIN + '/live.html']: page('v=mw1; btih=' + t.infoHash),
    [ORIGIN + '/css/app.css']: new Response('host copy', { headers: { 'Content-Type': 'text/css' } }),
  });
  const { core } = makeCore({ storage, fetch });
  await core.init();
  // The page reads its document before the worker's background work settles (a cancelled tee()
  // branch settles only once the page's branch is read), as in a browser.
  const open = async (path, id) => {
    const event = nav(path, { resultingClientId: id });
    assert.equal(core.owns(event), true);
    const body = await text(await core.handle(event));
    await event.settled();
    return body;
  };
  assert.match(await open('/gone.html', 'c-gone'), /st=withdrawn/);
  assert.match(await open('/live.html', 'c-live'), /<body>p/);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(storage.calls.some((c) => c[0] === 'putDoc' && c[1].endsWith('/gone.html')), false, 'a withdrawn page is never kept');
  assert.equal(storage.calls.some((c) => c[0] === 'putDoc' && c[1].endsWith('/live.html')), true);
  assert.equal(core.owns(ev('/css/app.css', { clientId: 'c-gone', destination: 'style' })), false, 'the withdrawn page is not mapped: the browser asks the host, never the stored copy');
  const live = await serve(core, ev('/css/app.css', { clientId: 'c-live', destination: 'style' }));
  assert.equal(await text(live), 'body { color: red }');
});

// Code review round 1: the drop-in web-seed rewrite never re-serves an arbitrary host URL.
test('web-seed rewrite: navigations are not ours; only paths of the mapped version\'s torrent are fetched; answers are opaque bytes', async () => {
  const t = buildTorrent([
    { path: 'about.html', data: '<!doctype html><title>About</title>' },
    { path: 'a.txt', data: bytes(16000) },
    { path: '.pad/384', data: new Uint8Array(384), pad: true },
    { path: 'b.txt', data: bytes(9000, 3) },
  ], { name: 'site' });
  const host = (path, body) => [ORIGIN + path, () => new Response(body, { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': "script-src 'self'" } })];
  const fetch = fetchStub(Object.fromEntries([
    host('/about.html', '<!doctype html><title>About</title>'),
    host('/secret.html', '<!doctype html>secret'),
    host('/a.txt', bytes(16000)),
    [ORIGIN + '/_mw/t/' + t.infoHash + '.torrent', () => new Response(t.torrentFile)],
  ]));
  const { core } = makeCore({ fetch });
  await core.init();
  // A top-level navigation (or a frame, worker or manifest load) of the rewrite is not owned at all.
  for (const e of [nav('/_mw/ws/site/about.html'), frameNav('/_mw/ws/site/about.html'), ev('/_mw/ws/site/about.html', { destination: 'worker' }), ev('/_mw/ws/site/about.html', { destination: 'manifest' })]) {
    assert.equal(core.owns(e), false, e.request.destination);
  }
  // No client mapping: 404, and the host is never asked.
  const unmapped = await serve(core, ev('/_mw/ws/site/about.html', { clientId: 'stranger' }));
  assert.equal(unmapped.status, 404);
  await send(core, { proto: PROTO, type: 'mw-map-client', clientId: 'p', btih: t.infoHash });
  const listed = await serve(core, ev('/_mw/ws/site/about.html', { clientId: 'p' }));
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get('content-type'), 'application/octet-stream', 'never text/html through the rewrite');
  assert.equal(listed.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(listed.headers.get('content-security-policy'), "sandbox; default-src 'none'");
  assert.equal(listed.headers.get('cross-origin-resource-policy'), 'same-origin');
  const secret = await serve(core, ev('/_mw/ws/site/secret.html', { clientId: 'p' }));
  assert.equal(secret.status, 404, 'a path the torrent does not list');
  assert.equal(fetch.count(ORIGIN + '/secret.html'), 0, 'and it is never fetched from the host');
  const otherName = await serve(core, ev('/_mw/ws/other/about.html', { clientId: 'p' }));
  assert.equal(otherName.status, 404, 'the torrent name must match');
  // BEP 47: the pad file is zeros, never asked of the host.
  const pad = await serve(core, ev('/_mw/ws/site/.pad/384', { clientId: 'p', headers: { range: 'bytes=0-99' } }));
  assert.equal(pad.status, 206);
  assert.deepEqual(new Uint8Array(await pad.arrayBuffer()), new Uint8Array(100));
  assert.equal(fetch.calls.some((c) => /\.pad/.test(c.url)), false);
  // The torrent fetched for a first download must hash to the mapped btih.
  const evil = buildTorrent([{ path: 'secret.html', data: 'x' }], { name: 'site' });
  const lying = fetchStub({ [ORIGIN + '/_mw/t/' + t.infoHash + '.torrent']: () => new Response(evil.torrentFile), [ORIGIN + '/secret.html']: () => new Response('secret') });
  const l = makeCore({ fetch: lying });
  await l.core.init();
  await send(l.core, { proto: PROTO, type: 'mw-map-client', clientId: 'p', btih: t.infoHash });
  assert.equal((await serve(l.core, ev('/_mw/ws/site/secret.html', { clientId: 'p' }))).status, 404);
  assert.equal(lying.count(ORIGIN + '/secret.html'), 0);
});

test('code review round 1: /_mw/webtorrent.min.js whose bytes do not match the build is neither cached nor served; matching bytes are', async () => {
  const good = '/* webtorrent 3.0.21, patched */';
  const map = Object.assign({}, CRITICAL, { '/_mw/webtorrent.min.js': sri(good) });
  const url = ORIGIN + '/_mw/webtorrent.min.js';
  // A stale CDN copy (other bytes): 502, nothing kept, the next request fetches again.
  const stale = fetchStub({ [url]: new Response('/* an older bundle */', { headers: { 'Content-Type': 'text/javascript' } }) });
  const s = makeCore({ fetch: stale, integrity: map, precache: ['/index.html', '/_mw/boot.js', '/_mw/loader.js', '/_mw/sdk.js'] });
  const bad = await serve(s.core, ev('/_mw/webtorrent.min.js', { destination: 'script' }));
  assert.equal(bad.status, 502);
  assert.equal(await s.caches.match(url, { cacheName: SHELL_CACHE_PREFIX + 'test' }), undefined, 'not kept');
  assert.equal(s.core.inspect().assetsRefused, 1);
  await serve(s.core, ev('/_mw/webtorrent.min.js', { destination: 'script' }));
  assert.equal(stale.count(url), 2, 'asked again, never answered from a cache');
  // The right bytes: served and kept, then answered from the cache.
  const right = fetchStub({ [url]: new Response(good, { headers: { 'Content-Type': 'text/javascript' } }) });
  const g = makeCore({ fetch: right, integrity: map, precache: ['/index.html', '/_mw/boot.js', '/_mw/loader.js', '/_mw/sdk.js'] });
  const ok = await serve(g.core, ev('/_mw/webtorrent.min.js', { destination: 'script' }));
  assert.equal(ok.status, 200);
  assert.equal(await text(ok), good);
  assert.equal(ok.headers.get('content-type'), 'text/javascript');
  const again = await serve(g.core, ev('/_mw/webtorrent.min.js', { destination: 'script' }));
  assert.equal(await text(again), good);
  assert.equal(right.count(url), 1, 'the second request came from the cache');
});

test('code review round 1 (F47): the install precaches only the files of the mode /index.html shows', async () => {
  const precache = ['/index.html', '/_mw/boot.js', '/_mw/loader.js', '/_mw/mw.js', '/_mw/pow-worker.js', '/_mw/sdk.js', '/_mw/sw-core.js', '/_mw/ui.css'];
  const routes = () => {
    const r = {};
    for (const p of precache) r[ORIGIN + p] = new Response('/* ' + p + ' */', { headers: { 'Content-Type': p.endsWith('.css') ? 'text/css' : 'text/javascript' } });
    return r;
  };
  // A drop-in site: /index.html is the site's own page. No shell loader, no ui.css, no boot.js.
  const dropinRoutes = routes();
  dropinRoutes[ORIGIN + '/index.html'] = new Response('<!doctype html><title>Home</title><script type="module" src="/_mw/mw.js" async></script>', { headers: { 'Content-Type': 'text/html' } });
  const d = makeCore({ fetch: fetchStub(dropinRoutes), precache });
  await d.core.install(installEvent());
  const fetched = d.fetch.calls.map((c) => c.url.slice(ORIGIN.length));
  assert.equal(fetched.includes('/_mw/loader.js'), false, 'a drop-in install never downloads the shell loader');
  assert.equal(fetched.includes('/_mw/boot.js'), false);
  assert.equal(fetched.includes('/_mw/ui.css'), false);
  assert.deepEqual(d.caches.paths(SHELL_CACHE_PREFIX + 'test').filter((p) => !p.startsWith('/_mw/__')).sort(), ['/_mw/mw.js', '/_mw/pow-worker.js', '/_mw/sdk.js']);
  assert.equal(d.core.inspect().installMode, 'dropin');
  assert.equal(fetched.filter((u) => u === '/index.html').length, 1, 'one /index.html fetch decides the mode');
  // A shell: no mw.js, no sw-core.js.
  const shellRoutes = routes();
  shellRoutes[ORIGIN + '/index.html'] = new Response(SHELL_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  const s = makeCore({ fetch: fetchStub(shellRoutes), precache });
  await s.core.install(installEvent());
  const sf = s.fetch.calls.map((c) => c.url.slice(ORIGIN.length));
  assert.equal(sf.includes('/_mw/mw.js'), false, 'a shell install never downloads the drop-in runtime');
  assert.equal(sf.includes('/_mw/sw-core.js'), false);
  assert.ok(s.caches.paths(SHELL_CACHE_PREFIX + 'test').includes('/index.html'), 'the shell itself is kept');
  assert.equal(s.core.inspect().installMode, 'shell');
  // /index.html does not answer: everything, as before.
  const offRoutes = routes();
  delete offRoutes[ORIGIN + '/index.html'];
  const u = makeCore({ fetch: fetchStub(offRoutes), precache });
  await u.core.install(installEvent());
  assert.equal(u.core.inspect().installMode, null);
  assert.ok(u.fetch.calls.some((c) => c.url === ORIGIN + '/_mw/loader.js') && u.fetch.calls.some((c) => c.url === ORIGIN + '/_mw/mw.js'));
});

// ---------------------------------------------------------------------------------------------
// v0.3 (R 2.3.1, 2.8.5, 2.9.6; lane media): reserved routes before the catch-all, /_mw/idp-return,
// COOP and Referrer-Policy on navigation responses the worker builds, session messages
// ---------------------------------------------------------------------------------------------

function sessionPort(data) {
  const port = {
    onmessage: null,
    replies: [],
    postMessage(m) {
      if (m.type === 'mw-ack') {
        port.replies.push(m);
        return;
      }
      if (m.type !== 'mw-chunk-need') return;
      const slice = data.slice(m.i * 4096, Math.min(data.length, (m.i + 1) * 4096));
      setTimeout(() => port.onmessage && port.onmessage({ data: { type: 'mw-chunk', req: m.req, i: m.i, data: slice.buffer } }), 0);
    },
  };
  return port;
}

test('v0.3 reserved routes: /_mw/f/<id> and /_mw/media/<sid> are answered before the navigation catch-all and the asset cache', async () => {
  const { core } = await shellCore();
  const data = te.encode('<!doctype html><script>alert(1)</script>');
  const port = sessionPort(data);
  const sid = 'cd'.repeat(16);
  const r = await send(core, { proto: PROTO, type: 'mw-session-register', sid, kind: 'file', file: { name: 'x.html', size: data.length, block: 4096 } }, { source: { id: 'shell-1' }, port: false });
  assert.equal(r.handled, true);
  // the reply went to ports[0], absent here: register again with the port
  const waits = [];
  core.message({ data: { proto: PROTO, type: 'mw-session-register', sid, kind: 'file', file: { name: 'x.html', size: data.length, block: 4096 } }, source: { id: 'shell-1' }, ports: [port], waitUntil: (p) => waits.push(p) });
  for (const w of waits) await w;
  assert.equal(port.replies[0].ok, true);
  assert.equal(port.replies[0].of, 'mw-session-register');
  const top = await serve(core, nav('/_mw/f/' + sid, { resultingClientId: 'dl-1' }));
  assert.equal(top.status, 200);
  assert.equal(top.headers.get('Content-Type'), 'application/octet-stream');
  assert.match(top.headers.get('Content-Disposition'), /^attachment; filename\*=UTF-8''x\.html$/);
  assert.equal(await text(top), new TextDecoder().decode(data), 'the file, not the shell');
  const frame = await serve(core, frameNav('/_mw/f/' + sid, { resultingClientId: 'f-1' }));
  assert.equal(frame.headers.get('Content-Security-Policy'), "sandbox; default-src 'none'");
  const gone = await serve(core, ev('/_mw/media/' + 'ef'.repeat(16)));
  assert.equal(gone.status, 410, 'no session: gone, never the asset cache or the site');
  const closed = await send(core, { proto: PROTO, type: 'mw-session-close', sid });
  assert.equal(closed.replies[0].closed, 1);
  assert.equal(core.inspect().media.sessions, 0);
});

test('v0.3 /_mw/idp-return: the loader document in shell mode, a minimal drop-in page otherwise; COOP same-origin-allow-popups', async () => {
  const { core } = await shellCore();
  const res = await serve(core, nav('/_mw/idp-return', { resultingClientId: 'r-1' }));
  assert.equal(res.status, 200);
  assert.match(await text(res), /\/_mw\/boot\.js/, 'the loader shell');
  assert.equal(res.headers.get('Cross-Origin-Opener-Policy'), 'same-origin-allow-popups');
  assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer');
  const dropin = makeCore({ foreign: true });
  const d = await serve(dropin.core, nav('/_mw/idp-return'));
  assert.equal(d.status, 200);
  assert.match(await text(d), /<script type="module" src="\/_mw\/mw\.js"><\/script>/);
  assert.equal(d.headers.get('Cross-Origin-Opener-Policy'), 'same-origin-allow-popups');
  assert.equal(d.headers.get('X-Frame-Options'), 'DENY');
});

test('v0.3 navigation responses the worker builds carry COOP same-origin-allow-popups and Referrer-Policy no-referrer', async () => {
  const { core } = await shellCore();
  const top = await serve(core, nav('/about', { resultingClientId: 's-9' }));
  assert.equal(top.headers.get('Cross-Origin-Opener-Policy'), 'same-origin-allow-popups');
  assert.equal(top.headers.get('Referrer-Policy'), 'no-referrer');
  const frame = await serve(core, frameNav('/', { resultingClientId: 'frame-9' }));
  assert.equal(frame.headers.get('Cross-Origin-Opener-Policy'), 'same-origin-allow-popups');
  const css = await serve(core, ev('/css/app.css', { clientId: 'frame-9', destination: 'style' }));
  assert.equal(css.headers.get('Cross-Origin-Opener-Policy'), null, 'subresources are not navigations');
  // a site whose routing manifest sets its own COOP (cross-origin isolation) keeps it on the shell
  const isolated = buildTorrent([
    { path: '.mw/site.json', data: JSON.stringify({ index: 'index.html', headers: [{ for: '/*', values: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } }] }) },
    { path: 'index.html', data: '<!doctype html><title>iso</title>' },
  ]);
  const iso = await shellCore({ torrent: isolated });
  const shell = await serve(iso.core, nav('/', { resultingClientId: 'iso-1' }));
  assert.equal(shell.headers.get('Cross-Origin-Opener-Policy'), 'same-origin', 'the routing manifest wins');
  // the worker's own pages (offline, interstitial) carry it too
  const off = makeCore({ fetch: async () => { throw new TypeError('offline'); } });
  const page = await serve(off.core, nav('/x'));
  assert.equal(page.headers.get('Cross-Origin-Opener-Policy'), 'same-origin-allow-popups');
});

test('code review v0.3 round 2: a message the worker could not read (messageerror) is reported to the sending page at once', async () => {
  const { core } = makeCore();
  const got = [];
  assert.equal(core.messageError({ data: null, source: { postMessage: (m) => got.push(m) }, ports: [] }), true);
  assert.deepEqual(got, [{ proto: PROTO, type: 'mw-message-error' }]);
  assert.equal(core.messageError({ data: null, source: null, ports: [] }), false, 'no client to tell');
  const sw = readFileSync(new URL('../../src/sw/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /addEventListener\('messageerror', \(event\) => \{\n {2}core\.messageError\(event\);/, 'the worker listens for it');
});
