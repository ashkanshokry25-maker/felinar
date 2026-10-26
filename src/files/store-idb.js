// src/files/store-idb.js: a writable IndexedDB chunk store for file and media torrents (R 2.8.2 step 5,
// MF-47, MF-45; ARCHITECTURE 15.7; INTERFACES "v0.3 (proposed)" src/files/*). Browsers; Node tests use
// the memory backend, which has the same surface.
//
// The abstract-chunk-store API WebTorrent expects (put, get, close, destroy, chunkLength), so a file
// torrent never sits whole in memory: the media worker route and the file lane read one piece at a
// time. Stores are named (the infohash or an item id) and survive TorrentManager.rebuild() and page
// reloads; destroy() deletes every chunk of the name.
//
//   new IdbChunkStore(chunkLength, { name, length, backend?, indexedDB? })
//     put(index, buf, cb) / get(index, opts, cb) / close(cb) / destroy(cb)
//     async has(index) / async missing() -> [index] / async complete() -> boolean
//   IdbChunkStore.factory({ name, backend?, indexedDB? }) -> a constructor for TorrentManager.addFileTorrent
//   idbBackend({ indexedDB?, dbName? }) / memoryBackend() -> { get, put, delete, deleteName, keys }
//   DB_NAME = 'mw-files', STORE = 'chunks' (key: [name, index], value: Uint8Array)

export const DB_NAME = 'mw-files';
export const STORE = 'chunks';

function storeError(message, extra) {
  const err = new Error(message);
  if (extra) Object.assign(err, extra);
  return err;
}

const asU8 = (buf) => (buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer ? buf.buffer : buf, buf.byteOffset || 0, buf.byteLength));

/** memoryBackend() -> the backend surface over a Map (tests, and a store that may vanish with the tab). */
export function memoryBackend() {
  const map = new Map();
  const k = (name, index) => name + '\u0000' + index;
  return {
    map,
    async get(name, index) {
      const v = map.get(k(name, index));
      return v ? v.slice() : undefined;
    },
    async put(name, index, bytes) {
      map.set(k(name, index), asU8(bytes).slice());
    },
    async delete(name, index) {
      map.delete(k(name, index));
    },
    async deleteName(name) {
      for (const key of Array.from(map.keys())) if (key.indexOf(name + '\u0000') === 0) map.delete(key);
    },
    async keys(name) {
      const out = [];
      for (const key of map.keys()) if (key.indexOf(name + '\u0000') === 0) out.push(Number(key.slice(name.length + 1)));
      return out.sort((a, b) => a - b);
    },
  };
}

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('IndexedDB request failed'));
  });
}

/** idbBackend({ indexedDB, dbName }) -> the backend over IndexedDB (one database, one object store). */
export function idbBackend({ indexedDB: idb = globalThis.indexedDB, IDBKeyRange: range = globalThis.IDBKeyRange, dbName = DB_NAME } = {}) {
  let dbp = null;
  const open = () => {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        if (!idb) return reject(storeError('IndexedDB is not available', { code: 'E_LIMIT' }));
        const r = idb.open(dbName, 1);
        r.onupgradeneeded = () => {
          if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
        };
        r.onsuccess = () => {
          const db = r.result;
          db.onversionchange = () => {
            db.close();
            dbp = null;
          };
          resolve(db);
        };
        r.onerror = () => reject(r.error || new Error('IndexedDB open failed'));
        r.onblocked = () => reject(storeError('IndexedDB is blocked by another tab'));
      });
      dbp.catch(() => {
        dbp = null;
      });
    }
    return dbp;
  };
  const tx = async (mode, fn) => {
    const db = await open();
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    const done = new Promise((resolve, reject) => {
      t.oncomplete = resolve;
      t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted'));
      t.onerror = () => reject(t.error || new Error('IndexedDB transaction failed'));
    });
    // A failed request fails the transaction too, while fn(s) is still rejecting: observed here, so the request's error
    // is the one the caller gets and no unhandled rejection is left behind (code review v0.3).
    done.catch(() => {});
    const out = await fn(s);
    await done;
    return out;
  };
  const bounds = (name) => range.bound([name, 0], [name, Number.MAX_SAFE_INTEGER]);
  return {
    async get(name, index) {
      const v = await tx('readonly', (s) => req(s.get([name, index])));
      return v === undefined ? undefined : asU8(v);
    },
    async put(name, index, bytes) {
      // a copy that owns its buffer: IndexedDB clones the whole underlying ArrayBuffer of a view
      await tx('readwrite', (s) => req(s.put(asU8(bytes).slice(), [name, index])));
    },
    async delete(name, index) {
      await tx('readwrite', (s) => req(s.delete([name, index])));
    },
    async deleteName(name) {
      await tx('readwrite', (s) => req(s.delete(bounds(name))));
    },
    async keys(name) {
      const keys = await tx('readonly', (s) => req(s.getAllKeys(bounds(name))));
      return keys.map((k) => k[1]).sort((a, b) => a - b);
    },
  };
}

let defaultBackend = null;

export class IdbChunkStore {
  constructor(chunkLength, opts = {}) {
    if (!Number.isSafeInteger(chunkLength) || chunkLength <= 0) throw new TypeError('IdbChunkStore: chunkLength must be a positive integer');
    this.chunkLength = chunkLength;
    this.name = typeof opts.name === 'string' && opts.name ? opts.name : (opts.torrent && opts.torrent.infoHash) || '';
    if (!this.name) throw new TypeError('IdbChunkStore: a name is required');
    this.length = Number.isSafeInteger(opts.length) ? opts.length : Infinity;
    this.lastChunkLength = Number.isFinite(this.length) ? (this.length % chunkLength) || chunkLength : chunkLength;
    this.lastIndex = Number.isFinite(this.length) ? Math.ceil(this.length / chunkLength) - 1 : Infinity;
    if (opts.backend) this.backend = opts.backend;
    else if (opts.indexedDB) this.backend = idbBackend({ indexedDB: opts.indexedDB, IDBKeyRange: opts.IDBKeyRange });
    else this.backend = defaultBackend || (defaultBackend = idbBackend());
    this.closed = false;
  }

  /** IdbChunkStore.factory({ name, backend }) -> class usable as WebTorrent's `store` option. */
  static factory(bind = {}) {
    const Base = IdbChunkStore;
    return class BoundIdbChunkStore extends Base {
      constructor(chunkLength, opts = {}) {
        super(chunkLength, Object.assign({}, opts, bind, { length: opts.length !== undefined ? opts.length : bind.length }));
      }
    };
  }

  _expected(index) {
    return index === this.lastIndex ? this.lastChunkLength : this.chunkLength;
  }

  put(index, buf, cb = () => {}) {
    if (this.closed) return queueCb(cb, storeError('Storage is closed'));
    if (!Number.isSafeInteger(index) || index < 0 || index > this.lastIndex) return queueCb(cb, storeError('Chunk index out of range'));
    const bytes = asU8(buf);
    if (bytes.length !== this._expected(index)) return queueCb(cb, storeError('Chunk length must be ' + this._expected(index)));
    this.backend.put(this.name, index, bytes).then(() => cb(null), (err) => cb(err));
  }

  get(index, opts, cb) {
    if (typeof opts === 'function') {
      cb = opts;
      opts = null;
    }
    if (this.closed) return queueCb(cb, storeError('Storage is closed'));
    this.backend.get(this.name, index).then((bytes) => {
      if (!bytes) return cb(storeError('Chunk not found', { notFound: true }));
      if (!opts) return cb(null, bytes);
      const offset = opts.offset || 0;
      const len = opts.length || bytes.length - offset;
      cb(null, bytes.subarray(offset, offset + len));
    }, (err) => cb(err));
  }

  /** getAsync(index) -> Promise<Uint8Array | undefined> (undefined when missing). */
  getAsync(index) {
    return this.backend.get(this.name, index);
  }

  putAsync(index, buf) {
    return new Promise((resolve, reject) => this.put(index, buf, (err) => (err ? reject(err) : resolve())));
  }

  async has(index) {
    return (await this.backend.get(this.name, index)) !== undefined;
  }

  async missing() {
    const have = new Set(await this.backend.keys(this.name));
    const out = [];
    for (let i = 0; i <= this.lastIndex && Number.isFinite(this.lastIndex); i++) if (!have.has(i)) out.push(i);
    return out;
  }

  async complete() {
    return Number.isFinite(this.lastIndex) && (await this.missing()).length === 0;
  }

  close(cb = () => {}) {
    this.closed = true;
    queueCb(cb, null);
  }

  destroy(cb = () => {}) {
    this.closed = true;
    this.backend.deleteName(this.name).then(() => cb(null), (err) => cb(err));
  }
}

function queueCb(cb, err) {
  Promise.resolve().then(() => cb(err));
}
