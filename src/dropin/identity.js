// src/dropin/identity.js: the visitor's identity in drop-in mode.
//
// v0.3 (R 2.2.7, 2.3.1, 2.4.1; lane idp): the drop-in adapter over src/identity/client.js and store.js.
//   createDropinIdentity({ win, cache, ledgerId, pointer, node, cfg, prompt, ... }) -> { service, legacy, boot(),
//     completeRedirect(), destroy() }
//   service is createIdentityService (src/identity/service.js): the working keys come from the identity origin;
//   this page never holds the root, the phrase or another site's keys. legacy reads the 0.2.1 key of this ledger
//   for its one-time move into the identity vault (migrate.js) and removes it after a backup file exists.
//   countPostsBy(node, pub) answers the identity origin's "Found N posts" question after a restore.
//
// 0.2.1, kept for migration only (ARCHITECTURE section 6.1, 9; DESIGN-REVIEW items 18, S3): the per-ledger key
// store, names ('identity:<ledgerId>') and the passphrase-wrapped export format ("mw-identity" v1: AES-GCM under
// PBKDF2-SHA256) shared with the shell (src/loader/app.js), so an old export still imports and an old key can be
// taken into the vault. New identities are not made with these functions in v0.3 once the loader mounts the
// identity service (docs/deviations/idp.md).
//
//   ensureIdentity({ cache, crypto, ledgerId, create })    load (or, with create: true, make) the 0.2.1 identity
//   storeKey(cache, crypto, name, { pair, jwk, pub })      CryptoKey pair first, JWK when the engine cannot clone it
//   exportIdentityText({ jwk, pub, ledgerId, passphrase, iterations })  -> JSON text
//   importIdentityText(text, passphrase, { publicFromPrivateJwk })      -> { jwk, pub, ledgerId }
//   exportCurrentIdentity / importIdentity                 the two above against the stored key

import { CONFIG } from '../loader/config.js';
import { STRINGS } from '../loader/strings.js';
import * as identityClient from '../identity/client.js';
import { WorkingKeys } from '../identity/store.js';
import { createIdentityService } from '../identity/service.js';

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw Object.assign(new Error('WebCrypto is unavailable'), { code: 'E_IDENTITY' });
  return c.subtle;
}

function b64urlEncode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) throw Object.assign(new Error('bad base64url'), { code: 'E_IDENTITY' });
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveWrapKey(passphrase, salt, iterations) {
  const base = await subtle().importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function identityAad(ledgerId, pub) {
  return new TextEncoder().encode('mw-identity-v1\n' + (ledgerId || '') + '\n' + (pub || ''));
}

/** Passphrase-wrapped identity (AES-GCM under PBKDF2-SHA256) as a JSON string. */
export async function exportIdentityText({ jwk, pub, ledgerId, passphrase, iterations = CONFIG.identity.pbkdf2Iterations }) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) throw Object.assign(new Error(STRINGS.passphraseTooShort), { code: 'E_IDENTITY' });
  if (!jwk || !jwk.d || !pub) throw Object.assign(new Error('this identity cannot be exported'), { code: 'E_IDENTITY' });
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveWrapKey(passphrase, salt, iterations);
  const plain = new TextEncoder().encode(JSON.stringify({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }));
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: identityAad(ledgerId, pub) }, key, plain));
  return JSON.stringify({ type: 'mw-identity', v: 1, ledger: ledgerId || null, pub, kdf: 'PBKDF2-SHA256', iter: iterations, salt: b64urlEncode(salt), iv: b64urlEncode(iv), ct: b64urlEncode(ct) }, null, 2);
}

/** Reverses exportIdentityText; checks that the decrypted key matches the recorded public key. */
export async function importIdentityText(text, passphrase, { publicFromPrivateJwk } = {}) {
  const wrong = () => Object.assign(new Error(STRINGS.wrongPassphrase), { code: 'E_IDENTITY' });
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (_) {
    throw wrong();
  }
  if (!obj || obj.type !== 'mw-identity' || obj.v !== 1 || obj.kdf !== 'PBKDF2-SHA256') throw wrong();
  const iter = Number(obj.iter);
  if (!Number.isInteger(iter) || iter < 1000 || iter > 10000000) throw wrong();
  let jwk;
  try {
    const key = await deriveWrapKey(String(passphrase), b64urlDecode(obj.salt), iter);
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv: b64urlDecode(obj.iv), additionalData: identityAad(obj.ledger, obj.pub) }, key, b64urlDecode(obj.ct));
    jwk = JSON.parse(new TextDecoder().decode(plain));
  } catch (_) {
    throw wrong();
  }
  if (typeof publicFromPrivateJwk === 'function') {
    const pub = await publicFromPrivateJwk(jwk);
    if (pub !== obj.pub) throw wrong();
  }
  return { jwk, pub: obj.pub, ledgerId: obj.ledger || null };
}

/**
 * storeKey(cache, crypto, name, { pair, jwk, pub }) -> { privateKey, pub, kind }
 * The CryptoKey pair is the whole value of the keys store; a put/get/sign/verify round trip runs
 * first, and when it fails (iOS DataCloneError) the private JWK is stored and imported as a
 * non-extractable key for this session instead.
 */
export async function storeKey(cache, crypto, name, { pair = null, jwk = null, pub, add = false }) {
  // add (code review round 1): never replace a key another tab stored first (cache.addKey, an
  // IndexedDB add()); null = it did, use that one.
  const put = async (value) => {
    if (add && typeof cache.addKey === 'function') return cache.addKey(name, value);
    await cache.saveKey(name, value);
    return true;
  };
  let useJwk = jwk;
  let mine = false;
  if (pair) {
    try {
      if (!(await put({ kind: 'cryptokey', privateKey: pair.privateKey, publicKey: pair.publicKey, pub }))) return null;
      mine = true;
      const back = await cache.getKey(name);
      if (!back || !back.privateKey) throw new Error('round trip lost the key');
      if (add && back.pub !== pub) return null; // another tab's key: not a failed self-test
      const sig = await crypto.sign(back.privateKey, 'mw-selftest');
      if (!(await crypto.verify(pub, 'mw-selftest', sig))) throw new Error('round trip key does not verify');
      return { privateKey: back.privateKey, pub, kind: 'cryptokey' };
    } catch (_) {
      if (!useJwk) useJwk = await crypto.exportPrivateJwk(pair.privateKey);
    }
  }
  const value = { kind: 'jwk', jwk: useJwk, pub };
  if (mine) await cache.saveKey(name, value); // replaces our own unusable record
  else if (!(await put(value))) return null;
  const privateKey = await crypto.importPrivateJwk(useJwk, { extractable: false });
  return { privateKey, pub, kind: 'jwk' };
}

async function readIdentity(cache, crypto, name) {
  let rec = null;
  try {
    rec = await cache.getKey(name);
  } catch (_) {
    rec = null;
  }
  if (rec && rec.kind === 'cryptokey' && rec.privateKey && rec.pub) return { privateKey: rec.privateKey, pub: rec.pub, kind: 'cryptokey', record: rec };
  if (rec && rec.kind === 'jwk' && rec.jwk && rec.pub) {
    const privateKey = await crypto.importPrivateJwk(rec.jwk, { extractable: false });
    return { privateKey, pub: rec.pub, kind: 'jwk', record: rec };
  }
  return null;
}

/**
 * ensureIdentity({ cache, crypto, ledgerId, create = true }) -> the 0.2.1 ledger identity keyed
 * 'identity:<ledgerId>'. create: false only reads (null when there is none): what the v0.3 path uses to find a
 * key to migrate.
 */
export async function ensureIdentity({ cache, crypto, ledgerId, create = true }) {
  const name = 'identity:' + ledgerId;
  const found = await readIdentity(cache, crypto, name);
  if (found) return found;
  if (create === false) return null;
  // Extractable so Settings can export it (passphrase-wrapped); it never leaves this origin otherwise.
  const pair = await crypto.generateKeyPair({ extractable: true });
  const pub = await crypto.exportPublicKey(pair.publicKey);
  const stored = await storeKey(cache, crypto, name, { pair, pub, add: true });
  if (stored === null) {
    const theirs = await readIdentity(cache, crypto, name);
    if (theirs) return theirs;
    throw Object.assign(new Error('the identity another tab created could not be read'), { code: 'E_IDENTITY' });
  }
  return Object.assign(stored, { record: await cache.getKey(name).catch(() => null) });
}

/** exportCurrentIdentity({ cache, crypto, ledgerId, passphrase, iterations }) -> the wrapped text. */
export async function exportCurrentIdentity({ cache, crypto, ledgerId, passphrase, iterations = CONFIG.identity.pbkdf2Iterations }) {
  const rec = await cache.getKey('identity:' + ledgerId);
  if (!rec || !rec.pub) throw Object.assign(new Error('no identity on this device yet'), { code: 'E_IDENTITY' });
  const jwk = rec.kind === 'jwk' ? rec.jwk : await crypto.exportPrivateJwk(rec.privateKey);
  return exportIdentityText({ jwk, pub: rec.pub, ledgerId, passphrase, iterations });
}

/** importIdentity({ cache, crypto, ledgerId, text, passphrase }) -> { pub }. The page reloads to use it. */
export async function importIdentity({ cache, crypto, ledgerId, text, passphrase }) {
  const res = await importIdentityText(text, passphrase, { publicFromPrivateJwk: crypto.publicFromPrivateJwk });
  let pair = null;
  try {
    const privateKey = await crypto.importPrivateJwk(res.jwk, { extractable: true });
    const publicKey = await globalThis.crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: res.jwk.x, y: res.jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
    pair = { privateKey, publicKey };
  } catch (_) {
    pair = null;
  }
  await storeKey(cache, crypto, 'identity:' + ledgerId, { pair, jwk: res.jwk, pub: res.pub });
  return { pub: res.pub };
}

// ---------------------------------------------------------------------------------------------
// v0.3: the drop-in adapter over the identity client and the working keys
// ---------------------------------------------------------------------------------------------

/**
 * countPostsBy(node, pub) -> the number of payload entries pub wrote to this ledger, or null when unknown: no node, or a copy
 * that holds nothing past the genesis yet (review round UX-5: a ledger still syncing must not report "No posts found" after
 * a correct restore; the identity page shows nothing for null).
 */
export function countPostsBy(node, pub) {
  if (!node || typeof pub !== 'string') return null;
  let blocks = null;
  try {
    blocks = typeof node.exportBlocks === 'function' ? node.exportBlocks() : null;
  } catch (_) {
    blocks = null;
  }
  if (!Array.isArray(blocks)) return null;
  let n = 0;
  for (const b of blocks) {
    const e = b && b.e;
    if (e && e.author === pub && e.op && (e.op.t === 'put' || e.op.t === 'append' || e.op.t === 'profile')) n++;
  }
  if (n === 0 && blocks.length <= 1) return null;
  return n;
}

/**
 * legacyAccess({ cache, ledgerId, write }) -> { get(), remove(), write(item) } for migrate.js:
 * get() -> the stored 0.2.1 record { kind, privateKey | jwk, pub } or null (a moderator key is never migrated);
 * remove() deletes it (called only after a backup file exists); write(item) appends the mw.link item as a block
 * authored by the legacy key (supplied by the engine, which can open a writer with that key).
 */
export function legacyAccess({ cache, ledgerId, write = null } = {}) {
  const name = 'identity:' + ledgerId;
  return {
    async get() {
      if (!cache || typeof cache.getKey !== 'function') return null;
      let rec = null;
      try { rec = await cache.getKey(name); } catch (_) { rec = null; }
      if (!rec || typeof rec.pub !== 'string' || (rec.kind !== 'cryptokey' && rec.kind !== 'jwk')) return null;
      return rec;
    },
    async remove() {
      if (cache && typeof cache.deleteKey === 'function') await cache.deleteKey(name);
    },
    async write(item) {
      if (typeof write !== 'function') return false;
      await write(item);
      return true;
    },
  };
}

/**
 * createDropinIdentity(opts) -> { service, legacy, boot(), completeRedirect(), destroy() }
 * opts: { win, cache, ledgerId, pointer (the record text), node, cfg, prompt, idp, idb, channelFactory, onKeys,
 *         sharedHub, writeLegacy(item), client (tests), Keys (tests) }
 * boot(): on /_mw/idp-return (<meta name="mw-idp-return">) it stores the identity origin's answer for this tab
 * and goes back to the page that started the sign-in; elsewhere it takes such an answer, or the "Stay signed in"
 * keys, and reports whether the visitor is signed in.
 */
export function createDropinIdentity(opts = {}) {
  const win = opts.win || (typeof window !== 'undefined' ? window : null);
  const client = opts.client || identityClient;
  const Keys = opts.Keys || WorkingKeys;
  const legacy = legacyAccess({ cache: opts.cache, ledgerId: opts.ledgerId, write: opts.writeLegacy });
  const service = createIdentityService({
    node: opts.node || null, ledgerId: opts.ledgerId, pointer: opts.pointer || undefined, scope: opts.scope, cfg: opts.cfg, prompt: opts.prompt,
    countPosts: (pub) => countPostsBy(opts.node, pub), client, Keys, origin: win && win.location ? win.location.origin : undefined,
    idb: opts.idb, channelFactory: opts.channelFactory, win, idp: opts.idp, sharedHub: opts.sharedHub === true, legacy, onKeys: opts.onKeys,
    now: opts.now,
  });

  function onReturnPage() {
    if (!win || !win.location || win.location.pathname !== identityClient.RETURN_PATH) return false;
    const doc = win.document;
    try {
      return Boolean(doc && typeof doc.querySelector === 'function' && doc.querySelector('meta[name="mw-idp-return"]'));
    } catch (_) {
      return false;
    }
  }

  async function completeRedirect() {
    const r = await client.completeRedirect({ win, defer: true });
    if (!r) return null;
    if (r.deferred && typeof r.returnTo === 'string') {
      try { win.location.replace(r.returnTo); } catch (_) { /* stay */ }
    }
    return r;
  }

  async function boot() {
    if (onReturnPage()) {
      await completeRedirect();
      return false;
    }
    if (typeof client.takeDeferredAnswer === 'function') {
      const answer = await client.takeDeferredAnswer({ win }).catch(() => null);
      if (answer && answer.bundle) {
        await service.adopt(answer);
        return true;
      }
    }
    return service.restore();
  }

  return {
    service, legacy, boot, completeRedirect,
    destroy: () => service.destroy(),
  };
}
