// Unit tests for --obs of tools/publish.mjs, the endpoint of the usage reports (docs/DEPLOY.md, "Usage reports"): summary.json gets an obs block
// and, with --shell, the shell's /_mw/door.json; the torrent, and so the infohash of the site, is the same with and without it; and the
// door kit (--door-kit --door-site) copies the first door site's block into the kit's /_mw/door.json, the one loader file that then
// differs from the signed release. The shape helpers themselves are tested in tools-apps-block-obs.test.mjs. No network: everything runs
// in temporary directories; the hosts are example names.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { publish, doorKit, doorKitFiles } from '../../tools/publish.mjs';
import { keygen } from '../../tools/keygen.mjs';
import { loadOwnerKey, UsageError, ToolError, ROOT } from '../../tools/lib.mjs';
import { buildHashList, signList, verifyRelease } from '../../tools/verify-release.mjs';
import { obsBlockProblems, makeObsBlock, withObsBlock, withoutObsBlock, withAppsBlock, withoutAppsBlock } from '../../tools/apps-block.mjs';
import { doorJson } from '../../build.mjs';
import { checkDoorJson } from '../../src/loader/doors.js';

const work = mkdtempSync(join(tmpdir(), 'mw-obs-publish-'));
after(() => rmSync(work, { recursive: true, force: true }));
const NOW = Date.UTC(2026, 10, 1, 12, 0, 30);
const DATE = '2026-11-01T12:00:00Z';
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
/** treeOf(root) -> { 'a/b.txt': Buffer }: every file under root, by its path relative to root. */
function treeOf(root) {
  const found = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else found[abs.slice(root.length + 1)] = readFileSync(abs);
    }
  };
  walk(root);
  return found;
}
let keyCounter = 0;
async function makeKey() {
  const file = join(work, 'owner-' + ++keyCounter + '.jwk');
  const res = await keygen({ out: file });
  return { file, pub: res.pub };
}
const BANNED = /blockchain|serverless|unstoppable|censorship|production-ready|fully decentralized|sub-second|[\u2013\u2014\u2018\u2019\u201c\u201d]/i;

const OBS = { endpoint: 'https://obs.example.org' };
const APPS = { rendezvous: ['wss://rtc.example.org'], stun: ['stun:stun.example.org:3478'], idp: 'https://id.example.org' };
const APPS_FLAGS = { tracker: APPS.rendezvous.slice(), stun: APPS.stun.slice(), idp: APPS.idp };

function makeSite() {
  const dir = fresh('site');
  writeTree(dir, { 'index.html': '<!doctype html><html><head><meta charset="utf-8"><title>Home</title></head><body><h1>Home</h1></body></html>\n', 'css/app.css': 'body { margin: 0 }\n' });
  return dir;
}
async function run(extra = {}) {
  const key = extra.key || (await makeKey()).file;
  return publish(Object.assign({
    dir: makeSite(), name: 'my-site', scope: 'example.com', key, tr: ['wss://tracker.example'], ws: ['https://static.example/ws/'],
    out: fresh('out'), now: NOW, date: DATE, quiet: true,
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
/** How the page reads a door.json the tools wrote: as a door list, and, when the page has the check (lane L2), with a usable obs block. */
function assertPageReads(door, obs) {
  const page = checkDoorJson(door);
  assert.equal(page.ok, true, 'the page reads it as a door list: ' + page.reason);
  if (Object.prototype.hasOwnProperty.call(page, 'obs') || Object.prototype.hasOwnProperty.call(page, 'obsReason')) assert.deepEqual(page.obs, obs, JSON.stringify(page.obsReason));
}
const doorOf = (res) => JSON.parse(readFileSync(join(res.outDir, 'shell', '_mw', 'door.json'), 'utf8'));
const summaryOf = (res) => JSON.parse(readFileSync(join(res.outDir, 'summary.json'), 'utf8'));

// ---------------------------------------------------------------------------------------------- publish

test('publish --obs alone: summary.json and the result hold the block; the apps block is not made; without --shell no shell is written', async () => {
  const lines = [];
  const res = await run({ obs: OBS.endpoint, quiet: false, log: (l) => lines.push(String(l)) });
  assert.deepEqual(res.obs, OBS);
  assert.equal(res.apps, null, 'the reports need no tracker, STUN server or identity origin, and make no apps block');
  assert.deepEqual(summaryOf(res).obs, OBS);
  assert.equal(summaryOf(res).apps, null);
  assert.equal(existsSync(join(res.outDir, 'shell')), false);
  assert.equal(res.warnings.some((w) => /--obs|obs block|usage report/.test(w)), false, 'no note: nothing was meant to be written');
  const line = lines.find((l) => /^ {2}obs /.test(l));
  assert.match(line, /^ {2}obs {7}usage reports to obs\.example\.org \(in summary\.json; --shell writes it into the shell, --door-kit --door-site into a door kit\)$/);
  assert.doesNotMatch(line, BANNED);
});

test('publish without --obs: no block in the result or summary.json, and no obs line in the report', async () => {
  const lines = [];
  const plain = await run({ quiet: false, log: (l) => lines.push(String(l)) });
  assert.equal(plain.obs, null);
  assert.equal(summaryOf(plain).obs, null);
  assert.equal(lines.some((l) => /^ {2}obs /.test(l)), false);
  // empty values are no request for a block (the command line gives null, a script may give an empty string or list)
  for (const empty of [null, undefined, '', []]) assert.equal((await run({ obs: empty })).obs, null, JSON.stringify(empty));
  // the apps flags without --obs make an apps block and no obs block
  const apps = await run(APPS_FLAGS);
  assert.deepEqual(apps.apps, APPS);
  assert.equal(apps.obs, null);
});

test('publish --shell --obs writes the block into shell/_mw/door.json as its last key; every other loader file is as built', async () => {
  const dist = fakeDist();
  const lines = [];
  const res = await run({ shell: true, dist, obs: OBS.endpoint, quiet: false, log: (l) => lines.push(String(l)) });
  const shellDoor = readFileSync(join(res.outDir, 'shell', '_mw', 'door.json'));
  const built = readFileSync(join(dist, '_mw', 'door.json'));
  const parsed = JSON.parse(shellDoor.toString('utf8'));
  assert.deepEqual(parsed.obs, OBS);
  assert.equal(Object.keys(parsed).pop(), 'obs');
  assert.equal('apps' in parsed, false, 'no apps block was asked for');
  assert.equal(withoutObsBlock(shellDoor).equals(built), true, 'door.json minus the block is the build\'s door.json');
  assertPageReads(parsed, OBS);
  assert.deepEqual(summaryOf(res).obs, OBS);
  // index.html and 404.html carry the pointer tag; every other file of the loader is the build's, byte for byte
  for (const rel of ['_mw/boot.js', '_mw/loader.js', '_mw/open.html', 'mw-sw.js']) {
    assert.equal(readFileSync(join(res.outDir, 'shell', ...rel.split('/'))).equals(readFileSync(join(dist, ...rel.split('/')))), true, rel);
  }
  assert.equal(readFileSync(join(dist, '_mw', 'door.json')).equals(built), true, 'dist itself is not changed');
  const line = lines.find((l) => /^ {2}obs /.test(l));
  assert.match(line, /^ {2}obs {7}usage reports to obs\.example\.org \(in .*shell\/_mw\/door\.json\)$/);
  // a second publish into the same folder without the flag writes the shell with the build's own door.json again
  const out = fresh('out');
  const key = (await makeKey()).file;
  const first = await run({ shell: true, dist, key, out, obs: OBS.endpoint });
  assert.ok(doorOf(first).obs);
  const again = await run({ shell: true, dist, key, out });
  assert.equal(doorOf(again).obs, undefined);
  assert.equal(readFileSync(join(again.outDir, 'shell', '_mw', 'door.json')).equals(built), true);
  assert.equal(summaryOf(again).obs, null);
});

test('publish --obs with and without --tracker, --stun and --idp: the reports stand alone, and next to a complete apps block they follow it', async () => {
  const dist = fakeDist();
  const built = readFileSync(join(dist, '_mw', 'door.json'));
  // each of the three alone, or two of them: an obs block and no apps block
  for (const flags of [{}, { tracker: APPS_FLAGS.tracker }, { stun: APPS_FLAGS.stun }, { idp: APPS_FLAGS.idp }, { tracker: APPS_FLAGS.tracker, idp: APPS_FLAGS.idp }, { tracker: APPS_FLAGS.tracker, stun: APPS_FLAGS.stun }]) {
    const res = await run(Object.assign({ shell: true, dist, obs: OBS.endpoint }, flags));
    assert.deepEqual(res.obs, OBS, JSON.stringify(flags));
    assert.equal(res.apps, null, JSON.stringify(flags));
    const door = doorOf(res);
    assert.deepEqual(door.obs, OBS, JSON.stringify(flags));
    assert.equal('apps' in door, false, JSON.stringify(flags));
    assert.equal(withoutObsBlock(readFileSync(join(res.outDir, 'shell', '_mw', 'door.json'))).equals(built), true, JSON.stringify(flags));
  }
  // all three: both blocks, apps first
  const both = await run(Object.assign({ shell: true, dist, obs: OBS.endpoint }, APPS_FLAGS));
  assert.deepEqual(both.apps, APPS);
  assert.deepEqual(both.obs, OBS);
  const shellDoor = readFileSync(join(both.outDir, 'shell', '_mw', 'door.json'));
  const door = JSON.parse(shellDoor.toString('utf8'));
  assert.deepEqual(Object.keys(door).slice(-2), ['apps', 'obs']);
  assert.deepEqual(door.apps, APPS);
  assert.deepEqual(door.obs, OBS);
  assertPageReads(door, OBS);
  assert.equal(withoutObsBlock(withoutAppsBlock(shellDoor)).equals(built), true, 'door.json minus both blocks is the build\'s door.json');
  assert.deepEqual(summaryOf(both).apps, APPS);
  assert.deepEqual(summaryOf(both).obs, OBS);
  // the apps flags without --obs: as before, no obs key at all
  const appsOnly = await run(Object.assign({ shell: true, dist }, APPS_FLAGS));
  assert.equal('obs' in doorOf(appsOnly), false);
  assert.equal(withoutAppsBlock(readFileSync(join(appsOnly.outDir, 'shell', '_mw', 'door.json'))).equals(built), true);
  // the report names each block on its own line
  const lines = [];
  await run(Object.assign({ shell: true, dist, obs: OBS.endpoint, quiet: false, log: (l) => lines.push(String(l)) }, APPS_FLAGS));
  assert.ok(lines.some((l) => /^ {2}apps {6}rendezvous 1, stun 1, identity https:\/\/id\.example\.org \(in /.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /^ {2}obs {7}usage reports to obs\.example\.org \(in /.test(l)), lines.join('\n'));
});

// What the site is: the torrent, its infohash, the web seed copy and the signed record. None of it may know about the usage reports, or a
// site's address would change when its owner turns them on.
function siteOf(res) {
  const { sig, raw, pairs, ...record } = res.record;
  return {
    btih: res.summary.btih,
    rendezvousBtih: res.rendezvousBtih,
    anchorBtih: res.anchorBtih,
    files: res.files,
    torrent: readFileSync(join(res.outDir, 'site.torrent')),
    namedTorrent: readFileSync(join(res.outDir, 'my-site.torrent')),
    seed: treeOf(join(res.outDir, 'my-site')),
    record,
    meta: readFileSync(join(res.outDir, 'meta.html'), 'utf8').replace(/sig=[A-Za-z0-9_-]+/g, 'sig=X'),
    dns: res.summary.dns,
    magnet: res.magnet,
    csp: readFileSync(join(res.outDir, 'csp.txt'), 'utf8'),
  };
}

test('the infohash does not depend on --obs: the same site published with and without it has the same torrent, web seed copy and signed record', async () => {
  const dir = makeSite();
  const key = (await makeKey()).file;
  const dist = fakeDist();
  const common = { dir, key };
  const plain = await run(common);
  const withObs = await run(Object.assign({ obs: OBS.endpoint }, common));
  assert.equal(withObs.summary.btih, plain.summary.btih);
  assert.match(plain.summary.btih, /^[0-9a-f]{40}$/);
  assert.deepEqual(siteOf(withObs), siteOf(plain));
  // the summary differs by the block alone (and by the pointer text, whose signature is different every time it is made)
  const differing = Object.keys(summaryOf(plain)).filter((k) => JSON.stringify(summaryOf(plain)[k]) !== JSON.stringify(summaryOf(withObs)[k])).sort();
  assert.deepEqual(differing, ['obs', 'pointer']);
  // also with a shell, with the apps flags, and with both
  for (const extra of [{ shell: true, dist }, APPS_FLAGS, Object.assign({ shell: true, dist }, APPS_FLAGS)]) {
    const a = await run(Object.assign({}, common, extra));
    const b = await run(Object.assign({ obs: OBS.endpoint }, common, extra));
    assert.equal(b.summary.btih, a.summary.btih, JSON.stringify(extra));
    assert.deepEqual(siteOf(b), siteOf(a), JSON.stringify(extra));
  }
  // and the tracker the apps flags add is the only reason the apps flags change the infohash's neighbours: --obs adds nothing to tr=
  assert.deepEqual(withObs.summary.tr, plain.summary.tr);
});

test('the block is never in the site payload, the pointer or the files beside it: only summary.json and the shell\'s door.json hold it', async () => {
  const dist = fakeDist();
  const res = await run({ shell: true, dist, obs: OBS.endpoint, door: ['door.example.net'], chain: 'my-site' });
  const everything = treeOf(res.outDir);
  const holders = Object.keys(everything).filter((rel) => everything[rel].includes('obs.example.org')).sort();
  assert.deepEqual(holders, ['shell/_mw/door.json', 'summary.json']);
  // the torrent's own files, the manifest and the file list included
  const manifest = JSON.parse(readFileSync(join(res.outDir, 'my-site', '.mw', 'site.json'), 'utf8'));
  assert.equal('obs' in manifest, false);
  assert.equal(res.files.some((f) => /obs/i.test(f.path)), false);
  for (const text of [res.pointer, res.magnet, readFileSync(join(res.outDir, 'pointer.txt'), 'utf8'), readFileSync(join(res.outDir, 'dns.txt'), 'utf8'), readFileSync(join(res.outDir, 'meta.html'), 'utf8'), readFileSync(join(res.outDir, 'link.txt'), 'utf8')]) {
    assert.equal(/obs/i.test(text), false, text.slice(0, 80));
  }
  // the shell's pages carry the pointer tag only
  for (const page of ['index.html', '404.html']) assert.equal(readFileSync(join(res.outDir, 'shell', page), 'utf8').includes('obs.example.org'), false, page);
});

test('publish and the door kit never contact the endpoint: a loopback server that counts what reaches it sees nothing', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.method + ' ' + req.url);
    res.writeHead(204);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = 'http://127.0.0.1:' + server.address().port;
    const dist = fakeDist();
    const rel = await release(dist);
    const site = await run({ shell: true, dist, obs: endpoint });
    assert.deepEqual(site.obs, { endpoint });
    await doorKit(kitOptions(rel, { out: join(fresh('kits'), 'kit'), dist, doorSite: [site.outDir], quiet: true }));
    assert.deepEqual(seen, [], 'nothing reached the endpoint');
  } finally {
    await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  }
});

test('publish --obs: loopback http is accepted for development; the report names the host', async () => {
  const dist = fakeDist();
  const lines = [];
  const res = await run({ shell: true, dist, obs: 'http://127.0.0.1:8787', quiet: false, log: (l) => lines.push(String(l)) });
  assert.deepEqual(res.obs, { endpoint: 'http://127.0.0.1:8787' });
  assert.deepEqual(doorOf(res).obs, { endpoint: 'http://127.0.0.1:8787' });
  assert.match(lines.find((l) => /^ {2}obs /.test(l)), /usage reports to 127\.0\.0\.1 \(in /);
  // the address a server prints for itself ends in a slash, and the one slash goes
  assert.deepEqual((await run({ obs: 'https://obs.example.org/' })).obs, OBS);
});

test('publish --obs that cannot be used stops before anything is written, and the message names the flag', async () => {
  const dist = fakeDist();
  const refuse = async (obs, re) => {
    const out = fresh('out');
    await assert.rejects(run({ shell: true, dist, out, obs }), (err) => err instanceof UsageError && re.test(err.message), JSON.stringify(obs));
    assert.deepEqual(readdirSync(out), [], 'nothing written for ' + JSON.stringify(obs));
  };
  await refuse('http://obs.example.org', /--obs is http: on a host that is not loopback/);
  await refuse('https://obs.example.org/path', /--obs is not an exact origin/);
  await refuse('https://user:pw@obs.example.org', /--obs carries a user name or password/);
  await refuse('https://obs.example.org#x', /--obs carries a fragment/);
  await refuse('obs.example.org', /--obs is not an absolute URL/);
  await refuse('ftp://obs.example.org', /--obs must be an https: origin/);
  await refuse(['https://a.example', 'https://b.example'], /--obs takes one origin, got 2/);
});

test('publish --dropin has no shell and no block: summary.json says null, the _mw/door.json it copies is as built, and a note says --obs is not used', async () => {
  const dist = fakeDist();
  const res = await run({ dropin: true, dist, ws: [], obs: OBS.endpoint });
  assert.equal(res.obs, null);
  assert.equal(summaryOf(res).obs, null);
  assert.equal(readFileSync(join(res.outDir, 'site', '_mw', 'door.json')).equals(readFileSync(join(dist, '_mw', 'door.json'))), true);
  assert.ok(res.warnings.some((w) => /^--obs https:\/\/obs\.example\.org is not used: a drop-in publish has no shell/.test(w) && /Usage reports/.test(w)), res.warnings.join('\n'));
  assert.doesNotMatch(res.warnings.join('\n'), BANNED);
  assert.equal(treeOfIncludes(res.outDir, 'obs.example.org'), false, 'the endpoint is nowhere in the output');
  const without = await run({ dropin: true, dist, ws: [] });
  assert.equal(without.warnings.some((w) => /--obs/.test(w)), false);
});
function treeOfIncludes(root, text) {
  return Object.values(treeOf(root)).some((bytes) => bytes.includes(text));
}

test('publish --shell with a loader build that has no _mw/door.json: the shell is written without the block and a note says to rebuild', async () => {
  const dist = fakeDist({ withDoorJson: false });
  const res = await run({ shell: true, dist, obs: OBS.endpoint });
  assert.ok(res.warnings.some((w) => /has no _mw\/door\.json to carry the obs block/.test(w) && /node build\.mjs/.test(w) && /written without it/.test(w)), res.warnings.join('\n'));
  assert.equal(existsSync(join(res.outDir, 'shell', '_mw', 'door.json')), false);
  assert.deepEqual(res.obs, OBS, 'summary.json still records what the flag said');
  // both blocks: one note that names both
  const both = await run(Object.assign({ shell: true, dist, obs: OBS.endpoint }, APPS_FLAGS));
  assert.ok(both.warnings.some((w) => /has no _mw\/door\.json to carry the apps and obs blocks/.test(w) && /written without them/.test(w)), both.warnings.join('\n'));
  // the apps block alone keeps its own words
  const appsOnly = await run(Object.assign({ shell: true, dist }, APPS_FLAGS));
  assert.ok(appsOnly.warnings.some((w) => /has no _mw\/door\.json to carry the apps block \(run: node build\.mjs\); the shell is written without it/.test(w)), appsOnly.warnings.join('\n'));
});

test('publish --shell --obs with a door.json that is not JSON stops before anything is written', async () => {
  const dist = fakeDist();
  writeFileSync(join(dist, '_mw', 'door.json'), '<html>error</html>');
  const out = fresh('out');
  await assert.rejects(run({ shell: true, dist, out, obs: OBS.endpoint }), (err) => err instanceof ToolError && /_mw\/door\.json is not JSON/.test(err.message));
  assert.deepEqual(readdirSync(out), [], 'nothing written');
});

test('CLI: --help lists --obs; a run with --shell prints the obs line and writes the block; a block that cannot be used exits 2 and names the flag', async () => {
  const help = spawnSync(process.execPath, ['tools/publish.mjs', '--help'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Reports: {3}--obs <origin> \(usage reports: the origin of the endpoint you run for them/m);
  assert.match(help.stdout, /it needs no --tracker, --stun or --idp/);
  assert.match(help.stdout, /an obs block from --obs goes there the same way/);
  assert.doesNotMatch(help.stdout, BANNED);
  assert.equal(/[^\x00-\x7f]/.test(help.stdout), false, 'ASCII only');
  const dist = fakeDist();
  const out = fresh('out-cli');
  const key = (await makeKey()).file;
  const base = ['tools/publish.mjs', makeSite(), '--name', 'my-site', '--scope', 'example.com', '--key', key, '--tr', 'wss://tracker.example', '--ws', 'https://static.example/ws/'];
  const r = spawnSync(process.execPath, base.concat(['--obs', OBS.endpoint, '--shell', '--dist', dist, '--allow-unverified-loader', '--out', out]), { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout.slice(0, 600));
  assert.match(r.stdout, /^ {2}obs {7}usage reports to obs\.example\.org \(in .*shell\/_mw\/door\.json\)$/m);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'shell', '_mw', 'door.json'), 'utf8')).obs, OBS);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')).obs, OBS);
  // the inline form of the flag
  const out2 = fresh('out-cli');
  const r2 = spawnSync(process.execPath, base.concat(['--obs=' + OBS.endpoint, '--out', out2]), { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stderr + r2.stdout.slice(0, 600));
  assert.deepEqual(JSON.parse(readFileSync(join(out2, 'summary.json'), 'utf8')).obs, OBS);
  // refusals
  const out3 = fresh('out-cli');
  const bad = spawnSync(process.execPath, base.concat(['--obs', 'http://obs.example.org', '--out', out3]), { cwd: ROOT, encoding: 'utf8' });
  assert.equal(bad.status, 2, bad.stderr);
  assert.match(bad.stderr, /--obs is http: on a host that is not loopback/);
  assert.deepEqual(readdirSync(out3), []);
  const noValue = spawnSync(process.execPath, base.concat(['--obs']), { cwd: ROOT, encoding: 'utf8' });
  assert.equal(noValue.status, 2);
  assert.match(noValue.stderr, /--obs needs a value/);
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

test('doorKit --door-site: the first site\'s obs block is set in the kit\'s door.json; the rest of the loader is the release byte for byte', async () => {
  const dist = fakeDist();
  const rel = await release(dist);
  const site = await run({ obs: OBS.endpoint }); // a shell-mode publish output whose summary.json holds the block
  const out = join(fresh('kits'), 'kit');
  const lines = [];
  const res = await doorKit(kitOptions(rel, { out, dist, doorSite: [site.outDir], log: (l) => lines.push(String(l)) }));
  assert.deepEqual(res.obs, OBS);
  assert.equal(res.apps, null);
  const kitDoor = readFileSync(join(out, '_mw', 'door.json'));
  const built = readFileSync(join(dist, '_mw', 'door.json'));
  const parsed = JSON.parse(kitDoor.toString('utf8'));
  assert.deepEqual(parsed.obs, OBS);
  assert.equal(Object.keys(parsed).pop(), 'obs');
  assert.equal('apps' in parsed, false);
  assert.equal(withoutObsBlock(kitDoor).equals(built), true, 'door.json minus the block is the release\'s door.json');
  assertPageReads(parsed, OBS);
  assert.equal(readFileSync(join(dist, '_mw', 'door.json')).equals(built), true, 'dist itself is not changed');
  for (const rel2 of ['index.html', '404.html', 'mw-sw.js', '_mw/boot.js', '_mw/loader.js', '_mw/open.html', 'build.json']) {
    assert.equal(readFileSync(join(out, ...rel2.split('/'))).equals(readFileSync(join(dist, ...rel2.split('/')))), true, rel2);
  }
  const line = lines.find((l) => /^ {2}obs /.test(l));
  assert.match(line, /^ {2}obs {5}usage reports to obs\.example\.org \(from my-site\), set in _mw\/door\.json: the one loader file that differs from the signed release/);
  assert.doesNotMatch(line, BANNED);
  assert.equal(lines.some((l) => /^ {2}apps /.test(l)), false, 'no apps line without an apps block');
  // The signed list names door.json without the block. The one file a verifier can name is that one, and it differs by the block alone.
  const verdict = await verifyRelease({ dir: out, list: rel.parsed, sig: rel.parsedSig, publicKey: rel.pub, pinnedKeys: [rel.pub], allowExtra: true, expectExtra: doorKitFiles({ version: '0.3.0' }) });
  assert.ok(verdict.problems.length > 0 && verdict.problems.every((p) => p.startsWith('_mw/door.json')), verdict.problems.join('; '));
});

test('doorKit --door-site: a site with both blocks gives the kit both, apps first; each comes from the first site only', async () => {
  const dist = fakeDist();
  const rel = await release(dist);
  const both = await run(Object.assign({ obs: OBS.endpoint }, APPS_FLAGS));
  const appsOnly = await run(APPS_FLAGS);
  const obsOnly = await run({ obs: OBS.endpoint });
  const none = await run({});
  const built = readFileSync(join(dist, '_mw', 'door.json'));
  const kitOf = async (sites, quiet = true, log = null) => {
    const out = join(fresh('kits'), 'kit');
    const res = await doorKit(kitOptions(rel, { out, dist, doorSite: sites.map((s) => s.outDir), quiet, log }));
    return { out, res, door: readFileSync(join(out, '_mw', 'door.json')) };
  };
  const kit = await kitOf([both]);
  assert.deepEqual(kit.res.apps, APPS);
  assert.deepEqual(kit.res.obs, OBS);
  assert.deepEqual(Object.keys(JSON.parse(kit.door.toString('utf8'))).slice(-2), ['apps', 'obs']);
  assert.equal(withoutObsBlock(withoutAppsBlock(kit.door)).equals(built), true);
  assert.equal(kit.door.equals(withObsBlock(withAppsBlock(built, APPS), OBS)), true);
  // a kit without any block is the release's file, and verifies
  const plain = await kitOf([none]);
  assert.equal(plain.res.obs, null);
  assert.equal(plain.door.equals(built), true);
  const verdictPlain = await verifyRelease({ dir: plain.out, list: rel.parsed, sig: rel.parsedSig, publicKey: rel.pub, pinnedKeys: [rel.pub], allowExtra: true, expectExtra: doorKitFiles({ version: '0.3.0' }) });
  assert.equal(verdictPlain.ok, true, verdictPlain.problems.join('; '));
  // the apps block from the first site and the obs block of a later one: the kit has the apps block, and a note says the obs block was left out
  const lines = [];
  const order = await kitOf([appsOnly, obsOnly], false, (l) => lines.push(String(l)));
  assert.deepEqual(order.res.apps, APPS);
  assert.equal(order.res.obs, null);
  assert.equal(JSON.parse(order.door.toString('utf8')).obs, undefined);
  assert.ok(lines.some((l) => /^ {2}obs {5}none in the kit: only the first --door-site names the door's usage reports, and it has no obs block \(my-site has one\)$/.test(l)), lines.join('\n'));
  assert.doesNotMatch(lines.join('\n'), BANNED);
  // the first site has one: it is used, whatever follows
  const first = await kitOf([obsOnly, none]);
  assert.deepEqual(first.res.obs, OBS);
});

test('doorKit --door-site: an obs block in summary.json that cannot be used is refused before the kit folder is touched, and so is a loader build with no door.json to carry it', async () => {
  const dist = fakeDist();
  const rel = await release(dist);
  const site = await run({ obs: OBS.endpoint });
  const summaryFile = join(site.outDir, 'summary.json');
  const summary = JSON.parse(readFileSync(summaryFile, 'utf8'));
  const kept = join(fresh('kits'), 'kept');
  await doorKit(kitOptions(rel, { out: kept, dist, doorSite: [site.outDir], quiet: true }));
  const keptDoor = readFileSync(join(kept, '_mw', 'door.json'));
  writeFileSync(summaryFile, JSON.stringify(Object.assign({}, summary, { obs: { endpoint: 'http://obs.example.org' } })));
  const k1 = join(fresh('kits'), 'k1');
  await assert.rejects(doorKit(kitOptions(rel, { out: k1, dist, doorSite: [site.outDir], quiet: true })),
    (err) => err instanceof ToolError && /the obs block in summary\.json is not usable \(endpoint is http: on a host that is not loopback/.test(err.message) && /publish the site again with --obs/.test(err.message));
  assert.equal(existsSync(k1), false, 'no kit folder was made');
  await assert.rejects(doorKit(kitOptions(rel, { out: kept, dist, doorSite: [site.outDir], quiet: true })), /not usable/);
  assert.equal(readFileSync(join(kept, '_mw', 'door.json')).equals(keptDoor), true, 'the earlier kit is untouched');
  writeFileSync(summaryFile, JSON.stringify(Object.assign({}, summary, { obs: 'yes' })));
  await assert.rejects(doorKit(kitOptions(rel, { out: join(fresh('kits'), 'k2'), dist, doorSite: [site.outDir], quiet: true })), /the obs block in summary\.json is not usable \(the obs block is not an object\)/);
  // a loader whose release list has no door.json (an old build) cannot carry a block
  const old = fakeDist({ withDoorJson: false });
  const oldRel = await release(old);
  writeFileSync(summaryFile, JSON.stringify(summary));
  const k3 = join(fresh('kits'), 'k3');
  await assert.rejects(doorKit(kitOptions(oldRel, { out: k3, dist: old, doorSite: [site.outDir], quiet: true })),
    (err) => err instanceof ToolError && /^--door-site .* has an obs block, but the loader in .* has no _mw\/door\.json to carry it \(run: node build\.mjs\)$/.test(err.message));
  assert.equal(existsSync(k3), false, 'no kit folder was made');
  // with both blocks the message names both
  const both = await run(Object.assign({ obs: OBS.endpoint }, APPS_FLAGS));
  await assert.rejects(doorKit(kitOptions(oldRel, { out: join(fresh('kits'), 'k4'), dist: old, doorSite: [both.outDir], quiet: true })), /has an apps block and an obs block, but the loader in/);
});

test('doorKit: the kit can be made again into the same folder, with or without the block; a site published before --obs existed has none', async () => {
  const dist = fakeDist();
  const rel = await release(dist);
  const withBlock = await run({ obs: OBS.endpoint });
  const out = join(fresh('kits'), 'kit');
  await doorKit(kitOptions(rel, { out, dist, doorSite: [withBlock.outDir], quiet: true }));
  assert.ok(JSON.parse(readFileSync(join(out, '_mw', 'door.json'), 'utf8')).obs);
  await doorKit(kitOptions(rel, { out, dist, quiet: true }));
  assert.equal(readFileSync(join(out, '_mw', 'door.json')).equals(readFileSync(join(dist, '_mw', 'door.json'))), true, 'a kit without a site is the plain loader again');
  // a summary.json from an older publish has no obs key at all
  const older = await run({});
  const summaryFile = join(older.outDir, 'summary.json');
  const summary = JSON.parse(readFileSync(summaryFile, 'utf8'));
  delete summary.obs;
  writeFileSync(summaryFile, JSON.stringify(summary));
  const res = await doorKit(kitOptions(rel, { out, dist, doorSite: [older.outDir], quiet: true }));
  assert.equal(res.obs, null);
  assert.equal(readFileSync(join(out, '_mw', 'door.json')).equals(readFileSync(join(dist, '_mw', 'door.json'))), true);
});

test('CLI: --door-kit with --obs exits 2 and says the block comes from the first --door-site', () => {
  const r = spawnSync(process.execPath, ['tools/publish.mjs', '--door-kit', join(fresh('kits'), 'kit'), '--obs', OBS.endpoint], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--obs belongs to a publish: a door kit takes the usage reports block of the first --door-site/);
});

test('the words of the new messages follow the wording rules (no dashes, curly quotes or banned terms, ASCII only)', async () => {
  const source = readFileSync(join(ROOT, 'tools', 'apps-block.mjs'), 'utf8');
  assert.doesNotMatch(source, BANNED);
  assert.equal(/[^\x00-\x7f]/.test(source), false, 'tools/apps-block.mjs is ASCII');
  const lines = [];
  const dist = fakeDist();
  const rel = await release(dist);
  const site = await run({ obs: OBS.endpoint });
  await doorKit(kitOptions(rel, { out: join(fresh('kits'), 'kit'), dist, doorSite: [site.outDir], log: (l) => lines.push(String(l)) }));
  const noDoorJson = await run({ shell: true, dist: fakeDist({ withDoorJson: false }), obs: OBS.endpoint });
  const dropin = await run({ dropin: true, dist, ws: [], obs: OBS.endpoint });
  const messages = [];
  for (const problems of [obsBlockProblems({}), obsBlockProblems({ endpoint: 'http://obs.example.org' }), obsBlockProblems({ endpoint: 'https://obs.example.org/x' }), obsBlockProblems({ endpoint: 'ftp://x' })]) messages.push(...problems);
  for (const input of [undefined, ['https://a.example', 'https://b.example'], 'http://obs.example.org']) {
    try {
      makeObsBlock(input);
    } catch (err) {
      messages.push(err.message);
    }
  }
  for (const text of lines.concat(noDoorJson.warnings, dropin.warnings, messages)) {
    assert.doesNotMatch(text, BANNED, text);
    assert.equal(/[^\x00-\x7f]/.test(text), false, 'ASCII only: ' + text);
  }
  assert.ok(messages.length >= 7);
});
