// Unit tests for the seeding side of the SDK and the loader (v0.3 C2, lane wire-ui; research/v03/SEEDING-AND-ZERO-SETUP-
// DESIGN.md 3.1.3 to 3.1.5): mw.net.seeding() (lanes, month, dock, keeper; Infinity crosses as null), mw.net.dock({ hours })
// and mw.net.keep(on) as UI methods with the loader's own card (dock.start() runs inside the card's click), drop-in and
// static answers, availability evidence and labels passing through mw.files.list() and mw.media.list(), and the pure
// helpers of src/loader/app.js that feed computePolicy() (network proof, dock, call yield, declarations). Lane
// seed-policy's real seedBudget() and createDock() are used; the TorrentManager's `seeding` getter (lane seed-engine) is
// mocked at its documented shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MwApi, createNetControl, seedingSnapshot, ipSentence, HOST_ONLY_METHODS, CONDITIONAL_UI, needsActivation, UI_METHODS, READ_METHODS, METHOD_ARGS } from '../../src/loader/api.js';
import { Bridge } from '../../src/loader/bridge.js';
import * as sdk from '../../src/sdk/sdk.js';
import staticMw from '../../src/sdk/sdk-static.js';
import { createBinding } from '../../src/dropin/binding.js';
import { networkProofOf, seedEnvOf, seedPrefsOf, staticTurnOf, callPolicyOf } from '../../src/loader/app.js';
import { computePolicy } from '../../src/loader/policy.js';
import { seedBudget } from '../../src/loader/seed-budget.js';
import { createSeedMeters } from '../../src/loader/seed-meters.js';
import { createDock } from '../../src/loader/dock.js';
import { CONFIG } from '../../src/loader/config.js';
import { seedText } from '../../src/loader/strings.js';

const ORIGIN = 'https://x.test';
const desktopEnv = { isMobile: false, networkClass: 'wifi', networkType: 'wifi', saveData: false, battery: null, online: true };
const phoneEnv = (over = {}) => Object.assign({ isMobile: true, networkClass: 'unknown', networkType: 'unknown', saveData: false, battery: null, online: true }, over);

async function codeOf(p) {
  try { await p; return 'resolved'; } catch (err) { return err && err.code; }
}

/** A fake Wake Lock world for lane seed-policy's real createDock(). */
function dockWorld({ battery = null, supported = true } = {}) {
  const doc = { visibilityState: 'visible', listeners: new Map(), addEventListener(t, f) { this.listeners.set(t, f); }, removeEventListener() {} };
  const requests = [];
  const sentinel = () => ({ released: false, release() { this.released = true; return Promise.resolve(); }, addEventListener() {}, removeEventListener() {} });
  const nav = supported ? { wakeLock: { request: (type) => { requests.push(type); return Promise.resolve(sentinel()); } } } : {};
  let t = 1000000;
  const timers = [];
  const dock = createDock({ nav, doc, now: () => t, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {}, battery, config: CONFIG });
  return { dock, requests, nav, doc, advance: (ms) => { t += ms; } };
}

function shellPair(api) {
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
  const timers = { setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); if (h && h.unref) h.unref(); return h; }, clearTimeout: (h) => clearTimeout(h) };
  const mw = sdk.createSdk(Object.assign({ win: frameWin, doc: null, global: {} }, timers));
  return { mw, bridge };
}

test('the tables: net.seeding is a read; net.dock is UI; net.keep is UI only to turn keeping on; both refused host-only', () => {
  assert.ok(READ_METHODS.indexOf('net.seeding') >= 0);
  assert.ok(UI_METHODS.indexOf('net.dock') >= 0);
  assert.ok(UI_METHODS.indexOf('net.keep') >= 0);
  assert.equal(CONDITIONAL_UI['net.keep'], 'on');
  assert.equal(needsActivation('net.keep', { on: true }), true);
  assert.equal(needsActivation('net.keep', { on: false }), false, 'turning keeping off needs no click');
  assert.equal(needsActivation('net.dock', {}), true);
  assert.ok(HOST_ONLY_METHODS.indexOf('net.dock') >= 0 && HOST_ONLY_METHODS.indexOf('net.keep') >= 0);
  assert.equal(HOST_ONLY_METHODS.indexOf('net.seeding'), -1, 'the counters of this device are always readable');
  assert.deepEqual(METHOD_ARGS['net.dock'], ['...']);
  assert.deepEqual(METHOD_ARGS['net.keep'], ['on']);
});

test('seedingSnapshot: lane rates from the budget, counts from the manager (or the meters), Infinity caps cross as null', () => {
  const b = seedBudget(desktopEnv, { share: true }, CONFIG);
  const tmSeeding = { active: true, row: 'desktop', lanes: { H: { rate: 1, used: 10, local: 4 }, K: { rate: 1, used: 2048 }, E: { rate: 1, used: 0 } }, month: { used: 2048, cap: 20000000000 } };
  const s = seedingSnapshot({ budget: b, seeding: tmSeeding, dock: { on: false, until: null }, keeper: true });
  assert.deepEqual(s, {
    lanes: { H: { rate: 1048576, used: 10 }, K: { rate: 1048576, used: 2048 }, E: { rate: 262144, used: 0 } },
    month: { used: 2048, cap: 20000000000 },
    dock: { on: false, until: null },
    keeper: true,
  });
  // Without a manager the meters count; a budget whose month has no cap reports null; the result is JSON as it is.
  const meters = createSeedMeters({ storage: null, now: () => Date.UTC(2026, 9, 20) });
  meters.add('K', 5000);
  meters.add('H', 700);
  meters.add('E', 900, { local: true });
  const open = Object.assign({}, b, { month: { cap: Infinity, lanes: ['K', 'E'] } });
  const s2 = seedingSnapshot({ budget: open, meters, dock: { on: true, until: 12345 } });
  assert.deepEqual(s2.lanes, { H: { rate: 1048576, used: 700 }, K: { rate: 1048576, used: 5000 }, E: { rate: 262144, used: 0 } }, 'a local wire\'s bytes do not count');
  assert.deepEqual(s2.month, { used: 5000, cap: null });
  assert.deepEqual(s2.dock, { on: true, until: 12345 });
  assert.equal(s2.keeper, false);
  assert.deepEqual(JSON.parse(JSON.stringify(s2)), s2);
  assert.deepEqual(seedingSnapshot({}), { lanes: { H: { rate: 0, used: 0 }, K: { rate: 0, used: 0 }, E: { rate: 0, used: 0 } }, month: { used: 0, cap: 0 }, dock: { on: false, until: null }, keeper: false });
});

test('mw.net.seeding() over the Bridge and through the binding; E_UNSUPPORTED on a page without the control; E_POLICY in a follower tab', async () => {
  const b = seedBudget(phoneEnv({ networkClass: 'cellular' }), { share: true }, CONFIG);
  let follower = false;
  const control = createNetControl({ budget: () => b, seeding: () => null, meters: () => null, follower: () => follower, keeper: () => false });
  const api = new MwApi({ mod: false, info: { mode: 'shell' } });
  api.setNode(null, { failed: true });
  api.setNet(control);
  const { mw, bridge } = shellPair(api);
  await mw.ready();
  const s = await mw.net.seeding();
  assert.equal(s.lanes.H.rate, 131072, 'row 5 (metered): own uploads at 128 KiB/s');
  assert.equal(s.lanes.K.rate, 0);
  assert.deepEqual(s.month, { used: 0, cap: 0 });
  const { mw: binding } = createBinding({ api });
  assert.deepEqual(await binding.net.seeding(), s);
  follower = true;
  assert.equal(await codeOf(mw.net.seeding()), 'E_POLICY');
  bridge.destroy();
  const bare = new MwApi({ mod: false });
  bare.setNode(null, { failed: true });
  const { mw: b2 } = createBinding({ api: bare });
  assert.equal(await codeOf(b2.net.seeding()), 'E_UNSUPPORTED');
  assert.equal(await codeOf(b2.net.dock({ hours: 1 })), 'E_NEEDS_GESTURE', 'the click comes first, as for every UI method');
});

test('mw.net.dock: a click, then the loader card; its button starts dock mode inside that click; phones only', async () => {
  const w = dockWorld({ battery: { charging: true, level: 0.9, addEventListener() {}, removeEventListener() {} } });
  const cards = [];
  let answer = 'start'; // what the person does on the card: 'start' clicks the button, 'cancel' closes it
  const prompt = async (kind, data) => {
    cards.push({ kind, data });
    if (answer !== 'start') return false;
    const requestsBefore = w.requests.length;
    const p = data.start(false); // the card's button: synchronous, inside the click
    assert.equal(w.requests.length, requestsBefore + 1, 'the Wake Lock request left before any await');
    return p;
  };
  let mobile = true;
  const api = new MwApi({ mod: false, activation: () => true, info: { mode: 'shell' } });
  api.setNet(createNetControl({ dock: w.dock, isMobile: () => mobile, prompt, now: () => 1000000, declareNeeded: () => false, dockDefaultMs: CONFIG.seed.dockDefaultMs, dockCapMs: CONFIG.seed.dockCapMs }));
  const r = await api.request('net.dock', { hours: 3 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.result, { on: true, until: 1000000 + 3 * 3600000, reason: null, declared: false });
  assert.equal(cards[0].kind, 'dock');
  assert.equal(cards[0].data.ms, 3 * 3600000);
  assert.equal(cards[0].data.until, 1000000 + 3 * 3600000);
  assert.equal(cards[0].data.declare, false);
  // hours: 0 stops it without a card; more than 8 is refused.
  const stop = await api.request('net.dock', { hours: 0 });
  assert.deepEqual(stop.result, { on: false, until: null, reason: 'user', declared: false });
  assert.equal(cards.length, 1);
  for (const bad of [9, -1, '2', NaN]) {
    const res = await api.request('net.dock', { hours: bad });
    assert.equal(res.error.code, 'E_LIMIT', String(bad));
  }
  // The default is 2 hours; cancelling the card is E_USER_CANCELLED and starts nothing.
  answer = 'cancel';
  const before = w.requests.length;
  const c = await api.request('net.dock', {});
  assert.equal(c.error.code, 'E_USER_CANCELLED');
  assert.equal(w.requests.length, before);
  assert.equal(cards[cards.length - 1].data.ms, CONFIG.seed.dockDefaultMs);
  // A computer keeps a site with keep(), not dock(); a browser without Wake Lock cannot.
  mobile = false;
  assert.equal((await api.request('net.dock', {})).error.code, 'E_UNSUPPORTED');
  mobile = true;
  const none = dockWorld({ supported: false });
  const api2 = new MwApi({ mod: false, activation: () => true });
  api2.setNet(createNetControl({ dock: none.dock, isMobile: () => true, prompt }));
  assert.equal((await api2.request('net.dock', {})).error.code, 'E_UNSUPPORTED');
  // Without a click: E_NEEDS_GESTURE and no card; host-only: E_HOST_ONLY first.
  const noClick = new MwApi({ mod: false, activation: () => false });
  noClick.setNet(createNetControl({ dock: w.dock, isMobile: () => true, prompt }));
  const n = cards.length;
  assert.equal((await noClick.request('net.dock', {})).error.code, 'E_NEEDS_GESTURE');
  const hostOnly = new MwApi({ mod: false, activation: () => true, hostOnly: () => true });
  hostOnly.setNet(createNetControl({ dock: w.dock, isMobile: () => true, prompt }));
  assert.equal((await hostOnly.request('net.dock', {})).error.code, 'E_HOST_ONLY');
  assert.equal(cards.length, n, 'no card without a click or with host-only');
});

test('mw.net.dock where the browser cannot read the battery: the card asks for the declaration, start gets it', async () => {
  const w = dockWorld({ battery: null });
  const seen = [];
  const prompt = async (kind, data) => { seen.push(data.declare); return data.start(true); };
  const api = new MwApi({ mod: false, activation: () => true });
  api.setNet(createNetControl({ dock: w.dock, isMobile: () => true, prompt, declareNeeded: () => true }));
  const r = await api.request('net.dock', { hours: 1 });
  assert.deepEqual(seen, [true]);
  assert.equal(r.result.on, true);
  assert.equal(r.result.declared, true, 'started on the person\'s word ("plugged in, on Wi-Fi")');
  // Undeclared, dock.js refuses ('declare') and the card stays open with that reason; here the fake card gives up.
  const w2 = dockWorld({ battery: null });
  const api2 = new MwApi({ mod: false, activation: () => true });
  api2.setNet(createNetControl({ dock: w2.dock, isMobile: () => true, prompt: async (k, d) => d.start(false).then((st) => (st.on ? st : false)), declareNeeded: () => true }));
  assert.equal((await api2.request('net.dock', {})).error.code, 'E_USER_CANCELLED');
});

test('mw.net.keep: computers only; keep(true) needs a click and the keeper card; keep(false) needs neither', async () => {
  let keeper = false;
  const cards = [];
  let ok = true;
  let share = true;
  const control = () => createNetControl({
    isMobile: () => false,
    keeper: () => keeper,
    setKeeper: async (on) => { keeper = on; },
    canKeep: () => (share ? null : 'E_POLICY'),
    prompt: async (kind, data) => { cards.push({ kind, data }); return ok; },
    lang: 'en',
  });
  const clicked = new MwApi({ mod: false, activation: () => true });
  clicked.setNet(control());
  const on = await clicked.request('net.keep', { on: true });
  assert.deepEqual(on.result, { on: true });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, 'confirm');
  assert.equal(cards[0].data.title, seedText('keeper.toggle'));
  assert.equal(cards[0].data.text, seedText('keeper.on') + ' ' + ipSentence('en'));
  assert.match(cards[0].data.text, /Others can see your IP address/);
  // Already keeping: no second card. Off: no card, no click.
  assert.deepEqual((await clicked.request('net.keep', { on: true })).result, { on: true });
  assert.equal(cards.length, 1);
  const noClick = new MwApi({ mod: false, activation: () => false });
  noClick.setNet(control());
  assert.deepEqual((await noClick.request('net.keep', { on: false })).result, { on: false });
  keeper = false;
  assert.equal((await noClick.request('net.keep', { on: true })).error.code, 'E_NEEDS_GESTURE');
  assert.equal((await clicked.request('net.keep', {})).error.code, 'E_LIMIT', 'on must be true or false');
  ok = false;
  assert.equal((await clicked.request('net.keep', { on: true })).error.code, 'E_USER_CANCELLED');
  assert.equal(keeper, false);
  share = false;
  ok = true;
  assert.equal((await clicked.request('net.keep', { on: true })).error.code, 'E_POLICY', 'sharing is off');
  const phone = new MwApi({ mod: false, activation: () => true });
  phone.setNet(createNetControl({ isMobile: () => true, keeper: () => false }));
  assert.equal((await phone.request('net.keep', { on: true })).error.code, 'E_UNSUPPORTED');
  assert.equal(ipSentence('fr'), 'D\'autres personnes peuvent voir votre adresse IP et les fichiers que vous partagez.');
});

test('the static stub: net.seeding() reads nothing shared; dock() and keep() are E_NO_HOST', async () => {
  const s = await staticMw.net.seeding();
  assert.deepEqual(s, { lanes: { H: { rate: 0, used: 0 }, K: { rate: 0, used: 0 }, E: { rate: 0, used: 0 } }, month: { used: 0, cap: 0 }, dock: { on: false, until: null }, keeper: false });
  assert.equal(await codeOf(staticMw.net.dock({ hours: 2 })), 'E_NO_HOST');
  assert.equal(await codeOf(staticMw.net.keep(true)), 'E_NO_HOST');
});

test('mw.files.list() and mw.media.list() pass evidence, label and hand-off state through (Bridge, facade, binding)', async () => {
  const evidence = { tier: 'E1', count: 3, atLeast: false, reported: true, checkedAt: 1700000000000 };
  const fileItem = { ref: 'f'.repeat(40), name: 'a.pdf', mine: true, available: 'online', evidence, label: 'avail.heldBy', labelParams: { n: 3 }, handoff: { state: 'sent', n: 3 } };
  const mediaItem = { id: 'm1', kind: 'image', from: 'mine', available: 'kept', evidence: { tier: 'E4', count: 0, atLeast: false, reported: false, checkedAt: 1700000000000 }, label: 'avail.keptBySite', labelParams: { age: 60000 } };
  const api = new MwApi({ mod: false });
  api.setNode(null, { failed: true });
  api.mount('files', { methods: { 'files.list': async () => [fileItem] }, on: () => () => {} });
  api.mount('media', { methods: { 'media.list': async () => [mediaItem] }, on: () => () => {} });
  const { mw, bridge } = shellPair(api);
  await mw.ready();
  assert.deepEqual(await mw.files.list(), [fileItem]);
  assert.deepEqual(await mw.media.list({ from: 'mine' }), [mediaItem]);
  bridge.destroy();
  const { mw: binding } = createBinding({ api });
  assert.deepEqual(await binding.files.list(), [fileItem]);
  assert.deepEqual(await binding.media.list(), [mediaItem]);
});

test('app.js helpers: how the network is known, dock and call state feed computePolicy() (lane seed-policy\'s seedBudget)', () => {
  assert.equal(networkProofOf({ networkClass: 'wifi' }), 'connection');
  assert.equal(networkProofOf({ networkClass: 'cellular' }), 'connection');
  assert.equal(networkProofOf({ networkClass: 'unknown' }), 'none');
  assert.equal(networkProofOf({ networkClass: 'unknown' }, { declaredWifi: true }), 'declared');
  assert.equal(networkProofOf({ networkClass: 'unknown' }, {}, { on: true, declared: true }), 'declared', 'dock mode on the person\'s word');
  assert.equal(networkProofOf({ networkClass: 'wifi' }, { declaredWifi: true }), 'connection', 'proof beats a declaration');

  const env = seedEnvOf(phoneEnv(), { prefs: {}, dock: { on: true, declared: true }, call: { active: true, limited: true } });
  assert.deepEqual([env.networkProof, env.dock, env.call], ['declared', true, { limited: true }]);
  assert.equal(seedEnvOf(phoneEnv(), {}).call, null);
  assert.deepEqual(seedPrefsOf({}, { on: true, declared: true }), { declaredWifi: true, declaredPlugged: true, seedAsked: false });
  assert.deepEqual(seedPrefsOf({ declaredWifi: true, seedAsked: true }, null), { declaredWifi: true, declaredPlugged: false, seedAsked: true });

  // An iPhone (nothing provable) in dock mode on the person's word: row 2, K and E on (dock mode is the opt-in).
  const dockState = { on: true, declared: true };
  const pol = computePolicy(seedEnvOf(phoneEnv(), { prefs: {}, dock: dockState }), Object.assign({ share: true }, seedPrefsOf({}, dockState)), CONFIG);
  assert.equal(pol.seedBudget.row, 'phoneCharging');
  assert.ok(pol.seedBudget.lanes.K.rate > 0 && pol.seedBudget.lanes.E.rate > 0);
  // The same phone without dock mode: row 4, K and E off, and the budget asks for "I am on Wi-Fi".
  const plain = computePolicy(seedEnvOf(phoneEnv(), { prefs: {} }), Object.assign({ share: true }, seedPrefsOf({})), CONFIG);
  assert.equal(plain.seedBudget.row, 'phoneLimited');
  assert.equal(plain.seedBudget.lanes.K.rate, 0);
  assert.equal(plain.seedBudget.ask, 'wifi');
  // During a call a desktop sends no E (SZ 3.1.3 row 7), and halves K only while the call is limited.
  const call = computePolicy(seedEnvOf(desktopEnv, { call: { active: true, limited: true } }), { share: true }, CONFIG);
  assert.equal(call.seedBudget.lanes.E.rate, 0);
  assert.equal(call.seedBudget.lanes.K.rate, 524288);
  assert.equal(computePolicy(seedEnvOf(desktopEnv, {}), { share: true }, CONFIG).seedBudget.lanes.E.rate, 262144);

  assert.deepEqual(callPolicyOf({ class: 'mobileMetered' }), { class: 'mobileMetered', metered: true });
  assert.deepEqual(callPolicyOf(null), { class: 'desktop', metered: false });
  const turn = { urls: ['turn:turn.example.org:3478'], username: 'u', credential: 'c', operator: 'Example' };
  assert.deepEqual(staticTurnOf({ urls: ['https://cred.example.org/'], mode: 'endpoint' }, turn), [turn], 'option (b) is not fetched in C2');
  assert.equal(staticTurnOf({ urls: ['turn:x.example:3478'], mode: 'static' }), null, 'no credentials, no relay');
  assert.equal(staticTurnOf(null, undefined), null);
});

// ---- the loader's own wiring (src/loader/app.js, "C2 wire-ui" insertion points), on a fake page object ----------

import { __c2WireUi as W } from '../../src/loader/app.js';
import { meterText } from '../../src/loader/ui.js';

function fakeEmitter() {
  const l = new Map();
  return {
    on(ev, fn) { if (!l.has(ev)) l.set(ev, []); l.get(ev).push(fn); },
    emit(ev, ...a) { for (const fn of l.get(ev) || []) fn(...a); },
  };
}

function fakeTm() {
  const ev = new Map();
  const tm = {
    budgets: [],
    meters: null,
    policy: null,
    seedingValue: null,
    diag: { swarm: { reported: true, others: 3 } },
    setSeedBudget(b) { this.budgets.push(b); return true; },
    setSeedMeters(m) { this.meters = m; },
    setPolicy(p) { this.policy = p; },
    get seeding() { return this.seedingValue; },
    diagnostics() { return this.diag; },
    addEventListener(type, fn) { if (!ev.has(type)) ev.set(type, []); ev.get(type).push(fn); },
    fire(type, detail) { for (const fn of ev.get(type) || []) fn({ detail }); },
  };
  return tm;
}

function fakePage({ env = desktopEnv, prefs = {}, config = CONFIG } = {}) {
  const store = new Map();
  const ui = {
    calls: [],
    setMode() {}, setKeeper(x) { this.calls.push(['keeper', x]); }, setDock(x) { this.calls.push(['dock', x]); },
    setBanner(id, text) { this.calls.push(['banner', id, text]); }, setMeter(x) { this.calls.push(['meter', x]); },
    setUploads(rows, o) { this.calls.push(['uploads', rows, o]); }, setSubline() {}, setStatus() {},
    prompts: [], answer: true,
    prompt(kind, data) { this.prompts.push([kind, data]); return Promise.resolve(this.answer); },
    settings: { setModel() {}, notify() {} },
    last(kind) { for (let i = this.calls.length - 1; i >= 0; i--) if (this.calls[i][0] === kind) return this.calls[i]; return null; },
  };
  const api = new MwApi({ mod: false, cfg: () => ({}) });
  const A = {
    win: { navigator: { language: 'en-CA' } },
    doc: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    origin: ORIGIN,
    config,
    env,
    webrtc: true,
    consentState: 'accepted',
    record: { btih: 'f'.repeat(40), dn: 'my-site' },
    manifest: { name: 'my-site' },
    prefs: Object.assign({ share: true, hostOnly: false, shareOnNetwork: false, declaredWifi: false, declaredPlugged: false, seedAsked: false, keeper: false }, prefs),
    ui,
    api,
    deps: { cache: { getPref: async (k, d) => (store.has(k) ? store.get(k) : d), setPref: async (k, v) => { store.set(k, v); }, estimateUsage: async () => 0 } },
    log: () => {},
    mode: { mode: 'shell' },
    isLeader: true,
    store,
  };
  A.policy = computePolicy(seedEnvOf(A.env, { prefs: A.prefs }), Object.assign({ share: true }, seedPrefsOf(A.prefs)), config);
  return A;
}

test('app.js: the TorrentManager gets the meters (per-origin key) and the budget; site wires feed the carry meter', async () => {
  const A = fakePage();
  const tm = fakeTm();
  A.tm = tm;
  W.attachSeeding(A, tm);
  clearInterval(A.seedTick);
  assert.equal(tm.meters, A.seedMeters);
  assert.deepEqual(tm.budgets[tm.budgets.length - 1], A.policy.seedBudget, 'the policy\'s seed budget, as computed');
  await A.seedMeters.ready;
  A.seedMeters.add('K', 1000);
  A.seedMeters.flush();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(A.store.get('seedMeters:' + ORIGIN).K, 1000, 'stored on the per-origin pref store');
  // The carry meter: bytes of the site torrent by source, and the distinct visitors who sent any.
  const peer1 = Object.assign(fakeEmitter(), { peerId: 'aa' });
  const peer2 = Object.assign(fakeEmitter(), { peerId: 'bb' });
  const peer1again = Object.assign(fakeEmitter(), { peerId: 'aa' });
  const web = Object.assign(fakeEmitter(), { type: 'webSeed' });
  const fileWire = Object.assign(fakeEmitter(), { peerId: 'cc' });
  for (const [w, kind] of [[peer1, 'site'], [peer2, 'site'], [peer1again, 'site'], [web, 'site'], [fileWire, 'file']]) tm.fire('wire', { wire: w, kind });
  peer1.emit('download', 300);
  peer1again.emit('download', 100);
  peer2.emit('download', 0);
  web.emit('download', 600);
  fileWire.emit('download', 5000);
  assert.deepEqual([A.carry.peer, A.carry.host, A.carry.senders.size], [400, 600, 1], 'a reconnect is the same visitor; a wire that sent nothing is not counted; file bytes are not the site');
  W.refreshCarry(A);
  const meter = A.ui.last('meter')[1];
  assert.equal(meter.visit, meterText({ p: 40, n: 1, h: 60 }), 'the singular sentence once lane docs-strings has one');
  assert.match(meter.visit, /^This visit: 40% of the bytes came from 1 visitors?, 60% from the host\.$/);
  assert.match(meter.tracker, /^4 connected to this site \(tracker report, /);
  A.fromCache = true;
  A.carryVisit = null;
  W.refreshCarry(A);
  assert.equal(A.ui.last('meter')[1].visit, null, 'a copy from the cache downloaded nothing this visit');
});

test('app.js: the keeper line with its counter, and the month-cap notice once K or E have used the month', () => {
  const A = fakePage({ prefs: { keeper: true } });
  const tm = fakeTm();
  A.tm = tm;
  tm.seedingValue = { active: true, lanes: { H: { used: 0 }, K: { used: 0 }, E: { used: 0 } }, month: { used: 1200000, cap: 20000000000 } };
  W.refreshSeedUi(A);
  const keeper = A.ui.last('keeper')[1];
  assert.equal(keeper.on, true);
  assert.equal(keeper.text, seedText('keeper.on') + ' (my-site: 1.14 MB / 20 GB)');
  assert.equal(A.ui.last('banner'), null, 'no notice before the cap');
  tm.seedingValue = { active: true, lanes: { H: {}, K: {}, E: {} }, month: { used: 20000000000, cap: 20000000000 } };
  W.refreshSeedUi(A);
  assert.deepEqual(A.ui.last('banner'), ['banner', 'seed-month', seedText('seed.monthUsed', 'en', { cap: '20 GB' })]);
  const n = A.ui.calls.length;
  W.refreshSeedUi(A);
  assert.equal(A.ui.calls.filter((c, i) => i >= n && c[0] === 'banner').length, 0, 'said once, not on every tick');
  // A phone never keeps a site as a tab; sharing off stops keeping too.
  const P = fakePage({ env: phoneEnv(), prefs: { keeper: true } });
  W.refreshSeedUi(P);
  assert.equal(P.ui.last('keeper')[1].on, false);
  assert.equal(W.keeperActive(fakePage({ prefs: { keeper: true, share: false } })), false);
});

test('app.js: the seed.ask card at the moment of value (an own upload), only where the budget asks; answered once', async () => {
  const config = Object.assign({}, CONFIG, { seed: Object.assign({}, CONFIG.seed, { phoneDefaultOn: true }) });
  const env = phoneEnv({ networkClass: 'wifi', networkType: 'wifi', battery: { charging: true, level: 0.8 } });
  const A = fakePage({ env, config });
  assert.equal(A.policy.seedBudget.ask, 'consent', 'row 2 with SZ-1 on, not answered yet');
  W.onSeedPush(A, 'files', { type: 'shared', data: { ref: 'f'.repeat(40), listed: true } });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(A.ui.prompts.length, 1);
  assert.equal(A.ui.prompts[0][0], 'confirm');
  assert.equal(A.ui.prompts[0][1].text, seedText('seed.ask', 'en', { cap: '1 GiB' }));
  assert.match(A.ui.prompts[0][1].text, /Others can see your IP address and which files you share/);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(A.prefs.shareOnNetwork, true);
  assert.equal(A.prefs.seedAsked, true);
  assert.equal(A.store.get('shareOnNetwork:' + ORIGIN), true);
  assert.equal(A.store.get('seedAsked:' + ORIGIN), true);
  assert.equal(A.policy.seedBudget.ask, null, 'never asked again');
  W.onSeedPush(A, 'media', { type: 'shared', data: { id: 'm1', kind: 'own' } });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(A.ui.prompts.length, 1);
  // Where the budget does not ask (SZ-1 off: the shipped default), no card at all.
  const B = fakePage({ env });
  W.onSeedPush(B, 'files', { type: 'shared', data: { ref: 'e'.repeat(40) } });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(B.ui.prompts.length, 0);
  assert.ok(B.uploads.has('files:' + 'e'.repeat(40)), 'the upload card follows the own upload');
  clearTimeout(B.uploadsTimer);
  clearTimeout(A.uploadsTimer);
});

test('app.js: the upload card shows the hand-off sentence of each own upload from the services\' lists', async () => {
  const A = fakePage();
  A.api.mount('media', { methods: { 'media.list': async (p) => { assert.deepEqual(p, { from: 'mine' }); return [{ id: 'm1', label: 'handoff.sending', labelParams: { pct: 62 }, handoff: { state: 'sending', pct: 62 } }]; } }, on: () => () => {} });
  A.api.mount('files', { methods: { 'files.list': async () => [{ ref: 'r1', name: 'notes.txt', label: 'avail.keptBySite', labelParams: { age: 60000 }, handoff: { state: 'kept' } }] }, on: () => () => {} });
  W.onSeedPush(A, 'media', { type: 'shared', data: { id: 'm1', kind: 'own' } });
  W.onSeedPush(A, 'files', { type: 'shared', data: { ref: 'r1', listed: true } });
  clearTimeout(A.uploadsTimer);
  A.uploadsTimer = null;
  await W.refreshUploads(A);
  clearTimeout(A.uploadsPoll);
  const [, rows, opts] = A.ui.last('uploads');
  assert.deepEqual(rows.map((r) => r.text), ['Sending to the site: 62%', 'Kept by the site (checked 1 minute ago)']);
  assert.equal(rows[1].name, 'notes.txt');
  assert.equal(opts.note, seedText('avail.noPin'), 'no pin node in _mw.cfg: the honest note');
});

test('app.js: the calls service gets the site\'s own STUN, static TURN only, the plain RTCPeerConnection and the call panel', async () => {
  const A = fakePage();
  const Base = function RTCPeerConnection() {};
  const Wrapped = function RTCPeerConnection() {};
  Object.setPrototypeOf(Wrapped, Base);
  Object.defineProperty(Wrapped, '__mwOfferTimeout', { value: 1500 });
  const nav = { language: 'en', mediaDevices: { getUserMedia() {} }, wakeLock: { request() {} } };
  A.win = { navigator: nav, RTCPeerConnection: Wrapped };
  A.routing = { stun: ['stun:stun.example.org:3478', 'stun:b.example.org', 'stun:c.example.org', 'stun:d.example.org', 'stun:e.example.org'], turn: { urls: ['turn:t.example.org'], mode: 'static' } };
  const prompts = [];
  A.callUi = { prompt: async (k, d) => { prompts.push(k); return true; } };
  const d = W.callDeps(A);
  assert.equal(d.RTCPeerConnection, Base, 'not the offer-timeout wrapper WebTorrent gets');
  assert.equal(d.stun().length, 4);
  assert.equal(d.turn(), null, 'a TURN URL without credentials is no relay');
  assert.deepEqual(d.policy(), { class: 'desktop', metered: false });
  assert.deepEqual(d.callPrefs(), { sameLan: false, hideIp: false });
  assert.equal(d.mode, 'shell');
  assert.equal(await d.callPrompt('call.start', {}), true);
  assert.deepEqual(prompts, ['call.start']);
  assert.equal(d.mediaDevices, nav.mediaDevices);
  // The call yield moves the budget (SZ 3.1.3 row 7): a desktop in a call sends no E.
  const tm = fakeTm();
  A.tm = tm;
  d.onSeedYield({ active: true, limited: false, connections: 1, video: true });
  assert.equal(A.policy.seedBudget.call, true);
  assert.equal(A.policy.seedBudget.lanes.E.rate, 0);
  assert.equal(tm.budgets[tm.budgets.length - 1], A.policy.seedBudget, 'handed to the TorrentManager at once');
  d.onSeedYield(null);
  assert.equal(A.policy.seedBudget.call, false);
});

test('app.js: dock mode from Settings starts inside the click and feeds the budget; mw.net.dock and seeding answer', async () => {
  const charging = { charging: true, level: 0.9 };
  const A = fakePage({ env: phoneEnv({ networkClass: 'wifi', networkType: 'wifi', battery: charging }) });
  const requests = [];
  const lock = () => ({ release: () => Promise.resolve(), addEventListener() {}, removeEventListener() {} });
  const nav = { language: 'en', wakeLock: { request: (t) => { requests.push(t); return Promise.resolve(lock()); } }, getBattery: async () => Object.assign({ addEventListener() {}, removeEventListener() {} }, charging) };
  A.win = { navigator: nav };
  const B = fakePage({ env: phoneEnv() });
  try {
    await W.setupSeeding(A);
    assert.ok(A.dock && A.api.net, 'the dock controller and the mw.net control');
    assert.equal(A.policy.seedBudget.lanes.K.rate, 0, 'a phone shares no K before an opt-in');
    W.toggleDockFromSettings(A);
    assert.deepEqual(requests, ['screen'], 'requested synchronously, inside the person\'s click');
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(A.dock.state().on, true);
    assert.equal(A.policy.seedBudget.row, 'phoneCharging', 'charging on proven Wi-Fi');
    assert.ok(A.policy.seedBudget.lanes.K.rate > 0, 'dock mode is the opt-in for K and E');
    const s = await A.api.request('net.seeding', {});
    assert.equal(s.result.dock.on, true);
    assert.equal(s.result.lanes.K.rate, A.policy.seedBudget.lanes.K.rate);
    assert.ok(A.ui.last('dock')[1] && A.ui.last('dock')[1].on, 'the dim page is up');
    W.toggleDockFromSettings(A);
    assert.equal(A.dock.state().on, false);
    assert.equal(A.policy.seedBudget.lanes.K.rate, 0, 'off again without Share on this network');
    assert.equal(A.ui.last('dock')[1], null, 'the dim page is gone');
    // A browser without the battery API needs the declaration ("plugged in, on Wi-Fi") before it starts.
    B.win = { navigator: { language: 'en', wakeLock: nav.wakeLock } };
    await W.setupSeeding(B);
    assert.equal(B.batteryManager, null);
    assert.deepEqual(W.seedModel(B).declare, { wifi: true, plugged: true });
    W.toggleDockFromSettings(B);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(B.dock.state().on, false);
    assert.equal(B.dock.state().reason, 'declare');
    B.prefs.declaredWifi = true;
    B.prefs.declaredPlugged = true;
    W.toggleDockFromSettings(B);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(B.dock.state().on, true);
    assert.equal(B.dock.state().declared, true);
    assert.equal(B.policy.seedBudget.row, 'phoneCharging', 'on the person\'s word');
  } finally {
    for (const P of [A, B]) if (P.dock) P.dock.stop('user');
  }
});
