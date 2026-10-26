// Unit tests for src/dropin/swreg.js: the foreign-Service-Worker decision (never register over a
// site's own worker), registration after load with updateViaCache 'none', the bounded wait for
// control, and the { proto: 1, type: 'mw-...' } messages. A fake navigator.serviceWorker with real
// MessageChannels; a manual clock. No browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClock, flush } from './dropin-fake-timers.mjs';
import {
  SW_PATH, isOurScript, foreignRecipe, decideRegistration, inspectServiceWorker, waitForController, setupServiceWorker,
  pingController, mapClient, notifySiteSaved, queryClients, watchWorkerMessages, onControllerChange, requestWorker, HARD_RELOAD_WAIT_MS, CONTROL_WAIT_MS, FOREIGN_CONTROL_WAIT_MS, looksLikeKillSwitch,
  EMPTY_SCOPE_RECHECK_MS,
} from '../../src/dropin/swreg.js';

const ORIGIN = 'https://site.test';
const OURS = ORIGIN + '/mw-sw.js';
const THEIRS = ORIGIN + '/sw.js';
const BTIH = 'ab'.repeat(20);

class FakeWorker {
  constructor(scriptURL, answer = null) {
    this.scriptURL = scriptURL;
    this.state = 'activated';
    this.posted = [];
    this.answer = answer; // (message) => reply | null
  }

  postMessage(message, ports = []) {
    this.posted.push(message);
    const reply = this.answer ? this.answer(message) : null;
    const port = ports[0];
    if (port && typeof port.unref === 'function') port.unref();
    if (port && reply) {
      port.postMessage(reply);
      port.close();
    } else if (port && !reply) {
      setTimeout(() => { try { port.close(); } catch (_) { /* closed */ } }, 0);
    }
  }
}

function fakeNav({ registration = null, controller = null, registerImpl = null } = {}) {
  const listeners = new Map();
  const calls = { register: [], getRegistration: [], unregister: 0 };
  const container = {
    controller,
    getRegistration: async (scope) => { calls.getRegistration.push(scope); return registration; },
    register: async (url, opts) => {
      calls.register.push([url, opts]);
      if (registerImpl) return registerImpl(url, opts, container);
      const reg = registration || { scope: ORIGIN + '/', active: null, waiting: null, installing: new FakeWorker(ORIGIN + url), unregister: async () => { calls.unregister++; } };
      registration = reg;
      return reg;
    },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { const s = listeners.get(type); if (s) s.delete(fn); },
    emit(type, ev = {}) { for (const fn of Array.from(listeners.get(type) || [])) fn(Object.assign({ type }, ev)); },
    listenerCount(type) { return (listeners.get(type) || new Set()).size; },
  };
  return { nav: { serviceWorker: container }, container, calls };
}

function reg(active, extra = {}) {
  return Object.assign({ scope: ORIGIN + '/', active, waiting: null, installing: null, unregister: async () => {} }, extra);
}

test('isOurScript: only this origin\'s /mw-sw.js, query strings allowed', () => {
  assert.equal(SW_PATH, '/mw-sw.js');
  assert.equal(isOurScript(OURS, ORIGIN), true);
  assert.equal(isOurScript(OURS + '?v=2', ORIGIN), true);
  assert.equal(isOurScript('/mw-sw.js', ORIGIN), true);
  assert.equal(isOurScript(THEIRS, ORIGIN), false);
  assert.equal(isOurScript('https://cdn.test/mw-sw.js', ORIGIN), false);
  assert.equal(isOurScript(ORIGIN + '/sub/mw-sw.js', ORIGIN), false);
  assert.equal(isOurScript('', ORIGIN), false);
  assert.equal(isOurScript(null, ORIGIN), false);
});

test('decideRegistration: the whole matrix', () => {
  const d = (o) => decideRegistration(Object.assign({ origin: ORIGIN }, o));
  assert.deepEqual(d({}), { action: 'register', reason: 'none', foreign: false, scriptURL: null, unregister: false });
  assert.equal(d({ workers: [{ state: 'active', scriptURL: OURS }] }).reason, 'ours');
  assert.equal(d({ workers: [{ state: 'active', scriptURL: OURS }] }).action, 'register');
  const foreign = d({ workers: [{ state: 'active', scriptURL: THEIRS }] });
  assert.equal(foreign.action, 'skip');
  assert.equal(foreign.reason, 'foreign');
  assert.equal(foreign.foreign, true);
  assert.equal(foreign.scriptURL, THEIRS);
  assert.equal(d({ workers: [{ state: 'installing', scriptURL: THEIRS }] }).reason, 'foreign', 'a foreign worker that is still installing is just as protected');
  assert.equal(d({ workers: [{ state: 'waiting', scriptURL: THEIRS }, { state: 'active', scriptURL: OURS }] }).reason, 'foreign', 'any foreign worker wins');
  assert.equal(d({ controllerURL: THEIRS }).reason, 'foreign', 'a foreign controller with no registration visible');
  assert.equal(d({ controllerURL: OURS }).reason, 'none');
  assert.deepEqual(d({ supported: false }), { action: 'skip', reason: 'unsupported', foreign: false, scriptURL: null, unregister: false });
  const off = d({ option: 'off', workers: [{ state: 'active', scriptURL: OURS }] });
  assert.equal(off.action, 'skip');
  assert.equal(off.reason, 'off');
  assert.equal(off.unregister, true, 'off removes our own worker');
  assert.equal(d({ option: 'off', workers: [{ state: 'active', scriptURL: THEIRS }] }).unregister, false, 'but never a foreign one');
  assert.equal(d({ option: 'off', supported: false }).reason, 'off');
  assert.equal(d({ workers: [null, {}, { scriptURL: '' }] }).reason, 'none', 'junk entries are ignored');
});

test('foreignRecipe: one line with both halves of the recipe, no em dashes', () => {
  const line = foreignRecipe(THEIRS);
  assert.ok(!/\n/.test(line), 'one console line');
  assert.ok(line.includes(THEIRS));
  assert.ok(line.includes("importScripts('/_mw/sw-core.js')"));
  assert.ok(line.includes('if (self.mw.owns(event)) return event.respondWith(self.mw.handle(event))'));
  assert.ok(!/[–—]/.test(line));
  assert.match(foreignRecipe(), /unknown script/);
});

test('inspectServiceWorker: workers of getRegistration(\'/\'), the controller, and failures', async () => {
  const a = fakeNav({ registration: reg(new FakeWorker(THEIRS), { installing: new FakeWorker(THEIRS) }), controller: new FakeWorker(THEIRS) });
  const seen = await inspectServiceWorker(a.nav);
  assert.deepEqual(a.calls.getRegistration, ['/']);
  assert.equal(seen.supported, true);
  assert.deepEqual(seen.workers.map((w) => w.state), ['active', 'installing']);
  assert.equal(seen.controllerURL, THEIRS);
  assert.deepEqual(await inspectServiceWorker({}), { supported: false, registration: null, workers: [], controllerURL: null });
  const boom = { serviceWorker: { getRegistration: async () => { throw new Error('SecurityError'); }, controller: null } };
  const failed = await inspectServiceWorker(boom);
  assert.equal(failed.supported, true);
  assert.equal(failed.registration, null, 'an unreadable registration list is treated as none');
});

test('waitForController: immediately, on controllerchange, or false after the wait', async () => {
  const clock = createClock();
  const already = fakeNav({ controller: new FakeWorker(OURS) });
  assert.equal(await waitForController(already.container, 100, clock.timers()), true);
  const n = fakeNav();
  const p = waitForController(n.container, 5000, clock.timers());
  assert.equal(n.container.listenerCount('controllerchange'), 1);
  n.container.controller = new FakeWorker(OURS);
  n.container.emit('controllerchange');
  assert.equal(await p, true);
  assert.equal(n.container.listenerCount('controllerchange'), 0, 'listener removed');
  assert.equal(clock.pending(), 0, 'timer cleared');
  const never = fakeNav();
  const q = waitForController(never.container, 5000, clock.timers());
  clock.advance(5000);
  assert.equal(await q, false);
  assert.equal(await waitForController(null, 10), false);
});

test('setupServiceWorker: a fresh visitor registers /mw-sw.js (scope /, updateViaCache none) and waits for the claim', async () => {
  const clock = createClock();
  const { nav, container, calls } = fakeNav();
  const p = setupServiceWorker({ nav, origin: ORIGIN, ...clock.timers() });
  await flush();
  assert.deepEqual(calls.register, [], 'an empty scope is looked at twice before ours registers');
  clock.advance(EMPTY_SCOPE_RECHECK_MS);
  await flush();
  assert.deepEqual(calls.register, [['/mw-sw.js', { scope: '/', updateViaCache: 'none' }]]);
  assert.equal(calls.getRegistration.length, 2);
  container.controller = new FakeWorker(OURS);
  container.emit('controllerchange');
  const state = await p;
  assert.equal(state.mode, 'ours');
  assert.equal(state.controlled, true);
  assert.equal(state.foreign, false);
  assert.ok(state.registration);
});

test('setupServiceWorker: no claim within the wait leaves the page uncontrolled, and a hard reload does not wait long', async () => {
  const clock = createClock();
  const fresh = fakeNav();
  const p = setupServiceWorker({ nav: fresh.nav, origin: ORIGIN, recheckMs: 0, ...clock.timers() });
  await flush();
  clock.advance(CONTROL_WAIT_MS);
  const state = await p;
  assert.equal(state.mode, 'uncontrolled');
  assert.equal(state.reason, 'not-controlled');
  assert.equal(state.controlled, false);

  const hard = fakeNav({ registration: reg(new FakeWorker(OURS)) });
  const q = setupServiceWorker({ nav: hard.nav, origin: ORIGIN, ...clock.timers() });
  await flush();
  clock.advance(HARD_RELOAD_WAIT_MS);
  const hs = await q;
  assert.equal(hs.mode, 'uncontrolled');
  assert.equal(hs.reason, 'hard-reload', 'an active worker that does not control this page: loaded from the host, no claim coming');
  assert.equal(hard.calls.register.length, 1, 'still registered (an update check), updateViaCache none');
});

test('setupServiceWorker: an already controlled page is "ours" at once', async () => {
  const clock = createClock();
  const { nav, calls } = fakeNav({ registration: reg(new FakeWorker(OURS)), controller: new FakeWorker(OURS) });
  const state = await setupServiceWorker({ nav, origin: ORIGIN, ...clock.timers() });
  assert.equal(state.mode, 'ours');
  assert.equal(calls.register.length, 1);
});

test('setupServiceWorker: a foreign worker is never registered over; the recipe is logged once', async () => {
  const clock = createClock();
  const logs = [];
  const log = (key, text) => logs.push([key, text]);
  const { nav, calls } = fakeNav({ registration: reg(new FakeWorker(THEIRS)) });
  const state = await setupServiceWorker({ nav, origin: ORIGIN, log, ...clock.timers() });
  assert.equal(calls.register.length, 0, 'register() was not called');
  assert.equal(state.mode, 'foreign');
  assert.equal(state.foreign, true);
  assert.equal(state.scriptURL, THEIRS);
  assert.equal(state.controlled, false);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], 'foreign');
  assert.ok(logs[0][1].includes('importScripts'));
});

test('setupServiceWorker: a foreign worker that imports sw-core.js answers mw-ping and counts as integrated', async () => {
  const clock = createClock();
  const integrated = new FakeWorker(THEIRS, (m) => (m.type === 'mw-ping' ? { proto: 1, type: 'mw-pong', buildId: 'dev', mode: 'dropin', foreign: true } : null));
  const a = fakeNav({ registration: reg(integrated), controller: integrated });
  const aLogs = [];
  const s1 = await setupServiceWorker({ nav: a.nav, origin: ORIGIN, log: (k, t) => aLogs.push([k, t]), ...clock.timers() });
  assert.equal(s1.mode, 'integrated');
  assert.deepEqual(aLogs, [], 'a site that already did the integration is not told how to do it');
  assert.equal(s1.controlled, true);
  assert.equal(a.calls.register.length, 0);
  assert.deepEqual(integrated.posted, [{ proto: 1, type: 'mw-ping' }]);

  const plain = new FakeWorker(THEIRS);
  const b = fakeNav({ registration: reg(plain), controller: plain });
  const bLogs = [];
  const p = setupServiceWorker({ nav: b.nav, origin: ORIGIN, log: (k, t) => bLogs.push(k), ...clock.timers() });
  await flush();
  assert.deepEqual(bLogs, [], 'the recipe waits for the ping verdict');
  clock.advance(1500);
  const s2 = await p;
  assert.equal(s2.mode, 'foreign', 'a hand-written worker never answers');
  assert.equal(s2.controlled, true);
  assert.deepEqual(bLogs, ['foreign'], 'and is then logged once');
});

test('setupServiceWorker: a foreign worker that is still installing gets a moment to claim the page before it is judged', async () => {
  const clock = createClock();
  const integrated = new FakeWorker(THEIRS, (m) => (m.type === 'mw-ping' ? { proto: 1, type: 'mw-pong', buildId: 'x', mode: 'dropin', foreign: true } : null));
  const installing = fakeNav({ registration: reg(null, { installing: new FakeWorker(THEIRS) }) });
  const p = setupServiceWorker({ nav: installing.nav, origin: ORIGIN, log() {}, ...clock.timers() });
  await flush();
  installing.container.controller = integrated;
  installing.container.emit('controllerchange');
  const s1 = await p;
  assert.equal(s1.mode, 'integrated', 'claimed within the wait, then recognised by its pong');
  assert.equal(installing.calls.register.length, 0);

  const slow = fakeNav({ registration: reg(null, { installing: new FakeWorker(THEIRS) }) });
  const q = setupServiceWorker({ nav: slow.nav, origin: ORIGIN, log() {}, ...clock.timers() });
  await flush();
  clock.advance(FOREIGN_CONTROL_WAIT_MS);
  const s2 = await q;
  assert.equal(s2.mode, 'foreign');
  assert.equal(s2.controlled, false);

  const settled = fakeNav({ registration: reg(new FakeWorker(THEIRS)) });
  const s3 = await setupServiceWorker({ nav: settled.nav, origin: ORIGIN, log() {}, ...clock.timers() });
  assert.equal(s3.mode, 'foreign', 'an active worker that does not control this page is not waited for');
  assert.equal(clock.pending(), 0);
});

test('setupServiceWorker: a refused registration fails open with one message', async () => {
  const clock = createClock();
  const logs = [];
  const { nav } = fakeNav({ registerImpl: async () => { throw new Error('SecurityError: blocked'); } });
  const state = await setupServiceWorker({ nav, origin: ORIGIN, log: (k, t) => logs.push([k, t]), recheckMs: 0, ...clock.timers() });
  assert.equal(state.mode, 'none');
  assert.equal(state.reason, 'register-failed');
  assert.equal(logs.length, 1);
  assert.match(logs[0][1], /SecurityError: blocked/);
});

test('setupServiceWorker: data-mw-sw="off" registers nothing and removes our own worker and caches', async () => {
  const clock = createClock();
  let unregistered = 0;
  const deleted = [];
  const caches = { keys: async () => ['mw-shell-abc', 'site-cache', 'mw-shell-old'], delete: async (n) => { deleted.push(n); return true; } };
  const withOurs = fakeNav({ registration: reg(new FakeWorker(OURS), { unregister: async () => { unregistered++; } }) });
  const s1 = await setupServiceWorker({ nav: withOurs.nav, caches, option: 'off', origin: ORIGIN, ...clock.timers() });
  assert.equal(s1.mode, 'off');
  assert.equal(withOurs.calls.register.length, 0);
  assert.equal(unregistered, 1);
  assert.deepEqual(deleted.sort(), ['mw-shell-abc', 'mw-shell-old'], 'only our caches');

  const withTheirs = fakeNav({ registration: reg(new FakeWorker(THEIRS), { unregister: async () => { unregistered++; } }) });
  const s2 = await setupServiceWorker({ nav: withTheirs.nav, caches, option: 'off', origin: ORIGIN, ...clock.timers() });
  assert.equal(s2.mode, 'off');
  assert.equal(unregistered, 1, 'a foreign worker is left alone');

  const none = fakeNav();
  assert.equal((await setupServiceWorker({ nav: none.nav, option: 'off', origin: ORIGIN, ...clock.timers() })).mode, 'off');
  assert.equal(none.calls.register.length, 0);
});

test('setupServiceWorker: browsers without Service Workers get mode none', async () => {
  const state = await setupServiceWorker({ nav: {}, origin: ORIGIN, ...createClock().timers() });
  assert.equal(state.mode, 'none');
  assert.equal(state.reason, 'unsupported');
});

test('messages: ping, map-client, site-saved, get-clients over a reply port; timeouts and wrong replies give null', async () => {
  const clock = createClock();
  const worker = new FakeWorker(OURS, (m) => {
    switch (m.type) {
      case 'mw-ping': return { proto: 1, type: 'mw-pong', buildId: 'x', mode: 'dropin', foreign: false };
      case 'mw-map-client': return { proto: 1, type: 'mw-ack', of: m.type, ok: true, btih: m.btih, complete: true };
      case 'mw-site-saved': return { proto: 1, type: 'mw-ack', of: m.type, ok: true, btih: m.btih, complete: true };
      case 'mw-get-clients': return { proto: 1, type: 'mw-clients', clients: { [BTIH]: 2 }, current: null };
      default: return null;
    }
  });
  const { nav } = fakeNav({ controller: worker });
  const pong = await pingController(nav);
  assert.equal(pong.type, 'mw-pong');
  const ack = await mapClient(nav, BTIH);
  assert.equal(ack.ok, true);
  assert.equal(ack.complete, true);
  assert.equal((await notifySiteSaved(nav, BTIH)).btih, BTIH);
  assert.deepEqual((await queryClients(nav)).clients, { [BTIH]: 2 });
  assert.deepEqual(worker.posted.map((m) => m.type), ['mw-ping', 'mw-map-client', 'mw-site-saved', 'mw-get-clients']);
  assert.ok(worker.posted.every((m) => m.proto === 1));
  assert.equal(worker.posted[1].btih, BTIH);

  const wrong = new FakeWorker(OURS, () => ({ proto: 1, type: 'mw-ack', ok: true }));
  assert.equal(await pingController({ serviceWorker: { controller: wrong } }), null, 'an ack is not a pong');
  assert.equal(await queryClients({ serviceWorker: { controller: wrong } }), null);

  const mute = new FakeWorker(OURS);
  const p = pingController({ serviceWorker: { controller: mute } }, { timeoutMs: 800, ...clock.timers() });
  await flush();
  clock.advance(800);
  assert.equal(await p, null, 'no answer in time');

  assert.equal(await pingController({ serviceWorker: { controller: null } }), null, 'no worker');
  assert.equal(await mapClient({}, BTIH), null);
  const registration = { active: new FakeWorker(OURS, () => ({ proto: 1, type: 'mw-pong' })) };
  assert.equal((await pingController({ serviceWorker: { controller: null } }, { registration })).type, 'mw-pong', 'the registration\'s active worker when nothing controls the page');
  assert.equal(await requestWorker({ postMessage() { throw new Error('detached'); } }, { type: 'x' }), null, 'a failing post is a null, not an exception');
});

test('watchWorkerMessages: mw-site-invalid with our protocol version only; stop() detaches', () => {
  const { nav, container } = fakeNav();
  const seen = [];
  const stop = watchWorkerMessages(nav, { onInvalid: (d) => seen.push(d) });
  container.emit('message', { data: { proto: 1, type: 'mw-site-invalid', btih: BTIH, reason: 'mismatch', path: 'css/app.css' } });
  container.emit('message', { data: { proto: 2, type: 'mw-site-invalid', btih: BTIH } });
  container.emit('message', { data: { proto: 1, type: 'mw-pong' } });
  container.emit('message', { data: 'junk' });
  container.emit('message', {});
  assert.equal(seen.length, 1);
  assert.equal(seen[0].reason, 'mismatch');
  stop();
  assert.equal(container.listenerCount('message'), 0);
  container.emit('message', { data: { proto: 1, type: 'mw-site-invalid', btih: BTIH } });
  assert.equal(seen.length, 1);
  const throwing = watchWorkerMessages(nav, { onInvalid() { throw new Error('page bug'); } });
  assert.doesNotThrow(() => container.emit('message', { data: { proto: 1, type: 'mw-site-invalid', btih: BTIH } }));
  throwing();
  assert.equal(typeof watchWorkerMessages({}, {}), 'function');
});

test('watchWorkerMessages: mw-reload (the kill switch) calls onReload with our protocol version only', () => {
  const { nav, container } = fakeNav();
  const seen = [];
  const stop = watchWorkerMessages(nav, { onReload: (d) => seen.push(d.type) });
  container.emit('message', { data: { proto: 1, type: 'mw-reload' } });
  container.emit('message', { data: { proto: 2, type: 'mw-reload' } });
  container.emit('message', { data: { type: 'mw-reload' } });
  assert.deepEqual(seen, ['mw-reload']);
  stop();
  container.emit('message', { data: { proto: 1, type: 'mw-reload' } });
  assert.equal(seen.length, 1);
  const throwing = watchWorkerMessages(nav, { onReload() { throw new Error('page bug'); } });
  assert.doesNotThrow(() => container.emit('message', { data: { proto: 1, type: 'mw-reload' } }));
  throwing();
  // no onReload handler: the message is simply ignored
  const quiet = watchWorkerMessages(nav, { onInvalid() { throw new Error('not for this message'); } });
  assert.doesNotThrow(() => container.emit('message', { data: { proto: 1, type: 'mw-reload' } }));
  quiet();
});

test('onControllerChange: calls back on every controllerchange until stopped', () => {
  const { nav, container } = fakeNav();
  let n = 0;
  const stop = onControllerChange(nav, () => { n++; });
  container.emit('controllerchange');
  container.emit('controllerchange');
  assert.equal(n, 2);
  stop();
  container.emit('controllerchange');
  assert.equal(n, 2);
  assert.equal(typeof onControllerChange({}, () => {}), 'function');
});

test('looksLikeKillSwitch: the self-unregistering worker, minified or not, and nothing else', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../src/sw/kill-switch.js', import.meta.url), 'utf8');
  assert.equal(looksLikeKillSwitch(source), true, 'the real source file');
  const minified = '/* felinar 0.2.0 */(()=>{self.addEventListener("install",()=>{self.skipWaiting()});self.addEventListener("activate",i=>{i.waitUntil((async()=>{try{await self.registration.unregister()}catch{}})())});})();';
  assert.equal(looksLikeKillSwitch(minified), true);
  const real = 'self.addEventListener("install",()=>{});self.addEventListener("fetch",e=>{});self.registration.unregister()';
  assert.equal(looksLikeKillSwitch(real), false, 'a worker with a fetch handler is not the kill switch');
  assert.equal(looksLikeKillSwitch("self.addEventListener('fetch', () => {}); self.registration.unregister()"), false);
  assert.equal(looksLikeKillSwitch('self.addEventListener("install",()=>{})'), false, 'it must unregister');
  assert.equal(looksLikeKillSwitch('x'.repeat(30000) + 'self.registration.unregister()'), false, 'a big script is not the 600-byte kill switch');
  for (const v of [null, undefined, '', 5, {}]) assert.equal(looksLikeKillSwitch(v), false);
});

test('setupServiceWorker: a precheck can refuse registration (the kill switch), and a failing precheck does not', async () => {
  const clock = createClock();
  const logs = [];
  const refused = fakeNav();
  const s1 = await setupServiceWorker({ nav: refused.nav, origin: ORIGIN, log: (k, t) => logs.push([k, t]), precheck: async () => ({ ok: false, reason: 'kill-switch', message: 'it is the kill switch' }), recheckMs: 0, ...clock.timers() });
  assert.equal(refused.calls.register.length, 0, 'never registered');
  assert.equal(s1.mode, 'none');
  assert.equal(s1.reason, 'kill-switch');
  assert.deepEqual(logs, [['kill-switch', 'it is the kill switch']]);

  const throwing = fakeNav();
  const p = setupServiceWorker({ nav: throwing.nav, origin: ORIGIN, precheck: async () => { throw new Error('storage'); }, recheckMs: 0, ...clock.timers() });
  await flush();
  assert.equal(throwing.calls.register.length, 1, 'a precheck that fails does not stop a normal registration');
  throwing.container.controller = new FakeWorker(OURS);
  throwing.container.emit('controllerchange');
  assert.equal((await p).mode, 'ours');

  const allowed = fakeNav({ registration: reg(new FakeWorker(OURS)), controller: new FakeWorker(OURS) });
  let asked = 0;
  const s3 = await setupServiceWorker({ nav: allowed.nav, origin: ORIGIN, precheck: async () => { asked++; return { ok: false, reason: 'x' }; }, ...clock.timers() });
  assert.equal(asked, 0, 'only asked when there is no registration at all');
  assert.equal(s3.mode, 'ours');
});

// integration-2: found by the end-to-end run (scenario 10, the integrated variant): the site's own
// register('/sw.js') was not yet visible when the engine looked, ours registered for the same scope
// and replaced the site's worker.
test('setupServiceWorker: an empty scope is checked again before ours registers, so a site worker registering right now is not replaced', async () => {
  const clock = createClock();
  const logs = [];
  const late = fakeNav();
  let current = null;
  late.container.getRegistration = async (scope) => { late.calls.getRegistration.push(scope); return current; };
  const p = setupServiceWorker({ nav: late.nav, origin: ORIGIN, log: (k) => logs.push(k), ...clock.timers() });
  await flush();
  assert.equal(late.calls.register.length, 0, 'nothing registered after the first look');
  current = reg(null, { installing: new FakeWorker(THEIRS) }); // the site's registration becomes visible
  clock.advance(EMPTY_SCOPE_RECHECK_MS);
  await flush();
  clock.advance(FOREIGN_CONTROL_WAIT_MS);
  const s = await p;
  assert.equal(late.calls.register.length, 0, '/mw-sw.js was never registered over the site worker');
  assert.equal(s.mode, 'foreign');
  assert.equal(s.scriptURL, THEIRS);
  assert.deepEqual(logs, ['foreign']);
  assert.equal(EMPTY_SCOPE_RECHECK_MS, 1000);
});

test('code review round 1: the recipe names the module-worker form, and sw-core.js attaches when imported as a module', async () => {
  const line = foreignRecipe(THEIRS);
  assert.ok(line.includes("import '/_mw/sw-core.js'"), 'module workers cannot call importScripts()');
  // The built classic script, evaluated as an ES module (strict mode, module scope) in a worker-like
  // scope, installs self.mw with owns() and handle().
  const { build } = await import('../../build.mjs');
  const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const dir = mkdtempSync(join(tmpdir(), 'mw-swcore-mod-'));
  try {
    await build({ outDir: join(dir, 'dist'), quiet: true });
    const file = join(dir, 'sw-core.mjs');
    writeFileSync(file, readFileSync(join(dir, 'dist', '_mw', 'sw-core.js')));
    class Scope {}
    const fake = Object.create(Scope.prototype);
    Object.assign(fake, { ServiceWorkerGlobalScope: Scope, addEventListener() {}, registration: { scope: 'https://site.test/' }, location: new URL('https://site.test/sw.js') });
    const before = globalThis.self;
    globalThis.self = fake;
    try {
      await import(pathToFileURL(file).href);
    } finally {
      if (before === undefined) delete globalThis.self;
      else globalThis.self = before;
    }
    assert.equal(typeof fake.mw, 'object');
    assert.equal(typeof fake.mw.owns, 'function');
    assert.equal(typeof fake.mw.handle, 'function');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
