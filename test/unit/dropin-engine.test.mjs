// Unit tests for src/dropin/engine.js: one page view of drop-in mode, end to end, against fakes
// (window, IndexedDB-style cache, ChainNode, TorrentManager, Service Worker, Web Locks). Pointers,
// torrents and keys are real. The flows under test: fail open, first visit (web seed through the
// worker, copy saved, version cleanup), consent and the 3 s visible gate, second visit (seed from
// the cache without loading webtorrent early), a site's own worker, metered networks, key change,
// settings. Tabs and the back/forward cache are in dropin-engine-tabs.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DropinEngine } from '../../src/dropin/engine.js';
import { ledgerIdFor, parsePointer } from '../../src/common/pointer.js';
import { STRINGS as S } from '../../src/loader/strings.js';
import { createClock, flush } from './dropin-fake-timers.mjs';
import {
  ORIGIN, until, buildSite, SITE_FILES, newOwner, stampFor, memoryCache, putSite, chainModule, torrentModule, fakeServiceWorker,
  FakeWorker, oursWorker, fakeWindow, FakeLockManager, consentPref, storedConsent,
} from './dropin-fakes.mjs';
import { CONFIG } from '../../src/loader/config.js';

const NOW = () => Date.now();

function captureConsole() {
  const out = { warns: [], infos: [] };
  const saved = { warn: console.warn, info: console.info };
  console.warn = (...a) => out.warns.push(a.join(' '));
  console.info = (...a) => out.infos.push(a.join(' '));
  out.restore = () => { console.warn = saved.warn; console.info = saved.info; };
  return out;
}

async function setup({ stamp = {}, noStamp = false, prefs = {}, cache = null, tmOpts, options, win: winOpts = {}, files = SITE_FILES, owner = null, site = null, deps: depsOver = {}, config } = {}) {
  site = site || await buildSite(files);
  owner = owner || await newOwner();
  const text = noStamp ? null : await stampFor(Object.assign({ owner, btih: site.infoHash }, stamp));
  const mem = cache || memoryCache({ prefs });
  const chain = chainModule();
  const tmod = torrentModule(site, tmOpts);
  const clock = createClock(NOW());
  const win = fakeWindow(Object.assign({ stamp: text }, winOpts));
  const loads = { webtorrent: 0, torrent: 0 };
  const deps = Object.assign({
    cache: async () => mem,
    verify: () => import('../../src/loader/verify.js'),
    torrentFile: () => import('../../src/common/torrent-file.js'),
    crypto: () => import('../../src/chain/crypto.js'),
    torrent: async () => { loads.torrent++; return tmod; },
    chain: async () => chain,
    webtorrent: async () => { loads.webtorrent++; return class WebTorrent {}; },
  }, depsOver);
  // swRecheckMs: 0 keeps these timelines; the empty-scope re-check has its own tests in dropin-swreg.
  const engine = new DropinEngine({ win, deps, options: Object.assign({ swRecheckMs: 0 }, options), timers: clock.timers(), config });
  return { engine, win, cache: mem, chain, tmod, clock, site, owner, text, loads, deps };
}

/** Runs start() to the end of the engine start: load, evaluate, idle (fake 200 ms), election, ledger, cache. */
async function boot(ctx) {
  const p = ctx.engine.start();
  await until(() => ctx.engine.state === 'ready' || ctx.engine.state === 'off', { label: 'evaluate' });
  if (ctx.engine.state === 'ready') ctx.clock.advance(200);
  await p;
  if (ctx.engine.ledgerPromise) await ctx.engine.ledgerPromise;
  return ctx;
}

/** The copy is set before it is saved and mapped; wait for the whole download task. */
async function copied(ctx) {
  await until(() => ctx.engine.copy, { label: 'copy' });
  const pending = ctx.engine.obtaining;
  if (pending) await pending;
}

/** Polls like until(), moving the engine's fake clock on each step (for waits that are timeouts, e.g. a ping). */
function advanceUntil(ctx, cond, { label, step = 100 } = {}) {
  return until(() => { ctx.clock.advance(step); return cond(); }, { label });
}

async function ledgerIdOf(text, scope = 'site.test') {
  return ledgerIdFor(parsePointer(text).record, scope);
}

const hostOf = (win) => win.document.body.children.find((c) => c.hasAttribute('data-mw-ui')) || null;

test('fail open: no stamp, unsupported browser and framed pages turn the engine off with one warning and a working window.mw', async () => {
  const con = captureConsole();
  try {
    const noMeta = await setup({ noStamp: true });
    await boot(noMeta);
    assert.equal(noMeta.engine.state, 'off');
    assert.equal(noMeta.engine.offReason, 'no-stamp');
    assert.equal(con.warns.length, 1);
    assert.match(con.warns[0], /mw-pointer/);
    assert.equal(noMeta.win.navigator.serviceWorker.calls.register.length, 0, 'nothing registered');
    const info = await noMeta.engine.mw.ready();
    assert.equal(info.mode, 'dropin');
    await assert.rejects(noMeta.engine.mw.db.set('k', 1), (e) => e.code === 'E_IDENTITY');
    assert.equal(await noMeta.engine.mw.db.get('k'), undefined, 'reads answer');
    await assert.rejects(noMeta.engine.mw.consent.request(), (e) => e.code === 'E_NO_HOST');
    assert.equal(noMeta.engine.mw.consent.accept, undefined, 'v0.2.1 A4: a site never accepts');
    noMeta.engine.warnOnce('off:no-stamp', 'again');
    assert.equal(con.warns.length, 1, 'once');

    const old = await setup({});
    old.win.indexedDB = undefined;
    await boot(old);
    assert.equal(old.engine.offReason, 'unsupported');
    assert.match(con.warns[1], /IndexedDB/);
    assert.match(con.warns[1], /Safari 15\.4/);

    const framed = await setup({ win: { framed: true } });
    await boot(framed);
    assert.equal(framed.engine.offReason, 'framed');
    assert.equal(con.warns.length, 2, 'a framed page is quietly left alone');
  } finally {
    con.restore();
  }
});

test('fail open: a pointer for another host, an expired one and unreadable storage never start the engine', async () => {
  const con = captureConsole();
  try {
    const other = await setup({ stamp: { scope: 'other.test' } });
    await boot(other);
    assert.equal(other.engine.offReason, 'pointer:bad-sig');
    assert.match(con.warns[0], /another host/);
    const expired = await setup({ stamp: { expDays: -1 } });
    await boot(expired);
    assert.equal(expired.engine.offReason, 'pointer:expired');
    const storage = await setup({});
    storage.cache.failOpen = true;
    await boot(storage);
    assert.equal(storage.engine.offReason, 'storage');
    assert.match(con.warns[2], /storage is not available/);
    assert.equal(storage.chain.FakeChainNode.opened.length, 0);
  } finally {
    con.restore();
  }
});

test('first visit: the host\'s /_mw/ws/ is the web seed through our worker; the copy is saved, the worker told, the page mapped', async () => {
  const worker = oursWorker();
  const ctx = await setup({ win: { serviceWorker: fakeServiceWorker({ controlOnRegister: worker }) } });
  await boot(ctx);
  const { engine, tmod, cache, site } = ctx;
  await copied(ctx);
  assert.equal(engine.state, 'running');
  assert.equal(engine.inspect().sw.mode, 'ours');
  assert.deepEqual(ctx.win.navigator.serviceWorker.calls.register, [['/mw-sw.js', { scope: '/', updateViaCache: 'none' }]]);
  const tm = tmod.instances[0];
  assert.equal(tmod.instances.length, 1);
  const rec = tm.downloads[0].record;
  assert.deepEqual(rec.ws, ['https://site.test/_mw/ws/'], 'the static origin is the web seed');
  assert.deepEqual(rec.xs, ['/_mw/t/' + site.infoHash + '.torrent']);
  assert.equal(tm.downloads[0].maxBytes, 134217728, 'desktop cap');
  assert.equal(engine.record.ws.length, 0, 'the verified record itself was not modified');
  assert.ok(cache.calls.some((c) => c[0] === 'saveSite' && c[1] === site.infoHash));
  assert.ok(cache.store.sites.has(site.infoHash));
  assert.ok(cache.calls.some((c) => c[0] === 'enforceBudget'));
  const types = worker.posted.map((m) => m.type);
  assert.ok(types.includes('mw-map-client'), 'the worker learns which version this page renders');
  assert.ok(types.includes('mw-site-saved'), 'and that the copy is complete');
  assert.ok(types.includes('mw-get-clients'), 'and is asked who still renders older versions');
  assert.equal(worker.posted.find((m) => m.type === 'mw-map-client').btih, site.infoHash);
  const ledgerId = await ledgerIdOf(ctx.text);
  assert.deepEqual(cache.store.prefs.get('versions:' + ledgerId), [site.infoHash]);
  const info = await engine.mw.site.info();
  assert.equal(info.mode, 'dropin');
  assert.equal(info.btih, site.infoHash);
  assert.equal(info.source, 'webseed');
  assert.deepEqual(info.files.map((f) => f.path).sort(), SITE_FILES.map((f) => f.path).sort());
  assert.equal(engine.consent.state(), 'pending');
  assert.equal(tm.consent.peersAllowed(), false, 'no tracker, no peer before consent and 3 s visible');
  assert.deepEqual(tm.anchors.map((a) => a[0]), [ledgerId], 'the anchor torrent for ledger gossip across versions');
  const ready = await engine.mw.ready();
  assert.equal(ready.role, 'writer');
  assert.equal(ready.siteId, ledgerId);
});

test('first visit: the ledger opens with the pointer\'s owner and genesis, the pow worker and a stored identity', async () => {
  const gen = 'ab'.repeat(32);
  const ctx = await setup({ stamp: { more: { gen } } });
  await boot(ctx);
  assert.equal(ctx.chain.FakeChainNode.opened.length, 1);
  const o = ctx.chain.FakeChainNode.opened[0].options;
  assert.equal(o.siteId, await ledgerIdOf(ctx.text));
  assert.equal(o.expectedOwner, ctx.owner.pub);
  assert.equal(o.genesisHash, gen);
  assert.equal(ctx.chain.miners[0].workerUrl, '/_mw/pow-worker.js');
  assert.equal(ctx.chain.pools[0].size, 2);
  assert.equal(ctx.chain.pools[0].workerUrl, '/_mw/pow-worker.js', 'signatures verify in the worker pool (code review round 1)');
  assert.equal(o.ledgerOwner, ctx.owner.pub, 'no lo=: the ledger owner is the pointer owner');
  assert.match(o.identity.pub, /^p256:[A-Za-z0-9_-]{87}$/); // algorithm-tagged since v0.2.1 (A2)
  assert.ok(ctx.cache.store.keys.has('identity:' + o.siteId), 'the posting identity is stored per ledger');
  assert.equal(ctx.engine.identityInfo.pub, o.identity.pub);
  assert.deepEqual(ctx.cache.store.pins.get('site.test').owner, ctx.owner.pub, 'first visit pins the publisher key');
  assert.equal(ctx.engine.firstTime, true);
});

test('an unsigned stamp gives an unmoderated ledger keyed by infohash', async () => {
  const site = await buildSite(SITE_FILES);
  const ctx = await setup({ site });
  const magnet = 'magnet:?xt=urn:btih:' + site.infoHash + '&xs=%2F_mw%2Ft%2F' + site.infoHash + '.torrent';
  ctx.win.document.head.findAll((n) => n.tagName === 'META')[0].setAttribute('content', magnet);
  await boot(ctx);
  assert.equal(ctx.engine.ledgerId, 'btih:' + site.infoHash);
  assert.equal(ctx.engine.signed, false);
  assert.equal(ctx.chain.FakeChainNode.opened[0].options.expectedOwner, null);
  const info = ctx.engine.siteInfo();
  assert.equal(info.unmoderated, true);
  assert.equal(info.owner, null);
});

test('consent: the first-run card appears after 3 s visible, "Share and load" stores consent and opens the gate for sockets; hidden time does not count', async () => {
  const ctx = await setup({});
  await boot(ctx);
  const { engine, win, clock, cache } = ctx;
  await until(() => engine.tmod || ctx.tmod.instances[0], { label: 'tm' });
  const tm = ctx.tmod.instances[0];
  clock.advance(2000);
  assert.equal(hostOf(win), null, 'nothing yet');
  win.document.setVisibility('hidden');
  clock.advance(60000);
  assert.equal(hostOf(win), null, 'a background tab does not count and is never asked');
  assert.equal(engine.visible, false);
  win.document.setVisibility('visible');
  const remaining = 3000 - engine.visibleTimer.elapsedMs();
  assert.ok(remaining > 0 && remaining < 3000, 'only the visible time counted: ' + remaining + ' ms left');
  clock.advance(remaining - 1);
  assert.equal(hostOf(win), null);
  clock.advance(1);
  const host = hostOf(win);
  assert.ok(host, 'the notice shows after 3 s of visible time');
  assert.equal(engine.inspect().prompt, 'notice');
  assert.equal(host.shadowRoot, null, 'closed shadow root');
  assert.equal(tm.consent.peersAllowed(), false, 'visible alone is not consent');
  // v0.2.1 C1: the same-layer choice (was [Settings] [OK]).
  assert.ok(host.buttonByText(S.consentShare) && host.buttonByText(S.consentHostOnly) && host.buttonByText(S.consentSettings), 'the first-run card');
  host.buttonByText(S.consentShare).click();
  await until(() => engine.consent.state() === 'accepted', { label: 'accepted' });
  assert.equal(tm.consent.peersAllowed(), true);
  assert.ok(tm.consentChanges >= 1, 'the TorrentManager was told to connect');
  const rec = cache.store.prefs.get('consent');
  assert.equal(rec.choice, 'accepted', 'the versioned per-origin record (v0.2.1 C1; was consent:<ledgerId> = accepted)');
  assert.equal(rec.v, CONFIG.consent.version);
  assert.equal(rec.scope, 'https://site.test');
  assert.match(rec.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(rec.rcpt.includes('tracker.example'), true, 'the recipients are named');
  assert.equal(hostOf(win), null, 'the notice is gone');
  await until(() => cache.calls.some((c) => c[0] === 'requestPersist'), { label: 'storage.persist() after consent' });
});

test('consent: Settings opens from the notice; "Host only" there stops all peer connections', async () => {
  const ctx = await setup({});
  await boot(ctx);
  const { engine, win, clock, cache } = ctx;
  await until(() => ctx.tmod.instances[0], { label: 'tm' });
  const tm = ctx.tmod.instances[0];
  clock.advance(3000);
  hostOf(win).buttonByText(S.noticeSettings).click();
  await until(() => engine.panel.settingsOpen, { label: 'settings' });
  const host = hostOf(win);
  const [, hostOnlyBox] = host.findAll((n) => n.tagName === 'INPUT');
  hostOnlyBox.checked = true;
  hostOnlyBox.dispatchEvent({ type: 'change' });
  await until(() => engine.prefs.hostOnly, { label: 'host only' });
  assert.equal(cache.store.prefs.get('hostOnly'), true);
  assert.equal(engine.policy.hostOnly, true);
  assert.ok(tm.calls.some((c) => c[0] === 'setHostOnly' && c[1] === true));
  assert.equal(tm.consent.peersAllowed(), false);
  await engine.consent.set('accepted');
  assert.equal(tm.consent.peersAllowed(), false, 'consent does not override the visitor\'s host-only choice');
  assert.equal((await ctx.engine.settingsModel()).hostOnly, true);
});

test('consent=gate in the pointer asks with the gate; "Load from host only" is consent host-only', async () => {
  const ctx = await setup({ stamp: { more: { consent: 'gate' } } });
  await boot(ctx);
  ctx.clock.advance(3000);
  const host = hostOf(ctx.win);
  assert.equal(ctx.engine.inspect().prompt, 'gate');
  assert.ok(host.buttonByText(S.gateLoad) && host.buttonByText(S.gateHostOnly) && host.buttonByText(S.gateCancel));
  host.buttonByText(S.gateHostOnly).click();
  await until(() => ctx.engine.consent.state() === 'host-only', { label: 'host-only' });
  assert.equal(storedConsent(ctx.cache), 'host-only');
  assert.equal(ctx.engine.announceReady(), false);
  assert.equal(hostOf(ctx.win), null);
});

// v0.2.1 C1 in drop-in mode (harden-verify): aud= forces the gate, the first-run card has a same-layer
// refusal, and only a versioned record with this pointer's recipients counts as a stored choice.
test('C1: aud=eea (or personal, uk, qc) without consent= asks with the gate in drop-in mode too', async () => {
  for (const aud of ['eea', 'personal', 'uk', 'qc', 'kids,general']) {
    const ctx = await setup({ stamp: { more: { aud } } });
    await boot(ctx);
    ctx.clock.advance(3000);
    assert.equal(ctx.engine.inspect().prompt, 'gate', 'aud=' + aud);
    assert.ok(hostOf(ctx.win).buttonByText(S.gateLoad), 'aud=' + aud);
    ctx.engine.destroy();
  }
  const general = await setup({ stamp: { more: { aud: 'general' } } });
  await boot(general);
  general.clock.advance(3000);
  assert.equal(general.engine.inspect().prompt, 'notice', 'a general audience gets the non-blocking card');
  const notice = await setup({ stamp: { more: { aud: 'eea', consent: 'notice' } } });
  await boot(notice);
  notice.clock.advance(3000);
  assert.equal(notice.engine.inspect().prompt, 'notice', 'an explicit consent=notice is the owner\'s choice');
});

test('C1: "Load from host only" on the first-run card stores host-only; nothing announces', async () => {
  const ctx = await setup({});
  await boot(ctx);
  ctx.clock.advance(3000);
  const host = hostOf(ctx.win);
  assert.equal(ctx.engine.inspect().prompt, 'notice');
  const texts = host.findAll((n) => typeof n._text === 'string' && n._text.length > 0).map((n) => n._text);
  assert.ok(texts.includes(S.consentTitle) && texts.includes(S.consentText) && texts.includes(S.consentChoice), 'the card text (closed shadow root)');
  host.buttonByText(S.consentHostOnly).dispatchEvent({ type: 'click', isTrusted: false });
  await flush();
  assert.equal(ctx.engine.consent.state(), 'pending', 'a script click decides nothing');
  host.buttonByText(S.consentHostOnly).click();
  await until(() => ctx.engine.consent.state() === 'host-only', { label: 'host-only' });
  assert.equal(storedConsent(ctx.cache), 'host-only');
  assert.equal(ctx.engine.announceReady(), false);
  assert.equal(hostOf(ctx.win), null);
  assert.equal(ctx.engine.inspect().consentRecord.choice, 'host-only');
});

test('C1: a v0.2 choice (a bare string per ledger) or a record for other recipients is asked again', async () => {
  const site = await buildSite(SITE_FILES);
  const owner = await newOwner();
  const probe = await stampFor({ owner, btih: site.infoHash });
  // v0.2 stored 'consent:<ledgerId>' = 'accepted': the card changed, so it does not count.
  const old = await setup({ site, owner, cache: memoryCache({ prefs: { ['consent:' + await ledgerIdOf(probe)]: 'accepted' } }) });
  await boot(old);
  assert.equal(old.engine.consent.state(), 'pending');
  old.clock.advance(3000);
  assert.equal(old.engine.inspect().prompt, 'notice', 'asked again');
  // An accepted record for other trackers: asked again (the recipients changed).
  const other = await stampFor({ owner, btih: site.infoHash, more: { tr: ['wss://other-tracker.example'] } });
  const moved = await setup({ site, owner, cache: memoryCache({ prefs: Object.fromEntries([consentPref(other, 'accepted')]) }) });
  await boot(moved);
  assert.equal(moved.engine.consent.state(), 'pending', 'recipients differ');
  // A host-only record counts whatever the recipients: nobody else is contacted.
  const hostOnly = await setup({ site, owner, cache: memoryCache({ prefs: Object.fromEntries([consentPref(other, 'host-only')]) }) });
  await boot(hostOnly);
  assert.equal(hostOnly.engine.consent.state(), 'host-only');
  // Another version: asked again.
  const [key, rec] = consentPref(probe, 'accepted');
  const stale = await setup({ site, owner, cache: memoryCache({ prefs: { [key]: Object.assign({}, rec, { v: rec.v - 1 }) } }) });
  await boot(stale);
  assert.equal(stale.engine.consent.state(), 'pending', 'an older record version');
});

test('consent=gate: Cancel is remembered for the tab session and nothing connects', async () => {
  const ctx = await setup({ stamp: { more: { consent: 'gate' } } });
  await boot(ctx);
  ctx.clock.advance(3000);
  hostOf(ctx.win).buttonByText(S.gateCancel).click();
  assert.equal(ctx.engine.consent.state(), 'pending');
  assert.equal(ctx.win.sessionStorage.getItem('mw-gate-cancelled:' + ctx.engine.ledgerId), '1');
  ctx.engine.maybePrompt();
  assert.equal(hostOf(ctx.win), null, 'not asked again in this session');
});

test('consent: with data-mw-consent="site" mw.consent.request() opens the loader card and resolves with the visitor\'s click; a site never accepts (v0.2.1 A4)', async () => {
  const ctx = await setup({ options: { sw: 'auto', consent: 'site' } });
  await boot(ctx);
  ctx.clock.advance(5000);
  assert.equal(hostOf(ctx.win), null, 'no built-in notice');
  assert.equal(ctx.engine.mw.consent.state(), 'pending');
  assert.equal(ctx.engine.mw.consent.accept, undefined);
  const asked = ctx.engine.mw.consent.request();
  const again = ctx.engine.mw.consent.request();
  await until(() => hostOf(ctx.win), { label: 'the loader-owned notice' });
  assert.equal(ctx.engine.inspect().prompt, 'notice');
  assert.equal(ctx.engine.mw.consent.state(), 'pending', 'asking grants nothing');
  // A script-made click (isTrusted false) on the loader's button does nothing.
  hostOf(ctx.win).buttonByText(S.consentShare).dispatchEvent({ type: 'click', isTrusted: false });
  await flush();
  assert.equal(ctx.engine.mw.consent.state(), 'pending', 'an untrusted click is ignored');
  hostOf(ctx.win).buttonByText(S.consentShare).click(); // the visitor's click
  assert.equal(await asked, 'accepted');
  assert.equal(await again, 'accepted', 'concurrent requests share the card');
  assert.equal(ctx.engine.mw.consent.state(), 'accepted');
  assert.equal(storedConsent(ctx.cache), 'accepted');
  assert.equal(await ctx.engine.mw.consent.request(), 'accepted', 'decided: nothing opens');
  assert.equal(hostOf(ctx.win), null);
  // A visitor's own host-only choice stays: request() reports it and opens nothing.
  const hostOnly = await setup({ options: { sw: 'auto', consent: 'site' }, prefs: {} });
  await boot(hostOnly);
  await hostOnly.engine.consent.set('host-only');
  assert.equal(await hostOnly.engine.mw.consent.request(), 'host-only');
  assert.equal(hostOf(hostOnly.win), null);
  // consent=gate: the card is the gate; Cancel resolves the request with 'pending'.
  const gated = await setup({ options: { sw: 'auto', consent: 'site' }, stamp: { more: { consent: 'gate' } } });
  await boot(gated);
  const pendingGate = gated.engine.mw.consent.request();
  await until(() => hostOf(gated.win), { label: 'the gate' });
  assert.equal(gated.engine.inspect().prompt, 'gate');
  hostOf(gated.win).buttonByText(S.gateCancel).click();
  assert.equal(await pendingGate, 'pending');
});

test('stored consent: no notice is shown and the announce gate opens after 3 s visible', async () => {
  const site = await buildSite(SITE_FILES);
  const owner = await newOwner();
  const probe = await stampFor({ owner, btih: site.infoHash });
  const cache = memoryCache({ prefs: Object.fromEntries([consentPref(probe, 'accepted')]) });
  const ctx = await setup({ site, owner, cache });
  await boot(ctx);
  assert.equal(ctx.engine.consent.state(), 'accepted');
  assert.equal(ctx.engine.announceReady(), false);
  ctx.clock.advance(3000);
  assert.equal(ctx.engine.announceReady(), true);
  assert.equal(hostOf(ctx.win), null, 'never asked again');
});

test('second visit: the complete copy is found, nothing is downloaded and webtorrent is not even loaded until sharing may start', async () => {
  const site = await buildSite(SITE_FILES);
  const owner = await newOwner();
  const probe = await stampFor({ owner, btih: site.infoHash });
  const cache = memoryCache({ prefs: Object.fromEntries([consentPref(probe, 'accepted')]) });
  putSite(cache, site);
  const worker = oursWorker();
  const ctx = await setup({ site, owner, cache, win: { serviceWorker: fakeServiceWorker({ controlOnRegister: worker }) } });
  await boot(ctx);
  const { engine, loads, tmod, clock } = ctx;
  assert.ok(engine.copy && engine.copy.fromCache);
  assert.equal(engine.inspect().source, 'cache');
  assert.ok(cache.calls.some((c) => c[0] === 'touchSite'));
  assert.equal(loads.webtorrent, 0, 'webtorrent.min.js is not loaded for a visit that has nothing to share yet');
  assert.equal(loads.torrent, 0);
  assert.equal(tmod.instances.length, 0);
  clock.advance(3000);
  await until(() => tmod.instances[0] && tmod.instances[0].seeds.length === 1, { label: 'seeded' });
  const tm = tmod.instances[0];
  assert.equal(loads.webtorrent, 1);
  assert.equal(tm.seeds[0].manifest.btih, site.infoHash);
  assert.equal(tm.seeds[0].blobs.size, SITE_FILES.length, 'blobs come from IndexedDB without hashing the whole site');
  assert.equal(tm.seeds[0].record.btih, site.infoHash);
  assert.equal(tm.downloads.length, 0);
  await until(() => tm.anchors.length === 1, { label: 'anchor' });
  assert.deepEqual(tm.anchors[0][1], ['wss://tracker.example'], 'a signed pointer\'s tr list, exactly');
  await until(() => worker.posted.some((m) => m.type === 'mw-map-client'), { label: 'mw-map-client' });
});

test('second visit: a stored torrent that does not hash to the stamped infohash is removed and the copy is fetched again', async () => {
  const site = await buildSite(SITE_FILES);
  const other = await buildSite([{ path: 'x.txt', data: 'other site' }], { name: 'other' });
  const owner = await newOwner();
  const cache = memoryCache();
  cache.store.sites.set(site.infoHash, Object.assign({}, site.manifest, { torrentFile: other.torrentFile }));
  for (const f of site.manifest.files) cache.store.files.set(site.infoHash + '/' + f.path, site.blobs.get(f.path));
  const ctx = await setup({ site, owner, cache });
  await boot(ctx);
  await copied(ctx);
  assert.ok(cache.calls.some((c) => c[0] === 'deleteSite' && c[1] === site.infoHash), 'the poisoned entry is deleted');
  assert.equal(ctx.engine.copy.fromCache, false);
  assert.equal(ctx.tmod.instances[0].downloads.length, 1);
});

test('second visit: an incomplete copy (a file with the wrong size) is not trusted', async () => {
  const site = await buildSite(SITE_FILES);
  const cache = memoryCache();
  putSite(cache, site);
  cache.store.files.set(site.infoHash + '/data.json', new Blob(['short']));
  const ctx = await setup({ site, cache });
  await boot(ctx);
  await copied(ctx);
  assert.equal(ctx.engine.copy.fromCache, false);
});

test('a site with its own Service Worker: nothing is registered over it, one console line with the recipe, no web seed', async () => {
  const con = captureConsole();
  try {
    const own = new FakeWorker(ORIGIN + '/sw.js');
    const sw = fakeServiceWorker({ registration: { scope: ORIGIN + '/', active: own, waiting: null, installing: null, unregister: async () => {} }, controller: own });
    const ctx = await setup({ win: { serviceWorker: sw } });
    await boot(ctx);
    // A hand-written worker never answers mw-ping: the engine decides after the 1.5 s ping window.
    await advanceUntil(ctx, () => ctx.tmod.instances[0] && ctx.tmod.instances[0].downloads.length === 1, { label: 'download' });
    assert.equal(sw.calls.register.length, 0, 'register() was never called: the foreign worker is untouched');
    assert.equal(ctx.engine.inspect().sw.mode, 'foreign');
    assert.equal(con.infos.length, 1);
    assert.ok(con.infos[0].includes("importScripts('/_mw/sw-core.js')"));
    assert.ok(con.infos[0].includes('self.mw.owns(event)'));
    assert.deepEqual(ctx.tmod.instances[0].downloads[0].record.ws, [], 'no web seed without our rewrite');
    assert.equal(con.warns.length, 0);
    assert.equal(ctx.chain.FakeChainNode.opened.length, 1, 'ledger and sharing still run');
    assert.equal(own.posted.filter((m) => m.type === 'mw-map-client').length, 0, 'a worker that never opted in gets no messages beyond the ping');
  } finally {
    con.restore();
  }
});

test('a site worker that imports sw-core.js answers mw-ping: it serves the web seed and gets the client mapping', async () => {
  const con = captureConsole();
  try {
    const own = new FakeWorker(ORIGIN + '/sw.js', (m) => {
      if (m.type === 'mw-ping') return { proto: 1, type: 'mw-pong', buildId: 'x', mode: 'dropin', foreign: true };
      if (m.type === 'mw-map-client' || m.type === 'mw-site-saved') return { proto: 1, type: 'mw-ack', of: m.type, ok: true, btih: m.btih };
      if (m.type === 'mw-get-clients') return { proto: 1, type: 'mw-clients', clients: {}, current: null };
      return null;
    });
    const sw = fakeServiceWorker({ registration: { scope: ORIGIN + '/', active: own, waiting: null, installing: null, unregister: async () => {} }, controller: own });
    const ctx = await setup({ win: { serviceWorker: sw } });
    await boot(ctx);
    await copied(ctx);
    assert.equal(sw.calls.register.length, 0);
    assert.equal(ctx.engine.inspect().sw.mode, 'integrated');
    assert.equal(con.infos.length, 0, 'no recipe for a site that already integrated');
    assert.equal(con.warns.length, 0);
    assert.deepEqual(ctx.tmod.instances[0].downloads[0].record.ws, ['https://site.test/_mw/ws/']);
    assert.ok(own.posted.some((m) => m.type === 'mw-map-client'));
    assert.ok(own.posted.some((m) => m.type === 'mw-site-saved'));
  } finally {
    con.restore();
  }
});

test('data-mw-sw="off": no registration, no web seed, our own earlier registration is removed; the ledger still runs', async () => {
  const worker = oursWorker();
  let unregistered = 0;
  const sw = fakeServiceWorker({ registration: { scope: ORIGIN + '/', active: worker, waiting: null, installing: null, unregister: async () => { unregistered++; } }, controller: null });
  const ctx = await setup({ options: { sw: 'off', consent: 'notice' }, win: { serviceWorker: sw } });
  await boot(ctx);
  await until(() => ctx.tmod.instances[0] && ctx.tmod.instances[0].downloads.length === 1, { label: 'download' });
  assert.equal(sw.calls.register.length, 0);
  assert.equal(unregistered, 1);
  assert.equal(ctx.engine.inspect().sw.mode, 'off');
  assert.deepEqual(ctx.tmod.instances[0].downloads[0].record.ws, []);
  assert.equal(ctx.chain.FakeChainNode.opened.length, 1);
});

test('kill switch: a deployed kill switch is never registered again by pages that still load /_mw/mw.js (no reload loop)', async () => {
  const con = captureConsole();
  try {
    const killText = 'self.addEventListener("install",()=>{});self.addEventListener("activate",e=>{e.waitUntil((async()=>{await self.registration.unregister()})())})';
    const realText = 'self.addEventListener("install",()=>{});self.addEventListener("fetch",e=>{});/* the normal worker */';
    for (const [prefs, body, expectRegister, expectFetch] of [
      [{ 'sw:registered': 1 }, killText, false, true],
      [{ 'sw:registered': 1 }, realText, true, true],
      [{}, killText, true, false], // never registered here: nothing to compare with, one visit registers (and the worker reloads the page once)
    ]) {
      const ctx = await setup({ prefs });
      const fetched = [];
      const seenAtRegister = [];
      const container = ctx.win.navigator.serviceWorker;
      const realRegister = container.register.bind(container);
      container.register = (...args) => { seenAtRegister.push(ctx.cache.store.prefs.has('sw:registered')); return realRegister(...args); };
      ctx.win.fetch = async (url, init) => { fetched.push([String(url), init && init.cache]); return new Response(body, { status: 200 }); };
      await boot(ctx);
      await advanceUntil(ctx, () => ctx.engine.inspect().sw.reason !== undefined && (ctx.win.navigator.serviceWorker.calls.register.length > 0 || ctx.engine.inspect().sw.reason === 'kill-switch'), { label: 'sw decision' });
      assert.equal(ctx.win.navigator.serviceWorker.calls.register.length > 0, expectRegister, JSON.stringify(prefs) + ' ' + body.slice(0, 20));
      if (expectRegister && !prefs['sw:registered']) assert.equal(seenAtRegister[0], true, 'the note is written before register(), a kill switch may reload the page at once');
      assert.equal(fetched.some((f) => f[0] === '/mw-sw.js' && f[1] === 'no-cache'), expectFetch, 'the worker script is only looked at when we registered here before and now have no registration');
      if (!expectRegister) {
        assert.equal(ctx.engine.inspect().sw.mode, 'none');
        assert.equal(ctx.engine.inspect().sw.reason, 'kill-switch');
        assert.match(con.warns.join('\n'), /kill switch/);
      } else {
        await until(() => ctx.cache.store.prefs.has('sw:registered') && ctx.cache.store.prefs.get('sw:registered') > 0, { label: 'registration remembered' });
      }
      ctx.engine.destroy();
    }
  } finally {
    con.restore();
  }
});

test('kill switch: a mw-reload from the worker reloads the page once, and never after destroy()', async () => {
  const worker = oursWorker();
  const sw = fakeServiceWorker({ controlOnRegister: worker });
  const ctx = await setup({ win: { serviceWorker: sw } });
  await boot(ctx);
  await copied(ctx);
  assert.equal(ctx.win.location.reloaded, 0);
  sw.emit('message', { data: { proto: 1, type: 'mw-reload' } });
  sw.emit('message', { data: { proto: 1, type: 'mw-reload' } });
  assert.equal(ctx.win.location.reloaded, 1, 'once, even if the worker asks twice');
  assert.ok(ctx.engine.inspect().logs.some((l) => /kill switch asked this page to reload/.test(l)));
  ctx.engine.destroy();

  const other = await setup({ win: { serviceWorker: fakeServiceWorker({ controlOnRegister: oursWorker() }) } });
  await boot(other);
  await copied(other);
  other.win.location.reload = () => { throw new Error('locked down'); };
  assert.doesNotThrow(() => other.win.navigator.serviceWorker.emit('message', { data: { proto: 1, type: 'mw-reload' } }));
  other.engine.destroy();
});

test('browsers without Service Workers: the engine still runs (peers only after consent), no web seed', async () => {
  const ctx = await setup({ win: { serviceWorker: null } });
  await boot(ctx);
  await until(() => ctx.tmod.instances[0] && ctx.tmod.instances[0].downloads.length === 1, { label: 'download' });
  assert.equal(ctx.engine.inspect().sw.mode, 'none');
  assert.deepEqual(ctx.tmod.instances[0].downloads[0].record.ws, []);
});

test('metered networks (cellular, Save-Data, an unknown phone network) fill the copy from peers only', async () => {
  for (const [label, win, ua] of [
    ['cellular', { connection: { type: 'cellular' } }, undefined],
    ['save-data', { connection: { type: 'wifi', saveData: true } }, undefined],
    ['unknown phone network', { connection: null, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148' }, undefined],
  ]) {
    void ua;
    const ctx = await setup({ win: Object.assign({}, win) });
    await boot(ctx);
    await until(() => ctx.tmod.instances[0] && ctx.tmod.instances[0].downloads.length === 1, { label: label + ' download' });
    assert.deepEqual(ctx.tmod.instances[0].downloads[0].record.ws, [], label);
    assert.equal(ctx.engine.policy.column, 'cellular', label);
    assert.ok(ctx.tmod.instances[0].downloads[0].maxBytes <= 25165824, label + ': the 24 MiB cap');
  }
});

test('nothing can fetch a copy (no web seed, host-only consent): webtorrent is never loaded', async () => {
  const cache = memoryCache();
  const site = await buildSite(SITE_FILES);
  const owner = await newOwner();
  const probe = await stampFor({ owner, btih: site.infoHash });
  cache.store.prefs.set(...consentPref(probe, 'host-only'));
  const ctx = await setup({ site, owner, cache, win: { serviceWorker: null } });
  await boot(ctx);
  await until(() => ctx.engine.copyError === 'no-source', { label: 'no source' });
  assert.equal(ctx.loads.webtorrent, 0);
  assert.equal(ctx.engine.copy, null);
  assert.equal(ctx.chain.FakeChainNode.opened.length, 1, 'the ledger works anyway');
});

test('download failures are one warning each and leave the page alone', async () => {
  const con = captureConsole();
  try {
    for (const [code, re] of [
      ['E_TOO_LARGE', /larger than allowed/],
      ['E_NO_PEERS', /Nobody is sharing/],
      ['E_TIMEOUT', /stalled/],
      ['E_BAD_TORRENT', /does not match/],
    ]) {
      const ctx = await setup({ tmOpts: { downloadError: Object.assign(new Error(code), { code, length: 30e6, maxBytes: 24e6 }) } });
      await boot(ctx);
      await until(() => ctx.engine.copyError === code, { label: code });
      assert.equal(ctx.engine.copy, null);
      assert.match(con.warns[con.warns.length - 1], re, code);
      assert.match(con.warns[con.warns.length - 1], /host keeps serving every file/);
    }
    const before = con.warns.length;
    const aborted = await setup({ tmOpts: { downloadError: Object.assign(new Error('aborted'), { code: 'E_ABORTED' }) } });
    await boot(aborted);
    await until(() => aborted.engine.copyError === 'E_ABORTED', { label: 'aborted' });
    assert.equal(con.warns.length, before, 'an abort is silent');
    assert.match(con.warns.find((w) => /larger than allowed/.test(w)), /29\.\d MB|28\.\d MB|30 MB/, 'sizes are readable');
  } finally {
    con.restore();
  }
});

test('a copy that cannot be stored (quota) is reported once and the download is still usable', async () => {
  const con = captureConsole();
  try {
    const cache = memoryCache();
    cache.saveError = Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
    const ctx = await setup({ cache });
    await boot(ctx);
    await copied(ctx);
    assert.equal(cache.store.sites.size, 0);
    assert.match(con.warns.join('\n'), /no room to keep it on this device/);
  } finally {
    con.restore();
  }
});

test('version cleanup: the previous version stays while a client still renders it, then goes', async () => {
  const oldSite = await buildSite([{ path: 'old.txt', data: 'version one' }], { name: 'v1' });
  const owner = await newOwner();
  for (const [clients, expectKept] of [[{}, false], [null, true]]) {
    const cache = memoryCache();
    putSite(cache, oldSite);
    const worker = oursWorker({ clients: clients === null ? { [oldSite.infoHash]: 1 } : clients });
    const site = await buildSite(SITE_FILES);
    const probe = await stampFor({ owner, btih: site.infoHash });
    cache.store.prefs.set('versions:' + await ledgerIdOf(probe), [oldSite.infoHash]);
    const ctx = await setup({ site, owner, cache, win: { serviceWorker: fakeServiceWorker({ controlOnRegister: worker }) } });
    await boot(ctx);
    await until(() => cache.store.prefs.get('versions:' + ctx.engine.ledgerId).includes(site.infoHash), { label: 'versions pref' });
    const versions = cache.store.prefs.get('versions:' + ctx.engine.ledgerId);
    assert.equal(versions[0], site.infoHash);
    assert.equal(cache.store.sites.has(oldSite.infoHash), expectKept, 'previous version kept only while a client renders it');
    assert.equal(versions.includes(oldSite.infoHash), expectKept);
  }
});

test('E_CACHE_CORRUPT from the TorrentManager removes the copy and fetches it again once', async () => {
  const site = await buildSite(SITE_FILES);
  const cache = memoryCache();
  putSite(cache, site);
  const owner = await newOwner();
  const probe = await stampFor({ owner, btih: site.infoHash });
  cache.store.prefs.set(...consentPref(probe, 'accepted'));
  const con = captureConsole();
  try {
    const ctx = await setup({ site, owner, cache });
    await boot(ctx);
    ctx.clock.advance(3000);
    await until(() => ctx.tmod.instances[0] && ctx.tmod.instances[0].seeds.length === 1, { label: 'seeded' });
    const tm = ctx.tmod.instances[0];
    tm.dispatchEvent(new CustomEvent('warning', { detail: { code: 'E_CACHE_CORRUPT', btih: site.infoHash, piece: 0 } }));
    await until(() => tm.downloads.length === 1, { label: 'refetch' });
    assert.ok(cache.calls.some((c) => c[0] === 'deleteSite'));
    assert.ok(tm.calls.some((c) => c[0] === 'stopSite'));
    tm.dispatchEvent(new CustomEvent('warning', { detail: { code: 'E_CACHE_CORRUPT' } }));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(tm.downloads.length, 1, 'only once per page view');
    assert.match(con.warns.join('\n'), /damaged and was removed/);
  } finally {
    con.restore();
  }
});

test('the worker\'s mw-site-invalid for this version drops the copy and fetches it again', async () => {
  const worker = oursWorker();
  const sw = fakeServiceWorker({ controlOnRegister: worker });
  const ctx = await setup({ win: { serviceWorker: sw } });
  await boot(ctx);
  await copied(ctx);
  const tm = ctx.tmod.instances[0];
  sw.emit('message', { data: { proto: 1, type: 'mw-site-invalid', btih: 'f'.repeat(40), reason: 'mismatch' } });
  assert.ok(ctx.engine.copy, 'another version\'s message changes nothing');
  sw.emit('message', { data: { proto: 1, type: 'mw-site-invalid', btih: ctx.site.infoHash, reason: 'mismatch', path: 'css/app.3f2a1b.css' } });
  await until(() => tm.downloads.length === 2, { label: 'second download' });
});

test('key change: the visitor decides; Keep refuses (and remembers), Confirm re-pins', async () => {
  const con = captureConsole();
  try {
    const a = await newOwner();
    const b = await newOwner();
    const site = await buildSite(SITE_FILES);
    const cache = memoryCache();
    cache.store.pins.set('site.test', { owner: a.pub, decidedAt: 1, firstSeen: 1 });
    const keep = await setup({ site, owner: b, cache });
    const p = keep.engine.start();
    await until(() => hostOf(keep.win), { label: 'key-change prompt' });
    assert.equal(keep.engine.state, 'starting');
    const host = hostOf(keep.win);
    assert.ok(host.buttonByText(S.keyChangedKeep) && host.buttonByText(S.keyChangedConfirm));
    host.buttonByText(S.keyChangedKeep).click();
    await p;
    assert.equal(keep.engine.state, 'off');
    assert.equal(keep.engine.offReason, 'pointer:owner-changed');
    assert.equal(cache.store.prefs.get('keyRefused:site.test:' + b.pub), true);
    assert.equal(cache.store.pins.get('site.test').owner, a.pub, 'the remembered key stays');
    assert.equal(hostOf(keep.win), null);

    const again = await setup({ site, owner: b, cache });
    await boot(again);
    assert.equal(again.engine.offReason, 'pointer:owner-changed');
    assert.equal(hostOf(again.win), null, 'asked once, not on every page view');

    const confirmCache = memoryCache();
    confirmCache.store.pins.set('site.test', { owner: a.pub, decidedAt: 1, firstSeen: 1 });
    const yes = await setup({ site, owner: b, cache: confirmCache });
    const q = yes.engine.start();
    await until(() => hostOf(yes.win), { label: 'prompt 2' });
    hostOf(yes.win).buttonByText(S.keyChangedConfirm).click();
    await until(() => yes.engine.state === 'ready', { label: 'ready' });
    yes.clock.advance(200);
    await q;
    assert.equal(yes.engine.state, 'running');
    assert.equal(confirmCache.store.pins.get('site.test').owner, b.pub, 'the new key is remembered from now on');
  } finally {
    con.restore();
  }
});

test('settings: share on/off, share on this network, forget this site', async () => {
  const ctx = await setup({ win: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148' } });
  await boot(ctx);
  await copied(ctx);
  const { engine, cache } = ctx;
  const tm = ctx.tmod.instances[0];
  await engine.openSettings();
  assert.equal(engine.panel.settingsOpen, true);
  const model = await engine.settingsModel();
  assert.equal(model.isMobile, true);
  assert.equal(model.canForget, true);
  assert.equal(model.share, true);
  await engine.changeSetting('share', { on: false });
  assert.equal(cache.store.prefs.get('uploads'), false);
  assert.equal(engine.policy.uploadsEnabled, false);
  assert.ok(tm.calls.some((c) => c[0] === 'setUploadsEnabled' && c[1] === false));
  assert.equal(engine.policy.column, 'cellular', 'a phone with an unknown network');
  await engine.changeSetting('shareOnNetwork', { on: true });
  assert.equal(cache.store.prefs.get('shareOnNetwork:https://site.test'), true);
  assert.equal(engine.policy.column, 'mobileWifi');
  await engine.changeSetting('forget');
  assert.ok(cache.calls.some((c) => c[0] === 'deleteSite' && c[1] === ctx.site.infoHash));
  assert.equal(engine.copy, null);
  assert.deepEqual(cache.store.prefs.get('versions:' + engine.ledgerId), []);
  assert.ok(tm.destroyed, 'the engine stopped sharing it');
  await engine.changeSetting('unknown-action');
});

test('v0.2.1 A4: identity export and import from the panel Settings (passphrase-wrapped; never through window.mw)', async () => {
  const ctx = await setup({});
  await boot(ctx);
  const { engine } = ctx;
  await until(() => engine.identityInfo, { label: 'identity' });
  const model = await engine.settingsModel();
  // v0.3: the panel (lane ui) shows Export and Import only for identity.legacy === true (a build without the
  // identity service, as here), "Open identity page" otherwise.
  assert.deepEqual(Object.keys(model.identity).sort(), ['canExport', 'canImport', 'legacy', 'name', 'short']);
  assert.equal(model.identity.legacy, true);
  assert.equal(model.identity.canExport, true);
  assert.equal(engine.mw.identity.export, undefined, 'the site cannot export');
  await engine.openSettings();
  const files = [];
  engine.downloadText = (name, text) => { files.push({ name, text }); return true; };
  await engine.changeSetting('exportIdentity', { passphrase: 'short' });
  assert.equal(files.length, 0, 'a short passphrase exports nothing');
  await engine.changeSetting('exportIdentity', { passphrase: 'correct horse battery' });
  assert.equal(files.length, 1);
  assert.match(files[0].name, /^identity-[A-Za-z0-9._-]+\.json$/);
  const exported = JSON.parse(files[0].text);
  assert.equal(exported.type, 'mw-identity');
  assert.equal(exported.pub, engine.identityInfo.pub);
  assert.equal(exported.ledger, engine.ledgerId);
  // Import: a wrong passphrase is refused; the right one stores the key (the page reloads to use it).
  const before = ctx.cache.store.keys.get('identity:' + engine.ledgerId);
  await engine.changeSetting('importIdentity', { text: files[0].text, passphrase: 'wrong passphrase' });
  assert.equal(ctx.cache.store.keys.get('identity:' + engine.ledgerId), before, 'nothing stored after a wrong passphrase');
  let reloaded = 0;
  engine.loc.reload = () => { reloaded++; };
  await engine.changeSetting('importIdentity', { text: files[0].text, passphrase: 'correct horse battery' });
  assert.equal(ctx.cache.store.keys.get('identity:' + engine.ledgerId).pub, engine.identityInfo.pub);
  ctx.clock.advance(300);
  assert.equal(reloaded, 1, 'the page reloads to use the imported key');
});

test('cs= snapshot: fetched after the ledger opens and offered to importSnapshot', async () => {
  const blocks = [{ h: 'c'.repeat(64), e: { prev: [] }, s: 'sig' }];
  const ctx = await setup({ stamp: { more: { cs: '/snapshots/ledger.json' } } });
  const fetched = [];
  ctx.win.fetch = async (url) => { fetched.push(url); return new Response(JSON.stringify(blocks), { status: 200, headers: { 'content-type': 'application/json' } }); };
  await boot(ctx);
  await until(() => ctx.chain.FakeChainNode.opened[0] && ctx.chain.FakeChainNode.opened[0].imported, { label: 'snapshot' });
  assert.deepEqual(fetched, ['https://site.test/snapshots/ledger.json']);
  assert.deepEqual(ctx.chain.FakeChainNode.opened[0].imported, blocks);
});

test('code review round 1: a gzip cs= snapshot is read without DecompressionStream (Safari and iOS 15.4 to 16.3)', async () => {
  const { gzipSync } = await import('node:zlib');
  const blocks = [{ h: 'c'.repeat(64), e: { prev: [] }, s: 'sig' }, { h: 'd'.repeat(64), e: { prev: ['c'.repeat(64)] }, s: 'sig' }];
  const ctx = await setup({ stamp: { more: { cs: '/snapshots/ledger.json.gz' } } });
  ctx.win.DecompressionStream = undefined;
  const gz = gzipSync(Buffer.from(JSON.stringify(blocks)));
  ctx.win.fetch = async () => new Response(gz, { status: 200 });
  await boot(ctx);
  await until(() => ctx.chain.FakeChainNode.opened[0] && ctx.chain.FakeChainNode.opened[0].imported, { label: 'snapshot' });
  assert.deepEqual(ctx.chain.FakeChainNode.opened[0].imported, blocks, 'every block is offered to the node');
});

test('identity export and import are loader-owned (v0.2.1 A4): not on window.mw; the engine\'s identity API wraps, unwraps and reloads', async () => {
  const ctx = await setup({});
  await boot(ctx);
  assert.equal(ctx.engine.mw.identity.export, undefined, 'a site cannot export the visitor\'s identity');
  assert.equal(ctx.engine.mw.identity.import, undefined, 'a site cannot replace the visitor\'s identity');
  const text = await ctx.engine.identityApi().export('correct horse');
  assert.equal(JSON.parse(text).type, 'mw-identity');
  assert.equal(JSON.parse(text).ledger, ctx.engine.ledgerId);
  const other = await setup({ site: ctx.site, owner: ctx.owner });
  await boot(other);
  const before = other.engine.identityInfo.pub;
  const res = await other.engine.identityApi().import(text, 'correct horse');
  assert.equal(res.pub, ctx.engine.identityInfo.pub);
  assert.notEqual(res.pub, before);
  assert.equal(other.win.location.reloaded, 0);
  other.clock.advance(300);
  assert.equal(other.win.location.reloaded, 1, 'reload so the ledger node signs with the imported key');
});

test('window.mw behaviour before the engine is ready: ready() waits for the ledger, writes forward to the node', async () => {
  const ctx = await setup({});
  const pending = ctx.engine.mw.ready();
  await boot(ctx);
  const info = await pending;
  assert.equal(info.siteId, ctx.engine.ledgerId);
  assert.deepEqual(await ctx.engine.mw.db.append('guestbook', 'hello'), { h: 'b'.repeat(64) });
  assert.deepEqual(ctx.chain.FakeChainNode.opened[0].calls[0], ['append', 'guestbook', 'hello']);
  const snaps = [];
  ctx.engine.mw.db.subscribe((s) => snaps.push(s.height));
  await until(() => snaps.length >= 1, { label: 'snapshot' });
  assert.equal(snaps[0], 3);
});

test('the diagnostics log counts a repeated line instead of repeating it, and stays capped', async () => {
  const ctx = await setup({});
  const e = ctx.engine;
  for (let i = 0; i < 5; i++) e.log('warning torrent: Piece 0 failed verification');
  e.log('something else');
  e.log('something else');
  assert.deepEqual(e.logs, ['warning torrent: Piece 0 failed verification (x5)', 'something else (x2)']);
  for (let i = 0; i < 400; i++) e.log('line ' + i);
  assert.equal(e.logs.length, 300);
});

test('inspect() summarises the page view for diagnostics and tests', async () => {
  const ctx = await setup({});
  await boot(ctx);
  await copied(ctx);
  const i = ctx.engine.inspect();
  assert.equal(i.state, 'running');
  assert.equal(i.btih, ctx.site.infoHash);
  assert.equal(i.leader, true);
  assert.equal(i.signed, true);
  assert.equal(i.consent, 'pending');
  assert.equal(i.copy.btih, ctx.site.infoHash);
  assert.equal(i.copy.fromCache, false);
  assert.equal(i.webrtc, true);
  assert.equal(i.policy.column, 'desktop');
  assert.ok(Array.isArray(i.logs) && i.logs.length > 0);
  ctx.engine.destroy();
  assert.equal(ctx.engine.inspect().state, 'destroyed');
  assert.ok(ctx.tmod.instances[0].destroyed);
  assert.ok(ctx.chain.FakeChainNode.opened[0].closed);
});

void FakeLockManager;

test('v0.2.1 A3: a signed withdrawal stamp keeps nothing: engine off, every stored copy deleted, the withdrawal cached, nothing loaded or announced', async () => {
  const site = await buildSite(SITE_FILES);
  const owner = await newOwner();
  const mem = memoryCache();
  // A copy of the earlier version and the record that named it are stored on this origin.
  const OLD = 'e'.repeat(40);
  mem.store.sites.set(OLD, { btih: OLD, complete: true, files: [] });
  mem.store.sites.set(site.infoHash, { btih: site.infoHash, complete: true, files: [] });
  mem.store.pointers.set('site.test', { record: { btih: OLD, signed: true, seq: 1, owner: owner.pub }, raw: 'old', source: 'meta' });
  const ledgerId = await ledgerIdFor(parsePointer(await stampFor({ owner, btih: site.infoHash })).record, 'site.test');
  mem.store.prefs.set('versions:' + ledgerId, [site.infoHash]);
  // Fail closed: even with a real btih in it, st=withdrawn names nothing to serve.
  const con = captureConsole();
  try {
    const ctx = await setup({ site, owner, cache: mem, stamp: { seq: 2, more: { st: 'withdrawn', why: 'copyright', ct: 'mailto:abuse@example.com' } } });
    await boot(ctx);
    assert.equal(ctx.engine.state, 'off');
    assert.equal(ctx.engine.offReason, 'withdrawn');
    assert.equal(mem.store.sites.size, 0, 'the old version and the current one are both deleted');
    assert.deepEqual(mem.store.prefs.get('versions:' + ledgerId), []);
    assert.equal(mem.store.pointers.get('site.test').record.withdrawn, true, 'the withdrawal is the cached record now');
    const info = ctx.engine.inspect();
    assert.deepEqual(info.withdrawn, { why: 'copyright', ct: 'mailto:abuse@example.com', deleted: 2 });
    assert.equal(ctx.loads.torrent, 0, 'no torrent code: nothing is fetched, served or seeded');
    assert.equal(ctx.loads.webtorrent, 0);
    assert.equal(con.warns.length, 1);
    assert.match(con.warns[0], /withdrew this site.*copyright/);
    await assert.rejects(ctx.engine.mw.db.set('k', 1), (e) => e.code === 'E_IDENTITY');
    await assert.rejects(ctx.engine.mw.consent.request(), (e) => e.code === 'E_NO_HOST');
  } finally {
    con.restore();
  }
});

test('code review round 1: Wi-Fi to mobile data during a copy through the host web seed restarts it from peers only, with the metered caps', async () => {
  const conn = new EventTarget();
  conn.type = 'wifi';
  conn.saveData = false;
  const ctx = await setup({ win: { connection: conn }, tmOpts: { hold: true } });
  await boot(ctx);
  await until(() => ctx.tmod.instances[0] && ctx.tmod.instances[0].downloads.length === 1, { label: 'first download' });
  const tm = ctx.tmod.instances[0];
  assert.ok(tm.downloads[0].record.ws.length > 0, 'on Wi-Fi the copy uses the host web seed');
  assert.equal(ctx.engine.policy.column, 'desktop');
  conn.type = 'cellular';
  conn.dispatchEvent(new Event('change'));
  await until(() => tm.downloads.length === 2, { label: 'the copy restarted' });
  assert.deepEqual(tm.downloads[1].record.ws, [], 'no /_mw/ws/ web seed on mobile data');
  assert.equal(ctx.engine.policy.column, 'cellular');
  assert.ok(tm.downloads[1].maxBytes <= 25165824, 'the 24 MiB cap');
  // Back on Wi-Fi: nothing restarts (the peer copy goes on); the next copy may use the web seed again.
  conn.type = 'wifi';
  conn.dispatchEvent(new Event('change'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(tm.downloads.length, 2);
  assert.equal(ctx.engine.policy.column, 'desktop');
  tm.release();
  await copied(ctx);
  ctx.engine.stop && ctx.engine.stop();
});

test('code review round 1: a drop-in phone keeps its client when hidden (C2 lock) and rebuilds it after more than 10 s', async () => {
  const ctx = await setup({ win: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Mobile Safari/537.36', connection: { type: 'wifi' } } });
  await boot(ctx);
  await until(() => ctx.tmod.instances[0], { label: 'tm' });
  const tm = ctx.tmod.instances[0];
  assert.equal(ctx.engine.env.isMobile, true);
  assert.equal(ctx.engine.policy.rebuildAfterHiddenMs, 10000);
  const doc = ctx.win.document;
  doc.setVisibility('hidden');
  assert.equal(tm.calls.some((c) => c[0] === 'pause'), false, 'hidden: the client stays (the TorrentManager locks uploads itself)');
  ctx.clock.advance(9000);
  doc.setVisibility('visible');
  assert.equal(tm.calls.some((c) => c[0] === 'rebuild'), false, 'back after 9 s: no rebuild');
  doc.setVisibility('hidden');
  ctx.clock.advance(11000);
  doc.setVisibility('visible');
  assert.equal(tm.calls.filter((c) => c[0] === 'rebuild').length, 1, 'back after 11 s: rebuilt (the phone value, not the desktop 60 s)');
});
