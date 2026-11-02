// Unit tests for the apps block of the door page (docs/DEPLOY.md, "Apps at a door"): the shape module
// tools/apps-block.mjs, tools/publish.mjs (--tracker, --stun and --idp give summary.json an apps block and, with --shell, the shell's
// /_mw/door.json), and the door kit (--door-kit --door-site copies the first door site's block into the kit's /_mw/door.json, the one loader
// file that then differs from the signed release). No network: everything runs in temporary directories; the hosts are example names.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { publish, doorKit, doorKitFiles } from '../../tools/publish.mjs';
import { keygen } from '../../tools/keygen.mjs';
import { loadOwnerKey, UsageError, ToolError, ROOT } from '../../tools/lib.mjs';
import { buildHashList, signList, verifyRelease } from '../../tools/verify-release.mjs';
import {
  appsBlockProblems, makeAppsBlock, appsBlockLine, withAppsBlock, withoutAppsBlock, APPS_RENDEZVOUS_MAX, APPS_STUN_MAX,
} from '../../tools/apps-block.mjs';
import { doorJson } from '../../build.mjs';
import { appsBlockOf } from '../../src/loader/doors.js';

const work = mkdtempSync(join(tmpdir(), 'mw-apps-publish-'));
after(() => rmSync(work, { recursive: true, force: true }));
const NOW = Date.UTC(2026, 10, 1, 12, 0, 30);
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
let keyCounter = 0;
async function makeKey() {
  const file = join(work, 'owner-' + ++keyCounter + '.jwk');
  const res = await keygen({ out: file });
  return { file, pub: res.pub };
}
const BANNED = /blockchain|serverless|unstoppable|censorship|production-ready|[\u2013\u2014\u2018\u2019\u201c\u201d]/i;

const BLOCK = { rendezvous: ['wss://rtc.example.org'], stun: ['stun:stun.example.org:3478'], idp: 'https://id.example.org' };
const FLAGS = { tracker: BLOCK.rendezvous.slice(), stun: BLOCK.stun.slice(), idp: BLOCK.idp };

function makeSite() {
  const dir = fresh('site');
  writeTree(dir, { 'index.html': '<!doctype html><html><head><meta charset="utf-8"><title>Home</title></head><body><h1>Home</h1></body></html>\n', 'css/app.css': 'body { margin: 0 }\n' });
  return dir;
}
async function run(extra = {}) {
  const key = extra.key || (await makeKey()).file;
  return publish(Object.assign({
    dir: makeSite(), name: 'my-site', scope: 'example.com', key, tr: ['wss://tracker.example'], ws: ['https://static.example/ws/'],
    out: fresh('out'), now: NOW, quiet: true,
  }, extra));
}

/** A loader build as build.mjs writes it: door.json comes from the build's own doorJson, so its bytes are the real format. */
function fakeDist({ withDoorJson = true } = {}) {
  const dist = fresh('dist');
  const files = new Map([
    ['index.html', Buffer.from('<!doctype html><html><head><meta charset="utf-8"><title>Loading site</title></head><body><script src="/_mw/boot.js"></script></body></html>')],
    ['404.html', Buffer.from('<!doctype html><html><head><title>Loading site</title></head><body></body></html>')],
    ['mw-sw.js', Buffer.from('// sw\n')],
    ['mw-sw-kill.js', Buffer.from('// kill\n')],
    ['_mw/boot.js', Buffer.from('// boot\n')],
    ['_mw/loader.js', Buffer.from('// loader\n')],
    ['_mw/open.html', Buffer.from('<!doctype html><title>Loading site</title><link rel="manifest" href="/_mw/door.webmanifest">')],
  ]);
  for (const [path, bytes] of files) writeTree(dist, { [path]: bytes });
  if (withDoorJson) writeTree(dist, { '_mw/door.json': doorJson(files, { version: '0.3.0', buildId: 'abcdef123456' }) });
  writeTree(dist, { 'build.json': '{"version":"0.3.0"}\n' });
  return dist;
}

// ---------------------------------------------------------------------------------------------- the shape of the block

test('appsBlockProblems: rendezvous is 1 to 8 wss: URLs (ws: only on a loopback host), stun 0 to 8 stun: URLs, idp an origin', () => {
  assert.deepEqual(appsBlockProblems(BLOCK), []);
  assert.deepEqual(appsBlockProblems({ rendezvous: ['wss://rtc.example.org/pair', 'ws://127.0.0.1:8000', 'ws://localhost:8000', 'ws://[::1]:8000'], stun: [], idp: 'http://127.0.0.1:8081' }), [],
    'a path is fine, an empty STUN list is fine, loopback ws: and http: are for development');
  assert.deepEqual(appsBlockProblems({ rendezvous: ['wss://a.example'], stun: ['stuns:s.example:5349'], idp: 'https://id.example.org:8443' }), []);
  const bad = (block, re) => {
    const problems = appsBlockProblems(block);
    assert.ok(problems.length > 0 && problems.some((p) => re.test(p)), JSON.stringify(block) + ' -> ' + JSON.stringify(problems));
  };
  for (const notBlock of [null, undefined, 'x', 7, [], [BLOCK]]) assert.deepEqual(appsBlockProblems(notBlock), ['the apps block is not an object']);
  bad({ stun: [], idp: BLOCK.idp }, /rendezvous is not a list/);
  bad({ rendezvous: [], stun: [], idp: BLOCK.idp }, /rendezvous is empty/);
  bad({ rendezvous: Array.from({ length: APPS_RENDEZVOUS_MAX + 1 }, (_, i) => 'wss://r' + i + '.example'), stun: [], idp: BLOCK.idp }, /rendezvous has 9 entries; at most 8/);
  bad({ rendezvous: ['ws://rtc.example.org'], stun: [], idp: BLOCK.idp }, /rendezvous\[0\] is ws: on a host that is not loopback/);
  bad({ rendezvous: ['https://rtc.example.org'], stun: [], idp: BLOCK.idp }, /must be a wss: URL/);
  bad({ rendezvous: ['rtc.example.org'], stun: [], idp: BLOCK.idp }, /not an absolute URL/);
  bad({ rendezvous: ['wss://user:pw@rtc.example.org'], stun: [], idp: BLOCK.idp }, /user name or password/);
  bad({ rendezvous: ['wss://rtc.example.org/#x'], stun: [], idp: BLOCK.idp }, /fragment/);
  bad({ rendezvous: ['wss://rtc.example.org/a b'], stun: [], idp: BLOCK.idp }, /white space/);
  bad({ rendezvous: ['wss://rtc.example.org/' + 'a'.repeat(300)], stun: [], idp: BLOCK.idp }, /longer than 300/);
  bad({ rendezvous: [7], stun: [], idp: BLOCK.idp }, /rendezvous\[0\] is not a URL/);
  bad({ rendezvous: BLOCK.rendezvous, idp: BLOCK.idp }, /stun is not a list/);
  bad({ rendezvous: BLOCK.rendezvous, stun: ['turn:t.example'], idp: BLOCK.idp }, /stun\[0\] is not a stun: or stuns: URL/);
  bad({ rendezvous: BLOCK.rendezvous, stun: ['stun:s.example?transport=udp'], idp: BLOCK.idp }, /stun\[0\] is not a stun: or stuns: URL/);
  bad({ rendezvous: BLOCK.rendezvous, stun: ['stun:s.example:99999'], idp: BLOCK.idp }, /stun\[0\] is not a stun: or stuns: URL/);
  bad({ rendezvous: BLOCK.rendezvous, stun: Array.from({ length: APPS_STUN_MAX + 1 }, (_, i) => 'stun:s' + i + '.example'), idp: BLOCK.idp }, /stun has 9 entries/);
  bad({ rendezvous: BLOCK.rendezvous, stun: [] }, /idp is not an origin/);
  bad({ rendezvous: BLOCK.rendezvous, stun: [], idp: 'http://id.example.org' }, /idp is not an origin/);
  bad({ rendezvous: BLOCK.rendezvous, stun: [], idp: 'https://id.example.org/' }, /idp is not an origin/);
  bad({ rendezvous: BLOCK.rendezvous, stun: [], idp: 'https://id.example.org/path' }, /idp is not an origin/);
  // other keys are left alone: a later loader may read more
  assert.deepEqual(appsBlockProblems(Object.assign({ future: 1 }, BLOCK)), []);
});

// The tools must never write a block the door page ignores: whatever passes appsBlockProblems must pass the page's own check
// (checkAppsBlock behind appsBlockOf in src/loader/doors.js). Both directions are compared over a table; the cases where the tools are
// stricter than the page are listed, so a change on either side shows here.
test('appsBlockProblems against the page\'s own appsBlockOf: the tools write nothing the page would ignore', () => {
  const ok = (rendezvous, stun, idp) => ({ rendezvous, stun, idp });
  const same = [
    BLOCK,
    ok(['ws://127.0.0.1:8000', 'ws://localhost:8000', 'ws://[::1]:8000', 'ws://dev.localhost:8000'], [], 'http://127.0.0.1:8081'),
    ok(['wss://a.example'], ['stun:s.example'], 'http://localhost:8081'),
    ok(['wss://a.example'], ['stuns:s.example:5349', 'stun:[2001:db8::1]:3478'], 'http://[::1]:8081'),
    ok(Array.from({ length: APPS_RENDEZVOUS_MAX }, (_, i) => 'wss://r' + i + '.example'), Array.from({ length: APPS_STUN_MAX }, (_, i) => 'stun:s' + i + '.example'), 'https://id.example.org:8443'),
    ok(['wss://rtc.example.org/pair?room=1'], [], 'https://id.example.org'),
    // refused by both
    ok([], [], 'https://id.example.org'),
    ok(Array.from({ length: APPS_RENDEZVOUS_MAX + 1 }, (_, i) => 'wss://r' + i + '.example'), [], 'https://id.example.org'),
    ok(['ws://rtc.example.org'], [], 'https://id.example.org'),
    ok(['ws://127.0.0.2:8000'], [], 'https://id.example.org'),
    ok(['https://rtc.example.org'], [], 'https://id.example.org'),
    ok(['rtc.example.org'], [], 'https://id.example.org'),
    ok(['wss://user:pw@rtc.example.org'], [], 'https://id.example.org'),
    ok(['wss://rtc.example.org/#x'], [], 'https://id.example.org'),
    ok(['wss://rtc.example.org '], [], 'https://id.example.org'),
    ok([' wss://rtc.example.org'], [], 'https://id.example.org'),
    ok(['wss://rtc.example.org/' + 'a'.repeat(300)], [], 'https://id.example.org'),
    ok([7], [], 'https://id.example.org'),
    ok(['wss://a.example'], ['turn:t.example'], 'https://id.example.org'),
    ok(['wss://a.example'], ['stun:s.example?transport=udp'], 'https://id.example.org'),
    ok(['wss://a.example'], ['stun:s.example:99999'], 'https://id.example.org'),
    ok(['wss://a.example'], Array.from({ length: APPS_STUN_MAX + 1 }, (_, i) => 'stun:s' + i + '.example'), 'https://id.example.org'),
    ok(['wss://a.example'], 'stun:s.example', 'https://id.example.org'),
    ok(['wss://a.example'], [], 'http://id.example.org'),
    ok(['wss://a.example'], [], 'https://id.example.org/'),
    ok(['wss://a.example'], [], 'https://id.example.org/path'),
    ok(['wss://a.example'], [], 'id.example.org'),
    ok(['wss://a.example'], [], undefined),
    ok(['wss://a.example'], [], ['https://id.example.org']),
    { stun: [], idp: 'https://id.example.org' },
    'yes',
    [],
    null,
  ];
  for (const block of same) {
    const mine = appsBlockProblems(block).length === 0;
    const page = appsBlockOf({ apps: block }) !== null;
    assert.equal(mine, page, 'tools ' + mine + ', page ' + page + ' for ' + JSON.stringify(block));
  }
  // Where the tools are stricter than the page (white space inside an entry; http only for the three loopback names the origin check knows).
  for (const block of [ok(['wss://rtc.example.org/a b'], [], 'https://id.example.org'), ok(['wss://a.example'], [], 'http://dev.localhost:8081')]) {
    assert.ok(appsBlockProblems(block).length > 0, JSON.stringify(block));
    assert.notEqual(appsBlockOf({ apps: block }), null, 'the page accepts it: ' + JSON.stringify(block));
  }
  // and the other way round never happens: a block the tools accept is a block the page accepts
  for (const block of same) if (appsBlockProblems(block).length === 0) assert.deepEqual(appsBlockOf({ apps: block }), block);
});

test('makeAppsBlock: comma lists and repeats become distinct lists in order; refusals are usage errors that name the flags', () => {
  assert.deepEqual(makeAppsBlock({ rendezvous: ['wss://a.example, wss://b.example', 'wss://a.example'], stun: 'stun:s.example:3478', idp: ['https://id.example.org', 'https://id.example.org'] }),
    { rendezvous: ['wss://a.example', 'wss://b.example'], stun: ['stun:s.example:3478'], idp: 'https://id.example.org' });
  assert.deepEqual(makeAppsBlock({ rendezvous: 'wss://a.example', idp: 'https://id.example.org' }).stun, [], 'no STUN is allowed: host candidates only');
  // the address a server prints for itself ends in a slash: that one slash is dropped; a path or a query is not
  assert.equal(makeAppsBlock({ rendezvous: 'wss://a.example', idp: 'http://127.0.0.1:8081/' }).idp, 'http://127.0.0.1:8081');
  assert.equal(makeAppsBlock({ rendezvous: 'wss://a.example', idp: ['https://id.example.org/', 'https://id.example.org'] }).idp, 'https://id.example.org');
  assert.throws(() => makeAppsBlock({ rendezvous: 'wss://a.example', idp: 'https://id.example.org/path/' }), UsageError);
  assert.throws(() => makeAppsBlock({ rendezvous: 'wss://a.example', idp: 'https://id.example.org//' }), UsageError);
  const throwsUsage = (input, re, options) => assert.throws(() => makeAppsBlock(input, options), (err) => err instanceof UsageError && re.test(err.message), JSON.stringify(input));
  throwsUsage({ idp: 'https://id.example.org' }, /--apps-rendezvous is needed/);
  throwsUsage({ rendezvous: ['wss://a.example'] }, /--apps-idp is needed/);
  throwsUsage({ rendezvous: ['wss://a.example'], idp: ['https://id.example.org', 'https://other.example.org'] }, /--apps-idp takes one origin, got 2/);
  throwsUsage({ rendezvous: ['ws://a.example'], idp: 'https://id.example.org' }, /--apps-rendezvous\[0\] is ws: on a host that is not loopback/);
  throwsUsage({ rendezvous: ['wss://a.example'], stun: ['x'], idp: 'https://id.example.org' }, /--apps-stun\[0\] is not a stun: or stuns: URL/);
  throwsUsage({ rendezvous: Array.from({ length: 9 }, (_, i) => 'wss://r' + i + '.example'), idp: 'https://id.example.org' }, /--apps-rendezvous has 9 entries; at most 8/);
  throwsUsage({ rendezvous: ['wss://a.example'], idp: 'http://id.example.org' }, /--apps-idp is not an origin/);
  throwsUsage({ idp: 'https://id.example.org' }, /--tracker is needed/, { flags: { rendezvous: '--tracker' } });
});

test('appsBlockLine names the three parts in the words check-site --door prints', () => {
  assert.equal(appsBlockLine(BLOCK), 'rendezvous 1, stun 1, identity https://id.example.org');
  assert.equal(appsBlockLine({ rendezvous: ['wss://a.example', 'wss://b.example'], stun: [], idp: 'http://127.0.0.1:8081' }), 'rendezvous 2, stun 0, identity http://127.0.0.1:8081');
  assert.equal(appsBlockLine(null), 'rendezvous 0, stun 0, identity (none)');
});

test('withAppsBlock / withoutAppsBlock: apps is the last key, nothing else moves, and removing it gives the build\'s door.json byte for byte', () => {
  const dist = fakeDist();
  const built = readFileSync(join(dist, '_mw', 'door.json'));
  const withBlock = withAppsBlock(built, BLOCK);
  const parsed = JSON.parse(withBlock.toString('utf8'));
  assert.deepEqual(Object.keys(parsed), ['v', 'kind', 'name', 'version', 'buildId', 'page', 'pageAlias', 'files', 'apps']);
  assert.deepEqual(parsed.apps, BLOCK);
  const original = JSON.parse(built.toString('utf8'));
  for (const key of Object.keys(original)) assert.deepEqual(parsed[key], original[key], key);
  assert.equal(withBlock.toString('utf8').endsWith('}\n'), true);
  assert.equal(withoutAppsBlock(withBlock).equals(built), true, 'the release\'s door.json is what is left');
  // a block already there is replaced, not doubled
  const other = { rendezvous: ['wss://other.example'], stun: [], idp: 'https://other-id.example.org' };
  assert.deepEqual(JSON.parse(withAppsBlock(withBlock, other).toString('utf8')).apps, other);
  assert.equal(withoutAppsBlock(withAppsBlock(withBlock, other)).equals(built), true);
  // not JSON, or not an object: a tool error that names the file
  assert.throws(() => withAppsBlock(Buffer.from('<html>'), BLOCK), (err) => err instanceof ToolError && /_mw\/door\.json is not JSON/.test(err.message));
  assert.throws(() => withAppsBlock(Buffer.from('[1]'), BLOCK), (err) => err instanceof ToolError && /not a JSON object/.test(err.message));
  assert.throws(() => withoutAppsBlock(Buffer.from('null')), ToolError);
});

test('withAppsBlock / withoutAppsBlock leave the obs block of the usage reports where it is: last, behind apps, whichever block was written first', () => {
  const dist = fakeDist();
  const built = readFileSync(join(dist, '_mw', 'door.json'));
  const OBS = { endpoint: 'https://obs.example.org' };
  const plain = JSON.parse(built.toString('utf8'));
  const withObs = Buffer.from(JSON.stringify(Object.assign({}, plain, { obs: OBS }), null, 2) + '\n');
  // apps is set into a file that already has obs: it goes in front of it
  const both = withAppsBlock(withObs, BLOCK);
  const parsed = JSON.parse(both.toString('utf8'));
  assert.deepEqual(Object.keys(parsed), ['v', 'kind', 'name', 'version', 'buildId', 'page', 'pageAlias', 'files', 'apps', 'obs']);
  assert.deepEqual(parsed.apps, BLOCK);
  assert.deepEqual(parsed.obs, OBS);
  assert.equal(both.equals(Buffer.from(JSON.stringify(Object.assign({}, plain, { apps: BLOCK, obs: OBS }), null, 2) + '\n')), true, 'the same bytes as apps written first');
  // a block that is already there is replaced without the obs block moving, and removing it leaves the obs file as it was
  const other = { rendezvous: ['wss://other.example'], stun: [], idp: 'https://other-id.example.org' };
  assert.deepEqual(Object.keys(JSON.parse(withAppsBlock(both, other).toString('utf8'))).slice(-2), ['apps', 'obs']);
  assert.equal(withoutAppsBlock(both).equals(withObs), true);
  // without an obs block nothing is different: apps is the last key and removing it gives the build's own bytes
  assert.equal(Object.keys(JSON.parse(withAppsBlock(built, BLOCK).toString('utf8'))).pop(), 'apps');
  assert.equal(withoutAppsBlock(withAppsBlock(built, BLOCK)).equals(built), true);
});

// ---------------------------------------------------------------------------------------------- publish

test('publish with --tracker, --stun and --idp: summary.json and the result hold the apps block; without --shell no shell is written', async () => {
  const res = await run(FLAGS);
  assert.deepEqual(res.apps, BLOCK);
  const summary = JSON.parse(readFileSync(join(res.outDir, 'summary.json'), 'utf8'));
  assert.deepEqual(summary.apps, BLOCK);
  assert.equal(existsSync(join(res.outDir, 'shell')), false);
  assert.equal(res.warnings.some((w) => /apps block/.test(w)), false, 'no note: nothing was meant to be written');
  // the tracker also joined tr= as before, and the STUN list is the one in /.mw/site.json
  assert.ok(res.summary.tr.includes('wss://rtc.example.org'));
  assert.deepEqual(res.summary.stun, BLOCK.stun);
});

test('publish --shell writes the block into shell/_mw/door.json as its last key; every other loader file is as built', async () => {
  const dist = fakeDist();
  const res = await run(Object.assign({ shell: true, dist }, FLAGS));
  const shellDoor = readFileSync(join(res.outDir, 'shell', '_mw', 'door.json'));
  const built = readFileSync(join(dist, '_mw', 'door.json'));
  const parsed = JSON.parse(shellDoor.toString('utf8'));
  assert.deepEqual(parsed.apps, BLOCK);
  assert.equal(Object.keys(parsed).pop(), 'apps');
  assert.equal(withoutAppsBlock(shellDoor).equals(built), true, 'door.json minus the block is the build\'s door.json');
  assert.deepEqual(JSON.parse(readFileSync(join(res.outDir, 'summary.json'), 'utf8')).apps, BLOCK);
  // the files door.json lists are untouched: the shell holds the loader's _mw files byte for byte
  for (const rel of ['_mw/boot.js', '_mw/loader.js', '_mw/open.html', 'mw-sw.js']) {
    assert.equal(readFileSync(join(res.outDir, 'shell', ...rel.split('/'))).equals(readFileSync(join(dist, ...rel.split('/')))), true, rel);
  }
  // a second publish into the same folder without the flags writes the shell with the build's own door.json again
  const out = fresh('out');
  const key = (await makeKey()).file;
  const first = await run(Object.assign({ shell: true, dist, key, out }, FLAGS));
  assert.ok(JSON.parse(readFileSync(join(first.outDir, 'shell', '_mw', 'door.json'), 'utf8')).apps);
  const again = await run({ shell: true, dist, key, out });
  assert.equal(JSON.parse(readFileSync(join(again.outDir, 'shell', '_mw', 'door.json'), 'utf8')).apps, undefined);
  assert.equal(readFileSync(join(again.outDir, 'shell', '_mw', 'door.json')).equals(built), true);
  assert.equal(JSON.parse(readFileSync(join(again.outDir, 'summary.json'), 'utf8')).apps, null);
});

test('publish: the block needs the site\'s own tracker (--tracker, not --tr), a STUN server and an identity origin', async () => {
  const dist = fakeDist();
  const lines = [];
  // --tr names a tracker for the pointer, but only --tracker names the apps rendezvous
  const trOnly = await run({ shell: true, dist, tr: ['wss://rtc.example.org'], stun: FLAGS.stun, idp: FLAGS.idp });
  assert.equal(trOnly.apps, null);
  // no STUN
  const noStun = await run({ shell: true, dist, tracker: FLAGS.tracker, idp: FLAGS.idp });
  assert.equal(noStun.apps, null);
  assert.equal(JSON.parse(readFileSync(join(noStun.outDir, 'shell', '_mw', 'door.json'), 'utf8')).apps, undefined);
  // no identity origin: no block, and with --shell a note says why (without --shell it stays quiet)
  const noIdp = await run({ shell: true, dist, tracker: FLAGS.tracker, stun: FLAGS.stun, quiet: false, log: (l) => lines.push(String(l)) });
  assert.equal(noIdp.apps, null);
  assert.ok(noIdp.warnings.some((w) => /no apps block for the door page: --idp is missing/.test(w) && /Apps at a door/.test(w)), noIdp.warnings.join('\n'));
  assert.equal(JSON.parse(readFileSync(join(noIdp.outDir, 'summary.json'), 'utf8')).apps, null);
  assert.equal(JSON.parse(readFileSync(join(noIdp.outDir, 'shell', '_mw', 'door.json'), 'utf8')).apps, undefined);
  const quietNoIdp = await run({ tracker: FLAGS.tracker, stun: FLAGS.stun });
  assert.equal(quietNoIdp.warnings.some((w) => /apps block/.test(w)), false);
  // a bare publish has no block at all
  const plain = await run({});
  assert.equal(plain.apps, null);
  assert.equal(JSON.parse(readFileSync(join(plain.outDir, 'summary.json'), 'utf8')).apps, null);
  assert.equal(lines.some((l) => /^ {2}apps /.test(l)), false, 'no apps line in the report without a block');
});

test('publish: loopback development values are accepted (ws: tracker, http: identity page); the report line names the block and where it went', async () => {
  const dist = fakeDist();
  const lines = [];
  const res = await run({
    shell: true, dist, tracker: ['ws://127.0.0.1:8000'], stun: ['stun:127.0.0.1:3478'], idp: 'http://127.0.0.1:8081', tr: [],
    quiet: false, log: (l) => lines.push(String(l)),
  });
  assert.deepEqual(res.apps, { rendezvous: ['ws://127.0.0.1:8000'], stun: ['stun:127.0.0.1:3478'], idp: 'http://127.0.0.1:8081' });
  const line = lines.find((l) => /^ {2}apps /.test(l));
  assert.ok(line, lines.join('\n'));
  assert.match(line, /rendezvous 1, stun 1, identity http:\/\/127\.0\.0\.1:8081 \(in .*shell\/_mw\/door\.json\)/);
  assert.doesNotMatch(line, BANNED);
  const noShell = [];
  await run({ tracker: FLAGS.tracker, stun: FLAGS.stun, idp: FLAGS.idp, quiet: false, log: (l) => noShell.push(String(l)) });
  assert.match(noShell.find((l) => /^ {2}apps /.test(l)), /\(in summary\.json; --shell writes it into the shell, --door-kit --door-site into a door kit\)/);
});

test('publish --dropin has no shell and no block: summary.json says null and the _mw/door.json it copies is as built', async () => {
  const dist = fakeDist();
  const res = await run(Object.assign({ dropin: true, dist, ws: [] }, FLAGS));
  assert.equal(res.apps, null);
  assert.equal(JSON.parse(readFileSync(join(res.outDir, 'summary.json'), 'utf8')).apps, null);
  assert.equal(readFileSync(join(res.outDir, 'site', '_mw', 'door.json')).equals(readFileSync(join(dist, '_mw', 'door.json'))), true);
  assert.equal(res.warnings.some((w) => /apps block/.test(w)), false);
});

test('publish --shell with a loader build that has no _mw/door.json: the shell is written without the block and a note says to rebuild', async () => {
  const dist = fakeDist({ withDoorJson: false });
  const res = await run(Object.assign({ shell: true, dist }, FLAGS));
  assert.ok(res.warnings.some((w) => /has no _mw\/door\.json to carry the apps block/.test(w) && /node build\.mjs/.test(w)), res.warnings.join('\n'));
  assert.equal(existsSync(join(res.outDir, 'shell', '_mw', 'door.json')), false);
  assert.deepEqual(res.apps, BLOCK, 'summary.json still records what the flags said');
});

test('publish --shell with a door.json that is not JSON stops before anything is written', async () => {
  const dist = fakeDist();
  writeFileSync(join(dist, '_mw', 'door.json'), '<html>error</html>');
  const out = fresh('out');
  await assert.rejects(run(Object.assign({ shell: true, dist, out }, FLAGS)), (err) => err instanceof ToolError && /_mw\/door\.json is not JSON/.test(err.message));
  assert.deepEqual(readdirSync(out), [], 'nothing written');
});

test('CLI: --help lists the apps flags; a run with --shell prints the apps line and writes the block', async () => {
  const help = spawnSync(process.execPath, ['tools/publish.mjs', '--help'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Apps: {6}--tracker, --stun and --idp together/m);
  assert.match(help.stdout, /summary\.json gets apps \{ rendezvous, stun, idp \}/);
  assert.match(help.stdout, /the one\s+file of the loader that then differs from the release/);
  const dist = fakeDist();
  const out = fresh('out-cli');
  const key = (await makeKey()).file;
  const r = spawnSync(process.execPath, [
    'tools/publish.mjs', makeSite(), '--name', 'my-site', '--scope', 'example.com', '--key', key, '--tr', 'wss://tracker.example', '--ws', 'https://static.example/ws/',
    '--tracker', BLOCK.rendezvous[0], '--stun', BLOCK.stun[0], '--idp', BLOCK.idp, '--shell', '--dist', dist, '--allow-unverified-loader', '--out', out,
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout.slice(0, 600));
  assert.match(r.stdout, /^ {2}apps {6}rendezvous 1, stun 1, identity https:\/\/id\.example\.org \(in .*shell\/_mw\/door\.json\)$/m);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'shell', '_mw', 'door.json'), 'utf8')).apps, BLOCK);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')).apps, BLOCK);
});

// ---------------------------------------------------------------------------------------------- door kit

async function release(dist) {
  const keyFile = join(work, 'release-' + ++keyCounter + '.jwk');
  const k = await keygen({ out: keyFile });
  const owner = await loadOwnerKey(keyFile);
  const list = buildHashList({ dir: dist, version: '0.3.0' });
  const sig = await signList(list, { privateKey: owner.privateKey, pub: owner.pub });
  const dir = fresh('release');
  writeFileSync(join(dir, 'hashes-dist.json'), JSON.stringify(list, null, 2) + '\n');
  writeFileSync(join(dir, 'hashes-dist.json.sig'), JSON.stringify(sig, null, 2) + '\n');
  return { pub: k.pub, list: join(dir, 'hashes-dist.json'), sig: join(dir, 'hashes-dist.json.sig'), parsed: list, parsedSig: sig };
}
const kitOptions = (rel, extra) => Object.assign({ releaseList: rel.list, releaseSig: rel.sig, releaseKey: rel.pub, releasePinnedKeys: [rel.pub] }, extra);

test('doorKit --door-site: the first site\'s apps block is set in the kit\'s door.json; the rest of the loader is the release byte for byte', async () => {
  const dist = fakeDist();
  const rel = await release(dist);
  const site = await run(FLAGS); // a shell-mode publish output whose summary.json holds the block
  const out = join(fresh('kits'), 'kit');
  const lines = [];
  const res = await doorKit(kitOptions(rel, { out, dist, doorSite: [site.outDir], log: (l) => lines.push(String(l)) }));
  assert.deepEqual(res.apps, BLOCK);
  assert.equal(res.sites.length, 1);
  const kitDoor = readFileSync(join(out, '_mw', 'door.json'));
  const built = readFileSync(join(dist, '_mw', 'door.json'));
  assert.deepEqual(JSON.parse(kitDoor.toString('utf8')).apps, BLOCK);
  assert.equal(Object.keys(JSON.parse(kitDoor.toString('utf8'))).pop(), 'apps');
  assert.equal(withoutAppsBlock(kitDoor).equals(built), true, 'door.json minus the block is the release\'s door.json');
  assert.equal(readFileSync(join(dist, '_mw', 'door.json')).equals(built), true, 'dist itself is not changed');
  for (const rel2 of ['index.html', '404.html', 'mw-sw.js', '_mw/boot.js', '_mw/loader.js', '_mw/open.html', 'build.json']) {
    assert.equal(readFileSync(join(out, ...rel2.split('/'))).equals(readFileSync(join(dist, ...rel2.split('/')))), true, rel2);
  }
  const line = lines.find((l) => /^ {2}apps /.test(l));
  assert.match(line, /rendezvous 1, stun 1, identity https:\/\/id\.example\.org \(from my-site\), set in _mw\/door\.json: the one loader file that differs from the signed release/);
  assert.doesNotMatch(line, BANNED);
  // The signed list names door.json without the block. The one file a verifier can name is that one, and it differs by the block alone.
  const verdict = await verifyRelease({ dir: out, list: rel.parsed, sig: rel.parsedSig, publicKey: rel.pub, pinnedKeys: [rel.pub], allowExtra: true, expectExtra: doorKitFiles({ version: '0.3.0' }) });
  assert.ok(verdict.problems.every((p) => p.startsWith('_mw/door.json')), verdict.problems.join('; '));
});

test('doorKit --door-site: only the first site names the door\'s apps; a first site without a block gives a kit without one, and a note when a later site has one', async () => {
  const dist = fakeDist();
  const rel = await release(dist);
  const withBlock = await run(FLAGS);
  const without = await run({});
  // no block anywhere: door.json is the release's, byte for byte
  const plainKit = join(fresh('kits'), 'plain');
  const plain = await doorKit(kitOptions(rel, { out: plainKit, dist, doorSite: [without.outDir], quiet: true }));
  assert.equal(plain.apps, null);
  assert.equal(readFileSync(join(plainKit, '_mw', 'door.json')).equals(readFileSync(join(dist, '_mw', 'door.json'))), true);
  const verdictPlain = await verifyRelease({ dir: plainKit, list: rel.parsed, sig: rel.parsedSig, publicKey: rel.pub, pinnedKeys: [rel.pub], allowExtra: true, expectExtra: doorKitFiles({ version: '0.3.0' }) });
  assert.equal(verdictPlain.ok, true, verdictPlain.problems.join('; '));
  // the first site has none, the second has one: the kit has none, and says so
  const lines = [];
  const orderKit = join(fresh('kits'), 'order');
  const order = await doorKit(kitOptions(rel, { out: orderKit, dist, doorSite: [without.outDir, withBlock.outDir], log: (l) => lines.push(String(l)) }));
  assert.equal(order.apps, null);
  assert.equal(JSON.parse(readFileSync(join(orderKit, '_mw', 'door.json'), 'utf8')).apps, undefined);
  assert.ok(lines.some((l) => /apps {4}none in the kit: only the first --door-site names the door's apps, and it has no apps block \(my-site has one\)/.test(l)), lines.join('\n'));
  // the first site has one: it is used, whatever follows
  const firstKit = join(fresh('kits'), 'first');
  const first = await doorKit(kitOptions(rel, { out: firstKit, dist, doorSite: [withBlock.outDir, without.outDir], quiet: true }));
  assert.deepEqual(first.apps, BLOCK);
});

test('doorKit --door-site: an apps block in summary.json that cannot be used is refused, and so is a loader build with no door.json to carry it', async () => {
  const dist = fakeDist();
  const rel = await release(dist);
  const site = await run(FLAGS);
  const summaryFile = join(site.outDir, 'summary.json');
  const summary = JSON.parse(readFileSync(summaryFile, 'utf8'));
  // the refusal comes before the kit folder is touched: nothing is made, and a kit that is already there stays as it was
  const kept = join(fresh('kits'), 'kept');
  await doorKit(kitOptions(rel, { out: kept, dist, doorSite: [site.outDir], quiet: true }));
  const keptDoor = readFileSync(join(kept, '_mw', 'door.json'));
  writeFileSync(summaryFile, JSON.stringify(Object.assign({}, summary, { apps: { rendezvous: ['http://rtc.example.org'], stun: [], idp: BLOCK.idp } })));
  const k1 = join(fresh('kits'), 'k1');
  await assert.rejects(doorKit(kitOptions(rel, { out: k1, dist, doorSite: [site.outDir], quiet: true })),
    (err) => err instanceof ToolError && /the apps block in summary\.json is not usable \(rendezvous\[0\] must be a wss: URL/.test(err.message) && /--tracker, --stun and --idp/.test(err.message));
  assert.equal(existsSync(k1), false, 'no kit folder was made');
  await assert.rejects(doorKit(kitOptions(rel, { out: kept, dist, doorSite: [site.outDir], quiet: true })), /not usable/);
  assert.equal(readFileSync(join(kept, '_mw', 'door.json')).equals(keptDoor), true, 'the earlier kit is untouched');
  writeFileSync(summaryFile, JSON.stringify(Object.assign({}, summary, { apps: 'yes' })));
  await assert.rejects(doorKit(kitOptions(rel, { out: join(fresh('kits'), 'k2'), dist, doorSite: [site.outDir], quiet: true })), /the apps block in summary\.json is not usable \(the apps block is not an object\)/);
  // a loader whose release list has no door.json (an old build) cannot carry a block
  const old = fakeDist({ withDoorJson: false });
  const oldRel = await release(old);
  writeFileSync(summaryFile, JSON.stringify(summary));
  const k3 = join(fresh('kits'), 'k3');
  await assert.rejects(doorKit(kitOptions(oldRel, { out: k3, dist: old, doorSite: [site.outDir], quiet: true })),
    (err) => err instanceof ToolError && /has an apps block, but the loader in .* has no _mw\/door\.json to carry it/.test(err.message));
  assert.equal(existsSync(k3), false, 'no kit folder was made');
});

test('doorKit: the kit can be made again into the same folder, with or without the block', async () => {
  const dist = fakeDist();
  const rel = await release(dist);
  const withBlock = await run(FLAGS);
  const out = join(fresh('kits'), 'kit');
  await doorKit(kitOptions(rel, { out, dist, doorSite: [withBlock.outDir], quiet: true }));
  assert.ok(JSON.parse(readFileSync(join(out, '_mw', 'door.json'), 'utf8')).apps);
  await doorKit(kitOptions(rel, { out, dist, quiet: true }));
  assert.equal(readFileSync(join(out, '_mw', 'door.json')).equals(readFileSync(join(dist, '_mw', 'door.json'))), true, 'a kit without a site is the plain loader again');
});

test('the words of the new messages follow the wording rules (no dashes, curly quotes or banned terms)', async () => {
  const source = readFileSync(join(ROOT, 'tools', 'apps-block.mjs'), 'utf8');
  assert.doesNotMatch(source, BANNED);
  const lines = [];
  const dist = fakeDist();
  const rel = await release(dist);
  const site = await run(FLAGS);
  await doorKit(kitOptions(rel, { out: join(fresh('kits'), 'kit'), dist, doorSite: [site.outDir], log: (l) => lines.push(String(l)) }));
  const noIdp = await run({ shell: true, dist, tracker: FLAGS.tracker, stun: FLAGS.stun });
  for (const text of lines.concat(noIdp.warnings)) assert.doesNotMatch(text, BANNED, text);
});
