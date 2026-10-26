// src/identity/store.js: the working keys of one label on a site origin (R 2.2.5, 2.4.1, 2.12; MF-14, MF-15;
// INTERFACES v0.3 store.js).
//
//   WorkingKeys.install(bundle, { stay, sharedComputer }) imports every scalar of the IdO bundle as a
//   non-extractable CryptoKey and drops the JSON: sign (ECDSA), chat (ECDH), rec, own, local (AES-GCM), name
//   (HMAC). "Stay signed in" keeps the CryptoKeys in IndexedDB for 30 days when the self-test shows this browser
//   can store them (iOS has thrown DataCloneError: then memory only); otherwise they live in memory. "Shared
//   computer" writes nothing to IndexedDB on this origin: no keys, no escrow, no caches, no epoch.
//   The escrow blobs (the IdO's wrapped root and vault, opaque here) are kept unless the computer is shared,
//   and go back to the IdO with the next request (WorkingKeys.escrow()).
//   destroy() deletes the keys from memory and IndexedDB, bumps the local revocation epoch and broadcasts
//   { t: 'signed-out', epoch } on BroadcastChannel 'mw-identity', so follower tabs drop their state.
//   destroy({ forget: true }) also removes the escrow blobs and the sealed caches ("Remove from this device").
//
// "Code on a site you are signed in to can copy your keys for that site" (R 2.14.2): non-extractable keeps a
// casual script from reading the scalars; it is not a boundary against the site's own code.
//
// Shared code: Node >= 22 and browsers; indexedDB, BroadcastChannel and crypto are injectable.

import { b64url, utf8 } from '../chain/canonical.js';
import { verify, publicKeyBytes, isPublicKeyString } from '../chain/crypto.js';
import { selfTest as defaultSelfTest } from './check.js';
import { sealLocal, openLocal } from './client.js';

export const DB_NAME = 'mw-identity';
export const DB_VERSION = 1;
export const STAY_MS = 30 * 24 * 3600 * 1000;
export const CHANNEL_NAME = 'mw-identity';
const STORES = ['keys', 'escrow', 'meta', 'cache'];
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const SELFTEST_MSG = utf8.encode('mw-selftest-v1');

const storeError = (code, message) => Object.assign(new Error(message), { code });

function subtle(cryptoApi) {
  const c = cryptoApi || globalThis.crypto;
  if (!c || !c.subtle) throw storeError('E_UNSUPPORTED', 'WebCrypto is unavailable');
  return c.subtle;
}

function idbReq(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function openDb(idb) {
  const open = idb.open(DB_NAME, DB_VERSION);
  open.onupgradeneeded = () => {
    for (const s of STORES) if (!open.result.objectStoreNames.contains(s)) open.result.createObjectStore(s);
  };
  return idbReq(open);
}

async function withStore(idb, name, mode, fn) {
  const db = await openDb(idb);
  try {
    return await fn(db.transaction(name, mode).objectStore(name));
  } finally {
    db.close();
  }
}

function defaultIdb() {
  return typeof indexedDB !== 'undefined' ? indexedDB : null;
}

function defaultChannel(name) {
  return typeof BroadcastChannel === 'function' ? new BroadcastChannel(name) : null;
}

// ---------------------------------------------------------------------------------------------
// The local revocation epoch (R 2.4.1): sign-out increments it; local proofs of an earlier epoch are refused.
// ---------------------------------------------------------------------------------------------

const EPOCH = { value: 0, loaded: false };

/** readEpoch({ idb }) -> the current epoch (memory, then IndexedDB). */
export async function readEpoch({ idb = defaultIdb() } = {}) {
  if (!EPOCH.loaded && idb) {
    try {
      const v = await withStore(idb, 'meta', 'readonly', (s) => idbReq(s.get('epoch')));
      if (Number.isSafeInteger(v) && v > EPOCH.value) EPOCH.value = v;
    } catch (_) {
      // no storage: memory only
    }
    EPOCH.loaded = true;
  }
  return EPOCH.value;
}

/** bumpEpoch({ idb, persist }) -> the new epoch; persist false (shared computer) keeps it in memory. */
export async function bumpEpoch({ idb = defaultIdb(), persist = true } = {}) {
  await readEpoch({ idb: persist ? idb : null });
  EPOCH.value += 1;
  if (persist && idb) {
    try { await withStore(idb, 'meta', 'readwrite', (s) => idbReq(s.put(EPOCH.value, 'epoch'))); } catch (_) { /* memory only */ }
  }
  return EPOCH.value;
}

/** noteEpoch(n): a follower tab learns a newer epoch from the channel. */
export function noteEpoch(n) {
  if (Number.isSafeInteger(n) && n > EPOCH.value) EPOCH.value = n;
  return EPOCH.value;
}

// ---------------------------------------------------------------------------------------------
// Follower tabs
// ---------------------------------------------------------------------------------------------

/**
 * onSignedOut(fn, { channelFactory }) -> unsubscribe. fn({ epoch }) runs when another tab of this origin
 * signs out (it holds no keys; it drops its signed-in state and its local proofs).
 */
export function onSignedOut(fn, { channelFactory = defaultChannel } = {}) {
  const ch = channelFactory(CHANNEL_NAME);
  if (!ch) return () => {};
  const handler = (ev) => {
    const d = ev && ev.data;
    if (d && d.t === 'signed-out') {
      noteEpoch(d.epoch);
      try { fn({ epoch: d.epoch }); } catch (_) { /* a listener must not break the channel */ }
    }
  };
  if (typeof ch.addEventListener === 'function') ch.addEventListener('message', handler);
  else ch.onmessage = handler;
  return () => {
    try {
      if (typeof ch.removeEventListener === 'function') ch.removeEventListener('message', handler);
      ch.close();
    } catch (_) { /* closed */ }
  };
}

function broadcast(msg, channelFactory) {
  const ch = channelFactory(CHANNEL_NAME);
  if (!ch) return false;
  try {
    ch.postMessage(msg);
    return true;
  } finally {
    try { ch.close(); } catch (_) { /* closed */ }
  }
}

// ---------------------------------------------------------------------------------------------
// Bundle checks and imports
// ---------------------------------------------------------------------------------------------

function b64ok(s, n) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) return false;
  try {
    return n === undefined || b64url.decode(s).length === n;
  } catch (_) {
    return false;
  }
}

/** checkBundle(K) -> null when the decrypted bundle has the R 2.3.3 shape, else a reason. */
export function checkBundle(K) {
  if (!K || typeof K !== 'object') return 'shape';
  if (K.v !== 1) return 'version';
  if (K.keyMode !== 'visit-only' && (typeof K.label !== 'string' || !/^[olh]\|./.test(K.label))) return 'label';
  if (['pairwise', 'ledger', 'hub', 'linked', 'visit-only'].indexOf(K.keyMode) < 0) return 'keyMode';
  if (!isPublicKeyString(K.pub)) return 'pub';
  const s = K.sign;
  if (!s || !b64ok(s.d, 32) || !b64ok(s.x, 32) || !b64ok(s.y, 32) || !Number.isSafeInteger(s.i) || s.i < 1) return 'sign';
  const c = K.chat;
  if (!c || !b64ok(c.d, 32) || !b64ok(c.x, 32) || !b64ok(c.y, 32) || !Number.isSafeInteger(c.e) || !Number.isSafeInteger(c.exp) || !isPublicKeyString(c.pub)) return 'chat';
  if (!K.rec || !Number.isSafeInteger(K.rec.r) || !b64ok(K.rec.key, 32)) return 'rec';
  for (const k of ['own', 'local', 'name']) if (!b64ok(K[k], 32)) return k;
  return null;
}

function rawOf(b64) {
  return b64url.decode(b64);
}

async function importSet(K, cryptoApi) {
  const s = subtle(cryptoApi);
  const sign = await s.importKey('jwk', { kty: 'EC', crv: 'P-256', x: K.sign.x, y: K.sign.y, d: K.sign.d }, ECDSA, false, ['sign']);
  const chat = await s.importKey('jwk', { kty: 'EC', crv: 'P-256', x: K.chat.x, y: K.chat.y, d: K.chat.d }, ECDH, false, ['deriveBits']);
  const aes = async (b64) => {
    const raw = rawOf(b64);
    try {
      return await s.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    } finally {
      raw.fill(0);
    }
  };
  const rec = await aes(K.rec.key);
  const own = await aes(K.own);
  const local = await aes(K.local);
  const nameRaw = rawOf(K.name);
  let name;
  try {
    name = await s.importKey('raw', nameRaw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  } finally {
    nameRaw.fill(0);
  }
  return { sign, chat, rec, own, local, name };
}

function dropSecrets(K) {
  // The bundle JSON is dropped once the keys exist (R 2.3.3): strings cannot be zeroed, so drop every reference.
  try {
    if (K.sign) K.sign.d = '';
    if (K.chat) K.chat.d = '';
    if (K.rec) K.rec.key = '';
    K.own = '';
    K.local = '';
    K.name = '';
  } catch (_) {
    // a frozen object: nothing to do
  }
}

// ---------------------------------------------------------------------------------------------
// WorkingKeys
// ---------------------------------------------------------------------------------------------

export class WorkingKeys {
  constructor(meta, keys, { storage, idb, cryptoApi, channelFactory, sharedComputer }) {
    this.meta = meta;
    this.keys = keys;
    this.storage = storage; // 'memory' | 'idb'
    this._idb = idb;
    this._crypto = cryptoApi;
    this._channel = channelFactory;
    this.sharedComputer = Boolean(sharedComputer);
    this._caches = new Map();
    this.destroyed = false;
  }

  /**
   * install(bundle, { stay, sharedComputer, idb, cryptoApi, selfTest, channelFactory, now }) -> WorkingKeys
   * bundle: the decrypted K of R 2.3.3 (client.signIn's `bundle`); its secret fields are emptied here.
   */
  static async install(bundle, { stay = false, sharedComputer = false, idb, cryptoApi, selfTest = defaultSelfTest, channelFactory = defaultChannel, now = () => Date.now() } = {}) {
    const why = checkBundle(bundle);
    if (why) throw storeError('E_BAD_REQUEST', 'the key bundle is malformed (' + why + ')');
    const shared = sharedComputer === true || bundle.keyMode === 'visit-only';
    const db = shared ? null : (idb === undefined ? defaultIdb() : idb);
    let keys;
    try {
      keys = await importSet(bundle, cryptoApi);
    } finally {
      dropSecrets(bundle);
    }
    // The imported key must sign for the bundle's public key (no second prompt: the self-test reuses it).
    const sig = new Uint8Array(await subtle(cryptoApi).sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.sign, SELFTEST_MSG));
    if (!(await verify(bundle.pub, SELFTEST_MSG, sig))) throw storeError('E_BAD_REQUEST', 'the key bundle does not match its public key');
    const meta = {
      v: 1, label: bundle.label, keyMode: bundle.keyMode, pub: bundle.pub, short: bundle.short || null, ledger: bundle.ledger || null,
      i: bundle.sign.i, rc: bundle.rc || null, nextPubHash: bundle.nextPubHash || null, status: bundle.status || null,
      chat: { pub: bundle.chat.pub, e: bundle.chat.e, exp: bundle.chat.exp }, r: bundle.rec.r,
      rotateNotice: bundle.rotateNotice || null, expiresAt: null,
    };
    let storage = 'memory';
    if (db) {
      if (bundle.escrow || bundle.vaultEscrow) {
        try {
          await withStore(db, 'escrow', 'readwrite', async (s) => {
            if (bundle.escrow) await idbReq(s.put(bundle.escrow, 'root'));
            if (bundle.vaultEscrow) await idbReq(s.put(bundle.vaultEscrow, 'vault'));
          });
        } catch (_) {
          // the IdO still has its own copy
        }
      }
      if (stay !== true) {
        // Keys an earlier "Stay signed in" session left here are not this session's choice: they go.
        try { await withStore(db, 'keys', 'readwrite', (s) => idbReq(s.delete('current'))); } catch (_) { /* nothing stored */ }
      }
      if (stay === true) {
        let canStore = false;
        try {
          const st = await selfTest(cryptoApi || globalThis.crypto, { indexedDB: db });
          canStore = st && st.idb === true && st.sign === true;
        } catch (_) {
          canStore = false;
        }
        if (canStore) {
          meta.expiresAt = now() + STAY_MS;
          try {
            await withStore(db, 'keys', 'readwrite', (s) => idbReq(s.put({ meta, keys }, 'current')));
            storage = 'idb';
          } catch (_) {
            storage = 'memory'; // DataCloneError after all: re-fetched from the IdO with one tap
            meta.expiresAt = null;
          }
        }
      }
    }
    return new WorkingKeys(meta, keys, { storage, idb: db, cryptoApi, channelFactory, sharedComputer: shared });
  }

  /** restore({ idb, cryptoApi, now }) -> WorkingKeys | null: "Stay signed in" after a reload. */
  static async restore({ idb = defaultIdb(), cryptoApi, channelFactory = defaultChannel, now = () => Date.now() } = {}) {
    if (!idb) return null;
    let rec = null;
    try {
      rec = await withStore(idb, 'keys', 'readonly', (s) => idbReq(s.get('current')));
    } catch (_) {
      return null;
    }
    if (!rec || !rec.meta || !rec.keys || !rec.keys.sign) return null;
    if (!Number.isSafeInteger(rec.meta.expiresAt) || rec.meta.expiresAt <= now()) {
      try { await withStore(idb, 'keys', 'readwrite', (s) => idbReq(s.delete('current'))); } catch (_) { /* gone */ }
      return null;
    }
    return new WorkingKeys(rec.meta, rec.keys, { storage: 'idb', idb, cryptoApi, channelFactory, sharedComputer: false });
  }

  /** escrow({ idb }) -> { root?, vault? } | null: the opaque blobs to pass back to the IdO. */
  static async escrow({ idb = defaultIdb() } = {}) {
    if (!idb) return null;
    try {
      return await withStore(idb, 'escrow', 'readonly', async (s) => {
        const root = await idbReq(s.get('root'));
        const vault = await idbReq(s.get('vault'));
        if (!root && !vault) return null;
        const out = {};
        if (root) out.root = root;
        if (vault) out.vault = vault;
        return out;
      });
    } catch (_) {
      return null;
    }
  }

  /** forget({ idb }): removes the escrow blobs, the sealed caches and stored keys ("Remove from this device"). */
  static async forget({ idb = defaultIdb() } = {}) {
    if (!idb) return;
    for (const name of ['keys', 'escrow', 'cache']) {
      try { await withStore(idb, name, 'readwrite', (s) => idbReq(s.clear())); } catch (_) { /* nothing there */ }
    }
  }

  get pub() { return this.meta.pub; }
  get label() { return this.meta.label; }
  get keyMode() { return this.meta.keyMode; }
  get short() { return this.meta.short; }
  get ledger() { return this.meta.ledger; }
  get rc() { return this.meta.rc; }
  get nextPubHash() { return this.meta.nextPubHash; }
  get status() { return this.meta.status; }
  get i() { return this.meta.i; }
  get rotateNotice() { return this.meta.rotateNotice; }
  get expiresAt() { return this.meta.expiresAt; }

  _live() {
    if (this.destroyed || !this.keys) throw storeError('E_NOT_SIGNED_IN', 'signed out');
    return this.keys;
  }

  /**
   * identity -> { privateKey, pub, kind, rc? } in the shape ChainNode and createBlock take; rc (the recovery commitment)
   * lets the ledger write the key's keyinfo before its first other write (MF-20).
   */
  get identity() {
    const out = { privateKey: this._live().sign, pub: this.meta.pub, kind: 'visitor' };
    if (typeof this.meta.rc === 'string' && this.meta.rc) out.rc = this.meta.rc;
    return out;
  }

  /** sign(bytes) -> Uint8Array(64), raw P1363 ECDSA P-256 SHA-256. */
  async sign(bytes) {
    const data = typeof bytes === 'string' ? utf8.encode(bytes) : bytes;
    return new Uint8Array(await subtle(this._crypto).sign({ name: 'ECDSA', hash: 'SHA-256' }, this._live().sign, data));
  }

  /**
   * ecdh(theirPub) -> Uint8Array(32) with the current chat key (the chat lane's ChatKey). theirPub is a 'p256:' key
   * string or the raw 65-byte uncompressed point: the chat lane's Noise XX handshake passes raw ephemeral and static
   * points (src/chat/noise.js), as its own ChatKeys accept (src/chat/seal.js rawPoint). v0.3 reconciliation: with
   * string-only input no wire handshake could complete with real working keys. WebCrypto refuses a point off the curve.
   */
  async ecdh(theirPub) {
    const s = subtle(this._crypto);
    const raw = typeof theirPub === 'string' ? publicKeyBytes(theirPub) : theirPub;
    if (!(raw instanceof Uint8Array) || raw.length !== 65 || raw[0] !== 4) throw storeError('E_BAD_REQUEST', 'not an uncompressed P-256 point');
    const pub = await s.importKey('raw', raw, ECDH, false, []);
    return new Uint8Array(await s.deriveBits({ name: 'ECDH', public: pub }, this._live().chat, 256));
  }

  /** chat -> { pub, e, exp, ecdh(theirPub) } (INTERFACES chat service: keys.chat). */
  get chat() {
    const self = this;
    return { pub: this.meta.chat.pub, e: this.meta.chat.e, exp: this.meta.chat.exp, ecdh: (p) => self.ecdh(p) };
  }

  get chatPub() { return this.meta.chat.pub; }

  /** rec -> the current record key (CryptoKey, AES-GCM); recEpoch -> its number r. */
  get rec() { return this._live().rec; }
  get recEpoch() { return this.meta.r; }
  get own() { return this._live().own; }
  get local() { return this._live().local; }
  get name() { return this._live().name; }

  /** hmacName(bytes) -> HMAC-SHA-256 under K_name (hint tags, blinded ids). */
  async hmacName(bytes) {
    const data = typeof bytes === 'string' ? utf8.encode(bytes) : bytes;
    return new Uint8Array(await subtle(this._crypto).sign('HMAC', this._live().name, data));
  }

  /** saveLocal(name, value) -> the sealed blob; kept in IndexedDB unless the computer is shared. */
  async saveLocal(name, value) {
    const blob = await sealLocal(this._live().local, this.meta.label || 'visit', name, value, { cryptoApi: this._crypto });
    this._caches.set(name, blob);
    if (!this.sharedComputer && this._idb) {
      try { await withStore(this._idb, 'cache', 'readwrite', (s) => idbReq(s.put(blob, (this.meta.label || 'visit') + '|' + name))); } catch (_) { /* memory copy stays */ }
    }
    return blob;
  }

  /** localBlob(name) -> the sealed blob (memory, then IndexedDB) or null. */
  async localBlob(name) {
    if (this._caches.has(name)) return this._caches.get(name);
    if (this.sharedComputer || !this._idb) return null;
    try {
      const blob = await withStore(this._idb, 'cache', 'readonly', (s) => idbReq(s.get((this.meta.label || 'visit') + '|' + name)));
      if (blob) this._caches.set(name, blob);
      return blob || null;
    } catch (_) {
      return null;
    }
  }

  /** loadLocal(name) -> the value or null. */
  async loadLocal(name) {
    const blob = await this.localBlob(name);
    if (!blob) return null;
    return openLocal(this._live().local, this.meta.label || 'visit', name, blob, { cryptoApi: this._crypto });
  }

  /** dropLocal(name): removes one sealed cache (memory and IndexedDB). */
  async dropLocal(name) {
    this._caches.delete(name);
    if (this.sharedComputer || !this._idb) return;
    try { await withStore(this._idb, 'cache', 'readwrite', (s) => idbReq(s.delete((this.meta.label || 'visit') + '|' + name))); } catch (_) { /* gone */ }
  }

  /**
   * destroy({ forget, broadcast }) -> { epoch }: sign out (R 2.4.1). Keys leave memory and IndexedDB, the epoch
   * moves on, other tabs hear 'signed-out'. forget also removes the escrow blobs and caches.
   */
  async destroy({ forget = false, broadcast: tell = true } = {}) {
    this.destroyed = true;
    this.keys = null;
    this._caches.clear();
    const persist = !this.sharedComputer && Boolean(this._idb);
    if (persist) {
      try { await withStore(this._idb, 'keys', 'readwrite', (s) => idbReq(s.delete('current'))); } catch (_) { /* nothing stored */ }
      if (forget) await WorkingKeys.forget({ idb: this._idb });
    }
    const epoch = await bumpEpoch({ idb: this._idb, persist });
    if (tell) {
      try { broadcast({ t: 'signed-out', epoch }, this._channel); } catch (_) { /* no channel */ }
    }
    return { epoch };
  }
}
