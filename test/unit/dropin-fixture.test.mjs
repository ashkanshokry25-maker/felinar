// Unit tests for examples/existing-site-dropin: the fixture is what the drop-in end-to-end tests run
// against, so its own promises are checked here without a browser: the staged layouts, root-relative
// references that resolve, the router and data script in a sandbox, both hand-written Service
// Workers in a fake worker scope, the static host emulator (redirects, SPA rewrite, headers, 404,
// ranges, outage, redeploy), and the whole chain fixture -> publish --dropin -> stamped pages that
// src/dropin/stamp.js verifies. Only 127.0.0.1 servers, closed in after().
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import { stage, applyVersion2, FIXTURE_DIR, MW_TAG, VARIANTS } from '../fixtures/existing-site-dropin/stage.mjs';
import { createHost } from '../fixtures/existing-site-dropin/host.mjs';
import { parseRedirects, parseHeaders, stampedPointerFromHtml, normalizeManifest, applyRouting } from '../../src/sw/lib.js';
import { createCore } from '../../src/sw/core.js';
import { publish } from '../../tools/publish.mjs';
import { keygen } from '../../tools/keygen.mjs';
import { parseTorrentFile } from '../../src/common/torrent-file.js';
import { evaluateStamp } from '../../src/dropin/stamp.js';

const work = mkdtempSync(join(tmpdir(), 'mw-fixture-test-'));
const hosts = [];
after(async () => {
  for (const h of hosts) await h.close();
  rmSync(work, { recursive: true, force: true });
});

let n = 0;
const fresh = (label) => join(work, label + '-' + ++n);
const read = (dir, rel) => readFileSync(join(dir, ...rel.split('/')), 'utf8');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const MAIN_FILES = ['404.html', '_headers', '_redirects', 'about.html', 'app.html', 'blog/post-1.html', 'css/app.3f2a1b.css', 'data.json', 'img/logo.png', 'index.html', 'js/app.9c0d2e.js', 'js/chunk.5e7f1a.js'];
const PAGES = ['index.html', 'about.html', 'blog/post-1.html', 'app.html', '404.html'];

// ---------------------------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------------------------

test('stage(main): the multi-page site root, without the variants, tooling or notes', () => {
  const s = stage('main', fresh('main'));
  assert.deepEqual(s.files, MAIN_FILES);
  assert.equal(s.version, 1);
  assert.equal(s.changes, null);
  assert.deepEqual(VARIANTS, ['main', 'with-own-sw', 'with-own-sw-integrated']);
  assert.throws(() => stage('nope', fresh('x')), /unknown fixture variant/);
  assert.throws(() => stage('main', fresh('x'), { version: 3 }), /unknown fixture version/);
  assert.throws(() => stage('with-own-sw', fresh('x'), { version: 2 }), /main site only/);
});

test('stage(variants): a complete site root with its own /sw.js and the shared assets', () => {
  for (const variant of ['with-own-sw', 'with-own-sw-integrated']) {
    const s = stage(variant, fresh(variant));
    assert.deepEqual(s.files, ['404.html', 'css/app.3f2a1b.css', 'data.json', 'img/logo.png', 'index.html', 'js/app.9c0d2e.js', 'js/register-sw.js', 'sw.js'], variant);
    assert.ok(read(s.dir, 'index.html').includes(MW_TAG), variant + ' loads the drop-in runtime');
    assert.ok(read(s.dir, 'js/register-sw.js').includes("register('/sw.js', { scope: '/' }"), variant);
  }
});

test('stage({ plain }): the site as it was before the script tag was added', () => {
  const s = stage('main', fresh('plain'), { plain: true });
  for (const page of PAGES) assert.ok(!read(s.dir, page).includes('/_mw/mw.js'), page);
  const withTag = stage('main', fresh('tagged'));
  for (const page of PAGES) {
    const html = read(withTag.dir, page);
    assert.equal(html.split(MW_TAG).length - 1, 1, page + ' carries the tag exactly once');
    assert.ok(html.indexOf(MW_TAG) < html.indexOf('</head>'), page + ': in <head>');
  }
});

test('every root-relative reference of every page resolves to a staged file, and names are content-hash style', () => {
  const s = stage('main', fresh('refs'));
  const have = new Set(s.files);
  const redirects = parseRedirects(read(s.dir, '_redirects'));
  const rewritten = (path) => redirects.some((r) => r.status === 200 && new RegExp('^' + r.from.replace('*', '.*') + '$').test(path));
  for (const page of PAGES) {
    const html = read(s.dir, page);
    for (const m of html.matchAll(/(?:src|href|data-src)="([^"]+)"/g)) {
      const url = m[1];
      if (/^(https?:|mailto:|#)/.test(url) || url.startsWith('/_mw/')) continue;
      const base = new URL('http://site.test/' + page);
      const path = new URL(url, base).pathname;
      const rel = path.slice(1);
      assert.ok(have.has(rel) || path === '/' || rewritten(path) || redirects.some((r) => r.from === path), page + ' -> ' + url + ' is neither a file, a rewrite nor a redirect');
    }
  }
  assert.match(MAIN_FILES.join(' '), /css\/app\.3f2a1b\.css/);
  assert.ok(MAIN_FILES.includes('js/app.9c0d2e.js'));
  assert.ok(read(s.dir, 'blog/post-1.html').includes('href="../about.html"'), 'a page-relative link stays in the fixture');
  assert.ok(read(s.dir, 'index.html').includes('<noscript>'), 'JS-off parity has visible text to compare');
});

test('_redirects and _headers: the SPA rewrite for /app/*, a 301, immutable assets, a header on everything', () => {
  const s = stage('main', fresh('hosts'));
  const redirects = parseRedirects(read(s.dir, '_redirects'));
  assert.deepEqual(redirects.map((r) => [r.from, r.to, r.status]), [['/app/*', '/app.html', 200], ['/old-about', '/about.html', 301]]);
  const headers = parseHeaders(read(s.dir, '_headers'));
  assert.deepEqual(headers.map((h) => h.for), ['/*', '/css/*', '/js/*', '/data.json']);
  assert.equal(headers[0].values['X-Fixture-Host'], 'existing-site');
  assert.match(headers[1].values['Cache-Control'], /immutable/);
  const routing = normalizeManifest({ redirects: read(s.dir, '_redirects'), headers: read(s.dir, '_headers'), notFound: '404.html' });
  const has = (p) => s.files.includes(p);
  assert.deepEqual([applyRouting(routing, '/app/items/42', has).path, applyRouting(routing, '/app/items/42', has).status], ['app.html', 200]);
  assert.equal(applyRouting(routing, '/old-about', has).redirect, '/about.html');
  assert.equal(applyRouting(routing, '/nope', has).status, 404);
});

test('applyVersion2: new content under the same URL (data.json), renamed hashed files, untouched ones, updated pages', () => {
  const s = stage('main', fresh('v2'), { version: 2 });
  assert.deepEqual(s.changes, { changed: ['data.json'], renamed: { 'css/app.3f2a1b.css': 'css/app.8d1e44.css', 'js/chunk.5e7f1a.js': 'js/chunk.b63d90.js' }, unchanged: ['js/app.9c0d2e.js', 'img/logo.png'] });
  assert.ok(!s.files.includes('css/app.3f2a1b.css') && s.files.includes('css/app.8d1e44.css'));
  assert.ok(!s.files.includes('js/chunk.5e7f1a.js') && s.files.includes('js/chunk.b63d90.js'));
  const v1 = stage('main', fresh('v1'));
  assert.equal(read(s.dir, 'js/app.9c0d2e.js'), read(v1.dir, 'js/app.9c0d2e.js'));
  assert.equal(sha256(readFileSync(join(s.dir, 'img/logo.png'))), sha256(readFileSync(join(v1.dir, 'img/logo.png'))));
  assert.notEqual(read(s.dir, 'data.json'), read(v1.dir, 'data.json'));
  assert.match(read(s.dir, 'data.json'), /"version": 2/);
  for (const page of PAGES) {
    const html = read(s.dir, page);
    assert.ok(!html.includes('3f2a1b') && !html.includes('5e7f1a'), page + ' points at the new names only');
  }
  assert.ok(read(s.dir, 'index.html').includes('data-src="/js/chunk.b63d90.js"'));
  assert.match(read(s.dir, 'index.html'), /<title>Existing Site: home \(v2\)<\/title>/);
  assert.match(read(s.dir, 'js/chunk.b63d90.js'), /'v2'/);
  assert.equal(typeof applyVersion2, 'function');
});

// ---------------------------------------------------------------------------------------------
// the page script in a sandbox
// ---------------------------------------------------------------------------------------------

function runPageScript({ page, pathname, data = { message: 'm', version: 1 }, dataStatus = 200 }) {
  const code = readFileSync(join(FIXTURE_DIR, 'js', 'app.9c0d2e.js'), 'utf8');
  const els = new Map();
  const mk = (id, attrs = {}) => {
    const el = { id, textContent: '', attrs, listeners: {}, getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }, addEventListener(t, f) { this.listeners[t] = f; }, closest(sel) { return sel === 'a[data-route]' && this.attrs['data-route'] !== undefined ? this : null; } };
    els.set(id, el);
    return el;
  };
  for (const id of ['path', 'data', 'view', 'chunk']) mk(id);
  mk('load-chunk', { 'data-src': '/js/chunk.5e7f1a.js' });
  const docListeners = {};
  const appended = [];
  const location = { pathname };
  const pushed = [];
  const winListeners = {};
  const sandbox = {
    location,
    history: { pushState(_s, _t, url) { pushed.push(url); location.pathname = url; } },
    fetch: async (url) => ({ ok: dataStatus === 200, status: dataStatus, json: async () => data, url }),
    console,
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = (t, f) => { winListeners[t] = f; };
  sandbox.document = {
    title: '',
    body: { getAttribute: (k) => (k === 'data-page' ? page : null) },
    documentElement: { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
    getElementById: (id) => els.get(id) || null,
    addEventListener: (t, f) => { docListeners[t] = f; },
    createElement: () => ({}),
    head: { appendChild: (el) => { appended.push(el); } },
  };
  vm.runInNewContext(code, sandbox);
  return { sandbox, els, docListeners, winListeners, appended, pushed, location };
}

test('page script: path, fetch(\'/data.json\') and the JS-on flag', async () => {
  const r = runPageScript({ page: 'home', pathname: '/blog/post-1.html', data: { message: 'hello', version: 2 } });
  assert.equal(r.sandbox.__fixture.jsRan, true);
  assert.equal(r.sandbox.__fixture.page, 'home');
  assert.equal(r.els.get('path').textContent, '/blog/post-1.html');
  assert.equal(r.sandbox.document.documentElement.attrs['data-js'], 'on');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(r.sandbox.__fixture.data, { message: 'hello', version: 2 });
  assert.equal(r.els.get('data').textContent, 'data.json says: hello (version 2)');
  assert.equal(r.sandbox.__fixture.errors.length, 0);
  const bad = runPageScript({ page: 'home', pathname: '/', dataStatus: 500 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.match(bad.sandbox.__fixture.errors[0], /^data\.json: HTTP 500/);
});

test('page script: the History-API router renders routes from the address bar, pushState and popstate', () => {
  for (const [pathname, route, id, label] of [['/app.html', 'home', null, 'App home'], ['/app/', 'home', null, 'App home'], ['/app/settings', 'settings', null, 'Settings'], ['/app/items/42', 'item', 42, 'Item 42'], ['/app/nope', 'not-found', null, 'No such route']]) {
    const r = runPageScript({ page: 'app', pathname });
    assert.equal(r.sandbox.__fixture.route, route, pathname);
    assert.equal(r.sandbox.__fixture.routeId, id, pathname);
    assert.equal(r.els.get('view').textContent, label, pathname);
    assert.equal(r.sandbox.__fixture.pathname, pathname, 'location.pathname is what the page sees');
  }
  const r = runPageScript({ page: 'app', pathname: '/app/' });
  const link = { attrs: { href: '/app/settings', 'data-route': '' }, getAttribute(k) { return this.attrs[k]; }, closest() { return this; } };
  let prevented = false;
  r.docListeners.click({ target: link, defaultPrevented: false, button: 0, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(r.pushed, ['/app/settings']);
  assert.equal(r.sandbox.__fixture.route, 'settings');
  assert.equal(r.els.get('path').textContent, '/app/settings');
  r.docListeners.click({ target: link, defaultPrevented: false, button: 0, metaKey: true, preventDefault() { throw new Error('modifier clicks are the browser\'s'); } });
  r.location.pathname = '/app/items/7';
  r.winListeners.popstate();
  assert.equal(r.sandbox.__fixture.route, 'item');
  assert.equal(r.sandbox.__fixture.routeId, 7);
  const other = runPageScript({ page: 'home', pathname: '/' });
  assert.equal(other.docListeners.click, undefined, 'only app.html has the router');
});

test('page script: the lazy chunk loads on demand from the button\'s data-src', () => {
  const r = runPageScript({ page: 'home', pathname: '/' });
  r.els.get('load-chunk').listeners.click();
  assert.equal(r.appended.length, 1);
  assert.equal(r.appended[0].src, '/js/chunk.5e7f1a.js');
  r.sandbox.__chunk = 'v1';
  r.appended[0].onload();
  assert.equal(r.sandbox.__fixture.chunk, 'v1');
  assert.equal(r.els.get('chunk').textContent, 'chunk loaded: v1');
  r.appended[0].onerror();
  assert.match(r.sandbox.__fixture.errors[0], /^chunk: failed to load/);
});

// ---------------------------------------------------------------------------------------------
// the hand-written Service Workers in a fake worker scope
// ---------------------------------------------------------------------------------------------

function runWorker(variant, { mwStub = null } = {}) {
  const code = readFileSync(join(FIXTURE_DIR, variant, 'sw.js'), 'utf8');
  const handlers = {};
  const order = [];
  const store = new Map();
  const cache = {
    async match(req) { return store.get(req.url) || undefined; },
    async put(req, res) { store.set(req.url, res); },
  };
  const self = {
    location: { origin: 'https://site.test' },
    clients: { claim: async () => { order.push('claim'); } },
    skipWaiting() { order.push('skipWaiting'); },
    addEventListener(type, fn) { order.push('listen:' + type); handlers[type] = fn; },
  };
  const net = { calls: [] };
  const scope = {
    self,
    URL,
    Response,
    caches: { open: async () => cache },
    fetch: async (req) => { net.calls.push(req.url); return new Response('/* css */', { status: 200 }); },
    importScripts(...urls) { order.push('import:' + urls.join(',')); if (mwStub) self.mw = mwStub(); },
  };
  vm.runInNewContext(code, scope);
  const fetchEvent = (url, method = 'GET') => {
    const ev = { request: { url, method }, responded: null, respondWith(p) { this.responded = p; } };
    handlers.fetch(ev);
    return ev;
  };
  return { handlers, order, net, store, fetchEvent, self };
}

test('with-own-sw/sw.js: cache-first for /css/*, a stats endpoint, everything else is left to the network', async () => {
  const w = runWorker('with-own-sw');
  assert.deepEqual(w.order, ['listen:install', 'listen:activate', 'listen:fetch']);
  w.handlers.install();
  let waited = null;
  w.handlers.activate({ waitUntil: (p) => { waited = p; } });
  await waited;
  assert.ok(w.order.includes('skipWaiting') && w.order.includes('claim'));

  const css1 = w.fetchEvent('https://site.test/css/app.3f2a1b.css');
  assert.ok(css1.responded, 'the worker answers /css/*');
  assert.equal(await (await css1.responded).text(), '/* css */');
  assert.equal(w.net.calls.length, 1);
  const css2 = w.fetchEvent('https://site.test/css/app.3f2a1b.css');
  assert.equal(await (await css2.responded).text(), '/* css */');
  assert.equal(w.net.calls.length, 1, 'the second request is a cache hit: cache-first');

  const stats = w.fetchEvent('https://site.test/__own-sw/stats');
  const body = await (await stats.responded).json();
  assert.deepEqual(body, { installs: 1, activations: 1, cssHits: 1, cssMisses: 1, other: 0 });

  assert.equal(w.fetchEvent('https://site.test/js/app.9c0d2e.js').responded, null, 'not its business: no respondWith, the browser goes to the network');
  assert.equal(w.fetchEvent('https://site.test/css/x.css', 'POST').responded, null);
  assert.equal(w.fetchEvent('https://cdn.test/css/x.css').responded, null, 'cross-origin requests are not touched');
  const after = await (await w.fetchEvent('https://site.test/__own-sw/stats').responded).json();
  assert.equal(after.other, 1);
});

test('with-own-sw-integrated/sw.js: importScripts first, then self.mw.owns(event) gets the first look; the rest runs unchanged', async () => {
  const owned = new Set(['https://site.test/css/app.3f2a1b.css']);
  const calls = [];
  const w = runWorker('with-own-sw-integrated', {
    mwStub: () => ({
      owns: (event) => { calls.push(['owns', event.request.url]); return owned.has(event.request.url); },
      handle: async (event) => { calls.push(['handle', event.request.url]); return new Response('from felinar'); },
    }),
  });
  assert.equal(w.order[0], 'import:/_mw/sw-core.js', 'importScripts is the first thing the worker does');
  const hit = w.fetchEvent('https://site.test/css/app.3f2a1b.css');
  assert.equal(await (await hit.responded).text(), 'from felinar');
  assert.equal(w.net.calls.length, 0, 'the site\'s own cache-first route did not run for a file felinar owns');
  const other = w.fetchEvent('https://site.test/css/other.css');
  assert.equal(await (await other.responded).text(), '/* css */', 'the site\'s own /css/* route still serves what felinar does not own');
  assert.equal(w.fetchEvent('https://site.test/data.json').responded, null);
  assert.deepEqual(calls.map((c) => c[0]), ['owns', 'handle', 'owns', 'owns']);
});

test('with-own-sw-integrated/sw.js against the real core: owns() is a synchronous boolean, handle() exists', () => {
  const real = createCore({ foreign: true, env: { origin: 'https://site.test', caches: null, clients: null, indexedDB: null, fetch: async () => new Response('x'), log() {} } });
  const w = runWorker('with-own-sw-integrated', { mwStub: () => real });
  const ev = { request: { url: 'https://site.test/css/app.3f2a1b.css', method: 'GET', mode: 'no-cors', destination: 'style', cache: 'default', referrer: 'https://site.test/' }, clientId: 'c1' };
  const owns = real.owns(ev);
  assert.equal(typeof owns, 'boolean');
  assert.equal(owns, false, 'a cold worker passes the request through (3.4.2: unsure means pass)');
  assert.equal(typeof real.handle, 'function');
  assert.ok(w.handlers.fetch);
});

// ---------------------------------------------------------------------------------------------
// the host emulator
// ---------------------------------------------------------------------------------------------

async function startHost(dir) {
  const host = await createHost({ root: dir });
  hosts.push(host);
  return host;
}

test('host: pages, the SPA rewrite for /app/*, the 301, 404.html with a 404, _headers, ranges, request log', async () => {
  const s = stage('main', fresh('hostA'));
  const host = await startHost(s.dir);
  const get = (path, init) => fetch(host.url + path.replace(/^\//, ''), init);
  const home = await get('/');
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('x-fixture-host'), 'existing-site', 'headers from _headers');
  assert.equal(home.headers.get('cache-control'), 'no-cache');
  assert.match(await home.text(), /<title>Existing Site: home<\/title>/);
  const deep = await get('/app/items/42');
  assert.equal(deep.status, 200);
  assert.match(await deep.text(), /data-page="app"/);
  const old = await get('/old-about', { redirect: 'manual' });
  assert.equal(old.status, 301);
  assert.equal(old.headers.get('location'), '/about.html');
  const missing = await get('/nope.html');
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /Existing Site: not found/);
  const css = await get('/css/app.3f2a1b.css');
  assert.match(css.headers.get('cache-control'), /immutable/);
  assert.match(css.headers.get('content-type'), /^text\/css/);
  const ranged = await get('/data.json', { headers: { range: 'bytes=0-4' } });
  assert.equal(ranged.status, 206);
  assert.equal(await ranged.text(), '{ "me');
  assert.equal((await get('/data.json', { headers: { range: 'bytes=9999-' } })).status, 416);
  assert.equal((await get('/index.html', { method: 'POST' })).status, 405);
  assert.equal((await get('/img/logo.png')).headers.get('content-type'), 'image/png');
  assert.ok(host.requests.some((r) => r.path === '/app/items/42' && r.status === 200));
  assert.ok(host.requests.some((r) => r.path === '/data.json' && r.range === 'bytes=0-4' && r.status === 206));
  host.clearLog();
  assert.equal(host.requests.length, 0);
  assert.equal((await get('/../../etc/passwd')).status, 404, 'no way out of the root');
});

test('host: an outage drops connections; a redeploy keeps the previous deploy\'s non-HTML files', async () => {
  const v1 = stage('main', fresh('hostV1'));
  const host = await startHost(v1.dir);
  assert.equal((await fetch(host.url + 'js/chunk.5e7f1a.js')).status, 200);
  host.down(true);
  await assert.rejects(fetch(host.url + 'index.html'));
  host.down(false);
  assert.equal((await fetch(host.url + 'index.html')).status, 200);

  const v2 = stage('main', fresh('hostV2'), { version: 2 });
  host.redeploy(v2.dir, { keepOld: true });
  assert.match(await (await fetch(host.url + 'index.html')).text(), /home \(v2\)/);
  assert.equal((await fetch(host.url + 'js/chunk.5e7f1a.js')).status, 200, 'the old chunk is still there for pages that are still open');
  assert.equal((await fetch(host.url + 'css/app.3f2a1b.css')).status, 200);
  assert.equal((await fetch(host.url + 'css/app.8d1e44.css')).status, 200);
  assert.match(await (await fetch(host.url + 'data.json')).text(), /"version": 2/, 'same URL, new content');
  host.redeploy(v2.dir, { keepOld: false });
  assert.equal((await fetch(host.url + 'js/chunk.5e7f1a.js')).status, 404, 'a clean deploy drops them');
  await assert.rejects(createHost({ root: join(work, 'nope') }), /no such directory/);
});

// ---------------------------------------------------------------------------------------------
// fixture -> publish --dropin -> stamped pages -> src/dropin/stamp.js
// ---------------------------------------------------------------------------------------------

function fakeDist() {
  const dist = fresh('dist');
  mkdirSync(join(dist, '_mw'), { recursive: true });
  writeFileSync(join(dist, 'mw-sw.js'), '// sw\n');
  writeFileSync(join(dist, 'mw-sw-kill.js'), '// kill\n');
  for (const f of ['boot.js', 'loader.js', 'mw.js', 'sw-core.js']) writeFileSync(join(dist, '_mw', f), '// ' + f + '\n');
  writeFileSync(join(dist, 'index.html'), '<!doctype html><html><head><title>x</title></head><body></body></html>');
  return dist;
}

async function publishFixture(site, key, dist, scope) {
  return publish({ dir: site.dir, name: 'existing-site', scope, key, tr: ['wss://tracker.example'], ws: [], dropin: true, dist, out: fresh('pub'), now: Date.now(), quiet: true });
}

test('publish --dropin of the fixture: HTML stays out of the torrent, every page is stamped for the host, routing and hashes are in /.mw', async () => {
  const key = join(work, 'owner.jwk');
  await keygen({ out: key });
  const dist = fakeDist();
  const v1 = stage('main', fresh('pubv1'));
  const res = await publishFixture(v1, key, dist, '127.0.0.1');
  const parsed = await parseTorrentFile(new Uint8Array(res.torrentFile));
  const paths = parsed.files.map((f) => f.path);
  assert.deepEqual(paths, ['.mw/files.json', '.mw/site.json', 'css/app.3f2a1b.css', 'data.json', 'img/logo.png', 'js/app.9c0d2e.js', 'js/chunk.5e7f1a.js']);
  assert.ok(!paths.some((p) => /\.html?$/.test(p)) && !paths.includes('_redirects') && !paths.includes('_headers'));
  const site = join(res.outDir, 'site');
  for (const page of PAGES) {
    const html = read(site, page);
    const stamped = stampedPointerFromHtml(html.slice(0, 4096));
    assert.ok(stamped, page);
    const verdict = await evaluateStamp({ text: stamped.raw, scope: '127.0.0.1', now: Date.now() });
    assert.equal(verdict.ok, true, page + ': ' + verdict.reason);
    assert.equal(verdict.record.btih, res.btih);
    assert.deepEqual(verdict.record.xs, ['/_mw/t/' + res.btih + '.torrent']);
    const wrong = await evaluateStamp({ text: stamped.raw, scope: 'evil.example', now: Date.now() });
    assert.equal(wrong.reason, 'bad-sig', 'a pointer copied to another host fails');
    assert.ok(html.includes(MW_TAG), page + ' keeps its script tag');
  }
  const manifest = JSON.parse(read(site, '.mw/site.json'));
  assert.ok(JSON.stringify(manifest).includes('/app/*'), 'the SPA rewrite travels with the site');
  const files = JSON.parse(read(site, '.mw/files.json'));
  assert.ok(files && typeof files === 'object');
  assert.ok(JSON.stringify(files).includes(sha256(readFileSync(join(v1.dir, 'js', 'app.9c0d2e.js')))), 'files.json carries the SHA-256 of each file');
});

test('publish --dropin of version 1 and 2: unchanged hashed files keep their hash, the rest differs; served by the host emulator', async () => {
  const key = join(work, 'owner2.jwk');
  await keygen({ out: key });
  const dist = fakeDist();
  const v1 = stage('main', fresh('chain1'));
  const v2 = stage('main', fresh('chain2'), { version: 2 });
  const r1 = await publishFixture(v1, key, dist, '127.0.0.1');
  const r2 = await publishFixture(v2, key, dist, '127.0.0.1');
  assert.notEqual(r1.btih, r2.btih);
  const f1 = JSON.stringify(JSON.parse(read(join(r1.outDir, 'site'), '.mw/files.json')));
  const f2 = JSON.stringify(JSON.parse(read(join(r2.outDir, 'site'), '.mw/files.json')));
  const appSha = sha256(readFileSync(join(v1.dir, 'js', 'app.9c0d2e.js')));
  assert.ok(f1.includes(appSha) && f2.includes(appSha), 'js/app.9c0d2e.js has the same SHA-256 in both versions: a new copy can reuse it');
  assert.notEqual(sha256(readFileSync(join(v1.dir, 'data.json'))), sha256(readFileSync(join(v2.dir, 'data.json'))));

  const host = await startHost(join(r1.outDir, 'site'));
  const torrent = await fetch(host.url + '_mw/t/' + r1.btih + '.torrent');
  assert.equal(torrent.status, 200, 'xs= is served by the host');
  assert.equal((await parseTorrentFile(new Uint8Array(await torrent.arrayBuffer()))).infoHash, r1.btih);
  assert.equal((await fetch(host.url + '.mw/files.json')).status, 200, '/.mw/files.json is a plain file on the host');
  assert.equal((await fetch(host.url + 'mw-sw.js')).headers.get('cache-control'), 'no-cache');
  const page = await (await fetch(host.url + 'app/settings')).text();
  assert.equal(stampedPointerFromHtml(page.slice(0, 4096)).btih, r1.btih, 'the SPA rewrite serves the stamped app.html');
  host.redeploy(join(r2.outDir, 'site'), { keepOld: true });
  assert.equal(stampedPointerFromHtml((await (await fetch(host.url + 'index.html')).text()).slice(0, 4096)).btih, r2.btih);
  assert.equal((await fetch(host.url + '_mw/t/' + r1.btih + '.torrent')).status, 200, 'the previous torrent stays for pages that are still open');
  assert.ok(readdirSync(join(r1.outDir, 'site')).includes('.nojekyll'));
  assert.ok(existsSync(join(r2.outDir, 'site', '_mw', 't', r2.btih + '.torrent')));
});
