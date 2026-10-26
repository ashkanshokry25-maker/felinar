// Unit tests for the doors lane in tools/publish.mjs (v0.3 C2, docs/research/v03/S4-doors.md D2, D7): link mode (--door: the same
// record signed for the hub scope btih:<hex> with dr=, link.txt, link-card.txt with a QR code, link-qr.svg, doors.json; the size
// warnings), and the door kit (--door-kit: the built loader copied unchanged only after it matches the signed release list, plus the
// host settings, the README and, with --door-site, a site's bytes). No network: everything runs in temporary directories.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, cpSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { publish, doorList, qrText, qrSvg, linkCardText, doorKitFiles, doorKit, PUBLISH_FLAGS } from '../../tools/publish.mjs';
import { keygen } from '../../tools/keygen.mjs';
import { loadOwnerKey, UsageError, ToolError, ROOT } from '../../tools/lib.mjs';
import { buildHashList, signList } from '../../tools/verify-release.mjs';
import { parsePointer, verifyPointer, parseLightLink, ledgerIdFor, DOOR_PAGE_PATH } from '../../src/common/pointer.js';
import { encode as qrEncode, decodeMatrix } from '../../src/idp/qr.js';

const work = mkdtempSync(join(tmpdir(), 'mw-doors-publish-'));
after(() => rmSync(work, { recursive: true, force: true }));
const NOW = Date.UTC(2026, 9, 20, 12, 0, 30);
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
function makeSite() {
  const dir = fresh('site');
  writeTree(dir, { 'index.html': '<!doctype html><html><head><meta charset="utf-8"><title>Home</title></head><body><h1>Home</h1></body></html>\n', 'css/app.css': 'body { margin: 0 }\n' });
  return dir;
}
let keyCounter = 0;
async function makeKey() {
  const file = join(work, 'owner-' + ++keyCounter + '.jwk');
  const res = await keygen({ out: file });
  return { file, pub: res.pub };
}
async function run(extra = {}) {
  const key = extra.key || (await makeKey()).file;
  return publish(Object.assign({
    dir: makeSite(), name: 'my-site', scope: 'example.com', key, tr: ['wss://tracker.example'], ws: ['https://static.example/ws/'],
    out: fresh('out'), now: NOW, quiet: true,
  }, extra));
}
const BANNED = /blockchain|serverless|unstoppable|censorship|production-ready|[\u2013\u2014\u2018\u2019\u201c\u201d]/i;

// ---------------------------------------------------------------------------------------------- link mode

test('doorList: lowercase door hosts, distinct, at most 8; anything else is a usage error', () => {
  assert.deepEqual(doorList(['a.example.org', 'b.example.net:8443', 'c.example,d.example']), ['a.example.org', 'b.example.net:8443', 'c.example', 'd.example']);
  for (const bad of [['https://a.example'], ['A.example'], ['a.example/x'], ['a.example', 'a.example'], ['intranet']]) assert.throws(() => doorList(bad), UsageError, bad.join(' '));
  assert.throws(() => doorList(Array.from({ length: 9 }, (_, i) => 'd' + i + '.example')), /at most 8/);
  assert.deepEqual(doorList(undefined), []);
  for (const f of ['door', 'door-kit', 'door-site', 'release-list', 'release-sig', 'release-key']) assert.ok(PUBLISH_FLAGS[f], f);
});

test('link mode needs --chain: the light link is signed for btih:<hex>, which changes with every version', async () => {
  await assert.rejects(run({ door: ['mirror.example.org'] }), (err) => err instanceof UsageError && /--door needs --chain/.test(err.message));
});

test('link mode: the same record signed for btih:<hex> with dr=; link.txt, link-card.txt, link-qr.svg and doors.json; the ledger id is the page tag\'s', async () => {
  const owner = await makeKey();
  const res = await run({ key: owner.file, chain: 'my-site', door: ['mirror.example.org', 'door.example.net:8443', 'third.example.com'], org: ['https://example.com'] });
  for (const f of ['link.txt', 'link-card.txt', 'link-qr.svg', 'doors.json']) assert.ok(existsSync(join(res.outDir, f)), f);
  assert.ok(res.outputs.includes('link.txt'));
  const linkLine = readFileSync(join(res.outDir, 'link.txt'), 'utf8').trim();
  assert.equal(linkLine, res.link.primary);
  assert.ok(linkLine.startsWith('https://mirror.example.org' + DOOR_PAGE_PATH + '#v%3Dmw1'));
  const p = parseLightLink(linkLine);
  assert.equal(p.ok, true);
  assert.equal(p.door, 'mirror.example.org');
  const rec = parsePointer(p.record).record;
  assert.deepEqual(rec.dr, ['mirror.example.org', 'door.example.net:8443', 'third.example.com']);
  assert.deepEqual(rec.org, ['https://example.com'], 'org= is left as the owner gave it');
  assert.equal(rec.btih, res.btih);
  const v = await verifyPointer(rec, 'btih:' + res.btih, { now: NOW });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal((await verifyPointer(rec, 'example.com', { now: NOW })).reason, 'bad-sig', 'the link record is not the page tag');
  assert.equal(await ledgerIdFor(rec, 'btih:' + res.btih), res.ledgerId, 'one ledger id on every door: owner and chain');
  // the page tag itself carries no dr=
  assert.deepEqual(parsePointer(res.pointer).record.dr, []);
  // fallbacks: the second and third door
  assert.deepEqual(res.link.fallbacks.map((l) => parseLightLink(l).door), ['door.example.net:8443', 'third.example.com']);
  const doors = JSON.parse(readFileSync(join(res.outDir, 'doors.json'), 'utf8'));
  assert.equal(doors.kind, 'felinar-doors');
  assert.equal(doors.scope, 'btih:' + res.btih);
  assert.equal(doors.record, p.record);
  assert.deepEqual(doors.owner, ['example.com']);
  assert.deepEqual(doors.guest, rec.dr);
  assert.deepEqual(doors.fullDoor, { webseed: '/ws/my-site/', torrent: '/_mw/t/' + res.btih + '.torrent' });
  assert.equal(doors.ledgerId, res.ledgerId);
  // the QR code of the card decodes back to the primary link
  const qr = qrEncode(res.link.primary, { ecl: 'L' });
  assert.equal(decodeMatrix(qr).text, res.link.primary);
  assert.equal(doors.qr.version, qr.version);
  const card = readFileSync(join(res.outDir, 'link-card.txt'), 'utf8');
  assert.ok(card.includes(res.link.primary));
  assert.ok(card.includes(res.link.fallbacks[0]));
  assert.ok(card.includes(res.link.web) && res.link.web.startsWith('web+felinar:'));
  assert.match(card, /cannot switch doors by itself|cannot do: when its first address is blocked or down/);
  assert.match(card, /█/, 'the QR code as block characters');
  assert.doesNotMatch(card.replace(/[▀-█]/g, ''), BANNED);
  assert.match(readFileSync(join(res.outDir, 'link-qr.svg'), 'utf8'), /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  const summary = JSON.parse(readFileSync(join(res.outDir, 'summary.json'), 'utf8'));
  assert.equal(summary.link.primary, res.link.primary);
});

test('link mode: one door gets the site\'s own address as a fallback; a run without --door removes the link files of an earlier run', async () => {
  const owner = await makeKey();
  const out = fresh('out');
  const res = await run({ key: owner.file, chain: 'my-site', door: ['mirror.example.org'], out });
  assert.deepEqual(res.link.fallbacks.map((l) => parseLightLink(l).door), ['example.com']);
  const again = await run({ key: owner.file, chain: 'my-site', out });
  assert.equal(again.link, null);
  for (const f of ['link.txt', 'link-card.txt', 'link-qr.svg', 'doors.json']) assert.equal(existsSync(join(out, f)), false, f);
});

test('link mode: above 450 bytes a warning names the link record; above 900 publish refuses', async () => {
  const owner = await makeKey();
  const res = await run({ key: owner.file, chain: 'my-site', door: ['mirror.example.org'] });
  assert.ok(res.link.bytes > 450, 'a hub record is above the SHOULD, as S4 F1 measured (' + res.link.bytes + ')');
  assert.ok(res.warnings.some((w) => /the link record is \d+ bytes/.test(w)), res.warnings.join('\n'));
  const long = Array.from({ length: 8 }, (_, i) => 'door-number-' + i + '-with-a-long-name.example-hosting-provider.org');
  const longTr = Array.from({ length: 4 }, (_, i) => 'wss://tracker-' + i + '.a-rather-long-tracker-domain-name.example/announce');
  await assert.rejects(run({ key: owner.file, chain: 'my-site', door: long, tr: longTr, org: ['https://example.com', 'https://www.example.com', 'https://shop.example.com', 'https://blog.example.com'] }), (err) => err instanceof ToolError && /link record is \d+ bytes; a record must stay at or under 900/.test(err.message));
});

test('qrText / qrSvg / linkCardText: the code as text two rows a line, as an image, and the card\'s honest last line', () => {
  const qr = qrEncode('https://door.example/_mw/open.html#v%3Dmw1', { ecl: 'L' });
  const text = qrText(qr, { margin: 4 });
  const lines = text.replace(/\n$/, '').split('\n');
  assert.equal(lines.length, Math.ceil((qr.size + 8) / 2));
  assert.ok(lines.every((l) => l.length <= qr.size + 8));
  const svg = qrSvg(qr);
  assert.match(svg, /viewBox="0 0 \d+ \d+"/);
  const card = linkCardText({ name: 'x', primary: 'P', fallbacks: ['F1', 'F2', 'F3'], web: 'web+felinar:W', qr, bytes: 500, expires: '2027-01-01' });
  assert.ok(card.includes('F2') && !card.includes('F3'), 'two fallbacks');
  assert.match(card, /nothing of the site runs/);
});

// ---------------------------------------------------------------------------------------------- door kit

function fakeDist() {
  const dist = fresh('dist');
  writeTree(dist, {
    'index.html': '<!doctype html><title>Loading site</title><script src="/_mw/boot.js"></script>',
    '404.html': '<!doctype html><title>Loading site</title>',
    'mw-sw.js': '// sw\n',
    '_mw/boot.js': '// boot\n',
    '_mw/loader.js': '// loader\n',
    '_mw/open.html': '<!doctype html><title>Loading site</title><link rel="manifest" href="/_mw/door.webmanifest">',
    '_mw/door.json': '{"v":1}\n',
    'build.json': '{"version":"0.3.0"}\n',
  });
  return dist;
}
async function release(dist) {
  const keyFile = join(work, 'release-' + ++keyCounter + '.jwk');
  const k = await keygen({ out: keyFile });
  const owner = await loadOwnerKey(keyFile);
  const list = buildHashList({ dir: dist, version: '0.3.0' });
  const sig = await signList(list, { privateKey: owner.privateKey, pub: owner.pub });
  const dir = fresh('release');
  writeFileSync(join(dir, 'hashes-dist.json'), JSON.stringify(list, null, 2) + '\n');
  writeFileSync(join(dir, 'hashes-dist.json.sig'), JSON.stringify(sig, null, 2) + '\n');
  return { pub: k.pub, list: join(dir, 'hashes-dist.json'), sig: join(dir, 'hashes-dist.json.sig') };
}

// The release key built into tools/verify-release.mjs (PINNED_RELEASE_KEYS) refuses a list signed by any other key (SUP-2, SUP-12), so
// each doorKit run below pins the fixture's own key (releasePinnedKeys, an internal option no flag sets), and the command line runs a
// copy of the tools with that key built in.
const PINNED_LINE = /^export const PINNED_RELEASE_KEYS = Object\.freeze\(\[(.*)\]\);$/m;
/** toolsPinnedTo(keys) -> a copy of tools/ and src/ (the module graph of tools/publish.mjs; create-torrent comes from node_modules) whose PINNED_RELEASE_KEYS line holds keys. */
function toolsPinnedTo(keys) {
  const dir = fresh('tools-pinned');
  for (const sub of ['tools', 'src']) cpSync(join(ROOT, sub), join(dir, sub), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'felinar-tools-copy', private: true, type: 'module' }));
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'junction');
  const file = join(dir, 'tools', 'verify-release.mjs');
  const src = readFileSync(file, 'utf8');
  assert.match(src, PINNED_LINE, 'PINNED_RELEASE_KEYS is one line of the form step 3b writes');
  writeFileSync(file, src.replace(PINNED_LINE, () => 'export const PINNED_RELEASE_KEYS = Object.freeze(' + JSON.stringify(keys) + ');'));
  return dir;
}

test('doorKitFiles: CORS on door.json, no-cache on the worker, the root opens the door page, plain words in README-DOOR.txt', () => {
  const f = doorKitFiles({ version: '0.3.0' });
  assert.deepEqual(Object.keys(f).sort(), ['.nojekyll', 'Caddyfile', 'README-DOOR.txt', '_headers', '_redirects', 'vercel.json']);
  assert.match(f._headers, /\/_mw\/door\.json\n {2}Access-Control-Allow-Origin: \*\n {2}Cache-Control: no-cache/);
  assert.match(f._headers, /\/mw-sw\.js\n {2}Content-Type: text\/javascript; charset=utf-8\n {2}Cache-Control: no-cache/);
  assert.match(f._redirects, /^\/ \/_mw\/open\.html 302$/m);
  const v = JSON.parse(f['vercel.json']);
  assert.deepEqual(v.redirects, [{ source: '/', destination: '/_mw/open.html', permanent: false }]);
  assert.ok(v.headers.some((h) => h.source === '/_mw/door.json' && h.headers.some((x) => x.key === 'Access-Control-Allow-Origin' && x.value === '*')));
  assert.match(f.Caddyfile, /redir @root \/_mw\/open\.html 302/);
  assert.match(f.Caddyfile, /header \/mw-sw\.js Cache-Control "no-cache"/);
  assert.match(f['README-DOOR.txt'], /A link cannot reroute itself/);
  assert.match(f['README-DOOR.txt'], /check-site\.mjs https:\/\/<this host>\/ --door/);
  for (const [name, text] of Object.entries(f)) assert.doesNotMatch(text, BANNED, name);
});

test('doorKit: refuses unless every loader byte matches the signed release list; then copies it unchanged and adds the host files', async () => {
  const dist = fakeDist();
  const rel = await release(dist);
  const out = join(fresh('kits'), 'kit');
  const res = await doorKit({ out, dist, releaseList: rel.list, releaseSig: rel.sig, releaseKey: rel.pub, releasePinnedKeys: [rel.pub], quiet: true });
  assert.equal(res.version, '0.3.0');
  for (const f of ['index.html', 'mw-sw.js', '_mw/open.html', '_mw/loader.js', 'hashes-dist.json', 'hashes-dist.json.sig', '_headers', '_redirects', 'vercel.json', 'Caddyfile', 'README-DOOR.txt', '.nojekyll']) {
    assert.ok(existsSync(join(out, ...f.split('/'))), f);
  }
  assert.equal(readFileSync(join(out, '_mw', 'loader.js'), 'utf8'), '// loader\n');
  assert.equal(readFileSync(join(out, 'hashes-dist.json'), 'utf8'), readFileSync(rel.list, 'utf8'));
  // a kit can be made again into the same folder; any other non-empty folder is refused
  await doorKit({ out, dist, releaseList: rel.list, releaseSig: rel.sig, releaseKey: rel.pub, releasePinnedKeys: [rel.pub], quiet: true });
  const other = fresh('not-a-kit');
  writeFileSync(join(other, 'notes.txt'), 'keep');
  await assert.rejects(doorKit({ out: other, dist, releaseList: rel.list, releaseSig: rel.sig, releaseKey: rel.pub, releasePinnedKeys: [rel.pub], quiet: true }), /not a door kit/);
  // one changed byte in the build, a wrong key, or no list: refused
  writeFileSync(join(dist, '_mw', 'loader.js'), '// loader!\n');
  await assert.rejects(doorKit({ out: join(fresh('kits'), 'k'), dist, releaseList: rel.list, releaseSig: rel.sig, releaseKey: rel.pub, releasePinnedKeys: [rel.pub], quiet: true }), (err) => err instanceof ToolError && /does not match the signed release list \(files\)/.test(err.message));
  writeFileSync(join(dist, '_mw', 'loader.js'), '// loader\n');
  const stranger = await makeKey();
  // the stranger's key, built in and given, did not sign the list: the signature fails under it
  await assert.rejects(doorKit({ out: join(fresh('kits'), 'k'), dist, releaseList: rel.list, releaseSig: rel.sig, releaseKey: stranger.pub, releasePinnedKeys: [stranger.pub], quiet: true }), /\(signature\)/);
  await assert.rejects(doorKit({ out: join(fresh('kits'), 'k'), dist, releaseKey: rel.pub, quiet: true }), UsageError);
  const noDoor = fresh('dist-old');
  writeTree(noDoor, { 'index.html': 'x' });
  await assert.rejects(doorKit({ out: join(fresh('kits'), 'k'), dist: noDoor, releaseList: rel.list, releaseSig: rel.sig, releaseKey: rel.pub, quiet: true }), /no _mw\/open\.html/);
});

test('doorKit --door-site: a full door also serves a site\'s web seed copy under /ws/<name>/ and its .torrent at /_mw/t/<btih>.torrent', async () => {
  const dist = fakeDist();
  const rel = await release(dist);
  const pub = await run({ chain: 'my-site' });
  const out = join(fresh('kits'), 'kit');
  const res = await doorKit({ out, dist, releaseList: rel.list, releaseSig: rel.sig, releaseKey: rel.pub, releasePinnedKeys: [rel.pub], doorSite: [pub.outDir], quiet: true });
  assert.deepEqual(res.sites, [{ name: 'my-site', btih: pub.btih, webseed: '/ws/my-site/', torrent: '/_mw/t/' + pub.btih + '.torrent' }]);
  assert.equal(readFileSync(join(out, 'ws', 'my-site', 'index.html'), 'utf8'), readFileSync(join(pub.outDir, 'my-site', 'index.html'), 'utf8'));
  assert.ok(readFileSync(join(out, '_mw', 't', pub.btih + '.torrent')).equals(readFileSync(join(pub.outDir, 'site.torrent'))));
  const drop = fresh('fake-pub');
  writeFileSync(join(drop, 'summary.json'), JSON.stringify({ mode: 'dropin', name: 'x', btih: 'a'.repeat(40) }));
  await assert.rejects(doorKit({ out: join(fresh('kits'), 'k2'), dist, releaseList: rel.list, releaseSig: rel.sig, releaseKey: rel.pub, releasePinnedKeys: [rel.pub], doorSite: [drop], quiet: true }), /not a shell-mode publish output/);
});

test('CLI: --door-kit runs without a site directory and prints what it added', async () => {
  const dist = fakeDist();
  const rel = await release(dist);
  const out = join(fresh('kits'), 'kit-cli');
  const r = spawnSync(process.execPath, [join(toolsPinnedTo([rel.pub]), 'tools', 'publish.mjs'), '--door-kit', out, '--dist', dist, '--release-list', rel.list, '--release-sig', rel.sig, '--release-key', rel.pub], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /door kit .*felinar 0\.3\.0/);
  assert.match(r.stdout, /check-site\.mjs https:\/\/<host>\/ --door/);
  assert.ok(readdirSync(out).includes('README-DOOR.txt'));
  const bad = spawnSync(process.execPath, [join(ROOT, 'tools', 'publish.mjs'), '--door-kit', out, 'some-site'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});
