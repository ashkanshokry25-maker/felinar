// Unit tests for drop-in mode v0.3 (src/dropin/engine.js, ledger.js, leader.js, mw.js with src/loader/api.js): the
// same tables, services and gating as the shell. The engine tab mounts the identity service (lane idp's drop-in
// adapter, src/dropin/identity.js) and the chat, files and media services; it alone holds keys; follower tabs
// show its auth state and drop it on 'signed-out'; /_mw/idp-return only finishes a redirect sign-in. The working keys
// are lane idp's real WorkingKeys and sign-in goes to a real identity origin in-process (src/idp/idp.js createIdp
// behind client.signIn, as lane idp's own tests do; v0.3 reconciliation); only the window-bound parts of the client
// (completeRedirect, takeDeferredAnswer, openIdentity) are stand-ins. The chat, files and media services are recorders
// at the SVC boundary, so the SDK's own gating can be told apart from theirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { DropinEngine } from '../../src/dropin/engine.js';
import { createDeps } from '../../src/dropin/mw.js';
import { onSignedOut, WorkingKeys } from '../../src/identity/store.js';
import * as identityClient from '../../src/identity/client.js';
import { createIdp } from '../../src/idp/idp.js';
import { openIdoStore } from '../../src/idp/store.js';
import { API_METHODS } from '../../src/loader/api.js';
import { ledgerIdFor, parsePointer } from '../../src/common/pointer.js';
import { createClock } from './dropin-fake-timers.mjs';
import {
  ORIGIN, until, buildSite, SITE_FILES, newOwner, stampFor, memoryCache, chainModule, torrentModule, fakeWindow, FakeLockManager, broadcastHub,
} from './dropin-fakes.mjs';

/** The real WorkingKeys, with every installed set recorded (pub and privateKey read the newest one). */
function keysModule() {
  const made = [];
  class RecordedKeys extends WorkingKeys {
    static async install(bundle, opts) {
      const k = await WorkingKeys.install(bundle, opts);
      made.push(k);
      return k;
    }
  }
  const last = () => made[made.length - 1] || null;
  return {
    FakeKeys: RecordedKeys,
    made,
    get pub() { return last() ? last().pub : null; },
    get privateKey() { return last() ? last().identity.privateKey : null; },
  };
}

/** The identity origin's cards answered as a person would; a passkey with PRF unlocks it. */
function scriptedCards() {
  return new Proxy({ lang: 'en' }, {
    get(t, k) {
      if (k in t) return t[k];
      return async () => {
        if (k === 'signin') return { action: 'continue', mode: { kind: 'private' }, stay: false, sharedComputer: false, hub: null };
        if (k === 'chooseUnlock') return { method: 'passkey', nickname: 'test' };
        if (k === 'busy') return undefined;
        return true;
      };
    },
  });
}

function fakePasskey() {
  const prf = webcrypto.getRandomValues(new Uint8Array(32));
  return {
    async capabilities() { return { webauthn: true, platform: true, prf: true }; },
    async create() { return { credId: 'Y3JlZA', prf, prfEnabled: true, uv: true }; },
    async prfFor({ created }) { return { prf: created.prf, uv: true, credId: created.credId }; },
    async get() { return { credId: 'Y3JlZA', prf, uv: true }; },
  };
}

/** client.signIn against the real identity origin, in process (the popup transport left out). */
async function idoSignIn(idp, raw) {
  const opts = await identityClient.resolveLate(raw);
  const want = opts.want || ['keys'];
  const box = await identityClient.newBoxKey();
  const requestId = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url');
  const req = { v: 1, t: 'mw-signin-req', requestId, purpose: opts.purpose || 'site', want, epk: box.pub };
  for (const k of ['pointer', 'scope', 'shared', 'hubDefault', 'create', 'owner', 'escrow']) if (opts[k] !== undefined && opts[k] !== null) req[k] = opts[k];
  const v = identityClient.validateRequest(req);
  if (!v.ok) throw Object.assign(new Error(v.reason), { code: 'E_BAD_REQUEST' });
  const res = await idp.handleRequest(req, ORIGIN, null);
  if (!res.ok) throw Object.assign(new Error(res.code), { code: res.code });
  return { bundle: await identityClient.open(identityClient.BUNDLE_PREFIX, box.privateKey, res.bundle, { origin: ORIGIN, requestId }) };
}

async function realClient() {
  const store = await openIdoStore({ memory: true });
  const idp = createIdp({
    win: null, doc: null, navigator: null, location: { origin: 'http://localhost:9555' }, cards: scriptedCards(), passkey: fakePasskey(), store,
    wasm: true, ios: false, standalone: false, build: { version: '0.3.0', id: 'test0001', hash: '', test: true },
  });
  const client = {
    calls: [],
    deferred: null,
    redirect: null,
    async signIn(opts) { client.calls.push(['signIn', opts]); return idoSignIn(idp, opts); },
    async completeRedirect(o) { client.calls.push(['completeRedirect', o.defer]); return client.redirect || null; },
    async takeDeferredAnswer() { const a = client.deferred; client.deferred = null; return a; },
    async openIdentity() { client.calls.push(['openIdentity']); return 'done'; },
    /** A real answer of the identity origin, as a finished redirect leaves it for the page that asked. */
    answer: () => idoSignIn(idp, { purpose: 'site', want: ['keys'] }),
  };
  return client;
}

/** Fake chat, files and media services: recorders of their namespace that keep the deps they were made with. */
function serviceModules() {
  const made = {};
  const mk = (name, prefix) => (deps) => {
    const calls = [];
    const methods = {};
    for (const m of API_METHODS.filter((x) => prefix.test(x))) methods[m] = async (params, ctx) => { calls.push({ m, params, ctx }); return { ran: m }; };
    const svc = { deps, calls, methods, on: () => () => {}, destroy() { svc.destroyed = true; } };
    made[name] = svc;
    return svc;
  };
  return {
    made,
    chat: { createChatService: mk('chat', /^chat\./) },
    files: { createFilesService: mk('files', /^files\./) },
    media: { createMediaService: mk('media', /^media\./) },
  };
}

/** A browser for one site: shared IndexedDB fake, locks and BroadcastChannel hub, one identity client and keys. */
async function browser() {
  const site = await buildSite(SITE_FILES);
  const owner = await newOwner();
  const text = await stampFor({ owner, btih: site.infoHash, more: { tr: ['wss://own.site.test/announce'] } });
  const keys = keysModule();
  return { site, owner, text, cache: memoryCache(), locks: new FakeLockManager(), hub: broadcastHub(), keys, client: await realClient(), ledgerId: await ledgerIdFor(parsePointer(text).record, 'site.test') };
}

function tab(b, { winOpts = {}, prefs = null, noStamp = false } = {}) {
  const chain = chainModule();
  const tmod = torrentModule(b.site);
  const clock = createClock(Date.now());
  const win = fakeWindow(Object.assign({ stamp: noStamp ? null : b.text, locks: b.locks, hub: b.hub }, winOpts));
  if (prefs) for (const [k, v] of Object.entries(prefs)) b.cache.store.prefs.set(k, v);
  const services = serviceModules();
  const deps = {
    cache: async () => b.cache,
    verify: () => import('../../src/loader/verify.js'),
    torrentFile: () => import('../../src/common/torrent-file.js'),
    crypto: () => import('../../src/chain/crypto.js'),
    torrent: async () => tmod,
    chain: async () => chain,
    webtorrent: async () => class WebTorrent {},
    v03: async () => ({
      client: b.client, store: { WorkingKeys: b.keys.FakeKeys, onSignedOut }, migrate: { legacyAuthorFor: () => null }, sealed: null,
      chat: services.chat, files: services.files, media: services.media,
    }),
  };
  const engine = new DropinEngine({ win, deps, options: { swRecheckMs: 0 }, timers: clock.timers() });
  return { engine, win, chain, tmod, clock, services, mw: engine.mw };
}

async function boot(t) {
  const p = t.engine.start();
  await until(() => t.engine.state === 'ready' || t.engine.state === 'off', { label: 'evaluate' });
  if (t.engine.state === 'ready') t.clock.advance(200);
  await p;
  if (t.engine.ledgerPromise) await t.engine.ledgerPromise;
  return t;
}

const click = (t) => t.win.dispatchEvent({ type: 'click', isTrusted: true });

test('drop-in v0.3: the engine tab mounts the services; a guest opens the ledger read only and no 0.2.1 key is made', async () => {
  const b = await browser();
  const t = await boot(tab(b));
  try {
    const e = t.engine;
    assert.equal(e.isLeader, true);
    assert.equal(e.identityMode, 'v03');
    for (const name of ['identity', 'chat', 'files', 'media', 'mod']) assert.ok(e.api.service(name), name + ' mounted');
    assert.equal(e.api.service('identity'), e.dropinIdentity.service, 'lane idp\'s drop-in adapter');
    const chat = t.services.made.chat.deps;
    assert.equal(chat.ledgerId, b.ledgerId);
    assert.equal(chat.ownTracker, 'wss://own.site.test/announce', 'the pointer\'s own tracker');
    assert.equal(chat.deviceClass, 'desktop');
    assert.equal(t.services.made.media.deps.deviceClass, 'desktop');
    const node = t.chain.FakeChainNode.opened[0];
    assert.equal(node.options.identity, null, 'a guest opens the ledger read only');
    assert.equal(b.cache.store.keys.has('identity:' + b.ledgerId), false, 'no per-site key is made in v0.3');
    const info = await t.mw.ready();
    assert.equal(info.mode, 'dropin');
    assert.equal(info.auth, 'guest');
    assert.equal(info.identity, null);
    assert.deepEqual(Object.keys(info.features).sort(), ['calls', 'chat', 'files', 'media', 'records', 'requests']);
    assert.equal(t.mw.auth.state(), 'guest');
    const settings = await e.settingsModel();
    assert.deepEqual(settings.identity, { short: null, name: null, canExport: false, canImport: false, legacy: false, v03: true });
  } finally {
    t.engine.destroy();
  }
});

test('sign-in from the loader card binds the working keys to the ledger; sign-out unbinds them', async () => {
  const b = await browser();
  const t = await boot(tab(b));
  try {
    const e = t.engine;
    const node = t.chain.FakeChainNode.opened[0];
    const changes = [];
    t.mw.auth.onChange((c) => changes.push(c.state));
    const res = await e.api.signInFromCard({});
    assert.equal(res.state, 'signed-in');
    const signIn = b.client.calls.find((c) => c[0] === 'signIn')[1];
    assert.equal(signIn.purpose, 'site');
    assert.deepEqual(signIn.want, ['keys']);
    assert.equal(b.keys.made.length, 1);
    await until(() => node.identity && node.identity.pub === b.keys.pub, { label: 'keys bound' });
    assert.equal(node.identity.privateKey, b.keys.privateKey, 'the working key signs (non-extractable, never shown to the site)');
    assert.equal(t.mw.auth.state(), 'signed-in');
    const info = await t.mw.ready();
    assert.equal(info.auth, 'signed-in');
    assert.equal(info.identity.pub, b.keys.pub);
    assert.deepEqual(await t.mw.db.set('k', 1), { h: 'b'.repeat(64) });
    assert.deepEqual(node.calls, [['put', 'k', 1]]);
    assert.equal(JSON.stringify(await t.mw.identity.current()).indexOf('privateKey'), -1);
    assert.deepEqual(await t.mw.auth.signOut(), { state: 'guest' });
    await until(() => node.identity === null, { label: 'keys unbound' });
    assert.equal(b.keys.made[0].destroyed, true);
    assert.equal(t.mw.auth.state(), 'guest');
    assert.ok(changes.indexOf('signed-in') >= 0 && changes[changes.length - 1] === 'guest');
  } finally {
    t.engine.destroy();
  }
});

test('a follower tab holds no keys: it shows the engine tab\'s sign-in, forwards writes, and drops it on signed-out', async () => {
  const b = await browser();
  const a = await boot(tab(b));
  const f = await boot(tab(b));
  try {
    assert.equal(f.engine.isLeader, false);
    assert.equal(f.engine.api.service('identity'), null, 'no identity service in a follower');
    assert.equal(f.engine.api.service('chat'), null);
    assert.equal(Object.keys(f.services.made).length, 0, 'no service was made there');
    await a.engine.api.signInFromCard({});
    // The engine tab's 'state' broadcast goes out within 250 ms (its clock).
    await until(() => { a.clock.advance(300); return f.engine.api.identity.state() === 'signed-in'; }, { label: 'follower sees the sign-in' });
    assert.equal(f.engine.api.identity.keys(), null, 'never keys in a follower');
    assert.equal(f.mw.auth.state(), 'signed-in');
    assert.equal((await f.mw.ready()).identity.pub, b.keys.pub);
    // A write in the follower is signed by the engine tab (its node, its keys).
    assert.deepEqual(await f.mw.db.set('from-follower', 1), { h: 'b'.repeat(64) });
    assert.deepEqual(a.chain.FakeChainNode.opened[0].calls, [['put', 'from-follower', 1]]);
    await assert.rejects(f.mw.chat.dm.send(b.keys.pub, { text: 'x' }), (e) => e.code === 'E_POLICY');
    click(f);
    await assert.rejects(f.mw.media.upload(new Blob(['x'])), (e) => e.code === 'E_POLICY', 'a UI method too: the engine tab holds the keys');
    // The engine tab signs out: the follower drops what it showed.
    await a.mw.auth.signOut();
    await until(() => { a.clock.advance(300); return f.engine.api.identity.state() === 'guest'; }, { label: 'follower drops the sign-in' });
    assert.equal(f.mw.auth.state(), 'guest');
    assert.equal(f.engine.identityInfo, null);
    await assert.rejects(f.mw.db.set('k', 1), (e) => e.code === 'E_NOT_SIGNED_IN', 'a guest write in a follower: no prompt there');
  } finally {
    f.engine.destroy();
    a.engine.destroy();
  }
});

test('/_mw/idp-return finishes the redirect sign-in and goes back; the page that asked takes the answer at boot', async () => {
  const b = await browser();
  b.client.redirect = { deferred: true, returnTo: ORIGIN + '/guestbook.html' };
  const ret = tab(b, { noStamp: true });
  const replaced = [];
  ret.win.location.pathname = '/_mw/idp-return';
  ret.win.location.replace = (u) => replaced.push(u);
  ret.win.document.querySelector = (sel) => (sel === 'meta[name="mw-idp-return"]' ? { name: 'mw-idp-return' } : null);
  const warns = [];
  const saved = console.warn;
  console.warn = (...x) => warns.push(x.join(' '));
  try {
    await boot(ret);
  } finally {
    console.warn = saved;
  }
  assert.equal(ret.engine.state, 'off');
  assert.equal(ret.engine.offReason, 'idp-return');
  assert.deepEqual(b.client.calls, [['completeRedirect', true]], 'the answer is kept (defer) for the tab that asked');
  assert.deepEqual(replaced, [ORIGIN + '/guestbook.html']);
  assert.deepEqual(warns, [], 'no "no pointer" warning on this page');
  assert.equal(ret.chain.FakeChainNode.opened.length, 0);
  ret.engine.destroy();
  // Back on the page: its engine tab takes the answer and is signed in, without a click.
  b.client.deferred = await b.client.answer();
  const t = await boot(tab(b));
  try {
    assert.equal(t.engine.api.identity.state(), 'signed-in');
    const node = t.chain.FakeChainNode.opened[0];
    await until(() => node.identity && node.identity.pub === b.keys.pub, { label: 'keys bound' });
  } finally {
    t.engine.destroy();
  }
});

test('UI methods need a trusted click on the page; the panel\'s own buttons run sign-in and the identity page', async () => {
  const b = await browser();
  const t = await boot(tab(b));
  try {
    await assert.rejects(t.mw.chat.enable(), (e) => e.code === 'E_NEEDS_GESTURE');
    t.win.dispatchEvent({ type: 'click', isTrusted: false });
    await assert.rejects(t.mw.chat.enable({ activation: true }), (e) => e.code === 'E_NEEDS_GESTURE', 'a script click and a flag prove nothing');
    assert.equal(t.services.made.chat.calls.length, 0);
    click(t);
    assert.deepEqual(await t.mw.chat.enable(), { ran: 'chat.enable' });
    assert.equal(t.services.made.chat.calls[0].ctx.activation, true);
    // The panel's Open identity page button (loader-owned, a click there).
    await t.engine.changeSetting('openIdentity', {});
    await until(() => b.client.calls.some((c) => c[0] === 'openIdentity'), { label: 'identity page' });
  } finally {
    t.engine.destroy();
  }
});

test('host-only drop-in: chat, files and media refuse with E_HOST_ONLY before any card, request or service call', async () => {
  const b = await browser();
  const t = await boot(tab(b, { prefs: { hostOnly: true } }));
  try {
    assert.equal(t.engine.policy.hostOnly, true);
    click(t);
    await assert.rejects(t.mw.chat.enable(), (e) => e.code === 'E_HOST_ONLY');
    await assert.rejects(t.mw.files.share(new Blob(['x']), { public: true }), (e) => e.code === 'E_HOST_ONLY');
    await assert.rejects(t.mw.media.upload(new Blob(['x'])), (e) => e.code === 'E_HOST_ONLY');
    for (const n of ['chat', 'files', 'media']) assert.equal(t.services.made[n].calls.length, 0, n);
    assert.equal(t.tmod.instances.length, 0, 'no torrent manager for it');
  } finally {
    t.engine.destroy();
  }
});

test('a page without a ledger keeps window.mw: ready() answers, v0.3 calls fail with a code, the chat panel sees chat off', async () => {
  const b = await browser();
  const saved = console.warn;
  console.warn = () => {};
  const t = tab(b, { noStamp: true });
  try {
    await boot(t);
  } finally {
    console.warn = saved;
  }
  try {
    assert.equal(t.engine.offReason, 'no-stamp');
    const info = await t.mw.ready();
    assert.equal(info.mode, 'dropin');
    assert.equal(info.features.chat, false, 'the chat panel shows "unavailable"');
    assert.equal(t.mw.auth.state(), 'guest');
    await assert.rejects(t.mw.chat.state(), (e) => e.code === 'E_UNSUPPORTED');
    await assert.rejects(t.mw.media.list(), (e) => e.code === 'E_UNSUPPORTED');
    assert.equal(Object.keys(t.services.made).length, 0);
  } finally {
    t.engine.destroy();
  }
});

test('createDeps: the v0.3 loader yields the real modules; destroy() closes the services and the sign-out channel', async () => {
  const deps = createDeps('https://site.test/_mw/mw.js');
  const v03 = await deps.v03();
  assert.equal(typeof v03.store.onSignedOut, 'function');
  assert.equal(typeof v03.client.takeDeferredAnswer, 'function', 'drop-in redirect answers (lane idp)');
  const b = await browser();
  const t = await boot(tab(b));
  const media = t.services.made.media;
  const before = b.hub.channels.filter((c) => c.name === 'mw-identity' && !c.closed).length;
  assert.ok(before >= 1, 'the engine listens for signed-out on the page\'s own BroadcastChannel');
  t.engine.destroy();
  assert.equal(media.destroyed, true);
  assert.equal(b.hub.channels.filter((c) => c.name === 'mw-identity' && !c.closed).length, 0);
});
