// Usage reports of the identity page (plan obs-2026-11-02, lane L4; docs/OBSERVABILITY.md). Four things are held here:
//   1. the reporter of src/idp/obs-client.js: the batch is the wire of the plan and passes the Worker's rules, nothing leaves before
//      the person agreed, the limits, the retries, the final flush, the masks;
//   2. the identity page: off without an endpoint (not one byte of its behaviour changes), the events of a sign-in and of the
//      settings page, and nothing a person typed, no pointer, no key and no site in any batch;
//   3. the sign-in client: the opener's report id goes to a page that said it reports, and to no other;
//   4. tools/build-idp.mjs --obs: the endpoint is data on the page and one source in connect-src, and a build without it is the
//      build it always was.
// Run: node --test test/unit/idp-obs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  createReporter, safeField, uaOf, hideHook, instrumentCards, instrumentHandlers, cardOutcome, wantWord, CARD_KINDS, HANDLER_NAMES, OBS_LIMITS, BEACON_GRACE_MS,
} from '../../src/idp/obs-client.js';
import { createIdp, readObsEndpoint, OBS_CLOSE_WAIT_MS } from '../../src/idp/idp.js';
import { staticRoute, installRoutes } from '../../src/idp/sw.js';
import { createCards } from '../../src/idp/cards.js';
import { STRINGS, t as idpT } from '../../src/idp/strings.js';
import { openIdoStore } from '../../src/idp/store.js';
import * as client from '../../src/identity/client.js';
import { buildIdp, checkObsOrigin, headersWithObs, pageFor, sriFor, OBS_ORIGIN_MAX } from '../../tools/build-idp.mjs';
import { UsageError } from '../../tools/lib.mjs';
import { FakeDocument } from './dropin-fake-dom.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const IDP = 'http://localhost:9555';
const SITE = 'https://shop.example';
const OBS = 'https://obs.example.org';
const SID = 'abcdefgh2345';
const tick = () => new Promise((r) => setImmediate(r));

async function waitFor(cond, what, deadlineMs = 10000) {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out after ' + deadlineMs + ' ms waiting for ' + what);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

// ------------------------------------------------------------------------------------------------ helpers

/** problems(batch) -> [text]: the rules the Worker applies to a batch (plan section 2.7), written out again here. */
function problems(b) {
  const out = [];
  const bad = (why) => out.push(why);
  if (!b || typeof b !== 'object' || Array.isArray(b)) return ['not an object'];
  const keys = ['v', 'sid', 'seq', 'page', 'build', 'loader', 'site', 'who', 'net', 'ua', 't0', 'events'];
  if (JSON.stringify(Object.keys(b)) !== JSON.stringify(keys)) bad('keys ' + Object.keys(b).join());
  if (b.v !== 1) bad('v');
  if (!/^[a-z2-9]{12}$/.test(b.sid)) bad('sid');
  if (!Number.isInteger(b.seq) || b.seq < 0 || b.seq > 1e9) bad('seq');
  if (['site', 'door', 'hub', 'idp'].indexOf(b.page) < 0) bad('page');
  if (typeof b.build !== 'string' || !/^[0-9a-f]{0,16}$/.test(b.build)) bad('build');
  if (typeof b.loader !== 'string' || b.loader.length > 16 || !/^(?:[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:[-+][0-9A-Za-z.]{1,8})?)?$/.test(b.loader)) bad('loader');
  if (typeof b.site !== 'string' || !/^[0-9a-f]{0,8}$/.test(b.site)) bad('site');
  if (b.who !== null && !/^[a-km-np-z2-9]{4}-[a-km-np-z2-9]{4}$/.test(String(b.who))) bad('who');
  if (b.net !== null) bad('net');
  if (!b.ua || ['chromium', 'firefox', 'webkit', 'other'].indexOf(b.ua.browser) < 0 || typeof b.ua.mobile !== 'boolean' || Object.keys(b.ua).length !== 2) bad('ua');
  if (!Number.isInteger(b.t0)) bad('t0');
  if (!Array.isArray(b.events) || b.events.length < 1 || b.events.length > 100) return out.concat('events');
  for (const e of b.events) {
    if (!Number.isInteger(e.t) || e.t < 0) bad('event t');
    if (!/^[a-z][a-z0-9.-]{1,48}$/.test(e.n)) bad('event name ' + e.n);
    const rest = Object.keys(e).filter((k) => k !== 't' && k !== 'n');
    if (rest.length > 12) bad('event keys');
    for (const k of rest) {
      const v = e[k];
      const okValue = v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 200);
      if (!okValue) bad('event value ' + k);
    }
  }
  return out;
}

function recorder({ ok = true } = {}) {
  const sent = [];
  const send = (url, text, opts) => {
    sent.push({ url, text, body: JSON.parse(text), final: Boolean(opts && opts.final) });
    return typeof ok === 'function' ? ok(sent.length) : ok;
  };
  return {
    sent, send,
    events: () => sent.flatMap((s) => s.body.events),
    names: () => sent.flatMap((s) => s.body.events).map((e) => e.n),
  };
}

function fakeTimers() {
  const pending = new Map();
  let n = 0;
  return {
    pending,
    setTimeout: (fn, ms) => { const id = ++n; pending.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { pending.delete(id); },
    fire() { const all = Array.from(pending.values()); pending.clear(); for (const x of all) x.fn(); },
  };
}

function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

/** A random() that walks the alphabet, so the session id is not all one letter. */
function walker() {
  let i = 0;
  return () => ((i++ * 7) % 34) / 34;
}

function reporter(extra = {}) {
  const rec = recorder();
  const timers = fakeTimers();
  const clock = makeClock();
  const r = createReporter(Object.assign({
    endpoint: OBS, build: 'bbcb82098cda', loader: '0.3.0', now: clock.now, random: walker(), send: rec.send,
    nav: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0' },
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  }, extra));
  return { r, rec, timers, clock };
}

function scriptedCards(script = {}) {
  const calls = [];
  const answer = (name, data) => {
    calls.push({ name, data });
    const s = script[name];
    if (typeof s === 'function') return s(data, calls);
    if (s !== undefined) return s;
    switch (name) {
      case 'signin': return { action: 'continue', mode: { kind: 'private' }, stay: false, sharedComputer: false, hub: null };
      case 'chooseUnlock': return { method: 'passkey', nickname: 'test' };
      case 'foundPosts': return 'continue';
      case 'busy': case 'close': return undefined;
      default: return true;
    }
  };
  return new Proxy({ calls, lang: 'en' }, { get(t, k) { if (k in t) return t[k]; return async (data) => answer(k, data); } });
}

function fakePasskey({ uv = true } = {}) {
  const prf = webcrypto.getRandomValues(new Uint8Array(32));
  const pk = {
    uv,
    async capabilities() { return { webauthn: true, platform: true, prf: true }; },
    async create() { return { credId: 'Y3JlZA', prf, prfEnabled: true, uv: true }; },
    async prfFor({ created }) { return { prf: created.prf, uv: true, credId: created.credId }; },
    async get() { return { credId: 'Y3JlZA', prf, uv: pk.uv }; },
  };
  return pk;
}

function randomRequestId() {
  return Buffer.from(webcrypto.getRandomValues(new Uint8Array(16))).toString('base64url');
}

async function newRequest({ want = ['keys'], purpose = 'site', extra = {} } = {}) {
  const box = await client.newBoxKey();
  const req = Object.assign({ v: 1, t: 'mw-signin-req', requestId: randomRequestId(), purpose, want, epk: box.pub }, extra);
  return { box, req };
}

/** A sign-in window opened by `openerWin`, as in test/unit/idp-protocol.test.mjs; `log` records the order of what leaves it. */
function idoWindow({ openerWin = null, hash = '', log = [] } = {}) {
  const listeners = new Set();
  const w = {
    opener: openerWin,
    location: { origin: IDP, hash, pathname: '/signin', replaced: [], replace(u) { log.push('replace'); this.replaced.push(u); } },
    history: { replaceState() {} },
    closed: false,
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(type, fn) { listeners.delete(fn); },
    close() { log.push('close'); w.closed = true; },
    deliver(ev) { for (const fn of Array.from(listeners)) fn(ev); },
  };
  return w;
}

function opener(log = []) {
  const o = { posts: [], postMessage(msg, target) { log.push(msg && msg.t === 'mw-signin-res' ? 'answer' : 'post'); o.posts.push({ msg, target }); } };
  return o;
}

/**
 * page({ obs, cards, sharedOrigins, hash, ... }) -> a sign-in window, a document, a clock and an identity page wired to a recorder.
 * obs: the endpoint (the attribute data-mw-obs on <html>), or false for a page without one.
 */
async function page({ obs = OBS, cards = scriptedCards(), passkey = fakePasskey(), store, sharedOrigins, hash = '', withOpener = true, ok = true, clock = makeClock(), doc = new FakeDocument(), wasm = true, idpTimers } = {}) {
  const log = [];
  const op = opener(log);
  const win = idoWindow({ openerWin: withOpener ? op : null, hash, log });
  doc.documentElement.setAttribute('data-mw-idp', '1');
  if (obs) doc.documentElement.setAttribute('data-mw-obs', obs);
  const rec = recorder({ ok });
  const wrapped = (url, text, opts) => { log.push(opts && opts.final ? 'send-final' : 'send'); return rec.send(url, text, opts); };
  const timers = fakeTimers();
  const st = store || await openIdoStore({ memory: true });
  const idp = createIdp({
    win, doc, navigator: null, location: win.location, cards, passkey, store: st, wasm, ios: false, standalone: false,
    build: { version: '0.3.0', id: 'bbcb82098cda', hash: '', test: false }, sharedOrigins, now: clock.now,
    obsSend: wrapped, obsTimers: timers, obsRandom: walker(),
    setTimeout: idpTimers && idpTimers.setTimeout, clearTimeout: idpTimers && idpTimers.clearTimeout,
  });
  return { idp, win, doc, op, log, rec, timers, clock, cards, store: st };
}

/** popup(p, req, origin) -> the sign-in result of one popup sign-in on page p (the opener's message is delivered as the browser would). */
async function popup(p, req, origin = SITE) {
  const done = p.idp.bootSignin();
  await tick();
  p.win.deliver({ source: p.op, origin, data: req });
  return done;
}


// ------------------------------------------------------------------------------------------------ 1. the reporter

test('a batch is the wire of the plan and passes the Worker\'s rules; nothing leaves before allow(true), then the waiting events go first, in order', () => {
  const { r, rec, timers, clock } = reporter();
  r.event('ready');
  clock.advance(40);
  r.event('card', { kind: 'signin' });
  clock.advance(60);
  r.event('result', { code: 'ok', ms: 1234 });
  assert.equal(rec.sent.length, 0, 'before the first allow() events only wait in memory');
  assert.equal(timers.pending.size, 0, 'no timer runs for a page that has not agreed');
  r.flush('timer');
  r.flush('final');
  assert.equal(rec.sent.length, 0, 'not even a flush sends what the person has not agreed to');
  r.allow(true);
  assert.equal(timers.pending.size, 1, 'allow() arms the one timer');
  assert.equal(timers.pending.get(1).ms, OBS_LIMITS.flushMs);
  timers.fire();
  assert.equal(rec.sent.length, 1);
  const b = rec.sent[0].body;
  assert.deepEqual(problems(b), []);
  assert.equal(rec.sent[0].url, OBS + '/e');
  assert.equal(b.page, 'idp');
  assert.equal(b.seq, 0);
  assert.equal(b.build, 'bbcb82098cda');
  assert.equal(b.loader, '0.3.0');
  assert.deepEqual([b.site, b.who, b.net], ['', null, null], 'the identity page names no site, no identity and no network type');
  assert.deepEqual(b.ua, { browser: 'firefox', mobile: false });
  assert.equal(b.t0, Math.floor(1_700_000_000_000 / 1000));
  assert.deepEqual(b.events, [{ t: 0, n: 'ready' }, { t: 40, n: 'card', kind: 'signin' }, { t: 100, n: 'result', code: 'ok', ms: 1234 }]);
  assert.equal(rec.sent[0].final, false);
  assert.deepEqual(r.inspect(), { host: 'obs.example.org', enabled: true, allowed: true, queued: 0, sent: 3, dropped: 0, batches: 1, lastOk: clock.now() });
  assert.equal(timers.pending.size, 0, 'the timer runs only while there is something queued');
});

test('the session id is 12 characters of [a-z2-9], whatever random() returns, and the next batch has the next seq', () => {
  for (const random of [walker(), () => 0, () => 0.999999, () => 1, () => NaN, () => -3, () => 7]) {
    const { r } = reporter({ random });
    assert.match(r.sid, /^[a-z2-9]{12}$/);
  }
  assert.notEqual(reporter({ random: () => 0 }).r.sid, reporter({ random: () => 0.5 }).r.sid);
  const real = createReporter({ endpoint: OBS, send: () => true });
  assert.match(real.sid, /^[a-z2-9]{12}$/, 'the default random() is the browser\'s');
  const { r, rec, timers } = reporter();
  r.allow(true);
  r.event('ready');
  timers.fire();
  r.event('card', { kind: 'signin' });
  timers.fire();
  assert.deepEqual(rec.sent.map((s) => s.body.seq), [0, 1]);
  assert.equal(new Set(rec.sent.map((s) => s.body.sid)).size, 1);
});

test('one batch holds at most 50 events and 16384 bytes; the rest waits for the next flush, in order', () => {
  const { r, rec, timers } = reporter();
  r.allow(true);
  for (let i = 0; i < 120; i++) r.event('card', { kind: 'k' + i });
  timers.fire();
  assert.equal(rec.sent[0].body.events.length, 50);
  assert.equal(timers.pending.size, 1, 'the timer runs again while events are queued');
  timers.fire();
  timers.fire();
  assert.deepEqual(rec.sent.map((s) => s.body.events.length), [50, 50, 20]);
  assert.deepEqual(rec.events().map((e) => e.kind), Array.from({ length: 120 }, (_, i) => 'k' + i));
  // Events with twelve long fields: the body stays under the byte limit and nothing is lost.
  const big = reporter();
  big.r.allow(true);
  const wide = {};
  for (let i = 0; i < 12; i++) wide['f' + i] = 'x'.repeat(200);
  for (let i = 0; i < 30; i++) big.r.event('wide', wide);
  for (let i = 0; i < 30 && big.timers.pending.size; i++) big.timers.fire();
  const oneEvent = Buffer.byteLength(JSON.stringify(big.rec.events()[0])) + 1;
  assert.ok(oneEvent > 2400, 'twelve 200-character fields make an event of ' + oneEvent + ' bytes');
  big.rec.sent.forEach((s, i) => {
    assert.ok(Buffer.byteLength(s.text) <= OBS_LIMITS.maxBodyBytes, Buffer.byteLength(s.text) + ' bytes');
    assert.deepEqual(problems(s.body), []);
    // Each batch but the last is as full as the limit allows: one more event would not have fitted.
    if (i < big.rec.sent.length - 1) assert.ok(Buffer.byteLength(s.text) + oneEvent > OBS_LIMITS.maxBodyBytes, 'batch ' + i + ' could have held another event');
  });
  assert.ok(big.rec.sent.length > 1);
  assert.equal(big.rec.events().length, 30);
});

test('the queue keeps 500 events (the oldest are dropped and counted); allow(false) drops the rest and ignores later events until allow(true)', () => {
  const { r, rec, timers } = reporter();
  for (let i = 0; i < 520; i++) r.event('card', { kind: 'k' + i });
  let s = r.inspect();
  assert.deepEqual([s.queued, s.dropped], [500, 20]);
  r.allow(false);
  s = r.inspect();
  assert.deepEqual([s.allowed, s.queued, s.dropped], [false, 0, 520]);
  r.event('card', { kind: 'after' });
  assert.equal(r.inspect().queued, 0, 'a refused page queues nothing');
  r.flush('final');
  assert.equal(rec.sent.length, 0);
  assert.equal(timers.pending.size, 0);
  r.allow(true);
  r.event('card', { kind: 'again' });
  timers.fire();
  assert.deepEqual(rec.events().map((e) => e.kind), ['again']);
});

test('a failed send keeps the batch (same seq) for the next flush, three tries in all, then drops it and counts it', async () => {
  const { r, rec, timers } = reporter();
  const failing = recorder({ ok: false });
  const sync = reporter({ send: failing.send });
  sync.r.allow(true);
  sync.r.event('ready');
  sync.r.event('card', { kind: 'signin' });
  sync.timers.fire();
  assert.equal(sync.timers.pending.size, 1, 'the batch is tried again on the next tick');
  sync.timers.fire();
  sync.timers.fire();
  assert.deepEqual(failing.sent.map((x) => x.body.seq), [0, 0, 0], 'the same batch, three times');
  assert.deepEqual(sync.r.inspect().dropped, 2);
  assert.equal(sync.timers.pending.size, 0);
  sync.r.event('card', { kind: 'next' });
  sync.timers.fire();
  assert.equal(failing.sent[3].body.seq, 1, 'a new batch has a new seq');
  // A promise that resolves false, or rejects, is a failed send too; one that resolves true is sent.
  let n = 0;
  const flaky = recorder({ ok: () => { n++; return n === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(n === 2 ? false : true); } });
  const a = reporter({ send: flaky.send });
  a.r.allow(true);
  a.r.event('ready');
  a.timers.fire();
  await tick();
  assert.equal(a.timers.pending.size, 1);
  a.timers.fire();
  await tick();
  a.timers.fire();
  await tick();
  assert.deepEqual(flaky.sent.map((x) => x.body.seq), [0, 0, 0]);
  assert.deepEqual([a.r.inspect().sent, a.r.inspect().batches, a.r.inspect().dropped], [1, 1, 0]);
  assert.equal(rec.sent.length + timers.pending.size, 0);
});

test('the final flush sends what is queued (up to four batches) with final: true, the call for fetch keepalive', () => {
  const { r, rec } = reporter();
  r.allow(true);
  for (let i = 0; i < 120; i++) r.event('card', { kind: 'k' + i });
  r.flush('final');
  assert.deepEqual(rec.sent.map((s) => [s.body.events.length, s.final]), [[50, true], [50, true], [20, true]]);
  const more = reporter();
  more.r.allow(true);
  for (let i = 0; i < 260; i++) more.r.event('card', { kind: 'k' + i });
  more.r.flush('final');
  assert.equal(more.rec.sent.length, 4, 'at most four batches in one final flush');
  assert.equal(more.r.inspect().queued, 60);
  const t = reporter();
  t.r.allow(true);
  t.r.event('ready');
  t.r.stop();
  t.r.event('card', { kind: 'late' });
  assert.deepEqual(t.rec.names(), ['ready'], 'stop() sends what it holds and ignores what comes after');
  assert.equal(t.timers.pending.size, 0);
});

test('flush() returns a promise that never rejects; the final flush settles when every batch has its answer, a failed answer included', async () => {
  const idle = reporter();
  assert.ok(idle.r.flush('final') instanceof Promise, 'a page that has not agreed: a promise, nothing sent');
  assert.equal(idle.rec.sent.length, 0);
  // Two batches, answers that come late and in the other order.
  const answers = [];
  const late = reporter({ send: (url, text) => new Promise((resolve) => { answers.push(resolve); }) });
  late.r.allow(true);
  for (let i = 0; i < 60; i++) late.r.event('card', { kind: 'k' + i });
  let settled = false;
  const done = late.r.flush('final').then(() => { settled = true; });
  assert.equal(answers.length, 2);
  await tick();
  assert.equal(settled, false, 'waits for the answers');
  answers[1](true);
  await tick();
  assert.equal(settled, false, 'both of them');
  answers[0](false);
  await done;
  assert.equal(settled, true);
  assert.deepEqual([late.r.inspect().sent, late.r.inspect().batches], [10, 1], 'the answered batch counts as sent; the refused one waits for a retry');
  assert.equal(late.r.inspect().queued, 50);
  // A send that rejects or throws: the promise still resolves.
  for (const send of [() => Promise.reject(new Error('offline')), () => { throw new Error('no network'); }]) {
    const bad = reporter({ send });
    bad.r.allow(true);
    bad.r.event('ready');
    await bad.r.flush('final');
    assert.equal(bad.r.inspect().sent, 0);
  }
  // stop() hands back the same promise.
  const stopping = reporter({ send: () => Promise.resolve(true) });
  stopping.r.allow(true);
  stopping.r.event('ready');
  await stopping.r.stop();
  assert.equal(stopping.r.inspect().sent, 1);
});

test('the hide hook sends when the page is hidden or closed, and only after the person agreed', () => {
  const doc = new FakeDocument();
  const win = { listeners: new Map(), addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); } };
  const a = reporter({ visibility: hideHook(win, doc) });
  a.r.event('ready');
  doc.setVisibility('hidden');
  win.listeners.get('pagehide')[0]();
  assert.equal(a.rec.sent.length, 0, 'a page that has not agreed sends nothing when it goes');
  a.r.allow(true);
  doc.setVisibility('visible');
  assert.equal(a.rec.sent.length, 0, 'visible is not hidden');
  doc.setVisibility('hidden');
  assert.deepEqual(a.rec.names(), ['ready']);
  a.r.event('card', { kind: 'signin' });
  win.listeners.get('pagehide')[0]();
  assert.deepEqual(a.rec.names(), ['ready', 'card']);
  assert.doesNotThrow(() => hideHook(null, null).onHide(() => {}));
});

test('event(): bad names and bad fields are dropped one by one, never thrown; a field cannot take the place of t or n', () => {
  const { r, rec, timers } = reporter();
  r.allow(true);
  for (const bad of ['Bad', 'a', 'x'.repeat(50), '1x', 'a b', '', null, undefined, 7, {}]) assert.doesNotThrow(() => r.event(bad, { k: 1 }));
  assert.equal(r.inspect().queued, 0, 'no name, no event');
  r.event('probe', {
    s: 'text', n1: 3, n2: 0, nan: NaN, inf: Infinity, yes: true, no: false, nil: null, obj: { a: 1 }, arr: [1], fn() {}, sym: Symbol('x'), undef: undefined, big: 10n,
    t: 999, n: 'forged', Bad: 'x', 'a-b': 'x', '': 'x',
  });
  timers.fire();
  assert.deepEqual(rec.events(), [{ t: 0, n: 'probe', s: 'text', n1: 3, n2: 0, yes: true, no: false, nil: null }]);
  const many = {};
  for (let i = 0; i < 20; i++) many['k' + i] = i;
  r.event('many', many);
  timers.fire();
  assert.equal(Object.keys(rec.events()[1]).length, 2 + 12, 'at most 12 fields');
  assert.doesNotThrow(() => r.event('probe', null));
  assert.doesNotThrow(() => r.event('probe', 'text'));
});

test('safeField: addresses, fragments and pair codes are masked, strings are cut at 200, anything else is null', () => {
  assert.equal(safeField('from 192.168.1.20 and 10.0.0.1'), 'from x.x.x.x and x.x.x.x');
  assert.equal(safeField('2001:db8::ff00:42:8329'), 'x.x.x.x');
  assert.equal(safeField('fe80::1 and ::1'), 'x.x.x.x and x.x.x.x');
  assert.equal(safeField('https://shop.example/page#secret=1'), 'https://shop.example/page#', 'the # stays, what follows it goes');
  assert.equal(safeField('/_mw/idp-return#answer'), '/_mw/idp-return#');
  assert.equal(safeField('shop.example/page#secret'), 'shop.example/page#', 'a URL without a scheme');
  assert.equal(safeField('page.html#section'), 'page.html#');
  assert.equal(safeField('plain # not a url'), 'plain # not a url');
  assert.equal(safeField('issue #12 is open'), 'issue #12 is open', 'a number after a # in plain words');
  assert.equal(safeField('colour #ff00aa'), 'colour #', 'but not a word');
  assert.equal(safeField('10.0.0.1:8080 and 10.0.0.2'), 'x.x.x.x and x.x.x.x', 'a port goes with its address');
  assert.equal(safeField('[2001:db8::1]:443'), 'x.x.x.x');
  assert.equal(safeField('fe80::1%en0'), 'x.x.x.x', 'and a zone');
  assert.equal(safeField('\uff11\uff19\uff12\uff0e\uff11\uff16\uff18\uff0e\uff11\uff0e\uff12'), 'x.x.x.x', 'full-width digits are folded first');
  assert.equal(safeField('x\u200b192.168.0.1'), 'xx.x.x.x', 'and an invisible character does not hide it');
  assert.equal(safeField('abcd\u2010efgh\u20102345 opened'), 'abcd opened', 'a pair code with a typographic hyphen');
  assert.equal(safeField('key ' + 'ab1'.repeat(16)), 'key ab1ab1ab', 'a long hex run keeps 8 characters');
  assert.equal(safeField('ab1'.repeat(12)), 'ab1'.repeat(12), 'a shorter one is not touched');
  assert.equal(safeField('a'.repeat(50)), 'a'.repeat(50), 'a run of letters alone is a word, not a hash');
  assert.equal(safeField('abcd-efgh-2345 opened'), 'abcd opened');
  assert.equal(safeField('  padded  '), 'padded');
  assert.equal(safeField('x'.repeat(500)).length, 200);
  assert.equal(safeField('y'.repeat(190) + '192.168.1.20'), 'y'.repeat(190) + 'x.x.x.x', 'an address glued to a word is masked');
  assert.equal(safeField('y'.repeat(197) + '192.168.1.20'), 'y'.repeat(197) + 'x.x', 'an address that straddles the limit is masked whole, then cut: no half address is left');
  assert.equal(safeField(3), 3);
  assert.equal(safeField(0), 0);
  assert.equal(safeField(NaN), null);
  assert.equal(safeField(Infinity), null);
  assert.equal(safeField(true), true);
  assert.equal(safeField(false), false);
  assert.equal(safeField(null), null);
  for (const other of [undefined, {}, [], () => 1, Symbol('x'), 5n]) assert.equal(safeField(other), null);
  assert.equal(safeField('E_USER_CANCELLED'), 'E_USER_CANCELLED', 'a code is left as it is');
  assert.equal(safeField(SID), SID, 'a session id is left as it is');
});

test('safeField: the look-alikes of the dot and the colon, a combining mark in an address, percent escapes and octal groups are addresses; one integer and a hex error code stay; the secrets of an SDP are cut', () => {
  const ch = String.fromCharCode;
  const cases = [
    ['192' + ch(0x3002) + '168' + ch(0x3002) + '0' + ch(0x3002) + '1', 'x.x.x.x'],
    ['192' + ch(0xff61) + '168' + ch(0xff61) + '0' + ch(0xff61) + '1', 'x.x.x.x'],
    ['192%2E168%2E0%2E1', 'x.x.x.x'],
    ['http://192%2e168%2e0%2e1/', 'http://x.x.x.x/'],
    ['192' + ch(0x301) + '.168.0.1', 'x.x.x.x'],
    ['0300.0250.0.1', 'x.x.x.x'],
    ['010.020.030.040', 'x.x.x.x'],
    ['2001' + ch(0x2236) + 'db8' + ch(0x2236) + ch(0x2236) + '1', 'x.x.x.x'],
    ['2001%3adb8%3a%3a1', 'x.x.x.x'],
    ['3232235777', '3232235777'],
    ['Error 0x80070005 in 1.2.3', 'Error 0x80070005 in 1.2.3'],
    ['caf' + ch(0xe9) + ' and q' + ch(0x301), 'caf' + ch(0xe9) + ' and q' + ch(0x301)],
    ['a=ice-ufrag:Zq3k\r\na=ice-pwd:zXy9aBcDeFgHiJkLmNoPqRsT\r\na=fingerprint:sha-256 5D:1C:0A:77:B3:4E:99:AB\r\n', 'a=ice-ufrag:\r\na=ice-pwd:\r\na=fingerprint:sha-256'],
  ];
  for (const [input, want] of cases) assert.equal(safeField(input), want, JSON.stringify(input));
});

test('safeField: a text of many "#1" costs time in proportion to its length, not to its square, and what the rule keeps and cuts is what it always was', () => {
  const real = RegExp.prototype.test;
  let chars = 0;
  RegExp.prototype.test = function (s) { chars += String(s).length; return real.call(this, s); };
  let out;
  try { out = safeField('#1'.repeat(1000)); } finally { RegExp.prototype.test = real; }
  assert.ok(chars < 20000, 'characters handed to a regular expression test: ' + chars + ' (reading everything before each # again made it about a million)');
  assert.equal(out, '#1'.repeat(100));
  for (const [input, want] of [['a #1#1 b.c #2', 'a #1#1 b.c #2'], ['a #1#1 b.c#2', 'a #1#1 b.c#'], ['x#1.5#2', 'x#1.5#'], ['x#1#a/b', 'x#1#'], ['https://host/#123456', 'https://host/#'], ['step #3 of #12 at #7', 'step #3 of #12 at #7']]) {
    assert.equal(safeField(input), want, input);
  }
});

test('the loader field of a batch is a version or nothing: a name, an address or a word is not sent', () => {
  const sent = (loader) => {
    const { r, rec } = reporter({ loader });
    r.allow(true);
    r.event('ready', {});
    r.flush('timer');
    return rec.sent[0].body.loader;
  };
  for (const ok of ['0.3.0', '0.3.1-rc.1', '1.2.3+build.5']) assert.equal(sent(ok), ok);
  for (const bad of ['dev', '203.0.113.5', 'someone', '0.3', '0.3.0.1', '', undefined, null, 7, '0.3.0 ', '1234.5678.9012-ab']) assert.equal(sent(bad), '', JSON.stringify(bad));
});

test('uaOf: the browser family and mobile, never the string; every iOS browser is WebKit', () => {
  const ua = (userAgent, extra = {}) => uaOf(Object.assign({ userAgent }, extra));
  assert.deepEqual(ua('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'), { browser: 'chromium', mobile: false });
  assert.deepEqual(ua('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0'), { browser: 'chromium', mobile: false });
  assert.deepEqual(ua('Mozilla/5.0 (Linux; Android 14; SM-F776W) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36'), { browser: 'chromium', mobile: true });
  assert.deepEqual(ua('Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0'), { browser: 'firefox', mobile: false });
  assert.deepEqual(ua('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'), { browser: 'webkit', mobile: false });
  assert.deepEqual(ua('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/120.0 Mobile/15E148 Safari/604.1'), { browser: 'webkit', mobile: true });
  assert.deepEqual(ua('curl/8'), { browser: 'other', mobile: false });
  assert.deepEqual(uaOf({ userAgent: '', userAgentData: { brands: [{ brand: 'Brave' }, { brand: 'Chromium' }], mobile: true } }), { browser: 'chromium', mobile: true });
  assert.deepEqual(uaOf(null), { browser: 'other', mobile: false });
  assert.deepEqual(uaOf({ get userAgent() { throw new Error('no'); } }), { browser: 'other', mobile: false });
  const { r, rec } = reporter({ nav: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) SECRET-DEVICE-NAME-9 Chrome/120.0' } });
  r.allow(true);
  r.event('ready');
  r.flush('hide');
  assert.ok(!rec.sent[0].text.includes('SECRET-DEVICE-NAME'), 'the full user agent is never sent');
});

test('the default transport: fetch with keepalive first (the real Origin, an answer); the beacon when there is no fetch, when fetch refuses the request, or for the final flush of a browser without keepalive; false when there is neither', async () => {
  const saved = { fetch: globalThis.fetch, Request: globalThis.Request };
  const calls = [];
  const beacons = [];
  class FakeRequest { get keepalive() { return true; } }
  globalThis.Request = FakeRequest;
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return { ok: true }; };
  try {
    const nav = { userAgent: 'x', sendBeacon: (url, blob) => { beacons.push({ url, blob }); return true; } };
    const a = createReporter({ endpoint: OBS, nav, setTimeout: () => 1, clearTimeout: () => {} });
    a.allow(true);
    a.event('ready');
    a.flush('hide');
    assert.equal(calls.length, 1, 'fetch first: a cors request carries the real Origin; a no-cors beacon carries Origin null under no-referrer and is refused');
    assert.equal(beacons.length, 0);
    assert.equal(calls[0].url, OBS + '/e');
    assert.deepEqual(
      [calls[0].init.method, calls[0].init.keepalive, calls[0].init.credentials, calls[0].init.mode, calls[0].init.headers['Content-Type'], calls[0].init.referrerPolicy],
      ['POST', true, 'omit', 'cors', 'text/plain', 'no-referrer'],
    );
    await tick();
    assert.equal(a.inspect().sent, 1);
    a.event('card', { kind: 'signin' });
    a.flush('final');
    assert.equal(calls.length, 2, 'the final flush is a fetch with keepalive where the browser has it');
    assert.equal(beacons.length, 0);
    await tick();
    assert.equal(a.inspect().sent, 2);
    // A browser without keepalive (Firefox before 133): fetch for an ordinary flush, the beacon for the final one, which outlives the window.
    globalThis.Request = class {};
    const b = createReporter({ endpoint: OBS, nav, setTimeout: () => 1, clearTimeout: () => {} });
    b.allow(true);
    b.event('ready');
    b.flush('hide');
    assert.equal(calls.length, 3);
    await tick();
    b.event('card', { kind: 'signin' });
    const startedAt = Date.now();
    let afterGrace = false;
    const graced = b.flush('final').then(() => { afterGrace = true; });
    assert.equal(beacons.length, 1);
    assert.equal(calls.length, 3);
    await tick();
    assert.equal(afterGrace, false, 'a beacon has no answer: the final flush gives the browser a moment to take it');
    await graced;
    assert.ok(Date.now() - startedAt >= BEACON_GRACE_MS - 20, 'about ' + BEACON_GRACE_MS + ' ms, was ' + (Date.now() - startedAt));
    assert.equal(b.inspect().sent, 2);
    // A fetch that throws at once (the keepalive quota) falls back to the beacon, settled at once for an ordinary flush.
    globalThis.Request = FakeRequest;
    globalThis.fetch = () => { throw new TypeError('keepalive quota'); };
    const refusing = createReporter({ endpoint: OBS, nav, setTimeout: () => 1, clearTimeout: () => {} });
    refusing.allow(true);
    refusing.event('ready');
    let quick = false;
    Promise.resolve(refusing.flush('hide')).then(() => { quick = true; });
    assert.equal(beacons.length, 2);
    await tick();
    assert.equal(quick, true);
    assert.equal(refusing.inspect().sent, 1);
    // With neither, the send fails and the batch is kept for a retry.
    globalThis.fetch = undefined;
    const none = createReporter({ endpoint: OBS, nav: { userAgent: 'x' }, setTimeout: () => 1, clearTimeout: () => {} });
    none.allow(true);
    none.event('ready');
    none.flush('hide');
    assert.deepEqual([none.inspect().sent, none.inspect().queued], [0, 1]);
  } finally {
    globalThis.fetch = saved.fetch;
    globalThis.Request = saved.Request;
  }
});

// ------------------------------------------------------------------------------------------------ 2. the cards

/** dom(node) -> a plain text form of a fake DOM tree (tag, sorted attributes, text, children), to compare two cards. */
function dom(node) {
  const attrs = Array.from(node.attrs.entries()).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => k + '=' + JSON.stringify(v)).join(' ');
  const tag = node.tagName.toLowerCase();
  return '<' + tag + (attrs ? ' ' + attrs : '') + '>' + node._text + node.children.map(dom).join('') + '</' + tag + '>';
}

const SIGNIN = { origin: 'https://www.shop.example', pub: null, first: true, notListed: false, statement: '', purpose: 'site', sameOptions: [], linkedTo: null, hub: null, shared: false, unlock: 'passkey', hasIdentity: true };

function cardsFor(opts = {}) {
  const doc = new FakeDocument();
  const clock = makeClock(1000);
  const cards = createCards(Object.assign({ doc, win: null, lang: 'en', build: { version: '0.3.0', id: 'abc123', hash: '', test: false }, now: clock.now, minPressMs: 400, idp: IDP }, opts));
  return { cards, doc, clock };
}

test('CARD_KINDS names every card of createCards (and only the cards), so a new card cannot go unreported', () => {
  const { cards } = cardsFor();
  const fns = Object.keys(cards).filter((k) => typeof cards[k] === 'function' && k !== 'progress' && k !== 'close');
  assert.deepEqual(fns.slice().sort(), CARD_KINDS.slice().sort());
  assert.deepEqual(HANDLER_NAMES.slice().sort(), ['hubAsk', 'hubOff', 'link', 'makeBackup', 'removeDevice', 'replaceKeys', 'restore', 'showPhrase', 'stopSame', 'unlockView']);
  const src = readFileSync(join(ROOT, 'src/idp/idp.js'), 'utf8');
  const handlers = src.slice(src.indexOf('observe({'), src.indexOf('}));', src.indexOf('observe({')));
  const named = Array.from(handlers.matchAll(/^\s{8}([a-zA-Z]+): \(/gm)).map((m) => m[1]);
  assert.deepEqual(named.sort(), HANDLER_NAMES.slice().sort(), 'the buttons bootHome gives the settings card are the ones reported');
});

test('the first card names the report host in one line above its buttons, in English and French; with no host to name it is exactly the card it was', () => {
  const plain = cardsFor();
  plain.cards.signin(SIGNIN);
  const off = cardsFor({ obsHost: () => null, onCardPress: () => {} });
  off.cards.signin(SIGNIN);
  assert.equal(dom(off.cards.root), dom(plain.cards.root), 'the options change nothing while there is no host to name');
  assert.equal(plain.cards.root.findAll((n) => n.getAttribute('data-mw-obs-line') !== null).length, 0);
  for (const lang of ['en', 'fr']) {
    const base = cardsFor({ lang });
    base.cards.signin(SIGNIN);
    const on = cardsFor({ lang, obsHost: () => 'obs.example.org' });
    on.cards.signin(SIGNIN);
    const lines = on.cards.root.findAll((n) => n.getAttribute('data-mw-obs-line') === '1');
    assert.equal(lines.length, 1, lang);
    assert.equal(lines[0].tagName, 'P');
    assert.equal(lines[0].getAttribute('class'), null, 'a plain paragraph, as visible as the lines around it');
    assert.equal(lines[0].textContent, idpT('obsDisclosure', { host: 'obs.example.org' }, lang));
    assert.ok(lines[0].textContent.includes('obs.example.org') && !lines[0].textContent.includes('{host}'));
    const card = on.cards.root.children[0];
    const at = card.children.indexOf(lines[0]);
    const actions = card.children.findIndex((n) => /(^|\s)mw-actions(\s|$)/.test(n.getAttribute('class') || ''));
    assert.ok(at > 0 && actions === at + 1, lang + ': right above the first row of buttons');
    assert.equal(dom(on.cards.root).replace(dom(lines[0]), ''), dom(base.cards.root), lang + ': that line is the one difference');
  }
  // Every card with buttons carries it, whatever its kind, until the host stops being named.
  let host = 'obs.example.org';
  const many = cardsFor({ obsHost: () => host });
  many.cards.confirmSame({ a: 'https://a.example', b: 'https://b.example' });
  assert.equal(many.cards.root.findAll((n) => n.getAttribute('data-mw-obs-line') === '1').length, 1);
  many.cards.settings({ hasIdentity: false }, {});
  assert.equal(many.cards.root.findAll((n) => n.getAttribute('data-mw-obs-line') === '1').length, 1);
  host = null;
  many.cards.settings({ hasIdentity: false }, {});
  assert.equal(many.cards.root.findAll((n) => n.getAttribute('data-mw-obs-line') === '1').length, 0, 'gone once the first press has been made');
});

test('onCardPress runs on a button\'s own press, once per press (not on untrusted ones or ones too early), and a hook that throws never stops the card', async () => {
  let presses = 0;
  const { cards, clock } = cardsFor({ onCardPress: () => { presses++; } });
  const p = cards.recordRead({ origin: SITE });
  const allow = cards.root.buttonByText('Allow');
  allow.dispatchEvent({ type: 'click', isTrusted: false });
  allow.click();
  assert.equal(presses, 0, 'an untrusted click and a press in the first 400 ms are not presses');
  clock.advance(401);
  allow.click();
  assert.equal(await p, true);
  assert.equal(presses, 1);
  const bad = cardsFor({ onCardPress: () => { throw new Error('the report failed'); } });
  const q = bad.cards.message({ text: 'x' });
  bad.cards.root.buttonByText('Close').click();
  assert.equal(await q, true, 'the press still resolves the card');
});

test('the disclosure strings: both languages, the host placeholder, English in ASCII, no refused word, no dash', () => {
  const en = STRINGS.en.obsDisclosure;
  const fr = STRINGS.fr.obsDisclosure;
  assert.match(en, /^[\x20-\x7e]+$/, 'English is ASCII only');
  assert.match(en, /^Usage reports: /);
  assert.match(fr, /^Rapports d'utilisation : /);
  for (const text of [en, fr]) {
    assert.ok(text.includes('{host}'));
    assert.ok(!/[\u2013\u2014]/.test(text), 'no em dash or en dash');
    for (const word of ['blockchain', 'serverless', 'unstoppable', 'censorship-resistant', 'production-ready', 'fully decentralized', 'sub-second', 'online']) assert.ok(!text.toLowerCase().includes(word), word);
  }
  // The line says when, what and what the report never holds; the tests below hold that "never" for every event.
  assert.match(en, /when you press a button on this page/);
  assert.match(en, /The report holds no keys, no site address and nothing you type\./);
  assert.match(en, /To send nothing, close this window without pressing one\./);
  assert.match(fr, /quand vous appuyez sur un bouton de cette page/);
  assert.match(fr, /ne contient ni cl\u00e9s, ni adresse de site, ni rien de ce que vous saisissez/);
  assert.match(fr, /Pour ne rien envoyer, fermez cette fen\u00eatre sans appuyer sur un bouton\./);
  assert.deepEqual(Object.keys(STRINGS.fr).sort(), Object.keys(STRINGS.en).sort());
});

test('cardOutcome and wantWord: words from a closed list or the shape of the value, never the text of a value', () => {
  assert.equal(cardOutcome('signin', { action: 'continue', mode: {}, stay: true }), 'continue');
  assert.equal(cardOutcome('signin', { action: 'restore' }), 'restore');
  assert.equal(cardOutcome('signin', { action: 'rm -rf' }), 'done');
  assert.equal(cardOutcome('chooseUnlock', { method: 'passphrase', nickname: 'my laptop', extra: 'secret' }), 'passphrase');
  assert.equal(cardOutcome('chooseUnlock', { method: 'my laptop' }), 'done');
  assert.equal(cardOutcome('passphrase', 'later'), 'continue', 'a passphrase that is a word of the list is still only "continue"');
  assert.equal(cardOutcome('scanCode', 'saved'), 'continue');
  assert.equal(cardOutcome('backupFile', { pass: 'keep' }), 'continue');
  assert.equal(cardOutcome('restore', { kind: 'phrase', words: 'abandon ability', extra: 'x' }), 'phrase');
  assert.equal(cardOutcome('restore', { kind: 'file', text: '{}', pass: 'x' }), 'file');
  assert.equal(cardOutcome('recoveryKit', 'saved'), 'saved');
  assert.equal(cardOutcome('recoveryKit', 'whatever'), 'done');
  assert.equal(cardOutcome('saveBackup', 'later'), 'later');
  assert.equal(cardOutcome('foundPosts', 'check'), 'check');
  assert.equal(cardOutcome('legacy', 'keep'), 'keep');
  assert.equal(cardOutcome('legacy', 'a name'), 'done');
  assert.equal(cardOutcome('message', true), 'close');
  assert.equal(cardOutcome('error', true), 'close');
  assert.equal(cardOutcome('confirmSame', true), 'yes');
  assert.equal(cardOutcome('confirmSame', false), 'no');
  assert.equal(cardOutcome('showCodes', { any: 'thing' }), 'done');
  for (const kind of CARD_KINDS) {
    assert.equal(cardOutcome(kind, null), 'cancel', kind);
    assert.equal(cardOutcome(kind, undefined), 'cancel', kind);
  }
  assert.equal(wantWord(['proof', 'keys']), 'keys+proof');
  assert.equal(wantWord(['record']), 'record');
  assert.equal(wantWord('keys'), '');
  assert.equal(wantWord(undefined), '');
});

test('instrumentCards: card {kind} on show, action {name} on the press, the card\'s own promise untouched, a failing report never reaches the card', async () => {
  const seen = [];
  const cards = {
    lang: 'en', root: { marker: true },
    signin: () => Promise.resolve({ action: 'cancel' }),
    chooseUnlock: () => Promise.resolve({ method: 'passphrase', nickname: 'secret name' }),
    busy: () => undefined,
    progress: () => 'p',
    close: () => 'c',
    erase: () => Promise.reject(new Error('boom')),
    settings: (model) => ({ drawn: model }),
  };
  const view = instrumentCards(cards, (n, f) => seen.push([n, f]));
  assert.equal(view.lang, 'en');
  assert.equal(view.root.marker, true);
  assert.equal(view.progress(), 'p');
  assert.equal(view.close(), 'c');
  assert.deepEqual(await view.signin({ origin: 'https://secret.example' }), { action: 'cancel' });
  await view.chooseUnlock({ prf: true });
  assert.equal(view.busy(), undefined);
  assert.deepEqual(view.settings({ hasIdentity: false }), { drawn: { hasIdentity: false } });
  await assert.rejects(view.erase({ origin: 'https://secret.example' }), /boom/, 'the card\'s own rejection reaches its caller');
  await tick();
  assert.deepEqual(seen, [
    ['card', { kind: 'signin' }], ['action', { name: 'signin.cancel' }],
    ['card', { kind: 'chooseUnlock' }], ['action', { name: 'chooseUnlock.passphrase' }],
    ['card', { kind: 'busy' }],
    ['card', { kind: 'settings' }],
    ['card', { kind: 'erase' }], ['action', { name: 'erase.error' }],
  ]);
  assert.ok(!JSON.stringify(seen).includes('secret'), 'no argument and no result text is read');
  const quiet = [];
  const busy = instrumentCards({ busy: () => Promise.resolve() }, (n, f) => quiet.push([n, f]));
  await busy.busy();
  await tick();
  assert.deepEqual(quiet, [['card', { kind: 'busy' }]], 'the "Unlocking" card has no button, so no action');
  const loud = instrumentCards(cards, () => { throw new Error('the report failed'); });
  assert.deepEqual(await loud.signin({}), { action: 'cancel' });
  const handlers = instrumentHandlers({ stopSame: (o) => 'stopped ' + o, odd: () => 'o', hubOff: 5 }, (n, f) => seen.push([n, f]));
  assert.equal(handlers.stopSame('https://secret.example'), 'stopped https://secret.example');
  assert.equal(handlers.odd(), 'o');
  assert.equal(handlers.hubOff, 5);
  assert.deepEqual(seen[seen.length - 1], ['action', { name: 'settings.stopSame' }]);
  assert.ok(!JSON.stringify(seen).includes('secret'));
  assert.equal(seen.filter((x) => x[0] === 'action' && x[1].name === 'settings.odd').length, 0, 'only the settings buttons are named');
});

// ------------------------------------------------------------------------------------------------ 3. the identity page

test('readObsEndpoint: the attribute the build wrote, an exact origin only; anything else is no endpoint at all', () => {
  const docWith = (v) => { const d = new FakeDocument(); if (v !== null) d.documentElement.setAttribute('data-mw-obs', v); return d; };
  assert.equal(readObsEndpoint(docWith(OBS)), OBS);
  assert.equal(readObsEndpoint(docWith('http://127.0.0.1:8787')), 'http://127.0.0.1:8787');
  assert.equal(readObsEndpoint(docWith('http://localhost:9000')), 'http://localhost:9000');
  for (const bad of [null, '', ' ', OBS + '/', OBS + '/path', OBS + '?x=1', OBS + '#f', 'https://user@obs.example.org', 'http://obs.example.org', 'ftp://obs.example.org', 'javascript:alert(1)',
    'HTTPS://OBS.EXAMPLE.ORG', 'obs.example.org', '//obs.example.org', 'https://' + 'a'.repeat(300) + '.example', 'https://obs.example.org:443']) {
    assert.equal(readObsEndpoint(docWith(bad)), null, JSON.stringify(bad));
  }
  assert.equal(readObsEndpoint(null), null);
  assert.equal(readObsEndpoint({}), null);
  assert.equal(readObsEndpoint({ documentElement: {} }), null);
  assert.equal(readObsEndpoint({ documentElement: { getAttribute() { throw new Error('no'); } } }), null);
});

test('no endpoint, no reporter: the ready message is the one it always was, no request leaves, and the cards are the ones the flow always used', async () => {
  for (const obs of [false, 'https://obs.example.org/with/a/path', 'http://not-loopback.example']) {
    const p = await page({ obs });
    assert.equal(p.idp.obs, null, String(obs));
    const done = p.idp.bootSignin();
    await tick();
    assert.deepEqual(Object.keys(p.op.posts[0].msg).sort(), ['build', 't', 'v'], 'the ready message carries nothing else');
    const { req } = await newRequest({ extra: { obs: { sid: SID } } });
    p.win.deliver({ source: p.op, origin: SITE, data: req });
    const r = await done;
    assert.equal(r.res.ok, true, 'a request that names a report id is still answered by a page that does not report');
    assert.equal(p.rec.sent.length, 0);
    assert.deepEqual(p.cards.calls.map((c) => c.name), ['signin', 'chooseUnlock'], 'the very cards, not wrapped ones');
    assert.deepEqual(p.log, ['post', 'answer', 'close'], 'no final flush call between the answer and the close');
  }
  // The home page too: nothing is wrapped, nothing is sent.
  const home = await page({ obs: false, withOpener: false });
  await home.idp.bootHome();
  assert.equal(home.rec.sent.length, 0);
  assert.equal(home.timers.pending.size, 0);
});

test('with an endpoint the ready message says obs: true (so the opener may send its report id); nothing is sent before the person presses a card button', async () => {
  const p = await page();
  assert.ok(p.idp.obs);
  assert.equal(p.idp.obs.inspect().host, 'obs.example.org');
  const done = p.idp.bootSignin();
  await tick();
  assert.deepEqual(Object.keys(p.op.posts[0].msg).sort(), ['build', 'obs', 't', 'v']);
  assert.equal(p.op.posts[0].msg.obs, true);
  const { req } = await newRequest();
  p.win.deliver({ source: p.op, origin: SITE, data: req });
  const r = await done;
  assert.equal(r.res.ok, true);
  assert.equal(p.rec.sent.length, 0, 'a whole sign-in, and the person never pressed a card button: nothing left the page');
  assert.equal(p.log.indexOf('send-final'), -1);
  assert.ok(p.idp.obs.inspect().queued >= 7, 'the events wait in memory');
  p.doc.setVisibility('hidden');
  assert.equal(p.rec.sent.length, 0, 'closing or hiding the window sends them nowhere');
  assert.equal(p.timers.pending.size, 0);
});

test('a popup sign-in that creates an identity: ready, request, card, action, unlock, result, in order, one batch, sent after the answer and before the close', async () => {
  const clock = makeClock();
  const cards = scriptedCards({ chooseUnlock: () => { clock.advance(1500); return { method: 'passkey', nickname: 'my laptop' }; } });
  const p = await page({ cards, clock });
  p.idp.obs.allow(true); // what the first press of a card button does
  const { req } = await newRequest({ extra: { obs: { sid: SID } } });
  const r = await popup(p, req);
  assert.equal(r.res.ok, true);
  assert.deepEqual(p.log, ['post', 'answer', 'send-final', 'close'], 'the final flush comes after the answer is posted and before the window closes');
  assert.equal(p.rec.sent.length, 1);
  const batch = p.rec.sent[0];
  assert.equal(batch.final, true);
  assert.deepEqual(problems(batch.body), []);
  assert.equal(batch.body.page, 'idp');
  assert.equal(batch.body.build, 'bbcb82098cda');
  assert.equal(batch.body.loader, '0.3.0');
  const ev = batch.body.events.map((e) => { const o = Object.assign({}, e); delete o.t; return o; });
  assert.deepEqual(ev, [
    { n: 'ready' },
    { n: 'request', kind: 'popup', shared: false, want: 'keys', ref: SID },
    { n: 'card', kind: 'signin' },
    { n: 'action', name: 'signin.continue' },
    { n: 'card', kind: 'chooseUnlock' },
    { n: 'action', name: 'chooseUnlock.passkey' },
    { n: 'unlock', method: 'passkey' },
    { n: 'result', code: 'ok', ms: 1500 },
  ]);
  assert.equal(batch.body.events[batch.body.events.length - 1].t, 1500, 't counts from the page\'s own start');
});

test('a returning sign-in unlocks with the stored method; a second site costs one more request and result, and the opener\'s id travels as ref only', async () => {
  const store = await openIdoStore({ memory: true });
  const passkey = fakePasskey();
  const first = await page({ store, passkey });
  await popup(first, (await newRequest()).req);
  const p = await page({ store, passkey });
  p.idp.obs.allow(true);
  const r = await popup(p, (await newRequest({ extra: { obs: { sid: SID } } })).req, 'https://forum.example');
  assert.equal(r.res.ok, true);
  assert.deepEqual(p.rec.names(), ['ready', 'request', 'card', 'action', 'unlock', 'result']);
  assert.deepEqual(p.rec.events().filter((e) => e.n === 'unlock').map((e) => e.method), ['passkey']);
  // A proof request is named by its want; the other wants are named the same way.
  for (const want of [['proof'], ['keys', 'proof'], ['record'], ['erase']]) {
    const q = await page({ store, passkey });
    q.idp.obs.allow(true);
    const extra = want.indexOf('proof') >= 0 ? { purpose: 'server', challenge: { nonce: 'A'.repeat(22), statement: 'Sign in' } } : {};
    const { req } = await newRequest({ want, purpose: want.indexOf('proof') >= 0 && want.length === 1 ? 'server' : 'site', extra: want.length === 1 && want[0] === 'proof' ? extra : {} });
    if (want.indexOf('keys') >= 0 && want.indexOf('proof') >= 0) delete req.challenge;
    await popup(q, req);
    assert.equal(q.rec.events().find((e) => e.n === 'request').want, want.slice().sort().join('+'));
  }
});

test('shared, cancelled and refused: the request says shared, a cancel is a result and not an error, a failed step is an error with its own code', async () => {
  // A shared-origin hub of this build, and a page that asks to be shared: both are "shared", both unlock "visit".
  const shared = await page({ sharedOrigins: [SITE] });
  shared.idp.obs.allow(true);
  await popup(shared, (await newRequest()).req);
  assert.deepEqual(shared.rec.events().filter((e) => e.n === 'request' || e.n === 'unlock').map((e) => [e.n, e.shared, e.method]), [['request', true, undefined], ['unlock', undefined, 'visit']]);
  const asked = await page();
  asked.idp.obs.allow(true);
  await popup(asked, (await newRequest({ extra: { shared: true } })).req);
  assert.equal(asked.rec.events().find((e) => e.n === 'request').shared, true);
  // The person presses Cancel.
  const cancelled = await page({ cards: scriptedCards({ signin: { action: 'cancel', mode: { kind: 'private' } } }) });
  cancelled.idp.obs.allow(true);
  const c = await popup(cancelled, (await newRequest()).req);
  assert.equal(c.res.ok, false);
  assert.deepEqual(cancelled.rec.names(), ['ready', 'request', 'card', 'action', 'result']);
  assert.deepEqual(cancelled.rec.events().filter((e) => e.n === 'action' || e.n === 'result').map((e) => e.name || e.code), ['signin.cancel', 'E_USER_CANCELLED']);
  // A first approval without user verification: the IdO keeps its own reason, the site is told only that it did not happen.
  const store = await openIdoStore({ memory: true });
  const passkey = fakePasskey();
  await popup(await page({ store, passkey }), (await newRequest()).req);
  passkey.uv = false;
  const refused = await page({ store, passkey });
  refused.idp.obs.allow(true);
  const f = await popup(refused, (await newRequest()).req, 'https://forum.example');
  assert.equal(f.res.ok, false);
  assert.deepEqual(refused.rec.names(), ['ready', 'request', 'card', 'action', 'unlock', 'error', 'result', 'card', 'action']);
  assert.deepEqual(refused.rec.events().filter((e) => e.n === 'error' || e.n === 'result').map((e) => e.code), ['E_UV_REQUIRED', 'E_USER_CANCELLED']);
  assert.deepEqual(refused.rec.events().slice(-2).map((e) => e.kind || e.name), ['error', 'error.close'], 'the error card that followed');
});

test('a request this page refuses is an error and no request event; a bad report id is one of the ways to be refused', async () => {
  for (const obs of [{}, { sid: SID, extra: 1 }, 'x', [], { sid: 5 }, { sid: 'abc' }, { sid: 'ABCDEFGHIJKL' }, { sid: 'abcdefgh2340' }, { sid: 'abcdefgh2341' }, { sid: SID + 'a' }, null]) {
    const p = await page();
    p.idp.obs.allow(true);
    const { req } = await newRequest({ extra: { obs } });
    const done = p.idp.bootSignin();
    await tick();
    p.win.deliver({ source: p.op, origin: SITE, data: req });
    assert.deepEqual((await done).done, false);
    const answer = p.op.posts.find((x) => x.msg.t === 'mw-signin-res').msg;
    assert.deepEqual([answer.ok, answer.code], [false, 'E_BAD_REQUEST'], JSON.stringify(obs));
    p.timers.fire();
    assert.deepEqual(p.rec.names(), ['ready', 'error'], JSON.stringify(obs));
    assert.equal(p.rec.events()[1].code, 'E_BAD_REQUEST');
  }
  // And through handleRequest, which the redirect path also uses: the error and the result, never a request.
  const q = await page();
  q.idp.obs.allow(true);
  const bad = (await newRequest({ extra: { obs: { sid: 'nope' } } })).req;
  const res = await q.idp.handleRequest(bad, SITE, null);
  assert.deepEqual([res.ok, res.code], [false, 'E_BAD_REQUEST']);
  q.idp.obs.flush('hide');
  assert.deepEqual(q.rec.names(), ['error', 'result']);
});

test('the window waits for the last report\'s answer before it closes, for at most OBS_CLOSE_WAIT_MS; a refused or failing report never keeps it', async () => {
  const manual = fakeTimers();
  let answer;
  const pending = new Promise((resolve) => { answer = resolve; });
  const p = await page({ ok: () => pending, idpTimers: manual });
  p.idp.obs.allow(true);
  const run = popup(p, (await newRequest()).req);
  await waitFor(() => p.log.indexOf('send-final') >= 0, 'the final flush');
  await tick();
  assert.deepEqual(p.log, ['post', 'answer', 'send-final'], 'the answer is out, the report is on its way, the window is still open');
  assert.equal(p.win.closed, false);
  assert.equal(manual.pending.size, 1);
  assert.equal(Array.from(manual.pending.values())[0].ms, OBS_CLOSE_WAIT_MS);
  answer(true);
  const r = await run;
  assert.equal(r.done, true);
  assert.deepEqual(p.log, ['post', 'answer', 'send-final', 'close']);
  assert.equal(manual.pending.size, 0, 'the answer cancels the wait');
  // No answer at all: the window goes when the wait is over.
  const manual2 = fakeTimers();
  const q = await page({ ok: () => new Promise(() => {}), idpTimers: manual2 });
  q.idp.obs.allow(true);
  const run2 = popup(q, (await newRequest()).req);
  await waitFor(() => q.log.indexOf('send-final') >= 0, 'the final flush');
  await tick();
  assert.equal(q.win.closed, false);
  manual2.fire();
  await run2;
  assert.deepEqual(q.log, ['post', 'answer', 'send-final', 'close']);
  // A refused report, a failing one and a throwing one: the window closes without the wait.
  for (const ok of [false, () => Promise.reject(new Error('offline')), () => { throw new Error('no network'); }]) {
    const manual3 = fakeTimers();
    const z = await page({ ok, idpTimers: manual3 });
    z.idp.obs.allow(true);
    await popup(z, (await newRequest()).req);
    assert.equal(z.win.closed, true);
    assert.equal(manual3.pending.size, 0);
  }
  // The redirect path waits the same way before the page leaves for the site.
  const manual5 = fakeTimers();
  let answer5;
  const pending5 = new Promise((resolve) => { answer5 = resolve; });
  const redirected = await newRequest();
  const fragment = client.encodeFragment(Object.assign({}, redirected.req, { origin: SITE, ret: SITE + '/_mw/idp-return' }));
  const leaving = await page({ hash: '#' + fragment, withOpener: false, ok: () => pending5, idpTimers: manual5 });
  leaving.idp.obs.allow(true);
  const run5 = leaving.idp.bootSignin();
  await waitFor(() => leaving.log.indexOf('send-final') >= 0, 'the final flush before the redirect');
  await tick();
  assert.deepEqual(leaving.log, ['send-final'], 'the page has not left yet');
  answer5(true);
  assert.equal((await run5).done, true);
  assert.deepEqual(leaving.log, ['send-final', 'replace']);
  assert.equal(manual5.pending.size, 0);
  // A page that does not report has no wait at all.
  const manual4 = fakeTimers();
  const none = await page({ obs: false, idpTimers: manual4 });
  await popup(none, (await newRequest()).req);
  assert.deepEqual(none.log, ['post', 'answer', 'close']);
  assert.equal(manual4.pending.size, 0);
  assert.equal(OBS_CLOSE_WAIT_MS, 700);
});

test('the identity page\'s worker tells Chromium to send a request to another origin straight to the network, and goes on installing where it cannot', () => {
  const rule = staticRoute({ protocol: 'https:', hostname: 'id.example.org', port: '' });
  assert.deepEqual(rule, { condition: { not: { urlPattern: { protocol: 'https', hostname: 'id.example.org', port: '' } } }, source: 'network' });
  assert.deepEqual(staticRoute({ protocol: 'http:', hostname: '127.0.0.1', port: '8080' }).condition.not.urlPattern, { protocol: 'http', hostname: '127.0.0.1', port: '8080' });
  const added = [];
  assert.equal(installRoutes({ addRoutes: (r) => added.push(r) }, { protocol: 'https:', hostname: 'id.example.org', port: '' }), true);
  assert.deepEqual(added, [rule]);
  assert.equal(installRoutes({}, { protocol: 'https:', hostname: 'id.example.org', port: '' }), false, 'a browser without the API');
  assert.equal(installRoutes(null, { protocol: 'https:', hostname: 'x', port: '' }), false);
  assert.equal(installRoutes({ addRoutes() { throw new TypeError('invalid rule'); } }, { protocol: 'https:', hostname: 'x', port: '' }), false, 'a browser that refuses the rule');
  // The rule never names the own origin as a target: a same-origin request still goes to the worker.
  assert.equal(JSON.stringify(rule).includes('"source":"network"'), true);
  const src = readFileSync(join(ROOT, 'src/idp/sw.js'), 'utf8');
  assert.match(src, /installRoutes\(event, self\.location\);\s+event\.waitUntil\(worker\.install\(\)\);/, 'the install event registers the rule and then installs, in that order');
});

test('a redirect request is a redirect in the report, carries no ref even when it names one, and the final flush comes before the page leaves', async () => {
  const { box, req } = await newRequest({ extra: { obs: { sid: SID } } });
  const fragment = client.encodeFragment(Object.assign({}, req, { origin: SITE, ret: SITE + '/_mw/idp-return' }));
  const p = await page({ hash: '#' + fragment, withOpener: false });
  p.idp.obs.allow(true);
  const r = await p.idp.bootSignin();
  assert.equal(r.done, true);
  assert.equal(r.res.ok, true);
  assert.deepEqual(p.log, ['send-final', 'replace'], 'the last report goes before the navigation, not after');
  const request = p.rec.events().find((e) => e.n === 'request');
  assert.deepEqual(request, Object.assign({ t: 0, n: 'request' }, { kind: 'redirect', shared: false, want: 'keys' }));
  assert.ok(!('ref' in request));
  assert.ok(!p.rec.sent[0].text.includes(SID), 'the report id of a redirect request is not used');
  assert.ok(!p.rec.sent[0].text.includes(box.pub));
  // A fragment this page refuses is an error before anything else.
  const bad = await page({ hash: '#' + client.encodeFragment({ v: 1, t: 'mw-signin-req', origin: SITE, ret: 'https://evil.example/_mw/idp-return' }), withOpener: false });
  bad.idp.obs.allow(true);
  await bad.idp.bootSignin();
  bad.idp.obs.flush('hide');
  assert.deepEqual(bad.rec.names(), ['ready', 'error', 'card', 'action']);
  assert.equal(bad.rec.events()[1].code, 'E_BAD_REQUEST');
});

test('never the pointer, a key, a site, a nick, a passphrase, a statement or an address: every value of every event comes from a closed list', async () => {
  const SECRET_PASS = 'a quiet river under seven bridges';
  const NICK = 'my-secret-laptop-name';
  const STATEMENT = 'Sign in to Super Secret Bank, ref 777';
  const POINTER = 'SECRETPOINTER-do-not-leak;btih=' + 'ab'.repeat(20);
  const bodies = [];
  const store = await openIdoStore({ memory: true });
  const passkey = fakePasskey();
  const run = async (opts) => {
    const { origin = SITE, cards, want = ['keys'], purpose = 'site', extra = {} } = opts;
    const p = await page({ store, passkey, cards, wasm: false }); // PBKDF2 where the page has no WebAssembly: the same cards, a much shorter wait
    p.idp.obs.allow(true);
    const { req } = await newRequest({ want, purpose, extra: Object.assign({ pointer: POINTER, obs: { sid: SID } }, extra) });
    const r = await popup(p, req, origin);
    bodies.push(...p.rec.sent.map((s) => s.text));
    return { p, r, req };
  };
  // A passphrase identity (the nick and the passphrase are typed on cards), then a server sign-in whose statement the card shows.
  const a = await run({ cards: scriptedCards({ chooseUnlock: { method: 'passphrase', nickname: NICK }, passphrase: SECRET_PASS }) });
  assert.equal(a.r.res.ok, true);
  const b = await run({ origin: 'https://bank.example', cards: scriptedCards({ passphrase: SECRET_PASS }), want: ['proof'], purpose: 'server', extra: { challenge: { nonce: 'A'.repeat(22), statement: STATEMENT }, pointer: undefined } });
  assert.equal(b.r.res.ok, true);
  // A step that throws an error whose message carries an address and a host name: only its code is reported.
  const boom = Object.assign(new Error('failed for 10.1.2.3 and [2001:db8::1] at secret.example#frag'), { code: 'E_STORAGE' });
  const c = await run({ origin: 'https://forum.example', cards: scriptedCards({ signin: () => { throw boom; } }) });
  assert.equal(c.r.res.ok, false);
  assert.equal(c.r.res.code, 'E_IDP_UNREACHABLE');
  // A step that throws something that is not one of ours.
  const d = await run({ origin: 'https://wiki.example', cards: scriptedCards({ signin: () => { throw new TypeError('secret.example 192.168.0.9'); } }) });
  assert.equal(d.r.res.ok, false);
  const text = bodies.join('\n');
  assert.ok(text.length > 500);
  const K = (await store.getState());
  const shorts = Object.keys(K.origins).map((o) => K.origins[o].short);
  assert.ok(shorts.length >= 2 && shorts.every((s) => /^[a-z2-9]{4}-[a-z2-9]{4}$/.test(s)));
  const forbidden = [
    'SECRETPOINTER', POINTER, SECRET_PASS, 'quiet river', NICK, 'my-secret', STATEMENT, 'Super Secret', 'shop.example', 'bank.example', 'forum.example', 'wiki.example', 'secret.example', 'https://', 'http://',
    'p256:', '10.1.2.3', '192.168.0.9', '2001:db8', '#frag', '_mw/idp-return', a.req.requestId, a.req.epk, 'btih', 'abababab',
  ].concat(shorts);
  for (const f of forbidden) assert.ok(!text.includes(f), 'a report carries ' + f);
  assert.ok(!/(?:\d{1,3}\.){3}\d{1,3}/.test(text) && !/[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,}/i.test(text.replace(/"(?:[^"\\]|\\.)*"\s*:/g, '"k":')), 'no address of either kind');
  // Every string value is one word from a closed list (or the opener's report id), and nothing but known keys is there.
  const kinds = new Set(CARD_KINDS.concat(['popup', 'redirect']));
  const wants = new Set(['keys', 'proof', 'keys+proof', 'record', 'erase']);
  const methods = new Set(['passkey', 'passphrase', 'visit']);
  const keysSeen = new Set();
  for (const body of bodies.map((x) => JSON.parse(x))) {
    assert.deepEqual(problems(body), []);
    for (const e of body.events) {
      for (const k of Object.keys(e)) keysSeen.add(e.n + '.' + k);
      if (e.n === 'card') assert.ok(CARD_KINDS.indexOf(e.kind) >= 0, e.kind);
      if (e.n === 'action') assert.match(e.name, /^(?:[a-zA-Z]+\.(?:continue|cancel|restore|link|passkey|passphrase|visit|phrase|file|saved|later|check|keep|fresh|yes|no|close|done|error)|settings\.[a-zA-Z]+)$/, e.name);
      if (e.n === 'request') { assert.ok(kinds.has(e.kind) && wants.has(e.want) && typeof e.shared === 'boolean'); assert.ok(e.ref === undefined || e.ref === SID); }
      if (e.n === 'unlock') assert.ok(methods.has(e.method), e.method);
      if (e.n === 'result') { assert.match(e.code, /^(?:ok|E_[A-Z_]+)$/); assert.ok(Number.isInteger(e.ms) && e.ms >= 0); }
      if (e.n === 'error') assert.match(e.code, /^E_[A-Z_]+$/);
    }
  }
  assert.deepEqual(Array.from(keysSeen).sort(), [
    'action.n', 'action.name', 'action.t', 'card.kind', 'card.n', 'card.t', 'error.code', 'error.n', 'error.t', 'ready.n', 'ready.t',
    'request.kind', 'request.n', 'request.ref', 'request.shared', 'request.t', 'request.want', 'result.code', 'result.ms', 'result.n', 'result.t', 'unlock.method', 'unlock.n', 'unlock.t',
  ]);
});

test('the settings buttons: each press is named from the closed list; the site a button was pressed for is never read', async () => {
  let drawn = null;
  const cards = new Proxy({ lang: 'en' }, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'settings') return (model, handlers) => { drawn = { model, handlers }; return {}; };
      if (k === 'restore') return async () => null; // the person closes the restore card
      return async () => true;
    },
  });
  const store = await openIdoStore({ memory: true });
  const p = await page({ cards, store, withOpener: false });
  p.idp.obs.allow(true);
  await p.idp.bootHome();
  assert.ok(drawn, 'the settings card was drawn');
  assert.deepEqual(Object.keys(drawn.handlers).sort(), HANDLER_NAMES.slice().sort());
  drawn.handlers.stopSame('https://secret.example');
  drawn.handlers.hubOff('secret-hub.example');
  drawn.handlers.restore();
  await waitFor(() => p.rec.events().length === 0 && p.idp.obs.inspect().queued >= 5, 'the events of the press');
  p.idp.obs.flush('hide');
  const names = p.rec.events().map((e) => e.n + ':' + (e.kind || e.name || ''));
  assert.ok(names.indexOf('ready:') === 0 && names.indexOf('card:settings') === 1, names.join());
  for (const n of ['action:settings.stopSame', 'action:settings.hubOff', 'action:settings.restore']) assert.ok(names.indexOf(n) >= 0, n);
  assert.ok(!p.rec.sent.map((s) => s.text).join('').includes('secret'), 'the origin a button was pressed for is not in the report');
});

test('with the real cards: the first card names the host above its buttons, the first press lets the page report, later cards do not repeat the line, and nothing is lost', async () => {
  const clock = makeClock();
  const p = await page({ cards: null, clock, passkey: fakePasskey() });
  const root = () => p.doc.body.find((n) => n.getAttribute('data-mw-idp-cards') === '1');
  // `cards: null` above would fall back to the real ones: scriptedCards() is the default only when cards is undefined.
  assert.equal(p.idp.obs.inspect().allowed, false);
  const done = p.idp.bootSignin();
  await tick();
  const { req } = await newRequest({ extra: { obs: { sid: SID } } });
  p.win.deliver({ source: p.op, origin: SITE, data: req });
  const press = async (text) => {
    const button = await waitFor(() => root() && root().buttonByText(text), 'the button ' + text);
    clock.advance(500);
    button.click();
  };
  const lineOf = () => root().findAll((n) => n.getAttribute('data-mw-obs-line') === '1');
  await waitFor(() => root() && root().buttonByText('Create my identity'), 'the sign-in card');
  const first = lineOf();
  assert.equal(first.length, 1);
  assert.equal(first[0].textContent, idpT('obsDisclosure', { host: 'obs.example.org' }, 'en'));
  const card = root().children[0];
  assert.equal(card.children.indexOf(first[0]) + 1, card.children.findIndex((n) => /mw-actions/.test(n.getAttribute('class') || '')), 'above the first row of buttons');
  assert.equal(p.rec.sent.length, 0, 'the card is up and nothing was sent');
  await press('Create my identity');
  assert.equal(p.idp.obs.inspect().allowed, true, 'the first press of a button agreed');
  await waitFor(() => root() && root().buttonByText('With a passkey'), 'the unlock card');
  assert.equal(lineOf().length, 0, 'the second card does not repeat the line');
  await press('With a passkey');
  const r = await done;
  assert.equal(r.res.ok, true);
  assert.deepEqual(p.log, ['post', 'answer', 'send-final', 'close']);
  assert.equal(p.rec.sent.length, 1, 'everything since the page started went out in the final flush');
  assert.deepEqual(p.rec.names(), ['ready', 'request', 'card', 'action', 'card', 'action', 'unlock', 'result']);
  assert.deepEqual(p.rec.events().filter((e) => e.n === 'action').map((e) => e.name), ['signin.continue', 'chooseUnlock.passkey']);
  assert.equal(p.rec.events()[1].ref, SID);
});

test('with the real cards on the settings page: the first press of any button is the yes, and the timer sends what was waiting, in order', async () => {
  const clock = makeClock();
  const p = await page({ cards: null, clock, withOpener: false });
  await p.idp.bootHome();
  const root = () => p.doc.body.find((n) => n.getAttribute('data-mw-idp-cards') === '1');
  assert.ok(root().find((n) => n.getAttribute('data-mw-obs-line') === '1'), 'the settings card names the host too');
  assert.equal(p.timers.pending.size, 0, 'no timer while the person has not agreed');
  clock.advance(500);
  root().buttonByText('Restore an identity').click();
  assert.equal(p.idp.obs.inspect().allowed, true);
  assert.equal(p.timers.pending.size, 1);
  await waitFor(() => root().textContent.includes('Your 12 words, in order'), 'the restore card');
  assert.equal(root().findAll((n) => n.getAttribute('data-mw-obs-line') === '1').length, 0);
  p.timers.fire();
  assert.deepEqual(p.rec.sent.length, 1);
  assert.equal(p.rec.sent[0].final, false);
  assert.deepEqual(p.rec.sent[0].body.events.map((e) => e.n + ':' + (e.kind || e.name || '')), ['ready:', 'card:settings', 'action:settings.restore', 'card:restore']);
  assert.deepEqual(problems(p.rec.sent[0].body), []);
});

// ------------------------------------------------------------------------------------------------ 4. the sign-in client

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m };
}

/** A site window as test/unit/identity-client.test.mjs makes one: the popup records what is posted to it. */
function siteWindow({ href = SITE + '/page' } = {}) {
  const listeners = new Set();
  const popup = { closed: false, posts: [], onPost: null, postMessage(msg, target) { popup.posts.push({ msg, target }); if (popup.onPost) popup.onPost(msg, target); }, close() { popup.closed = true; } };
  const url = new URL(href);
  const w = {
    popup, opened: [],
    location: { origin: url.origin, href, hash: url.hash, pathname: url.pathname, assigned: [], assign(u) { this.assigned.push(u); }, replace(u) { this.replaced = u; } },
    history: { calls: [], replaceState(s, t, u) { w.history.calls.push(u); w.location.hash = ''; } },
    document: { querySelector: (sel) => (sel === 'meta[name="mw-idp"]' ? { getAttribute: () => IDP } : null) },
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(type, fn) { listeners.delete(fn); },
    deliver(ev) { for (const fn of Array.from(listeners)) fn(ev); },
    open(u, name, features) { w.opened.push({ url: u, name, features }); return popup; },
    sessionStorage: memoryStorage(),
    indexedDB: null,
  };
  return w;
}

const readyFrom = (win, data = {}) => win.deliver({ source: win.popup, origin: IDP, data: Object.assign({ v: 1, t: 'mw-idp-ready', build: '0.3.0-test' }, data) });
const BASE_KEYS = ['epk', 'purpose', 'requestId', 't', 'v', 'want'];

/** requestOf(say, { obsSid, configured }) -> the request the opener posted after the ready message `say`. */
async function requestOf(say, { configured, call } = {}) {
  client.resetCooldown();
  client.configure({ obsSid: configured === undefined ? null : configured });
  const win = siteWindow();
  const p = client.signIn(Object.assign({ win, purpose: 'site', want: ['keys'], pollMs: 5 }, call));
  readyFrom(win, say);
  await waitFor(() => win.popup.posts.length, 'the sign-in request to the identity origin');
  win.popup.closed = true;
  await assert.rejects(p, (e) => e.code === 'E_USER_CANCELLED');
  return win.popup.posts[0].msg;
}

test('the report id: 12 characters of [a-z2-9]; a request may carry { sid } and nothing else with it, in either transport', async () => {
  const { req } = await newRequest();
  const v = (obs) => client.validateRequest(Object.assign({}, req, { obs })).ok;
  assert.equal(client.validateRequest(req).ok, true, 'a request without it is what it always was');
  assert.equal(v({ sid: SID }), true);
  assert.equal(v({ sid: 'zzzzzzzzzzzz' }), true);
  assert.equal(v({ sid: '222222222222' }), true);
  for (const bad of [false, {}, { sid: SID, more: 1 }, { sid: 5 }, { sid: null }, { sid: '' }, { sid: SID.slice(1) }, { sid: SID + 'a' }, { sid: SID.toUpperCase() }, { sid: 'abcdefgh2340' }, { sid: 'abcdefgh2341' },
    { sid: 'abcdefgh-345' }, { sid: ' ' + SID.slice(1) }, 'abcdefgh2345', [SID], null, 7, true]) assert.equal(v(bad), false, JSON.stringify(bad));
  assert.equal(client.validateRequest(Object.assign({}, req, { obs: { sid: SID }, origin: SITE, ret: SITE + '/_mw/idp-return' }), { transport: 'redirect' }).ok, true);
  assert.deepEqual(client.REQUEST_FIELDS.filter((f) => f === 'obs'), ['obs']);
  assert.ok(client.isObsSid(SID) && !client.isObsSid('abc') && !client.isObsSid(undefined) && !client.isObsSid(123456789012));
  assert.match('a2345678abcz', client.OBS_SID_RE);
});

test('the opener names its report id only to an identity page that said obs: true, and only a valid one; an older page is sent the request it always knew', async () => {
  const cases = [
    ['a page that reports', { obs: true }, SID, { sid: SID }],
    ['an older page: no obs in its ready message', {}, SID, undefined],
    ['obs that is not exactly true', { obs: 'yes' }, SID, undefined],
    ['obs false', { obs: false }, SID, undefined],
    ['the opener has no reporter', { obs: true }, undefined, undefined],
    ['a string that is not a report id', { obs: true }, 'ABCDEFGHIJKL', undefined],
  ];
  for (const [why, say, sid, expected] of cases) {
    const msg = await requestOf(say, { configured: sid });
    assert.deepEqual(msg.obs, expected, why);
    assert.deepEqual(Object.keys(msg).sort(), expected ? BASE_KEYS.concat('obs').sort() : BASE_KEYS, why + ': no other key moves');
    assert.equal(client.validateRequest(msg).ok, true, why);
  }
  client.configure({ obsSid: null });
});

test('signIn({ obsSid }) is for one call and wins over configure(); configure({ obsSid: null }) turns it off; configure({ idp }) leaves it alone', async () => {
  const OTHER = 'zyxwvuts9876';
  assert.deepEqual((await requestOf({ obs: true }, { configured: SID, call: { obsSid: OTHER } })).obs, { sid: OTHER });
  assert.deepEqual((await requestOf({ obs: true }, { configured: SID, call: { obsSid: 'not a sid' } })).obs, { sid: SID }, 'a bad per-call id falls back to the configured one');
  assert.deepEqual((await requestOf({ obs: true }, { configured: undefined, call: { obsSid: OTHER } })).obs, { sid: OTHER });
  assert.equal((await requestOf({ obs: true }, { configured: undefined })).obs, undefined, 'nothing configured, nothing sent');
  client.configure({ obsSid: SID });
  client.configure({ idp: IDP });
  assert.deepEqual((await requestOf({ obs: true }, { configured: SID })).obs, { sid: SID });
  client.configure({ obsSid: null });
  client.configure({ idp: null });
  assert.equal((await requestOf({ obs: true }, { configured: null })).obs, undefined, 'null turns it off (the person switched reports off)');
  client.configure({ obsSid: 'bad' });
  assert.equal((await requestOf({ obs: true })).obs, undefined);
  client.configure({ obsSid: null });
});

test('the redirect round trip never carries the report id: there is no ready message to say the page reports, and the page is gone when the answer comes back', async () => {
  client.resetCooldown();
  client.configure({ obsSid: SID });
  const win = siteWindow();
  client.signIn({ win, redirect: true, obsSid: SID, purpose: 'site', want: ['keys'] });
  await waitFor(() => win.location.assigned.length, 'the redirect');
  const req = client.decodeFragment(win.location.assigned[0].split('#')[1]);
  assert.equal(req.t, 'mw-signin-req');
  assert.equal(req.obs, undefined);
  assert.deepEqual(Object.keys(req).sort(), ['epk', 'origin', 'purpose', 'requestId', 'ret', 't', 'v', 'want']);
  client.configure({ obsSid: null });
});

/** pair({ idpReports, sid }) -> the opener's request, the answer and the events of the identity page, with the two windows wired to each other. */
async function pair({ idpReports, sid }) {
  client.resetCooldown();
  client.configure({ obsSid: sid === undefined ? null : sid });
  const site = siteWindow();
  const idpOpener = { postMessage(msg) { site.deliver({ source: site.popup, origin: IDP, data: msg }); } };
  const ido = idoWindow({ openerWin: idpOpener });
  site.popup.onPost = (msg) => ido.deliver({ source: idpOpener, origin: SITE, data: msg });
  const doc = new FakeDocument();
  if (idpReports) doc.documentElement.setAttribute('data-mw-obs', OBS);
  const rec = recorder();
  const idp = createIdp({
    win: ido, doc, navigator: null, location: ido.location, cards: scriptedCards(), passkey: fakePasskey(), store: await openIdoStore({ memory: true }), wasm: true, ios: false,
    standalone: false, build: { version: '0.3.0', id: 'bbcb82098cda', hash: '', test: false }, obsSend: rec.send, obsTimers: fakeTimers(), obsRandom: walker(),
  });
  if (idp.obs) idp.obs.allow(true);
  const signing = client.signIn({ win: site, purpose: 'site', want: ['keys'], pollMs: 5 });
  const booted = idp.bootSignin();
  const out = await signing;
  await booted;
  client.configure({ obsSid: null });
  return { site, out, rec, idp, ready: site.popup.posts.length };
}

test('end to end: both sides report, the identity page labels its report with the opener\'s id; with only one side reporting nothing else changes and the sign-in works', async () => {
  const both = await pair({ idpReports: true, sid: SID });
  assert.equal(both.out.bundle.origin, SITE);
  assert.deepEqual(both.site.popup.posts[0].msg.obs, { sid: SID });
  const request = both.rec.events().find((e) => e.n === 'request');
  assert.equal(request.ref, SID, 'the operator can join the two timelines on this label');
  assert.deepEqual(both.rec.names(), ['ready', 'request', 'card', 'action', 'card', 'action', 'unlock', 'result']);
  assert.notEqual(both.rec.sent[0].body.sid, SID, 'the identity page has a session id of its own');
  // The identity page reports, the opener has no report id: no ref.
  const noRef = await pair({ idpReports: true, sid: undefined });
  assert.equal(noRef.out.bundle.origin, SITE);
  assert.equal(noRef.site.popup.posts[0].msg.obs, undefined);
  assert.ok(!('ref' in noRef.rec.events().find((e) => e.n === 'request')));
  // The opener has a report id, the identity page does not report (an older build, or no --obs): the id is not sent.
  const quiet = await pair({ idpReports: false, sid: SID });
  assert.equal(quiet.out.bundle.origin, SITE);
  assert.equal(quiet.site.popup.posts[0].msg.obs, undefined);
  assert.deepEqual(Object.keys(quiet.site.popup.posts[0].msg).sort(), BASE_KEYS);
  assert.equal(quiet.rec.sent.length, 0);
});

// ------------------------------------------------------------------------------------------------ 5. tools/build-idp.mjs --obs

/** tree(dir) -> Map of the files below dir (relative path to bytes), in a stable order. */
function tree(dir, rel = '', out = new Map()) {
  for (const name of readdirSync(join(dir, rel)).sort()) {
    const path = rel ? rel + '/' + name : name;
    if (statSync(join(dir, path)).isDirectory()) tree(dir, path, out);
    else out.set(path, readFileSync(join(dir, path)));
  }
  return out;
}

test('--obs takes an exact origin the way the apps block takes its identity origin: https, or http on a loopback host, nothing else', () => {
  for (const ok of ['https://obs.example.org', 'https://obs.example.org:8443', 'https://a.b.obs.example.org', 'http://127.0.0.1:8787', 'http://localhost:9000', 'http://[::1]:8000', 'https://xn--bcher-kva.example']) assert.equal(checkObsOrigin(ok), ok);
  const bad = ['', ' ', 'obs.example.org', '//obs.example.org', 'https://obs.example.org/', 'https://obs.example.org/e', 'https://obs.example.org?x=1', 'https://obs.example.org#f', 'https://user@obs.example.org',
    'https://user:pw@obs.example.org', 'http://obs.example.org', 'http://127.0.0.1.example.org', 'ftp://obs.example.org', 'wss://obs.example.org', 'javascript:alert(1)', 'https://Obs.Example.org',
    'https://obs.example.org:443', 'https://obs example.org', 'https://obs.example.org ', ' https://obs.example.org', 'https://obs.example.org"', "https://obs.example.org'", 'https://obs.example.org;',
    'https://obs.example.org\n', 'https://b\u00fccher.example', 'https://obs.example.org>', 'https://obs.example.org\\', null, undefined, 5, {}, ['https://obs.example.org']];
  for (const b of bad) assert.throws(() => checkObsOrigin(b), (e) => e instanceof UsageError && /--obs takes an exact https origin/.test(e.message), JSON.stringify(b));
  assert.equal(OBS_ORIGIN_MAX, 300);
  const long = (n) => 'https://' + 'a'.repeat(n - 'https://'.length - '.com'.length) + '.com';
  assert.equal(long(300).length, 300);
  assert.equal(checkObsOrigin(long(300)), long(300));
  assert.throws(() => checkObsOrigin(long(301)), UsageError);
});

test('headersWithObs adds the origin to the one connect-src directive and touches nothing else; pageFor writes data-mw-obs on the root element only when told to', () => {
  const src = readFileSync(join(ROOT, 'src/idp/_headers'), 'utf8');
  const out = headersWithObs(src, OBS);
  assert.equal(out, src.replace("connect-src 'self';", "connect-src 'self' " + OBS + ';'));
  assert.equal(out.split(OBS).length, 2, 'named once');
  const csp = (t) => t.split('\n').find((l) => l.trim().startsWith('Content-Security-Policy:')).split(': ')[1].split('; ');
  assert.deepEqual(csp(out).filter((d) => !d.startsWith('connect-src')), csp(src).filter((d) => !d.startsWith('connect-src')), 'every other directive is the same');
  assert.equal(csp(out).find((d) => d.startsWith('connect-src')), "connect-src 'self' " + OBS);
  assert.ok(!/'unsafe-inline'|'unsafe-eval'/.test(out), 'no inline script or eval is allowed');
  assert.deepEqual(out.split('\n').filter((l) => !l.includes('Content-Security-Policy')), src.split('\n').filter((l) => !l.includes('Content-Security-Policy')), 'every other header line is the same');
  assert.throws(() => headersWithObs("default-src 'none'", OBS), /no single connect-src/);
  assert.throws(() => headersWithObs("connect-src 'self'; x; connect-src 'self';", OBS), /no single connect-src/);
  assert.throws(() => headersWithObs("connect-src 'self' https://x.example;", OBS), /no single connect-src/);
  const html = readFileSync(join(ROOT, 'src/idp/index.html'), 'utf8');
  const args = { prefix: './', buildMeta: '0.3.0 abc def', sriJs: 'sha384-x', sriCss: 'sha384-y' };
  const plain = pageFor(html, args);
  assert.ok(!plain.includes('data-mw-obs'));
  assert.equal(pageFor(html, Object.assign({ obs: null }, args)), plain);
  assert.equal(pageFor(html, Object.assign({ obs: undefined }, args)), plain);
  const withObs = pageFor(html, Object.assign({ obs: OBS }, args));
  assert.equal(withObs, plain.replace('<html lang="en" data-mw-idp="1">', '<html lang="en" data-mw-idp="1" data-mw-obs="' + OBS + '">'));
  assert.throws(() => pageFor(html.replace('data-mw-idp="1"', 'data-x="1"'), Object.assign({ obs: OBS }, args)), /no root element/);
});

test('without --obs the build is the build it always was: twice the same bytes, _headers the source file, the pages the source with their three known swaps, build.json without an obs key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mw-idp-obs-'));
  try {
    const a = await buildIdp({ outDir: dir + '/a', quiet: true });
    const b = await buildIdp({ outDir: dir + '/b', quiet: true });
    const c = await buildIdp({ outDir: dir + '/c', quiet: true, obs: null });
    const [ta, tb, tc] = ['a', 'b', 'c'].map((x) => tree(dir + '/' + x));
    assert.deepEqual(Array.from(ta.keys()), ['_headers', 'build.json', 'idp.css', 'idp.js', 'index.html', 'signin/index.html', 'sw.js']);
    assert.deepEqual(Array.from(tb.keys()), Array.from(ta.keys()));
    assert.deepEqual(Array.from(tc.keys()), Array.from(ta.keys()));
    for (const [path, bytes] of ta) {
      assert.ok(bytes.equals(tb.get(path)), 'a build twice: ' + path + ' differs');
      assert.ok(bytes.equals(tc.get(path)), 'obs: null is no obs: ' + path + ' differs');
    }
    assert.deepEqual([a.buildId, a.bundleSha256, a.obs], [b.buildId, b.bundleSha256, null]);
    assert.equal(c.buildId, a.buildId);
    const src = (f) => readFileSync(join(ROOT, 'src/idp', f));
    assert.ok(ta.get('_headers').equals(src('_headers')), '_headers is the source file, byte for byte');
    const sri = (bytes) => 'sha384-' + createHash('sha384').update(bytes).digest('base64');
    const expected = (prefix) => src('index.html').toString('utf8')
      .replace('<meta name="mw-idp-build" content="0.3.0 dev">', '<meta name="mw-idp-build" content="0.3.0 ' + a.buildId + ' ' + a.bundleSha256 + '">')
      .replace('<link rel="stylesheet" href="./idp.css">', '<link rel="stylesheet" href="' + prefix + 'idp.css" integrity="' + sri(ta.get('idp.css')) + '">')
      .replace('<script type="module" src="./idp.js"></script>', '<script type="module" src="' + prefix + 'idp.js" integrity="' + sri(ta.get('idp.js')) + '"></script>');
    assert.equal(ta.get('index.html').toString('utf8'), expected('./'));
    assert.equal(ta.get('signin/index.html').toString('utf8'), expected('../'));
    for (const f of ['index.html', 'signin/index.html', '_headers', 'build.json', 'sw.js']) assert.ok(!ta.get(f).toString('utf8').includes('mw-obs'), f + ' names no endpoint');
    const info = JSON.parse(ta.get('build.json'));
    assert.deepEqual(Object.keys(info), ['name', 'version', 'buildId', 'bundleSha256', 'test', 'testPsl', 'hubSuffixes', 'sharedOrigins', 'hubTemplates', 'targets', 'esbuild', 'minified', 'qr', 'precache', 'files']);
    // The built bundle loads in Node (nothing runs outside the identity page) and has no endpoint of its own.
    const built = await import(new URL('file://' + dir + '/a/idp.js').href);
    assert.equal(built.readObsEndpoint(new FakeDocument()), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('with --obs the endpoint is data on both pages and one source in connect-src, idp.js is the same bytes, and the build id commits to it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mw-idp-obs-'));
  try {
    const plain = await buildIdp({ outDir: dir + '/p', quiet: true });
    const withObs = await buildIdp({ outDir: dir + '/o', quiet: true, obs: OBS });
    const [tp, to] = ['p', 'o'].map((x) => tree(dir + '/' + x));
    assert.deepEqual(Array.from(to.keys()), Array.from(tp.keys()), 'the same files');
    assert.ok(to.get('idp.js').equals(tp.get('idp.js')) && to.get('idp.css').equals(tp.get('idp.css')), 'the bundle and the style do not depend on the endpoint');
    assert.equal(withObs.bundleSha256, plain.bundleSha256);
    assert.match(withObs.buildId, /^[0-9a-f]{12}$/);
    assert.notEqual(withObs.buildId, plain.buildId, 'the build id commits to the endpoint');
    assert.equal(withObs.obs, OBS);
    assert.equal(to.get('_headers').toString('utf8'), tp.get('_headers').toString('utf8').replace("connect-src 'self';", "connect-src 'self' " + OBS + ';'));
    const headers = to.get('_headers').toString('utf8');
    assert.match(headers, /script-src 'self' 'wasm-unsafe-eval';/);
    assert.match(headers, /connect-src 'self' https:\/\/obs\.example\.org;/);
    assert.match(headers, /frame-ancestors 'none'/);
    assert.match(headers, /default-src 'none'/);
    assert.ok(!/'unsafe-inline'|'unsafe-eval'/.test(headers));
    for (const f of ['index.html', 'signin/index.html']) {
      const html = to.get(f).toString('utf8');
      assert.equal(html.split('data-mw-obs').length, 2, f + ': named once');
      assert.ok(html.includes('<html lang="en" data-mw-idp="1" data-mw-obs="' + OBS + '">'), f);
      assert.equal(html.replace(' data-mw-obs="' + OBS + '"', '').replace(withObs.buildId, plain.buildId), tp.get(f).toString('utf8'), f + ': the attribute and the build id are the only differences');
      assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), f + ': no inline script');
      assert.ok(html.includes('integrity="' + sriFor(to.get('idp.js')) + '"'), f + ': the script is still pinned');
    }
    assert.equal(to.get('sw.js').toString('utf8').split(withObs.buildId).join(plain.buildId), tp.get('sw.js').toString('utf8'), 'the worker carries the new build id and nothing else');
    const io = JSON.parse(to.get('build.json'));
    const ip = JSON.parse(tp.get('build.json'));
    assert.equal(io.obs, OBS);
    assert.deepEqual(Object.keys(io), Object.keys(ip).concat('obs'));
    assert.deepEqual(io.files.map((x) => x.path), ip.files.map((x) => x.path));
    for (const f of io.files) assert.equal(f.sha256, createHash('sha256').update(to.get(f.path)).digest('hex'), f.path);
    // Another endpoint is another build; the endpoint and a hub list are both in the id; a test build takes a loopback endpoint.
    const other = await buildIdp({ outDir: dir + '/x', quiet: true, obs: 'https://obs2.example.org' });
    assert.notEqual(other.buildId, withObs.buildId);
    const hub = await buildIdp({ outDir: dir + '/h', quiet: true, hubSuffixes: ['hub.example.org'] });
    const both = await buildIdp({ outDir: dir + '/hb', quiet: true, hubSuffixes: ['hub.example.org'], obs: OBS });
    assert.ok(new Set([plain.buildId, withObs.buildId, hub.buildId, both.buildId]).size === 4);
    const test = await buildIdp({ outDir: dir + '/t', quiet: true, test: true, testPsl: ['localhost'], obs: 'http://127.0.0.1:8787' });
    assert.match(test.buildId, /^test-[0-9a-f]{12}$/);
    assert.match(readFileSync(dir + '/t/_headers', 'utf8'), /connect-src 'self' http:\/\/127\.0\.0\.1:8787;/);
    await assert.rejects(buildIdp({ outDir: dir + '/bad', quiet: true, obs: 'http://obs.example.org' }), UsageError);
    assert.equal(existsSync(dir + '/bad'), false, 'a refused endpoint builds nothing');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the command line: --obs is checked before anything is built, named in the summary, and the --json output has an obs key only when it was given', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mw-idp-obs-cli-'));
  const run = (...args) => spawnSync(process.execPath, [join(ROOT, 'tools/build-idp.mjs'), ...args], { encoding: 'utf8' });
  try {
    for (const bad of ['https://obs.example.org/path', 'http://obs.example.org', '']) {
      const r = run('--obs=' + bad, '--out', dir + '/x', '--quiet');
      assert.equal(r.status, 2, JSON.stringify(bad));
      assert.match(r.stderr, /--obs takes an exact https origin/);
      assert.equal(existsSync(dir + '/x'), false, 'nothing was built');
    }
    const json = run('--obs', OBS, '--out', dir + '/y', '--json');
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.obs, OBS);
    assert.match(readFileSync(dir + '/y/index.html', 'utf8'), /data-mw-obs="https:\/\/obs\.example\.org"/);
    const plain = run('--out', dir + '/z', '--json');
    assert.equal(plain.status, 0, plain.stderr);
    assert.deepEqual(Object.keys(JSON.parse(plain.stdout)), ['outDir', 'buildId', 'bundleSha256', 'qrGzipBytes', 'test', 'testPsl', 'hubSuffixes', 'sharedOrigins', 'hubTemplates'], 'the same keys as before the option');
    const text = run('--obs', OBS, '--out', dir + '/w');
    assert.equal(text.status, 0, text.stderr);
    assert.ok(text.stdout.includes('usage reports: the pages name ' + OBS + ' and connect-src reaches it'));
    const textPlain = run('--out', dir + '/v');
    assert.ok(!/usage reports/.test(textPlain.stdout), 'no extra line without the option');
    assert.match(run('--help').stdout, /--obs <https origin>/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
