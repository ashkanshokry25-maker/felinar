// The identity origin's cards (R 2.3.4, 2.3.5, 2.2.6; MF-03, MF-07, MF-11, MF-12): no phrase or backup-file
// field anywhere but the IdO bundle, the "same identity" pressure limits (offered at most once per origin per 30
// days, never preselected, a refusal remembered, a second deliberate press to confirm), the first approval of an
// origin needs user verification, and the recovery-kit timing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

import {
  createCards, sameIdentityOptions, recordSameOffer, approvalAllowed, kitDue, reentryPositions, registrableSplit, shortId, SAME_OFFER_INTERVAL_MS,
} from '../../src/idp/cards.js';
import { createIdp } from '../../src/idp/idp.js';
import { openIdoStore } from '../../src/idp/store.js';
import * as client from '../../src/identity/client.js';
import { FakeDocument } from './dropin-fake-dom.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const IDP = 'http://localhost:9555';
const DAY = 24 * 3600 * 1000;

function scriptedCards(script = {}) {
  const calls = [];
  const answer = (name, data) => {
    calls.push({ name, data });
    const s = script[name];
    if (typeof s === 'function') return s(data, calls);
    if (s !== undefined) return s;
    switch (name) {
      case 'signin': return { action: 'continue', mode: { kind: 'private' }, stay: false, sharedComputer: false, hub: null };
      case 'chooseUnlock': return { method: 'passkey', nickname: 'test' };
      case 'busy': case 'close': return undefined;
      default: return true;
    }
  };
  return new Proxy({ calls, lang: 'en' }, { get(t, k) { if (k in t) return t[k]; return async (data) => answer(k, data); } });
}

function fakePasskey() {
  const prf = webcrypto.getRandomValues(new Uint8Array(32));
  const pk = {
    uv: true,
    async capabilities() { return { webauthn: true, platform: true, prf: true }; },
    async create() { return { credId: 'Y3JlZA', prf, prfEnabled: true, uv: true }; },
    async prfFor({ created }) { return { prf: created.prf, uv: true, credId: created.credId }; },
    async get() { return { credId: 'Y3JlZA', prf, uv: pk.uv }; },
  };
  return pk;
}

async function signInAt(idp, origin) {
  const box = await client.newBoxKey();
  const requestId = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url');
  const res = await idp.handleRequest({ v: 1, t: 'mw-signin-req', requestId, purpose: 'site', want: ['keys'], epk: box.pub }, origin, null);
  if (!res.ok) return { res };
  return { res, K: await client.open(client.BUNDLE_PREFIX, box.privateKey, res.bundle, { origin, requestId }) };
}

function makeIdp({ cards, passkey, store, wasm = true }) {
  return createIdp({ win: null, doc: null, navigator: null, location: { origin: IDP }, cards, passkey, store, wasm, ios: false, standalone: false, build: { version: '0.3.0', id: 'test0001', hash: '', test: true } });
}

// ------------------------------------------------------------------------------------------------ policies

test('same identity is offered at most once per origin per 30 days, never for the origin itself, and a refusal is remembered', () => {
  const now = 1_700_000_000_000;
  const state = { origins: { 'https://a.example': { label: 'o|https://a.example', keyMode: 'pairwise' }, 'https://b.example': { label: 'o|https://b.example', keyMode: 'pairwise' } }, same: {} };
  const opts = sameIdentityOptions({ state, origin: 'https://b.example', now });
  assert.deepEqual(opts, [{ origin: 'https://a.example', label: 'o|https://a.example' }]);
  recordSameOffer(state, 'https://b.example', { now, outcome: 'shown' });
  assert.deepEqual(sameIdentityOptions({ state, origin: 'https://b.example', now: now + DAY }), [], 'not again inside 30 days');
  assert.equal(sameIdentityOptions({ state, origin: 'https://b.example', now: now + SAME_OFFER_INTERVAL_MS }).length, 1, 'after 30 days it may be offered again');
  recordSameOffer(state, 'https://b.example', { now: now + SAME_OFFER_INTERVAL_MS, outcome: 'refused' });
  assert.deepEqual(sameIdentityOptions({ state, origin: 'https://b.example', now: now + 400 * DAY }), [], 'a refusal is remembered');
  assert.deepEqual(sameIdentityOptions({ state: { origins: {} }, origin: 'https://b.example', now }), [], 'nothing to offer without another site');
  assert.equal(SAME_OFFER_INTERVAL_MS, 30 * DAY);
});

test('the first approval of an origin requires user verification; a returning origin does not ask again', () => {
  const state = { origins: { 'https://a.example': { label: 'o|https://a.example' } } };
  assert.deepEqual(approvalAllowed({ state, origin: 'https://new.example', uv: false }), { ok: false, first: true, code: 'E_UV_REQUIRED' });
  assert.deepEqual(approvalAllowed({ state, origin: 'https://new.example', uv: true }), { ok: true, first: true });
  assert.deepEqual(approvalAllowed({ state, origin: 'https://a.example', uv: false }), { ok: true, first: false });
});

test('recovery-kit timing: after the first meaningful action, and on iOS outside Home Screen every visit until saved', () => {
  assert.deepEqual(kitDue({ meaningful: false }), { show: false, ios: false, offerHomeScreen: false });
  assert.deepEqual(kitDue({ meaningful: true }), { show: true, ios: false, offerHomeScreen: false });
  // Code review v0.3 (browser): the identity page added to the Home Screen starts empty, so it is never offered.
  assert.deepEqual(kitDue({ ios: true, standalone: false, firstVisit: true }), { show: true, ios: true, offerHomeScreen: false });
  assert.deepEqual(kitDue({ ios: true, standalone: false, firstVisit: false }), { show: true, ios: true, offerHomeScreen: false }, 'every visit');
  assert.deepEqual(kitDue({ ios: true, standalone: true, firstVisit: true }), { show: false, ios: false, offerHomeScreen: false }, 'Home Screen apps keep their data');
  assert.deepEqual(kitDue({ ios: true, kitSaved: true, meaningful: true }), { show: false, ios: false, offerHomeScreen: false });
});

test('helpers: re-entry positions, the registrable part shown in bold, short ids', () => {
  for (let i = 0; i < 50; i++) {
    const p = reentryPositions();
    assert.equal(p.length, 3);
    assert.equal(new Set(p).size, 3);
    assert.ok(p.every((n) => n >= 1 && n <= 12));
    assert.deepEqual(p, p.slice().sort((a, b) => a - b));
  }
  assert.deepEqual(registrableSplit('shop.example'), { sub: '', reg: 'shop.example' });
  assert.deepEqual(registrableSplit('www.shop.example'), { sub: 'www.', reg: 'shop.example' });
  assert.deepEqual(registrableSplit('a.shop.co.uk'), { sub: 'a.', reg: 'shop.co.uk' });
  assert.deepEqual(registrableSplit('ana.github.io'), { sub: '', reg: 'ana.github.io' });
  assert.deepEqual(registrableSplit('localhost:8080'), { sub: '', reg: 'localhost:8080' });
  assert.match(shortId('p256:x'), /^[a-z2-9]{4}-[a-z2-9]{4}$/);
});

// ------------------------------------------------------------------------------------------------ the IdO flow

test('in the IdO flow: a first approval without the UV flag gives nothing; the origin is not remembered', async () => {
  const store = await openIdoStore({ memory: true });
  const passkey = fakePasskey();
  const idp = makeIdp({ cards: scriptedCards(), passkey, store });
  const a = await signInAt(idp, 'https://a.example');
  assert.equal(a.res.ok, true);
  passkey.uv = false; // an assertion without user verification (UP only)
  const idp2 = makeIdp({ cards: scriptedCards(), passkey, store });
  const b = await signInAt(idp2, 'https://b.example');
  assert.equal(b.res.ok, false);
  assert.equal(b.res.code, 'E_USER_CANCELLED', 'the site learns only that it did not happen');
  assert.equal(b.res.bundle, undefined);
  assert.equal((await store.getState()).origins['https://b.example'], undefined);
  const idp3 = makeIdp({ cards: scriptedCards(), passkey, store });
  const again = await signInAt(idp3, 'https://a.example');
  assert.equal(again.res.ok, true, 'a returning origin is not a first approval');
  assert.equal(again.K.pub, a.K.pub);
});

test('in the IdO flow: "same identity" is never preselected, needs the confirm card, links once, and a refusal sticks', async () => {
  const store = await openIdoStore({ memory: true });
  const passkey = fakePasskey();
  const a = await signInAt(makeIdp({ cards: scriptedCards(), passkey, store }), 'https://a.example');
  // The card for b lists a as an option, with Private as the mode the card starts on.
  const cards1 = scriptedCards({ signin: { action: 'continue', mode: { kind: 'same', origin: 'https://a.example' }, stay: false, sharedComputer: false, hub: null }, confirmSame: false });
  const refused = await signInAt(makeIdp({ cards: cards1, passkey, store }), 'https://b.example');
  const card1 = cards1.calls.find((c) => c.name === 'signin').data;
  assert.deepEqual(card1.sameOptions, [{ origin: 'https://a.example', label: 'o|https://a.example' }]);
  assert.ok(cards1.calls.some((c) => c.name === 'confirmSame'), 'the link needs its own confirm card');
  assert.equal(refused.K.keyMode, 'pairwise', 'Back on the confirm card keeps the site private');
  assert.notEqual(refused.K.pub, a.K.pub);
  const cards2 = scriptedCards();
  await signInAt(makeIdp({ cards: cards2, passkey, store }), 'https://b.example');
  assert.deepEqual(cards2.calls.find((c) => c.name === 'signin').data.sameOptions, [], 'a refusal is remembered');
  // Another site, confirmed: one key for both, recorded locally only.
  const cards3 = scriptedCards({ signin: { action: 'continue', mode: { kind: 'same', origin: 'https://a.example' }, stay: false, sharedComputer: false, hub: null }, confirmSame: true });
  const linked = await signInAt(makeIdp({ cards: cards3, passkey, store }), 'https://c.example');
  assert.equal(linked.K.keyMode, 'linked');
  assert.equal(linked.K.pub, a.K.pub);
  const st = await store.getState();
  assert.equal(st.origins['https://c.example'].linkedTo, 'https://a.example');
  // Settings: "Stop using the same identity here" works for the future.
  const idp = makeIdp({ cards: scriptedCards(), passkey, store });
  await idp.stopSame('https://c.example');
  const after = await signInAt(makeIdp({ cards: scriptedCards(), passkey, store }), 'https://c.example');
  assert.equal(after.K.keyMode, 'pairwise');
  assert.notEqual(after.K.pub, a.K.pub);
});

// ------------------------------------------------------------------------------------------------ the DOM

function cardsIn(doc, opts = {}) {
  let t = 1000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const cards = createCards(Object.assign({ doc, win: null, lang: 'en', build: { version: '0.3.0', id: 'abc123', hash: 'f'.repeat(64), test: false }, now: clock.now, minPressMs: 0, secondPressMs: 500, idp: IDP }, opts));
  return { cards, clock };
}

const inputs = (root) => root.findAll((n) => n.tagName === 'INPUT' || n.tagName === 'TEXTAREA');

test('the sign-in card: origin from the browser, statement verbatim, first-visit line, no secret field, stay off by default', async () => {
  const doc = new FakeDocument();
  const { cards } = cardsIn(doc);
  const p = cards.signin({
    origin: 'https://www.shop.example', pub: null, first: true, notListed: false, statement: 'Sign in to Example Shop. Nonce 9f2c', purpose: 'server',
    sameOptions: [{ origin: 'https://a.example', label: 'o|https://a.example' }], hub: null, shared: false, unlock: 'passkey', hasIdentity: true,
  });
  const root = cards.root;
  const text = root.textContent;
  assert.ok(text.includes('Sign in to'));
  assert.ok(text.includes('shop.example'));
  assert.ok(text.includes('"Sign in to Example Shop. Nonce 9f2c"'), 'the statement verbatim');
  assert.ok(text.includes('First time you sign in here.'));
  assert.ok(text.includes('This site gets a key that works only here.'));
  assert.ok(text.includes('Build 0.3.0 abc123'));
  const select = root.find((n) => n.tagName === 'SELECT');
  assert.equal(select.value, 'private', 'Private to this site is the default');
  for (const i of inputs(root)) {
    assert.equal(i.getAttribute('type'), 'checkbox', 'only checkboxes on the sign-in card');
    assert.equal(i.checked, false, 'stay signed in and shared computer start off');
    assert.equal(i.getAttribute('data-mw-phrase'), null);
  }
  root.buttonByText('Continue with passkey').click();
  const r = await p;
  assert.deepEqual(r, { action: 'continue', mode: { kind: 'private' }, stay: false, sharedComputer: false, hub: null });
});

test('buttons take only the person\'s own press: untrusted events and presses right after the card appeared are ignored', async () => {
  const doc = new FakeDocument();
  const { cards, clock } = cardsIn(doc, { minPressMs: 400 });
  const p = cards.recordRead({ origin: 'https://shop.example' });
  const allow = cards.root.buttonByText('Allow');
  allow.dispatchEvent({ type: 'click', isTrusted: false });
  allow.click(); // inside the first 400 ms
  let settled = false;
  p.then(() => { settled = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false);
  clock.advance(401);
  allow.click();
  assert.equal(await p, true);
});

test('the same-identity confirm needs a second, deliberate press; Back is the default', async () => {
  const doc = new FakeDocument();
  const { cards, clock } = cardsIn(doc);
  const p = cards.confirmSame({ a: 'https://forum.example', b: 'https://shop.example' });
  const text = cards.root.textContent;
  // Review round PHISH-3: the confirm card says that the other site's key is handed over and what that allows.
  assert.ok(text.includes('forum.example will receive the key you use on shop.example. It can sign in as you on shop.example and read your private data there'), text);
  const yes = cards.root.buttonByText('Yes, use the same identity');
  yes.click();
  let done = false;
  p.then(() => { done = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false, 'a press in the first moments does not count');
  clock.advance(600);
  yes.click();
  assert.equal(await p, true);
  const p2 = cards.confirmSame({ a: 'https://forum.example', b: 'https://shop.example' });
  const back = cards.root.buttonByText('Back');
  assert.ok(back.getAttribute('class').includes('mw-primary'), 'Back is the primary choice');
  back.click();
  assert.equal(await p2, false);
});

test('phrase and backup-file fields exist only in the IdO restore and re-entry cards', async () => {
  const doc = new FakeDocument();
  const { cards } = cardsIn(doc);
  const p = cards.restore({});
  const fields = inputs(cards.root);
  assert.ok(fields.some((n) => n.getAttribute('data-mw-phrase') === '1'), 'phrase field');
  assert.ok(fields.some((n) => n.getAttribute('data-mw-backup-file') === '1' && n.getAttribute('type') === 'file'), 'backup file field');
  assert.ok(cards.root.textContent.includes('felinar never asks for your 12 words on the site you are signing in to.'));
  fields.find((n) => n.getAttribute('data-mw-phrase') === '1').value = 'abandon ability';
  cards.root.buttonByText('From my 12 words').click();
  assert.deepEqual(await p, { kind: 'phrase', words: 'abandon ability', extra: '' });
  const words = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'];
  const q = cards.reentry({ words, positions: [2, 5, 11] });
  const boxes = inputs(cards.root);
  assert.equal(boxes.length, 3);
  boxes[0].value = 'ability'; boxes[1].value = 'above'; boxes[2].value = 'WRONG';
  cards.root.buttonByText('Continue').click();
  assert.ok(cards.root.textContent.includes('That word is not the one at this position.'));
  boxes[2].value = 'access';
  cards.root.buttonByText('Continue').click();
  assert.equal(await q, true);
});

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(m?js)$/.test(name)) out.push(p);
  }
  return out;
}

test('no site-origin module has a phrase or backup-file field, and none imports the identity origin bundle (MF-03, E-ID-10)', () => {
  const siteDirs = ['src/loader', 'src/dropin', 'src/widget', 'src/sdk', 'src/sw', 'src/chat', 'src/files', 'src/media'].map((d) => join(ROOT, d));
  const siteFiles = siteDirs.flatMap((d) => walk(d)).concat(['client.js', 'store.js', 'migrate.js', 'service.js'].map((f) => join(ROOT, 'src/identity', f)));
  for (const file of siteFiles) {
    const src = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file);
    assert.ok(!/data-mw-phrase|data-mw-backup-file/.test(src), rel + ' renders a phrase or backup-file field');
    // psl.js (the suffix list) and strings.js are plain data a site page may share; the modules that unlock,
    // hold or show secrets never load on a site origin.
    const imports = Array.from(src.matchAll(/(?:from\s+|import\()\s*['"]([^'"]+)['"]/g)).map((m) => m[1]).filter((spec) => /(^|\/)idp\//.test(spec));
    for (const spec of imports) assert.ok(/\/idp\/(psl|strings)\.js$/.test(spec), rel + ' imports ' + spec);
  }
  // The IdO bundle is where those fields live.
  const cardsSrc = readFileSync(join(ROOT, 'src/idp/cards.js'), 'utf8');
  assert.ok(cardsSrc.includes("'data-mw-phrase': '1'") && cardsSrc.includes("'data-mw-backup-file': '1'"));
});

// ------------------------------------------------------------------------------------------------ restore

test('restore from the 12 words: the same public key on a site, not the vault (old messages need the backup file)', async () => {
  const { rootToPhrase } = await import('../../src/identity/derive.js');
  const { b64url } = await import('../../src/chain/canonical.js');
  const store = await openIdoStore({ memory: true });
  const first = makeIdp({ cards: scriptedCards(), passkey: fakePasskey(), store });
  const a = await signInAt(first, 'https://a.example');
  const words = rootToPhrase(b64url.decode(first.session.vault.data.root));
  // A new device: the sign-in card offers "Restore an identity"; a first "no" at the check code goes back.
  let restores = 0;
  let checks = 0;
  const cards = scriptedCards({
    signin: (data, calls) => (calls.filter((c) => c.name === 'signin').length === 1 ? { action: 'restore', mode: { kind: 'private' } } : { action: 'continue', mode: { kind: 'private' }, stay: false, sharedComputer: false, hub: null }),
    restore: () => { restores++; return { kind: 'phrase', words: words.join(' '), extra: '' }; },
    checkCode: () => { checks++; return checks > 1; },
  });
  const fresh = await openIdoStore({ memory: true });
  const b = await signInAt(makeIdp({ cards, passkey: fakePasskey(), store: fresh }), 'https://a.example');
  assert.equal(restores, 2, 'Check the words: back to the restore card');
  assert.equal(b.res.ok, true);
  assert.equal(b.K.pub, a.K.pub, 'the public identity is back');
  assert.notEqual(b.K.chat.pub, a.K.chat.pub, 'random keys are not in the phrase');
  assert.notEqual(b.K.rec.key, a.K.rec.key);
  assert.ok((await fresh.getState()).restored, 'the next sign-ins ask "Found N posts?"');
  const signinData = cards.calls.find((c) => c.name === 'signin').data;
  assert.equal(signinData.hasIdentity, false, 'the card offered restore and link because this device has none');
});

test('restore from the backup file: everything comes back, the vault included', async () => {
  const store = await openIdoStore({ memory: true });
  const passkey = fakePasskey();
  const first = makeIdp({ cards: scriptedCards({ backupFile: (data) => ({ pass: data.generated }) }), passkey, store });
  const a = await signInAt(first, 'https://a.example');
  let generated = null;
  const backupCards = scriptedCards({ backupFile: (data) => { generated = data.generated; return { pass: data.generated }; } });
  // Without WebAssembly the file is stretched with PBKDF2 (named in it); Argon2id is covered by the idcore tests.
  // The file is counted as saved only after "I saved the file" (code review v0.3, browser): Later leaves it unsaved.
  const later = makeIdp({ cards: scriptedCards({ backupFile: (data) => ({ pass: data.generated }), saveBackup: 'later' }), passkey, store, wasm: false });
  assert.ok(await later.makeBackup());
  assert.equal((await store.getState()).backup.fileSaved, false, 'no confirmation, not saved');
  backupCards.calls.length = 0;
  const confirmCards = scriptedCards({ backupFile: (data) => { generated = data.generated; return { pass: data.generated }; }, saveBackup: 'saved' });
  const maker = makeIdp({ cards: confirmCards, passkey, store, wasm: false });
  const text = await maker.makeBackup();
  assert.ok(confirmCards.calls.some((c) => c.name === 'saveBackup' && c.data.text === text), 'the save card holds the file');
  assert.match(generated, /^[a-z]+(-[a-z]+){5}$/, 'a generated 6-word passphrase');
  const file = JSON.parse(text);
  assert.equal(file.type, 'mw-identity');
  assert.equal(file.v, 3);
  assert.equal(file.kdf, 'pbkdf2-sha256');
  assert.ok(!text.includes(a.K.chat.d), 'the file is encrypted');
  assert.equal((await store.getState()).backup.fileSaved, true);
  const cards = scriptedCards({
    signin: (data, calls) => (calls.filter((c) => c.name === 'signin').length === 1 ? { action: 'restore', mode: { kind: 'private' } } : { action: 'continue', mode: { kind: 'private' }, stay: false, sharedComputer: false, hub: null }),
    restore: () => ({ kind: 'file', text, pass: generated }),
  });
  const b = await signInAt(makeIdp({ cards, passkey: fakePasskey(), store: await openIdoStore({ memory: true }) }), 'https://a.example');
  assert.equal(b.K.pub, a.K.pub);
  assert.equal(b.K.chat.pub, a.K.chat.pub, 'the vault came back with the file');
  assert.equal(b.K.rec.key, a.K.rec.key);
});

test('iOS outside Home Screen: the recovery kit follows every sign-in until saved, after the site has its answer', async () => {
  const store = await openIdoStore({ memory: true });
  const passkey = fakePasskey();
  const opener = { posts: [], postMessage(msg, target) { opener.posts.push({ msg, target, kitShownBefore: kitCalls.length > 0 }); } };
  const kitCalls = [];
  const listeners = new Set();
  const win = { opener, location: { origin: IDP, hash: '', pathname: '/signin' }, closed: false, addEventListener: (t, f) => listeners.add(f), removeEventListener: (t, f) => listeners.delete(f), close() { win.closed = true; } };
  const words = [];
  const cards = scriptedCards({
    recoveryKit: (data) => { kitCalls.push(data); return 'saved'; },
    showPhrase: (data) => { words.push(...data.words); return true; },
    reentry: (data) => data.positions.every((n) => n >= 1 && n <= 12),
  });
  const idp = createIdp({ win, doc: null, navigator: null, location: win.location, cards, passkey, store, wasm: true, ios: true, standalone: false, build: { version: '0.3.0', id: 'test0001', hash: '', test: true } });
  const done = idp.bootSignin();
  await new Promise((r) => setImmediate(r));
  const box = await client.newBoxKey();
  const requestId = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url');
  for (const fn of Array.from(listeners)) fn({ source: opener, origin: 'https://a.example', data: { v: 1, t: 'mw-signin-req', requestId, purpose: 'site', want: ['keys'], epk: box.pub } });
  await done;
  const answer = opener.posts.find((p) => p.msg.t === 'mw-signin-res');
  assert.equal(answer.msg.ok, true);
  assert.equal(answer.kitShownBefore, false, 'the site had its answer before the kit appeared');
  assert.equal(kitCalls.length, 1);
  assert.equal(kitCalls[0].ios, true);
  assert.equal(kitCalls[0].offerHomeScreen, undefined, 'no Home Screen step for the identity page (it would start empty)');
  assert.equal(kitCalls[0].escrow, true, 'a passkey identity: the sites keep a sealed copy');
  assert.equal(words.length, 12, 'the 12 words, then the 3-word re-entry check');
  assert.equal((await store.getState()).backup.kitSaved, true);
  assert.equal(win.closed, true);
});

test('every card renders in English and French (no missing string), and none puts a site value into markup', async () => {
  const { STRINGS } = await import('../../src/idp/strings.js');
  assert.deepEqual(Object.keys(STRINGS.fr).sort(), Object.keys(STRINGS.en).sort(), 'French has every English key');
  for (const lang of ['en', 'fr']) {
    const doc = new FakeDocument();
    const { cards } = cardsIn(doc, { lang });
    const evil = '<img src=x onerror=alert(1)>';
    const renders = [
      () => cards.signin({ origin: 'https://shop.example', pub: 'p256:x', first: true, notListed: true, statement: evil, purpose: 'server', sameOptions: [], linkedTo: null, hub: { suffix: 'github.io', decided: false, on: false, defaultOn: true }, shared: false, create: true, owner: { what: 'policy' }, unlock: 'new', hasIdentity: false }),
      () => cards.signin({ origin: 'https://shop.example', shared: true, unlock: 'visit', hasIdentity: true, first: true }),
      () => cards.signin({ origin: 'https://shop.example', linkedTo: 'https://a.example', unlock: 'passphrase', hasIdentity: true }),
      () => cards.confirmSame({ a: 'https://a.example', b: 'https://b.example' }),
      () => cards.chooseUnlock({ prf: null, wasm: true }),
      () => cards.chooseUnlock({ prf: false, wasm: false }),
      () => cards.passphrase({ mode: 'create', kdf: 'pbkdf2-sha256', error: 'x' }),
      () => cards.showPhrase({ words: new Array(12).fill('abandon'), checkCode: 'abcd2345' }),
      () => cards.reentry({ words: new Array(12).fill('abandon'), positions: [1, 2, 3] }),
      () => cards.restore({ error: 'x' }),
      () => cards.checkCode({ code: 'abcd2345' }),
      () => cards.foundPosts({ n: 0, site: 'https://a.example' }),
      () => cards.foundPosts({ n: 1, site: 'https://a.example' }),
      () => cards.foundPosts({ n: 14, site: 'https://a.example' }),
      () => cards.recoveryKit({ ios: true, offerHomeScreen: true, checkCode: 'abcd2345' }),
      () => cards.backupFile({ generated: 'a-b-c-d-e-f' }),
      () => cards.createPage({ hub: 'github.io' }),
      () => cards.ownerAction({ origin: 'https://a.example', what: 'withdraw' }),
      () => cards.recordRead({ origin: 'https://a.example' }),
      () => cards.erase({ origin: 'https://a.example' }),
      () => cards.legacy({ name: evil }),
      () => cards.replaceKeys(),
      () => cards.removeDevice(),
      () => cards.message({ text: 'x' }),
      () => cards.error({ code: 'E_UV_REQUIRED' }),
      () => cards.showCodes({ title: 't', lines: ['l'], codes: ['mwlink:2:a:' + 'A'.repeat(87)], sas: '123456', buttons: [{ text: 'ok', value: true }] }),
      () => cards.scanCode({ title: 't', lines: ['l'] }),
      () => { cards.busy(); return null; },
      () => { cards.settings({ hasIdentity: true, unlock: 'passkey', backup: { kitSaved: true, fileSaved: false }, checkCode: 'abcd2345', links: [{ origin: 'https://c.example', with: 'https://a.example' }], hubs: [{ suffix: 'github.io', on: true }], sites: ['https://a.example'] }, {}); return null; },
      () => { cards.settings({ hasIdentity: false }, {}); return null; },
    ];
    for (const render of renders) {
      assert.doesNotThrow(render, lang);
      const text = cards.root.textContent;
      assert.ok(text.length > 0, lang);
      assert.ok(!/\{[a-z]+\}/.test(text), lang + ': an unfilled placeholder in ' + text.slice(0, 80));
      // Site-supplied strings are text nodes only: no element is ever made from them.
      assert.equal(cards.root.findAll((n) => n.tagName === 'IMG').length, 0);
    }
    cards.close();
  }
});
