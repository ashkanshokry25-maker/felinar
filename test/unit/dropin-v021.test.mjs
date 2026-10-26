// Unit tests for the v0.2.1 drop-in rule edits (DIGEST-AMENDMENTS D4, MIGRATION-DIGEST M09) and the
// page side of D1: no-store pages run host-only (the worker's mw-ack doc), the keep-alive ping while
// the copy downloads through the worker, no CSP <meta> from the drop-in script, idempotent double
// inclusion, and the data-nosnippet status container (F7). No browser: the fakes of dropin-fakes.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { start } from '../../src/dropin/mw.js';
import { announceAllowed } from '../../src/dropin/rules.js';
import { keepAlive, mapClient } from '../../src/dropin/swreg.js';
import { PROTO, KEEPALIVE_MS } from '../../src/sw/protocol.js';
import { createClock } from './dropin-fake-timers.mjs';
import {
  until, buildSite, SITE_FILES, newOwner, stampFor, memoryCache, chainModule, torrentModule, fakeWindow, fakeServiceWorker, FakeWorker, ORIGIN,
} from './dropin-fakes.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;

async function page({ scripts = [{ src: '/_mw/mw.js' }], serviceWorker = undefined } = {}) {
  const site = await buildSite(SITE_FILES);
  const owner = await newOwner();
  const stamp = await stampFor({ owner, btih: site.infoHash });
  const cache = memoryCache();
  const clock = createClock(Date.now());
  const win = fakeWindow({ stamp, scripts, serviceWorker });
  const deps = {
    cache: async () => cache,
    verify: () => import('../../src/loader/verify.js'),
    torrentFile: () => import('../../src/common/torrent-file.js'),
    crypto: () => import('../../src/chain/crypto.js'),
    torrent: async () => torrentModule(site),
    chain: async () => chainModule(),
    webtorrent: async () => class WebTorrent {},
  };
  return { win, deps, clock, site };
}

test('D4 announceAllowed: a no-store page never opens a tracker socket or a peer, whatever else holds', () => {
  const ready = { consent: 'accepted', hostOnly: false, visible: true, suspended: false, webrtc: true };
  assert.equal(announceAllowed(ready), true);
  assert.equal(announceAllowed(Object.assign({}, ready, { noStore: true })), false);
  assert.equal(announceAllowed(Object.assign({}, ready, { noStore: false })), true);
});

test('D4 the worker says the page was no-store (mw-ack doc): the engine runs host-only on that page', async () => {
  const worker = new FakeWorker(ORIGIN + '/mw-sw.js', (m) => {
    if (m.type === 'mw-ping') return { proto: 1, type: 'mw-pong', buildId: 'test', mode: 'dropin', foreign: false };
    if (m.type === 'mw-map-client') return { proto: 1, type: 'mw-ack', of: m.type, ok: true, btih: m.btih, complete: true, doc: { noStore: true } };
    if (m.type === 'mw-get-clients') return { proto: 1, type: 'mw-clients', clients: {}, current: null };
    return { proto: 1, type: 'mw-ack', of: m.type, ok: true };
  });
  const sw = fakeServiceWorker({ registration: { scope: ORIGIN + '/', active: worker, waiting: null, installing: null }, controller: worker });
  const p = await page({ serviceWorker: sw });
  const handle = start({ win: p.win, moduleUrl: ORIGIN + '/_mw/mw.js', deps: p.deps, engineOptions: { timers: p.clock.timers() } });
  await until(() => handle.engine.state === 'ready' || handle.engine.state === 'off', { label: 'evaluate' });
  await handle.engine.mapToWorker();
  await until(() => handle.inspect().noStore === true, { label: 'noStore from the ack' });
  assert.equal(handle.inspect().noStore, true);
  assert.equal(handle.engine.announceReady(), false, 'host only on this page');
  assert.ok(handle.inspect().logs.some((l) => /no-store/.test(l)));
  const ack = await mapClient({ serviceWorker: sw }, p.site.infoHash);
  assert.deepEqual(ack.doc, { noStore: true }, 'swreg passes the doc through');
});

test('D1 keepAlive: posts { proto, type: mw-keepalive } to the controller at once and every 20 s at most', () => {
  const posted = [];
  const nav = { serviceWorker: { controller: { postMessage: (m) => posted.push(m) } } };
  const ticks = [];
  const ka = keepAlive(nav, { intervalMs: 90000, setIntervalFn: (fn, ms) => { ticks.push(ms); return 1; }, clearIntervalFn: () => {} });
  ka.hold();
  assert.deepEqual(posted, [{ proto: PROTO, type: 'mw-keepalive' }]);
  assert.deepEqual(ticks, [KEEPALIVE_MS]);
  ka.stop();
  const none = keepAlive({}, { setIntervalFn: () => 1, clearIntervalFn: () => {} });
  assert.doesNotThrow(() => none.hold(), 'no controller: nothing to ping, no error');
  none.stop();
});

test('D4 the drop-in script never inserts a Content-Security-Policy <meta> (the host CSP is the host\'s)', async () => {
  // source level: no file of src/dropin creates a CSP meta
  for (const name of readdirSync(join(ROOT, 'src', 'dropin'))) {
    if (!name.endsWith('.js')) continue;
    const src = readFileSync(join(ROOT, 'src', 'dropin', name), 'utf8');
    assert.equal(/http-?equiv[^\n]{0,80}Content-Security-Policy|Content-Security-Policy[^\n]{0,80}http-?equiv/i.test(src), false, name + ' builds no CSP meta');
  }
  // runtime level: a started engine leaves the document's metas as the host sent them
  const p = await page();
  const before = p.win.document.getElementsByTagName('meta').map((m) => m.getAttribute('name') || m.getAttribute('http-equiv'));
  const handle = start({ win: p.win, moduleUrl: ORIGIN + '/_mw/mw.js', deps: p.deps, engineOptions: { timers: p.clock.timers() } });
  await until(() => handle.engine.state === 'ready' || handle.engine.state === 'off', { label: 'evaluate' });
  p.clock.advance(200);
  await handle.started;
  const after = p.win.document.getElementsByTagName('meta');
  assert.deepEqual(after.map((m) => m.getAttribute('name') || m.getAttribute('http-equiv')), before);
  assert.equal(after.some((m) => /content-security-policy/i.test(String(m.getAttribute('http-equiv') || ''))), false);
});

test('D4 double inclusion: two tags (two module URLs) on one page start one engine', async () => {
  const p = await page({ scripts: [{ src: '/_mw/mw.js' }, { src: '/_mw/mw.js?v=2' }] });
  const first = start({ win: p.win, moduleUrl: ORIGIN + '/_mw/mw.js', deps: p.deps, engineOptions: { timers: p.clock.timers() } });
  const second = start({ win: p.win, moduleUrl: ORIGIN + '/_mw/mw.js?v=2', deps: p.deps, engineOptions: { timers: p.clock.timers() } });
  // Code review round 1: the second module instance gets the public (frozen) handle of the first engine.
  assert.equal(second, p.win.__mwDropin, 'the second module instance returns the first engine\'s handle');
  assert.equal(second.started, first.started, 'one engine');
  assert.equal(p.win.mw, first.engine.mw);
});

test('F7 the drop-in status container is created with data-nosnippet; the shell status bar has it in static HTML', () => {
  const panel = readFileSync(join(ROOT, 'src', 'dropin', 'panel.js'), 'utf8');
  const create = panel.indexOf("host = document_.createElement('div');");
  assert.ok(create > 0);
  const attrs = panel.slice(create, create + 500);
  assert.match(attrs, /setAttribute\('data-nosnippet', ''\)/, 'set when the node is created (Google: never add it later)');
  const shell = readFileSync(join(ROOT, 'src', 'loader', 'index.html'), 'utf8');
  assert.match(shell, /<div id="mw-bar" class="mw-bar" data-nosnippet>/);
});

test('D1 the engine keeps the worker alive on its own timers while the copy downloads through /_mw/ws/', async () => {
  const { DropinEngine } = await import('../../src/dropin/engine.js');
  const clock = createClock(1000);
  const posted = [];
  const nav = { serviceWorker: { controller: { postMessage: (m) => posted.push(m.type) } } };
  const fake = { timers: clock.timers() };
  const alive = keepAlive(nav, DropinEngine.prototype.keepAliveIntervals.call(fake));
  alive.hold();
  assert.deepEqual(posted, ['mw-keepalive'], 'a ping at once');
  clock.advance(KEEPALIVE_MS - 1);
  assert.equal(posted.length, 1);
  clock.advance(1);
  assert.equal(posted.length, 2, 'then every 20 s');
  clock.advance(KEEPALIVE_MS * 2);
  assert.equal(posted.length, 4);
  alive.stop();
  clock.advance(KEEPALIVE_MS * 3);
  assert.equal(posted.length, 4, 'nothing after the download ends');
  assert.equal(clock.pending(), 0, 'no timer left behind');
});
