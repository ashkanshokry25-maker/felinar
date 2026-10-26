// src/dropin/leader.js: one engine per origin across tabs (ARCHITECTURE §5.9, §3.4.6;
// DESIGN-REVIEW S6). Many tabs of one site are normal in drop-in mode, so exactly one of them
// (the leader) runs the WebTorrent client and the ledger node; the others (followers) get the
// ledger state over a BroadcastChannel and forward their writes to the leader.
//
//   Leadership      Web Locks election on 'mw-swarm-<ledgerId>' as a small state machine:
//                   idle -> candidate -> leader | follower (-> leader when the leader goes away)
//                   -> released (pagehide: a held lock would keep the page out of the back/forward
//                   cache) -> candidate again on pageshow (restart())
//   TabLink         BroadcastChannel('mw-<ledgerId>') with request/response for forwarded writes
//   RemoteNode      the follower's stand-in for ChainNode (snapshot, subscribe, put/del/append...)
//   validTabMessage structural check of every channel message (it is still untrusted data)
//
// Same protocol and names as src/loader/app.js (a copy: importing app.js would drag the whole
// shell UI into the drop-in bundle). Without Web Locks every tab leads; without BroadcastChannel
// followers cannot exist, so every tab leads there too.

export const LOCK_PREFIX = 'mw-swarm-';
export const CHANNEL_PREFIX = 'mw-';
const BTIH_RE = /^[0-9a-f]{40}$/;
export const TAB_METHODS = Object.freeze(['put', 'del', 'append', 'profile', 'tombstone', 'ban']);
const TAB_METHOD_SET = new Set(TAB_METHODS);
/** Arguments of each forwarded write before its { signal, onProgress } (code review round 1). */
export const TAB_ARITY = Object.freeze({ put: 2, append: 2, del: 1, profile: 1, tombstone: 1, ban: 1 });

/** Validates a tab-link message: structure only, the payload is still untrusted. */
export function validTabMessage(m) {
  if (!m || typeof m !== 'object' || m.mw !== 1 || typeof m.t !== 'string' || typeof m.from !== 'string') return false;
  switch (m.t) {
    case 'leader':
    case 'need-state':
    case 'signed-out': // v0.3 (E-ID-2b): the engine tab signed out; carries nothing
      return true;
    case 'state':
      return Boolean(m.snap) && typeof m.snap === 'object';
    case 'site':
    case 'version':
      return typeof m.btih === 'string' && BTIH_RE.test(m.btih);
    case 'consent':
      return m.state === 'accepted' || m.state === 'host-only' || m.state === 'pending';
    case 'call':
      return typeof m.id === 'string' && TAB_METHOD_SET.has(m.method) && Array.isArray(m.args) && m.args.length <= 2;
    case 'result':
      return typeof m.id === 'string' && typeof m.to === 'string';
    case 'cancel':
      return typeof m.id === 'string';
    case 'pow':
      return typeof m.id === 'string' && typeof m.to === 'string' && Number.isFinite(m.hashes);
    default:
      return false;
  }
}

function defaultLocks() {
  return typeof navigator !== 'undefined' && navigator && navigator.locks ? navigator.locks : null;
}

/**
 * new Leadership(name, { locks, onChange })
 *   state: 'idle' | 'candidate' | 'leader' | 'follower' | 'released'
 *   start() → Promise<boolean>   true when this tab leads right now (decided without waiting for the
 *                                current leader); a follower keeps waiting in the background
 *   whenLeader                   a Promise that resolves once this tab leads (it may never)
 *   release()                    leave: drop the lock or the queued request
 *   restart() → Promise<boolean> request again after release()
 * onChange(state) is called on every transition.
 */
export class Leadership {
  constructor(name, { locks = defaultLocks(), onChange = null } = {}) {
    this.name = String(name);
    this.locks = locks;
    this.onChange = typeof onChange === 'function' ? onChange : null;
    this.state = 'idle';
    this._gen = 0;
    this._abort = null;
    this._free = null; // resolves the promise that holds the lock
    this._undecided = null; // settles the start() promise that has not been answered yet
    this._leaderWaiters = [];
    this.whenLeader = this._newWhenLeader();
  }

  get isLeader() { return this.state === 'leader'; }

  _newWhenLeader() {
    return new Promise((resolve) => { this._leaderWaiters.push(resolve); });
  }

  _set(state) {
    if (this.state === state) return;
    this.state = state;
    if (state === 'leader') {
      const waiters = this._leaderWaiters;
      this._leaderWaiters = [];
      for (const w of waiters) w();
    }
    if (this.onChange) {
      try {
        this.onChange(state);
      } catch (_) { /* the listener's bug */ }
    }
  }

  /** Without Web Locks (or when they throw) every tab leads: duplicate engines beat no engine. */
  _lead() {
    this._set('leader');
    return true;
  }

  start() {
    if (this.state === 'candidate' || this.state === 'leader' || this.state === 'follower') {
      return Promise.resolve(this.state === 'leader');
    }
    if (this.state === 'released') {
      this.whenLeader = this._newWhenLeader();
    }
    const gen = ++this._gen;
    this._set('candidate');
    const locks = this.locks;
    if (!locks || typeof locks.request !== 'function') return Promise.resolve(this._lead());
    return new Promise((resolve) => {
      let decided = false;
      const decide = (isLeader) => {
        if (decided) return;
        decided = true;
        if (this._undecided === decide) this._undecided = null;
        resolve(isLeader);
      };
      this._undecided = decide;
      const hold = () => new Promise((free) => { this._free = free; });
      const become = () => {
        if (gen !== this._gen) return null; // released while the request was queued: give the lock straight back
        this._set('leader');
        decide(true);
        return hold();
      };
      try {
        const first = locks.request(this.name, { ifAvailable: true }, (lock) => {
          if (gen !== this._gen) return null;
          if (lock) return become();
          this._set('follower');
          decide(false);
          // Queue for the lock; release() aborts this request so a left page never takes it later.
          const abort = typeof AbortController === 'function' ? new AbortController() : null;
          this._abort = abort;
          try {
            const queued = locks.request(this.name, abort ? { signal: abort.signal } : {}, () => become());
            if (queued && typeof queued.catch === 'function') queued.catch(() => {});
          } catch (_) { /* cannot queue: stay a follower */ }
          return null;
        });
        if (first && typeof first.catch === 'function') {
          first.catch(() => {
            if (!decided && gen === this._gen) {
              this._lead();
              decide(true);
            }
          });
        }
      } catch (_) {
        if (gen === this._gen) {
          this._lead();
          decide(true);
        } else {
          decide(false);
        }
      }
    });
  }

  restart() {
    if (this.state !== 'released' && this.state !== 'idle') return Promise.resolve(this.state === 'leader');
    return this.start();
  }

  release() {
    if (this.state === 'released' || this.state === 'idle') return;
    this._gen++;
    if (this._undecided) this._undecided(false); // a start() still waiting for the lock's answer
    if (this._abort) {
      try {
        this._abort.abort();
      } catch (_) { /* already aborted */ }
      this._abort = null;
    }
    if (this._free) {
      const free = this._free;
      this._free = null;
      free();
    }
    this._set('released');
  }
}

/** BroadcastChannel('mw-' + ledgerId) wrapper with request/response for forwarded writes. */
export class TabLink {
  constructor(ledgerId, { Channel = (typeof BroadcastChannel === 'function' ? BroadcastChannel : null), timeoutMs = 60000, setTimeoutFn = null, clearTimeoutFn = null } = {}) {
    this.ledgerId = ledgerId;
    this.Channel = Channel;
    this.id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    this.handlers = new Set();
    this.pending = new Map();
    this.timeoutMs = timeoutMs;
    this.seq = 0;
    this._setTimeout = setTimeoutFn || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimeout = clearTimeoutFn || ((t) => clearTimeout(t));
    this.channel = null;
    this.open();
  }

  get available() { return Boolean(this.Channel); }

  open() {
    if (this.channel || !this.Channel) return this;
    try {
      this.channel = new this.Channel(CHANNEL_PREFIX + this.ledgerId);
      this.channel.onmessage = (e) => this._receive(e && e.data);
    } catch (_) {
      this.channel = null;
    }
    return this;
  }

  on(fn) {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  send(t, data = {}) {
    if (!this.channel) return false;
    try {
      this.channel.postMessage(Object.assign({}, data, { mw: 1, t, from: this.id }));
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * call(method, args, { signal, onProgress }) → the leader's result. The answer may take as long as
   * the leader keeps reporting the fee's progress ('pow'); without news for timeoutMs, or when
   * `signal` aborts, the leader is told to cancel ('cancel') and the call rejects (code review round 1).
   */
  call(method, args, opts) {
    if (!this.channel) return Promise.reject(Object.assign(new Error('no tab link'), { code: 'E_IDENTITY' }));
    const signal = opts && opts.signal && typeof opts.signal.addEventListener === 'function' ? opts.signal : null;
    const onProgress = opts && typeof opts.onProgress === 'function' ? opts.onProgress : null;
    if (signal && signal.aborted) return Promise.reject(Object.assign(new Error('the write was cancelled'), { name: 'AbortError', code: 'E_POW_ABORTED' }));
    const id = this.id + ':' + (++this.seq);
    return new Promise((resolve, reject) => {
      let onAbort = null;
      const settle = (fn, value) => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        this._clearTimeout(p.timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        fn(value);
      };
      const expire = () => {
        this.send('cancel', { id });
        settle(reject, Object.assign(new Error('the tab running this site did not answer'), { code: 'E_INTERNAL' }));
      };
      this.pending.set(id, {
        resolve: (v) => settle(resolve, v),
        reject: (e) => settle(reject, e),
        timer: this._setTimeout(expire, this.timeoutMs),
        expire,
        onProgress,
      });
      if (signal) {
        onAbort = () => {
          this.send('cancel', { id });
          settle(reject, Object.assign(new Error('the write was cancelled'), { name: 'AbortError', code: 'E_POW_ABORTED' }));
        };
        signal.addEventListener('abort', onAbort);
      }
      if (!this.send('call', { id, method, args })) settle(reject, Object.assign(new Error('no tab link'), { code: 'E_IDENTITY' }));
    });
  }

  _receive(m) {
    if (!validTabMessage(m) || m.from === this.id) return;
    if (m.t === 'result') {
      if (m.to !== this.id) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.ok) p.resolve(m.result);
      else {
        const e = m.error && typeof m.error === 'object' ? m.error : {};
        p.reject(Object.assign(new Error(typeof e.message === 'string' && e.message ? e.message : 'failed'), { code: typeof e.code === 'string' && e.code ? e.code : 'E_INTERNAL' }));
      }
      return;
    }
    if (m.t === 'pow') {
      if (m.to !== this.id) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this._clearTimeout(p.timer);
      p.timer = this._setTimeout(p.expire, this.timeoutMs); // the leader is still working on it
      if (p.onProgress) {
        try {
          p.onProgress({ hashes: m.hashes, bits: Number(m.bits) || 0 });
        } catch (_) { /* the caller's bug */ }
      }
      return;
    }
    for (const fn of Array.from(this.handlers)) {
      try {
        fn(m);
      } catch (_) { /* a handler's bug must not stop the others */ }
    }
  }

  /** Closes the channel (pagehide). Pending forwarded writes fail now instead of at the timeout. */
  close() {
    for (const p of Array.from(this.pending.values())) {
      p.reject(Object.assign(new Error('the page was closed before the tab running this site answered'), { code: 'E_INTERNAL' }));
    }
    this.pending.clear();
    const ch = this.channel;
    this.channel = null;
    if (ch) {
      try {
        ch.onmessage = null;
        ch.close();
      } catch (_) { /* closed */ }
    }
  }
}

/** The follower's stand-in for ChainNode: snapshots from the leader, writes forwarded to it. */
export class RemoteNode {
  constructor(link) {
    this.link = link;
    this._snap = null;
    this._subs = new Set();
    this.peers = 0;
    this.inSyncPeers = 0;
    this.height = 0;
    this.role = 'reader';
    this.identity = null;
    this.ownerMismatch = false;
    this.unmoderated = false;
  }

  get state() { return null; }
  snapshot() { return this._snap; }

  subscribe(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }

  apply(m) {
    this._snap = m.snap;
    this.peers = Number(m.peers) || 0;
    this.inSyncPeers = Number(m.inSync) || 0;
    this.height = Number(m.snap && m.snap.height) || 0;
    if (typeof m.role === 'string') this.role = m.role;
    if (m.identity && typeof m.identity === 'object') this.identity = m.identity;
    for (const fn of Array.from(this._subs)) {
      try {
        fn(this._snap, { reason: 'remote' });
      } catch (_) { /* listener's bug */ }
    }
  }

  // Writes take ChainNode's { signal, onProgress } (TabLink.call forwards both).
  put(k, v, opts) { return this.link.call('put', [k, v], opts); }
  del(k, opts) { return this.link.call('del', [k], opts); }
  append(l, v, opts) { return this.link.call('append', [l, v], opts); }
  profile(name, opts) { return this.link.call('profile', [name], opts); }
  tombstone(h, opts) { return this.link.call('tombstone', [h], opts); }
  ban(author, opts) { return this.link.call('ban', [author], opts); }
}
