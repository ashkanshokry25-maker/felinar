// The site-origin client (R 2.3.1, 2.3.3, 2.4.1, 2.11.2): the identity window opens inside the click, the request
// goes only to the identity origin and only after its ready message, answers from anywhere else are ignored, the
// bundle opens with this request's page key, the errors of R 2.11.2 (E_POPUP_BLOCKED, E_IDP_UNREACHABLE,
// E_USER_CANCELLED, E_RATE), and the redirect round trip through /_mw/idp-return.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import * as client from '../../src/identity/client.js';
import { createIdp } from '../../src/idp/idp.js';
import { openIdoStore } from '../../src/idp/store.js';

const IDP = 'http://localhost:9555';
const SITE = 'https://shop.example';

function scriptedCards() {
  return new Proxy({ lang: 'en' }, {
    get(t, k) {
      if (k in t) return t[k];
      return async () => {
        if (k === 'signin') return { action: 'continue', mode: { kind: 'private' }, stay: false, sharedComputer: false, hub: null };
        if (k === 'chooseUnlock') return { method: 'passkey', nickname: 'test' };
        if (k === 'foundPosts') return 'continue';
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

async function newIdo(store) {
  const st = store || await openIdoStore({ memory: true });
  return { store: st, idp: createIdp({ win: null, doc: null, navigator: null, location: { origin: IDP }, cards: scriptedCards(), passkey: fakePasskey(), store: st, wasm: true, ios: false, standalone: false, build: { version: '0.3.0', id: 'test0001', hash: '', test: true } }) };
}

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}

function siteWindow({ blocked = false, idpMeta = IDP, href = SITE + '/page' } = {}) {
  const listeners = new Set();
  const popup = { closed: false, posts: [], onPost: null, postMessage(msg, target) { popup.posts.push({ msg, target }); if (popup.onPost) popup.onPost(msg, target); }, close() { popup.closed = true; } };
  const url = new URL(href);
  const w = {
    popup, opened: [],
    location: { origin: url.origin, href, hash: url.hash, pathname: url.pathname, assigned: [], assign(u) { this.assigned.push(u); }, replace(u) { this.replaced = u; } },
    history: { calls: [], replaceState(s, t, u) { w.history.calls.push(u); w.location.hash = ''; } },
    document: { querySelector: (sel) => (sel === 'meta[name="mw-idp"]' && idpMeta ? { getAttribute: () => idpMeta } : null) },
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(type, fn) { listeners.delete(fn); },
    deliver(ev) { for (const fn of Array.from(listeners)) fn(ev); },
    open(u, name, features) { w.opened.push({ url: u, name, features }); return blocked ? null : popup; },
    sessionStorage: memoryStorage(),
    indexedDB: null,
  };
  return w;
}

/** Connects the fake popup to an in-process identity origin answering for `origin`. */
function wire(win, idp, { origin = SITE } = {}) {
  win.popup.onPost = (msg) => {
    if (!msg || msg.t !== 'mw-signin-req') return;
    const pendingRounds = new Map();
    const prevOnPost = win.popup.onPost;
    win.popup.onPost = (m) => {
      const r = m && pendingRounds.get(m.t);
      if (r) { pendingRounds.delete(m.t); r(m); return; }
      return prevOnPost(m);
    };
    const channel = {
      ask(message, expectT) {
        return new Promise((resolve) => {
          pendingRounds.set(expectT, resolve);
          win.deliver({ source: win.popup, origin: IDP, data: message });
        });
      },
    };
    idp.handleRequest(msg, origin, channel).then((res) => win.deliver({ source: win.popup, origin: IDP, data: res }));
  };
}

const ready = (win, extra = {}) => win.deliver(Object.assign({ source: win.popup, origin: IDP, data: { v: 1, t: 'mw-idp-ready', build: '0.3.0-test' } }, extra));
const tick = () => new Promise((r) => setImmediate(r));

test('the window opens inside the click (before any await) and the request goes to the identity origin only after its ready message', async () => {
  client.resetCooldown();
  const { idp } = await newIdo();
  const win = siteWindow();
  wire(win, idp);
  const p = client.signIn({ win, purpose: 'site', want: ['keys'] });
  assert.equal(win.opened.length, 1, 'opened synchronously');
  assert.deepEqual(win.opened[0], { url: IDP + '/signin', name: 'mw-idp', features: 'popup,width=420,height=640' });
  await tick();
  assert.equal(win.popup.posts.length, 0, 'nothing is sent before mw-idp-ready');
  ready(win, { source: { other: true } });
  ready(win, { origin: 'https://evil.example' });
  await tick();
  assert.equal(win.popup.posts.length, 0, 'a ready message from another window or origin is ignored');
  ready(win);
  const out = await p;
  const req = win.popup.posts[0];
  assert.equal(req.target, IDP, 'targetOrigin is the identity origin');
  assert.equal(req.msg.t, 'mw-signin-req');
  assert.deepEqual(Object.keys(req.msg).sort(), ['epk', 'purpose', 'requestId', 't', 'v', 'want']);
  assert.equal(out.bundle.origin, SITE);
  assert.equal(out.bundle.keyMode, 'pairwise');
});

test('E_POPUP_BLOCKED, E_RATE (10 s per kind), E_IDP_UNREACHABLE without an identity page', async () => {
  client.resetCooldown();
  let t = 1_000_000;
  const now = () => t;
  await assert.rejects(client.signIn({ win: siteWindow({ blocked: true }), now }), (e) => e.code === 'E_POPUP_BLOCKED');
  const { idp } = await newIdo();
  const win = siteWindow();
  wire(win, idp);
  const first = client.signIn({ win, now });
  await assert.rejects(client.signIn({ win: siteWindow(), now }), (e) => e.code === 'E_RATE');
  ready(win);
  await first;
  t += 10001;
  const win2 = siteWindow();
  wire(win2, idp);
  const second = client.signIn({ win: win2, now });
  ready(win2);
  assert.ok((await second).bundle, 'after 10 s it opens again');
  const server = client.signIn({ win: siteWindow({ blocked: true }), now, purpose: 'server', want: ['proof'], challenge: { nonce: 'A'.repeat(22) } });
  await assert.rejects(server, (e) => e.code === 'E_POPUP_BLOCKED', 'another kind has its own cooldown');
  client.resetCooldown();
  await assert.rejects(client.signIn({ win: siteWindow({ idpMeta: null }) }), (e) => e.code === 'E_IDP_UNREACHABLE');
});

test('closing the window: E_IDP_UNREACHABLE before the page loaded, E_USER_CANCELLED after', async () => {
  client.resetCooldown();
  const win = siteWindow();
  const p = client.signIn({ win, pollMs: 5 });
  win.popup.closed = true;
  await assert.rejects(p, (e) => e.code === 'E_IDP_UNREACHABLE');
  client.resetCooldown();
  const win2 = siteWindow();
  const p2 = client.signIn({ win: win2, pollMs: 5 });
  ready(win2);
  await tick();
  win2.popup.closed = true;
  await assert.rejects(p2, (e) => e.code === 'E_USER_CANCELLED');
  client.resetCooldown();
  const win3 = siteWindow();
  const p3 = client.signIn({ win: win3, readyTimeoutMs: 20 });
  await assert.rejects(p3, (e) => e.code === 'E_IDP_UNREACHABLE', 'no ready message in time');
  assert.equal(win3.popup.closed, true);
});

test('answers for another request, from another window or malformed are not taken', async () => {
  client.resetCooldown();
  const win = siteWindow();
  const p = client.signIn({ win });
  ready(win);
  await tick();
  await tick();
  const requestId = win.popup.posts[0].msg.requestId;
  win.deliver({ source: win.popup, origin: IDP, data: { v: 1, t: 'mw-signin-res', requestId: 'X'.repeat(22), ok: true } });
  win.deliver({ source: { other: true }, origin: IDP, data: { v: 1, t: 'mw-signin-res', requestId, ok: false, code: 'E_USER_CANCELLED' } });
  win.deliver({ source: win.popup, origin: SITE, data: { v: 1, t: 'mw-signin-res', requestId, ok: false, code: 'E_USER_CANCELLED' } });
  await tick();
  win.deliver({ source: win.popup, origin: IDP, data: { v: 1, t: 'mw-signin-res', requestId, ok: true, bundle: { v: 1, epk: 'nope' } } });
  await assert.rejects(p, (e) => e.code === 'E_BAD_REQUEST');
});

test('the "Found N posts" round answers the identity origin with the site\'s own count', async () => {
  client.resetCooldown();
  const store = await openIdoStore({ memory: true });
  const { idp } = await newIdo(store);
  const win0 = siteWindow();
  wire(win0, idp);
  const p0 = client.signIn({ win: win0 });
  ready(win0);
  await p0;
  const state = await store.getState();
  state.restored = { t: Date.now(), left: 3 };
  await store.setState(state);
  client.resetCooldown();
  const win = siteWindow();
  wire(win, idp);
  const asked = [];
  const p = client.signIn({ win, countPosts: async (pub) => { asked.push(pub); return 3; } });
  ready(win);
  const out = await p;
  assert.deepEqual(asked, [out.bundle.pub], 'asked about the key the identity origin derived for this site');
  const reply = win.popup.posts.find((x) => x.msg.t === 'mw-idp-count-res');
  assert.equal(reply.target, IDP);
  assert.equal(reply.msg.count, 3);
});

test('a challenge may be a promise: the window opens first, the request waits for it', async () => {
  client.resetCooldown();
  const { idp } = await newIdo();
  const win = siteWindow();
  wire(win, idp);
  let resolve;
  const challenge = new Promise((r) => { resolve = r; });
  const p = client.signIn({ win, purpose: 'server', want: ['proof'], challenge });
  assert.equal(win.opened.length, 1);
  ready(win);
  await tick();
  assert.equal(win.popup.posts.length, 0, 'the request waits for the challenge');
  resolve({ nonce: Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url'), statement: 'Sign in to Example Shop' });
  const out = await p;
  assert.equal(out.proof.c.statement, 'Sign in to Example Shop');
  assert.equal(out.bundle, undefined);
});

test('redirect round trip: the pending key survives the navigation, the answer opens at /_mw/idp-return and the fragment goes', async () => {
  client.resetCooldown();
  const { idp } = await newIdo();
  const win = siteWindow({ href: SITE + '/shop/cart?x=1' });
  client.signIn({ win, redirect: true });
  for (let i = 0; i < 20 && !win.location.assigned.length; i++) await tick();
  assert.equal(win.location.assigned.length, 1);
  const [base, frag] = win.location.assigned[0].split('#');
  assert.equal(base, IDP + '/signin');
  const req = client.decodeFragment(frag);
  assert.equal(req.origin, SITE);
  assert.equal(req.ret, SITE + '/_mw/idp-return');
  assert.equal(client.validateRequest(req, { transport: 'redirect' }).ok, true);
  // The identity origin answers through the return URL's fragment.
  const clean = Object.assign({}, req);
  delete clean.origin;
  delete clean.ret;
  const res = await idp.handleRequest(clean, req.origin, null);
  const back = siteWindow({ href: SITE + '/_mw/idp-return#' + client.encodeFragment(res) });
  back.sessionStorage = win.sessionStorage; // the same tab
  const out = await client.completeRedirect({ win: back });
  assert.equal(out.bundle.origin, SITE);
  assert.equal(out.returnTo, SITE + '/shop/cart?x=1');
  assert.deepEqual(back.history.calls, ['/_mw/idp-return'], 'the fragment is removed at once');
  // The same answer again finds no pending request.
  const again = siteWindow({ href: SITE + '/_mw/idp-return#' + client.encodeFragment(res) });
  again.sessionStorage = win.sessionStorage;
  await assert.rejects(client.completeRedirect({ win: again }), (e) => e.code === 'E_BAD_REQUEST');
  assert.equal(await client.completeRedirect({ win: siteWindow({ href: SITE + '/_mw/idp-return' }) }), null, 'no fragment, nothing to do');
});

test('drop-in redirect: the encrypted answer waits in this tab for the page; a proof is never kept in sessionStorage', async () => {
  client.resetCooldown();
  const { idp } = await newIdo();
  const win = siteWindow({ href: SITE + '/blog/post' });
  client.signIn({ win, redirect: true });
  for (let i = 0; i < 20 && !win.location.assigned.length; i++) await tick();
  const req = client.decodeFragment(win.location.assigned[0].split('#')[1]);
  const clean = Object.assign({}, req);
  delete clean.origin;
  delete clean.ret;
  const res = await idp.handleRequest(clean, req.origin, null);
  const back = siteWindow({ href: SITE + '/_mw/idp-return#' + client.encodeFragment(res) });
  back.sessionStorage = win.sessionStorage;
  const r = await client.completeRedirect({ win: back, defer: true });
  assert.deepEqual(r, { deferred: true, returnTo: SITE + '/blog/post' });
  const stash = win.sessionStorage.getItem('mw-idp-answer');
  assert.ok(stash && !stash.includes('"d"'), 'only the sealed answer is kept');
  const page = siteWindow({ href: SITE + '/blog/post' });
  page.sessionStorage = win.sessionStorage;
  const out = await client.takeDeferredAnswer({ win: page });
  assert.equal(out.bundle.origin, SITE);
  assert.equal(win.sessionStorage.getItem('mw-idp-answer'), null);
  // A proof never goes by redirect (review round SEC-2, PHISH-9): the client refuses to start one, the identity origin
  // refuses one, and a proof answer arriving at the drop-in return page is still refused and not stored.
  client.resetCooldown();
  const w2 = siteWindow({ href: SITE + '/blog/post' });
  await assert.rejects(client.signIn({ win: w2, redirect: true, purpose: 'server', want: ['proof'], challenge: { nonce: Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url') } }), (e) => e.code === 'E_BAD_REQUEST');
  assert.equal(w2.location.assigned.length, 0, 'no navigation for a proof');
  const forged = { v: 1, t: 'mw-signin-res', requestId: Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url'), ok: true, proof: { c: {}, alg: 'ES256-P1363', sig: 'x' } };
  const back2 = siteWindow({ href: SITE + '/_mw/idp-return#' + client.encodeFragment(forged) });
  back2.sessionStorage = w2.sessionStorage;
  await assert.rejects(client.completeRedirect({ win: back2, defer: true }), (e) => e.code === 'E_POPUP_BLOCKED');
  assert.equal(w2.sessionStorage.getItem('mw-idp-answer'), null);
});

test('the identity origin address: explicit, then configure(), then <meta name="mw-idp">, then a signed pointer\'s idp=', () => {
  const SIG = '; sig=' + 'Q'.repeat(86);
  const doc = { querySelector: () => ({ getAttribute: () => 'https://id.meta.example' }) };
  assert.equal(client.resolveIdp({ idp: 'https://id.explicit.example', doc }), 'https://id.explicit.example');
  assert.equal(client.resolveIdp({ doc }), 'https://id.meta.example');
  assert.equal(client.resolveIdp({ doc: { querySelector: () => null }, pointer: 'v=mw1; btih=' + 'a'.repeat(40) + '; idp=https://id.ptr.example' + SIG }), 'https://id.ptr.example');
  assert.equal(client.resolveIdp({ idp: 'http://evil.example' }), null, 'plain http only on loopback');
  client.configure({ idp: 'https://id.config.example' });
  assert.equal(client.resolveIdp({ doc }), 'https://id.config.example');
  client.configure({ idp: null });
  assert.equal(client.resolveIdp({ doc }), 'https://id.meta.example');
  assert.equal(client.returnUrlOk(SITE + '/_mw/idp-return', SITE), true);
  assert.equal(client.returnUrlOk(SITE + '/_mw/idp-return/', SITE), false);
  // v0.3 final integration: no pointer given (the sign-in widget on a drop-in page): the page's stamped pointer names it.
  const stampedPage = (content) => ({ querySelector: (sel) => (sel === 'meta[name="mw-pointer"]' ? { getAttribute: () => content } : null) });
  assert.equal(client.resolveIdp({ doc: stampedPage('v=mw1; btih=' + 'a'.repeat(40) + '; idp=https://id.stamp.example' + SIG) }), 'https://id.stamp.example');
  assert.equal(client.resolveIdp({ doc: stampedPage('v=mw1; btih=' + 'a'.repeat(40) + SIG) }), null, 'a stamp without idp= names none');
  assert.equal(client.resolveIdp({ doc: stampedPage('v=mw1; idp=https://id.stamp.example' + SIG), pointer: 'v=mw1; idp=https://id.given.example' + SIG }), 'https://id.given.example', 'a pointer the caller passes wins over the stamp');
});

test('review round PTR-10, PHISH-10: an unsigned pointer, or one that arrived by link (hub label, door), never picks the identity origin', () => {
  const none = { querySelector: () => null };
  const evil = 'v=mw1; btih=' + 'a'.repeat(40) + '; idp=https://evil.example';
  assert.equal(client.resolveIdp({ doc: none, pointer: evil }), null, 'unsigned text names no identity origin');
  assert.equal(client.resolveIdp({ doc: none, pointer: evil + '; sig=' + 'Q'.repeat(86), trustPointer: false }), null, 'a link-carried signed pointer names none');
  const meta = { querySelector: (sel) => (sel === 'meta[name="mw-idp"]' ? { getAttribute: () => 'https://id.operator.example' } : null) };
  assert.equal(client.resolveIdp({ doc: meta, pointer: evil + '; sig=' + 'Q'.repeat(86), trustPointer: false }), 'https://id.operator.example', 'the operator meta still works');
  // The loader's identity service on a hub label passes trustPointer: false.
  const opened = [];
  const win = { location: { origin: 'https://' + 'b'.repeat(32) + '.hub.example', href: 'https://' + 'b'.repeat(32) + '.hub.example/' }, document: none, open: (u) => { opened.push(u); return null; } };
  client.resetCooldown();
  return assert.rejects(client.signIn({ win, pointer: evil + '; sig=' + 'Q'.repeat(86), trustPointer: false }), (e) => e.code === 'E_IDP_UNREACHABLE').then(() => {
    assert.equal(opened.length, 0, 'no window opened at evil.example');
  });
});

test('review round PRIV-4, HUB-9: the sign-in window opens while the page says no-referrer, and the page\'s own policy comes back', async () => {
  client.resetCooldown();
  const head = { kids: [], appendChild(n) { n.parentNode = head; head.kids.push(n); return n; }, removeChild(n) { head.kids = head.kids.filter((x) => x !== n); n.parentNode = null; } };
  const doc = {
    head,
    createElement: () => ({ attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } }),
    querySelector: (sel) => (sel === 'meta[name="mw-idp"]' ? { getAttribute: () => IDP } : null),
  };
  const seen = [];
  const win = siteWindow();
  win.document = doc;
  win.open = (u) => { seen.push(head.kids.filter((m) => m.attrs.name === 'referrer').map((m) => m.attrs.content)); return null; };
  await assert.rejects(client.signIn({ win }), (e) => e.code === 'E_POPUP_BLOCKED');
  assert.deepEqual(seen, [['no-referrer']], 'no-referrer is in force while window.open runs');
  const out = client.withoutReferrer(win, () => 7);
  assert.equal(out, 7);
});

test('review round PHISH-11: a statement outside the mw-signin-v1 rules is refused before any card', () => {
  const base = { v: 1, t: 'mw-signin-req', requestId: Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url'), purpose: 'server', want: ['proof'] };
  const ok = (statement) => client.validateRequest(Object.assign({}, base, { challenge: { nonce: 'A'.repeat(22), statement } })).ok;
  assert.equal(ok('Sign in to Example Forum'), true);
  assert.equal(ok('x'.repeat(281)), false, 'over 280 characters');
  assert.equal(ok('\u202eevil'), false, 'a bidi control');
  assert.equal(ok('line one\nline two'), false, 'a newline');
});

test('mergeRecords: per field the newest write wins, removals included', () => {
  const a = { f: { display: 'Ana', notes: 'old' }, ft: { display: 10, notes: 10 }, t: 10 };
  const b = { f: { display: 'Ana B' }, ft: { display: 20, notes: 20 }, t: 20 };
  const c = { f: { links: ['https://a.example'] }, ft: { links: 15 }, t: 15 };
  const m = client.mergeRecords(a, b, c);
  assert.deepEqual(m.f, { display: 'Ana B', links: ['https://a.example'] });
  assert.equal(m.t, 20);
  assert.deepEqual(client.mergeRecords(b, a).f, { display: 'Ana B' }, 'a removal newer than the value wins');
  assert.deepEqual(client.mergeRecords(c, b, a), m, 'order does not matter');
  assert.deepEqual(client.mergeRecords(null, undefined, { bad: 1 }), { f: {}, ft: {}, t: 0 });
});
