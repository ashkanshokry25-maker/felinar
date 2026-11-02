// Unit tests for the --obs flag of tools/dev-server.mjs (docs/DEPLOY.md, "Usage reports"): --obs <origin> adds the obs block to the
// /_mw/door.json the dev server sends, on its own or beside the apps block, without changing the file under --root. Servers listen on
// 127.0.0.1 with ephemeral ports and are closed in after(); the endpoint named in a test is a loopback server that counts what reaches it,
// so "nothing contacts the endpoint" is measured, not assumed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

import { createDevServer } from '../../tools/dev-server.mjs';
import { checkDoor } from '../../tools/check-site.mjs';
import { withoutObsBlock, withoutAppsBlock } from '../../tools/apps-block.mjs';
import { UsageError, ROOT } from '../../tools/lib.mjs';
import { doorJson } from '../../build.mjs';
import { checkDoorJson } from '../../src/loader/doors.js';

const work = mkdtempSync(join(tmpdir(), 'mw-dev-obs-'));
const stoppers = [];
after(async () => {
  for (const s of stoppers.reverse()) await s();
  rmSync(work, { recursive: true, force: true });
});
let counter = 0;
const fresh = (label) => {
  const dir = join(work, label + '-' + ++counter);
  mkdirSync(dir, { recursive: true });
  return dir;
};
function writeTree(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, ...path.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}
const BANNED = /blockchain|serverless|unstoppable|censorship|production-ready|fully decentralized|sub-second|[\u2013\u2014\u2018\u2019\u201c\u201d]/i;

/** The files of a door as build.mjs writes them, door.json included (the build's own doorJson, so its bytes are the real format). */
function doorRoot() {
  const root = fresh('root');
  const files = new Map([
    ['index.html', Buffer.from('<!doctype html><title>Loading site</title>')],
    ['mw-sw.js', Buffer.from('// the worker\n')],
    ['_mw/open.html', Buffer.from('<!doctype html><title>Loading site</title><link rel="manifest" href="/_mw/door.webmanifest">')],
    ['_mw/loader.js', Buffer.from('// the loader\n'.repeat(20))],
    ['_mw/boot.js', Buffer.from('// boot\n')],
  ]);
  for (const [path, bytes] of files) writeTree(root, { [path]: bytes });
  writeTree(root, { '_mw/door.json': doorJson(files, { version: '0.3.0', buildId: 'abcdef123456' }) });
  return root;
}

/** A stand-in for the report endpoint on 127.0.0.1: it answers 204 to anything and counts every request that reaches it. */
async function collector() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.method + ' ' + req.url);
    res.writeHead(204);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  stoppers.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { seen, origin: 'http://127.0.0.1:' + server.address().port };
}

const OBS_ORIGIN = 'http://127.0.0.1:8787';
const OBS = { endpoint: OBS_ORIGIN };
const APPS = { appsRendezvous: ['ws://127.0.0.1:8000'], appsStun: ['stun:127.0.0.1:3478'], appsIdp: 'http://127.0.0.1:8081' };
const APPS_BLOCK = { rendezvous: ['ws://127.0.0.1:8000'], stun: ['stun:127.0.0.1:3478'], idp: 'http://127.0.0.1:8081' };

async function start(options) {
  const s = await createDevServer(Object.assign({ port: 0, quiet: true }, options));
  stoppers.push(() => s.close());
  return s;
}
const get = (server, path, init) => fetch(server.url.replace(/\/$/, '') + path, init);

// ---------------------------------------------------------------------------------------------- dev server

test('without --obs door.json is served exactly as built, and the result holds no obs block', async () => {
  const root = doorRoot();
  const s = await start({ root });
  assert.equal(s.obs, null);
  const res = await get(s, '/_mw/door.json');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(Buffer.from(await res.arrayBuffer()).equals(readFileSync(join(root, '_mw', 'door.json'))), true);
  // empty values (the command line gives null) are no request for a block
  for (const empty of [null, '', []]) {
    const e = await start({ root, obs: empty });
    assert.equal(e.obs, null, JSON.stringify(empty));
    assert.equal(Buffer.from(await (await get(e, '/_mw/door.json')).arrayBuffer()).equals(readFileSync(join(root, '_mw', 'door.json'))), true);
  }
});

test('with --obs /_mw/door.json carries the block as its last key; CORS and no-cache stay; the file under --root is not changed', async () => {
  const root = doorRoot();
  const built = readFileSync(join(root, '_mw', 'door.json'));
  const s = await start({ root, obs: OBS_ORIGIN });
  assert.deepEqual(s.obs, OBS);
  assert.equal(s.apps, null, 'the reports need none of the --apps-* flags');
  const res = await get(s, '/_mw/door.json', { headers: { origin: 'https://other.example' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const bytes = Buffer.from(await res.arrayBuffer());
  const parsed = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(parsed.obs, OBS);
  assert.equal(Object.keys(parsed).pop(), 'obs');
  assert.equal('apps' in parsed, false);
  assert.equal(withoutObsBlock(bytes).equals(built), true, 'the rest of the file is the build\'s door.json');
  const page = checkDoorJson(parsed);
  assert.equal(page.ok, true, 'the page reads it as a door list: ' + page.reason);
  if (Object.prototype.hasOwnProperty.call(page, 'obs') || Object.prototype.hasOwnProperty.call(page, 'obsReason')) assert.deepEqual(page.obs, OBS, 'the page finds the block usable (lane L2)');
  assert.equal(readFileSync(join(root, '_mw', 'door.json')).equals(built), true, 'nothing is written under --root');
  assert.equal(res.headers.get('content-length'), String(bytes.length));
  // HEAD: the same headers and no body
  const head = await get(s, '/_mw/door.json', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(bytes.length));
  assert.equal(head.headers.get('access-control-allow-origin'), '*');
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  // every other path is served as before
  const loader = await get(s, '/_mw/loader.js');
  assert.equal(loader.headers.get('access-control-allow-origin'), null);
  assert.equal(await loader.text(), '// the loader\n'.repeat(20));
});

test('https and loopback origins are taken as they are; a trailing slash is dropped; a list holding one origin is one origin', async () => {
  const root = doorRoot();
  for (const [given, endpoint] of [
    ['https://obs.example.org', 'https://obs.example.org'],
    ['https://obs.example.org:8443', 'https://obs.example.org:8443'],
    ['http://localhost:8787', 'http://localhost:8787'],
    ['http://[::1]:8787', 'http://[::1]:8787'],
    ['http://127.0.0.1:8787/', 'http://127.0.0.1:8787'],
    [['https://obs.example.org', 'https://obs.example.org/'], 'https://obs.example.org'],
  ]) {
    const s = await start({ root, obs: given });
    assert.deepEqual(s.obs, { endpoint }, JSON.stringify(given));
    assert.deepEqual((await (await get(s, '/_mw/door.json')).json()).obs, { endpoint }, JSON.stringify(given));
  }
});

test('the file is read again on every request (a rebuild shows at once); a block already in it is replaced', async () => {
  const root = doorRoot();
  const s = await start({ root, obs: OBS_ORIGIN });
  const first = await (await get(s, '/_mw/door.json')).json();
  assert.equal(first.buildId, 'abcdef123456');
  const file = join(root, '_mw', 'door.json');
  const next = JSON.parse(readFileSync(file, 'utf8'));
  next.buildId = 'fedcba654321';
  next.obs = { endpoint: 'https://old-obs.example.org' };
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  const second = await (await get(s, '/_mw/door.json')).json();
  assert.equal(second.buildId, 'fedcba654321');
  assert.deepEqual(second.obs, OBS, 'the flag wins over a block in the file');
  assert.deepEqual(Object.keys(second).filter((k) => k === 'obs'), ['obs'], 'one obs key');
});

test('with the apps flags too: both blocks, apps first; each flag alone leaves the other block as the file has it', async () => {
  const root = doorRoot();
  const built = readFileSync(join(root, '_mw', 'door.json'));
  const both = await start(Object.assign({ root, obs: OBS_ORIGIN }, APPS));
  assert.deepEqual(both.obs, OBS);
  assert.deepEqual(both.apps, APPS_BLOCK);
  const bytes = Buffer.from(await (await get(both, '/_mw/door.json')).arrayBuffer());
  const parsed = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(Object.keys(parsed).slice(-2), ['apps', 'obs']);
  assert.deepEqual(parsed.apps, APPS_BLOCK);
  assert.deepEqual(parsed.obs, OBS);
  assert.equal(withoutObsBlock(withoutAppsBlock(bytes)).equals(built), true, 'the rest of the file is the build\'s door.json');
  // the apps flags without --obs: the file's own obs block (if it had one) is not touched
  const file = join(root, '_mw', 'door.json');
  const withFileObs = JSON.parse(built.toString('utf8'));
  withFileObs.obs = { endpoint: 'https://file-obs.example.org' };
  writeFileSync(file, JSON.stringify(withFileObs, null, 2) + '\n');
  const appsOnly = await start(Object.assign({ root }, APPS));
  const served = await (await get(appsOnly, '/_mw/door.json')).json();
  assert.deepEqual(served.obs, { endpoint: 'https://file-obs.example.org' });
  assert.deepEqual(served.apps, APPS_BLOCK);
  assert.deepEqual(Object.keys(served).slice(-2), ['apps', 'obs']);
});

test('a door.json that is not JSON is served as it is with a log line; a root without one answers 404 as before', async () => {
  const root = doorRoot();
  writeFileSync(join(root, '_mw', 'door.json'), '<html>not a door list</html>');
  const lines = [];
  const s = await start({ root, obs: OBS_ORIGIN, quiet: false, log: (l) => lines.push(String(l)) });
  const res = await get(s, '/_mw/door.json');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<html>not a door list</html>');
  assert.ok(lines.some((l) => /\/_mw\/door\.json: _mw\/door\.json is not JSON.*served without the obs block$/.test(l)), lines.join('\n'));
  const both = [];
  const b = await start(Object.assign({ root, obs: OBS_ORIGIN, quiet: false, log: (l) => both.push(String(l)) }, APPS));
  await get(b, '/_mw/door.json');
  assert.ok(both.some((l) => /served without the apps and obs blocks$/.test(l)), both.join('\n'));
  const bare = fresh('bare');
  writeTree(bare, { 'index.html': '<!doctype html><title>x</title>' });
  const none = await start({ root: bare, spa: false, obs: OBS_ORIGIN });
  assert.equal((await get(none, '/_mw/door.json')).status, 404);
});

test('refusals: an origin that cannot be used stops the server before it listens, and the message names the flag', async () => {
  const root = doorRoot();
  // A server that starts when it should have refused is closed again, so that the failure is reported and the run does not hang.
  const refuse = async (obs, re) => {
    let started = null;
    try {
      started = await createDevServer({ root, port: 0, quiet: true, obs });
    } catch (err) {
      assert.ok(err instanceof UsageError && re.test(err.message), JSON.stringify(obs) + ' -> ' + err.message);
      return;
    }
    await started.close();
    assert.fail('the server started for ' + JSON.stringify(obs));
  };
  await refuse('http://obs.example.org', /--obs is http: on a host that is not loopback/);
  await refuse('http://127.0.0.2:8787', /--obs is http: on a host that is not loopback/);
  await refuse('https://obs.example.org/e', /--obs is not an exact origin/);
  await refuse('https://user:pw@obs.example.org', /--obs carries a user name or password/);
  await refuse('https://obs.example.org#x', /--obs carries a fragment/);
  await refuse('ftp://obs.example.org', /--obs must be an https: origin/);
  await refuse('obs.example.org', /--obs is not an absolute URL/);
  await refuse(['https://a.example', 'https://b.example'], /--obs takes one origin, got 2/);
  // a bad apps flag still names its own flag when --obs is fine
  await assert.rejects(createDevServer({ root, port: 0, quiet: true, obs: OBS_ORIGIN, appsRendezvous: ['ws://rtc.example.org'], appsIdp: 'http://127.0.0.1:8081' }), /--apps-rendezvous\[0\] is ws: on a host that is not loopback/);
});

test('check-site --door against the dev server: the door passes and one line names the host; the endpoint, a server that counts, is never contacted', async () => {
  const root = doorRoot();
  const sink = await collector();
  const s = await start({ root, obs: sink.origin });
  const fetched = [];
  const res = await checkDoor(s.url, { fetch: (url, init) => { fetched.push(String(url)); return fetch(url, init); } });
  assert.equal(res.ok, true, JSON.stringify(res.results, null, 1));
  const line = res.results.filter((r) => r.level === 'info' && /usage reports/.test(r.message));
  assert.deepEqual(line, [{ level: 'info', step: 'door', message: 'usage reports to 127.0.0.1' }]);
  assert.deepEqual(res.door.obs, { endpoint: sink.origin });
  assert.ok(fetched.length > 0 && fetched.every((u) => u.startsWith(s.url.replace(/\/$/, '') + '/')), 'only the door itself: ' + fetched.join(' '));
  assert.deepEqual(sink.seen, [], 'nothing reached the endpoint');
  // the same server without the flag: a good door with no such line
  const plain = await start({ root });
  const plainRes = await checkDoor(plain.url, {});
  assert.equal(plainRes.ok, true);
  assert.equal(plainRes.results.some((r) => /usage reports/.test(r.message)), false);
});

// ---------------------------------------------------------------------------------------------- the command line

function startCli(args) {
  const child = spawn(process.execPath, ['tools/dev-server.mjs', ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  stoppers.push(async () => { child.kill('SIGKILL'); });
  let out = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no output: ' + out)), 8000);
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('\n')) {
        clearTimeout(timer);
        resolve({ child, first: out.split('\n')[0] });
      }
    });
    child.once('exit', (code) => reject(new Error('exited early ' + code + ': ' + out)));
  });
}
async function stopCli(child) {
  child.removeAllListeners('exit');
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  child.kill('SIGTERM');
  return exited;
}

test('command line: --obs with --json names the block and the page serves it; without the flag there is no obs in the JSON', async () => {
  const root = doorRoot();
  const { child, first } = await startCli(['--root', root, '--port', '0', '--json', '--quiet', '--obs', OBS_ORIGIN]);
  const info = JSON.parse(first);
  assert.deepEqual(info.obs, OBS);
  assert.equal('apps' in info, false);
  const door = await (await fetch(info.url + '_mw/door.json')).json();
  assert.deepEqual(door.obs, OBS);
  assert.equal(await stopCli(child), 0);
  const inline = await startCli(['--root', root, '--port', '0', '--json', '--quiet', '--obs=https://obs.example.org']);
  assert.deepEqual(JSON.parse(inline.first).obs, { endpoint: 'https://obs.example.org' });
  assert.equal(await stopCli(inline.child), 0);
  const plainRun = await startCli(['--root', root, '--port', '0', '--json', '--quiet']);
  assert.equal('obs' in JSON.parse(plainRun.first), false);
  assert.equal(await stopCli(plainRun.child), 0);
});

test('command line: the plain output names the block and the condition; the apps flags and --obs together print both lines', async () => {
  const root = doorRoot();
  const child = spawn(process.execPath, ['tools/dev-server.mjs', '--root', root, '--port', '0', '--quiet', '--obs', OBS_ORIGIN, '--apps-rendezvous', APPS.appsRendezvous[0], '--apps-idp', APPS.appsIdp], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  stoppers.push(async () => { child.kill('SIGKILL'); });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no obs line: ' + out)), 8000);
    child.stdout.on('data', (d) => {
      out += d;
      if (/obs block in \/_mw\/door\.json/.test(out)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  assert.match(out, /^ {2}obs block in \/_mw\/door\.json: usage reports to 127\.0\.0\.1 \(the loader sends reports there once a visitor agrees\)$/m);
  assert.match(out, /^ {2}apps block in \/_mw\/door\.json: rendezvous 1, stun 0, identity http:\/\/127\.0\.0\.1:8081 \(the door page offers the apps\)$/m);
  assert.doesNotMatch(out, BANNED);
  child.removeAllListeners('exit');
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
});

// The timeout is there so that a server that starts when it should have refused ends this test with a failure, not a hang.
test('command line: an origin that cannot be used exits 2 and names the flag; --obs needs a value; --help lists the flag', () => {
  const root = doorRoot();
  const http1 = spawnSync(process.execPath, ['tools/dev-server.mjs', '--root', root, '--port', '0', '--obs', 'http://obs.example.org'], { cwd: ROOT, encoding: 'utf8', timeout: 20000 });
  assert.equal(http1.status, 2);
  assert.match(http1.stderr, /--obs is http: on a host that is not loopback/);
  const path = spawnSync(process.execPath, ['tools/dev-server.mjs', '--root', root, '--port', '0', '--obs', 'https://obs.example.org/e'], { cwd: ROOT, encoding: 'utf8', timeout: 20000 });
  assert.equal(path.status, 2);
  assert.match(path.stderr, /--obs is not an exact origin/);
  const noValue = spawnSync(process.execPath, ['tools/dev-server.mjs', '--root', root, '--port', '0', '--obs'], { cwd: ROOT, encoding: 'utf8', timeout: 20000 });
  assert.equal(noValue.status, 2);
  assert.match(noValue.stderr, /--obs needs a value/);
  const help = spawnSync(process.execPath, ['tools/dev-server.mjs', '--help'], { cwd: ROOT, encoding: 'utf8', timeout: 20000 });
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes('--obs <origin>  the obs block of /_mw/door.json'), help.stdout);
  assert.match(help.stdout, /\[--apps-idp <origin>\] \[--obs <origin>\] \[--quiet\] \[--json\]/);
  assert.match(help.stdout, /needs none of the --apps-\* flags/);
  assert.doesNotMatch(help.stdout, BANNED);
  assert.equal(/[^\x00-\x7f]/.test(help.stdout), false, 'ASCII only');
});
