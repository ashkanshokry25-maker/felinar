// Unit tests for deploy/obs-worker/worker.js: the front (the default export) and the Durable Object ObsLog through a fake platform,
// modelled on deploy-rtc-worker.test.mjs (fakeStorage, fakeCtx, fakeWs, a mocked Date), plus a scan of the source for what the
// Worker must never touch. obs-core.js (the validation, the masks, the limits, the log) has its own tests in deploy-obs-core.test.mjs.
// Nothing here opens a socket. WebSocketPair does not exist in Node, so a tail socket is put into the object the way fetch() does
// once the platform has made the pair (obj.accept), and one test fakes the pair to follow a whole upgrade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import worker, { ObsLog } from '../../deploy/obs-worker/worker.js';
import { LIMITS, MASK, KEY_PREFIX, META_KEY, batchKey, parseBatchKey, utf8Length, maskString } from '../../deploy/obs-worker/obs-core.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'deploy', 'obs-worker');
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const SITE = 'https://site.example';
const DOOR = 'https://door.example';
const TOKEN = 'r3ad-t0ken-0123456789abcdef';
const SID = 'k3m8k3m8k3m8';

const sidOf = (i) => 'k3m8' + i.toString(8).padStart(8, '0').replace(/[0-7]/g, (d) => String(Number(d) + 2));
const sample = (over = {}) => Object.assign({
  v: 1, sid: SID, seq: 7, page: 'door', build: 'bbcb82098cda', loader: '0.3.0', site: 'd680ff36', who: 'da9u-6qug',
  net: { type: 'cellular', effectiveType: '4g' }, ua: { browser: 'chromium', mobile: true }, t0: 1793600000,
  events: [{ t: 1234, n: 'gate.shown', kind: 'consent', host: 'tracker.example' }, { t: 1300, n: 'ui.click', role: 'continue', trusted: true, ms: 12.5, x: null }],
}, over);
const batchOf = (i, extra = {}) => sample(Object.assign({ sid: sidOf(i), seq: i }, extra));

// ---------------------------------------------------------------------------------------------- the fake platform

function fakeWs(name) {
  return {
    name, sent: [], closed: null, attachment: null, throwOnSend: false,
    send(t) { if (this.throwOnSend) throw new Error('closing'); this.sent.push(JSON.parse(t)); },
    close(code, reason) { this.closed = { code, reason }; },
    serializeAttachment(v) { this.attachment = JSON.parse(JSON.stringify(v)); },
    deserializeAttachment() { return this.attachment; },
  };
}

/** The Durable Object storage of the fake platform: rows are cloned in and out, list() takes the options of the platform's API, delete() at most 128 keys. */
function fakeStorage(rows = new Map()) {
  let alarm = null;
  const ops = { puts: [], deletes: [] };
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  return {
    rows,
    ops,
    async get(key) { return clone(rows.get(key)); },
    async put(key, value) { ops.puts.push(key); rows.set(key, clone(value)); },
    async delete(keys) {
      ops.deletes.push(keys);
      if (!Array.isArray(keys)) return rows.delete(keys);
      if (keys.length > 128) throw new Error('delete() takes at most 128 keys');
      let n = 0;
      for (const k of keys) if (rows.delete(k)) n++;
      return n;
    },
    async list({ prefix = '', start, startAfter, end, reverse = false, limit } = {}) {
      if (start !== undefined && startAfter !== undefined) throw new Error('list(): start and startAfter cannot be used together');
      let keys = Array.from(rows.keys()).sort().filter((k) => k.startsWith(prefix) && (start === undefined || k >= start) && (startAfter === undefined || k > startAfter) && (end === undefined || k < end));
      if (reverse) keys.reverse();
      if (limit !== undefined) keys = keys.slice(0, limit);
      const out = new Map();
      for (const k of keys) out.set(k, clone(rows.get(k)));
      return out;
    },
    async getAlarm() { return alarm; },
    async setAlarm(t) { alarm = t; },
    alarmAt: () => alarm,
  };
}
function fakeCtx(sockets = [], storage = fakeStorage()) {
  return { sockets, accepted: [], storage, getWebSockets: () => sockets.slice(), acceptWebSocket(ws) { this.accepted.push(ws); sockets.push(ws); }, blockConcurrencyWhile: (fn) => Promise.resolve().then(fn), alarmAt: () => storage.alarmAt() };
}

const clocked = new WeakSet();

/** platform(t, over) -> one object over a fake storage, and the env of the front bound to it; every request the front sends the object is kept in seen. */
async function platform(t, over = {}) {
  if (!clocked.has(t)) { t.mock.timers.enable({ apis: ['Date'], now: T0 }); clocked.add(t); } else t.mock.timers.setTime(T0);
  const storage = over.storage || fakeStorage();
  const ctx = fakeCtx(over.sockets || [], storage);
  const obj = new ObsLog(ctx, Object.assign({}, over.objectEnv));
  await obj.ready;
  const seen = [];
  // what the front sent the object, as plain records (the object reads the body of the request itself, so it is read from a copy)
  const stub = { fetch: async (req) => { seen.push({ method: req.method, url: req.url, headers: Array.from(req.headers.keys()), text: req.method === 'POST' ? await req.clone().text() : null }); return obj.fetch(req); } };
  const env = Object.assign({ ALLOW_ORIGINS: SITE + ', ' + DOOR, READ_TOKEN: TOKEN, OBS: { idFromName: (n) => 'id:' + n, get: (id) => { seen.ids = (seen.ids || []).concat(id); return stub; } } }, over.env);
  return { storage, ctx, obj, env, seen };
}

/** fire(p): the platform fires the alarm (it is no longer set while it runs), then the object's handler. */
async function fire(p) {
  await p.storage.setAlarm(null);
  await p.obj.alarm();
}

const post = (p, body, { origin = SITE, type = 'text/plain;charset=UTF-8', headers = {} } = {}) => {
  const h = Object.assign({}, origin === null ? {} : { Origin: origin }, type === null ? {} : { 'Content-Type': type }, headers);
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  // a string body makes the Request add Content-Type: text/plain itself, so a request without a type carries bytes
  return worker.fetch(new Request('https://obs.example/e', { method: 'POST', headers: h, body: type === null ? new TextEncoder().encode(text) : text }), p.env);
};
const get = (p, path, headers = {}) => worker.fetch(new Request('https://obs.example' + path, { headers }), p.env);
const rowKeys = (p) => Array.from(p.storage.rows.keys()).filter((k) => k.startsWith(KEY_PREFIX));
const word = async (res) => (await res.text()).trim();

// ---------------------------------------------------------------------------------------------- the front

test('front: /healthz answers ok; every other path and method is 404; the tail is 426 without an upgrade and 404 without the token', async (t) => {
  const p = await platform(t);
  const ok = await get(p, '/healthz');
  assert.deepEqual([ok.status, await ok.text()], [200, 'ok\n']);
  assert.equal((await worker.fetch(new Request('https://obs.example/healthz', { method: 'HEAD' }), p.env)).status, 200);
  assert.equal((await worker.fetch(new Request('https://obs.example/healthz', { method: 'POST', body: 'x' }), p.env)).status, 404);
  for (const path of ['/', '/index.html', '/e/', '/E', '/events', '/summary', '/stats.json', '/healthz/x', '/tail/x', '/_worker.js']) assert.equal((await get(p, path)).status, 404, path);
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) assert.equal((await worker.fetch(new Request('https://obs.example/e', { method, ...(method === 'GET' ? {} : { body: '{}' }) }), p.env)).status, 404, method + ' /e');
  for (const path of ['/events.json', '/summary.json', '/tail']) assert.equal((await worker.fetch(new Request('https://obs.example' + path + '?token=' + TOKEN, { method: 'POST', body: '{}' }), p.env)).status, 404, 'POST ' + path);
  assert.equal((await get(p, '/tail')).status, 404, 'no token: not found, whatever the request');
  assert.equal((await get(p, '/tail', { Upgrade: 'websocket' })).status, 404, 'an upgrade without the token is not found either');
  const plain = await get(p, '/tail?token=' + TOKEN);
  assert.equal(plain.status, 426);
  assert.equal(plain.headers.get('upgrade'), 'websocket');
  assert.equal(p.seen.length, 0, 'none of these reached the object');
});

test('front: the Origin of a report must be one ALLOW_ORIGINS names, exactly; with none named every report is refused', async (t) => {
  const p = await platform(t);
  const refused = [
    ['no Origin header', null], ['Origin: null', 'null'], ['an origin that is not listed', 'https://evil.example'], ['the same host on http', 'http://site.example'],
    ['the same host on another port', 'https://site.example:8443'], ['a subdomain', 'https://a.site.example'], ['the same name in capitals', 'HTTPS://SITE.EXAMPLE'],
    ['a trailing slash', SITE + '/'], ['a path', SITE + '/x'], ['empty', ''], ['a wildcard', '*'],
  ];
  for (const [what, origin] of refused) {
    const res = await post(p, sample(), { origin });
    assert.deepEqual([what, res.status, await res.text()], [what, 403, 'origin not allowed\n']);
    assert.equal(res.headers.get('access-control-allow-origin'), null, what + ': a refused origin is not told it may read');
    assert.equal(res.headers.get('vary'), 'Origin');
  }
  assert.equal(p.seen.length, 0, 'a refused report never reaches the object');
  assert.equal(rowKeys(p).length, 0);
  let i = 0;
  for (const origin of [SITE, DOOR]) {
    const res = await post(p, batchOf(++i), { origin });
    assert.equal(res.status, 204, origin);
    assert.equal(await res.text(), '');
    assert.equal(res.headers.get('access-control-allow-origin'), origin, 'the allowed origin is echoed, not *');
    assert.equal(res.headers.get('vary'), 'Origin');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
  assert.equal(rowKeys(p).length, 2);
  // the list itself: comma, space or line separated; a trailing slash and capitals in the config are forgiven; a wildcard, a path and "null" are not origins
  const named = async (list, origin) => (await post(Object.assign({}, p, { env: Object.assign({}, p.env, { ALLOW_ORIGINS: list }) }), batchOf(++i), { origin })).status;
  assert.equal(await named('', SITE), 403, 'an empty list refuses everything');
  assert.equal(await named(undefined, SITE), 403, 'so does a missing one');
  assert.equal(await named('   ,  ,', SITE), 403);
  assert.equal(await named('*', SITE), 403, 'there is no wildcard');
  assert.equal(await named('*', '*'), 403);
  assert.equal(await named('null', 'null'), 403);
  assert.equal(await named(SITE + '/path', SITE), 403, 'an entry with a path is not an origin');
  assert.equal(await named('https://user@site.example', 'https://user@site.example'), 403, 'nor one with a userinfo');
  assert.equal(await named('site.example', SITE), 403, 'nor a bare host');
  assert.equal(await named('HTTPS://Site.Example/', SITE), 204, 'capitals and a trailing slash in the config');
  assert.equal(await named('https://a.example\n  https://b.example:8443 ,' + SITE, 'https://b.example:8443'), 204, 'lines, spaces and commas separate; a port is part of the origin');
  assert.equal(await named('http://127.0.0.1:8080', 'http://127.0.0.1:8080'), 204, 'a loopback http origin');
  assert.equal(await named('https://a.example', SITE), 403);
});

test('front: OPTIONS /e answers the preflight for an allowed origin (10 minutes) and refuses any other', async (t) => {
  const p = await platform(t);
  const ask = (origin) => worker.fetch(new Request('https://obs.example/e', { method: 'OPTIONS', headers: Object.assign({ 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }, origin === null ? {} : { Origin: origin }) }), p.env);
  const ok = await ask(DOOR);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), DOOR);
  assert.equal(ok.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.equal(ok.headers.get('access-control-allow-headers'), 'content-type');
  assert.equal(ok.headers.get('access-control-max-age'), '600');
  assert.equal(ok.headers.get('vary'), 'Origin');
  for (const origin of [null, 'null', 'https://evil.example']) {
    const no = await ask(origin);
    assert.equal(no.status, 403, String(origin));
    assert.equal(no.headers.get('access-control-allow-origin'), null);
  }
  assert.equal((await worker.fetch(new Request('https://obs.example/events.json', { method: 'OPTIONS', headers: { Origin: SITE } }), p.env)).status, 404, 'only /e has a preflight');
  assert.equal(p.seen.length, 0);
});

test('front: a body over 32768 bytes is 413 (by its declared length, or as it streams, in bytes and not characters) and exactly 32768 is read', async (t) => {
  const p = await platform(t);
  const base = JSON.stringify(sample());
  const exact = base + ' '.repeat(32768 - utf8Length(base));
  assert.equal(utf8Length(exact), 32768);
  const full = await post(p, exact);
  assert.equal(full.status, 204, 'the limit itself is allowed');
  const over = await post(p, exact + ' ');
  assert.deepEqual([over.status, await over.text()], [413, 'too large\n']);
  assert.equal(over.headers.get('access-control-allow-origin'), SITE, 'a browser may read the refusal');
  const declared = await post(p, '{}', { headers: { 'Content-Length': '32769' } });
  assert.equal(declared.status, 413, 'a declared length over the limit is refused before the body is read');
  const wide = JSON.stringify(sample({ events: [{ t: 0, n: 'a.b', m: String.fromCharCode(233).repeat(16400) }] }));
  assert.ok(wide.length < 32768 && utf8Length(wide) > 32768);
  assert.equal((await post(p, wide)).status, 413, 'bytes, not characters');
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < 40; i++) c.enqueue(new Uint8Array(1000).fill(32)); c.close(); } });
  const streamed = await worker.fetch(new Request('https://obs.example/e', { method: 'POST', headers: { Origin: SITE, 'Content-Type': 'text/plain' }, body: stream, duplex: 'half' }), p.env);
  assert.equal(streamed.status, 413, 'a body without a length is cut off at the limit');
  const lying = await post(p, ' '.repeat(40000), { headers: { 'Content-Length': '10' } });
  assert.equal(lying.status, 413, 'a declared length that is too small for the body is not believed');
  assert.equal((await post(p, '{}', { headers: { 'Content-Length': 'many' } })).status, 400, 'a length that is not a number is ignored and the body judged as it is');
  const before = p.seen.length;
  const none = await post(p, '');
  assert.deepEqual([none.status, await none.text()], [400, 'empty\n']);
  assert.equal(p.seen.length, before, 'an empty body is refused at the front: the object is not asked');
  assert.equal(rowKeys(p).length, 1, 'only the first batch was stored');
});

test('front: the Content-Type must be text/plain or application/json, whatever its case or parameters', async (t) => {
  const p = await platform(t);
  let i = 0;
  for (const type of ['text/plain', 'text/plain;charset=UTF-8', 'text/plain; charset=utf-8', 'TEXT/PLAIN', 'application/json', 'Application/JSON; charset=utf-8']) {
    assert.equal((await post(p, batchOf(++i), { type })).status, 204, type);
  }
  for (const type of ['text/html', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/octet-stream', 'text/plainer', 'xtext/plain', '', null]) {
    const res = await post(p, batchOf(++i), { type });
    assert.deepEqual([String(type), res.status, await res.text()], [String(type), 415, 'unsupported type\n']);
    assert.equal(res.headers.get('access-control-allow-origin'), SITE);
  }
  assert.equal(rowKeys(p).length, 6);
});

test('front: a bad batch is 400 with one word and stores and pushes nothing; the object, not the front, judges it', async (t) => {
  const p = await platform(t);
  const ws = fakeWs('tail');
  await p.obj.accept(ws);
  const frames = ws.sent.length;
  const cases = [
    ['', 'empty'], ['{', 'json'], ['not json at all', 'json'], ['null', 'shape'], ['[]', 'shape'], ['"x"', 'shape'], [JSON.stringify(sample({ v: 2 })), 'version'],
    [JSON.stringify(sample({ sid: 'SHORT' })), 'sid'], [JSON.stringify(sample({ seq: -1 })), 'seq'], [JSON.stringify(sample({ page: 'app' })), 'page'], [JSON.stringify(sample({ events: [] })), 'events'],
    [JSON.stringify(sample({ events: Array.from({ length: 101 }, (_, i) => ({ t: i, n: 'a.b' })) })), 'events'], [JSON.stringify(sample({ events: [{ t: 0, n: 'Bad Name' }] })), 'name'],
    [JSON.stringify(sample({ events: [{ t: 0, n: 'a.b', x: { y: 1 } }] })), 'value'],
    [JSON.stringify(sample({ events: [Object.assign({ t: 0, n: 'a.b' }, Object.fromEntries(Array.from({ length: 13 }, (_, i) => ['k' + i, i])))] })), 'keys'],
    ['[' .repeat(10000) + ']'.repeat(10000), 'shape'],
  ];
  for (const [body, reason] of cases) {
    const res = await post(p, body);
    assert.deepEqual([body.slice(0, 24), res.status, await res.text()], [body.slice(0, 24), 400, reason + '\n']);
    assert.equal(res.headers.get('access-control-allow-origin'), SITE);
  }
  assert.equal(rowKeys(p).length, 0, 'nothing stored');
  assert.equal(p.storage.ops.puts.length, 0, 'nothing written at all');
  assert.equal(ws.sent.length, frames, 'nothing pushed to the tail');
  assert.equal(p.ctx.alarmAt(), T0 + 10 * MIN, 'the one the tail socket set: the refused batches set none of their own');
});

test('front: a session that sends more than 60 batches in a minute gets 429 with Retry-After; the day caps do the same; the CORS headers stay on the refusal', async (t) => {
  const p = await platform(t);
  for (let i = 0; i < 60; i++) assert.equal((await post(p, sample({ seq: i }))).status, 204);
  const over = await post(p, sample({ seq: 60 }));
  assert.deepEqual([over.status, await over.text()], [429, 'sid-minute\n']);
  assert.equal(over.headers.get('retry-after'), '60');
  assert.equal(over.headers.get('access-control-allow-origin'), SITE);
  assert.equal((await post(p, batchOf(1))).status, 204, 'another session is not held back');
  assert.equal(rowKeys(p).length, 61);
  t.mock.timers.tick(MIN + 1);
  assert.equal((await post(p, sample({ seq: 61 }))).status, 204, 'a minute later');
  // all sessions together: MAX_BATCHES_PER_DAY, from the object's vars
  const q = await platform(t, { objectEnv: { MAX_BATCHES_PER_DAY: '3' } });
  for (let i = 0; i < 3; i++) assert.equal((await post(q, batchOf(i))).status, 204);
  const full = await post(q, batchOf(10));
  assert.deepEqual([full.status, await full.text()], [429, 'day-all\n']);
  assert.equal(full.headers.get('retry-after'), String(12 * 3600), 'until midnight UTC');
  t.mock.timers.tick(12 * HOUR);
  assert.equal((await post(q, batchOf(10))).status, 204, 'a new UTC day');
  // a session's own day: 1000 batches, spaced so that the minute cap is not the one that stops it
  const r = await platform(t);
  const sid = sidOf(5000);
  for (let i = 0; i < 1000; i++) {
    t.mock.timers.tick(1000);
    const res = await post(r, sample({ sid, seq: i }));
    assert.equal(res.status, 204, 'batch ' + i);
  }
  t.mock.timers.tick(1000);
  const day = await post(r, sample({ sid, seq: 1000 }));
  assert.deepEqual([day.status, await day.text()], [429, 'sid-day\n']);
});

test('front: the object is handed a new request with the text of the batch and no header of the sender', async (t) => {
  const p = await platform(t);
  const body = JSON.stringify(sample());
  const res = await post(p, body, { headers: { 'X-Forwarded-For': '203.0.113.9', 'CF-Connecting-IP': '203.0.113.9', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Secret/1.0', Referer: 'https://site.example/secret#frag', 'Accept-Language': 'fr-CA', Cookie: 'a=b', Authorization: 'Bearer abc' } });
  assert.equal(res.status, 204);
  assert.equal(p.seen.length, 1);
  const forwarded = p.seen[0];
  assert.equal(forwarded.method, 'POST');
  assert.equal(new URL(forwarded.url).pathname, '/e');
  assert.deepEqual(forwarded.headers, ['content-type'], 'the one header the object is given');
  assert.equal(forwarded.text, body, 'the text as it came');
  assert.deepEqual(p.seen.ids, ['id:log'], 'one object holds everything');
  const dump = JSON.stringify(Array.from(p.storage.rows.values()));
  for (const leak of ['203.0.113.9', 'Mozilla', 'Secret/1.0', 'fr-CA', 'Bearer']) assert.equal(dump.includes(leak), false, leak);
});

test('front: if the object cannot be reached the answer is 503, with the CORS headers of an allowed origin', async (t) => {
  const p = await platform(t);
  const env = Object.assign({}, p.env, { OBS: { idFromName: () => 'x', get: () => ({ fetch: async () => { throw new Error('overloaded'); } }) } });
  const res = await worker.fetch(new Request('https://obs.example/e', { method: 'POST', headers: { Origin: SITE, 'Content-Type': 'text/plain' }, body: JSON.stringify(sample()) }), env);
  assert.deepEqual([res.status, await res.text(), res.headers.get('access-control-allow-origin')], [503, 'unavailable\n', SITE]);
  const read = await worker.fetch(new Request('https://obs.example/summary.json?token=' + TOKEN), env);
  assert.deepEqual([read.status, read.headers.get('access-control-allow-origin')], [503, '*']);
});

test('front: with no object bound every route that needs one answers 503, and /healthz still answers', async (t) => {
  const p = await platform(t);
  const env = Object.assign({}, p.env, { OBS: undefined });
  const ingest = await worker.fetch(new Request('https://obs.example/e', { method: 'POST', headers: { Origin: SITE, 'Content-Type': 'text/plain' }, body: JSON.stringify(sample()) }), env);
  assert.deepEqual([ingest.status, ingest.headers.get('access-control-allow-origin')], [503, SITE]);
  for (const path of ['/events.json', '/summary.json']) {
    const res = await worker.fetch(new Request('https://obs.example' + path + '?token=' + TOKEN), env);
    assert.deepEqual([path, res.status, res.headers.get('access-control-allow-origin')], [path, 503, '*']);
  }
  const tail = await worker.fetch(new Request('https://obs.example/tail?token=' + TOKEN, { headers: { Upgrade: 'websocket' } }), env);
  assert.equal(tail.status, 503);
  assert.equal((await worker.fetch(new Request('https://obs.example/healthz'), env)).status, 200);
});

test('the object does not rely on the front: by itself it refuses an oversize or empty body and a bad batch, and takes a good one', async (t) => {
  const p = await platform(t);
  const send = (body) => p.obj.fetch(new Request('https://obs.internal/e', { method: 'POST', body }));
  const over = await send('x'.repeat(32769));
  assert.deepEqual([over.status, await over.text()], [413, 'too large\n']);
  const empty = await send('');
  assert.deepEqual([empty.status, await empty.text()], [400, 'empty\n']);
  assert.equal((await send('{}')).status, 400);
  const ok = await send(JSON.stringify(sample()));
  assert.deepEqual([ok.status, await ok.text()], [204, '']);
  assert.equal(rowKeys(p).length, 1);
});

test('front: the read routes and the tail are 404 unless READ_TOKEN is set and the request carries exactly it', async (t) => {
  const p = await platform(t);
  await post(p, sample());
  for (const path of ['/events.json', '/summary.json']) {
    const bare = await get(p, path);
    assert.equal(bare.status, 404, path + ' without a token');
    assert.equal(await bare.text(), 'not found\n');
    for (const token of ['', 'wrong', TOKEN.slice(0, -1), TOKEN + 'x', TOKEN.toUpperCase(), ' ' + TOKEN, TOKEN + ' ', TOKEN.slice(0, 5), 'null', 'undefined', '0']) {
      assert.equal((await get(p, path + '?token=' + encodeURIComponent(token))).status, 404, path + ' with token ' + JSON.stringify(token));
    }
    assert.equal((await get(p, path + '?token=other&token=' + TOKEN)).status, 404, 'the first token counts');
    assert.equal((await get(p, path + '?token=' + TOKEN + '&token=other')).status, 200, 'and only the first');
    const ok = await get(p, path + '?token=' + TOKEN);
    assert.equal(ok.status, 200, path);
    assert.equal(ok.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.equal(ok.headers.get('access-control-allow-origin'), '*', 'any page may read: the token is the gate');
    assert.equal((await get(p, path)).headers.get('access-control-allow-origin'), '*', 'also on the 404, so that a page can read the status');
  }
  // no token set: closed, even for an empty token that "matches" the empty setting
  for (const READ_TOKEN of ['', undefined, null, 42]) {
    const closed = Object.assign({}, p, { env: Object.assign({}, p.env, { READ_TOKEN }) });
    for (const path of ['/events.json?token=', '/summary.json?token=', '/events.json', '/tail?token=', '/events.json?token=42', '/events.json?token=undefined', '/events.json?token=null']) {
      assert.equal((await get(closed, path, { Upgrade: 'websocket' })).status, 404, String(READ_TOKEN) + ' ' + path);
    }
  }
  assert.equal((await get(p, '/tail?token=wrong', { Upgrade: 'websocket' })).status, 404);
});

test('front: what is forwarded to the object for a read is the path and the filters, not the token, and filters it does not know are dropped', async (t) => {
  const p = await platform(t);
  const sid = sidOf(3);
  await post(p, batchOf(3));
  p.seen.length = 0;
  await get(p, '/events.json?token=' + TOKEN + '&since=&sid=' + sid + '&who=da9u-6qug&limit=5&evil=1&hours=2');
  await get(p, '/summary.json?token=' + TOKEN + '&hours=12&cookie=x');
  assert.equal(p.seen.length, 2);
  const [a, b] = p.seen.map((r) => new URL(r.url));
  assert.deepEqual([a.pathname, Array.from(a.searchParams.keys())], ['/events.json', ['since', 'sid', 'who', 'limit', 'hours']]);
  assert.deepEqual([b.pathname, Array.from(b.searchParams.keys())], ['/summary.json', ['hours']]);
  assert.equal(JSON.stringify(p.seen.map((r) => r.url)).includes(TOKEN), false, 'the token stays at the front');
  assert.deepEqual(p.seen[0].headers, [], 'and no header goes with it');
});

test('/events.json and /summary.json through the front: paging by next, filters, a word for a bad filter, the counts', async (t) => {
  const p = await platform(t);
  const keys = [];
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(1000);
    await post(p, batchOf(i % 2, { who: i === 4 ? null : 'da9u-6qug', seq: i, page: i === 4 ? 'idp' : 'door', events: [{ t: 0, n: 'ui.click' }, { t: 1, n: i % 2 ? 'log' : 'ready' }] }));
    keys.push(rowKeys(p).pop());
  }
  const json = async (path) => { const r = await get(p, path + (path.includes('?') ? '&' : '?') + 'token=' + TOKEN); return [r.status, r.status === 200 ? await r.json() : await word(r)]; };
  const [s1, page1] = await json('/events.json?limit=2');
  assert.equal(s1, 200);
  assert.deepEqual(Object.keys(page1), ['next', 'more', 'batches']);
  assert.deepEqual([page1.batches.map((b) => b.body.seq), page1.next, page1.more], [[0, 1], keys[1], true]);
  const [, page2] = await json('/events.json?limit=2&since=' + keys[1]);
  assert.deepEqual([page2.batches.map((b) => b.body.seq), page2.next], [[2, 3], keys[3]]);
  const [, page3] = await json('/events.json?limit=2&since=' + keys[3]);
  assert.deepEqual([page3.batches.map((b) => b.body.seq), page3.next, page3.more], [[4], keys[4], false]);
  const [, same] = await json('/events.json?since=' + keys[4]);
  assert.deepEqual([same.batches, same.next], [[], keys[4]]);
  const [, byWho] = await json('/events.json?who=da9u-6qug');
  assert.deepEqual(byWho.batches.map((b) => b.body.seq), [0, 1, 2, 3]);
  const [, bySid] = await json('/events.json?sid=' + sidOf(1));
  assert.deepEqual(bySid.batches.map((b) => b.body.seq), [1, 3]);
  assert.deepEqual((await json('/events.json?limit=nope'))[1].batches.length, 5, 'a limit that is not a number is the default');
  assert.deepEqual((await json('/events.json?limit=0'))[1].batches.length, 1, 'and 0 is 1');
  for (const [query, reason] of [['since=nope', 'since'], ['since=b:1:1', 'since'], ['sid=SHORT', 'sid'], ['who=Not+Valid', 'who'], ['who=' + 'a'.repeat(25), 'who']]) {
    assert.deepEqual(await json('/events.json?' + query), [400, reason], query);
  }
  const [, sum] = await json('/summary.json');
  assert.deepEqual(Object.keys(sum), ['hours', 'from', 'to', 'truncated', 'batches', 'events', 'sids', 'who', 'pages', 'names']);
  assert.deepEqual([sum.hours, sum.batches, sum.events, sum.sids, sum.who, sum.truncated], [24, 5, 10, 2, 1, false]);
  assert.deepEqual(sum.pages, { door: 4, idp: 1 });
  assert.deepEqual(sum.names, { 'ui.click': 5, ready: 3, log: 2 });
  assert.deepEqual(Object.keys(sum.names), ['ui.click', 'ready', 'log'], 'by count, then by name');
  assert.deepEqual([sum.to, sum.from], [Date.now(), Date.now() - 24 * HOUR]);
  assert.equal((await json('/summary.json?hours=2'))[1].hours, 2);
  assert.equal((await json('/summary.json?hours=5000'))[1].hours, 168);
  assert.equal((await json('/summary.json?hours=0'))[1].hours, 1);
  assert.equal((await json('/summary.json?hours=abc'))[1].hours, 24);
  t.mock.timers.tick(2 * HOUR);
  assert.equal((await json('/summary.json?hours=1'))[1].batches, 0, 'older than the window');
  assert.equal((await json('/summary.json?hours=3'))[1].batches, 5);
});

// ---------------------------------------------------------------------------------------------- the stored row and the masks

test('a batch is one row under b:<ms>:<counter>; the row is { at, sid, page, who, site, build, n, body } and everything in it is masked', async (t) => {
  const p = await platform(t);
  const dirty = sample({ events: [{ t: 1, n: 'log', m: 'peer 203.0.113.9:5555 from [2001:db8::7]:1234 via abcd-efgh-jkmn at https://site.example/open#secretkey' }, { t: 2, n: 'ui.click', text: '10.1.1.1', hash: 'ab12'.repeat(10) }] });
  assert.equal((await post(p, dirty)).status, 204);
  assert.equal((await post(p, sample({ seq: 8 }))).status, 204);
  const [first, second] = rowKeys(p);
  assert.deepEqual([first, second], [batchKey(T0, 0), batchKey(T0, 1)]);
  assert.match(first, /^b:\d{15}:\d{4}$/);
  const row = p.storage.rows.get(first);
  assert.deepEqual(Object.keys(row), ['at', 'sid', 'page', 'who', 'site', 'build', 'n', 'body']);
  assert.deepEqual([row.at, row.sid, row.page, row.who, row.site, row.build, row.n], [T0, SID, 'door', 'da9u-6qug', 'd680ff36', 'bbcb82098cda', 2]);
  assert.equal(row.body.events[0].m, 'peer ' + MASK + ' from ' + MASK + ' via abcd at https://site.example/open#');
  assert.deepEqual([row.body.events[1].text, row.body.events[1].hash], [MASK, 'ab12ab12']);
  const dump = JSON.stringify(Array.from(p.storage.rows.values()));
  for (const leak of ['203.0.113.9', '5555', '2001:db8', 'efgh', 'jkmn', 'secretkey', '10.1.1.1']) assert.equal(dump.includes(leak), false, leak);
  assert.equal(p.storage.ops.puts.filter((k) => k.startsWith(KEY_PREFIX)).length, 2, 'one row per batch');
  assert.deepEqual(p.storage.ops.puts.filter((k) => k === META_KEY).length, 1, 'and the counter row with the first batch of the day only');
});

// ---------------------------------------------------------------------------------------------- the reporters against the Worker

test('contract: the batches the loader reporter and the identity page reporter write are accepted, and the Worker stores what they sent, masked once more', async (t) => {
  const p = await platform(t);
  const exercised = [];
  const maskedMore = [];
  for (const [rel, page] of [['../../src/loader/obs.js', 'door'], ['../../src/idp/obs-client.js', 'idp']]) {
    let mod = null;
    try { mod = await import(rel); } catch (_) { mod = null; }
    if (!mod || typeof mod.createReporter !== 'function') continue;
    const sent = [];
    let step = 0;
    const reporter = mod.createReporter({
      endpoint: 'https://obs.example', page, build: 'bbcb82098cda', loader: '0.3.0', site: 'd680ff36',
      now: () => Date.now() + (step += 7), random: () => ((step += 1) * 0.6180339887) % 1, send: (url, text) => { sent.push([url, text]); return true; },
    });
    if (typeof reporter.setWho === 'function') { reporter.setWho('da9u-6qug'); reporter.setNet({ type: 'cellular', effectiveType: '4g' }); }
    reporter.allow(true);
    reporter.event('boot.start', { t0ms: 12, dev: false, degraded: false, cspKind: 'meta' });
    reporter.event('gate.shown', { kind: 'consent', host: 'tracker.example' });
    reporter.event('ui.click', { role: 'continue', text: 'Share and load', trusted: true, type: 'click' });
    reporter.event('log', { m: 'tracker wss://tracker.example:443/announce open; peer 203.0.113.9:5555 and [2001:db8::7]:1234; code abcd-efgh-jkmn; https://site.example/open#secretkey' });
    reporter.event('peer.ice', { kind: 'host', ice: 'connected', gathering: 'complete', nothing: null, count: 3, ratio: 0.5 });
    reporter.event('apps.view', { view: 'chat' });
    reporter.flush('final');
    reporter.stop();
    assert.ok(sent.length >= 1, rel + ' sent a batch');
    for (const [url, text] of sent) {
      assert.equal(url, 'https://obs.example/e');
      const res = await post(p, text);
      assert.equal(res.status, 204, rel + ' was refused: ' + (await res.text()) + ' for ' + text.slice(0, 200));
    }
    const wire = sent.map(([, text]) => JSON.parse(text));
    const stored = rowKeys(p).map((k) => p.storage.rows.get(k)).filter((r) => r.body.page === page);
    assert.equal(stored.length, wire.length, rel + ': one row per batch');
    stored.forEach((row, i) => {
      assert.deepEqual(row.body.events.map((e) => e.n), wire[i].events.map((e) => e.n), rel + ': the same events');
      assert.deepEqual(row.body.sid, wire[i].sid);
      for (const [j, ev] of row.body.events.entries()) {
        for (const [k, v] of Object.entries(wire[i].events[j])) {
          const expected = typeof v === 'string' ? maskString(v) : v;
          assert.deepEqual([k, ev[k]], [k, expected], rel + ': what is stored is the Worker mask of what the reporter wrote');
          if (expected !== v) maskedMore.push(rel + ' ' + k + ': ' + JSON.stringify(v));
        }
      }
    });
    const dump = JSON.stringify(stored);
    for (const leak of ['203.0.113.9', '5555', '2001:db8', 'efgh', 'jkmn', 'secretkey']) assert.equal(dump.includes(leak), false, rel + ': ' + leak);
    exercised.push(rel);
  }
  t.diagnostic('reporters held against the Worker: ' + (exercised.join(', ') || 'none in the tree'));
  for (const line of maskedMore) t.diagnostic('the Worker masked more than the reporter did: ' + line);
  assert.deepEqual(maskedMore.filter((l) => l.includes('src/loader/obs.js')), [], 'the loader reporter and the Worker mask these events alike');
  if (!exercised.length) t.skip('no reporter is in the tree');
});

// ---------------------------------------------------------------------------------------------- the tail

test('tail: a socket gets a hello with the count of today, then one frame per stored batch (the row as JSON); pings are ignored; a closing socket does not stop the others', async (t) => {
  const p = await platform(t);
  await post(p, batchOf(1));
  const a = fakeWs('a');
  await p.obj.accept(a);
  assert.deepEqual(a.sent, [{ type: 'hello', batches: 1 }]);
  assert.deepEqual(a.attachment, { at: T0 });
  assert.deepEqual(p.ctx.accepted, [a]);
  assert.equal(p.ctx.alarmAt(), T0 + 10 * MIN, 'a sweep is set for the socket (and for the row)');
  const res = await post(p, batchOf(2));
  assert.equal(res.status, 204);
  assert.equal(a.sent.length, 2);
  const stored = p.storage.rows.get(rowKeys(p)[1]);
  assert.deepEqual(a.sent[1], stored, 'the frame is the stored row');
  assert.deepEqual(Object.keys(a.sent[1]), ['at', 'sid', 'page', 'who', 'site', 'build', 'n', 'body']);
  const b = fakeWs('b');
  b.throwOnSend = true;
  p.ctx.sockets.push(b);
  const c = fakeWs('c');
  await p.obj.accept(c);
  assert.deepEqual(c.sent, [{ type: 'hello', batches: 2 }]);
  assert.equal((await post(p, batchOf(3))).status, 204, 'a socket that cannot be written to does not fail the batch');
  assert.deepEqual([a.sent.length, c.sent.length, b.sent.length], [3, 2, 0]);
  const before = a.sent.length;
  await p.obj.webSocketMessage(a, 'ping');
  await p.obj.webSocketMessage(a, JSON.stringify({ type: 'ping' }));
  await p.obj.webSocketMessage(a, new ArrayBuffer(8));
  await p.obj.webSocketMessage(a, 'x'.repeat(100000));
  assert.deepEqual([a.sent.length, a.closed], [before, null], 'a message from the operator is ignored: no reply, no close');
  // a refused batch is not pushed
  assert.equal((await post(p, '{')).status, 400);
  assert.equal(a.sent.length, before);
  // closing: the object finishes the close handshake with the code it was given, or 1000 for a code that cannot be sent
  await p.obj.webSocketClose(a, 1001);
  assert.deepEqual(a.closed, { code: 1001, reason: 'closed' });
  await p.obj.webSocketClose(c, 1006);
  assert.deepEqual(c.closed, { code: 1000, reason: 'closed' });
  await p.obj.webSocketError(c);
  assert.equal(c.closed.code, 1011);
});

test('tail: the object refuses a plain GET with 426 and a 17th socket with 429; nothing else is in the way', async (t) => {
  const p = await platform(t);
  const plain = await p.obj.fetch(new Request('https://obs.internal/tail'));
  assert.equal(plain.status, 426);
  assert.equal(plain.headers.get('upgrade'), 'websocket');
  for (let i = 0; i < 16; i++) await p.obj.accept(fakeWs('s' + i));
  const full = await p.obj.fetch(new Request('https://obs.internal/tail', { headers: { Upgrade: 'websocket' } }));
  assert.deepEqual([full.status, await full.text()], [429, 'too many tail sockets\n']);
  assert.equal(p.ctx.accepted.length, 16);
  assert.equal((await p.obj.fetch(new Request('https://obs.internal/other'))).status, 404);
  assert.equal((await p.obj.fetch(new Request('https://obs.internal/e'))).status, 404, 'GET /e');
  assert.equal((await p.obj.fetch(new Request('https://obs.internal/tail', { method: 'POST', body: 'x' }))).status, 404);
});

test('tail: through the front, an upgrade with the token is handed to the object, which accepts the server end of a pair and sends the hello (the pair is faked)', async (t) => {
  const p = await platform(t);
  await post(p, sample());
  const RealResponse = globalThis.Response;
  const pairs = [];
  globalThis.WebSocketPair = class { constructor() { this[0] = fakeWs('client'); this[1] = fakeWs('server'); pairs.push(this); } };
  // Node refuses a Response with status 101; the Workers runtime has one that carries the client end
  globalThis.Response = class extends RealResponse {
    constructor(body, init) {
      if (init && init.status === 101) { super(null, { status: 200 }); Object.defineProperty(this, 'status', { value: 101 }); this.webSocket = init.webSocket; } else super(body, init);
    }
  };
  try {
    const res = await get(p, '/tail?token=' + TOKEN, { Upgrade: 'websocket' });
    assert.equal(res.status, 101);
    assert.equal(pairs.length, 1);
    assert.equal(res.webSocket, pairs[0][0], 'the client end goes back to the visitor of the tail');
    assert.deepEqual(p.ctx.accepted, [pairs[0][1]], 'the server end is accepted with the Hibernation API');
    assert.deepEqual(pairs[0][1].sent, [{ type: 'hello', batches: 1 }]);
    assert.deepEqual(pairs[0][1].attachment, { at: T0 });
    assert.equal((await post(p, batchOf(9))).status, 204);
    assert.equal(pairs[0][1].sent.length, 2);
    assert.equal((await get(p, '/tail?token=nope', { Upgrade: 'websocket' })).status, 404);
    assert.equal(pairs.length, 1, 'a wrong token never gets as far as a pair');
  } finally {
    globalThis.Response = RealResponse;
    delete globalThis.WebSocketPair;
  }
});

// ---------------------------------------------------------------------------------------------- the alarm and the wake

test('alarm: one sweep is pending while there are rows or sockets, set by the first batch and not moved by the next ones; it sleeps when nothing is left', async (t) => {
  const p = await platform(t, { objectEnv: { RETENTION_DAYS: '2' } });
  assert.equal(p.ctx.alarmAt(), null, 'nothing to sweep yet');
  await post(p, batchOf(1));
  assert.equal(p.ctx.alarmAt(), T0 + 10 * MIN);
  t.mock.timers.tick(MIN);
  await post(p, batchOf(2));
  assert.equal(p.ctx.alarmAt(), T0 + 10 * MIN, 'a pending alarm stays where it is');
  // the sweep runs: nothing is old yet, the rows are still there, so the next sweep is 10 minutes on
  t.mock.timers.setTime(T0 + 10 * MIN);
  await fire(p);
  assert.equal(rowKeys(p).length, 2);
  assert.equal(p.ctx.alarmAt(), T0 + 20 * MIN);
  // two days and a minute on: the first row (T0) is older than the 2 day retention, the second (T0 + 1 min) is exactly as old: kept until the next minute
  t.mock.timers.setTime(T0 + 2 * DAY + MIN);
  await fire(p);
  assert.deepEqual(rowKeys(p).map((k) => parseBatchKey(k).ms), [T0 + MIN], 'the cutoff is exclusive');
  assert.equal(p.ctx.alarmAt(), T0 + 2 * DAY + 11 * MIN, 'a row is left, so the sweep goes on');
  t.mock.timers.setTime(T0 + 2 * DAY + 11 * MIN);
  await fire(p);
  assert.deepEqual(rowKeys(p), []);
  assert.equal(p.ctx.alarmAt(), null, 'no rows and no sockets: the object sleeps without an alarm');
  assert.deepEqual(p.storage.rows.get(META_KEY), { d: Math.floor((T0 + 2 * DAY + 11 * MIN) / DAY), n: 0, r: 0 });
  await post(p, batchOf(3));
  assert.equal(p.ctx.alarmAt(), T0 + 2 * DAY + 21 * MIN, 'the next batch sets it again');
});

test('alarm: tail sockets open for 12 hours are closed, younger ones stay and keep the sweep going', async (t) => {
  const p = await platform(t);
  const old = fakeWs('old');
  await p.obj.accept(old);
  t.mock.timers.setTime(T0 + 6 * HOUR);
  const young = fakeWs('young');
  await p.obj.accept(young);
  t.mock.timers.setTime(T0 + 12 * HOUR - 1);
  await fire(p);
  assert.deepEqual([old.closed, young.closed], [null, null], 'one millisecond short of 12 hours');
  assert.equal(p.ctx.alarmAt(), T0 + 12 * HOUR - 1 + 10 * MIN);
  t.mock.timers.setTime(T0 + 12 * HOUR);
  await fire(p);
  assert.deepEqual(old.closed, { code: 1001, reason: 'idle' });
  assert.equal(young.closed, null);
  assert.equal(p.ctx.alarmAt(), T0 + 12 * HOUR + 10 * MIN, 'a socket is open: sweep again');
  t.mock.timers.setTime(T0 + 18 * HOUR);
  const noAttachment = fakeWs('lost');
  p.ctx.sockets.push(noAttachment);
  await fire(p);
  assert.deepEqual(young.closed, { code: 1001, reason: 'idle' });
  assert.deepEqual(noAttachment.closed, { code: 1001, reason: 'idle' }, 'a socket that kept no time is treated as old');
  assert.equal(p.ctx.alarmAt(), null, 'every socket was closed by this sweep and there are no rows: the object sleeps without an alarm');
});

test('alarm: at most 50000 rows are kept (here 3), the oldest go first; a backlog is taken in rounds, with the next sweep one second away until it is done', async (t) => {
  const p = await platform(t);
  p.obj.log.limits.maxRows = 3;
  const keys = [];
  for (let i = 0; i < 7; i++) {
    t.mock.timers.tick(10);
    await post(p, batchOf(i));
    keys.push(rowKeys(p).pop());
  }
  await fire(p);
  assert.deepEqual(rowKeys(p), keys.slice(4));
  assert.equal(p.obj.log.rowCount(), 3);
  assert.equal(p.ctx.alarmAt(), Date.now() + 10 * MIN);
  const q = await platform(t, { objectEnv: { RETENTION_DAYS: '1' } });
  q.obj.log.limits.pageRows = 2;
  q.obj.log.limits.sweepRounds = 2;
  for (let i = 0; i < 9; i++) {
    t.mock.timers.setTime(T0 - 3 * DAY + i);
    await post(q, batchOf(i));
  }
  t.mock.timers.setTime(T0);
  await fire(q);
  assert.equal(rowKeys(q).length, 5);
  assert.equal(q.ctx.alarmAt(), T0 + 1000, 'more to delete: the next sweep is soon');
  t.mock.timers.setTime(T0 + 1000);
  await fire(q);
  assert.equal(rowKeys(q).length, 1);
  assert.equal(q.ctx.alarmAt(), T0 + 2000);
  t.mock.timers.setTime(T0 + 2000);
  await fire(q);
  assert.equal(rowKeys(q).length, 0);
  assert.equal(q.ctx.alarmAt(), null);
  assert.ok(q.storage.ops.deletes.every((d) => Array.isArray(d) && d.length <= 2), 'deletes are in the pages the sweep reads');
});

test('wake: a rebuilt object knows its rows and the count of the day to within 19 batches, keeps the alarm it finds, sets one when rows have none, and hands the tail a hello that says so', async (t) => {
  const p = await platform(t);
  for (let i = 0; i < 25; i++) await post(p, batchOf(i));
  const woken = new ObsLog(fakeCtx([], p.storage), {});
  await woken.ready;
  assert.deepEqual([woken.log.todayCount(), woken.log.rowCount()], [20, 20], 'the counter row was last written with the 20th batch');
  assert.equal(woken.alarmAt, T0 + 10 * MIN, 'the alarm set before is the alarm of the rebuilt object');
  const ws = fakeWs('tail');
  await woken.accept(ws);
  assert.deepEqual(ws.sent, [{ type: 'hello', batches: 20 }]);
  // rows but no alarm (a deployment cleared it): wake sets one
  await p.storage.setAlarm(null);
  const second = new ObsLog(fakeCtx([], p.storage), {});
  await second.ready;
  assert.equal(second.alarmAt, T0 + 10 * MIN);
  assert.equal(p.storage.alarmAt(), T0 + 10 * MIN);
  // sockets but no rows: wake sets one too; neither: none
  const sockets = new ObsLog(fakeCtx([fakeWs('s')], fakeStorage()), {});
  await sockets.ready;
  assert.equal(sockets.alarmAt, T0 + 10 * MIN);
  const empty = fakeCtx([], fakeStorage());
  const nothing = new ObsLog(empty, {});
  await nothing.ready;
  assert.deepEqual([nothing.alarmAt, empty.alarmAt()], [null, null]);
  // a day later the count starts again, the rows stay until the sweep
  t.mock.timers.setTime(T0 + DAY);
  const next = new ObsLog(fakeCtx([], p.storage), {});
  await next.ready;
  assert.deepEqual([next.log.todayCount(), next.log.rowCount()], [0, 20]);
});

test('vars: RETENTION_DAYS is held between 1 and 30, MAX_BATCHES_PER_DAY between 1 and 200000, and anything that is not a whole number is the default', async (t) => {
  const limits = async (objectEnv) => { const p = await platform(t, { objectEnv }); return [p.obj.log.limits.retentionDays, p.obj.log.limits.maxBatchesPerDay]; };
  assert.deepEqual(await limits({}), [7, 20000]);
  assert.deepEqual(await limits({ RETENTION_DAYS: '3', MAX_BATCHES_PER_DAY: '500' }), [3, 500]);
  assert.deepEqual(await limits({ RETENTION_DAYS: '0', MAX_BATCHES_PER_DAY: '0' }), [1, 1]);
  assert.deepEqual(await limits({ RETENTION_DAYS: '365', MAX_BATCHES_PER_DAY: '99999999' }), [30, 200000]);
  assert.deepEqual(await limits({ RETENTION_DAYS: 'week', MAX_BATCHES_PER_DAY: '-5' }), [7, 20000]);
  assert.deepEqual(await limits({ RETENTION_DAYS: '', MAX_BATCHES_PER_DAY: '1.5' }), [7, 20000]);
  assert.deepEqual(await limits({ RETENTION_DAYS: ' 2 ', MAX_BATCHES_PER_DAY: '1e3' }), [2, 20000]);
});

// ---------------------------------------------------------------------------------------------- what the Worker never touches

test('the Worker reads no header of the sender but Origin, Content-Type, Content-Length and Upgrade, and never the platform request properties (a spy over every route)', async (t) => {
  const p = await platform(t);
  await post(p, sample());
  const read = new Set();
  const props = new Set();
  const spy = (req) => new Proxy(req, {
    get(target, prop) {
      if (prop === 'headers') return { get: (n) => { read.add(String(n).toLowerCase()); return target.headers.get(n); }, has: (n) => { read.add(String(n).toLowerCase()); return target.headers.has(n); } };
      props.add(String(prop));
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const sender = { Origin: SITE, 'Content-Type': 'text/plain', 'X-Forwarded-For': '203.0.113.9', 'CF-Connecting-IP': '203.0.113.9', 'User-Agent': 'x', Cookie: 'a=b', Referer: 'https://x/', Authorization: 'x', 'Accept-Language': 'fr', 'Sec-Fetch-Site': 'cross-site' };
  const fetches = [
    ['POST', '/e', JSON.stringify(batchOf(40))], ['POST', '/e', '{'], ['OPTIONS', '/e', undefined], ['GET', '/healthz', undefined], ['GET', '/nothing', undefined],
    ['GET', '/events.json?token=' + TOKEN, undefined], ['GET', '/summary.json?token=' + TOKEN, undefined], ['GET', '/tail?token=' + TOKEN, undefined],
  ];
  for (const [method, path, body] of fetches) {
    const req = new Request('https://obs.example' + path, { method, headers: sender, body });
    await worker.fetch(spy(req), p.env);
  }
  // the object, called with a request that carries every header it could want
  for (const [method, path, body] of [['POST', '/e', JSON.stringify(batchOf(41))], ['GET', '/events.json', undefined], ['GET', '/summary.json', undefined], ['GET', '/tail', undefined]]) {
    await p.obj.fetch(spy(new Request('https://obs.internal' + path, { method, headers: sender, body })));
  }
  const allowed = new Set(['origin', 'content-type', 'content-length', 'upgrade']);
  assert.deepEqual(Array.from(read).filter((n) => !allowed.has(n)), [], 'headers read: ' + Array.from(read).join(', '));
  assert.ok(read.has('origin') && read.has('content-type') && read.has('upgrade'), 'the spy saw the reads it should: ' + Array.from(read).join(', '));
  assert.equal(props.has('cf'), false, 'request.cf is never touched');
  for (const prop of ['cf', 'signal', 'referrer', 'mode', 'credentials', 'integrity']) assert.equal(props.has(prop), false, prop);
});

// A scan of the source, for the privacy rule of the endpoint: no client address header, no request.cf, no console, in code (comments may name them).
const FORBIDDEN = [
  [/cf-connecting-ip/i, 'CF-Connecting-IP'], [/cf-connecting-ipv6/i, 'CF-Connecting-IPv6'], [/x-forwarded-for/i, 'X-Forwarded-For'], [/x-real-ip/i, 'X-Real-IP'], [/true-client-ip/i, 'True-Client-IP'],
  [/['"`]forwarded['"`]/i, 'Forwarded'], [/request\.cf\b/, 'request.cf'], [/\.cf\b/, '.cf'], [/\bcf\s*[:}=]/, 'cf'], [/['"`]cf-/i, 'a cf- header'], [/\bconsole\b/, 'console'],
];
const SOURCES = ['worker.js', 'obs-core.js', 'pages/public/_worker.js'];

/** code(text) -> the text without comments: block comments, whole-line comments and a trailing comment (a // that has a space before and after it). */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((line) => (/^\s*\/\//.test(line) ? '' : line.replace(/\s\/\/\s.*$/, ''))).join('\n');
}
const read = (rel) => readFileSync(join(DIR, rel), 'utf8');
function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

test('source scan: no client address header, no request.cf, no console in worker.js, obs-core.js and the Pages front (the scan itself is checked on samples)', () => {
  const sample1 = "const ip = request.headers.get('CF-Connecting-IP');\nconst c = request.cf;\nconsole.log(1);\nconst h = req.headers.get('x-forwarded-for'); // fine?\n";
  const flagged = (text) => FORBIDDEN.filter(([re]) => re.test(code(text))).map(([, name]) => name);
  assert.deepEqual(flagged(sample1), ['CF-Connecting-IP', 'X-Forwarded-For', 'request.cf', '.cf', 'a cf- header', 'console']);
  assert.deepEqual(flagged("// reads no CF-Connecting-IP and no request.cf\nconst a = 1; // never X-Forwarded-For and no console.log\n/* console.log\n  request.cf */\nfoo('https://x.example/a');\n"), [], 'comments, and a // in a URL, are not code');
  assert.deepEqual(flagged("const url = 'https://x.example/' + request.cf;\n"), ['request.cf', '.cf'], 'a // inside a string does not hide what follows it on the line');
  for (const rel of SOURCES) {
    const body = code(read(rel));
    assert.ok(body.length > 500, rel + ' has code');
    assert.deepEqual(FORBIDDEN.filter(([re]) => re.test(body)).map(([, name]) => name), [], rel);
    // the header names the code reads, and no way to walk every header
    const names = Array.from(body.matchAll(/headers\.(?:get|has)\(\s*(['"])([^'"]+)\1/g)).map((m) => m[2].toLowerCase());
    for (const n of names) assert.ok(['origin', 'content-type', 'content-length', 'upgrade', 'retry-after'].includes(n), rel + ' reads the header ' + n);
    assert.equal(/headers\.(?:entries|keys|values|forEach)\b|\.\.\.\s*[\w.]*headers\b|Object\.(?:fromEntries|entries)\([^)]*headers|Symbol\.iterator/.test(body), false, rel + ' walks the headers');
    assert.equal(/\bwaitUntil\b|\bfetch\(\s*['"`]http|\bcaches\b|\bKV\b|\bsendBeacon\b/.test(body), false, rel + ' reaches out');
  }
  assert.ok(code(read('worker.js')).includes("headers.get('Upgrade')"));
});

test('source scan: everything under deploy/obs-worker is pure ASCII; no em or en dash, no banned word, no presence word the rules keep out, straight quotes (the wording rules of the project)', () => {
  const dash = [String.fromCharCode(0x2014), String.fromCharCode(0x2013)];
  // built from parts, so that this file never holds the words it looks for
  const presence = 'on' + 'line'; // presence reads "Connected to you now"
  const banned = ['block' + 'chain', 'server' + 'less', 'unstop' + 'pable', 'censorship' + '-resistant', 'production' + '-ready', 'fully ' + 'decentralized', 'sub' + '-second'];
  const files = filesUnder(DIR);
  assert.ok(files.length >= 6, files.map((f) => relative(DIR, f)).join(', '));
  for (const file of files) {
    const rel = relative(DIR, file);
    const buf = readFileSync(file);
    const bad = Array.from(buf).findIndex((b) => b > 127);
    assert.equal(bad, -1, rel + ' has a byte above 127 at ' + bad);
    const text = buf.toString('utf8');
    for (const d of dash) assert.equal(text.includes(d), false, rel + ' has a dash that is not a hyphen');
    for (const w of banned) assert.equal(text.toLowerCase().includes(w), false, rel + ' has the word ' + w);
    assert.equal(new RegExp('\\b' + presence + '\\b', 'i').test(text), false, rel + ' uses the word ' + presence);
    assert.equal(/[\u2018\u2019\u201c\u201d]/.test(text), false, rel + ' has curly quotes');
    assert.equal(/\t/.test(text), false, rel + ' has a tab');
    assert.equal(/[ \t]+$/m.test(text) && !rel.endsWith('.md'), false, rel + ' has trailing spaces');
    assert.equal(text.endsWith('\n'), true, rel + ' ends with a newline');
  }
  for (const rel of ['worker.js', 'obs-core.js', 'pages/public/_worker.js']) {
    // a statement that starts on a line ends with a semicolon, or the line goes on (an opening bracket, a comma, an operator)
    const lines = code(read(rel)).split('\n');
    const bareEnds = lines.map((l, i) => [l.trim(), i + 1]).filter(([l]) => /^(?:const|let|var|return|throw|await|import)\b/.test(l) && !/[;{(\[,:+&|?=>]$/.test(l));
    assert.deepEqual(bareEnds.map(([l, n]) => rel + ':' + n + ': ' + l.slice(0, 60)), [], rel + ' uses semicolons');
  }
});

test('the Pages front is a copy of the front of worker.js, line for line, and imports nothing; the object class is not in it', () => {
  const worker = read('worker.js');
  const begin = worker.indexOf('// ===== front: begin');
  const end = worker.indexOf('// ===== front: end =====');
  assert.ok(begin > 0 && end > begin);
  const block = worker.slice(begin, end + '// ===== front: end ====='.length);
  const copy = read('pages/public/_worker.js');
  assert.ok(copy.includes(block), 'pages/public/_worker.js must hold the lines between the front markers of worker.js unchanged; copy them again');
  assert.equal(copy.slice(copy.indexOf(block) + block.length).trim(), '', 'nothing follows the block');
  const head = copy.slice(0, copy.indexOf(block));
  assert.ok(head.split('\n').filter(Boolean).every((l) => l.startsWith('//')), 'only comments come before it');
  const body = code(copy);
  assert.equal(/^\s*import\b|\bimport\s*\(|\brequire\(/m.test(body), false, 'no import');
  assert.equal(/\bclass\b/.test(body), false, 'a Pages project cannot define the object class');
  assert.equal((body.match(/export default/g) || []).length, 1);
  assert.equal(/^export (?!default)/m.test(body), false, 'no named export beside the default one');
  // the front of worker.js does not name anything the copy would lack: the names it uses outside the block are the object's own
  const frontBody = code(block);
  for (const name of ['createObsLog', 'parseEventsQuery', 'parseSummaryQuery', 'LIMITS', 'ObsLog', 'SWEEP_MS', 'MAX_TAILS', 'intVar']) assert.equal(new RegExp('\\b' + name + '\\b').test(frontBody), false, 'the front uses ' + name);
  assert.equal(/\bjson\(/.test(frontBody), false, 'the front uses the json() helper of the object part');
  // and the constant the front enforces is the one the object enforces
  assert.equal(Number(/const MAX_BODY_BYTES = (\d+);/.exec(frontBody)[1]), LIMITS.maxBodyBytes);
});

test('README.md states the numbers the code enforces', () => {
  const md = read('README.md');
  const workerSource = read('worker.js');
  const fromSource = (re) => Number(re.exec(workerSource)[1]);
  assert.equal(fromSource(/const MAX_TAILS = (\d+);/), 16);
  assert.ok(/const TAIL_MAX_MS = 12 \* 60 \* 60 \* 1000;/.test(workerSource) && /const SWEEP_MS = 10 \* 60 \* 1000;/.test(workerSource));
  assert.ok(/const PREFLIGHT_MAX_AGE_S = 600;/.test(workerSource));
  const thousands = (n) => n.toLocaleString('en-US');
  const phrases = [
    LIMITS.maxBodyBytes + ' bytes', LIMITS.perSidPerMinute + ' in a sliding minute', LIMITS.perSidPerDay + ' in a UTC day', thousands(LIMITS.maxBatchesPerDay), thousands(LIMITS.maxRows),
    LIMITS.retentionDays + ' days', LIMITS.maxField + ' characters', LIMITS.maxEvents + ' and ' + LIMITS.maxEventKeys, LIMITS.eventsMax + ' rows returned, ' + LIMITS.eventsScanRows + ' rows read',
    LIMITS.summaryHoursMax + ' hours, ' + LIMITS.summaryScanRows + ' rows', 'the ' + LIMITS.summaryNames + ' names', 'every ' + LIMITS.saveEvery + 'th', LIMITS.eventsDefault + ' of them by default',
    '(`max-age` 600)', '16 sockets at most', '12 hours', 'every 10 minutes',
  ];
  for (const phrase of phrases) assert.ok(md.includes(phrase), 'the README does not say "' + phrase + '"');
  assert.ok(md.includes('first batch of a UTC day, with every ' + LIMITS.saveEvery + 'th'), 'the counter row rule');
});

test('wrangler.jsonc and pages/wrangler.toml: the names, the binding, the migration and the vars match the code', () => {
  const jsonc = read('wrangler.jsonc');
  const cfg = JSON.parse(jsonc.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'));
  assert.equal(cfg.name, 'felinar-obs-do');
  assert.equal(cfg.main, 'worker.js');
  assert.equal(cfg.workers_dev, false);
  assert.match(cfg.compatibility_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(cfg.durable_objects.bindings, [{ name: 'OBS', class_name: 'ObsLog' }]);
  assert.deepEqual(cfg.migrations, [{ tag: 'v1', new_sqlite_classes: ['ObsLog'] }]);
  assert.deepEqual(cfg.observability, { enabled: false });
  assert.deepEqual(cfg.vars, { ALLOW_ORIGINS: '', READ_TOKEN: '', RETENTION_DAYS: '7', MAX_BATCHES_PER_DAY: '20000' });
  assert.equal(cfg.routes, undefined, 'no route: the only way in is the binding of the Pages front');
  // every var the code reads is declared, and every declared var is read
  const used = new Set();
  for (const rel of ['worker.js', 'obs-core.js']) for (const m of code(read(rel)).matchAll(/\benv\.([A-Z][A-Z_]+)\b/g)) used.add(m[1]);
  used.delete('OBS');
  assert.deepEqual(Array.from(used).sort(), Object.keys(cfg.vars).sort());
  assert.ok(/export class ObsLog\b/.test(read('worker.js')));
  assert.ok(/export default \{/.test(read('worker.js')));
  assert.equal(LIMITS.retentionDays, Number(cfg.vars.RETENTION_DAYS));
  assert.equal(LIMITS.maxBatchesPerDay, Number(cfg.vars.MAX_BATCHES_PER_DAY));
  const toml = read('pages/wrangler.toml');
  const lines = toml.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  assert.deepEqual(lines, ['name = "felinar-obs"', 'pages_build_output_dir = "./public"', 'compatibility_date = "' + cfg.compatibility_date + '"', '[vars]', 'ALLOW_ORIGINS = ""', '[[durable_objects.bindings]]', 'name = "OBS"', 'class_name = "ObsLog"', 'script_name = "' + cfg.name + '"']);
  assert.equal(/READ_TOKEN\s*=/.test(toml), false, 'the token is a secret of the project, never a var in a file');
});

test('README.md: the deploy steps, the limits of the Free plan, the privacy section and the vars are in it, and its relative links point at files that exist', () => {
  const md = read('README.md');
  for (const heading of ['## What you need', '## Start it', '## The routes', '## The limits and the Free plan', '## Privacy', '## What was tested']) assert.ok(md.includes('\n' + heading), heading);
  for (const must of [
    'ALLOW_ORIGINS', 'READ_TOKEN', 'RETENTION_DAYS', 'MAX_BATCHES_PER_DAY', 'felinar-obs-do', 'felinar-obs', 'wrangler pages deploy', 'wrangler deploy', 'outside the repository',
    '100,000', '20,000', '50,000', '13,000', '5 GB', '7 days', '32768', '60 batches', '1000', '12 hours', '/events.json', '/summary.json', '/tail', '/healthz',
    'CF-Connecting-IP', 'X-Forwarded-For', 'request.cf', 'never logs', 'Origin',
  ]) assert.ok(md.includes(must), 'the README does not say ' + must);
  for (const m of md.replace(/^```[\s\S]*?^```/gm, '').matchAll(/\]\(([^)\s#]+)(?:#[^)\s]*)?\)/g)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(m[1])) continue;
    assert.doesNotThrow(() => readFileSync(join(DIR, m[1])), 'the link ' + m[1] + ' points at nothing');
  }
});

// ---------------------------------------------------------------------------------------------- the checks of the fix lane (verify-adversary F2, F9, F11)

test('front: a READ_TOKEN of fewer than 24 characters is taken for none (the reads and the tail stay closed); one of 24 opens them', async (t) => {
  for (const weak of ['x', '   ', '1234', 'a'.repeat(23), TOKEN.slice(0, 23)]) {
    const p = await platform(t, { env: { READ_TOKEN: weak } });
    await post(p, sample());
    for (const path of ['/events.json', '/summary.json']) assert.equal((await get(p, path + '?token=' + encodeURIComponent(weak))).status, 404, JSON.stringify(weak) + ' ' + path);
    assert.equal((await get(p, '/tail?token=' + encodeURIComponent(weak), { Upgrade: 'websocket' })).status, 404, JSON.stringify(weak) + ' tail');
    assert.equal((await get(p, '/tail?token=' + encodeURIComponent(weak))).status, 404, 'not even the 426');
  }
  const exact = 'k'.repeat(24);
  const p = await platform(t, { env: { READ_TOKEN: exact } });
  await post(p, sample());
  for (const path of ['/events.json', '/summary.json']) assert.equal((await get(p, path + '?token=' + exact)).status, 200, path);
  assert.equal((await get(p, '/events.json?token=' + exact.slice(1))).status, 404);
  assert.equal((await get(p, '/tail?token=' + exact)).status, 426);
  // the front the Pages project runs is the same text, so the same rule (the copy is held to this file by another test)
  assert.match(read('pages/public/_worker.js'), /const MIN_TOKEN_CHARS = 24;/);
});

test('front: a batch sent again (the same session, number and text) is answered 204 and is not stored, counted or pushed to the tail a second time; the front does not read the batch to tell', async (t) => {
  const p = await platform(t);
  const ws = fakeWs('tail');
  await p.obj.accept(ws);
  const body = JSON.stringify(sample({ seq: 3 }));
  const a = await post(p, body);
  const b = await post(p, body);
  assert.deepEqual([a.status, b.status, a.headers.get('access-control-allow-origin'), b.headers.get('access-control-allow-origin')], [204, 204, SITE, SITE]);
  assert.equal(rowKeys(p).length, 1);
  assert.deepEqual(ws.sent.map((f) => f.type || f.body.seq), ['hello', 3], 'one frame for the batch');
  const summary = await (await get(p, '/summary.json?token=' + TOKEN)).json();
  assert.deepEqual([summary.batches, summary.events], [1, 2], 'counted once');
  assert.equal(p.seen.filter((s) => s.method === 'POST').length, 2, 'both reached the object: the front does not judge a batch');
  const other = await post(p, JSON.stringify(sample({ seq: 3, events: [{ t: 1, n: 'a.b' }] })));
  assert.equal(other.status, 204);
  assert.equal(rowKeys(p).length, 2, 'other text under the same number is stored');
});

test('front: once the day is full the object answers every batch 429 day-all without reading it, whatever the body is; the front reads no JSON of its own', async (t) => {
  const front = read('worker.js').split('// ===== front: begin')[1].split('// ===== front: end')[0];
  assert.equal(/JSON\.parse|parseBatchText|validateBatch|maskString/.test(front), false, 'the front does no validation');
  const p = await platform(t, { objectEnv: { MAX_BATCHES_PER_DAY: '2' } });
  for (let i = 0; i < 2; i++) assert.equal((await post(p, batchOf(i))).status, 204);
  const real = JSON.parse;
  let parses = 0;
  JSON.parse = function (...args) { parses++; return real.apply(this, args); };
  try {
    for (const body of [JSON.stringify(batchOf(9)), 'not json at all', '#1'.repeat(15000)]) {
      const res = await post(p, body);
      assert.deepEqual([res.status, await word(res), res.headers.get('retry-after')], [429, 'day-all', String(12 * 3600)], body.slice(0, 10));
    }
  } finally {
    JSON.parse = real;
  }
  assert.equal(parses, 0, 'not one body was parsed');
  assert.equal(rowKeys(p).length, 2);
  t.mock.timers.tick(12 * HOUR);
  assert.equal((await post(p, 'not json at all')).status, 400, 'the next UTC day it is read again');
});
