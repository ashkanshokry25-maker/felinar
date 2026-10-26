// src/media/vault.js: the persistent home of private media and private file keys on this device (R 2.9.4, MF-72;
// code review v0.3). Own items that have no ledger copy (a reader on an owner-only site, a person who chose not to
// write) and every accepted grant keep their manifest and fk here, so a reload or a sign-out followed by a sign-in
// finds them again. Until the identity-origin vault holds file keys (R 2.9.4), the store is the working keys'
// per-origin sealed cache: saveLocal / loadLocal / dropLocal of src/identity/store.js (AES-GCM under K_local, in
// IndexedDB unless the computer is shared), the cache the chat service's store already uses (chatStore in
// src/loader/api.js). Nothing here is ever sent anywhere.
//
//   keysVault(getKeys, { name }) -> { usable(), put(key, value), del(key), entries() }
//     getKeys: the working keys, or a function returning them (null when signed out: every call is a no-op)
//     name: the sealed cache entry ('media:index' for the media lane, 'files:index' for the file lane)
//     value: plain JSON; put/del are serialized, so two writes never lose each other
//
// Shared code: no imports, no Buffer, no node: imports.

function keysOf(getKeys) {
  try {
    return typeof getKeys === 'function' ? getKeys() : getKeys;
  } catch (_) {
    return null;
  }
}

function usableKeys(k) {
  return !!(k && typeof k.saveLocal === 'function' && typeof k.loadLocal === 'function');
}

/** keysVault(getKeys, { name }) -> a vault over the working keys' sealed per-origin cache. */
export function keysVault(getKeys, { name = 'media:index' } = {}) {
  let chain = Promise.resolve();
  const queue = (fn) => {
    const p = chain.then(fn, fn);
    chain = p.then(() => undefined, () => undefined);
    return p;
  };
  const load = async (k) => {
    let v = null;
    try {
      v = await k.loadLocal(name);
    } catch (_) {
      v = null;
    }
    if (!v || v.v !== 1 || !v.items || typeof v.items !== 'object' || Array.isArray(v.items)) return { v: 1, items: {} };
    return v;
  };
  return {
    usable() {
      return usableKeys(keysOf(getKeys));
    },
    put(key, value) {
      return queue(async () => {
        const k = keysOf(getKeys);
        if (!usableKeys(k) || typeof key !== 'string') return false;
        const idx = await load(k);
        idx.items[key] = value;
        await k.saveLocal(name, idx);
        return true;
      });
    },
    del(key) {
      return queue(async () => {
        const k = keysOf(getKeys);
        if (!usableKeys(k) || typeof key !== 'string') return false;
        const idx = await load(k);
        if (!Object.prototype.hasOwnProperty.call(idx.items, key)) return false;
        delete idx.items[key];
        await k.saveLocal(name, idx);
        return true;
      });
    },
    entries() {
      return queue(async () => {
        const k = keysOf(getKeys);
        if (!usableKeys(k)) return [];
        return Object.entries((await load(k)).items);
      });
    },
  };
}
