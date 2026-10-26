// src/dropin/binding.js: window.mw in drop-in mode (ARCHITECTURE 3.4.9, 9 and 15.9; R 2.11). The SDK surface bound
// directly to the engine, with no Bridge and no MessagePort: every method turns into one MwApi.request()
// (src/loader/api.js), the table the shell Bridge also uses, so a site that moves between drop-in and shell sees
// the same validation, gating, limits, results and error codes. /_mw/sdk.js re-exports this object when it is
// already on window.mw, and adopts it when it appears later.
//
//   const { mw, push, pushState, destroy } = createBinding({ api })
//   mw                  the SDK object (frozen, every namespace frozen)
//   push(event, data)   engine -> site: 'peers' | 'progress' | 'status' | 'sync' | 'pow' (net events)
//   pushState()         engine -> site: a ledger change (snapshot to db.subscribe listeners, throttled)
// Service events (auth, chat, files, media, keychange, hub) come from the MwApi itself (addPushListener).
//
// Writes take an optional last argument { onProgress, signal } (code review round 1, DESIGN-REVIEW
// item 4): onProgress({ hashes, bits }) while this browser computes the post's spam fee (also pushed
// as the 'pow' event), and an aborted signal cancels the write (E_POW_ABORTED; nothing is published).
// media.upload and files.fetch report { phase, done, total } progress to their onProgress.
//
// Errors are Error objects with a .code (R 2.11.2). Everything written with mw.db is public and copied to every
// visitor. A site never exports a key, grants consent or accepts a link (R 2.11.1): those methods do not exist.
// UI methods need a click: the engine's ActivationTracker watches the page for trusted input.
// v0.3 C2 (lane wire-ui; SZ 3.5, 3.1): mw.calls is here so a site has one surface in every mode, but in drop-in mode
// every mw.calls method rejects with E_UNSUPPORTED (the MwApi answers it, because the host's next page load would end a
// call) and calls.on() never fires. mw.net.seeding(), dock() and keep() go to the engine's seeding control, when it
// has one (MwApi.setNet), and answer E_UNSUPPORTED otherwise.

import { METHOD_ARGS, SDK_VERSION } from '../loader/api.js';

export const NET_EVENTS = Object.freeze(['peers', 'progress', 'status', 'sync', 'pow']);
export const CHAT_EVENTS = Object.freeze(['message', 'delivery', 'request', 'presence', 'room', 'group', 'state', 'keychange']);
export const FILES_EVENTS = Object.freeze(['progress', 'shared', 'received', 'removed']);
export const MEDIA_EVENTS = Object.freeze(['progress', 'received', 'shared', 'revoked', 'unavailable']);
export const CALL_EVENTS = Object.freeze(['ring', 'state', 'peer', 'ended']);
const HASH_RE = /^[0-9a-f]{64}$/;

function mwError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function reject(code, message) {
  return Promise.reject(mwError(code, 'mw: ' + message));
}

function badString(v) {
  return typeof v !== 'string' || v.length === 0;
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

/** Splits an options argument into the JSON params and the local { onProgress, signal } (never sent). */
function splitOpts(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { params: {}, local: {} };
  const params = {};
  const local = {};
  for (const k of Object.keys(o)) {
    if (k === 'onProgress' && typeof o[k] === 'function') local.onProgress = o[k];
    else if (k === 'signal' && o[k] && typeof o[k].addEventListener === 'function') local.signal = o[k];
    else params[k] = o[k];
  }
  return { params, local };
}

/** paramsFor(method, args) -> { params, local }: positional SDK arguments as the params object (METHOD_ARGS). */
export function paramsFor(method, args) {
  const names = METHOD_ARGS[method] || [];
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
  // A trailing options object after the named arguments (writes: { onProgress, signal }).
  const extra = args[names.length];
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) local = Object.assign(local, splitOpts(extra).local);
  return { params, local };
}

/**
 * createBinding({ api, statePushMs, setTimeoutFn, clearTimeoutFn, now }) -> { mw, push, pushState, destroy }
 * api: a MwApi. The engine calls api.setNode() when the ledger opens and then pushState().
 */
export function createBinding({ api, statePushMs = 250, setTimeoutFn = null, clearTimeoutFn = null, now = null } = {}) {
  if (!api || typeof api.request !== 'function') throw new TypeError('createBinding needs a MwApi');
  const setT = setTimeoutFn || ((fn, ms) => setTimeout(fn, ms));
  const clearT = clearTimeoutFn || ((t) => clearTimeout(t));
  const clock = now || (() => Date.now());

  const listeners = {};
  for (const e of NET_EVENTS) listeners[e] = new Set();
  const service = { chat: new Map(), files: new Map(), media: new Map(), calls: new Map() };
  const authListeners = new Set();
  const ledgerSubs = new Map(); // ledgerId -> Set(fn)
  const progress = { files: new Set(), media: new Set() };
  const subscribers = new Set();
  let lastSnapshot = null;
  let lastPush = 0;
  let timer = null;
  let destroyed = false;

  // A listener's own bug must surface in the console as the site's error, not stop delivery.
  function safeCall(fn, data) {
    try {
      fn(data);
    } catch (err) {
      setT(() => { throw err; }, 0);
    }
  }

  // { onProgress, signal } of a write, with every progress report also pushed as 'pow'.
  function writeOpts(local) {
    const own = local && typeof local.onProgress === 'function' ? local.onProgress : null;
    const signal = local && local.signal ? local.signal : null;
    return {
      signal,
      onProgress: (p) => {
        const data = { hashes: Number(p && p.hashes) || 0, bits: Number(p && p.bits) || 0 };
        push('pow', data);
        if (own) safeCall(own, data);
      },
    };
  }

  function unwrap(res) {
    if (res && res.ok) return res.result;
    const e = (res && res.error) || {};
    throw mwError(typeof e.code === 'string' && e.code ? e.code : 'E_POLICY', typeof e.message === 'string' && e.message ? e.message : 'mw: the request was refused');
  }

  function call(method, params, opts) {
    return api.request(method, params, opts).then(unwrap);
  }

  /** callArgs(method, args): the generic path of every v0.3 method. */
  function callArgs(method, args) {
    const { params, local } = paramsFor(method, args);
    const ns = method.split('.')[0];
    const prog = (ns === 'media' || ns === 'files') && typeof local.onProgress === 'function' ? local.onProgress : null;
    if (prog) progress[ns].add(prog);
    const opts = Object.assign(writeOpts(local), { signal: local.signal || null });
    return call(method, params, opts).finally(() => {
      if (prog) progress[ns].delete(prog);
    });
  }

  // false when there is no ledger node yet (nothing to deliver).
  function deliverState() {
    const snap = api.snapshot();
    if (!snap) return false;
    lastSnapshot = snap;
    for (const fn of Array.from(subscribers)) safeCall(fn, snap);
    for (const fn of Array.from(listeners.sync)) safeCall(fn, { height: snap.height || 0, peers: snap.peers || 0, inSync: snap.inSync || 0 });
    return true;
  }

  function pushState() {
    if (destroyed || timer !== null) return;
    const t = clock();
    const due = lastPush + statePushMs;
    if (t >= due) {
      // A push before the node exists delivers nothing and must not use up the leading edge: the first
      // real snapshot would otherwise wait out a whole interval.
      if (deliverState()) lastPush = t;
      return;
    }
    timer = setT(() => {
      timer = null;
      pushState();
    }, Math.max(0, due - t));
  }

  function push(event, data) {
    if (destroyed || !listeners[event]) return;
    for (const fn of Array.from(listeners[event])) safeCall(fn, data);
  }

  // Service pushes from the MwApi: { type, data } for chat, files, media and hub; auth carries the change.
  function onApiPush(event, data) {
    if (destroyed) return;
    const d = data && typeof data === 'object' ? data : {};
    if (event === 'auth') {
      const payload = d.data || d;
      for (const fn of Array.from(authListeners)) safeCall(fn, payload);
      return;
    }
    if (event === 'chat' || event === 'files' || event === 'media' || event === 'calls') {
      const set = service[event].get(d.type);
      if ((event === 'files' || event === 'media') && d.type === 'progress') for (const fn of Array.from(progress[event])) safeCall(fn, d.data);
      if (set) for (const fn of Array.from(set)) safeCall(fn, d.data);
      return;
    }
    if (event === 'hub' && d.type === 'change' && d.data && ledgerSubs.has(d.data.ledger)) {
      const ledger = d.data.ledger;
      call('db.snapshot', { ledger }).then((snap) => {
        const subs = ledgerSubs.get(ledger);
        if (subs && snap) for (const fn of Array.from(subs)) safeCall(fn, snap);
      }, () => {});
    }
  }
  const offApi = typeof api.addPushListener === 'function' ? api.addPushListener(onApiPush) : () => {};

  function onFor(map, allowed, label) {
    return function on(event, fn) {
      if (badString(event) || allowed.indexOf(event) < 0) throw mwError('E_LIMIT', 'mw: ' + label + '.on expects one of ' + allowed.join(', '));
      if (typeof fn !== 'function') throw mwError('E_LIMIT', 'mw: ' + label + '.on expects a function');
      if (!map.has(event)) map.set(event, new Set());
      map.get(event).add(fn);
      return () => { map.get(event).delete(fn); };
    };
  }

  const m = (method) => (...args) => callArgs(method, args);

  const mw = {
    version: SDK_VERSION,

    ready() {
      return call('ready', {}).then((info) => {
        pushState();
        return info;
      });
    },

    auth: {
      signIn: m('auth.signIn'),
      signOut: m('auth.signOut'),
      // 'guest' | 'signed-in', synchronous (R 2.11.2).
      state() {
        try {
          return api.identity && typeof api.identity.state === 'function' ? api.identity.state() : 'guest';
        } catch (_) {
          return 'guest';
        }
      },
      // fn({ state, identity, role }) on every change; returns unsubscribe().
      onChange(fn) {
        if (typeof fn !== 'function') throw mwError('E_LIMIT', 'mw: auth.onChange expects a function');
        authListeners.add(fn);
        return () => { authListeners.delete(fn); };
      },
      prove: m('auth.prove'),
      verify: m('auth.verify'),
      signInServer: m('auth.signInServer'),
    },

    identity: {
      current: m('identity.current'),
      setName(name, opts) {
        if (badString(name)) return reject('E_LIMIT', 'the name must be a non-empty string');
        return call('identity.setName', { name }, writeOpts(splitOpts(opts).local));
      },
      backupStatus: m('identity.backupStatus'),
      openIdentity: m('identity.openIdentity'),
    },

    me: {
      get: m('me.get'),
      set: m('me.set'),
      del: m('me.del'),
      sync: m('me.sync'),
      erase: m('me.erase'),
    },

    db: {
      get(key, opts) {
        if (badString(key)) return reject('E_LIMIT', 'the key must be a non-empty string');
        const o = opts && typeof opts === 'object' ? opts : {};
        return call('db.get', o.ledger ? { key, ledger: o.ledger } : { key });
      },
      set(key, value, opts) {
        if (badString(key)) return reject('E_LIMIT', 'the key must be a non-empty string');
        if (value === undefined || !isPlainJson(value)) return reject('E_LIMIT', 'the value must be plain JSON');
        return call('db.set', { key, value }, writeOpts(splitOpts(opts).local));
      },
      del(key, opts) {
        if (badString(key)) return reject('E_LIMIT', 'the key must be a non-empty string');
        return call('db.del', { key }, writeOpts(splitOpts(opts).local));
      },
      list(name, opts) {
        if (badString(name)) return reject('E_LIMIT', 'the list name must be a non-empty string');
        const o = opts && typeof opts === 'object' ? opts : {};
        const limit = o.limit === undefined ? 100 : o.limit;
        if (!Number.isInteger(limit) || limit < 1) return reject('E_LIMIT', 'limit must be a positive integer');
        const newestFirst = o.newestFirst === undefined ? true : Boolean(o.newestFirst);
        return call('db.list', o.ledger ? { name, limit, newestFirst, ledger: o.ledger } : { name, limit, newestFirst });
      },
      append(name, value, opts) {
        if (badString(name)) return reject('E_LIMIT', 'the list name must be a non-empty string');
        if (value === undefined || !isPlainJson(value)) return reject('E_LIMIT', 'the value must be plain JSON');
        return call('db.append', { name, value }, writeOpts(splitOpts(opts).local));
      },
      tombstone(h, opts) {
        if (typeof h !== 'string' || !HASH_RE.test(h)) return reject('E_LIMIT', 'h must be an entry hash (64 lowercase hex characters)');
        return call('db.tombstone', { h }, writeOpts(splitOpts(opts).local));
      },
      setMine: m('db.setMine'),
      getMine: m('db.getMine'),
      listBy: m('db.listBy'),
      // fn(snapshot: { height, peers, inSync, kv, lists, profiles, policy }) on every change; a new
      // subscriber first gets the latest snapshot already known. Returns unsubscribe(). With { ledger }:
      // the snapshots of a followed ledger (the hub amendment).
      subscribe(fn, opts) {
        if (typeof fn !== 'function') throw mwError('E_LIMIT', 'mw: db.subscribe expects a function');
        const ledger = opts && typeof opts === 'object' && typeof opts.ledger === 'string' ? opts.ledger : null;
        if (ledger) {
          if (!ledgerSubs.has(ledger)) ledgerSubs.set(ledger, new Set());
          ledgerSubs.get(ledger).add(fn);
          call('db.snapshot', { ledger }).then((snap) => { if (snap && ledgerSubs.has(ledger) && ledgerSubs.get(ledger).has(fn)) safeCall(fn, snap); }, () => {});
          return () => {
            const s = ledgerSubs.get(ledger);
            if (s) { s.delete(fn); if (!s.size) ledgerSubs.delete(ledger); }
          };
        }
        subscribers.add(fn);
        if (lastSnapshot !== null) {
          Promise.resolve().then(() => {
            if (subscribers.has(fn) && lastSnapshot !== null) safeCall(fn, lastSnapshot);
          });
        } else {
          pushState();
        }
        return () => { subscribers.delete(fn); };
      },
    },

    hub: {
      follow: m('hub.follow'),
      unfollow: m('hub.unfollow'),
      list: m('hub.list'),
      createPage: m('hub.createPage'),
    },

    mod: {
      ban(pub, opts) {
        if (badString(pub)) return reject('E_LIMIT', 'pub must be a public key string');
        return callArgs('mod.ban', [pub, opts]);
      },
      unban: m('mod.unban'),
      tombstoneMany: m('mod.tombstoneMany'),
      queue: m('mod.queue'),
      decide: m('mod.decide'),
    },

    chat: {
      enable: m('chat.enable'),
      disable: m('chat.disable'),
      state: m('chat.state'),
      presence: { set: m('chat.presence.set'), list: m('chat.presence.list') },
      contacts: {
        list: m('chat.contacts.list'), add: m('chat.contacts.add'), remove: m('chat.contacts.remove'),
        block: m('chat.contacts.block'), unblock: m('chat.contacts.unblock'), verify: m('chat.contacts.verify'),
      },
      requests: { list: m('chat.requests.list'), accept: m('chat.requests.accept'), decline: m('chat.requests.decline'), setOpen: m('chat.requests.setOpen') },
      dm: { send: m('chat.dm.send'), history: m('chat.dm.history'), keepHistory: m('chat.dm.keepHistory') },
      room: {
        join(name) { return callArgs('chat.room.join', [name === undefined ? 'Lobby' : name]); },
        leave: m('chat.room.leave'),
        send: m('chat.room.send'),
      },
      group: { create: m('chat.group.create'), invite: m('chat.group.invite'), remove: m('chat.group.remove'), leave: m('chat.group.leave'), send: m('chat.group.send') },
      holder: { set: m('chat.holder.set') },
      direct: { connect: m('chat.direct.connect') },
      on: onFor(service.chat, CHAT_EVENTS, 'chat'),
    },

    files: {
      enable: m('files.enable'),
      list: m('files.list'),
      received: m('files.received'),
      share: m('files.share'),
      // -> { handle, name, size, mime, stream(), blob() }; blob() is application/octet-stream (never render it).
      fetch: m('files.fetch'),
      preview: m('files.preview'),
      save: m('files.save'),
      keepSharing: m('files.keepSharing'),
      stopSharing: m('files.stopSharing'),
      remove: m('files.remove'),
      pinRequest: m('files.pinRequest'),
      on: onFor(service.files, FILES_EVENTS, 'files'),
    },

    media: {
      upload: m('media.upload'),
      list: m('media.list'),
      open: m('media.open'),
      close: m('media.close'),
      share: m('media.share'),
      revoke: m('media.revoke'),
      delete: m('media.delete'),
      keepAvailable: m('media.keepAvailable'),
      pinRequest: m('media.pinRequest'),
      on: onFor(service.media, MEDIA_EVENTS, 'media'),
    },

    report: { send: m('report.send') },

    // v0.3 C2: the same calls surface as the shell; in drop-in mode each method answers E_UNSUPPORTED (MwApi).
    calls: {
      start: m('calls.start'),
      accept: m('calls.accept'),
      decline: m('calls.decline'),
      hangup: m('calls.hangup'),
      mute: m('calls.mute'),
      camera: m('calls.camera'),
      screen: m('calls.screen'),
      state: m('calls.state'),
      list: m('calls.list'),
      on: onFor(service.calls, CALL_EVENTS, 'calls'),
    },

    net: {
      peers() {
        try {
          return api.peers();
        } catch (_) {
          return 0;
        }
      },
      // on('peers' | 'progress' | 'status' | 'sync' | 'pow', fn) -> unsubscribe()
      on(event, fn) {
        if (badString(event) || !listeners[event]) throw mwError('E_LIMIT', 'mw: net.on expects one of ' + NET_EVENTS.join(', '));
        if (typeof fn !== 'function') throw mwError('E_LIMIT', 'mw: net.on expects a function');
        listeners[event].add(fn);
        return () => { listeners[event].delete(fn); };
      },
      // v0.3 C2: the seeding counters and controls (the engine's control, MwApi.setNet; E_UNSUPPORTED without one)
      seeding: m('net.seeding'),
      dock: m('net.dock'),
      keep: m('net.keep'),
    },

    site: {
      // -> { name, files: [{ path, length }], btih, source: 'peers'|'webseed'|'cache'|'mixed', mode: 'dropin' }
      info() {
        return call('site.info', {});
      },
    },

    consent: {
      // Opens the loader-owned consent card; resolves with the visitor's choice ('pending' when it
      // was closed without one). A decided state resolves at once.
      request() {
        return call('consent.request', {});
      },
      // -> 'pending' | 'accepted' | 'host-only'
      state() {
        const c = api.consent;
        if (c && typeof c.state === 'function') {
          try {
            return c.state();
          } catch (_) { /* fall through */ }
        }
        return 'pending';
      },
    },

    owner: {
      // Personal sites (R 3.3): the owner changes the policy after the identity page's card. Elsewhere the
      // owner key never enters a browser (tools/ledger-admin.mjs): E_NOT_OWNER.
      policy(fields) {
        return call('owner.policy', fields && typeof fields === 'object' ? splitOpts(fields).params : {});
      },
    },
  };

  const deepFreeze = (o) => {
    for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object' && !Object.isFrozen(o[k])) deepFreeze(o[k]);
    return Object.freeze(o);
  };
  deepFreeze(mw);

  function destroy() {
    destroyed = true;
    if (timer !== null) {
      clearT(timer);
      timer = null;
    }
    offApi();
    subscribers.clear();
    authListeners.clear();
    ledgerSubs.clear();
    for (const e of NET_EVENTS) listeners[e].clear();
    for (const k of Object.keys(service)) service[k].clear();
  }

  return { mw, push, pushState, destroy };
}
