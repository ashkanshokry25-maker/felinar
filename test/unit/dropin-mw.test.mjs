// Unit tests for src/dropin/mw.js, the entry of /_mw/mw.js: one engine per window, window.mw bound
// (also through the accessor /_mw/sdk.js installs), script tag options, the lazy module loaders, and
// "never throws into the page" when the module starts itself. No browser: a fake window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { start, createDeps, DROPIN_VERSION } from '../../src/dropin/mw.js';
import { createSdk } from '../../src/sdk/sdk.js';
import { CONFIG } from '../../src/loader/config.js';
import { createClock } from './dropin-fake-timers.mjs';
import { until, buildSite, SITE_FILES, newOwner, stampFor, memoryCache, chainModule, torrentModule, fakeWindow } from './dropin-fakes.mjs';

const MODULE_URL = 'https://site.test/_mw/mw.js';

async function page({ scripts = [{ src: '/_mw/mw.js' }], withStamp = true } = {}) {
  const site = await buildSite(SITE_FILES);
  const owner = await newOwner();
  const stamp = withStamp ? await stampFor({ owner, btih: site.infoHash }) : null;
  const cache = memoryCache();
  const chain = chainModule();
  const tmod = torrentModule(site);
  const clock = createClock(Date.now());
  const win = fakeWindow({ stamp, scripts });
  const deps = {
    cache: async () => cache,
    verify: () => import('../../src/loader/verify.js'),
    torrentFile: () => import('../../src/common/torrent-file.js'),
    crypto: () => import('../../src/chain/crypto.js'),
    torrent: async () => tmod,
    chain: async () => chain,
    webtorrent: async () => class WebTorrent {},
  };
  return { win, deps, cache, chain, tmod, clock, site, owner };
}

async function drive(handle, clock) {
  await until(() => handle.engine.state === 'ready' || handle.engine.state === 'off', { label: 'evaluate' });
  if (handle.engine.state === 'ready') clock.advance(200);
  await handle.started;
  if (handle.engine.ledgerPromise) await handle.engine.ledgerPromise;
}

test('start(): nothing happens outside a page', () => {
  assert.equal(start({ win: null }), null);
  assert.equal(start({ win: {} }), null);
  assert.equal(DROPIN_VERSION, CONFIG.version);
});

test('start(): binds window.mw, keeps a diagnostics handle, and a second start returns the same engine', async () => {
  const p = await page();
  const handle = start({ win: p.win, moduleUrl: MODULE_URL, deps: p.deps, engineOptions: { timers: p.clock.timers() } });
  assert.ok(handle);
  assert.equal(p.win.mw, handle.engine.mw);
  assert.equal(p.win.__mwDropin.version, handle.version);
  assert.equal(p.win.__mwDropin.started, handle.started);
  assert.equal(handle.version, CONFIG.version);
  assert.equal(typeof handle.inspect, 'function');
  assert.equal(start({ win: p.win, moduleUrl: MODULE_URL, deps: p.deps }), p.win.__mwDropin, 'one engine per window: later calls get the public handle');
  await drive(handle, p.clock);
  assert.equal(handle.inspect().state, 'running');
  assert.equal(p.chain.FakeChainNode.opened.length, 1);
  assert.equal(typeof p.win.mw.ready, 'function');
  assert.equal((await p.win.mw.ready()).mode, 'dropin');
});

test('start(): the handle can open the sharing settings on demand (a site\'s own "peer-to-peer settings" link)', async () => {
  const p = await page();
  const handle = start({ win: p.win, moduleUrl: MODULE_URL, deps: p.deps, engineOptions: { timers: p.clock.timers() } });
  await drive(handle, p.clock);
  assert.equal(handle.engine.panel, null, 'nothing shown');
  await handle.openSettings();
  assert.equal(handle.engine.panel.settingsOpen, true);
  const host = p.win.document.body.children.find((c) => c.hasAttribute('data-mw-ui'));
  assert.ok(host.buttonByText('Close'));
  handle.engine.destroy();
});

test('start(): reads data-mw-sw and data-mw-consent from the script tag that loaded the module', async () => {
  const p = await page({ scripts: [{ src: '/other.js' }, { src: '/_mw/mw.js', 'data-mw-sw': 'off', 'data-mw-consent': 'site' }] });
  const handle = start({ win: p.win, moduleUrl: MODULE_URL, deps: p.deps, engineOptions: { timers: p.clock.timers() } });
  assert.deepEqual(handle.engine.options, { sw: 'off', consent: 'site' });
  await drive(handle, p.clock);
  assert.equal(p.win.navigator.serviceWorker.calls.register.length, 0, 'data-mw-sw="off" registers nothing');
  p.clock.advance(5000);
  assert.equal(p.win.document.body.children.length, 0, 'data-mw-consent="site" shows no notice');
  handle.engine.destroy();
});

test('window.mw goes through the setter /_mw/sdk.js installed, so a facade imported first adopts the binding', async () => {
  const p = await page();
  const facade = createSdk({ win: p.win, doc: p.win.document, global: p.win, installGlobal: true, bindingTimeoutMs: 5000 });
  assert.equal(p.win.mw, facade, 'before mw.js: the facade');
  const handle = start({ win: p.win, moduleUrl: MODULE_URL, deps: p.deps, engineOptions: { timers: p.clock.timers() } });
  assert.equal(p.win.mw, handle.engine.mw, 'the getter now returns the adopted binding');
  await drive(handle, p.clock);
  const info = await facade.ready();
  assert.equal(info.mode, 'dropin');
  assert.equal(await facade.db.get('notice'), 'hi', 'the facade reads through the binding');
  assert.deepEqual(await facade.db.append('guestbook', 'hello'), { h: 'b'.repeat(64) });
  assert.deepEqual(p.chain.FakeChainNode.opened[0].calls[0], ['append', 'guestbook', 'hello']);
  assert.equal(facade.consent.state(), 'pending');
  assert.equal((await facade.site.info()).mode, 'dropin');
});

test('window.mw: a frozen window or a read-only global never throws into the page', async () => {
  const p = await page();
  Object.defineProperty(p.win, 'mw', { get: () => 'taken', set: () => { throw new Error('read-only'); }, configurable: true });
  let handle;
  assert.doesNotThrow(() => { handle = start({ win: p.win, moduleUrl: MODULE_URL, deps: p.deps, engineOptions: { timers: p.clock.timers() } }); });
  assert.equal(p.win.mw, handle.engine.mw, 'the binding replaced the property when it was configurable');
  const q = await page();
  Object.freeze(q.win);
  assert.doesNotThrow(() => start({ win: q.win, moduleUrl: MODULE_URL, deps: q.deps, engineOptions: { timers: q.clock.timers() } }));
});

test('a page without a stamp: one warning, window.mw still answers, the page is untouched', async () => {
  const p = await page({ withStamp: false });
  const warns = [];
  const saved = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const handle = start({ win: p.win, moduleUrl: MODULE_URL, deps: p.deps, engineOptions: { timers: p.clock.timers() } });
    await handle.started;
    assert.equal(handle.inspect().state, 'off');
    assert.equal(warns.length, 1);
    await assert.rejects(p.win.mw.db.set('k', 1), (e) => e.code === 'E_IDENTITY');
    assert.equal(p.win.document.body.children.length, 0);
  } finally {
    console.warn = saved;
  }
});

test('loading the module in a page starts it by itself, with the real loaders, and fails open', async () => {
  const p = await page({ withStamp: false });
  const warns = [];
  const saved = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  globalThis.window = p.win;
  try {
    await import('../../src/dropin/mw.js?autostart=' + Date.now());
    assert.ok(p.win.__mwDropin, 'the module started itself');
    assert.equal(typeof p.win.mw.ready, 'function');
    await p.win.__mwDropin.started;
    assert.equal(p.win.__mwDropin.inspect().off, 'no-stamp');
    assert.match(warns.join('\n'), /mw-pointer/);
    p.win.__mwNoAutostart = true;
  } finally {
    delete globalThis.window;
    console.warn = saved;
  }
  const q = await page();
  q.win.__mwNoAutostart = true;
  globalThis.window = q.win;
  try {
    await import('../../src/dropin/mw.js?noauto=' + Date.now());
    assert.equal(q.win.__mwDropin, undefined, '__mwNoAutostart disables it (tests, embedders)');
  } finally {
    delete globalThis.window;
  }
});

test('createDeps: every loader yields the module the engine expects, nothing is evaluated up front', async () => {
  const deps = createDeps(MODULE_URL);
  // v0.3: 'v03' loads the modules of the services (identity client and store, chat, files, media).
  assert.deepEqual(Object.keys(deps).sort(), ['cache', 'chain', 'crypto', 'torrent', 'torrentFile', 'v03', 'verify', 'webtorrent']);
  assert.equal(typeof (await deps.cache()).getSite, 'function');
  assert.equal(typeof (await deps.verify()).verifyInfoHash, 'function');
  assert.equal(typeof (await deps.torrentFile()).parseTorrentFile, 'function');
  assert.equal(typeof (await deps.crypto()).fingerprint, 'function');
  assert.equal(typeof (await deps.torrent()).TorrentManager, 'function');
  const chain = await deps.chain();
  assert.equal(typeof chain.ChainNode.open, 'function');
  assert.equal(typeof chain.IdbBlockStore, 'function');
  assert.equal(typeof chain.createMiner, 'function');
  assert.equal(typeof chain.createVerifierPool, 'function');
  assert.equal(typeof chain.createBlock, 'function', 'the 0.2.1 key signs its mw.link item with createBlock');
  const v03 = await deps.v03();
  assert.equal(typeof v03.client.signIn, 'function');
  assert.equal(typeof v03.client.completeRedirect, 'function');
  assert.equal(typeof v03.store.WorkingKeys, 'function');
  assert.equal(typeof v03.chat.createChatService, 'function');
  assert.equal(typeof v03.files.createFilesService, 'function');
  assert.equal(typeof v03.media.createMediaService, 'function');
});

test('createDeps.webtorrent: the B7 offer-timeout wrapper is installed on the window before the bundle is imported (v0.2.1)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mw-dropin-b7-'));
  writeFileSync(join(dir, 'wt.js'), 'export default class WebTorrent { constructor() { this.pc = globalThis.__mwSeenPc; } }\n');
  class FakePc { addEventListener() {} }
  const win = { RTCPeerConnection: FakePc };
  const W = await createDeps(MODULE_URL, { webtorrentUrl: pathToFileURL(join(dir, 'wt.js')).href, win }).webtorrent();
  assert.equal(typeof W, 'function');
  assert.notEqual(win.RTCPeerConnection, FakePc, 'wrapped');
  assert.equal(win.RTCPeerConnection.__mwOfferTimeout, CONFIG.ice.offerTimeoutMs);
  const pc = new win.RTCPeerConnection();
  assert.ok(pc instanceof FakePc, 'the wrapper returns a real connection');
  assert.equal(pc.__mwOfferTimeout, CONFIG.ice.offerTimeoutMs, 'every connection is patched');
  // Installed once: a second load keeps the same wrapper; no RTCPeerConnection means nothing to wrap.
  const wrapped = win.RTCPeerConnection;
  await createDeps(MODULE_URL, { webtorrentUrl: pathToFileURL(join(dir, 'wt.js')).href, win }).webtorrent();
  assert.equal(win.RTCPeerConnection, wrapped);
  await createDeps(MODULE_URL, { webtorrentUrl: pathToFileURL(join(dir, 'wt.js')).href, win: {} }).webtorrent();
});

test('createDeps.webtorrent: imports the vendored bundle next to mw.js by URL and takes its default export', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mw-dropin-'));
  mkdirSync(join(dir, '_mw'));
  writeFileSync(join(dir, '_mw', 'webtorrent.min.js'), 'export default class WebTorrent { constructor() { this.ok = true; } }\n');
  writeFileSync(join(dir, '_mw', 'broken.min.js'), 'export const nothing = 1;\n');
  const good = await createDeps(MODULE_URL, { webtorrentUrl: pathToFileURL(join(dir, '_mw', 'webtorrent.min.js')).href }).webtorrent();
  assert.equal(new good().ok, true);
  await assert.rejects(createDeps(MODULE_URL, { webtorrentUrl: pathToFileURL(join(dir, '_mw', 'broken.min.js')).href }).webtorrent(), /no default export/);
  await assert.rejects(createDeps(MODULE_URL, { webtorrentUrl: pathToFileURL(join(dir, '_mw', 'missing.js')).href }).webtorrent());
});

test('code review round 1: window.__mwDropin is frozen and reaches nothing that can accept consent or move the identity', async () => {
  const p = await page();
  const handle = start({ win: p.win, moduleUrl: MODULE_URL, deps: p.deps, engineOptions: { timers: p.clock.timers() } });
  await drive(handle, p.clock);
  const pub = p.win.__mwDropin;
  assert.equal(pub.engine, undefined, 'the engine is not on the window');
  assert.equal(Object.isFrozen(pub), true);
  assert.deepEqual(Object.keys(pub).sort(), ['inspect', 'openSettings', 'rectOf', 'started', 'version']);
  assert.throws(() => { 'use strict'; pub.engine = handle.engine; }, TypeError, 'cannot be extended');
  // Walk everything reachable from the handle and its return values (no engine, no consent setter,
  // no identity API, no changeSetting).
  const seen = new Set();
  const forbidden = ['consent', 'identityApi', 'changeSetting', 'engine'];
  const walk = (v, depth) => {
    if (!v || (typeof v !== 'object' && typeof v !== 'function') || seen.has(v) || depth > 3) return;
    seen.add(v);
    for (const k of Object.keys(v)) {
      if (typeof v === 'object' && k === 'consent' && typeof v[k] === 'string') continue; // inspect().consent is a state name
      assert.equal(forbidden.includes(k) && typeof v[k] !== 'string', false, 'reachable: ' + k);
      walk(v[k], depth + 1);
    }
  };
  walk(pub, 0);
  walk(pub.inspect(), 0);
  // A page script that tries to accept leaves consent pending.
  assert.equal(pub.inspect().consent, 'pending');
  assert.equal(typeof pub.rectOf('anything'), 'object', 'rectOf answers null or a rectangle');
});
