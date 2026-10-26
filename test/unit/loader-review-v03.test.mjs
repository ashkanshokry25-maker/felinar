// Code review v0.3 fixes on the site origin (loader-sw fixer, 2026-10-20): the upload card says what was removed
// (conformance, MF-57); the signed-in header shows the real unlock method and backup state and folds on phones
// (browser); the recovery kit is offered after the first meaningful action (conformance, R 2.2.6); own media come back
// after a sign-in (correctness); "Continue in this tab" and the iOS Home Screen redirect (browser, R 2.3.1); "Replace my
// keys on all sites" writes the recover rotation on the ledger, so allow membership follows (conformance, MF-20).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { FakeDocument, FakeNode } from './dropin-fake-dom.mjs';
import { createCards } from '../../src/loader/ui.js';
import { uiText, cardText } from '../../src/loader/strings.js';
import {
  MwApi, cardFor, identityHeaderOf, restoreMedia, writeRotation, nodeIdentityOf, setNodeIdentity, MEANINGFUL_METHODS, SERVICE_EVENTS,
} from '../../src/loader/api.js';
import * as client from '../../src/identity/client.js';
import { createIdentityService } from '../../src/identity/service.js';
import { WorkingKeys } from '../../src/identity/store.js';
import { createIdp } from '../../src/idp/idp.js';
import { openIdoStore } from '../../src/idp/store.js';
import { ChainNode } from '../../src/chain/node.js';
import { MemoryBlockStore } from '../../src/chain/stores.js';
import { generateKeyPair, exportPublicKey, sign } from '../../src/chain/crypto.js';
import { b64url } from '../../src/chain/canonical.js';
import { signPointer, parsePointer, formatPointer } from '../../src/common/pointer.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

// ---- the fake DOM with a tiny layout (as ui-v03-cards.test.mjs) ------------------------------------------------
function world({ width = 1200, coarse = false } = {}) {
  const w = { clock: 1000, timers: [] };
  FakeNode.prototype.getBoundingClientRect = function () {
    if (this.tagName !== 'BUTTON') return { x: 0, y: 0, width: 300, height: 100 };
    if (!this._idx) { w.n = (w.n || 0) + 1; this._idx = w.n; }
    return { x: 20, y: 100 * this._idx, width: 120, height: 44 };
  };
  FakeNode.prototype.getRootNode = function () { let n = this; while (n.parentNode) n = n.parentNode; return n; };
  FakeNode.prototype.elementFromPoint = function (x, y) {
    const hit = this.findAll((n) => {
      if (n.tagName !== 'BUTTON') return false;
      const r = n.getBoundingClientRect();
      return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
    });
    return hit[0] || null;
  };
  const doc = new FakeDocument();
  doc.elementFromPoint = () => w.host;
  const win = {
    document: doc, innerWidth: width, innerHeight: 844,
    MutationObserver: class { observe() {} disconnect() {} },
    matchMedia: (q) => ({ matches: q === '(pointer: coarse)' ? coarse : false }),
    navigator: { language: 'en-CA' },
    getComputedStyle: () => ({ opacity: '1', visibility: 'visible', display: 'block', pointerEvents: 'auto' }),
  };
  w.doc = doc; w.win = win;
  return w;
}

function make(opts = {}, worldOpts = {}) {
  const w = world(worldOpts);
  const cards = createCards(Object.assign({
    win: w.win, doc: w.doc, now: () => w.clock, minVisibleMs: 250,
    setTimeout: (fn, ms) => { const t = { fn, ms, done: false }; w.timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.done = true; },
  }, opts));
  const open = (kind, data) => { const p = cards.prompt(kind, data); w.host = cards.host; return p; };
  const run = () => { for (const t of w.timers.splice(0)) if (!t.done) t.fn(); };
  return { w, cards, open, run };
}
const texts = (root) => root.findAll((n) => n._text).map((n) => n._text).join(' | ');

// ------------------------------------------------------------------------------------------------ the upload card

test('the upload card says details were removed only when the stripper removed some (MF-57)', () => {
  const pdf = cardFor('file-share', { public: true, name: 'flyer.pdf', size: 1000, mime: 'application/pdf', removed: [] });
  const t = make();
  t.open(pdf.kind, pdf.data);
  const shown = texts(t.cards.host);
  assert.ok(!/were removed/.test(shown), 'a PDF goes as it is');
  assert.ok(shown.includes(uiText('uploadAsIs', 'en')), 'and the card says documents can carry a name or a location');
  assert.ok(!cardText('publicUpload', 'en').includes('removed'), 'the public sentence itself no longer claims a removal');
  t.cards.destroy();
  const jpg = cardFor('file-share', { public: true, name: 'a.jpg', size: 1000, mime: 'image/jpeg', removed: ['exif'] });
  const u = make();
  u.open(jpg.kind, jpg.data);
  assert.ok(texts(u.cards.host).includes(uiText('uploadStripped', 'en')));
  u.cards.destroy();
  // A private file the stripper did not touch: no removal claim either.
  const doc = cardFor('file-share', { public: false, name: 'notes.docx', size: 10, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', removed: [] });
  const v = make();
  v.open(doc.kind, doc.data);
  assert.ok(!/were removed/.test(texts(v.cards.host)));
  v.cards.destroy();
});

// ------------------------------------------------------------------------------------------------ the header

test('the signed-in header shows how the identity unlocked and whether a backup exists', () => {
  const info = { pub: 'p256:x', short: 'k3f9-2xq1', name: 'Ana', mode: 'private' };
  assert.deepEqual(identityHeaderOf(info, { keyMode: 'pairwise', status: { passkey: false, kitSaved: true, fileSaved: false } }), { name: 'Ana', short: 'k3f9-2xq1', pub: 'p256:x', mode: 'private', unlock: 'passphrase', backup: true });
  assert.equal(identityHeaderOf(info, { keyMode: 'visit-only', status: { passkey: false } }).unlock, 'visit');
  assert.equal(identityHeaderOf(info, { keyMode: 'pairwise', sharedComputer: true, status: { passkey: true } }).unlock, 'visit', 'a shared computer');
  const pk = identityHeaderOf(info, { keyMode: 'pairwise', status: { passkey: true, kitSaved: false, fileSaved: false } });
  assert.equal(pk.unlock, 'passkey');
  assert.equal(pk.backup, false);
  assert.equal(identityHeaderOf(null, null), null);
});

test('on a phone the header folds into a 44 px corner chip after a few seconds and opens again on a tap', () => {
  const t = make({}, { width: 390, coarse: true });
  t.cards.setIdentityHeader({ name: 'Ana', short: 'k3f9-2xq1', pub: 'p256:abc', unlock: 'passkey', backup: false }, {});
  const host = t.cards.host;
  assert.equal(t.cards.headerState, 'full', 'shown once after sign-in');
  assert.equal(t.w.timers.length, 1);
  assert.equal(t.w.timers[0].ms, 5000);
  t.run();
  assert.equal(t.cards.headerState, 'folded');
  assert.equal(host.findAll((n) => n.getAttribute && n.getAttribute('data-mw-header') === '').length, 0, 'no full-width card over the site');
  const chip = host.findAll((n) => n.getAttribute && n.getAttribute('data-mw-header-chip') === '')[0];
  assert.ok(chip);
  assert.equal(chip.style.getPropertyValue('width'), '44px');
  assert.equal(chip.style.getPropertyValue('pointer-events'), 'auto');
  // The strip around the chip lets taps through to the site.
  const slots = host.findAll((n) => n.style && n.style.getPropertyValue && n.style.getPropertyValue('pointer-events') === 'none');
  assert.ok(slots.length >= 2);
  chip.dispatchEvent({ type: 'click', isTrusted: false });
  assert.equal(t.cards.headerState, 'folded', 'a script click does nothing');
  chip.dispatchEvent({ type: 'click', isTrusted: true });
  assert.equal(t.cards.headerState, 'full');
  t.run();
  assert.equal(t.cards.headerState, 'folded', 'and it folds again');
  // A desktop keeps the full header.
  const d = make({}, { width: 1200 });
  d.cards.setIdentityHeader({ name: 'Ana', short: 'k3f9-2xq1', pub: 'p256:abc' }, {});
  assert.equal(d.w.timers.length, 0);
  assert.equal(d.cards.headerState, 'full');
  t.cards.destroy();
  d.cards.destroy();
});

// ------------------------------------------------------------------------------------------------ the recovery kit

function fakeIdentity({ kitSaved = false } = {}) {
  const listeners = new Map();
  const svc = {
    noted: [],
    methods: { 'auth.state': async () => 'signed-in', 'identity.current': async () => ({ pub: 'p256:x', short: 'k3f9', name: null, mode: 'private' }) },
    on(ev, fn) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(fn); return () => listeners.get(ev).delete(fn); },
    emit(ev, data) { for (const fn of listeners.get(ev) || []) fn(data); },
    keys: () => ({ pub: 'p256:x', status: { kitSaved } }),
    noteMeaningful(method) { svc.noted.push(method); if (!kitSaved && svc.noted.length === 1) svc.emit('kit', { reason: 'first-action' }); },
  };
  return svc;
}

test('the first meaningful action brings the loader\'s kit card; its button opens the identity page at the kit', async () => {
  assert.ok(SERVICE_EVENTS.identity.events.includes('kit'));
  for (const m of ['db.append', 'chat.dm.send', 'files.share', 'media.upload', 'me.set', 'chat.dm.keepHistory']) assert.ok(MEANINGFUL_METHODS.includes(m), m);
  const prompts = [];
  const ui = { prompt: async (kind, data) => { prompts.push(kind); return true; } };
  const node = { role: 'writer', state: { kv: new Map() }, append: async () => ({ h: 'a'.repeat(64) }) };
  const api = new MwApi({ node, ui, activation: () => true, mod: false });
  const svc = fakeIdentity();
  api.mount('identity', svc);
  await flush();
  const r = await api.request('db.append', { name: 'posts', value: 'hello' });
  assert.equal(r.ok, true);
  await flush();
  assert.deepEqual(svc.noted, ['db.append']);
  assert.deepEqual(prompts, ['kit']);
  await api.request('db.append', { name: 'posts', value: 'again' });
  await flush();
  assert.deepEqual(prompts, ['kit'], 'once per page');
  // The card's button: openIdentity({ intent: 'kit' }) inside the click.
  const opened = [];
  const t = make({ actions: { openIdentity: async (o) => { opened.push(o); return 'done'; } } });
  const p = t.open('kit', {});
  t.w.clock += 500;
  t.cards.host.buttonByText(uiText('kitButton', 'en')).click();
  assert.equal(await p, true);
  assert.deepEqual(opened, [{ intent: 'kit' }]);
  t.cards.destroy();
  // openIdentityFromCard passes the intent to identity.openIdentity.
  const seen = [];
  const api2 = new MwApi({ mod: false });
  api2.mount('identity', Object.assign(fakeIdentity(), { methods: { 'identity.openIdentity': async (p2, ctx) => { seen.push([p2, ctx.activation]); return 'done'; }, 'auth.state': async () => 'guest' } }));
  await api2.openIdentityFromCard({ intent: 'kit' });
  assert.deepEqual(seen, [[{ intent: 'kit' }, true]]);
});

test('the identity service emits kit after the first meaningful action while the kit is not saved', async () => {
  const keys = { pub: (await client.newBoxKey()).pub, destroyed: false, status: { kitSaved: false } };
  const svc = createIdentityService({ client: { signIn: async () => ({}) }, Keys: { install: async () => keys, restore: async () => keys, escrow: async () => null, forget: async () => {} }, channelFactory: () => null });
  const got = [];
  svc.on('kit', (d) => got.push(d));
  assert.equal(svc.noteMeaningful('db.append'), false, 'nothing while signed out');
  await svc.restore();
  assert.equal(svc.noteMeaningful('db.append'), true);
  svc.noteMeaningful('chat.dm.send');
  assert.equal(got.length, 1);
  await svc.destroy();
});

// ------------------------------------------------------------------------------------------------ own media

test('working keys installed: the media service restores the person\'s own items (shell, hub and drop-in all run MwApi)', async () => {
  let restored = 0;
  const media = { methods: {}, on: () => () => {}, lane: { ready: async () => { restored++; return 3; } } };
  const api = new MwApi({ mod: false });
  api.mount('media', media);
  const svc = fakeIdentity({ kitSaved: true });
  api.mount('identity', svc);
  await flush();
  await flush();
  assert.ok(restored >= 1, 'restore ran when the identity became signed in');
  assert.equal(await restoreMedia({ restore: async () => 2 }), 2);
  assert.equal(await restoreMedia(null), 0);
  assert.equal(await restoreMedia({ lane: { ready: () => { throw Object.assign(new Error('x'), { code: 'E_NOT_SIGNED_IN' }); } } }), 0, 'never throws');
});

// ------------------------------------------------------------------------------------------------ the redirect

test('the loader\'s sign-in card falls back to "Continue in this tab"; an iOS Home Screen app starts with the redirect', async () => {
  const kinds = [];
  const ui = { prompt: async (kind) => { kinds.push(kind); return kind === 'signin' ? { fallback: 'redirect', code: 'E_POPUP_BLOCKED' } : false; } };
  const api = new MwApi({ ui, mod: false });
  assert.equal(await api.openSignInCard({}), false);
  assert.deepEqual(kinds, ['signin', 'continue-here']);
  assert.equal(client.opensInPlace({ navigator: { standalone: true } }), true);
  assert.equal(client.opensInPlace({ navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }, matchMedia: () => ({ matches: true }) }), true);
  assert.equal(client.opensInPlace({ navigator: { userAgent: 'Mozilla/5.0 (Macintosh)' }, matchMedia: () => ({ matches: true }) }), false);
  assert.equal(client.opensInPlace({ navigator: { userAgent: 'Mozilla/5.0 (iPhone)' }, matchMedia: () => ({ matches: false }) }), false);
  // signIn on a Home Screen app navigates to the identity page at once (no popup that would lose its opener).
  client.resetCooldown();
  const assigned = [];
  const win = {
    location: { origin: 'https://site.test', href: 'https://site.test/p', assign: (u) => assigned.push(u) },
    navigator: { standalone: true }, document: null, open: () => { throw new Error('no popup here'); },
    sessionStorage: { m: new Map(), setItem(k, v) { this.m.set(k, v); }, getItem(k) { return this.m.get(k) || null; }, removeItem(k) { this.m.delete(k); } },
  };
  client.signIn({ win, idp: 'https://id.example', want: ['keys'] });
  for (let i = 0; i < 20 && !assigned.length; i++) await flush();
  assert.equal(assigned.length, 1);
  assert.ok(assigned[0].startsWith('https://id.example/signin#'));
  client.resetCooldown();
});

// ------------------------------------------------------------------------------------------------ MF-20 rotation

function idoCards() {
  return new Proxy({ lang: 'en' }, { get(t, k) { if (k in t) return t[k]; return async () => {
    if (k === 'signin') return { action: 'continue', mode: { kind: 'private' }, stay: false, sharedComputer: false, hub: null };
    if (k === 'chooseUnlock') return { method: 'passkey', nickname: 'x' };
    return true; }; } });
}

async function signInKeys(idp, origin, pointer) {
  const box = await client.newBoxKey();
  const requestId = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url');
  const res = await idp.handleRequest({ v: 1, t: 'mw-signin-req', requestId, purpose: 'site', want: ['keys'], epk: box.pub, pointer }, origin, null);
  assert.equal(res.ok, true, res.code);
  const K = await client.open(client.BUNDLE_PREFIX, box.privateKey, res.bundle, { origin, requestId });
  return WorkingKeys.install(K, { idb: null, channelFactory: () => null });
}

test('"Replace my keys on all sites" writes the recover rotation on an allow site: the new key keeps the membership', async () => {
  const ORIGIN = 'https://site.test';
  const kp = await generateKeyPair({ extractable: false });
  const owner = { pub: await exportPublicKey(kp.publicKey), privateKey: kp.privateKey };
  const signer = { pub: owner.pub, sign: (b) => sign(kp.privateKey, b) };
  const chain = b64url.encode(webcrypto.getRandomValues(new Uint8Array(16)));
  const g = await ChainNode.genesis({ signer, policy: { writers: 'allow', bits: 0, allow: [] }, chain });
  const s = Math.floor(Date.now() / 1000);
  const rec = Object.assign(parsePointer('v=mw1; btih=' + 'e'.repeat(40)).record, { btih: 'e'.repeat(40), owner: owner.pub, chain, seq: s, exp: s + 86400 });
  const pointer = formatPointer(await signPointer(rec, 'site.test', kp.privateKey));
  const prf = webcrypto.getRandomValues(new Uint8Array(32));
  const passkey = { async capabilities() { return { webauthn: true, platform: true, prf: true }; }, async create() { return { credId: 'Y3JlZA', prf, prfEnabled: true, uv: true }; }, async get() { return { credId: 'Y3JlZA', prf, uv: true }; } };
  const idp = createIdp({ win: null, doc: null, navigator: null, location: { origin: 'http://localhost:9555' }, cards: idoCards(), passkey, store: await openIdoStore({ memory: true }), wasm: true, ios: false, standalone: false, build: { version: '0.3.0', id: 'test0001', hash: '', test: true } });
  const keys1 = await signInKeys(idp, ORIGIN, pointer);
  assert.equal(keys1.keyMode, 'ledger');
  assert.match(keys1.identity.rc, /^[A-Za-z0-9_-]{43}$/, 'the working keys carry the recovery commitment');
  // The owner lets this visitor write; the visitor posts (the ledger writes its keyinfo first, MF-20).
  const node = await ChainNode.open({ siteId: g.ledgerId, expectedOwner: owner.pub, ledgerOwner: owner.pub, genesisHash: g.gen, store: new MemoryBlockStore(), identity: { pub: owner.pub, privateKey: owner.privateKey }, config: { minBits: 0, tickMs: 0 } });
  try {
    await node.ingest(g.blocks, 'local');
    await node.writeControl({ t: 'allow', add: [keys1.pub], remove: [] });
    setNodeIdentity(node, nodeIdentityOf(keys1));
    assert.equal(nodeIdentityOf(keys1).rc, keys1.rc);
    await node.append('posts', 'before');
    assert.ok(node.state.keyinfo.has(keys1.pub), 'keyinfo written before the first post');
    // Settings at the identity origin: Replace my keys. The next sign-in brings the new key and its notice.
    await idp.replaceAllKeys();
    const keys2 = await signInKeys(idp, ORIGIN, pointer);
    assert.notEqual(keys2.pub, keys1.pub);
    assert.equal(keys2.rotateNotice.ledger, g.ledgerId);
    assert.ok(keys2.rotateNotice.rsig);
    setNodeIdentity(node, nodeIdentityOf(keys2));
    await assert.rejects(node.append('posts', 'too early'), (e) => e.code === 'E_POLICY', 'without the rotation the new key is a stranger here');
    const block = await writeRotation(node, keys2, g.ledgerId);
    assert.ok(block, 'the rotate block was written');
    assert.equal(node.state.rotations.get(keys1.pub).next, keys2.pub);
    await node.append('posts', 'after');
    const posts = node.state.lists.get('posts').map((x) => [x.author === keys2.pub ? 'new' : 'old', x.v]);
    assert.deepEqual(posts.map((p) => p[1]).sort(), ['after', 'before']);
    assert.ok(posts.some((p) => p[0] === 'new' && p[1] === 'after'), 'the new key writes as a member');
    assert.equal(await writeRotation(node, keys2, g.ledgerId), null, 'written once');
    assert.equal(await writeRotation(node, keys2, 'mw1:another'), null, 'never for another ledger');
  } finally {
    await node.close();
  }
});

// ------------------------------------------------------------------------------------------------ takedown, premoderation, pin key

import { createModService, denyIdsOf, listingVisible, pendingListings, idKey, LISTED_PREFIX, DENY_PREFIX } from '../../src/loader/mod.js';
import { denyChecker, ownerCfgPin } from '../../src/loader/api.js';
import { STRINGS as LOADER_STRINGS } from '../../src/loader/strings.js';
import { resolvePointer, parseFragment } from '../../src/loader/app.js';
import { CONFIG as LOADER_CONFIG } from '../../src/loader/config.js';
import * as pointerMod from '../../src/common/pointer.js';
import { ownerFingerprint } from '../../src/loader/harden.js';
import { createHubService, refreshPersonalPointer, personalPointer, hubScope, POINTER_KEY } from '../../src/loader/personal-site.js';

const H = (c) => c.repeat(64);

function modNode({ lists = new Map(), kv = new Map(), modPub = 'p256:mod', owner = 'p256:owner', allow = [], moderators = [] } = {}) {
  const puts = [];
  const ops = [];
  let n = 0;
  const node = {
    role: 'moderator', identity: { pub: modPub },
    state: { lists, kv, owner, policy: { moderators: new Set(moderators), allow: new Set(allow) } },
    async put (k, v) { puts.push([k, v]); kv.set(k, { v, h: H(String((++n) % 10)), author: modPub }); return { h: 'p'.repeat(63) + n }; },
    async writeControl (op) { ops.push(op); return { h: 'c'.repeat(63) + (++n) }; },
  };
  return { node, puts, ops };
}

function modApi (node, extra = {}) {
  return Object.assign({ node, identity: { keys: () => null, info: () => ({ pub: node.identity.pub }) }, prompt: async () => true, infoNow: () => ({}), service: () => null }, extra);
}

test('a deny of a reported public file writes the deny keys the lanes check and tombstones the listing (MF-52)', async () => {
  const ih = 'b'.repeat(40);
  const sha = 'd'.repeat(64);
  const lists = new Map([['mw.files', [{ h: H('1'), author: 'p256:bad', ts: 1, v: { ih, len: 10, name: 'x.pdf', mime: 'application/pdf', sha256: sha, t: 1 } }]]]);
  const { node, puts, ops } = modNode({ lists });
  const mod = createModService({ api: modApi(node) });
  const item = mod.receive('p256:reporter', { t: 'report', report: { target: { h: H('1') }, reason: 'illegal' } });
  const r = await mod.methods['mod.decide']({ id: item.id, decision: 'deny', reason: 'illegal' }, { activation: true });
  assert.equal(r.decision, 'deny');
  const keys = puts.map((p) => p[0]).sort();
  assert.deepEqual(keys, [await idKey(DENY_PREFIX, ih), await idKey(DENY_PREFIX, sha)].sort(), 'by infohash and by content hash');
  assert.ok(!keys.includes(await idKey(DENY_PREFIX, H('1'))), 'never the hash of the block hash');
  assert.deepEqual(ops, [{ t: 'tombstone', h: H('1') }], 'the listing is tombstoned in the same step');
  // What the files and media lanes ask before a fetch or a seed now answers yes.
  const isDenied = denyChecker(() => node);
  assert.equal(await isDenied(ih), true);
  assert.equal(await isDenied(sha), true);
  // A report of private media carries the infohash from the reporter's own copy, and the deny names it.
  assert.deepEqual(denyIdsOf(node.state, { kind: 'report', target: { media: 'f'.repeat(32), ih: 'e'.repeat(40) } }).ids, ['e'.repeat(40)]);
  assert.deepEqual(denyIdsOf(node.state, { kind: 'report', target: { media: 'f'.repeat(32) } }).ids, [], 'a media id alone names nothing a lane checks');
  mod.destroy();
});

test('report.send of private media names its infohash from this device\'s copy, never from the site', async () => {
  const sent = [];
  const keys = { pub: (await client.newBoxKey()).pub, sign: async () => new Uint8Array(64) };
  const chat = { methods: { 'chat.dm.send': async (p) => { sent.push(p); return {}; } } };
  const media = { lane: { items: new Map([['a'.repeat(32), { M: { ih: 'c'.repeat(40) } }]]) } };
  const moderator = (await client.newBoxKey()).pub;
  const { node } = modNode({ moderators: [moderator] });
  node.state.owner = moderator;
  const api = modApi(node, { identity: { keys: () => keys, info: () => ({ pub: keys.pub }) }, service: (n) => (n === 'chat' ? chat : n === 'media' ? media : null), infoNow: () => ({ siteId: 'mw1:x' }) });
  const mod = createModService({ api });
  const r = await mod.methods['report.send']({ target: { media: 'a'.repeat(32) }, reason: 'illegal' }, { activation: true });
  assert.equal(r.sent, 1);
  assert.equal(sent[0].grant.report.target.ih, 'c'.repeat(40));
  mod.destroy();
});

test('premoderation: a new key\'s first public listing waits for a moderator; accept makes it and the author\'s later ones visible (MF-53)', async () => {
  const ih = 'a'.repeat(40);
  const listing = { h: H('2'), author: 'p256:new', ts: 1, v: { ih, len: 5, name: 'a.txt', mime: 'text/plain', t: 1 } };
  const lists = new Map([['mw.files', [listing]]]);
  const { node, puts, ops } = modNode({ lists, allow: ['p256:member'] });
  assert.equal(listingVisible(node.state, listing), false, 'hidden until accepted');
  assert.equal(listingVisible(node.state, Object.assign({}, listing, { author: 'p256:member' })), true, 'an allow-listed key is not premoderated');
  assert.equal(listingVisible(node.state, Object.assign({}, listing, { author: 'p256:owner' })), true);
  assert.deepEqual(pendingListings(node.state).map((x) => x.h), [H('2')]);
  const mod = createModService({ api: modApi(node) });
  const q = await mod.methods['mod.queue']({}, {});
  assert.deepEqual(q.map((x) => [x.kind, x.ih]), [['listing', ih]]);
  await mod.methods['mod.decide']({ id: q[0].id, decision: 'accept' }, { activation: true });
  assert.deepEqual(puts.map((p) => p[0]), [await idKey(LISTED_PREFIX, ih + '\n' + 'p256:new')], 'bound to the infohash and the author (MAL53-1)');
  assert.equal(listingVisible(node.state, listing), true);
  const later = { h: H('3'), author: 'p256:new', ts: 2, v: { ih: 'f'.repeat(40), len: 5, name: 'b.txt', mime: 'text/plain', t: 2 } };
  lists.get('mw.files').push(later);
  assert.equal(listingVisible(node.state, later), true, 'an author with an accepted listing is past premoderation');
  assert.deepEqual(pendingListings(node.state), []);
  // Decline tombstones a waiting listing.
  const spam = { h: H('4'), author: 'p256:spam', ts: 3, v: { ih: 'e'.repeat(40), len: 5, name: 'c.txt', mime: 'text/plain', t: 3 } };
  lists.get('mw.files').push(spam);
  const q2 = await mod.methods['mod.queue']({}, {});
  const it = q2.find((x) => x.h === H('4'));
  await mod.methods['mod.decide']({ id: it.id, decision: 'decline' }, { activation: true });
  assert.deepEqual(ops, [{ t: 'tombstone', h: H('4') }]);
  mod.destroy();
});

test('the pin key comes only from a _mw.cfg written with owner standing', () => {
  const kv = new Map([['_mw.cfg', { v: { pin: 'p256:pinnode' }, h: H('5'), author: 'p256:owner' }]]);
  assert.equal(ownerCfgPin({ state: { kv, ownerWritten: new Set([H('5')]) } }), 'p256:pinnode');
  assert.equal(ownerCfgPin({ state: { kv, ownerWritten: new Set() } }), null, 'a moderator-written _mw.cfg names no pin key');
  assert.equal(ownerCfgPin({ state: { kv } }), null);
  assert.equal(ownerCfgPin(null), null);
});

test('MF-30: the DNS badge never says DNSSEC without "resolver says"; a #host:name@fp link refuses a record by another key', async () => {
  const badge = LOADER_STRINGS.pointerBadge({ source: 'dns', resolver: 'cloudflare', ad: true, signed: true });
  assert.ok(/DNSSEC/.test(badge) && /resolver says validated/.test(badge), badge);
  assert.ok(!/DNSSEC/.test(LOADER_STRINGS.pointerBadge({ source: 'dns', resolver: 'cloudflare', ad: false, signed: true })));
  const kpA = await generateKeyPair({ extractable: false });
  const a = { pub: await exportPublicKey(kpA.publicKey), privateKey: kpA.privateKey };
  const kpB = await generateKeyPair({ extractable: false });
  const b = { pub: await exportPublicKey(kpB.publicKey) };
  const NOW = Date.now();
  const SEC = Math.floor(NOW / 1000);
  const scope = 'site.example';
  const text = pointerMod.formatPointer(await pointerMod.signPointer({ btih: 'a'.repeat(40), owner: a.pub, seq: SEC - 10, exp: SEC + 86400 }, scope, a.privateKey));
  const cache = { getPin: async () => null, savePin: async () => {}, getPointer: async () => null, savePointer: async () => {}, getPref: async (k, d) => d, setPref: async () => {} };
  const deps = { parsePointer: pointerMod.parsePointer, verifyPointer: pointerMod.verifyPointer, verifyRotation: pointerMod.verifyRotation, ledgerIdFor: pointerMod.ledgerIdFor, pickRecord: pointerMod.pickRecord, joinTxtData: pointerMod.joinTxtData, resolveTxt: async () => ({ resolver: 'test', strings: [text], ad: false, ttl: 300 }), shouldSkipDoh: () => false, cache };
  const ctx = (fp) => ({ mode: 'hub', scope, hostFp: fp, dnsHost: scope, blockOnDns: true, dohAllowed: true, now: NOW, config: LOADER_CONFIG });
  const ok = await resolvePointer(ctx((await ownerFingerprint(a.pub)).slice(0, 22)), deps);
  assert.equal(ok.record.owner, a.pub);
  await assert.rejects(resolvePointer(ctx((await ownerFingerprint(b.pub)).slice(0, 22)), deps), (e) => e.code === 'E_POINTER' && /not signed by the key the link names/.test(e.tried.join(' ')));
  const f = parseFragment('#host:site.example@' + (await ownerFingerprint(a.pub)).slice(0, 22), '');
  assert.equal(f.kind, 'host');
  assert.equal(f.fp, (await ownerFingerprint(a.pub)).slice(0, 22));
});

// ------------------------------------------------------------------------------------------------ personal pointers

async function workingKey () {
  const kp = await generateKeyPair({ extractable: false });
  const pub = await exportPublicKey(kp.publicKey);
  return { pub, sign: (bytes) => sign(kp.privateKey, bytes) };
}

test('a personal pointer is signed again when fewer than 30 days are left; a follow whose pointer expired is kept and refreshed', async () => {
  const keys = await workingKey();
  const template = 'c'.repeat(40);
  const DAY = 86400000;
  const t0 = Date.now() - 80 * DAY;
  const signer = { pub: keys.pub, sign: keys.sign };
  const first = await personalPointer({ signer, templateBtih: template, chain: 'A'.repeat(22), gen: H('9'), nx: 'N'.repeat(43), transport: { tr: ['wss://hub.example'] }, now: t0 });
  assert.equal(await refreshPersonalPointer({ keys, record: first.record, now: t0 + 10 * DAY }), null, '80 days left: nothing to do');
  const fresh = await refreshPersonalPointer({ keys, record: first.record, now: Date.now() });
  assert.ok(fresh);
  assert.ok(fresh.record.seq > first.record.seq && fresh.record.exp > first.record.exp);
  assert.deepEqual([fresh.record.chain, fresh.record.gen, fresh.record.nx, fresh.record.owner], [first.record.chain, first.record.gen, first.record.nx, first.record.owner]);
  assert.deepEqual(fresh.record.tr, ['wss://hub.example'], 'the transport hints stay');
  assert.equal(await refreshPersonalPointer({ keys: await workingKey(), record: first.record, now: Date.now() }), null, 'only the owner re-signs');
  // A follower: the stored follow's pointer expired yesterday.
  const old = await personalPointer({ signer, templateBtih: template, chain: 'B'.repeat(22), gen: H('8'), nx: 'N'.repeat(43), now: Date.now() - 91 * DAY });
  const ledger = await pointerMod.ledgerIdFor(old.record, hubScope(template));
  const prefs = new Map([['hub:follows', [{ ledger, text: old.text, since: 1 }]]]);
  const kv = new Map();
  const node = { height: 3, state: { kv, lists: new Map() }, subscribe: () => () => {}, close: async () => {} };
  const svc = createHubService({
    prefs: { get: async (k, d) => (prefs.has(k) ? prefs.get(k) : d), set: async (k, v) => { prefs.set(k, v); } },
    openLedger: async () => node,
    verifyPointer: async (rec, o = {}) => { const v = await pointerMod.verifyPointer(rec, hubScope(rec.btih), { now: Date.now(), allowExpired: o.allowExpired === true }); return !!(v && v.ok); },
  });
  assert.equal(await svc.load(), 1, 'kept, not dropped');
  let list = await svc.methods['hub.list']();
  assert.equal(list[0].expired, true, 'flagged: not refreshed since it expired');
  // The owner's page wrote a fresh pointer to _mw.ptr; the follow picks it up.
  const renewed = await refreshPersonalPointer({ keys, record: old.record, now: Date.now() });
  kv.set(POINTER_KEY, { v: renewed.text, h: H('7'), author: keys.pub });
  assert.equal(await svc.refresh(ledger), true);
  list = await svc.methods['hub.list']();
  assert.equal(list[0].expired, undefined);
  assert.equal(list[0].pointer, renewed.text);
  assert.equal(prefs.get('hub:follows')[0].text, renewed.text, 'kept for the next load');
  // A replayed older pointer is never taken.
  kv.set(POINTER_KEY, { v: old.text, h: H('6'), author: keys.pub });
  assert.equal(await svc.refresh(ledger), false);
  await svc.destroy();
});

test('stored follows open in batches, not one after another', async () => {
  const keys = await workingKey();
  const signer = { pub: keys.pub, sign: keys.sign };
  const follows = [];
  for (let i = 0; i < 40; i++) {
    const p = await personalPointer({ signer, templateBtih: 'd'.repeat(40), chain: String(i).padStart(22, 'C'), gen: H('5'), nx: 'N'.repeat(43), now: Date.now() });
    follows.push({ ledger: await pointerMod.ledgerIdFor(p.record, hubScope('d'.repeat(40))), text: p.text, since: 1 });
  }
  let inFlight = 0;
  let peak = 0;
  const svc = createHubService({
    prefs: { get: async () => follows, set: async () => {} },
    openLedger: async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return { state: { kv: new Map() }, subscribe: () => () => {}, close: async () => {} }; },
    verifyPointer: async () => true,
  });
  assert.equal(await svc.load(), 40);
  assert.ok(peak > 1, 'opened together: peak ' + peak);
  await svc.destroy();
});

test('code review v0.3 round 2: mw.hub.createPage refuses a key that is not the hub key (it could never sign in at the new page)', async () => {
  const { __test } = await import('../../src/loader/app.js');
  for (const keyMode of ['pairwise', 'visit-only', 'linked', 'ledger', undefined]) {
    const A = { api: { identity: { keys: () => ({ pub: 'p256:x', keyMode }) }, service: () => null } };
    await assert.rejects(__test.createPage(A, {}, { activation: true }), (e) => e.code === 'E_POLICY' && /identity for this hub/.test(e.message), String(keyMode));
  }
  await assert.rejects(__test.createPage({ api: { identity: { keys: () => null } } }, {}, {}), (e) => e.code === 'E_NOT_SIGNED_IN');
});
