// The identity origin's message protocol (R 2.3.1 to 2.3.3; MF-02, MF-07): requests only from window.opener,
// the requester is event.origin (never page text), answers go only to that origin, the redirect return URL is
// bound to the origin being signed for, and the key bundle opens only with the page key it was sealed to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { createIdp, verifyPointerFor, siteCode } from '../../src/idp/idp.js';
import { openIdoStore } from '../../src/idp/store.js';
import * as client from '../../src/identity/client.js';
import { signPointer, parsePointer, ledgerIdFor } from '../../src/common/pointer.js';
import { generateKeyPair, exportPublicKey } from '../../src/chain/crypto.js';
import { createVerifier, issueChallenge, MemoryNonceStore } from '../../packages/verify/verify.js';

const IDP = 'http://localhost:9555';
const SITE = 'https://shop.example';

function scriptedCards(script = {}) {
  const calls = [];
  const answer = (name, data) => {
    calls.push({ name, data });
    const s = script[name];
    if (typeof s === 'function') return s(data);
    if (s !== undefined) return s;
    switch (name) {
      case 'signin': return { action: 'continue', mode: { kind: 'private' }, stay: false, sharedComputer: false, hub: null };
      case 'chooseUnlock': return { method: 'passkey', nickname: 'test' };
      case 'legacy': return 'keep';
      case 'foundPosts': return 'continue';
      case 'busy': case 'close': return undefined;
      default: return true;
    }
  };
  const target = { calls, lang: 'en' };
  return new Proxy(target, { get(t, k) { if (k in t) return t[k]; return async (data) => answer(k, data); } });
}

function fakePasskey({ uv = true } = {}) {
  const prf = webcrypto.getRandomValues(new Uint8Array(32));
  const pk = {
    uv, calls: [],
    async capabilities() { return { webauthn: true, platform: true, prf: true }; },
    async create() { pk.calls.push('create'); return { credId: 'Y3JlZA', prf, prfEnabled: true, uv: true }; },
    async prfFor({ created }) { return { prf: created.prf, uv: true, credId: created.credId }; },
    async get() { pk.calls.push('get'); return { credId: 'Y3JlZA', prf, uv: pk.uv }; },
  };
  return pk;
}

function opener() {
  const o = { posts: [], postMessage(msg, target) { o.posts.push({ msg, target }); } };
  return o;
}

function idoWindow({ openerWin = null, hash = '' } = {}) {
  const listeners = new Set();
  const w = {
    opener: openerWin,
    location: { origin: IDP, hash, pathname: '/signin', replaced: [], replace(u) { this.replaced.push(u); } },
    history: { replaceState() {} },
    closed: false,
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(type, fn) { listeners.delete(fn); },
    close() { w.closed = true; },
    deliver(ev) { for (const fn of Array.from(listeners)) fn(ev); },
  };
  return w;
}

async function newIdp({ win, cards = scriptedCards(), passkey = fakePasskey(), store, hubSuffixes, sharedOrigins, now } = {}) {
  const st = store || await openIdoStore({ memory: true });
  const idp = createIdp({ win, doc: null, navigator: null, location: win ? win.location : { origin: IDP }, cards, passkey, store: st, wasm: true, ios: false, standalone: false, build: { version: '0.3.0', id: 'test0001', hash: '', test: true }, hubSuffixes, sharedOrigins, now });
  return { idp, store: st, cards, passkey };
}

async function request({ want = ['keys'], purpose = 'site', extra = {} } = {}) {
  const box = await client.newBoxKey();
  const requestId = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url');
  const req = Object.assign({ v: 1, t: 'mw-signin-req', requestId, purpose, want, epk: box.pub }, extra);
  return { box, req };
}

const tick = () => new Promise((r) => setImmediate(r));

test('the popup posts mw-idp-ready to its opener, ignores messages from any other source and answers only event.origin', async () => {
  const op = opener();
  const win = idoWindow({ openerWin: op });
  const { idp } = await newIdp({ win });
  const done = idp.bootSignin();
  await tick();
  assert.equal(op.posts.length, 1);
  assert.deepEqual(Object.keys(op.posts[0].msg).sort(), ['build', 't', 'v'], 'the ready message carries nothing else');
  assert.equal(op.posts[0].msg.t, 'mw-idp-ready');
  const { box, req } = await request();
  // Another window (an iframe, a second page) sends a request: ignored, nothing posted.
  win.deliver({ source: { not: 'the opener' }, origin: 'https://evil.example', data: req });
  await tick();
  assert.equal(op.posts.length, 1, 'a request from another source is refused');
  win.deliver({ source: op, origin: SITE, data: req });
  const r = await done;
  assert.equal(r.done, true);
  const answers = op.posts.slice(1);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].target, SITE, 'posted to event.origin only');
  assert.equal(answers[0].msg.ok, true);
  assert.equal(win.closed, true);
  const K = await client.open(client.BUNDLE_PREFIX, box.privateKey, answers[0].msg.bundle, { origin: SITE, requestId: req.requestId });
  assert.equal(K.origin, SITE);
  assert.equal(K.label, 'o|' + SITE);
  // A later message on the same window is not taken (one request per window).
  win.deliver({ source: op, origin: SITE, data: req });
  await tick();
  assert.equal(op.posts.length, 2);
});

test('the requester comes from event.origin: an origin field in a popup request is refused, never believed', async () => {
  const op = opener();
  const win = idoWindow({ openerWin: op });
  const { idp } = await newIdp({ win });
  const done = idp.bootSignin();
  await tick();
  const { req } = await request({ extra: { origin: 'https://bank.example' } });
  win.deliver({ source: op, origin: SITE, data: req });
  await done;
  const ans = op.posts[1];
  assert.equal(ans.target, SITE);
  assert.equal(ans.msg.ok, false);
  assert.equal(ans.msg.code, 'E_BAD_REQUEST');
  assert.equal(ans.msg.bundle, undefined);
  // Proofs carry the browser-reported origin and domain whatever the page says.
  const op2 = opener();
  const win2 = idoWindow({ openerWin: op2 });
  const { idp: idp2 } = await newIdp({ win: win2 });
  const done2 = idp2.bootSignin();
  await tick();
  const nonces = new MemoryNonceStore();
  const ch = await issueChallenge({ statement: 'Sign in to Example Shop', nonces, ttlMs: 300000 });
  const { req: r2 } = await request({ purpose: 'server', want: ['proof'], extra: { challenge: { nonce: ch.nonce, statement: ch.statement, exp: ch.exp } } });
  delete r2.epk;
  win2.deliver({ source: op2, origin: 'https://forum.example', data: r2 });
  await done2;
  const proof = op2.posts[1].msg.proof;
  assert.equal(proof.c.origin, 'https://forum.example');
  assert.equal(proof.c.domain, 'forum.example');
  assert.equal(proof.c.idp, IDP);
  const ok = await createVerifier({ origin: 'https://forum.example', nonces, allowKeyModes: ['pairwise'] }).verify(proof);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const foreign = await createVerifier({ origin: SITE, nonces, allowKeyModes: ['pairwise'] }).verify(proof);
  assert.equal(foreign.ok, false, 'the proof is useless at another origin');
});

test('the key bundle opens only with the page key, for that origin and that request', async () => {
  const { idp } = await newIdp({ win: null });
  const { box, req } = await request();
  const res = await idp.handleRequest(req, SITE, null);
  assert.equal(res.ok, true);
  const K = await client.open(client.BUNDLE_PREFIX, box.privateKey, res.bundle, { origin: SITE, requestId: req.requestId });
  assert.equal(K.keyMode, 'pairwise');
  assert.ok(K.sign.d && K.chat.d && K.rec.key && K.own && K.local && K.name);
  const other = await client.newBoxKey();
  await assert.rejects(client.open(client.BUNDLE_PREFIX, other.privateKey, res.bundle, { origin: SITE, requestId: req.requestId }), (e) => e.code === 'E_DECRYPT');
  await assert.rejects(client.open(client.BUNDLE_PREFIX, box.privateKey, res.bundle, { origin: 'https://evil.example', requestId: req.requestId }), (e) => e.code === 'E_DECRYPT');
  await assert.rejects(client.open(client.BUNDLE_PREFIX, box.privateKey, res.bundle, { origin: SITE, requestId: 'B'.repeat(22) }), (e) => e.code === 'E_DECRYPT');
  await assert.rejects(client.open(client.RECORD_PREFIX, box.privateKey, res.bundle, { origin: SITE, requestId: req.requestId }), (e) => e.code === 'E_DECRYPT', 'prefixes are distinct');
  // One character of the ciphertext changed for certain (v0.3 reconciliation: the old flip chose its letter by the last
  // character, so when the one it replaced was already that letter nothing changed, about 1 run in 64).
  const ctText = res.bundle.ct;
  const at = ctText.length - 2;
  const flipped = Object.assign({}, res.bundle, { ct: ctText.slice(0, at) + (ctText[at] === 'A' ? 'B' : 'A') + ctText.slice(at + 1) });
  await assert.rejects(client.open(client.BUNDLE_PREFIX, box.privateKey, flipped, { origin: SITE, requestId: req.requestId }), (e) => e.code === 'E_DECRYPT');
  // The root, the phrase and the vault key are never in a bundle.
  const text = JSON.stringify(K);
  assert.ok(!/rootStar|kVault|"root"|phrase/.test(text));
});

test('redirect round trip: the answer goes to origin + /_mw/idp-return and nowhere else', async () => {
  const { box, req } = await request();
  const bad = [
    'https://evil.example/_mw/idp-return',
    SITE + '/_mw/idp-return?x=1',
    SITE + '/other',
    SITE + '/_mw/idp-return#frag',
    'https://user@shop.example/_mw/idp-return',
  ];
  for (const ret of bad) {
    const win = idoWindow({ hash: '#' + client.encodeFragment(Object.assign({}, req, { origin: SITE, ret })) });
    const { idp, cards } = await newIdp({ win });
    const r = await idp.bootSignin();
    assert.equal(r.done, false, ret);
    assert.deepEqual(win.location.replaced, [], 'no navigation for ' + ret);
    assert.ok(cards.calls.some((c) => c.name === 'error'), 'the IdO says why');
  }
  const win = idoWindow({ hash: '#' + client.encodeFragment(Object.assign({}, req, { origin: SITE, ret: SITE + '/_mw/idp-return' })) });
  const { idp } = await newIdp({ win });
  const r = await idp.bootSignin();
  assert.equal(r.done, true);
  assert.equal(win.location.replaced.length, 1);
  const [base, frag] = win.location.replaced[0].split('#');
  assert.equal(base, SITE + '/_mw/idp-return');
  const res = client.decodeFragment(frag);
  assert.equal(res.ok, true);
  const K = await client.open(client.BUNDLE_PREFIX, box.privateKey, res.bundle, { origin: SITE, requestId: req.requestId });
  assert.equal(K.origin, SITE);
  // validateRequest is the same rule on both sides.
  assert.equal(client.validateRequest(Object.assign({}, req, { origin: SITE, ret: SITE + '/_mw/idp-return' }), { transport: 'redirect' }).ok, true);
  assert.equal(client.validateRequest(Object.assign({}, req, { origin: SITE, ret: SITE + '/_mw/idp-return' })).ok, false, 'popup requests never carry origin or ret');
});

test('request rules: unknown fields (no parameter can preselect a link or a key mode), want combinations, epk', async () => {
  const { req } = await request();
  const v = (patch) => client.validateRequest(Object.assign({}, req, patch));
  assert.equal(v({}).ok, true);
  for (const field of ['sameAs', 'linked', 'keyMode', 'label', 'domain', 'ledger', 'pub']) assert.equal(v({ [field]: 'x' }).ok, false, field);
  assert.equal(v({ want: ['keys', 'keys'] }).ok, false);
  assert.equal(v({ want: ['erase', 'keys'] }).ok, false);
  assert.equal(v({ want: [] }).ok, false);
  assert.equal(v({ want: ['root'] }).ok, false);
  assert.equal(v({ purpose: 'server', want: ['keys'] }).ok, false, 'a server sign-in wants a proof');
  assert.equal(v({ epk: undefined }).ok, false, 'keys need a page key');
  assert.equal(v({ requestId: 'short' }).ok, false);
  assert.equal(v({ challenge: { nonce: 'x' } }).ok, false);
  assert.equal(v({ challenge: { nonce: 'A'.repeat(22), extra: 1 } }).ok, false);
  assert.equal(v({ owner: { what: 'policy' } }).ok, true);
  assert.equal(v({ owner: { what: 'everything' } }).ok, false);
  assert.equal(v({ legacy: { pub: req.epk, ledger: 'mw1:x' } }).ok, true);
  assert.equal(v({ legacy: { pub: 'p256:nope' } }).ok, false);
  assert.equal(siteCode('E_UV_REQUIRED'), 'E_USER_CANCELLED', 'the IdO keeps its own reasons');
  assert.equal(siteCode('E_STATEMENT'), 'E_BAD_REQUEST');
  assert.equal(siteCode('E_HOST_ONLY_IDENTITY'), 'E_HOST_ONLY_IDENTITY');
});

test('rounds: the "Found N posts" question goes to event.origin and only the opener may answer it', async () => {
  const op = opener();
  const store = await openIdoStore({ memory: true });
  // First sign-in creates the identity; then the state says it was just restored.
  const first = await newIdp({ win: null, store });
  const passkey = first.passkey;
  const { req: r0 } = await request();
  assert.equal((await first.idp.handleRequest(r0, SITE, null)).ok, true);
  const state = await store.getState();
  state.restored = { t: Date.now(), left: 3 };
  await store.setState(state);
  const win = idoWindow({ openerWin: op });
  const cards = scriptedCards();
  const { idp } = await newIdp({ win, store, passkey, cards });
  const done = idp.bootSignin();
  await tick();
  const { req } = await request();
  win.deliver({ source: op, origin: SITE, data: req });
  for (let i = 0; i < 50 && !op.posts.some((p) => p.msg.t === 'mw-idp-count'); i++) await tick();
  const ask = op.posts.find((p) => p.msg.t === 'mw-idp-count');
  assert.ok(ask, 'the IdO asked the site for the post count');
  assert.equal(ask.target, SITE);
  // A reply from another source or origin is ignored; the opener's reply is used.
  win.deliver({ source: { other: true }, origin: SITE, data: { v: 1, t: 'mw-idp-count-res', requestId: req.requestId, count: 99 } });
  win.deliver({ source: op, origin: 'https://evil.example', data: { v: 1, t: 'mw-idp-count-res', requestId: req.requestId, count: 98 } });
  win.deliver({ source: op, origin: SITE, data: { v: 1, t: 'mw-idp-count-res', requestId: req.requestId, count: 14 } });
  const r = await done;
  assert.equal(r.res.ok, true);
  const found = cards.calls.find((c) => c.name === 'foundPosts');
  assert.deepEqual(found.data, { n: 14, site: SITE });
  assert.equal((await store.getState()).restored, null, 'posts were found: the restore is confirmed');
});

test('the ledger label needs a verified pointer whose own host or org= lists the origin (MF-04)', async () => {
  const kp = await generateKeyPair({ extractable: false });
  const owner = await exportPublicKey(kp.publicKey);
  const now = Date.now();
  const base = { btih: 'a'.repeat(40), owner, seq: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 86400 };
  const signed = await signPointer(Object.assign(parsePointer('v=mw1; btih=' + 'a'.repeat(40)).record, base, { org: ['https://mirror.example'] }), 'shop.example', kp.privateKey);
  const text = (await import('../../src/common/pointer.js')).formatPointer(signed);
  const own = await verifyPointerFor(text, SITE, { now });
  assert.equal(own.ok, true);
  assert.equal(own.host, 'shop.example');
  assert.equal(own.ledgerId, await ledgerIdFor(signed, 'shop.example'));
  assert.equal((await verifyPointerFor(text, 'https://mirror.example', { now })).ok, false, 'the mirror cannot guess the name it was signed for');
  const mirror = await verifyPointerFor(text, 'https://mirror.example', { now, scope: 'shop.example' });
  assert.equal(mirror.ok, true, 'with the scope the loader verified it under, org= names the mirror');
  assert.equal(mirror.host, 'shop.example');
  const { idp } = await newIdp({ win: null });
  const { box, req } = await request({ extra: { pointer: text } });
  const res = await idp.handleRequest(req, SITE, null);
  const K = await client.open(client.BUNDLE_PREFIX, box.privateKey, res.bundle, { origin: SITE, requestId: req.requestId });
  assert.equal(K.keyMode, 'ledger');
  assert.equal(K.label, 'l|' + own.ledgerId);
  const { box: box2, req: req2 } = await request({ extra: { pointer: text, scope: 'shop.example' } });
  const res2 = await idp.handleRequest(req2, 'https://mirror.example', null);
  const K2 = await client.open(client.BUNDLE_PREFIX, box2.privateKey, res2.bundle, { origin: 'https://mirror.example', requestId: req2.requestId });
  assert.equal(K2.pub, K.pub, 'a listed mirror shares the identity');
  // A look-alike origin presenting the same pointer gets its own key and the card says so.
  const cards = scriptedCards();
  const { idp: idp3 } = await newIdp({ win: null, cards });
  const { box: box3, req: req3 } = await request({ extra: { pointer: text, scope: 'shop.example' } });
  const res3 = await idp3.handleRequest(req3, 'https://shop-example.com', null);
  const K3 = await client.open(client.BUNDLE_PREFIX, box3.privateKey, res3.bundle, { origin: 'https://shop-example.com', requestId: req3.requestId });
  assert.equal(K3.keyMode, 'pairwise');
  assert.equal(cards.calls.find((c) => c.name === 'signin').data.notListed, true);
  // A seq below the highest one accepted for that ledger is a rollback: the origin label instead.
  const state = { seqFloors: { [own.ledgerId]: base.seq + 10 } };
  assert.equal((await verifyPointerFor(text, SITE, { now, state })).reason, 'rollback');
});

/** hubPage(btih, hub, { key }) -> { text, origin }: a pointer signed for btih:<btih> and the hub address derived from it. */
async function hubPage(btih, hub, { key = null } = {}) {
  const { formatPointer, hubLabelFor } = await import('../../src/common/pointer.js');
  let privateKey;
  let owner;
  if (key) {
    privateKey = await webcrypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', d: key.d, x: key.x, y: key.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    owner = key.pub;
  } else {
    const kp = await generateKeyPair({ extractable: false });
    privateKey = kp.privateKey;
    owner = await exportPublicKey(kp.publicKey);
  }
  const now = Math.floor(Date.now() / 1000);
  const signed = await signPointer(Object.assign(parsePointer('v=mw1; btih=' + btih).record, { btih, owner, seq: now, exp: now + 86400 }), 'btih:' + btih, privateKey);
  const ledgerId = await ledgerIdFor(signed, 'btih:' + btih);
  return { text: formatPointer(signed), origin: 'https://' + hubLabelFor(signed, ledgerId) + '.' + hub, ledgerId };
}

const HUB_ON = { action: 'continue', mode: { kind: 'private' }, stay: false, sharedComputer: false, hub: true };

test('hub identity: one key on the hub\'s own pages after the person opts in; platform suffixes and other hubs stay per site', async () => {
  const store = await openIdoStore({ memory: true });
  const passkey = fakePasskey();
  const HUB = 'hub.example';
  const TEMPLATE = 'a'.repeat(40);
  const tpl = await hubPage(TEMPLATE, HUB);
  const cards = scriptedCards({ signin: HUB_ON });
  const { idp } = await newIdp({ win: null, store, passkey, cards, hubSuffixes: [HUB] });
  const { box, req } = await request({ extra: { hubDefault: true, pointer: tpl.text } });
  const res = await idp.handleRequest(req, tpl.origin, null);
  const K = await client.open(client.BUNDLE_PREFIX, box.privateKey, res.bundle, { origin: tpl.origin, requestId: req.requestId });
  assert.equal(K.keyMode, 'hub');
  assert.equal(K.label, 'h|' + HUB);
  const shown = cards.calls.find((c) => c.name === 'signin').data.hub;
  // Code review v0.3 (security 9): the page's hubDefault alone does not tick the box (no build template list here).
  assert.deepEqual(shown, { suffix: HUB, decided: false, on: false, buildDefault: false });
  const hubState = (await store.getState()).hubs[HUB];
  assert.equal(hubState.on, true);
  assert.deepEqual(hubState.templates, [TEMPLATE], 'the template of the page where the person turned it on');
  // Another person's page made from the same template: the same hub key.
  const page2 = await hubPage(TEMPLATE, HUB);
  const { idp: idp2 } = await newIdp({ win: null, store, passkey, hubSuffixes: [HUB] });
  const { box: b2, req: r2 } = await request({ extra: { pointer: page2.text } });
  const res2 = await idp2.handleRequest(r2, page2.origin, null);
  const K2 = await client.open(client.BUNDLE_PREFIX, b2.privateKey, res2.bundle, { origin: page2.origin, requestId: r2.requestId });
  assert.equal(K2.pub, K.pub, 'the same key on another page of the hub');
  // A hub domain that is not one of this build's hubs: per-origin keys, whatever the person would choose.
  const { idp: idp3 } = await newIdp({ win: null, store, passkey, hubSuffixes: [HUB], cards: scriptedCards({ signin: HUB_ON }) });
  const other = await hubPage(TEMPLATE, 'other-hub.example');
  const { box: b3, req: r3 } = await request({ extra: { pointer: other.text } });
  const res3 = await idp3.handleRequest(r3, other.origin, null);
  const K3 = await client.open(client.BUNDLE_PREFIX, b3.privateKey, res3.bundle, { origin: other.origin, requestId: r3.requestId });
  assert.notEqual(K3.keyMode, 'hub');
  // A multi-tenant platform suffix on the Public Suffix List (anyone registers a 32-character name there): never a hub.
  const platformCards = scriptedCards({ signin: HUB_ON });
  const { idp: idp4 } = await newIdp({ win: null, store, passkey, cards: platformCards });
  for (const suffix of ['github.io', 'pages.dev', 'netlify.app']) {
    const pg = await hubPage(TEMPLATE, suffix);
    const { box: b4, req: r4 } = await request({ extra: { hubDefault: true, pointer: pg.text } });
    const res4 = await idp4.handleRequest(r4, pg.origin, null);
    const K4 = await client.open(client.BUNDLE_PREFIX, b4.privateKey, res4.bundle, { origin: pg.origin, requestId: r4.requestId });
    assert.notEqual(K4.keyMode, 'hub', suffix);
  }
  assert.ok(platformCards.calls.filter((c) => c.name === 'signin').every((c) => c.data.hub === null), 'no hub box on a platform suffix');
  const { hubSuffixOf, isHubSuffix } = await import('../../src/idp/psl.js');
  assert.equal(hubSuffixOf('a'.repeat(32) + '.netlify.app'), null, 'a production build offers no hub label on netlify.app');
  assert.equal(isHubSuffix('github.io'), false);
});

test('review round PHISH-1, HUB-3: a stranger\'s label on the hub (other code, or no pointer) gets its own key, and its erase cannot touch the hub keys', async () => {
  const store = await openIdoStore({ memory: true });
  const passkey = fakePasskey();
  const HUB = 'hub.example';
  const TEMPLATE = 'a'.repeat(40);
  const tpl = await hubPage(TEMPLATE, HUB);
  const { idp } = await newIdp({ win: null, store, passkey, cards: scriptedCards({ signin: HUB_ON }), hubSuffixes: [HUB] });
  const { box, req } = await request({ extra: { pointer: tpl.text } });
  const K = await client.open(client.BUNDLE_PREFIX, box.privateKey, (await idp.handleRequest(req, tpl.origin, null)).bundle, { origin: tpl.origin, requestId: req.requestId });
  assert.equal(K.keyMode, 'hub');
  // Sam's page: his own signed pointer, his own code (another btih), served at the label derived from it.
  const sam = await hubPage('c'.repeat(40), HUB);
  const cards2 = scriptedCards();
  const { idp: idp2 } = await newIdp({ win: null, store, passkey, cards: cards2, hubSuffixes: [HUB] });
  const { box: b2, req: r2 } = await request({ extra: { pointer: sam.text } });
  const K2 = await client.open(client.BUNDLE_PREFIX, b2.privateKey, (await idp2.handleRequest(r2, sam.origin, null)).bundle, { origin: sam.origin, requestId: r2.requestId });
  assert.notEqual(K2.keyMode, 'hub');
  assert.notEqual(K2.pub, K.pub, 'not the hub key');
  assert.notEqual(K2.sign.d, K.sign.d);
  assert.notEqual(K2.rec.key, K.rec.key);
  assert.notEqual(K2.own, K.own);
  assert.equal(cards2.calls.find((c) => c.name === 'signin').data.hub.notTemplate, true, 'the card says the page is not one of the hub\'s own');
  // A 32-character label with no pointer at all: its own key.
  const { box: b3, req: r3 } = await request();
  const bare = 'https://' + 'd'.repeat(32) + '.' + HUB;
  const K3 = await client.open(client.BUNDLE_PREFIX, b3.privateKey, (await idp2.handleRequest(r3, bare, null)).bundle, { origin: bare, requestId: r3.requestId });
  assert.equal(K3.keyMode, 'pairwise');
  // Sam's page asks for an erase: only its own label loses its record keys; the hub label keeps K_rec and K_own.
  const { box: b4, req: r4 } = await request({ want: ['erase'], extra: { pointer: sam.text } });
  const res4 = await idp2.handleRequest(r4, sam.origin, null);
  assert.equal(res4.ok, true);
  const { box: b5, req: r5 } = await request({ extra: { pointer: tpl.text } });
  const K5 = await client.open(client.BUNDLE_PREFIX, b5.privateKey, (await idp2.handleRequest(r5, tpl.origin, null)).bundle, { origin: tpl.origin, requestId: r5.requestId });
  assert.equal(K5.keyMode, 'hub');
  assert.equal(K5.rec.key, K.rec.key, 'the hub record key survives a stranger\'s erase');
  assert.equal(K5.own, K.own);
  void b4;
  // A build that lists its templates: only those, and a page asking for the default gets the box ticked.
  const store2 = await openIdoStore({ memory: true });
  const cards3 = scriptedCards({ signin: HUB_ON });
  const { createIdp } = await import('../../src/idp/idp.js');
  const listed = createIdp({ win: null, doc: null, navigator: null, location: { origin: IDP }, cards: cards3, passkey: fakePasskey(), store: store2, wasm: true, ios: false, standalone: false, build: { version: '0.3.0', id: 'test0001', hash: '', test: true }, hubSuffixes: [HUB], hubTemplates: [TEMPLATE] });
  const { box: b6, req: r6 } = await request({ extra: { pointer: tpl.text, hubDefault: true } });
  const K6 = await client.open(client.BUNDLE_PREFIX, b6.privateKey, (await listed.handleRequest(r6, tpl.origin, null)).bundle, { origin: tpl.origin, requestId: r6.requestId });
  assert.equal(K6.keyMode, 'hub');
  assert.equal(cards3.calls.find((c) => c.name === 'signin').data.hub.buildDefault, true, 'a listed template asking for the default gets the box ticked');
  assert.equal((await store2.getState()).hubs[HUB].templates, undefined, 'the build list decides, nothing is kept');
});

test('personal sites: nextPubHash commits to signKey(label, i + 1); "Replace my keys" moves other sites and keeps the key that owns a page', async () => {
  const { nextKeyCommitment } = await import('../../src/common/pointer.js');
  const d = await import('../../src/identity/derive.js');
  const { b64url } = await import('../../src/chain/canonical.js');
  const store = await openIdoStore({ memory: true });
  const passkey = fakePasskey();
  const HUB = 'hub.example';
  const tpl = await hubPage('a'.repeat(40), HUB);
  const { idp } = await newIdp({ win: null, store, passkey, cards: scriptedCards({ signin: HUB_ON }), hubSuffixes: [HUB] });
  // "Create my page" on one of the hub's own pages, confirmed on the identity origin's card: the hub key owns the page.
  const { box, req } = await request({ extra: { create: true, pointer: tpl.text } });
  const res = await idp.handleRequest(req, tpl.origin, null);
  const K = await client.open(client.BUNDLE_PREFIX, box.privateKey, res.bundle, { origin: tpl.origin, requestId: req.requestId });
  assert.equal(K.keyMode, 'hub');
  assert.equal(K.sign.i, 1);
  assert.match(K.nextPubHash, /^[A-Za-z0-9_-]{43}$/);
  assert.match(K.rc, /^[A-Za-z0-9_-]{43}$/, 'the keyinfo commitment to the recover key');
  const rs = await d.rootStar(b64url.decode(idp.session.vault.data.root));
  const seed = await d.labelSeed(rs, K.label);
  assert.equal(K.nextPubHash, await nextKeyCommitment(d.publicKeyOf(await d.signScalar(seed, 2))), 'nx= commits to index i + 1');
  const OTHER = 'https://forum.example';
  const { box: bo, req: ro } = await request();
  const KO = await client.open(client.BUNDLE_PREFIX, bo.privateKey, (await idp.handleRequest(ro, OTHER, null)).bundle, { origin: OTHER, requestId: ro.requestId });
  const { idp: idp2 } = await newIdp({ win: null, store, passkey, hubSuffixes: [HUB] });
  // Review round PHISH-6: the card names the sites whose key stays.
  assert.deepEqual(await idp2.replaceAllKeys(), { replaced: 1, kept: 1, keptSites: [tpl.origin] });
  // The page's owner key stays: no owner hand-over exists, so moving it would strand the page (security 5).
  const { box: b2, req: r2 } = await request({ extra: { pointer: tpl.text } });
  const K2 = await client.open(client.BUNDLE_PREFIX, b2.privateKey, (await idp2.handleRequest(r2, tpl.origin, null)).bundle, { origin: tpl.origin, requestId: r2.requestId });
  assert.equal(K2.sign.i, 1);
  assert.equal(K2.pub, K.pub, 'the person still owns their page');
  assert.equal(K2.rotateNotice, undefined);
  // Every other site moves to i + 1 and hears it once.
  const { box: b3, req: r3 } = await request();
  const KO2 = await client.open(client.BUNDLE_PREFIX, b3.privateKey, (await idp2.handleRequest(r3, OTHER, null)).bundle, { origin: OTHER, requestId: r3.requestId });
  assert.equal(KO2.sign.i, 2);
  assert.notEqual(KO2.pub, KO.pub);
  assert.deepEqual([KO2.rotateNotice.from, KO2.rotateNotice.next], [KO.pub, KO2.pub]);
  assert.match(KO2.rotateNotice.rp, /^p256:/);
  const { box: b4, req: r4 } = await request();
  const KO3 = await client.open(client.BUNDLE_PREFIX, b4.privateKey, (await idp2.handleRequest(r4, OTHER, null)).bundle, { origin: OTHER, requestId: r4.requestId });
  assert.equal(KO3.rotateNotice, undefined, 'each site hears it once');
  assert.equal(KO3.pub, KO2.pub);
});

test('review round PHISH-6: create: true or an owner action from a plain origin marks no page owner; a pointer owned by the key does', async () => {
  const store = await openIdoStore({ memory: true });
  const passkey = fakePasskey();
  const cards = scriptedCards();
  const { idp } = await newIdp({ win: null, store, passkey, cards });
  const { box, req } = await request({ extra: { create: true } });
  const K = await client.open(client.BUNDLE_PREFIX, box.privateKey, (await idp.handleRequest(req, SITE, null)).bundle, { origin: SITE, requestId: req.requestId });
  assert.ok(!cards.calls.some((c) => c.name === 'createPage'), 'no "Create your page" card off a hub');
  const { box: b1, req: r1 } = await request({ extra: { owner: { what: 'policy' } } });
  await client.open(client.BUNDLE_PREFIX, b1.privateKey, (await idp.handleRequest(r1, SITE, null)).bundle, { origin: SITE, requestId: r1.requestId });
  const { idp: idp2 } = await newIdp({ win: null, store, passkey });
  assert.deepEqual(await idp2.replaceAllKeys(), { replaced: 1, kept: 0, keptSites: [] }, 'the stolen-key remedy reaches this site');
  const { box: b2, req: r2 } = await request();
  const K2 = await client.open(client.BUNDLE_PREFIX, b2.privateKey, (await idp2.handleRequest(r2, SITE, null)).bundle, { origin: SITE, requestId: r2.requestId });
  assert.equal(K2.sign.i, 2);
  assert.notEqual(K2.pub, K.pub);
  // A server sign-in never carries an owner action or a page creation.
  const nonces = new MemoryNonceStore();
  const ch = await issueChallenge({ statement: 'x', nonces, ttlMs: 300000 });
  const { req: r3 } = await request({ purpose: 'server', want: ['keys', 'proof'], extra: { create: true, challenge: { nonce: ch.nonce, statement: ch.statement, exp: ch.exp } } });
  const res3 = await idp2.handleRequest(r3, SITE, null);
  assert.deepEqual([res3.ok, res3.code], [false, 'E_BAD_REQUEST']);
});

test('the identity origin bundle: reproducible build, SRI on the page, build id in the worker, --test-psl only with --test', async () => {
  const os = await import('node:os');
  const fsp = await import('node:fs/promises');
  const { buildIdp, sriFor } = await import('../../tools/build-idp.mjs');
  const dir = await fsp.mkdtemp((await import('node:path')).join(os.tmpdir(), 'mw-idp-build-'));
  try {
    await assert.rejects(buildIdp({ outDir: dir + '/x', testPsl: ['localhost'], quiet: true }), /--test/);
    const a = await buildIdp({ outDir: dir + '/a', quiet: true });
    const b = await buildIdp({ outDir: dir + '/b', quiet: true });
    assert.equal(a.bundleSha256, b.bundleSha256, 'the same sources give the same bundle');
    assert.equal(a.buildId, b.buildId);
    assert.match(a.buildId, /^[0-9a-f]{12}$/);
    const js = await fsp.readFile(dir + '/a/idp.js');
    const html = await fsp.readFile(dir + '/a/signin/index.html', 'utf8');
    assert.ok(html.includes('src="../idp.js" integrity="' + sriFor(js) + '"'));
    assert.ok(html.includes('content="0.3.0 ' + a.buildId + ' ' + a.bundleSha256 + '"'));
    const sw = await fsp.readFile(dir + '/a/sw.js', 'utf8');
    assert.ok(sw.includes(JSON.stringify(a.buildId)) && !sw.includes('__MW_IDP_BUILD__'));
    const headers = await fsp.readFile(dir + '/a/_headers', 'utf8');
    assert.ok(headers.includes("script-src 'self' 'wasm-unsafe-eval'") && headers.includes("frame-ancestors 'none'") && headers.includes('Referrer-Policy: no-referrer'));
    assert.ok(a.qrGzipBytes > 1000 && a.qrGzipBytes < 20000);
    const tb = await buildIdp({ outDir: dir + '/t', test: true, testPsl: ['localhost'], quiet: true });
    assert.match(tb.buildId, /^test-[0-9a-f]{12}$/);
    assert.notEqual(tb.bundleSha256, a.bundleSha256);
    // The built bundle loads (nothing runs outside the IdO page) and knows it is a test build.
    const built = await import(new URL('file://' + dir + '/t/idp.js').href);
    assert.equal(built.readBuild(null).test, true);
    const prod = await import(new URL('file://' + dir + '/a/idp.js').href);
    assert.equal(prod.readBuild(null).test, false);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('code review v0.3 round 2: --hub-suffix and --shared-origin build the hub lists into the identity origin and its build id', async () => {
  const os = await import('node:os');
  const fsp = await import('node:fs/promises');
  const { buildIdp, checkHubSuffix, checkSharedOrigin } = await import('../../tools/build-idp.mjs');
  const dir = await fsp.mkdtemp((await import('node:path')).join(os.tmpdir(), 'mw-idp-hubs-'));
  try {
    for (const bad of ['com', 'GitHub.io', 'hub..example', '']) assert.throws(() => checkHubSuffix(bad), /--hub-suffix/, bad);
    for (const bad of ['https://demo.example.org/', 'http://demo.example.org', 'demo.example.org', 'https://demo.example.org/x']) assert.throws(() => checkSharedOrigin(bad), /--shared-origin/, bad);
    assert.equal(checkSharedOrigin('http://127.0.0.1:8080', { test: true }), 'http://127.0.0.1:8080');
    const plain = await buildIdp({ outDir: dir + '/p', quiet: true });
    const hubs = await buildIdp({ outDir: dir + '/h', hubSuffixes: ['hub.example.org', 'hub.example.org'], sharedOrigins: ['https://demo.example.org'], quiet: true });
    assert.deepEqual(hubs.hubSuffixes, ['hub.example.org']);
    assert.deepEqual(hubs.sharedOrigins, ['https://demo.example.org']);
    assert.notEqual(hubs.buildId, plain.buildId, 'the lists are part of the build id');
    const info = JSON.parse(await fsp.readFile(dir + '/h/build.json', 'utf8'));
    assert.deepEqual([info.hubSuffixes, info.sharedOrigins], [['hub.example.org'], ['https://demo.example.org']]);
    const built = await import(new URL('file://' + dir + '/h/idp.js').href);
    assert.deepEqual([built.readBuild(null).hubs, built.readBuild(null).shared], [['hub.example.org'], ['https://demo.example.org']]);
    const prod = await import(new URL('file://' + dir + '/p/idp.js').href);
    assert.deepEqual([prod.readBuild(null).hubs, prod.readBuild(null).shared], [[], []], 'a normal build offers no hub label');
    // Review round R 5.3 (PHISH-1, HUB-3; integrator): --hub-template builds MW_HUB_TEMPLATES (src/idp/psl.js HUB_TEMPLATES).
    const T = 'ab'.repeat(20);
    const tpl = await buildIdp({ outDir: dir + '/t', hubSuffixes: ['hub.example.org'], hubTemplates: [T.toUpperCase(), T], quiet: true });
    assert.deepEqual(tpl.hubTemplates, [T]);
    assert.notEqual(tpl.buildId, hubs.buildId, 'the template list is part of the build id');
    assert.deepEqual(JSON.parse(await fsp.readFile(dir + '/t/build.json', 'utf8')).hubTemplates, [T]);
    assert.ok((await fsp.readFile(dir + '/t/idp.js', 'utf8')).includes(T), 'the bundle carries the template list');
    assert.ok(!(await fsp.readFile(dir + '/h/idp.js', 'utf8')).includes(T));
    await assert.rejects(buildIdp({ outDir: dir + '/x', hubTemplates: ['not-hex'], quiet: true }), /--hub-template/);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('the loopback fixture serves the identity origin with its own headers', async () => {
  const { startIdpServer } = await import('../fixtures/idp/serve.mjs');
  const s = await startIdpServer({ src: true });
  try {
    for (const path of ['/', '/signin']) {
      const r = await fetch(s.url + path);
      assert.equal(r.status, 200, path);
      const csp = r.headers.get('content-security-policy');
      assert.ok(csp.includes("script-src 'self' 'wasm-unsafe-eval'") && csp.includes("frame-ancestors 'none'"), path);
      assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
      assert.ok((await r.text()).includes('/src/idp/idp.js'));
    }
    const js = await fetch(s.url + '/src/idp/link.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.equal((await fetch(s.url + '/src/../package.json')).status, 404);
    assert.equal((await fetch(s.url + '/sw.js')).headers.get('cache-control'), 'no-cache');
    assert.ok(!(await (await fetch(s.url + '/sw.js')).text()).includes('export '), 'a classic copy of the worker');
  } finally {
    await s.close();
  }
});

test('integrator (SUP-7): the identity origin\'s bundled npm packages are checked against build.lock.json like the loader\'s', async () => {
  const { checkIdpPackages } = await import('../../tools/build-idp.mjs');
  const { ROOT } = await import('../../tools/lib.mjs');
  const path = await import('node:path');
  assert.deepEqual(checkIdpPackages(ROOT, [path.join('src', 'idp', 'idp.js')]), [], 'own code only: nothing to pin');
  // A package that is in node_modules but not pinned fails the build.
  assert.throws(() => checkIdpPackages(ROOT, ['node_modules/axe-core/axe.js']), /does not pin/);
});
