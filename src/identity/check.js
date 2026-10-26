// Crypto self-test at the identity origin and the site loader (R 2.12 key storage): can this
// browser sign and verify with a non-extractable ECDSA P-256 key, run ECDH P-256, and keep a
// CryptoKey in IndexedDB (iOS has thrown DataCloneError there)? Pure: Node >= 22 and browsers.

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };
const MSG = new TextEncoder().encode('mw-selftest-v1');

async function signCheck(subtle) {
  const { privateKey, publicKey } = await subtle.generateKey(ECDSA, false, ['sign', 'verify']);
  const sig = await subtle.sign(SIGN, privateKey, MSG);
  if (new Uint8Array(sig).length !== 64) return false;
  return (await subtle.verify(SIGN, publicKey, sig, MSG)) === true;
}

async function ecdhCheck(subtle) {
  const a = await subtle.generateKey(ECDH, false, ['deriveBits']);
  const b = await subtle.generateKey(ECDH, false, ['deriveBits']);
  const ab = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: b.publicKey }, a.privateKey, 256));
  const ba = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: a.publicKey }, b.privateKey, 256));
  if (ab.length !== 32) return false;
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= ab[i] ^ ba[i];
  return diff === 0;
}

function idbRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbCheck(subtle, idb) {
  if (!idb || typeof idb.open !== 'function') return false;
  const name = 'mw-selftest-' + Math.random().toString(36).slice(2);
  const open = idb.open(name, 1);
  open.onupgradeneeded = () => open.result.createObjectStore('k');
  const db = await idbRequest(open);
  try {
    const { privateKey, publicKey } = await subtle.generateKey(ECDSA, false, ['sign', 'verify']);
    const tx = db.transaction('k', 'readwrite');
    await idbRequest(tx.objectStore('k').put(privateKey, 'p'));
    const back = await idbRequest(db.transaction('k', 'readonly').objectStore('k').get('p'));
    if (!back || back.extractable !== false) return false;
    const sig = await subtle.sign(SIGN, back, MSG);
    return (await subtle.verify(SIGN, publicKey, sig, MSG)) === true;
  } finally {
    db.close();
    try { idb.deleteDatabase(name); } catch (_) { /* best effort */ }
  }
}

async function attempt(fn) {
  try {
    return (await fn()) === true;
  } catch (_) {
    return false;
  }
}

/**
 * selfTest(cryptoApi = globalThis.crypto, { indexedDB }) -> { idb, sign, ecdh } (booleans).
 * idb is false where IndexedDB is missing (Node) or cannot store a CryptoKey.
 */
export async function selfTest(cryptoApi = globalThis.crypto, { indexedDB: idb = globalThis.indexedDB } = {}) {
  const subtle = cryptoApi && cryptoApi.subtle;
  if (!subtle) return { idb: false, sign: false, ecdh: false };
  const [sign, ecdh, store] = await Promise.all([
    attempt(() => signCheck(subtle)),
    attempt(() => ecdhCheck(subtle)),
    attempt(() => idbCheck(subtle, idb)),
  ]);
  return { idb: store, sign, ecdh };
}
