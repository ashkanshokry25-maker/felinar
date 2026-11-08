// Unit tests for tools/check-site.mjs --door (v0.3 C2, docs/research/v03/S4-doors.md D3, D7): the root of an https: host (http only
// on loopback), /mw-sw.js 200 with a JavaScript type and no redirect, /_mw/door.json a door list other origins may read, and every
// /_mw/* file it lists byte for byte. A door is served by a small server on 127.0.0.1; one case uses a fake fetch so that no
// non-local address is ever contacted.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { checkDoor, DOOR_CHECK_ORIGIN } from '../../tools/check-site.mjs';
import { appsBlockOf } from '../../src/loader/doors.js';
import { doorJson } from '../../build.mjs';
import { ROOT } from '../../tools/lib.mjs';

const BANNED = /blockchain|serverless|unstoppable|censorship|production-ready|fully decentralized|sub-second|[\u2013\u2014\u2018\u2019\u201c\u201d]/i;
const closers = [];
after(async () => { for (const c of closers.reverse()) await c(); });

function doorFiles() {
  return new Map([
    ['index.html', Buffer.from('<!doctype html><title>Loading site</title>')],
    ['mw-sw.js', Buffer.from('// the worker\n')],
    ['_mw/open.html', Buffer.from('<!doctype html><title>Loading site</title><link rel="manifest" href="/_mw/door.webmanifest">')],
    ['_mw/loader.js', Buffer.from('// the loader\n'.repeat(50))],
    ['_mw/boot.js', Buffer.from('// boot\n')],
    ['_mw/ui.css', Buffer.from('body{}')],
  ]);
}

/**
 * A door on 127.0.0.1. opts: { cors, swRedirect, swType, flip: path, noDoorJson, blockPage, cleanUrls (0.3.1: /_mw/open.html answers
 * 308 to /_mw/open and the page is served there, as Cloudflare Pages does), redirectTo (the 308's target), oldLoader (a door.json
 * without pageAlias: a loader that enters door mode only at /_mw/open.html), apps (the value of the "apps" key of door.json, set as
 * the last key: a door that offers apps), obs (the value of its "obs" key, set after apps: a door whose loader sends usage reports) }.
 */
async function door(opts = {}) {
  const files = doorFiles();
  let dj = doorJson(files, { version: '0.3.0', buildId: 'abcdef123456' });
  if (opts.oldLoader) {
    const o = JSON.parse(dj.toString('utf8'));
    delete o.pageAlias;
    dj = Buffer.from(JSON.stringify(o));
  }
  if (opts.apps !== undefined) {
    const o = JSON.parse(dj.toString('utf8'));
    o.apps = opts.apps;
    dj = Buffer.from(JSON.stringify(o, null, 2) + '\n');
  }
  if (opts.obs !== undefined) {
    const o = JSON.parse(dj.toString('utf8'));
    o.obs = opts.obs;
    dj = Buffer.from(JSON.stringify(o, null, 2) + '\n');
  }
  const served = new Map(files);
  if (opts.flip) {
    const b = Buffer.from(served.get(opts.flip));
    b[0] ^= 1;
    served.set(opts.flip, b);
  }
  const seen = [];
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    seen.push({ path, origin: req.headers.origin || null });
    if (path === '/mw-sw.js' && opts.swRedirect) { res.writeHead(302, { location: '/other-sw.js' }); return res.end() }
    if (path === '/_mw/door.json') {
      if (opts.noDoorJson) { res.writeHead(404); return res.end('not found') }
      const headers = { 'content-type': 'application/json' };
      if (opts.cors !== false) headers['access-control-allow-origin'] = '*';
      res.writeHead(200, headers);
      return res.end(opts.blockPage ? '<html><body>This site is blocked in your country</body></html>' : dj);
    }
    if (opts.cleanUrls && path === '/_mw/open.html') { res.writeHead(308, { location: opts.redirectTo || '/_mw/open' }); return res.end() }
    const key = opts.cleanUrls && path === '/_mw/open' ? '_mw/open.html' : path.slice(1);
    if (!served.has(key)) { res.writeHead(404); return res.end() }
    const type = key.endsWith('.js') ? (path === '/mw-sw.js' && opts.swType ? opts.swType : 'text/javascript') : key.endsWith('.css') ? 'text/css' : 'text/html';
    res.writeHead(200, { 'content-type': type });
    res.end(served.get(key));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port + '/';
  closers.push(() => new Promise((r) => { server.closeAllConnections(); server.close(r) }));
  return { url, seen };
}

const levels = (res) => Object.fromEntries(res.results.map((r) => [r.step, r.level]));

test('checkDoor: a good door passes: the address, the worker, door.json with CORS, every /_mw/ file and the worker byte for byte', async () => {
  const d = await door();
  const res = await checkDoor(d.url, {});
  assert.equal(res.ok, true, JSON.stringify(res.results, null, 1));
  assert.equal(res.door.buildId, 'abcdef123456');
  const lv = levels(res);
  assert.equal(lv.cors, 'ok');
  assert.equal(lv['/_mw/*'], 'ok');
  assert.ok(res.results.some((r) => r.step === '/mw-sw.js' && /match door\.json/.test(r.message)));
  assert.ok(d.seen.some((s) => s.path === '/_mw/door.json' && s.origin === DOOR_CHECK_ORIGIN), 'the door.json request names an Origin');
  assert.ok(d.seen.every((s) => s.path.startsWith('/_mw/') || s.path === '/mw-sw.js'), 'only the door files, never a pointer, DNS or a tracker');
});

test('checkDoor: one changed byte in a loader file, a redirected or mistyped worker, or a missing door.json fails', async () => {
  let res = await checkDoor((await door({ flip: '_mw/loader.js' })).url, {});
  assert.equal(res.ok, false);
  assert.equal(levels(res)['/_mw/loader.js'], 'fail');
  assert.match(res.results.find((r) => r.step === '/_mw/loader.js').message, /transformed file/);
  res = await checkDoor((await door({ flip: 'mw-sw.js' })).url, {});
  assert.ok(res.results.some((r) => r.step === '/mw-sw.js' && r.level === 'fail' && /differ from door\.json/.test(r.message)));
  res = await checkDoor((await door({ swRedirect: true })).url, {});
  assert.ok(res.results.some((r) => r.step === '/mw-sw.js' && r.level === 'fail' && /redirect/.test(r.message)));
  res = await checkDoor((await door({ swType: 'text/plain' })).url, {});
  assert.ok(res.results.some((r) => r.step === '/mw-sw.js' && r.level === 'fail' && /not served as JavaScript/.test(r.message)));
  res = await checkDoor((await door({ noDoorJson: true })).url, {});
  assert.equal(levels(res)['/_mw/door.json'], 'fail');
  res = await checkDoor((await door({ blockPage: true })).url, {});
  assert.match(res.results.find((r) => r.step === '/_mw/door.json').message, /not a door list .*block page/);
});

test('checkDoor: no CORS on door.json fails (other doors cannot check this one); --allow-no-cors makes it a warning', async () => {
  const d = await door({ cors: false });
  let res = await checkDoor(d.url, {});
  assert.equal(levels(res).cors, 'fail');
  assert.match(res.results.find((r) => r.step === 'cors').message, /answering, not checked/);
  res = await checkDoor(d.url, { allowNoCors: true });
  assert.equal(res.ok, true);
  assert.equal(levels(res).cors, 'warn');
});

test('checkDoor: plain http on a public name fails before anything else is believed; a sub-path is checked at the root', async () => {
  const calls = [];
  const fakeFetch = async (url) => { calls.push(url); throw new TypeError('not contacted in tests') };
  const res = await checkDoor('http://door.example.org/', { fetch: fakeFetch });
  assert.equal(levels(res).door, 'fail');
  assert.ok(calls.every((u) => u.startsWith('http://door.example.org/')), 'the fake fetch saw only the door itself');
  const d = await door();
  const sub = await checkDoor(d.url + 'some/path', {});
  assert.ok(sub.results.some((r) => r.step === 'door' && r.level === 'warn'));
  assert.equal(sub.failures, 0);
  const alias = await checkDoor(d.url + '_mw/open', {});
  assert.ok(!alias.results.some((r) => r.step === 'door' && r.level === 'warn'), 'the clean URL of the door page names the door');
});

test('checkDoor (0.3.1): a host with clean URLs answers the door page at /_mw/open after a redirect: ok with an info line for a loader that enters door mode there, a failure for an older loader, a failure for a redirect elsewhere; the bytes at the clean URL are checked', async () => {
  const clean = await door({ cleanUrls: true });
  let res = await checkDoor(clean.url, {});
  assert.equal(res.ok, true, JSON.stringify(res.results, null, 1));
  assert.ok(res.results.some((r) => r.step === '/_mw/open.html' && r.level === 'info' && /clean URLs: the host answers the door page at \/_mw\/open \(HTTP 308/.test(r.message)));
  assert.equal(levels(res)['/_mw/*'], 'ok');
  assert.ok(clean.seen.some((s) => s.path === '/_mw/open.html') && clean.seen.some((s) => s.path === '/_mw/open'), 'both addresses were fetched');
  res = await checkDoor((await door({ cleanUrls: true, oldLoader: true })).url, {});
  assert.equal(res.ok, false);
  assert.match(res.results.find((r) => r.step === '/_mw/open.html' && r.level === 'fail').message, /where this loader \(0\.3\.0\) does not enter door mode/);
  res = await checkDoor((await door({ cleanUrls: true, redirectTo: '/somewhere-else' })).url, {});
  assert.ok(res.results.some((r) => r.step === '/_mw/open.html' && r.level === 'fail' && /HTTP 308 redirect to \/somewhere-else/.test(r.message)));
  res = await checkDoor((await door({ cleanUrls: true, flip: '_mw/open.html' })).url, {});
  assert.equal(res.ok, false);
  assert.ok(res.results.some((r) => r.step === '/_mw/open.html' && r.level === 'fail' && /transformed file/.test(r.message)));
});

// ---------------------------------------------------------------------------------------------- apps at a door

const APPS_BLOCK = { rendezvous: ['ws://127.0.0.1:8000'], stun: ['stun:127.0.0.1:3478'], idp: 'http://127.0.0.1:8081' };

test('checkDoor (apps at a door): a door.json with an apps block still passes and gets an info line that names it; the addresses in it are never contacted', async () => {
  const d = await door({ apps: APPS_BLOCK });
  const calls = [];
  const res = await checkDoor(d.url, { fetch: (url, init) => { calls.push(String(url)); return fetch(url, init) } });
  assert.equal(res.ok, true, JSON.stringify(res.results, null, 1));
  assert.deepEqual(res.results.find((r) => r.step === 'apps'), { level: 'info', step: 'apps', message: 'rendezvous 1, stun 1, identity http://127.0.0.1:8081' });
  assert.deepEqual(res.door.apps, APPS_BLOCK);
  assert.equal(levels(res)['/_mw/*'], 'ok', 'every listed file still matches: door.json does not list itself');
  assert.ok(calls.length > 0 && calls.every((u) => u.startsWith(d.url)), 'only the door: ' + calls.join(' '));
  assert.ok(d.seen.every((s) => s.path.startsWith('/_mw/') || s.path === '/mw-sw.js'));
  // counts follow the block: two rendezvous, no STUN, an https identity origin
  const more = await door({ apps: { rendezvous: ['wss://rtc.example.org', 'wss://spare.example.org/pair'], stun: [], idp: 'https://id.example.org' } });
  const moreRes = await checkDoor(more.url, {});
  assert.equal(moreRes.ok, true, JSON.stringify(moreRes.results, null, 1));
  assert.equal(moreRes.results.find((r) => r.step === 'apps').message, 'rendezvous 2, stun 0, identity https://id.example.org');
  // the step comes after door.json is read and before the files are compared
  const steps = moreRes.results.map((r) => r.step);
  assert.ok(steps.indexOf('apps') > steps.indexOf('/_mw/door.json') && steps.indexOf('apps') < steps.indexOf('/_mw/*'));
});

test('checkDoor (apps at a door): a door without a block has no apps line', async () => {
  const res = await checkDoor((await door()).url, {});
  assert.equal(res.ok, true);
  assert.equal(res.results.some((r) => r.step === 'apps'), false);
});

test('checkDoor (apps at a door): a block the door page cannot use is a warning that says the paste box stays; a door that is otherwise good still passes', async () => {
  const bad = [
    { rendezvous: ['ws://rtc.example.org'], stun: [], idp: 'https://id.example.org' },
    { rendezvous: [], stun: [], idp: 'https://id.example.org' },
    { rendezvous: ['wss://rtc.example.org'], stun: ['turn:t.example'], idp: 'https://id.example.org' },
    { rendezvous: ['wss://rtc.example.org'], stun: [] },
    { rendezvous: ['wss://rtc.example.org'], stun: [], idp: 'http://id.example.org' },
    'yes',
  ];
  for (const apps of bad) {
    const res = await checkDoor((await door({ apps })).url, {});
    const line = res.results.find((r) => r.step === 'apps');
    assert.ok(!line || line.level !== 'info', 'never an info line for ' + JSON.stringify(apps));
    if (res.door) {
      // this loader's door.json check lets the block through: the tool says it is not usable
      assert.equal(line.level, 'warn', JSON.stringify(apps));
      assert.match(line.message, /apps block the door page cannot use \(.+\): the bare door page keeps its paste box/, JSON.stringify(apps));
      assert.equal(res.ok, true, 'a warning does not fail the door');
    } else {
      // a stricter door.json check refuses the whole file: that is a failure of door.json, not a silent pass
      assert.equal(levels(res)['/_mw/door.json'], 'fail', JSON.stringify(apps));
    }
  }
  const one = await checkDoor((await door({ apps: bad[0] })).url, {});
  if (one.door) assert.match(one.results.find((r) => r.step === 'apps').message, /rendezvous\[0\] is ws: on a host that is not loopback/);
  const many = await checkDoor((await door({ apps: { rendezvous: [], stun: ['x'] } })).url, {});
  if (many.door) assert.match(many.results.find((r) => r.step === 'apps').message, /\(rendezvous is empty: name at least 1; \d+ more\)/);
});

test('CLI: check-site --door prints the apps line, and says the addresses in a block are never contacted', async () => {
  const script = [
    "const http = require('node:http');",
    "const files = " + JSON.stringify(Array.from(doorFiles()).map(([k, v]) => [k, v.toString('base64')])) + ";",
    "const o = JSON.parse(Buffer.from(" + JSON.stringify(doorJson(doorFiles(), { version: '0.3.0', buildId: 'abcdef123456' }).toString('base64')) + ", 'base64').toString());",
    "o.apps = " + JSON.stringify(APPS_BLOCK) + ";",
    "const dj = Buffer.from(JSON.stringify(o, null, 2) + '\\n');",
    "const map = new Map(files.map(([k, v]) => [k, Buffer.from(v, 'base64')]));",
    "const s = http.createServer((q, r) => { const p = new URL(q.url, 'http://x').pathname; if (p === '/_mw/door.json') { r.writeHead(200, { 'access-control-allow-origin': '*' }); return r.end(dj) } const k = p.slice(1); if (!map.has(k)) { r.writeHead(404); return r.end() } r.writeHead(200, { 'content-type': k.endsWith('.js') ? 'text/javascript' : 'text/html' }); r.end(map.get(k)) });",
    "s.listen(0, '127.0.0.1', () => { process.stdout.write(String(s.address().port) + '\\n') });",
  ].join('\n');
  const { spawn } = await import('node:child_process');
  const { port, child } = await new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    c.stdout.once('data', (d) => resolve({ port: Number(String(d).trim()), child: c }));
  });
  try {
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'check-site.mjs'), 'http://127.0.0.1:' + port + '/', '--door'], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr + r.stdout.slice(0, 600));
    assert.match(r.stdout, /^\[info\] apps: rendezvous 1, stun 1, identity http:\/\/127\.0\.0\.1:8081$/m);
    assert.match(r.stdout, /the addresses of an apps block are read, never contacted/);
    assert.match(r.stdout, /^OK: 0 failure\(s\), 0 warning\(s\)\.$/m);
    const json = spawnSync(process.execPath, [join(ROOT, 'tools', 'check-site.mjs'), 'http://127.0.0.1:' + port + '/', '--door', '--json'], { encoding: 'utf8', timeout: 60000 });
    assert.deepEqual(JSON.parse(json.stdout).results.find((x) => x.step === 'apps'), { level: 'info', step: 'apps', message: 'rendezvous 1, stun 1, identity http://127.0.0.1:8081' });
  } finally {
    child.kill();
  }
});

// relay-first tokens (plan 3.9): the info line names what the page makes of relay and direct, and a token the page would refuse is a warning
test('checkDoor (apps at a door): the info line names relay and direct as the page reads them; a block without them keeps the line it had', async () => {
  const line = async (extra) => {
    const res = await checkDoor((await door({ apps: Object.assign({}, APPS_BLOCK, extra) })).url, {});
    assert.equal(res.ok, true, JSON.stringify(res.results, null, 1));
    return res.results.find((r) => r.step === 'apps');
  };
  assert.deepEqual(await line({ relay: 'rendezvous', direct: 'off' }), { level: 'info', step: 'apps', message: 'rendezvous 1, stun 1, identity http://127.0.0.1:8081, relay rendezvous, direct off' });
  assert.equal((await line({ relay: 'rendezvous', direct: 'on' })).message, 'rendezvous 1, stun 1, identity http://127.0.0.1:8081, relay rendezvous, direct on');
  assert.equal((await line({ relay: 'none', direct: 'on' })).message, 'rendezvous 1, stun 1, identity http://127.0.0.1:8081, relay none, direct on');
  assert.equal((await line({ relay: 'none' })).message, 'rendezvous 1, stun 1, identity http://127.0.0.1:8081, relay none, direct on', 'relay none alone is direct on: today\'s behaviour');
  assert.equal((await line({ direct: 'on' })).message, 'rendezvous 1, stun 1, identity http://127.0.0.1:8081, relay rendezvous, direct on');
  assert.equal((await line({})).message, 'rendezvous 1, stun 1, identity http://127.0.0.1:8081');
  // the tokens are kept in the door the check hands back
  const res = await checkDoor((await door({ apps: Object.assign({ relay: 'rendezvous', direct: 'off' }, APPS_BLOCK) })).url, {});
  assert.deepEqual(res.door.apps, Object.assign({ relay: 'rendezvous', direct: 'off' }, APPS_BLOCK));
});

test('checkDoor (apps at a door): a token the page would refuse is a warning that says the paste box stays, and the door still passes; no info line', async () => {
  const cases = [
    [{ relay: 'cloudflare' }, /relay is not "rendezvous" or "none"/],
    [{ relay: 'Rendezvous' }, /relay is not "rendezvous" or "none"/],
    [{ direct: 'sometimes' }, /direct is not "off" or "on"/],
    [{ direct: true }, /direct is not "off" or "on"/],
    [{ relay: 'none', direct: 'off' }, /no way to connect: relay "none" with direct "off"/],
  ];
  for (const [extra, re] of cases) {
    const res = await checkDoor((await door({ apps: Object.assign({}, APPS_BLOCK, extra) })).url, {});
    const line = res.results.find((r) => r.step === 'apps');
    assert.equal(line.level, 'warn', JSON.stringify(extra));
    assert.match(line.message, /apps block the door page cannot use \(.+\): the bare door page keeps its paste box/);
    assert.match(line.message, re, JSON.stringify(extra));
    assert.equal(res.ok, true, 'a warning does not fail the door');
    assert.equal(appsBlockOf(res.door), null, 'the page ignores the block');
    assert.doesNotMatch(line.message, BANNED);
  }
});

test('CLI: check-site --door prints the tokens on the apps line', async () => {
  const withTokens = Object.assign({ relay: 'rendezvous', direct: 'off' }, APPS_BLOCK);
  const script = [
    "const http = require('node:http');",
    "const files = " + JSON.stringify(Array.from(doorFiles()).map(([k, v]) => [k, v.toString('base64')])) + ";",
    "const o = JSON.parse(Buffer.from(" + JSON.stringify(doorJson(doorFiles(), { version: '0.3.0', buildId: 'abcdef123456' }).toString('base64')) + ", 'base64').toString());",
    "o.apps = " + JSON.stringify(withTokens) + ";",
    "const dj = Buffer.from(JSON.stringify(o, null, 2) + '\\n');",
    "const map = new Map(files.map(([k, v]) => [k, Buffer.from(v, 'base64')]));",
    "const s = http.createServer((q, r) => { const p = new URL(q.url, 'http://x').pathname; if (p === '/_mw/door.json') { r.writeHead(200, { 'access-control-allow-origin': '*' }); return r.end(dj) } const k = p.slice(1); if (!map.has(k)) { r.writeHead(404); return r.end() } r.writeHead(200, { 'content-type': k.endsWith('.js') ? 'text/javascript' : 'text/html' }); r.end(map.get(k)) });",
    "s.listen(0, '127.0.0.1', () => { process.stdout.write(String(s.address().port) + '\\n') });",
  ].join('\n');
  const { spawn } = await import('node:child_process');
  const { port, child } = await new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    c.stdout.once('data', (d) => resolve({ port: Number(String(d).trim()), child: c }));
  });
  try {
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'check-site.mjs'), 'http://127.0.0.1:' + port + '/', '--door'], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr + r.stdout.slice(0, 600));
    assert.match(r.stdout, /^\[info\] apps: rendezvous 1, stun 1, identity http:\/\/127\.0\.0\.1:8081, relay rendezvous, direct off$/m);
    assert.match(r.stdout, /^OK: 0 failure\(s\), 0 warning\(s\)\.$/m);
  } finally {
    child.kill();
  }
});

// ---------------------------------------------------------------------------------------------- usage reports

const OBS_ENDPOINT = 'http://127.0.0.1:8787';

/** A stand-in for the report endpoint on 127.0.0.1: it answers 204 to anything and counts every request that reaches it. */
async function collector() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.method + ' ' + req.url);
    res.writeHead(204);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => { server.closeAllConnections(); server.close(r) }));
  return { seen, origin: 'http://127.0.0.1:' + server.address().port };
}

test('checkDoor (usage reports): a door.json with an obs block still passes and gets one info line that names the host; the endpoint is never contacted', async () => {
  const sink = await collector();
  const d = await door({ obs: { endpoint: sink.origin } });
  const calls = [];
  const res = await checkDoor(d.url, { fetch: (url, init) => { calls.push(String(url)); return fetch(url, init) } });
  assert.equal(res.ok, true, JSON.stringify(res.results, null, 1));
  assert.deepEqual(res.results.filter((r) => /usage reports/.test(r.message)), [{ level: 'info', step: 'door', message: 'usage reports to 127.0.0.1' }]);
  assert.deepEqual(res.door.obs, { endpoint: sink.origin });
  assert.equal(levels(res)['/_mw/*'], 'ok', 'every listed file still matches: door.json does not list itself');
  assert.ok(calls.length > 0 && calls.every((u) => u.startsWith(d.url)), 'only the door: ' + calls.join(' '));
  assert.ok(d.seen.every((s) => s.path.startsWith('/_mw/') || s.path === '/mw-sw.js'));
  assert.deepEqual(sink.seen, [], 'nothing reached the endpoint');
  // the step comes after door.json is read and before the files are compared
  const steps = res.results.map((r) => (/usage reports/.test(r.message) ? 'obs-line' : r.step));
  assert.ok(steps.indexOf('obs-line') > steps.indexOf('/_mw/door.json') && steps.indexOf('obs-line') < steps.indexOf('/_mw/*'));
  // the host is named without a port, as the consent card names it; an https endpoint is read, not contacted
  const named = await door({ obs: { endpoint: 'https://obs.example.org:8443' } });
  const namedCalls = [];
  const namedRes = await checkDoor(named.url, { fetch: (url, init) => { namedCalls.push(String(url)); return fetch(url, init) } });
  assert.equal(namedRes.ok, true, JSON.stringify(namedRes.results, null, 1));
  assert.equal(namedRes.results.find((r) => /usage reports/.test(r.message)).message, 'usage reports to obs.example.org');
  assert.ok(namedCalls.every((u) => u.startsWith(named.url)), 'only the door: ' + namedCalls.join(' '));
});

test('checkDoor (usage reports): an http: endpoint on a loopback host is usable only by a page that is itself on a loopback host: checked as a door elsewhere it is a warning, checked on loopback it is the info line', async () => {
  const d = await door({ obs: { endpoint: 'http://localhost:6379' } });
  // the same door, reached under another name: the host the checker sees is door.example.test (the requests go to the local server, so nothing outside is contacted)
  const away = await checkDoor('https://door.example.test/', { fetch: (url, init) => fetch(String(url).replace('https://door.example.test', d.url.replace(/\/$/, '')), init) });
  const lines = away.results.filter((r) => /usage reports|obs block/.test(r.message));
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.deepEqual([lines[0].level, lines[0].step], ['warn', 'door']);
  assert.match(lines[0].message, /^door\.json has an obs block the loader cannot use on this host \(an http: endpoint on a loopback host is used only by a page that is itself on one\): it sends no usage reports$/);
  assert.equal(away.results.some((r) => r.level === 'info' && /usage reports/.test(r.message)), false);
  const here = await checkDoor(d.url, {});
  assert.deepEqual(here.results.filter((r) => /usage reports/.test(r.message)), [{ level: 'info', step: 'door', message: 'usage reports to localhost' }]);
  const secure = await door({ obs: { endpoint: 'https://obs.example.org' } });
  const secureAway = await checkDoor('https://door.example.test/', { fetch: (url, init) => fetch(String(url).replace('https://door.example.test', secure.url.replace(/\/$/, '')), init) });
  assert.deepEqual(secureAway.results.filter((r) => /usage reports|obs block/.test(r.message)), [{ level: 'info', step: 'door', message: 'usage reports to obs.example.org' }]);
});

test('checkDoor (usage reports): a door without a block has no such line, and a null block is no block', async () => {
  const res = await checkDoor((await door()).url, {});
  assert.equal(res.ok, true);
  assert.equal(res.results.some((r) => /usage reports/.test(r.message)), false);
  const nul = await checkDoor((await door({ obs: null })).url, {});
  assert.equal(nul.ok, true);
  assert.equal(nul.results.some((r) => /usage reports|obs block/.test(r.message)), false);
});

test('checkDoor (usage reports): apps and obs together give both lines, apps first, and the door passes', async () => {
  const d = await door({ apps: APPS_BLOCK, obs: { endpoint: OBS_ENDPOINT } });
  const res = await checkDoor(d.url, {});
  assert.equal(res.ok, true, JSON.stringify(res.results, null, 1));
  const steps = res.results.filter((r) => r.level === 'info' && (r.step === 'apps' || /usage reports/.test(r.message))).map((r) => r.message);
  assert.deepEqual(steps, ['rendezvous 1, stun 1, identity http://127.0.0.1:8081', 'usage reports to 127.0.0.1']);
  assert.deepEqual(res.door.apps, APPS_BLOCK);
  assert.deepEqual(res.door.obs, { endpoint: OBS_ENDPOINT });
});

test('checkDoor (usage reports): a block the loader cannot use is a warning that says no reports are sent; a door that is otherwise good still passes', async () => {
  const bad = [
    { endpoint: 'http://obs.example.org' },
    { endpoint: 'https://obs.example.org/e' },
    { endpoint: 'https://user:pw@obs.example.org' },
    { endpoint: 'https://obs.example.org#x' },
    { endpoint: 7 },
    {},
    'yes',
    [],
  ];
  for (const obs of bad) {
    const res = await checkDoor((await door({ obs })).url, {});
    const lines = res.results.filter((r) => /usage reports|obs block/.test(r.message));
    assert.equal(lines.length, 1, JSON.stringify(obs) + ' -> ' + JSON.stringify(lines));
    assert.equal(lines[0].level, 'warn', JSON.stringify(obs));
    assert.equal(lines[0].step, 'door');
    assert.match(lines[0].message, /^door\.json has an obs block the loader cannot use \(.+\): it sends no usage reports$/, JSON.stringify(obs));
    assert.equal(res.ok, true, 'a warning does not fail the door');
    assert.equal(res.warnings, 1);
    assert.equal(res.results.some((r) => r.level === 'info' && /usage reports/.test(r.message)), false, 'never an info line for ' + JSON.stringify(obs));
  }
  const one = await checkDoor((await door({ obs: bad[0] })).url, {});
  assert.match(one.results.find((r) => /obs block/.test(r.message)).message, /endpoint is http: on a host that is not loopback/);
  const many = await checkDoor((await door({ obs: {} })).url, {});
  assert.match(many.results.find((r) => /obs block/.test(r.message)).message, /\(endpoint is not a string\)/);
});

test('CLI: check-site --door prints the usage reports line, and says the endpoint is never contacted', async () => {
  const script = [
    "const http = require('node:http');",
    "const files = " + JSON.stringify(Array.from(doorFiles()).map(([k, v]) => [k, v.toString('base64')])) + ";",
    "const o = JSON.parse(Buffer.from(" + JSON.stringify(doorJson(doorFiles(), { version: '0.3.0', buildId: 'abcdef123456' }).toString('base64')) + ", 'base64').toString());",
    "o.obs = " + JSON.stringify({ endpoint: OBS_ENDPOINT }) + ";",
    "const dj = Buffer.from(JSON.stringify(o, null, 2) + '\\n');",
    "const map = new Map(files.map(([k, v]) => [k, Buffer.from(v, 'base64')]));",
    "const s = http.createServer((q, r) => { const p = new URL(q.url, 'http://x').pathname; if (p === '/_mw/door.json') { r.writeHead(200, { 'access-control-allow-origin': '*' }); return r.end(dj) } const k = p.slice(1); if (!map.has(k)) { r.writeHead(404); return r.end() } r.writeHead(200, { 'content-type': k.endsWith('.js') ? 'text/javascript' : 'text/html' }); r.end(map.get(k)) });",
    "s.listen(0, '127.0.0.1', () => { process.stdout.write(String(s.address().port) + '\\n') });",
  ].join('\n');
  const { spawn } = await import('node:child_process');
  const { port, child } = await new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    c.stdout.once('data', (d) => resolve({ port: Number(String(d).trim()), child: c }));
  });
  try {
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'check-site.mjs'), 'http://127.0.0.1:' + port + '/', '--door'], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr + r.stdout.slice(0, 600));
    assert.match(r.stdout, /^\[info\] door: usage reports to 127\.0\.0\.1$/m);
    assert.match(r.stdout, /the addresses of an apps block are read, never contacted, and neither is the endpoint of an obs block/);
    assert.match(r.stdout, /^OK: 0 failure\(s\), 0 warning\(s\)\.$/m);
    assert.doesNotMatch(r.stdout, BANNED);
    const json = spawnSync(process.execPath, [join(ROOT, 'tools', 'check-site.mjs'), 'http://127.0.0.1:' + port + '/', '--door', '--json'], { encoding: 'utf8', timeout: 60000 });
    assert.deepEqual(JSON.parse(json.stdout).results.find((x) => /usage reports/.test(x.message)), { level: 'info', step: 'door', message: 'usage reports to 127.0.0.1' });
  } finally {
    child.kill();
  }
});

test('CLI: check-site --door --json exits 0 for a good door and 1 for a bad one', async () => {
  // spawnSync blocks this process, so a server in this process could not answer the CLI: the door runs in another process.
  const script = [
    "const http = require('node:http');",
    "const files = " + JSON.stringify(Array.from(doorFiles()).map(([k, v]) => [k, v.toString('base64')])) + ";",
    "const dj = " + JSON.stringify(doorJson(doorFiles(), { version: '0.3.0', buildId: 'abcdef123456' }).toString('base64')) + ";",
    "const map = new Map(files.map(([k, v]) => [k, Buffer.from(v, 'base64')]));",
    "const flip = process.argv[1] === 'bad'; if (flip) { const b = Buffer.from(map.get('_mw/boot.js')); b[0] ^= 1; map.set('_mw/boot.js', b) }",
    "const s = http.createServer((q, r) => { const p = new URL(q.url, 'http://x').pathname; if (p === '/_mw/door.json') { r.writeHead(200, { 'access-control-allow-origin': '*' }); return r.end(Buffer.from(dj, 'base64')) } const k = p.slice(1); if (!map.has(k)) { r.writeHead(404); return r.end() } r.writeHead(200, { 'content-type': k.endsWith('.js') ? 'text/javascript' : 'text/html' }); r.end(map.get(k)) });",
    "s.listen(0, '127.0.0.1', () => { process.stdout.write(String(s.address().port) + '\\n') });",
  ].join('\n');
  const { spawn } = await import('node:child_process');
  const serve = (kind) => new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script, kind], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.once('data', (d) => resolve({ port: Number(String(d).trim()), child }));
  });
  for (const [kind, code] of [['good', 0], ['bad', 1]]) {
    const { port, child } = await serve(kind);
    try {
      const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'check-site.mjs'), 'http://127.0.0.1:' + port + '/', '--door', '--json'], { encoding: 'utf8', timeout: 60000 });
      assert.equal(r.status, code, kind + ': ' + r.stderr + r.stdout.slice(0, 400));
      const out = JSON.parse(r.stdout);
      assert.equal(out.door, true);
      assert.equal(out.ok, code === 0);
    } finally {
      child.kill();
    }
  }
});
