// Unit tests for src/dropin/refresh.js and the engine step that uses it: when a new version of the
// site is fetched through the host's web seed (read with cache 'force-cache'), the files that
// changed since the stored previous version must be replaced in the HTTP cache first, or a stale
// entry would fail the piece hash and stall the download.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DropinEngine } from '../../src/dropin/engine.js';
import { parseFileList, changedPaths, refreshHttpCache, siteFileUrl } from '../../src/dropin/refresh.js';
import { ledgerIdFor, parsePointer } from '../../src/common/pointer.js';
import { createClock } from './dropin-fake-timers.mjs';
import { until, buildSite, SITE_FILES, newOwner, stampFor, memoryCache, putSite, chainModule, torrentModule, fakeServiceWorker, oursWorker, fakeWindow } from './dropin-fakes.mjs';

const sha = (c) => c.repeat(64);

test('parseFileList: /.mw/files.json into a map, junk skipped, hashes lowercased; anything else is null', () => {
  const m = parseFileList({ v: 1, files: [{ path: 'a.css', length: 3, sha256: sha('A') }, { path: 'b.js', length: '9', sha256: sha('b') }, { path: '', sha256: 'x' }, { sha256: 'x' }, null, { path: 'c', length: 1 }] });
  assert.deepEqual(Array.from(m.keys()), ['a.css', 'b.js']);
  assert.deepEqual(m.get('a.css'), { length: 3, sha256: sha('a') });
  assert.equal(m.get('b.js').length, 9);
  for (const bad of [null, undefined, 'x', 5, {}, { files: 'no' }]) assert.equal(parseFileList(bad), null);
});

test('changedPaths: new paths and changed hashes or lengths, not identical files, not /.mw/*, sorted', () => {
  const oldList = parseFileList({ files: [{ path: 'css/app.3f2a1b.css', length: 5, sha256: sha('a') }, { path: 'data.json', length: 4, sha256: sha('b') }, { path: 'img/logo.png', length: 9, sha256: sha('c') }, { path: 'gone.txt', length: 1, sha256: sha('d') }] });
  const newList = parseFileList({ files: [
    { path: 'css/app.8d1e44.css', length: 5, sha256: sha('e') }, // renamed: a new path
    { path: 'data.json', length: 4, sha256: sha('f') }, // same URL, new content
    { path: 'img/logo.png', length: 9, sha256: sha('c') }, // identical
    { path: 'js/chunk.js', length: 2, sha256: sha('g') },
    { path: 'size.txt', length: 8, sha256: sha('c') },
    { path: '.mw/site.json', length: 1, sha256: sha('h') },
  ] });
  assert.deepEqual(changedPaths(oldList, newList), ['css/app.8d1e44.css', 'data.json', 'js/chunk.js', 'size.txt']);
  assert.deepEqual(changedPaths(null, newList), ['css/app.8d1e44.css', 'data.json', 'img/logo.png', 'js/chunk.js', 'size.txt'], 'nothing known about the old version: everything');
  assert.deepEqual(changedPaths(oldList, null), []);
  const sameLengthChange = changedPaths(parseFileList({ files: [{ path: 'x', length: 1, sha256: sha('a') }] }), parseFileList({ files: [{ path: 'x', length: 2, sha256: sha('a') }] }));
  assert.deepEqual(sameLengthChange, ['x']);
});

test('siteFileUrl: same-origin URL with each segment percent-encoded', () => {
  assert.equal(siteFileUrl('https://site.test', 'css/app.3f2a1b.css'), 'https://site.test/css/app.3f2a1b.css');
  assert.equal(siteFileUrl('https://site.test/', 'my docs/café menu.pdf'), 'https://site.test/my%20docs/caf%C3%A9%20menu.pdf');
});

test('refreshHttpCache: every path with cache "reload", body read to the end, at most 4 at a time, failures recorded not thrown', async () => {
  const calls = [];
  let inFlight = 0;
  let peak = 0;
  const bodies = [];
  const fetchFn = async (url, init) => {
    calls.push([url, init.cache, init.credentials]);
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 3));
    inFlight--;
    if (url.endsWith('/bad.txt')) return { ok: false, status: 500, arrayBuffer: async () => { throw new Error('unused'); } };
    if (url.endsWith('/boom.txt')) throw new Error('network down');
    return { ok: true, arrayBuffer: async () => { bodies.push(url); return new ArrayBuffer(1); } };
  };
  const paths = ['a.css', 'b.js', 'bad.txt', 'boom.txt', 'c.png', 'd.json', 'e.txt', 'f.txt', 'g.txt'];
  const out = await refreshHttpCache({ fetchFn, origin: 'https://site.test', paths });
  assert.equal(out.refreshed, 7);
  assert.deepEqual(out.failed.sort(), ['bad.txt', 'boom.txt']);
  assert.equal(out.skipped, 0);
  assert.ok(peak <= 4 && peak >= 2, 'bounded concurrency: ' + peak);
  assert.ok(calls.every((c) => c[1] === 'reload' && c[2] === 'same-origin'));
  assert.equal(bodies.length, 7, 'bodies are read: that is what stores the fresh entry');
  const capped = await refreshHttpCache({ fetchFn, origin: 'https://site.test', paths: ['x1', 'x2', 'x3', 'x4'], maxFiles: 2 });
  assert.equal(capped.refreshed, 2);
  assert.equal(capped.skipped, 2);
  assert.deepEqual(await refreshHttpCache({ fetchFn, origin: 'https://site.test', paths: [] }), { refreshed: 0, failed: [], skipped: 0 });
  assert.deepEqual(await refreshHttpCache({ fetchFn, origin: 'https://site.test' }), { refreshed: 0, failed: [], skipped: 0 });
});

test('refreshHttpCache: a request that hangs is aborted at the timeout and counted as failed', async () => {
  const clock = createClock();
  const aborted = [];
  const fetchFn = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => { aborted.push(url); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
  });
  const p = refreshHttpCache({ fetchFn, origin: 'https://site.test', paths: ['slow.bin'], timeoutMs: 15000, setTimeoutFn: clock.setTimeout, clearTimeoutFn: clock.clearTimeout });
  await new Promise((r) => setTimeout(r, 5));
  clock.advance(15000);
  const out = await p;
  assert.deepEqual(out.failed, ['slow.bin']);
  assert.equal(aborted.length, 1);
  assert.equal(clock.pending(), 0);
});

// ---------------------------------------------------------------------------------------------
// the engine step
// ---------------------------------------------------------------------------------------------

async function engineWithPrevious({ previous = true, column = {} } = {}) {
  const oldList = { v: 1, name: 'existing-site', files: [
    { path: 'css/app.3f2a1b.css', length: 26, sha256: sha('a') },
    { path: 'data.json', length: 17, sha256: sha('b') },
    { path: 'js/app.9c0d2e.js', length: 25, sha256: sha('c') },
  ] };
  const newList = { v: 1, name: 'existing-site', files: [
    { path: 'css/app.3f2a1b.css', length: 26, sha256: sha('a') },
    { path: 'data.json', length: 17, sha256: sha('d') }, // changed under the same URL
    { path: 'js/app.9c0d2e.js', length: 25, sha256: sha('c') },
    { path: 'js/chunk.b63d90.js', length: 5, sha256: sha('e') }, // new
  ] };
  const oldSite = await buildSite([{ path: 'old.txt', data: 'previous version' }, { path: '.mw/files.json', data: JSON.stringify(oldList) }], { name: 'v1' });
  const site = await buildSite(SITE_FILES);
  const owner = await newOwner();
  const text = await stampFor({ owner, btih: site.infoHash });
  const ledgerId = await ledgerIdFor(parsePointer(text).record, 'site.test');
  const cache = memoryCache({ prefs: previous ? { ['versions:' + ledgerId]: [oldSite.infoHash] } : {} });
  if (previous) putSite(cache, oldSite);
  const worker = oursWorker();
  const win = fakeWindow(Object.assign({ stamp: text, serviceWorker: fakeServiceWorker({ controlOnRegister: worker }) }, column));
  const fetched = [];
  win.fetch = async (url, init = {}) => {
    fetched.push([String(url), init.cache || 'default']);
    if (String(url).endsWith('/.mw/files.json')) return new Response(JSON.stringify(newList), { status: 200 });
    return new Response('fresh', { status: 200 });
  };
  const chain = chainModule();
  const tmod = torrentModule(site);
  const order = [];
  const origDownload = tmod.TorrentManager.prototype.download;
  tmod.TorrentManager.prototype.download = async function (args) { order.push('download'); return origDownload.call(this, args); };
  const clock = createClock(Date.now());
  const deps = {
    cache: async () => cache, verify: () => import('../../src/loader/verify.js'), torrentFile: () => import('../../src/common/torrent-file.js'),
    crypto: () => import('../../src/chain/crypto.js'), torrent: async () => tmod, chain: async () => chain, webtorrent: async () => class WebTorrent {},
  };
  // swRecheckMs: 0 keeps these timelines; the empty-scope re-check has its own tests in dropin-swreg.
  const engine = new DropinEngine({ win, deps, options: { swRecheckMs: 0 }, timers: clock.timers() });
  const origRefresh = engine.refreshStale.bind(engine);
  engine.refreshStale = async () => { order.push('refresh'); return origRefresh(); };
  return { engine, win, fetched, order, clock, tmod, cache, site, oldSite };
}

async function boot(ctx) {
  const p = ctx.engine.start();
  await until(() => ctx.engine.state === 'ready' || ctx.engine.state === 'off', { label: 'evaluate' });
  if (ctx.engine.state === 'ready') ctx.clock.advance(200);
  await p;
  await until(() => ctx.engine.copy || ctx.engine.copyError, { label: 'copy or error' });
  if (ctx.engine.obtaining) await ctx.engine.obtaining;
}

test('engine: with a stored previous version, changed files and the routing manifest are refreshed with "reload" before the download', async () => {
  const ctx = await engineWithPrevious();
  await boot(ctx);
  assert.deepEqual(ctx.order, ['refresh', 'download'], 'refresh first');
  assert.deepEqual(ctx.fetched.filter((f) => f[1] === 'no-cache').map((f) => f[0]), ['/.mw/files.json'], 'the new file list is revalidated');
  assert.deepEqual(ctx.fetched.filter((f) => f[1] === 'reload').map((f) => f[0]).sort(), [
    'https://site.test/.mw/site.json', 'https://site.test/data.json', 'https://site.test/js/chunk.b63d90.js',
  ], 'the changed and the new file, and the manifest; unchanged hashed files are left in the HTTP cache');
  assert.ok(ctx.engine.logs.some((l) => /refreshed 3 changed file/.test(l)));
  assert.ok(ctx.engine.copy);
});

test('engine: a first visit (no stored version) and a metered network skip the refresh', async () => {
  const first = await engineWithPrevious({ previous: false });
  await boot(first);
  assert.deepEqual(first.order, ['refresh', 'download']);
  assert.equal(first.fetched.length, 0, 'nothing stale can exist: no request');
  const metered = await engineWithPrevious({ column: { connection: { type: 'cellular' } } });
  await boot(metered);
  assert.deepEqual(metered.order, ['download'], 'no web seed from the host, so no refresh of host files');
  assert.equal(metered.fetched.length, 0);
});

test('engine: a missing or broken previous file list never blocks the download', async () => {
  const ctx = await engineWithPrevious();
  ctx.win.fetch = async () => { throw new Error('offline'); };
  await boot(ctx);
  assert.ok(ctx.engine.copy, 'the download went ahead');
  assert.ok(ctx.engine.logs.some((l) => /refresh of changed files failed/.test(l)));
  const noList = await engineWithPrevious();
  noList.cache.store.files.delete(noList.oldSite.infoHash + '/.mw/files.json');
  await boot(noList);
  assert.equal(noList.fetched.length, 0, 'no old list to compare with: nothing is refreshed');
  assert.ok(noList.engine.copy);
});
