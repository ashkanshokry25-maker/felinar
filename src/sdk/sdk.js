// src/sdk/sdk.js: the site SDK, served at /_mw/sdk.js (ARCHITECTURE 9, 15.9 and 3.4.9; R 2.11; INTERFACES
// "src/sdk/sdk.js"; the method reference is docs/SDK.md).
//
//   import mw from '/_mw/sdk.js';
//   const me = await mw.ready();
//   button.onclick = async () => { await mw.auth.signIn(); await mw.db.append('guestbook', { text: 'hello' }); };
//
// Shell mode (the site runs in the loader's same-URL iframe): this module posts { mw: 'hello' } with
// a MessagePort to window.parent and talks to the loader's Bridge over that port:
//   request  { id, method, params }  ->  response { id, ok: true, result } | { id, ok: false, error: { code, message } }
//   push     { event, data }          ('state' carries the db snapshot; 'peers', 'progress', 'status', 'sync', 'pow';
//                                     v0.3: 'auth', 'chat', 'files', 'media', 'mod', 'keychange', 'hub'; C2: 'calls')
// The method is the SDK path (mw.chat.dm.send -> 'chat.dm.send'); params are named as in docs/SDK.md, for example
//   db.get { key, ledger? }   db.set { key, value }   db.append { name, value }   chat.dm.send { pub, text }
//   ping {} (handshake probe: any answer, even an error, completes the handshake)
//   write.cancel { id } (aborts the write request with that id; sent by this module when it gives up)
// Writes and their fee (code review round 1, DESIGN-REVIEW item 4): every write method takes an
// optional last argument { onProgress, signal }. While the browser computes the post's spam fee
// (proof-of-work), the host pushes { event: 'pow', data: { id, hashes, bits } }: onProgress gets
// { hashes, bits }, mw.net.on('pow', fn) gets every one, and each push restarts the write's 30 s
// answer timer (for at most 10 minutes). When the timer runs out, or `signal` aborts, this module
// sends write.cancel and rejects (E_TIMEOUT or E_POW_ABORTED); the host then never publishes it.
// A request that waits for the person (a card, the identity page, the sign-in prompt of a guest's first write)
// stays alive while the host pushes { event: 'wait', data: { id } } (every 20 s), for at most 10 minutes.
// The A4 rule (v0.2.1, extended in v0.3, R 2.11.1): a site cannot export or read a key, the root or the phrase,
// grant consent, accept a "same identity" link or choose the origin of a sign-in proof. Those methods do not
// exist. UI methods must be called from a click on the page: the loader checks it (a flag in the params is ignored).
// Drop-in mode: /_mw/mw.js binds window.mw directly to the engine. This module re-exports that object
// when it is already bound, and otherwise hands every call over to it as soon as /_mw/mw.js assigns
// window.mw, so the import order of the two scripts does not matter.
// Standalone (not inside a felinar page): every call rejects with code E_NO_HOST.
//
// v0.3 C2 (docs/research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md 3.5 and 3.1): mw.calls (start, accept and screen are UI
// methods; no method returns a MediaStream: the loader's own call panel plays the media) and mw.net.seeding(), dock()
// and keep(). In drop-in mode every mw.calls method rejects with E_UNSUPPORTED (a page load would end the call).
// Errors are Error objects with a .code (ERROR_CODES below; docs/SDK.md lists what each means).
// mw.consent.state() resolves to the state in shell mode: write `await mw.consent.state()`.
// mw.auth.state() is synchronous: the last state the loader reported ('guest' before mw.ready() resolves).
// Public keys (identity.pub, owner, authors) are algorithm-tagged strings: 'p256:' + 87 base64url.
// Everything written with mw.db is public and copied to every visitor.
// No dependencies, no top-level await.

export const SDK_VERSION = '0.3.0';
export const ERROR_CODES = Object.freeze([
  'E_POLICY', 'E_LIMIT', 'E_RATE', 'E_NOT_OWNER', 'E_NOT_MODERATOR', 'E_POW_ABORTED', 'E_IDENTITY', 'E_NO_HOST', 'E_CAP', 'E_BANNED',
  'E_BAD_REQUEST', 'E_INTERNAL', 'E_TIMEOUT',
  'E_NOT_SIGNED_IN', 'E_USER_CANCELLED', 'E_UNSUPPORTED', 'E_FIELD', 'E_DECRYPT', 'E_HOST_ONLY_IDENTITY', 'E_POPUP_BLOCKED',
  'E_IDP_UNREACHABLE', 'E_NEEDS_GESTURE', 'E_NONCE_REQUIRED', 'E_LEDGER_FULL', 'E_SYNCING', 'E_HOST_ONLY', 'E_NO_OWN_TRACKER',
  'E_NO_CHAT_KEY', 'E_BLOCKED', 'E_STAMP', 'E_NOT_MEMBER', 'E_NOT_ADMIN', 'E_NOT_CONTACT', 'E_PEER_UNREACHABLE',
  'E_FILE_UNAVAILABLE', 'E_FILE_TOMBSTONED', 'E_FILE_HASH', 'E_DENIED', 'E_MEDIA_TYPE', 'E_MEDIA_STRIP', 'E_MEDIA_UNPLAYABLE', 'E_REVOKED',
  // v0.3 C2: calls
  'E_BUSY', 'E_DECLINED', 'E_NO_ANSWER', 'E_MEDIA_DENIED', 'E_NO_DEVICE', 'E_CALL_FAILED',
]);

const FACADE = typeof Symbol === 'function' ? Symbol.for('magnet-web.sdk.facade') : '__mwSdkFacade';
const SNAPSHOT_EVENTS = ['state', 'snapshot'];
const PROBE_PREFIX = '__mw_hello_';
// Ledger writes: { onProgress, signal } report the fee; each 'pow' push keeps the request alive.
const WRITE_METHODS = ['db.set', 'db.del', 'db.append', 'db.tombstone', 'db.setMine', 'mod.ban', 'mod.unban', 'mod.tombstoneMany', 'mod.decide', 'identity.setName', 'owner.policy'];
// Argument names of each call, in order ('...' merges an options object): the same table as src/loader/api.js METHOD_ARGS.
const ARGS = {
  'auth.signIn': ['...'], 'auth.signOut': ['...'], 'auth.prove': ['...'], 'auth.verify': ['proof'], 'auth.signInServer': ['...'],
  'identity.current': [], 'identity.setName': ['name'], 'identity.backupStatus': [], 'identity.openIdentity': [],
  'me.get': ['field'], 'me.set': ['field', 'value'], 'me.del': ['field'], 'me.sync': ['...'], 'me.erase': [],
  'db.setMine': ['name', 'value'], 'db.getMine': ['name', '...'], 'db.listBy': ['name', 'author', '...'], 'db.snapshot': ['...'],
  'hub.follow': ['target', 'opts'], 'hub.unfollow': ['ledger'], 'hub.list': [], 'hub.createPage': ['...'],
  'mod.ban': ['pub', '...'], 'mod.unban': ['pub'], 'mod.tombstoneMany': ['authors', '...'], 'mod.queue': [], 'mod.decide': ['id', 'decision', '...'],
  'chat.enable': ['...'], 'chat.disable': [], 'chat.state': [],
  'chat.presence.set': ['...'], 'chat.presence.list': [],
  'chat.contacts.list': [], 'chat.contacts.add': ['pub', '...'], 'chat.contacts.remove': ['pub'], 'chat.contacts.block': ['pub'],
  'chat.contacts.unblock': ['pub'], 'chat.contacts.verify': ['pub'],
  'chat.requests.list': [], 'chat.requests.accept': ['id'], 'chat.requests.decline': ['id'], 'chat.requests.setOpen': ['open'],
  'chat.dm.send': ['pub', '...'], 'chat.dm.history': ['pub', '...'], 'chat.dm.keepHistory': ['pub', 'on'],
  'chat.room.join': ['name'], 'chat.room.leave': ['name'], 'chat.room.send': ['name', '...'],
  'chat.group.create': ['...'], 'chat.group.invite': ['groupId', 'pub'], 'chat.group.remove': ['groupId', 'pub'],
  'chat.group.leave': ['groupId'], 'chat.group.send': ['groupId', '...'],
  'chat.holder.set': ['on'], 'chat.direct.connect': ['pub'],
  'files.enable': [], 'files.list': [], 'files.received': [], 'files.share': ['file', '...'], 'files.fetch': ['ref', '...'],
  'files.preview': ['ref'], 'files.save': ['ref'], 'files.keepSharing': ['ref', 'on'], 'files.stopSharing': ['ref'],
  'files.remove': ['ref'], 'files.pinRequest': ['ref'],
  'media.upload': ['file', '...'], 'media.list': ['...'], 'media.open': ['id', '...'], 'media.close': ['id'],
  'media.share': ['id', '...'], 'media.revoke': ['id', '...'], 'media.delete': ['id'], 'media.keepAvailable': ['id', 'on'],
  'media.pinRequest': ['id'],
  'report.send': ['...'],
  // v0.3 C2: calls and seeding
  'calls.start': ['...'], 'calls.accept': ['id', '...'], 'calls.decline': ['id'], 'calls.hangup': ['id'], 'calls.mute': ['id', 'on'],
  'calls.camera': ['id', 'on'], 'calls.screen': ['id', 'on'], 'calls.state': ['id'], 'calls.list': [],
  'net.seeding': [], 'net.dock': ['...'], 'net.keep': ['on'],
};
const CHAT_EVENTS = ['message', 'delivery', 'request', 'presence', 'room', 'group', 'state', 'keychange'];
const FILES_EVENTS = ['progress', 'shared', 'received', 'removed'];
const MEDIA_EVENTS = ['progress', 'received', 'shared', 'revoked', 'unavailable'];
const CALL_EVENTS = ['ring', 'state', 'peer', 'ended'];
const DEFAULTS = {
  requestTimeoutMs: 30000,
  writeTimeoutMaxMs: 600000,
  waitTimeoutMaxMs: 600000,
  helloIntervalMs: 500,
  helloTimeoutMs: 20000,
  bindingTimeoutMs: 20000,
  graceMs: 1000,
  bindingPollMs: 100,
};

function mwError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function rejectWith(code, message) {
  return Promise.reject(mwError(code, 'mw: ' + message));
}

/** True for an object with the SDK surface (the drop-in binding, or an SDK instance). */
export function looksLikeApi(v) {
  return Boolean(v) && typeof v === 'object' && typeof v.ready === 'function' && Boolean(v.db) && typeof v.db.get === 'function';
}

function isFacade(v) {
  return Boolean(v) && v[FACADE] === true;
}

function isPlainJson(value, depth) {
  const d = depth || 0;
  if (d > 64) return false;
  if (value === null) return true;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return true;
  if (t === 'number') return Number.isFinite(value);
  if (t !== 'object') return false;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) if (!isPlainJson(value[i], d + 1)) return false;
    return true;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const k of Object.keys(value)) if (!isPlainJson(value[k], d + 1)) return false;
  return true;
}

function badString(v) {
  return typeof v !== 'string' || v.length === 0;
}

function countOf(data) {
  if (typeof data === 'number' && Number.isFinite(data)) return data;
  if (data && typeof data === 'object') {
    if (typeof data.count === 'number') return data.count;
    if (typeof data.peers === 'number') return data.peers;
  }
  return null;
}

function closePort(p) {
  try {
    p.onmessage = null;
  } catch (_) { /* ignore */ }
  try {
    p.close();
  } catch (_) { /* ignore */ }
}

/** Splits an options argument into the params sent to the host and the local { onProgress, signal }. */
function splitOpts(o) {
  const params = {};
  const local = {};
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { params, local };
  for (const k of Object.keys(o)) {
    if (k === 'onProgress' && typeof o[k] === 'function') local.onProgress = o[k];
    else if (k === 'signal' && o[k] && typeof o[k].addEventListener === 'function') local.signal = o[k];
    else params[k] = o[k];
  }
  return { params, local };
}

function paramsFor(method, args) {
  const names = ARGS[method] || [];
  const params = {};
  let local = {};
  names.forEach((n, i) => {
    const a = args[i];
    if (a === undefined) return;
    if (n === '...') {
      const s = splitOpts(a);
      Object.assign(params, s.params);
      local = Object.assign(local, s.local);
    } else {
      params[n] = a;
    }
  });
  const extra = args[names.length];
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) local = Object.assign(local, splitOpts(extra).local);
  return { params, local };
}

/**
 * createSdk(options) -> an mw object (the default export is one of these, or the drop-in binding).
 * Options (all optional; tests inject them): win, doc, global, MessageChannel, setTimeout,
 * clearTimeout, now, requestTimeoutMs (30000), writeTimeoutMaxMs (600000), waitTimeoutMaxMs (600000),
 * helloIntervalMs (500), helloTimeoutMs (20000), bindingTimeoutMs (20000), graceMs (1000), bindingPollMs (100),
 * installGlobal (false).
 */
export function createSdk(options) {
  const o = options || {};
  const win = o.win !== undefined ? o.win : (typeof window !== 'undefined' ? window : null);
  const doc = o.doc !== undefined ? o.doc : ((win && win.document) || null);
  const G = o.global || (typeof globalThis !== 'undefined' ? globalThis : {});
  const MC = o.MessageChannel || (win && win.MessageChannel) || (typeof MessageChannel === 'function' ? MessageChannel : null);
  const setT = o.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clearT = o.clearTimeout || ((t) => clearTimeout(t));
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const cfg = {};
  for (const k of Object.keys(DEFAULTS)) cfg[k] = typeof o[k] === 'number' && o[k] > 0 ? o[k] : DEFAULTS[k];

  let binding = null; // the drop-in engine API, once known
  let port = null; // the Bridge port in use
  let connecting = null;
  let readyPromise = null;
  let readyAnswered = false; // the loader answered one ready() already: later calls ask again
  let nextId = 1;
  const pending = new Map(); // id -> { resolve, reject, timer, msg }
  let lastSnapshot = null;
  let peerCount = 0;
  let authState = 'guest';
  const subscribers = new Set(); // { fn, active, off }
  const listeners = new Map(); // net event -> Set of { fn, active, off }
  // v0.3 service listeners (shell): { fn, active, off }; in drop-in mode they move over to the binding.
  const svcListeners = { chat: new Map(), files: new Map(), media: new Map(), calls: new Map() };
  const authListeners = new Set();
  const ledgerSubs = new Map(); // ledgerId -> Set of { fn, active, off }
  const progress = { files: new Set(), media: new Set() };
  const bindingWaiters = [];
  let pollTimer = null;

  function safeCall(fn, data) {
    try {
      fn(data);
    } catch (err) {
      setT(() => {
        throw err; // surface the site's own error without breaking delivery to others
      }, 0);
    }
  }

  // ------------------------------------------------------------------- drop-in binding

  function moveOver(api, l, subscribe) {
    if (!l.active || l.off) return;
    try {
      const off = subscribe(api);
      l.off = typeof off === 'function' ? off : () => {};
    } catch (_) { /* the binding refused it */ }
  }

  function adoptBinding(api) {
    if (binding || !looksLikeApi(api) || api === mw || isFacade(api)) return;
    binding = api;
    stopPolling();
    subscribers.forEach((s) => moveOver(api, s, (b) => b.db.subscribe(s.fn)));
    listeners.forEach((set, event) => {
      set.forEach((l) => moveOver(api, l, (b) => b.net.on(event, l.fn)));
    });
    for (const ns of Object.keys(svcListeners)) {
      svcListeners[ns].forEach((set, event) => {
        set.forEach((l) => moveOver(api, l, (b) => (b[ns] && typeof b[ns].on === 'function' ? b[ns].on(event, l.fn) : null)));
      });
    }
    authListeners.forEach((l) => moveOver(api, l, (b) => (b.auth && typeof b.auth.onChange === 'function' ? b.auth.onChange(l.fn) : null)));
    ledgerSubs.forEach((set, ledger) => {
      set.forEach((l) => moveOver(api, l, (b) => b.db.subscribe(l.fn, { ledger })));
    });
    bindingWaiters.splice(0).forEach((w) => w(api));
  }

  function currentBinding() {
    if (binding) return binding;
    let g = null;
    try {
      g = G.mw;
    } catch (_) {
      g = null;
    }
    if (g && g !== mw && !isFacade(g) && looksLikeApi(g)) adoptBinding(g);
    return binding;
  }

  function startPolling() {
    if (pollTimer !== null) return;
    const tick = () => {
      pollTimer = null;
      if (currentBinding()) return;
      pollTimer = setT(tick, cfg.bindingPollMs);
    };
    pollTimer = setT(tick, cfg.bindingPollMs);
  }

  function stopPolling() {
    if (pollTimer !== null) clearT(pollTimer);
    pollTimer = null;
  }

  // /_mw/mw.js is on this page: the drop-in binding is coming.
  function dropinExpected() {
    if (!doc || typeof doc.getElementsByTagName !== 'function') return false;
    try {
      const list = doc.getElementsByTagName('script');
      for (let i = 0; i < list.length; i++) {
        const el = list[i];
        const src = (el && (el.src || (typeof el.getAttribute === 'function' && el.getAttribute('src')))) || '';
        if (/(^|\/)_mw\/mw\.js([?#]|$)/.test(String(src))) return true;
      }
    } catch (_) { /* no DOM */ }
    return false;
  }

  // The origin of a window's document. In limited mode (ARCHITECTURE 7.4) the site is an
  // about:srcdoc document: it inherits the shell's origin, but its location.origin is "null".
  function docOrigin(w) {
    const og = w && typeof w.origin === 'string' ? w.origin : null;
    if (og && og !== 'null') return og;
    return w && w.location ? w.location.origin : null;
  }

  function framedSameOrigin() {
    if (!win || !win.parent || win.parent === win) return false;
    try {
      const mine = docOrigin(win);
      // v0.3 C2 doors (research/v03/S4-doors.md D4): the door view is a frame with sandbox="allow-scripts" (an opaque origin, "null")
      // whose renderer (src/loader/doors.js frameMain) sets window.__mwDoor; its parent, the door page, takes the hello only from
      // that frame and only with origin "null" (src/loader/app.js attachBridge).
      if (mine === 'null' && win.__mwDoor === true) return true;
      return !!mine && mine !== 'null' && docOrigin(win.parent) === mine;
    } catch (_) {
      return false; // cross-origin parent: never a felinar shell
    }
  }

  // ------------------------------------------------------------------- Bridge port

  function dispatch(data) {
    if (data.id !== undefined && pending.has(data.id)) {
      const entry = pending.get(data.id);
      pending.delete(data.id);
      clearT(entry.timer);
      if (entry.cleanup) entry.cleanup();
      if (data.ok) entry.resolve(data.result);
      else {
        const e = data.error && typeof data.error === 'object' ? data.error : {};
        entry.reject(mwError(typeof e.code === 'string' && e.code ? e.code : 'E_POLICY',
          typeof e.message === 'string' && e.message ? e.message : 'mw: the request was refused'));
      }
      return;
    }
    if (typeof data.event === 'string') onPush(data.event, data.data);
  }

  function deliverSet(set, data) {
    if (!set) return;
    set.forEach((l) => {
      if (l.active && !l.off) safeCall(l.fn, data);
    });
  }

  function onPush(event, data) {
    if (SNAPSHOT_EVENTS.indexOf(event) >= 0) {
      lastSnapshot = data;
      if (data && typeof data.peers === 'number') peerCount = data.peers;
      subscribers.forEach((s) => {
        if (s.active && !s.off) safeCall(s.fn, data);
      });
      return;
    }
    if (event === 'auth') {
      const payload = data && data.data ? data.data : data;
      if (payload && (payload.state === 'signed-in' || payload.state === 'guest')) authState = payload.state;
      authListeners.forEach((l) => {
        if (l.active && !l.off) safeCall(l.fn, payload);
      });
      return;
    }
    if (event === 'chat' || event === 'files' || event === 'media' || event === 'calls') {
      const d = data && typeof data === 'object' ? data : {};
      if ((event === 'files' || event === 'media') && d.type === 'progress') progress[event].forEach((fn) => safeCall(fn, d.data));
      deliverSet(svcListeners[event].get(d.type), d.data);
      return;
    }
    if (event === 'hub') {
      const d = data && typeof data === 'object' ? data : {};
      if (d.type === 'change' && d.data && ledgerSubs.has(d.data.ledger)) {
        const ledger = d.data.ledger;
        request('db.snapshot', { ledger }).then((snap) => {
          if (snap) deliverSet(ledgerSubs.get(ledger), snap);
        }, () => {});
      }
      return;
    }
    if (event === 'peers') {
      const n = countOf(data);
      if (n !== null) peerCount = n;
    }
    if (event === 'pow' && data && typeof data === 'object' && pending.has(data.id)) {
      // The host is still computing this write's fee: keep waiting (up to writeTimeoutMaxMs).
      const entry = pending.get(data.id);
      if (entry.write) {
        if (now() - entry.started < cfg.writeTimeoutMaxMs) entry.arm();
        if (entry.onProgress) safeCall(entry.onProgress, { hashes: Number(data.hashes) || 0, bits: Number(data.bits) || 0 });
      }
    }
    if (event === 'wait' && data && typeof data === 'object') {
      // The host is waiting for the person (a card, the identity page): keep waiting (up to waitTimeoutMaxMs).
      const entry = pending.get(data.id);
      if (entry && now() - entry.started < cfg.waitTimeoutMaxMs) entry.arm();
      return;
    }
    deliverSet(listeners.get(event), data);
  }

  function usePort(p, resend) {
    port = p;
    if (!resend) return;
    pending.forEach((entry) => {
      try {
        p.postMessage(entry.msg);
      } catch (_) { /* it times out */ }
    });
  }

  // Posts a hello (with a fresh MessageChannel) every helloIntervalMs until the Bridge answers on
  // one of the ports. Bridges replace their port on every hello, so the port in use is the most
  // recent one that answered: after a first answer no more hellos go out, and if older hellos are
  // still unanswered-for we wait up to graceMs for the newest one before settling.
  function startHandshake(onConnected) {
    const tries = [];
    let best = -1;
    let connected = false;
    let cancelled = false;
    let retry = null;
    let grace = null;
    const origin = docOrigin(win);

    function finish() {
      if (connected || cancelled || best < 0) return;
      connected = true;
      clearT(retry);
      clearT(grace);
      usePort(tries[best].port, false);
      onConnected();
      // Ports the Bridge never adopted: stop listening once no late answer can come.
      setT(() => {
        tries.forEach((t) => {
          if (t.port !== port) closePort(t.port);
        });
      }, cfg.helloTimeoutMs);
    }

    function onPortMessage(k, data) {
      if (cancelled || !data || typeof data !== 'object') return;
      if (k > best) {
        best = k;
        if (connected) usePort(tries[k].port, true); // the Bridge moved to a newer port
        else if (best === tries.length - 1) finish();
        else if (grace === null) grace = setT(finish, cfg.graceMs);
      }
      if (typeof data.id === 'string' && data.id.indexOf(PROBE_PREFIX) === 0) return;
      if (data.mw !== undefined && data.id === undefined && data.event === undefined) return; // { mw: 'ready' }
      dispatch(data);
    }

    function attempt() {
      if (connected || cancelled || best >= 0 || !MC) return;
      let ch;
      try {
        ch = new MC();
      } catch (_) {
        return;
      }
      const k = tries.length;
      tries.push({ port: ch.port1 });
      ch.port1.onmessage = (ev) => onPortMessage(k, ev && ev.data);
      try {
        // C2 doors: an opaque origin cannot be named as a target; the door view's hello goes to its parent with '*'.
        win.parent.postMessage({ mw: 'hello', proto: 1, sdk: SDK_VERSION }, origin === 'null' ? '*' : origin, [ch.port2]);
        ch.port1.postMessage({ id: PROBE_PREFIX + k, method: 'ping', params: {} });
      } catch (_) { /* detached frame: the deadline reports E_NO_HOST */ }
      retry = setT(attempt, cfg.helloIntervalMs);
    }

    attempt();
    return {
      cancel() {
        cancelled = true;
        clearT(retry);
        clearT(grace);
        tries.forEach((t) => {
          if (t.port !== port) closePort(t.port);
        });
      },
    };
  }

  function connect() {
    if (binding || port || currentBinding()) return Promise.resolve();
    if (!connecting) {
      const attemptPromise = new Promise((resolve, reject) => {
        const framed = framedSameOrigin();
        const dropin = dropinExpected();
        if (!framed && !dropin) {
          reject(mwError('E_NO_HOST', 'mw: this page is not running inside felinar'));
          return;
        }
        let settled = false;
        let deadline = null;
        let handshake = null;
        const done = (err) => {
          if (settled) return;
          settled = true;
          clearT(deadline);
          if (err) {
            stopPolling();
            if (handshake) handshake.cancel();
            reject(err);
            return;
          }
          if (binding && handshake) handshake.cancel();
          resolve();
        };
        if (dropin) {
          bindingWaiters.push(() => done(null));
          startPolling();
        }
        if (framed) handshake = startHandshake(() => done(null));
        const wait = Math.max(framed ? cfg.helloTimeoutMs : 0, dropin ? cfg.bindingTimeoutMs : 0);
        deadline = setT(() => done(mwError('E_NO_HOST', 'mw: the felinar loader did not answer')), wait);
      });
      connecting = attemptPromise;
      attemptPromise.then(() => {}, () => {
        if (connecting === attemptPromise) connecting = null; // a later call tries again
      });
    }
    return connecting;
  }

  // Tells the host to stop a write this module gave up on (no answer is expected).
  function sendCancel(id) {
    if (!port) return;
    try {
      port.postMessage({ id: nextId++, method: 'write.cancel', params: { id } });
    } catch (_) { /* the port is gone, and so is the write */ }
  }

  function request(method, params, opts) {
    const o2 = opts && typeof opts === 'object' ? opts : {};
    const write = WRITE_METHODS.indexOf(method) >= 0;
    const signal = o2.signal && typeof o2.signal.addEventListener === 'function' ? o2.signal : null;
    const onProgress = write && typeof o2.onProgress === 'function' ? o2.onProgress : null;
    if (signal && signal.aborted) return rejectWith('E_POW_ABORTED', method + ' was cancelled');
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const msg = { id, method, params: params || {} };
      const entry = { resolve, reject, timer: null, msg, write, onProgress, started: now(), cleanup: null, arm: null };
      const fail = (code, message, cancel) => {
        if (pending.get(id) !== entry) return;
        pending.delete(id);
        clearT(entry.timer);
        if (entry.cleanup) entry.cleanup();
        if (cancel) sendCancel(id);
        reject(mwError(code, message));
      };
      entry.arm = () => {
        clearT(entry.timer);
        entry.timer = setT(() => fail('E_TIMEOUT', 'mw: ' + method + ' got no answer within ' + Math.round(cfg.requestTimeoutMs / 1000) + ' s', write), cfg.requestTimeoutMs);
      };
      entry.arm();
      pending.set(id, entry);
      if (signal) {
        const onAbort = () => fail('E_POW_ABORTED', 'mw: ' + method + ' was cancelled', true);
        signal.addEventListener('abort', onAbort);
        entry.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      try {
        port.postMessage(msg);
      } catch (err) {
        clearT(entry.timer);
        pending.delete(id);
        if (entry.cleanup) entry.cleanup();
        reject(mwError(err && err.name === 'DataCloneError' ? 'E_LIMIT' : 'E_NO_HOST',
          'mw: could not send ' + method + ': ' + (err && err.message ? err.message : String(err))));
      }
    });
  }

  // Runs `direct(binding)` in drop-in mode, else sends `method` to the Bridge.
  function call(method, params, direct, opts) {
    return connect().then(() => {
      const api = currentBinding();
      if (api) return direct(api);
      return request(method, params, opts);
    });
  }

  function bindingFn(api, method) {
    let at = api;
    for (const part of method.split('.')) {
      at = at ? at[part] : undefined;
    }
    return typeof at === 'function' ? at : null;
  }

  /** The generic path of every v0.3 method: positional arguments as named params (ARGS). */
  function v03(method, transform) {
    return function () {
      const args = Array.prototype.slice.call(arguments);
      const { params, local } = paramsFor(method, args);
      const ns = method.split('.')[0];
      return call(method, params, (b) => {
        const fn = bindingFn(b, method);
        if (!fn) return rejectWith('E_UNSUPPORTED', method + ' is not available on this page');
        return fn.apply(null, args);
      }, local).then((res) => (transform && !binding ? transform(res) : res), (err) => { throw err; })
        .finally(() => {
          if ((ns === 'files' || ns === 'media') && local.onProgress) progress[ns].delete(local.onProgress);
        });
    };
  }

  // media.upload / files.fetch: their onProgress gets the service's progress pushes while they run.
  function withProgress(method) {
    const inner = v03(method, method === 'files.fetch' ? fetchResult : null);
    return function () {
      const args = Array.prototype.slice.call(arguments);
      const { local } = paramsFor(method, args);
      const ns = method.split('.')[0];
      if (local.onProgress && !currentBinding()) progress[ns].add(local.onProgress);
      return inner.apply(null, args);
    };
  }

  // files.fetch over the port arrives as { handle, name, size, mime, blob }: give the site the R 2.11.2 shape.
  function fetchResult(res) {
    if (!res || typeof res !== 'object') return res;
    const b = res.blob;
    return {
      handle: res.handle, name: res.name, size: res.size, mime: res.mime || 'application/octet-stream',
      blob: () => Promise.resolve(b),
      stream: () => (b && typeof b.stream === 'function' ? b.stream() : null),
    };
  }

  function addListener(map, event, fn, label, allowed, bindingOn) {
    if (badString(event) || (allowed && allowed.indexOf(event) < 0)) throw mwError('E_LIMIT', 'mw: ' + label + '.on expects one of ' + (allowed || []).join(', '));
    if (typeof fn !== 'function') throw mwError('E_LIMIT', 'mw: ' + label + '.on expects a function');
    const api = currentBinding();
    if (api) {
      const off = bindingOn(api);
      return typeof off === 'function' ? off : () => {};
    }
    let set = map.get(event);
    if (!set) {
      set = new Set();
      map.set(event, set);
    }
    const l = { fn, active: true, off: null };
    set.add(l);
    connect().catch(() => {});
    return () => {
      l.active = false;
      set.delete(l);
      if (typeof l.off === 'function') {
        try {
          l.off();
        } catch (_) { /* ignore */ }
      }
    };
  }

  // ------------------------------------------------------------------- the API (R 2.11.2)

  const mw = {
    version: SDK_VERSION,

    ready() {
      const api = currentBinding();
      if (api) return Promise.resolve().then(() => api.ready());
      // The first call waits for the loader (at most 15 s) and every call made meanwhile shares it. Once the loader has
      // answered, each call asks it again, so auth, identity, role and features follow the sign-in as docs/SDK.md says
      // (v0.3 final integration: the first answer was kept for ever, so a page that signed in still read 'guest').
      if (!readyPromise || readyAnswered) {
        const p = call('ready', {}, (b) => b.ready()).then((info) => {
          if (info && typeof info.peers === 'number') peerCount = info.peers;
          if (info && (info.auth === 'signed-in' || info.auth === 'guest')) authState = info.auth;
          readyAnswered = true;
          return info;
        });
        readyPromise = p;
        p.then(() => {}, () => {
          if (readyPromise === p) readyPromise = null;
        });
      }
      return readyPromise;
    },

    auth: {
      // Opens the identity page (call it from a click); resolves { state: 'signed-in', identity, role }.
      signIn: v03('auth.signIn'),
      signOut: v03('auth.signOut'),
      // 'guest' | 'signed-in': the last state the loader reported (synchronous).
      state() {
        const api = currentBinding();
        if (api && api.auth && typeof api.auth.state === 'function') return api.auth.state();
        return authState;
      },
      // fn({ state, identity, role }) on every change; returns unsubscribe().
      onChange(fn) {
        if (typeof fn !== 'function') throw mwError('E_LIMIT', 'mw: auth.onChange expects a function');
        const api = currentBinding();
        if (api && api.auth && typeof api.auth.onChange === 'function') {
          const off = api.auth.onChange(fn);
          return typeof off === 'function' ? off : () => {};
        }
        const l = { fn, active: true, off: null };
        authListeners.add(l);
        connect().catch(() => {});
        return () => {
          l.active = false;
          authListeners.delete(l);
          if (typeof l.off === 'function') {
            try {
              l.off();
            } catch (_) { /* ignore */ }
          }
        };
      },
      prove: v03('auth.prove'),
      verify: v03('auth.verify'),
      signInServer: v03('auth.signInServer'),
    },

    identity: {
      current: v03('identity.current'),
      setName(name, opts) {
        if (badString(name)) return rejectWith('E_LIMIT', 'the name must be a non-empty string');
        return call('identity.setName', { name }, (b) => b.identity.setName(name, opts), opts);
      },
      backupStatus: v03('identity.backupStatus'),
      openIdentity: v03('identity.openIdentity'),
    },

    me: {
      get: v03('me.get'),
      set: v03('me.set'),
      del: v03('me.del'),
      sync: v03('me.sync'),
      erase: v03('me.erase'),
    },

    db: {
      // get(key, { ledger }?): ledger reads a followed ledger (the hub amendment, read only).
      get(key, opts) {
        if (badString(key)) return rejectWith('E_LIMIT', 'the key must be a non-empty string');
        const ledger = opts && typeof opts === 'object' && typeof opts.ledger === 'string' ? opts.ledger : null;
        return call('db.get', ledger ? { key, ledger } : { key }, (b) => (ledger ? b.db.get(key, { ledger }) : b.db.get(key)));
      },
      // Writes: (..., { onProgress, signal }) is optional (see the header).
      set(key, value, opts) {
        if (badString(key)) return rejectWith('E_LIMIT', 'the key must be a non-empty string');
        if (value === undefined || !isPlainJson(value)) return rejectWith('E_LIMIT', 'the value must be plain JSON');
        return call('db.set', { key, value }, (b) => b.db.set(key, value, opts), opts);
      },
      del(key, opts) {
        if (badString(key)) return rejectWith('E_LIMIT', 'the key must be a non-empty string');
        return call('db.del', { key }, (b) => b.db.del(key, opts), opts);
      },
      list(name, opts) {
        if (badString(name)) return rejectWith('E_LIMIT', 'the list name must be a non-empty string');
        const o2 = opts && typeof opts === 'object' ? opts : {};
        const limit = o2.limit === undefined ? 100 : o2.limit;
        if (!Number.isInteger(limit) || limit < 1) return rejectWith('E_LIMIT', 'limit must be a positive integer');
        const newestFirst = o2.newestFirst === undefined ? true : Boolean(o2.newestFirst);
        const ledger = typeof o2.ledger === 'string' ? o2.ledger : null;
        const params = ledger ? { name, limit, newestFirst, ledger } : { name, limit, newestFirst };
        return call('db.list', params, (b) => b.db.list(name, ledger ? { limit, newestFirst, ledger } : { limit, newestFirst }));
      },
      append(name, value, opts) {
        if (badString(name)) return rejectWith('E_LIMIT', 'the list name must be a non-empty string');
        if (value === undefined || !isPlainJson(value)) return rejectWith('E_LIMIT', 'the value must be plain JSON');
        return call('db.append', { name, value }, (b) => b.db.append(name, value, opts), opts);
      },
      tombstone(h, opts) {
        if (typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h)) return rejectWith('E_LIMIT', 'h must be an entry hash (64 lowercase hex characters)');
        return call('db.tombstone', { h }, (b) => b.db.tombstone(h, opts), opts);
      },
      // The author-scoped keys of the freeze group: '@<16 chars>/' + name, written only by their author.
      setMine: v03('db.setMine'),
      getMine: v03('db.getMine'),
      listBy: v03('db.listBy'),
      // fn(snapshot: { height, peers, inSync, kv, lists, profiles, policy }) on every change; a new
      // subscriber first gets the latest snapshot already received. Returns unsubscribe().
      // With { ledger }: the snapshots of a followed ledger.
      subscribe(fn, opts) {
        if (typeof fn !== 'function') throw mwError('E_LIMIT', 'mw: db.subscribe expects a function');
        const ledger = opts && typeof opts === 'object' && typeof opts.ledger === 'string' ? opts.ledger : null;
        const api = currentBinding();
        if (api) {
          const off = ledger ? api.db.subscribe(fn, { ledger }) : api.db.subscribe(fn);
          return typeof off === 'function' ? off : () => {};
        }
        const s = { fn, active: true, off: null };
        if (ledger) {
          if (!ledgerSubs.has(ledger)) ledgerSubs.set(ledger, new Set());
          ledgerSubs.get(ledger).add(s);
          connect().then(() => (currentBinding() ? null : request('db.snapshot', { ledger }))).then((snap) => {
            if (snap && s.active && !s.off) safeCall(fn, snap);
          }, () => {});
          return () => {
            s.active = false;
            const set = ledgerSubs.get(ledger);
            if (set) set.delete(s);
            if (typeof s.off === 'function') {
              try {
                s.off();
              } catch (_) { /* ignore */ }
            }
          };
        }
        subscribers.add(s);
        connect().catch(() => {});
        if (lastSnapshot !== null) {
          Promise.resolve().then(() => {
            if (s.active && !s.off && lastSnapshot !== null) safeCall(fn, lastSnapshot);
          });
        }
        return () => {
          s.active = false;
          subscribers.delete(s);
          if (typeof s.off === 'function') {
            try {
              s.off();
            } catch (_) { /* ignore */ }
          }
        };
      },
    },

    // Followed ledgers (the hub amendment to R 2.11.2): follow(pointer or ledger id) / unfollow / list; and in hub
    // mode createPage() (R 3.3, an identity page card) returns the new personal site's { ledgerId, label, url }.
    hub: {
      follow: v03('hub.follow'),
      unfollow: v03('hub.unfollow'),
      list: v03('hub.list'),
      createPage: v03('hub.createPage'),
    },

    mod: {
      // UI methods (MF-27): call them from a click; the loader shows the moderator card.
      ban(pub, opts) {
        if (badString(pub)) return rejectWith('E_LIMIT', 'pub must be a public key string');
        const { params, local } = paramsFor('mod.ban', [pub, opts]);
        return call('mod.ban', params, (b) => b.mod.ban(pub, opts), local);
      },
      unban: v03('mod.unban'),
      tombstoneMany: v03('mod.tombstoneMany'),
      queue: v03('mod.queue'),
      decide: v03('mod.decide'),
    },

    chat: {
      enable: v03('chat.enable'),
      disable: v03('chat.disable'),
      state: v03('chat.state'),
      presence: { set: v03('chat.presence.set'), list: v03('chat.presence.list') },
      contacts: {
        list: v03('chat.contacts.list'), add: v03('chat.contacts.add'), remove: v03('chat.contacts.remove'),
        block: v03('chat.contacts.block'), unblock: v03('chat.contacts.unblock'), verify: v03('chat.contacts.verify'),
      },
      requests: { list: v03('chat.requests.list'), accept: v03('chat.requests.accept'), decline: v03('chat.requests.decline'), setOpen: v03('chat.requests.setOpen') },
      dm: { send: v03('chat.dm.send'), history: v03('chat.dm.history'), keepHistory: v03('chat.dm.keepHistory') },
      room: {
        join(name) { return v03('chat.room.join')(name === undefined ? 'Lobby' : name); },
        leave: v03('chat.room.leave'),
        send: v03('chat.room.send'),
      },
      group: {
        create: v03('chat.group.create'), invite: v03('chat.group.invite'), remove: v03('chat.group.remove'),
        leave: v03('chat.group.leave'), send: v03('chat.group.send'),
      },
      holder: { set: v03('chat.holder.set') },
      direct: { connect: v03('chat.direct.connect') },
      // on('message'|'delivery'|'request'|'presence'|'room'|'group'|'state'|'keychange', fn) -> unsubscribe()
      on(event, fn) {
        return addListener(svcListeners.chat, event, fn, 'chat', CHAT_EVENTS, (b) => b.chat.on(event, fn));
      },
    },

    files: {
      enable: v03('files.enable'),
      list: v03('files.list'),
      received: v03('files.received'),
      share: v03('files.share'),
      // -> { handle, name, size, mime, stream(), blob() }. The Blob is application/octet-stream: never pass it
      // to URL.createObjectURL in a frame or a navigation (render only through mw.files.preview).
      fetch: withProgress('files.fetch'),
      preview: v03('files.preview'),
      save: v03('files.save'),
      keepSharing: v03('files.keepSharing'),
      stopSharing: v03('files.stopSharing'),
      remove: v03('files.remove'),
      pinRequest: v03('files.pinRequest'),
      on(event, fn) {
        return addListener(svcListeners.files, event, fn, 'files', FILES_EVENTS, (b) => b.files.on(event, fn));
      },
    },

    media: {
      upload: withProgress('media.upload'),
      list: v03('media.list'),
      // -> { url, mime, duration?, w, h }: url is /_mw/media/<sid>, valid for this session (never a key).
      open: v03('media.open'),
      close: v03('media.close'),
      share: v03('media.share'),
      revoke: v03('media.revoke'),
      delete: v03('media.delete'),
      keepAvailable: v03('media.keepAvailable'),
      pinRequest: v03('media.pinRequest'),
      on(event, fn) {
        return addListener(svcListeners.media, event, fn, 'media', MEDIA_EVENTS, (b) => b.media.on(event, fn));
      },
    },

    report: {
      // { target: { h } | { envelope } | { media } | { key }, reason, note? } -> { sent }; metadata only.
      send: v03('report.send'),
    },

    // v0.3 C2 (SZ 3.5): calls between signed-in contacts, 1:1 or a mesh of at most 6 (4 with video). Accepting a call
    // shows your IP address to everyone in it. The loader's own call panel shows the cards and plays the media.
    calls: {
      // start({ to: pub | [pubs] | groupId, video }) -> the call state; call it from a click (the loader's card follows)
      start: v03('calls.start'),
      // accept(id, { video }) from a click; decline(id); hangup(id)
      accept: v03('calls.accept'),
      decline: v03('calls.decline'),
      hangup: v03('calls.hangup'),
      // mute(id, on), camera(id, on), screen(id, on): screen needs a click
      mute: v03('calls.mute'),
      camera: v03('calls.camera'),
      screen: v03('calls.screen'),
      // state(id) -> the call state or null; list() -> the calls in progress
      state: v03('calls.state'),
      list: v03('calls.list'),
      // on('ring' | 'state' | 'peer' | 'ended', fn) -> unsubscribe()
      on(event, fn) {
        return addListener(svcListeners.calls, event, fn, 'calls', CALL_EVENTS, (b) => b.calls.on(event, fn));
      },
    },

    net: {
      // Last known number of peer connections (pushed by the host; 0 before the first push).
      peers() {
        const api = currentBinding();
        if (api && api.net && typeof api.net.peers === 'function') {
          try {
            return api.net.peers();
          } catch (_) { /* fall back to the cached count */ }
        }
        return peerCount;
      },
      // on('peers' | 'progress' | 'status' | 'sync' | 'pow', fn) -> unsubscribe()
      on(event, fn) {
        return addListener(listeners, event, fn, 'net', null, (b) => b.net.on(event, fn));
      },
      // v0.3 C2 (SZ 3.1.3, 3.1.4): what this device shares, counted on this device only:
      // -> { lanes: { H, K, E: { rate, used } }, month: { used, cap }, dock: { on, until }, keeper }
      seeding: v03('net.seeding'),
      // dock({ hours }) on a phone: keep the screen on and share (from a click; the loader's card follows)
      dock: v03('net.dock'),
      // keep(on) on a computer: keep this site while this tab is open (keep(true) from a click)
      keep: v03('net.keep'),
    },

    site: {
      // -> { name, files: [{ path, length }], btih, source: 'peers'|'webseed'|'cache'|'mixed', mode }
      info() {
        return call('site.info', {}, (b) => b.site.info());
      },
    },

    consent: {
      // Opens the loader-owned consent card (call it from a click); resolves with the visitor's
      // choice: 'accepted' | 'host-only', or 'pending' when the card was closed without one. An
      // already decided state resolves at once and opens nothing. A site never grants consent.
      request() {
        return call('consent.request', {}, (b) => b.consent.request());
      },
      // -> 'pending' | 'accepted' | 'host-only'
      state() {
        const api = currentBinding();
        if (api) return api.consent.state();
        return call('consent.state', {}, (b) => b.consent.state());
      },
    },

    owner: {
      // Personal sites (R 3.3): the owner changes the policy after the identity page's card (call it from a click).
      // Elsewhere the owner key never runs in a browser (tools/ledger-admin.mjs) and this rejects E_NOT_OWNER.
      policy(fields) {
        // Standalone (no felinar here): E_NOT_OWNER as in v0.2.1, since no owner key can run on this page.
        if (!binding && !port && !currentBinding() && !framedSameOrigin() && !dropinExpected()) {
          return rejectWith('E_NOT_OWNER', 'mw: the owner key never runs on this page (felinar is not running here)');
        }
        const params = fields && typeof fields === 'object' ? splitOpts(fields).params : {};
        return call('owner.policy', params, (b) => (typeof b.owner.policy === 'function' ? b.owner.policy(fields) : rejectWith('E_NOT_OWNER', 'not the owner')));
      },
    },
  };
  Object.defineProperty(mw, FACADE, { value: true });

  if (o.installGlobal) {
    // window.mw is this object until /_mw/mw.js assigns its direct binding, which is captured
    // here so modules that imported this object early keep working (they now reach the binding).
    try {
      Object.defineProperty(G, 'mw', {
        configurable: true,
        enumerable: true,
        get() {
          return binding || mw;
        },
        set(v) {
          if (v && v !== mw && !isFacade(v) && looksLikeApi(v)) adoptBinding(v);
        },
      });
    } catch (_) {
      try {
        G.mw = mw;
      } catch (_e) { /* frozen global */ }
    }
  }

  return mw;
}

function defaultInstance() {
  const G = typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : {});
  let prior = null;
  try {
    prior = G.mw;
  } catch (_) {
    prior = null;
  }
  // Drop-in already bound window.mw (or another copy of this module set it up): re-export it.
  if (looksLikeApi(prior)) return prior;
  return createSdk({ global: G, installGlobal: true });
}

const mw = defaultInstance();
export default mw;
