// Unit tests for test/e2e/obs-collector.mjs, the loopback stand-in for the usage report endpoint that the end to end scenarios OBS-1 to OBS-3
// (test/e2e/scenarios-obs.mjs) post to. The scenarios trust it as their oracle, so it is held here, with no browser, to the rules of the
// Worker (plan obs-2026-11-02 section 2.7, deploy/obs-worker): the same statuses and reason words over obs-core.js and over the inline copy of
// the rules it falls back to, the same routes behind the same token, the same tail frames. The helpers the scenarios read with (sessionsOf,
// matchEvent, inOrder, findLeaks) are tested as well, because a leak scan that finds nothing in everything is worth nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCollector, loadCore, CORE_FILE, MAX_BODY_BYTES, sessionsOf, matchEvent, inOrder, firstOf, findLeaks } from '../e2e/obs-collector.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGE = 'http://127.0.0.1:41001';
const OTHER = 'http://127.0.0.1:41002';
const SID = 'k3m8k3m8k3m8';

const sample = (over = {}) => Object.assign({
  v: 1, sid: SID, seq: 0, page: 'site', build: 'bbcb82098cda', loader: '0.3.0', site: 'd680ff36', who: null, net: null,
  ua: { browser: 'chromium', mobile: false }, t0: 1793600000,
  events: [{ t: 5, n: 'boot.start', dev: true }, { t: 40, n: 'run.start', mode: 'site' }],
}, over);

/** call(url, { method, headers, body }) -> { status, headers, text } over node:http, which (unlike fetch) lets a test set Origin. */
function call(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}
const post = (c, batch, { origin = PAGE, type = 'text/plain' } = {}) => call(c.origin + '/e', { method: 'POST', headers: Object.assign({ 'content-type': type }, origin ? { origin } : {}), body: typeof batch === 'string' ? batch : JSON.stringify(batch) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** tailOf(c) -> { frames, close() }: a WebSocket client of /tail (the global WebSocket of Node), open when it is returned. */
async function tailOf(c, token = c.token) {
  const frames = [];
  const ws = new WebSocket(c.origin.replace(/^http/, 'ws') + '/tail?token=' + token);
  ws.onmessage = (m) => frames.push(JSON.parse(String(m.data)));
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('the tail socket did not open')); });
  return { frames, close: () => ws.close() };
}

test('the collector loads deploy/obs-worker/obs-core.js and says which rules it runs', async () => {
  const core = await loadCore();
  const c = await createCollector({ allowOrigins: [PAGE] });
  try {
    if (existsSync(CORE_FILE)) {
      assert.ok(core, 'obs-core.js is in the tree and loads');
      assert.equal(c.validator, 'deploy/obs-worker/obs-core.js');
    } else {
      assert.equal(core, null);
      assert.match(c.validator, /^inline rules/);
    }
  } finally {
    await c.close();
  }
  const forced = await createCollector({ allowOrigins: [PAGE], core: null });
  try {
    assert.match(forced.validator, /^inline rules/, 'core: null forces the inline rules');
  } finally {
    await forced.close();
  }
});

for (const [label, core] of [['obs-core.js', undefined], ['the inline rules of plan 2.7', null]]) {
  const open = (opts = {}) => createCollector(Object.assign({ allowOrigins: [PAGE], core }, opts));

  test('[' + label + '] a batch from an allowed Origin: 204, the origin echoed, the row stored, the text kept as it arrived', async (t) => {
    const c = await open();
    t.after(() => c.close());
    const raw = JSON.stringify(sample({ events: [{ t: 5, n: 'log', m: 'ws://127.0.0.1:9999/x' }] }));
    const r = await post(c, raw);
    assert.equal(r.status, 204);
    assert.equal(r.headers['access-control-allow-origin'], PAGE);
    assert.match(r.headers.vary, /Origin/);
    assert.equal(c.count(), 1);
    assert.equal(c.rows()[0].sid, SID);
    // what the page sent (an address inside a log line) is what posts() holds; what was stored has been masked again
    assert.equal(c.rawBodies()[0], raw);
    assert.match(c.rawBodies()[0], /127\.0\.0\.1/);
    assert.doesNotMatch(JSON.stringify(c.rows()[0]), /127\.0\.0\.1/);
    assert.ok(findLeaks(c.rawBodies()[0]).some((x) => x.indexOf('an IPv4 address') === 0), 'the scan finds the address in the text the page sent');
    assert.deepEqual(findLeaks(JSON.stringify(c.rows()[0].body)), []);
    assert.equal(c.posts()[0].status, 204);
    assert.equal(c.posts()[0].origin, PAGE);
  });

  test('[' + label + '] what the Worker refuses is refused with its status and reason word, and nothing is stored', async (t) => {
    const c = await open();
    t.after(() => c.close());
    const none = await post(c, sample(), { origin: null });
    assert.equal(none.status, 403, 'no Origin header');
    const other = await post(c, sample(), { origin: OTHER });
    assert.equal(other.status, 403, 'an Origin nobody allowed');
    assert.equal(other.headers['access-control-allow-origin'], undefined);
    assert.equal(c.posts().filter((p) => p.status === 403).every((p) => p.body === null), true, 'the body of a refused origin is never read');
    assert.equal((await post(c, sample(), { type: 'image/png' })).status, 415);
    assert.equal((await post(c, 'x'.repeat(MAX_BODY_BYTES + 1))).status, 413);
    assert.equal((await post(c, 'not json')).status, 400);
    const reasons = {
      version: sample({ v: 2 }), sid: sample({ sid: 'SHORT' }), page: sample({ page: 'mars' }), who: sample({ who: 'Has Space' }),
      name: sample({ events: [{ t: 1, n: 'Bad Name' }] }), events: sample({ events: [] }), value: sample({ events: [{ t: 1, n: 'ok.name', x: { nested: 1 } }] }),
    };
    for (const [reason, batch] of Object.entries(reasons)) {
      const r = await post(c, batch);
      assert.equal(r.status, 400, reason);
      assert.equal(r.text.trim(), reason);
      assert.equal(r.headers['access-control-allow-origin'], PAGE);
    }
    const tooMany = await post(c, sample({ events: Array.from({ length: 101 }, (_, i) => ({ t: i, n: 'ev.many' })) }));
    assert.equal(tooMany.status, 400, '101 events');
    assert.equal(c.count(), 0, 'nothing was stored');
  });

  test('[' + label + '] the sixty-first batch of one session in a minute is 429 with its reason and a retry time', async (t) => {
    let at = Date.UTC(2026, 10, 2, 12, 0, 0);
    const c = await open({ now: () => at });
    t.after(() => c.close());
    for (let i = 0; i < 60; i++) assert.equal((await post(c, sample({ seq: i }))).status, 204, 'batch ' + i);
    const over = await post(c, sample({ seq: 60 }));
    assert.equal(over.status, 429);
    assert.equal(over.text.trim(), 'sid-minute');
    assert.match(over.headers['retry-after'], /^\d+$/);
    at += 61000;
    assert.equal((await post(c, sample({ seq: 61 }))).status, 204, 'a minute later it is let through again');
    assert.equal((await post(c, sample({ sid: 'p3m8p3m8p3m8', seq: 0 }))).status, 204, 'another session was never limited');
  });

  test('[' + label + '] the preflight answers an allowed origin and refuses another; healthz and unknown paths', async (t) => {
    const c = await open();
    t.after(() => c.close());
    const ok = await call(c.origin + '/e', { method: 'OPTIONS', headers: { origin: PAGE, 'access-control-request-method': 'POST' } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers['access-control-allow-origin'], PAGE);
    assert.match(ok.headers['access-control-allow-methods'], /POST/);
    assert.equal(ok.headers['access-control-max-age'], '600');
    assert.equal((await call(c.origin + '/e', { method: 'OPTIONS', headers: { origin: OTHER } })).status, 403);
    assert.equal((await call(c.origin + '/healthz')).text, 'ok\n');
    assert.equal((await call(c.origin + '/nothing')).status, 404);
    assert.equal((await call(c.origin + '/e')).status, 404, 'GET /e');
  });

  test('[' + label + '] /events.json and /summary.json need the token, filter by sid and who, and read from any origin', async (t) => {
    const c = await open();
    t.after(() => c.close());
    await post(c, sample({ seq: 0 }));
    await post(c, sample({ seq: 1, who: 'da9u-6qug', events: [{ t: 90, n: 'auth.change', signedIn: true }] }));
    await post(c, sample({ sid: 'p3m8p3m8p3m8', seq: 0, events: [{ t: 3, n: 'boot.start' }] }));
    assert.equal((await call(c.origin + '/events.json')).status, 404, 'no token');
    assert.equal((await call(c.origin + '/events.json?token=wrong')).status, 404, 'a wrong token');
    const all = await call(c.origin + '/events.json?token=' + c.token);
    assert.equal(all.status, 200);
    assert.equal(all.headers['access-control-allow-origin'], '*');
    const list = JSON.parse(all.text);
    assert.equal(list.batches.length, 3);
    assert.equal(typeof list.next, 'string');
    assert.deepEqual(list.batches.map((b) => b.body.seq), [0, 1, 0], 'in the order they were stored');
    const mine = JSON.parse((await call(c.origin + '/events.json?token=' + c.token + '&sid=' + SID)).text);
    assert.equal(mine.batches.length, 2);
    const signed = JSON.parse((await call(c.origin + '/events.json?token=' + c.token + '&who=da9u-6qug')).text);
    assert.equal(signed.batches.length, 1);
    const after = JSON.parse((await call(c.origin + '/events.json?token=' + c.token + '&since=' + encodeURIComponent(list.batches.length ? list.next : ''))).text);
    assert.equal(after.batches.length, 0, 'since the last key: nothing');
    assert.equal((await call(c.origin + '/events.json?token=' + c.token + '&sid=bad')).status, 400);
    const sum = JSON.parse((await call(c.origin + '/summary.json?token=' + c.token)).text);
    assert.equal(sum.batches, 3);
    assert.equal(sum.sids, 2);
    assert.equal(sum.who, 1);
    assert.equal(sum.names['boot.start'], 2);
    assert.equal((await call(c.origin + '/summary.json')).status, 404);
  });

  test('[' + label + '] /tail: a hello frame, then one frame per stored batch; a wrong token and a plain GET get nothing', async (t) => {
    const c = await open();
    t.after(() => c.close());
    await post(c, sample({ seq: 0 }));
    const tail = await tailOf(c);
    t.after(() => tail.close());
    await c.waitFor(() => tail.frames.length >= 1, { label: 'the hello frame' });
    assert.deepEqual(tail.frames[0], { type: 'hello', batches: 1 });
    assert.equal(c.tailCount(), 1);
    await post(c, sample({ seq: 1 }));
    await post(c, sample({ seq: 2 }), { origin: OTHER }); // refused: no frame
    await c.waitFor(() => tail.frames.length >= 2, { label: 'a batch frame' });
    await sleep(100);
    assert.equal(tail.frames.length, 2, 'one frame for the stored batch, none for the refused one');
    assert.equal(tail.frames[1].sid, SID);
    assert.equal(tail.frames[1].body.seq, 1);
    assert.deepEqual(tail.frames[1], c.rows()[1], 'the frame is the stored row');
    await assert.rejects(tailOf(c, 'wrong'), /did not open/);
    assert.equal((await call(c.origin + '/tail?token=' + c.token)).status, 426);
    assert.equal((await call(c.origin + '/tail')).status, 404);
  });

  test('[' + label + '] a batch sent again (same sid, seq and text) is answered 204 and stored once, as at the Worker; the same seq with other text is stored, and sessionsOf keeps the first of the two; clear() forgets rows, not origins or sockets', async (t) => {
    const c = await open();
    t.after(() => c.close());
    assert.equal((await post(c, sample({ seq: 0 }))).status, 204);
    assert.equal((await post(c, sample({ seq: 0 }))).status, 204);
    assert.equal(c.count(), 1, 'the retry is not stored again');
    assert.equal(c.posts().length, 2, 'but both posts are on record, for a scan of what the page sent');
    await post(c, sample({ seq: 0, events: [{ t: 7, n: 'run.start', mode: 'site' }] }));
    await post(c, sample({ seq: 1, events: [{ t: 90, n: 'render.done', ms: 80 }] }));
    assert.equal(c.count(), 3);
    const s = c.sessions().get(SID);
    assert.equal(s.repeats, 1);
    assert.deepEqual(s.seqs, [0, 1]);
    assert.deepEqual(s.events.map((e) => e.n), ['boot.start', 'run.start', 'render.done']);
    const tail = await tailOf(c);
    t.after(() => tail.close());
    c.clear();
    assert.equal(c.count(), 0);
    assert.deepEqual(c.requests(), []);
    assert.deepEqual(c.allowedOrigins(), [PAGE]);
    assert.equal(c.tailCount(), 1);
    assert.equal((await post(c, sample({ seq: 0 }))).status, 204, 'the same sid and seq again: the limits started again too');
  });
}

for (const [label, core] of [['obs-core.js', undefined], ['the inline rules of plan 2.7', null]]) {
  test('[' + label + '] a batch sent again is not pushed to the tail a second time; who, loader, site and net are checked against the shapes the reporters write', async (t) => {
    const c = await createCollector({ allowOrigins: [PAGE], core });
    t.after(() => c.close());
    const tail = await tailOf(c);
    t.after(() => tail.close());
    assert.equal((await post(c, sample({ seq: 0 }))).status, 204);
    assert.equal((await post(c, sample({ seq: 0 }))).status, 204);
    assert.equal((await post(c, sample({ seq: 1 }))).status, 204);
    for (let i = 0; i < 100 && tail.frames.length < 3; i++) await sleep(10);
    await sleep(30);
    assert.deepEqual(tail.frames.map((f) => (f.type === 'hello' ? 'hello' : 'seq ' + f.body.seq)), ['hello', 'seq 0', 'seq 1']);
    // who, loader, site and net in the shapes the reporters write: the rest is a 400 with the word of the field
    for (const [over, reason] of [[{ who: 'pat-example' }, 'who'], [{ loader: 'dev' }, 'loader'], [{ site: 'd680ff36d' }, 'site'], [{ net: { type: 'abcdefgh2345', effectiveType: '4g' } }, 'net']]) {
      const r = await post(c, sample(Object.assign({ seq: 9 }, over)));
      assert.deepEqual([r.status, r.text.trim()], [400, reason], JSON.stringify(over));
    }
    assert.equal((await post(c, sample({ seq: 9, who: 'da9u-6qug', net: { type: 'wifi', effectiveType: '4g' } }))).status, 204);
  });
}

test('findLeaks: what it must find, and what it must not mistake for a leak', () => {
  const hits = {
    'an IPv4 address': ['{"m":"peer 192.168.1.20 left"}', '{"m":"x 127.0.0.1"}', '{"m":"10.0.0.1:8080"}'],
    'an IPv6 address': ['{"m":"fe80::1"}', '{"m":"2001:db8:85a3:0:0:8a2e:370:7334"}', '{"m":"::1"}', '{"m":"::ffff:10.1.2.3"}'],
    'a port after a masked address': ['{"m":"ws://x.x.x.x:5555/"}', '{"m":"[x.x.x.x]:1234"}'],
    'a loopback name': ['{"host":"localhost"}', '{"host":"[::1]"}'],
    'a full user agent': ['{"ua":"Mozilla/5.0 (Macintosh)"}', '{"ua":"HeadlessChrome/156.0.0.0"}'],
    'a URL with a fragment': ['{"m":"https://site.example/#mw1:abcdef"}'],
    'a whole pair code': ['{"m":"abcd-efgh-jkmn"}'],
    'a hash of 40 or more hex digits': ['{"m":"' + 'a1'.repeat(20) + '"}'],
  };
  for (const [what, texts] of Object.entries(hits)) {
    for (const text of texts) assert.ok(findLeaks(text).some((x) => x.indexOf(what) === 0), what + ' in ' + text + ': ' + JSON.stringify(findLeaks(text)));
  }
  const clean = [
    '{"v":1,"sid":"k3m8k3m8k3m8","seq":3,"t0":1793600000,"events":[{"t":5,"n":"boot.start","dev":true,"ms":12.5}]}',
    '{"m":"ws://x.x.x.x/tracker","host":"x.x.x.x"}',
    '{"m":"started at 12:30:45 after 3 tries"}',
    '{"who":"da9u-6qug","site":"d680ff36","build":"bbcb82098cda","loader":"0.3.0"}',
    '{"n":"ice.pair","id":"pc1","local":"host/udp","remote":"host/udp","types":"host,host,srflx"}',
    '{"m":"version 0.3.0 loaded","t":4321}',
  ];
  for (const text of clean) assert.deepEqual(findLeaks(text), [], text);
  // ports and literals the scenario knows about
  assert.ok(findLeaks('{"m":"host:5555"}', { ports: [5555] }).some((x) => /port 5555/.test(x)));
  assert.deepEqual(findLeaks('{"t":5555,"n":"a.b"}', { ports: [5555] }), [], 'a number that equals a port is not a port');
  assert.ok(findLeaks('{"m":"sent hello-secret-text"}', { literals: ['hello-secret-text'] }).some((x) => /hello-secret-text/.test(x)));
  assert.deepEqual(findLeaks('{"m":"sent"}', { literals: ['', 'ab'] }), [], 'a literal shorter than 4 characters is not looked for');
});

test('sessionsOf, matchEvent, inOrder and firstOf: the order inside one session is the reporter\'s, with times and labels', () => {
  const rows = [
    { body: sample({ seq: 1, who: 'da9u-6qug', site: 'd680ff36', events: [{ t: 2200, n: 'apps.conv', status: 'connecting' }, { t: 3100, n: 'apps.conv', status: 'connected' }] }) },
    { body: sample({ seq: 0, who: null, site: '', events: [{ t: 10, n: 'boot.start' }, { t: 900, n: 'apps.signin', step: 'start' }] }) },
    { body: sample({ seq: 0, who: null, site: '', events: [{ t: 10, n: 'boot.start' }, { t: 900, n: 'apps.signin', step: 'start' }] }) }, // a retry
    { body: sample({ sid: 'p3m8p3m8p3m8', t0: 1793600002, seq: 0, events: [{ t: 5, n: 'boot.start' }] }) },
  ];
  const sessions = sessionsOf(rows);
  assert.equal(sessions.size, 2);
  const s = sessions.get(SID);
  assert.deepEqual(s.seqs, [0, 1], 'sorted by seq, the retry not counted twice');
  assert.equal(s.repeats, 1);
  assert.deepEqual(s.who, [null, 'da9u-6qug'], 'who in the order it first labelled a batch');
  assert.deepEqual(s.events.map((e) => e.n + ':' + (e.status || e.step || '')), ['boot.start:', 'apps.signin:start', 'apps.conv:connecting', 'apps.conv:connected']);
  assert.equal(s.events[1].$abs, 1793600000 * 1000 + 900);
  assert.equal(s.events[3].$who, 'da9u-6qug');
  assert.equal(s.events[0].$who, null);
  assert.equal(sessions.get('p3m8p3m8p3m8').events[0].$abs, 1793600002 * 1000 + 5);

  assert.equal(matchEvent(s.events[2], 'apps.conv'), true);
  assert.equal(matchEvent(s.events[2], { n: 'apps.conv', status: 'connecting' }), true);
  assert.equal(matchEvent(s.events[2], { n: 'apps.conv', status: 'connected' }), false);
  assert.equal(matchEvent(s.events[2], { n: 'apps.conv', status: /^conn/ }), true);
  assert.equal(matchEvent(s.events[2], { n: 'apps.conv', status: (v, ev) => v.length === 10 && ev.t === 2200 }), true);
  assert.equal(matchEvent(s.events[2], { n: 'apps.conv', missing: undefined }), true, 'a field the event lacks equals undefined');
  assert.equal(matchEvent(null, 'x'), false);

  const good = inOrder(s.events, ['boot.start', { n: 'apps.signin', step: 'start' }, { n: 'apps.conv', status: 'connecting' }, { n: 'apps.conv', status: 'connected' }]);
  assert.deepEqual(good, { ok: true, at: [0, 1, 2, 3] });
  const gap = inOrder(s.events, ['boot.start', { n: 'apps.conv', status: 'connected' }]);
  assert.deepEqual(gap.at, [0, 3], 'other events may stand between the links');
  const wrong = inOrder(s.events, [{ n: 'apps.conv', status: 'connected' }, { n: 'apps.conv', status: 'connecting' }]);
  assert.equal(wrong.ok, false);
  assert.equal(wrong.link, 'apps.conv {status="connecting"}');
  assert.equal(wrong.after, 'apps.conv {status="connected"}');
  assert.equal(inOrder(s.events, ['nothing.here']).ok, false);
  assert.equal(firstOf(s.events, { n: 'apps.conv', status: 'connected' }).t, 3100);
  assert.equal(firstOf(s.events, 'absent'), null);
});

test('the collector reads no client address and writes no log (the Worker does neither)', () => {
  const lines = readFileSync(join(ROOT, 'test', 'e2e', 'obs-collector.mjs'), 'utf8').split('\n').map((l) => l.replace(/\/\/.*$/, ''));
  const code = lines.join('\n');
  for (const needle of ['remoteAddress', 'remotePort', 'x-forwarded-for', 'cf-connecting-ip', 'request.cf', 'console.', 'process.stdout']) {
    assert.equal(code.toLowerCase().indexOf(needle.toLowerCase()), -1, needle);
  }
});

test('the e2e files of the usage reports follow the wording rules (plan section 0): no banned phrase, no dash characters, no curly quotes, ASCII only', () => {
  const banned = [['block', 'chain'], ['server', 'less'], ['un', 'stoppable'], ['censorship', '-resistant'], ['production', '-ready'], ['fully ', 'decentralized'], ['sub', '-second']].map((p) => p.join(''));
  const presence = new RegExp('\\b' + 'on' + 'line\\b', 'i');
  const marks = [0x2014, 0x2013, 0x2018, 0x2019, 0x201c, 0x201d, 0x2026].map((code) => String.fromCharCode(code));
  for (const name of ['test/e2e/obs-collector.mjs', 'test/e2e/scenarios-obs.mjs', 'test/unit/e2e-obs-collector.test.mjs']) {
    const file = join(ROOT, name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const word of banned) assert.equal(text.toLowerCase().indexOf(word), -1, name + ' says "' + word + '"');
    for (const mark of marks) assert.equal(text.indexOf(mark), -1, name + ' holds U+' + mark.charCodeAt(0).toString(16));
    assert.equal(/[^\x00-\x7f]/.test(text), false, name + ' is not ASCII');
    assert.equal(presence.test(text), false, name + ' uses the word that presence wording avoids (the wording is "Connected to you now")');
  }
});
