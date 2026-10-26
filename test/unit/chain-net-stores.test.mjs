// chain-net: ledger persistence (ARCHITECTURE 6.7). MemoryBlockStore, the IndexedDB name
// sanitiser, and IdbBlockStore against a strict in-memory IndexedDB: requests complete in later
// tasks, a transaction goes inactive at the next macrotask and auto-commits once idle, and a
// request on an inactive transaction throws TransactionInactiveError (so an `await` inside a
// transaction fails the test). A ChainNode over IdbBlockStore persists through a reopen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBlockStore, IdbBlockStore, dbNameFor } from '../../src/chain/stores.js';
import { ChainNode } from '../../src/chain/node.js';
import { Sim, SITE, makeIdentity, policy, append, put, tomb } from './chain-net-helpers.mjs';

// ---------------------------------------------------------------------------------------------
// A strict fake IndexedDB (just what the ledger store uses)
// ---------------------------------------------------------------------------------------------

const nextTask = (fn) => setImmediate(fn);
const clone = (v) => (v === undefined ? undefined : structuredClone(v));

function domError(name) {
  const err = new Error(name);
  err.name = name;
  return err;
}

class FakeRequest {
  constructor() {
    this.result = undefined;
    this.error = null;
    this.onsuccess = null;
    this.onerror = null;
  }
}

class FakeTransaction {
  constructor(db, names, mode) {
    this.db = db;
    this.names = names;
    this.mode = mode;
    this.active = true;
    this.pending = 0;
    this.done = false;
    this.oncomplete = null;
    this.onabort = null;
    this.onerror = null;
    this.error = null;
    db.factory.stats.transactions++;
    nextTask(() => {
      this.active = false;
      this._maybeComplete();
    });
  }

  objectStore(name) {
    if (this.names.indexOf(name) < 0) throw domError('NotFoundError');
    return new FakeStore(this, name);
  }

  _request(op) {
    if (!this.active || this.done) throw domError('TransactionInactiveError');
    const req = new FakeRequest();
    this.pending++;
    nextTask(() => {
      try {
        req.result = op();
      } catch (err) {
        req.error = err;
      }
      this.active = true;
      try {
        if (req.error) {
          if (req.onerror) req.onerror();
        } else if (req.onsuccess) {
          req.onsuccess();
        }
      } finally {
        this.active = false;
        this.pending--;
        this._maybeComplete();
      }
    });
    return req;
  }

  _maybeComplete() {
    if (this.done || this.active || this.pending > 0) return;
    this.done = true;
    nextTask(() => {
      if (this.oncomplete) this.oncomplete();
    });
  }
}

class FakeStore {
  constructor(tx, name) {
    this.tx = tx;
    this.name = name;
    this.data = tx.db.data.get(name);
    this.keyPath = tx.db.keyPaths.get(name);
  }

  get(key) {
    return this.tx._request(() => clone(this.data.get(key)));
  }

  getAll() {
    return this.tx._request(() => Array.from(this.data.keys()).sort().map((k) => clone(this.data.get(k))));
  }

  put(value, key) {
    if (this.tx.mode !== 'readwrite') throw domError('ReadOnlyError');
    const k = this.keyPath ? value[this.keyPath] : key;
    const copy = clone(value); // structured clone happens at put time, like IndexedDB
    return this.tx._request(() => {
      this.data.set(k, copy);
      return k;
    });
  }
}

class FakeDb {
  constructor(factory, name) {
    this.factory = factory;
    this.name = name;
    this.data = new Map();
    this.keyPaths = new Map();
    this.closed = false;
    this.onversionchange = null;
    const stores = this.data;
    this.objectStoreNames = { contains: (n) => stores.has(n) };
  }

  createObjectStore(name, opts) {
    this.data.set(name, new Map());
    this.keyPaths.set(name, opts && opts.keyPath ? opts.keyPath : null);
  }

  transaction(names, mode = 'readonly') {
    if (this.closed) throw domError('InvalidStateError');
    return new FakeTransaction(this, Array.isArray(names) ? names : [names], mode);
  }

  close() {
    this.closed = true;
  }
}

class FakeIndexedDB {
  constructor() {
    this.dbs = new Map();
    this.stats = { opens: 0, transactions: 0 };
  }

  open(name, version) {
    const req = new FakeRequest();
    req.onupgradeneeded = null;
    req.onblocked = null;
    this.stats.opens++;
    nextTask(() => {
      let stored = this.dbs.get(name);
      const fresh = !stored;
      if (!stored) {
        stored = { version: 0, data: new Map(), keyPaths: new Map() };
        this.dbs.set(name, stored);
      }
      const db = new FakeDb(this, name);
      db.data = stored.data;
      db.keyPaths = stored.keyPaths;
      db.objectStoreNames = { contains: (n) => stored.data.has(n) };
      req.result = db;
      if (fresh || version > stored.version) {
        stored.version = version;
        if (req.onupgradeneeded) req.onupgradeneeded();
      }
      if (req.onsuccess) req.onsuccess();
    });
    return req;
  }
}

class FakeDocument {
  constructor() {
    this.visibilityState = 'visible';
    this.listeners = new Set();
  }

  addEventListener(type, fn) {
    if (type === 'visibilitychange') this.listeners.add(fn);
  }

  removeEventListener(type, fn) {
    if (type === 'visibilitychange') this.listeners.delete(fn);
  }

  hide() {
    this.visibilityState = 'hidden';
    for (const fn of this.listeners) fn();
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function sampleBlocks() {
  const owner = await makeIdentity();
  const alice = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const p1 = await append(alice, 'gb', { text: 'one' }, [G.h]);
  const p2 = await put(alice, 'k', { n: 2 }, [p1.h]);
  const T = await tomb(owner, p1.h, [p2.h]);
  return { owner, alice, G, p1, p2, T };
}

// ---------------------------------------------------------------------------------------------

test('the fake IndexedDB is strict: a request after an await inside a transaction throws', async () => {
  const idb = new FakeIndexedDB();
  const req = idb.open('x', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('s', { keyPath: 'h' });
  const db = await new Promise((resolve) => { req.onsuccess = () => resolve(req.result); });
  const tx = db.transaction('s', 'readwrite');
  const store = tx.objectStore('s');
  store.put({ h: 'a' });
  await tick();
  assert.throws(() => store.put({ h: 'b' }), (err) => err.name === 'TransactionInactiveError');
});

test('MemoryBlockStore: rows are copies, dropValue keeps control blocks whole, reopening keeps or clears', async () => {
  const { G, p1, p2, T } = await sampleBlocks();
  const s = new MemoryBlockStore();
  await s.open(SITE);
  await s.put(G);
  await s.putMany([p1, p2, T]);
  assert.equal(s.size, 4);
  const rows = await s.getAll();
  rows[0].e = null; // callers cannot corrupt the store
  assert.ok((await s.getAll()).every((b) => b.e !== null));
  await s.dropValue(p1.h);
  await s.dropValue(T.h); // a control block: nothing to drop
  await s.dropValue('0'.repeat(64)); // unknown: no-op
  const byH = new Map((await s.getAll()).map((b) => [b.h, b]));
  assert.equal(byH.get(p1.h).v, undefined);
  assert.deepEqual(byH.get(p2.h).v, { n: 2 });
  assert.deepEqual(byH.get(T.h).e.op, T.e.op);
  const meta = { heads: [p2.h], n: 4 };
  await s.setMeta('state', meta);
  meta.n = 99;
  assert.equal((await s.getMeta('state')).n, 4, 'meta is copied in and out');
  await assert.rejects(s.put({ nope: true }), TypeError);
  await s.flush();
  await s.close();
  assert.equal(s.closed, true);
  await s.open(SITE);
  assert.equal(s.size, 4, 'the same site keeps its blocks');
  await s.open('mw1:another');
  assert.equal(s.size, 0, 'another site starts empty');
});

test('code review v0.3 round 2: a meta flush whose transaction fails keeps its entries for the next flush (a newer value wins)', async () => {
  const idb = new FakeIndexedDB();
  const s = new IdbBlockStore({ indexedDB: idb, doc: new FakeDocument(), metaDelayMs: 60000 });
  await s.open(SITE);
  await s.setMeta('grace', { a: 1 });
  await s.setMeta('state', { n: 1 });
  const real = s._store.bind(s);
  s._store = (name, mode) => {
    if (mode !== 'readwrite') return real(name, mode);
    const tx = { oncomplete: null, onabort: null, onerror: null, error: Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' }) };
    return { tx, store: { put() { setImmediate(() => tx.onabort && tx.onabort()); } } };
  };
  await assert.rejects(s.flush(), /QuotaExceededError/);
  s._store = real;
  await s.setMeta('state', { n: 2 }); // set again meanwhile: this value wins over the one the failed flush held
  await s.flush();
  const again = new IdbBlockStore({ indexedDB: idb, doc: new FakeDocument() });
  await again.open(SITE);
  assert.deepEqual(await again.getMeta('grace'), { a: 1 }, 'the grace times the failed flush held were written by the next one');
  assert.deepEqual(await again.getMeta('state'), { n: 2 });
  await s.close();
  await again.close();
});

test('dbNameFor: mw-chain- prefix, readable, injective', () => {
  assert.equal(dbNameFor('btih:' + 'a'.repeat(40)), 'mw-chain-btih.3a' + 'a'.repeat(40));
  assert.equal(dbNameFor('mw1:AbC_-9'), 'mw-chain-mw1.3aAbC_-9');
  const ids = ['mw1:abc', 'mw1.3aabc', 'mw1:a.b', 'mw1:a/b', 'mw1:aé', 'mw1:a中', 'mw1:a.u4e2d'];
  const names = ids.map(dbNameFor);
  assert.equal(new Set(names).size, ids.length);
  for (const n of names) assert.match(n, /^mw-chain-[A-Za-z0-9_.-]+$/);
});

test('IdbBlockStore: stores, rows, dropValue, buffered meta (flush, hidden, close), closed and missing IndexedDB', async () => {
  const { G, p1, p2, T } = await sampleBlocks();
  const idb = new FakeIndexedDB();
  const doc = new FakeDocument();
  const s = new IdbBlockStore({ indexedDB: idb, doc, metaDelayMs: 60000 });
  await s.open(SITE);
  assert.equal(s.name, dbNameFor(SITE));
  const raw = idb.dbs.get(s.name);
  assert.deepEqual(Array.from(raw.data.keys()).sort(), ['blocks', 'meta']);
  await s.put(G);
  await s.putMany([p1, p2, T]);
  await s.putMany([]);
  assert.equal(raw.data.get('blocks').size, 4, 'committed when putMany resolves');
  assert.deepEqual((await s.getAll()).map((b) => b.h).sort(), [G.h, p1.h, p2.h, T.h].sort());
  await s.dropValue(p1.h);
  await s.dropValue(T.h);
  const rows = new Map((await s.getAll()).map((b) => [b.h, b]));
  assert.equal(rows.get(p1.h).v, undefined);
  assert.deepEqual(rows.get(p2.h).v, { n: 2 });
  assert.deepEqual(rows.get(T.h).e.op, T.e.op);
  await assert.rejects(s.putMany([{ h: 1 }]), TypeError);
  // Meta is buffered: readable at once, written on flush().
  await s.setMeta('state', { n: 4 });
  assert.deepEqual(await s.getMeta('state'), { n: 4 });
  assert.equal(raw.data.get('meta').size, 0);
  await s.flush();
  assert.deepEqual(raw.data.get('meta').get('state'), { n: 4 });
  // ... and when the page becomes hidden.
  await s.setMeta('state', { n: 5 });
  doc.hide();
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(raw.data.get('meta').get('state'), { n: 5 });
  // ... and on close().
  await s.setMeta('state', { n: 6 });
  await s.close();
  assert.deepEqual(raw.data.get('meta').get('state'), { n: 6 });
  assert.equal(doc.listeners.size, 0, 'the visibility listener is removed');
  await assert.rejects(s.getAll(), /closed/);
  // Reopen: everything is still there.
  const again = new IdbBlockStore({ indexedDB: idb, doc });
  await again.open(SITE);
  assert.equal((await again.getAll()).length, 4);
  assert.deepEqual(await again.getMeta('state'), { n: 6 });
  await again.close();
  // No IndexedDB at all (some in-app WebViews).
  await assert.rejects(new IdbBlockStore({ indexedDB: null }).open(SITE), (err) => err.code === 'E_STORAGE');
});

test('a ChainNode over IdbBlockStore: write-through, tombstone drops the stored value, reopen restores the ledger', async () => {
  const sim = new Sim();
  const owner = await makeIdentity();
  const alice = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const idb = new FakeIndexedDB();
  const seed = new IdbBlockStore({ indexedDB: idb });
  await seed.open(SITE);
  await seed.putMany([G]);
  await seed.close();
  const open = (identity) => ChainNode.open({
    siteId: SITE, expectedOwner: owner.pub, store: new IdbBlockStore({ indexedDB: idb, metaDelayMs: 10 }), identity,
    now: sim.now, setTimeoutFn: sim.setTimeout, clearTimeoutFn: sim.clearTimeout,
  });
  const node = await open(alice);
  const a = await node.append('gb', { text: 'kept' });
  const b = await node.append('gb', { text: 'removed' });
  const raw = idb.dbs.get(dbNameFor(SITE)).data.get('blocks');
  assert.ok(raw.has(a.h) && raw.has(b.h), 'stored before append() resolved');
  await node.tombstone(b.h);
  assert.equal(raw.get(b.h).v, undefined, 'the stored copy lost its value');
  const before = node.snapshot();
  const root = node.dag.root();
  await node.close();
  const reopened = await open(null);
  assert.equal(reopened.dag.root(), root);
  assert.deepEqual(reopened.snapshot(), before);
  assert.deepEqual(reopened.snapshot().lists.gb.map((x) => x.v.text), ['kept']);
  await reopened.close();
});
