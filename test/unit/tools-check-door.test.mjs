// Unit tests for tools/check-site.mjs --door (v0.3 C2, docs/research/v03/S4-doors.md D3, D7): the root of an https: host (http only
// on loopback), /mw-sw.js 200 with a JavaScript type and no redirect, /_mw/door.json a door list other origins may read, every
// /_mw/* file it lists byte for byte, and the three other files it lists: /mw-sw-kill.js, the 404 page (through one made-up path) and
// /index.html (post-8.2 polish P5; 8.2 audit H-F2, H-F5 and A F7). A door is served by a small server on 127.0.0.1; one case uses a
// fake fetch so that no non-local address is ever contacted.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { checkDoor, withoutPointerStamp, DOOR_CHECK_ORIGIN, DOOR_CHECK_MISSING_PATH } from '../../tools/check-site.mjs';
import { publish, stampHtml } from '../../tools/publish.mjs';
import { keygen } from '../../tools/keygen.mjs';
import { appsBlockOf } from '../../src/loader/doors.js';
import { isShellHtml } from '../../src/sw/lib.js';
import { doorJson } from '../../build.mjs';
import { ROOT } from '../../tools/lib.mjs';

const BANNED = /blockchain|serverless|unstoppable|censorship|production-ready|fully decentralized|sub-second|[\u2013\u2014\u2018\u2019\u201c\u201d]/i;
const closers = [];
after(async () => { for (const c of closers.reverse()) await c(); });

// A page shaped like the loader shell build.mjs writes (a head with a charset, the script that loads /_mw/boot.js), so that the shell
// test (isShellHtml) and the pointer tag see on it what they see on a real door. build.mjs sets index.html and 404.html to ONE buffer.
const SHELL = Buffer.from('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Loading site</title></head><body><script src="/_mw/boot.js" integrity="sha384-AAAAAAAAAAAA" crossorigin></script></body></html>\n');
// A page of the host's own, in place of the shell.
const OTHER_PAGE = Buffer.from('<!doctype html><title>Not found</title><p>This page does not exist.</p>\n');
// A pointer record as publish stamps it into a page (any text: stampHtml escapes it into the content of one meta tag).
const POINTER = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=site&exp=1893456000&seq=1';
const stamped = (page) => stampHtml(page, POINTER).buffer;
// The addresses a door check may ask for: the worker, the door list and its files, the three root files door.json lists and the one
// made-up path that reads the 404 page. Never a pointer, DNS or a tracker, and never /404.html itself: a host serves that page for a
// path it does not have.
const askedFor = (s) => s.path === '/mw-sw.js' || s.path.startsWith('/_mw/') || s.path === '/index.html' || s.path === '/mw-sw-kill.js' || s.path === DOOR_CHECK_MISSING_PATH;

function doorFiles() {
  return new Map([
    ['index.html', SHELL],
    ['404.html', SHELL],
    ['mw-sw.js', Buffer.from('// the worker\n')],
    ['mw-sw-kill.js', Buffer.from('// unregister the worker\n')],
    ['_mw/open.html', Buffer.from('<!doctype html><title>Loading site</title><link rel="manifest" href="/_mw/door.webmanifest">')],
    ['_mw/loader.js', Buffer.from('// the loader\n'.repeat(50))],
    ['_mw/boot.js', Buffer.from('// boot\n')],
    ['_mw/ui.css', Buffer.from('body{}')],
  ]);
}

/**
 * A door on 127.0.0.1. opts: { cors, corsValue (the Access-Control-Allow-Origin value: a string, or a list that sends one header line
 * each), swRedirect, swType, flip: path (one byte of that file is changed on the host; door.json keeps the built bytes), built: { path:
 * Buffer } (other bytes in the build itself: door.json lists them and the host serves them), serve: { path: Buffer } (the host serves
 * other bytes than door.json lists: a stale build, its own page), missing: [path] (listed, not served: 404), hang: [url path] (never
 * answered), unlisted: [path] (served, not in door.json: a list from an older loader or made by hand), unknown (what a path the host
 * does not have gets: 'page', the default, is the build's 404.html with status 404, where docs/COMPATIBILITY.md lists "your 404.html,
 * status 404" for GitHub Pages and "your 404.html" for Cloudflare Pages and Netlify; 'empty' is a 404 with no body, what a host with no
 * rule for it would answer; 'spa' is index.html with 200, as the dev server answers; 'redirect' is a 302; 'error' is a 503; 'other' is
 * a 404 page of the host's own; 'stamped' is the listed page plus the pointer tag a publish adds), noDoorJson, blockPage, cleanUrls
 * (0.3.1: /_mw/open.html answers 308 to /_mw/open and the page is served there, as Cloudflare Pages does; it also models /index.html as a
 * redirect to /, which that host does on its identity page, and /404.html as a redirect to /404, which is expected there and not
 * observed), redirectTo (the 308's target), oldLoader (a door.json without pageAlias: a loader that enters door mode only at
 * /_mw/open.html), apps (the value of the "apps" key of door.json, set as the last key: a door that offers apps), obs (the value of its
 * "obs" key, set after apps: a door whose loader sends usage reports) }.
 */
async function door(opts = {}) {
  const files = doorFiles();
  for (const [key, bytes] of Object.entries(opts.built || {})) files.set(key, bytes);
  const listed = new Map(Array.from(files).filter(([key]) => !(opts.unlisted || []).includes(key)));
  let dj = doorJson(listed, { version: '0.3.0', buildId: 'abcdef123456' });
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
  for (const [key, bytes] of Object.entries(opts.serve || {})) served.set(key, bytes);
  for (const key of opts.missing || []) served.delete(key);
  if (opts.flip) {
    const b = Buffer.from(served.get(opts.flip));
    b[0] ^= 1;
    served.set(opts.flip, b);
  }
  const seen = [];
  const unknown = (res) => {
    const mode = opts.unknown || 'page';
    if (mode === 'empty') { res.writeHead(404); return res.end() }
    if (mode === 'spa') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(served.get('index.html')) }
    if (mode === 'redirect') { res.writeHead(302, { location: '/' }); return res.end() }
    if (mode === 'error') { res.writeHead(503); return res.end('unavailable') }
    if (mode === 'other') { res.writeHead(404, { 'content-type': 'text/html' }); return res.end(OTHER_PAGE) }
    if (mode === 'stamped') { res.writeHead(404, { 'content-type': 'text/html' }); return res.end(stamped(served.get('404.html'))) }
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end(served.get('404.html'));
  };
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    seen.push({ path, origin: req.headers.origin || null });
    if ((opts.hang || []).includes(path)) return; // a host that never answers this address
    if (path === '/mw-sw.js' && opts.swRedirect) { res.writeHead(302, { location: '/other-sw.js' }); return res.end() }
    if (path === '/_mw/door.json') {
      if (opts.noDoorJson) { res.writeHead(404); return res.end('not found') }
      const headers = { 'content-type': 'application/json' };
      if (opts.corsValue !== undefined) headers['access-control-allow-origin'] = opts.corsValue;
      else if (opts.cors !== false) headers['access-control-allow-origin'] = '*';
      res.writeHead(200, headers);
      return res.end(opts.blockPage ? '<html><body>This site is blocked in your country</body></html>' : dj);
    }
    if (opts.cleanUrls && path === '/_mw/open.html') { res.writeHead(308, { location: opts.redirectTo || '/_mw/open' }); return res.end() }
    if (opts.cleanUrls && path === '/index.html') { res.writeHead(308, { location: '/' }); return res.end() }
    if (opts.cleanUrls && path === '/404.html') { res.writeHead(308, { location: '/404' }); return res.end() }
    const key = opts.cleanUrls && path === '/_mw/open' ? '_mw/open.html' : path.slice(1);
    if (!served.has(key)) return unknown(res);
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
  assert.deepEqual(['/404.html', '/index.html', '/mw-sw-kill.js'].map((step) => lv[step]), ['ok', 'ok', 'ok'], 'the three root files door.json lists are read too (8.2 audit H-F2)');
  assert.ok(d.seen.some((s) => s.path === '/_mw/door.json' && s.origin === DOOR_CHECK_ORIGIN), 'the door.json request names an Origin');
  assert.ok(d.seen.every(askedFor), 'only the door files, never a pointer, DNS or a tracker: ' + d.seen.map((s) => s.path).join(' '));
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
  assert.ok(d.seen.every(askedFor), d.seen.map((s) => s.path).join(' '));
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
    "const s = http.createServer((q, r) => { const p = new URL(q.url, 'http://x').pathname; if (p === '/_mw/door.json') { r.writeHead(200, { 'access-control-allow-origin': '*' }); return r.end(dj) } const k = p.slice(1); if (!map.has(k)) { r.writeHead(404); return r.end(map.get('404.html')) } r.writeHead(200, { 'content-type': k.endsWith('.js') ? 'text/javascript' : 'text/html' }); r.end(map.get(k)) });",
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
    "const s = http.createServer((q, r) => { const p = new URL(q.url, 'http://x').pathname; if (p === '/_mw/door.json') { r.writeHead(200, { 'access-control-allow-origin': '*' }); return r.end(dj) } const k = p.slice(1); if (!map.has(k)) { r.writeHead(404); return r.end(map.get('404.html')) } r.writeHead(200, { 'content-type': k.endsWith('.js') ? 'text/javascript' : 'text/html' }); r.end(map.get(k)) });",
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
  assert.ok(d.seen.every(askedFor), d.seen.map((s) => s.path).join(' '));
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
    "const s = http.createServer((q, r) => { const p = new URL(q.url, 'http://x').pathname; if (p === '/_mw/door.json') { r.writeHead(200, { 'access-control-allow-origin': '*' }); return r.end(dj) } const k = p.slice(1); if (!map.has(k)) { r.writeHead(404); return r.end(map.get('404.html')) } r.writeHead(200, { 'content-type': k.endsWith('.js') ? 'text/javascript' : 'text/html' }); r.end(map.get(k)) });",
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

// ---------------------------------------------------------------------------------------------- the files at the root of the host
// 8.2 audit H-F2 and A F7: door.json lists /404.html, /index.html and /mw-sw-kill.js, and this check once read none of them. build.mjs
// sets the first two to one buffer; a host serves /404.html for a path it does not have, so that page is read through one.

const WORDING = /serverless|blockchain|unstoppable|censorship|production-ready|fully decentralized|sub-second|anonymous|[\u2013\u2014\u2018\u2019\u201c\u201d]/i;
const ASCII = /^[\x20-\x7e]*$/;
const lineOf = (res, step) => res.results.filter((r) => r.step === step);
const only = (res, step) => {
  const lines = lineOf(res, step);
  assert.equal(lines.length, 1, step + ': ' + JSON.stringify(lines));
  return lines[0];
};
// Pages a host may answer in place of the shell.
const STALE = Buffer.from(SHELL.toString().replace('sha384-AAAAAAAAAAAA', 'sha384-BBBBBBBBBBBBBBBB'));
const SAME_LENGTH = Buffer.from(SHELL.toString().replace('/_mw/boot.js', '/_mw/boot.jt'));
// What the check says about a page that is not the listed one but is still the loader shell, or has the listed length.
const CHANGED_404 = /^an unknown path answers HTTP 404: the host serves .+ with sha256 [0-9a-f]{16}\.\.\.; door\.json names .+ with [0-9a-f]{16}\.\.\. \(a stale build, a transformed file or a mixed deploy\)$/;
const CHANGED_INDEX = /^the host serves .+ with sha256 [0-9a-f]{16}\.\.\.; door\.json names .+ with [0-9a-f]{16}\.\.\. \(a stale build, a transformed file or a mixed deploy\)$/;
const STAMP_TEXT = 'the <meta name="mw-pointer"> tag a publish adds: a published site used as a door, not a bare door kit';

// A temporary folder for the one case that runs publish, and a static host for what it writes.
const work = mkdtempSync(join(tmpdir(), 'mw-check-door-'));
after(() => rmSync(work, { recursive: true, force: true }));
let made = 0;
const fresh = (label) => {
  const dir = join(work, label + '-' + ++made);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const writeTree = (root, files) => {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, ...path.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
};

/** The files of a folder as a static host serves them (GitHub Pages): an exact path answers 200 with Access-Control-Allow-Origin: *, any other path the folder's 404.html with status 404. */
async function serveFolder(dir) {
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const file = join(dir, ...path.split('/').filter((s) => s && s !== '..'));
    const hit = path !== '/' && !path.endsWith('/') && existsSync(file);
    const ext = file.slice(file.lastIndexOf('.'));
    res.writeHead(hit ? 200 : 404, { 'content-type': types[ext] || 'text/html', 'access-control-allow-origin': '*' });
    res.end(readFileSync(hit ? file : join(dir, '404.html')));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => { server.closeAllConnections(); server.close(r) }));
  return { url: 'http://127.0.0.1:' + server.address().port + '/' };
}

test('the pages of the root-file cases are what the cases say they are', () => {
  assert.equal(isShellHtml(SHELL), true);
  assert.equal(isShellHtml(STALE), true, 'an old build is still the shell');
  assert.notEqual(STALE.length, SHELL.length);
  assert.equal(SAME_LENGTH.length, SHELL.length);
  assert.equal(isShellHtml(SAME_LENGTH), false, 'a byte inside the script tag: not the shell any more, but the same length');
  assert.equal(isShellHtml(OTHER_PAGE), false);
  assert.ok(stamped(SHELL).length > SHELL.length);
});

test('checkDoor (root files): a listed /mw-sw-kill.js is asked for at its own address and compared byte for byte; a changed byte, a 404, a redirect, no answer and a network error fail; a door.json that does not list it makes no request', async () => {
  const good = await door();
  let res = await checkDoor(good.url, {});
  assert.equal(res.ok, true, JSON.stringify(res.results, null, 1));
  assert.deepEqual(only(res, '/mw-sw-kill.js'), { level: 'ok', step: '/mw-sw-kill.js', message: 'the bytes match door.json' });
  assert.equal(good.seen.filter((s) => s.path === '/mw-sw-kill.js').length, 1);
  // a changed byte: the words the other listed files use
  res = await checkDoor((await door({ flip: 'mw-sw-kill.js' })).url, {});
  assert.equal(res.ok, false);
  assert.equal(only(res, '/mw-sw-kill.js').level, 'fail');
  assert.match(only(res, '/mw-sw-kill.js').message, /^the host serves .+ with sha256 [0-9a-f]{16}\.\.\.; door\.json names .+ with [0-9a-f]{16}\.\.\. \(a transformed file: minifier, image optimiser, compression with changed bytes, or a mixed deploy\)$/);
  // not 200
  res = await checkDoor((await door({ missing: ['mw-sw-kill.js'] })).url, {});
  assert.deepEqual(only(res, '/mw-sw-kill.js'), { level: 'fail', step: '/mw-sw-kill.js', message: 'HTTP 404' });
  res = await checkDoor((await door()).url, { fetch: (url, init) => (/\/mw-sw-kill\.js$/.test(String(url)) ? Promise.resolve(new Response(null, { status: 301, headers: { location: '/elsewhere.js' } })) : fetch(url, init)) });
  assert.deepEqual(only(res, '/mw-sw-kill.js'), { level: 'fail', step: '/mw-sw-kill.js', message: 'HTTP 301' });
  // no answer in time, and a network error
  res = await checkDoor((await door({ hang: ['/mw-sw-kill.js'] })).url, { timeoutMs: 1000 });
  assert.equal(res.ok, false);
  assert.match(only(res, '/mw-sw-kill.js').message, /^cannot fetch http:\/\/127\.0\.0\.1:\d+\/mw-sw-kill\.js: no answer in time$/);
  res = await checkDoor((await door()).url, { fetch: (url, init) => (/\/mw-sw-kill\.js$/.test(String(url)) ? Promise.reject(new TypeError('fetch failed')) : fetch(url, init)) });
  assert.match(only(res, '/mw-sw-kill.js').message, /^cannot fetch http:\/\/127\.0\.0\.1:\d+\/mw-sw-kill\.js: fetch failed$/);
  // a door.json from an older loader, or made by hand, that lists none of the three: no request and no line for them, as before
  const old = await door({ unlisted: ['mw-sw-kill.js', '404.html', 'index.html'] });
  res = await checkDoor(old.url, {});
  assert.equal(res.ok, true, JSON.stringify(res.results, null, 1));
  assert.deepEqual(res.results.map((r) => r.step), ['door', '/mw-sw.js', '/_mw/door.json', 'cors', '/mw-sw.js', '/_mw/*']);
  assert.ok(old.seen.every((s) => s.path === '/mw-sw.js' || s.path.startsWith('/_mw/')), old.seen.map((s) => s.path).join(' '));
  // one at a time: each file is asked for on its own entry
  for (const [name, asked, step] of [['mw-sw-kill.js', '/mw-sw-kill.js', '/mw-sw-kill.js'], ['index.html', '/index.html', '/index.html'], ['404.html', DOOR_CHECK_MISSING_PATH, '/404.html']]) {
    const d = await door({ unlisted: [name] });
    const r = await checkDoor(d.url, {});
    assert.equal(r.ok, true, name);
    assert.deepEqual(lineOf(r, step), [], name + ' is not listed: no line');
    assert.equal(d.seen.some((s) => s.path === asked), false, name + ' is not listed: no request');
    assert.equal(r.results.length, 8, name + ': the two other root files are still read');
  }
});

test('checkDoor (404 page): door.json lists /404.html, a host serves it for a path it does not have, so one made-up path is asked for; what the host answers is judged by what the host explains', async () => {
  const at = async (opts, run) => {
    const d = await door(opts);
    const res = await checkDoor(d.url, run || {});
    return { d, res, line: only(res, '/404.html') };
  };
  assert.equal(DOOR_CHECK_MISSING_PATH, '/felinar-door-check-no-such-file', 'a fixed path: the output is the same on every run');
  // the host of the kit (GitHub Pages, Netlify, Cloudflare Pages): the listed page with status 404
  const lines = [];
  let r = await at({}, { log: (l) => lines.push(l) });
  assert.equal(r.res.ok, true, JSON.stringify(r.res.results, null, 1));
  assert.deepEqual(r.line, { level: 'ok', step: '/404.html', message: 'an unknown path answers HTTP 404 with the page door.json lists' });
  assert.equal(r.d.seen.filter((s) => s.path === DOOR_CHECK_MISSING_PATH).length, 1, 'one request for the made-up path');
  assert.equal(r.d.seen.some((s) => s.path === '/404.html'), false, 'the address /404.html is never asked for: the page is read through a path the host does not have');
  const where = lines.findIndex((l) => l.startsWith('[ok]   /404.html: '));
  assert.equal(lines[where - 1], '  -> GET ' + r.d.url.slice(0, -1) + DOOR_CHECK_MISSING_PATH + ' (a path that does not exist: the host\'s 404 page is read)', 'the target is printed before it is contacted');
  const cases = [
    [{ unknown: 'spa' }, 'info', /^an unknown path answers HTTP 200 with the page door\.json lists: an SPA fallback \(the dev server answers this way\), which is allowed for a shell$/],
    [{ unknown: 'stamped' }, 'info', new RegExp('^an unknown path answers HTTP 404 with the page door\\.json lists plus ' + STAMP_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$')],
    [{ unknown: 'empty' }, 'info', /^an unknown path answers HTTP 404 with no page, not the page door\.json lists: a door needs no 404 page$/],
    [{ unknown: 'other' }, 'info', /^an unknown path answers HTTP 404 with the host's own page \(\d+ B\), not the page door\.json lists: a door needs no 404 page$/],
    [{ unknown: 'redirect' }, 'info', /^the host answers HTTP 302 on an unknown path, so its 404 page is not read here: a door needs no 404 page$/],
    [{ flip: '404.html' }, 'fail', CHANGED_404],
    [{ serve: { '404.html': STALE } }, 'fail', CHANGED_404],
    [{ serve: { '404.html': SAME_LENGTH } }, 'fail', CHANGED_404],
    [{ unknown: 'error' }, 'fail', /^HTTP 503 on an unknown path: a host answers a path it does not have with its 404 page, not with a server error$/],
  ];
  for (const [opts, level, re] of cases) {
    const x = await at(opts);
    const label = JSON.stringify(Object.keys(opts)) + ' ' + JSON.stringify(opts.unknown || '') + ' -> ' + x.line.message;
    assert.equal(x.line.level, level, label);
    assert.match(x.line.message, re, label);
    assert.equal(x.res.ok, level !== 'fail', label);
    assert.equal(x.res.failures, level === 'fail' ? 1 : 0, label);
    assert.equal(x.res.warnings, 0, label + ': a host that explains itself is an info line, never a warning');
    assert.ok(ASCII.test(x.line.message) && !WORDING.test(x.line.message), label);
  }
  // no answer, and a network error
  r = await at({}, { fetch: (url, init) => (String(url).endsWith(DOOR_CHECK_MISSING_PATH) ? Promise.reject(new TypeError('fetch failed')) : fetch(url, init)) });
  assert.equal(r.line.level, 'fail');
  assert.match(r.line.message, /^cannot fetch http:\/\/127\.0\.0\.1:\d+\/felinar-door-check-no-such-file: fetch failed$/);
  r = await at({ hang: [DOOR_CHECK_MISSING_PATH] }, { timeoutMs: 1000 });
  assert.equal(r.line.level, 'fail');
  assert.match(r.line.message, /^cannot fetch http:\/\/127\.0\.0\.1:\d+\/felinar-door-check-no-such-file: no answer in time$/);
});

test('checkDoor (index.html): compared where the host serves it; where the host redirects or does not serve it, the line says why and where the same bytes are checked', async () => {
  const at = async (opts, run) => {
    const d = await door(opts);
    const res = await checkDoor(d.url, run || {});
    return { d, res, line: only(res, '/index.html') };
  };
  const cannot = (status, tail) => 'the host answers HTTP ' + status + ' here, so this page cannot be read at this address; ' + tail;
  // GitHub Pages and the dev server serve it
  let r = await at({});
  assert.deepEqual(r.line, { level: 'ok', step: '/index.html', message: 'the bytes match door.json' });
  assert.equal(r.d.seen.filter((s) => s.path === '/index.html').length, 1);
  // Cloudflare Pages answers 308: nobody receives these bytes at this address, and door.json lists the bytes of /404.html, which are checked
  r = await at({ cleanUrls: true });
  assert.deepEqual(r.line, { level: 'info', step: '/index.html', message: cannot(308, 'door.json lists the same bytes as /404.html, which is checked at an unknown path') });
  assert.equal(r.res.ok, true);
  assert.equal(r.res.warnings, 0);
  // not served at all
  r = await at({ missing: ['index.html'] });
  assert.deepEqual(r.line, { level: 'info', step: '/index.html', message: cannot(404, 'door.json lists the same bytes as /404.html, which is checked at an unknown path') });
  // a host with no 404 page of the build (the kit's Caddyfile has no rule for it): the line does not claim a check that did not happen
  r = await at({ cleanUrls: true, unknown: 'empty' });
  assert.equal(only(r.res, '/404.html').level, 'info');
  assert.deepEqual(r.line, { level: 'info', step: '/index.html', message: cannot(308, 'door.json lists the same bytes as /404.html, which could not be read at an unknown path on this host either (see the /404.html line)') });
  // a door.json that lists /index.html and not /404.html
  r = await at({ cleanUrls: true, unlisted: ['404.html'] });
  assert.deepEqual(r.line, { level: 'info', step: '/index.html', message: cannot(308, 'door.json does not list /404.html, so these bytes are not compared anywhere') });
  // the two entries differ in door.json although a build lists one page under both names: a warning, and the door still passes
  r = await at({ cleanUrls: true, built: { 'index.html': STALE } });
  assert.deepEqual(r.line, { level: 'warn', step: '/index.html', message: cannot(308, 'door.json lists other bytes for /index.html than for /404.html, and a build lists the same page under both names: check that this door.json is the one the build wrote') });
  assert.equal(r.res.ok, true, 'a warning does not fail the door');
  assert.equal(r.res.warnings, 1);
  // a host that serves it with other bytes: a changed byte, a stale build
  for (const opts of [{ flip: 'index.html' }, { serve: { 'index.html': STALE } }, { serve: { 'index.html': SAME_LENGTH } }]) {
    r = await at(opts);
    assert.equal(r.line.level, 'fail', JSON.stringify(Object.keys(opts)));
    assert.match(r.line.message, CHANGED_INDEX);
    assert.equal(r.res.ok, false);
    assert.equal(r.res.failures, 1);
  }
  // the pointer tag a publish adds, and the host's own page
  r = await at({ serve: { 'index.html': stamped(SHELL) } });
  assert.deepEqual(r.line, { level: 'info', step: '/index.html', message: 'the host serves the page door.json lists plus ' + STAMP_TEXT });
  r = await at({ serve: { 'index.html': OTHER_PAGE } });
  assert.deepEqual(r.line, { level: 'info', step: '/index.html', message: 'the host serves its own page (' + OTHER_PAGE.length + ' B) here and not the page door.json lists: a door does not have to serve this page' });
  // a server error, a network error, no answer
  r = await at({}, { fetch: (url, init) => (/\/index\.html$/.test(String(url)) ? Promise.resolve(new Response('unavailable', { status: 503 })) : fetch(url, init)) });
  assert.deepEqual(r.line, { level: 'fail', step: '/index.html', message: 'HTTP 503' });
  r = await at({}, { fetch: (url, init) => (/\/index\.html$/.test(String(url)) ? Promise.reject(new TypeError('fetch failed')) : fetch(url, init)) });
  assert.match(r.line.message, /^cannot fetch http:\/\/127\.0\.0\.1:\d+\/index\.html: fetch failed$/);
  r = await at({ hang: ['/index.html'] }, { timeoutMs: 1000 });
  assert.match(r.line.message, /^cannot fetch http:\/\/127\.0\.0\.1:\d+\/index\.html: no answer in time$/);
});

test('withoutPointerStamp: takes out the pointer tag a publish adds and nothing else; the round trip with stampHtml gives the page back; a page without the tag is unchanged', () => {
  const pages = {
    'a shell with a head and a charset': SHELL,
    'no head tag': Buffer.from('<!doctype html><title>x</title><p>hello</p>\n'),
    'no doctype and no html tag': Buffer.from('<p>a fragment</p>'),
    'a byte order mark': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), SHELL]),
    'bytes above 0x7f': Buffer.concat([Buffer.from('<!doctype html><html><head><title>'), Buffer.from([0xe9, 0xe8, 0xff]), Buffer.from('</title></head><body></body></html>')]),
    'other meta tags, and a comment and a script that name the tag': Buffer.from('<!doctype html><html><head><meta name="description" content="x"><!-- <meta name="mw-pointer" content="old"> --><script>var t = \'<meta name="mw-pointer" content="in a script">\'</script></head><body></body></html>'),
    'the loader shell of this repository': readFileSync(join(ROOT, 'src', 'loader', 'index.html')),
  };
  for (const [label, page] of Object.entries(pages)) {
    const withTag = stamped(page);
    assert.ok(withTag.length > page.length, label + ': stampHtml adds the tag');
    const back = withoutPointerStamp(withTag);
    assert.equal(Buffer.compare(back, page), 0, label + ': the round trip');
    assert.equal(Buffer.compare(withoutPointerStamp(back), back), 0, label + ': idempotent');
    assert.equal(Buffer.compare(withoutPointerStamp(page), page), 0, label + ': a page without the tag is unchanged');
  }
  // every tag of that name goes (any case, spaces round the name), the other tags stay, and the answer is bytes
  const two = Buffer.from('<head><META NAME=" MW-Pointer " CONTENT=x><meta name="mw-shell" content="1"><meta name="mw-pointer" content="y"></head>');
  assert.equal(withoutPointerStamp(two).toString('latin1'), '<head><meta name="mw-shell" content="1"></head>');
  assert.ok(Buffer.isBuffer(withoutPointerStamp(new Uint8Array(two))));
  assert.equal(withoutPointerStamp(Buffer.alloc(0)).length, 0);
});

test('checkDoor (a published site used as a door): publish --shell stamps index.html and 404.html after door.json lists them; the check explains the tag and fails nothing, and a changed copy of a stamped page still fails', async () => {
  const dist = fresh('dist');
  const built = new Map([
    ['index.html', SHELL],
    ['404.html', SHELL],
    ['mw-sw.js', Buffer.from('// sw\n')],
    ['mw-sw-kill.js', Buffer.from('// kill\n')],
    ['_mw/boot.js', Buffer.from('// boot\n')],
    ['_mw/loader.js', Buffer.from('// loader\n')],
    ['_mw/open.html', Buffer.from('<!doctype html><title>Loading site</title><link rel="manifest" href="/_mw/door.webmanifest">')],
  ]);
  for (const [path, bytes] of built) writeTree(dist, { [path]: bytes });
  writeTree(dist, { '_mw/door.json': doorJson(built, { version: '0.3.0', buildId: 'abcdef123456' }), 'build.json': '{"version":"0.3.0"}\n' });
  const site = fresh('site');
  writeTree(site, { 'index.html': '<!doctype html><html><head><meta charset="utf-8"><title>Home</title></head><body><h1>Home</h1></body></html>\n' });
  const key = join(work, 'owner.jwk');
  await keygen({ out: key });
  const published = await publish({
    dir: site, name: 'my-site', scope: 'example.com', key, tr: ['wss://tracker.example'], ws: ['https://static.example/ws/'],
    out: fresh('out'), now: Date.UTC(2026, 10, 1, 12, 0, 30), quiet: true, shell: true, dist,
  });
  const shell = join(published.outDir, 'shell');
  // the premise: door.json lists the build's pages, and the pages on disk are those pages plus the tag
  for (const page of ['index.html', '404.html']) {
    const onDisk = readFileSync(join(shell, page));
    assert.ok(onDisk.length > SHELL.length, page + ' is stamped');
    assert.equal(Buffer.compare(withoutPointerStamp(onDisk), SHELL), 0, page);
  }
  const host = await serveFolder(shell);
  const res = await checkDoor(host.url, {});
  assert.equal(res.ok, true, JSON.stringify(res.results, null, 1));
  assert.equal(res.warnings, 0);
  assert.deepEqual(only(res, '/404.html'), { level: 'info', step: '/404.html', message: 'an unknown path answers HTTP 404 with the page door.json lists plus ' + STAMP_TEXT });
  assert.deepEqual(only(res, '/index.html'), { level: 'info', step: '/index.html', message: 'the host serves the page door.json lists plus ' + STAMP_TEXT });
  assert.equal(only(res, '/mw-sw-kill.js').level, 'ok');
  assert.equal(only(res, '/_mw/*').level, 'ok');
  // a changed byte in a stamped page: still the loader shell, no longer the listed one
  const page = readFileSync(join(shell, 'index.html'));
  writeFileSync(join(shell, 'index.html'), Buffer.from(page.toString('latin1').replace('<title>Loading site</title>', '<title>Loading sitf</title>'), 'latin1'));
  const bad = await checkDoor(host.url, {});
  assert.equal(bad.ok, false);
  assert.equal(only(bad, '/index.html').level, 'fail');
  assert.equal(only(bad, '/404.html').level, 'info', 'the other page is untouched');
});

test('checkDoor (cors): a header that is present but joined or wrong is told apart from a missing one and quotes its value; --allow-no-cors makes only the missing one a warning', async () => {
  const at = async (opts, run) => {
    const res = await checkDoor((await door(opts)).url, run || {});
    return { res, line: only(res, 'cors') };
  };
  const joined = (shown) => 'Access-Control-Allow-Origin on /_mw/door.json is "' + shown + '", not "*": two rules or two headers set it and the host joined them into one value, which browsers refuse, so other doors see this one as "answering, not checked" (set it once per path: the kit\'s _headers does)';
  const wrong = (shown) => 'Access-Control-Allow-Origin on /_mw/door.json is "' + shown + '", not "*": other doors see this one as "answering, not checked" (the header must be * on this file)';
  // the 2026-11-01 bug: two rules that Cloudflare Pages joined (two header lines and one joined line read the same)
  for (const corsValue of [['*', '*'], '*, *']) {
    const r = await at({ corsValue });
    assert.deepEqual(r.line, { level: 'fail', step: 'cors', message: joined('*, *') }, JSON.stringify(corsValue));
    assert.equal(r.res.ok, false);
    assert.doesNotMatch(r.line.message, /^no Access-Control-Allow-Origin/);
    const flag = await at({ corsValue }, { allowNoCors: true });
    assert.equal(flag.line.level, 'fail', '--allow-no-cors is for a missing header, not for a header that is wrong');
    assert.equal(flag.res.ok, false);
  }
  // another origin, with and without the flag
  for (const run of [{}, { allowNoCors: true }]) {
    const r = await at({ corsValue: 'https://other.example' }, run);
    assert.deepEqual(r.line, { level: 'fail', step: 'cors', message: wrong('https://other.example') });
    assert.equal(r.res.ok, false);
  }
  assert.equal((await at({ corsValue: '' })).line.message, wrong(''), 'present and empty is not the same as missing');
  // the origin the check sends is accepted (a host that echoes it), as is *
  assert.equal((await at({ corsValue: DOOR_CHECK_ORIGIN })).line.level, 'ok');
  assert.equal((await at({})).line.level, 'ok');
  // a long value is cut at 80 characters, and what is not printable ASCII is not printed
  assert.equal((await at({ corsValue: 'x'.repeat(200) })).line.message, wrong('x'.repeat(80) + '...'));
  assert.equal((await at({ corsValue: ('*, ').repeat(100) })).line.message, joined(('*, ').repeat(100).slice(0, 80) + '...'));
  const latin = await at({ corsValue: 'caf\xe9' });
  assert.equal(latin.line.message, wrong('caf?'));
  assert.ok(ASCII.test(latin.line.message));
  // missing: today's words and today's rule
  const absent = await at({ cors: false });
  assert.deepEqual(absent.line, { level: 'fail', step: 'cors', message: 'no Access-Control-Allow-Origin on /_mw/door.json: other doors see this one as "answering, not checked" (add the header: the kit\'s _headers, vercel.json or Caddyfile do; for a host that cannot send it, use --allow-no-cors)' });
  const allowed = await at({ cors: false }, { allowNoCors: true });
  assert.equal(allowed.line.level, 'warn');
  assert.equal(allowed.res.ok, true);
  for (const x of [absent, allowed]) assert.ok(ASCII.test(x.line.message) && !WORDING.test(x.line.message));
});

test('checkDoor: the step names and levels that scripts read stay put, and a lab-like door gains exactly three lines and no warning', async () => {
  // a door as the lab door is served: clean URLs (Cloudflare Pages), an apps block with the relay-first words, usage reports
  const apps = { rendezvous: ['wss://rtc.example.org'], stun: ['stun:stun.example.org:3478'], idp: 'https://id.example.org', relay: 'rendezvous', direct: 'off' };
  const d = await door({ cleanUrls: true, apps, obs: { endpoint: 'https://obs.example.org' } });
  const res = await checkDoor(d.url, {});
  assert.equal(res.ok, true, JSON.stringify(res.results, null, 1));
  assert.equal(res.failures, 0);
  assert.equal(res.warnings, 0, 'a good lab door has no warning (the post-deploy script of a lab run treats one as a failure)');
  const steps = res.results.map((r) => r.level + ' ' + r.step);
  // the nine results of before, in the order of before
  assert.deepEqual(steps.slice(0, 9), ['ok door', 'ok /mw-sw.js', 'ok /_mw/door.json', 'info apps', 'info door', 'ok cors', 'ok /mw-sw.js', 'info /_mw/open.html', 'ok /_mw/*']);
  // then three new ones, each with a step of its own
  assert.deepEqual(steps.slice(9), ['ok /404.html', 'info /index.html', 'ok /mw-sw-kill.js']);
  assert.equal(res.results.length, 12);
  // what the post-deploy script of a lab run reads: exactly one ok '/_mw/*' line that starts with the count, exactly one info line for the
  // door page, the words of the apps line, one usage reports line, and a worker line that says the bytes match
  const files = res.results.filter((r) => r.level === 'ok' && r.step === '/_mw/*');
  assert.equal(files.length, 1);
  assert.match(files[0].message, /^\d+ file\(s\) match door\.json byte for byte$/);
  assert.equal(res.results.filter((r) => r.level === 'info' && r.step === '/_mw/open.html').length, 1);
  const appsLines = res.results.filter((r) => r.level === 'info' && r.step === 'apps');
  assert.equal(appsLines.length, 1);
  assert.match(appsLines[0].message, /relay rendezvous, direct off/);
  assert.match(appsLines[0].message, /rendezvous 1/);
  assert.equal(res.results.filter((r) => r.level === 'info' && r.step === 'door' && /usage reports to obs\.example\.org/.test(r.message)).length, 1);
  assert.ok(res.results.some((r) => r.level === 'ok' && r.step === '/mw-sw.js' && /bytes match door\.json/.test(r.message)));
  // the shape of a result, and the words
  for (const r of res.results) {
    assert.deepEqual(Object.keys(r), ['level', 'step', 'message']);
    assert.ok(['ok', 'info', 'warn', 'fail'].includes(r.level));
    assert.ok(ASCII.test(r.message) && !WORDING.test(r.message), r.step + ': ' + r.message);
  }
  assert.ok(d.seen.every(askedFor), d.seen.map((s) => s.path).join(' '));
});

test('checkDoor (the controls of the 8.2 audit): a changed byte in /index.html, /404.html or /mw-sw-kill.js on the host fails the door; where the host redirects /index.html the change cannot be seen, and the line says so', async () => {
  const fails = async (opts, step) => {
    const res = await checkDoor((await door(opts)).url, {});
    assert.equal(res.ok, false, step);
    assert.equal(only(res, step).level, 'fail', step);
    assert.equal(res.failures, 1, JSON.stringify(res.results, null, 1));
  };
  await fails({ flip: 'index.html' }, '/index.html'); // vi-a: a host that serves it (GitHub Pages, the dev server)
  await fails({ flip: '404.html' }, '/404.html'); // vi-b
  await fails({ flip: 'mw-sw-kill.js' }, '/mw-sw-kill.js'); // vi-c
  // the clean-URL variant of vi-a: nobody receives the bytes at this address, and a change to them cannot be seen there (docs/DEPLOY.md says so)
  const limit = await checkDoor((await door({ cleanUrls: true, flip: 'index.html' })).url, {});
  assert.equal(limit.ok, true);
  assert.equal(only(limit, '/index.html').level, 'info');
  assert.match(only(limit, '/index.html').message, /cannot be read at this address/);
});

/** A door in another process (spawnSync blocks this one) that answers as the kit's host does. kind 'bad' changes one byte of the kill file and of the 404 page. */
async function cliDoor(kind) {
  const script = [
    "const http = require('node:http');",
    "const files = " + JSON.stringify(Array.from(doorFiles()).map(([k, v]) => [k, v.toString('base64')])) + ";",
    "const dj = " + JSON.stringify(doorJson(doorFiles(), { version: '0.3.0', buildId: 'abcdef123456' }).toString('base64')) + ";",
    "const map = new Map(files.map(([k, v]) => [k, Buffer.from(v, 'base64')]));",
    "if (process.argv[1] === 'bad') for (const k of ['mw-sw-kill.js', '404.html']) { const b = Buffer.from(map.get(k)); b[0] ^= 1; map.set(k, b) }",
    "const s = http.createServer((q, r) => { const p = new URL(q.url, 'http://x').pathname; if (p === '/_mw/door.json') { r.writeHead(200, { 'access-control-allow-origin': '*' }); return r.end(Buffer.from(dj, 'base64')) } const k = p.slice(1); if (!map.has(k)) { r.writeHead(404); return r.end(map.get('404.html')) } r.writeHead(200, { 'content-type': k.endsWith('.js') ? 'text/javascript' : 'text/html' }); r.end(map.get(k)) });",
    "s.listen(0, '127.0.0.1', () => { process.stdout.write(String(s.address().port) + '\\n') });",
  ].join('\n');
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script, kind], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.once('data', (d) => resolve({ port: Number(String(d).trim()), child }));
  });
}

test('CLI: check-site --door names the root files it reads in its Will contact line, prints the three lines, and --json carries their steps; a changed kill file and 404 page exit 1', async () => {
  const { port, child } = await cliDoor('good');
  try {
    const url = 'http://127.0.0.1:' + port + '/';
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'check-site.mjs'), url, '--door'], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr + r.stdout.slice(0, 600));
    assert.match(r.stdout, /^Will contact: http:\/\/127\.0\.0\.1:\d+ only \(\/mw-sw\.js, \/_mw\/door\.json and every \/_mw\/ file it lists; when door\.json lists them, also \/mw-sw-kill\.js, \/index\.html and, to read the 404 page, one made-up path, \/felinar-door-check-no-such-file; /m);
    assert.match(r.stdout, /the addresses of an apps block are read, never contacted, and neither is the endpoint of an obs block/);
    assert.match(r.stdout, /^  -> GET http:\/\/127\.0\.0\.1:\d+\/felinar-door-check-no-such-file \(a path that does not exist: the host's 404 page is read\)$/m);
    assert.match(r.stdout, /^\[ok\]   \/404\.html: an unknown path answers HTTP 404 with the page door\.json lists$/m);
    assert.match(r.stdout, /^  -> GET http:\/\/127\.0\.0\.1:\d+\/index\.html$/m);
    assert.match(r.stdout, /^\[ok\]   \/index\.html: the bytes match door\.json$/m);
    assert.match(r.stdout, /^  -> GET http:\/\/127\.0\.0\.1:\d+\/mw-sw-kill\.js$/m);
    assert.match(r.stdout, /^\[ok\]   \/mw-sw-kill\.js: the bytes match door\.json$/m);
    assert.match(r.stdout, /^OK: 0 failure\(s\), 0 warning\(s\)\.$/m);
    assert.doesNotMatch(r.stdout, BANNED);
    const json = spawnSync(process.execPath, [join(ROOT, 'tools', 'check-site.mjs'), url, '--door', '--json'], { encoding: 'utf8', timeout: 60000 });
    const out = JSON.parse(json.stdout);
    assert.deepEqual(Object.keys(out), ['url', 'door', 'ok', 'failures', 'warnings', 'results']);
    assert.deepEqual(out.results.slice(-3).map((x) => x.level + ' ' + x.step), ['ok /404.html', 'ok /index.html', 'ok /mw-sw-kill.js']);
  } finally {
    child.kill();
  }
  const bad = await cliDoor('bad');
  try {
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'check-site.mjs'), 'http://127.0.0.1:' + bad.port + '/', '--door'], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 1, r.stderr + r.stdout.slice(0, 600));
    assert.match(r.stdout, /^\[FAIL\] \/404\.html: an unknown path answers HTTP 404: the host serves /m);
    assert.match(r.stdout, /^\[FAIL\] \/mw-sw-kill\.js: the host serves /m);
    assert.match(r.stdout, /^\[ok\]   \/index\.html: the bytes match door\.json$/m, 'the page that was not changed passes');
    assert.match(r.stdout, /^FAILED: 2 failure\(s\), 0 warning\(s\)\.$/m);
  } finally {
    bad.child.kill();
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
    "const s = http.createServer((q, r) => { const p = new URL(q.url, 'http://x').pathname; if (p === '/_mw/door.json') { r.writeHead(200, { 'access-control-allow-origin': '*' }); return r.end(Buffer.from(dj, 'base64')) } const k = p.slice(1); if (!map.has(k)) { r.writeHead(404); return r.end(map.get('404.html')) } r.writeHead(200, { 'content-type': k.endsWith('.js') ? 'text/javascript' : 'text/html' }); r.end(map.get(k)) });",
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
