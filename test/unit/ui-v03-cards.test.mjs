// Unit tests for the v0.3 in-page cards (src/loader/ui.js createCards) and src/widget/redress.js: no secret
// fields in any card, untrusted clicks ignored, redress checks cancel on an overlay, opacity 0, a moved button
// and a style change, the sign-in prompt calls the injected function, high-risk cards are refused, offers never
// auto-accept. The fake DOM has no layout, so the tests give it a tiny one (below).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeDocument, FakeNode } from './dropin-fake-dom.mjs';
import { createCards, CARD_KINDS } from '../../src/loader/ui.js';
import { checkElement, createGuard, isTrusted } from '../../src/widget/redress.js';
import { uiText } from '../../src/loader/strings.js';

// ---- a tiny layout for the fake DOM -----------------------------------------------------------------
class FakeMO {
  static all = [];
  constructor(cb) { this.cb = cb; this.targets = []; FakeMO.all.push(this); }
  observe(target, init) { this.targets.push({ target, init }); }
  disconnect() { this.targets = []; }
}

function world() {
  const w = { overlay: null, styles: new Map(), rects: new Map(), clock: 1000 };
  FakeMO.all = [];
  FakeNode.prototype.getBoundingClientRect = function () {
    if (this.tagName !== 'BUTTON') return { x: 0, y: 0, width: 300, height: 100 };
    if (w.rects.has(this)) return w.rects.get(this);
    if (!this._idx) { w.n = (w.n || 0) + 1; this._idx = w.n; }
    return { x: 20, y: 100 * this._idx, width: 120, height: 44 };
  };
  FakeNode.prototype.getRootNode = function () { let n = this; while (n.parentNode) n = n.parentNode; return n; };
  FakeNode.prototype.elementFromPoint = function (x, y) {
    if (w.overlay) return w.overlay;
    const hit = this.findAll((n) => {
      if (n.tagName !== 'BUTTON') return false;
      const r = n.getBoundingClientRect();
      return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
    });
    return hit[0] || null;
  };
  const doc = new FakeDocument();
  doc.elementFromPoint = () => (w.overlay ? w.overlay : w.host);
  const win = {
    document: doc, innerWidth: 1200, innerHeight: 2000, MutationObserver: FakeMO,
    matchMedia: () => ({ matches: false }), navigator: { language: 'en-CA' },
    getComputedStyle: (n) => w.styles.get(n) || { opacity: '1', visibility: 'visible', display: 'block', pointerEvents: 'auto' }
  };
  w.doc = doc; w.win = win;
  return w;
}

function make(opts = {}) {
  const w = world();
  const cards = createCards(Object.assign({ win: w.win, doc: w.doc, now: () => w.clock, minVisibleMs: 250 }, opts));
  const open = (kind, data) => {
    const p = cards.prompt(kind, data);
    w.host = cards.host;
    return p;
  };
  const btn = (label) => cards.host.buttonByText(label);
  const tick = (ms) => { w.clock += ms; };
  return { w, cards, open, btn, tick };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const settled = async (p) => { let v; let done = false; p.then((x) => { v = x; done = true; }); await flush(); return { done, v }; };
const texts = (root) => root.findAll((n) => n._text).map((n) => n._text).join(' | ');

const SAMPLES = {
  signin: {}, tap: {}, consent: { card: 'turnOnChat', params: { tracker: 't.example', stun: 's.example' } }, confirm: { title: 'T', text: 'x' },
  upload: { visibility: 'private', name: 'a.jpg', size: 2048, type: 'image/jpeg' }, 'phone-upload': { name: 'a.mp4' },
  offer: { kind: 'file', from: 'Bo', name: 'x.pdf', size: 1000, type: 'pdf' }, 'owner-changed': { minutes: 4 }, 'foreign-address': {},
  'storage-evicted': {}, error: { code: 'E_NO_CHAT_KEY', params: { name: 'Bo' } },
  'mod.ban': { pub: 'p256:x', name: 'Eve', short: 'k3f9-2xq1' }, 'mod.unban': { name: 'Eve', short: 'k3f9' },
  'mod.tombstoneMany': { authors: ['a', 'b'], before: 1700000000000 }, 'mod.decide': { id: 1, decision: 'deny', kind: 'pin', reason: 'spam' },
  // v0.3 C2 (lane wire-ui): dock mode, with the two declarations of a browser that cannot read the battery
  dock: { ms: 7200000, until: 1700000000000, declare: true, start: () => Promise.resolve({ on: true }) },
  // code review v0.3: the recovery kit prompt and the redirect round trip's "Continue in this tab"
  kit: {}, 'continue-here': { options: {} }
};

test('every card kind renders in a closed shadow root with no text, password, file or textarea field (E-ID-10)', async () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), [...CARD_KINDS].sort(), 'a sample for each documented kind');
  for (const kind of CARD_KINDS) {
    const t = make({ lang: 'en' });
    t.open(kind, SAMPLES[kind]);
    const host = t.cards.host;
    assert.equal(host.shadowRoot, null, kind + ': closed root');
    assert.equal(host._shadow.mode, 'closed');
    const inputs = host.findAll((n) => n.tagName === 'INPUT' || n.tagName === 'TEXTAREA' || n.tagName === 'SELECT');
    assert.equal(inputs.length, 0, kind + ' has no input at all');
    const all = texts(host);
    assert.ok(!/12 words?, type|recovery phrase:|backup file/i.test(all), kind);
    t.cards.destroy();
  }
  const t = make();
  t.cards.setIdentityHeader({ name: 'Ana', short: 'k3f9-2xq1', pub: 'p256:abc' }, {});
  assert.equal(t.cards.host.findAll((n) => n.tagName === 'INPUT').length, 0);
});

test('the sign-in prompt shows the never-asks-for-words line and the scripts sentence', async () => {
  const t = make();
  t.open('signin', {});
  const all = texts(t.cards.host);
  assert.ok(all.includes('felinar never asks for your 12 words on the site you are signing in to.'));
  assert.ok(all.includes('Scripts on this page can act as you on this site while you are signed in. They cannot reach your other sites.'));
});

test('cards ignore untrusted clicks and act on trusted ones', async () => {
  const t = make();
  const p = t.open('confirm', { title: 'Sure?', text: 'x', confirmLabel: 'Yes' });
  t.tick(500);
  t.btn('Yes').dispatchEvent({ type: 'click', isTrusted: false });
  t.btn('Yes').click(); // fakes without the field pass as the person's own input
  assert.equal(await p, true);
  const q = t.open('confirm', { title: 'Sure?', text: 'x', confirmLabel: 'Yes' });
  t.tick(500);
  t.btn('Yes').dispatchEvent({ type: 'click', isTrusted: false });
  assert.equal((await settled(q)).done, false, 'a script click settles nothing');
  assert.equal(isTrusted({ isTrusted: false }), false);
  assert.equal(isTrusted({ isTrusted: true }), true);
  assert.equal(isTrusted({}), true);
});

test('a click right after the card appears is ignored (speed bump), later it works', async () => {
  const t = make();
  const p = t.open('consent', { card: 'rooms' });
  t.btn('Continue').click();
  assert.equal((await settled(p)).done, false);
  t.tick(300);
  t.btn('Continue').click();
  assert.equal(await p, true);
});

test('redress: an overlay on top of the button cancels the card', async () => {
  const t = make();
  const p = t.open('consent', { card: 'turnOnChat', params: {} });
  t.tick(500);
  t.w.overlay = new FakeNode('div', t.w.doc);
  t.btn('Continue').click();
  assert.equal(await p, false);
  assert.ok(texts(t.cards.host).includes('Cancelled: something moved or covered this button.'));
});

test('redress: a page element above the whole host (topmost on the page is not our host) cancels the card', async () => {
  const t = make();
  const p = t.open('consent', { card: 'rooms' });
  t.tick(500);
  const page = new FakeNode('div', t.w.doc);
  t.w.doc.elementFromPoint = () => page;
  t.btn('Continue').click();
  assert.equal(await p, false);
});

test('redress: computed opacity 0, visibility hidden or an ancestor with opacity below 1 cancels', async () => {
  for (const style of [{ opacity: '0' }, { visibility: 'hidden' }, { opacity: '0.4' }]) {
    const t = make();
    const p = t.open('consent', { card: 'rooms' });
    t.tick(500);
    const target = style.opacity === '0.4' ? t.cards.host : t.btn('Continue');
    t.w.styles.set(target, Object.assign({ opacity: '1', visibility: 'visible', display: 'block' }, style));
    t.btn('Continue').click();
    assert.equal(await p, false, JSON.stringify(style));
  }
});

test('redress: a button that moved since the card appeared cancels the card', async () => {
  const t = make();
  const p = t.open('consent', { card: 'rooms' });
  t.tick(500);
  t.w.rects.set(t.btn('Continue'), { x: 400, y: 900, width: 120, height: 44 });
  t.btn('Continue').click();
  assert.equal(await p, false);
});

test('redress: a style or class mutation under the host reported by the MutationObserver cancels the card', async () => {
  const t = make();
  const p = t.open('consent', { card: 'rooms' });
  assert.ok(FakeMO.all.length > 0, 'observers are installed');
  const hostObs = FakeMO.all.find((o) => o.targets.some((x) => x.target === t.cards.host));
  assert.ok(hostObs, 'the host is observed');
  hostObs.cb([{ type: 'attributes', attributeName: 'style', target: t.cards.host }]);
  assert.equal(await p, false);
  assert.ok(FakeMO.all.every((o) => o.targets.length === 0), 'observers are disconnected');
});

test('redress: a new element in the page body that covers the button cancels, one that does not leaves the card alone', async () => {
  const t = make();
  const p = t.open('consent', { card: 'rooms' });
  const bodyObs = FakeMO.all.find((o) => o.targets.some((x) => x.target === t.w.doc.body));
  bodyObs.cb([{ type: 'childList', target: t.w.doc.body }]);
  assert.equal((await settled(p)).done, false, 'harmless insert');
  t.w.overlay = new FakeNode('div', t.w.doc);
  bodyObs.cb([{ type: 'childList', target: t.w.doc.body }]);
  assert.equal(await p, false);
});

test('checkElement: strict fails closed without layout APIs, non-strict skips them', () => {
  const doc = {};
  const b = { tagName: 'BUTTON', parentNode: null };
  assert.equal(checkElement(b, { win: {}, doc, strict: true }).ok, false);
  assert.equal(checkElement(b, { win: {}, doc, strict: false }).ok, true);
  assert.equal(checkElement(null, {}).ok, false);
  const g = createGuard({ win: {}, doc, button: b, strict: false, minVisibleMs: 0 }).start();
  assert.equal(g.check(), true);
});

test('sign-in: the button calls the injected signIn once, resolves with its result; other errors stay on the card', async () => {
  const calls = [];
  let fail = true;
  const t = make({ actions: { signIn: async (o) => { calls.push(o); if (fail) { const e = new Error('x'); e.code = 'E_RATE'; throw e; } return { state: 'signed-in' }; } } });
  const p = t.open('signin', { options: { stay: false } });
  t.tick(500);
  t.btn('Sign in').click();
  await flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { stay: false });
  assert.equal((await settled(p)).done, false);
  fail = false;
  t.btn('Sign in').click();
  assert.deepEqual(await p, { state: 'signed-in' });
  assert.equal(calls.length, 2);
});

test('sign-in: a window blocked even inside the click, or one that never answered, settles for "Continue in this tab"', async () => {
  for (const code of ['E_POPUP_BLOCKED', 'E_IDP_UNREACHABLE']) {
    const t = make({ actions: { signIn: async () => { const e = new Error('x'); e.code = code; throw e; } } });
    const p = t.open('signin', { options: {} });
    t.tick(500);
    t.btn('Sign in').click();
    assert.deepEqual(await p, { fallback: 'redirect', code });
  }
  // The continue-here card's button signs in with redirect: true inside the click; Cancel resolves false.
  const calls = [];
  const t = make({ actions: { signIn: (o) => { calls.push(o); return new Promise(() => {}); } } });
  t.open('continue-here', { options: { stay: false } });
  t.tick(500);
  t.btn('Continue in this tab').click();
  assert.deepEqual(calls, [{ stay: false, redirect: true }]);
  const u = make({ actions: { signIn: async () => true } });
  const q = u.open('continue-here', { options: {} });
  u.tick(500);
  u.btn('Cancel').click();
  assert.equal(await q, false);
});

test('sign-in: Cancel and E_USER_CANCELLED resolve false; a missing function shows E_UNSUPPORTED', async () => {
  const t = make({ actions: { signIn: async () => { const e = new Error('c'); e.code = 'E_USER_CANCELLED'; throw e; } } });
  const p = t.open('signin', {});
  t.tick(500);
  t.btn('Sign in').click();
  assert.equal(await p, false);
  const u = make();
  const q = u.open('signin', {});
  u.tick(500);
  u.btn('Sign in').click();
  assert.ok(texts(u.cards.host).includes('This browser cannot do this.'));
  u.btn('Cancel').click();
  assert.equal(await q, false);
});

test('storage-evicted shows the eviction sentence above Sign in; method openIdentity calls openIdentity', async () => {
  let opened = 0;
  const t = make({ actions: { openIdentity: async () => { opened++; return 'done'; } } });
  const p = t.open('storage-evicted', { method: 'openIdentity' });
  assert.ok(texts(t.cards.host).includes('This browser deleted your sign-in for this site. Tap Sign in to get it back.'));
  t.tick(500);
  t.btn('Sign in').click();
  assert.equal(await p, 'done');
  assert.equal(opened, 1);
});

test('tap-to-finish runs the supplied function inside the tap', async () => {
  let ran = 0;
  const t = make();
  const p = t.open('tap', { run: () => { ran++; return { ok: 1 }; } });
  t.tick(500);
  t.btn('Tap to finish').click();
  assert.deepEqual(await p, { ok: 1 });
  assert.equal(ran, 1);
});

test('consent cards: identity-origin-only cards and unknown cards are refused', async () => {
  const t = make();
  for (const card of ['signIn', 'twelveWords', 'sameIdentity', 'hubIdentity', 'staySignedIn', 'passkey', 'recoveryKitIos', 'nope', '']) {
    await assert.rejects(t.cards.prompt('consent', { card }), (e) => e.code === 'E_BAD_REQUEST', card);
  }
  assert.equal(t.cards.host, null, 'nothing was drawn');
  await assert.rejects(t.cards.prompt('mod.decide', { decision: 'maybe' }), (e) => e.code === 'E_BAD_REQUEST');
});

test('upload card: private and public texts, name and size; per-upload phone exception card', async () => {
  const t = make();
  const p = t.open('upload', SAMPLES.upload);
  const all = texts(t.cards.host);
  assert.ok(all.includes('Send this file privately?') && all.includes('a.jpg (2.00 KB, image/jpeg)'));
  assert.ok(all.includes('Encrypted before it leaves this device.'));
  t.tick(500);
  t.btn('Continue').click();
  assert.equal(await p, true);
  const u = make();
  u.open('upload', { visibility: 'public', name: 'b.png', size: 10, type: 'image/png' });
  assert.ok(texts(u.cards.host).includes('This file will be public on this site.'));
  assert.ok(!texts(u.cards.host).includes('was not checked for location'), 'a checked kind says nothing more');
  // Review round R 5.3 (PRIV-5; integrator): a kind no stripper reads says it was not checked.
  const w = make();
  w.open('upload', { visibility: 'public', name: 'c.heic', size: 10, type: 'image/heic', unchecked: true });
  assert.ok(texts(w.cards.host).includes('This kind of file was not checked for location or camera details. Photos, audio and video in formats that are not cleaned can carry them.'));
  const v = make();
  const q = v.open('phone-upload', { name: 'v.mp4' });
  assert.ok(texts(v.cards.host).includes('Sending this file uses your mobile data. Keep this page open and on screen until it says sent.'));
  v.tick(500);
  v.btn('Send now').click();
  assert.equal(await q, true);
});

test('offers are never auto-accepted: no timer, the Decline button has the focus, Accept needs a click', async () => {
  const t = make();
  const p = t.open('offer', SAMPLES.offer);
  assert.equal(t.btn('Decline').focused, true);
  t.tick(60 * 60 * 1000);
  assert.equal((await settled(p)).done, false);
  t.btn('Accept').click();
  assert.equal(await p, true);
  const u = make();
  const q = u.open('offer', { kind: 'media', from: 'Bo', name: 'p.jpg', size: 5, type: 'image' });
  assert.ok(texts(u.cards.host).includes('Bo wants to send you a photo or video'));
  u.tick(500);
  u.btn('Decline').click();
  assert.equal(await q, false);
});

test('moderator cards name the person and need a confirming click; Cancel resolves false', async () => {
  const t = make();
  const p = t.open('mod.ban', SAMPLES['mod.ban']);
  const all = texts(t.cards.host);
  assert.ok(all.includes('Ban Eve?') && all.includes('Eve (k3f9-2xq1) will no longer be able to write to this site.'));
  t.tick(500);
  t.btn('Cancel').click();
  assert.equal(await p, false);
  const u = make();
  const q = u.open('mod.tombstoneMany', SAMPLES['mod.tombstoneMany']);
  assert.ok(texts(u.cards.host).includes('Hide 2 people'));
  assert.ok(texts(u.cards.host).includes('hides posts by 2 people from copies that sync'));
  assert.ok(!/erase|delete everywhere/i.test(texts(u.cards.host)));
  u.tick(500);
  u.btn('Confirm').click();
  assert.equal(await q, true);
  const v = make();
  const r = v.open('mod.decide', SAMPLES['mod.decide']);
  assert.ok(texts(v.cards.host).includes('Deny this pin?'));
  v.tick(500);
  v.btn('Confirm').click();
  assert.equal(await r, true);
  const w = make();
  const s = w.open('mod.unban', SAMPLES['mod.unban']);
  w.tick(500);
  w.btn('Confirm').click();
  assert.equal(await s, true);
});

test('notices: owner changed, foreign address, error code text; two prompts are shown one at a time', async () => {
  const t = make();
  const a = t.open('owner-changed', { minutes: 7 });
  const b = t.open('foreign-address', {});
  assert.ok(texts(t.cards.host).includes('The owner of this site changed 7 minutes ago.'));
  assert.ok(!texts(t.cards.host).includes('This address is not one of this site\'s addresses.'), 'the second waits');
  t.tick(500);
  t.btn('OK').click();
  assert.equal(await a, true);
  assert.ok(texts(t.cards.host).includes('This address is not one of this site\'s addresses.'));
  t.tick(500);
  t.btn('OK').click();
  assert.equal(await b, true);
  assert.equal(t.cards.host.parentNode, null, 'the host leaves the page with its last card');
});

test('the signed-in header: identicon, name, short id, mode, unlock and backup; Sign out; Remove asks first', async () => {
  const t = make();
  const calls = [];
  t.cards.setIdentityHeader({ name: 'Ana', short: 'k3f9-2xq1', pub: 'p256:abc', mode: 'same', origin: 'a.example', unlock: 'passkey', backup: true }, { onSignOut: () => calls.push('out'), onRemove: () => calls.push('remove') });
  t.w.host = t.cards.host;
  const all = texts(t.cards.host);
  assert.ok(all.includes('Ana  k3f9-2xq1') && all.includes('Same as on a.example') && all.includes('Unlocked with a passkey / Backup saved'));
  assert.ok(t.cards.host.find((n) => n.getAttribute('role') === 'img'), 'identicon');
  t.tick(500);
  t.btn('Sign out').click();
  assert.deepEqual(calls, ['out']);
  t.btn('Remove from this device').click();
  await flush();
  assert.deepEqual(calls, ['out'], 'a confirmation comes first');
  assert.ok(texts(t.cards.host).includes('Remove from this device?'));
  t.tick(500);
  const confirm = t.cards.host.findAll((n) => n.tagName === 'BUTTON' && n.textContent === 'Remove from this device');
  confirm[confirm.length - 1].click();
  await flush();
  assert.deepEqual(calls, ['out', 'remove']);
  t.cards.setIdentityHeader(null);
  assert.equal(t.cards.host.parentNode, null);
  // private and hub modes, no backup
  const u = make();
  u.cards.setIdentityHeader({ name: '', short: 'zz', mode: 'hub', hub: 'hub.example', unlock: 'visit', backup: false }, {});
  assert.ok(texts(u.cards.host).includes('One identity on hub.example') && texts(u.cards.host).includes('This visit only / No backup yet'));
});

test('French cards and a language switch', async () => {
  const t = make({ lang: 'fr-CA' });
  t.open('owner-changed', { minutes: 3 });
  assert.ok(texts(t.cards.host).includes('Le propriétaire de ce site a changé il y a 3 minutes.'));
  assert.equal(t.cards.lang, 'fr');
  t.cards.lang = 'en';
  assert.equal(t.cards.lang, 'en');
  assert.equal(uiText('signInButton', 'fr'), 'Se connecter');
});
