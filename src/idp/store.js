// src/idp/store.js: what the identity origin keeps in its own IndexedDB (R 2.2.4, 2.2.5, 2.12; MF-14, MF-20).
//
//   'wrapped' { blob, method: 'passkey' | 'passphrase', credId?, t }   root* and K_vault, wrapped (wrap.js)
//   'vault'   the vault blob { v: 2, kind: 'vault', id, iv, ct } (vault.js), id = vaultIdOf(root*)
//   'state'   display and pressure state, no secret (see emptyState): per-origin first and last sign-in, the
//             same-identity offers and refusals, hub choices, per-ledger pointer seq floors, backup flags
//
// The state record is readable by anyone with this device's storage (like browser history); Settings >
// "Remove my identity from this device" wipes everything. "This visit only" uses openIdoStore({ memory: true }):
// nothing touches IndexedDB.
//
// Escrow (R 2.2.5): every sign-in hands the site a copy of 'vault' to keep as an opaque value, and a copy of
// 'wrapped' only when it unlocks with the passkey (PRF), which no site can open. Since review round SEC-1 / STALK-1 /
// PHISH-2 both copies are made for that one origin: the root copy is wrapped again under the PRF output with a fresh IV and
// no credId, the vault copy is encrypted again with a fresh IV, padded (vault.js padBucket) and named escrowIdOf(root*,
// origin), so no byte, id or length of one site's copy matches another site's. A passphrase blob would be an offline
// guessing target for every site (code review v0.3, security 2), so it never leaves this origin and is never taken
// back. When this origin's copy is gone (Safari's 7-day rule, a purge), the next sign-in passes the site's copy
// back. acceptEscrow() takes only the exact shapes this origin writes, and the copy is authenticated by AES-GCM
// when it is unwrapped (wrap.js, vault.js), so a forged or swapped blob fails. Every vault copy a request carries
// is merged into this origin's own (src/idp/idp.js, Vault.mergeFrom), never adopted in its place.
// Pure enough for Node: indexedDB is injected.

import { b64url } from '../chain/canonical.js';
import { kVaultHash, hkdf } from '../identity/derive.js';

export const DB_NAME = 'mw-idp';
export const DB_VERSION = 1;
const STORE = 'kv';

/** emptyState() -> the state record of a device without an identity. */
export function emptyState() {
  return { v: 1, origins: {}, same: {}, hubs: {}, seqFloors: {}, backup: { kitSaved: false, fileSaved: false }, nickname: null, restored: null, created: null };
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

class MemoryBackend {
  constructor() {
    this.map = new Map();
  }

  async get(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }

  async put(k, v) {
    this.map.set(k, v);
  }

  async delete(k) {
    this.map.delete(k);
  }

  async clear() {
    this.map.clear();
  }

  async close() {}
}

class IdbBackend {
  constructor(db) {
    this.db = db;
  }

  async get(k) {
    const v = await req(this.db.transaction(STORE, 'readonly').objectStore(STORE).get(k));
    return v === undefined ? null : v;
  }

  async put(k, v) {
    await req(this.db.transaction(STORE, 'readwrite').objectStore(STORE).put(v, k));
  }

  async delete(k) {
    await req(this.db.transaction(STORE, 'readwrite').objectStore(STORE).delete(k));
  }

  async clear() {
    await req(this.db.transaction(STORE, 'readwrite').objectStore(STORE).clear());
  }

  async close() {
    try { this.db.close(); } catch (_) { /* already closed */ }
  }
}

/**
 * openIdoStore({ indexedDB, memory }) -> IdoStore. memory: true (or no indexedDB) keeps everything in this
 * window only ("this visit only"). An IndexedDB that refuses to open falls back to memory and says so
 * (store.persistent === false).
 */
export async function openIdoStore({ indexedDB: idb = globalThis.indexedDB, memory = false } = {}) {
  if (memory || !idb || typeof idb.open !== 'function') return new IdoStore(new MemoryBackend(), false);
  try {
    const open = idb.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
    };
    const db = await req(open);
    return new IdoStore(new IdbBackend(db), true);
  } catch (_) {
    return new IdoStore(new MemoryBackend(), false);
  }
}

export class IdoStore {
  constructor(backend, persistent) {
    this.backend = backend;
    this.persistent = persistent;
  }

  async getWrapped() {
    return this.backend.get('wrapped');
  }

  async setWrapped(rec) {
    if (!rec || !rec.blob || (rec.method !== 'passkey' && rec.method !== 'passphrase')) throw new TypeError('wrapped record needs blob and method');
    await this.backend.put('wrapped', rec);
  }

  async getVault() {
    return this.backend.get('vault');
  }

  async setVault(blob) {
    await this.backend.put('vault', blob);
  }

  async getState() {
    const s = await this.backend.get('state');
    if (!s || s.v !== 1) return emptyState();
    return Object.assign(emptyState(), s);
  }

  async setState(state) {
    await this.backend.put('state', state);
  }

  /** wipe(): "Remove my identity from this device" (R 2.15). */
  async wipe() {
    await this.backend.clear();
  }

  /**
   * dropIdentity(): the wrapped record and the vault only (review round UX-5: "Check the words" after a restore that
   * found no posts takes the restored identity off again; the state record, with the sites of an earlier identity, is
   * the caller's to change).
   */
  async dropIdentity() {
    if (typeof this.backend.delete === 'function') {
      await this.backend.delete('wrapped');
      await this.backend.delete('vault');
      return;
    }
    await this.backend.put('wrapped', null);
    await this.backend.put('vault', null);
  }

  async close() {
    await this.backend.close();
  }
}

/** vaultIdOf(root*) -> the vault blob id: b64url(K_vaultHash(root*))[:22]. It names the vault; it opens nothing. */
export async function vaultIdOf(rootStar) {
  return b64url.encode(await kVaultHash(rootStar)).slice(0, 22);
}

/**
 * escrowIdOf(root*, origin) -> the id of the vault copy one site keeps (review round SEC-1, STALK-1, PHISH-2):
 * b64url(HKDF(root*, info "mw-escrow-id|1|" + origin))[:22]. Each origin's copy has its own id (and its own IV, ciphertext
 * and padded length), so two sites cannot match their copies; the identity origin's own vault keeps vaultIdOf.
 */
export async function escrowIdOf(rootStar, origin) {
  if (typeof origin !== 'string' || !origin) throw new TypeError('escrowIdOf: origin');
  return b64url.encode(await hkdf(rootStar, new Uint8Array(0), 'mw-escrow-id|1|' + origin, 16)).slice(0, 22);
}

function exactKeys(o, keys) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  const k = Object.keys(o);
  return k.every((x) => keys.indexOf(x) >= 0);
}

function b64ok(s, min, max) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) return false;
  try {
    const n = b64url.decode(s).length;
    return n >= min && n <= max;
  } catch (_) {
    return false;
  }
}

/**
 * acceptEscrow({ root, vault }) -> { root: blob | null, vault: blob | null }: the escrow copies a site passed
 * back, kept only when they have the exact shape this origin writes: a PRF blob (a passphrase blob is never
 * escrowed and never taken back: security 2), and a vault blob with an id. Authenticity is checked later by
 * AES-GCM (unwrap and Vault.open).
 */
export function acceptEscrow(escrow) {
  const out = { root: null, vault: null };
  if (!escrow || typeof escrow !== 'object') return out;
  const r = escrow.root;
  if (r && exactKeys(r, ['v', 'kind', 'credId', 'salt', 'kdf', 'iv', 'ct']) && r.v === 2 && b64ok(r.iv, 12, 12) && b64ok(r.ct, 80, 80)) {
    if (r.kind === 'prf' && r.salt === undefined && r.kdf === undefined && (r.credId === undefined || b64ok(r.credId, 1, 1024))) out.root = r;
  }
  const v = escrow.vault;
  if (v && exactKeys(v, ['v', 'kind', 'id', 'iv', 'ct']) && v.v === 2 && v.kind === 'vault' && typeof v.id === 'string' && /^[A-Za-z0-9_-]{22}$/.test(v.id) &&
    b64ok(v.iv, 12, 12) && typeof v.ct === 'string' && v.ct.length > 0 && v.ct.length <= 350000) {
    out.vault = v;
  }
  return out;
}
