// Unit tests for the apps flags of tools/dev-server.mjs and tools/demo.mjs (docs/DEPLOY.md, "Apps at a door"):
// --apps-rendezvous, --apps-stun and --apps-idp add the apps block to the /_mw/door.json the dev server sends, and the demo passes them when it
// has a tracker and an identity page. Servers listen on 127.0.0.1 with ephemeral ports and are closed in after(); nothing else is contacted.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

import { createDevServer } from '../../tools/dev-server.mjs';
import { planDemo, demoAppsOptions, runDemo } from '../../tools/demo.mjs';
import { checkDoor } from '../../tools/check-site.mjs';
import { withoutAppsBlock } from '../../tools/apps-block.mjs';
import { UsageError, ROOT } from '../../tools/lib.mjs';
import { doorJson } from '../../build.mjs';

const work = mkdtempSync(join(tmpdir(), 'mw-dev-apps-'));
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
const BANNED = /blockchain|serverless|unstoppable|censorship|production-ready|[\u2013\u2014\u2018\u2019\u201c\u201d]/i;

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

const RENDEZVOUS = ['ws://127.0.0.1:8000'];
const STUN = ['stun:127.0.0.1:3478'];
const IDP = 'http://127.0.0.1:8081';
const BLOCK = { rendezvous: RENDEZVOUS, stun: STUN, idp: IDP };
const APPS = { appsRendezvous: RENDEZVOUS, appsStun: STUN, appsIdp: IDP };

async function start(options) {
  const s = await createDevServer(Object.assign({ port: 0, quiet: true }, options));
  stoppers.push(() => s.close());
  return s;
}
const get = (server, path, init) => fetch(server.url.replace(/\/$/, '') + path, init);

// ---------------------------------------------------------------------------------------------- dev server

test('without the apps flags door.json is served exactly as built, and the result holds no block', async () => {
  const root = doorRoot();
  const s = await start({ root });
  assert.equal(s.apps, null);
  const res = await get(s, '/_mw/door.json');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(Buffer.from(await res.arrayBuffer()).equals(readFileSync(join(root, '_mw', 'door.json'))), true);
  // flags that are empty (the command line gives empty lists) are not a request for a block
  const empty = await start({ root, appsRendezvous: [], appsStun: [], appsIdp: [] });
  assert.equal(empty.apps, null);
  assert.equal(Buffer.from(await (await get(empty, '/_mw/door.json')).arrayBuffer()).equals(readFileSync(join(root, '_mw', 'door.json'))), true);
});

test('with the apps flags /_mw/door.json carries the block as its last key; CORS and no-cache stay; the file under --root is not changed', async () => {
  const root = doorRoot();
  const built = readFileSync(join(root, '_mw', 'door.json'));
  const s = await start(Object.assign({ root }, APPS));
  assert.deepEqual(s.apps, BLOCK);
  const res = await get(s, '/_mw/door.json', { headers: { origin: 'https://other.example' } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const bytes = Buffer.from(await res.arrayBuffer());
  const parsed = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(parsed.apps, BLOCK);
  assert.equal(Object.keys(parsed).pop(), 'apps');
  assert.equal(withoutAppsBlock(bytes).equals(built), true, 'the rest of the file is the build\'s door.json');
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

test('the file is read again on every request (a rebuild shows at once); a block already in it is replaced', async () => {
  const root = doorRoot();
  const s = await start(Object.assign({ root }, APPS));
  const first = await (await get(s, '/_mw/door.json')).json();
  assert.equal(first.buildId, 'abcdef123456');
  const file = join(root, '_mw', 'door.json');
  const next = JSON.parse(readFileSync(file, 'utf8'));
  next.buildId = 'fedcba654321';
  next.apps = { rendezvous: ['wss://old.example'], stun: [], idp: 'https://old-id.example' };
  writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  const second = await (await get(s, '/_mw/door.json')).json();
  assert.equal(second.buildId, 'fedcba654321');
  assert.deepEqual(second.apps, BLOCK, 'the flags win over a block in the file');
  assert.deepEqual(Object.keys(second).filter((k) => k === 'apps'), ['apps'], 'one apps key');
});

test('a door.json that is not JSON is served as it is with a log line; a root without one answers 404 as before', async () => {
  const root = doorRoot();
  writeFileSync(join(root, '_mw', 'door.json'), '<html>not a door list</html>');
  const lines = [];
  const s = await start(Object.assign({ root, quiet: false, log: (l) => lines.push(String(l)) }, APPS));
  const res = await get(s, '/_mw/door.json');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<html>not a door list</html>');
  assert.ok(lines.some((l) => /\/_mw\/door\.json: _mw\/door\.json is not JSON.*served without the apps block/.test(l)), lines.join('\n'));
  const bare = fresh('bare');
  writeTree(bare, { 'index.html': '<!doctype html><title>x</title>' });
  const none = await start(Object.assign({ root: bare, spa: false }, APPS));
  assert.equal((await get(none, '/_mw/door.json')).status, 404);
});

test('refusals: a block that cannot be used stops the server before it listens, and the message names the flag', async () => {
  const root = doorRoot();
  const refuse = (extra, re) => assert.rejects(createDevServer(Object.assign({ root, port: 0, quiet: true }, extra)), (err) => err instanceof UsageError && re.test(err.message), JSON.stringify(extra));
  await refuse({ appsRendezvous: RENDEZVOUS }, /--apps-idp is needed/);
  await refuse({ appsIdp: IDP }, /--apps-rendezvous is needed/);
  await refuse({ appsStun: STUN }, /--apps-rendezvous is needed/);
  await refuse({ appsRendezvous: ['ws://rtc.example.org'], appsIdp: IDP }, /--apps-rendezvous\[0\] is ws: on a host that is not loopback/);
  await refuse({ appsRendezvous: ['https://rtc.example.org'], appsIdp: IDP }, /--apps-rendezvous\[0\] must be a wss: URL/);
  await refuse({ appsRendezvous: RENDEZVOUS, appsIdp: 'http://id.example.org' }, /--apps-idp is not an origin/);
  await refuse({ appsRendezvous: RENDEZVOUS, appsIdp: [IDP, 'http://localhost:9'] }, /--apps-idp takes one origin, got 2/);
  await refuse({ appsRendezvous: RENDEZVOUS, appsStun: ['turn:t.example'], appsIdp: IDP }, /--apps-stun\[0\] is not a stun: or stuns: URL/);
  await refuse({ appsRendezvous: Array.from({ length: 9 }, (_, i) => 'wss://r' + i + '.example'), appsIdp: IDP }, /--apps-rendezvous has 9 entries; at most 8/);
});

test('values may be strings, comma lists or lists; the same value twice counts once; wss: and https: need no loopback', async () => {
  const root = doorRoot();
  const s = await start({ root, appsRendezvous: 'wss://a.example/pair, wss://b.example', appsStun: ['stuns:s.example:5349', 'stuns:s.example:5349'], appsIdp: ['https://id.example.org', 'https://id.example.org'] });
  assert.deepEqual(s.apps, { rendezvous: ['wss://a.example/pair', 'wss://b.example'], stun: ['stuns:s.example:5349'], idp: 'https://id.example.org' });
  assert.deepEqual((await (await get(s, '/_mw/door.json')).json()).apps, s.apps);
  const noStun = await start({ root, appsRendezvous: RENDEZVOUS, appsIdp: IDP });
  assert.deepEqual(noStun.apps.stun, [], 'no STUN: browsers on one network connect with host candidates');
});

test('check-site --door against the dev server: the door passes and the apps line names the block; nothing outside the door is contacted', async () => {
  const root = doorRoot();
  const s = await start(Object.assign({ root }, APPS));
  const seen = [];
  const res = await checkDoor(s.url, { fetch: (url, init) => { seen.push(String(url)); return fetch(url, init); } });
  assert.equal(res.ok, true, JSON.stringify(res.results, null, 1));
  const apps = res.results.find((r) => r.step === 'apps');
  assert.deepEqual(apps, { level: 'info', step: 'apps', message: 'rendezvous 1, stun 1, identity http://127.0.0.1:8081' });
  assert.deepEqual(res.door.apps, BLOCK);
  assert.ok(seen.length > 0 && seen.every((u) => u.startsWith(s.url.replace(/\/$/, '') + '/')), 'only the door itself: ' + seen.join(' '));
  // the same server without the flags: a good door with no apps line
  const plain = await start({ root });
  const plainRes = await checkDoor(plain.url, {});
  assert.equal(plainRes.ok, true);
  assert.equal(plainRes.results.some((r) => r.step === 'apps'), false);
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

test('command line: repeated --apps-rendezvous and --apps-stun, --apps-idp; --json names the block and the page serves it', async () => {
  const root = doorRoot();
  const { child, first } = await startCli(['--root', root, '--port', '0', '--json', '--quiet',
    '--apps-rendezvous', 'ws://127.0.0.1:8000', '--apps-rendezvous', 'ws://localhost:8001', '--apps-stun', 'stun:127.0.0.1:3478', '--apps-idp', IDP, '--apps-idp', IDP]);
  const info = JSON.parse(first);
  assert.deepEqual(info.apps, { rendezvous: ['ws://127.0.0.1:8000', 'ws://localhost:8001'], stun: ['stun:127.0.0.1:3478'], idp: IDP });
  const door = await (await fetch(info.url + '_mw/door.json')).json();
  assert.deepEqual(door.apps, info.apps);
  assert.equal(await stopCli(child), 0);
});

test('command line: the plain output names the block; no flags, no apps in the JSON', async () => {
  const root = doorRoot();
  const plainRun = await startCli(['--root', root, '--port', '0', '--json', '--quiet']);
  assert.equal('apps' in JSON.parse(plainRun.first), false);
  assert.equal(await stopCli(plainRun.child), 0);
  const child = spawn(process.execPath, ['tools/dev-server.mjs', '--root', root, '--port', '0', '--quiet', ...['--apps-rendezvous', RENDEZVOUS[0], '--apps-idp', IDP]], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  stoppers.push(async () => { child.kill('SIGKILL'); });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no apps line: ' + out)), 8000);
    child.stdout.on('data', (d) => {
      out += d;
      if (/apps block in \/_mw\/door\.json/.test(out)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  assert.match(out, /apps block in \/_mw\/door\.json: rendezvous 1, stun 0, identity http:\/\/127\.0\.0\.1:8081 \(the door page offers the apps\)/);
  child.removeAllListeners('exit');
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  child.kill('SIGTERM');
  assert.equal(await exited, 0);
});

test('command line: a block that cannot be used exits 2 and names the flag; --help lists the three flags', () => {
  const root = doorRoot();
  const noIdp = spawnSync(process.execPath, ['tools/dev-server.mjs', '--root', root, '--port', '0', '--apps-rendezvous', 'wss://rtc.example.org'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(noIdp.status, 2);
  assert.match(noIdp.stderr, /--apps-idp is needed/);
  const twoIdp = spawnSync(process.execPath, ['tools/dev-server.mjs', '--root', root, '--port', '0', '--apps-rendezvous', 'wss://rtc.example.org', '--apps-idp', 'https://a.example', '--apps-idp', 'https://b.example'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(twoIdp.status, 2);
  assert.match(twoIdp.stderr, /--apps-idp takes one origin, got 2/);
  const help = spawnSync(process.execPath, ['tools/dev-server.mjs', '--help'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(help.status, 0);
  for (const flag of ['--apps-rendezvous <url>', '--apps-stun <url>', '--apps-idp <origin>']) assert.ok(help.stdout.includes(flag), flag);
  assert.doesNotMatch(help.stdout, BANNED);
  // Polish P7 4.10 (S28): a STUN server is asked only when direct links are on; by default the page makes no peer connection
  assert.ok(help.stdout.replace(/\s+/g, ' ').includes('--apps-stun <url> a stun: or stuns: URL for the apps block (repeat; at most 8; used only when --apps-direct is on; none: browsers on one network connect with host candidates)'), help.stdout);
});

// ---------------------------------------------------------------------------------------------- the demo

test('demoAppsOptions: the demo\'s tracker is the rendezvous, the identity page is where a visitor signs in; no identity page, no block', () => {
  const desktop = planDemo({ port: 8080, trackerPort: 8000 });
  assert.deepEqual(demoAppsOptions({ plan: desktop, idp: { origin: 'http://localhost:8081' } }), { appsRendezvous: ['ws://localhost:8000'], appsStun: [], appsIdp: 'http://localhost:8081' });
  assert.deepEqual(demoAppsOptions({ plan: desktop, stun: ['stun:stun.example.org:3478'], idp: { origin: 'http://localhost:8081' } }).appsStun, ['stun:stun.example.org:3478']);
  assert.equal(demoAppsOptions({ plan: desktop, idp: null }), null);
  assert.equal(demoAppsOptions({ plan: desktop }), null);
  // the LAN tier runs no identity page, so it offers no apps; with one it would name the tracker on the page's own origin
  const lan = planDemo({ tls: true, port: 8443, trackerPort: 8001, lan: ['192.0.2.20'] });
  assert.equal(demoAppsOptions({ plan: lan, idp: null }), null);
  assert.deepEqual(demoAppsOptions({ plan: lan, idp: { origin: 'https://192.0.2.20:8444' } }).appsRendezvous, ['wss://192.0.2.20:8443/tracker']);
});

test('runDemo (no browser, no build): the dev server sends the apps block; --stun is carried; without an identity page there is none', async () => {
  const dist = doorRoot();
  const idpDist = fresh('idp-dist');
  writeTree(idpDist, { 'index.html': '<!doctype html><title>Identity</title>' });
  const lines = [];
  const demo = await runDemo({
    port: 0, trackerPort: 0, seeder: 'none', build: false, dist, idpDist, dir: join(work, 'demo-with'), stun: ['stun:stun.example.org:3478'], log: (l) => lines.push(String(l)),
  });
  stoppers.push(() => demo.stop());
  assert.deepEqual(demo.apps, { rendezvous: [demo.plan.trackerUrl], stun: ['stun:stun.example.org:3478'], idp: demo.idp.origin });
  assert.match(demo.plan.trackerUrl, /^ws:\/\/localhost:\d+$/);
  assert.match(demo.idp.origin, /^http:\/\/localhost:\d+$/);
  const door = await (await fetch(demo.dev.url + '_mw/door.json')).json();
  assert.deepEqual(door.apps, demo.apps);
  assert.equal(door.buildId, 'abcdef123456', 'the rest of door.json is the build\'s');
  const line = lines.find((l) => /^apps: the door page /.test(l));
  assert.ok(line, lines.join('\n'));
  assert.match(line, new RegExp('^apps: the door page ' + demo.plan.origin.replace(/[.]/g, '\\.') + '/_mw/open\\.html offers the apps \\(rendezvous 1, stun 1, identity ' + demo.idp.origin.replace(/[.]/g, '\\.') + '\\)$'));
  assert.doesNotMatch(lines.join('\n'), BANNED);

  // Polish P7 4.10 (S27): the note about host candidates is about direct links, so it is printed only when the block's resolved direct is "on".
  // Without keys the page applies its defaults, relay rendezvous and direct off: it makes no peer connection and asks no STUN server, so the
  // demo says nothing about one.
  const noStunLines = [];
  const plain = await runDemo({ port: 0, trackerPort: 0, seeder: 'none', build: false, dist, idpDist, dir: join(work, 'demo-plain'), log: (l) => noStunLines.push(String(l)) });
  stoppers.push(() => plain.stop());
  assert.deepEqual(plain.apps.stun, []);
  const plainLine = noStunLines.find((l) => /^apps: the door page /.test(l));
  assert.ok(plainLine, noStunLines.join('\n'));
  assert.match(plainLine, /offers the apps \(rendezvous 1, stun 0, identity http:\/\/localhost:\d+\)$/, 'no keys, direct off by default: no note about a STUN server');
  assert.doesNotMatch(noStunLines.join('\n'), /host candidates|no STUN server/);

  // direct on and no STUN server named: the note is true (browsers then connect with host candidates) and is printed. "relay none" alone
  // means direct on in the page's reading (appsTransportOf), so the note is printed for it too; with a STUN server named it is not.
  const noteFor = async (label, options) => {
    const got = [];
    const run = await runDemo(Object.assign({ port: 0, trackerPort: 0, seeder: 'none', build: false, dist, idpDist, dir: join(work, 'demo-note-' + label), log: (l) => got.push(String(l)) }, options));
    stoppers.push(() => run.stop());
    const line = got.find((l) => /^apps: the door page /.test(l));
    assert.ok(line, label + ': ' + got.join('\n'));
    return line;
  };
  assert.match(await noteFor('direct-on', { appsDirect: 'on' }), /\(rendezvous 1, stun 0, identity http:\/\/localhost:\d+, relay rendezvous, direct on; no STUN server, so browsers connect with host candidates; --stun names one\)$/);
  assert.match(await noteFor('relay-none', { appsRelay: 'none' }), /, relay none, direct on; no STUN server, so browsers connect with host candidates; --stun names one\)$/);
  assert.doesNotMatch(await noteFor('direct-on-stun', { appsDirect: 'on', stun: ['stun:stun.example.org:3478'] }), /no STUN server|host candidates/);
  assert.doesNotMatch(await noteFor('direct-off-explicit', { appsRelay: 'rendezvous', appsDirect: 'off' }), /no STUN server|host candidates/);

  const noIdpLines = [];
  const noIdp = await runDemo({ port: 0, trackerPort: 0, seeder: 'none', build: false, dist, idp: false, dir: join(work, 'demo-noidp'), log: (l) => noIdpLines.push(String(l)) });
  stoppers.push(() => noIdp.stop());
  assert.equal(noIdp.apps, null);
  assert.equal((await (await fetch(noIdp.dev.url + '_mw/door.json')).json()).apps, undefined);
  assert.ok(noIdpLines.some((l) => /^apps: not offered \(there is no identity page to sign in at\)$/.test(l)), noIdpLines.join('\n'));
  await assert.rejects(runDemo({ port: 0, trackerPort: 0, seeder: 'none', build: false, dist, idpDist, dir: join(work, 'demo-bad'), stun: ['turn:t.example'], log: () => {} }), UsageError);
});

test('demo --help lists --stun', () => {
  const help = spawnSync(process.execPath, ['tools/demo.mjs', '--help'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /\[--stun <stun: URL>\]\.\.\./);
  assert.match(help.stdout, /^--stun {6}a STUN server for the apps block of the door page/m);
  assert.doesNotMatch(help.stdout, BANNED);
  // Polish P7 4.10 (S26): the entry says when the STUN server matters, and no longer says that browsers connect with host candidates "without it"
  const flat = help.stdout.replace(/\s+/g, ' ');
  assert.ok(flat.includes('It matters only with --apps-direct on: by default the page makes no peer connection and asks no STUN server.'), help.stdout);
  assert.ok(flat.includes('with direct on and none named, browsers connect with host candidates'), help.stdout);
  assert.doesNotMatch(flat, /The demo runs none: without it browsers connect with host/);
});

// ---------------------------------------------------------------------------------------------- relay-first tokens (plan 3.9)

const WITH_TOKENS = Object.assign({}, BLOCK, { relay: 'rendezvous', direct: 'off' });

test('--apps-relay and --apps-direct: the tokens are in the block of /_mw/door.json after idp; without them the block has the three keys it had; an empty flag is no flag', async () => {
  const root = doorRoot();
  const built = readFileSync(join(root, '_mw', 'door.json'));
  const s = await start(Object.assign({ root, appsRelay: 'rendezvous', appsDirect: 'off' }, APPS));
  assert.deepEqual(s.apps, WITH_TOKENS);
  assert.deepEqual(Object.keys(s.apps), ['rendezvous', 'stun', 'idp', 'relay', 'direct']);
  const bytes = Buffer.from(await (await get(s, '/_mw/door.json')).arrayBuffer());
  const parsed = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(parsed.apps, WITH_TOKENS);
  assert.equal(withoutAppsBlock(bytes).equals(built), true, 'the rest of the file is the build\'s door.json');
  assert.equal(readFileSync(join(root, '_mw', 'door.json')).equals(built), true, 'nothing is written under --root');
  assert.deepEqual(Object.keys((await start(Object.assign({ root }, APPS))).apps), ['rendezvous', 'stun', 'idp']);
  assert.deepEqual(Object.keys((await start(Object.assign({ root, appsRelay: null, appsDirect: '' }, APPS))).apps), ['rendezvous', 'stun', 'idp']);
  assert.deepEqual((await start(Object.assign({ root, appsRelay: 'none' }, APPS))).apps, Object.assign({}, BLOCK, { relay: 'none' }), 'relay none alone: direct on is the page\'s reading');
  assert.deepEqual((await start(Object.assign({ root, appsDirect: ['on', 'on'] }, APPS))).apps, Object.assign({}, BLOCK, { direct: 'on' }));
});

test('refusals: a token the page does not know, a second value or the pair none + off stops the server before it listens and names the flag; the tokens alone need the rest of the block', async () => {
  const root = doorRoot();
  const refuse = (extra, re) => assert.rejects(createDevServer(Object.assign({ root, port: 0, quiet: true }, extra)), (err) => err instanceof UsageError && re.test(err.message), JSON.stringify(extra));
  await refuse(Object.assign({ appsRelay: 'cloudflare' }, APPS), /--apps-relay is not "rendezvous" or "none"/);
  await refuse(Object.assign({ appsDirect: 'sometimes' }, APPS), /--apps-direct is not "off" or "on"/);
  await refuse(Object.assign({ appsRelay: 'none', appsDirect: 'off' }, APPS), /no way to connect: relay "none" with direct "off"/);
  await refuse(Object.assign({ appsRelay: ['none', 'rendezvous'] }, APPS), /--apps-relay takes one value, got 2/);
  await refuse({ appsRelay: 'none' }, /--apps-rendezvous is needed/);
  await refuse({ appsDirect: 'on' }, /--apps-rendezvous is needed/);
});

test('check-site --door against a dev server with the tokens: the apps line names them, resolved as the page does', async () => {
  const root = doorRoot();
  const seen = async (extra) => {
    const s = await start(Object.assign({ root }, APPS, extra));
    const res = await checkDoor(s.url, {});
    assert.equal(res.ok, true, JSON.stringify(res.results, null, 1));
    return res.results.find((r) => r.step === 'apps');
  };
  assert.deepEqual(await seen({ appsRelay: 'rendezvous', appsDirect: 'off' }), { level: 'info', step: 'apps', message: 'rendezvous 1, stun 1, identity http://127.0.0.1:8081, relay rendezvous, direct off' });
  assert.equal((await seen({ appsDirect: 'on' })).message, 'rendezvous 1, stun 1, identity http://127.0.0.1:8081, relay rendezvous, direct on');
  assert.equal((await seen({ appsRelay: 'none' })).message, 'rendezvous 1, stun 1, identity http://127.0.0.1:8081, relay none, direct on');
  assert.equal((await seen({})).message, 'rendezvous 1, stun 1, identity http://127.0.0.1:8081', 'no tokens: the line it always was');
});

test('command line: --apps-relay and --apps-direct reach the block, the --json output and the plain line; a bad token exits 2; --help lists them', async () => {
  const root = doorRoot();
  const { child, first } = await startCli(['--root', root, '--port', '0', '--json', '--quiet', '--apps-rendezvous', RENDEZVOUS[0], '--apps-idp', IDP, '--apps-relay', 'rendezvous', '--apps-direct', 'on']);
  const info = JSON.parse(first);
  assert.deepEqual(info.apps, { rendezvous: RENDEZVOUS, stun: [], idp: IDP, relay: 'rendezvous', direct: 'on' });
  assert.deepEqual((await (await fetch(info.url + '_mw/door.json')).json()).apps, info.apps);
  assert.equal(await stopCli(child), 0);
  const plain = spawn(process.execPath, ['tools/dev-server.mjs', '--root', root, '--port', '0', '--quiet', '--apps-rendezvous', RENDEZVOUS[0], '--apps-idp', IDP, '--apps-relay', 'none'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  stoppers.push(async () => { plain.kill('SIGKILL'); });
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no apps line: ' + out)), 8000);
    plain.stdout.on('data', (d) => {
      out += d;
      if (/apps block in \/_mw\/door\.json/.test(out)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  assert.match(out, /apps block in \/_mw\/door\.json: rendezvous 1, stun 0, identity http:\/\/127\.0\.0\.1:8081, relay none, direct on \(the door page offers the apps\)/);
  plain.removeAllListeners('exit');
  const exited = new Promise((resolve) => plain.once('exit', (code) => resolve(code)));
  plain.kill('SIGTERM');
  assert.equal(await exited, 0);
  const bad = spawnSync(process.execPath, ['tools/dev-server.mjs', '--root', root, '--port', '0', '--apps-rendezvous', 'wss://rtc.example.org', '--apps-idp', 'https://id.example.org', '--apps-direct', 'maybe'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--apps-direct is not "off" or "on"/);
  const help = spawnSync(process.execPath, ['tools/dev-server.mjs', '--help'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(help.status, 0);
  for (const flag of ['--apps-relay <rendezvous|none>', '--apps-direct <off|on>']) assert.ok(help.stdout.includes(flag), flag);
  assert.doesNotMatch(help.stdout, BANNED);
});

test('demoAppsOptions and runDemo pass relay and direct on to the dev server; the demo line names them; a bad token stops the demo; demo --help lists the flags', async () => {
  const desktop = planDemo({ port: 8080, trackerPort: 8000 });
  const idp = { origin: 'http://localhost:8081' };
  assert.deepEqual(demoAppsOptions({ plan: desktop, idp }), { appsRendezvous: ['ws://localhost:8000'], appsStun: [], appsIdp: 'http://localhost:8081' }, 'without the options: exactly the three');
  assert.deepEqual(demoAppsOptions({ plan: desktop, idp, relay: 'rendezvous', direct: 'on' }),
    { appsRendezvous: ['ws://localhost:8000'], appsStun: [], appsIdp: 'http://localhost:8081', appsRelay: 'rendezvous', appsDirect: 'on' });
  assert.deepEqual(demoAppsOptions({ plan: desktop, idp, relay: 'none' }).appsRelay, 'none');
  assert.equal('appsDirect' in demoAppsOptions({ plan: desktop, idp, relay: 'none' }), false);
  assert.throws(() => demoAppsOptions({ plan: desktop, idp, relay: 'cloudflare' }), (err) => err instanceof UsageError && /--apps-relay is not "rendezvous" or "none"/.test(err.message));
  assert.equal(demoAppsOptions({ plan: desktop, idp: null, relay: 'none' }), null, 'no identity page, no block');

  const dist = doorRoot();
  const idpDist = fresh('idp-dist');
  writeTree(idpDist, { 'index.html': '<!doctype html><title>Identity</title>' });
  const lines = [];
  const demo = await runDemo({ port: 0, trackerPort: 0, seeder: 'none', build: false, dist, idpDist, dir: join(work, 'demo-tokens'), appsRelay: 'rendezvous', appsDirect: 'off', log: (l) => lines.push(String(l)) });
  stoppers.push(() => demo.stop());
  assert.deepEqual(demo.apps, { rendezvous: [demo.plan.trackerUrl], stun: [], idp: demo.idp.origin, relay: 'rendezvous', direct: 'off' });
  assert.deepEqual((await (await fetch(demo.dev.url + '_mw/door.json')).json()).apps, demo.apps);
  assert.match(lines.find((l) => /^apps: the door page /.test(l)), /offers the apps \(rendezvous 1, stun 0, identity http:\/\/localhost:\d+, relay rendezvous, direct off\)$/, 'direct off, said or not: no note about a STUN server (polish P7 4.10, S27)');
  assert.doesNotMatch(lines.join('\n'), BANNED);
  // a bad token stops the demo, with or without an identity page, and nothing keeps running (a demo that starts anyway is stopped here, then the test fails)
  const refuseDemo = async (options, re) => {
    let started = null;
    try {
      started = await runDemo(Object.assign({ port: 0, trackerPort: 0, seeder: 'none', build: false, dist, log: () => {} }, options));
    } catch (err) {
      assert.ok(err instanceof UsageError && re.test(err.message), String(err && err.message));
      return;
    }
    await started.stop();
    assert.fail('the demo started although ' + Object.keys(options).join(', ') + ' cannot be used');
  };
  await refuseDemo({ idpDist, dir: join(work, 'demo-bad-token'), appsDirect: 'maybe' }, /--apps-direct is not "off" or "on"/);
  await refuseDemo({ idp: false, dir: join(work, 'demo-bad-token-2'), appsRelay: 'none', appsDirect: 'off' }, /no way to connect/);
  // an identity page that is not there: the tokens have no block to join, and the demo says so
  const noIdpLines = [];
  const noIdp = await runDemo({ port: 0, trackerPort: 0, seeder: 'none', build: false, dist, idp: false, dir: join(work, 'demo-noidp-tokens'), appsDirect: 'on', log: (l) => noIdpLines.push(String(l)) });
  stoppers.push(() => noIdp.stop());
  assert.equal(noIdp.apps, null);
  assert.ok(noIdpLines.some((l) => /^apps: not offered /.test(l) && /--apps-direct is not used/.test(l)), noIdpLines.join('\n'));
  const help = spawnSync(process.execPath, ['tools/demo.mjs', '--help'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /\[--apps-relay rendezvous\|none\] \[--apps-direct off\|on\]/);
  assert.match(help.stdout, /^--apps-relay, --apps-direct {2}how messages travel/m);
  assert.doesNotMatch(help.stdout, BANNED);
});
