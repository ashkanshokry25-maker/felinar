// Unit tests for src/dropin/identity.js. v0.3 (lane idp): the drop-in adapter over the identity client and
// the working keys (createDropinIdentity, legacyAccess, countPostsBy), the redirect hand-off on
// /_mw/idp-return, and the one-time move of a 0.2.1 key into the identity vault. The 0.2.1 functions stay for
// migration: their export format must stay interchangeable with the shell's (src/loader/app.js), so the two
// implementations are run against each other. In-memory keys store, real WebCrypto, low PBKDF2 iterations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import * as crypto from '../../src/chain/crypto.js';
import {
  ensureIdentity, storeKey, exportIdentityText, importIdentityText, exportCurrentIdentity, importIdentity,
  createDropinIdentity, legacyAccess, countPostsBy,
} from '../../src/dropin/identity.js';
import * as shell from '../../src/loader/app.js';
import * as client from '../../src/identity/client.js';
import { createIdp } from '../../src/idp/idp.js';
import { openIdoStore } from '../../src/idp/store.js';

function memoryCache({ failCryptoKey = false } = {}) {
  const keys = new Map();
  return {
    keys,
    async saveKey(name, value) {
      if (failCryptoKey && value.kind === 'cryptokey') throw Object.assign(new Error('could not be cloned'), { name: 'DataCloneError' });
      keys.set(name, value);
    },
    async getKey(name) { return keys.get(name) || null; },
  };
}

const LEDGER = 'mw1:abcdefghijklmnopqrstuvwxyz0';

test('ensureIdentity creates an extractable identity once and finds it again', async () => {
  const cache = memoryCache();
  const first = await ensureIdentity({ cache, crypto, ledgerId: LEDGER });
  assert.equal(first.kind, 'cryptokey');
  assert.match(first.pub, /^p256:[A-Za-z0-9_-]{87}$/); // algorithm-tagged since v0.2.1 (A2)
  const stored = cache.keys.get('identity:' + LEDGER);
  assert.equal(stored.kind, 'cryptokey');
  assert.equal(stored.privateKey.extractable, true, 'extractable so the visitor can export it');
  const again = await ensureIdentity({ cache, crypto, ledgerId: LEDGER });
  assert.equal(again.pub, first.pub, 'the same identity on the next page view');
  assert.equal(cache.keys.size, 1);
});

test('ensureIdentity falls back to a stored JWK when the engine cannot clone CryptoKeys (iOS DataCloneError)', async () => {
  const cache = memoryCache({ failCryptoKey: true });
  const made = await ensureIdentity({ cache, crypto, ledgerId: LEDGER });
  assert.equal(made.kind, 'jwk');
  const stored = cache.keys.get('identity:' + LEDGER);
  assert.equal(stored.kind, 'jwk');
  assert.equal(typeof stored.jwk.d, 'string');
  assert.equal(made.privateKey.extractable, false, 'imported non-extractable for the session');
  const msg = new TextEncoder().encode('hello');
  const sig = await crypto.sign(made.privateKey, msg);
  assert.equal(await crypto.verify(made.pub, msg, sig), true, 'the session key signs for the stored public key');
  const later = await ensureIdentity({ cache, crypto, ledgerId: LEDGER });
  assert.equal(later.kind, 'jwk');
  assert.equal(later.pub, made.pub);
});

test('export then import: a different device gets the same identity back', async () => {
  const a = memoryCache();
  const made = await ensureIdentity({ cache: a, crypto, ledgerId: LEDGER });
  const text = await exportCurrentIdentity({ cache: a, crypto, ledgerId: LEDGER, passphrase: 'correct horse', iterations: 2000 });
  const obj = JSON.parse(text);
  assert.equal(obj.type, 'mw-identity');
  assert.equal(obj.v, 1);
  assert.equal(obj.ledger, LEDGER);
  assert.equal(obj.pub, made.pub);
  assert.equal(obj.iter, 2000);
  assert.ok(!text.includes('"d"'), 'the private scalar is only inside the ciphertext');
  const b = memoryCache();
  const res = await importIdentity({ cache: b, crypto, ledgerId: LEDGER, text, passphrase: 'correct horse' });
  assert.equal(res.pub, made.pub);
  const restored = await ensureIdentity({ cache: b, crypto, ledgerId: LEDGER });
  assert.equal(restored.pub, made.pub);
  const sig = await crypto.sign(restored.privateKey, 'x');
  assert.equal(await crypto.verify(made.pub, 'x', sig), true);
});

test('import refuses a wrong passphrase, tampered text, another ledger and nonsense, always as E_IDENTITY', async () => {
  const cache = memoryCache();
  await ensureIdentity({ cache, crypto, ledgerId: LEDGER });
  const text = await exportCurrentIdentity({ cache, crypto, ledgerId: LEDGER, passphrase: 'correct horse', iterations: 2000 });
  const fresh = () => ({ cache: memoryCache(), crypto, ledgerId: LEDGER });
  const bad = async (t, p) => { try { await importIdentity(Object.assign(fresh(), { text: t, passphrase: p })); return null; } catch (e) { return e.code; } };
  assert.equal(await bad(text, 'wrong passphrase'), 'E_IDENTITY');
  assert.equal(await bad('not json', 'correct horse'), 'E_IDENTITY');
  assert.equal(await bad(JSON.stringify({ type: 'something else' }), 'correct horse'), 'E_IDENTITY');
  const obj = JSON.parse(text);
  assert.equal(await bad(JSON.stringify(Object.assign({}, obj, { ledger: 'mw1:other' })), 'correct horse'), 'E_IDENTITY', 'the ledger id is authenticated data');
  assert.equal(await bad(JSON.stringify(Object.assign({}, obj, { iter: 5 })), 'correct horse'), 'E_IDENTITY', 'absurdly low iteration counts');
  assert.equal(await bad(JSON.stringify(Object.assign({}, obj, { ct: obj.ct.slice(0, -4) + 'AAAA' })), 'correct horse'), 'E_IDENTITY');
  await assert.rejects(exportIdentityText({ jwk: { d: 'x' }, pub: 'p', ledgerId: LEDGER, passphrase: 'short' }), (e) => e.code === 'E_IDENTITY');
  await assert.rejects(exportIdentityText({ jwk: {}, pub: 'p', ledgerId: LEDGER, passphrase: 'long enough' }), (e) => e.code === 'E_IDENTITY');
  await assert.rejects(exportCurrentIdentity({ cache: memoryCache(), crypto, ledgerId: LEDGER, passphrase: 'long enough' }), (e) => e.code === 'E_IDENTITY' && /no identity/.test(e.message));
});

test('the format is the shell\'s: each side imports what the other exports', async () => {
  const pair = await crypto.generateKeyPair({ extractable: true });
  const pub = await crypto.exportPublicKey(pair.publicKey);
  const jwk = await crypto.exportPrivateJwk(pair.privateKey);
  const fromShell = await shell.exportIdentityText({ jwk, pub, ledgerId: LEDGER, passphrase: 'correct horse', iterations: 2000 });
  const intoDropin = await importIdentityText(fromShell, 'correct horse', { publicFromPrivateJwk: crypto.publicFromPrivateJwk });
  assert.equal(intoDropin.pub, pub);
  assert.equal(intoDropin.ledgerId, LEDGER);
  assert.equal(intoDropin.jwk.d, jwk.d);
  const fromDropin = await exportIdentityText({ jwk, pub, ledgerId: LEDGER, passphrase: 'correct horse', iterations: 2000 });
  const intoShell = await shell.importIdentityText(fromDropin, 'correct horse', { publicFromPrivateJwk: crypto.publicFromPrivateJwk });
  assert.equal(intoShell.pub, pub);
  assert.equal(intoShell.jwk.d, jwk.d);
});

test('storeKey stores a JWK directly when there is no pair', async () => {
  const cache = memoryCache();
  const pair = await crypto.generateKeyPair({ extractable: true });
  const pub = await crypto.exportPublicKey(pair.publicKey);
  const jwk = await crypto.exportPrivateJwk(pair.privateKey);
  const out = await storeKey(cache, crypto, 'moderator:x', { jwk, pub });
  assert.equal(out.kind, 'jwk');
  assert.equal(cache.keys.get('moderator:x').kind, 'jwk');
  assert.equal(out.pub, pub);
});

test('code review round 1: concurrent creation stores one identity (addKey) and both callers use it', async () => {
  const keys = new Map();
  const yieldNow = () => new Promise((resolve) => setImmediate(resolve));
  const cache = {
    async getKey(name) { await yieldNow(); return keys.get(name) || null; },
    async saveKey(name, value) { await yieldNow(); keys.set(name, value); },
    async addKey(name, value) { await yieldNow(); if (keys.has(name)) return false; keys.set(name, value); return true; },
  };
  const [a, b] = await Promise.all([ensureIdentity({ cache, crypto, ledgerId: LEDGER }), ensureIdentity({ cache, crypto, ledgerId: LEDGER })]);
  assert.equal(a.pub, b.pub);
  assert.equal(keys.get('identity:' + LEDGER).pub, a.pub);
  assert.equal(keys.get('identity:' + LEDGER).kind, 'cryptokey');
  // storeKey without add (import, moderator key) still replaces what is there.
  const jwk = await crypto.exportPrivateJwk((await crypto.generateKeyPair({ extractable: true })).privateKey);
  const out = await storeKey(cache, crypto, 'identity:' + LEDGER, { jwk, pub: 'p256:replaced' });
  assert.equal(out.kind, 'jwk');
  assert.equal(keys.get('identity:' + LEDGER).pub, 'p256:replaced');
});

// ------------------------------------------------------------------------------------------------ v0.3 adapter

test('v0.3: ensureIdentity({ create: false }) only reads; legacyAccess never offers a moderator key', async () => {
  const cache = memoryCache();
  assert.equal(await ensureIdentity({ cache, crypto, ledgerId: LEDGER, create: false }), null);
  assert.equal(cache.keys.size, 0, 'nothing is made on a v0.3 page');
  const deleted = [];
  cache.deleteKey = async (name) => { deleted.push(name); cache.keys.delete(name); };
  const access = legacyAccess({ cache, ledgerId: LEDGER, write: async (item) => item });
  assert.equal(await access.get(), null);
  const made = await ensureIdentity({ cache, crypto, ledgerId: LEDGER });
  assert.equal((await access.get()).pub, made.pub);
  cache.keys.set('moderator:' + LEDGER, { kind: 'jwk', jwk: { d: 'x' }, pub: 'p256:mod' });
  assert.equal((await access.get()).pub, made.pub, 'the visitor key, never the moderator key');
  assert.equal(await access.write({ l: 'mw.link', v: {} }), true);
  await access.remove();
  assert.deepEqual(deleted, ['identity:' + LEDGER]);
  assert.equal(await access.get(), null);
});

test('v0.3: countPostsBy counts the payload entries one key wrote (the "Found N posts" answer)', () => {
  const blocks = [
    { e: { author: 'p256:a', op: { t: 'append', l: 'mw.post' } } },
    { e: { author: 'p256:a', op: { t: 'put', k: 'x' } } },
    { e: { author: 'p256:a', op: { t: 'tombstone', h: '00' } } },
    { e: { author: 'p256:b', op: { t: 'append', l: 'mw.post' } } },
    { e: { author: 'p256:a', op: { t: 'profile' } } },
  ];
  assert.equal(countPostsBy({ exportBlocks: () => blocks }, 'p256:a'), 3);
  assert.equal(countPostsBy({ exportBlocks: () => blocks }, 'p256:c'), 0);
  assert.equal(countPostsBy(null, 'p256:a'), null);
});

function scriptedCards() {
  return new Proxy({ lang: 'en' }, {
    get(t, k) {
      if (k in t) return t[k];
      return async () => {
        if (k === 'signin') return { action: 'continue', mode: { kind: 'private' }, stay: false, sharedComputer: false, hub: null };
        if (k === 'chooseUnlock') return { method: 'passkey', nickname: 'test' };
        if (k === 'legacy') return 'keep';
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

function processClient(idp, origin) {
  return {
    async signIn(raw) {
      const opts = await client.resolveLate(raw);
      const want = opts.want || ['keys'];
      const box = await client.newBoxKey();
      const requestId = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url');
      const req = { v: 1, t: 'mw-signin-req', requestId, purpose: 'site', want, epk: box.pub };
      if (opts.legacy) req.legacy = { pub: opts.legacy.pub, ledger: opts.legacy.ledger };
      if (opts.escrow) req.escrow = opts.escrow;
      const channel = {
        async ask(message) {
          if (message.t !== 'mw-idp-legacy') return null;
          const jwk = await opts.legacy.exportKey();
          return { t: 'mw-idp-legacy-res', requestId, sealed: await client.seal(client.LEGACY_PREFIX, message.epk, { jwk }, { origin, requestId }) };
        },
      };
      const res = await idp.handleRequest(req, origin, channel);
      if (!res.ok) throw Object.assign(new Error(res.code), { code: res.code });
      return { bundle: await client.open(client.BUNDLE_PREFIX, box.privateKey, res.bundle, { origin, requestId }) };
    },
    async completeRedirect() { return null; },
    async takeDeferredAnswer() { return null; },
    async openIdentity() { return 'done'; },
  };
}

function pageWindow(href, { meta = false } = {}) {
  const u = new URL(href);
  return {
    location: { origin: u.origin, href, pathname: u.pathname, hash: '', replaced: null, replace(x) { this.replaced = x; } },
    document: { querySelector: (sel) => (meta && sel === 'meta[name="mw-idp-return"]' ? {} : null) },
  };
}

test('v0.3: the adapter signs in through the identity origin and moves the 0.2.1 key into the vault (keep links them)', async () => {
  const origin = 'https://blog.example';
  const store = await openIdoStore({ memory: true });
  const idp = createIdp({ win: null, doc: null, navigator: null, location: { origin: 'http://localhost:9555' }, cards: scriptedCards(), passkey: fakePasskey(), store, wasm: true, ios: false, standalone: false, build: { version: '0.3.0', id: 'test0001', hash: '', test: true } });
  const cache = memoryCache();
  const old = await ensureIdentity({ cache, crypto, ledgerId: LEDGER });
  const written = [];
  const keysSeen = [];
  const dropin = createDropinIdentity({
    win: pageWindow(origin + '/post/1'), cache, ledgerId: LEDGER, client: processClient(idp, origin), idb: null, channelFactory: () => null,
    writeLegacy: async (item) => written.push(item), onKeys: (k) => keysSeen.push(k),
  });
  assert.equal(await dropin.boot(), false, 'no stay-signed-in keys yet');
  const r = await dropin.service.methods['auth.signIn']({}, { activation: true, tab: 'leader' });
  assert.equal(r.state, 'signed-in');
  assert.notEqual(r.identity.pub, old.pub, 'the new key comes from the identity origin');
  assert.equal(written.length, 1);
  assert.deepEqual([written[0].l, written[0].v.from, written[0].v.to], ['mw.link', old.pub, r.identity.pub]);
  assert.ok(cache.keys.get('identity:' + LEDGER), 'the old key stays until a backup file exists');
  assert.equal(keysSeen[keysSeen.length - 1].pub, r.identity.pub);
  await dropin.destroy();
});

test('v0.3: on /_mw/idp-return the adapter keeps the sealed answer for this tab and goes back; the page then adopts it', async () => {
  const origin = 'https://blog.example';
  const calls = [];
  const fake = {
    async completeRedirect(opts) { calls.push(['complete', opts.defer]); return { deferred: true, returnTo: origin + '/post/1' }; },
    async takeDeferredAnswer() { calls.push(['take']); return null; },
    async signIn() { throw new Error('not used'); },
  };
  const ret = pageWindow(origin + '/_mw/idp-return', { meta: true });
  const onReturn = createDropinIdentity({ win: ret, cache: memoryCache(), ledgerId: LEDGER, client: fake, idb: null, channelFactory: () => null });
  assert.equal(await onReturn.boot(), false);
  assert.deepEqual(calls, [['complete', true]], 'defer: the answer is not opened on the return page');
  assert.equal(ret.location.replaced, origin + '/post/1');
  await onReturn.destroy();
  const page = pageWindow(origin + '/post/1');
  const onPage = createDropinIdentity({ win: page, cache: memoryCache(), ledgerId: LEDGER, client: fake, idb: null, channelFactory: () => null });
  assert.equal(await onPage.boot(), false, 'no answer waiting and no stored keys');
  assert.deepEqual(calls[1], ['take']);
  await onPage.destroy();
});
