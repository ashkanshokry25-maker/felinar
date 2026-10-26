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
import { doorJson } from '../../build.mjs';
import { ROOT } from '../../tools/lib.mjs';

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

/** A door on 127.0.0.1. opts: { cors, swRedirect, swType, flip: path, noDoorJson, blockPage }. */
async function door(opts = {}) {
  const files = doorFiles();
  const dj = doorJson(files, { version: '0.3.0', buildId: 'abcdef123456' });
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
    const key = path.slice(1);
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
