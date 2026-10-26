// Identity core, vault and backup file (R 2.2.2, 2.2.6, 2.2.7; test U-ID-5 parts; MF-18, MF-19):
// random per-label keys, shred, the vault blob, a phrase-only restore that cannot open the vault,
// the mw-identity-v3 backup file round trip, the passphrase helper and floor, and the import of
// the 0.2.1 export into vault.legacy. Plus check.js selfTest in Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import {
  Vault, makeBackupFile, openBackupFile, parseLegacyExport, isLegacyExport, generatePassphrase, passphraseStrength, CHAT_EPOCH_MS,
} from '../../src/identity/vault.js';
import * as d from '../../src/identity/derive.js';
import { isOnCurve, bytesToBigInt } from '../../src/identity/p256.js';
import { selfTest } from '../../src/identity/check.js';
import { exportIdentityText } from '../../src/loader/app.js';
import { generateKeyPair, exportPublicKey, exportPrivateJwk } from '../../src/chain/crypto.js';
import { b64url, hex } from '../../src/chain/canonical.js';

const T = Date.UTC(2026, 9, 20, 12, 0, 0);
const L1 = 'o|https://shop.example';
const L2 = 'l|mw1:abcdefghijklmnopqrstuvwxyz0';

test('U-ID-5 vault labels hold random chat, record, own and local keys', async () => {
  const a = Vault.create();
  const b = Vault.create();
  assert.equal(a.kVault.length, 32);
  assert.notDeepEqual(a.kVault, b.kVault);
  const ea = a.vault.label(L1, { now: T });
  const eb = b.vault.label(L1, { now: T });
  assert.deepEqual(Object.keys(ea).sort(), ['chat', 'contacts', 'i', 'links', 'local', 'own', 'rec', 'sites']);
  assert.equal(ea.i, 1);
  assert.equal(ea.chat.length, 1);
  assert.equal(ea.chat[0].e, 1);
  assert.equal(ea.chat[0].exp, T + CHAT_EPOCH_MS);
  assert.notEqual(ea.chat[0].jwk.d, eb.chat[0].jwk.d, 'random, not derived from anything shared');
  assert.notEqual(ea.rec[0].key, eb.rec[0].key);
  assert.notEqual(ea.own, eb.own);
  assert.notEqual(ea.local, eb.local);
  assert.equal(b64url.decode(ea.rec[0].key).length, 32);
  // The chat key is a valid P-256 ECDH key pair.
  const jwk = ea.chat[0].jwk;
  assert.ok(isOnCurve(bytesToBigInt(b64url.decode(jwk.x)), bytesToBigInt(b64url.decode(jwk.y))));
  const priv = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const other = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  assert.equal((await crypto.subtle.deriveBits({ name: 'ECDH', public: other.publicKey }, priv, 256)).byteLength, 32);
  assert.equal(a.vault.currentChat(L1, T).pub, d.publicKeyOf(b64url.decode(jwk.d)));
  assert.equal(a.vault.currentChat(L1, T + CHAT_EPOCH_MS), null, 'expired epoch');
  assert.equal(a.vault.label('o|https://none.example', { create: false }), null);
  assert.throws(() => a.vault.label('shop.example'), TypeError);
});

test('U-ID-5 rotation, new record epochs and shred retire keys', () => {
  const { vault } = Vault.create();
  vault.label(L1, { now: T });
  const e2 = vault.rotateChat(L1, { now: T + 1 });
  assert.equal(e2.e, 2);
  assert.equal(vault.label(L1).chat.length, 2);
  assert.equal(vault.newRecordKey(L1).r, 2);
  assert.equal(vault.bumpSignIndex(L1), 2);
  assert.equal(vault.shred(L1, { chat: 1 }), true);
  assert.deepEqual(vault.label(L1).chat.map((c) => c.e), [2]);
  assert.equal(vault.shred(L1, { rec: 1 }), true);
  assert.deepEqual(vault.label(L1).rec.map((r) => r.r), [2]);
  assert.equal(vault.shred(L1, { rec: 9 }), false);
  assert.equal(vault.shred(L1, 'own'), true);
  assert.equal(vault.label(L1).own, null);
  assert.equal(vault.shred(L1, 'own'), false);
  assert.equal(vault.shred(L1, 'chat'), true);
  assert.equal(vault.label(L1).chat.length, 0);
  assert.equal(vault.rotateChat(L1, { now: T }).e, 1, 'a new epoch after a full shred');
  assert.equal(vault.shred(L1, 'all'), true);
  assert.equal(vault.label(L1, { create: false }), null);
  assert.equal(vault.shred('o|https://none.example', 'all'), false);
  assert.throws(() => vault.shred(L2, 'everything'), TypeError);
});

test('links (same identity) and the local list of sites', () => {
  const { vault } = Vault.create();
  vault.linkOrigin('https://forum.example', L1, T);
  vault.linkOrigin('https://blog.example', L1, T);
  vault.linkOrigin('https://forum.example', L2, T); // re-link moves it
  assert.deepEqual(vault.links(), { 'https://blog.example': L1, 'https://forum.example': L2 });
  assert.equal(vault.unlinkOrigin('https://blog.example'), true);
  assert.equal(vault.unlinkOrigin('https://blog.example'), false);
  vault.addSite(L1, 'https://shop.example', T);
  vault.addSite(L1, 'https://shop.example', T + 5);
  assert.deepEqual(vault.label(L1).sites, [{ origin: 'https://shop.example', t: T }]);
  assert.throws(() => vault.addSite(L1, 'https://shop.example/path', T), TypeError);
});

test('U-ID-5 vault blob round trip; the wrong key fails', async () => {
  const { vault, kVault } = Vault.create();
  vault.label(L1, { now: T }).contacts.push({ name: 'Ana', pub: 'p256:x' });
  vault.label(L2, { now: T });
  const blob = await vault.toBlob(kVault, { id: 'vault-1' });
  assert.deepEqual(Object.keys(blob).sort(), ['ct', 'id', 'iv', 'kind', 'v']);
  const back = await Vault.open(kVault, blob);
  assert.deepEqual(back.toJSON(), vault.toJSON());
  await assert.rejects(() => Vault.open(new Uint8Array(randomBytes(32)), blob), (e) => e.code === 'E_VAULT');
  await assert.rejects(() => Vault.open(new Uint8Array(31), blob), (e) => e.code === 'E_VAULT');
});

test('U-ID-5 a phrase-only restore recovers public keys but cannot open the vault', async () => {
  const root = d.newRoot();
  const phrase = d.rootToPhrase(root);
  const rs = await d.rootStar(root);
  const { vault, kVault } = Vault.create();
  vault.label(L1, { now: T });
  const blob = await vault.toBlob(kVault);
  // Restore from the words alone: the same public identity...
  const restored = await d.rootStar(d.phraseToRoot(phrase));
  assert.equal((await d.deriveLabel(restored, L1)).pub, (await d.deriveLabel(rs, L1)).pub);
  // ...and every key the phrase can derive fails to open the vault (K_vault is random).
  const candidates = [
    restored, await d.kVaultHash(restored), await d.labelSeed(restored, L1), await d.kName(await d.labelSeed(restored, L1)),
    await d.hkdf(restored, new Uint8Array(0), 'vault|2', 32), await d.hkdf(restored, 'mw/id/v2', 'vault', 32),
  ];
  for (const k of candidates) {
    assert.notDeepEqual(k, kVault);
    await assert.rejects(() => Vault.open(k, blob), (e) => e.code === 'E_VAULT');
  }
  // The vault's keys are not derivable either: none equals a derived value.
  const entry = vault.label(L1);
  const derived = new Set(candidates.map((c) => hex.encode(c)));
  for (const k of [entry.own, entry.local, entry.rec[0].key]) assert.ok(!derived.has(hex.encode(b64url.decode(k))));
});

test('U-ID-5 backup file mw-identity-v3 round trip; wrong passphrase and weak passphrases refused', async () => {
  const rootStar = new Uint8Array(randomBytes(32));
  const { vault, kVault } = Vault.create();
  vault.label(L1, { now: T });
  vault.addLegacy({ ledger: 'mw1:x', pub: 'p256:legacy', jwk: { x: 'a', y: 'b', d: 'c' } }, T);
  const pass = generatePassphrase();
  const text = await makeBackupFile({ rootStar, kVault, vault }, pass, { kdf: 'argon2id', params: { m: 256, t: 1, p: 1 } });
  const obj = JSON.parse(text);
  assert.deepEqual(Object.keys(obj).sort(), ['ct', 'iv', 'kdf', 'params', 'salt', 'type', 'v']);
  assert.equal(obj.type, 'mw-identity');
  assert.equal(obj.v, 3);
  assert.equal(obj.kdf, 'argon2id');
  assert.deepEqual(obj.params, { m: 256, t: 1, p: 1 });
  assert.ok(!text.includes(b64url.encode(rootStar)), 'no secret in clear');
  const back = await openBackupFile(text, pass);
  assert.deepEqual(back.rootStar, rootStar);
  assert.deepEqual(back.kVault, kVault);
  assert.deepEqual(back.vault.toJSON(), vault.toJSON());
  await assert.rejects(() => openBackupFile(text, pass + 'x'), (e) => e.code === 'E_BACKUP');
  // A swapped KDF parameter fails AEAD (the header is bound).
  await assert.rejects(() => openBackupFile(JSON.stringify(Object.assign({}, obj, { params: { m: 512, t: 1, p: 1 } })), pass), (e) => e.code === 'E_BACKUP');
  await assert.rejects(() => openBackupFile('not json', pass), (e) => e.code === 'E_BACKUP');
  // Weak passphrases are refused unless the caller (a test) says otherwise.
  await assert.rejects(() => makeBackupFile({ rootStar, kVault, vault }, 'password123'), (e) => e.code === 'E_WEAK_PASSPHRASE');
  // PBKDF2 at the default 600,000 iterations, named in the file.
  const pb = await makeBackupFile({ rootStar, kVault, vault }, pass, { kdf: 'pbkdf2' });
  assert.equal(JSON.parse(pb).kdf, 'pbkdf2-sha256');
  assert.deepEqual(JSON.parse(pb).params, { iter: 600000 });
  assert.deepEqual((await openBackupFile(pb, pass)).rootStar, rootStar);
});

test('generated passphrases: 6 distinct BIP-39 words that pass the stated floor', () => {
  for (let i = 0; i < 50; i++) {
    const p = generatePassphrase();
    const words = p.split('-');
    assert.equal(words.length, 6);
    assert.equal(new Set(words).size, 6);
    const s = passphraseStrength(p);
    assert.equal(s.ok, true, p);
    assert.equal(s.bits, 66);
  }
  assert.equal(passphraseStrength('password123').ok, false);
  assert.equal(passphraseStrength('short').reason, 'short');
  assert.equal(passphraseStrength('aaaaaaaaaaaaaaaaaaaa').ok, false, 'repeats count once');
  assert.equal(passphraseStrength('Tr0ub4dor&3-horse-Battery!').ok, true);
  assert.equal(passphraseStrength('zoo zoo zoo zoo zoo zoo').ok, false);
  assert.throws(() => generatePassphrase(5), RangeError);
});

test('U-ID-5 legacy import: the 0.2.1 export (src/loader/app.js exportIdentityText) into vault.legacy', async () => {
  const kp = await generateKeyPair({ extractable: true });
  const pub = await exportPublicKey(kp.publicKey);
  const jwk = await exportPrivateJwk(kp.privateKey);
  const text = await exportIdentityText({ jwk, pub, ledgerId: 'mw1:legacyledger000000000000', passphrase: 'old passphrase', iterations: 2000 });
  assert.equal(isLegacyExport(text), true);
  assert.equal(isLegacyExport('{"type":"mw-identity","v":3}'), false);
  const rec = await parseLegacyExport(text, 'old passphrase');
  assert.equal(rec.pub, pub);
  assert.equal(rec.ledger, 'mw1:legacyledger000000000000');
  assert.equal(rec.jwk.d, jwk.d);
  await assert.rejects(() => parseLegacyExport(text, 'wrong'), (e) => e.code === 'E_LEGACY');
  // A file whose recorded pub was changed is refused (AAD binds it).
  await assert.rejects(() => parseLegacyExport(JSON.stringify(Object.assign(JSON.parse(text), { pub: d.publicKeyOf(d.scalar(new Uint8Array(48))) })), 'old passphrase'), (e) => e.code === 'E_LEGACY');
  const { vault, kVault } = Vault.create();
  assert.equal(vault.addLegacy(rec, T), true);
  assert.equal(vault.addLegacy(rec, T), false, 'once');
  const back = await Vault.open(kVault, await vault.toBlob(kVault));
  assert.equal(back.toJSON().legacy[0].pub, pub);
  assert.equal(back.toJSON().legacy[0].jwk.d, jwk.d);
});

test('check.js selfTest in Node: sign and ECDH work, no IndexedDB', async () => {
  assert.deepEqual(await selfTest(globalThis.crypto), { idb: false, sign: true, ecdh: true });
  assert.deepEqual(await selfTest(null), { idb: false, sign: false, ecdh: false });
  assert.deepEqual(await selfTest({ subtle: { generateKey: async () => { throw new Error('no'); } } }), { idb: false, sign: false, ecdh: false });
});
