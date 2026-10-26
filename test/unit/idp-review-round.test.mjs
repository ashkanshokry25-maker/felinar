// Review round of 2026-10-24 (identity fixer): regression tests for the confirmed findings of the v0.3 design review round
// (.orchestration/reports/all-findings-2026-10-22.json) in src/idp, src/identity, src/dropin and packages/verify. Each test
// names its finding; the record is docs/deviations/review-round-identity.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { createIdp } from '../../src/idp/idp.js';
import { createCards } from '../../src/idp/cards.js';
import { openIdoStore, vaultIdOf } from '../../src/idp/store.js';
import { LinkNewDevice, LinkOldDevice, MAX_PARTS } from '../../src/idp/link.js';
import * as client from '../../src/identity/client.js';
import { Vault, padBucket, VAULT_PAD_MIN } from '../../src/identity/vault.js';
import { phraseToRoot, rootToPhrase, rootStar, checkCode, newRoot } from '../../src/identity/derive.js';
import { b64url } from '../../src/chain/canonical.js';
import { countPostsBy } from '../../src/dropin/identity.js';
import { MemoryNonceStore, statelessNonce } from '../../packages/verify/verify.js';
import { FakeDocument } from './dropin-fake-dom.mjs';

const IDP = 'http://localhost:9555';

function scriptedCards(script = {}) {
  const calls = [];
  const answer = (name, data, more) => {
    calls.push({ name, data, more });
    const s = script[name];
    if (typeof s === 'function') return s(data, calls, more);
    if (s !== undefined) return s;
    switch (name) {
      case 'signin': return { action: 'continue', mode: { kind: 'private' }, stay: false, sharedComputer: false, hub: null };
      case 'chooseUnlock': return { method: 'passkey', nickname: 'test' };
      case 'foundPosts': return 'continue';
      case 'busy': case 'close': case 'progress': return undefined;
      default: return true;
    }
  };
  return new Proxy({ calls, lang: 'en' }, { get(t, k) { if (k in t) return t[k]; return async (data, more) => answer(k, data, more); } });
}

function fakePasskey() {
  const prf = webcrypto.getRandomValues(new Uint8Array(32));
  const pk = {
    gets: [],
    async capabilities() { return { webauthn: true, platform: true, prf: true }; },
    async create() { return { credId: 'Y3JlZA', prf, prfEnabled: true, uv: true }; },
    async get(o) { pk.gets.push(o && o.credId); return { credId: 'Y3JlZA', prf, uv: true }; },
  };
  return pk;
}

function makeIdp({ cards = scriptedCards(), passkey = fakePasskey(), store, win = null, location = { origin: IDP }, extra = {} } = {}) {
  return createIdp(Object.assign({ win, doc: null, navigator: null, location, cards, passkey, store, wasm: true, ios: false, standalone: false, build: { version: '0.3.0', id: 'test0001', hash: '', test: true } }, extra));
}

async function request({ want = ['keys'], purpose = 'site', extra = {} } = {}) {
  const box = await client.newBoxKey();
  const requestId = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url');
  return { box, req: Object.assign({ v: 1, t: 'mw-signin-req', requestId, purpose, want, epk: box.pub }, extra) };
}

async function signInAt(idp, origin, { extra = {}, channel = null, transport } = {}) {
  const { box, req } = await request({ extra });
  const res = await idp.handleRequest(req, origin, channel, transport ? { transport } : undefined);
  if (!res.ok) return { res };
  return { res, K: await client.open(client.BUNDLE_PREFIX, box.privateKey, res.bundle, { origin, requestId: req.requestId }) };
}

// ------------------------------------------------------------------------------------------- SEC-1, STALK-1, PHISH-2

test('SEC-1, STALK-1, PHISH-2: no escrow value is the same for two sites, the vault copies have one length, and one site\'s copy restores', async () => {
  const store = await openIdoStore({ memory: true });
  const passkey = fakePasskey();
  const idp = makeIdp({ store, passkey });
  const sites = ['https://a.example', 'https://b.example', 'https://c.example'];
  const got = [];
  for (const o of sites) got.push((await signInAt(idp, o)).K);
  for (const K of got) {
    assert.equal(K.escrow.kind, 'prf');
    assert.equal(K.escrow.credId, undefined, 'no passkey id in a site\'s copy');
    assert.ok(K.vaultEscrow && typeof K.vaultEscrow.id === 'string');
  }
  for (let i = 0; i < got.length; i++) {
    for (let j = i + 1; j < got.length; j++) {
      const a = got[i];
      const b = got[j];
      for (const f of ['iv', 'ct']) assert.notEqual(a.escrow[f], b.escrow[f], 'root ' + f);
      for (const f of ['id', 'iv', 'ct']) assert.notEqual(a.vaultEscrow[f], b.vaultEscrow[f], 'vault ' + f);
      assert.notEqual(a.vaultEscrow.ct.slice(0, 64), b.vaultEscrow.ct.slice(0, 64));
    }
  }
  assert.ok(got.every((K) => K.vaultEscrow.ct.length === got[0].vaultEscrow.ct.length), 'the copy length does not count the sites');
  assert.notEqual(got[0].vaultEscrow.id, await vaultIdOf(idp.session.secrets.rootStar), 'not the identity\'s vault id');
  // The identity origin loses its storage (Safari's 7-day rule): c.example's copy alone brings everything back.
  const empty = await openIdoStore({ memory: true });
  const idp2 = makeIdp({ store: empty, passkey });
  const back = (await signInAt(idp2, 'https://a.example', { extra: { escrow: { root: got[2].escrow, vault: got[2].vaultEscrow } } })).K;
  assert.equal(back.pub, got[0].pub, 'the same key at a.example');
  assert.equal(back.chat.d, got[0].chat.d, 'the random chat key came back from the vault copy');
  assert.equal(passkey.gets[passkey.gets.length - 1], undefined, 'a discoverable passkey call (no credId in the copy)');
  assert.equal(padBucket(10), VAULT_PAD_MIN);
  assert.equal(padBucket(VAULT_PAD_MIN + 1), VAULT_PAD_MIN * 2);
});

// ------------------------------------------------------------------------------------------- SEC-2, PHISH-9

test('SEC-2, PHISH-9: a redirect request may not erase, prove or act as owner, and nothing it does is remembered for the named origin', async () => {
  const store = await openIdoStore({ memory: true });
  const cards = scriptedCards();
  const idp = makeIdp({ store, cards });
  const BANK = 'https://bank.example';
  for (const extra of [{ want: ['erase'] }, { want: ['keys'], extra: { owner: { what: 'policy' } } }, { want: ['keys'], extra: { create: true } }]) {
    const { req } = await request(extra);
    const res = await idp.handleRequest(req, BANK, null, { transport: 'redirect' });
    assert.deepEqual([res.ok, res.code], [false, 'E_BAD_REQUEST'], JSON.stringify(extra));
  }
  assert.ok(!cards.calls.some((c) => c.name === 'erase' || c.name === 'signin'), 'no card for a refused redirect');
  const proofReq = { v: 1, t: 'mw-signin-req', requestId: Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url'), purpose: 'server', want: ['proof'], challenge: { nonce: 'A'.repeat(22) } };
  assert.equal((await idp.handleRequest(proofReq, BANK, null, { transport: 'redirect' })).code, 'E_BAD_REQUEST');
  assert.equal(client.validateRequest(Object.assign({}, proofReq, { origin: BANK, ret: BANK + '/_mw/idp-return' }), { transport: 'redirect' }).ok, false);
  // A key sign-in by redirect: the card says the origin is unconfirmed and shows no identity; no approval, no rotation delivery.
  await signInAt(idp, 'https://forum.example');
  await idp.replaceAllKeys();
  const r1 = await signInAt(idp, BANK, { transport: 'redirect' });
  assert.equal(r1.res.ok, true);
  const card = cards.calls.filter((c) => c.name === 'signin').pop().data;
  assert.equal(card.unverified, true);
  assert.equal(card.pub, null);
  assert.deepEqual(card.sameOptions, []);
  assert.equal((await store.getState()).origins[BANK], undefined, 'no approval recorded for a claimed origin');
  const { K: viaRedirect } = await signInAt(idp, 'https://forum.example', { transport: 'redirect' });
  assert.ok(viaRedirect.rotateNotice, 'the notice is given');
  const { K: viaPopup } = await signInAt(idp, 'https://forum.example');
  assert.ok(viaPopup.rotateNotice, 'and given again, because a redirect answer may never have reached the site');
  const { K: again } = await signInAt(idp, 'https://forum.example');
  assert.equal(again.rotateNotice, undefined, 'a popup delivery counts');
});

// ------------------------------------------------------------------------------------------- SEC-3, PHISH-4, UX-4

test('SEC-3, PHISH-4: a restore on a device with an identity needs that identity unlocked; the same words keep the vault; a site-opened #restore is refused', async () => {
  const store = await openIdoStore({ memory: true });
  const passkey = fakePasskey();
  const idp = makeIdp({ store, passkey });
  const { K } = await signInAt(idp, 'https://a.example');
  const words = rootToPhrase(b64url.decode(idp.session.vault.data.root));
  const code = (await store.getState()).checkCode;
  const vaultBefore = JSON.stringify(await store.getVault());
  // Opened by a site (window.opener set): no restore card at all.
  const c1 = scriptedCards();
  const win = { opener: {}, location: { origin: IDP, hash: '#restore' } };
  const homeIdp = makeIdp({ store, passkey, cards: c1, win, location: win.location });
  await homeIdp.bootHome();
  assert.ok(!c1.calls.some((c) => c.name === 'restore' || c.name === 'replaceIdentity'), 'refused');
  assert.ok(c1.calls.some((c) => c.name === 'message' && /open http:\/\/localhost:9555 yourself/.test(c.data.text)), 'the card says to open the identity page yourself');
  // Declining the replace card changes nothing.
  const c2 = scriptedCards({ replaceIdentity: false });
  await assert.rejects(makeIdp({ store, passkey, cards: c2 }).runRestore(), (e) => e.code === 'E_USER_CANCELLED');
  assert.equal(c2.calls.find((c) => c.name === 'replaceIdentity').data.code, code, 'the card names the current check code');
  assert.ok(!c2.calls.some((c) => c.name === 'restore'));
  // The same 12 words again: nothing replaced (the vault, its chat and record keys, stay).
  const gets = passkey.gets.length;
  const c3 = scriptedCards({ restore: { kind: 'phrase', words: words.join(' '), extra: '' } });
  await makeIdp({ store, passkey, cards: c3 }).runRestore();
  assert.ok(passkey.gets.length > gets, 'the current identity was unlocked first');
  assert.ok(c3.calls.some((c) => c.name === 'message' && /already on this device/.test(c.data.text)));
  assert.equal(JSON.stringify(await store.getVault()), vaultBefore, 'the stored vault is untouched');
  // Other words: the check code card shows both codes before anything is replaced.
  const other = rootToPhrase(newRoot());
  let n = 0;
  const c4b = scriptedCards({ restore: () => (n++ === 0 ? { kind: 'phrase', words: other.join(' '), extra: '' } : null), checkCode: false });
  await assert.rejects(makeIdp({ store, passkey, cards: c4b }).runRestore(), (e) => e.code === 'E_USER_CANCELLED');
  const shown = c4b.calls.find((c) => c.name === 'checkCode').data;
  assert.equal(shown.replaces, code);
  assert.notEqual(shown.code, code);
  const second = c4b.calls.filter((c) => c.name === 'restore')[1].data;
  assert.equal(second.words, other.join(' '), 'the words stay in the box after "check the words"');
  assert.match(second.error, /check code did not match/);
  assert.equal(JSON.stringify(await store.getVault()), vaultBefore);
  void K;
});

test('UX-4: a refused phrase keeps the typed words and names the word or the count; list numbers and commas are read as the words alone', async () => {
  const root = newRoot();
  const words = rootToPhrase(root);
  const numbered = words.map((w, i) => (i + 1) + '. ' + w + ',').join(' ');
  assert.deepEqual(phraseToRoot(numbered), root);
  const bad = words.slice();
  bad[6] = 'abandom';
  const answers = [{ kind: 'phrase', words: bad.join(' '), extra: '' }, { kind: 'phrase', words: words.slice(0, 11).join(' '), extra: '' }, null];
  const cards = scriptedCards({ restore: () => answers.shift() });
  await assert.rejects(makeIdp({ store: await openIdoStore({ memory: true }), cards }).runRestore(), (e) => e.code === 'E_USER_CANCELLED');
  const shown = cards.calls.filter((c) => c.name === 'restore').map((c) => c.data);
  assert.equal(shown[1].error, 'Word 7 is not in the word list. Check its spelling.');
  assert.equal(shown[1].words, bad.join(' '));
  assert.equal(shown[2].error, 'You typed 11 words. The phrase has 12.');
  // The card puts the words back in the box.
  const doc = new FakeDocument();
  const ui = createCards({ doc, win: null, lang: 'en', build: { version: '0.3.0', id: 'x', hash: '', test: false }, now: () => 1, minPressMs: 0, idp: IDP });
  ui.restore({ error: 'Word 7 is not in the word list. Check its spelling.', words: bad.join(' ') });
  const area = ui.root.find((x) => x.tagName === 'TEXTAREA');
  assert.equal(area.value, bad.join(' '));
});

// ------------------------------------------------------------------------------------------- UX-5

test('UX-5: "Check the words" after a restore that found no posts takes the restored identity off and offers the restore again; Continue is the main button', async () => {
  const store = await openIdoStore({ memory: true });
  const words = rootToPhrase(newRoot());
  let signins = 0;
  const cards = scriptedCards({
    signin: () => {
      signins++;
      if (signins === 1) return { action: 'restore' };
      if (signins === 2) return { action: 'continue', mode: { kind: 'private' }, stay: false, sharedComputer: false, hub: null };
      return { action: 'cancel' };
    },
    restore: { kind: 'phrase', words: words.join(' '), extra: '' },
    foundPosts: 'check',
  });
  const idp = makeIdp({ store, cards });
  const { req } = await request();
  const res = await idp.handleRequest(req, 'https://a.example', { ask: async () => ({ count: 0 }) });
  assert.deepEqual([res.ok, res.code], [false, 'E_USER_CANCELLED']);
  assert.equal(signins, 3, 'the sign-in card came back, with the restore offered');
  assert.equal(cards.calls.filter((c) => c.name === 'signin')[2].data.hasIdentity, false);
  assert.equal(await store.getWrapped(), null, 'no restored identity is left on the device');
  assert.equal((await store.getState()).restored, null);
  const doc = new FakeDocument();
  const ui = createCards({ doc, win: null, lang: 'en', build: { version: '0.3.0', id: 'x', hash: '', test: false }, now: () => 1, minPressMs: 0, idp: IDP });
  ui.foundPosts({ n: 0, site: 'https://a.example' });
  const primary = ui.root.find((x) => x.tagName === 'BUTTON' && x.getAttribute('class') === 'mw-primary');
  assert.equal(primary.textContent, (await import('../../src/idp/strings.js')).STRINGS.en.continueAnyway);
  assert.ok(ui.root.textContent.includes('This count comes from the site.'));
  assert.equal(countPostsBy({ exportBlocks: () => [{ e: { author: 'p256:x', op: { t: 'genesis' } } }] }, 'p256:y'), null, 'a copy with nothing past the genesis does not know');
  assert.equal(countPostsBy({ exportBlocks: () => [{ e: {} }, { e: { author: 'p256:y', op: { t: 'append' } } }] }, 'p256:y'), 1);
});

// ------------------------------------------------------------------------------------------- UX-9

test('UX-9: every card moves focus to its heading (or the card), and an error line takes focus', () => {
  const doc = new FakeDocument();
  const ui = createCards({ doc, win: null, lang: 'en', build: { version: '0.3.0', id: 'x', hash: '', test: false }, now: () => 1, minPressMs: 0, idp: IDP });
  ui.chooseUnlock({ prf: true, wasm: true });
  assert.equal(doc.activeElement && doc.activeElement.tagName, 'H1');
  assert.equal(doc.activeElement.getAttribute('tabindex'), '-1');
  ui.signin({ origin: 'https://shop.example', first: true, sameOptions: [], hub: null, unlock: 'passkey', hasIdentity: true });
  assert.equal(doc.activeElement.tagName, 'H1');
  assert.ok(doc.activeElement.textContent.includes('shop.example'));
  ui.busy();
  assert.equal(doc.activeElement.tagName, 'SECTION');
  ui.passphrase({ mode: 'unlock', error: 'That passphrase did not unlock it.' });
  assert.equal(doc.activeElement.getAttribute('role'), 'alert');
  assert.notEqual(doc.activeElement.tagName, 'BUTTON');
});

// ------------------------------------------------------------------------------------------- UX-12, STALK-6

test('UX-12, STALK-6: Settings shows sites, links, hubs and the check code only after an unlock; a hub answer can be asked again', async () => {
  const store = await openIdoStore({ memory: true });
  const passkey = fakePasskey();
  const idp = makeIdp({ store, passkey });
  for (const o of ['https://dating.example', 'https://shelter-help.example']) await signInAt(idp, o);
  // "Shared computer": nothing about the site is saved in the clear state record.
  const shared = makeIdp({ store, passkey, cards: scriptedCards({ signin: { action: 'continue', mode: { kind: 'private' }, stay: false, sharedComputer: true, hub: null } }) });
  await signInAt(shared, 'https://support-group.example');
  assert.equal((await store.getState()).origins['https://support-group.example'], undefined);
  const state = await store.getState();
  state.hubs['hub.example'] = { on: false, t: 1 };
  await store.setState(state);
  const models = [];
  let handlers = null;
  const cards = scriptedCards({ settings: (model, calls, h) => { models.push(model); handlers = h; return undefined; } });
  const gets = passkey.gets.length;
  const home = makeIdp({ store, passkey, cards, win: { opener: null, location: { origin: IDP, hash: '' } }, location: { origin: IDP, hash: '' } });
  await home.bootHome();
  assert.equal(passkey.gets.length, gets, 'no unlock to draw the page');
  assert.equal(models[0].locked, true);
  for (const k of ['sites', 'links', 'hubs', 'checkCode']) assert.equal(models[0][k], undefined, k + ' waits for the unlock');
  await handlers.unlockView();
  const open = models[models.length - 1];
  assert.equal(open.locked, undefined);
  assert.deepEqual(open.sites, ['https://dating.example', 'https://shelter-help.example']);
  assert.match(open.checkCode, /^[a-z2-7]{8}$/);
  assert.deepEqual(open.hubs, [{ suffix: 'hub.example', on: false }]);
  await handlers.hubAsk('hub.example');
  assert.equal((await store.getState()).hubs['hub.example'], undefined, 'the next sign-in on the hub offers the box again');
  const doc = new FakeDocument();
  const ui = createCards({ doc, win: null, lang: 'en', build: { version: '0.3.0', id: 'x', hash: '', test: false }, now: () => 1, minPressMs: 0, idp: IDP });
  ui.settings({ hasIdentity: true, unlock: 'passkey', backup: {}, links: [], hubs: [{ suffix: 'hub.example', on: false }], sites: [] }, {});
  assert.ok(ui.root.buttonByText('Ask me again on hub.example'));
  ui.settings({ hasIdentity: true, locked: true, unlock: 'passkey', backup: {} }, {});
  assert.ok(!ui.root.textContent.includes('Check code'), 'nothing of the sites before the unlock');
  assert.ok(ui.root.buttonByText('Remove my identity from this device'), 'the way out needs no unlock');
});

// ------------------------------------------------------------------------------------------- STALK-5

test('STALK-5: the extra word can be set when the identity is made; the 12 words alone then give another identity', async () => {
  const store = await openIdoStore({ memory: true });
  const cards = scriptedCards({ chooseUnlock: { method: 'passkey', nickname: 't', extra: 'tulip' } });
  const idp = makeIdp({ store, cards });
  await signInAt(idp, 'https://a.example');
  assert.equal(cards.calls.find((c) => c.name === 'chooseUnlock').data.extra, true, 'the create card offers the extra word');
  const root = b64url.decode(idp.session.vault.data.root);
  const code = (await store.getState()).checkCode;
  assert.notEqual(await checkCode(await rootStar(root)), code, 'without the extra word the words give another check code');
  assert.equal(await checkCode(await rootStar(root, 'tulip')), code);
  const doc = new FakeDocument();
  const ui = createCards({ doc, win: null, lang: 'en', build: { version: '0.3.0', id: 'x', hash: '', test: false }, now: () => 1, minPressMs: 0, idp: IDP });
  const p = ui.chooseUnlock({ prf: true, wasm: true, extra: true });
  const inputs = ui.root.findAll((x) => x.tagName === 'INPUT' && /^extra/.test(x.getAttribute('name') || ''));
  assert.equal(inputs.length, 2);
  inputs[0].value = 'tulip';
  inputs[1].value = 'tulips';
  ui.root.buttonByText('Use a passkey on this device') && ui.root.buttonByText('Use a passkey on this device').click();
  const visit = ui.root.find((x) => x.tagName === 'BUTTON' && /visit/i.test(x.textContent));
  visit.click();
  assert.ok(ui.root.textContent.includes('The two extra words differ.'));
  inputs[1].value = 'tulip';
  visit.click();
  assert.deepEqual(await p, { method: 'visit', extra: 'tulip' });
});

// ------------------------------------------------------------------------------------------- PHISH-3

test('PHISH-3: the card follows the menu when "Same as on" is chosen, and stopping it moves the shared label to new keys', async () => {
  const doc = new FakeDocument();
  const ui = createCards({ doc, win: null, lang: 'en', build: { version: '0.3.0', id: 'x', hash: '', test: false }, now: () => 1, minPressMs: 0, idp: IDP });
  ui.signin({ origin: 'https://evil.example', first: true, sameOptions: [{ origin: 'https://bank.example', label: 'o|https://bank.example' }], hub: null, unlock: 'passkey', hasIdentity: true });
  assert.ok(ui.root.textContent.includes('This site gets a key that works only here.'));
  const select = ui.root.find((x) => x.tagName === 'SELECT');
  select.value = 'same:https://bank.example';
  select.dispatchEvent({ type: 'change' });
  const text = ui.root.textContent;
  assert.ok(!text.includes('works only here') && !text.includes('It cannot see your other sites.'), text);
  assert.ok(text.includes('This site gets the same key as bank.example.'));
  assert.ok(text.includes('can sign in as you on bank.example'));
  // stopSame: the label evil.example shared moves on.
  const store = await openIdoStore({ memory: true });
  const passkey = fakePasskey();
  const idp = makeIdp({ store, passkey });
  const { K: bank } = await signInAt(idp, 'https://bank.example');
  const linker = makeIdp({ store, passkey, cards: scriptedCards({ signin: { action: 'continue', mode: { kind: 'same', origin: 'https://bank.example' }, stay: false, sharedComputer: false, hub: null }, confirmSame: true }) });
  const { K: evil } = await signInAt(linker, 'https://evil.example');
  assert.equal(evil.pub, bank.pub);
  const r = await makeIdp({ store, passkey }).stopSame('https://evil.example');
  assert.deepEqual(r, { rotated: true });
  const after = makeIdp({ store, passkey });
  const { K: bank2 } = await signInAt(after, 'https://bank.example');
  assert.notEqual(bank2.pub, bank.pub, 'the key evil.example holds no longer signs in at bank.example');
  assert.notEqual(bank2.chat.d, bank.chat.d);
  assert.notEqual(bank2.rec.key, bank.rec.key);
  assert.deepEqual([bank2.rotateNotice.from, bank2.rotateNotice.next], [bank.pub, bank2.pub]);
  const { K: evil2 } = await signInAt(after, 'https://evil.example');
  assert.notEqual(evil2.pub, bank2.pub);
});

// ------------------------------------------------------------------------------------------- PHISH-5, PHISH-12

test('PHISH-5, PHISH-12: #link in a window a site opened is refused before any passkey call; a framed identity page draws nothing else', async () => {
  const store = await openIdoStore({ memory: true });
  const passkey = fakePasskey();
  await signInAt(makeIdp({ store, passkey }), 'https://a.example');
  const gets = passkey.gets.length;
  const cards = scriptedCards();
  const loc = { origin: IDP, hash: '#link' };
  await makeIdp({ store, passkey, cards, win: { opener: {}, location: loc }, location: loc }).bootHome();
  assert.equal(passkey.gets.length, gets, 'no passkey prompt');
  assert.ok(!cards.calls.some((c) => c.name === 'scanCode' || c.name === 'showCodes'));
  const { STRINGS } = await import('../../src/idp/strings.js');
  assert.match(STRINGS.en.linkReleaseWarn, /12 words and every key/);
  const framedCards = scriptedCards();
  const top = {};
  const win = { opener: null, location: { origin: IDP, hash: '' } };
  win.top = top;
  win.self = win;
  await makeIdp({ store, passkey, cards: framedCards, win, location: win.location }).bootHome();
  assert.deepEqual(framedCards.calls.map((c) => c.name), ['message']);
  assert.match(framedCards.calls[0].data.text, /only in a window of its own/);
});

// ------------------------------------------------------------------------------------------- SEC-4

test('SEC-4: a 150,000-byte vault moves over the device link at 2 s a code, and an early stop never adopts an identity without its vault', async () => {
  let t = 1_000_000;
  const now = () => t;
  const v = new Vault();
  v.data.root = b64url.encode(newRoot());
  v.data.filler = 'x'.repeat(150000);
  const kVault = webcrypto.getRandomValues(new Uint8Array(32));
  const rs = webcrypto.getRandomValues(new Uint8Array(32));
  const blob = await v.toBlob(kVault, { id: 'abcdefghijklmnopqrstuv' });
  const b = new LinkNewDevice({ now });
  const a = new LinkOldDevice({ now });
  const q1 = await b.open();
  a.open();
  t += 2000;
  const q2 = await a.acceptCommit(q1);
  t += 2000;
  const { reveal } = await b.acceptA(q2);
  t += 2000;
  await a.acceptReveal(reveal);
  t += 2000;
  const codes = await a.confirm(true, { rootStar: rs, kVault, vaultBlob: blob });
  assert.ok(codes.length - 1 <= MAX_PARTS && codes.length - 1 > 200, (codes.length - 1) + ' parts');
  t += 2000;
  await b.acceptSecret(codes[0]);
  for (const c of codes.slice(1)) { t += 2000; b.acceptPart(c); }
  const done = b.complete();
  const opened = await Vault.open(done.kVault, done.vaultBlob);
  assert.equal(opened.data.filler.length, 150000);
  // runLinkNew: a person who stops scanning before the vault parts arrived gets an error, not an empty vault.
  const store = await openIdoStore({ memory: true });
  const A = new LinkOldDevice();
  A.open();
  const shown = [];
  let scans = 0;
  const cards = scriptedCards({
    showCodes: (data) => { shown.push(data.codes[0]); return true; },
    scanCode: async () => {
      scans++;
      if (scans === 1) return A.acceptCommit(shown[0]);
      if (scans === 2) {
        await A.acceptReveal(shown[1]);
        return (await A.confirm(true, { rootStar: rs, kVault, vaultBlob: blob }))[0];
      }
      return null; // the person stops before the vault parts
    },
  });
  await assert.rejects(makeIdp({ store, cards }).runLinkNew(), (e) => e.code === 'E_LINK_STEP');
  assert.equal(scans, 3, 'the identity code arrived, then the person stopped');
  assert.equal(await store.getWrapped(), null, 'no identity without its vault');
});

// ------------------------------------------------------------------------------------------- SEC-9

test('SEC-9: a nonce store full of unexpired entries says so: store-full, not replay', async () => {
  const used = new MemoryNonceStore({ max: 1 });
  const nonces = statelessNonce('s'.repeat(32), { used });
  const a = await nonces.issue('https://forum.example');
  const b = await nonces.issue('https://forum.example');
  assert.equal(await nonces.consume(a.nonce, a.exp, 'https://forum.example'), true);
  assert.equal(await nonces.consume(a.nonce, a.exp, 'https://forum.example'), 'used');
  assert.equal(await nonces.consume(b.nonce, b.exp, 'https://forum.example'), 'full');
});
