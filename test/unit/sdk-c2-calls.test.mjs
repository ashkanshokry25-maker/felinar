// Unit tests for mw.calls (v0.3 C2, lane wire-ui; research/v03/SEEDING-AND-ZERO-SETUP-DESIGN.md 3.5 "SDK"): the method
// tables of src/loader/api.js, gating at the SDK boundary over the real Bridge and SDK facade (a click for start, accept
// and screen; host-only before any service; the site's activation flags ignored), drop-in mode answering E_UNSUPPORTED,
// the six call error codes passing through, no MediaStream in any result or event, features.calls, the 'calls' push,
// the static stub, the fallback cards, and mountV03Services mounting the calls service after chat with its deps. The
// calls service (lane calls) is a recorder at the SVC contract boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MwApi, API_METHODS, READ_METHODS, WRITE_METHODS, UI_METHODS, HOST_ONLY_METHODS, METHOD_ARGS, PUSH_EVENTS, NAMESPACE_SERVICE,
  SERVICE_EVENTS, ERROR_CODES, ERROR_STRING_KEYS, C2_CALL_METHODS, CALL_EVENTS, CALL_CARD_KINDS, classOf, featuresOf, plainOnly,
  mountV03Services, cardFor, promptAdapter, callName, callNames
} from '../../src/loader/api.js';
import { Bridge, portSafe } from '../../src/loader/bridge.js';
import * as sdk from '../../src/sdk/sdk.js';
import staticMw from '../../src/sdk/sdk-static.js';
import { createBinding } from '../../src/dropin/binding.js';
import { C2_ERROR_CODES, ERROR_TEXT, callText } from '../../src/loader/strings.js';

const PUB = 'p256:B' + 'A'.repeat(86);
const PUB2 = 'p256:B' + 'Q'.repeat(86);
const CALL_ID = 'c'.repeat(22);

/** A MediaStream-like object: an instance of a class of its own, as a browser's stream is. */
class FakeStream { constructor() { this.id = 'stream-1'; this.active = true; } getTracks() { return []; } }

/** The calls service as the SVC contract describes it: every method records its params and context. */
function callsRecorder(impl = {}) {
  const calls = [];
  const listeners = new Map();
  const methods = {};
  for (const m of C2_CALL_METHODS) {
    methods[m] = async (params, ctx) => {
      calls.push({ method: m, params, ctx });
      if (impl[m]) return impl[m](params, ctx);
      return { id: CALL_ID, state: 'ringing', method: m };
    };
  }
  return {
    methods,
    calls,
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev).add(fn);
      return () => listeners.get(ev).delete(fn);
    },
    emit(ev, data) { for (const fn of Array.from(listeners.get(ev) || [])) fn(data); },
    ran(method) { return calls.filter((c) => c.method === method); },
    destroy() {},
  };
}

function page({ activation = () => false, hostOnly = false, mode = 'shell', impl = {}, cfg = { calls: 'contacts', chat: 'members' } } = {}) {
  const api = new MwApi({ activation, hostOnly: () => hostOnly, mod: false, cfg: () => cfg, info: { siteId: 'mw1:' + 'a'.repeat(27), btih: 'f'.repeat(40), mode } });
  api.setNode(null, { failed: true }); // no ledger here: ready() answers at once
  const svc = callsRecorder(impl);
  api.mount('calls', svc);
  return { api, svc };
}

/** A shell page: the real Bridge in the parent window, the SDK facade in the site frame (as sdk-v03-tables does). */
async function shellSdk(api) {
  const ORIGIN = 'https://x.test';
  const listeners = new Set();
  const frameWin = { location: { origin: ORIGIN } };
  const parentWin = {
    location: { origin: ORIGIN },
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(type, fn) { listeners.delete(fn); },
    postMessage(data, targetOrigin, transfer) {
      const ev = { source: frameWin, origin: ORIGIN, data, ports: transfer || [] };
      for (const fn of Array.from(listeners)) fn(ev);
    },
  };
  frameWin.parent = parentWin;
  const bridge = new Bridge({ iframe: { contentWindow: frameWin }, api, win: parentWin, origin: ORIGIN });
  bridge.attach();
  const timers = { setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; }, clearTimeout: (t) => clearTimeout(t) };
  const mw = sdk.createSdk(Object.assign({ win: frameWin, doc: null, global: {} }, timers));
  await mw.ready();
  return { mw, bridge };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

async function codeOf(p) {
  try { await p; return 'resolved'; } catch (err) { return err && err.code; }
}

test('the method tables: start, accept and screen are UI; decline, hangup, mute, camera write; state and list read', () => {
  assert.deepEqual(C2_CALL_METHODS, ['calls.start', 'calls.accept', 'calls.decline', 'calls.hangup', 'calls.mute', 'calls.camera', 'calls.screen', 'calls.state', 'calls.list']);
  for (const m of ['calls.start', 'calls.accept', 'calls.screen']) assert.equal(classOf(m), 'ui', m);
  for (const m of ['calls.decline', 'calls.hangup', 'calls.mute', 'calls.camera']) assert.equal(classOf(m), 'write', m);
  for (const m of ['calls.state', 'calls.list']) assert.equal(classOf(m), 'read', m);
  for (const m of C2_CALL_METHODS) {
    assert.ok(API_METHODS.indexOf(m) >= 0, m);
    assert.ok(Array.isArray(METHOD_ARGS[m]), m + ' has argument names');
  }
  const all = READ_METHODS.concat(WRITE_METHODS, UI_METHODS);
  assert.equal(new Set(all).size, all.length, 'no method in two classes');
  assert.deepEqual(METHOD_ARGS['calls.start'], ['...']);
  assert.deepEqual(METHOD_ARGS['calls.accept'], ['id', '...']);
  assert.deepEqual(METHOD_ARGS['calls.mute'], ['id', 'on']);
  // Host-only refuses what rings, answers or sends to the people of a call; hanging up, muting and the reads keep working.
  for (const m of ['calls.start', 'calls.accept', 'calls.decline', 'calls.camera', 'calls.screen']) assert.ok(HOST_ONLY_METHODS.indexOf(m) >= 0, m);
  for (const m of ['calls.hangup', 'calls.mute', 'calls.state', 'calls.list']) assert.equal(HOST_ONLY_METHODS.indexOf(m), -1, m);
  assert.ok(PUSH_EVENTS.indexOf('calls') >= 0);
  assert.equal(NAMESPACE_SERVICE.calls, 'calls');
  assert.deepEqual(SERVICE_EVENTS.calls, { push: 'calls', events: ['ring', 'state', 'peer', 'ended'] });
  assert.deepEqual(CALL_EVENTS, ['ring', 'state', 'peer', 'ended']);
});

test('error codes: the six call codes follow the R 2.11.2 list, the SDK has the same list, each has its own sentence', () => {
  assert.deepEqual(C2_ERROR_CODES, ['E_BUSY', 'E_DECLINED', 'E_NO_ANSWER', 'E_MEDIA_DENIED', 'E_NO_DEVICE', 'E_CALL_FAILED']);
  assert.deepEqual(ERROR_CODES.slice(-6), C2_ERROR_CODES, 'appended after the 29 codes of R 2.11.2');
  assert.equal(ERROR_CODES[ERROR_CODES.length - 7], 'E_REVOKED');
  assert.deepEqual(sdk.ERROR_CODES, ERROR_CODES, 'the SDK lists the same codes in the same order');
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length);
  for (const code of C2_ERROR_CODES) {
    assert.equal(ERROR_STRING_KEYS[code], code, code + ' has its own sentence');
    assert.ok(ERROR_TEXT.en[code] && ERROR_TEXT.fr[code], code + ' in English and French');
  }
});

test('a call method needs a click (start, accept, screen) and reaches no service without one; flags prove nothing', async () => {
  const { api, svc } = page();
  for (const m of ['calls.start', 'calls.accept', 'calls.screen']) {
    const res = await api.request(m, { id: CALL_ID, to: PUB, activation: true, isTrusted: true, userGesture: true });
    assert.equal(res.ok, false, m);
    assert.equal(res.error.code, 'E_NEEDS_GESTURE', m);
    assert.equal(res.reason, 'gesture', m);
    assert.equal(svc.ran(m).length, 0, m + ' reached no service');
  }
  // The others need none; the service gets the params without any activation flag and ctx.activation false.
  for (const m of ['calls.decline', 'calls.hangup', 'calls.mute', 'calls.camera', 'calls.state', 'calls.list']) {
    const res = await api.request(m, { id: CALL_ID, on: true, activation: true });
    assert.equal(res.ok, true, m);
    const got = svc.ran(m)[0];
    assert.equal(got.ctx.activation, false, m);
    assert.equal(Object.prototype.hasOwnProperty.call(got.params, 'activation'), false, m + ': the site flag is removed');
  }
  // With the loader's own activation (a trusted click in the site frame) the UI methods reach the service.
  const clicked = page({ activation: () => true });
  const res = await clicked.api.request('calls.start', { to: PUB, video: true, isTrusted: true });
  assert.equal(res.ok, true);
  const got = clicked.svc.ran('calls.start')[0];
  assert.deepEqual(got.params, { to: PUB, video: true });
  assert.equal(got.ctx.activation, true);
});

test('host-only answers E_HOST_ONLY before any service; hanging up, muting and the reads still reach it', async () => {
  const { api, svc } = page({ activation: () => true, hostOnly: true });
  for (const m of ['calls.start', 'calls.accept', 'calls.decline', 'calls.camera', 'calls.screen']) {
    const res = await api.request(m, { id: CALL_ID, to: PUB, on: true });
    assert.deepEqual([res.ok, res.error.code, res.reason], [false, 'E_HOST_ONLY', 'host-only'], m);
    assert.equal(svc.ran(m).length, 0, m);
  }
  for (const m of ['calls.hangup', 'calls.mute', 'calls.state', 'calls.list']) {
    const res = await api.request(m, { id: CALL_ID, on: true });
    assert.equal(res.ok, true, m);
    assert.equal(svc.ran(m).length, 1, m);
  }
});

test('over the Bridge: the SDK facade sends every call method with the documented names, and the codes pass through', async () => {
  const fail = (code) => () => { throw Object.assign(new Error('refused'), { code }); };
  const { api, svc } = page({ activation: () => true });
  const { mw, bridge } = await shellSdk(api);
  await mw.calls.start({ to: [PUB, PUB2], video: false });
  assert.deepEqual(svc.ran('calls.start')[0].params, { to: [PUB, PUB2], video: false });
  await mw.calls.accept(CALL_ID, { video: true });
  assert.deepEqual(svc.ran('calls.accept')[0].params, { id: CALL_ID, video: true });
  await mw.calls.decline(CALL_ID);
  await mw.calls.hangup(CALL_ID);
  await mw.calls.mute(CALL_ID, true);
  await mw.calls.camera(CALL_ID, false);
  await mw.calls.screen(CALL_ID, true);
  await mw.calls.state(CALL_ID);
  await mw.calls.list();
  assert.deepEqual(svc.ran('calls.mute')[0].params, { id: CALL_ID, on: true });
  assert.deepEqual(svc.ran('calls.camera')[0].params, { id: CALL_ID, on: false });
  assert.deepEqual(svc.ran('calls.screen')[0].params, { id: CALL_ID, on: true });
  assert.deepEqual(svc.ran('calls.state')[0].params, { id: CALL_ID });
  assert.deepEqual(svc.ran('calls.list')[0].params, {});
  bridge.destroy();

  // Each of the six call codes (and the reused ones) reaches the site as itself, not as E_POLICY.
  for (const code of C2_ERROR_CODES.concat(['E_NOT_CONTACT', 'E_PEER_UNREACHABLE', 'E_LIMIT', 'E_UNSUPPORTED', 'E_NOT_SIGNED_IN', 'E_POLICY'])) {
    const t = page({ activation: () => true, impl: { 'calls.start': fail(code) } });
    const s = await shellSdk(t.api);
    assert.equal(await codeOf(s.mw.calls.start({ to: PUB })), code, 'facade ' + code);
    s.bridge.destroy();
    const { mw: binding } = createBinding({ api: t.api });
    assert.equal(await codeOf(binding.calls.start({ to: PUB })), code, 'binding ' + code);
  }
});

test('no MediaStream ever reaches the site: results and call events are plain data (MwApi, Bridge, facade, binding)', async () => {
  const stream = new FakeStream();
  const state = { id: CALL_ID, state: 'connected', local: { mute: false, camera: true, stream }, participants: [{ pub: PUB2, state: 'direct', track: stream }], render: () => 1 };
  const { api, svc } = page({ impl: { 'calls.state': () => state, 'calls.list': () => [state, stream] } });
  const direct = await api.request('calls.state', { id: CALL_ID });
  assert.equal(direct.ok, true);
  assert.deepEqual(direct.result, { id: CALL_ID, state: 'connected', local: { mute: false, camera: true }, participants: [{ pub: PUB2, state: 'direct' }] });
  const list = await api.request('calls.list', {});
  assert.deepEqual(list.result.length, 1, 'the stream itself is left out of the list');
  assert.deepEqual(await portSafe('calls.state', state), direct.result, 'the Bridge reduces a call result again');
  assert.deepEqual(plainOnly({ a: Infinity, b: NaN, c: [1, () => 2, 'x'], d: new Date(0) }), { a: null, b: null, c: [1, 'x'] });

  const { mw, bridge } = await shellSdk(api);
  const got = await mw.calls.state(CALL_ID);
  assert.deepEqual(got, direct.result);
  // The 'calls' push: a ring and a state event arrive at mw.calls.on listeners as plain data.
  const seen = [];
  const off = mw.calls.on('state', (d) => seen.push(['state', d]));
  mw.calls.on('ring', (d) => seen.push(['ring', d]));
  await settle();
  svc.emit('state', state);
  svc.emit('ring', { id: CALL_ID, from: PUB2, name: 'Bo', kind: 'video', expiresAt: 5, media: stream });
  for (let i = 0; i < 5 && seen.length < 2; i++) await settle();
  assert.deepEqual(seen, [['state', direct.result], ['ring', { id: CALL_ID, from: PUB2, name: 'Bo', kind: 'video', expiresAt: 5 }]]);
  off();
  assert.throws(() => mw.calls.on('media', () => {}), (e) => e.code === 'E_LIMIT', 'only the four events of SZ 3.5');
  bridge.destroy();

  const { mw: binding } = createBinding({ api });
  const viaBinding = [];
  binding.calls.on('peer', (d) => viaBinding.push(d));
  svc.emit('peer', { id: CALL_ID, pub: PUB2, state: 'relayed', track: stream });
  assert.deepEqual(viaBinding, [{ id: CALL_ID, pub: PUB2, state: 'relayed' }]);
  assert.deepEqual(await binding.calls.state(CALL_ID), direct.result);
});

test('drop-in mode: every mw.calls method answers E_UNSUPPORTED, before any gesture check or service; on() is inert', async () => {
  const { api, svc } = page({ mode: 'dropin', activation: () => false });
  const { mw } = createBinding({ api });
  const calls = [
    () => mw.calls.start({ to: PUB }), () => mw.calls.accept(CALL_ID), () => mw.calls.decline(CALL_ID), () => mw.calls.hangup(CALL_ID),
    () => mw.calls.mute(CALL_ID, true), () => mw.calls.camera(CALL_ID, true), () => mw.calls.screen(CALL_ID, true),
    () => mw.calls.state(CALL_ID), () => mw.calls.list(),
  ];
  for (const c of calls) assert.equal(await codeOf(c()), 'E_UNSUPPORTED');
  assert.equal(svc.calls.length, 0, 'no call method ran');
  // Even with a click and a bad parameter shape the answer is the same (a page load would end the call).
  const clicked = page({ mode: 'dropin', activation: () => true });
  const res = await clicked.api.request('calls.start', { to: PUB });
  assert.deepEqual([res.ok, res.error.code], [false, 'E_UNSUPPORTED']);
  const seen = [];
  const off = mw.calls.on('ring', (d) => seen.push(d));
  assert.equal(typeof off, 'function');
  assert.throws(() => mw.calls.on('nope', () => {}), (e) => e.code === 'E_LIMIT');
  off();
  assert.ok(Object.isFrozen(mw.calls), 'the binding surface is frozen');
});

test('features.calls comes from _mw.cfg.calls (only "contacts" turns it on); mw.ready() reports it', async () => {
  assert.equal(featuresOf({}).calls, false);
  assert.equal(featuresOf({ calls: 'off' }).calls, false);
  assert.equal(featuresOf({ calls: true }).calls, false, 'only the value src/calls/service.js accepts');
  assert.equal(featuresOf({ calls: 'contacts' }).calls, true);
  const on = page({ cfg: { calls: 'contacts', chat: 'members' } });
  const ready = await on.api.request('ready', {});
  assert.equal(ready.result.features.calls, true);
  const off = page({ cfg: {} });
  assert.equal((await off.api.request('ready', {})).result.features.calls, false);
});

test('the static stub: state() null, list() [], the rest E_NO_HOST, on() inert; features.calls false', async () => {
  assert.equal(await staticMw.calls.state(CALL_ID), null);
  assert.deepEqual(await staticMw.calls.list(), []);
  for (const m of ['start', 'accept', 'decline', 'hangup', 'mute', 'camera', 'screen']) assert.equal(await codeOf(staticMw.calls[m]()), 'E_NO_HOST', m);
  assert.equal(typeof staticMw.calls.on('ring', () => {}), 'function');
  assert.equal((await staticMw.ready()).features.calls, false);
});

test('mountV03Services mounts calls right after chat, on the chat SIG seam, with the documented deps', async () => {
  const order = [];
  const made = {};
  const sig = { send: async () => ({ reached: 1 }), onReceive: () => () => {}, listen: () => () => {}, contact: () => null, groupMembers: () => [], state: () => ({ on: true, calls: true }) };
  const recorderService = (name) => (deps) => { order.push(name); made[name] = deps; return { methods: { [name + '.state']: async () => null }, on: () => () => {}, sig: name === 'chat' ? sig : undefined }; };
  const modules = {
    chat: { createChatService: recorderService('chat') },
    calls: { createCallService: recorderService('calls') },
    files: { createFilesService: recorderService('files') },
    media: { createMediaService: recorderService('media') },
  };
  const api = new MwApi({ mod: false, cfg: () => ({ calls: 'contacts' }) });
  const prompts = [];
  const callPrompt = async (kind, data) => { prompts.push([kind, data]); return true; };
  const yields = [];
  const RTC = function RTCPeerConnection() {};
  const res = await mountV03Services(api, {
    modules,
    deps: {
      ledgerId: 'mw1:' + 'a'.repeat(27), mode: 'shell', chatDevice: 'android', hostOnly: () => false,
      policy: () => ({ class: 'mobileMetered', metered: true }), stun: () => ['stun:stun.example.org:3478'], turn: () => null,
      callPrefs: () => ({ sameLan: false, hideIp: true }), RTCPeerConnection: RTC, mediaDevices: { getUserMedia() {} }, wakeLock: { request() {} },
      callPrompt, onSeedYield: (st) => yields.push(st),
    },
  });
  assert.deepEqual(res.errors, {});
  assert.deepEqual(order, ['chat', 'calls', 'files', 'media'], 'calls is mounted right after chat');
  assert.deepEqual(res.mounted, ['chat', 'calls', 'files', 'media']);
  const d = made.calls;
  assert.equal(d.chat, sig, 'the chat service\'s SIG seam, as it is');
  assert.equal(typeof d.keys, 'function');
  assert.deepEqual(d.cfg(), { calls: 'contacts' });
  assert.deepEqual(d.policy(), { class: 'mobileMetered', metered: true });
  assert.deepEqual(d.stun(), ['stun:stun.example.org:3478']);
  assert.equal(d.turn(), null);
  assert.deepEqual(d.prefs(), { sameLan: false, hideIp: true });
  assert.equal(d.RTCPeerConnection, RTC);
  assert.equal(typeof d.mediaDevices.getUserMedia, 'function');
  assert.equal(typeof d.wakeLock.request, 'function');
  assert.equal(d.deviceClass, 'android');
  assert.equal(d.mode, 'shell');
  assert.equal(d.hostOnly(), false);
  assert.equal(await d.prompt('call.start', { to: PUB }), true);
  assert.deepEqual(prompts, [['call.start', { to: PUB }]], 'the call panel answers the call cards');
  d.onSeedYield({ active: true, limited: true });
  assert.deepEqual(yields, [{ active: true, limited: true }]);
  assert.equal(typeof d.now(), 'number');

  // No calls without the chat seam, in drop-in mode, or without the module.
  for (const variant of [
    { modules: { chat: { createChatService: () => ({ methods: {}, on: () => () => {} }) }, calls: modules.calls }, deps: {} },
    { modules, deps: { mode: 'dropin' } },
    { modules: { chat: modules.chat }, deps: {} },
  ]) {
    order.length = 0;
    const a = new MwApi({ mod: false });
    const r = await mountV03Services(a, variant);
    assert.equal(r.mounted.indexOf('calls'), -1, JSON.stringify(variant.deps));
    assert.equal(a.service('calls'), null);
  }
  // A drop-in page's API never gets calls, even when its engine passes no mode.
  const dropinApi = new MwApi({ mod: false, info: { mode: 'dropin' } });
  assert.equal((await mountV03Services(dropinApi, { modules, deps: {} })).mounted.indexOf('calls'), -1);
  // Without the call panel the page's own prompt answers the call cards (cardFor below).
  const a2 = new MwApi({ mod: false, ui: { prompt: async (kind, data) => ({ kind, data }) } });
  const r2 = await mountV03Services(a2, { modules: { chat: modules.chat, calls: modules.calls }, deps: {} });
  assert.deepEqual(r2.mounted, ['chat', 'calls']);
  const card = await made.calls.prompt('call.screen', { id: CALL_ID });
  assert.equal(card.kind, 'confirm');
  assert.equal(card.data.text, callText('call.screen'));
  assert.deepEqual(made.calls.policy(), { class: 'desktop', metered: false }, 'defaults when the loader passes none');
  assert.deepEqual(made.calls.stun(), []);
});

test('cardFor maps every call card to a confirm card that names who sees the IP address (loaders without a call panel)', () => {
  assert.deepEqual(CALL_CARD_KINDS, ['call.start', 'call.incoming', 'call.group', 'call.metered', 'call.screen']);
  const start = cardFor('call.start', { to: PUB, name: 'Ana', relay: { operator: 'Relay Co' } });
  assert.equal(start.kind, 'confirm');
  assert.equal(start.data.text, callText('call.start', 'en', { name: 'Ana' }) + ' ' + callText('call.startRelay', 'en', { operator: 'Relay Co' }));
  assert.match(start.data.text, /will see your IP address/);
  const noName = cardFor('call.start', { to: PUB });
  assert.match(noName.data.text, new RegExp('^Call ' + PUB.slice(5, 13) + '\\?'), 'the short id stands in for a missing name');
  const inc = cardFor('call.incoming', { from: PUB2, name: 'Bo', kind: 'video' });
  assert.equal(inc.data.text, 'Bo is calling (video). Accepting shows your IP address to Bo.');
  const grp = cardFor('call.group', { role: 'callee', from: PUB2, name: 'Bo', roster: [PUB], names: ['Ana'] });
  assert.equal(grp.data.text, 'Join a call with Bo, Ana? Each of them will see your IP address.');
  const grpCaller = cardFor('call.group', { role: 'caller', to: [PUB, PUB2], names: ['Ana', null] });
  assert.equal(grpCaller.data.text, 'Join a call with Ana, ' + PUB2.slice(5, 13) + '? Each of them will see your IP address.');
  assert.equal(cardFor('call.metered', {}).data.text, callText('call.metered'));
  const fr = cardFor('call.screen', {}, { lang: 'fr' });
  assert.equal(fr.data.text, callText('call.screen', 'fr'));
  assert.equal(callName('  Ana  ', PUB), 'Ana');
  assert.equal(callName('', null), '?');
  assert.equal(callNames(['A', 'B'], [PUB, PUB2]), 'A, B');
});

test('the page prompt answers a call card only from the person\'s own input (promptAdapter)', async () => {
  const seen = [];
  const prompt = promptAdapter({ prompt: async (kind, data) => { seen.push([kind, data.text]); return true; } });
  assert.equal(await prompt('call.metered', {}), true);
  assert.deepEqual(seen, [['confirm', callText('call.metered')]]);
  const refusing = promptAdapter({ prompt: async () => { throw new Error('closed'); } });
  assert.equal(await refusing('call.start', { to: PUB }), false, 'a closed card grants nothing');
});
