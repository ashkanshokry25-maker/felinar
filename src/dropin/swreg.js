// src/dropin/swreg.js: the drop-in side of the Service Worker (ARCHITECTURE §3.4.2 to §3.4.4,
// DESIGN-REVIEW item 23). One registration controls a scope, and register() on the same scope
// replaces its script, so /_mw/mw.js must never register /mw-sw.js over a site's own worker:
//
//   decideRegistration(input)       pure: 'register' | 'skip' (off, unsupported, foreign)
//   foreignRecipe(scriptURL)        the one console line that explains how a site's worker opts in
//   setupServiceWorker(opts)        inspect getRegistration('/'), register after load when allowed,
//                                   wait (bounded) for control, report the mode
//   pingController / mapClient / queryClients / notifySiteSaved / watchWorkerMessages
//                                   the { proto: 1, type: 'mw-...' } messages of src/sw/core.js
//
// Page-side modes: 'ours' (our /mw-sw.js controls this page), 'integrated' (the site's worker
// imports /_mw/sw-core.js and answers mw-ping: it can serve files and the web seed), 'foreign' (a
// worker we must not touch and that is not integrated), 'off' (data-mw-sw="off"), 'uncontrolled'
// (ours is registered but this page was loaded without it: first view, hard reload), 'none' (no
// Service Worker support, or registration refused).

import { PROTO, MSG, KEEPALIVE_MS, createKeepAlive, message as protocolMessage } from '../sw/protocol.js';

// v0.2.1 D1: the protocol version and the message types come from src/sw/protocol.js.
export { PROTO };
export const SW_PATH = '/mw-sw.js';
export const SW_SCOPE = '/';
export const CONTROL_WAIT_MS = 10000;
export const PING_MS = 1500;
export const HARD_RELOAD_WAIT_MS = 1500;
export const FOREIGN_CONTROL_WAIT_MS = 3000;
// An empty scope is checked twice, this far apart, before /mw-sw.js is registered into it: a site
// that called register('/sw.js') moments ago may not have a visible registration yet, and
// registering ours for the same scope would replace its worker (ARCHITECTURE 3.4.4).
export const EMPTY_SCOPE_RECHECK_MS = 1000;
const CACHE_PREFIX = 'mw-shell-';

function realTimers() {
  return { setTimeoutFn: (fn, ms) => setTimeout(fn, ms), clearTimeoutFn: (id) => clearTimeout(id), now: () => Date.now() };
}

function timersFrom(opts) {
  const real = realTimers();
  return {
    setTimeoutFn: opts && typeof opts.setTimeoutFn === 'function' ? opts.setTimeoutFn : real.setTimeoutFn,
    clearTimeoutFn: opts && typeof opts.clearTimeoutFn === 'function' ? opts.clearTimeoutFn : real.clearTimeoutFn,
    now: opts && typeof opts.now === 'function' ? opts.now : real.now,
  };
}

/** True when `scriptURL` is this origin's /mw-sw.js (a query string does not make it foreign). */
export function isOurScript(scriptURL, origin) {
  if (typeof scriptURL !== 'string' || !scriptURL) return false;
  try {
    const u = new URL(scriptURL, origin || undefined);
    return u.pathname === SW_PATH && (!origin || u.origin === origin);
  } catch (_) {
    return false;
  }
}

/**
 * looksLikeKillSwitch(text) → true for the text of the self-unregistering worker (src/sw/kill-switch.js,
 * dist/mw-sw-kill.js): it unregisters its own registration and has no fetch handler, and it is tiny.
 * Deployed as /mw-sw.js it reloads every open page; a page that still loads /_mw/mw.js must not
 * register it again, or the visitor is stuck in a reload loop.
 */
export function looksLikeKillSwitch(text) {
  const s = typeof text === 'string' ? text : '';
  if (!s || s.length > 20000) return false;
  return /registration\s*\.\s*unregister\s*\(/.test(s) && !/addEventListener\(\s*["'`]fetch["'`]/.test(s);
}

/** The single console line a site gets when it has its own worker (ARCHITECTURE §3.4.4). */
export function foreignRecipe(scriptURL) {
  return 'felinar: this page has its own Service Worker (' + (scriptURL || 'unknown script') + '), so /mw-sw.js was not registered over it. ' +
    "To let that worker serve files from this device, add importScripts('/_mw/sw-core.js') as the first line of the worker " +
    "(a module worker: import '/_mw/sw-core.js' as its first statement) and " +
    'if (self.mw.owns(event)) return event.respondWith(self.mw.handle(event)) at the top of its fetch handler. ' +
    'Until then the ledger and sharing still run and the host serves every file.';
}

/**
 * decideRegistration({ option, supported, workers, controllerURL, origin })
 *   → { action: 'register'|'skip', reason, foreign, scriptURL, unregister }
 * workers: [{ state, scriptURL }] of getRegistration('/') (installing, waiting and active).
 * reasons: 'off', 'unsupported', 'foreign', 'ours', 'none'. A worker that is not /mw-sw.js, in any
 * state, or a controller that is not /mw-sw.js, makes the page foreign: replacing a script that is
 * still installing would clobber it just as much as replacing an active one.
 */
export function decideRegistration({ option = 'auto', supported = true, workers = [], controllerURL = null, origin = null } = {}) {
  const list = Array.isArray(workers) ? workers.filter((w) => w && typeof w.scriptURL === 'string' && w.scriptURL) : [];
  const ours = list.filter((w) => isOurScript(w.scriptURL, origin));
  if (option === 'off') {
    return { action: 'skip', reason: 'off', foreign: false, scriptURL: null, unregister: ours.length > 0 };
  }
  if (!supported) return { action: 'skip', reason: 'unsupported', foreign: false, scriptURL: null, unregister: false };
  const foreign = list.find((w) => !isOurScript(w.scriptURL, origin));
  if (foreign) return { action: 'skip', reason: 'foreign', foreign: true, scriptURL: foreign.scriptURL, unregister: false };
  if (controllerURL && !isOurScript(controllerURL, origin)) {
    return { action: 'skip', reason: 'foreign', foreign: true, scriptURL: controllerURL, unregister: false };
  }
  return { action: 'register', reason: ours.length ? 'ours' : 'none', foreign: false, scriptURL: null, unregister: false };
}

function workersOf(registration) {
  const out = [];
  if (!registration) return out;
  for (const key of ['active', 'waiting', 'installing']) {
    const w = registration[key];
    if (w && typeof w.scriptURL === 'string') out.push({ state: key, scriptURL: w.scriptURL });
  }
  return out;
}

/** inspectServiceWorker(nav) → { supported, registration, workers, controllerURL } (never throws). */
export async function inspectServiceWorker(nav) {
  const sw = nav && nav.serviceWorker;
  if (!sw) return { supported: false, registration: null, workers: [], controllerURL: null };
  let registration = null;
  try {
    registration = (await sw.getRegistration(SW_SCOPE)) || null;
  } catch (_) {
    registration = null;
  }
  const controller = sw.controller;
  return {
    supported: true,
    registration,
    workers: workersOf(registration),
    controllerURL: controller && typeof controller.scriptURL === 'string' ? controller.scriptURL : null,
  };
}

/** waitForController(sw, ms, timers) → Promise<boolean>: controlled now, or after controllerchange within ms. */
export function waitForController(sw, ms, timers) {
  if (!sw) return Promise.resolve(false);
  if (sw.controller) return Promise.resolve(true);
  const t = timersFrom(timers);
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const onChange = () => finish(Boolean(sw.controller));
    function finish(value) {
      if (done) return;
      done = true;
      if (timer !== null) t.clearTimeoutFn(timer);
      try {
        sw.removeEventListener('controllerchange', onChange);
      } catch (_) { /* gone */ }
      resolve(value);
    }
    sw.addEventListener('controllerchange', onChange);
    timer = t.setTimeoutFn(() => finish(Boolean(sw.controller)), ms);
  });
}

function target(nav, registration) {
  const sw = nav && nav.serviceWorker;
  return (sw && sw.controller) || (registration && registration.active) || null;
}

/**
 * request(worker, message, { proto, timeoutMs, timers, MessageChannelCtor }) → Promise<reply | null>.
 * Posts { proto, ...message } with a reply port; null on timeout, no worker or a failed post.
 */
export function requestWorker(worker, message, { proto = PROTO, timeoutMs = PING_MS, MessageChannelCtor = (typeof MessageChannel === 'function' ? MessageChannel : null), ...timers } = {}) {
  if (!worker || typeof worker.postMessage !== 'function') return Promise.resolve(null);
  const t = timersFrom(timers);
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    let channel = null;
    const finish = (value) => {
      if (done) return;
      done = true;
      if (timer !== null) t.clearTimeoutFn(timer);
      try {
        if (channel) {
          channel.port1.onmessage = null;
          channel.port1.close();
        }
      } catch (_) { /* closed */ }
      resolve(value);
    };
    try {
      channel = MessageChannelCtor ? new MessageChannelCtor() : null;
      if (channel) channel.port1.onmessage = (ev) => finish(ev && ev.data ? ev.data : null);
      worker.postMessage(Object.assign({ proto }, message), channel ? [channel.port2] : []);
    } catch (_) {
      finish(null);
      return;
    }
    if (!channel) {
      finish(null);
      return;
    }
    timer = t.setTimeoutFn(() => finish(null), timeoutMs);
  });
}

/** pingController → the worker's mw-pong ({ proto, buildId, mode, foreign }) or null (not ours, not integrated). */
export async function pingController(nav, opts = {}) {
  const worker = target(nav, opts.registration);
  const reply = await requestWorker(worker, { type: 'mw-ping' }, opts);
  return reply && reply.type === 'mw-pong' ? reply : null;
}

/**
 * mapClient → the worker's mw-ack for { type: 'mw-map-client', btih } or null. Idempotent on the worker side.
 * v0.2.1 D4: the ack carries doc: { noStore } (what the worker saw of this page's navigation) or null.
 */
export async function mapClient(nav, btih, opts = {}) {
  const worker = target(nav, opts.registration);
  const reply = await requestWorker(worker, { type: 'mw-map-client', btih }, opts);
  return reply && reply.type === 'mw-ack' ? reply : null;
}

/**
 * keepAlive(nav, opts) → a src/sw/protocol.js createKeepAlive() that posts mw-keepalive to the
 * controlling worker (v0.2.1 D1: while the page depends on the worker, such as a download through the
 * /_mw/ws/ rewrite, Firefox would otherwise stop an idle worker after about 60 s).
 */
export function keepAlive(nav, opts = {}) {
  return createKeepAlive({
    post: () => {
      const worker = nav && nav.serviceWorker && nav.serviceWorker.controller;
      if (worker && typeof worker.postMessage === 'function') worker.postMessage(protocolMessage(MSG.keepalive));
    },
    intervalMs: opts.intervalMs || KEEPALIVE_MS,
    setIntervalFn: opts.setIntervalFn || ((fn, ms) => setInterval(fn, ms)),
    clearIntervalFn: opts.clearIntervalFn || ((id) => clearInterval(id)),
  });
}

/** notifySiteSaved: the page stored a complete copy; the worker re-reads it. */
export async function notifySiteSaved(nav, btih, opts = {}) {
  const worker = target(nav, opts.registration);
  const reply = await requestWorker(worker, { type: 'mw-site-saved', btih }, opts);
  return reply && reply.type === 'mw-ack' ? reply : null;
}

/** queryClients → { clients: { btih: liveCount }, current } or null (no worker that answers). */
export async function queryClients(nav, opts = {}) {
  const worker = target(nav, opts.registration);
  const reply = await requestWorker(worker, { type: 'mw-get-clients' }, opts);
  return reply && reply.type === 'mw-clients' && reply.clients && typeof reply.clients === 'object' ? reply : null;
}

/**
 * watchWorkerMessages(nav, { proto, onInvalid, onReload }) → stop(). The worker pushes
 * { proto, type: 'mw-site-invalid', btih, reason, path } when cached files fail verification.
 */
export function watchWorkerMessages(nav, { proto = PROTO, onInvalid, onReload } = {}) {
  const sw = nav && nav.serviceWorker;
  if (!sw || typeof sw.addEventListener !== 'function') return () => {};
  const handler = (ev) => {
    const d = ev && ev.data;
    if (!d || typeof d !== 'object' || d.proto !== proto || typeof d.type !== 'string') return;
    if (d.type === 'mw-site-invalid' && typeof onInvalid === 'function') {
      try {
        onInvalid(d);
      } catch (_) { /* page code must not break the listener */ }
    } else if (d.type === 'mw-reload' && typeof onReload === 'function') {
      // The kill switch (src/sw/kill-switch.js) asks a page to reload when WindowClient.navigate is missing.
      try {
        onReload(d);
      } catch (_) { /* page code must not break the listener */ }
    }
  };
  sw.addEventListener('message', handler);
  return () => sw.removeEventListener('message', handler);
}

/** onControllerChange(nav, fn) → stop(). */
export function onControllerChange(nav, fn) {
  const sw = nav && nav.serviceWorker;
  if (!sw || typeof sw.addEventListener !== 'function') return () => {};
  sw.addEventListener('controllerchange', fn);
  return () => sw.removeEventListener('controllerchange', fn);
}

async function dropOurCaches(caches) {
  if (!caches || typeof caches.keys !== 'function') return;
  try {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n.indexOf(CACHE_PREFIX) === 0).map((n) => caches.delete(n)));
  } catch (_) { /* best effort */ }
}

/**
 * setupServiceWorker({ nav, caches, option, origin, log, controlWaitMs, proto, ...timers })
 *   → Promise<{ mode, reason, controlled, registration, scriptURL, foreign }>
 * Call it after the window `load` event (3.4.2). Never throws and never forces a reload.
 */
export async function setupServiceWorker({
  nav, caches = null, option = 'auto', origin = null, log = null, controlWaitMs = CONTROL_WAIT_MS, proto = PROTO,
  precheck = null, recheckMs = EMPTY_SCOPE_RECHECK_MS, ...timers
} = {}) {
  const say = typeof log === 'function' ? log : () => {};
  const state = { mode: 'none', reason: null, controlled: false, registration: null, scriptURL: null, foreign: false };
  let seen = await inspectServiceWorker(nav);
  let decision = decideRegistration({ option, supported: seen.supported, workers: seen.workers, controllerURL: seen.controllerURL, origin });
  if (decision.action === 'register' && decision.reason === 'none' && recheckMs > 0) {
    const t = timersFrom(timers);
    await new Promise((resolve) => t.setTimeoutFn(resolve, recheckMs));
    seen = await inspectServiceWorker(nav);
    decision = decideRegistration({ option, supported: seen.supported, workers: seen.workers, controllerURL: seen.controllerURL, origin });
  }
  state.reason = decision.reason;
  state.registration = seen.registration;

  if (decision.action === 'skip') {
    if (decision.reason === 'off') {
      state.mode = 'off';
      if (decision.unregister && seen.registration) {
        try {
          await seen.registration.unregister();
        } catch (_) { /* leave it */ }
        await dropOurCaches(caches);
      }
      return state;
    }
    if (decision.reason === 'unsupported') return state;
    // A site's own worker: never touched. If it opted in (importScripts of sw-core.js) it answers mw-ping.
    state.foreign = true;
    state.scriptURL = decision.scriptURL;
    state.controlled = Boolean(nav.serviceWorker.controller);
    state.mode = 'foreign';
    // The site's worker may still be installing on this very first view: give it a moment to claim
    // the page, so an integrated worker (it imports /_mw/sw-core.js) is recognised right away.
    if (!state.controlled && seen.workers.some((w) => w.state === 'installing' || w.state === 'waiting')) {
      state.controlled = await waitForController(nav.serviceWorker, Math.min(controlWaitMs, FOREIGN_CONTROL_WAIT_MS), timers);
    }
    if (state.controlled) {
      const pong = await pingController(nav, Object.assign({ proto, registration: seen.registration }, timers));
      if (pong) state.mode = 'integrated';
    }
    // The recipe is for sites that have not done the integration; one that has is not told to do it.
    if (state.mode !== 'integrated') say('foreign', foreignRecipe(decision.scriptURL));
    return state;
  }

  // No registration at all: the caller may know why (a kill switch that unregistered us), and say no.
  if (decision.reason === 'none' && typeof precheck === 'function') {
    let gate = null;
    try {
      gate = await precheck();
    } catch (_) {
      gate = null;
    }
    if (gate && gate.ok === false) {
      state.reason = gate.reason || 'blocked';
      if (gate.message) say(state.reason, gate.message);
      return state;
    }
  }

  let registration;
  try {
    registration = await nav.serviceWorker.register(SW_PATH, { scope: SW_SCOPE, updateViaCache: 'none' });
  } catch (err) {
    state.reason = 'register-failed';
    say('register-failed', 'felinar: the Service Worker could not be registered (' + ((err && err.message) || String(err)) + '). The host serves every file.');
    return state;
  }
  state.registration = registration;
  // A worker that was already active and still does not control this page means a hard reload (or
  // a page opened before it activated): no claim is coming, so do not wait for one. A fresh
  // install activates and claims within a moment (clients.claim() in activate).
  const hadActive = Boolean(seen.registration && seen.registration.active);
  state.controlled = await waitForController(nav.serviceWorker, hadActive ? Math.min(controlWaitMs, HARD_RELOAD_WAIT_MS) : controlWaitMs, timers);
  state.mode = state.controlled ? 'ours' : 'uncontrolled';
  if (!state.controlled) state.reason = hadActive ? 'hard-reload' : 'not-controlled';
  return state;
}
