// IndexedDB schema v2 for the loader (ARCHITECTURE §5.4, §6.1, §8; DESIGN-REVIEW items 9, 18, S3).
// The Service Worker core re-implements a minimal reader with the same names, so DB_NAME,
// DB_VERSION, STORES, fileKey() and the value shapes below are a contract.
//
// Rules: every store uses out-of-line keys; every value is built before its readwrite transaction
// opens and nothing is awaited inside one (Safari and Firefox auto-commit); our connection closes
// itself on `versionchange` so other contexts (the SW, other tabs) can upgrade; a Safari
// `UnknownError` (or a connection that closed under us) is retried once with a fresh connection.
//
//   sites:    btih → { btih, kind: 'site'|'assets', name, torrentFile: Uint8Array,
//                      files: [{ path, length, type, offset }], pieceLength, total, savedAt,
//                      lastVisit, complete: true }           (pad files are not listed)
//   files:    `${btih}/${path}` → Blob                        (path is site-relative; an ArrayBuffer
//                                                               where the engine cannot store Blobs, see below)
//   pointers: scope → { record, raw, source, savedAt, ttlUntil }
//   pins:     scope → { owner, decidedAt, firstSeen }
//   prefs:    key → any  ('consent:<ledgerId>', 'uploads', 'hostOnly', 'shareOnNetwork:<origin>', 'hubMode:<btih>')
//   keys:     `identity:<ledgerId>` | `moderator:<ledgerId>` →
//                 { kind: 'cryptokey', privateKey, publicKey, pub } | { kind: 'jwk', jwk, pub }
//   meta:     'current' → { btih, ledgerId, routing }   'clients' → { clientId: btih }
//   docs:     url → { body: Blob, headers, btih, savedAt }  (drop-in offline documents, LRU)
//
// WebKit ephemeral sessions (Safari Private Browsing, Playwright's default WebKit context) refuse
// Blobs in IndexedDB with UnknownError "Error preparing Blob/File data to be stored in object
// store". When the failing Blob put is the first request of its transaction, the transaction
// aborts cleanly; when any other request precedes it, the transaction never settles and the
// stores stay locked for every connection until the session ends (abort() throws
// InvalidStateError; verified on WebKit 2370). So: blobStorageSupported() probes once with a
// Blob put as the first request, saveSite stores ArrayBuffers when the probe fails, every
// transaction here issues its Blob puts before anything else, and getFile always returns a Blob.

import { normalizeBtih } from '../common/magnet.js';
import { utf8 } from '../chain/canonical.js';
import {
  generateKeyPair, exportPublicKey, exportPrivateJwk, importPrivateJwk, sign, verify,
} from '../chain/crypto.js';

export const DB_NAME = 'mw-sites';
export const DB_VERSION = 2;
export const STORES = {
  sites: 'sites', files: 'files', pointers: 'pointers', pins: 'pins', prefs: 'prefs', keys: 'keys', meta: 'meta', docs: 'docs',
};
const STORE_NAMES = Object.keys(STORES).map((k) => STORES[k]);
/** How long openDb() waits on a `blocked` upgrade before it gives up (E_IDB_BLOCKED). */
export const BLOCKED_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------------------------
// pure helpers (also used by tests and by the SW reader)
// ---------------------------------------------------------------------------------------------

/** Key of a file Blob in the `files` store. */
export function fileKey(btih, path) {
  return btih + '/' + path;
}

/** [lower, upper) bounds that select every `files` key of one btih ('/' + 1 is '0'). */
export function fileKeyBounds(btih) {
  return [btih + '/', btih + '0'];
}

/** IndexedDB key name of the posting identity / imported moderator key for a ledger. */
export function identityKeyName(ledgerId) {
  return 'identity:' + ledgerId;
}
export function moderatorKeyName(ledgerId) {
  return 'moderator:' + ledgerId;
}

/**
 * siteRelativePath(filePath, torrentName, fileCount) → the path a site file is served at.
 * WebTorrent's file.path is `<name>/<path>` for a multi-file torrent and `<name>` for a
 * single-file one; the torrent-name prefix is stripped whenever present (a multi-file torrent
 * may hold one file), backslashes become '/', leading slashes are dropped.
 */
export function siteRelativePath(filePath, torrentName, fileCount) {
  let p = String(filePath).replace(/\\/g, '/');
  const name = String(torrentName || '');
  if (name && p.startsWith(name + '/')) p = p.slice(name.length + 1);
  else if (name && fileCount === 1 && p === name) return name;
  return p.replace(/^\/+/, '');
}

function siteBytes(site) {
  if (site && typeof site.total === 'number') return site.total;
  let n = 0;
  if (site && Array.isArray(site.files)) for (const f of site.files) n += f.length || 0;
  return n;
}

/**
 * buildManifest(parsed, { torrentFile, kind = 'site', name, typeFor }) → the `sites` value for
 * a parsed torrent (pad files left out; total = bytes of the listed files). typeFor(path) may
 * supply a MIME type; it defaults to ''.
 */
export function buildManifest(parsed, { torrentFile, kind = 'site', name = null, typeFor = null } = {}) {
  if (!parsed || !Array.isArray(parsed.files)) throw new TypeError('buildManifest: parsed torrent expected');
  const files = parsed.files.filter((f) => !f.pad).map((f) => ({
    path: f.path,
    length: f.length,
    type: (typeFor && typeFor(f.path)) || '',
    offset: f.offset,
  }));
  let total = 0;
  for (const f of files) total += f.length;
  return {
    btih: parsed.infoHash,
    kind: kind === 'assets' ? 'assets' : 'site',
    name: name === null || name === undefined ? parsed.name : String(name),
    torrentFile,
    files,
    pieceLength: parsed.pieceLength,
    total,
  };
}

function normalizeManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new TypeError('saveSite: manifest must be an object');
  const btih = normalizeBtih(manifest.btih);
  if (!btih) throw new TypeError('saveSite: manifest.btih must be an infohash');
  if (!(manifest.torrentFile instanceof Uint8Array)) throw new TypeError('saveSite: manifest.torrentFile must be a Uint8Array');
  if (!Array.isArray(manifest.files)) throw new TypeError('saveSite: manifest.files must be an array');
  const seen = new Set();
  const files = [];
  let total = 0;
  for (const f of manifest.files) {
    if (!f || f.pad) continue;
    if (typeof f.path !== 'string' || !f.path || f.path.charAt(0) === '/') throw new TypeError('saveSite: invalid file path');
    if (!Number.isSafeInteger(f.length) || f.length < 0) throw new TypeError('saveSite: invalid length for ' + f.path);
    if (seen.has(f.path)) throw new TypeError('saveSite: duplicate path ' + f.path);
    seen.add(f.path);
    files.push({
      path: f.path,
      length: f.length,
      type: typeof f.type === 'string' ? f.type : '',
      offset: Number.isSafeInteger(f.offset) ? f.offset : null,
    });
    total += f.length;
  }
  const now = Date.now();
  return Object.assign({}, manifest, {
    btih,
    kind: manifest.kind === 'assets' ? 'assets' : 'site',
    name: typeof manifest.name === 'string' ? manifest.name : '',
    files,
    pieceLength: Number.isSafeInteger(manifest.pieceLength) ? manifest.pieceLength : null,
    total,
    savedAt: now,
    lastVisit: now,
    complete: true,
  });
}

function toBlob(data, type) {
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data;
  if (data instanceof Uint8Array || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    return new Blob([data], type ? { type } : undefined);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// connection
// ---------------------------------------------------------------------------------------------

let factoryOverride = null;
let dbPromise = null;
let currentDb = null;

/** Tests only: use another IDBFactory (null restores globalThis.indexedDB). Closes the cached connection. */
export function setIndexedDbFactory(factory) {
  resetConnection();
  blobSupport = null;
  factoryOverride = factory || null;
}

function factory() {
  const f = factoryOverride || globalThis.indexedDB;
  if (!f) {
    const err = new Error('IndexedDB is unavailable');
    err.code = 'E_NO_IDB';
    throw err;
  }
  return f;
}

function resetConnection() {
  const db = currentDb;
  if (db === null && dbPromise === null) return;
  currentDb = null;
  dbPromise = null;
  if (db) {
    try {
      db.close();
    } catch (_) { /* already closed */ }
  }
}

/** Closes our connection (the next call reopens). */
export function closeDb() {
  resetConnection();
}

function upgrade(db, tx, oldVersion) {
  if (oldVersion >= 1 && oldVersion < 2) {
    // v1 (never released) had an `identity` store and manifests without offsets: drop the
    // re-downloadable caches, keep pins and prefs when their key layout already matches.
    for (const name of Array.from(db.objectStoreNames)) {
      const keep = (name === 'pins' || name === 'prefs') && tx.objectStore(name).keyPath === null;
      if (!keep) db.deleteObjectStore(name);
    }
  }
  for (const name of STORE_NAMES) {
    if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
  }
}

/** openDb() → IDBDatabase (one shared connection per context). */
export function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      let settled = false;
      let blockedTimer = null;
      let request;
      try {
        request = factory().open(DB_NAME, DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      request.onupgradeneeded = (event) => {
        upgrade(request.result, request.transaction, event.oldVersion || 0);
      };
      request.onsuccess = () => {
        const db = request.result;
        if (settled) {
          db.close(); // we gave up waiting (blocked); do not leak the late connection
          return;
        }
        settled = true;
        clearTimeout(blockedTimer);
        db.onversionchange = () => {
          // Another context wants a newer schema: step aside instead of blocking it.
          if (currentDb === db) resetConnection();
          else db.close();
        };
        db.onclose = () => {
          if (currentDb === db) {
            currentDb = null;
            dbPromise = null;
          }
        };
        currentDb = db;
        resolve(db);
      };
      request.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(blockedTimer);
        reject(request.error || new Error('IndexedDB open failed'));
      };
      request.onblocked = () => {
        if (blockedTimer !== null || settled) return;
        blockedTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const err = new Error('IndexedDB upgrade is blocked by another open tab of this site');
          err.code = 'E_IDB_BLOCKED';
          reject(err);
        }, BLOCKED_TIMEOUT_MS);
      };
    }).catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

function retryable(err) {
  return Boolean(err && (err.name === 'UnknownError' || err.name === 'InvalidStateError'));
}

// Runs one transaction. `body(tx, setResult)` must issue all requests synchronously (request
// callbacks may issue more); the promise settles on complete (with the value given to
// setResult) or on abort (with the first error). Retried once on UnknownError/InvalidStateError.
async function transact(storeNames, mode, body) {
  for (let attempt = 0; ; attempt++) {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        let tx;
        try {
          tx = db.transaction(storeNames, mode);
        } catch (err) {
          reject(err);
          return;
        }
        let result;
        let failure = null;
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(failure || tx.error || new Error('IndexedDB transaction aborted'));
        tx.onerror = (event) => {
          if (!failure && event && event.target && event.target.error) failure = event.target.error;
        };
        try {
          body(tx, (value) => {
            result = value;
          });
        } catch (err) {
          failure = err;
          try {
            tx.abort();
          } catch (_) { /* already finished */ }
        }
      });
    } catch (err) {
      if (attempt === 0 && retryable(err)) {
        resetConnection();
        continue;
      }
      throw err;
    }
  }
}

function getOne(storeName, key) {
  return transact([storeName], 'readonly', (tx, set) => {
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => set(req.result);
  });
}

function putOne(storeName, key, value) {
  return transact([storeName], 'readwrite', (tx) => {
    tx.objectStore(storeName).put(value, key);
  });
}

function deleteOne(storeName, key) {
  return transact([storeName], 'readwrite', (tx) => {
    tx.objectStore(storeName).delete(key);
  });
}

function fileRange(btih) {
  const [lower, upper] = fileKeyBounds(btih);
  return IDBKeyRange.bound(lower, upper, false, true);
}

// Outside every btih key range ('~' sorts after hex digits).
const BLOB_PROBE_KEY = '~blob-probe';
let blobSupport = null;

/**
 * blobStorageSupported() → Promise<boolean>, probed once per context: can this engine store a
 * Blob in IndexedDB? False in WebKit ephemeral sessions; saveSite then stores ArrayBuffers.
 */
export function blobStorageSupported() {
  if (!blobSupport) {
    blobSupport = transact([STORES.files], 'readwrite', (tx) => {
      const store = tx.objectStore(STORES.files);
      store.put(new Blob(['mw']), BLOB_PROBE_KEY); // first request: a refusal aborts cleanly
      store.delete(BLOB_PROBE_KEY);
    }).then(() => true, (err) => {
      if (err && err.code === 'E_NO_IDB') {
        blobSupport = null;
        throw err;
      }
      return false;
    });
  }
  return blobSupport;
}

function asBlob(value) {
  if (value === undefined || value === null) return null;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return new Blob([value]);
  return null;
}

// ---------------------------------------------------------------------------------------------
// sites and files
// ---------------------------------------------------------------------------------------------

/**
 * saveSite(manifest, blobs: Map<path, Blob|Uint8Array>) → the stored manifest. Writes the
 * manifest and every listed file in ONE transaction: every value is built and size-checked
 * before it opens (ArrayBuffers instead of Blobs where blobStorageSupported() is false), the file
 * puts come first (see the WebKit note above), then the manifest, then files of an older save of
 * the same btih that the new manifest no longer lists are deleted.
 */
export async function saveSite(manifest, blobs) {
  const record = normalizeManifest(manifest);
  if (!blobs || typeof blobs.get !== 'function') throw new TypeError('saveSite: blobs must be a Map');
  let entries = [];
  for (const f of record.files) {
    const blob = toBlob(blobs.get(f.path), f.type);
    if (!blob) throw new Error('saveSite: no data for ' + f.path);
    if (blob.size !== f.length) throw new Error('saveSite: ' + f.path + ' is ' + blob.size + ' bytes, expected ' + f.length);
    entries.push([fileKey(record.btih, f.path), blob]);
  }
  if (!(await blobStorageSupported())) {
    entries = await Promise.all(entries.map(async ([key, blob]) => [key, await blob.arrayBuffer()]));
  }
  const keep = new Set(entries.map((e) => e[0]));
  await transact([STORES.sites, STORES.files], 'readwrite', (tx) => {
    const files = tx.objectStore(STORES.files);
    for (const [key, value] of entries) files.put(value, key);
    tx.objectStore(STORES.sites).put(record, record.btih);
    const stale = files.getAllKeys(fileRange(record.btih));
    stale.onsuccess = () => {
      for (const key of stale.result) if (!keep.has(key)) files.delete(key);
    };
  });
  return record;
}

/** getSite(btih) → manifest | null. */
export async function getSite(btih) {
  const key = normalizeBtih(btih);
  if (!key) return null;
  return (await getOne(STORES.sites, key)) || null;
}

/** getFile(btih, path) → Blob | null (bytes stored by the no-Blob fallback come back as a Blob too). */
export async function getFile(btih, path) {
  const key = normalizeBtih(btih);
  if (!key || typeof path !== 'string') return null;
  return asBlob(await getOne(STORES.files, fileKey(key, path.charAt(0) === '/' ? path.slice(1) : path)));
}

/** listSites() → every manifest. */
export function listSites() {
  return transact([STORES.sites], 'readonly', (tx, set) => {
    const req = tx.objectStore(STORES.sites).getAll();
    req.onsuccess = () => set(req.result || []);
  });
}

/** deleteSite(btih): manifest, every file (one key range) and offline documents stamped with it, atomically. */
export async function deleteSite(btih) {
  const key = normalizeBtih(btih);
  if (!key) return;
  await transact([STORES.sites, STORES.files, STORES.docs], 'readwrite', (tx) => {
    tx.objectStore(STORES.sites).delete(key);
    tx.objectStore(STORES.files).delete(fileRange(key));
    const cursorReq = tx.objectStore(STORES.docs).openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      if (cursor.value && cursor.value.btih === key) cursor.delete();
      cursor.continue();
    };
  });
}

/** touchSite(btih) → true when the site exists; sets lastVisit = now (LRU order for enforceBudget). */
export async function touchSite(btih, now = Date.now()) {
  const key = normalizeBtih(btih);
  if (!key) return false;
  return transact([STORES.sites], 'readwrite', (tx, set) => {
    const store = tx.objectStore(STORES.sites);
    const req = store.get(key);
    set(false);
    req.onsuccess = () => {
      const site = req.result;
      if (!site) return;
      site.lastVisit = now;
      store.put(site, key);
      set(true);
    };
  });
}

// ---------------------------------------------------------------------------------------------
// pointers, pins, prefs, keys, meta
// ---------------------------------------------------------------------------------------------

export async function getPointer(scope) {
  return (await getOne(STORES.pointers, scope)) || null;
}

/** savePointer(scope, value) — value { record, raw, source, savedAt, ttlUntil }; savedAt defaults to now. */
export async function savePointer(scope, value) {
  const v = Object.assign({}, value);
  if (typeof v.savedAt !== 'number') v.savedAt = Date.now();
  await putOne(STORES.pointers, scope, v);
  return v;
}

export async function getPin(scope) {
  return (await getOne(STORES.pins, scope)) || null;
}

/**
 * savePin(scope, owner, extra = {}) → stored pin { owner, decidedAt, firstSeen, ...extra }.
 * firstSeen survives later key changes for the scope.
 */
export function savePin(scope, owner, extra = {}) {
  const now = Date.now();
  const more = extra && typeof extra === 'object' ? extra : {};
  return transact([STORES.pins], 'readwrite', (tx, set) => {
    const store = tx.objectStore(STORES.pins);
    const req = store.get(scope);
    req.onsuccess = () => {
      const prev = req.result;
      const value = Object.assign({}, more, {
        owner,
        decidedAt: typeof more.decidedAt === 'number' ? more.decidedAt : now,
        firstSeen: typeof more.firstSeen === 'number' ? more.firstSeen
          : (prev && typeof prev.firstSeen === 'number' ? prev.firstSeen : now),
      });
      store.put(value, scope);
      set(value);
    };
  });
}

/** getPref(key, fallback) → stored value, or fallback when absent. */
export async function getPref(key, fallback = undefined) {
  const v = await getOne(STORES.prefs, key);
  return v === undefined ? fallback : v;
}

export async function setPref(key, value) {
  await putOne(STORES.prefs, key, value);
}

export async function getKey(name) {
  return (await getOne(STORES.keys, name)) || null;
}

/**
 * saveKey(name, value) — value { kind: 'cryptokey', privateKey, publicKey, pub } or
 * { kind: 'jwk', jwk, pub }. A CryptoKey that cannot be cloned (iOS DataCloneError) rejects with
 * that error, so the caller can fall back to the JWK shape (createIdentity does).
 */
export async function saveKey(name, value) {
  if (!value || (value.kind !== 'cryptokey' && value.kind !== 'jwk') || typeof value.pub !== 'string') {
    throw new TypeError("saveKey: value must be { kind: 'cryptokey'|'jwk', pub, ... }");
  }
  await putOne(STORES.keys, name, value);
}

/**
 * addKey(name, value) → true when stored, false when a key of that name exists already (code review
 * round 1): IndexedDB add() in its own readwrite transaction, so two tabs creating an identity at
 * once cannot overwrite each other; the one that loses reads and uses the stored key. Other errors
 * (DataCloneError on iOS) reject as saveKey's do.
 */
export async function addKey(name, value) {
  if (!value || (value.kind !== 'cryptokey' && value.kind !== 'jwk') || typeof value.pub !== 'string') {
    throw new TypeError("addKey: value must be { kind: 'cryptokey'|'jwk', pub, ... }");
  }
  try {
    await transact([STORES.keys], 'readwrite', (tx) => {
      tx.objectStore(STORES.keys).add(value, name);
    });
    return true;
  } catch (err) {
    if (err && err.name === 'ConstraintError') return false;
    throw err;
  }
}

export async function deleteKey(name) {
  await deleteOne(STORES.keys, name);
}

export async function getMeta(key) {
  const v = await getOne(STORES.meta, key);
  return v === undefined ? null : v;
}

export async function setMeta(key, value) {
  await putOne(STORES.meta, key, value);
}

// ---------------------------------------------------------------------------------------------
// identity (ARCHITECTURE §6.1, DESIGN-REVIEW item 18)
// ---------------------------------------------------------------------------------------------

async function signsAs(privateKey, pub) {
  try {
    const message = utf8.encode('mw-identity-self-test');
    return await verify(pub, message, await sign(privateKey, message));
  } catch (_) {
    return false;
  }
}

/**
 * createIdentity(name, { forceJwk = false }) → { privateKey, pub, kind }.
 * Generates a P-256 pair, stores the non-extractable CryptoKey pair as the whole value under
 * `name` and runs the round-trip self-test (put, get, sign, verify). If storing or the self-test
 * fails (iOS Safari reports DataCloneError for ECDSA keys), stores { kind: 'jwk', jwk, pub }
 * instead and returns a key imported non-extractable for this session. forceJwk takes that path
 * directly (used to test it).
 */
export async function createIdentity(name, { forceJwk = false } = {}) {
  const pair = await generateKeyPair({ extractable: true });
  const pub = await exportPublicKey(pair.publicKey);
  const jwk = await exportPrivateJwk(pair.privateKey);
  const privateKey = await importPrivateJwk(jwk, { extractable: false });
  if (!forceJwk) {
    try {
      await saveKey(name, { kind: 'cryptokey', privateKey, publicKey: pair.publicKey, pub, createdAt: Date.now() });
      const back = await getKey(name);
      if (back && back.kind === 'cryptokey' && back.privateKey && (await signsAs(back.privateKey, pub))) {
        return { privateKey: back.privateKey, pub, kind: 'cryptokey' };
      }
    } catch (_) { /* DataCloneError and friends: fall back to the JWK below */ }
  }
  await saveKey(name, { kind: 'jwk', jwk, pub, createdAt: Date.now() });
  return { privateKey, pub, kind: 'jwk' };
}

/** loadIdentity(name) → { privateKey, pub, kind } | null (a stored JWK is imported non-extractable). */
export async function loadIdentity(name) {
  const v = await getKey(name);
  if (!v) return null;
  if (v.kind === 'cryptokey' && v.privateKey) return { privateKey: v.privateKey, pub: v.pub, kind: 'cryptokey' };
  if (v.kind === 'jwk' && v.jwk) {
    return { privateKey: await importPrivateJwk(v.jwk, { extractable: false }), pub: v.pub, kind: 'jwk' };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// storage budget and persistence (ARCHITECTURE §8, DESIGN-REVIEW S3)
// ---------------------------------------------------------------------------------------------

function storageManager() {
  return typeof navigator !== 'undefined' && navigator && navigator.storage ? navigator.storage : null;
}

/** estimateUsage() → { usage, quota, persisted, sites, siteBytes } (nulls where the browser says nothing). */
export async function estimateUsage() {
  const out = { usage: null, quota: null, persisted: null, sites: 0, siteBytes: 0 };
  const sm = storageManager();
  try {
    if (sm && typeof sm.estimate === 'function') {
      const e = await sm.estimate();
      out.usage = typeof e.usage === 'number' ? e.usage : null;
      out.quota = typeof e.quota === 'number' ? e.quota : null;
    }
  } catch (_) { /* unsupported */ }
  try {
    if (sm && typeof sm.persisted === 'function') out.persisted = (await sm.persisted()) === true;
  } catch (_) { /* unsupported */ }
  try {
    const sites = await listSites();
    out.sites = sites.length;
    for (const s of sites) out.siteBytes += siteBytes(s);
  } catch (_) { /* no IndexedDB: report what the browser said */ }
  return out;
}

/**
 * enforceBudget({ budgetBytes, keep = [] }) → { evicted: [btih], total }.
 * While the stored sites exceed budgetBytes, deletes the least recently visited one (lastVisit,
 * then savedAt), never a btih in `keep` (the current site and its previous version).
 */
export async function enforceBudget({ budgetBytes, keep = [] } = {}) {
  if (typeof budgetBytes !== 'number' || !(budgetBytes >= 0)) throw new TypeError('enforceBudget: budgetBytes must be a number');
  const sites = await listSites();
  let total = 0;
  for (const s of sites) total += siteBytes(s);
  const evicted = [];
  if (total <= budgetBytes) return { evicted, total };
  const keepSet = new Set((Array.isArray(keep) ? keep : [keep]).map(normalizeBtih).filter(Boolean));
  const stamp = (s) => (typeof s.lastVisit === 'number' ? s.lastVisit : (typeof s.savedAt === 'number' ? s.savedAt : 0));
  const candidates = sites.filter((s) => !keepSet.has(s.btih)).sort((a, b) => stamp(a) - stamp(b) || (a.btih < b.btih ? -1 : 1));
  for (const s of candidates) {
    if (total <= budgetBytes) break;
    await deleteSite(s.btih);
    total -= siteBytes(s);
    evicted.push(s.btih);
  }
  return { evicted, total };
}

/** requestPersist() → true when storage is (now) persistent; false when refused or unsupported. */
export async function requestPersist() {
  const sm = storageManager();
  if (!sm || typeof sm.persist !== 'function') return false;
  try {
    if (typeof sm.persisted === 'function' && (await sm.persisted()) === true) return true;
    return (await sm.persist()) === true;
  } catch (_) {
    return false;
  }
}
