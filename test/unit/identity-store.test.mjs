// WorkingKeys on a site origin (R 2.2.5, 2.4.1, 2.12; MF-14): sign-out deletes the keys from IndexedDB,
// "Shared computer" writes nothing on this origin, follower tabs drop their state on 'signed-out', the escrow
// blobs go back to the identity origin and are authenticated there (a forged one fails), "Stay signed in" keeps
// non-extractable CryptoKeys for 30 days only where the self-test says this browser can.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import { WorkingKeys, onSignedOut, readEpoch, checkBundle, STAY_MS, DB_NAME } from '../../src/identity/store.js';
import { makeLocalProof, verifyLocalProof } from '../../src/identity/signin.js';
import * as client from '../../src/identity/client.js';
import { createIdp } from '../../src/idp/idp.js';
import { openIdoStore } from '../../src/idp/store.js';
import { verify } from '../../src/chain/crypto.js';

const IDP = 'http://localhost:9555';
const SITE = 'https://shop.example';

// ------------------------------------------------------------------------------------------------ fakes

function fakeIndexedDB({ failCryptoKey = false } = {}) {
  const dbs = new Map();
  const stats = { opens: 0, puts: 0, deletes: 0 };
  const isKey = (v) => v && typeof v === 'object' && typeof v.type === 'string' && v.algorithm;
  const hasKey = (v, depth = 0) => {
    if (isKey(v)) return true;
    if (!v || typeof v !== 'object' || depth > 4) return false;
    return Object.values(v).some((x) => hasKey(x, depth + 1));
  };
  const request = (fn) => {
    const req = { onsuccess: null, onerror: null, result: undefined, error: null };
    setImmediate(() => {
      try {
        req.result = fn();
        if (req.onsuccess) req.onsuccess({ target: req });
      } catch (err) {
        req.error = err;
        if (req.onerror) req.onerror({ target: req });
      }
    });
    return req;
  };
  const dbObject = (rec) => ({
    objectStoreNames: { contains: (s) => rec.stores.has(s) },
    createObjectStore(s) { rec.stores.set(s, new Map()); return {}; },
    transaction() {
      return {
        objectStore(name) {
          const map = rec.stores.get(name);
          if (!map) throw new Error('no object store ' + name);
          return {
            get: (k) => request(() => map.get(k)),
            put: (v, k) => request(() => {
              if (failCryptoKey && hasKey(v)) throw Object.assign(new Error('could not be cloned'), { name: 'DataCloneError' });
              stats.puts++;
              map.set(k, v);
              return k;
            }),
            delete: (k) => request(() => { stats.deletes++; map.delete(k); }),
            clear: () => request(() => map.clear()),
          };
        },
      };
    },
    close() {},
  });
  return {
    stats, dbs,
    open(name, version) {
      stats.opens++;
      const req = { onsuccess: null, onerror: null, onupgradeneeded: null, result: null };
      setImmediate(() => {
        let rec = dbs.get(name);
        const fresh = !rec;
        if (!rec) { rec = { version, stores: new Map() }; dbs.set(name, rec); }
        req.result = dbObject(rec);
        if (fresh && req.onupgradeneeded) req.onupgradeneeded({ target: req });
        if (req.onsuccess) req.onsuccess({ target: req });
      });
      return req;
    },
    deleteDatabase(name) { return request(() => dbs.delete(name)); },
    peek(dbName, store, key) {
      const rec = dbs.get(dbName);
      const map = rec && rec.stores.get(store);
      return map ? map.get(key) : undefined;
    },
  };
}

function channelBus() {
  const members = new Set();
  return (name) => {
    const ch = {
      name, listeners: new Set(), closed: false,
      addEventListener(type, fn) { if (type === 'message') ch.listeners.add(fn); },
      removeEventListener(type, fn) { ch.listeners.delete(fn); },
      postMessage(data) { for (const m of members) if (m !== ch && m.name === name && !m.closed) for (const fn of m.listeners) fn({ data }); },
      close() { ch.closed = true; members.delete(ch); },
    };
    members.add(ch);
    return ch;
  };
}

function scriptedCards(script = {}) {
  return new Proxy({ lang: 'en' }, {
    get(t, k) {
      if (k in t) return t[k];
      return async () => {
        if (script[k] !== undefined) return script[k];
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

async function bundleFrom(idp, { origin = SITE, escrow, stay = false } = {}) {
  const box = await client.newBoxKey();
  const requestId = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url');
  const req = { v: 1, t: 'mw-signin-req', requestId, purpose: 'site', want: ['keys'], epk: box.pub };
  if (escrow) req.escrow = escrow;
  const res = await idp.handleRequest(req, origin, null);
  if (!res.ok) return { res };
  const K = await client.open(client.BUNDLE_PREFIX, box.privateKey, res.bundle, { origin, requestId });
  if (stay) K.stay = true;
  return { res, K };
}

async function newIdo({ store, passkey = fakePasskey() } = {}) {
  const st = store || await openIdoStore({ memory: true });
  const idp = createIdp({ win: null, doc: null, navigator: null, location: { origin: IDP }, cards: scriptedCards(), passkey, store: st, wasm: true, ios: false, standalone: false, build: { version: '0.3.0', id: 'test0001', hash: '', test: true } });
  return { idp, store: st, passkey };
}

const okSelfTest = async () => ({ idb: true, sign: true, ecdh: true });

// ------------------------------------------------------------------------------------------------ tests

test('stay signed in keeps non-extractable CryptoKeys in IndexedDB; sign out deletes them and the keys stop working', async () => {
  const { idp } = await newIdo();
  const { K } = await bundleFrom(idp);
  const pub = K.pub;
  const idb = fakeIndexedDB();
  const bus = channelBus();
  const keys = await WorkingKeys.install(K, { stay: true, idb, selfTest: okSelfTest, channelFactory: bus });
  assert.equal(keys.storage, 'idb');
  assert.equal(K.sign.d, '', 'the bundle JSON is dropped');
  assert.equal(K.rec.key, '');
  const stored = idb.peek(DB_NAME, 'keys', 'current');
  assert.ok(stored && stored.keys.sign && stored.keys.sign.extractable === false);
  assert.ok(stored.meta.expiresAt > Date.now() + STAY_MS - 60000);
  await assert.rejects(webcrypto.subtle.exportKey('jwk', keys.identity.privateKey));
  await assert.rejects(webcrypto.subtle.exportKey('raw', keys.rec));
  const sig = await keys.sign('hello');
  assert.equal(await verify(pub, new TextEncoder().encode('hello'), sig), true);
  const back = await WorkingKeys.restore({ idb });
  assert.equal(back.pub, pub, 'a reload finds them');
  await keys.destroy();
  assert.equal(idb.peek(DB_NAME, 'keys', 'current'), undefined, 'gone from IndexedDB');
  await assert.rejects(keys.sign('x'), (e) => e.code === 'E_NOT_SIGNED_IN');
  assert.equal(await WorkingKeys.restore({ idb }), null);
});

test('without "stay signed in" the keys stay in memory; an older stored set is removed', async () => {
  const { idp } = await newIdo();
  const idb = fakeIndexedDB();
  const first = await bundleFrom(idp, { stay: true });
  await WorkingKeys.install(first.K, { stay: true, idb, selfTest: okSelfTest, channelFactory: channelBus() });
  assert.ok(idb.peek(DB_NAME, 'keys', 'current'));
  const second = await bundleFrom(idp);
  const keys = await WorkingKeys.install(second.K, { stay: false, idb, selfTest: okSelfTest, channelFactory: channelBus() });
  assert.equal(keys.storage, 'memory');
  assert.equal(idb.peek(DB_NAME, 'keys', 'current'), undefined, 'not this session\'s choice');
  assert.ok(idb.peek(DB_NAME, 'escrow', 'root'), 'the escrow blobs are kept (opaque)');
});

test('"Shared computer" writes nothing to IndexedDB on this origin: no keys, no escrow, no cache, no epoch', async () => {
  const { idp } = await newIdo();
  const { K } = await bundleFrom(idp);
  assert.ok(K.escrow && K.vaultEscrow, 'the bundle carries escrow blobs');
  const idb = fakeIndexedDB();
  const keys = await WorkingKeys.install(K, { stay: true, sharedComputer: true, idb, selfTest: okSelfTest, channelFactory: channelBus() });
  assert.equal(keys.storage, 'memory');
  await keys.saveLocal('me', { f: { display: 'Ana' }, ft: {}, t: 1 });
  assert.deepEqual(await keys.loadLocal('me'), { f: { display: 'Ana' }, ft: {}, t: 1 });
  await keys.destroy();
  assert.equal(idb.stats.opens, 0, 'IndexedDB was never opened');
  assert.equal(idb.dbs.size, 0);
});

test('stay signed in where the self-test cannot store a CryptoKey (iOS DataCloneError): memory only', async () => {
  const { idp } = await newIdo();
  const { K } = await bundleFrom(idp);
  const idb = fakeIndexedDB();
  const keys = await WorkingKeys.install(K, { stay: true, idb, selfTest: async () => ({ idb: false, sign: true, ecdh: true }), channelFactory: channelBus() });
  assert.equal(keys.storage, 'memory');
  assert.equal(idb.peek(DB_NAME, 'keys', 'current'), undefined);
  const { K: K2 } = await bundleFrom(idp);
  const failing = fakeIndexedDB({ failCryptoKey: true });
  const keys2 = await WorkingKeys.install(K2, { stay: true, idb: failing, selfTest: okSelfTest, channelFactory: channelBus() });
  assert.equal(keys2.storage, 'memory', 'a DataCloneError at the real put falls back too');
});

test('follower tabs drop their state when any tab of the origin signs out', async () => {
  const { idp } = await newIdo();
  const { K } = await bundleFrom(idp);
  const bus = channelBus();
  const heard = [];
  const off = onSignedOut((m) => heard.push(m), { channelFactory: bus });
  const keys = await WorkingKeys.install(K, { idb: null, channelFactory: bus });
  const before = await readEpoch({ idb: null });
  const { epoch } = await keys.destroy();
  assert.equal(epoch, before + 1);
  assert.deepEqual(heard, [{ epoch }]);
  off();
  await (await WorkingKeys.install((await bundleFrom(idp)).K, { idb: null, channelFactory: bus })).destroy();
  assert.equal(heard.length, 1, 'unsubscribed');
});

test('a local proof made before sign-out is refused afterwards (the local revocation epoch)', async () => {
  const { idp } = await newIdo();
  const { K } = await bundleFrom(idp);
  const keys = await WorkingKeys.install(K, { idb: null, channelFactory: channelBus() });
  const epoch = await readEpoch({ idb: null });
  const proof = await makeLocalProof({ signKey: keys.identity.privateKey, pub: keys.pub, origin: SITE, epoch });
  assert.equal((await verifyLocalProof(proof, { origin: SITE, epoch })).ok, true);
  await keys.destroy();
  const later = await readEpoch({ idb: null });
  assert.equal((await verifyLocalProof(proof, { origin: SITE, epoch: later })).reason, 'revoked');
});

test('escrow round trip: the site keeps the blobs opaquely, an evicted identity origin takes them back and authenticates them', async () => {
  const passkey = fakePasskey();
  const { idp } = await newIdo({ passkey });
  const { K } = await bundleFrom(idp);
  const pub = K.pub;
  const idb = fakeIndexedDB();
  await WorkingKeys.install(K, { idb, selfTest: okSelfTest, channelFactory: channelBus() });
  const escrow = await WorkingKeys.escrow({ idb });
  assert.ok(escrow.root && escrow.vault);
  assert.equal(escrow.root.kind, 'prf', 'opaque here: a PRF blob nobody on this origin can open');
  // The identity origin lost its storage (Safari's 7-day rule): the site's copy brings the same identity back.
  const evicted = await newIdo({ passkey });
  const back = await bundleFrom(evicted.idp, { escrow });
  assert.equal(back.res.ok, true);
  assert.equal(back.K.pub, pub);
  assert.ok(await evicted.store.getWrapped(), 'and the identity origin keeps it again');
  // A forged blob fails AES-GCM: no keys, and no new identity made behind the person's back.
  const forged = JSON.parse(JSON.stringify(escrow));
  const c = forged.root.ct;
  forged.root.ct = c.slice(0, 10) + (c[10] === 'A' ? 'B' : 'A') + c.slice(11);
  const fresh = await newIdo({ passkey });
  const bad = await bundleFrom(fresh.idp, { escrow: forged });
  assert.equal(bad.res.ok, false);
  assert.equal(await fresh.store.getWrapped(), null);
  // A blob with an attacker-chosen KDF (a huge Argon2id memory size) is not even tried.
  const { acceptEscrow } = await import('../../src/idp/store.js');
  const heavy = { root: { v: 2, kind: 'pass', salt: 'A'.repeat(22), kdf: { name: 'argon2id', m: 1048576, t: 16, p: 1 }, iv: 'A'.repeat(16), ct: 'A'.repeat(107) } };
  assert.equal(acceptEscrow(heavy).root, null);
  // Remove from this device: the blobs go as well.
  await WorkingKeys.forget({ idb });
  assert.equal(await WorkingKeys.escrow({ idb }), null);
});

test('sealed local caches open only with this label\'s K_local; the bundle shape is checked before any import', async () => {
  const { idp } = await newIdo();
  const { K } = await bundleFrom(idp);
  const { K: other } = await bundleFrom(idp, { origin: 'https://forum.example' });
  const idb = fakeIndexedDB();
  const keys = await WorkingKeys.install(K, { idb, selfTest: okSelfTest, channelFactory: channelBus() });
  const blob = await keys.saveLocal('me', { f: { notes: 'x' }, ft: { notes: 5 }, t: 5 });
  assert.deepEqual(await client.openLocal(keys.local, K.label, 'me', blob), { f: { notes: 'x' }, ft: { notes: 5 }, t: 5 });
  const otherKeys = await WorkingKeys.install(other, { idb: null, channelFactory: channelBus() });
  assert.equal(await client.openLocal(otherKeys.local, K.label, 'me', blob), null);
  assert.equal(await client.openLocal(keys.local, other.label, 'me', blob), null, 'the label is authenticated');
  assert.equal(checkBundle({ v: 1 }), 'label');
  const { K: K3 } = await bundleFrom(idp);
  const wrongPub = Object.assign({}, K3, { pub: other.pub });
  await assert.rejects(WorkingKeys.install(wrongPub, { idb: null, channelFactory: channelBus() }), (e) => e.code === 'E_BAD_REQUEST');
});

test('stay signed in expires after 30 days', async () => {
  const { idp } = await newIdo();
  const { K } = await bundleFrom(idp);
  const idb = fakeIndexedDB();
  let t = Date.now();
  await WorkingKeys.install(K, { stay: true, idb, selfTest: okSelfTest, channelFactory: channelBus(), now: () => t });
  t += STAY_MS + 1;
  assert.equal(await WorkingKeys.restore({ idb, now: () => t }), null);
  assert.equal(idb.peek(DB_NAME, 'keys', 'current'), undefined, 'an expired set is deleted');
});
