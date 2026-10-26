// Unit tests for the SDK boundary of v0.3 (src/loader/api.js, the A4 rule of R 2.11.1): UI methods need a click in
// the site frame (only the loader's ActivationTracker can say so; a flag in the params proves nothing), the
// conditional UI methods, the order of the boundary checks, mw.ready()'s R 2.11.2 shape and the implicit sign-in
// of a guest's first write (R 2.4.1). Services are fakes that record what reaches them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MwApi, ActivationTracker, UI_METHODS, GESTURE_EXEMPT, CONDITIONAL_UI, ACTIVATION_FLAGS, ACTIVATION_WINDOW_MS, SIGNIN_COOLDOWN_MS,
  API_METHODS, HOST_ONLY_METHODS, needsActivation, stripActivationFlags, featuresOf
} from '../../src/loader/api.js';
import { createBinding } from '../../src/dropin/binding.js';

const PUB = 'p256:B' + 'A'.repeat(86);
const H = 'c'.repeat(64);

function clock(t = 1000000) {
  return { now: () => t, advance: (ms) => { t += ms; } };
}

/** A service of the SVC contract that answers every method of `names` and records the calls. */
function recorder(names, impl = {}) {
  const calls = [];
  const listeners = new Map();
  const methods = {};
  for (const n of names) {
    methods[n] = async (params, ctx) => {
      calls.push({ method: n, params, ctx });
      if (impl[n]) return impl[n](params, ctx);
      return 'ran ' + n;
    };
  }
  return {
    methods,
    calls,
    ran: (m) => calls.filter((c) => c.method === m),
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev).add(fn);
      return () => listeners.get(ev).delete(fn);
    },
    emit(ev, data) { for (const fn of Array.from(listeners.get(ev) || [])) fn(data); },
    destroy() {},
  };
}

/** An identity service fake: auth.state / identity.current follow `state.signedIn`. */
function identityFake(state = { signedIn: false }, impl = {}) {
  const names = API_METHODS.filter((m) => /^(auth|identity|me)\./.test(m));
  const svc = recorder(names, Object.assign({
    'auth.state': () => (state.signedIn ? 'signed-in' : 'guest'),
    'identity.current': () => (state.signedIn ? { pub: PUB, short: 'abcd1234', name: null, mode: 'private' } : null),
    'auth.signOut': () => { state.signedIn = false; return { state: 'guest' }; },
  }, impl));
  svc.keys = () => (state.signedIn ? { pub: PUB } : null);
  return svc;
}

function fakeNode(over = {}) {
  const calls = [];
  return Object.assign({
    calls,
    role: 'writer',
    height: 7,
    peers: 3,
    state: { kv: new Map(), lists: new Map(), policy: { maxValueBytes: 2048 } },
    snapshot() { return { height: 7, kv: {}, lists: {}, profiles: {}, policy: {} }; },
    subscribe() { return () => {}; },
    async put(k, v) { calls.push(['put', k, v]); return { h: H }; },
    async append(l, v) { calls.push(['append', l, v]); return { h: H }; },
    async ban(p) { calls.push(['ban', p]); return { h: H }; },
  }, over);
}

/** Minimal params that pass the boundary's own validation for a method. */
function paramsFor(method) {
  if (method === 'mod.ban' || method === 'mod.unban') return { pub: PUB };
  if (method === 'chat.presence.set') return { on: true, public: true };
  if (method === 'auth.signOut') return { forget: true };
  if (method === 'net.keep') return { on: true };
  return {};
}

/** A page with every service mounted as a recorder; `activation` as the loader would pass it. */
function page({ activation = null, hostOnly = false, node = fakeNode(), signedIn = false, ui = null, readOnly = false, c = clock() } = {}) {
  const api = new MwApi({ node, activation, hostOnly: () => hostOnly, readOnly: () => readOnly, ui, now: c.now, mod: false, info: { siteId: 'mw1:' + 'a'.repeat(27), btih: 'f'.repeat(40), mode: 'shell', owner: PUB } });
  const svc = {
    identity: identityFake({ signedIn }),
    chat: recorder(API_METHODS.filter((m) => m.startsWith('chat.'))),
    files: recorder(API_METHODS.filter((m) => m.startsWith('files.'))),
    media: recorder(API_METHODS.filter((m) => m.startsWith('media.'))),
    mod: recorder(API_METHODS.filter((m) => /^(mod|report)\./.test(m)).concat(['db.setMine', 'db.getMine', 'db.listBy', 'owner.policy'])),
    hub: recorder(API_METHODS.filter((m) => m.startsWith('hub.'))),
  };
  for (const [name, s] of Object.entries(svc)) api.mount(name, s);
  return { api, svc, node, c };
}

const serviceCalls = (svc, method) => Object.values(svc).reduce((n, s) => n + s.ran(method).length, 0);

test('every UI method answers E_NEEDS_GESTURE without a click, before any service, prompt or request', async () => {
  const prompts = [];
  const { api, svc } = page({ ui: { prompt: async (k) => { prompts.push(k); return true; } } });
  await api.identity.refresh();
  const gated = UI_METHODS.filter((m) => GESTURE_EXEMPT.indexOf(m) < 0);
  assert.ok(gated.length >= 30, 'the UI list is the v0.3 one');
  for (const method of gated) {
    const res = await api.request(method, paramsFor(method));
    assert.equal(res.ok, false, method);
    assert.equal(res.error.code, 'E_NEEDS_GESTURE', method);
    assert.equal(res.reason, 'gesture', method);
    assert.equal(serviceCalls(svc, method), 0, method + ' reached no service');
  }
  assert.deepEqual(prompts, [], 'no card opened');
  assert.equal(api.stats.gestureRefused, gated.length);
});

test('a trusted click in the watched window opens UI methods for 5 s; script events and site flags do not', async () => {
  const c = clock();
  const nav = {};
  const tracker = new ActivationTracker({ now: c.now, nav });
  const handlers = [];
  const frame = { addEventListener: (type, fn, capture) => handlers.push({ type, fn, capture }), removeEventListener() {} };
  const unwatch = tracker.watch(frame);
  assert.ok(handlers.length >= 6 && handlers.every((h) => h.capture === true), 'capture phase: a site stopPropagation cannot hide a click');
  assert.deepEqual(handlers.map((h) => h.type).sort(), ['click', 'keydown', 'keyup', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchend']);
  const fire = (ev) => { for (const h of handlers.filter((x) => x.type === ev.type)) h.fn(ev); };
  const { api, svc } = page({ activation: tracker, c });

  // A site's flags in the params prove nothing, and they never reach the service.
  const flags = {};
  for (const f of ACTIVATION_FLAGS) flags[f] = true;
  let res = await api.request('media.share', Object.assign({ id: 'm1' }, flags));
  assert.equal(res.error.code, 'E_NEEDS_GESTURE');
  // A script-made click (isTrusted false) or a fake without isTrusted is not the person's.
  fire({ type: 'click', isTrusted: false });
  fire({ type: 'click' });
  res = await api.request('media.share', { id: 'm1' });
  assert.equal(res.error.code, 'E_NEEDS_GESTURE');
  assert.equal(tracker.count, 0);

  // The person's click: the service runs with ctx.activation true and the params without the flags.
  fire({ type: 'click', isTrusted: true });
  res = await api.request('media.share', Object.assign({ id: 'm1' }, flags));
  assert.equal(res.ok, true);
  const call = svc.media.ran('media.share')[0];
  assert.equal(call.ctx.activation, true);
  assert.deepEqual(Object.keys(call.params), ['id'], 'the activation flags were removed');
  // Not consumed within the window (a card that follows still sees it), gone after it.
  c.advance(ACTIVATION_WINDOW_MS);
  assert.equal((await api.request('media.delete', { id: 'm1' })).ok, true);
  c.advance(1);
  assert.equal((await api.request('media.delete', { id: 'm1' })).error.code, 'E_NEEDS_GESTURE');
  // The browser's own transient activation counts where the floor browsers report it.
  nav.userActivation = { isActive: true };
  assert.equal((await api.request('media.delete', { id: 'm1' })).ok, true);
  nav.userActivation = { isActive: false };
  unwatch();
  assert.equal(handlers.length, 8, 'unwatch removes through removeEventListener (the fake keeps its list)');
  assert.deepEqual(stripActivationFlags({ a: 1, gesture: true }), { a: 1 });
});

test('conditional UI: me.get and the contact list once per sign-in session, presence only when public, sign-out only with forget', async () => {
  const state = { signedIn: true };
  const c = clock();
  let active = false;
  const api = new MwApi({ activation: () => active, now: c.now, mod: false });
  const id = identityFake(state);
  api.mount('identity', id);
  const chat = recorder(API_METHODS.filter((m) => m.startsWith('chat.')));
  api.mount('chat', chat);
  await api.identity.refresh();

  for (const m of ['me.get', 'chat.contacts.list', 'chat.dm.history']) {
    assert.equal(CONDITIONAL_UI[m], 'session');
    assert.equal((await api.request(m, {})).error.code, 'E_NEEDS_GESTURE', m + ': the first call needs the card');
    active = true;
    assert.equal((await api.request(m, {})).ok, true, m);
    active = false;
    assert.equal((await api.request(m, {})).ok, true, m + ': read afterwards in this session');
  }
  // Signing out ends the session: the next me.get needs a click again.
  state.signedIn = false;
  id.emit('auth', { state: 'guest' });
  await api.identity.refresh();
  state.signedIn = true;
  id.emit('auth', { state: 'signed-in' });
  await api.identity.refresh();
  assert.equal((await api.request('me.get', {})).error.code, 'E_NEEDS_GESTURE', 'a new session asks again');

  assert.equal((await api.request('chat.presence.set', { on: true })).ok, true, 'presence to contacts: no card');
  assert.equal((await api.request('chat.presence.set', { on: true, public: true })).error.code, 'E_NEEDS_GESTURE');
  assert.equal((await api.request('auth.signOut', {})).ok, true, 'a plain sign-out needs no click');
  assert.equal((await api.request('auth.signOut', { forget: true })).error.code, 'E_NEEDS_GESTURE');
  assert.equal(needsActivation('consent.request', {}), false, 'consent.request keeps its v0.2.1 behaviour (its card takes the click)');
  assert.equal(needsActivation('db.get', {}), false);
});

test('the boundary order: unknown, shape, host-only, gesture, read-only hub ledger, rate, then the service', async () => {
  const prompts = [];
  const ui = { prompt: async (k) => { prompts.push(k); return true; } };
  // Unknown and loader-only first.
  let p = page({ hostOnly: true, ui });
  assert.equal((await p.api.request('nope.nothing', {})).error.code, 'E_BAD_REQUEST');
  assert.equal((await p.api.request('keys.export', {})).error.code, 'E_BAD_REQUEST');
  // Shape before host-only: a non-JSON param is E_LIMIT even for a method host-only mode refuses.
  assert.equal((await p.api.request('chat.enable', { x: () => 1 })).error.code, 'E_LIMIT');
  // Host-only before the gesture and before any card or request (E-CH-6).
  for (const m of HOST_ONLY_METHODS) {
    const res = await p.api.request(m, paramsFor(m));
    assert.equal(res.error.code, 'E_HOST_ONLY', m);
    assert.equal(serviceCalls(p.svc, m), 0, m);
  }
  assert.deepEqual(prompts, [], 'host-only opened no card');
  // A host-only page still reads and writes its ledger.
  assert.equal((await p.api.request('db.get', { key: 'k' })).ok, true);

  // The gesture before the service's own rules: a reader's ban without a click is E_NEEDS_GESTURE (docs/SDK.md).
  p = page({ node: fakeNode({ role: 'reader' }) });
  p.api.unmount('mod');
  const { createModService } = await import('../../src/loader/mod.js');
  p.api.mount('mod', createModService({ api: p.api }));
  assert.equal((await p.api.request('mod.ban', { pub: PUB })).error.code, 'E_NEEDS_GESTURE');
  let active = true;
  p = page({ node: fakeNode({ role: 'reader' }), activation: () => active, ui });
  p.api.unmount('mod');
  p.api.mount('mod', createModService({ api: p.api }));
  assert.equal((await p.api.request('mod.ban', { pub: PUB })).error.code, 'E_NOT_MODERATOR', 'with a click the service rule answers');

  // The gesture before the rate limit: after 20 writes a ban without a click is still E_NEEDS_GESTURE.
  active = false;
  p = page({ signedIn: true, activation: () => active });
  await p.api.identity.refresh();
  for (let i = 0; i < 20; i++) assert.equal((await p.api.request('db.append', { name: 'g', value: i })).ok, true);
  assert.equal((await p.api.request('db.append', { name: 'g', value: 'x' })).error.code, 'E_RATE');
  assert.equal((await p.api.request('mod.ban', { pub: PUB })).error.code, 'E_NEEDS_GESTURE');
  active = true;
  assert.equal((await p.api.request('mod.ban', { pub: PUB })).error.code, 'E_RATE', 'the ban counts as a ledger write');
  assert.equal((await p.api.request('db.get', { key: 'k' })).ok, true, 'reads are never limited');

  // A hub ledger without an owner on this hub is read only (R 3.1.4); owner.policy is not refused there.
  p = page({ readOnly: true, activation: () => true });
  assert.equal((await p.api.request('db.set', { key: 'k', value: 1 })).error.code, 'E_POLICY');
  assert.equal(p.node.calls.length, 0);
  assert.equal((await p.api.request('owner.policy', { writers: 'owner' })).ok, true, 'answered by the owner path (here the fake mod service)');
});

test('mw.ready() has the R 2.11.2 shape; features come from _mw.cfg; auth and identity follow the service', async () => {
  const cfg = { chat: true, files: 'on', media: false, records: 'sealed', requests: true };
  const node = fakeNode();
  node.state.kv.set('_mw.cfg', { v: cfg, h: H, author: PUB, ts: 1 });
  const state = { signedIn: false };
  const api = new MwApi({ node, mod: false, info: { siteId: 'mw1:' + 'a'.repeat(27), btih: 'f'.repeat(40), mode: 'shell', owner: PUB, unmoderated: false } });
  api.mount('identity', identityFake(state));
  await api.identity.refresh();
  let info = (await api.request('ready', {})).result;
  assert.deepEqual(Object.keys(info), ['siteId', 'btih', 'mode', 'auth', 'identity', 'role', 'peers', 'height', 'owner', 'unmoderated', 'features']);
  assert.equal(info.auth, 'guest');
  assert.equal(info.identity, null);
  assert.deepEqual(info.features, { chat: true, files: true, media: false, records: true, requests: true, calls: false });
  assert.equal(info.role, 'writer');
  assert.equal(info.height, 7);
  state.signedIn = true;
  await api.identity.refresh();
  info = (await api.request('ready', {})).result;
  assert.equal(info.auth, 'signed-in');
  assert.deepEqual(info.identity, { pub: PUB, short: 'abcd1234', name: null, mode: 'private' });
  assert.deepEqual(featuresOf({}), { chat: false, files: false, media: false, records: false, requests: false, calls: false }, 'every feature is off by default');
  assert.deepEqual(featuresOf({ chat: 'off', records: { mode: 'sealed' } }), { chat: false, files: false, media: false, records: true, requests: false, calls: false });
});

test('implicit sign-in (R 2.4.1): a guest\'s first write opens the sign-in card; cancelled, nothing is written and no card for 10 s', async () => {
  const c = clock();
  const state = { signedIn: false };
  const cards = [];
  let answer = false;
  const ui = { prompt: async (kind) => { cards.push(kind); if (answer) state.signedIn = true; return answer; } };
  const node = fakeNode();
  const api = new MwApi({ node, ui, now: c.now, mod: false });
  api.mount('identity', identityFake(state));
  await api.identity.refresh();
  assert.equal(api.identity.mode(), 'v03');
  let res = await api.request('db.append', { name: 'guestbook', value: 'hi' });
  assert.equal(res.error.code, 'E_NOT_SIGNED_IN');
  assert.deepEqual(cards, ['signin']);
  assert.equal(node.calls.length, 0, 'nothing written');
  res = await api.request('db.set', { key: 'k', value: 1 });
  assert.equal(res.error.code, 'E_NOT_SIGNED_IN');
  assert.deepEqual(cards, ['signin'], 'no second card within the cooldown');
  c.advance(SIGNIN_COOLDOWN_MS + 1);
  answer = true;
  res = await api.request('db.append', { name: 'guestbook', value: 'hi' });
  assert.equal(res.ok, true, 'signed in from the card: the write goes on');
  assert.deepEqual(cards, ['signin', 'signin']);
  assert.deepEqual(node.calls, [['append', 'guestbook', 'hi']]);
  // Reads never ask.
  state.signedIn = false;
  await api.identity.refresh();
  assert.equal((await api.request('db.get', { key: 'k' })).ok, true);
  assert.deepEqual(cards, ['signin', 'signin']);
});

test('auth.signIn: a popup the browser blocked falls back to the loader\'s own Sign in card', async () => {
  const state = { signedIn: false };
  const cards = [];
  const ui = { prompt: async (kind) => { cards.push(kind); state.signedIn = true; return true; } };
  const api = new MwApi({ ui, activation: () => true, mod: false });
  api.mount('identity', identityFake(state, { 'auth.signIn': () => { throw Object.assign(new Error('blocked'), { code: 'E_POPUP_BLOCKED' }); } }));
  await api.identity.refresh();
  const res = await api.request('auth.signIn', {});
  assert.equal(res.ok, true);
  assert.equal(res.result.state, 'signed-in');
  assert.deepEqual(cards, ['signin']);
  // Without a loader card the error goes to the site.
  const bare = new MwApi({ activation: () => true, mod: false });
  bare.mount('identity', identityFake({ signedIn: false }, { 'auth.signIn': () => { throw Object.assign(new Error('blocked'), { code: 'E_POPUP_BLOCKED' }); } }));
  assert.equal((await bare.request('auth.signIn', {})).error.code, 'E_POPUP_BLOCKED');
});

test('drop-in: the binding goes through the same gate (no click on the page: E_NEEDS_GESTURE; flags ignored)', async () => {
  let active = false;
  const api = new MwApi({ activation: () => active, mod: false });
  const media = recorder(API_METHODS.filter((m) => m.startsWith('media.')));
  api.mount('media', media);
  const { mw } = createBinding({ api });
  await assert.rejects(mw.media.share('m1', { to: [PUB], activation: true, isTrusted: true }), (e) => e.code === 'E_NEEDS_GESTURE' && e instanceof Error);
  assert.equal(media.calls.length, 0);
  active = true;
  assert.equal(await mw.media.share('m1', { to: [PUB], gesture: true }), 'ran media.share');
  assert.deepEqual(media.calls[0].params, { id: 'm1', to: [PUB] });
  assert.equal(media.calls[0].ctx.activation, true);
});

test('MF-27: removing another author\'s entry needs a click and the loader\'s card; removing one\'s own does not', async () => {
  const OTHER = 'p256:B' + 'Q'.repeat(86);
  const mine = 'd'.repeat(64);
  const theirs = 'e'.repeat(64);
  const node = fakeNode({ role: 'moderator' });
  node.identity = { pub: PUB };
  node.state.lists.set('guestbook', [{ h: mine, author: PUB, v: 'me', ts: 1 }, { h: theirs, author: OTHER, v: 'spam', ts: 2 }]);
  node.tombstone = async (h) => { node.calls.push(['tombstone', h]); return { h: H }; };
  let active = false;
  const cards = [];
  let answer = true;
  const api = new MwApi({ node, activation: () => active, mod: false, ui: { prompt: async (kind, data) => { cards.push([kind, data]); return answer; } }, identity: { current: () => ({ pub: PUB, short: 'abcd1234', name: null }) } });
  assert.equal((await api.request('db.tombstone', { h: mine })).ok, true, 'one\'s own entry: a plain write');
  assert.deepEqual(cards, []);
  let res = await api.request('db.tombstone', { h: theirs });
  assert.equal(res.error.code, 'E_NEEDS_GESTURE', 'another author\'s entry: a click first');
  active = true;
  answer = false;
  res = await api.request('db.tombstone', { h: theirs });
  assert.equal(res.error.code, 'E_USER_CANCELLED', 'the card was declined');
  assert.equal(cards[0][0], 'confirm');
  assert.equal(cards[0][1].danger, true);
  answer = true;
  assert.equal((await api.request('db.tombstone', { h: theirs })).ok, true);
  assert.deepEqual(node.calls, [['tombstone', mine], ['tombstone', theirs]]);
  // An entry this browser does not hold: the ledger node decides (no card can name its author).
  assert.equal((await api.request('db.tombstone', { h: 'f'.repeat(64) })).ok, true);
});
