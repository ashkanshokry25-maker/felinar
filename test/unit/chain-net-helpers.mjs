// Shared fixtures for the chain-net tests (not a test file itself): a deterministic network
// simulator with a virtual clock, identities, block builders and ledger fixtures. Pure Node,
// no sockets: every "network" here is an in-memory event queue.

import { ChainNode } from '../../src/chain/node.js';
import { MemoryBlockStore } from '../../src/chain/stores.js';
import { createBlock } from '../../src/chain/block.js';
import { generateKeyPair, exportPublicKey } from '../../src/chain/crypto.js';

export const SITE = 'mw1:chainnettestsite000000000';
export const T0 = Date.UTC(2026, 9, 18, 12, 0, 0);

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function makeIdentity() {
  const kp = await generateKeyPair();
  return { privateKey: kp.privateKey, pub: await exportPublicKey(kp.publicKey) };
}

// ---------------------------------------------------------------------------------------------
// Virtual-time event simulator
// ---------------------------------------------------------------------------------------------

function heapPush(heap, ev) {
  heap.push(ev);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (before(heap[parent], heap[i])) break;
    [heap[parent], heap[i]] = [heap[i], heap[parent]];
    i = parent;
  }
}

function heapPop(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < heap.length && before(heap[l], heap[m])) m = l;
      if (r < heap.length && before(heap[r], heap[m])) m = r;
      if (m === i) break;
      [heap[m], heap[i]] = [heap[i], heap[m]];
      i = m;
    }
  }
  return top;
}

function before(a, b) {
  return a.at < b.at || (a.at === b.at && a.seq < b.seq);
}

/**
 * Sim: virtual clock + event queue. now/setTimeout/clearTimeout are injected into nodes and
 * gossips; every delivery awaits the receiver's handle() so runs are deterministic.
 */
export class Sim {
  constructor({ seed = 1, start = T0 } = {}) {
    this.t = start;
    this.heap = [];
    this.seq = 0;
    this.rand = mulberry32(seed);
    this.stats = { delivered: 0, lost: 0, frames: [] };
    this.trace = null; // optional (from, to, u8) recorder
    this.now = () => this.t;
    this.setTimeout = (fn, ms) => this.schedule(Math.max(0, Number(ms) || 0), fn);
    this.clearTimeout = (ev) => {
      if (ev && typeof ev === 'object') ev.cancelled = true;
    };
  }

  schedule(delay, fn) {
    const ev = { at: this.t + delay, seq: this.seq++, fn, cancelled: false };
    heapPush(this.heap, ev);
    return ev;
  }

  async step() {
    while (this.heap.length > 0) {
      const ev = heapPop(this.heap);
      if (ev.cancelled) continue;
      if (ev.at > this.t) this.t = ev.at;
      await ev.fn();
      return true;
    }
    return false;
  }

  /** Runs events up to now + ms (or until `until()` is true). Returns true when `until` held. */
  async run(ms, until = null) {
    const end = this.t + ms;
    for (;;) {
      if (until && until()) return true;
      while (this.heap.length > 0 && this.heap[0].cancelled) heapPop(this.heap);
      if (this.heap.length === 0 || this.heap[0].at > end) {
        this.t = Math.max(this.t, end);
        return until ? !!until() : true;
      }
      await this.step();
    }
  }

  /**
   * link(a, b, { latency, jitter, loss }) connects two nodes (or { name, gossip }) both ways.
   * jitter reorders frames; loss drops them. Returns { down(), up(), lost }.
   */
  link(a, b, { latency = 20, jitter = 0, loss = 0, filter = null } = {}) {
    const link = { down: false, lost: 0, sent: 0 };
    const deliver = (from, to, u8) => {
      if (link.down) return false;
      link.sent++;
      if (filter && filter(from.name, to.name, u8) === false) return true;
      if (loss > 0 && this.rand() < loss) {
        link.lost++;
        this.stats.lost++;
        return true;
      }
      if (this.trace) this.trace(from.name, to.name, u8, this.t);
      const copy = u8.slice();
      const delay = latency + (jitter > 0 ? Math.floor(this.rand() * jitter) : 0);
      this.schedule(delay, () => {
        if (link.down) return undefined;
        this.stats.delivered++;
        return to.gossip.handle(from.name, copy);
      });
      return true;
    };
    a.gossip.attach({ id: b.name, send: (u8) => deliver(a, b, u8), close: () => {} });
    b.gossip.attach({ id: a.name, send: (u8) => deliver(b, a, u8), close: () => {} });
    link.cut = () => {
      link.down = true;
      a.gossip.detach(b.name);
      b.gossip.detach(a.name);
    };
    return link;
  }
}

// ---------------------------------------------------------------------------------------------
// Blocks and ledgers
// ---------------------------------------------------------------------------------------------

let seqCounter = 0;

export function mk(identity, op, value, prev, { bits = 0, ts = T0 - 3600000, site = SITE } = {}) {
  return createBlock({ identity, site, seq: ++seqCounter, prev, op, value, ts, bits, maxValueBytes: 4096 });
}
export const put = (id, k, v, prev, o) => mk(id, { t: 'put', k }, v, prev, o);
export const append = (id, l, v, prev, o) => mk(id, { t: 'append', l }, v, prev, o);
export const policy = (id, fields, prev, o) => mk(id, Object.assign({ t: 'policy' }, fields), undefined, prev, o);
export const tomb = (id, h, prev, o) => mk(id, { t: 'tombstone', h }, undefined, prev, o);
export const ban = (id, author, prev, o) => mk(id, { t: 'ban', author }, undefined, prev, o);
export const succession = (id, next, prev, o) => mk(id, { t: 'owner', next }, undefined, prev, o);

/** A store pre-filled with blocks (as a node would have persisted them). */
export async function storeWith(blocks, siteId = SITE) {
  const store = new MemoryBlockStore();
  await store.open(siteId);
  await store.putMany(blocks);
  return store;
}

/** gossipLimits for tests that time relays exactly: no announcement jitter (review round STALK-8 adds it by default). */
export const NO_JITTER = Object.freeze({ annJitterLocalMs: 0, annJitterRelayMs: 0 });

/**
 * makeNode(sim, { name, owner, identity, store, blocks, config, gossipLimits, siteId, genesisHash })
 * -> ChainNode named `name`, driven by the simulator's clock (ticks every simulated second).
 */
export async function makeNode(sim, {
  name, owner = null, identity = null, store = null, blocks = null, config = {}, gossipLimits = null,
  siteId = SITE, genesisHash = null, verifierPool = null,
} = {}) {
  const st = store || (blocks ? await storeWith(blocks, siteId) : new MemoryBlockStore());
  const node = await ChainNode.open({
    siteId,
    expectedOwner: owner,
    genesisHash,
    store: st,
    identity,
    verifierPool,
    now: sim.now,
    setTimeoutFn: sim.setTimeout,
    clearTimeoutFn: sim.clearTimeout,
    config: Object.assign({ random: sim.rand }, config), // the announcement jitter follows the simulator's seed
    gossipLimits,
  });
  node.name = name;
  return node;
}

/** Plain JSON view of a node's state, for equality checks across nodes. */
export function stateJson(node) {
  return JSON.stringify(node.snapshot());
}

export function sameLedger(a, b) {
  return a.dag.root() === b.dag.root() && stateJson(a) === stateJson(b);
}

export function allSame(nodes) {
  for (let i = 1; i < nodes.length; i++) if (!sameLedger(nodes[0], nodes[i])) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// v0.3 hardening and hub-lane helpers
// ---------------------------------------------------------------------------------------------

export const checkpointOp = (heads, made) => ({ t: 'checkpoint', heads: heads.slice().sort(), snap: made.snap, n: made.n, bytes: made.bytes });

/**
 * makeCheckpoint(owner, node, { heads, prev }) -> { block, S, snap }: the owner's checkpoint over `heads`
 * (default: the node's heads), as tools/ledger-admin.mjs would sign it (state.js checkpointFor).
 */
export async function makeCheckpoint(owner, node, { heads = null, prev = null, ts } = {}) {
  const { checkpointFor } = await import('../../src/chain/state.js');
  const hs = (heads || node.dag.heads({ limit: 32 })).slice().sort();
  const made = checkpointFor(node.dag, hs, { genesisOwner: node.genesisOwner, expectedOwner: node.expectedOwner });
  const block = await mk(owner, checkpointOp(made.heads, made), undefined, prev || hs, ts === undefined ? {} : { ts });
  return { block, S: made.S, snap: made.snap };
}

/** A transport peer attached straight to a gossip (or MultiGossip): what it is sent is kept in `sent`. */
export function rawPeer(gossip, id, { group = undefined, decode = null } = {}) {
  const peer = { id, sent: [], frames: [], closed: 0, ignored: [], delivered: 0, synced: 0 };
  const attached = gossip.attach({
    id,
    group,
    send: (u8) => {
      peer.frames.push(u8);
      if (decode) peer.sent.push(decode(u8));
    },
    close: () => { peer.closed++; },
    ignored: (reason) => { peer.ignored.push(reason); },
    delivered: () => { peer.delivered++; },
    synced: () => { peer.synced++; },
  });
  peer.attached = attached;
  peer.of = (type) => peer.sent.filter((m) => m && m.type === type);
  return peer;
}

// A strict in-memory IndexedDB (what IdbBlockStore uses, including delete): requests complete in later
// tasks and a transaction goes inactive at the next macrotask (an await inside one throws).
const nextTask = (fn) => setImmediate(fn);
const cloneValue = (v) => (v === undefined ? undefined : structuredClone(v));

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
    nextTask(() => {
      this.active = false;
      this._maybeComplete();
    });
  }

  objectStore(name) {
    if (this.names.indexOf(name) < 0) throw domError('NotFoundError');
    return new FakeObjectStore(this, name);
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

class FakeObjectStore {
  constructor(tx, name) {
    this.tx = tx;
    this.data = tx.db.data.get(name);
    this.keyPath = tx.db.keyPaths.get(name);
  }

  get(key) {
    return this.tx._request(() => cloneValue(this.data.get(key)));
  }

  getAll() {
    return this.tx._request(() => Array.from(this.data.keys()).sort().map((k) => cloneValue(this.data.get(k))));
  }

  put(value, key) {
    if (this.tx.mode !== 'readwrite') throw domError('ReadOnlyError');
    const k = this.keyPath ? value[this.keyPath] : key;
    const copy = cloneValue(value);
    return this.tx._request(() => {
      this.data.set(k, copy);
      return k;
    });
  }

  delete(key) {
    if (this.tx.mode !== 'readwrite') throw domError('ReadOnlyError');
    return this.tx._request(() => {
      this.data.delete(key);
      return undefined;
    });
  }
}

class FakeDatabase {
  constructor(stored) {
    this.data = stored.data;
    this.keyPaths = stored.keyPaths;
    this.objectStoreNames = { contains: (n) => stored.data.has(n) };
    this.closed = false;
    this.onversionchange = null;
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

export class FakeIndexedDB {
  constructor() {
    this.dbs = new Map();
  }

  open(name, version) {
    const req = new FakeRequest();
    req.onupgradeneeded = null;
    req.onblocked = null;
    nextTask(() => {
      let stored = this.dbs.get(name);
      const fresh = !stored;
      if (!stored) {
        stored = { version: 0, data: new Map(), keyPaths: new Map() };
        this.dbs.set(name, stored);
      }
      const db = new FakeDatabase(stored);
      req.result = db;
      if (fresh || version > stored.version) {
        stored.version = version;
        if (req.onupgradeneeded) req.onupgradeneeded();
      }
      if (req.onsuccess) req.onsuccess();
    });
    return req;
  }

  /** The stored rows of one object store (tests). */
  rows(dbName, storeName) {
    const stored = this.dbs.get(dbName);
    return stored && stored.data.get(storeName) ? new Map(stored.data.get(storeName)) : new Map();
  }
}
