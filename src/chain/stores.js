// Site ledger persistence (ARCHITECTURE 6.7). Two stores with one API:
//   open(siteId) / getAll() -> Block[] / put(block) / putMany(blocks) / dropValue(h)
//   getMeta(k) / setMeta(k, v) / flush() / close()
// MemoryBlockStore keeps everything in memory (Node, tests, tools). IdbBlockStore keeps the ledger in
// IndexedDB 'mw-chain-<sanitised ledger id>' with stores 'blocks' (keyPath h) and 'meta'.
// Write-through: put()/putMany() resolve only once the transaction has committed, so node.js can
// guarantee a block is on disk before put() resolves and before it is relayed. Meta writes (heads,
// root, bytes) are buffered and flushed after a short delay, on flush(), on close() and when the
// page becomes hidden (visibilitychange). IndexedDB rule: every value is built before a readwrite
// transaction opens and nothing is awaited inside one (dropValue edits inside a request callback).
// Stored blocks are plain JSON { e, h, s, v?, z? }; tombstoning deletes v and its salt z (v0.2.1
// A1), never anything inside e.
// Checkpoints (v0.3 freeze group, DESIGN-REVIEW 2.5.3): applyCheckpoint({ h, snap, S }, covered) keeps the
// checkpoint state S in meta under 'checkpoint' and deletes every covered row (stubs included) in the same
// transaction, so a reopened node prunes its DAG to S (dag.pruneTo) before it loads the remaining rows,
// and later blocks naming covered parents are accepted as if the parents were held. getCheckpoint()
// returns { h, snap, S } or null. deleteMany(hashes) removes rows.

const PAYLOAD = new Set(['put', 'append', 'profile']);

function copyBlock(b) {
  const out = { e: b.e, h: b.h, s: b.s };
  if (b.v !== undefined) {
    out.v = b.v;
    if (b.z !== undefined) out.z = b.z;
  }
  return out;
}

function cloneJson(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function checkCheckpoint(meta) {
  if (!meta || typeof meta !== 'object' || typeof meta.h !== 'string' || typeof meta.snap !== 'string' || !meta.S || typeof meta.S !== 'object') {
    throw new TypeError('expected a checkpoint { h, snap, S }');
  }
}

function checkBlock(b) {
  if (!b || typeof b !== 'object' || typeof b.h !== 'string' || !b.e || typeof b.e !== 'object') {
    throw new TypeError('expected a ledger block { e, h, s, v? }');
  }
}

export class MemoryBlockStore {
  constructor() {
    this.siteId = null;
    this.opened = false;
    this.closed = false;
    this.writes = 0;
    this._blocks = new Map();
    this._meta = new Map();
  }

  /** Reopening the same instance keeps its contents (a node restart in tests and tools). */
  async open(siteId) {
    if (this.siteId !== null && this.siteId !== siteId) {
      this._blocks.clear();
      this._meta.clear();
    }
    this.siteId = siteId;
    this.opened = true;
    this.closed = false;
    return this;
  }

  async getAll() {
    return Array.from(this._blocks.values(), copyBlock);
  }

  async put(block) {
    checkBlock(block);
    this._blocks.set(block.h, copyBlock(block));
    this.writes++;
  }

  async putMany(blocks) {
    for (const b of blocks) checkBlock(b);
    for (const b of blocks) this._blocks.set(b.h, copyBlock(b));
    this.writes++;
  }

  async dropValue(h) {
    const b = this._blocks.get(h);
    if (b && (b.v !== undefined || b.z !== undefined) && b.e && b.e.op && PAYLOAD.has(b.e.op.t)) {
      delete b.v;
      delete b.z;
      this.writes++;
    }
  }

  async getMeta(k) {
    return cloneJson(this._meta.get(k));
  }

  async setMeta(k, v) {
    this._meta.set(k, cloneJson(v));
  }

  async deleteMany(hashes) {
    for (const h of hashes || []) if (this._blocks.delete(h)) this.writes++;
  }

  /** applyCheckpoint({ h, snap, S }, covered): keeps S, deletes the covered rows (see the header). */
  async applyCheckpoint(meta, covered) {
    checkCheckpoint(meta);
    this._meta.set('checkpoint', cloneJson(meta));
    for (const h of covered || []) this._blocks.delete(h);
    this.writes++;
  }

  /** getCheckpoint() -> { h, snap, S } | null */
  async getCheckpoint() {
    const cp = this._meta.get('checkpoint');
    return cp === undefined ? null : cloneJson(cp);
  }

  async flush() {}

  async close() {
    this.closed = true;
    this.opened = false;
  }

  /** Number of stored blocks (tests). */
  get size() {
    return this._blocks.size;
  }
}

/**
 * 'mw-chain-' + the ledger id with every character outside [A-Za-z0-9_-] written as '.' and two
 * hex digits ('.u' and four hex digits above U+00FF): readable and injective.
 */
export function dbNameFor(siteId) {
  const safe = String(siteId).replace(/[^A-Za-z0-9_-]/g, (c) => {
    const code = c.charCodeAt(0);
    return code < 256 ? '.' + code.toString(16).padStart(2, '0') : '.u' + code.toString(16).padStart(4, '0');
  });
  return 'mw-chain-' + safe;
}

function requestPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
  });
}

export class IdbBlockStore {
  /** new IdbBlockStore({ indexedDB, metaDelayMs = 3000, doc }) - every option is for tests. */
  constructor({ indexedDB = globalThis.indexedDB, metaDelayMs = 3000, doc = globalThis.document } = {}) {
    this.idb = indexedDB;
    this.metaDelayMs = metaDelayMs;
    this.doc = doc && typeof doc.addEventListener === 'function' ? doc : null;
    this.db = null;
    this.siteId = null;
    this.name = null;
    this._pendingMeta = new Map();
    this._metaTimer = null;
    this._onVisibility = () => {
      if (this.doc && this.doc.visibilityState === 'hidden') this.flush().catch(() => {});
    };
  }

  async open(siteId) {
    if (!this.idb || typeof this.idb.open !== 'function') {
      // A caller may fall back to a MemoryBlockStore (the ledger then lasts one page view).
      const err = new Error('IndexedDB is not available');
      err.code = 'E_STORAGE';
      throw err;
    }
    if (this.db) await this.close();
    this.siteId = siteId;
    this.name = dbNameFor(siteId);
    const req = this.idb.open(this.name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('blocks')) db.createObjectStore('blocks', { keyPath: 'h' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onblocked = () => {};
    this.db = await requestPromise(req);
    this.db.onversionchange = () => {
      try {
        this.db.close();
      } catch (_) {
        // already closed
      }
      this.db = null;
    };
    if (this.doc) this.doc.addEventListener('visibilitychange', this._onVisibility);
    return this;
  }

  _store(name, mode) {
    if (!this.db) throw new Error('the ledger store is closed');
    const tx = this.db.transaction(name, mode);
    return { tx, store: tx.objectStore(name) };
  }

  async getAll() {
    const { store } = this._store('blocks', 'readonly');
    const rows = await requestPromise(store.getAll());
    return Array.isArray(rows) ? rows : [];
  }

  async put(block) {
    return this.putMany([block]);
  }

  async putMany(blocks) {
    const rows = [];
    for (const b of blocks) {
      checkBlock(b);
      rows.push(copyBlock(b));
    }
    if (rows.length === 0) return;
    const { tx, store } = this._store('blocks', 'readwrite');
    const done = txDone(tx);
    for (const row of rows) store.put(row);
    await done;
  }

  async dropValue(h) {
    const { tx, store } = this._store('blocks', 'readwrite');
    const done = txDone(tx);
    const req = store.get(h);
    req.onsuccess = () => {
      const row = req.result;
      if (row && (row.v !== undefined || row.z !== undefined) && row.e && row.e.op && PAYLOAD.has(row.e.op.t)) {
        delete row.v;
        delete row.z;
        store.put(row);
      }
    };
    await done;
  }

  async deleteMany(hashes) {
    const list = Array.from(hashes || []);
    if (list.length === 0) return;
    const { tx, store } = this._store('blocks', 'readwrite');
    const done = txDone(tx);
    for (const h of list) store.delete(h);
    await done;
  }

  /**
   * applyCheckpoint({ h, snap, S }, covered): one readwrite transaction over 'blocks' and 'meta' that
   * stores S under 'checkpoint' and deletes the covered rows (see the header).
   */
  async applyCheckpoint(meta, covered) {
    checkCheckpoint(meta);
    const value = cloneJson(meta);
    const list = Array.from(covered || []);
    if (!this.db) throw new Error('the ledger store is closed');
    const tx = this.db.transaction(['blocks', 'meta'], 'readwrite');
    const done = txDone(tx);
    const blocks = tx.objectStore('blocks');
    const metaStore = tx.objectStore('meta');
    metaStore.put(value, 'checkpoint');
    for (const h of list) blocks.delete(h);
    this._pendingMeta.delete('checkpoint');
    await done;
  }

  /** getCheckpoint() -> { h, snap, S } | null */
  async getCheckpoint() {
    const cp = await this.getMeta('checkpoint');
    return cp === undefined || cp === null ? null : cp;
  }

  async getMeta(k) {
    if (this._pendingMeta.has(k)) return cloneJson(this._pendingMeta.get(k));
    const { store } = this._store('meta', 'readonly');
    return requestPromise(store.get(k));
  }

  async setMeta(k, v) {
    this._pendingMeta.set(k, cloneJson(v));
    if (this._metaTimer === null) {
      this._metaTimer = setTimeout(() => {
        this._metaTimer = null;
        this.flush().catch(() => {});
      }, this.metaDelayMs);
      // Node (tools, tests): a pending meta write never keeps the process alive; close() flushes.
      if (this._metaTimer && typeof this._metaTimer === 'object' && typeof this._metaTimer.unref === 'function') this._metaTimer.unref();
    }
  }

  async flush() {
    if (this._metaTimer !== null) {
      clearTimeout(this._metaTimer);
      this._metaTimer = null;
    }
    if (this._pendingMeta.size === 0 || !this.db) return;
    const entries = Array.from(this._pendingMeta.entries());
    this._pendingMeta.clear();
    try {
      const { tx, store } = this._store('meta', 'readwrite');
      const done = txDone(tx);
      for (const [k, v] of entries) store.put(v, k);
      await done;
    } catch (err) {
      // Code review v0.3 (round 2, chat-calls-media request): a failed transaction keeps what it held (the node's grace
      // times, its root), so the next flush writes them; a newer value set meanwhile wins.
      for (const [k, v] of entries) if (!this._pendingMeta.has(k)) this._pendingMeta.set(k, v);
      throw err;
    }
  }

  async close() {
    try {
      await this.flush();
    } catch (_) {
      // a failed meta write must not keep the database open
    }
    if (this.doc) this.doc.removeEventListener('visibilitychange', this._onVisibility);
    if (this.db) {
      try {
        this.db.close();
      } catch (_) {
        // already closed
      }
    }
    this.db = null;
  }
}
