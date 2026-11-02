// Unit tests for src/loader/obs.js (plan obs-2026-11-02, lane L1): the usage reporter. No browser and no network: the clock, the timers,
// the transport and the navigator are injected, and the fakes of the drop-in tests (dropin-fake-timers.mjs, dropin-fake-dom.mjs) stand
// in for the page. A real browser run of the same module is in the L1 report (a Playwright script on loopback).
// Run: node --test test/unit/loader-obs.test.mjs
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createReporter, describeTarget, wrapPeerConnection, safeField, OBS_LIMITS } from '../../src/loader/obs.js';
import { installOfferTimeout } from '../../src/loader/connectivity.js';
import { createClock, flush as flushMicrotasks } from './dropin-fake-timers.mjs';
import { FakeDocument } from './dropin-fake-dom.mjs';

const OBS_SOURCE = fileURLToPath(new URL('../../src/loader/obs.js', import.meta.url));
const T0_MS = 1793600000000;
const SID_RE = /^[a-z2-9]{12}$/;

// A seeded generator, so the tests that draw random shapes are the same on every run.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ch = (code) => String.fromCharCode(code);
const EN_DASH = ch(0x2013);
const EM_DASH = ch(0x2014);

/** rig(over): a reporter on a manual clock whose transport records every post and answers true. */
function rig(over = {}) {
  const clock = createClock(T0_MS);
  const posts = [];
  const hide = { fn: null, off: false };
  const opts = Object.assign({
    endpoint: 'https://obs.example',
    page: 'door',
    build: 'bbcb82098cda',
    loader: '0.3.0',
    now: clock.now,
    timers: clock,
    random: seeded(1),
    send: (url, text, o) => {
      posts.push({ url, text, body: JSON.parse(text), final: !!(o && o.final) });
      return true;
    },
    visibility: { onHide(fn) { hide.fn = fn; return () => { hide.off = true; }; } },
  }, over);
  const r = createReporter(opts);
  return { r, clock, posts, hide };
}

const names = (post) => post.body.events.map((e) => e.n);

// ---------------------------------------------------------------------------------------------
// The limits and the endpoint
// ---------------------------------------------------------------------------------------------

test('OBS_LIMITS are the numbers of plan section 2.2 and cannot be changed', () => {
  assert.deepEqual(OBS_LIMITS, { flushMs: 2000, maxBatch: 50, maxQueue: 500, maxField: 200, maxBodyBytes: 16384, maxRetries: 3 });
  assert.equal(Object.isFrozen(OBS_LIMITS), true);
});

test('an endpoint is an exact https origin, or http on loopback; reports go to <origin>/e', () => {
  const good = [
    ['https://obs.example', 'https://obs.example/e', 'obs.example'],
    ['https://obs.example/', 'https://obs.example/e', 'obs.example'],
    ['https://obs.example:8443', 'https://obs.example:8443/e', 'obs.example'],
    ['https://OBS.Example', 'https://obs.example/e', 'obs.example'],
    ['http://127.0.0.1:8787', 'http://127.0.0.1:8787/e', '127.0.0.1'],
    ['http://localhost:3000', 'http://localhost:3000/e', 'localhost'],
    ['http://obs.localhost:8000', 'http://obs.localhost:8000/e', 'obs.localhost'],
    ['http://[::1]:3000', 'http://[::1]:3000/e', '[::1]'],
  ];
  for (const [endpoint, url, host] of good) {
    const { r, posts } = rig({ endpoint });
    assert.equal(r.inspect().enabled, true, endpoint);
    assert.equal(r.inspect().host, host, endpoint);
    r.allow(true);
    r.event('run.start');
    r.flush();
    assert.equal(posts.length, 1, endpoint);
    assert.equal(posts[0].url, url, endpoint);
  }
});

test('an endpoint that cannot be used gives an inert reporter: same shape, no network, no events', () => {
  const bad = [
    'http://obs.example', 'http://192.0.2.1', 'https://obs.example/path', 'https://obs.example/?x=1', 'https://obs.example?x=1',
    'https://obs.example#a', 'https://obs.example#', 'https://user:pw@obs.example', 'https://user@obs.example', 'ftp://obs.example',
    'wss://obs.example', 'https://', 'not a url', '', ' https://obs.example', 'https://obs.example ', 'https://obs.example/e',
    'https://' + 'a'.repeat(300) + '.example', null, undefined, 123, {}, [], true,
  ];
  for (const endpoint of bad) {
    const { r, posts } = rig({ endpoint });
    assert.deepEqual(r.inspect(), { host: '', enabled: false, allowed: false, queued: 0, sent: 0, dropped: 0, batches: 0, lastOk: null }, String(endpoint));
    assert.equal(r.sid, '');
    assert.equal(r.allow(true), false);
    assert.equal(r.event('run.start'), false);
    assert.equal(r.click({}), false);
    assert.equal(r.flush(), false);
    r.setWho('da9u-6qug');
    r.setSite('d680ff36');
    r.setNet({ type: 'wifi' });
    r.stop();
    assert.equal(posts.length, 0, String(endpoint));
  }
  assert.equal(createReporter().inspect().enabled, false, 'no options at all');
  assert.equal(createReporter(null).inspect().enabled, false);
});

// ---------------------------------------------------------------------------------------------
// The wire format
// ---------------------------------------------------------------------------------------------

test('a batch is the JSON object of plan section 2.2, keys in that order, sent as text', () => {
  const { r, posts, clock } = rig({ site: 'D680FF36AABBCCDD' });
  r.allow(true);
  clock.advance(1234);
  r.event('gate.shown', { kind: 'consent', host: 'obs.example' });
  r.flush();
  assert.equal(posts.length, 1);
  assert.equal(typeof posts[0].text, 'string');
  const b = posts[0].body;
  assert.deepEqual(Object.keys(b), ['v', 'sid', 'seq', 'page', 'build', 'loader', 'site', 'who', 'net', 'ua', 't0', 'events']);
  assert.equal(b.v, 1);
  assert.match(b.sid, SID_RE);
  assert.equal(b.seq, 0);
  assert.equal(b.page, 'door');
  assert.equal(b.build, 'bbcb82098cda');
  assert.equal(b.loader, '0.3.0');
  assert.equal(b.site, 'd680ff36', 'the first 8 hex characters, lower case');
  assert.equal(b.who, null);
  assert.equal(b.net, null);
  assert.deepEqual(Object.keys(b.ua), ['browser', 'mobile']);
  assert.equal(b.t0, 1793600000, 'creation time in whole seconds');
  assert.deepEqual(b.events, [{ t: 1234, n: 'gate.shown', kind: 'consent', host: 'obs.example' }]);
  assert.equal(r.sid, b.sid);
  assert.deepEqual(posts[0].text, JSON.stringify(b), 'no whitespace, nothing outside the object');
});

test('the session id is 12 characters of [a-z2-9], from the injected random, with a safe fallback, and it cannot be changed', () => {
  assert.equal(rig({ random: () => 0 }).r.sid, 'aaaaaaaaaaaa');
  assert.equal(rig({ random: () => 0.999999 }).r.sid, '999999999999');
  let i = 0;
  assert.equal(rig({ random: () => (i++ % 34) / 34 }).r.sid, 'abcdefghijkl');
  for (const bad of [() => NaN, () => 1, () => -1, () => 'x', () => { throw new Error('no'); }, () => undefined]) {
    assert.match(rig({ random: bad }).r.sid, SID_RE);
  }
  const seen = new Set();
  for (let k = 0; k < 40; k++) seen.add(createReporter({ endpoint: 'https://obs.example', send: () => true, visibility: { onHide() {} } }).sid);
  assert.equal(seen.size, 40, 'the default random source gives a new id each time');
  for (const sid of seen) assert.match(sid, SID_RE);
  const { r } = rig();
  assert.throws(() => { r.sid = 'x'; }, TypeError);
});

test('page, build, loader and site are cleaned to what the endpoint accepts', () => {
  for (const page of ['site', 'door', 'hub', 'idp']) assert.equal(first(rig({ page })).page, page);
  for (const page of ['bogus', '', null, undefined, 5, 'DOOR']) assert.equal(first(rig({ page })).page, 'site');
  assert.equal(first(rig({ build: 'not-hex' })).build, '');
  assert.equal(first(rig({ build: 'ABCDEF0123456789ABCDEF' })).build, 'abcdef0123456789');
  assert.equal(first(rig({ build: undefined })).build, '');
  // The loader field is a version or nothing: the endpoint takes no other shape (a name or an address cannot ride in it).
  assert.equal(first(rig({ loader: '0.3.0' })).loader, '0.3.0');
  assert.equal(first(rig({ loader: '0.3.1-rc.1' })).loader, '0.3.1-rc.1');
  assert.equal(first(rig({ loader: '1.2.3+build.5' })).loader, '1.2.3+build.5');
  for (const bad of ['0.3.0-rc.1 beta!', '1'.repeat(40), 'dev', '203.0.113.5', 'someone', '0.3', '0.3.0.1', '10.20.30-abcdefgh', ' ', '0.3.0 ']) assert.equal(first(rig({ loader: bad })).loader, bad === '0.3.0 ' ? '0.3.0' : '', JSON.stringify(bad));
  assert.equal(first(rig({ loader: 7 })).loader, '');
  assert.equal(first(rig({ site: '0123456789abcdef0123456789abcdef01234567' })).site, '01234567', 'a whole infohash is cut to 8');
  assert.equal(first(rig({ site: 'zz' })).site, '');
  assert.equal(first(rig({})).site, '');
  function first(rg) {
    rg.r.allow(true);
    rg.r.event('run.start');
    rg.r.flush();
    return rg.posts[0].body;
  }
});

test('t is ms since the reporter was created (whole numbers, never going back), t0 whole seconds', () => {
  const { r, posts, clock } = rig();
  r.allow(true);
  r.event('a.one');
  clock.advance(10);
  r.event('a.two');
  clock.advance(7.6);
  r.event('a.three');
  r.flush();
  assert.deepEqual(posts[0].body.events.map((e) => e.t), [0, 10, 18]);
  const c2 = createClock(T0_MS + 999);
  const r2 = createReporter({ endpoint: 'https://obs.example', now: c2.now, timers: c2, send: () => true, visibility: { onHide() {} } });
  r2.allow(true);
  assert.equal(r2.inspect().enabled, true);
  // a clock that steps back (or answers nonsense) must not make t go back or become NaN
  let wall = 5000;
  const posts3 = [];
  const r3 = createReporter({ endpoint: 'https://obs.example', now: () => wall, timers: createClock(), send: (u, t) => { posts3.push(JSON.parse(t)); return true; }, visibility: { onHide() {} } });
  r3.allow(true);
  wall = 6000; r3.event('a.one');
  wall = 5500; r3.event('a.two');
  wall = NaN; r3.event('a.three');
  wall = 7000; r3.event('a.four');
  r3.flush();
  assert.deepEqual(posts3[0].events.map((e) => e.t), [1000, 1000, 1000, 2000]);
  assert.equal(posts3[0].t0, 5);
});

const UA = {
  chromeDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  firefoxDesktop: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  safariIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  chromeIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.37 Mobile/15E148 Safari/604.1',
  firefoxIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/131.0 Mobile/15E148 Safari/605.1.15',
  edgeDesktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SM-F766W) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  node: 'Node.js/26',
};

test('ua is the browser family and a mobile flag, never the user agent string', () => {
  const run = (navigator) => {
    const { r, posts } = rig({ env: { navigator } });
    r.allow(true);
    r.event('run.start');
    r.flush();
    assert.doesNotMatch(posts[0].text, /Mozilla|AppleWebKit|Gecko|Chrome\/|Safari\/|Firefox\/|Node\.js|Macintosh|Android|iPhone/);
    return posts[0].body.ua;
  };
  assert.deepEqual(run({ userAgent: UA.chromeDesktop }), { browser: 'chromium', mobile: false });
  assert.deepEqual(run({ userAgent: UA.chromeAndroid }), { browser: 'chromium', mobile: true });
  assert.deepEqual(run({ userAgent: UA.firefoxDesktop }), { browser: 'firefox', mobile: false });
  assert.deepEqual(run({ userAgent: UA.firefoxAndroid }), { browser: 'firefox', mobile: true });
  assert.deepEqual(run({ userAgent: UA.safariMac }), { browser: 'webkit', mobile: false });
  assert.deepEqual(run({ userAgent: UA.safariIos }), { browser: 'webkit', mobile: true });
  assert.deepEqual(run({ userAgent: UA.chromeIos }), { browser: 'webkit', mobile: true }, 'every browser on iOS is WebKit');
  assert.deepEqual(run({ userAgent: UA.firefoxIos }), { browser: 'webkit', mobile: true });
  assert.deepEqual(run({ userAgent: UA.edgeDesktop }), { browser: 'chromium', mobile: false });
  assert.deepEqual(run({ userAgent: UA.samsung }), { browser: 'chromium', mobile: true });
  assert.deepEqual(run({ userAgent: UA.node }), { browser: 'other', mobile: false });
  assert.deepEqual(run({ userAgent: '' }), { browser: 'other', mobile: false });
  assert.deepEqual(run({}), { browser: 'other', mobile: false });
  assert.deepEqual(run(null), { browser: 'other', mobile: false });
  assert.deepEqual(run({ userAgent: 5 }), { browser: 'other', mobile: false });
  // userAgentData wins where it exists, and its mobile flag is the answer
  const brands = (...b) => b.map((brand) => ({ brand, version: '130' }));
  assert.deepEqual(run({ userAgent: UA.node, userAgentData: { brands: brands('Not A;Brand', 'Chromium', 'Google Chrome'), mobile: true } }), { browser: 'chromium', mobile: true });
  assert.deepEqual(run({ userAgent: UA.chromeDesktop, userAgentData: { brands: brands('Not A;Brand', 'Brave', 'Chromium'), mobile: false } }), { browser: 'chromium', mobile: false });
  assert.deepEqual(run({ userAgent: UA.firefoxDesktop, userAgentData: { brands: brands('Something') } }), { browser: 'firefox', mobile: false }, 'unknown brands fall back to the string');
  const throwing = { get userAgent() { throw new Error('blocked'); } };
  assert.deepEqual(run(throwing), { browser: 'other', mobile: false });
});

// ---------------------------------------------------------------------------------------------
// Events: names, fields, never a throw
// ---------------------------------------------------------------------------------------------

test('an event name is /^[a-z][a-z0-9.-]{1,48}$/; anything else is dropped and counted, never thrown', () => {
  const { r, posts } = rig();
  r.allow(true);
  const ok = ['ui.click', 'a-b.c9', 'ab', 'a'.repeat(49), 'ice.pc', 'boot.start', 'apps.first-yes'];
  const bad = ['', 'a', 'A.b', 'Ui.click', '1ab', 'a'.repeat(50), 'ui click', 'ui_click', '.ui', '-ui', 'ui:click', 'ui.click\n', null, undefined, 5, {}, [], () => 1, Symbol('x')];
  for (const n of ok) assert.equal(r.event(n), true, String(n));
  for (const n of bad) assert.doesNotThrow(() => assert.equal(r.event(n), false), String(typeof n));
  assert.equal(r.inspect().queued, ok.length);
  assert.equal(r.inspect().dropped, bad.length);
  r.flush();
  assert.deepEqual(names(posts[0]), ok);
});

test('fields: at most 12 keys; a string, a finite number, a boolean or null; anything else is dropped field by field', () => {
  const { r, posts } = rig();
  r.allow(true);
  r.event('x.fields', {
    s: 'text', n0: 0, n1: -1.5, nan: NaN, inf: Infinity, ninf: -Infinity, yes: true, no: false, nul: null, undef: undefined,
    fn: () => 1, obj: { a: 1 }, arr: [1], sym: Symbol('s'), big: BigInt(5), date: new Date(0),
  });
  r.flush();
  assert.deepEqual(posts[0].body.events[0], { t: 0, n: 'x.fields', s: 'text', n0: 0, n1: -1.5, yes: true, no: false, nul: null });
  // more than 12 keys: the first 12 that are valid
  const many = {};
  for (let i = 0; i < 20; i++) many['k' + i] = i;
  r.event('x.many', many);
  r.flush();
  const e = posts[1].body.events[0];
  assert.equal(Object.keys(e).length, 2 + 12);
  assert.equal(e.k11, 11);
  assert.equal(e.k12, undefined);
  // dropped keys do not use up the 12
  const mixed = { 'bad key': 1, '1x': 2, 'a-b': 3, _under: 4 };
  for (let i = 0; i < 12; i++) mixed['f' + i] = i;
  r.event('x.mixed', mixed);
  r.flush();
  assert.deepEqual(Object.keys(posts[2].body.events[0]), ['t', 'n'].concat(Array.from({ length: 12 }, (_, i) => 'f' + i)));
});

test('a field cannot replace t or n, and the keys that are not plain words are dropped', () => {
  const { r, posts } = rig();
  r.allow(true);
  r.event('x.keys', { t: 999999, n: 'evil.name', ok: 1 });
  const proto = JSON.parse('{"__proto__": "polluted", "constructor": "kept", "ok": 2}');
  r.event('x.proto', proto);
  r.flush();
  const [a, b] = posts[0].body.events;
  assert.deepEqual(a, { t: 0, n: 'x.keys', ok: 1 });
  assert.deepEqual(b, { t: 0, n: 'x.proto', constructor: 'kept', ok: 2 });
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(b), Object.prototype);
});

test('fields that are not an object are ignored; a getter that throws drops that event and nothing else', () => {
  const { r, posts } = rig();
  r.allow(true);
  for (const f of ['a string', 5, true, null, undefined, ['a', 'b'], () => 1]) r.event('x.plain', f);
  const boom = { get bad() { throw new Error('getter'); }, fine: 1 };
  assert.doesNotThrow(() => assert.equal(r.event('x.boom', boom), false));
  assert.equal(r.event('x.after', { fine: 2 }), true);
  r.flush();
  assert.deepEqual(names(posts[0]), ['x.plain', 'x.plain', 'x.plain', 'x.plain', 'x.plain', 'x.plain', 'x.plain', 'x.after']);
  for (const e of posts[0].body.events.slice(0, 7)) assert.deepEqual(Object.keys(e), ['t', 'n']);
  assert.equal(r.inspect().dropped, 1);
});

test('string fields go through safeField: masked, cut at 200, one line', () => {
  const { r, posts } = rig();
  r.allow(true);
  r.event('log', { m: 'peer 192.168.1.5:3478 and [2001:db8::1]:443\nabcd-efgh-2345 https://x.example/#key', long: 'z'.repeat(500) });
  r.flush();
  const e = posts[0].body.events[0];
  assert.equal(e.m, 'peer x.x.x.x and x.x.x.x abcd https://x.example/#');
  assert.equal(e.long.length, 200);
});

// ---------------------------------------------------------------------------------------------
// Batching and caps
// ---------------------------------------------------------------------------------------------

test('a batch holds at most 50 events; the rest waits for the next flush, in order, one batch per flush', () => {
  const { r, posts, clock } = rig();
  r.allow(true);
  for (let i = 0; i < 120; i++) r.event('x.n', { i });
  assert.equal(clock.pending(), 1, 'one timer, however many events');
  assert.equal(r.flush(), true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.events.length, 50);
  assert.equal(clock.pending(), 1, 'the timer runs again while events wait');
  clock.advance(1999);
  assert.equal(posts.length, 1);
  clock.advance(1);
  assert.equal(posts.length, 2);
  assert.equal(posts[1].body.events.length, 50);
  clock.advance(2000);
  assert.equal(posts.length, 3);
  assert.equal(posts[2].body.events.length, 20);
  assert.equal(clock.pending(), 0, 'no timer once the queue is empty');
  assert.deepEqual(posts.map((p) => p.body.seq), [0, 1, 2]);
  assert.deepEqual(posts.flatMap((p) => p.body.events.map((e) => e.i)), Array.from({ length: 120 }, (_, i) => i));
  assert.deepEqual(r.inspect(), { host: 'obs.example', enabled: true, allowed: true, queued: 0, sent: 120, dropped: 0, batches: 3, lastOk: true });
});

test('a batch body is at most 16384 bytes, counted in UTF-8 bytes, and no event is lost or reordered', () => {
  const { r, posts } = rig();
  r.allow(true);
  const euro = String.fromCharCode(0x20ac);
  const big = {};
  for (let i = 0; i < 12; i++) big['f' + i] = euro.repeat(200);
  for (let i = 0; i < 20; i++) r.event('x.big', Object.assign({ i }, big));
  let guard = 0;
  while (r.inspect().queued > 0 && guard++ < 50) r.flush();
  assert.ok(posts.length > 3, 'about 7 KB per event: only two fit a batch');
  for (const p of posts) {
    assert.ok(Buffer.byteLength(p.text, 'utf8') <= OBS_LIMITS.maxBodyBytes, 'batch of ' + Buffer.byteLength(p.text, 'utf8') + ' bytes');
    assert.ok(p.text.length < Buffer.byteLength(p.text, 'utf8'), 'the bytes, not the characters, are what is capped');
  }
  assert.deepEqual(posts.flatMap((p) => p.body.events.map((e) => e.i)), Array.from({ length: 20 }, (_, i) => i));
});

test('the worst event an event() call can make fits a batch, so no event is ever too large to send', () => {
  // 12 keys of 32 characters, each value 200 lone surrogates (JSON writes each as a 6 byte escape), the longest name: the largest event
  const { r, posts } = rig({ build: 'f'.repeat(16), loader: '9'.repeat(16), site: 'f'.repeat(8) });
  r.setWho('z'.repeat(24));
  r.setNet({ type: 'x'.repeat(16), effectiveType: 'y'.repeat(16) });
  r.allow(true);
  const fields = {};
  for (let i = 0; i < 12; i++) fields[('k' + i).padEnd(32, 'k')] = ch(0xd800).repeat(200);
  assert.equal(r.event('a'.repeat(49), fields), true);
  r.flush();
  assert.equal(posts.length, 1);
  const bytes = Buffer.byteLength(posts[0].text, 'utf8');
  assert.ok(bytes < OBS_LIMITS.maxBodyBytes, 'the worst case is ' + bytes + ' bytes');
  assert.equal(posts[0].body.events.length, 1);
  assert.equal(r.inspect().dropped, 0);
});

test('events that share who, site and net go in one batch; a change starts the next batch, so a sign-in never relabels earlier events', () => {
  const { r, posts, clock } = rig();
  r.allow(true);
  r.event('a.before');
  r.setWho('da9u-6qug');
  r.event('a.signed');
  r.event('a.signed2');
  r.setSite('D680FF36');
  r.event('a.site');
  r.setNet({ type: 'cellular', effectiveType: '4g' });
  r.event('a.net');
  r.setNet({ type: 'cellular', effectiveType: '4g' });
  r.event('a.net-same');
  r.setWho('da9u-6qug');
  r.event('a.who-same');
  r.setWho(null);
  r.event('a.out');
  for (let i = 0; i < 8; i++) clock.advance(2000);
  assert.deepEqual(posts.map(names), [['a.before'], ['a.signed', 'a.signed2'], ['a.site'], ['a.net', 'a.net-same', 'a.who-same'], ['a.out']]);
  assert.deepEqual(posts.map((p) => p.body.who), [null, 'da9u-6qug', 'da9u-6qug', 'da9u-6qug', null]);
  assert.deepEqual(posts.map((p) => p.body.site), ['', '', 'd680ff36', 'd680ff36', 'd680ff36']);
  assert.deepEqual(posts.map((p) => p.body.net), [null, null, null, { type: 'cellular', effectiveType: '4g' }, { type: 'cellular', effectiveType: '4g' }]);
  assert.deepEqual(posts.map((p) => p.body.seq), [0, 1, 2, 3, 4]);
});

// ---------------------------------------------------------------------------------------------
// The timer
// ---------------------------------------------------------------------------------------------

test('the 2 s timer runs only while something waits: none when idle, none before a yes, one while queued', () => {
  const { r, posts, clock } = rig();
  assert.equal(clock.pending(), 0, 'created: no timer');
  r.event('a.pending');
  assert.equal(clock.pending(), 0, 'events before the first yes only buffer: no timer, nothing can be sent');
  r.allow(true);
  assert.equal(clock.pending(), 1, 'a yes with buffered events starts it');
  r.event('a.two');
  assert.equal(clock.pending(), 1, 'a second event does not add a second timer');
  clock.advance(1999);
  assert.equal(posts.length, 0);
  clock.advance(1);
  assert.equal(posts.length, 1);
  assert.deepEqual(names(posts[0]), ['a.pending', 'a.two']);
  assert.equal(clock.pending(), 0);
  r.flush();
  assert.equal(posts.length, 1, 'flushing an empty queue sends nothing');
  r.event('a.later');
  assert.equal(clock.pending(), 1);
  r.flush();
  assert.equal(clock.pending(), 0, 'a manual flush that empties the queue clears the timer');
  assert.equal(posts.length, 2);
});

test('without an injected timers option the global setTimeout is used, looked up when it is needed (node:test mock timers)', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const posts = [];
    const r = createReporter({ endpoint: 'https://obs.example', send: (u, t) => { posts.push(JSON.parse(t)); return true; }, visibility: { onHide() {} } });
    r.allow(true);
    r.event('a.one');
    mock.timers.tick(1999);
    assert.equal(posts.length, 0);
    mock.timers.tick(1);
    assert.equal(posts.length, 1);
    r.event('a.two');
    r.stop();
    assert.equal(posts.length, 2, 'stop flushes');
  } finally {
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------------------------

test('before the first yes events only buffer; a yes sends them first, in order; nothing leaves earlier', () => {
  const { r, posts, clock } = rig();
  r.event('a.one');
  r.event('a.two');
  clock.advance(60000);
  assert.equal(r.flush(), false, 'a flush before the yes does nothing');
  assert.equal(posts.length, 0);
  assert.deepEqual(r.inspect(), { host: 'obs.example', enabled: true, allowed: false, queued: 2, sent: 0, dropped: 0, batches: 0, lastOk: null });
  assert.equal(r.allow(true), true);
  r.event('a.three');
  r.flush();
  assert.deepEqual(names(posts[0]), ['a.one', 'a.two', 'a.three']);
  assert.equal(r.inspect().allowed, true);
});

test('allow(false) drops the queue, ignores events until the next yes, and a yes resumes', () => {
  const { r, posts, clock } = rig();
  r.event('a.one');
  r.event('a.two');
  assert.equal(r.allow(false), false);
  assert.deepEqual(r.inspect(), { host: 'obs.example', enabled: true, allowed: false, queued: 0, sent: 0, dropped: 2, batches: 0, lastOk: null });
  assert.equal(r.event('a.ignored'), false);
  assert.equal(r.inspect().dropped, 2, 'an event ignored after a no is not counted: it was never collected');
  clock.advance(10000);
  r.flush();
  assert.equal(posts.length, 0);
  assert.equal(clock.pending(), 0);
  r.allow(true);
  r.event('a.back');
  r.flush();
  assert.deepEqual(names(posts[0]), ['a.back'], 'only what happened after the yes');
  // a no after sending drops what has been queued since
  r.event('a.queued');
  r.allow(false);
  assert.equal(r.inspect().queued, 0);
  assert.equal(r.inspect().dropped, 3);
  assert.equal(clock.pending(), 0);
  r.flush();
  assert.equal(posts.length, 1);
});

test('only an exact true allows; anything else is a no', () => {
  for (const v of ['true', 1, 'yes', {}, [], undefined, null, 0, '']) {
    const { r, posts } = rig();
    r.event('a.one');
    assert.equal(r.allow(v), false, String(v));
    assert.equal(r.inspect().allowed, false);
    r.flush();
    assert.equal(posts.length, 0);
  }
});

test('before a yes at most 500 events are held; the oldest are dropped and counted', () => {
  const { r, posts } = rig();
  for (let i = 0; i < 600; i++) r.event('a.n', { i });
  assert.deepEqual(r.inspect(), { host: 'obs.example', enabled: true, allowed: false, queued: 500, sent: 0, dropped: 100, batches: 0, lastOk: null });
  r.allow(true);
  r.flush();
  assert.equal(posts[0].body.events[0].i, 100, 'the oldest 100 are the ones that went');
  assert.equal(posts[0].body.events.length, 50);
});

// ---------------------------------------------------------------------------------------------
// Hide and stop
// ---------------------------------------------------------------------------------------------

test('when the page is hidden the queue is flushed at once, as a final flush, up to three batches', () => {
  const { r, posts, hide, clock } = rig();
  assert.equal(typeof hide.fn, 'function', 'the reporter subscribed to the visibility object');
  r.event('a.before-yes');
  hide.fn();
  assert.equal(posts.length, 0, 'hidden before a yes: nothing is sent');
  r.allow(true);
  for (let i = 0; i < 20; i++) r.event('a.n', { i });
  hide.fn();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].final, true);
  assert.equal(posts[0].body.events.length, 21);
  for (let i = 0; i < 400; i++) r.event('a.m', { i });
  hide.fn();
  assert.equal(posts.length, 4, 'three more batches, not eight');
  assert.deepEqual(posts.slice(1).map((p) => p.body.events.length), [50, 50, 50]);
  assert.equal(r.inspect().queued, 250);
  assert.equal(clock.pending(), 1, 'the rest still has its timer');
  clock.advance(2000);
  assert.equal(posts.length, 5);
  assert.equal(posts[4].final, false, 'the timer flush is an ordinary one');
});

test('stop(): a final flush, the timer off, the hide subscription off, and nothing after it', () => {
  const { r, posts, hide, clock } = rig();
  r.allow(true);
  r.event('a.one');
  r.event('a.two');
  r.stop();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].final, true);
  assert.deepEqual(names(posts[0]), ['a.one', 'a.two']);
  assert.equal(clock.pending(), 0);
  assert.equal(hide.off, true);
  assert.equal(r.inspect().enabled, false);
  assert.equal(r.inspect().allowed, false);
  assert.equal(r.event('a.after'), false);
  assert.equal(r.allow(true), false);
  assert.equal(r.flush(), false);
  r.stop();
  assert.equal(posts.length, 1);
  assert.equal(r.inspect().sent, 2);
});

test('stop() before a yes sends nothing and counts the buffer as dropped; after a no it is a no-op', () => {
  const a = rig();
  a.r.event('a.one');
  a.r.stop();
  assert.equal(a.posts.length, 0);
  assert.deepEqual(a.r.inspect(), { host: 'obs.example', enabled: false, allowed: false, queued: 0, sent: 0, dropped: 1, batches: 0, lastOk: null });
  const b = rig();
  b.r.event('a.one');
  b.r.allow(false);
  b.r.stop();
  assert.equal(b.posts.length, 0);
});

test('stop() keeps no failed batch for later: the one try is the last', () => {
  const posts = [];
  const { r } = rig({ send: (u, t) => { posts.push(t); return false; } });
  r.allow(true);
  r.event('a.one');
  r.stop();
  assert.equal(posts.length, 1);
  assert.deepEqual(r.inspect(), { host: 'obs.example', enabled: false, allowed: false, queued: 0, sent: 0, dropped: 1, batches: 0, lastOk: false });
});

// ---------------------------------------------------------------------------------------------
// Retries
// ---------------------------------------------------------------------------------------------

test('a failed batch keeps its seq and its body and goes again at the next flush', () => {
  const texts = [];
  let answer = false;
  const { r, clock } = rig({ send: (u, t) => { texts.push(t); return answer; } });
  r.allow(true);
  r.event('a.one');
  r.event('a.two');
  clock.advance(2000);
  assert.equal(texts.length, 1);
  assert.deepEqual(r.inspect(), { host: 'obs.example', enabled: true, allowed: true, queued: 2, sent: 0, dropped: 0, batches: 0, lastOk: false });
  assert.equal(clock.pending(), 1, 'the timer runs for the retry');
  r.event('a.three');
  answer = true;
  clock.advance(2000);
  assert.equal(texts.length, 2);
  assert.equal(texts[1], texts[0], 'the same body, the same seq: a duplicate can be told from a new batch');
  assert.equal(JSON.parse(texts[0]).seq, 0);
  clock.advance(2000);
  assert.equal(texts.length, 3);
  assert.equal(JSON.parse(texts[2]).seq, 1, 'the next batch is the next seq');
  assert.deepEqual(JSON.parse(texts[2]).events.map((e) => e.n), ['a.three']);
  assert.deepEqual(r.inspect(), { host: 'obs.example', enabled: true, allowed: true, queued: 0, sent: 3, dropped: 0, batches: 2, lastOk: true });
  assert.equal(clock.pending(), 0);
});

test('at most 3 tries per batch, then it is dropped and counted; the next batch is unaffected', () => {
  const texts = [];
  let answer = false;
  const { r, clock } = rig({ send: (u, t) => { texts.push(t); return answer; } });
  r.allow(true);
  r.event('a.one');
  for (let i = 0; i < 3; i++) clock.advance(2000);
  assert.equal(texts.length, 3, 'one try and two retries');
  assert.deepEqual(r.inspect(), { host: 'obs.example', enabled: true, allowed: true, queued: 0, sent: 0, dropped: 1, batches: 0, lastOk: false });
  assert.equal(clock.pending(), 0);
  clock.advance(10000);
  assert.equal(texts.length, 3, 'a dropped batch is not tried again');
  answer = true;
  r.event('a.two');
  clock.advance(2000);
  assert.equal(JSON.parse(texts[3]).seq, 1);
  assert.deepEqual(r.inspect(), { host: 'obs.example', enabled: true, allowed: true, queued: 0, sent: 1, dropped: 1, batches: 1, lastOk: true });
});

test('a send that returns a promise: one at a time, false or a rejection is a failure, anything else a success', async () => {
  const pending = [];
  const texts = [];
  const { r, clock } = rig({ send: (u, t) => { texts.push(t); return new Promise((resolve, reject) => pending.push({ resolve, reject })); } });
  r.allow(true);
  r.event('a.one');
  r.flush();
  assert.equal(texts.length, 1);
  assert.deepEqual(r.inspect(), { host: 'obs.example', enabled: true, allowed: true, queued: 1, sent: 0, dropped: 0, batches: 0, lastOk: null }, 'in flight still counts as queued');
  r.event('a.two');
  assert.equal(r.flush(), false, 'no second request while one is in flight');
  clock.advance(2000);
  assert.equal(texts.length, 1);
  pending[0].resolve(false);
  await flushMicrotasks();
  assert.equal(r.inspect().lastOk, false);
  clock.advance(2000);
  assert.equal(texts.length, 2);
  assert.equal(JSON.parse(texts[1]).seq, 0, 'the retry of the failed batch comes first');
  pending[1].reject(new Error('network'));
  await flushMicrotasks();
  clock.advance(2000);
  assert.equal(texts.length, 3);
  pending[2].resolve(undefined);
  await flushMicrotasks();
  assert.equal(r.inspect().sent, 1, 'an answer that is not false counts as success');
  assert.equal(r.inspect().lastOk, true);
  clock.advance(2000);
  assert.equal(JSON.parse(texts[3]).seq, 1);
  pending[3].resolve(true);
  await flushMicrotasks();
  assert.deepEqual(r.inspect(), { host: 'obs.example', enabled: true, allowed: true, queued: 0, sent: 2, dropped: 0, batches: 2, lastOk: true });
  assert.equal(clock.pending(), 0);
});

test('a send that never answers is a failure after 15 s; its late answer is ignored', async () => {
  const pending = [];
  const texts = [];
  const { r, clock } = rig({ send: (u, t) => { texts.push(t); return new Promise((resolve) => pending.push(resolve)); } });
  r.allow(true);
  r.event('a.one');
  r.flush();
  clock.advance(14999);
  assert.equal(r.inspect().lastOk, null);
  clock.advance(1);
  assert.equal(r.inspect().lastOk, false);
  assert.equal(r.inspect().queued, 1, 'kept for a retry');
  pending[0](true);
  await flushMicrotasks();
  assert.equal(r.inspect().sent, 0, 'the late success does not count twice or undo the failure');
  clock.advance(2000);
  assert.equal(texts.length, 2);
  assert.equal(clock.pending(), 1, 'only the watchdog of the second try');
  pending[1](true);
  await flushMicrotasks();
  assert.equal(clock.pending(), 0, 'an answer clears its watchdog');
  assert.equal(r.inspect().sent, 1);
});

test('a send that returns nothing, throws, or returns true behaves as documented', () => {
  const none = rig({ send: () => undefined });
  none.r.allow(true);
  none.r.event('a.one');
  none.r.flush();
  assert.equal(none.r.inspect().sent, 1, 'undefined is not an explicit failure');
  const thrower = rig({ send: () => { throw new Error('blocked'); } });
  thrower.r.allow(true);
  thrower.r.event('a.one');
  assert.doesNotThrow(() => thrower.r.flush());
  assert.equal(thrower.r.inspect().lastOk, false);
  assert.equal(thrower.r.inspect().queued, 1);
});

test('a final flush sends the batch that failed before it, once, with the new ones', () => {
  const texts = [];
  let answer = false;
  const { r, hide } = rig({ send: (u, t) => { texts.push(t); return answer; } });
  r.allow(true);
  r.event('a.one');
  r.flush();
  r.event('a.two');
  answer = true;
  hide.fn();
  assert.deepEqual(texts.map((t) => JSON.parse(t).events.map((e) => e.n)), [['a.one'], ['a.one'], ['a.two']]);
  assert.deepEqual(r.inspect(), { host: 'obs.example', enabled: true, allowed: true, queued: 0, sent: 2, dropped: 0, batches: 2, lastOk: true });
});

test('a no while a batch waits for a retry drops it too', () => {
  const { r, clock } = rig({ send: () => false });
  r.allow(true);
  r.event('a.one');
  r.flush();
  assert.equal(r.inspect().queued, 1);
  r.allow(false);
  assert.deepEqual(r.inspect(), { host: 'obs.example', enabled: true, allowed: false, queued: 0, sent: 0, dropped: 1, batches: 0, lastOk: false });
  assert.equal(clock.pending(), 0);
});

// ---------------------------------------------------------------------------------------------
// inspect: the counts always add up
// ---------------------------------------------------------------------------------------------

test('every event handed to a live reporter is exactly one of queued, sent or dropped, whatever happens to it', async () => {
  for (let seed = 1; seed <= 12; seed++) {
    const rnd = seeded(seed);
    const { r, clock } = rig({
      send: () => {
        const k = rnd();
        if (k < 0.5) return true;
        if (k < 0.7) return false;
        if (k < 0.85) return Promise.resolve(rnd() < 0.5);
        return Promise.reject(new Error('x'));
      },
    });
    let handed = 0;
    let denied = false; // after a no an event is ignored, not counted: it was never collected
    for (let step = 0; step < 300; step++) {
      const k = rnd();
      if (k < 0.55) {
        const n = 1 + Math.floor(rnd() * 8);
        for (let i = 0; i < n; i++) {
          if (!denied) handed++;
          r.event(rnd() < 0.05 ? 'BAD NAME' : 'a.n', { i: step });
        }
      } else if (k < 0.7) r.flush();
      else if (k < 0.85) clock.advance(Math.floor(rnd() * 5000));
      else if (k < 0.9) { r.allow(true); denied = false; }
      else if (k < 0.93) { r.allow(false); denied = true; }
      else if (k < 0.97) await flushMicrotasks(2);
      else clock.advance(16000);
      const s = r.inspect();
      assert.ok(s.queued >= 0 && s.sent >= 0 && s.dropped >= 0);
      assert.equal(s.queued + s.sent + s.dropped, handed, 'seed ' + seed + ' step ' + step);
    }
    r.stop();
    await flushMicrotasks();
    clock.advance(20000);
    await flushMicrotasks();
    const s = r.inspect();
    assert.equal(s.queued + s.sent + s.dropped, handed, 'seed ' + seed + ' at the end');
    assert.equal(s.enabled, false);
  }
});

// ---------------------------------------------------------------------------------------------
// setWho, setSite, setNet, click
// ---------------------------------------------------------------------------------------------

function sendOne(r, posts) {
  r.allow(true);
  r.event('a.probe');
  r.flush();
  return posts[posts.length - 1].body;
}

test('setWho takes the short id as the header shows it (two groups of 4 from the identity page\'s alphabet) or null', () => {
  for (const [given, kept] of [['da9u-6qug', 'da9u-6qug'], ['DA9U-6QUG', 'da9u-6qug'], ['  da9u-6qug ', 'da9u-6qug'], ['aaaa-aaaa', 'aaaa-aaaa'], ['ijkm-npqr', 'ijkm-npqr'], ['a'.repeat(24), null], ['a'.repeat(25), null],
    ['pat-example', null], ['someone', null], ['abcd-efg', null], ['abcd-efghi', null], ['abcdefgh', null], ['abcd_efgh', null], ['abcd-efg0', null], ['abcd-efg1', null], ['abcd-efgl', null], ['abcd-efgo', null],
    ['has space', null], ['under_score', null], ['name@host', null], ['', null], [5, null], [{}, null], [undefined, null], [null, null], ['Alice Example', null], ['203.0.113.5', null]]) {
    const { r, posts } = rig();
    r.setWho(given);
    assert.equal(sendOne(r, posts).who, kept, String(given));
  }
});

test('setSite keeps the first 8 hex characters; setNet keeps coarse words only', () => {
  for (const [given, kept] of [['d680ff36', 'd680ff36'], ['D680FF36', 'd680ff36'], ['d680ff36aabbccdd', 'd680ff36'], ['abc', 'abc'], ['xyz', ''], ['d680-ff36', ''], ['', ''], [null, ''], [7, '']]) {
    const { r, posts } = rig();
    r.setSite(given);
    assert.equal(sendOne(r, posts).site, kept, String(given));
  }
  for (const [given, kept] of [
    [{ type: 'cellular', effectiveType: '4g' }, { type: 'cellular', effectiveType: '4g' }],
    [{ type: 'WiFi', effectiveType: '4G' }, { type: 'wifi', effectiveType: '4g' }],
    [{ type: 'Wi-Fi!', effectiveType: '4G' }, { type: 'other', effectiveType: '4g' }],
    [{ effectiveType: 'slow-2g' }, { type: 'unknown', effectiveType: 'slow-2g' }],
    [{ type: 'ethernet' }, { type: 'ethernet', effectiveType: 'unknown' }],
    [{ type: 'x'.repeat(40), effectiveType: 'y'.repeat(40) }, { type: 'other', effectiveType: 'unknown' }],
    [{ type: 'wifi 192.168.1.1', effectiveType: 5 }, { type: 'other', effectiveType: 'unknown' }],
    [{ type: '203.0.113.5', effectiveType: 'abcdefgh2345' }, { type: 'other', effectiveType: 'unknown' }],
    [{}, null], [null, null], [undefined, null], ['cellular', null], [5, null], [{ type: '', effectiveType: '' }, null],
  ]) {
    const { r, posts } = rig();
    r.setNet(given);
    assert.deepEqual(sendOne(r, posts).net, kept, JSON.stringify(given));
  }
  const { r, posts } = rig();
  r.setNet({ type: 'cellular', effectiveType: '4g' });
  r.setNet(null);
  assert.equal(sendOne(r, posts).net, null, 'setNet(null) clears it');
});

test('click(target, extra) is the ui.click event of describeTarget plus the extra fields', () => {
  const doc = new FakeDocument();
  const btn = doc.createElement('button', { 'data-role': 'gate-accept' });
  btn.textContent = 'Share and load';
  const { r, posts } = rig();
  r.allow(true);
  assert.equal(r.click(btn, { trusted: true, type: 'click' }), true);
  assert.equal(r.click(btn), true);
  assert.equal(r.click(null, { trusted: false }), true);
  assert.equal(r.click(btn, 'not an object'), true);
  r.flush();
  assert.deepEqual(posts[0].body.events, [
    { t: 0, n: 'ui.click', role: 'gate-accept', text: 'Share and load', trusted: true, type: 'click' },
    { t: 0, n: 'ui.click', role: 'gate-accept', text: 'Share and load' },
    { t: 0, n: 'ui.click', tag: 'unknown', trusted: false },
    { t: 0, n: 'ui.click', role: 'gate-accept', text: 'Share and load' },
  ]);
});

// ---------------------------------------------------------------------------------------------
// The default transport: fetch keepalive first (a cors request: the real Origin, an answer), then sendBeacon with a text/plain Blob
// ---------------------------------------------------------------------------------------------

function transportRig(env) {
  const clock = createClock(T0_MS);
  const r = createReporter({ endpoint: 'https://obs.example', now: clock.now, timers: clock, random: seeded(2), env, visibility: { onHide() {} } });
  r.allow(true);
  return { r, clock };
}

test('the default send is fetch: POST, text/plain, keepalive, cors, no credentials, no referrer; the beacon is not used while fetch works', async () => {
  const beacons = [];
  const fetches = [];
  const nav = { userAgent: UA.chromeDesktop, sendBeacon(url, blob) { beacons.push({ url, blob, self: this }); return true; } };
  const { r } = transportRig({ navigator: nav, fetch: (url, init) => { fetches.push({ url, init }); return Promise.resolve({ ok: true, status: 204 }); } });
  r.event('a.one', { m: 'hello' });
  r.flush();
  assert.equal(fetches.length, 1);
  assert.equal(beacons.length, 0, 'fetch was taken, no beacon: a no-cors beacon carries Origin null under a no-referrer policy and is refused');
  assert.equal(fetches[0].url, 'https://obs.example/e');
  const init = fetches[0].init;
  assert.equal(init.method, 'POST');
  assert.equal(init.keepalive, true);
  assert.equal(init.mode, 'cors');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.deepEqual(init.headers, { 'content-type': 'text/plain' });
  assert.equal(typeof init.body, 'string');
  assert.equal(JSON.parse(init.body).events[0].m, 'hello');
  await flushMicrotasks();
  assert.deepEqual(r.inspect(), { host: 'obs.example', enabled: true, allowed: true, queued: 0, sent: 1, dropped: 0, batches: 1, lastOk: true });
});

test('when there is no fetch, or it throws at once (the keepalive quota), the beacon is used: a text/plain Blob, called as a method of navigator, counted as sent without an answer', async () => {
  for (const f of [null, () => { throw new TypeError('keepalive quota'); }]) {
    const beacons = [];
    const nav = { userAgent: UA.chromeDesktop, sendBeacon(url, blob) { beacons.push({ url, blob, self: this }); return true; } };
    const { r } = transportRig({ navigator: nav, fetch: f });
    r.event('a.one', { m: 'hello' });
    r.flush();
    assert.equal(beacons.length, 1);
    assert.equal(beacons[0].url, 'https://obs.example/e');
    assert.equal(beacons[0].self, nav, 'called as a method of navigator');
    assert.equal(beacons[0].blob.type, 'text/plain');
    const body = JSON.parse(await beacons[0].blob.text());
    assert.equal(body.events[0].m, 'hello');
    assert.equal(r.inspect().sent, 1);
    assert.equal(r.inspect().lastOk, true);
  }
});

test('a fetch that answers with an error status, rejects or throws is a failure and is retried; no transport at all is a failure', async () => {
  for (const f of [() => Promise.resolve({ ok: false, status: 500 }), () => Promise.reject(new TypeError('Failed to fetch')), () => { throw new TypeError('keepalive quota'); }, () => Promise.resolve(null)]) {
    const { r, clock } = transportRig({ navigator: {}, fetch: f });
    r.event('a.one');
    r.flush();
    await flushMicrotasks();
    assert.equal(r.inspect().lastOk, false);
    assert.equal(r.inspect().queued, 1, 'kept for the next try');
    assert.equal(clock.pending(), 1);
  }
  const none = transportRig({ navigator: null, fetch: null });
  none.r.event('a.one');
  none.r.flush();
  assert.equal(none.r.inspect().lastOk, false);
});

test('the final flush prefers fetch keepalive (its answer can be read); with no fetch it falls back to the beacon', async () => {
  const beacons = [];
  const fetches = [];
  const nav = { sendBeacon: (url, blob) => { beacons.push({ url, blob }); return true; } };
  const a = transportRig({ navigator: nav, fetch: (url, init) => { fetches.push({ url, init }); return Promise.resolve({ ok: true }); } });
  a.r.event('a.one');
  a.r.stop();
  assert.equal(fetches.length, 1);
  assert.equal(beacons.length, 0);
  await flushMicrotasks();
  assert.equal(a.r.inspect().sent, 1);
  const b = transportRig({ navigator: nav, fetch: null });
  b.r.event('a.one');
  b.r.stop();
  assert.equal(beacons.length, 1);
  assert.equal(b.r.inspect().sent, 1);
  const c = transportRig({ navigator: nav, fetch: () => { throw new TypeError('quota'); } });
  c.r.event('a.one');
  c.r.stop();
  assert.equal(beacons.length, 2, 'a refused keepalive request falls back to the beacon');
});

// ---------------------------------------------------------------------------------------------
// safeField: the masks of plan section 4
// ---------------------------------------------------------------------------------------------

function table(rows) {
  for (const [input, expected] of rows) assert.equal(safeField(input), expected, JSON.stringify(input));
}

test('safeField: numbers must be finite, booleans and null pass, everything that is not a string, number, boolean or null becomes null', () => {
  assert.equal(safeField(0), 0);
  assert.equal(safeField(-1.5), -1.5);
  assert.equal(safeField(1e21), 1e21);
  assert.equal(safeField(true), true);
  assert.equal(safeField(false), false);
  assert.equal(safeField(null), null);
  for (const v of [NaN, Infinity, -Infinity, undefined, {}, { a: 1 }, [], ['a'], () => 1, Symbol('s'), BigInt(1), new Date(0), new String('s'), new Number(1), /x/]) {
    assert.equal(safeField(v), null, String(typeof v));
  }
  assert.equal(safeField(''), '');
  assert.equal(safeField('   '), '');
});

test('safeField: IPv4 literals become x.x.x.x, with their port, wherever they stand', () => {
  table([
    ['192.168.1.5', 'x.x.x.x'],
    ['peer 10.0.0.1 connected', 'peer x.x.x.x connected'],
    ['ip=10.0.0.1,', 'ip=x.x.x.x,'],
    ['(1.2.3.4)', '(x.x.x.x)'],
    ['[1.2.3.4]', '[x.x.x.x]'],
    ['"1.2.3.4"', '"x.x.x.x"'],
    ["'1.2.3.4'", "'x.x.x.x'"],
    ['1.2.3.4:5678', 'x.x.x.x'],
    ['1.2.3.4:5678 up', 'x.x.x.x up'],
    ['http://1.2.3.4:8080/path?q=1', 'http://x.x.x.x/path?q=1'],
    ['wss://203.0.113.10:8000/announce', 'wss://x.x.x.x/announce'],
    ['255.255.255.255', 'x.x.x.x'],
    ['0.0.0.0', 'x.x.x.x'],
    ['127.0.0.1', 'x.x.x.x'],
    ['192.168.001.001', 'x.x.x.x'],
    ['010.000.000.001', 'x.x.x.x'],
    ['a192.168.0.1', 'ax.x.x.x'],
    ['ip192.168.0.1', 'ipx.x.x.x'],
    ['192.168.0.1abc', 'x.x.x.xabc'],
    ['1.2.3.4 5.6.7.8', 'x.x.x.x x.x.x.x'],
    ['1.2.3.4,5.6.7.8', 'x.x.x.x,x.x.x.x'],
    ['1.2.3.4/5.6.7.8', 'x.x.x.x/x.x.x.x'],
    ['1.2.3.4-5.6.7.8', 'x.x.x.x-x.x.x.x'],
    ['1.2.3.4.5', 'x.x.x.x.5'],
    ['host 192.168.0.1.nip.io', 'host x.x.x.x.nip.io'],
    ['from 8.8.8.8:53 to 9.9.9.9:53', 'from x.x.x.x to x.x.x.x'],
    ['port 3478 on 198.51.100.7', 'port 3478 on x.x.x.x'],
  ]);
});

test('safeField: what is not an IPv4 address is left alone (versions, dates, times, numbers)', () => {
  const same = ['256.1.1.1', '1.2.3', '1.2.3.256', '1.2.3.4567', '1234.1.1.1', '999.999.999.999', '300.300.300.300', '0.3.0', 'v1.2.3', 'Chrome/120.0.6099.109',
    '2026-11-02', '12:34:56', '12:34:56.789', '2026-11-02T10:20:30.123Z', '1.2', '1,2,3,4', '1 2 3 4', 'x.x.x.x', '3.14159', '1.2.3.', '.1.2.3', 'build 12.34.56'];
  for (const s of same) assert.equal(safeField(s), s);
});

test('safeField: IPv6 literals become x.x.x.x in every form: compressed, full, mapped, with a zone, in brackets, with a port', () => {
  table([
    ['2001:db8::1', 'x.x.x.x'],
    ['2001:DB8::ABCD', 'x.x.x.x'],
    ['::1', 'x.x.x.x'],
    ['1::', 'x.x.x.x'],
    ['fe80::', 'x.x.x.x'],
    ['a::b', 'x.x.x.x'],
    ['1:2:3:4:5:6:7::', 'x.x.x.x'],
    ['::2:3:4:5:6:7:8', 'x.x.x.x'],
    ['2001:0db8:0000:0000:0000:ff00:0042:8329', 'x.x.x.x'],
    ['2001:db8:0:0:0:ff00:42:8329', 'x.x.x.x'],
    ['2001:db8:85a3::8a2e:370:7334', 'x.x.x.x'],
    ['::ffff:192.0.2.1', 'x.x.x.x'],
    ['::ffff:c0a8:0101', 'x.x.x.x'],
    ['::FFFF:192.0.2.1', 'x.x.x.x'],
    ['64:ff9b::192.0.2.33', 'x.x.x.x'],
    ['1:2:3:4:5:6:1.2.3.4', 'x.x.x.x'],
    ['::192.0.2.1', 'x.x.x.x'],
    ['fe80::1%en0', 'x.x.x.x'],
    ['fe80::1%25en0', 'x.x.x.x'],
    ['fe80::1%eth0.5', 'x.x.x.x'],
    ['fe80::1ff:fe23:4567:890a%utun3 up', 'x.x.x.x up'],
    ['[::1]', 'x.x.x.x'],
    ['[::1]:8080', 'x.x.x.x'],
    ['[2001:db8::1]:443', 'x.x.x.x'],
    ['[2001:db8::1]', 'x.x.x.x'],
    ['[fe80::1%en0]:99', 'x.x.x.x'],
    ['[::ffff:192.0.2.1]:443', 'x.x.x.x'],
    ['http://[2001:db8::1]:8080/p', 'http://x.x.x.x/p'],
    ['wss://[::1]:3000', 'wss://x.x.x.x'],
    ['peer 2001:db8::1 up', 'peer x.x.x.x up'],
    ['addr=2001:db8::1,', 'addr=x.x.x.x,'],
    ['(2001:db8::1)', '(x.x.x.x)'],
    ['"2001:db8::1"', '"x.x.x.x"'],
    ['ip:2001:db8::1', 'ip:x.x.x.x'],
    ['ip: 2001:db8::1.', 'ip: x.x.x.x.'],
    ['2001:db8::1:', 'x.x.x.x:'],
    ['2001:db8::1/64', 'x.x.x.x/64'],
    ['2001:db8::1, 2001:db8::2', 'x.x.x.x, x.x.x.x'],
    ['2001:db8::1 and fe80::2', 'x.x.x.x and x.x.x.x'],
    ['feed2001:db8::1', 'feedx.x.x.x'],
    ['2001:db8::1abcde', 'x.x.x.xde'],
    ['[2001:db8::1] and [2001:db8::2]:5', 'x.x.x.x and x.x.x.x'],
    ['2001:db8::1 1.2.3.4', 'x.x.x.x x.x.x.x'],
  ]);
});

test('safeField: what is not an IPv6 literal is left alone (times, MAC addresses, bare colons, too many or too few groups)', () => {
  const same = ['::', ':::', '1:::2', 'a:::b', '12:34:56', 'aa:bb:cc:dd:ee:ff', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7:8::', 'key:value', 'a:b', 'sha256:abcdef',
    'https://host/a:b', 'Error: x', 'ratio 3:2', '1::2::3', '2001:db8:::1', '::ffff:999.1.1.1', '::ffff:256.1.1.1', '::ffff:1.2.3'];
  for (const s of same) assert.equal(safeField(s), s, s);
});

test('safeField: when a word is glued to an address, or an address is cut short, the address part is masked and the rest stays (over-masking, never under-masking)', () => {
  table([
    ['std::vector', 'stx.x.x.xvector'],
    ['g::1', 'gx.x.x.x'],
    ['12345::1', '1x.x.x.x'],
    ['2001:db8::zz', 'x.x.x.xzz'],
    ['peer2001:db8::1', 'peerx.x.x.x'],
    ['dead2001:db8::1', 'deadx.x.x.x'],
  ]);
});

test('safeField: an SDP candidate line loses its addresses and its ports; mDNS names stand for addresses too', () => {
  table([
    ['candidate:842163049 1 udp 1677729535 203.0.113.5 46154 typ srflx raddr 10.0.0.2 rport 46154 generation 0',
      'candidate:842163049 1 udp 1677729535 x.x.x.x typ srflx raddr x.x.x.x generation 0'],
    ['a=candidate:1 1 udp 2122260223 192.168.1.2 50000 typ host generation 0 ufrag abcd network-id 1',
      'a=candidate:1 1 udp 2122260223 x.x.x.x typ host generation 0 ufrag abcd network-id 1'],
    ['candidate:2 1 udp 2113939711 2001:db8::5 40000 typ host', 'candidate:2 1 udp 2113939711 x.x.x.x typ host'],
    ['candidate:3 1 udp 41885439 198.51.100.7 61000 typ relay raddr 203.0.113.1 rport 52000', 'candidate:3 1 udp 41885439 x.x.x.x typ relay raddr x.x.x.x'],
    ['candidate:4 1 tcp 1518280447 192.168.1.2 9 typ host tcptype active', 'candidate:4 1 tcp 1518280447 x.x.x.x typ host tcptype active'],
    ['candidate:1 1 udp 2113937151 a1b2c3d4-e5f6-7890-abcd-ef1234567890.local 54321 typ host generation 0', 'candidate:1 1 udp 2113937151 x.x.x.x typ host generation 0'],
    ['c=IN IP4 203.0.113.5', 'c=IN IP4 x.x.x.x'],
    ['c=IN IP6 2001:db8::5', 'c=IN IP6 x.x.x.x'],
    ['a=rtcp:9 IN IP4 0.0.0.0', 'a=rtcp:9 IN IP4 x.x.x.x'],
    ['resolved a1b2c3d4-e5f6-7890-abcd-ef1234567890.local', 'resolved x.x.x.x'],
  ]);
});

test('safeField: the text after a # in a URL-looking string is cut (the # stays); a number sign in plain text stays', () => {
  table([
    ['https://x.example/p#secret=1', 'https://x.example/p#'],
    ['https://x.example/#/room/abcd-efgh-2345', 'https://x.example/#'],
    ['https://x.example/p#123456', 'https://x.example/p#'],
    ['https://x.example/p?a=b#frag', 'https://x.example/p?a=b#'],
    ['https://x.example/p#', 'https://x.example/p#'],
    ['wss://t.example/announce#k', 'wss://t.example/announce#'],
    ['/site/page#section', '/site/page#'],
    ['#key=abc', '#'],
    ['#/room/1', '#'],
    ['#ff0000', '#'],
    ['page#section', 'page#'],
    ['a#b#c', 'a#'],
    ['go to https://a.b/c#d now', 'go to https://a.b/c#'],
    ['ok #3 then https://a.b/c#frag', 'ok #3 then https://a.b/c#'],
    ['room #1234567 ready', 'room #'],
    ['Item #3 and C# are fine', 'Item #3 and C# are fine'],
    ['#3', '#3'],
    ['room #12 ready', 'room #12 ready'],
    ['# Title', '# Title'],
    ['C#', 'C#'],
    ['F# and C#', 'F# and C#'],
    ['#', '#'],
    ['no number sign here', 'no number sign here'],
    [String.fromCharCode(0xff03) + 'key=abc', '#'],
  ]);
});

test('safeField: a pair code xxxx-xxxx-xxxx keeps only its first 4 characters (the channel)', () => {
  table([
    ['abcd-efgh-2345', 'abcd'],
    ['ABCD-EFGH-2345', 'ABCD'],
    ['code: abcd-efgh-2345.', 'code: abcd.'],
    ['x abcd-efgh-2345, y', 'x abcd, y'],
    ['(abcd-efgh-2345)', '(abcd)'],
    ['"abcd-efgh-2345"', '"abcd"'],
    ['code=abcd-efgh-2345&x=1', 'code=abcd&x=1'],
    ['abcd-efgh-2345 and wxyz-mnpq-9876', 'abcd and wxyz'],
    ['abcd' + EN_DASH + 'efgh' + EN_DASH + '2345', 'abcd'],
    ['abcd' + EM_DASH + 'efgh' + EM_DASH + '2345', 'abcd'],
    ['abcd' + String.fromCharCode(0x2010) + 'efgh' + String.fromCharCode(0x2212) + '2345', 'abcd'],
    ['abcd-efgh-2345-wxyz', 'abcd-wxyz'],
    ['1234-5678-9012', '1234'],
    ['da9u-6qug', 'da9u-6qug'],
    ['abcd-efgh', 'abcd-efgh'],
    ['abc-efgh-2345', 'abc-efgh-2345'],
    ['abcde-efgh-2345', 'abcde-efgh-2345'],
    ['abcd-efgh-23456', 'abcd-efgh-23456'],
    ['abcdefgh2345', 'abcdefgh2345'],
    ['2026-11-02', '2026-11-02'],
  ]);
  // the last 8 characters of a code, the secret, are in no output
  assert.doesNotMatch(safeField('please give abcd-efgh-2345 to him'), /efgh|2345/);
  // accepted over-masking: any three hyphenated words of four letters read as a code
  assert.equal(safeField('read-only-mode'), 'read');
});

test('safeField: 40 or more hex digits (an infohash, a ledger id, a hash) keep their first 8', () => {
  const btih = '0123456789abcdef0123456789abcdef01234567';
  const sha = 'a3f1c2d4e5b6a7980123456789abcdef0123456789abcdef0123456789abcdef';
  table([
    [btih, '01234567'],
    [sha, 'a3f1c2d4'],
    ['btih=' + btih + ' ledger', 'btih=01234567 ledger'],
    ['pointer door btih=' + btih + ' ledger=' + sha, 'pointer door btih=01234567 ledger=a3f1c2d4'],
    ['/' + btih + '/', '/01234567/'],
    [btih.toUpperCase(), '01234567'],
    [btih.slice(0, 39), btih.slice(0, 39)],
    ['g' + btih, 'g' + btih],
    [btih + 'z', btih + 'z'],
    ['0'.repeat(45), '0'.repeat(45)],
    ['abcdef'.repeat(10), 'abcdef'.repeat(10)],
    ['d680ff36', 'd680ff36'],
    ['bbcb82098cda', 'bbcb82098cda'],
  ]);
  assert.equal(safeField('a'.repeat(300)).length, 200, 'the 200 character cut stays what the contract says');
});

test('safeField: control characters and every kind of space become one space; invisible characters go; the text is trimmed', () => {
  table([
    ['a\nb\tc  d\r\ne', 'a b c d e'],
    ['  padded  ', 'padded'],
    ['x' + ch(0x00a0) + 'y' + ch(0x2003) + 'z' + ch(0x3000) + 'w', 'x y z w'],
    ['a' + ch(0x200b) + 'b' + ch(0xfeff) + 'c' + ch(0xad) + 'd' + ch(0x202e) + 'e', 'abcde'],
    ['a' + ch(0x0000) + 'b' + ch(0x001b) + 'c' + ch(0x007f) + 'd' + ch(0x0085) + 'e', 'a b c d e'],
    ['line1' + ch(0x2028) + 'line2' + ch(0x2029) + 'line3', 'line1 line2 line3'],
    ['192.168.' + ch(0x200b) + '0.1', 'x.x.x.x'],
    ['192.168.0.' + ch(0x202e) + '1', 'x.x.x.x'],
    ['2001:db8:' + ch(0x200d) + ':1', 'x.x.x.x'],
  ]);
});

test('safeField: compatibility forms are folded first, so full width digits, dots, colons and brackets do not hide an address', () => {
  const full = (s) => Array.from(s).map((c) => (c >= '0' && c <= '9' ? String.fromCharCode(0xff10 + (c.charCodeAt(0) - 48)) : (c === '.' ? ch(0xff0e) : (c === ':' ? ch(0xff1a) : c)))).join('');
  table([
    [full('192.168.0.1'), 'x.x.x.x'],
    [full('10.0.0.1:8080'), 'x.x.x.x'],
    [full('2001:0db8::1'), 'x.x.x.x'],
    [ch(0xff3b) + full('::1') + ch(0xff3d) + full(':8080'), 'x.x.x.x'],
    ['abcd' + ch(0xff0d) + 'efgh' + ch(0xff0d) + full('2345'), 'abcd'],
    ['https://x.example/p' + ch(0xff03) + 'key', 'https://x.example/p#'],
  ]);
  assert.equal(safeField('e' + ch(0x0301)), ch(0xe9), 'composed: one character for the cut and the count');
});

test('safeField: masked first, cut after, so no half of an address is left at the cut; a pair of surrogates is not split', () => {
  const pad = (n) => 'x'.repeat(n);
  assert.equal(safeField(pad(190) + ' 192.168.100.200'), pad(190) + ' x.x.x.x');
  assert.equal(safeField(pad(197) + ' 10.0.0.1').length, 200);
  assert.doesNotMatch(safeField(pad(197) + ' 10.0.0.1'), /[0-9]/);
  assert.doesNotMatch(safeField(pad(185) + ' 2001:db8:85a3::8a2e:370:7334'), /[0-9a-f]:/);
  for (let n = 150; n <= 230; n++) {
    const out = safeField(pad(n % 200) + ' 192.168.100.200 and 2001:db8::1 and abcd-efgh-2345 ' + 'y'.repeat(300));
    assert.ok(out.length <= 200);
    assert.doesNotMatch(out, /192|168|2001|db8|efgh|2345/, 'n=' + n);
  }
  const emoji = String.fromCodePoint(0x1f600);
  assert.equal(safeField('a'.repeat(199) + emoji).length, 199, 'the high surrogate at the cut is dropped, not left alone');
  assert.equal(safeField('a'.repeat(198) + emoji).length, 200);
  assert.equal(safeField('a'.repeat(500)).length, 200);
  assert.equal(safeField('a'.repeat(100000)).length, 200);
});

test('safeField: applying it twice changes nothing', () => {
  const inputs = ['peer 192.168.1.5:3478 [2001:db8::1]:443 fe80::1%en0 ::ffff:1.2.3.4', 'https://x.example/p#frag abcd-efgh-2345', '0123456789abcdef0123456789abcdef01234567 and #3',
    'candidate:1 1 udp 2122260223 192.168.1.2 50000 typ host raddr 10.0.0.1 rport 5', '  \n\t spaced ' + ch(0x200b) + ' out ', 'e' + ch(0x0301) + ' plain', 'x'.repeat(500),
    'a'.repeat(199) + String.fromCodePoint(0x1f600), '#', '::', 'std::vector', 'abcd-efgh-2345-wxyz'];
  for (const s of inputs) {
    const once = safeField(s);
    assert.equal(safeField(once), once, JSON.stringify(s));
  }
});

// Random addresses in random sentences: whatever the shape, the address is not in the output (the same assertion the e2e scenarios make
// on the raw bodies). The generator is seeded, so a failure repeats.
const IPV4_ANY = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const IPV6_ANY = /[0-9a-f]*::|(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}/i;

function hex4(n, rnd) {
  const h = n.toString(16);
  const padded = rnd() < 0.3 ? h.padStart(4, '0') : h;
  return rnd() < 0.4 ? padded.toUpperCase() : padded;
}

function randomV6(rnd) {
  const mapped = rnd();
  if (mapped < 0.08) return '::ffff:' + randomV4(rnd);
  if (mapped < 0.12) return '64:ff9b::' + randomV4(rnd);
  if (mapped < 0.16) return '2001:db8:' + hex4(1 + Math.floor(rnd() * 65534), rnd) + ':1:2:3:' + randomV4(rnd);
  const g = [];
  for (let i = 0; i < 8; i++) g.push(rnd() < 0.4 ? 0 : 1 + Math.floor(rnd() * 65534));
  if (g.every((n) => n === 0)) g[7] = 1; // the unspecified address :: names nobody, and is left alone on purpose
  // the longest run of zero groups, first on a tie
  let best = null;
  for (let i = 0; i < 8; i++) {
    if (g[i] !== 0) continue;
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (!best || j - i > best[1] - best[0]) best = [i, j];
    i = j;
  }
  const form = rnd();
  if (form < 0.15 || !best) return g.map((n) => hex4(n, rnd)).join(':');
  if (form < 0.3 && g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) return '::ffff:' + [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.');
  const left = g.slice(0, best[0]).map((n) => hex4(n, rnd)).join(':');
  const right = g.slice(best[1]).map((n) => hex4(n, rnd)).join(':');
  return left + '::' + right;
}

function randomV4(rnd) {
  const o = () => {
    const n = Math.floor(rnd() * 256);
    return rnd() < 0.1 ? String(n).padStart(3, '0') : String(n);
  };
  return [o(), o(), o(), o()].join('.');
}

const WORDS = ['peer', 'connect', 'from', 'to', 'ip', 'addr', 'listening', 'tracker', 'stun', 'relay', 'answered', 'error'];

test('safeField: no address of a random shape survives, in any of a dozen sentence shapes', () => {
  const rnd = seeded(20261102);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const wrapV6 = [
    (a, p) => a,
    (a, p) => pick(WORDS) + ' ' + a + ' up',
    (a, p) => pick(WORDS) + '=' + a + ',',
    (a, p) => '(' + a + ')',
    (a, p) => '[' + a + ']:' + p,
    (a, p) => 'http://[' + a + ']:' + p + '/p?q=1',
    (a, p) => 'wss://[' + a + ']/announce',
    (a, p) => a + '%en0 and more',
    (a, p) => pick(WORDS) + ' ' + a + '.',
    (a, p) => 'candidate:1 1 udp 2113937151 ' + a + ' ' + p + ' typ host generation 0',
    (a, p) => '"' + a + '"',
    (a, p) => pick(WORDS) + ': ' + a + ' ' + pick(WORDS) + ' ' + a,
  ];
  const wrapV4 = [
    (a, p) => a,
    (a, p) => pick(WORDS) + ' ' + a + ' up',
    (a, p) => pick(WORDS) + '=' + a + ',',
    (a, p) => '(' + a + ')',
    (a, p) => a + ':' + p,
    (a, p) => 'http://' + a + ':' + p + '/p?q=1',
    (a, p) => 'wss://' + a + '/announce',
    (a, p) => pick(WORDS) + ' ' + a + '.',
    (a, p) => 'candidate:1 1 udp 2113937151 ' + a + ' ' + p + ' typ host generation 0',
    (a, p) => '"' + a + '"',
    (a, p) => 'c=IN IP4 ' + a,
    (a, p) => pick(WORDS) + ': ' + a + ' ' + pick(WORDS) + ' ' + a,
  ];
  let cases = 0;
  for (let i = 0; i < 1500; i++) {
    const port = String(1024 + Math.floor(rnd() * 64000));
    const v6 = randomV6(rnd);
    const v4 = randomV4(rnd);
    for (const [addr, wrap, any] of [[v6, pick(wrapV6), IPV6_ANY], [v4, pick(wrapV4), IPV4_ANY]]) {
      const input = wrap(addr, port);
      const out = safeField(input);
      assert.equal(out.toLowerCase().includes(addr.toLowerCase()), false, JSON.stringify(input) + ' -> ' + JSON.stringify(out));
      assert.doesNotMatch(out, any, JSON.stringify(input) + ' -> ' + JSON.stringify(out));
      assert.ok(out.includes('x.x.x.x'), JSON.stringify(input));
      assert.equal(out.includes(':' + port), false, JSON.stringify(input) + ' -> ' + JSON.stringify(out));
      assert.equal(out.includes(' ' + port + ' typ'), false, JSON.stringify(input));
      cases++;
    }
  }
  assert.equal(cases, 3000);
});

test('safeField: strings built to be slow for a pattern are still fast (the cut at 2000 characters bounds every rule)', () => {
  const nasty = ['a'.repeat(100000), ':'.repeat(100000), 'a:'.repeat(50000), '1.'.repeat(50000), '1.2.3.'.repeat(20000), '#'.repeat(100000), '-'.repeat(100000), 'abcd-'.repeat(20000),
    '0'.repeat(100000) + 'g', '[' + '::'.repeat(50000), 'a::'.repeat(30000), '1.1.1.1.'.repeat(20000), 'x'.repeat(1999) + '1.2.3.4', ' '.repeat(100000), 'ab:cd'.repeat(30000) + ':::'];
  const t0 = performance.now();
  for (const s of nasty) assert.ok(safeField(s).length <= 200);
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, 'fifteen pathological strings took ' + ms.toFixed(1) + ' ms');
});

// ---------------------------------------------------------------------------------------------
// The whole path: what goes in as hostile content is not in any body that leaves
// ---------------------------------------------------------------------------------------------

test('hostile content in every channel never reaches a body: addresses, fragments, codes, hashes, names, typed text', () => {
  const doc = new FakeDocument();
  const root = doc.createElement('div', { id: 'mw-root' });
  const list = doc.createElement('ul', { 'data-role': 'conv-list' });
  const convBtn = doc.createElement('button', { 'data-fk': 'conv:k3m8q2w9z4x7', 'data-conv': 'k3m8q2w9z4x7' });
  const nameSpan = doc.createElement('span', { dir: 'auto' });
  nameSpan.textContent = 'Bea: meet at 192.168.1.5 tonight';
  convBtn.appendChild(nameSpan);
  list.appendChild(convBtn);
  root.appendChild(list);
  const input = doc.createElement('input', { id: 'nick', type: 'text' });
  Object.defineProperty(input, 'value', { get() { throw new Error('an input value was read'); } });
  root.appendChild(input);
  const ipButton = doc.createElement('button', { 'data-role': '10.0.0.7' });
  ipButton.textContent = 'Connect to 192.168.1.100 now';
  root.appendChild(ipButton);
  const { r, posts } = rig({ site: '0123456789abcdef0123456789abcdef01234567' });
  r.allow(true);
  r.setWho('Alice Example <alice@example.org>');
  r.setNet({ type: 'wifi 10.1.2.3', effectiveType: '4g' });
  const btih = '0123456789abcdef0123456789abcdef01234567';
  r.event('log', { m: 'pointer door btih=' + btih + ' ledger=' + btih.replace(/0/g, '9') });
  r.event('log', { m: 'tracker wss://203.0.113.7:8000/announce#token=SECRETFRAGMENT failed for [2001:db8::7]:443' });
  r.event('log', { m: 'code wxyz-mnpq-9876 typed' });
  r.event('x.fields', { host: '198.51.100.9:3478', note: 'fe80::1%en0', a: '::ffff:192.0.2.1' });
  r.click(convBtn, { trusted: true, type: 'click' });
  r.click(nameSpan);
  r.click(input);
  r.click(ipButton);
  r.flush();
  const raw = posts.map((p) => p.text).join('\n');
  assert.doesNotMatch(raw, IPV4_ANY);
  assert.doesNotMatch(raw, IPV6_ANY);
  assert.doesNotMatch(raw, /#[^"]/, 'no fragment text');
  for (const secret of ['SECRETFRAGMENT', 'mnpq', '9876', 'Bea:', 'meet at', 'tonight', '192.168', '203.0.113', '2001:db8', '56789abc', 'Alice', 'example.org', '10.1.2.3', '198.51.100', 'fe80', 'ffff:']) {
    assert.equal(raw.includes(secret), false, secret);
  }
  assert.equal(posts[0].body.site, '01234567');
  assert.equal(posts[0].body.who, null);
  assert.deepEqual(posts[0].body.net, { type: 'other', effectiveType: '4g' });
  const clicks = posts[0].body.events.filter((e) => e.n === 'ui.click');
  assert.deepEqual(clicks.map((e) => Object.keys(e).filter((k) => k !== 't' && k !== 'n')), [['role', 'trusted', 'type'], ['role'], ['id'], ['role', 'text']]);
  assert.equal(clicks[3].role, 'x.x.x.x');
  assert.equal(clicks[3].text, 'Connect to x.x.x.x now');
});

// ---------------------------------------------------------------------------------------------
// describeTarget
// ---------------------------------------------------------------------------------------------

function el(doc, tag, attrs = {}, text = null) {
  const n = doc.createElement(tag, attrs);
  if (text !== null) n.textContent = text;
  return n;
}

test('describeTarget returns the first match in the order role, fk, app, view, banner, dialog, row, card, id, tag', () => {
  const doc = new FakeDocument();
  const everything = el(doc, 'div', { 'data-role': 'r', 'data-fk': 'f:1', 'data-app': 'a', 'data-view': 'v', 'data-id': 'b', 'aria-labelledby': 'title', 'data-row': 'row1', 'data-mw-card': 'consent', id: 'i' });
  everything.className = 'mw-banner mw-dialog';
  const steps = [
    ['role', 'r', 'data-role'], ['fk', 'f', 'data-fk'], ['app', 'a', 'data-app'], ['view', 'v', 'data-view'], ['banner', 'b', 'data-id'], ['dialog', 'title', 'aria-labelledby'],
    ['row', 'row1', 'data-row'], ['card', 'consent', 'data-mw-card'], ['id', 'i', 'id'],
  ];
  for (const [key, value, attribute] of steps) {
    assert.deepEqual(describeTarget(everything), { [key]: value }, key);
    everything.removeAttribute(attribute);
    if (key === 'banner') everything.className = 'mw-dialog';
  }
  assert.deepEqual(describeTarget(everything), { tag: 'div' });
  assert.deepEqual(describeTarget(el(doc, 'section')), { tag: 'section' });
  assert.deepEqual(describeTarget(el(doc, 'my-element')), { tag: 'my-element' });
});

test('describeTarget finds each match on the target or an ancestor, the closest one for each rule, and the rule order wins over distance', () => {
  const doc = new FakeDocument();
  const outer = el(doc, 'div', { 'data-role': 'outer-role', id: 'outer' });
  const middle = el(doc, 'section', { 'data-fk': 'mid:x', id: 'middle' });
  const inner = el(doc, 'span', { id: 'inner' });
  outer.appendChild(middle);
  middle.appendChild(inner);
  assert.deepEqual(describeTarget(inner), { role: 'outer-role' }, 'a role on an ancestor beats an fk nearer to the target');
  assert.deepEqual(describeTarget(middle), { role: 'outer-role' });
  outer.removeAttribute('data-role');
  assert.deepEqual(describeTarget(inner), { fk: 'mid' });
  middle.removeAttribute('data-fk');
  assert.deepEqual(describeTarget(inner), { id: 'inner' }, 'the closest id');
  inner.removeAttribute('id');
  assert.deepEqual(describeTarget(inner), { id: 'middle' });
  middle.removeAttribute('id');
  const twoRoles = el(doc, 'div', { 'data-role': 'far' });
  const nearRole = el(doc, 'div', { 'data-role': 'near' });
  const leaf = el(doc, 'b');
  twoRoles.appendChild(nearRole);
  nearRole.appendChild(leaf);
  assert.deepEqual(describeTarget(leaf), { role: 'near' }, 'the closest element for one rule');
});

test('describeTarget: fk is the prefix before the first colon only; empty values are no match', () => {
  const doc = new FakeDocument();
  for (const [given, kept] of [['conv:abc123', 'conv'], ['act:reply:msg9', 'act'], ['plain', 'plain'], ['a:', 'a'], ['tile:chat', 'tile']]) {
    assert.deepEqual(describeTarget(el(doc, 'button', { 'data-fk': given })), { fk: kept }, given);
  }
  for (const given of [':x', '', '   ']) assert.deepEqual(describeTarget(el(doc, 'p', { 'data-fk': given })), { tag: 'p' }, JSON.stringify(given));
  assert.deepEqual(describeTarget(el(doc, 'p', { 'data-role': '' })), { tag: 'p' });
  // an empty attribute on the target does not stop an ancestor from matching
  const parent = el(doc, 'div', { 'data-role': 'panel' });
  const child = el(doc, 'p', { 'data-role': '' });
  parent.appendChild(child);
  assert.deepEqual(describeTarget(child), { role: 'panel' });
});

test('describeTarget: .mw-banner[data-id], .mw-dialog with aria-labelledby, [data-mw-card], [data-row], [data-app], [data-view]', () => {
  const doc = new FakeDocument();
  const banner = el(doc, 'div', { 'data-id': 'offline-note' });
  banner.className = 'mw-banner mw-warn';
  const inBanner = el(doc, 'span');
  banner.appendChild(inBanner);
  assert.deepEqual(describeTarget(inBanner), { banner: 'offline-note' });
  const notBanner = el(doc, 'div', { 'data-id': 'x' });
  assert.deepEqual(describeTarget(notBanner), { tag: 'div' }, 'data-id alone is not a banner');
  const viaAttribute = el(doc, 'div', { class: 'foo mw-banner', 'data-id': 'attr-class' });
  assert.deepEqual(describeTarget(viaAttribute), { banner: 'attr-class' }, 'the class attribute counts when className is empty');
  const lookalike = el(doc, 'div', { 'data-id': 'x' });
  lookalike.className = 'mw-banners';
  assert.deepEqual(describeTarget(lookalike), { tag: 'div' });
  const dialog = el(doc, 'div', { role: 'dialog', 'aria-labelledby': 'mw-settings-title' });
  dialog.className = 'mw-dialog mw-settings';
  const inDialog = el(doc, 'div');
  dialog.appendChild(inDialog);
  assert.deepEqual(describeTarget(inDialog), { dialog: 'mw-settings-title' });
  const noLabel = el(doc, 'div');
  noLabel.className = 'mw-dialog';
  assert.deepEqual(describeTarget(noLabel), { tag: 'div' });
  const labelOnly = el(doc, 'div', { 'aria-labelledby': 'x' });
  assert.deepEqual(describeTarget(labelOnly), { tag: 'div' });
  assert.deepEqual(describeTarget(el(doc, 'li', { 'data-row': 'dns-blocked' })), { row: 'dns-blocked' });
  assert.deepEqual(describeTarget(el(doc, 'div', { 'data-mw-card': 'consent' })), { card: 'consent' });
  assert.deepEqual(describeTarget(el(doc, 'button', { 'data-app': 'messages' })), { app: 'messages' });
  assert.deepEqual(describeTarget(el(doc, 'section', { 'data-view': 'home' })), { view: 'home' });
});

test('describeTarget: the text is the control text, first 24 characters, one line, only for buttons and links', () => {
  const doc = new FakeDocument();
  const btn = el(doc, 'button', { 'data-role': 'go' }, 'Share and load');
  assert.deepEqual(describeTarget(btn), { role: 'go', text: 'Share and load' });
  assert.deepEqual(describeTarget(el(doc, 'button', {}, 'A much longer label than twenty four characters')), { tag: 'button', text: 'A much longer label than' });
  assert.deepEqual(describeTarget(el(doc, 'button', {}, '  Line one\n   line two  ')), { tag: 'button', text: 'Line one line two' });
  assert.deepEqual(describeTarget(el(doc, 'a', { href: 'https://x.example/#k' }, 'Open the site')), { tag: 'a', text: 'Open the site' });
  assert.deepEqual(describeTarget(el(doc, 'a', {}, 'No href is still a link')), { tag: 'a', text: 'No href is still a link' });
  assert.deepEqual(describeTarget(el(doc, 'div', { role: 'button' }, 'Aria button')), { tag: 'div', text: 'Aria button' });
  assert.deepEqual(describeTarget(el(doc, 'div', { role: 'link' }, 'Aria link')), { tag: 'div', text: 'Aria link' });
  // a click on something inside the control reports the control's text
  const holder = el(doc, 'button', { 'data-fk': 'save:1' });
  const icon = el(doc, 'span', {}, 'icon');
  const label = el(doc, 'b', {}, 'Save');
  holder.appendChild(icon);
  holder.appendChild(label);
  assert.deepEqual(describeTarget(label), { fk: 'save', text: 'iconSave' });
  // not a control: no text
  assert.deepEqual(describeTarget(el(doc, 'p', { 'data-role': 'note' }, 'Some paragraph text')), { role: 'note' });
  assert.deepEqual(describeTarget(el(doc, 'div', {}, 'plain')), { tag: 'div' });
  assert.deepEqual(describeTarget(el(doc, 'button', {}, '   ')), { tag: 'button' }, 'no text, no key');
  assert.deepEqual(describeTarget(el(doc, 'button', {})), { tag: 'button' });
});

test('describeTarget: the control text is masked before it is cut, so no half of an address is left at the cut', () => {
  const doc = new FakeDocument();
  assert.deepEqual(describeTarget(el(doc, 'button', {}, 'Connect to 192.168.1.100 now')), { tag: 'button', text: 'Connect to x.x.x.x now' });
  assert.deepEqual(describeTarget(el(doc, 'button', {}, 'Connect to 192.168.1.1')), { tag: 'button', text: 'Connect to x.x.x.x' });
  assert.deepEqual(describeTarget(el(doc, 'button', {}, 'Connect to 192.168.1.100:8080')), { tag: 'button', text: 'Connect to x.x.x.x' });
  assert.deepEqual(describeTarget(el(doc, 'a', {}, 'https://x.example/#secret=1')), { tag: 'a', text: 'https://x.example/#' });
  assert.deepEqual(describeTarget(el(doc, 'button', {}, 'Use abcd-efgh-2345')), { tag: 'button', text: 'Use abcd' });
  assert.deepEqual(describeTarget(el(doc, 'button', {}, 'Reply #2')), { tag: 'button', text: 'Reply #2' });
});

test('describeTarget never reads an input: no text for an input, a textarea, a select or an option, and never a value', () => {
  const doc = new FakeDocument();
  const trap = (node) => {
    Object.defineProperty(node, 'value', { get() { throw new Error('value was read'); } });
    Object.defineProperty(node, 'innerText', { get() { throw new Error('innerText was read'); } });
    return node;
  };
  const input = trap(el(doc, 'input', { id: 'nick', type: 'text' }));
  input.textContent = 'typed text sits in textContent in this fake';
  assert.deepEqual(describeTarget(input), { id: 'nick' });
  assert.deepEqual(describeTarget(trap(el(doc, 'input', { type: 'button', value: 'Click me' }))), { tag: 'input' });
  assert.deepEqual(describeTarget(trap(el(doc, 'input', { type: 'submit', 'data-fk': 'form:go' }))), { fk: 'form' });
  const area = trap(el(doc, 'textarea', { 'data-role': 'composer' }, 'a draft message'));
  assert.deepEqual(describeTarget(area), { role: 'composer' });
  assert.deepEqual(describeTarget(trap(el(doc, 'select', { 'data-fk': 'lang:select' }, 'English Francais'))), { fk: 'lang' });
  assert.deepEqual(describeTarget(trap(el(doc, 'option', {}, 'English'))), { tag: 'option' });
  // an input inside a button (invalid HTML, but a page may do it) still reports no text
  const odd = el(doc, 'button', {}, 'wrapper text');
  const inside = trap(el(doc, 'input', { id: 'inner-input' }));
  odd.appendChild(inside);
  assert.deepEqual(describeTarget(inside), { id: 'inner-input' });
});

test('describeTarget reports no text for a control that shows what a person wrote: dir="auto" inside, around or on it, or data-obs="off"', () => {
  const doc = new FakeDocument();
  // a conversation row: the name and the preview are person text (the apps mark them dir="auto")
  const row = el(doc, 'button', { 'data-fk': 'conv:k3m8q2w9z4x7', 'data-conv': 'k3m8q2w9z4x7' });
  const main = el(doc, 'span', { class: 'mw-apps-row-main' });
  const who = el(doc, 'span', { dir: 'auto' }, 'Bea');
  const prev = el(doc, 'span', { dir: 'auto' }, 'see you at 8');
  main.appendChild(who);
  main.appendChild(prev);
  row.appendChild(main);
  assert.deepEqual(describeTarget(row), { fk: 'conv' });
  assert.deepEqual(describeTarget(who), { fk: 'conv' }, 'a click on the name inside the row: the row text is still withheld');
  // a link inside a message body
  const body = el(doc, 'div', { dir: 'auto', 'data-role': 'body' });
  const link = el(doc, 'a', { href: 'https://x.example/' }, 'my private page');
  body.appendChild(link);
  assert.deepEqual(describeTarget(link), { role: 'body' });
  // the control itself
  assert.deepEqual(describeTarget(el(doc, 'button', { dir: 'auto', 'data-fk': 'x:1' }, 'Nick')), { fk: 'x' });
  assert.deepEqual(describeTarget(el(doc, 'button', { dir: 'AUTO', 'data-fk': 'x:1' }, 'Nick')), { fk: 'x' });
  // dir="ltr" and "rtl" are layout, not a mark
  assert.deepEqual(describeTarget(el(doc, 'button', { dir: 'rtl', 'data-fk': 'x:1' }, 'Close')), { fk: 'x', text: 'Close' });
  // the explicit opt-out, on the control or on any ancestor
  assert.deepEqual(describeTarget(el(doc, 'button', { 'data-obs': 'off', 'data-fk': 'x:1' }, 'Secret label')), { fk: 'x' });
  const group = el(doc, 'div', { 'data-obs': 'off' });
  const inGroup = el(doc, 'button', {}, 'Inside the group');
  group.appendChild(inGroup);
  assert.deepEqual(describeTarget(inGroup), { tag: 'button' });
  assert.deepEqual(describeTarget(el(doc, 'button', { 'data-obs': 'on', 'data-fk': 'x:1' }, 'Fine')), { fk: 'x', text: 'Fine' });
});

test('describeTarget: every value is masked like any field, and the result never carries more than the plan names', () => {
  const doc = new FakeDocument();
  assert.deepEqual(describeTarget(el(doc, 'div', { 'data-role': '10.0.0.7' })), { role: 'x.x.x.x' });
  assert.deepEqual(describeTarget(el(doc, 'div', { 'data-view': 'https://x.example/#key' })), { view: 'https://x.example/#' });
  assert.deepEqual(describeTarget(el(doc, 'div', { 'data-row': 'abcd-efgh-2345' })), { row: 'abcd' });
  assert.equal(describeTarget(el(doc, 'div', { id: 'z'.repeat(500) })).id.length, 200);
  const out = describeTarget(el(doc, 'button', { 'data-role': 'a', 'data-fk': 'b:c', 'data-app': 'd', id: 'e', class: 'f', title: 'g', 'aria-label': 'h' }, 'Label'));
  assert.deepEqual(Object.keys(out), ['role', 'text']);
});

test('describeTarget is total: it takes what a real DOM hands over (SVG className objects, shadow roots, text nodes, documents, windows, nothing) and never throws', () => {
  const doc = new FakeDocument();
  // an SVG element: className is an object with baseVal
  const svg = { tagName: 'svg', className: { baseVal: 'mw-banner' }, parentNode: null, getAttribute: (n) => ({ 'data-id': 'svg-banner' }[n] || null) };
  assert.deepEqual(describeTarget(svg), { banner: 'svg-banner' });
  // a closed shadow root: the walk stops at the root, whose own node has no getAttribute (as in a browser), and does not reach the host
  const host = el(doc, 'div', { 'data-role': 'host-role', id: 'host' });
  const shadow = host.attachShadow({ mode: 'closed' });
  const card = el(doc, 'div', { 'data-mw-card': 'consent' });
  const btn = el(doc, 'button', {}, 'Accept');
  shadow.appendChild(card);
  card.appendChild(btn);
  assert.deepEqual(describeTarget(btn), { card: 'consent', text: 'Accept' });
  const plain = el(doc, 'button', {}, 'No marks');
  shadow.appendChild(plain);
  assert.deepEqual(describeTarget(plain), { tag: 'button', text: 'No marks' }, 'the host outside the shadow tree is not consulted: closest does not cross it either');
  const realShadowRoot = { nodeName: '#document-fragment', parentNode: null, host };
  const inReal = { tagName: 'DIV', parentNode: realShadowRoot, getAttribute: () => null };
  assert.deepEqual(describeTarget(inReal), { tag: 'div' });
  // a text node, the document, the window, nothing at all
  const textNode = { nodeName: '#text', parentNode: btn, parentElement: btn };
  assert.deepEqual(describeTarget(textNode), { card: 'consent', text: 'Accept' });
  assert.deepEqual(describeTarget(doc), { tag: '#document' });
  assert.deepEqual(describeTarget({}), { tag: 'unknown' });
  assert.deepEqual(describeTarget(null), { tag: 'unknown' });
  assert.deepEqual(describeTarget(undefined), { tag: 'unknown' });
  assert.deepEqual(describeTarget('a string'), { tag: 'unknown' });
  assert.deepEqual(describeTarget(5), { tag: 'unknown' });
  // a node whose attribute access throws, and a parent chain that loops
  const hostile = { tagName: 'DIV', getAttribute() { throw new Error('no'); }, parentNode: null };
  assert.deepEqual(describeTarget(hostile), { tag: 'unknown' });
  const a = el(doc, 'div');
  const b = el(doc, 'div');
  a.parentNode = b;
  b.parentNode = a;
  assert.deepEqual(describeTarget(a), { tag: 'div' });
});

// ---------------------------------------------------------------------------------------------
// wrapPeerConnection
// ---------------------------------------------------------------------------------------------

class FakePC extends EventTarget {
  constructor(config) {
    super();
    this.config = config;
    this.iceGatheringState = 'new';
    this.iceConnectionState = 'new';
    this.connectionState = 'new';
    this.remote = [];
    this.statsCalls = 0;
    this.stats = new Map();
    FakePC.made.push(this);
  }

  static generateCertificate(algorithm) { return Promise.resolve({ algorithm, fake: true }); }

  setRemoteDescription(desc) { this.remote.push({ desc, self: this }); return Promise.resolve('srd:' + (desc && desc.type)); }
  getStats() { this.statsCalls++; return Promise.resolve(this.stats); }
  close() { this.closed = true; }

  fire(type, props) { this.dispatchEvent(Object.assign(new Event(type), props || {})); }
  state(prop, value, type) { this[prop] = value; this.fire(type); }
}
FakePC.made = [];

const SDP = [
  'v=0', 'o=- 4611731400430051336 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0',
  'a=candidate:1 1 udp 2122260223 192.168.1.2 50000 typ host generation 0',
  'a=candidate:2 1 udp 2122260222 10.0.0.2 50001 typ host generation 0',
  'a=candidate:3 1 udp 1686052607 203.0.113.9 50002 typ srflx raddr 192.168.1.2 rport 50000 generation 0',
  'a=candidate:4 1 udp 41885439 198.51.100.4 50003 typ relay raddr 203.0.113.9 rport 50002 generation 0',
  'a=candidate:5 1 tcp 1518280447 192.168.1.2 9 typ host tcptype active generation 0',
  'a=ice-ufrag:abcd', 'a=ice-pwd:supersecretpassword',
  'a=fingerprint:sha-256 AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99', 'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000', '',
].join('\r\n');

function chromeStats(local, remote, extra = {}) {
  return new Map([
    ['T1', { id: 'T1', type: 'transport', selectedCandidatePairId: 'P1' }],
    ['P0', { id: 'P0', type: 'candidate-pair', state: 'failed', localCandidateId: 'L0', remoteCandidateId: 'R0' }],
    ['P1', Object.assign({ id: 'P1', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'L1', remoteCandidateId: 'R1' }, extra)],
    ['L0', { id: 'L0', type: 'local-candidate', candidateType: 'relay', protocol: 'udp', address: '198.51.100.99', port: 1 }],
    ['R0', { id: 'R0', type: 'remote-candidate', candidateType: 'relay', protocol: 'udp', address: '198.51.100.98', port: 2 }],
    ['L1', { id: 'L1', type: 'local-candidate', candidateType: local[0], protocol: local[1], address: '203.0.113.9', ip: '203.0.113.9', port: 50000, foundation: 'abc', usernameFragment: 'abcd' }],
    ['R1', { id: 'R1', type: 'remote-candidate', candidateType: remote[0], protocol: remote[1], address: '198.51.100.7', ip: '198.51.100.7', port: 3478 }],
  ]);
}

function reporterStub() {
  const events = [];
  return { events, event: (n, f) => { events.push(Object.assign({ n }, f)); return true; } };
}

function installed(order) {
  FakePC.made.length = 0;
  const win = { RTCPeerConnection: FakePC };
  const rep = reporterStub();
  const clock = createClock();
  if (order === 'obs only') assert.equal(wrapPeerConnection(win, rep), true);
  return { win, rep, clock };
}

const candidate = (type, protocol, line) => ({ candidate: { type, protocol, candidate: line === undefined ? 'candidate:1 1 ' + protocol + ' 2122260223 192.168.1.2 50000 typ ' + type + ' generation 0' : line, address: '192.168.1.2', port: 50000 } });

test('wrapPeerConnection: ice.pc, ice.gathering, ice.state, ice.conn, ice.local, ice.remote and ice.pair, by type and protocol only', async () => {
  const { win, rep } = installed('obs only');
  const pc = new win.RTCPeerConnection({ iceServers: [] });
  const pc2 = new win.RTCPeerConnection({});
  assert.deepEqual(rep.events, [{ n: 'ice.pc', id: 1, ev: 'created' }, { n: 'ice.pc', id: 2, ev: 'created' }]);
  rep.events.length = 0;
  pc.state('iceGatheringState', 'gathering', 'icegatheringstatechange');
  pc.fire('icecandidate', candidate('host', 'udp'));
  pc.fire('icecandidate', candidate('srflx', 'udp'));
  pc.fire('icecandidate', candidate('relay', 'tcp'));
  pc.fire('icecandidate', candidate('prflx', 'udp'));
  pc.fire('icecandidate', { candidate: { candidate: 'candidate:2 1 tcp 1518280447 203.0.113.9 9 typ srflx raddr 192.168.1.2 rport 9' } });
  pc.fire('icecandidate', { candidate: { candidate: 'a=candidate:3 1 UDP 1 192.168.1.2 5 typ host' } });
  pc.fire('icecandidate', { candidate: { type: 'weird', protocol: 'sctp', candidate: 'candidate:4 1 sctp 1 192.168.1.2 5 typ weird' } });
  pc.fire('icecandidate', { candidate: null });
  pc.fire('icecandidate', { candidate: { candidate: '' } });
  pc.fire('icecandidate', {});
  pc.state('iceGatheringState', 'complete', 'icegatheringstatechange');
  pc.state('iceConnectionState', 'checking', 'iceconnectionstatechange');
  pc.state('iceConnectionState', 'connected', 'iceconnectionstatechange');
  pc.state('connectionState', 'connecting', 'connectionstatechange');
  pc.stats = chromeStats(['host', 'udp'], ['srflx', 'udp']);
  pc.state('connectionState', 'connected', 'connectionstatechange');
  await flushMicrotasks();
  pc2.state('iceConnectionState', 'failed', 'iceconnectionstatechange');
  pc.close();
  pc.close();
  assert.deepEqual(rep.events, [
    { n: 'ice.gathering', id: 1, state: 'gathering' },
    { n: 'ice.local', id: 1, type: 'host', proto: 'udp' },
    { n: 'ice.local', id: 1, type: 'srflx', proto: 'udp' },
    { n: 'ice.local', id: 1, type: 'relay', proto: 'tcp' },
    { n: 'ice.local', id: 1, type: 'prflx', proto: 'udp' },
    { n: 'ice.local', id: 1, type: 'srflx', proto: 'tcp' },
    { n: 'ice.local', id: 1, type: 'host', proto: 'udp' },
    { n: 'ice.local', id: 1, type: 'other', proto: 'other' },
    { n: 'ice.gathering', id: 1, state: 'complete' },
    { n: 'ice.state', id: 1, state: 'checking' },
    { n: 'ice.state', id: 1, state: 'connected' },
    { n: 'ice.conn', id: 1, state: 'connecting' },
    { n: 'ice.conn', id: 1, state: 'connected' },
    { n: 'ice.pair', id: 1, local: 'host/udp', remote: 'srflx/udp' },
    { n: 'ice.state', id: 2, state: 'failed' },
    { n: 'ice.pc', id: 1, ev: 'closed' },
  ]);
  assert.doesNotMatch(JSON.stringify(rep.events), IPV4_ANY);
  assert.doesNotMatch(JSON.stringify(rep.events), /abcd|203\.|198\.|50000|3478/);
});

test('wrapPeerConnection: ice.remote counts the typ words of the candidate lines and reads no address, port, username fragment or password', async () => {
  const { win, rep } = installed('obs only');
  const pc = new win.RTCPeerConnection();
  rep.events.length = 0;
  const offer = { type: 'offer', sdp: SDP };
  assert.equal(await pc.setRemoteDescription(offer), 'srd:offer', 'the native result is returned unchanged');
  assert.equal(pc.remote[0].desc, offer, 'the same argument object reaches the native method');
  assert.equal(pc.remote[0].self, pc, 'and the same this');
  assert.equal(await pc.setRemoteDescription({ type: 'answer', sdp: SDP.replace(/a=candidate:[^\r]*\r\n/g, '') }), 'srd:answer');
  assert.equal(await pc.setRemoteDescription({ type: 'pranswer', sdp: 'a=candidate:1 1 udp 1 1.2.3.4 5 typ srflx\r\n' }), 'srd:pranswer');
  assert.equal(await pc.setRemoteDescription({ type: 'rollback' }), 'srd:rollback');
  assert.equal(await pc.setRemoteDescription(), 'srd:undefined');
  assert.equal(await pc.setRemoteDescription(null), 'srd:null');
  assert.equal(await pc.setRemoteDescription({ type: 'offer' }), 'srd:offer');
  assert.equal(await pc.setRemoteDescription({ type: 'offer', sdp: 'a=candidate:9 1 udp 1 1.2.3.4 5 typ bogus\r\na=candidate:9 1 udp 1 1.2.3.4 5 typ HOST' }), 'srd:offer');
  assert.deepEqual(rep.events, [
    { n: 'ice.remote', id: 1, sdp: 'offer', types: 'host,host,srflx,relay,host' },
    { n: 'ice.remote', id: 1, sdp: 'answer', types: '' },
    { n: 'ice.remote', id: 1, sdp: 'answer', types: 'srflx' },
    { n: 'ice.remote', id: 1, sdp: 'offer', types: '' },
    { n: 'ice.remote', id: 1, sdp: 'offer', types: 'other' },
  ]);
  const many = 'a=candidate:1 1 udp 1 1.2.3.4 5 typ host\r\n'.repeat(100);
  rep.events.length = 0;
  await pc.setRemoteDescription({ type: 'offer', sdp: many });
  assert.equal(rep.events[0].types.split(',').length, 32, 'at most 32 words');
  // a description that is not an object, or whose sdp is odd, is passed through and reports what it can
  assert.equal(await pc.setRemoteDescription('v=0'), 'srd:undefined');
  assert.equal(await pc.setRemoteDescription({ type: 'offer', sdp: 12345 }), 'srd:offer');
});

test('wrapPeerConnection: ice.pair is read from getStats when the connection becomes connected: the selected pair, in the shapes of Chromium, Firefox and Safari', async () => {
  const cases = [
    ['chromium: transport.selectedCandidatePairId', chromeStats(['host', 'udp'], ['host', 'udp']), 'host/udp', 'host/udp'],
    ['relay over tcp', chromeStats(['relay', 'tcp'], ['srflx', 'udp']), 'relay/tcp', 'srflx/udp'],
    ['an unknown protocol and type', chromeStats(['prflx', 'sctp'], ['other', 'UDP']), 'prflx/other', 'other/udp'],
    ['firefox: candidate-pair with selected: true', new Map([
      ['p', { id: 'p', type: 'candidate-pair', state: 'succeeded', selected: true, localCandidateId: 'l', remoteCandidateId: 'r' }],
      ['x', { id: 'x', type: 'candidate-pair', state: 'succeeded', selected: false, localCandidateId: 'l2', remoteCandidateId: 'r2' }],
      ['l', { id: 'l', type: 'local-candidate', candidateType: 'srflx', protocol: 'udp' }], ['r', { id: 'r', type: 'remote-candidate', candidateType: 'host', protocol: 'udp' }],
      ['l2', { id: 'l2', type: 'local-candidate', candidateType: 'relay', protocol: 'tcp' }], ['r2', { id: 'r2', type: 'remote-candidate', candidateType: 'relay', protocol: 'tcp' }]]), 'srflx/udp', 'host/udp'],
    ['no transport, no selected flag: the nominated pair that succeeded', new Map([
      ['a', { id: 'a', type: 'candidate-pair', state: 'succeeded', nominated: false, localCandidateId: 'l', remoteCandidateId: 'r' }],
      ['b', { id: 'b', type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'l2', remoteCandidateId: 'r2' }],
      ['l', { id: 'l', type: 'local-candidate', candidateType: 'host', protocol: 'udp' }], ['r', { id: 'r', type: 'remote-candidate', candidateType: 'host', protocol: 'udp' }],
      ['l2', { id: 'l2', type: 'local-candidate', candidateType: 'srflx', protocol: 'udp' }], ['r2', { id: 'r2', type: 'remote-candidate', candidateType: 'srflx', protocol: 'udp' }]]), 'srflx/udp', 'srflx/udp'],
    ['no flag at all: any pair that succeeded', new Map([
      ['b', { id: 'b', type: 'candidate-pair', state: 'succeeded', localCandidateId: 'l', remoteCandidateId: 'r' }],
      ['l', { id: 'l', type: 'local-candidate', candidateType: 'host', protocol: 'tcp' }], ['r', { id: 'r', type: 'remote-candidate', candidateType: 'relay', protocol: 'udp' }]]), 'host/tcp', 'relay/udp'],
    ['a plain array of stats', [{ id: 'T', type: 'transport', selectedCandidatePairId: 'P' }, { id: 'P', type: 'candidate-pair', localCandidateId: 'l', remoteCandidateId: 'r' },
      { id: 'l', type: 'local-candidate', candidateType: 'host', protocol: 'udp' }, { id: 'r', type: 'remote-candidate', candidateType: 'host', protocol: 'udp' }], 'host/udp', 'host/udp'],
    ['a plain object of stats', { T: { id: 'T', type: 'transport', selectedCandidatePairId: 'P' }, P: { id: 'P', type: 'candidate-pair', localCandidateId: 'l', remoteCandidateId: 'r' },
      l: { id: 'l', type: 'local-candidate', candidateType: 'relay', protocol: 'udp' }, r: { id: 'r', type: 'remote-candidate', candidateType: 'host', protocol: 'udp' } }, 'relay/udp', 'host/udp'],
  ];
  for (const [label, stats, local, remote] of cases) {
    const { win, rep } = installed('obs only');
    const pc = new win.RTCPeerConnection();
    pc.stats = stats;
    rep.events.length = 0;
    pc.state('connectionState', 'connected', 'connectionstatechange');
    await flushMicrotasks();
    assert.deepEqual(rep.events.filter((e) => e.n === 'ice.pair'), [{ n: 'ice.pair', id: 1, local, remote }], label);
    assert.doesNotMatch(JSON.stringify(rep.events), IPV4_ANY, label);
  }
  for (const [label, stats] of [['empty', new Map()], ['no candidates', new Map([['P', { id: 'P', type: 'candidate-pair', state: 'succeeded', localCandidateId: 'l', remoteCandidateId: 'r' }]])],
    ['nothing selected', new Map([['P', { id: 'P', type: 'candidate-pair', state: 'failed', localCandidateId: 'l', remoteCandidateId: 'r' }]])], ['null', null], ['a string', 'x']]) {
    const { win, rep } = installed('obs only');
    const pc = new win.RTCPeerConnection();
    pc.stats = stats;
    pc.state('connectionState', 'connected', 'connectionstatechange');
    await flushMicrotasks();
    assert.equal(rep.events.filter((e) => e.n === 'ice.pair').length, 0, label);
  }
});

test('wrapPeerConnection: ice.pair once per connected episode; a failing getStats is no pair and no error; an older engine without connectionState uses iceConnectionState', async () => {
  const { win, rep } = installed('obs only');
  const pc = new win.RTCPeerConnection();
  pc.stats = chromeStats(['host', 'udp'], ['host', 'udp']);
  const pairs = () => rep.events.filter((e) => e.n === 'ice.pair').length;
  pc.state('connectionState', 'connected', 'connectionstatechange');
  pc.fire('connectionstatechange');
  pc.fire('iceconnectionstatechange');
  await flushMicrotasks();
  assert.equal(pairs(), 1);
  assert.equal(pc.statsCalls, 1, 'one getStats per episode');
  pc.state('connectionState', 'disconnected', 'connectionstatechange');
  pc.state('connectionState', 'connected', 'connectionstatechange');
  await flushMicrotasks();
  assert.equal(pairs(), 2, 'a new episode, a new look at the pair');
  // getStats that rejects, throws, or does not return a promise
  for (const bad of [() => Promise.reject(new Error('closed')), () => { throw new Error('sync'); }, () => 'not a promise', () => undefined]) {
    const w = installed('obs only');
    const p = new w.win.RTCPeerConnection();
    p.getStats = bad;
    assert.doesNotThrow(() => p.state('connectionState', 'connected', 'connectionstatechange'));
    await flushMicrotasks();
    assert.equal(w.rep.events.filter((e) => e.n === 'ice.pair').length, 0);
  }
  // no connectionState (an older engine): the ICE state decides, and 'completed' counts too
  const w = installed('obs only');
  const old = new w.win.RTCPeerConnection();
  old.connectionState = undefined;
  old.stats = chromeStats(['srflx', 'udp'], ['srflx', 'udp']);
  old.state('iceConnectionState', 'checking', 'iceconnectionstatechange');
  old.state('iceConnectionState', 'connected', 'iceconnectionstatechange');
  old.state('iceConnectionState', 'completed', 'iceconnectionstatechange');
  await flushMicrotasks();
  assert.equal(w.rep.events.filter((e) => e.n === 'ice.pair').length, 1);
  assert.equal(old.statsCalls, 1);
  // a connection that has no getStats at all
  const w2 = installed('obs only');
  const bare = new w2.win.RTCPeerConnection();
  bare.getStats = undefined;
  assert.doesNotThrow(() => bare.state('connectionState', 'connected', 'connectionstatechange'));
});

test('wrapPeerConnection is idempotent, refuses what it cannot wrap, and marks the wrapper', () => {
  const { win, rep } = installed('obs only');
  const W = win.RTCPeerConnection;
  assert.equal(wrapPeerConnection(win, rep), false);
  assert.equal(win.RTCPeerConnection, W, 'not wrapped twice');
  assert.equal(W.__mwObs, true);
  assert.equal(Object.getOwnPropertyDescriptor(W, '__mwObs').enumerable, false);
  assert.equal(Object.getOwnPropertyDescriptor(W, '__mwObs').writable, false);
  assert.equal(wrapPeerConnection({}, rep), false);
  assert.equal(wrapPeerConnection(null, rep), false);
  assert.equal(wrapPeerConnection(undefined, rep), false);
  assert.equal(wrapPeerConnection({ RTCPeerConnection: 'no' }, rep), false);
  assert.equal(wrapPeerConnection({ RTCPeerConnection: FakePC }, null), false);
  assert.equal(wrapPeerConnection({ RTCPeerConnection: FakePC }, {}), false);
  assert.equal(wrapPeerConnection({ RTCPeerConnection: FakePC }, { event: 'no' }), false);
  const untouched = { RTCPeerConnection: FakePC };
  wrapPeerConnection(untouched, null);
  assert.equal(untouched.RTCPeerConnection, FakePC, 'nothing is installed when there is nothing to report to (a page without the usage-report block)');
  // a different reporter, a second time: still once
  assert.equal(wrapPeerConnection(win, reporterStub()), false);
});

test('wrapPeerConnection keeps the prototype and the statics, works for subclasses, and behaves like the native class without new', async () => {
  const { win, rep } = installed('obs only');
  const W = win.RTCPeerConnection;
  assert.equal(W.name, 'RTCPeerConnection');
  assert.equal(W.prototype, FakePC.prototype);
  assert.equal(Object.getPrototypeOf(W), FakePC);
  const pc = new W({ iceServers: [{ urls: 'stun:a.example:3478' }] });
  assert.ok(pc instanceof W);
  assert.ok(pc instanceof FakePC);
  assert.ok(pc instanceof EventTarget);
  assert.deepEqual(pc.config, { iceServers: [{ urls: 'stun:a.example:3478' }] });
  assert.equal(W.generateCertificate, FakePC.generateCertificate);
  assert.deepEqual(await W.generateCertificate('RSA'), { algorithm: 'RSA', fake: true });
  class Sub extends W {
    constructor(config) { super(config); this.sub = true; }
    extra() { return 'extra'; }
  }
  rep.events.length = 0;
  const s = new Sub({ a: 1 });
  assert.ok(s instanceof Sub);
  assert.ok(s instanceof FakePC);
  assert.equal(s.extra(), 'extra');
  assert.equal(s.sub, true);
  assert.deepEqual(s.config, { a: 1 });
  assert.deepEqual(rep.events, [{ n: 'ice.pc', id: 2, ev: 'created' }]);
  assert.throws(() => W({}), TypeError, 'a class cannot be called without new, wrapped or not');
  assert.throws(() => FakePC({}), TypeError);
});

test('wrapPeerConnection: a reporter that throws, or a connection without addEventListener, never breaks the connection', async () => {
  const angry = { event() { throw new Error('reporter down'); } };
  FakePC.made.length = 0;
  const win = { RTCPeerConnection: FakePC };
  assert.equal(wrapPeerConnection(win, angry), true);
  const pc = new win.RTCPeerConnection({ a: 1 });
  assert.deepEqual(pc.config, { a: 1 });
  pc.state('iceConnectionState', 'connected', 'iceconnectionstatechange');
  pc.fire('icecandidate', candidate('host', 'udp'));
  assert.equal(await pc.setRemoteDescription({ type: 'offer', sdp: SDP }), 'srd:offer');
  pc.close();
  assert.equal(pc.closed, true);
  // a native class without addEventListener (not a browser, but a fake can be): constructed, created is reported, nothing else
  class Bare { constructor(c) { this.c = c; } setRemoteDescription() { return 'ok'; } }
  const rep = reporterStub();
  const win2 = { RTCPeerConnection: Bare };
  assert.equal(wrapPeerConnection(win2, rep), true);
  const b = new win2.RTCPeerConnection(7);
  assert.equal(b.c, 7);
  assert.deepEqual(rep.events, [{ n: 'ice.pc', id: 1, ev: 'created' }]);
  assert.equal(b.setRemoteDescription(), 'ok');
  // a constructor that throws throws the same error through the wrapper
  const win3 = { RTCPeerConnection: class { constructor() { throw new TypeError('bad config'); } } };
  wrapPeerConnection(win3, rep);
  assert.throws(() => new win3.RTCPeerConnection(), /bad config/);
});

test('wrapPeerConnection leaves a read-only RTCPeerConnection alone and says so', () => {
  const win = {};
  Object.defineProperty(win, 'RTCPeerConnection', { value: FakePC, writable: false, configurable: false });
  assert.equal(wrapPeerConnection(win, reporterStub()), false);
  assert.equal(win.RTCPeerConnection, FakePC);
  const quiet = {};
  Object.defineProperty(quiet, 'RTCPeerConnection', { get() { return FakePC; }, set() { /* ignores writes */ }, configurable: true });
  assert.equal(wrapPeerConnection(quiet, reporterStub()), false, 'a setter that drops the write is not an install');
});

test('wrapPeerConnection composes with a harness wrapper that returns a native connection from its constructor', () => {
  FakePC.made.length = 0;
  const Harness = function RTCPeerConnection(config) { return new FakePC(Object.assign({}, config, { iceServers: [] })); };
  Harness.prototype = FakePC.prototype;
  const win = { RTCPeerConnection: Harness };
  const rep = reporterStub();
  assert.equal(wrapPeerConnection(win, rep), true);
  assert.equal(win.RTCPeerConnection.__mwNative, Harness, 'a constructor that is none of the loader\'s own wrappers is the native one for our purposes');
  const pc = new win.RTCPeerConnection({ iceServers: [{ urls: 'stun:x' }] });
  assert.deepEqual(pc.config.iceServers, [], 'the harness still strips the ICE servers');
  pc.fire('icecandidate', candidate('host', 'udp'));
  assert.deepEqual(rep.events.map((e) => e.n), ['ice.pc', 'ice.local']);
});

// The loader installs the offer timeout of connectivity.js (WebTorrent's non-trickle offers) and the usage reporter's wrapper before the
// bundle is imported. Each wraps the constructor, and either may come first, so both orders must work, and the constructor underneath them
// both must stay reachable for the calls, which use the browser's own class.
for (const order of ['obs first, offer timeout on top', 'offer timeout first, obs on top']) {
  test('wrapPeerConnection and installOfferTimeout compose: ' + order, async () => {
    FakePC.made.length = 0;
    const clock = createClock();
    const win = { RTCPeerConnection: FakePC };
    const rep = reporterStub();
    const obs = () => wrapPeerConnection(win, rep);
    const offer = () => installOfferTimeout(win, { timeoutMs: 1500, timers: clock });
    if (order.startsWith('obs first')) { assert.equal(obs(), true); assert.equal(offer(), true); } else { assert.equal(offer(), true); assert.equal(obs(), true); }
    assert.equal(obs(), false, 'obs is installed once');
    assert.equal(offer(), false, 'the offer timeout is installed once');
    const W = win.RTCPeerConnection;

    // the native class is reachable, from the outer wrapper, in both orders
    assert.equal(W.__mwNative, FakePC);
    assert.equal(W.__mwObs, true);
    assert.equal(W.__mwOfferTimeout, 1500, 'the markers of both wrappers are visible on the outer one');
    const today = (R) => (R && R.__mwOfferTimeout ? Object.getPrototypeOf(R) : R);
    assert.notEqual(today(W), FakePC, 'what app.js reads today stops at our wrapper: the reason __mwNative exists');

    // construction
    const pc = new W({ iceServers: [] });
    assert.equal(FakePC.made.length, 1, 'one native connection per construction');
    assert.ok(pc instanceof W && pc instanceof FakePC);
    assert.deepEqual(pc.config, { iceServers: [] });
    assert.deepEqual(rep.events, [{ n: 'ice.pc', id: 1, ev: 'created' }]);

    // icecandidate listeners: a listener and the onicecandidate handler both get the real events; the handler also gets the offer timeout's end
    const viaListener = [];
    const viaHandler = [];
    pc.addEventListener('icecandidate', (e) => viaListener.push(e.candidate ? e.candidate.type : (e.mwSynthetic ? 'synthetic' : 'end')));
    pc.onicecandidate = (e) => viaHandler.push(e.candidate ? e.candidate.type : (e.mwSynthetic ? 'synthetic' : 'end'));
    pc.fire('icecandidate', candidate('host', 'udp'));
    pc.fire('icecandidate', candidate('srflx', 'udp'));
    clock.advance(1499);
    assert.deepEqual(viaHandler, ['host', 'srflx']);
    clock.advance(1);
    assert.deepEqual(viaHandler, ['host', 'srflx', 'synthetic'], 'the offer timeout still ends a non-trickle offer');
    assert.deepEqual(viaListener, ['host', 'srflx'], 'a plain listener sees only what the browser fires');
    assert.deepEqual(rep.events.filter((e) => e.n === 'ice.local'), [{ n: 'ice.local', id: 1, type: 'host', proto: 'udp' }, { n: 'ice.local', id: 1, type: 'srflx', proto: 'udp' }]);

    // setRemoteDescription and getStats still reach the native methods
    const desc = { type: 'answer', sdp: SDP };
    assert.equal(await pc.setRemoteDescription(desc), 'srd:answer');
    assert.equal(pc.remote.length, 1);
    assert.equal(pc.remote[0].desc, desc);
    assert.deepEqual(rep.events.filter((e) => e.n === 'ice.remote'), [{ n: 'ice.remote', id: 1, sdp: 'answer', types: 'host,host,srflx,relay,host' }]);
    pc.stats = chromeStats(['srflx', 'udp'], ['host', 'udp']);
    const own = await pc.getStats();
    assert.equal(own, pc.stats, 'a page that calls getStats gets the native answer');
    const before = pc.statsCalls;
    pc.state('connectionState', 'connected', 'connectionstatechange');
    await flushMicrotasks();
    assert.equal(pc.statsCalls, before + 1);
    assert.deepEqual(rep.events.filter((e) => e.n === 'ice.pair'), [{ n: 'ice.pair', id: 1, local: 'srflx/udp', remote: 'host/udp' }]);

    // the static
    assert.equal(W.generateCertificate, FakePC.generateCertificate);
    assert.deepEqual(await W.generateCertificate({ name: 'ECDSA' }), { algorithm: { name: 'ECDSA' }, fake: true });
    pc.close();
    assert.equal(pc.closed, true);
    assert.deepEqual(rep.events.filter((e) => e.n === 'ice.pc'), [{ n: 'ice.pc', id: 1, ev: 'created' }, { n: 'ice.pc', id: 1, ev: 'closed' }]);
    assert.doesNotMatch(JSON.stringify(rep.events), IPV4_ANY);

    // the calls: the class under both wrappers makes a connection that is neither reported nor patched
    const Native = W.__mwNative;
    const call = new Native({ iceServers: [] });
    assert.equal(rep.events.filter((e) => e.n === 'ice.pc' && e.ev === 'created').length, 1, 'a call is not reported');
    assert.equal(Object.getOwnPropertyDescriptor(call, 'onicecandidate'), undefined, 'and the offer timeout did not patch it');
    assert.equal(FakePC.made.length, 2);
  });
}

test('the offer timeout alone is unwrapped by what app.js reads today; obs does not change that for a page without it', () => {
  FakePC.made.length = 0;
  const win = { RTCPeerConnection: FakePC };
  installOfferTimeout(win, { timeoutMs: 1500, timers: createClock() });
  const R = win.RTCPeerConnection;
  assert.equal(Object.getPrototypeOf(R), FakePC);
  assert.equal(R.__mwNative, undefined, 'only our wrapper sets it');
  assert.equal(R.__mwObs, undefined);
});

test('three wrappers deep (a harness, the offer timeout, obs) still find the class that is none of ours', () => {
  FakePC.made.length = 0;
  class Harness extends FakePC {}
  const win = { RTCPeerConnection: Harness };
  installOfferTimeout(win, { timeoutMs: 1500, timers: createClock() });
  wrapPeerConnection(win, reporterStub());
  assert.equal(win.RTCPeerConnection.__mwNative, Harness);
  const pc = new win.RTCPeerConnection();
  assert.ok(pc instanceof Harness);
});

test('a real reporter and the wrapper: a whole connection leaves no address and no port in any body', async () => {
  FakePC.made.length = 0;
  const { r, posts, clock } = rig();
  const win = { RTCPeerConnection: FakePC };
  assert.equal(wrapPeerConnection(win, r), true);
  r.allow(true);
  const pc = new win.RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.example:3478' }] });
  pc.fire('icecandidate', candidate('host', 'udp'));
  await pc.setRemoteDescription({ type: 'offer', sdp: SDP });
  pc.stats = chromeStats(['host', 'udp'], ['srflx', 'udp']);
  pc.state('connectionState', 'connected', 'connectionstatechange');
  await flushMicrotasks();
  clock.advance(2000);
  const raw = posts.map((p) => p.text).join('\n');
  assert.ok(posts.length >= 1);
  assert.doesNotMatch(raw, IPV4_ANY);
  assert.doesNotMatch(raw, /192\.168|203\.0|198\.51|10\.0\.0|50000|50001|3478|supersecret|ufrag|AA:BB/);
  const got = posts.flatMap((p) => p.body.events.map((e) => e.n));
  assert.deepEqual(got, ['ice.pc', 'ice.local', 'ice.remote', 'ice.conn', 'ice.pair']);
});

// ---------------------------------------------------------------------------------------------
// The source follows the rules of plan section 0
// ---------------------------------------------------------------------------------------------

test('the source of obs.js follows the wording and style rules: ASCII, no dashes, no banned words, no imports, no logging, no semicolons, no lookbehind', () => {
  const src = readFileSync(OBS_SOURCE, 'utf8');
  const has = (re) => re.test(src);
  assert.equal(has(/[^\x00-\x7f]/), false, 'pure ASCII');
  assert.equal(src.includes(EN_DASH) || src.includes(EM_DASH), false, 'no en dash or em dash');
  const banned = ['block' + 'chain', 'server' + 'less', 'un' + 'stoppable', 'censorship-' + 'resistant', 'production-' + 'ready', 'fully ' + 'decentralized', 'sub-' + 'second', 'on' + 'line'];
  for (const w of banned) assert.equal(src.toLowerCase().includes(w), false, w);
  assert.equal(has(/^\s*import\b/m), false, 'no imports: the identity page build can bundle the file as it is');
  assert.equal(has(/\bconsole\s*\./), false, 'a reporter does not log');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  assert.deepEqual(code.filter((l) => /;\s*$/.test(l)), [], 'src/loader is semicolon-free');
  assert.equal(has(/\(\?<[=!]/), false, 'no regular expression lookbehind (the floor includes Safari 15.4)');
  assert.equal(has(/\bnew Function\b|\beval\s*\(/), false);
  assert.equal(has(new RegExp('[' + String.fromCharCode(0x201c, 0x201d, 0x2018, 0x2019) + ']')), false, 'straight quotes');
  // nothing in the file asks the page for its address or its storage: a report carries what it is handed, nothing more
  assert.equal(has(/\blocation\b|\bdocument\.cookie\b|\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/), false);
});

test('this test file follows the same wording rules', () => {
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert.equal(src.includes(EN_DASH) || src.includes(EM_DASH), false);
  assert.equal(/[^\x00-\x7f]/.test(src), false, 'pure ASCII: every other character is built from its code point');
});

// ---------------------------------------------------------------------------------------------
// More cases found by changing the source and watching which test noticed
// ---------------------------------------------------------------------------------------------

test('ua: an iOS in-app web view has no Safari token and is still WebKit', () => {
  const view = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
  const { r, posts } = rig({ env: { navigator: { userAgent: view } } });
  assert.deepEqual(sendOne(r, posts).ua, { browser: 'webkit', mobile: true });
  const ipad = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
  const b = rig({ env: { navigator: { userAgent: ipad } } });
  assert.equal(sendOne(b.r, b.posts).ua.browser, 'webkit');
});

test('a byte is a byte: four for a character outside the BMP, three for the euro sign, two for an accent, one for ASCII, and the batch stays within the cap', () => {
  const { r, posts } = rig();
  r.allow(true);
  const fields = {};
  for (let i = 0; i < 12; i++) fields['f' + i] = String.fromCodePoint(0x1f600).repeat(100);
  for (let i = 0; i < 12; i++) r.event('x.emoji', Object.assign({ i }, fields));
  let guard = 0;
  while (r.inspect().queued > 0 && guard++ < 40) r.flush();
  assert.ok(posts.length >= 2);
  for (const p of posts) assert.ok(Buffer.byteLength(p.text, 'utf8') <= OBS_LIMITS.maxBodyBytes, 'batch of ' + Buffer.byteLength(p.text, 'utf8') + ' bytes');
  assert.deepEqual(posts.flatMap((p) => p.body.events.map((e) => e.i)), Array.from({ length: 12 }, (_, i) => i));
});

test('the retries of several batches go in seq order, however their answers arrive', async () => {
  const pending = [];
  const seqs = [];
  const { r, clock, hide } = rig({ send: (u, t) => { seqs.push(JSON.parse(t).seq); return new Promise((resolve) => pending.push(resolve)); } });
  r.allow(true);
  for (let i = 0; i < 3; i++) { r.setWho(['aaaa-bbbb', 'aaaa-cccc', 'aaaa-dddd'][i]); r.event('a.n', { i }); }
  hide.fn();
  assert.deepEqual(seqs, [0, 1, 2], 'a final flush has all three in flight at once');
  pending[2](false);
  pending[0](false);
  pending[1](false);
  await flushMicrotasks();
  seqs.length = 0;
  pending.length = 0;
  for (let i = 0; i < 3; i++) { clock.advance(2000); }
  assert.deepEqual(seqs, [0], 'one batch per ordinary flush, the oldest first');
  pending[0](true);
  await flushMicrotasks();
  clock.advance(2000);
  pending[1](true);
  await flushMicrotasks();
  clock.advance(2000);
  assert.deepEqual(seqs, [0, 1, 2]);
});

test('the default hide subscription is pagehide and a visibilitychange to hidden, and stop() takes both off', () => {
  const added = [];
  const removed = [];
  const doc = { visibilityState: 'visible', addEventListener: (t, f) => added.push(['document', t, f]), removeEventListener: (t, f) => removed.push(['document', t, f]) };
  const hadAdd = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener');
  const hadRemove = Object.getOwnPropertyDescriptor(globalThis, 'removeEventListener');
  const hadDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'addEventListener', { value: (t, f) => added.push(['window', t, f]), configurable: true, writable: true });
  Object.defineProperty(globalThis, 'removeEventListener', { value: (t, f) => removed.push(['window', t, f]), configurable: true, writable: true });
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
  try {
    const clock = createClock(T0_MS);
    const posts = [];
    const r = createReporter({ endpoint: 'https://obs.example', now: clock.now, timers: clock, send: (u, t) => { posts.push(JSON.parse(t)); return true; } });
    assert.deepEqual(added.map((a) => a.slice(0, 2)), [['window', 'pagehide'], ['document', 'visibilitychange']]);
    r.allow(true);
    r.event('a.one');
    added[1][2]();
    assert.equal(posts.length, 0, 'a visibilitychange to visible does not flush');
    doc.visibilityState = 'hidden';
    added[1][2]();
    assert.equal(posts.length, 1, 'hidden flushes');
    r.event('a.two');
    added[0][2]();
    assert.equal(posts.length, 2, 'pagehide flushes');
    r.stop();
    assert.deepEqual(removed.map((a) => a.slice(0, 2)), [['window', 'pagehide'], ['document', 'visibilitychange']]);
    assert.equal(removed[0][2], added[0][2]);
    assert.equal(removed[1][2], added[1][2]);
    // a visibility object that is not usable is ignored, and a falsy one means the default
    const bad = createReporter({ endpoint: 'https://obs.example', send: () => true, visibility: {}, timers: clock, now: clock.now });
    assert.equal(bad.inspect().enabled, true);
    assert.equal(added.length, 2, 'a visibility object without onHide subscribes to nothing, and no default is added behind it');
  } finally {
    for (const [name, had] of [['addEventListener', hadAdd], ['removeEventListener', hadRemove], ['document', hadDoc]]) {
      if (had) Object.defineProperty(globalThis, name, had); else delete globalThis[name];
    }
  }
});

test('wrapPeerConnection: setRemoteDescription runs with the this it was called with, and only candidate lines count', async () => {
  const { win, rep } = installed('obs only');
  const a = new win.RTCPeerConnection();
  const b = new win.RTCPeerConnection();
  rep.events.length = 0;
  await a.setRemoteDescription.call(b, { type: 'offer', sdp: 'a=candidate:1 1 udp 1 1.2.3.4 5 typ host\r\na=x-note:says typ relay here\r\nb=typ srflx' });
  assert.equal(b.remote.length, 1, 'the native method ran on the object it was called on');
  assert.equal(a.remote.length, 0);
  assert.deepEqual(rep.events, [{ n: 'ice.remote', id: 1, sdp: 'offer', types: 'host' }]);
});

test('a send that fails after a no, or after stop(), is dropped and counted, not kept for a retry that can never happen', async () => {
  for (const how of ['no', 'stop']) {
    const pending = [];
    const { r, clock } = rig({ send: () => new Promise((resolve) => pending.push(resolve)) });
    r.allow(true);
    r.event('a.one');
    r.event('a.two');
    r.flush();
    assert.equal(r.inspect().queued, 2, how);
    if (how === 'no') r.allow(false); else r.stop();
    pending[0](false);
    await flushMicrotasks();
    assert.deepEqual({ queued: r.inspect().queued, sent: r.inspect().sent, dropped: r.inspect().dropped }, { queued: 0, sent: 0, dropped: 2 }, how);
    clock.advance(60000);
    assert.equal(pending.length, 1, 'no retry after ' + how);
  }
  // a send that succeeds after stop() still counts as sent
  const pending = [];
  const { r } = rig({ send: () => new Promise((resolve) => pending.push(resolve)) });
  r.allow(true);
  r.event('a.one');
  r.stop();
  pending[0](true);
  await flushMicrotasks();
  assert.deepEqual({ queued: r.inspect().queued, sent: r.inspect().sent, dropped: r.inspect().dropped }, { queued: 0, sent: 1, dropped: 0 });
});

// ---------------------------------------------------------------------------------------------
// The fix lane (verify-adversary F2, F3, F4, F6, F7)
// ---------------------------------------------------------------------------------------------

test('safeField: the look-alikes of the dot and the colon, a combining mark in an address, percent escapes and octal groups are addresses; one integer and a hex number stay', () => {
  table([
    ['192' + ch(0x3002) + '168' + ch(0x3002) + '0' + ch(0x3002) + '1', 'x.x.x.x'],
    ['192' + ch(0xff61) + '168' + ch(0xff61) + '0' + ch(0xff61) + '1', 'x.x.x.x'],
    ['192%2E168%2E0%2E1', 'x.x.x.x'],
    ['http://192%2e168%2e0%2e1:8080/x', 'http://x.x.x.x/x'],
    ['192' + ch(0x301) + '.168.0.1', 'x.x.x.x'],
    ['192.168' + ch(0x301) + ch(0x302) + '.0.1', 'x.x.x.x'],
    ['0300.0250.0.1', 'x.x.x.x'],
    ['0300.0250.0.1:8080', 'x.x.x.x'],
    ['010.020.030.040', 'x.x.x.x'],
    ['page 08.1.1.1 and 00.1.2.3 and 0.0.0.0', 'page x.x.x.x and x.x.x.x and x.x.x.x'],
    ['2001' + ch(0x2236) + 'db8' + ch(0x2236) + ch(0x2236) + '1', 'x.x.x.x'],
    ['2001' + ch(0xa789) + 'db8' + ch(0xa789) + ch(0xa789) + '1', 'x.x.x.x'],
    ['2001%3adb8%3a%3a1', 'x.x.x.x'],
    // not addresses: an integer, an error code in hex, a version, a date, an accent that has no composed form
    ['3232235777', '3232235777'],
    ['0xC0A80001', '0xC0A80001'],
    ['Error 0x80070005 in 1.2.3 on 2026.11.02', 'Error 0x80070005 in 1.2.3 on 2026.11.02'],
    ['caf' + ch(0xe9) + ' and q' + ch(0x301), 'caf' + ch(0xe9) + ' and q' + ch(0x301)],
  ]);
});

test('safeField: the user fragment, the password and the fingerprint of an SDP are cut with the addresses, whatever line ends the text has; the keys stay', () => {
  const sdp = 'a=candidate:842163049 1 udp 1677729535 203.0.113.9 51472 typ srflx raddr 192.168.1.5 rport 51472\r\na=ice-ufrag:Zq3k\r\na=ice-pwd:zXy9aBcDeFgHiJkLmNoPqRsT\r\na=fingerprint:sha-256 5D:1C:0A:77:B3:4E:99:AB:CD:EF:01:23:45:67:89:AB\r\n';
  const out = safeField(sdp);
  assert.equal(out, 'a=candidate:842163049 1 udp 1677729535 x.x.x.x typ srflx raddr x.x.x.x a=ice-ufrag: a=ice-pwd: a=fingerprint:sha-256');
  for (const secret of ['Zq3k', 'zXy9', '5D:1C', '203.0.113', '192.168', '51472']) assert.equal(out.includes(secret), false, secret);
  assert.equal(safeField(out), out, 'twice changes nothing');
  table([['ice-ufrag:Zq3k and fingerprint:abc', 'ice-ufrag:Zq3k and fingerprint:abc'], ['A=ICE-PWD:Secret1234 x', 'A=ICE-PWD: x']]);
});

test('safeField: a text of many "#1" costs time in proportion to its length, not to its square, and what the rule keeps and cuts is what it always was', () => {
  const real = RegExp.prototype.test;
  let chars = 0;
  RegExp.prototype.test = function (s) { chars += String(s).length; return real.call(this, s); };
  let out;
  try { out = safeField('#1'.repeat(1000)); } finally { RegExp.prototype.test = real; }
  assert.ok(chars < 20000, 'characters handed to a regular expression test: ' + chars + ' (reading everything before each # again made it about a million)');
  assert.equal(out, '#1'.repeat(100));
  table([['a #1#1 b.c #2', 'a #1#1 b.c #2'], ['a #1#1 b.c#2', 'a #1#1 b.c#'], ['x#1.5#2', 'x#1.5#'], ['x#1#a/b', 'x#1#'], ['https://host/#123456', 'https://host/#'], ['step #3 of #12 at #7', 'step #3 of #12 at #7']]);
});

test('describeTarget: a control too large for the search of the mark (more than 40 children, 80 nodes or 200 ancestors) gives no label; a smaller one keeps it', () => {
  const doc = new FakeDocument();
  const button = (kids, text = 'Share') => {
    const b = el(doc, 'button', { 'data-fk': 'x:1' }, text);
    for (let i = 0; i < kids; i++) b.appendChild(el(doc, 'span', {}));
    return b;
  };
  assert.equal(describeTarget(button(40)).text, 'Share');
  assert.equal(describeTarget(button(41)).text, undefined);
  const marked = button(40);
  marked.appendChild(el(doc, 'span', { dir: 'auto' }, 'Bea'));
  assert.equal(describeTarget(marked).text, undefined, 'a mark behind 40 siblings is not missed');
  let at = el(doc, 'button', { 'data-fk': 'x:2' });
  const top = at;
  for (let i = 0; i < 79; i++) { const next = el(doc, 'span', {}); at.appendChild(next); at = next; }
  at.appendChild(el(doc, 'span', { dir: 'auto' }, 'Bea'));
  assert.equal(describeTarget(top).text, undefined, '81 nodes with the mark last: more than the search covers, so no label');
});
