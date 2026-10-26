// Fakes for the drop-in engine tests (no browser): a window with the few globals the engine reads,
// an in-memory stand-in for src/loader/cache.js, a ChainNode / TorrentManager that only record, a
// Service Worker container, a Web Locks manager and a BroadcastChannel hub. Torrents, pointers and
// keys are real (bencode, SHA-1, ECDSA); everything that would touch a network or IndexedDB is not.
import { createHash } from 'node:crypto';
import { FakeDocument } from './dropin-fake-dom.mjs';
import { encode } from '../../src/common/bencode.js';
import { parseTorrentFile } from '../../src/common/torrent-file.js';
import { buildManifest } from '../../src/loader/cache.js';
import { formatPointer, signPointer, parsePointer } from '../../src/common/pointer.js';
import { makeConsentRecord, recipientsKey, consentKeyFor } from '../../src/loader/consent.js';
import { generateKeyPair, exportPublicKey } from '../../src/chain/crypto.js';

export const ORIGIN = 'https://site.test';
export const te = new TextEncoder();

/** Polls until cond() is truthy (real time, 1 ms steps); throws with a label when it never is. */
export async function until(cond, { timeout = 4000, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('timed out waiting for ' + label);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const sha1 = (u8) => new Uint8Array(createHash('sha1').update(u8).digest());

/** files: [{ path, data: string | Uint8Array }] → a real multi-file torrent and its parsed form. */
export async function buildSite(files, { name = 'existing-site', pieceLength = 16384 } = {}) {
  const list = files.map((f) => ({ path: f.path, data: typeof f.data === 'string' ? te.encode(f.data) : f.data }));
  let total = 0;
  for (const f of list) total += f.data.length;
  const all = new Uint8Array(total);
  let off = 0;
  for (const f of list) {
    all.set(f.data, off);
    off += f.data.length;
  }
  const count = Math.ceil(total / pieceLength);
  const pieces = new Uint8Array(count * 20);
  for (let i = 0; i < count; i++) pieces.set(sha1(all.subarray(i * pieceLength, Math.min(total, (i + 1) * pieceLength))), i * 20);
  const info = { files: list.map((f) => ({ length: f.data.length, path: f.path.split('/') })), name, 'piece length': pieceLength, pieces };
  const torrentFile = encode({ 'created by': 'felinar test', info });
  const infoHash = Buffer.from(sha1(encode(info))).toString('hex');
  const parsed = await parseTorrentFile(torrentFile);
  const blobs = new Map(list.map((f) => [f.path, new Blob([f.data])]));
  const manifest = Object.assign(buildManifest(parsed, { torrentFile, kind: 'site' }), { savedAt: 1, lastVisit: 1, complete: true });
  return { torrentFile, infoHash, parsed, blobs, manifest, files: list };
}

export const SITE_FILES = [
  { path: 'css/app.3f2a1b.css', data: 'body{font:16px sans-serif}' },
  { path: 'js/app.9c0d2e.js', data: 'window.__fixture={js:true}' },
  { path: 'data.json', data: '{"hello":"world"}' },
  { path: '.mw/files.json', data: '{}' },
];

export async function newOwner() {
  const kp = await generateKeyPair({ extractable: true });
  return { privateKey: kp.privateKey, pub: await exportPublicKey(kp.publicKey) };
}

/** The content of a drop-in page's <meta name="mw-pointer">, signed for `scope`. */
export async function stampFor({ owner, scope = 'site.test', btih, seq = 1, expDays = 90, more = {} }) {
  const exp = Math.floor(Date.now() / 1000) + expDays * 86400;
  const record = Object.assign({ btih, dn: 'Existing Site', xs: ['/_mw/t/' + btih + '.torrent'], tr: ['wss://tracker.example'], owner: owner.pub, seq, exp }, more);
  return formatPointer(await signPointer(record, scope, owner.privateKey));
}

/**
 * consentPref(stampText, choice) → [key, value]: the stored consent of a returning visitor of this stamped
 * page (v0.2.1 C1): the versioned per-origin record { v, choice, dns, day, scope, rcpt } with the
 * recipients of this pointer, as the engine writes it. Use as memoryCache({ prefs: Object.fromEntries([...]) }).
 */
export function consentPref(stampText, choice, { origin = ORIGIN } = {}) {
  const record = parsePointer(stampText).record;
  return [consentKeyFor('dropin'), makeConsentRecord({ choice, scope: origin, rcpt: recipientsKey(record) })];
}

/** storedConsent(cache) → the choice in the stored versioned record, or null. */
export function storedConsent(cache) {
  const rec = cache.store.prefs.get(consentKeyFor('dropin'));
  return rec && typeof rec === 'object' ? rec.choice : null;
}

// ---------------------------------------------------------------------------------------------
// cache
// ---------------------------------------------------------------------------------------------

export function memoryCache(seed = {}) {
  const store = { sites: new Map(), files: new Map(), pointers: new Map(), pins: new Map(), prefs: new Map(), keys: new Map(), meta: new Map() };
  for (const [k, v] of Object.entries(seed.prefs || {})) store.prefs.set(k, v);
  const calls = [];
  const cache = {
    store,
    calls,
    failOpen: false,
    async getPin(scope) { if (cache.failOpen) throw new Error('IndexedDB is unavailable'); return store.pins.get(scope) || null; },
    async savePin(scope, owner, extra = {}) { const v = Object.assign({}, extra, { owner, decidedAt: extra.decidedAt || 1, firstSeen: extra.firstSeen || 1 }); store.pins.set(scope, v); calls.push(['savePin', scope, owner]); return v; },
    async getPointer(scope) { return store.pointers.get(scope) || null; },
    async savePointer(scope, value) { store.pointers.set(scope, value); calls.push(['savePointer', scope]); return value; },
    async getPref(key, fallback) { return store.prefs.has(key) ? store.prefs.get(key) : fallback; },
    async setPref(key, value) { store.prefs.set(key, value); calls.push(['setPref', key, value]); },
    async getKey(name) { return store.keys.get(name) || null; },
    async saveKey(name, value) { store.keys.set(name, value); },
    async getSite(btih) { return store.sites.get(btih) || null; },
    async getFile(btih, path) { return store.files.get(btih + '/' + path) || null; },
    async saveSite(manifest, blobs) {
      calls.push(['saveSite', manifest.btih]);
      if (cache.saveError) throw cache.saveError;
      store.sites.set(manifest.btih, Object.assign({}, manifest, { complete: true }));
      for (const f of manifest.files) store.files.set(manifest.btih + '/' + f.path, blobs.get(f.path));
      return manifest;
    },
    async deleteSite(btih) {
      calls.push(['deleteSite', btih]);
      store.sites.delete(btih);
      for (const k of Array.from(store.files.keys())) if (k.startsWith(btih + '/')) store.files.delete(k);
    },
    async touchSite(btih) { calls.push(['touchSite', btih]); return store.sites.has(btih); },
    async enforceBudget(opts) { calls.push(['enforceBudget', opts.budgetBytes]); return { evicted: [], total: 0 }; },
    async requestPersist() { calls.push(['requestPersist']); return true; },
    async estimateUsage() { return { usage: 3 * 1024 * 1024, quota: 200 * 1024 * 1024, persisted: false, sites: store.sites.size, siteBytes: 0 }; },
  };
  return cache;
}

export function putSite(cache, site) {
  cache.store.sites.set(site.infoHash, Object.assign({}, site.manifest));
  for (const f of site.manifest.files) cache.store.files.set(site.infoHash + '/' + f.path, site.blobs.get(f.path));
}

// ---------------------------------------------------------------------------------------------
// ledger and torrent fakes
// ---------------------------------------------------------------------------------------------

export class FakeChainNode {
  constructor(options) {
    this.options = options;
    this.role = 'writer';
    this.peers = 0;
    this.inSyncPeers = 0;
    this.height = 3;
    this.identity = options.identity;
    this.ownerMismatch = false;
    this.closed = false;
    this.calls = [];
    this.subs = new Set();
    this.attached = [];
    this.imported = null;
    this.state = { kv: new Map([['notice', { v: 'hi', h: 'a'.repeat(64) }]]), lists: new Map(), policy: { maxValueBytes: 2048 } };
  }

  snapshot() { return { height: this.height, kv: { notice: 'hi' }, lists: {}, profiles: {}, policy: { writers: 'open', maxValueBytes: 2048 } }; }
  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  emit() { for (const fn of Array.from(this.subs)) fn(); }
  attachTorrent(torrent) { this.attached.push(torrent); return () => { this.attached = this.attached.filter((t) => t !== torrent); }; }
  async put(k, v) { this.calls.push(['put', k, v]); return { h: 'b'.repeat(64) }; }
  async del(k) { this.calls.push(['del', k]); return { h: 'b'.repeat(64) }; }
  async append(l, v) { this.calls.push(['append', l, v]); return { h: 'b'.repeat(64) }; }
  async profile(n) { this.calls.push(['profile', n]); return { h: 'b'.repeat(64) }; }
  async tombstone(h) { this.calls.push(['tombstone', h]); return { h: 'b'.repeat(64) }; }
  async ban(a) { this.calls.push(['ban', a]); return { h: 'b'.repeat(64) }; }
  // The v0.3 ChainNode API (src/chain/node.js setIdentity, writeControl; v0.3 reconciliation), mirrored.
  setIdentity(id) { (this.bound = this.bound || []).push(id ? id.pub : null); this.identity = id || null; return true; }
  async writeControl(op) { this.calls.push(['writeControl', op]); return { h: 'b'.repeat(64) }; }
  async importSnapshot(blocks) { this.imported = blocks; }
  async close() { this.closed = true; }
}
export class FakeStore {
  constructor() { this.flushed = 0; }
  async flush() { this.flushed++; }
}

/** One per tab: its own ChainNode class, so `FakeChainNode.opened` lists only that tab's nodes. */
export function chainModule() {
  const opened = [];
  class TabNode extends FakeChainNode {
    static async open(options) {
      const node = new TabNode(options);
      opened.push(node);
      return node;
    }
  }
  TabNode.opened = opened;
  const miners = [];
  const pools = [];
  return {
    FakeChainNode: TabNode,
    miners,
    pools,
    ChainNode: TabNode,
    IdbBlockStore: FakeStore,
    createMiner: (o) => { const m = { workerUrl: o.workerUrl, destroyed: false, destroy() { this.destroyed = true; } }; miners.push(m); return m; },
    createVerifierPool: (o) => { const p = { size: o.size, workerUrl: o.workerUrl || null, mode: o.workerUrl ? 'worker' : 'inline', destroyed: false, destroy() { this.destroyed = true; } }; pools.push(p); return p; },
  };
}

/** Records what the engine asks of the TorrentManager; download() resolves with a real site. */
export function torrentModule(site, { downloadError = null, hold = false } = {}) {
  const instances = [];
  class FakeTM extends EventTarget {
    constructor(opts) {
      super();
      this.opts = opts;
      this.consent = opts.consent;
      this.policy = Object.assign({}, opts.policy);
      this.peers = 0;
      this.source = null;
      this.site = null;
      this.anchor = null;
      this.suspended = false;
      this.destroyed = false;
      this.calls = [];
      this.downloads = [];
      this.seeds = [];
      this.anchors = [];
      this.consentChanges = 0;
      this.release = null;
      if (opts.consent && opts.consent.onChange) opts.consent.onChange(() => { this.consentChanges++; this.calls.push(['consent-change', opts.consent.peersAllowed()]); });
      instances.push(this);
    }

    async download(args) {
      this.downloads.push(args);
      this.calls.push(['download']);
      if (hold) {
        await new Promise((resolve, reject) => {
          this.release = resolve;
          // Like the real TorrentManager: an aborted signal rejects with E_ABORTED.
          if (args && args.signal) args.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'E_ABORTED' })));
        });
      }
      if (downloadError) throw downloadError;
      this.source = args.record && args.record.ws && args.record.ws.length ? 'webseed' : 'peers';
      this.site = { mode: 'seed', torrent: {}, fromCache: false };
      return { torrent: {}, manifest: site.manifest, blobs: site.blobs, parsed: site.parsed };
    }

    async seedFromCache(args) { this.seeds.push(args); this.calls.push(['seedFromCache']); this.site = { mode: 'seed', fromCache: true, torrent: { once() {} } }; this.source = 'cache'; return {}; }
    async addAnchor(ledgerId, trackers) { this.anchors.push([ledgerId, trackers]); this.calls.push(['addAnchor']); this.anchor = { torrent: {} }; return {}; }
    setPolicy(p) { this.policy = Object.assign({}, p); this.calls.push(['setPolicy']); }
    setUploadsEnabled(v) { this.calls.push(['setUploadsEnabled', v]); }
    setHostOnly(v) { this.calls.push(['setHostOnly', v]); }
    stopSite() { this.calls.push(['stopSite']); }
    pause() { this.suspended = true; this.calls.push(['pause']); }
    rebuild() { this.suspended = false; this.calls.push(['rebuild']); }
    destroy() { this.destroyed = true; this.calls.push(['destroy']); }
  }
  return { TorrentManager: FakeTM, instances };
}

// ---------------------------------------------------------------------------------------------
// Service Worker container, Web Locks, BroadcastChannel
// ---------------------------------------------------------------------------------------------

export class FakeWorker {
  constructor(scriptURL, answer = null) {
    this.scriptURL = scriptURL;
    this.state = 'activated';
    this.posted = [];
    this.answer = answer;
  }

  postMessage(message, ports = []) {
    this.posted.push(message);
    const reply = this.answer ? this.answer(message) : null;
    const port = ports[0];
    if (port && typeof port.unref === 'function') port.unref();
    if (port && reply) {
      port.postMessage(reply);
      port.close();
    } else if (port) {
      setTimeout(() => { try { port.close(); } catch (_) { /* closed */ } }, 0);
    }
  }
}

/** A worker like /mw-sw.js: answers ping, map-client, site-saved and get-clients. */
export function oursWorker({ clients = {} } = {}) {
  const w = new FakeWorker(ORIGIN + '/mw-sw.js', (m) => {
    switch (m.type) {
      case 'mw-ping': return { proto: 1, type: 'mw-pong', buildId: 'test', mode: 'dropin', foreign: false };
      case 'mw-map-client': return { proto: 1, type: 'mw-ack', of: m.type, ok: true, btih: m.btih, complete: true };
      case 'mw-site-saved': return { proto: 1, type: 'mw-ack', of: m.type, ok: true, btih: m.btih, complete: true };
      case 'mw-get-clients': return { proto: 1, type: 'mw-clients', clients: w.clients, current: null };
      default: return null;
    }
  });
  w.clients = clients;
  return w;
}

export function fakeServiceWorker({ registration = null, controller = null, controlOnRegister = null } = {}) {
  const listeners = new Map();
  const calls = { register: [] };
  const container = {
    controller,
    calls,
    async getRegistration() { return registration; },
    async register(url, opts) {
      calls.register.push([url, opts]);
      const worker = controlOnRegister || oursWorker();
      registration = { scope: ORIGIN + '/', active: worker, waiting: null, installing: null, unregister: async () => { calls.unregistered = true; } };
      // The worker installs, activates and claims shortly after: controllerchange.
      setTimeout(() => { container.controller = worker; container.emit('controllerchange'); }, 5);
      return registration;
    },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { const s = listeners.get(type); if (s) s.delete(fn); },
    emit(type, ev = {}) { for (const fn of Array.from(listeners.get(type) || [])) fn(Object.assign({ type }, ev)); },
  };
  return container;
}

export class FakeLockManager {
  constructor() { this.held = new Map(); this.queues = new Map(); }

  request(name, a, b) {
    const options = typeof a === 'function' ? {} : a || {};
    const cb = typeof a === 'function' ? a : b;
    return new Promise((resolve, reject) => {
      const grant = async () => {
        this.held.set(name, true);
        try {
          resolve(await cb({ name }));
        } catch (e) {
          reject(e);
        } finally {
          this.held.delete(name);
          const next = (this.queues.get(name) || []).shift();
          if (next) next();
        }
      };
      if (!this.held.get(name)) { Promise.resolve().then(grant); return; }
      if (options.ifAvailable) { Promise.resolve().then(async () => { try { resolve(await cb(null)); } catch (e) { reject(e); } }); return; }
      const entry = () => { if (options.signal && options.signal.aborted) return; grant(); };
      if (!this.queues.has(name)) this.queues.set(name, []);
      this.queues.get(name).push(entry);
      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          const q = this.queues.get(name) || [];
          const i = q.indexOf(entry);
          if (i >= 0) q.splice(i, 1);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      }
    });
  }
}

export function broadcastHub() {
  const channels = [];
  class Channel {
    constructor(name) { this.name = name; this.closed = false; this.onmessage = null; channels.push(this); }
    postMessage(data) {
      for (const c of channels) {
        if (c !== this && c.name === this.name && !c.closed) {
          const copy = JSON.parse(JSON.stringify(data));
          Promise.resolve().then(() => { if (!c.closed && c.onmessage) c.onmessage({ data: copy }); });
        }
      }
    }
    close() { this.closed = true; }
  }
  return { Channel, channels };
}

// ---------------------------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------------------------

/**
 * A page: document with the stamp, a navigator with Service Worker and Web Locks, location, the
 * globals missingFeatures() looks for, and window events (load, pagehide, pageshow, online...).
 * Pass shared `locks` / `hub` to make several pages tabs of one browser.
 */
export function fakeWindow({ stamp, scripts = [{ src: '/_mw/mw.js' }], serviceWorker = undefined, locks = new FakeLockManager(), hub = broadcastHub(), hostname = 'site.test', userAgent = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130', connection = null, rtc = true, readyState = 'complete', matches = {}, battery = null, framed = false } = {}) {
  const metas = stamp ? [{ name: 'mw-pointer', content: stamp }] : [];
  const doc = new FakeDocument({ metas, scripts, readyState, baseURI: 'https://' + hostname + '/' });
  const win = new FakeDocument({ readyState });
  win.document = doc;
  const nav = { userAgent, onLine: true, locks, connection, serviceWorker: serviceWorker === undefined ? fakeServiceWorker() : serviceWorker };
  if (battery) nav.getBattery = async () => battery;
  if (!nav.serviceWorker) delete nav.serviceWorker;
  Object.assign(win, {
    navigator: nav,
    location: { hostname, origin: 'https://' + hostname, href: 'https://' + hostname + '/', reloaded: 0, reload() { this.reloaded++; } },
    isSecureContext: true,
    indexedDB: {},
    crypto: globalThis.crypto,
    fetch: async () => { throw new Error('no network in unit tests'); },
    TextEncoder, ReadableStream, BigInt, AbortController, AbortSignal, MessageChannel, Blob, Uint8Array, Response: globalThis.Response,
    BroadcastChannel: hub.Channel,
    matchMedia: (q) => ({ matches: Boolean(matches[q]) }),
    sessionStorage: (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })(),
    caches: null,
  });
  if (rtc) win.RTCPeerConnection = function RTCPeerConnection() {};
  win.top = framed ? {} : win;
  win.mwLocks = locks;
  win.hub = hub;
  return win;
}
