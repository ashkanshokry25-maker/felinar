// src/dropin/engine.js: the drop-in engine of one page view (ARCHITECTURE §3.4, §5.9, §8, §9;
// DESIGN-REVIEW item 23). /_mw/mw.js (mw.js) builds one DropinEngine per page and calls start().
//
// What a page view does, in order (every step fails open: the host already served the page, so an
// error becomes one console.warn and the page keeps working):
//   1. window.mw is bound at once (binding.js); ready() waits for the ledger.
//   2. After `load`: read and verify the stamped pointer against location.hostname (stamp.js), check
//      for a Service Worker of the site's own and register /mw-sw.js only if there is none (swreg.js).
//   3. At idle: elect one engine tab per origin (leader.js), open the ledger (ledger.js), look for a
//      complete copy in IndexedDB. A leader with no copy downloads one: the host's /_mw/ws/ as web seed
//      on unmetered networks, peers only after consent. The copy is saved, the worker is told, the
//      superseded version is dropped when no client renders it.
//   4. After 3 s of visible time AND consent: trackers and peers (seedFromCache, anchor torrent).
//   5. pagehide closes sockets, peers, ledger and the lock (back/forward-cache eligibility); a
//      persisted pageshow starts the engine again.
//   v0.3 (R 2.11, 3.8): the engine tab mounts the identity, chat, files and media services on the page's MwApi
//   (the SVC contract, src/loader/api.js mountV03Services); it alone holds keys. Follower tabs show its auth state
//   and drop it on 'signed-out'. UI methods need a click on the page (the ActivationTracker watches trusted input).
//
// Collaborators arrive through `deps` (module loaders), so Node tests run the whole flow with fakes.

import { CONFIG } from '../loader/config.js';
import { STRINGS } from '../loader/strings.js';
import { detectEnvironment, readBattery, computePolicy, watchLifecycle, watchNetwork, lifecyclePlan, deviceClassOf } from '../loader/policy.js';
import {
  MwApi, ActivationTracker, createTorrentSeam, mountV03Services, ownTrackerOf, chatDeviceClass, swPortFor, nodeIdentityOf, setNodeIdentity, writeRotation,
} from '../loader/api.js';
import { announceListFor } from '../loader/torrent.js';
import { consentModeFor, recipientsKey, makeConsentRecord, consentFromRecord, consentKeyFor } from '../loader/consent.js';
import { normalizeScope, parsePointer } from '../common/pointer.js';
import { purgeWithdrawn, withdrawalNotice } from '../common/withdrawal.js';
import { formatBytes } from './panel.js';
import { createBinding } from './binding.js';
import { createPanel as defaultCreatePanel } from './panel.js';
import { Leadership, TabLink, LOCK_PREFIX } from './leader.js';
import { setupServiceWorker, mapClient, notifySiteSaved, queryClients, onControllerChange, watchWorkerMessages, pingController, isOurScript, looksLikeKillSwitch, keepAlive } from './swreg.js';
import { evaluateStamp, describeRejection, readStampedText } from './stamp.js';
import { onWindowLoad, runWhenIdle, createVisibleTimer } from './schedule.js';
import { webseedDecision, dropinRecord, announceAllowed, promptFor, planVersions, missingFeatures, DROPIN } from './rules.js';
import { installPolyfills, selfTest } from './polyfills.js';
import { exportCurrentIdentity, importIdentity, ensureIdentity, createDropinIdentity } from './identity.js';
import { openLedger, followLedger, installTabLink, attachLedger, fetchSnapshot, closeLedger, broadcastState } from './ledger.js';
import { parseFileList, changedPaths, refreshHttpCache, FILE_LIST_PATH, SITE_MANIFEST_PATH } from './refresh.js';

const BTIH_RE = /^[0-9a-f]{40}$/;
const SW_SEEN_PREF = 'sw:registered';
// v0.3: how long the engine tab waits for a "Stay signed in" restore before it opens the ledger as a guest
// (the keys bind when the restore finishes).
const RESTORE_WAIT_MS = 3000;
// v0.3 (R 2.3.1): the page the identity origin returns to after a redirect sign-in (src/sw/core.js serves it).
const IDP_RETURN_PATH = '/_mw/idp-return';

function errMsg(err) {
  return (err && err.message) || String(err);
}

function realTimers() {
  return { setTimeoutFn: (fn, ms) => setTimeout(fn, ms), clearTimeoutFn: (id) => clearTimeout(id), now: () => Date.now() };
}

function noSite(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * The consent object MwApi, TorrentManager and the site all talk to. The site can only ask for the
 * loader-owned card (request(), v0.2.1 A4); the choice is made in the panel (closed shadow root).
 */
class ConsentState {
  constructor(engine) {
    this.e = engine;
    this._state = 'pending';
    this.listeners = new Set();
    this._waiters = [];
  }

  state() {
    return this._state;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  peersAllowed() {
    return this.e.announceReady();
  }

  /**
   * mw.consent.request() (v0.2.1 A4): shows the loader-owned card (the notice, or the gate when the
   * pointer says consent=gate) now, also with data-mw-consent="site" and before 3 s of visible
   * time, and resolves with the visitor's choice there ('pending' when the gate is cancelled or
   * nothing can be shown, for example without WebRTC). A decided state resolves at once; a
   * visitor's own host-only choice is never changed by the site.
   */
  async request() {
    await this.e.whenEvaluated();
    if (this.e.state === 'off' || this.e.state === 'destroyed') throw noSite('E_NO_HOST', 'felinar is not active on this page');
    if (this._state !== 'pending') return this._state;
    const waiter = new Promise((resolve) => this._waiters.push(resolve));
    if (!this.e.consentPromptRequested()) this.settleWaiters();
    return waiter;
  }

  /** Resolves every pending request() with the current state. */
  settleWaiters() {
    const waiters = this._waiters;
    this._waiters = [];
    for (const resolve of waiters) {
      try {
        resolve(this._state);
      } catch (_) { /* a waiter's bug */ }
    }
  }

  /**
   * set(state, { broadcast, gesture, fromTab }): gesture = the visitor's own click in the card or gate
   * (only then is persistent storage requested: Firefox prompts, ARCHITECTURE §8; code review round 1:
   * a follower tab used to request it when it heard another tab's choice); fromTab = a choice another
   * tab announced, adopted only when the stored per-origin record says the same (code review round 1:
   * a message on the tab channel is not a choice by itself).
   */
  async set(state, { broadcast = true, gesture = false, fromTab = false } = {}) {
    if (state !== 'accepted' && state !== 'host-only' && state !== 'pending') return this._state;
    if (this._state === state) {
      if (state !== 'pending') this.settleWaiters();
      return this._state;
    }
    const e = this.e;
    if (fromTab) {
      let stored = 'pending';
      try {
        const cache = await e.mod('cache');
        const rec = await cache.getPref(consentKeyFor('dropin'), null);
        const cfg = e.consentConfig();
        stored = consentFromRecord(rec && typeof rec === 'object' ? rec : null, { rcpt: recipientsKey(e.record, cfg), config: cfg });
        if (stored === state) e.consentRecord = rec;
      } catch (_) {
        stored = 'pending';
      }
      if (stored !== state) {
        e.log('ignored a sharing choice from another tab that the stored choice does not confirm');
        return this._state;
      }
      this._state = state;
      e.hidePrompt();
      e.recomputePolicy();
      e.refreshSettings();
      if (this._state !== 'pending') this.settleWaiters();
      return this._state;
    }
    this._state = state;
    if (state !== 'pending') {
      // v0.2.1 C1: the versioned record { v, choice, dns, day, scope, rcpt } per origin, as in the shell.
      try {
        const cache = await e.mod('cache');
        const rec = e.consentRecordFor(state);
        e.consentRecord = rec;
        await cache.setPref(consentKeyFor('dropin'), rec);
      } catch (err) {
        e.log('could not store the consent choice: ' + errMsg(err));
      }
    }
    e.hidePrompt();
    e.recomputePolicy();
    if (broadcast && e.link) e.link.send('consent', { state });
    if (state === 'accepted' && gesture) {
      e.mod('cache').then((c) => c.requestPersist()).then((v) => { e.persisted = v; }).catch(() => {});
    }
    // recomputePolicy() above already told the listeners when announcing became (im)possible.
    e.refreshSettings();
    if (this._state !== 'pending') this.settleWaiters();
    return this._state;
  }
}

export class DropinEngine {
  constructor({ win, deps, options = {}, config = CONFIG, strings = STRINGS, timers = null, createPanel = defaultCreatePanel, tracker = null } = {}) {
    if (!win || !win.document) throw new TypeError('DropinEngine needs a window');
    this.win = win;
    this.doc = win.document;
    this.nav = win.navigator || {};
    this.loc = win.location || {};
    this.config = config;
    this.strings = strings;
    this.deps = deps || {};
    this.options = Object.assign({ sw: 'auto', consent: 'notice' }, options);
    this.timers = Object.assign(realTimers(), timers || {});
    this.createPanel = createPanel;

    this.state = 'init'; // init -> starting -> ready -> running; off; destroyed
    this.offReason = null;
    this.warned = new Set();
    this.logs = [];
    this.mods = {};
    this.runId = 0;
    this.suspended = false;
    this.visible = false;
    this.webrtc = typeof win.RTCPeerConnection === 'function';
    this.prefs = { share: true, hostOnly: false, shareOnNetwork: false };

    this.verdict = null;
    this.record = null;
    this.scope = null;
    this.ledgerId = null;
    this.signed = false;
    this.btih = null;
    this.firstTime = false;
    this.consentRecord = null;

    this.env = null;
    this.battery = null;
    this.policy = null;
    this.sw = { mode: 'none', controlled: false, registration: null, reason: null };
    this.swPromise = Promise.resolve(this.sw);

    this.leadership = null;
    this.isLeader = false;
    this.link = null;
    this.node = null;
    this.followerNode = null;
    this.nodeStore = null;
    this.miner = null;
    this.verifierPool = null;
    this.identity = null;
    this.identityInfo = null;
    this.ledgerPromise = null;
    this.stateTimer = null;

    this.tm = null;
    this.tmPromise = null;
    this.laneStunList = null; // the site's own STUN list once read (laneStun)
    this.laneStunPromise = null;
    this.copy = null;
    this.obtaining = null;
    this.seeding = false;
    this.anchorAdded = false;
    this.corruptRetry = false;
    this.persisted = null;
    this.copyError = null;
    this.copyWebseed = null; // the running copy uses the host's web seed (onNetworkChange)
    this.swInfo = null;

    this.panel = null;
    this.hideCurrent = null;
    this.promptKind = null;
    this.hideSettings = null;
    this.visibleTimer = null;
    this.lifecycleStop = null;
    this.networkStop = null;
    this.hiddenTimer = null;
    this.lastAnnounce = false;
    this.swStops = [];
    this._evaluated = null;
    this._evaluatedResolve = null;
    this._started = null;

    this.consent = new ConsentState(this);
    // v0.3 (R 2.11.1): trusted input on this page is the only activation a UI method gets.
    this.tracker = tracker || new ActivationTracker({ nav: this.nav, now: this.timers.now });
    try {
      this.tracker.watch(win);
    } catch (_) { /* a window without events */ }
    this.identityMode = null; // 'v03' | 'legacy', decided when the v0.3 modules load
    this.v03 = null;
    this.servicesMounted = false;
    this.seam = null;
    this.offSignedOut = null;
    this.wasSignedIn = false;
    this.dropinIdentity = null;
    this.api = new MwApi({
      node: null,
      consent: this.consent,
      ui: { prompt: (kind, data) => this.promptCard(kind, data) },
      info: () => this.siteInfo(),
      identity: this.identityApi(),
      limits: {
        writesPerMinute: config.bridge.writesPerMinute,
        maxRequestBytes: config.bridge.maxRequestBytes,
        maxListLimit: config.bridge.maxListLimit,
        readyWaitMs: config.bridge.readyWaitMs,
      },
      now: this.timers.now,
      setTimeoutFn: this.timers.setTimeoutFn,
      clearTimeoutFn: this.timers.clearTimeoutFn,
      activation: this.tracker,
      // A follower is a tab that lost the election to another tab of this site; a page whose engine never started
      // (no pointer, off) is not one: its v0.3 methods answer E_UNSUPPORTED, not "use the first tab".
      tab: () => (this.isLeader || !this.leadership ? 'leader' : 'follower'),
      hostOnly: () => Boolean(this.policy && this.policy.hostOnly),
      lang: (this.nav && this.nav.language) || 'en',
      log: (line) => this.log(line),
    });
    this.api.ownerConfirm = (card) => this.ownerConfirm(card);
    this.api.identity.onChange((snap) => this.onAuthChange(snap));
    this.binding = createBinding({ api: this.api, ...this.timers });
    /** The §9 object for window.mw. */
    this.mw = this.binding.mw;
  }

  // ------------------------------------------------------------------- helpers

  /** The diagnostics log (inspect().logs): capped, and a line that repeats is counted instead of repeated. */
  log(line) {
    const text = String(line);
    const last = this.logs.length - 1;
    if (last >= 0) {
      const m = /^(.*) \(x(\d+)\)$/.exec(this.logs[last]);
      const base = m ? m[1] : this.logs[last];
      if (base === text) {
        this.logs[last] = text + ' (x' + ((m ? Number(m[2]) : 1) + 1) + ')';
        return;
      }
    }
    if (this.logs.length < 300) this.logs.push(text);
  }

  warnOnce(key, text) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log(text);
    try {
      if (typeof console !== 'undefined' && console.warn) console.warn(text);
    } catch (_) { /* no console */ }
  }

  infoOnce(key, text) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log(text);
    try {
      if (typeof console !== 'undefined' && console.info) console.info(text);
    } catch (_) { /* no console */ }
  }

  mod(name) {
    if (!this.mods[name]) {
      const loader = this.deps[name];
      if (typeof loader !== 'function') return Promise.reject(new Error('missing module loader: ' + name));
      this.mods[name] = Promise.resolve().then(loader);
      this.mods[name].catch(() => { delete this.mods[name]; });
    }
    return this.mods[name];
  }

  withTimeout(promise, ms, fallback) {
    let timer;
    return Promise.race([
      promise,
      new Promise((resolve) => { timer = this.timers.setTimeoutFn(() => resolve(fallback), ms); }),
    ]).finally(() => this.timers.clearTimeoutFn(timer));
  }

  whenEvaluated() {
    if (!this._evaluated) this._evaluated = new Promise((resolve) => { this._evaluatedResolve = resolve; });
    return this._evaluated;
  }

  resolveEvaluated() {
    this.whenEvaluated();
    if (this._evaluatedResolve) this._evaluatedResolve();
  }

  /** window.mw, siteInfo for the API: a function, so it always reflects the current copy. */
  siteInfo() {
    const files = this.copy && this.copy.manifest && Array.isArray(this.copy.manifest.files) ? this.copy.manifest.files : [];
    let source = null;
    if (this.copy) source = this.copy.fromCache ? 'cache' : (this.tm ? this.tm.source : null);
    return {
      siteId: this.ledgerId,
      btih: this.btih,
      mode: 'dropin',
      name: (this.copy && this.copy.manifest && this.copy.manifest.name) || (this.record && this.record.dn) || null,
      files,
      owner: this.signed && this.record ? this.record.owner : null,
      unmoderated: !this.signed,
      source,
    };
  }

  // export/import are for loader-owned UI only (the panel's Settings); MwApi no longer exposes them
  // to the site (v0.2.1 A4).
  identityApi() {
    return {
      current: () => this.identityInfo,
      export: async (passphrase) => {
        const [cache, crypto] = await Promise.all([this.mod('cache'), this.mod('crypto')]);
        return exportCurrentIdentity({ cache, crypto, ledgerId: this.ledgerId, passphrase, iterations: this.config.identity.pbkdf2Iterations });
      },
      import: async (text, passphrase) => {
        const [cache, crypto] = await Promise.all([this.mod('cache'), this.mod('crypto')]);
        const res = await importIdentity({ cache, crypto, ledgerId: this.ledgerId, text, passphrase });
        // The ledger node holds the old key in memory: a reload picks the imported one up.
        this.timers.setTimeoutFn(() => { try { this.loc.reload(); } catch (_) { /* no reload */ } }, 300);
        return { pub: res.pub };
      },
    };
  }

  announceReady() {
    return announceAllowed({
      consent: this.consent.state(),
      hostOnly: this.policy ? this.policy.hostOnly : false,
      visible: this.visible,
      suspended: this.suspended,
      webrtc: this.webrtc,
      noStore: this.noStore === true,
    });
  }

  /** Tells the TorrentManager (through consent.onChange) and the seeding logic when announcing became (im)possible. */
  fireAnnounceChange() {
    const now = this.announceReady();
    if (now === this.lastAnnounce) return;
    this.lastAnnounce = now;
    for (const fn of Array.from(this.consent.listeners)) {
      try {
        fn(this.consent.state());
      } catch (_) { /* a listener's bug */ }
    }
    if (now) this.maybeSeed();
  }

  inspect() {
    return {
      state: this.state,
      off: this.offReason,
      withdrawn: this.withdrawn || null,
      btih: this.btih,
      ledgerId: this.ledgerId,
      signed: this.signed,
      firstTime: this.firstTime,
      consent: this.consent.state(),
      consentRecord: this.consentRecord || null,
      leader: this.isLeader,
      sw: { mode: this.sw.mode, controlled: this.sw.controlled, reason: this.sw.reason },
      copy: this.copy ? { btih: this.copy.manifest.btih, files: this.copy.manifest.files.length, fromCache: this.copy.fromCache } : null,
      source: this.siteInfo().source,
      peers: this.tm ? this.tm.peers : 0,
      // Post-wave fix H: the piece bytes this page passed on to other visitors (progress.uploaded).
      uploaded: this.tm ? this.tm.uploadedBytes || 0 : 0,
      visible: this.visible,
      suspended: this.suspended,
      noStore: this.noStore === true,
      announce: this.announceReady(),
      policy: this.policy ? { column: this.policy.column, hostOnly: this.policy.hostOnly, uploadsEnabled: this.policy.uploadsEnabled, maxSiteBytes: this.policy.maxSiteBytes } : null,
      prompt: this.promptKind,
      webrtc: this.webrtc,
      verifierPool: this.verifierPool ? this.verifierPool.mode || null : null,
      logs: this.logs.slice(),
    };
  }

  // ------------------------------------------------------------------- start

  /** start() → Promise that settles when the first engine start is done (the page never waits for it). */
  start() {
    if (!this._started) {
      this._started = this._start().catch((err) => {
        this.goOff('error', 'felinar: the peer-to-peer engine stopped (' + errMsg(err) + '). The host serves every file.');
      });
    }
    return this._started;
  }

  async _start() {
    this.state = 'starting';
    let framed = false;
    try {
      framed = this.win.top !== this.win;
    } catch (_) {
      framed = true;
    }
    if (framed) return this.goOff('framed', null);
    const missing = missingFeatures(this.win);
    if (missing.length) {
      return this.goOff('unsupported', 'felinar: this browser lacks ' + missing.join(', ') + ', so the peer-to-peer engine is off. The host serves every file. Supported: Safari 15.4, Chromium 110, Firefox 115 or newer.');
    }
    installPolyfills(this.win);
    const failed = selfTest(this.win);
    if (failed.length) return this.goOff('polyfills', 'felinar: the engine needs browser features that failed their self-test (' + failed.join(', ') + '), so it is off. The host serves every file.');
    // v0.3: /_mw/idp-return (a page without a pointer) only finishes a redirect sign-in and goes back.
    if (this.onIdpReturnPage()) return this.finishIdpReturn();

    this.earlyMap();
    await new Promise((resolve) => onWindowLoad(this.win, resolve));
    if (this.state !== 'starting') return false;
    if (!(await this.evaluate())) return false;

    this.state = 'ready';
    this.visibleTimer = createVisibleTimer({ doc: this.doc, ms: DROPIN.visibleAnnounceMs, onElapsed: () => this.onVisibleElapsed(), ...this.timers });
    this.visibleTimer.start();
    this.swPromise = this.setupSw();
    await new Promise((resolve) => { this.cancelIdle = runWhenIdle(this.win, resolve, this.timers); });
    if (this.state !== 'ready') return false;
    return this.startEngine();
  }

  /**
   * A valid withdrawal (v0.2.1 A3, ARCHITECTURE 5.8): every stored version of this site is deleted
   * (the record it replaced, the version list, every site this origin holds), the engine goes off
   * with reason 'withdrawn', and one warning carries the publisher's why= text. The host keeps
   * serving its own pages: drop-in fails open to the host, never to an old peer-to-peer copy.
   */
  async withdrawScope(cache, v, cached) {
    const previous = cached && cached.record && typeof cached.record.btih === 'string' ? [cached.record.btih] : [];
    const res = await purgeWithdrawn({ cache, ledgerId: v.ledgerId, btihs: previous, all: true });
    this.withdrawn = Object.assign(withdrawalNotice(v.record), { deleted: res.deleted.length });
    const why = this.withdrawn.why ? ' The publisher says: ' + this.withdrawn.why + '.' : '';
    return this.goOff('withdrawn', 'felinar: the publisher withdrew this site, so this browser no longer shares it and deleted ' +
      res.deleted.length + ' stored copy(ies).' + why + ' The host serves its own pages.');
  }

  goOff(reason, message) {
    if (this.state === 'off' || this.state === 'destroyed') return false;
    this.state = 'off';
    this.offReason = reason;
    if (message) this.warnOnce('off:' + reason, message);
    this.log('engine off: ' + reason);
    this.api.setNode(null, { failed: true });
    this.resolveEvaluated();
    this.cleanup();
    return false;
  }

  cleanup() {
    this.runId++;
    if (this.visibleTimer) this.visibleTimer.cancel();
    if (this.hiddenTimer !== null) {
      this.timers.clearTimeoutFn(this.hiddenTimer);
      this.hiddenTimer = null;
    }
    if (this.lifecycleStop) {
      this.lifecycleStop();
      this.lifecycleStop = null;
    }
    if (this.networkStop) {
      this.networkStop();
      this.networkStop = null;
    }
    for (const stop of this.swStops.splice(0)) {
      try {
        stop();
      } catch (_) { /* gone */ }
    }
    if (this.panel) {
      this.panel.destroy();
      this.panel = null;
    }
    this.hideCurrent = null;
    this.promptKind = null;
    this.hideSettings = null;
  }

  // ------------------------------------------------------------------- pointer

  async evaluate() {
    const text = readStampedText(this.doc);
    if (!text) {
      return this.goOff('no-stamp', 'felinar: this page loads /_mw/mw.js but has no <meta name="mw-pointer"> tag, so the peer-to-peer engine is off. Publish the site with tools/publish.mjs --dropin to stamp every page.');
    }
    let cache;
    let pin = null;
    let cached = null;
    const hostname = this.loc.hostname;
    let scope;
    try {
      scope = normalizeScope(hostname);
    } catch (_) {
      return this.goOff('pointer:bad-scope', 'felinar: ' + describeRejection('bad-scope') + ', so the peer-to-peer engine is off. The host serves every file.');
    }
    try {
      cache = await this.mod('cache');
      pin = await cache.getPin(scope);
      cached = await cache.getPointer(scope);
    } catch (err) {
      return this.goOff('storage', 'felinar: browser storage is not available (' + errMsg(err) + '), so the peer-to-peer engine is off. The host serves every file.');
    }
    const cachedSeq = cached && cached.record && cached.record.signed && typeof cached.record.seq === 'number' ? cached.record.seq : null;
    const now = this.timers.now();
    let v = await evaluateStamp({ text, scope: hostname, now, pin, cachedSeq });
    if (v.status === 'key-changed') v = await this.resolveKeyChange(v, cache, pin, now);
    if (!v.ok) {
      return this.goOff('pointer:' + v.reason, 'felinar: ' + describeRejection(v.reason) + ', so the peer-to-peer engine is off. The host serves every file.');
    }
    this.verdict = v;
    this.record = v.record;
    this.scope = v.scope;
    this.ledgerId = v.ledgerId;
    this.signed = v.signed;
    this.btih = v.record.btih;
    this.firstTime = v.firstTime;
    if (v.expiresSoon) this.log('the signed pointer expires soon: the publisher has to sign it again');
    try {
      if (v.signed && (!pin || v.rotated)) await cache.savePin(v.scope, v.record.owner, { decidedAt: now, firstSeen: pin && pin.firstSeen ? pin.firstSeen : now, rotatedAt: v.rotated ? now : undefined });
      await cache.savePointer(v.scope, { record: v.record, raw: text, source: 'meta', savedAt: now, ttlUntil: null });
    } catch (err) {
      this.log('could not remember the pointer: ' + errMsg(err));
    }
    // v0.2.1 A3: a valid withdrawal (st= other than ok) is kept as the cached record, and the engine
    // stops for this scope: nothing is served or seeded and every stored copy is deleted.
    if (v.record.withdrawn) return this.withdrawScope(cache, v, cached);
    try {
      // v0.2.1 C1: a stored choice counts when its version and its recipients (tracker and STUN hosts)
      // match; a v0.2 choice (a bare string per ledger) or one for other recipients is asked again.
      const rec = await cache.getPref(consentKeyFor('dropin'), null);
      this.consentRecord = rec && typeof rec === 'object' ? rec : null;
      const cfg = this.consentConfig();
      this.consent._state = consentFromRecord(this.consentRecord, { rcpt: recipientsKey(v.record, cfg), config: cfg });
    } catch (_) { /* first visit */ }
    await this.loadPrefs(cache);
    this.resolveEvaluated();
    return true;
  }

  async resolveKeyChange(v, cache, pin, now) {
    const refusedKey = 'keyRefused:' + v.scope + ':' + v.record.owner;
    let refused = false;
    try {
      refused = Boolean(await cache.getPref(refusedKey, false));
    } catch (_) { /* not stored */ }
    if (refused) return Object.assign({}, v, { ok: false, status: 'rejected', reason: 'owner-changed' });
    const crypto = await this.mod('crypto');
    const fp = async (pub) => {
      try {
        return await crypto.fingerprint(pub);
      } catch (_) {
        return '?';
      }
    };
    const [oldFp, newFp] = await Promise.all([fp(v.oldOwner), fp(v.newOwner)]);
    const keep = await new Promise((resolve) => {
      this.ensurePanel().showKeyChange({
        scope: v.scope, oldFp, newFp,
        onKeep: () => resolve(true),
        onConfirm: () => resolve(false),
      });
    });
    if (keep) {
      try {
        await cache.setPref(refusedKey, true);
      } catch (_) { /* asked again next time */ }
      return Object.assign({}, v, { ok: false, status: 'rejected', reason: 'owner-changed' });
    }
    try {
      await cache.savePin(v.scope, v.record.owner, { decidedAt: now, firstSeen: pin && pin.firstSeen ? pin.firstSeen : now });
    } catch (_) { /* the choice holds for this page view */ }
    return Object.assign({}, v, { ok: true, status: 'ok', reason: null, firstTime: false });
  }

  async loadPrefs(cache) {
    const get = async (k, d) => {
      try {
        const v = await cache.getPref(k, d);
        return v === undefined ? d : v;
      } catch (_) {
        return d;
      }
    };
    this.prefs.share = (await get('uploads', true)) !== false;
    this.prefs.hostOnly = (await get('hostOnly', false)) === true;
    this.prefs.shareOnNetwork = (await get('shareOnNetwork:' + (this.loc.origin || ''), false)) === true;
  }

  // ------------------------------------------------------------------- Service Worker

  setupSw() {
    const log = (kind, text) => {
      if (kind === 'foreign') this.infoOnce('sw-foreign', text);
      else this.warnOnce('sw:' + kind, text);
    };
    return setupServiceWorker({
      nav: this.nav, caches: this.win.caches, option: this.options.sw, origin: this.loc.origin, log, precheck: () => this.killSwitchGate(),
      recheckMs: this.options.swRecheckMs, ...this.timers,
    }).then(async (sw) => {
      this.sw = sw;
      if (sw.registration && (sw.mode === 'ours' || sw.mode === 'uncontrolled')) await this.markSwSeen();
      this.log('service worker mode ' + sw.mode + (sw.controlled ? ' (controlling this page)' : ''));
      if (sw.mode === 'ours' || sw.mode === 'integrated') {
        this.swStops.push(onControllerChange(this.nav, () => {
          this.sw.controlled = Boolean(this.nav.serviceWorker && this.nav.serviceWorker.controller);
          this.mapToWorker();
        }));
        this.swStops.push(watchWorkerMessages(this.nav, { onInvalid: (d) => this.onSiteInvalid(d), onReload: () => this.onKillSwitchReload() }));
        if (sw.controlled) this.mapToWorker();
      }
      return sw;
    }).catch((err) => {
      this.warnOnce('sw', 'felinar: the Service Worker could not be set up (' + errMsg(err) + '). The host serves every file.');
      return this.sw;
    });
  }

  /** Remembers (per origin, in this browser) that ours was registered here, so its later absence is noticed. */
  async markSwSeen() {
    try {
      const cache = await this.mod('cache');
      if (!(await cache.getPref(SW_SEEN_PREF, null))) await cache.setPref(SW_SEEN_PREF, this.timers.now());
    } catch (_) { /* a missing note only costs one extra check later */ }
  }

  /**
   * No Service Worker registration exists. If this origin registered ours before, someone removed it
   * (the kill switch, DESIGN-REVIEW item 20, unregisters itself and reloads every page): look at what
   * /mw-sw.js is now, and do not register the kill switch again, or the page reloads forever.
   */
  async killSwitchGate() {
    const cache = await this.mod('cache');
    const seen = await cache.getPref(SW_SEEN_PREF, null);
    if (!seen) {
      // About to register here for the first time. Write the note before registering: if /mw-sw.js is the
      // kill switch, it reloads this page the moment it activates, possibly before any later write lands.
      await this.markSwSeen();
      return { ok: true };
    }
    let text = '';
    try {
      const res = await this.win.fetch('/mw-sw.js', { cache: 'no-cache', credentials: 'same-origin' });
      text = res && res.ok ? await res.text() : '';
    } catch (_) {
      return { ok: true };
    }
    if (looksLikeKillSwitch(text)) {
      return { ok: false, reason: 'kill-switch', message: 'felinar: /mw-sw.js is the kill switch, so the Service Worker is not registered and the host serves every file. Remove the /_mw/mw.js script tag from the pages to retire drop-in mode.' };
    }
    return { ok: true };
  }

  /**
   * A page controlled by a site's own worker that imports /_mw/sw-core.js never had its navigation
   * seen by felinar (a foreign worker is never given navigations), so nothing maps this page to
   * its version until a message says so. Say it as early as possible, before load, from the stamp
   * itself (the worker trusts the stamped pointer exactly as it would read it from the HTML), so the
   * subresources requested later in the page load can come from IndexedDB. Our own /mw-sw.js read
   * the stamp from the navigation and needs nothing. Fire and forget; the mapping after the Service
   * Worker setup (mapToWorker) repeats it and is idempotent.
   */
  earlyMap() {
    try {
      const controller = this.nav.serviceWorker && this.nav.serviceWorker.controller;
      if (!controller || this.options.sw === 'off' || isOurScript(controller.scriptURL, this.loc.origin)) return;
      const text = readStampedText(this.doc);
      const parsed = text ? parsePointer(text) : null;
      const btih = parsed && parsed.ok ? parsed.record.btih : null;
      if (!btih) return;
      pingController(this.nav, this.timers).then((pong) => {
        if (pong && this.state !== 'off' && this.state !== 'destroyed') return mapClient(this.nav, btih, this.timers);
        return null;
      }).catch(() => {});
    } catch (_) { /* best effort */ }
  }

  /** Tells the worker which version this page renders (3.4.3: the first load was not intercepted). */
  async mapToWorker() {
    const sw = await this.swPromise;
    if (this.state === 'off' || this.state === 'destroyed' || !this.btih) return null;
    if (!(sw.mode === 'ours' || sw.mode === 'integrated') || !this.nav.serviceWorker || !this.nav.serviceWorker.controller) return null;
    const ack = await mapClient(this.nav, this.btih, { registration: sw.registration, ...this.timers });
    // v0.2.1 D4: the host served this page with Cache-Control: no-store: run host-only (no tracker
    // socket, no peer), so the page keeps its back/forward-cache eligibility.
    if (ack && ack.doc && ack.doc.noStore === true && this.noStore !== true) {
      this.noStore = true;
      this.log('the host sent this page with Cache-Control: no-store: host only on this page (no trackers, no peers)');
      this.fireAnnounceChange();
    }
    return ack;
  }

  /** The kill switch (it unregisters itself) asked this page to reload so the host serves it plainly. Once. */
  onKillSwitchReload() {
    if (this.reloadAsked || this.state === 'destroyed') return;
    this.reloadAsked = true;
    this.log('the kill switch asked this page to reload');
    try {
      this.win.location.reload();
    } catch (_) { /* a frame or a locked-down page: the next navigation is served by the host anyway */ }
  }

  onSiteInvalid(d) {
    if (!d || d.btih !== this.btih) return;
    this.log('the worker removed the cached copy (' + d.reason + ')');
    this.copy = null;
    if (this.tm) this.tm.stopSite();
    if (this.isLeader && this.state === 'running' && !this.corruptRetry) {
      this.corruptRetry = true;
      this.obtainCopy({ force: true });
    }
  }

  // ------------------------------------------------------------------- policy, consent UI

  async refreshEnv() {
    if (!this.battery) {
      this.battery = await readBattery({ nav: this.nav, onChange: (b) => { this.battery = b; this.refreshEnvSync(); } });
    }
    this.refreshEnvSync();
  }

  refreshEnvSync() {
    this.env = detectEnvironment({ nav: this.nav, win: this.win, battery: this.battery });
    this.recomputePolicy();
  }

  /**
   * A change of network (navigator.connection 'change', 'online', the page visible again; code review
   * round 1): the policy is computed again, and a copy that runs through the host's web seed stops
   * using it when the network no longer allows it (ARCHITECTURE 3.4.7: only unmetered networks at
   * idle): it is aborted and started again from peers only (or not at all without peers).
   */
  onNetworkChange() {
    this.refreshEnvSync();
    if (!this.obtaining || this.copyWebseed !== true || !this.policy) return false;
    const wsd = webseedDecision({ policy: this.policy, sw: this.swInfo });
    if (wsd.allowed) return false;
    this.log('network changed: web seed off (' + wsd.reason + '), the copy continues from peers only');
    this.copyWebseed = false;
    const running = this.obtaining;
    if (this.abortCopy) {
      try {
        this.abortCopy.abort();
      } catch (_) { /* done */ }
    }
    running.then(() => { if (!this.suspended && this.state === 'running' && !this.copy) this.obtainCopy(); });
    return true;
  }

  recomputePolicy() {
    if (!this.env) this.env = detectEnvironment({ nav: this.nav, win: this.win, battery: this.battery });
    const hostOnly = this.prefs.hostOnly || !this.webrtc || this.consent.state() === 'host-only';
    this.policy = computePolicy(this.env, {
      share: this.prefs.share,
      hostOnly,
      shareOnNetwork: this.prefs.shareOnNetwork,
      pointerMax: this.record ? this.record.max : undefined,
    }, this.config);
    if (this.tm) this.tm.setPolicy(this.policy);
    this.fireAnnounceChange();
    return this.policy;
  }

  /** The config the consent rules read (a test config without consent keys falls back to CONFIG). */
  consentConfig() {
    return this.config && this.config.consent && this.config.trackers ? this.config : CONFIG;
  }

  /** 'gate' | 'notice' (v0.2.1 C1): consent= decides; without it, aud= (personal, eea, uk, qc, ...) forces the gate. */
  consentMode() {
    return this.record ? consentModeFor(this.record, this.consentConfig()) : null;
  }

  /** The versioned consent record for a choice made on this page (v0.2.1 C1; same shape as the shell's). */
  consentRecordFor(choice) {
    const cfg = this.consentConfig();
    let origin = null;
    try {
      origin = this.loc && this.loc.origin ? String(this.loc.origin) : null;
    } catch (_) { /* no location */ }
    return makeConsentRecord({ choice, scope: origin, rcpt: this.record ? recipientsKey(this.record, cfg) : '', now: this.timers.now(), config: cfg });
  }

  ensurePanel() {
    if (!this.panel) {
      this.panel = this.createPanel({
        win: this.win,
        strings: this.strings,
        // v0.3 (lane ui): the panel's Sign in and identity buttons run inside the person's click.
        actions: {
          signIn: (o) => this.api.signInFromCard(o || {}),
          openIdentity: () => this.api.openIdentityFromCard(),
        },
      });
    }
    return this.panel;
  }

  /** promptCard(kind, data): the loader-owned card in the panel's closed shadow root (lane ui panel.prompt). */
  promptCard(kind, data) {
    const panel = this.ensurePanel();
    if (!panel || typeof panel.prompt !== 'function') return Promise.resolve(false);
    return panel.prompt(kind, data);
  }

  hidePrompt() {
    if (this.hideCurrent) {
      try {
        this.hideCurrent();
      } catch (_) { /* gone */ }
    }
    this.hideCurrent = null;
    this.promptKind = null;
  }

  gateCancelledKey() {
    return 'mw-gate-cancelled:' + this.ledgerId;
  }

  gateCancelled() {
    try {
      return Boolean(this.win.sessionStorage && this.win.sessionStorage.getItem(this.gateCancelledKey()));
    } catch (_) {
      return false;
    }
  }

  onVisibleElapsed() {
    this.visible = true;
    this.fireAnnounceChange();
    this.maybePrompt();
  }

  maybePrompt() {
    if (this.state !== 'running' && this.state !== 'ready') return;
    if (!this.visible || this.hideCurrent) return;
    const kind = promptFor({
      consent: this.consent.state(),
      webrtc: this.webrtc,
      siteHandlesConsent: this.options.consent === 'site',
      recordConsent: this.consentMode(),
    });
    if (!kind) return;
    if (kind === 'gate' && this.gateCancelled()) return;
    this.showConsentPrompt(kind);
  }

  /**
   * The site asked for the consent card (mw.consent.request(), v0.2.1 A4): show it now, whatever
   * data-mw-consent says and before 3 s of visible time. true when a card is open (it was already,
   * or now is); false when none can be shown (decided, no WebRTC, another prompt is open).
   */
  consentPromptRequested() {
    if (this.state !== 'running' && this.state !== 'ready') return false;
    if (this.hideCurrent) return this.promptKind === 'notice' || this.promptKind === 'gate';
    const kind = promptFor({
      consent: this.consent.state(),
      webrtc: this.webrtc,
      siteHandlesConsent: false,
      recordConsent: this.consentMode(),
    });
    if (!kind) return false;
    this.showConsentPrompt(kind);
    return true;
  }

  showConsentPrompt(kind) {
    const panel = this.ensurePanel();
    const extra = this.firstTime ? this.strings.firstTime : null;
    if (kind === 'notice') {
      // v0.2.1 C1: the first-run card with a same-layer refusal, [Share and load] [Load from host only]
      // (the host always serves the pages in drop-in mode, so "host only" is always possible).
      this.promptKind = 'notice';
      const accept = () => { this.hideCurrent = null; this.promptKind = null; this.consent.set('accepted', { gesture: true }); };
      this.hideCurrent = typeof panel.showConsentCard === 'function'
        ? panel.showConsentCard({
          extra,
          hostOnlyOffered: true,
          mobile: Boolean(this.env && this.env.isMobile),
          onShare: accept,
          onHostOnly: () => { this.hideCurrent = null; this.promptKind = null; this.consent.set('host-only'); },
          onSettings: () => { this.openSettings(); },
        })
        : panel.showNotice({ extra, onOk: accept, onSettings: () => { this.openSettings(); } });
    } else {
      this.promptKind = 'gate';
      this.hideCurrent = panel.showGate({
        extra,
        hostOnlyOffered: true, // the static host is always an HTTP source in drop-in mode
        onLoad: () => { this.hideCurrent = null; this.promptKind = null; this.consent.set('accepted', { gesture: true }); },
        onHostOnly: () => { this.hideCurrent = null; this.promptKind = null; this.consent.set('host-only'); },
        onCancel: () => {
          this.hideCurrent = null;
          this.promptKind = null;
          try {
            if (this.win.sessionStorage) this.win.sessionStorage.setItem(this.gateCancelledKey(), '1');
          } catch (_) { /* private mode */ }
          this.consent.settleWaiters(); // closed without a choice: request() resolves 'pending'
        },
      });
    }
  }

  // ------------------------------------------------------------------- the engine

  /** Leader election, ledger, copy. Runs at idle, and again after a back/forward-cache restore. */
  async startEngine() {
    if (this.state !== 'ready' && this.state !== 'running') return false;
    const run = ++this.runId;
    this.state = 'running';
    this.suspended = false;
    this.corruptRetry = false;
    await this.refreshEnv();
    if (run !== this.runId) return false;
    this.installLifecycle();

    this.link = new TabLink(this.ledgerId, { Channel: this.win.BroadcastChannel || null, setTimeoutFn: this.timers.setTimeoutFn, clearTimeoutFn: this.timers.clearTimeoutFn });
    installTabLink(this);
    if (this.link.available) {
      this.leadership = new Leadership(LOCK_PREFIX + this.ledgerId, { locks: this.nav.locks || null });
      this.isLeader = await this.leadership.start();
    } else {
      this.leadership = null;
      this.isLeader = true; // no way to talk to siblings: every tab runs its own engine
    }
    if (run !== this.runId) return false;
    this.log(this.isLeader ? 'engine tab' : 'follower tab');
    await this.setupV03();
    if (run !== this.runId) return false;
    this.ledgerPromise = this.isLeader ? openLedger(this) : followLedger(this);
    if (!this.isLeader && this.leadership) this.leadership.whenLeader.then(() => this.promote(run));

    const cached = await this.lookupCache();
    if (run !== this.runId) return false;
    if (this.isLeader) this.afterLedger(run);
    this.maybePrompt();
    if (cached) await this.useCopy(cached);
    else if (this.isLeader) this.obtainCopy();
    return true;
  }

  async afterLedger(run) {
    const node = await this.withTimeout(this.ledgerPromise, this.config.ledger.nodeOpenMs * 4, null);
    if (run !== this.runId || !node || node === this.followerNode) return;
    fetchSnapshot(this);
  }

  async promote(run) {
    if (run !== this.runId || this.isLeader || this.state !== 'running') return;
    this.isLeader = true;
    this.log('this tab now runs the engine');
    this.followerNode = null;
    // v0.3: this tab now holds the services (and, after sign-in, the keys).
    await this.mountLeaderServices();
    this.ledgerPromise = openLedger(this);
    await this.ledgerPromise;
    if (run !== this.runId) return;
    this.afterLedger(run);
    if (this.copy) {
      this.maybeSeed();
      this.pruneVersions();
    } else {
      this.obtainCopy();
    }
  }

  onSiblingSavedSite() {
    // Another tab stored the copy: read it (this tab may be a follower that needs it for site.info()).
    if (this.copy || this.state !== 'running') return;
    this.lookupCache().then((c) => { if (c && !this.copy) return this.useCopy(c); return null; }).catch(() => {});
  }

  // ----- the copy in IndexedDB

  async lookupCache() {
    try {
      const [cache, verify, torrentFile] = await Promise.all([this.mod('cache'), this.mod('verify'), this.mod('torrentFile')]);
      const site = await cache.getSite(this.btih);
      if (!site || !site.complete || !(site.torrentFile instanceof Uint8Array) || !Array.isArray(site.files)) return null;
      // The expected btih is the stamped page's, never IndexedDB's own claim (§7.3).
      if (!(await verify.verifyInfoHash(site.torrentFile, this.btih))) {
        this.log('the stored torrent does not hash to ' + this.btih + '; removed');
        await cache.deleteSite(this.btih);
        return null;
      }
      const blobs = new Map();
      for (const f of site.files) {
        const blob = await cache.getFile(this.btih, f.path);
        if (!blob || typeof blob.size !== 'number' || blob.size !== f.length) {
          this.log('the stored copy is incomplete at ' + f.path);
          return null;
        }
        blobs.set(f.path, blob);
      }
      const parsed = await torrentFile.parseTorrentFile(site.torrentFile);
      await cache.touchSite(this.btih).catch(() => {});
      return { manifest: site, blobs, parsed, fromCache: true };
    } catch (err) {
      this.log('cache lookup failed: ' + errMsg(err));
      return null;
    }
  }

  async useCopy(copy) {
    this.copy = copy;
    this.binding.pushState();
    await this.afterCopy();
  }

  async afterCopy() {
    const tasks = [this.mapToWorker()];
    if (this.isLeader) {
      tasks.push(this.pruneVersions());
      tasks.push(this.maybeSeed());
    }
    this.refreshSettings();
    // Each task handles its own failures; this settles when all of them are done.
    await Promise.all(tasks.map((t) => Promise.resolve(t).catch(() => null)));
  }

  async persistSite(res) {
    const cache = await this.mod('cache');
    try {
      await cache.saveSite(res.manifest, res.blobs);
    } catch (err) {
      const quota = err && (err.name === 'QuotaExceededError' || /quota/i.test(errMsg(err)));
      this.warnOnce('persist', 'felinar: ' + (quota ? this.strings.storageFull : 'the site could not be stored (' + errMsg(err) + ')') + ' The host keeps serving every file.');
      return false;
    }
    const sw = await this.swPromise;
    if (sw.mode === 'ours' || sw.mode === 'integrated') await notifySiteSaved(this.nav, this.btih, { registration: sw.registration, ...this.timers });
    try {
      await cache.enforceBudget({ budgetBytes: this.policy.storageBudget, keep: [this.btih] });
    } catch (_) { /* best effort */ }
    if (this.link) this.link.send('site', { btih: this.btih });
    return true;
  }

  /** Keeps the current version and at most one previous one, and that one only while a client renders it (3.4.5). */
  async pruneVersions() {
    try {
      const cache = await this.mod('cache');
      const key = 'versions:' + this.ledgerId;
      let versions = [];
      try {
        versions = (await cache.getPref(key, [])) || [];
      } catch (_) {
        versions = [];
      }
      if (!Array.isArray(versions)) versions = [];
      const sw = await this.swPromise;
      let live = null;
      if (sw.mode === 'ours' || sw.mode === 'integrated') {
        const reply = await queryClients(this.nav, { registration: sw.registration, ...this.timers });
        live = reply && reply.clients ? reply.clients : null;
      }
      const plan = planVersions({ versions, current: this.btih, live });
      for (const old of plan.drop) {
        try {
          await cache.deleteSite(old);
          this.log('removed superseded version ' + old);
        } catch (_) { /* best effort */ }
      }
      await cache.setPref(key, plan.versions);
      return plan;
    } catch (err) {
      this.log('version cleanup failed: ' + errMsg(err));
      return null;
    }
  }

  // ----- torrent manager

  async ensureTorrentManager() {
    if (this.tm) return this.tm;
    if (!this.tmPromise) {
      this.tmPromise = (async () => {
        const [torrent, WebTorrent] = await Promise.all([this.mod('torrent'), this.mod('webtorrent')]);
        if (this.state === 'destroyed' || this.state === 'off') throw noSite('E_ABORTED', 'engine stopped');
        const tm = new torrent.TorrentManager({ WebTorrent, config: this.config, policy: this.policy, consent: this.consent });
        tm.addEventListener('torrent', (e) => attachLedger(this, e.detail.torrent));
        tm.addEventListener('peers', (e) => {
          this.binding.push('peers', { count: (e.detail && e.detail.count) || 0 });
          this.binding.pushState();
        });
        tm.addEventListener('progress', (e) => this.binding.push('progress', e.detail || {}));
        tm.addEventListener('status', (e) => {
          this.binding.push('status', e.detail || {});
          this.log('status ' + ((e.detail && e.detail.code) || ''));
        });
        tm.addEventListener('warning', (e) => this.onTorrentWarning(e.detail || {}));
        tm.addEventListener('tracker', (e) => this.log('tracker ' + e.detail.url + ' ' + e.detail.state));
        this.tm = tm;
        this.api.setTorrentManager(tm);
        if (this.seam) this.seam.attach(tm);
        // The site's own STUN servers for the chat, group, file and media swarms (R 2.7.1, MF-44: the public default
        // STUN operators are never their fallback), once known (laneStun(): read when a swarm or the chat card needs it).
        if (this.laneStunList && typeof tm.setLaneIceServers === 'function') tm.setLaneIceServers(this.laneStunList);
        return tm;
      })();
      this.tmPromise.catch(() => { this.tmPromise = null; });
    }
    return this.tmPromise;
  }

  /**
   * laneStun() -> Promise<string[]>: the stun list of this site's /.mw/site.json (publish --stun), [] when it names none,
   * read once and only when a lane, a file swarm or the chat card needs it (code review v0.3, MF-44): from the stored
   * copy when there is one (the copy is the site, so a copy without the file names no STUN), else from the host
   * (siteStun). The list goes to the torrent manager and to the chat card (api.setLaneStun).
   */
  laneStun() {
    if (!this.laneStunPromise) {
      this.laneStunPromise = (async () => {
        let stun = await this.copyStun(this.copy);
        if (stun === null) stun = await this.siteStun();
        this.applyLaneStun(stun);
        return stun;
      })();
      this.laneStunPromise.catch(() => { this.laneStunPromise = null; });
    }
    return this.laneStunPromise;
  }

  /** copyStun(copy) -> Promise<string[] | null>: the stun list of a copy's .mw/site.json; null without a copy. */
  async copyStun(copy) {
    const blobs = copy && copy.blobs;
    if (!blobs || typeof blobs.get !== 'function') return null;
    const blob = blobs.get(SITE_MANIFEST_PATH) || blobs.get('/' + SITE_MANIFEST_PATH);
    if (!blob || typeof blob.text !== 'function') return [];
    try {
      const v = JSON.parse(await blob.text());
      return v && Array.isArray(v.stun) ? v.stun.slice(0, 4) : [];
    } catch (_) {
      return [];
    }
  }

  /** applyLaneStun(list): the torrent manager and the chat card use this list from now on. */
  applyLaneStun(list) {
    this.laneStunList = Array.isArray(list) ? list.slice(0, 4) : [];
    if (this.tm && typeof this.tm.setLaneIceServers === 'function') this.tm.setLaneIceServers(this.laneStunList);
    if (this.api && typeof this.api.setLaneStun === 'function') this.api.setLaneStun(this.laneStunList);
  }

  /** siteStun() -> the stun list of the host's /.mw/site.json ([] when it names none or the file is missing). */
  async siteStun() {
    try {
      const res = await this.win.fetch('/' + SITE_MANIFEST_PATH, { cache: 'no-cache', credentials: 'same-origin' });
      if (!res || !res.ok) return [];
      const v = await res.json();
      return v && Array.isArray(v.stun) ? v.stun.slice(0, 4) : [];
    } catch (_) {
      return [];
    }
  }

  onTorrentWarning(d) {
    this.log('warning ' + d.code + (d.message ? ': ' + d.message : '') + (d.reason ? ' (' + d.reason + ')' : ''));
    if (d.code === 'E_CACHE_CORRUPT') this.handleCorruptCache();
  }

  async handleCorruptCache() {
    if (this.corruptRetry) return;
    this.corruptRetry = true;
    this.warnOnce('corrupt', 'felinar: ' + this.strings.cachedCorrupt);
    try {
      const cache = await this.mod('cache');
      await cache.deleteSite(this.btih);
    } catch (_) { /* best effort */ }
    this.copy = null;
    if (this.tm) this.tm.stopSite();
    if (this.isLeader) this.obtainCopy({ force: true });
  }

  addAnchor() {
    if (!this.tm || !this.ledgerId || this.anchorAdded) return;
    this.anchorAdded = true;
    this.tm.addAnchor(this.ledgerId, announceListFor(this.record, this.config.trackers)).catch((err) => this.log('anchor torrent: ' + errMsg(err)));
  }

  /** Starts sharing a copy that came from IndexedDB, once announcing is allowed. */
  async maybeSeed() {
    if (!this.isLeader || !this.copy || this.seeding || this.state !== 'running' || !this.announceReady()) return;
    this.seeding = true;
    const run = this.runId;
    try {
      const tm = await this.ensureTorrentManager();
      if (this.ledgerPromise) await this.withTimeout(this.ledgerPromise, this.config.ledger.nodeOpenMs, null);
      if (run !== this.runId || !this.copy) return;
      if (this.copy.fromCache && !this.copy.seeded) {
        await tm.seedFromCache({ manifest: this.copy.manifest, blobs: this.copy.blobs, parsed: this.copy.parsed, record: this.record });
        this.copy.seeded = true;
      }
      this.addAnchor();
    } catch (err) {
      if (!(err && err.code === 'E_ABORTED')) this.warnOnce('seed', 'felinar: sharing could not start (' + errMsg(err) + ').');
    } finally {
      this.seeding = false;
    }
  }

  /**
   * The keep-alive interval on the engine's own timers (tests drive them with a fake clock): a timeout
   * that re-arms itself, cleared by clearIntervalFn.
   */
  keepAliveIntervals() {
    const t = this.timers;
    return {
      setIntervalFn: (fn, ms) => {
        const h = { id: null, live: true };
        const tick = () => {
          if (!h.live) return;
          fn();
          if (h.live) h.id = t.setTimeoutFn(tick, ms);
        };
        h.id = t.setTimeoutFn(tick, ms);
        return h;
      },
      clearIntervalFn: (h) => {
        if (!h) return;
        h.live = false;
        if (h.id !== null) t.clearTimeoutFn(h.id);
      },
    };
  }

  /** The leader downloads the copy: the host's web seed when allowed, peers after consent. */
  obtainCopy({ force = false } = {}) {
    if (this.obtaining) {
      // A download that is still finishing (saving, mapping) cannot be asked twice; a forced one
      // (the copy turned out to be damaged) starts again as soon as it is done.
      return force ? this.obtaining.then(() => this.obtainCopy()) : this.obtaining;
    }
    const run = this.runId;
    this.obtaining = (async () => {
      try {
        const sw = await this.swPromise;
        if (run !== this.runId) return;
        this.swInfo = sw;
        const wsd = webseedDecision({ policy: this.policy, sw });
        this.copyWebseed = wsd.allowed;
        this.log('web seed ' + (wsd.allowed ? 'allowed' : 'off (' + wsd.reason + ')'));
        const peersPossible = this.webrtc && this.consent.state() !== 'host-only' && !this.prefs.hostOnly;
        if (!wsd.allowed && !peersPossible) {
          this.copyError = 'no-source';
          return;
        }
        if (wsd.allowed) await this.refreshStale();
        // The worker answers /_mw/ws/ only for the version a mapped page renders (code review round
        // 1): the mapping is in place before the first web-seed request.
        if (wsd.allowed) await this.mapToWorker();
        if (run !== this.runId) return;
        const tm = await this.ensureTorrentManager();
        if (this.ledgerPromise) await this.withTimeout(this.ledgerPromise, this.config.ledger.nodeOpenMs, null);
        if (run !== this.runId) return;
        this.addAnchor();
        const abort = typeof AbortController === 'function' ? new AbortController() : null;
        this.abortCopy = abort;
        // v0.2.1 D1: the download goes through the worker's /_mw/ws/ rewrite; keep the worker alive
        // (a ping at most every 20 s) until it is done.
        const alive = wsd.allowed ? keepAlive(this.nav, this.keepAliveIntervals()) : null;
        if (alive) alive.hold();
        let res;
        try {
          res = await tm.download({
            record: dropinRecord(this.record, { origin: this.loc.origin, allowWebseed: wsd.allowed }),
            maxBytes: this.policy.maxSiteBytes,
            signal: abort ? abort.signal : null,
          });
        } finally {
          if (alive) alive.stop();
        }
        if (run !== this.runId) return;
        this.copy = { manifest: res.manifest, blobs: res.blobs, parsed: res.parsed, fromCache: false };
        this.copyError = null;
        this.binding.pushState();
        await this.persistSite(res);
        await this.afterCopy();
      } catch (err) {
        this.copyError = (err && err.code) || 'error';
        this.presentDownloadError(err);
      } finally {
        this.obtaining = null;
      }
    })();
    return this.obtaining;
  }

  /**
   * Before the host is used as a web seed for a NEW version: replace stale HTTP-cache entries of the
   * files that changed since the stored previous version (refresh.js says why). Best effort.
   */
  async refreshStale() {
    try {
      const cache = await this.mod('cache');
      const versions = ((await cache.getPref('versions:' + this.ledgerId, [])) || []).filter((v) => v !== this.btih);
      let previous = null;
      for (const v of versions) {
        if (await cache.getSite(v)) {
          previous = v;
          break;
        }
      }
      if (!previous) return null;
      const oldBlob = await cache.getFile(previous, FILE_LIST_PATH);
      if (!oldBlob) return null;
      const res = await this.win.fetch('/' + FILE_LIST_PATH, { cache: 'no-cache', credentials: 'same-origin' });
      if (!res || !res.ok) return null;
      const oldList = parseFileList(JSON.parse(await oldBlob.text()));
      const newList = parseFileList(await res.json());
      if (!oldList || !newList) return null;
      const paths = changedPaths(oldList, newList).concat([SITE_MANIFEST_PATH]);
      const out = await refreshHttpCache({ fetchFn: (url, init) => this.win.fetch(url, init), origin: this.loc.origin, paths, ...this.timers });
      this.log('refreshed ' + out.refreshed + ' changed file(s) of the new version' + (out.failed.length ? ', ' + out.failed.length + ' failed' : ''));
      return out;
    } catch (err) {
      this.log('refresh of changed files failed: ' + errMsg(err));
      return null;
    }
  }

  presentDownloadError(err) {
    const code = err && err.code;
    this.log('download failed: ' + code + ' ' + errMsg(err));
    const tail = ' The host keeps serving every file.';
    if (code === 'E_ABORTED') return;
    if (code === 'E_TOO_LARGE') this.warnOnce('download', 'felinar: ' + this.strings.tooLargeTitle + '. ' + this.strings.tooLarge(formatBytes(err.length), formatBytes(err.maxBytes)) + tail);
    else if (code === 'E_NO_PEERS') this.warnOnce('download', 'felinar: ' + this.strings.noPeersTitle + '.' + tail);
    else if (code === 'E_TIMEOUT') this.warnOnce('download', 'felinar: ' + this.strings.timeoutTitle + '. ' + this.strings.timeout + tail);
    else if (code === 'E_BAD_TORRENT') this.warnOnce('download', 'felinar: ' + this.strings.badTorrentTitle + '. ' + this.strings.badTorrent + tail);
    else this.warnOnce('download', 'felinar: ' + this.strings.genericErrorTitle + ' (' + errMsg(err) + ').' + tail);
  }

  // ------------------------------------------------------------------- lifecycle

  installLifecycle() {
    if (this.lifecycleStop) return;
    const cfg = this.config.policy;
    const flush = () => {
      try {
        if (this.nodeStore && typeof this.nodeStore.flush === 'function') this.nodeStore.flush();
      } catch (_) { /* best effort */ }
    };
    this.networkStop = watchNetwork({ nav: this.nav, onChange: () => this.onNetworkChange() });
    // Code review round 1: the shell's C2 plan (lifecyclePlan): phones keep the client when hidden (the
    // TorrentManager choke-locks every wire at once) and rebuild it after policy.rebuildAfterHiddenMs
    // (10 s on phones, 60 s on desktop), instead of destroying it on every hide.
    this.lifecycleStop = watchLifecycle({
      onHidden: () => {
        flush();
        if (!this.tm || !this.policy) return;
        const plan = lifecyclePlan('hidden', { policy: this.policy });
        if (plan.pause) this.tm.pause();
        else if (plan.batteryTimer) {
          if (this.hiddenTimer !== null) this.timers.clearTimeoutFn(this.hiddenTimer);
          this.hiddenTimer = this.timers.setTimeoutFn(() => { this.hiddenTimer = null; if (this.tm) this.tm.pause(); }, cfg.hiddenBatteryMs);
        }
      },
      onVisible: (hiddenFor) => {
        if (this.hiddenTimer !== null) {
          this.timers.clearTimeoutFn(this.hiddenTimer);
          this.hiddenTimer = null;
        }
        this.onNetworkChange();
        const plan = lifecyclePlan('visible', { policy: this.policy, hiddenFor, suspended: !!(this.tm && this.tm.suspended) });
        if (this.tm && !this.suspended && plan.rebuild) this.tm.rebuild();
      },
      onPageHide: () => { this.suspend(); },
      onPageShow: (persisted) => { if (persisted) this.resume(); },
      onOnline: () => {
        this.onNetworkChange();
        if (this.tm && !this.suspended) this.tm.rebuild();
      },
      onFreeze: () => { this.suspend(); },
      onResume: () => { this.resume(); },
    }, { doc: this.doc, win: this.win, now: this.timers.now });
  }

  /** pagehide / freeze: close sockets, peers, the ledger, the channel and the lock (back/forward-cache eligibility). */
  suspend() {
    if (this.suspended || this.state !== 'running') return;
    this.suspended = true;
    this.log('suspended');
    this.closeSessions();
    if (this.visibleTimer) this.visibleTimer.cancel();
    this.visible = false;
    this.fireAnnounceChange();
    this.teardownEngine();
  }

  /** pageshow (persisted) / resume: the same engine start as at idle, with a fresh 3 s of visibility. */
  resume() {
    if (!this.suspended || this.state !== 'running') return;
    this.suspended = false;
    this.log('resumed');
    if (this.visibleTimer) this.visibleTimer.reset();
    this.startEngine();
  }

  teardownEngine() {
    this.runId++;
    if (this.abortCopy) {
      try {
        this.abortCopy.abort();
      } catch (_) { /* done */ }
      this.abortCopy = null;
    }
    const tm = this.tm;
    this.tm = null;
    this.tmPromise = null;
    this.api.setTorrentManager(null);
    if (tm) {
      try {
        tm.destroy();
      } catch (_) { /* gone */ }
    }
    if (this.leadership) {
      this.leadership.release();
      this.leadership = null;
    }
    if (this.link) {
      this.link.close();
      this.link = null;
    }
    this.copy = null;
    this.obtaining = null;
    this.seeding = false;
    this.anchorAdded = false;
    this.isLeader = false;
    this.lastAnnounce = false;
    const closing = closeLedger(this);
    this.api.setNode(null);
    return closing;
  }

  // ------------------------------------------------------------------- settings

  async settingsModel() {
    let usage = null;
    try {
      usage = await (await this.mod('cache')).estimateUsage();
    } catch (_) { /* no storage info */ }
    const u = usage || {};
    return {
      share: this.prefs.share,
      hostOnly: Boolean(this.policy && this.policy.hostOnly),
      hostOnlyForced: !this.webrtc,
      isMobile: Boolean(this.env && this.env.isMobile),
      shareOnNetwork: this.prefs.shareOnNetwork,
      storage: { usage: u.usage || 0, quota: u.quota || 0 },
      persisted: u.persisted === true ? true : (this.persisted === true ? true : (u.persisted === false ? false : null)),
      canForget: Boolean(this.copy),
      version: this.config.version,
      // v0.2.1 (A4): export and import live in the panel only (loader-owned, closed shadow root). v0.3: the panel
      // shows "Open identity page"; the 0.2.1 fields only for a build without the identity service (legacy).
      identity: this.identityMode === 'v03'
        ? { short: this.identityInfo ? this.identityInfo.short || null : null, name: this.identityInfo ? this.identityInfo.name || null : null, canExport: false, canImport: false, legacy: false, v03: true }
        : (this.identityInfo && this.ledgerId ? {
          short: this.identityInfo.short || null,
          name: this.identityInfo.name || null,
          canExport: !(this.identity && this.identity.kind === 'moderator'),
          canImport: true,
          legacy: true,
        } : null),
    };
  }

  /** downloadText(filename, text) → true when the browser was handed the file (an <a download> click). */
  downloadText(filename, text) {
    try {
      const URLc = this.win.URL || globalThis.URL;
      const BlobC = this.win.Blob || globalThis.Blob;
      const url = URLc.createObjectURL(new BlobC([text], { type: 'application/json' }));
      const a = this.doc.createElement('a');
      a.setAttribute('href', url);
      a.setAttribute('download', filename);
      a.setAttribute('hidden', '');
      const parent = this.doc.body || this.doc.documentElement;
      parent.appendChild(a);
      a.click();
      parent.removeChild(a);
      this.timers.setTimeoutFn(() => { try { URLc.revokeObjectURL(url); } catch (_) { /* gone */ } }, 30000);
      return true;
    } catch (_) {
      return false;
    }
  }

  async openSettings() {
    const model = await this.settingsModel();
    const panel = this.ensurePanel();
    this.hideSettings = panel.openSettings(model, (action, payload) => this.changeSetting(action, payload));
  }

  async refreshSettings() {
    if (!this.panel || !this.panel.settingsOpen) return;
    try {
      this.panel.updateSettings(await this.settingsModel());
    } catch (_) { /* settings are a courtesy */ }
  }

  async changeSetting(action, payload = {}) {
    const cache = await this.mod('cache');
    switch (action) {
      case 'share':
        this.prefs.share = Boolean(payload.on);
        await cache.setPref('uploads', this.prefs.share);
        this.recomputePolicy();
        if (this.tm) this.tm.setUploadsEnabled(this.policy.uploadsEnabled);
        break;
      case 'hostOnly':
        this.prefs.hostOnly = Boolean(payload.on);
        await cache.setPref('hostOnly', this.prefs.hostOnly);
        this.recomputePolicy();
        if (this.tm) this.tm.setHostOnly(this.policy.hostOnly);
        break;
      case 'shareOnNetwork':
        this.prefs.shareOnNetwork = Boolean(payload.on);
        await cache.setPref('shareOnNetwork:' + (this.loc.origin || ''), this.prefs.shareOnNetwork);
        this.recomputePolicy();
        break;
      case 'forget':
        await this.forget();
        return;
      case 'openIdentity':
        // v0.3: the panel's own button (a trusted click) opens the identity page.
        this.api.openIdentityFromCard().catch((err) => { if (this.panel) this.panel.notify(errMsg(err), 'error'); });
        return;
      case 'exportIdentity': {
        // v0.2.1 (A4): reached only from the panel's own button (a trusted click), never from window.mw.
        const note = (text, kind) => { if (this.panel) this.panel.notify(text, kind); };
        try {
          const text = await this.identityApi().export(payload.passphrase);
          const short = (this.identityInfo && this.identityInfo.short) || 'site';
          if (!this.downloadText('identity-' + String(short).replace(/[^a-z0-9._-]+/gi, '_') + '.json', text)) throw new Error('the browser refused the download');
          note(this.strings.settingsIdentityExported, 'ok');
        } catch (err) {
          note(errMsg(err), 'error');
        }
        return;
      }
      case 'importIdentity': {
        const note = (text, kind) => { if (this.panel) this.panel.notify(text, kind); };
        try {
          await this.identityApi().import(payload.text, payload.passphrase);
          note(this.strings.settingsIdentityImported, 'ok'); // identityApi().import reloads the page
        } catch (err) {
          note(errMsg(err), 'error');
        }
        return;
      }
      default:
        return;
    }
    this.refreshSettings();
  }

  async forget() {
    const cache = await this.mod('cache');
    try {
      if (this.tm) this.tm.destroy();
      this.tm = null;
      this.tmPromise = null;
      this.api.setTorrentManager(null);
      let versions = [];
      try {
        versions = (await cache.getPref('versions:' + this.ledgerId, [])) || [];
      } catch (_) {
        versions = [];
      }
      for (const v of new Set(versions.concat(this.btih ? [this.btih] : []))) {
        if (BTIH_RE.test(v)) {
          try {
            await cache.deleteSite(v);
          } catch (_) { /* best effort */ }
        }
      }
      await cache.setPref('versions:' + this.ledgerId, []);
      this.copy = null;
      this.binding.pushState();
      if (this.panel) this.panel.notify(this.strings.settingsForgetDone, 'ok');
      this.refreshSettings();
    } catch (err) {
      if (this.panel) this.panel.notify(errMsg(err), 'error');
    }
  }

  // ------------------------------------------------------------------- v0.3 (R 2.11, 3.8; the SVC contract)

  /**
   * setupV03(): the v0.3 modules of this build (deps.v03, lazily), then the services in the engine tab. A follower
   * tab holds no keys: it shows the engine tab's auth state and drops it on 'signed-out' (E-ID-2b). Without the
   * identity service in the build the 0.2.1 per-site key stays ('legacy').
   */
  async setupV03() {
    if (!this.v03) {
      let mods = null;
      try {
        mods = await this.mod('v03');
      } catch (_) {
        mods = null;
      }
      mods = mods && typeof mods === 'object' ? mods : {};
      // The v0.3 identity in drop-in mode is lane idp's adapter (src/dropin/identity.js createDropinIdentity) over
      // the identity client and the working keys of this build (deps.v03 client and store).
      this.identityMode = mods.client && mods.store ? 'v03' : 'legacy';
      this.v03 = this.identityMode === 'v03'
        ? Object.assign({}, mods, { identity: { createIdentityService: (deps) => this.makeDropinIdentity(deps) } })
        : Object.assign({}, mods, { identity: null });
      if (this.identityMode === 'legacy') this.log('identity: the 0.2.1 per-site key (the identity service is not in this build)');
      if (this.identityMode === 'v03' && typeof mods.store.onSignedOut === 'function' && !this.offSignedOut) {
        try {
          const opts = this.channelFactory() ? { channelFactory: this.channelFactory() } : {};
          this.offSignedOut = mods.store.onSignedOut(() => { if (!this.isLeader || this.node === this.followerNode) this.onSignedOutBroadcast(); }, opts);
        } catch (_) { /* no BroadcastChannel */ }
      }
    }
    if (!this.isLeader) {
      // A tab that ran the site before a back/forward-cache restore may come back as a follower: its services go.
      if (this.servicesMounted) this.unmountServices();
      if (this.identityMode === 'v03') this.api.identity.setRemote({ state: 'guest', info: null });
      return;
    }
    await this.mountLeaderServices();
  }

  /** channelFactory() -> (name) => BroadcastChannel of this page's window (the 'mw-identity' sign-out channel), or null. */
  channelFactory() {
    const C = this.win && this.win.BroadcastChannel;
    return typeof C === 'function' ? (name) => new C(name) : null;
  }

  /** makeDropinIdentity(deps) -> the identity service of this page (mountV03Services calls it with its deps). */
  makeDropinIdentity(deps) {
    const mods = this.v03 || {};
    const di = createDropinIdentity({
      win: this.win,
      channelFactory: this.channelFactory() || undefined,
      cache: deps.cache || null,
      ledgerId: deps.ledgerId,
      pointer: deps.pointer || null,
      // The scope the pointer was verified under (v0.3 reconciliation: the shell passes it too).
      scope: deps.scope,
      node: deps.node,
      cfg: deps.cfg,
      prompt: deps.prompt,
      onKeys: deps.onKeys,
      sharedHub: false,
      writeLegacy: (item) => this.writeLegacyItem(item),
      now: deps.now,
      client: mods.client || undefined,
      Keys: (mods.store && mods.store.WorkingKeys) || undefined,
    });
    this.dropinIdentity = di;
    return di.service;
  }

  /** onIdpReturnPage() -> true on /_mw/idp-return (the worker's minimal page carries <meta name="mw-idp-return">). */
  onIdpReturnPage() {
    try {
      if (this.loc.pathname !== IDP_RETURN_PATH) return false;
      return Boolean(this.doc && typeof this.doc.querySelector === 'function' && this.doc.querySelector('meta[name="mw-idp-return"]'));
    } catch (_) {
      return false;
    }
  }

  /**
   * finishIdpReturn(): stores the identity origin's still-encrypted answer for the tab that asked (lane idp:
   * client.completeRedirect({ defer: true })) and goes back to the page that started the sign-in; that page's engine
   * tab takes the answer at boot. Nothing else runs on this page.
   */
  async finishIdpReturn() {
    let mods = null;
    try {
      mods = await this.mod('v03');
    } catch (_) {
      mods = null;
    }
    try {
      const di = createDropinIdentity({ win: this.win, client: (mods && mods.client) || undefined, Keys: (mods && mods.store && mods.store.WorkingKeys) || undefined });
      const r = await di.completeRedirect();
      this.log(r ? 'sign-in answer kept for the page that asked' : 'no sign-in answer on this page');
      di.destroy();
    } catch (err) {
      this.log('sign-in return: ' + errMsg(err));
    }
    return this.goOff('idp-return', null);
  }

  async mountLeaderServices() {
    if (this.servicesMounted || !this.v03) return;
    this.servicesMounted = true;
    this.api.identity.setRemote(null);
    this.seam = this.seam || createTorrentSeam({ get: () => this.tm, ensure: () => this.ensureTorrentManager(), beforeSwarm: () => this.laneStun() });
    if (typeof this.api.setLaneStunSource === 'function') this.api.setLaneStunSource(() => this.laneStun());
    if (this.tm) this.seam.attach(this.tm);
    let cache = null;
    try {
      cache = await this.mod('cache');
    } catch (_) {
      cache = null;
    }
    const res = await mountV03Services(this.api, {
      modules: this.v03,
      deps: {
        ledgerId: this.ledgerId,
        pointer: readStampedText(this.doc) || null,
        node: () => (this.node && this.node !== this.followerNode ? this.node : null),
        deviceClass: deviceClassOf(this.env),
        chatDevice: chatDeviceClass(this.env, this.nav),
        hostOnly: () => Boolean(this.policy && this.policy.hostOnly),
        ownTracker: this.record ? ownTrackerOf(this.record, this.config.trackers) : null,
        torrents: this.seam,
        swPort: swPortFor(this.nav),
        prefs: cache ? { get: (k, d) => cache.getPref(k, d), set: (k, v) => cache.setPref(k, v) } : null,
        download: (url, name) => this.downloadUrl(url, name),
        shareOnNetwork: this.prefs.shareOnNetwork === true,
        identityExtra: {
          sharedHub: false,
          win: this.win,
          origin: this.loc.origin,
          scope: () => this.scope || null,
          cache,
          onKeys: (keys) => { this.bindKeys(keys).catch((err) => this.log('keys: ' + errMsg(err))); },
        },
      },
    });
    if (res.mounted.length) this.log('v0.3 services: ' + res.mounted.join(', '));
    for (const name of Object.keys(res.errors)) this.log('v0.3 service ' + name + ' not mounted: ' + res.errors[name]);
    const svc = this.api.service('identity');
    // The answer of a redirect sign-in, or the "Stay signed in" keys of this origin, come back once, in the engine
    // tab (lane idp: createDropinIdentity boot(), else the service's restore()).
    const boot = this.dropinIdentity && typeof this.dropinIdentity.boot === 'function'
      ? () => this.dropinIdentity.boot()
      : (svc && typeof svc.restore === 'function' ? () => svc.restore() : null);
    if (boot) {
      try {
        await this.withTimeout(Promise.resolve().then(boot), RESTORE_WAIT_MS, null);
      } catch (err) {
        this.log('restore sign-in: ' + errMsg(err));
      }
    }
    await this.api.identity.refresh().catch(() => {});
  }

  unmountServices() {
    for (const name of ['media', 'files', 'chat', 'identity']) {
      const svc = this.api.unmount(name);
      if (svc && typeof svc.destroy === 'function') {
        try {
          svc.destroy();
        } catch (_) { /* gone */ }
      }
    }
    this.servicesMounted = false;
    this.dropinIdentity = null;
  }

  /**
   * onAuthChange({ state, info }): the working keys moved. The ledger signs with them (or nothing for a guest),
   * follower tabs hear the state, and a sign-out ends playback sessions and tells the other tabs.
   */
  onAuthChange(snap) {
    const signedIn = snap.state === 'signed-in';
    const moderator = this.identity && this.identity.kind === 'moderator';
    if (this.identityMode === 'v03') this.bindKeys(signedIn ? this.api.identity.keys() : null).catch((err) => this.log('keys: ' + errMsg(err)));
    if (!moderator) this.identityInfo = snap.info ? { pub: snap.info.pub, short: snap.info.short, name: snap.info.name, mode: snap.info.mode || null } : null;
    broadcastState(this);
    if (!signedIn) {
      if (this.wasSignedIn && this.isLeader && this.link) this.link.send('signed-out', {});
      this.wasSignedIn = false;
      const media = this.api.service('media');
      if (media && typeof media.signOut === 'function') {
        try {
          media.signOut();
        } catch (_) { /* gone */ }
      }
      this.closeSessions();
    } else {
      this.wasSignedIn = true;
    }
    this.refreshSettings();
  }

  /** onSignedOutBroadcast(): a follower tab drops what it showed of the engine tab's sign-in (E-ID-2b). */
  onSignedOutBroadcast() {
    this.api.identity.setRemote({ state: 'guest', info: null });
    this.identityInfo = null;
    if (this.followerNode) this.followerNode.identity = null;
    this.log('another tab signed out: this tab dropped its signed-in state');
    this.refreshSettings();
  }

  /** legacyIdentity() -> { privateKey, pub } of this ledger's 0.2.1 key, or null (never made here). */
  async legacyIdentity() {
    try {
      const [cache, crypto] = await Promise.all([this.mod('cache'), this.mod('crypto')]);
      const id = await ensureIdentity({ cache, crypto, ledgerId: this.ledgerId, create: false });
      return id && id.privateKey ? { privateKey: id.privateKey, pub: id.pub } : null;
    } catch (_) {
      return null;
    }
  }

  /** writeLegacyItem({ l, v }): one append authored by the 0.2.1 key (the mw.link item). */
  async writeLegacyItem(item) {
    const node = this.node;
    if (!item || typeof item.l !== 'string' || item.v === undefined) throw Object.assign(new Error('not a list item'), { code: 'E_BAD_REQUEST' });
    if (!node || node === this.followerNode || typeof node.ingest !== 'function') throw Object.assign(new Error('the site ledger is not open in this tab'), { code: 'E_POLICY' });
    const legacy = await this.legacyIdentity();
    if (!legacy) throw Object.assign(new Error('no 0.2.1 key on this device'), { code: 'E_IDENTITY' });
    const chain = await this.mod('chain');
    let bits = 0;
    try {
      bits = Math.max(Number(this.config.chain.minBits) || 0, Number(node.state.policy.bits) || 0);
    } catch (_) {
      bits = 0;
    }
    const block = await chain.createBlock({
      identity: legacy, site: this.ledgerId, seq: 1, prev: node.choosePrev(), op: { t: 'append', l: item.l }, value: item.v, ts: this.timers.now(), bits, miner: this.miner || null,
    });
    await node.ingest([block], 'local');
    return { h: block.h };
  }

  /**
   * bindKeys(keys): what the engine tab's ledger signs with: the working keys, nothing for a guest, or the 0.2.1 key
   * on an 'allow' site that lists only it (HON M9, migrate.js legacyAuthorFor). An imported moderator key stays.
   */
  async bindKeys(keys) {
    if (!this.isLeader || !this.node || this.node === this.followerNode) return;
    if (this.identity && this.identity.kind === 'moderator') return;
    // Bound at once (onKeys runs inside the sign-in, before auth.signIn resolves), so the site's first write after
    // the identity window is signed (v0.3 reconciliation: an await before this bind let that write fail E_IDENTITY).
    const id = keys ? nodeIdentityOf(keys) : null;
    setNodeIdentity(this.node, id);
    this.identity = id;
    // "Replace my keys on all sites": the rotation reaches this ledger, written by the new key (MF-20).
    if (keys && keys.rotateNotice) writeRotation(this.node, keys, this.ledgerId).then((b) => { if (b) this.log('the new key took over the old one on this site (rotation written)'); }, () => {});
    const mig = this.v03 && this.v03.migrate;
    if (!keys || !mig || typeof mig.legacyAuthorFor !== 'function') return;
    try {
      const legacy = await this.legacyIdentity();
      if (!legacy) return;
      const st = this.node.state;
      const who = mig.legacyAuthorFor({ policy: st && st.policy, newPub: keys.pub, legacyPub: legacy.pub });
      // Still the same sign-in: the 0.2.1 key signs on this 'allow' site until the owner lists the new key (HON M9).
      if (who === legacy.pub && this.identity === id && this.api.identity.keys() === keys) {
        const legacyId = { privateKey: legacy.privateKey, pub: legacy.pub, kind: 'legacy' };
        setNodeIdentity(this.node, legacyId);
        this.identity = legacyId;
      }
    } catch (_) { /* the working key signs */ }
  }

  /**
   * ownerConfirm(card): an owner action confirmed at the identity origin (R 3.3); never an in-page card. The identity
   * service's ownerAction() (lane idp; wired by the v0.3 reconciliation) opens the identity page with the request.
   */
  async ownerConfirm(card) {
    const svc = this.api.service('identity');
    if (!svc || typeof svc.ownerAction !== 'function') throw Object.assign(new Error('owner actions need the identity page, which this page cannot open'), { code: 'E_UNSUPPORTED' });
    const ok = (await svc.ownerAction(card)) === true;
    await this.api.identity.refresh().catch(() => {});
    return ok;
  }

  /** closeSessions(): media and file sessions end when the page goes away (lane media). */
  closeSessions() {
    for (const name of ['media', 'files']) {
      const svc = this.api.service(name);
      if (svc && svc.sessions && typeof svc.sessions.closeAll === 'function') {
        try {
          svc.sessions.closeAll();
        } catch (_) { /* gone */ }
      }
    }
  }

  /** downloadUrl(url, name) -> true when the browser was handed the file (files.save through /_mw/f/). */
  downloadUrl(url, name) {
    try {
      const a = this.doc.createElement('a');
      a.setAttribute('href', url);
      a.setAttribute('download', name || 'download');
      a.setAttribute('hidden', '');
      const parent = this.doc.body || this.doc.documentElement;
      parent.appendChild(a);
      a.click();
      parent.removeChild(a);
      return true;
    } catch (_) {
      return false;
    }
  }

  // ------------------------------------------------------------------- end

  destroy() {
    if (this.state === 'destroyed') return;
    this.state = 'destroyed';
    this.cleanup();
    this.teardownEngine();
    this.binding.destroy();
    try {
      this.tracker.destroy();
    } catch (_) { /* gone */ }
    if (this.offSignedOut) {
      try {
        this.offSignedOut();
      } catch (_) { /* closed */ }
      this.offSignedOut = null;
    }
    this.api.destroy();
    this.consent.settleWaiters();
    this.resolveEvaluated();
  }
}
