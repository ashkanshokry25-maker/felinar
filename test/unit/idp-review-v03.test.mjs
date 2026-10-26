// Code review v0.3 fixes at the identity origin (loader-sw fixer, 2026-10-20): escrow copies are merged, never adopted
// whole (security 1); only the passkey blob is escrowed and the strength floor refuses sequences (security 2); every
// vault and state change runs under one lock on the newest stored copy (correctness 3); a proof never rides with the
// record read and a site proof never takes a page nonce (security 7); a site cannot bloat the vault (security 8); no
// ledger label for an expired pointer, the seq floor travels in the vault (security 10); shared origins and hub
// suffixes are the build's (security 9, 20); the look-alike line, the mode lines and the iOS lines (conformance,
// security 19, browser); MF-09 "Tap to finish"; the backup file save card; the KDF yields to the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { createIdp, verifyPointerFor, FAST_REFUSAL_MS, BACKUP_URL_MS } from '../../src/idp/idp.js';
import { openIdoStore, acceptEscrow } from '../../src/idp/store.js';
import { createCards } from '../../src/idp/cards.js';
import { STRINGS, t as idpT, setIdpStringFlag } from '../../src/idp/strings.js';
import * as client from '../../src/identity/client.js';
import { Vault, passphraseStrength, openBackupFile, RECORD_MAX_BYTES } from '../../src/identity/vault.js';
import { wrapWithPassphrase } from '../../src/identity/wrap.js';
import { legacyOutcome } from '../../src/identity/migrate.js';
import { buildChallenge } from '../../src/identity/signin.js';
import { signPointer, parsePointer, formatPointer, ledgerIdFor, hubLabelFor } from '../../src/common/pointer.js';
import { generateKeyPair, exportPublicKey } from '../../src/chain/crypto.js';
import { FakeDocument } from './dropin-fake-dom.mjs';

const IDP = 'http://localhost:9555';

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
      case 'busy': case 'close': case 'progress': return undefined;
      default: return true;
    }
  };
  return new Proxy({ calls, lang: 'en' }, { get(tgt, k) { if (k in tgt) return tgt[k]; return async (data) => answer(k, data); } });
}

function fakePasskey(prf = webcrypto.getRandomValues(new Uint8Array(32))) {
  const pk = {
    uv: true, calls: [],
    async capabilities() { return { webauthn: true, platform: true, prf: true }; },
    async create() { pk.calls.push('create'); return { credId: 'Y3JlZA', prf, prfEnabled: true, uv: true }; },
    async get() { pk.calls.push('get'); return { credId: 'Y3JlZA', prf, uv: pk.uv }; },
  };
  return pk;
}

function makeIdp({ cards = scriptedCards(), passkey, store, wasm = true, now, extra = {} }) {
  return createIdp(Object.assign({ win: null, doc: null, navigator: null, location: { origin: IDP }, cards, passkey, store, wasm, ios: false, standalone: false, build: { version: '0.3.0', id: 'test0001', hash: '', test: true }, now }, extra));
}

async function signInAt(idp, origin, { want = ['keys'], extra = {}, escrowFrom = null } = {}) {
  const box = await client.newBoxKey();
  const requestId = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url');
  const req = Object.assign({ v: 1, t: 'mw-signin-req', requestId, purpose: 'site', want, epk: box.pub }, extra);
  if (escrowFrom) {
    const e = {};
    if (escrowFrom.escrow) e.root = escrowFrom.escrow;
    if (escrowFrom.vaultEscrow) e.vault = escrowFrom.vaultEscrow;
    req.escrow = e;
  }
  const res = await idp.handleRequest(req, origin, null);
  if (!res.ok || !res.bundle) return { res, req };
  return { res, req, K: await client.open(client.BUNDLE_PREFIX, box.privateKey, res.bundle, { origin, requestId }) };
}

const keysOf = (K) => ({ pub: K.pub, chat: K.chat.pub, rec: K.rec.key, own: K.own, local: K.local });

// ------------------------------------------------------------------------------------------------ security 1

test('escrow copies are merged: after the identity origin loses its storage, a site signed in to later keeps every key', async () => {
  const passkey = fakePasskey();
  const A = 'https://a.example';
  const C = 'https://c.example';
  const one = makeIdp({ passkey, store: await openIdoStore({ memory: true }) });
  const a1 = (await signInAt(one, A)).K; // day 1: a.example's copy knows o|a only
  const c1 = (await signInAt(one, C, { escrowFrom: a1 })).K; // day 3: c.example's copy knows both
  // Safari's 7-day rule removes the identity origin's storage: same passkey, empty store.
  const two = makeIdp({ passkey, store: await openIdoStore({ memory: true }) });
  const a2 = (await signInAt(two, A, { escrowFrom: a1 })).K; // the older copy comes back first
  assert.deepEqual(keysOf(a2), keysOf(a1), 'a.example: the same keys');
  const c2 = (await signInAt(two, C, { escrowFrom: c1 })).K; // the newer copy is merged, not ignored
  assert.deepEqual(keysOf(c2), keysOf(c1), 'c.example: its chat key, K_rec, K_own and K_local are unchanged');
  // And the other order: the newer copy first, then the older one adds nothing and loses nothing.
  const three = makeIdp({ passkey, store: await openIdoStore({ memory: true }) });
  assert.deepEqual(keysOf((await signInAt(three, C, { escrowFrom: c1 })).K), keysOf(c1));
  assert.deepEqual(keysOf((await signInAt(three, A, { escrowFrom: a1 })).K), keysOf(a1));
});

test('a key shredded by me.erase never comes back from an older escrow copy', async () => {
  const passkey = fakePasskey();
  const S = 'https://s.example';
  const store = await openIdoStore({ memory: true });
  const idp = makeIdp({ passkey, store });
  const before = (await signInAt(idp, S)).K;
  const erased = (await signInAt(idp, S, { want: ['erase'], escrowFrom: before })).K;
  assert.notEqual(erased.rec.key, before.rec.key);
  assert.notEqual(erased.own, before.own);
  // A site still holding the pre-erase copy passes it back, here and after a storage loss.
  const again = (await signInAt(makeIdp({ passkey, store }), S, { escrowFrom: before })).K;
  assert.deepEqual([again.rec.key, again.own], [erased.rec.key, erased.own], 'the erased keys stay retired');
  const evicted = makeIdp({ passkey, store: await openIdoStore({ memory: true }) });
  await signInAt(evicted, S, { escrowFrom: erased });
  const later = (await signInAt(evicted, S, { escrowFrom: before })).K;
  assert.notEqual(later.rec.key, before.rec.key, 'not even after the identity origin lost its storage');
  assert.notEqual(later.own, before.own);
});

test('Vault.mergeFrom: epochs by number, retired keys stay gone, unlinks and record erasures stand, floors only rise', () => {
  const { vault: a } = Vault.create();
  const L = 'o|https://x.example';
  a.label(L, { now: 1 });
  const b = new Vault(JSON.parse(JSON.stringify(a.data)));
  b.rotateChat(L, { now: 2 });
  b.newRecordKey(L);
  b.raiseFloor('mw1:ledger', 40);
  a.raiseFloor('mw1:ledger', 30);
  a.linkOrigin('https://y.example', L, 5);
  b.linkOrigin('https://y.example', L, 5);
  a.unlinkOrigin('https://y.example', 9);
  a.eraseRecord(L, 'https://x.example', 10);
  b.label(L).me = { 'https://x.example': { f: { old: 1, fresh: 2 }, ft: { old: 8, fresh: 11 }, t: 11 } };
  const oldOwn = a.label(L).own;
  a.shred(L, 'own');
  a.label(L).own = 'bmV3b3du';
  const v0 = a.version();
  assert.equal(a.mergeFrom(b, { now: 20 }), true);
  const e = a.label(L, { create: false });
  assert.deepEqual(e.chat.map((c) => c.e), [1, 2]);
  assert.deepEqual(e.rec.map((r) => r.r), [1, 2]);
  assert.equal(e.own, 'bmV3b3du', 'the shredded K_own does not return');
  assert.notEqual(e.own, oldOwn);
  assert.deepEqual(e.links, [], 'the link removed at 9 stays removed');
  assert.deepEqual(e.me['https://x.example'].f, { fresh: 2 }, 'fields older than the erase stay gone');
  assert.equal(a.floor('mw1:ledger'), 40);
  assert.ok(a.version() > v0);
});

// ------------------------------------------------------------------------------------------------ security 2

test('a passphrase identity is never escrowed, a passphrase blob is never taken back, and the floor refuses sequences', async () => {
  for (const weak of ['abcdefghijklmnopqrstuvwxyz', 'qwertyuiopasdfghjklzxcvbnm', 'abandon ability able about above absent', 'zyxwvutsrqponmlkjihgfedcba', '1234567890123456']) {
    assert.equal(passphraseStrength(weak).ok, false, weak);
  }
  for (const ok of ['Tr0ub4dor&3-horse-Battery!', 'my dog likes long walks at noon']) assert.equal(passphraseStrength(ok).ok, true, ok);
  const store = await openIdoStore({ memory: true });
  const cards = scriptedCards({ chooseUnlock: { method: 'passphrase' }, passphrase: 'a quiet river under seven bridges' });
  const idp = makeIdp({ cards, passkey: fakePasskey(), store, wasm: false });
  const { K } = await signInAt(idp, 'https://p.example');
  assert.equal(K.escrow, null, 'no passphrase blob for any site');
  assert.ok(K.vaultEscrow, 'the vault copy (opaque without K_vault) still goes');
  assert.ok(cards.calls.some((c) => c.name === 'passphrase' && c.data.mode === 'create'));
  const blob = await wrapWithPassphrase('a quiet river under seven bridges', new Uint8Array(64), { kdf: 'pbkdf2' });
  assert.equal(acceptEscrow({ root: blob }).root, null, 'a passphrase blob a site passes back is ignored');
});

// ------------------------------------------------------------------------------------------------ correctness 3

test('two windows over one store: a stale window never erases a site another window added; a backup holds it', async () => {
  const passkey = fakePasskey();
  const store = await openIdoStore({ memory: true });
  const first = (await signInAt(makeIdp({ passkey, store }), 'https://x.example')).K;
  assert.ok(first);
  // Window A (Settings) unlocks and keeps its copy; window B signs in to a new site S.
  const backupCards = scriptedCards({ backupFile: (data) => ({ pass: data.generated }), saveBackup: 'saved' });
  const A = makeIdp({ passkey, store, cards: backupCards, wasm: false });
  await A.unlock({ allowCreate: false });
  const B = makeIdp({ passkey, store });
  const S = 'https://s.example';
  const s1 = (await signInAt(B, S)).K;
  // Window A acts on its stale view: "Stop using the same identity", then a backup.
  await A.stopSame('https://x.example');
  const s2 = (await signInAt(makeIdp({ passkey, store }), S)).K;
  assert.deepEqual(keysOf(s2), keysOf(s1), 'S keeps its own, local, record and chat keys');
  const text = await A.makeBackup();
  const generated = backupCards.calls.find((c) => c.name === 'backupFile').data.generated;
  const opened = await openBackupFile(text, generated);
  assert.ok(opened.vault.labels().includes('o|' + S), 'the backup made by the stale window holds S');
  // And a stale "Replace my keys" builds on the newest copy too.
  const C = makeIdp({ passkey, store });
  await C.unlock({ allowCreate: false });
  const T = 'https://t.example';
  const t1 = (await signInAt(makeIdp({ passkey, store }), T)).K;
  await C.replaceAllKeys();
  const t2 = (await signInAt(makeIdp({ passkey, store }), T)).K;
  assert.equal(t2.sign.i, 2, 'T was replaced as well');
  assert.deepEqual([t2.rec.key, t2.own, t2.local], [t1.rec.key, t1.own, t1.local], 'its random keys were not lost');
});

// ------------------------------------------------------------------------------------------------ security 7

test('a proof never rides with the record read, a site proof never takes a page nonce, every proof shows the sign-in card', async () => {
  const box = await client.newBoxKey();
  const base = { v: 1, t: 'mw-signin-req', requestId: 'A'.repeat(22), purpose: 'site', epk: box.pub };
  const v = (patch) => client.validateRequest(Object.assign({}, base, patch));
  assert.equal(v({ want: ['record', 'proof'] }).ok, false);
  assert.equal(v({ want: ['record', 'keys'] }).ok, false);
  for (const want of [['keys'], ['proof'], ['keys', 'proof'], ['record'], ['erase']]) assert.equal(v({ want }).ok, true, want.join());
  assert.equal(v({ want: ['proof'], challenge: { nonce: 'B'.repeat(22), statement: 'I agree to close my account' } }).ok, false, 'a challenge belongs to a server sign-in');
  // The identity origin runs the same rule itself (a page skipping the check gains nothing).
  const cards = scriptedCards();
  const idp = makeIdp({ cards, passkey: fakePasskey(), store: await openIdoStore({ memory: true }) });
  const r = await signInAt(idp, 'https://forum.example', { want: ['record', 'proof'], extra: { challenge: { nonce: 'B'.repeat(22), statement: 'I agree' } } });
  assert.equal(r.res.ok, false);
  assert.equal(r.res.proof, undefined);
  assert.equal(cards.calls.length, 0, 'no card at all for a refused request');
  // buildChallenge never uses a page nonce for purpose 'site'.
  const c = buildChallenge({ origin: 'https://forum.example', pub: (await client.newBoxKey()).pub, keyMode: 'pairwise', purpose: 'site', challenge: { nonce: 'B'.repeat(22) }, now: Date.now(), requestId: 'A'.repeat(22), idp: IDP, build: 'b' });
  assert.notEqual(c.nonce, 'B'.repeat(22));
  // A site proof: the sign-in card was shown.
  const cards2 = scriptedCards();
  const idp2 = makeIdp({ cards: cards2, passkey: fakePasskey(), store: await openIdoStore({ memory: true }) });
  const p = await signInAt(idp2, 'https://forum.example', { want: ['proof'] });
  assert.equal(p.res.ok, true);
  assert.ok(p.res.proof);
  assert.ok(cards2.calls.some((x) => x.name === 'signin'), 'the sign-in card');
});

// ------------------------------------------------------------------------------------------------ security 8

test('one site cannot bloat the vault: a 300 KB record is refused and later sign-ins at other sites still go out', async () => {
  const passkey = fakePasskey();
  const store = await openIdoStore({ memory: true });
  const idp = makeIdp({ passkey, store });
  const GOOD = 'https://good.example';
  const EVIL = 'https://evil.example';
  const g1 = (await signInAt(idp, GOOD)).K;
  const e1 = (await signInAt(idp, EVIL)).K;
  let esc = e1;
  for (const field of ['a', 'b']) {
    const big = { f: { [field]: 'x'.repeat(150000) }, ft: { [field]: Date.now() }, t: Date.now() };
    const record = await client.sealLocal(e1.local, e1.label, 'me', big);
    esc = (await signInAt(idp, EVIL, { extra: { record }, escrowFrom: esc })).K;
  }
  assert.ok(esc.vaultEscrow.ct.length < 60000, 'the records were refused: ' + esc.vaultEscrow.ct.length);
  // A record at the cap is kept; one byte over is not.
  const okRec = { f: { n: 'y'.repeat(RECORD_MAX_BYTES - 100) }, ft: { n: Date.now() }, t: Date.now() };
  const k2 = (await signInAt(idp, EVIL, { want: ['keys'], extra: { record: await client.sealLocal(e1.local, e1.label, 'me', okRec) }, escrowFrom: esc })).K;
  assert.ok(k2.vaultEscrow.ct.length > RECORD_MAX_BYTES, 'a record within the cap is merged');
  // good.example: two more sign-ins, both requests within the limits a page checks before sending.
  let g = g1;
  for (let i = 0; i < 2; i++) {
    const box = await client.newBoxKey();
    const req = { v: 1, t: 'mw-signin-req', requestId: Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url'), purpose: 'site', want: ['keys'], epk: box.pub, escrow: { root: g.escrow, vault: g.vaultEscrow } };
    assert.equal(client.validateRequest(req).ok, true, 'sign-in ' + (i + 1) + ' is not refused before it is sent');
    const res = await idp.handleRequest(req, GOOD, null);
    assert.equal(res.ok, true);
    g = await client.open(client.BUNDLE_PREFIX, box.privateKey, res.bundle, { origin: GOOD, requestId: req.requestId });
  }
  // An escrow over the request limit is dropped, never the sign-in.
  assert.equal(client.fitEscrow({ root: g.escrow, vault: { ct: 'x'.repeat(client.MAX_BLOB_CHARS) } }).vault, undefined);
});

// ------------------------------------------------------------------------------------------------ security 10

async function pointerText({ org = [], seq, exp, scope }) {
  const kp = await generateKeyPair({ extractable: false });
  const owner = await exportPublicKey(kp.publicKey);
  const rec = Object.assign(parsePointer('v=mw1; btih=' + 'a'.repeat(40)).record, { btih: 'a'.repeat(40), owner, seq, exp, org });
  const signed = await signPointer(rec, scope, kp.privateKey);
  return { text: formatPointer(signed), signed };
}

test('no ledger label for an expired pointer, and the seq floor travels in the vault', async () => {
  const now = Date.now();
  const s = Math.floor(now / 1000);
  const expired = await pointerText({ org: ['https://mirror.example'], seq: s - 200000, exp: s - 100, scope: 'shop.example' });
  const v = await verifyPointerFor(expired.text, 'https://mirror.example', { now, scope: 'shop.example' });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'expired');
  const idp = makeIdp({ passkey: fakePasskey(), store: await openIdoStore({ memory: true }) });
  const r = await signInAt(idp, 'https://mirror.example', { extra: { pointer: expired.text, scope: 'shop.example' } });
  assert.equal(r.K.label, 'o|https://mirror.example', 'the origin label instead');
  // The floor: the vault remembers the highest seq accepted; after a storage loss the escrow copy brings it back.
  const passkey = fakePasskey();
  const kp = await generateKeyPair({ extractable: false });
  const owner = await exportPublicKey(kp.publicKey);
  const mk = async (seq) => formatPointer(await signPointer(Object.assign(parsePointer('v=mw1; btih=' + 'b'.repeat(40)).record, { btih: 'b'.repeat(40), owner, seq, exp: s + 86400 }), 'shop.example', kp.privateKey));
  const newer = await mk(s);
  const older = await mk(s - 1000);
  const one = makeIdp({ passkey, store: await openIdoStore({ memory: true }) });
  const k1 = (await signInAt(one, 'https://shop.example', { extra: { pointer: newer } })).K;
  assert.equal(k1.keyMode, 'ledger');
  const two = makeIdp({ passkey, store: await openIdoStore({ memory: true }) });
  const k2 = (await signInAt(two, 'https://shop.example', { extra: { pointer: older }, escrowFrom: k1 })).K;
  assert.equal(k2.keyMode, 'pairwise', 'an older pointer is a rollback even after the storage loss');
});

// ------------------------------------------------------------------------------------------------ security 20, conformance

test('a shared origin of the build gets "this visit only" whatever the page says', async () => {
  const SH = 'https://shared.example';
  const idp = makeIdp({ passkey: fakePasskey(), store: await openIdoStore({ memory: true }), extra: { sharedOrigins: [SH] } });
  const r = await signInAt(idp, SH);
  assert.equal(r.K.keyMode, 'visit-only');
  assert.equal(r.K.escrow, null);
  const other = await signInAt(idp, 'https://own.example');
  assert.equal(other.K.keyMode, 'pairwise');
});

test('a personal page on a hub: the address derived from its own pointer gets no look-alike warning; a foreign pointer does', async () => {
  const kp = await generateKeyPair({ extractable: false });
  const owner = await exportPublicKey(kp.publicKey);
  const s = Math.floor(Date.now() / 1000);
  const template = 'c'.repeat(40);
  const scope = 'btih:' + template;
  const rec = Object.assign(parsePointer('v=mw1; btih=' + template).record, { btih: template, owner, chain: 'A'.repeat(22), seq: s, exp: s + 86400 });
  const signed = await signPointer(rec, scope, kp.privateKey);
  const text = formatPointer(signed);
  const ledgerId = await ledgerIdFor(signed, scope);
  const label = hubLabelFor(signed, ledgerId);
  const own = 'https://' + label + '.hub.example';
  const cards = scriptedCards();
  const idp = makeIdp({ cards, passkey: fakePasskey(), store: await openIdoStore({ memory: true }), extra: { hubSuffixes: ['hub.example'] } });
  await signInAt(idp, own, { extra: { pointer: text, scope } });
  assert.equal(cards.calls.find((c) => c.name === 'signin').data.notListed, false, 'its own address');
  const cards2 = scriptedCards();
  const idp2 = makeIdp({ cards: cards2, passkey: fakePasskey(), store: await openIdoStore({ memory: true }), extra: { hubSuffixes: ['hub.example'] } });
  await signInAt(idp2, 'https://' + 'd'.repeat(32) + '.hub.example', { extra: { pointer: text, scope } });
  assert.equal(cards2.calls.find((c) => c.name === 'signin').data.notListed, true, 'another label presenting it is a look-alike');
});

test('the sign-in card says what the key reaches: private, linked, hub and mirror lines', async () => {
  const doc = new FakeDocument();
  const cards = createCards({ doc, win: null, lang: 'en', build: { version: '0.3.0', id: 'abc123', hash: '', test: false }, now: () => 1000, minPressMs: 0, idp: IDP });
  const text = (data) => { cards.signin(Object.assign({ origin: 'https://shop.example', unlock: 'unlocked', hasIdentity: true }, data)); return cards.root.textContent; };
  const only = idpT('keyOnlyHere');
  const others = idpT('cannotSeeOthers');
  const priv = text({});
  assert.ok(priv.includes(only) && priv.includes(others));
  const linked = text({ linkedTo: 'https://a.example' });
  assert.ok(!linked.includes(only) && !linked.includes(others), 'linked: no "works only here"');
  assert.ok(linked.includes(idpT('linkedLine', { site: 'a.example' })));
  const hub = text({ hub: { suffix: 'hub.example', decided: true, on: true } });
  assert.ok(!hub.includes(only) && !hub.includes(others), 'hub: no "cannot see your other sites"');
  assert.ok(hub.includes(idpT('hubLine', { hub: 'hub.example' })));
  const mirror = text({ mirrorOf: 'shop.example' });
  assert.ok(!mirror.includes(only));
  assert.ok(mirror.includes(idpT('mirrorLine', { site: 'shop.example' })));
  // The hub box starts unchecked even if a caller passes the old defaultOn.
  cards.signin({ origin: 'https://' + 'a'.repeat(32) + '.hub.example', hub: { suffix: 'hub.example', decided: false, on: false, defaultOn: true }, unlock: 'unlocked', hasIdentity: true });
  const box = cards.root.findAll((n) => n.tagName === 'INPUT' && n.getAttribute && n.getAttribute('name') === 'hub')[0];
  assert.equal(box.checked, false);
  cards.close();
});

test('identity-origin strings: no Home Screen promise for this page, iOS lines behind the flag, "by key" on the hub card', async () => {
  for (const lang of ['en', 'fr']) {
    for (const [k, v] of Object.entries(STRINGS[lang])) {
      assert.ok(!/(home screen|écran d'accueil)/i.test(v) || !/(keep|garder)/i.test(v), lang + ' ' + k + ': ' + v);
    }
  }
  assert.ok(STRINGS.en.hubIdentityText.includes('cannot match you by key'));
  assert.ok(STRINGS.fr.hubIdentityText.includes('par votre clé'));
  const doc = new FakeDocument();
  const cards = createCards({ doc, win: null, lang: 'en', build: { version: '0.3.0', id: 'abc123', hash: '', test: false }, now: () => 1000, minPressMs: 0, idp: IDP });
  cards.recoveryKit({ ios: true, escrow: true, checkCode: 'abcd2345' });
  assert.ok(!cards.root.textContent.includes('Safari'), 'iOS lines wait for the MF-63 check');
  setIdpStringFlag('iosStrings', true);
  try {
    cards.recoveryKit({ ios: true, escrow: true, checkCode: 'abcd2345' });
    const shown = cards.root.textContent;
    assert.ok(shown.includes(STRINGS.en.kitIos) && shown.includes(STRINGS.en.kitIosEscrow));
    assert.ok(!/Home Screen/.test(shown), 'no Home Screen step for the identity page');
    cards.recoveryKit({ ios: true, escrow: false, checkCode: 'abcd2345' });
    assert.ok(!cards.root.textContent.includes(STRINGS.en.kitIosEscrow), 'a passphrase identity has no sealed copy on sites');
  } finally {
    setIdpStringFlag('iosStrings', false);
  }
  cards.close();
});

// ------------------------------------------------------------------------------------------------ MF-09

/** A memory store whose reads finish in a later task, like IndexedDB. */
async function slowStore() {
  const st = await openIdoStore({ memory: true });
  const get = st.backend.get.bind(st.backend);
  st.backend.get = (k) => new Promise((resolve) => setImmediate(() => resolve(get(k))));
  return st;
}

/** A passkey that works only inside a press: the card press sets the flag, the next task clears it. */
function gesturePasskey({ prfAtCreate = false } = {}) {
  const prf = webcrypto.getRandomValues(new Uint8Array(32));
  const g = { on: false, refused: 0, calls: [] };
  g.press = () => { g.on = true; setImmediate(() => { g.on = false; }); };
  const refuse = (what) => { g.refused++; g.calls.push(what + ':refused'); throw Object.assign(new Error('NotAllowedError'), { code: 'E_USER_CANCELLED' }); };
  g.passkey = {
    async capabilities() { return { webauthn: true, platform: true, prf: true }; },
    async create() { if (!g.on) refuse('create'); g.calls.push('create'); return { credId: 'Y3JlZA', prf: prfAtCreate ? prf : null, prfEnabled: true, uv: true }; },
    async get() { if (!g.on) refuse('get'); g.calls.push('get'); return { credId: 'Y3JlZA', prf, uv: true }; },
  };
  return g;
}

test('MF-09: a returning sign-in reaches the passkey call inside the press; enrolment on Safari needs one "Tap to finish"', async () => {
  const g = gesturePasskey({ prfAtCreate: false });
  const store = await slowStore();
  const press = (v) => () => { g.press(); return v; };
  const cards = scriptedCards({
    signin: press({ action: 'continue', mode: { kind: 'private' }, stay: false, sharedComputer: false, hub: null }),
    chooseUnlock: press({ method: 'passkey', nickname: 'x' }),
    tapToFinish: press(true),
  });
  const first = await signInAt(makeIdp({ cards, passkey: g.passkey, store }), 'https://a.example');
  assert.equal(first.res.ok, true, 'enrolment finished');
  assert.deepEqual(g.calls, ['create', 'get'], 'create in the choice press, the PRF assertion in the tap');
  assert.equal(cards.calls.filter((c) => c.name === 'tapToFinish').length, 1);
  g.calls.length = 0;
  const cards2 = scriptedCards({ signin: press({ action: 'continue', mode: { kind: 'private' }, stay: false, sharedComputer: false, hub: null }), tapToFinish: press(true) });
  const back = await signInAt(makeIdp({ cards: cards2, passkey: g.passkey, store }), 'https://a.example');
  assert.equal(back.res.ok, true);
  assert.deepEqual(g.calls, ['get'], 'nothing awaited storage or crypto between the press and the call');
  assert.equal(cards2.calls.filter((c) => c.name === 'tapToFinish').length, 0, 'no extra tap for a returning person');
});

test('MF-09: a call refused without a prompt gets one "Tap to finish"; NotSupportedError falls back to a passphrase in the same window', async () => {
  const g = gesturePasskey({ prfAtCreate: true });
  const store = await openIdoStore({ memory: true });
  // The sign-in card press is used up before the call (no press flag): the browser refuses at once.
  const cards = scriptedCards({ chooseUnlock: { method: 'passkey', nickname: 'x' }, tapToFinish: () => { g.press(); return true; } });
  const r = await signInAt(makeIdp({ cards, passkey: g.passkey, store }), 'https://a.example');
  assert.equal(r.res.ok, true);
  assert.equal(cards.calls.filter((c) => c.name === 'tapToFinish').length, 1);
  assert.deepEqual(g.calls, ['create:refused', 'create']);
  // Two fast refusals: E_PASSKEY_REFUSED, and for a new identity the passphrase card.
  const never = { async capabilities() { return { webauthn: true, platform: true, prf: true }; }, async create() { throw Object.assign(new Error('NotSupportedError'), { code: 'E_UNSUPPORTED' }); }, async get() { throw new Error('unused'); } };
  const cards2 = scriptedCards({ chooseUnlock: { method: 'passkey', nickname: 'x' }, passphrase: 'a quiet river under seven bridges' });
  const r2 = await signInAt(makeIdp({ cards: cards2, passkey: never, store: await openIdoStore({ memory: true }), wasm: false }), 'https://b.example');
  assert.equal(r2.res.ok, true, 'the site gets keys, not E_UNSUPPORTED');
  assert.ok(cards2.calls.some((c) => c.name === 'passphrase' && c.data.mode === 'create'), 'the passphrase card in the same window');
  // IND-9 (independence design, 2026-10-25): an identity page on an IP address, https://203.0.113.7. The real passkey module takes
  // the RP ID from the page's host name; a browser refuses an IP address there with SecurityError (WebAuthn: the RP ID must be a
  // valid domain), which maps to E_UNSUPPORTED, so the person gets the passphrase card in the same window and the identity works.
  const ipLoc = { origin: 'https://203.0.113.7', hostname: '203.0.113.7' };
  const rpIds = [];
  const ipNav = { credentials: {
    async create(o) { rpIds.push(o.publicKey.rp.id); throw Object.assign(new Error('The relying party ID is not a registrable domain suffix'), { name: 'SecurityError' }); },
    async get() { throw new Error('unused: no passkey was made'); },
  } };
  const cards3 = scriptedCards({ chooseUnlock: { method: 'passkey', nickname: 'x' }, passphrase: 'a quiet river under seven bridges' });
  const r3 = await signInAt(makeIdp({ cards: cards3, passkey: undefined, store: await openIdoStore({ memory: true }), wasm: false,
    extra: { location: ipLoc, passkeyEnv: { navigator: ipNav, PublicKeyCredential: function PublicKeyCredential() {}, crypto: webcrypto, location: ipLoc } } }), 'https://b.example');
  assert.deepEqual(rpIds, ['203.0.113.7'], 'the passkey call named the IP address as the RP ID (the real module, not a stub)');
  assert.equal(r3.res.ok, true, 'an identity page on an IP address still gives the site its keys');
  assert.ok(r3.K && r3.K.pub, 'the site received a working key');
  assert.ok(cards3.calls.some((c) => c.name === 'passphrase' && c.data.mode === 'create'), 'the passphrase card in the same window');
  assert.equal(cards3.calls.filter((c) => c.name === 'tapToFinish').length, 0, 'a refusal by SecurityError is not a missing gesture');
  assert.equal(FAST_REFUSAL_MS, 1000);
});

// ------------------------------------------------------------------------------------------------ backup file, KDF

test('the backup file download keeps its URL at least 60 s and is started by the save button only', async () => {
  const timers = [];
  const revoked = [];
  const clicks = [];
  const doc = new FakeDocument();
  const win = {
    Blob: class { constructor(parts, o) { this.parts = parts; this.type = o.type; } },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: (u) => revoked.push(u) },
  };
  const origCreate = doc.createElement.bind(doc);
  doc.createElement = (tag) => { const e = origCreate(tag); if (tag === 'a') e.click = () => clicks.push(e.getAttribute('download')); return e; };
  const idp = createIdp({ win, doc, navigator: null, location: { origin: IDP }, cards: scriptedCards(), passkey: fakePasskey(), store: await openIdoStore({ memory: true }), wasm: false, ios: false, standalone: false, setTimeout: (fn, ms) => timers.push({ fn, ms }), build: { version: '0.3.0', id: 'test0001', hash: '', test: true } });
  assert.equal(idp.startDownload('{"type":"mw-identity"}'), true);
  assert.deepEqual(clicks, ['magnet-web-identity-backup.json']);
  assert.equal(revoked.length, 0);
  assert.equal(timers.length, 1);
  assert.ok(timers[0].ms >= 30000 && timers[0].ms === BACKUP_URL_MS, 'no revoke before 30 s');
  timers[0].fn();
  assert.deepEqual(revoked, ['blob:x']);
  // The save card: its Save button calls download inside the press; only "I saved the file" resolves 'saved'.
  const cards = createCards({ doc, win: null, lang: 'en', build: { version: '0.3.0', id: 'abc123', hash: '', test: false }, now: () => 1000, minPressMs: 0, idp: IDP });
  const got = [];
  const p = cards.saveBackup({ text: 'T', download: (x) => got.push(x) });
  const buttons = cards.root.findAll((n) => n.tagName === 'BUTTON');
  buttons.find((b) => b.textContent === STRINGS.en.backupSave).dispatchEvent({ type: 'click', isTrusted: true });
  assert.deepEqual(got, ['T']);
  buttons.find((b) => b.textContent === STRINGS.en.backupSaved).dispatchEvent({ type: 'click', isTrusted: true });
  assert.equal(await p, 'saved');
  cards.close();
});

test('the passphrase is stretched in slices: the page gets turns of the event loop while Argon2id runs', async () => {
  let ticks = 0;
  const iv = setInterval(() => { ticks++; }, 5);
  const progress = [];
  try {
    await wrapWithPassphrase('a quiet river under seven bridges', new Uint8Array(64), { kdf: 'argon2id', params: { m: 8192, t: 3, p: 1 }, onProgress: (f) => progress.push(f) });
  } finally {
    clearInterval(iv);
  }
  assert.ok(progress.length >= 10, 'progress reported ' + progress.length + ' times');
  assert.ok(progress[progress.length - 1] <= 1 && progress[0] > 0);
  assert.ok(ticks >= 1, 'timers ran during the stretching');
});

// ------------------------------------------------------------------------------------------------ security 15

test('the 0.2.1 key leaves the site only after a backup file made after it entered the vault', async () => {
  const pub = (await client.newBoxKey()).pub;
  const res = (status) => ({ bundle: { legacy: { choice: 'keep', stored: true }, status } });
  let removed = 0;
  const removeLegacy = async () => { removed++; };
  const old = await legacyOutcome(res({ fileSaved: true, legacyBackedUp: false }), pub, { removeLegacy });
  assert.equal(old.deleteLegacy, false, 'a backup older than the migration does not hold the key');
  assert.equal(removed, 0);
  const fresh = await legacyOutcome(res({ fileSaved: true, legacyBackedUp: true }), pub, { removeLegacy });
  assert.equal(fresh.deleteLegacy, true);
  assert.equal(removed, 1);
});

test('identity page fields are 16 px, so iOS Safari does not zoom into them', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../../src/idp/idp.css', import.meta.url), 'utf8');
  const rule = /\.mw-field input, \.mw-field textarea, \.mw-mode select \{([^}]*)\}/.exec(css);
  assert.ok(rule, 'the field rule');
  assert.match(rule[1], /font-size:\s*16px/);
  assert.match(css, /\.mw-copy textarea \{[^}]*16px/);
});
