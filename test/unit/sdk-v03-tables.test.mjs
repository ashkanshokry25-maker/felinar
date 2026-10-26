// Unit tests for the v0.3 SDK method tables (src/loader/api.js, bridge.js, src/sdk/sdk.js, sdk-static.js and the
// drop-in binding): the tables equal the INTERFACES "v0.3 (proposed)" lists plus the amendments docs/SDK.md
// names, loader-only methods are unknown over the Bridge and the binding, and every error code has a visitor
// sentence in English and French (src/loader/strings.js, lane ui).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  READ_METHODS, WRITE_METHODS, UI_METHODS, LOADER_ONLY_METHODS, API_METHODS, PUSH_EVENTS, SDK_VERSION, ERROR_CODES,
  ERROR_STRING_KEYS, METHOD_ARGS, HOST_ONLY_METHODS, SERVICE_EVENTS, NAMESPACE_SERVICE, CONDITIONAL_UI, GESTURE_EXEMPT,
  UI_CARD_KINDS, MwApi, classOf, cardFor
} from '../../src/loader/api.js';
import { Bridge, BRIDGE_METHODS, TRANSPORT_EVENTS } from '../../src/loader/bridge.js';
import * as sdk from '../../src/sdk/sdk.js';
import staticMw, { SDK_VERSION as STATIC_VERSION } from '../../src/sdk/sdk-static.js';
import { createBinding } from '../../src/dropin/binding.js';
import { ERROR_TEXT, V03_ERROR_CODES, CARD_TEXT } from '../../src/loader/strings.js';

const ROOT = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');

// ---- what the specs say ---------------------------------------------------------------------------

/** The v0.3 block of INTERFACES "src/loader/api.js, bridge.js, src/sdk/sdk.js (v0.3)". */
function interfacesBlock() {
  const text = read('docs/INTERFACES.md');
  const start = text.indexOf('### src/loader/api.js, bridge.js, src/sdk/sdk.js (v0.3)');
  assert.ok(start > 0, 'INTERFACES has the v0.3 api.js section');
  const open = text.indexOf('```', start);
  const close = text.indexOf('```', open + 3);
  const block = text.slice(open + 3, close);
  const list = (name) => {
    const m = new RegExp(name + '\\s*\\+?=\\s*\\[([^\\]]*)\\]').exec(block);
    assert.ok(m, name + ' is in the block');
    return Array.from(m[1].matchAll(/'([^']+)'/g)).map((x) => x[1]);
  };
  const version = /SDK_VERSION\s*=\s*'([^']+)'/.exec(block);
  return { ui: list('UI_METHODS'), read: list('READ_METHODS'), write: list('WRITE_METHODS'), loaderOnly: list('LOADER_ONLY_METHODS'), push: list('PUSH_EVENTS'), version: version && version[1] };
}

/** 'me.get(first per session)' -> 'me.get'; 'chat.group.*' -> the five group methods of R 2.11.2. */
function normalize(names) {
  const out = [];
  for (const n of names) {
    const base = n.replace(/\(.*\)$/, '');
    if (base === 'chat.group.*') out.push('chat.group.create', 'chat.group.invite', 'chat.group.remove', 'chat.group.leave', 'chat.group.send');
    else out.push(base);
  }
  return out;
}

// v0.2.1 (INTERFACES "src/loader/api.js [changed in v0.2.1: A4]" and ARCHITECTURE 9): mod.ban moved to UI (MF-27).
const V021_READ = ['ready', 'db.get', 'db.list', 'net.peers', 'site.info', 'consent.state'];
const V021_WRITE = ['db.set', 'db.del', 'db.append', 'db.tombstone', 'identity.setName', 'owner.policy'];
const V021_UI = ['consent.request'];
const V021_PUSH = ['state', 'peers', 'progress', 'status', 'sync', 'pow'];

// Methods R 2.11.2 and 2.9.11 name that the INTERFACES lists leave unclassified, and the followed-ledger
// amendment (docs/SDK.md "Amendment to R 2.11.2: followed ledgers"). Each one is listed in docs/SDK.md.
// v0.3 C2 (lane wire-ui, docs/deviations/wire-ui.md): calls and the seeding side of mw.net.
const C2 = {
  read: ['calls.state', 'calls.list', 'net.seeding'],
  write: ['calls.decline', 'calls.hangup', 'calls.mute', 'calls.camera'],
  ui: ['calls.start', 'calls.accept', 'calls.screen', 'net.dock', 'net.keep'],
};
const C2_METHODS = C2.read.concat(C2.write, C2.ui);
const AMENDMENT = {
  read: ['db.getMine', 'db.listBy', 'db.snapshot', 'hub.list', 'chat.requests.list', 'chat.contacts.verify', 'files.preview'],
  write: ['chat.disable', 'chat.contacts.add', 'chat.contacts.remove', 'chat.contacts.block', 'chat.contacts.unblock',
    'chat.requests.accept', 'chat.requests.decline', 'chat.dm.keepHistory', 'chat.room.join', 'chat.room.leave',
    'files.fetch', 'files.stopSharing', 'files.pinRequest', 'media.pinRequest', 'hub.follow', 'hub.unfollow'],
  ui: ['auth.signOut', 'chat.contacts.list', 'chat.dm.history', 'files.enable', 'files.remove', 'hub.createPage'],
};

// Every method path R 2.11.2 and R 2.9.11 name (transcribed from docs/review/V03-DESIGN-REVIEW.md).
const R_METHODS = [
  'ready', 'auth.signIn', 'auth.signOut', 'auth.state', 'auth.prove', 'auth.verify', 'auth.signInServer',
  'identity.current', 'identity.setName', 'identity.backupStatus', 'identity.openIdentity',
  'me.get', 'me.set', 'me.del', 'me.sync', 'me.erase',
  'db.get', 'db.set', 'db.del', 'db.list', 'db.append', 'db.tombstone', 'db.setMine', 'db.getMine', 'db.listBy',
  'mod.ban', 'mod.unban', 'mod.tombstoneMany', 'mod.queue', 'mod.decide',
  'chat.enable', 'chat.disable', 'chat.state', 'chat.presence.set', 'chat.presence.list',
  'chat.contacts.list', 'chat.contacts.add', 'chat.contacts.remove', 'chat.contacts.block', 'chat.contacts.unblock', 'chat.contacts.verify',
  'chat.requests.list', 'chat.requests.accept', 'chat.requests.decline', 'chat.requests.setOpen',
  'chat.dm.send', 'chat.dm.history', 'chat.dm.keepHistory', 'chat.room.join', 'chat.room.leave', 'chat.room.send',
  'chat.group.create', 'chat.group.invite', 'chat.group.remove', 'chat.group.leave', 'chat.group.send',
  'chat.holder.set', 'chat.direct.connect',
  'files.enable', 'files.list', 'files.received', 'files.share', 'files.fetch', 'files.preview', 'files.save',
  'files.keepSharing', 'files.stopSharing', 'files.remove', 'files.pinRequest',
  'media.upload', 'media.list', 'media.open', 'media.close', 'media.share', 'media.revoke', 'media.delete', 'media.keepAvailable', 'media.pinRequest',
  'report.send', 'net.peers', 'site.info', 'consent.request', 'consent.state', 'owner.policy',
];
// Subscriptions and listeners of the SDK object (functions on mw, not request methods).
const LOCAL_PATHS = ['auth.onChange', 'db.subscribe', 'chat.on', 'files.on', 'media.on', 'net.on', 'calls.on'];
const HUB_METHODS = ['hub.follow', 'hub.unfollow', 'hub.list', 'hub.createPage'];

const set = (a) => new Set(a);
const sorted = (a) => Array.from(new Set(a)).sort();
const minus = (a, b) => { const s = set(b); return sorted(a.filter((x) => !s.has(x))); };

function paths(obj, prefix = '') {
  const out = [];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const p = prefix ? prefix + '.' + k : k;
    if (typeof v === 'function') out.push(p);
    else if (v && typeof v === 'object') out.push(...paths(v, p));
  }
  return out;
}

// ---- tests ------------------------------------------------------------------------------------------

test('the classes are INTERFACES v0.3 plus v0.2.1 plus the documented amendments, nothing else', () => {
  const spec = interfacesBlock();
  assert.deepEqual(sorted(READ_METHODS), sorted(V021_READ.concat(normalize(spec.read), AMENDMENT.read, C2.read)));
  assert.deepEqual(sorted(WRITE_METHODS), sorted(V021_WRITE.concat(normalize(spec.write), AMENDMENT.write, C2.write)));
  assert.deepEqual(sorted(UI_METHODS), sorted(V021_UI.concat(normalize(spec.ui), AMENDMENT.ui, C2.ui)));
  assert.equal(WRITE_METHODS.indexOf('mod.ban'), -1, 'MF-27: mod.ban is a UI method (the moderator card)');
  // The conditional UI methods of INTERFACES ('me.get(first per session)', 'chat.presence.set(public)') are conditional here.
  assert.equal(CONDITIONAL_UI['me.get'], 'session');
  assert.equal(CONDITIONAL_UI['chat.presence.set'], 'public');
  assert.deepEqual(GESTURE_EXEMPT, ['consent.request']);
  // Disjoint classes, and the API is exactly their union.
  const all = READ_METHODS.concat(WRITE_METHODS, UI_METHODS);
  assert.equal(new Set(all).size, all.length, 'no method is in two classes');
  assert.deepEqual(sorted(API_METHODS), sorted(all));
  for (const m of READ_METHODS) assert.equal(classOf(m), 'read', m);
  for (const m of WRITE_METHODS) assert.equal(classOf(m), 'write', m);
  for (const m of UI_METHODS) assert.equal(classOf(m), 'ui', m);
  assert.equal(classOf('write.cancel'), 'control');
  assert.deepEqual(sorted(BRIDGE_METHODS), sorted(all.concat(['write.cancel'])));
});

test('every R 2.11.2 and R 2.9.11 method exists, with an argument table entry; the hub amendment adds four', () => {
  const api = set(API_METHODS);
  for (const m of R_METHODS) assert.ok(api.has(m), m + ' is in the method table');
  assert.deepEqual(minus(API_METHODS, R_METHODS), sorted(HUB_METHODS.concat(['db.snapshot'], C2_METHODS)), 'only the amendment and C2 add methods');
  assert.deepEqual(sorted(Object.keys(METHOD_ARGS)), sorted(API_METHODS), 'METHOD_ARGS names exactly the API methods');
  // The review's code block itself: every mw.<path>( it shows is a method or a listener.
  const review = read('docs/review/V03-DESIGN-REVIEW.md');
  const block = review.slice(review.indexOf('### 2.11.2 Methods'), review.indexOf('## 2.12 '));
  const media = review.slice(review.indexOf('### 2.9.11 SDK'), review.indexOf('### 2.9.12'));
  for (const m of (block + media).matchAll(/mw\.([a-z]+(?:\.[a-zA-Z]+)+)\(/g)) {
    assert.ok(api.has(m[1]) || LOCAL_PATHS.indexOf(m[1]) >= 0, 'R names mw.' + m[1]);
  }
});

test('LOADER_ONLY_METHODS, PUSH_EVENTS and SDK_VERSION are the INTERFACES ones; the versions agree everywhere', () => {
  const spec = interfacesBlock();
  assert.deepEqual(sorted(LOADER_ONLY_METHODS), sorted(spec.loaderOnly));
  for (const m of LOADER_ONLY_METHODS) assert.equal(classOf(m), null, m + ' is not a method');
  assert.deepEqual(sorted(PUSH_EVENTS), sorted(V021_PUSH.concat(spec.push, ['hub', 'calls'])), "'hub' is the followed-ledger amendment, 'calls' is C2");
  assert.deepEqual(TRANSPORT_EVENTS, ['wait'], 'the keep-alive push is a transport event, not a site event');
  for (const s of Object.values(SERVICE_EVENTS)) assert.ok(PUSH_EVENTS.indexOf(s.push) >= 0, s.push);
  assert.equal(spec.version, '0.3.0');
  assert.equal(SDK_VERSION, spec.version);
  assert.equal(sdk.SDK_VERSION, spec.version);
  assert.equal(STATIC_VERSION, spec.version);
  const { mw } = createBinding({ api: new MwApi({}) });
  assert.equal(mw.version, spec.version);
  assert.equal(staticMw.version, spec.version);
});

test('loader-only methods are unknown over the Bridge (E_BAD_REQUEST) and no service sees them', async () => {
  const seen = [];
  const api = new MwApi({ activation: () => true });
  const trap = {};
  for (const m of LOADER_ONLY_METHODS.concat(['identity.root'])) trap[m] = async () => { seen.push(m); return 'leaked'; };
  api.mount('identity', { methods: Object.assign({ 'auth.state': async () => 'guest', 'identity.current': async () => null }, trap), on: () => () => {} });
  api.mount('media', { methods: Object.assign({}, trap), on: () => () => {} });
  const frameWin = {};
  const sent = [];
  const port = { postMessage: (m) => sent.push(m), start() {}, close() {} };
  const bridge = new Bridge({ iframe: { contentWindow: frameWin }, api, win: { addEventListener() {}, removeEventListener() {}, location: { origin: 'https://x.test' } }, origin: 'https://x.test', activation: () => true });
  bridge.attach();
  assert.equal(bridge.handleWindowMessage({ source: frameWin, origin: 'https://x.test', data: { mw: 'hello', proto: 1 }, ports: [port] }), true);
  let id = 1;
  for (const method of LOADER_ONLY_METHODS) {
    // Every way a site might dress the call up: params, a gesture flag, the positional form.
    for (const params of [{}, { passphrase: 'long enough', activation: true, isTrusted: true }, { args: ['x'] }]) {
      const rid = id++;
      await bridge.handleRequest({ id: rid, method, params });
      const reply = sent.find((m) => m.id === rid);
      assert.ok(reply, method + ' answered');
      assert.equal(reply.ok, false, method);
      assert.equal(reply.error.code, 'E_BAD_REQUEST', method);
    }
    // The table call (drop-in binding path) refuses it the same way.
    const res = await api.request(method, {});
    assert.deepEqual([res.ok, res.error.code], [false, 'E_BAD_REQUEST'], method);
  }
  assert.deepEqual(seen, [], 'no service method ran');
  bridge.destroy();
});

test('no SDK object exposes a loader-only method: the binding, the SDK facade and the static stub', () => {
  const { mw } = createBinding({ api: new MwApi({}) });
  const facade = sdk.createSdk({ win: { location: { origin: 'https://x.test' }, parent: null }, doc: null, global: {} });
  for (const obj of [mw, facade, staticMw]) {
    const all = set(paths(obj));
    for (const m of LOADER_ONLY_METHODS) assert.equal(all.has(m), false, m);
    assert.equal(all.has('consent.accept'), false);
    assert.equal(all.has('identity.export'), false);
  }
});

test('the binding, the SDK facade and the static stub expose every method and listener, at the same paths', () => {
  const want = sorted(API_METHODS.filter((m) => m !== 'ready' && m !== 'db.snapshot').concat(LOCAL_PATHS, ['ready']));
  const { mw } = createBinding({ api: new MwApi({}) });
  const facade = sdk.createSdk({ win: { location: { origin: 'https://x.test' }, parent: null }, doc: null, global: {} });
  assert.deepEqual(sorted(paths(mw)), want, 'drop-in binding');
  assert.deepEqual(sorted(paths(facade)), want, 'SDK facade');
  assert.deepEqual(sorted(paths(staticMw)), want, 'static stub (a site that calls any method on a static copy gets an answer)');
});

/** A shell page: the real Bridge in the parent window, the SDK facade in the site frame (a same-origin iframe). */
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

/** Positional test arguments for a method from its METHOD_ARGS names, and the params the service must get. */
function argsFor(method) {
  const PUB = 'p256:B' + 'A'.repeat(86);
  const values = { pub: PUB, author: PUB, authors: [PUB], on: true, open: true, file: new Blob(['x']), h: 'c'.repeat(64), proof: { kind: 'local' } };
  const args = [];
  const want = {};
  for (const n of METHOD_ARGS[method]) {
    if (n === '...') { args.push({ opt: 'o-' + method }); want.opt = 'o-' + method; continue; }
    const v = values[n] !== undefined ? values[n] : n + '-value';
    args.push(v);
    want[n] = v;
  }
  return { args, want };
}

function fnAt(obj, method) {
  let at = obj;
  for (const part of method.split('.')) at = at ? at[part] : undefined;
  return at;
}

test('the SDK facade (over the Bridge) and the binding send every v0.3 method with the METHOD_ARGS names', async () => {
  // Every service method of the table answers from a recorder; the moderation and hub services too.
  const record = [];
  const api = new MwApi({ activation: () => true, mod: false, cfg: () => ({}) });
  const byService = {};
  for (const m of API_METHODS) {
    const svc = NAMESPACE_SERVICE[m.split('.')[0]] || (['db.setMine', 'db.getMine', 'db.listBy'].indexOf(m) >= 0 ? 'mod' : null);
    if (!svc || m === 'identity.setName') continue;
    (byService[svc] = byService[svc] || []).push(m);
  }
  byService.mod = (byService.mod || []).concat(['db.setMine', 'db.getMine', 'db.listBy']);
  for (const [name, methods] of Object.entries(byService)) {
    const impl = {};
    for (const m of methods) impl[m] = async (params, ctx) => { record.push({ via: ctx && ctx.via, m, params }); return { ok: m }; };
    if (name === 'identity') { impl['auth.state'] = async () => 'guest'; impl['identity.current'] = async () => null; }
    api.mount(name, { methods: impl, on: () => () => {} });
  }
  const { mw: facade, bridge } = await shellSdk(api);
  const { mw: binding } = createBinding({ api });
  const skip = new Set(['auth.state', 'identity.current']); // answered by the loader's own binding state
  let checked = 0;
  for (const m of Object.keys(byService).flatMap((k) => byService[k])) {
    if (skip.has(m)) continue;
    for (const [label, obj] of [['facade', facade], ['binding', binding]]) {
      const fn = fnAt(obj, m);
      assert.equal(typeof fn, 'function', label + ' has ' + m);
      const { args, want } = argsFor(m);
      record.length = 0;
      await fn(...args);
      const got = record.find((r) => r.m === m);
      assert.ok(got, label + ': ' + m + ' reached its service');
      const params = Object.assign({}, got.params);
      if (want.file) { assert.ok(params.file && typeof params.file.size === 'number', label + ': ' + m + ' carries the Blob'); delete params.file; delete want.file; }
      // chat.room.join defaults its name in the binding only when it is omitted; here it is given.
      assert.deepEqual(params, want, label + ': ' + m);
      checked++;
    }
  }
  assert.ok(checked > 120, 'checked ' + checked + ' calls');
  bridge.destroy();
});

test('error codes: the R 2.11.2 additions in order, the same list in the SDK, a sentence for each in English and French', () => {
  const review = read('docs/review/V03-DESIGN-REVIEW.md');
  const line = /\*\*Error codes added:\*\*([^\n]+)/.exec(review);
  assert.ok(line, 'the review lists the added codes');
  // The list ends where the line goes on to SDK_VERSION and its string examples.
  const listed = line[1].slice(0, line[1].indexOf('SDK_VERSION'));
  const added = Array.from(listed.matchAll(/`(E_[A-Z_]+)`/g)).map((x) => x[1]);
  assert.equal(added.length, 29);
  assert.deepEqual(ERROR_CODES.slice(ERROR_CODES.length - 6 - added.length, ERROR_CODES.length - 6), added);
  assert.deepEqual(ERROR_CODES.slice(-6), ['E_BUSY', 'E_DECLINED', 'E_NO_ANSWER', 'E_MEDIA_DENIED', 'E_NO_DEVICE', 'E_CALL_FAILED'], 'the C2 call codes come last');
  assert.deepEqual(V03_ERROR_CODES, added, 'lane ui keeps the same list');
  assert.deepEqual(sdk.ERROR_CODES, ERROR_CODES);
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length);
  for (const code of ERROR_CODES) {
    const key = ERROR_STRING_KEYS[code];
    assert.equal(typeof key, 'string', code + ' maps to a string key');
    assert.equal(typeof ERROR_TEXT.en[key], 'string', code + ' -> ' + key + ' (en)');
    assert.equal(typeof ERROR_TEXT.fr[key], 'string', code + ' -> ' + key + ' (fr)');
    assert.ok(ERROR_TEXT.en[key].length > 0 && ERROR_TEXT.fr[key].length > 0);
  }
  for (const code of added) assert.equal(ERROR_STRING_KEYS[code], code, code + ' has its own sentence');
  assert.deepEqual(sorted(Object.keys(ERROR_STRING_KEYS)), sorted(ERROR_CODES));
});

test('host-only methods, namespaces and loader cards are consistent with the tables and lane ui', async () => {
  const api = set(API_METHODS);
  for (const m of HOST_ONLY_METHODS) assert.ok(api.has(m), m);
  for (const m of HOST_ONLY_METHODS) assert.ok(/^(chat|files|media|report|calls|net)\./.test(m), m + ' reaches peers');
  for (const m of API_METHODS) {
    const ns = m.split('.')[0];
    if (['ready', 'db', 'net', 'site', 'consent', 'owner'].indexOf(ns) >= 0) continue;
    assert.ok(NAMESPACE_SERVICE[ns], m + ' has a service');
  }
  // The loader card kinds are lane ui's CARD_KINDS; every consent card a prompt maps to has its text in en and fr.
  const ui = await import('../../src/loader/ui.js');
  assert.deepEqual(sorted(UI_CARD_KINDS), sorted(ui.CARD_KINDS));
  const prompts = ['chat.enable', 'chat.ck.ledger', 'chat.presence.public', 'chat.requests.open', 'chat.holder', 'files-enable', 'file-help-share', 'media-keep-available'];
  for (const kind of prompts) {
    const card = cardFor(kind, {});
    assert.equal(card.kind, 'consent', kind);
    assert.equal(typeof CARD_TEXT.en[card.data.card], 'string', kind + ' -> ' + card.data.card + ' (en)');
    assert.equal(typeof CARD_TEXT.fr[card.data.card], 'string', kind + ' -> ' + card.data.card + ' (fr)');
  }
  assert.equal(cardFor('no-such-prompt', {}), null, 'a prompt without a card is answered no');
});

test('docs/SDK.md names every method, every error code, the amendment and the two binding rules', () => {
  const doc = read('docs/SDK.md');
  for (const m of API_METHODS) assert.ok(doc.indexOf('`' + m) >= 0 || doc.indexOf('mw.' + m) >= 0, 'docs/SDK.md names ' + m);
  for (const code of ERROR_CODES) assert.ok(doc.indexOf(code) >= 0, 'docs/SDK.md names ' + code);
  assert.ok(doc.indexOf('Amendment to R 2.11.2: followed ledgers') >= 0);
  assert.ok(/never gate a security decision on `?_roles\/`?/i.test(doc), 'the _roles/ rule');
  assert.ok(doc.indexOf('Never pass a Blob from mw.files to createObjectURL in a frame or a navigation.') >= 0, 'the Blob rule');
  for (const word of ['blockchain', 'serverless', 'unstoppable', 'censorship-resistant', 'production-ready']) {
    assert.equal(doc.toLowerCase().indexOf(word), -1, 'wording rule: ' + word);
  }
  assert.equal(/[—“”‘’]/.test(doc), false, 'no em dashes or curly quotes');
});
