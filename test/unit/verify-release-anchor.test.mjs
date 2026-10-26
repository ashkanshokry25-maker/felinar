// The signed hash lists are the anchor of a release (IND-3 and IND-6, .orchestration/reports/independence-design-2026-10-25.md).
// The project holds no domain, so the release key lives in the tools themselves: step 3b of docs/PUBLISH-CHECKLIST.md writes it
// into PINNED_RELEASE_KEYS of tools/verify-release.mjs, and a copy of the release files from any mirror, door, torrent or USB stick
// passes or fails the same check as a download from GitHub. These tests run the checklist's own lines on a temporary copy of the
// tools, then run `verify` from that copy against a copy of a fixture release, with no gh on PATH, file reads limited to the
// temporary folder (node --permission) and every network call made to throw. Nothing here leaves this machine.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, realpathSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import { buildHashList, signList, PINNED_RELEASE_KEYS } from '../../tools/verify-release.mjs';
import { keygen } from '../../tools/keygen.mjs';
import { loadOwnerKey, ROOT } from '../../tools/lib.mjs';
import { isPublicKeyString } from '../../src/chain/crypto.js';

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const CHECKLIST = read('docs/PUBLISH-CHECKLIST.md');
const CHECKLIST_LINES = CHECKLIST.split('\n');
const PLACEHOLDER = 'RELEASE-KEY-NOT-PINNED-YET';
const PINNED_LINE = /^export const PINNED_RELEASE_KEYS = Object\.freeze\(\[(.*)\]\);$/m;
// The module graph of tools/verify-release.mjs (its relative imports, followed by hand; the copy test fails if one is missing).
const TOOL_FILES = ['tools/verify-release.mjs', 'tools/lib.mjs', 'tools/door-kit-files.mjs', 'src/chain/crypto.js', 'src/chain/canonical.js'];

const work = realpathSync(mkdtempSync(join(tmpdir(), 'mw-release-anchor-')));
after(() => rmSync(work, { recursive: true, force: true }));
let n = 0;
const fresh = (label) => {
  const dir = join(work, label + '-' + ++n);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const has = (cmd) => spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;
const HAVE_PERL = has('perl');

async function releaseKey(label) {
  const file = join(work, label + '-' + ++n + '.jwk');
  const res = await keygen({ out: file });
  return { pub: res.pub, identity: await loadOwnerKey(file) };
}

/** A copy of the tools that verify needs, with README.md and SECURITY.md as they stand (placeholder restored if pinned). */
function copyTools() {
  const dir = fresh('tools-copy');
  for (const rel of TOOL_FILES) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), read(rel));
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'felinar-tools-copy', private: true, type: 'module' }));
  // Back to the state step 3b starts from, whatever the tree holds now.
  const src = read('tools/verify-release.mjs');
  assert.match(src, PINNED_LINE, 'PINNED_RELEASE_KEYS is one line of the form step 3b rewrites');
  writeFileSync(join(dir, 'tools/verify-release.mjs'), src.replace(PINNED_LINE, 'export const PINNED_RELEASE_KEYS = Object.freeze([]);'));
  const unpin = (text) => text.replace(/`p256:[A-Za-z0-9_-]{87}`/g, '`' + PLACEHOLDER + '`');
  writeFileSync(join(dir, 'README.md'), unpin(read('README.md')));
  writeFileSync(join(dir, 'SECURITY.md'), unpin(read('SECURITY.md')));
  return dir;
}

/** The then-branch of step 3b's if block: the lines that pin RELEASE_PUB, exactly as the checklist has them. */
function step3bPinLines() {
  const start = CHECKLIST_LINES.findIndex((l) => /^ {2}export RELEASE_PUB && perl /.test(l));
  assert.ok(start > 0, 'step 3b pins with "export RELEASE_PUB && perl ..."');
  const end = CHECKLIST_LINES.indexOf('else', start);
  assert.ok(end > start, 'the pin lines end at the else of the if block');
  const lines = CHECKLIST_LINES.slice(start, end).join('\n');
  assert.match(lines, /PINNED_RELEASE_KEYS/, 'step 3b names PINNED_RELEASE_KEYS');
  assert.match(lines, /tools\/verify-release\.mjs/, 'step 3b writes tools/verify-release.mjs');
  return lines;
}

function step3bLoop() {
  const loop = CHECKLIST_LINES.filter((l) => /^for f in README\.md SECURITY\.md tools\/verify-release\.mjs; do /.test(l));
  assert.equal(loop.length, 1, 'step 3b checks all three files');
  return loop[0];
}

function gateToolsGrep() {
  const hits = CHECKLIST_LINES.map((l) => /^ {2}&& (grep -Eq "\^export const PINNED_RELEASE_KEYS[^"]+" tools\/verify-release\.mjs) \\$/.exec(l)).filter(Boolean);
  assert.equal(hits.length, 2, 'the gate line of step 5b and its copy in section 11 stop while PINNED_RELEASE_KEYS is empty');
  assert.equal(hits[0][1], hits[1][1]);
  return hits[0][1];
}

const sh = (script, cwd, env = {}) => spawnSync('/bin/sh', ['-c', script], { cwd, encoding: 'utf8', env: Object.assign({}, process.env, env) });

/** pin(dir, pub) runs step 3b's own lines in dir and returns the loop's output. */
function pin(dir, pub) {
  const r = sh(step3bPinLines(), dir, { RELEASE_PUB: pub });
  assert.equal(r.status, 0, r.stderr);
  const loop = sh(step3bLoop(), dir, { RELEASE_PUB: pub });
  assert.equal(loop.status, 0, loop.stderr);
  return loop.stdout;
}

// A preload that makes every way out of the process throw and say so on stderr.
const GUARD = join(work, 'no-network.mjs');
writeFileSync(GUARD, `
import net from 'node:net'; import tls from 'node:tls'; import dns from 'node:dns'; import dgram from 'node:dgram';
import http from 'node:http'; import https from 'node:https';
const trip = (what) => function () { process.stderr.write('NETWORK-ATTEMPT ' + what + '\\n'); throw new Error('no network in this test: ' + what); };
net.Socket.prototype.connect = trip('net.Socket.connect'); net.connect = net.createConnection = trip('net.connect'); tls.connect = trip('tls.connect');
dns.lookup = trip('dns.lookup'); dns.resolve = trip('dns.resolve'); dns.promises.lookup = trip('dns.promises.lookup'); dns.promises.resolve = trip('dns.promises.resolve');
dgram.createSocket = trip('dgram.createSocket'); http.request = http.get = trip('http.request'); https.request = https.get = trip('https.request');
globalThis.fetch = trip('fetch'); globalThis.WebSocket = trip('WebSocket');
`);

/** Runs a copy of verify-release with no gh on PATH, reads limited to the temporary folder and the network guard. */
function isolatedVerify(toolsDir, args) {
  return spawnSync(process.execPath, ['--permission', '--allow-fs-read=' + work, '--import', GUARD, join(toolsDir, 'tools/verify-release.mjs'), 'verify', ...args], {
    cwd: work, encoding: 'utf8', env: { PATH: '', HOME: work, LANG: 'C' },
  });
}

function fixtureRelease(version = '0.3.0') {
  const dir = fresh('release');
  const files = {
    'dist/index.html': '<!doctype html><title>loader</title>\n',
    'dist/404.html': '<!doctype html><title>loader</title>\n',
    'dist/mw-sw.js': 'self.addEventListener("install", () => {});\n',
    'dist/_mw/loader.js': 'export const loader = 1;\n',
    'dist/build.json': JSON.stringify({ name: 'felinar', version, buildId: 'fixture' }),
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

async function signInto(dir, key, name = 'hashes-dist.json') {
  const list = buildHashList({ dir: join(dir, 'dist') });
  writeFileSync(join(dir, name), JSON.stringify(list, null, 2) + '\n');
  writeFileSync(join(dir, name + '.sig'), JSON.stringify(await signList(list, key.identity)) + '\n');
}

// ---------------------------------------------------------------------------------------------------------------- IND-3

test('IND-3: PINNED_RELEASE_KEYS holds only P-256 public keys (empty until the owner makes the release key)', () => {
  assert.ok(Array.isArray(PINNED_RELEASE_KEYS) && Object.isFrozen(PINNED_RELEASE_KEYS));
  for (const k of PINNED_RELEASE_KEYS) {
    assert.match(k, /^p256:[A-Za-z0-9_-]{87}$/, k);
    assert.ok(isPublicKeyString(k), k);
  }
  assert.match(read('tools/verify-release.mjs'), PINNED_LINE, 'one line, as step 3b and the gate line expect');
});

test('IND-3: the key SECURITY.md and the README show is the key built into the tools (both empty until step 3b runs)', () => {
  const security = read('SECURITY.md');
  const shown = security.split('\n').filter((l) => /^`(?:p256:[A-Za-z0-9_-]+|RELEASE-KEY-NOT-PINNED-YET)`$/.test(l)).map((l) => l.slice(1, -1));
  assert.equal(shown.length, 1, 'SECURITY.md shows the release key once, on its own line');
  const readme = /Releases are signed with the release key `([^`]+)`/.exec(read('README.md').replace(/\s+/g, ' '));
  assert.ok(readme, 'the README names the release key');
  assert.equal(readme[1], shown[0], 'README and SECURITY.md show the same key');
  if (shown[0] === PLACEHOLDER) assert.deepEqual([...PINNED_RELEASE_KEYS], [], 'no key in the tools while the documents show none');
  else assert.deepEqual([...PINNED_RELEASE_KEYS], [shown[0]], 'the documents and the tools pin the same key');
});

test('IND-3: step 3b pins the key in README.md, SECURITY.md and tools/verify-release.mjs, and the gate line sees it', { skip: !HAVE_PERL && 'perl is not installed' }, async () => {
  const dir = copyTools();
  const gate = gateToolsGrep();
  assert.equal(sh(gate, dir).status, 1, 'the gate stops while PINNED_RELEASE_KEYS is empty');
  const project = await releaseKey('project');
  const out = pin(dir, project.pub);
  assert.equal(out, 'pinned README.md\npinned SECURITY.md\npinned tools/verify-release.mjs\n');
  const pinned = readFileSync(join(dir, 'tools/verify-release.mjs'), 'utf8');
  assert.equal(PINNED_LINE.exec(pinned)[1], "'" + project.pub + "'");
  assert.ok(readFileSync(join(dir, 'SECURITY.md'), 'utf8').split('\n').includes('`' + project.pub + '`'));
  assert.equal(sh(gate, dir).status, 0, 'the gate sees the pinned key');
  // The loop refuses a blank key and another key.
  assert.equal(sh(step3bLoop(), dir, { RELEASE_PUB: '' }).stdout, 'NOT PINNED README.md\nNOT PINNED SECURITY.md\nNOT PINNED tools/verify-release.mjs\n');
  const other = await releaseKey('other');
  assert.match(sh(step3bLoop(), dir, { RELEASE_PUB: other.pub }).stdout, /^NOT PINNED README\.md\nNOT PINNED SECURITY\.md\nNOT PINNED tools\/verify-release\.mjs\n$/);
  // The copy with the key built in loads and exports it.
  const exported = spawnSync(process.execPath, ['--input-type=module', '-e', 'const m = await import(process.argv[1]); console.log(JSON.stringify(m.PINNED_RELEASE_KEYS))', 'file://' + join(dir, 'tools/verify-release.mjs')], { encoding: 'utf8' });
  assert.equal(exported.status, 0, exported.stderr);
  assert.deepEqual(JSON.parse(exported.stdout), [project.pub]);
});

test('IND-3: with one key built in, verify refuses a list signed by another key even when --pubkey names that key', { skip: !HAVE_PERL && 'perl is not installed' }, async () => {
  const dir = copyTools();
  const project = await releaseKey('project');
  const attacker = await releaseKey('attacker');
  pin(dir, project.pub);
  const rel = fixtureRelease();
  await signInto(rel, attacker);
  const args = [join(rel, 'dist'), '--list', join(rel, 'hashes-dist.json'), '--sig', join(rel, 'hashes-dist.json.sig'), '--expect-version', '0.3.0', '--expect-tree', 'dist'];
  const named = isolatedVerify(dir, args.concat(['--pubkey', attacker.pub]));
  assert.equal(named.status, 1, named.stdout + named.stderr);
  assert.match(named.stdout, /FAILED \(key\)/);
  assert.match(named.stdout, /not a release key built into this copy/);
  const unnamed = isolatedVerify(dir, args);
  assert.equal(unnamed.status, 1, unnamed.stdout + unnamed.stderr);
  assert.match(unnamed.stdout, /FAILED \(signature\)/, 'without --pubkey the built-in key decides, and the attacker did not sign with it');
  for (const r of [named, unnamed]) assert.doesNotMatch(r.stderr, /NETWORK-ATTEMPT|ERR_ACCESS_DENIED/);
});

// ---------------------------------------------------------------------------------------------------------------- IND-6

test('IND-6: the guard of these tests trips on a network call and a read outside the temporary folder', () => {
  const net = spawnSync(process.execPath, ['--import', GUARD, '-e', 'fetch("http://127.0.0.1:9/").catch(() => {})'], { encoding: 'utf8', env: { PATH: '' } });
  assert.match(net.stderr, /NETWORK-ATTEMPT fetch/);
  const outside = spawnSync(process.execPath, ['--permission', '--allow-fs-read=' + work, '-e', 'require("fs").readFileSync(' + JSON.stringify(join(ROOT, 'package.json')) + ')'], { encoding: 'utf8', cwd: work, env: { PATH: '' } });
  assert.notEqual(outside.status, 0);
  assert.match(outside.stderr, /ERR_ACCESS_DENIED/);
});

test('IND-6: a copy of a release from anywhere verifies offline from a copy of the tools: no gh, no network, nothing read outside the copies', { skip: !HAVE_PERL && 'perl is not installed' }, async () => {
  const dir = copyTools();
  const project = await releaseKey('project');
  pin(dir, project.pub);
  const rel = fixtureRelease();
  await signInto(rel, project);
  // The copy a person got from a mirror, a door, a torrent or a USB stick: the same bytes in another folder.
  const mirror = fresh('mirror');
  cpSync(rel, mirror, { recursive: true });
  const args = (root) => [join(root, 'dist'), '--list', join(root, 'hashes-dist.json'), '--sig', join(root, 'hashes-dist.json.sig'), '--expect-version', '0.3.0', '--expect-tree', 'dist'];
  for (const extra of [[], ['--pubkey', project.pub]]) {
    const ok = isolatedVerify(dir, args(mirror).concat(extra));
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /^OK: felinar 0\.3\.0 \(dist\): 5 files match the list, signed by [0-9a-f]{8}/);
    assert.doesNotMatch(ok.stdout + ok.stderr, /no release key built in yet/, 'the built-in key decides; nothing is trusted as given');
    assert.doesNotMatch(ok.stderr, /NETWORK-ATTEMPT|ERR_ACCESS_DENIED/);
  }
  // One changed byte in the copy fails, naming the file.
  const file = join(mirror, 'dist/_mw/loader.js');
  const bytes = readFileSync(file);
  bytes[0] ^= 1;
  writeFileSync(file, bytes);
  const bad = isolatedVerify(dir, args(mirror));
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /FAILED \(files\):\n {2}_mw\/loader\.js: sha256/);
  // An older genuine release is not the one expected.
  const old = fixtureRelease('0.2.9');
  await signInto(old, project);
  const rollback = isolatedVerify(dir, args(old));
  assert.equal(rollback.status, 1);
  assert.match(rollback.stdout, /FAILED \(version\)/);
  // The SHA256SUMS line of a download matches what sha256sum would print.
  const zipLike = join(rel, 'dist/index.html');
  assert.equal(createHash('sha256').update(readFileSync(zipLike)).digest('hex').length, 64);
  assert.ok(!existsSync(join(work, '.config')), 'gh wrote no configuration');
});

/** The lines of the checklist's code blocks that match re, each at most once per copy; the copies must be the same. */
function checklistCopies(re, copies = 2) {
  const hits = CHECKLIST_LINES.filter((l) => re.test(l));
  assert.equal(hits.length, copies, 'expected ' + copies + ' copies of ' + re);
  assert.equal(new Set(hits).size, 1, 'the copies differ: ' + re);
  return hits[0];
}

test('IND-6: the release-notes block of step 3 still runs, and its notes name the signed lists as the check', { skip: (!HAVE_PERL || !has('bash')) && 'perl or bash is not installed' }, (t) => {
  const start = CHECKLIST_LINES.findIndex((l) => /^if printf '%s\\n' "\$TEXTS_REVIEW_DATE" /.test(l));
  assert.ok(start > 0, 'step 3 has its if block');
  const end = CHECKLIST_LINES.indexOf('fi', start);
  const block = CHECKLIST_LINES.slice(start, end + 1).join('\n');
  const second = CHECKLIST_LINES.findIndex((l, i) => i > end && l === CHECKLIST_LINES[start]);
  assert.ok(second > end, 'section 8 has the copy');
  assert.equal(CHECKLIST_LINES.slice(second, second + end - start + 1).join('\n'), block, 'step 3 and section 8 run the same block');
  const changelog = read('CHANGELOG.md');
  if (!/^## \[Unreleased\] - 0\.3\.0\n\nNot released yet\./m.test(changelog)) return t.skip('0.3.0 is dated already');
  const dir = fresh('changelog');
  writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
  const r = spawnSync('bash', ['-c', block], {
    cwd: dir, encoding: 'utf8',
    env: Object.assign({}, process.env, { TAG_DATE: '2026-11-01', TEXTS_REVIEW_DATE: '2026-10-24', REVIEW_ROUND: 'ran on 2026-10-24, and its blockers are fixed' }),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '', 'perl and the shell report nothing');
  const dated = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
  assert.match(dated, /^## \[0\.3\.0\] - 2026-11-01$/m);
  const notes = dated.slice(dated.indexOf('## [0.3.0] - 2026-11-01'));
  assert.match(notes, /^- The signed per-file hash lists are the check of this release: `node tools\/verify-release\.mjs verify`/m);
  assert.match(notes, /from any mirror, door, torrent or USB stick/);
  assert.match(notes, /not against the owner, who controls all of them\./);
});

test('IND-6: step 10b adds the checksums and the identity page build to the notes, and signs release-key.txt with the OpenPGP key', () => {
  const noteLine = checklistCopies(/^node -e 'const fs = require\("fs"\); const d = process\.argv\[1\];.*notes\.md/);
  const script = /^node -e '(.*)' "\$RDIR"$/.exec(noteLine);
  assert.ok(script, 'one node line that reads only $RDIR');
  const rdir = fresh('rdir');
  mkdirSync(join(rdir, 'unzipped/dist-idp'), { recursive: true });
  writeFileSync(join(rdir, 'unzipped/dist-idp/build.json'), JSON.stringify({ version: '0.3.0', buildId: '9d6a24e3eb7f', bundleSha256: 'a'.repeat(64) }));
  writeFileSync(join(rdir, 'SHA256SUMS'), 'b'.repeat(64) + '  felinar-0.3.0-dist.zip\n' + 'c'.repeat(64) + '  felinar-0.3.0.tgz\n');
  writeFileSync(join(rdir, 'notes.md'), 'The notes.\n');
  const r = spawnSync(process.execPath, ['-e', script[1], rdir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(rdir, 'notes.md'), 'utf8'), 'The notes.\n\n### Checksums\n\n    ' + 'b'.repeat(64) + '  felinar-0.3.0-dist.zip\n    ' + 'c'.repeat(64) +
    '  felinar-0.3.0.tgz\n\nIdentity page (dist-idp): build id 9d6a24e3eb7f, bundle sha256 ' + 'a'.repeat(64) + '.\n');
  const gpgLine = checklistCopies(/gpg --local-user [0-9A-F]{40} --armor --detach-sign/);
  const fpr = /--local-user ([0-9A-F]{40})/.exec(gpgLine)[1];
  assert.ok(read('SECURITY.md').replace(/\s+/g, ' ').includes(fpr.match(/.{4}/g).join(' ')), 'the checklist signs with the key SECURITY.md names');
  checklistCopies(/^gh release upload v0\.3\.0 .*"\$RDIR\/release-key\.txt" "\$RDIR\/release-key\.txt\.asc"/);
  for (const tree of ['dist', 'dist-idp']) {
    checklistCopies(new RegExp('^node tools/verify-release\\.mjs sign --list "\\$RDIR/hashes-' + (tree === 'dist' ? 'dist' : 'idp') + '\\.json" --rebuilt "\\$RDIR/rebuilt/' + tree + '" '));
    checklistCopies(new RegExp('^node tools/verify-release\\.mjs verify "\\$RDIR/unzipped/' + tree + '" .* --expect-version 0\\.3\\.0 --expect-tree ' + tree + '$'));
  }
  checklistCopies(/^if \[ -n "\$npm_commit" \] .* git tag -a v0\.3\.0 -m "felinar 0\.3\.0" -m "Release key: \$RELEASE_PUB"; else /);
});

// ------------------------------------------------------------------------------------------------------- IND-2 (the key)

/** OpenPGP packets of an ASCII-armoured block: [{ tag, body }] (RFC 9580 4.2, old and new formats). */
function packets(armored) {
  const b64 = armored.split('\n').map((l) => l.trim()).filter((l) => l && !/^-----/.test(l) && !/^[A-Za-z-]+: /.test(l) && !/^=/.test(l)).join('');
  const bytes = Buffer.from(b64, 'base64');
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    const h = bytes[i++];
    assert.ok(h & 0x80, 'a packet header');
    let tag, len;
    if (h & 0x40) {
      tag = h & 0x3f;
      const o = bytes[i++];
      if (o < 192) len = o;
      else if (o < 224) len = ((o - 192) << 8) + bytes[i++] + 192;
      else if (o === 255) { len = bytes.readUInt32BE(i); i += 4; }
      else throw new Error('partial lengths do not occur in a public key');
    } else {
      tag = (h >> 2) & 0x0f;
      const lt = h & 3;
      if (lt === 0) len = bytes[i++];
      else if (lt === 1) { len = bytes.readUInt16BE(i); i += 2; }
      else if (lt === 2) { len = bytes.readUInt32BE(i); i += 4; }
      else throw new Error('indeterminate length');
    }
    out.push({ tag, body: bytes.subarray(i, i + len) });
    i += len;
  }
  return out;
}

test('IND-2: SECURITY-KEY.asc names no e-mail address, and SECURITY.md, the README and the checklist give its fingerprint', () => {
  const pk = packets(read('SECURITY-KEY.asc'));
  const primary = pk.find((p) => p.tag === 6);
  assert.ok(primary && primary.body[0] === 4, 'a v4 primary key');
  const head = Buffer.from([0x99, primary.body.length >> 8, primary.body.length & 0xff]);
  const fpr = createHash('sha1').update(Buffer.concat([head, primary.body])).digest('hex').toUpperCase();
  const spaced = fpr.match(/.{4}/g).join(' ');
  const uids = pk.filter((p) => p.tag === 13).map((p) => p.body.toString('utf8'));
  assert.ok(uids.length >= 1, 'a user id');
  for (const uid of uids) assert.doesNotMatch(uid, /@|<[^>]*>/, 'the user id names no e-mail address: ' + uid);
  const flat = (rel) => read(rel).replace(/\s+/g, ' ');
  for (const rel of ['SECURITY.md', 'README.md', 'docs/PUBLISH-CHECKLIST.md']) {
    assert.ok(flat(rel).includes(spaced), rel + ' gives the fingerprint ' + spaced);
    assert.doesNotMatch(flat(rel), /ACF1 2905 7744 55EC/, rel + ' still names the retired key');
  }
});
