// Unit tests for the multi-tab and lifecycle behaviour of src/dropin/engine.js: one engine per
// origin (Web Locks + BroadcastChannel, follower tabs, promotion), pagehide closing everything for
// the back/forward cache and pageshow starting it again, hidden tabs on phones and on battery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DropinEngine } from '../../src/dropin/engine.js';
import { RemoteNode } from '../../src/dropin/leader.js';
import { ledgerIdFor, parsePointer } from '../../src/common/pointer.js';
import { createClock } from './dropin-fake-timers.mjs';
import {
  until, buildSite, SITE_FILES, newOwner, stampFor, memoryCache, putSite, chainModule, torrentModule, fakeServiceWorker,
  oursWorker, fakeWindow, FakeLockManager, broadcastHub, consentPref, storedConsent,
} from './dropin-fakes.mjs';

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148';

/** One shared browser: a site, an owner, one IndexedDB, one lock manager, one BroadcastChannel hub. */
async function browser({ withCopy = false, consent = null } = {}) {
  const site = await buildSite(SITE_FILES);
  const owner = await newOwner();
  const text = await stampFor({ owner, btih: site.infoHash });
  const cache = memoryCache();
  if (withCopy) putSite(cache, site);
  const ledgerId = await ledgerIdFor(parsePointer(text).record, 'site.test');
  // v0.2.1 C1: a returning visitor's choice is the versioned per-origin record (was 'consent:<ledgerId>' = state).
  if (consent) cache.store.prefs.set(...consentPref(text, consent));
  return { site, owner, text, cache, ledgerId, locks: new FakeLockManager(), hub: broadcastHub() };
}

function tab(b, winOpts = {}, { tmOpts } = {}) {
  const chain = chainModule();
  const tmod = torrentModule(b.site, tmOpts);
  const clock = createClock(Date.now());
  const worker = oursWorker();
  const win = fakeWindow(Object.assign({ stamp: b.text, locks: b.locks, hub: b.hub, serviceWorker: fakeServiceWorker({ controlOnRegister: worker }) }, winOpts));
  const loads = { webtorrent: 0 };
  const deps = {
    cache: async () => b.cache,
    verify: () => import('../../src/loader/verify.js'),
    torrentFile: () => import('../../src/common/torrent-file.js'),
    crypto: () => import('../../src/chain/crypto.js'),
    torrent: async () => tmod,
    chain: async () => chain,
    webtorrent: async () => { loads.webtorrent++; return class WebTorrent {}; },
  };
  // swRecheckMs: 0 keeps these timelines; the empty-scope re-check has its own tests in dropin-swreg.
  const engine = new DropinEngine({ win, deps, options: { swRecheckMs: 0 }, timers: clock.timers() });
  return { engine, win, chain, tmod, clock, worker, loads, site: b.site };
}

async function boot(t) {
  const p = t.engine.start();
  await until(() => t.engine.state === 'ready' || t.engine.state === 'off', { label: 'evaluate' });
  if (t.engine.state === 'ready') t.clock.advance(200);
  await p;
  if (t.engine.ledgerPromise) await t.engine.ledgerPromise;
  return t;
}

const flushSoon = () => new Promise((r) => setTimeout(r, 15));

test('two tabs: the first leads, the second follows through the channel and never builds an engine of its own', async () => {
  const b = await browser();
  const a = await boot(tab(b));
  const f = await boot(tab(b));
  assert.equal(a.engine.isLeader, true);
  assert.equal(f.engine.isLeader, false);
  assert.equal(f.engine.inspect().leader, false);
  assert.ok(f.engine.node instanceof RemoteNode);
  assert.equal(a.chain.FakeChainNode.opened.length, 1);
  assert.equal(f.chain.FakeChainNode.opened.length, 0, 'only the leader opens the ledger');
  assert.equal(f.loads.webtorrent, 0);
  assert.equal(f.tmod.instances.length, 0, 'and only the leader has a TorrentManager');
  assert.equal(b.locks.held.get('mw-swarm-' + b.ledgerId), true);
  assert.equal(b.hub.channels.filter((c) => c.name === 'mw-' + b.ledgerId && !c.closed).length, 2);
});

test('follower: reads the leader\'s ledger state, forwards its writes, shares the consent decision', async () => {
  const b = await browser();
  const a = await boot(tab(b));
  const f = await boot(tab(b));
  a.chain.FakeChainNode.opened[0].height = 9;
  a.chain.FakeChainNode.opened[0].emit();
  a.clock.advance(250);
  await until(() => f.engine.node.height === 9, { label: 'state reached the follower' });
  assert.equal(await f.engine.mw.db.get('notice'), 'hi');
  const snaps = [];
  f.engine.mw.db.subscribe((s) => snaps.push(s.height));
  // The follower's binding throttles on the follower's own (fake) clock: a delivery held back for the
  // rest of the 250 ms interval only happens when that clock moves on, so move it while waiting.
  await until(() => { f.clock.advance(250); return snaps.includes(9); }, { label: 'follower snapshot' });
  const res = await f.engine.mw.db.set('k', { a: 1 });
  assert.deepEqual(res, { h: 'b'.repeat(64) });
  assert.deepEqual(a.chain.FakeChainNode.opened[0].calls, [['put', 'k', { a: 1 }]], 'the write ran in the leader tab');
  assert.equal((await f.engine.mw.ready()).role, 'writer');

  await a.engine.consent.set('accepted');
  await until(() => f.engine.consent.state() === 'accepted', { label: 'consent follows' });
  assert.equal(storedConsent(b.cache), 'accepted', 'the versioned record (v0.2.1 C1)');
  await f.engine.consent.set('host-only');
  await until(() => a.engine.consent.state() === 'host-only', { label: 'and back' });
});

test('follower: bans from non-moderators are refused in the leader, errors come back with their codes', async () => {
  const b = await browser();
  const a = await boot(tab(b));
  const f = await boot(tab(b));
  a.chain.FakeChainNode.opened[0].role = 'writer';
  a.chain.FakeChainNode.opened[0].emit();
  a.clock.advance(250);
  await until(() => f.engine.node.role === 'writer', { label: 'role' });
  f.engine.node.role = 'moderator'; // the follower believes it can; the leader decides
  await assert.rejects(f.engine.node.ban('A'.repeat(87)), (e) => e.code === 'E_NOT_MODERATOR');
  a.chain.FakeChainNode.opened[0].put = async () => { throw Object.assign(new Error('writers is owner'), { code: 'E_POLICY' }); };
  await assert.rejects(f.engine.mw.db.set('k', 1), (e) => e.code === 'E_POLICY' && /writers is owner/.test(e.message));
});

test('follower: learns that a sibling saved the copy and shows it, without sharing it', async () => {
  const b = await browser();
  const a = await boot(tab(b));
  const f = await boot(tab(b));
  await until(() => a.engine.copy, { label: 'leader copy' });
  const pending = a.engine.obtaining;
  if (pending) await pending;
  await until(() => f.engine.copy, { label: 'follower copy' });
  assert.equal(f.engine.copy.fromCache, true);
  assert.equal((await f.engine.mw.site.info()).btih, b.site.infoHash);
  f.clock.advance(5000);
  assert.equal(f.tmod.instances.length, 0, 'a follower never opens sockets');
});

test('when the leader goes away the follower is promoted, opens the ledger and fetches the copy', async () => {
  const b = await browser();
  const a = await boot(tab(b));
  const f = await boot(tab(b));
  assert.equal(f.engine.isLeader, false);
  a.engine.suspend(); // pagehide in the leader tab: it releases the lock
  await until(() => f.engine.isLeader, { label: 'promotion' });
  assert.equal(f.engine.inspect().leader, true);
  await until(() => f.chain.FakeChainNode.opened.length === 1, { label: 'ledger opened by the new leader' });
  assert.ok(!(f.engine.node instanceof RemoteNode));
  assert.equal(f.engine.followerNode, null);
  await until(() => f.engine.copy || f.tmod.instances[0], { label: 'copy path' });
});

test('without Web Locks every tab leads; without BroadcastChannel a tab cannot follow, so it leads too', async () => {
  const b = await browser();
  const noLocks = await boot(tab(b, { locks: undefined }));
  noLocks.win.navigator.locks = undefined;
  assert.equal(noLocks.engine.isLeader, true);
  const noChannel = tab(b, {});
  noChannel.win.BroadcastChannel = undefined;
  await boot(noChannel);
  assert.equal(noChannel.engine.isLeader, true, 'duplicate engines beat a follower that never gets state');
  assert.equal(noChannel.chain.FakeChainNode.opened.length, 1);
});

test('pagehide closes sockets, peers, ledger, channel and lock; a persisted pageshow starts the engine again', async () => {
  const b = await browser({ withCopy: true, consent: 'accepted' });
  const t = await boot(tab(b));
  t.clock.advance(3000);
  await until(() => t.tmod.instances[0] && t.tmod.instances[0].seeds.length === 1, { label: 'seeding' });
  const tm = t.tmod.instances[0];
  const node = t.chain.FakeChainNode.opened[0];
  const channels = b.hub.channels.filter((c) => c.name === 'mw-' + b.ledgerId);
  assert.equal(t.engine.inspect().announce, true);

  t.win.dispatchEvent({ type: 'pagehide', persisted: true });
  assert.equal(t.engine.suspended, true);
  assert.equal(tm.destroyed, true, 'tracker sockets and peer connections are closed');
  assert.equal(t.engine.inspect().announce, false);
  assert.equal(t.engine.link, null);
  assert.ok(channels.every((c) => c.closed), 'the BroadcastChannel is closed');
  await until(() => node.closed, { label: 'ledger closed' });
  await until(() => !b.locks.held.get('mw-swarm-' + b.ledgerId), { label: 'lock released' });
  assert.equal(t.engine.inspect().leader, false);
  t.win.dispatchEvent({ type: 'pagehide', persisted: true });
  assert.equal(tm.calls.filter((c) => c[0] === 'destroy').length, 1, 'a second pagehide changes nothing');

  t.win.dispatchEvent({ type: 'pageshow', persisted: false });
  assert.equal(t.engine.suspended, true, 'a normal pageshow is not a restore');

  t.win.dispatchEvent({ type: 'pageshow', persisted: true });
  assert.equal(t.engine.suspended, false);
  await until(() => t.engine.isLeader && t.chain.FakeChainNode.opened.length === 2, { label: 'rebuilt: leader with a new ledger node' });
  await until(() => t.engine.copy, { label: 'copy again' });
  assert.equal(t.engine.announceReady(), false, 'announcing waits for 3 s of visibility again');
  t.clock.advance(3000);
  await until(() => t.tmod.instances.length === 2 && t.tmod.instances[1].seeds.length === 1, { label: 'seeding again' });
  assert.notEqual(t.tmod.instances[1], tm);
});

test('freeze and resume behave like pagehide and a persisted pageshow', async () => {
  const b = await browser({ withCopy: true, consent: 'accepted' });
  const t = await boot(tab(b));
  t.clock.advance(3000);
  await until(() => t.tmod.instances[0] && t.tmod.instances[0].seeds.length === 1, { label: 'seeding' });
  t.win.document.dispatchEvent({ type: 'freeze' });
  assert.equal(t.engine.suspended, true);
  assert.equal(t.tmod.instances[0].destroyed, true);
  t.win.document.dispatchEvent({ type: 'resume' });
  await until(() => t.chain.FakeChainNode.opened.length === 2, { label: 'restarted' });
  assert.equal(t.engine.suspended, false);
});

test('a page that never became visible long enough announces nothing and pagehide has little to close', async () => {
  const b = await browser({ withCopy: true, consent: 'accepted' });
  const t = await boot(tab(b));
  t.clock.advance(1000);
  t.win.dispatchEvent({ type: 'pagehide', persisted: false });
  t.clock.advance(60000);
  assert.equal(t.tmod.instances.length, 0, 'a click-through visitor never churned the swarm');
  assert.equal(t.loads.webtorrent, 0);
});

// Code review round 1 (F50): drop-in phones follow the shell's C2 plan (they used to destroy the client on
// every hide and rebuild after the desktop 60 s): the client stays (the TorrentManager choke-locks every
// wire itself) and is rebuilt on return after more than policy.rebuildAfterHiddenMs (10 s on phones).
test('phones: the client stays while hidden (C2 lock) and is rebuilt after more than 10 s away', async () => {
  const b = await browser({ withCopy: true, consent: 'accepted' });
  const t = await boot(tab(b, { userAgent: MOBILE_UA, connection: { type: 'wifi' } }));
  t.clock.advance(3000);
  await until(() => t.tmod.instances[0] && t.tmod.instances[0].seeds.length === 1, { label: 'seeding' });
  const tm = t.tmod.instances[0];
  assert.equal(t.engine.policy.hiddenAction, 'lock');
  t.win.document.setVisibility('hidden');
  assert.equal(tm.calls.some((c) => c[0] === 'pause'), false, 'not destroyed on hide');
  t.clock.advance(5000);
  t.win.document.setVisibility('visible');
  assert.equal(tm.calls.some((c) => c[0] === 'rebuild'), false, 'back within 10 s: nothing to rebuild');
  t.win.document.setVisibility('hidden');
  t.clock.advance(30000);
  t.win.document.setVisibility('visible');
  assert.ok(tm.calls.some((c) => c[0] === 'rebuild'), 'after more than 10 s hidden the client is rebuilt (fresh sockets, tracker back-off reset)');
});

test('desktop on battery: hidden tabs keep sharing for 10 minutes, then the client is paused; online rebuilds', async () => {
  const b = await browser({ withCopy: true, consent: 'accepted' });
  const t = await boot(tab(b, { battery: { charging: false, level: 0.5 } }));
  t.clock.advance(3000);
  await until(() => t.tmod.instances[0] && t.tmod.instances[0].seeds.length === 1, { label: 'seeding' });
  const tm = t.tmod.instances[0];
  assert.equal(t.engine.policy.hiddenBehaviour, 'battery');
  t.win.document.setVisibility('hidden');
  t.clock.advance(599000);
  assert.ok(!tm.calls.some((c) => c[0] === 'pause'), 'still sharing after 9 minutes 59 seconds');
  t.clock.advance(1000);
  assert.ok(tm.calls.some((c) => c[0] === 'pause'), 'paused after 10 minutes hidden on battery');
  t.win.document.setVisibility('visible');
  assert.ok(tm.calls.some((c) => c[0] === 'rebuild'));
  tm.calls.length = 0;
  t.win.dispatchEvent({ type: 'online' });
  assert.ok(tm.calls.some((c) => c[0] === 'rebuild'), 'back online: a fresh client');
});

test('desktop on mains power keeps sharing while hidden', async () => {
  const b = await browser({ withCopy: true, consent: 'accepted' });
  const t = await boot(tab(b));
  t.clock.advance(3000);
  await until(() => t.tmod.instances[0] && t.tmod.instances[0].seeds.length === 1, { label: 'seeding' });
  const tm = t.tmod.instances[0];
  assert.equal(t.engine.policy.hiddenBehaviour, 'keep');
  t.win.document.setVisibility('hidden');
  t.clock.advance(3600000);
  assert.ok(!tm.calls.some((c) => c[0] === 'pause'));
});

test('destroy() leaves nothing behind: lock, channel, sockets, timers', async () => {
  const b = await browser({ withCopy: true, consent: 'accepted' });
  const t = await boot(tab(b));
  t.clock.advance(3000);
  await until(() => t.tmod.instances[0] && t.tmod.instances[0].seeds.length === 1, { label: 'seeding' });
  t.engine.destroy();
  await until(() => !b.locks.held.get('mw-swarm-' + b.ledgerId), { label: 'lock released' });
  assert.ok(t.tmod.instances[0].destroyed);
  assert.ok(b.hub.channels.every((c) => c.closed));
  await flushSoon();
  t.win.dispatchEvent({ type: 'pageshow', persisted: true });
  assert.equal(t.chain.FakeChainNode.opened.length, 1, 'a destroyed engine does not restart');
});

test('code review round 1: a consent message on the tab channel is adopted only when the stored record confirms it; only the click asks for persistent storage', async () => {
  const b = await browser();
  const a = await boot(tab(b));
  const f = await boot(tab(b));
  const persists = () => b.cache.calls.filter((c) => c[0] === 'requestPersist').length;
  // A forged message (no stored choice): ignored.
  a.engine.link.send('consent', { state: 'accepted' });
  await flushSoon();
  assert.equal(f.engine.consent.state(), 'pending', 'a message alone is not a choice');
  // The visitor's click in the leader: stored, broadcast, adopted by the follower; one persist() request.
  await a.engine.consent.set('accepted', { gesture: true });
  await until(() => f.engine.consent.state() === 'accepted', { label: 'consent follows' });
  await until(() => persists() === 1, { label: 'one persist() from the click' });
  await flushSoon();
  assert.equal(persists(), 1, 'the follower did not ask for persistent storage');
});
