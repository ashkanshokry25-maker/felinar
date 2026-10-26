// Unit tests for tools/verify-release.mjs (V03-DESIGN-REVIEW 2.19, SC-1, SC-8, MF-78): a good signed list passes, one changed byte
// fails, the wrong key fails, a changed list fails, extra and missing files fail. Offline; keys and trees live in a temporary directory.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  buildHashList, signList, verifyRelease, checkList, listHash, signedText, readPublicKey, listPathProblem, RELEASE_PREFIX, LIST_KIND, SIG_ALG,
  compareVersions, compareLists, PINNED_RELEASE_KEYS, RETIRED_RELEASE_KEYS,
} from '../../tools/verify-release.mjs';
import { doorKitFiles } from '../../tools/door-kit-files.mjs';
import { keygen } from '../../tools/keygen.mjs';
import { loadOwnerKey, ToolError, ROOT } from '../../tools/lib.mjs';
import { verify } from '../../src/chain/crypto.js';
import { canonicalize, utf8 } from '../../src/chain/canonical.js';

const work = mkdtempSync(join(tmpdir(), 'mw-v03-release-'));
after(() => rmSync(work, { recursive: true, force: true }));
let n = 0;
const fresh = (label) => {
  const dir = join(work, label + '-' + ++n);
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
async function key(label = 'release') {
  const file = join(work, label + '-' + ++n + '.jwk');
  const res = await keygen({ out: file });
  return Object.assign({ file }, res, { identity: await loadOwnerKey(file) });
}
function makeTree() {
  const dir = fresh('dist');
  writeTree(dir, {
    'index.html': '<!doctype html><title>loader</title>\n',
    '404.html': '<!doctype html><title>loader</title>\n',
    'mw-sw.js': 'self.addEventListener("install", () => {});\n',
    '_mw/loader.js': 'export const loader = 1;\n',
    '_mw/signin.js': 'export const signin = 1;\n',
    '_mw/icons/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
    'build.json': JSON.stringify({ name: 'felinar', version: '0.3.0', buildId: 'abc123def456' }),
  });
  return dir;
}
async function signed(dir, k) {
  const list = buildHashList({ dir });
  const sig = await signList(list, k.identity);
  return { list, sig };
}

// tools/verify-release.mjs has the project's release key built in (PINNED_RELEASE_KEYS, step 3b of docs/PUBLISH-CHECKLIST.md), and it
// refuses a list signed by any other key (SUP-2, SUP-12). So each check below pins the fixture's own key: pinnedKeys in this process, and
// on the command line a copy of the tools with that key built in (toolsPinnedTo).
test('a good list passes: the signature verifies under the pinned key and every file matches', async () => {
  const dir = makeTree();
  const k = await key();
  const { list, sig } = await signed(dir, k);
  assert.equal(list.kind, LIST_KIND);
  assert.equal(list.version, '0.3.0', 'the version comes from build.json');
  assert.equal(list.tree, 'dist');
  assert.deepEqual(list.files.map((f) => f.path), ['404.html', '_mw/icons/icon.svg', '_mw/loader.js', '_mw/signin.js', 'build.json', 'index.html', 'mw-sw.js'], 'sorted by the UTF-8 bytes of the path');
  assert.equal(sig.alg, SIG_ALG);
  assert.equal(sig.key, k.pub);
  const res = await verifyRelease({ dir, list, sig, publicKey: k.pub, pinnedKeys: [k.pub] });
  assert.equal(res.ok, true, JSON.stringify(res.problems));
  assert.equal(res.checked, 7);
  assert.equal(res.signer, k.pub);
  assert.equal(res.listHash, listHash(list));
  // the signed text is the documented one, signed as a raw P1363 signature
  assert.equal(signedText(list), 'mw-release-v1\n' + canonicalize(list));
  assert.equal(RELEASE_PREFIX, 'mw-release-v1\n');
  assert.equal(await verify(k.pub, utf8.encode(signedText(list)), sig.sig), true);
});

test('one changed byte fails, and the failure names the file and both hashes', async () => {
  const dir = makeTree();
  const k = await key();
  const { list, sig } = await signed(dir, k);
  const file = join(dir, '_mw', 'loader.js');
  const bytes = readFileSync(file);
  bytes[bytes.length - 3] ^= 1; // same size, one flipped bit
  writeFileSync(file, bytes);
  const res = await verifyRelease({ dir, list, sig, publicKey: k.pub, pinnedKeys: [k.pub] });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'files');
  assert.equal(res.problems.length, 1);
  assert.match(res.problems[0], /^_mw\/loader\.js: sha256 [0-9a-f]{64} differs from the list \([0-9a-f]{64}\)/);
  // a changed size is caught before hashing
  writeFileSync(file, bytes.subarray(0, bytes.length - 1));
  const shorter = await verifyRelease({ dir, list, sig, publicKey: k.pub, pinnedKeys: [k.pub] });
  assert.match(shorter.problems[0], /_mw\/loader\.js: \d+ bytes, the list says \d+/);
});

test('the wrong key fails: a list signed by someone else does not pass the pinned key', async () => {
  const dir = makeTree();
  const releaseKey = await key('release');
  const attacker = await key('attacker');
  const forged = await signed(dir, attacker);
  const res = await verifyRelease({ dir, list: forged.list, sig: forged.sig, publicKey: releaseKey.pub, pinnedKeys: [releaseKey.pub] });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'signature');
  assert.match(res.problems[0], /another key than the pinned one/);
  // even when the attacker writes the pinned key into the signature file, the signature itself does not verify
  const relabelled = Object.assign({}, forged.sig, { key: releaseKey.pub });
  const res2 = await verifyRelease({ dir, list: forged.list, sig: relabelled, publicKey: releaseKey.pub, pinnedKeys: [releaseKey.pub] });
  assert.equal(res2.reason, 'signature');
  assert.match(res2.problems[0], /does not verify under the pinned key/);
  // a key that is not a key at all
  assert.equal((await verifyRelease({ dir, list: forged.list, sig: forged.sig, publicKey: 'p256:nope' })).reason, 'key');
});

test('a changed list fails the signature even when the files match the changed list', async () => {
  const dir = makeTree();
  const k = await key();
  const { list, sig } = await signed(dir, k);
  // swap a file and fix the list to match: the signature no longer covers it
  writeFileSync(join(dir, 'mw-sw.js'), 'self.addEventListener("install", () => { fetch("https://evil.example") });\n');
  const evil = buildHashList({ dir });
  const res = await verifyRelease({ dir, list: evil, sig, publicKey: k.pub, pinnedKeys: [k.pub] });
  assert.equal(res.reason, 'signature');
  assert.equal(res.ok, false);
  // a signature with a flipped bit
  const flipped = Object.assign({}, sig, { sig: (sig.sig[0] === 'A' ? 'B' : 'A') + sig.sig.slice(1) });
  assert.equal((await verifyRelease({ dir: makeTree(), list, sig: flipped, publicKey: k.pub, pinnedKeys: [k.pub] })).reason, 'signature');
  assert.equal((await verifyRelease({ dir, list, sig: { v: 1, alg: 'ES256-DER', sig: sig.sig }, publicKey: k.pub, pinnedKeys: [k.pub] })).reason, 'signature', 'only the P1363 form is accepted');
  assert.equal((await verifyRelease({ dir, list, sig: null, publicKey: k.pub, pinnedKeys: [k.pub] })).reason, 'signature');
});

test('extra and missing files fail; --allow-extra lets a host add its own files; symbolic links are never followed', async () => {
  const dir = makeTree();
  const k = await key();
  const { list, sig } = await signed(dir, k);
  writeFileSync(join(dir, '_headers'), '/*\n  X-Test: 1\n');
  const extra = await verifyRelease({ dir, list, sig, publicKey: k.pub, pinnedKeys: [k.pub] });
  assert.equal(extra.ok, false);
  assert.deepEqual(extra.problems, ['_headers: not in the list']);
  // SEC-5: --allow-extra does not cover host settings; a plain extra file passes and is named
  const hostSettings = await verifyRelease({ dir, list, sig, publicKey: k.pub, pinnedKeys: [k.pub], allowExtra: true });
  assert.equal(hostSettings.ok, false);
  assert.match(hostSettings.problems.join('\n'), /_headers: host settings that are not in the signed list/);
  rmSync(join(dir, '_headers'));
  writeFileSync(join(dir, 'notes.txt'), 'a host note\n');
  const plain = await verifyRelease({ dir, list, sig, publicKey: k.pub, pinnedKeys: [k.pub], allowExtra: true });
  assert.equal(plain.ok, true, plain.problems.join('; '));
  assert.deepEqual(plain.extras, ['notes.txt']);
  rmSync(join(dir, 'notes.txt'));
  rmSync(join(dir, '_mw', 'signin.js'));
  const missing = await verifyRelease({ dir, list, sig, publicKey: k.pub, pinnedKeys: [k.pub] });
  assert.deepEqual(missing.problems, ['_mw/signin.js: missing']);
  const withLink = makeTree();
  symlinkSync('/etc/hosts', join(withLink, 'link.txt'));
  assert.throws(() => buildHashList({ dir: withLink }), (e) => e instanceof ToolError && /only regular files/.test(e.message));
  const good = makeTree();
  const g = await signed(good, k);
  symlinkSync('/etc/hosts', join(good, 'link.txt'));
  const res = await verifyRelease({ dir: good, list: g.list, sig: g.sig, publicKey: k.pub, pinnedKeys: [k.pub], allowExtra: true });
  assert.equal(res.ok, false, 'a symbolic link fails even with --allow-extra');
  assert.match(res.problems[0], /link\.txt.*not a regular file/);
});

test('the list is checked strictly: traversal paths, duplicates, unsorted files, bad hashes and unknown fields are refused', async () => {
  const good = buildHashList({ dir: makeTree() });
  assert.deepEqual(checkList(good), []);
  const mutate = (fn) => {
    const copy = JSON.parse(JSON.stringify(good));
    fn(copy);
    return copy;
  };
  assert.match(checkList(mutate((l) => { l.files[0].path = '../escape'; })).join(';'), /empty or dot segment/);
  assert.match(checkList(mutate((l) => { l.files[0].path = '/abs'; })).join(';'), /absolute/);
  assert.match(checkList(mutate((l) => { l.files[0].path = 'a\\b'; })).join(';'), /backslash/);
  assert.match(checkList(mutate((l) => { l.files[1].path = l.files[0].path; })).join(';'), /listed twice/);
  assert.match(checkList(mutate((l) => { l.files.reverse(); })).join(';'), /not sorted/);
  assert.match(checkList(mutate((l) => { l.files[0].sha256 = 'XYZ'; })).join(';'), /64 lowercase hex/);
  assert.match(checkList(mutate((l) => { l.files[0].bytes = -1; })).join(';'), /not a size/);
  assert.match(checkList(mutate((l) => { l.files[0].extra = 1; })).join(';'), /unknown field extra/);
  assert.match(checkList(mutate((l) => { l.extra = 1; })).join(';'), /unknown field extra/);
  assert.match(checkList(mutate((l) => { l.kind = 'other'; })).join(';'), /not a release hash list/);
  assert.match(checkList(mutate((l) => { l.v = 2; })).join(';'), /unsupported list version/);
  assert.match(checkList(mutate((l) => { l.files = []; })).join(';'), /empty/);
  assert.ok(checkList(null).length);
  assert.equal(listPathProblem('a/b.js'), null);
  assert.equal(listPathProblem('e\u0301.js'), 'not NFC');
  await assert.rejects(signList(mutate((l) => { l.files[0].path = '../x'; }), (await key()).identity), ToolError);
  const dir = makeTree();
  const k = await key();
  const s = await signed(dir, k);
  const bad = mutate((l) => { l.files[0].path = '../x'; });
  assert.equal((await verifyRelease({ dir, list: bad, sig: s.sig, publicKey: k.pub, pinnedKeys: [k.pub] })).reason, 'list');
});

test('the pinned key can be a text file, a public JWK or the key file itself', async () => {
  const k = await key();
  const jwk = JSON.parse(readFileSync(k.file, 'utf8'));
  const textFile = join(work, 'pinned.pub');
  writeFileSync(textFile, k.pub + '\n');
  const publicJwk = join(work, 'pinned-public.jwk');
  writeFileSync(publicJwk, JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }));
  for (const f of [textFile, publicJwk, k.file]) assert.equal(await readPublicKey(f), k.pub, f);
  await assert.rejects(readPublicKey(join(work, 'missing')), ToolError);
  writeFileSync(join(work, 'junk'), 'hello');
  await assert.rejects(readPublicKey(join(work, 'junk')), /neither a public key/);
});

// The module graph of tools/verify-release.mjs, as verify-release-anchor.test.mjs copies it.
const TOOL_FILES = ['tools/verify-release.mjs', 'tools/lib.mjs', 'tools/door-kit-files.mjs', 'src/chain/crypto.js', 'src/chain/canonical.js'];
const PINNED_LINE = /^export const PINNED_RELEASE_KEYS = Object\.freeze\(\[(.*)\]\);$/m;
/** toolsPinnedTo(keys) -> a copy of those files whose PINNED_RELEASE_KEYS line holds keys (the line step 3b writes); cli(args, copy) runs it. */
function toolsPinnedTo(keys) {
  const dir = fresh('tools-pinned');
  for (const rel of TOOL_FILES) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    copyFileSync(join(ROOT, rel), join(dir, rel));
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'felinar-tools-copy', private: true, type: 'module' }));
  const file = join(dir, 'tools', 'verify-release.mjs');
  const src = readFileSync(file, 'utf8');
  assert.match(src, PINNED_LINE, 'PINNED_RELEASE_KEYS is one line of the form step 3b writes');
  writeFileSync(file, src.replace(PINNED_LINE, () => 'export const PINNED_RELEASE_KEYS = Object.freeze(' + JSON.stringify(keys) + ');'));
  return dir;
}

function cli(args, cwd = ROOT) {
  return spawnSync(process.execPath, ['tools/verify-release.mjs', ...args], { cwd, encoding: 'utf8' });
}

test('command line: list, sign and verify work offline; a changed byte exits 1; usage errors exit 2', async () => {
  const dir = makeTree();
  const k = await key();
  const listFile = join(work, 'hashes.json');
  const sigFile = join(work, 'hashes.json.sig');
  const l = cli(['list', dir, '--out', listFile]);
  assert.equal(l.status, 0, l.stderr);
  assert.match(l.stdout, /listed 7 files of dist \(felinar 0\.3\.0\)/);
  assert.match(l.stdout, /list sha256 [0-9a-f]{64}/);
  const s = cli(['sign', '--list', listFile, '--rebuilt', dir, '--key', k.file, '--out', sigFile]);
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, new RegExp(k.pub.replace(/[+]/g, '\\+')));
  const pub = join(work, 'release.pub');
  writeFileSync(pub, k.pub + '\n');
  const pinnedTools = toolsPinnedTo([k.pub]); // a copy of the tools with the fixture's key built in
  const ok = cli(['verify', dir, '--list', listFile, '--sig', sigFile, '--key', pub, '--expect-version', '0.3.0'], pinnedTools);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /^OK: felinar 0\.3\.0 \(dist\): 7 files match the list, signed by [0-9a-f]{8}/);
  const okJson = cli(['verify', dir, '--list', listFile, '--sig', sigFile, '--pubkey', k.pub, '--json', '--min-version', '0.3.0'], pinnedTools);
  assert.equal(JSON.parse(okJson.stdout).ok, true);
  assert.equal(JSON.parse(okJson.stdout).version, '0.3.0');
  const other = await key('other');
  // a copy with other's key built in: the list k signed fails the signature under it
  const wrong = cli(['verify', dir, '--list', listFile, '--sig', sigFile, '--pubkey', other.pub, '--any-version'], toolsPinnedTo([other.pub]));
  assert.equal(wrong.status, 1);
  assert.match(wrong.stdout, /FAILED \(signature\)/);
  const file = join(dir, 'index.html');
  const b = readFileSync(file);
  b[5] ^= 1;
  writeFileSync(file, b);
  const bad = cli(['verify', dir, '--list', listFile, '--sig', sigFile, '--key', pub, '--expect-version', '0.3.0'], pinnedTools);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /FAILED \(files\):\n {2}index\.html: sha256/);
  assert.equal(cli(['verify', dir, '--list', listFile, '--sig', sigFile, '--expect-version', '0.3.0'], toolsPinnedTo([])).status, 2, 'the pinned key is required (a copy with no key built in)');
  assert.equal(cli(['verify', dir, '--list', listFile, '--sig', sigFile, '--key', pub]).status, 2, 'the expected version is required (SEC-6)');
  assert.equal(cli(['verify', dir, '--list', listFile, '--sig', sigFile, '--key', pub, '--pubkey', k.pub, '--expect-version', '0.3.0']).status, 2);
  assert.equal(cli(['verify', '--list', listFile, '--sig', sigFile, '--key', pub, '--expect-version', '0.3.0']).status, 2);
  assert.equal(cli(['list', dir]).status, 2);
  assert.equal(cli(['bogus']).status, 2);
  assert.equal(cli(['sign', '--list', listFile]).status, 2);
  const help = cli(['--help']);
  for (const flag of ['--out', '--version', '--tree', '--list', '--sig', '--key', '--pubkey', '--allow-extra', '--json', '--expect-version', '--min-version', '--rebuilt', '--door-kit']) assert.ok(help.stdout.includes(flag), flag);
});

// ---------------------------------------------------------------------------------------------- review round 2026-10-24

function versionTree(version) {
  const dir = makeTree();
  writeFileSync(join(dir, 'build.json'), JSON.stringify({ name: 'felinar', version, buildId: 'b-' + version }));
  return dir;
}

test('SEC-6: a genuine older signed release is refused when a version is expected, and the accepted release is named', async () => {
  const k = await key();
  const old = versionTree('0.3.0');
  const oldSet = await signed(old, k);
  const newer = versionTree('0.3.1');
  await signed(newer, k);
  const rollback = await verifyRelease({ dir: old, list: oldSet.list, sig: oldSet.sig, publicKey: k.pub, pinnedKeys: [k.pub], expectVersion: '0.3.1' });
  assert.equal(rollback.ok, false);
  assert.equal(rollback.reason, 'version');
  assert.match(rollback.problems[0], /version 0\.3\.0, not the version expected \(0\.3\.1\)/);
  const floor = await verifyRelease({ dir: old, list: oldSet.list, sig: oldSet.sig, publicKey: k.pub, pinnedKeys: [k.pub], minVersion: '0.3.1' });
  assert.equal(floor.reason, 'version');
  const fine = await verifyRelease({ dir: old, list: oldSet.list, sig: oldSet.sig, publicKey: k.pub, pinnedKeys: [k.pub], minVersion: '0.3.0-rc.2', expectTree: 'dist', expectName: 'felinar' });
  assert.equal(fine.ok, true);
  assert.deepEqual([fine.name, fine.version, fine.tree], ['felinar', '0.3.0', 'dist']);
  assert.equal((await verifyRelease({ dir: old, list: oldSet.list, sig: oldSet.sig, publicKey: k.pub, pinnedKeys: [k.pub], expectTree: 'dist-idp' })).reason, 'version', 'a signed dist-idp list cannot stand in for dist');
  // the command line: the old set offered as 0.3.1 fails, and the OK line names the version
  const listFile = join(fresh('cli'), 'hashes.json');
  const sigFile = listFile + '.sig';
  writeFileSync(listFile, JSON.stringify(oldSet.list));
  writeFileSync(sigFile, JSON.stringify(oldSet.sig));
  const pinnedTools = toolsPinnedTo([k.pub]);
  const r = cli(['verify', old, '--list', listFile, '--sig', sigFile, '--pubkey', k.pub, '--expect-version', '0.3.1'], pinnedTools);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAILED \(version\)/);
  const ok = cli(['verify', old, '--list', listFile, '--sig', sigFile, '--pubkey', k.pub, '--expect-version', '0.3.0'], pinnedTools);
  assert.match(ok.stdout, /^OK: felinar 0\.3\.0 \(dist\)/);
  assert.equal(compareVersions('0.3.0-rc.1', '0.3.0'), -1);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.3.0', '0.3.0'), 0);
  assert.equal(compareVersions('x', '0.3.0'), null);
});

test('SUP-3: sign --rebuilt signs only a list equal to the local build; one changed byte exits 1 and writes no signature', async () => {
  const k = await key();
  const draft = makeTree();
  const listFile = join(fresh('draft'), 'hashes-dist.json');
  const sigFile = listFile + '.sig';
  writeFileSync(listFile, JSON.stringify(buildHashList({ dir: draft })));
  const rebuilt = makeTree();
  const b = readFileSync(join(rebuilt, '_mw', 'loader.js'));
  b[0] ^= 1;
  writeFileSync(join(rebuilt, '_mw', 'loader.js'), b);
  const refused = cli(['sign', '--list', listFile, '--rebuilt', rebuilt, '--key', k.file, '--out', sigFile]);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /NOT SIGNED: the list differs[\s\S]*_mw\/loader\.js: sha256/);
  assert.match(refused.stdout, /list to sign {4}sha256 [0-9a-f]{64}\nlocal rebuild {3}sha256 [0-9a-f]{64}/);
  assert.equal(existsSync(sigFile), false, 'no signature is written');
  assert.equal(cli(['sign', '--list', listFile, '--key', k.file, '--out', sigFile]).status, 2, '--rebuilt is required');
  const same = makeTree();
  assert.equal(cli(['sign', '--list', listFile, '--rebuilt', same, '--key', k.file, '--out', sigFile]).status, 0);
  assert.equal(existsSync(sigFile), true);
  assert.deepEqual(compareLists(buildHashList({ dir: draft }), buildHashList({ dir: same })), []);
});

test('SUP-2, SUP-12: a release key built into the tools decides; another key fails even when --pubkey names it; a retired key fails', async () => {
  const project = await key('project');
  const attacker = await key('attacker');
  const dir = makeTree();
  const forged = await signed(dir, attacker);
  const pinned = [project.pub];
  const r = await verifyRelease({ dir, list: forged.list, sig: forged.sig, publicKey: attacker.pub, pinnedKeys: pinned, expectVersion: '0.3.0' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'key');
  assert.match(r.problems[0], /not a release key built into this copy/);
  const real = await signed(dir, project);
  assert.equal((await verifyRelease({ dir, list: real.list, sig: real.sig, publicKey: project.pub, pinnedKeys: pinned })).ok, true);
  const retired = await verifyRelease({ dir, list: real.list, sig: real.sig, publicKey: project.pub, pinnedKeys: [], retiredKeys: [project.pub] });
  assert.equal(retired.reason, 'key');
  assert.match(retired.problems[0], /retired/);
  const unpinned = await verifyRelease({ dir, list: real.list, sig: real.sig, publicKey: project.pub, pinnedKeys: [] });
  assert.equal(unpinned.ok, true);
  assert.match(unpinned.warnings.join('\n'), /no release key built in yet/);
  assert.ok(Array.isArray(PINNED_RELEASE_KEYS) && Array.isArray(RETIRED_RELEASE_KEYS));
});

test('SEC-5: a door kit with a changed _redirects, an extra script or a file under _mw/ fails --door-kit and --allow-extra, naming each file', async () => {
  const k = await key();
  const dist = makeTree();
  const { list, sig } = await signed(dist, k);
  const kit = fresh('kit');
  writeTree(kit, Object.fromEntries(buildHashList({ dir: dist }).files.map((f) => [f.path, readFileSync(join(dist, ...f.path.split('/')))])));
  const extra = doorKitFiles({ version: '0.3.0' });
  writeTree(kit, Object.assign({}, extra, { 'hashes-dist.json': JSON.stringify(list), 'hashes-dist.json.sig': JSON.stringify(sig), ['_mw/t/' + 'a'.repeat(40) + '.torrent']: 'd4:infoe' }));
  const clean = await verifyRelease({ dir: kit, list, sig, publicKey: k.pub, pinnedKeys: [k.pub], allowExtra: true, expectExtra: extra });
  assert.equal(clean.ok, true, clean.problems.join('; '));
  assert.ok(clean.extras.includes('_redirects') && clean.extras.includes('hashes-dist.json'));
  writeFileSync(join(kit, '_redirects'), '/mw-sw.js /x.js 200!\n');
  writeFileSync(join(kit, 'x.js'), 'evil()\n');
  writeFileSync(join(kit, '_mw', 'evil.js'), 'evil()\n');
  const tampered = await verifyRelease({ dir: kit, list, sig, publicKey: k.pub, pinnedKeys: [k.pub], allowExtra: true, expectExtra: extra });
  assert.equal(tampered.ok, false);
  const text = tampered.problems.join('\n');
  assert.match(text, /_redirects: differs from the file the door kit makes/);
  assert.match(text, /x\.js: code at the root/);
  assert.match(text, /_mw\/evil\.js: a file under _mw\//);
  const plain = await verifyRelease({ dir: kit, list, sig, publicKey: k.pub, pinnedKeys: [k.pub], allowExtra: true });
  assert.match(plain.problems.join('\n'), /_redirects: host settings that are not in the signed list/);
  // the README's step 1 on the command line
  const listFile = join(fresh('cli'), 'hashes.json');
  writeFileSync(listFile, JSON.stringify(list));
  writeFileSync(listFile + '.sig', JSON.stringify(sig));
  const r = cli(['verify', kit, '--list', listFile, '--sig', listFile + '.sig', '--pubkey', k.pub, '--door-kit', '--expect-version', '0.3.0'], toolsPinnedTo([k.pub]));
  assert.equal(r.status, 1);
  for (const name of [/_redirects: differs/, /x\.js: code at the root/, /_mw\/evil\.js: a file under _mw\//]) assert.match(r.stdout, name);
});

test('the cross-OS comparison: the same tree gives the same list on any machine (no path separator, time or order dependence)', async () => {
  const a = makeTree();
  const b = fresh('copy');
  for (const f of readdirSync(a)) if (f !== '_mw') copyFileSync(join(a, f), join(b, f));
  mkdirSync(join(b, '_mw', 'icons'), { recursive: true });
  for (const f of ['loader.js', 'signin.js']) copyFileSync(join(a, '_mw', f), join(b, '_mw', f));
  copyFileSync(join(a, '_mw', 'icons', 'icon.svg'), join(b, '_mw', 'icons', 'icon.svg'));
  assert.equal(listHash(buildHashList({ dir: a })), listHash(buildHashList({ dir: b })));
  writeFileSync(join(b, '_mw', 'loader.js'), 'export const loader = 2;\n');
  assert.notEqual(listHash(buildHashList({ dir: a })), listHash(buildHashList({ dir: b })));
});

// ---------------------------------------------------------------------------------------------- build.lock.json: every bundled package (MF-78)

import {
  packageOfInput, hashPackageDir, collectBundledPackages, checkPackages, lockEntriesFor, orderedLock, unresolvedLocalImports, precacheList, WIDGET_FILES,
  CHECKED_ON_FETCH, ENTRIES, LOCK_REVIEW, build, sha256Hex,
} from '../../build.mjs';
import * as esbuild from 'esbuild';

function makeProject() {
  const dir = fresh('project');
  writeTree(dir, {
    'node_modules/fake-pkg/package.json': JSON.stringify({ name: 'fake-pkg', version: '1.2.3' }),
    'node_modules/fake-pkg/index.js': 'import { helper } from "./lib/helper.js";\nexport const fake = () => helper("fake");\n',
    'node_modules/fake-pkg/lib/helper.js': 'export const helper = (x) => "helper:" + x;\n',
    'node_modules/fake-pkg/README.md': 'docs that no bundle reads\n',
    'node_modules/fake-pkg/node_modules/inner/package.json': JSON.stringify({ name: 'inner', version: '9.9.9' }),
    'node_modules/fake-pkg/node_modules/inner/index.js': 'export const inner = 1;\n',
    'node_modules/@scope/other/package.json': JSON.stringify({ name: '@scope/other', version: '0.0.1', main: 'main.js' }),
    'node_modules/@scope/other/main.js': 'export const other = 2;\n',
    'entry.js': 'import { fake } from "fake-pkg";\nimport { other } from "@scope/other";\nexport default fake() + other;\n',
  });
  return dir;
}

// The entries of a build that touches none of the other lanes' sources: a tiny boot and loader (the build needs both for SRI) plus `extra`.
// Everything else build() reads (package.json, the vendored bundle, ui.css, index.html) is this lane's or stable.
function miniEntries(extra = []) {
  const dir = fresh('mini');
  writeTree(dir, { 'boot.js': 'var booted = 1;\n', 'loader.js': 'export const loader = 1;\n' });
  return [
    { name: 'boot', in: join(dir, 'boot.js'), out: '_mw/boot.js', format: 'iife', target: 'es5' },
    { name: 'loader', in: join(dir, 'loader.js'), out: '_mw/loader.js', format: 'esm' },
  ].concat(extra);
}

async function inputsOf(dir) {
  const result = await esbuild.build({ entryPoints: [join(dir, 'entry.js')], bundle: true, write: false, metafile: true, format: 'esm', absWorkingDir: dir, logLevel: 'silent' });
  return Object.keys(result.metafile.inputs).sort();
}

test('packageOfInput: the innermost package of a node_modules path, scoped names included, sources and the tree outside the root handled', () => {
  assert.deepEqual(packageOfInput('node_modules/fake-pkg/lib/x.js'), { name: 'fake-pkg', dir: 'node_modules/fake-pkg' });
  assert.deepEqual(packageOfInput('node_modules/@scope/other/main.js'), { name: '@scope/other', dir: 'node_modules/@scope/other' });
  assert.deepEqual(packageOfInput('node_modules/a/node_modules/b/index.js'), { name: 'b', dir: 'node_modules/a/node_modules/b' }, 'the innermost');
  assert.deepEqual(packageOfInput('../../tmp/x/node_modules/p/i.js'), { name: 'p', dir: '../../tmp/x/node_modules/p' });
  assert.equal(packageOfInput('src/loader/app.js'), null);
  assert.equal(packageOfInput('node_modules'), null);
  assert.equal(packageOfInput('node_modules/@scope'), null);
});

test('hashPackageDir: stable, sensitive to every byte, path and added file; the nested node_modules is not part of the package', () => {
  const dir = makeProject();
  const pkg = join(dir, 'node_modules', 'fake-pkg');
  const a = hashPackageDir(pkg);
  assert.equal(a.files, 4, 'package.json, index.js, lib/helper.js, README.md (the nested node_modules is its own package)');
  assert.match(a.sha256, /^[0-9a-f]{64}$/);
  assert.equal(hashPackageDir(pkg).sha256, a.sha256, 'stable');
  const file = join(pkg, 'lib', 'helper.js');
  const original = readFileSync(file);
  writeFileSync(file, original.toString('utf8').replace('helper:', 'hELper:'));
  assert.notEqual(hashPackageDir(pkg).sha256, a.sha256, 'one changed character');
  writeFileSync(file, original);
  assert.equal(hashPackageDir(pkg).sha256, a.sha256);
  writeFileSync(join(pkg, 'extra.js'), '//');
  assert.notEqual(hashPackageDir(pkg).sha256, a.sha256, 'an added file');
  rmSync(join(pkg, 'extra.js'));
  writeFileSync(join(pkg, 'node_modules', 'inner', 'index.js'), 'export const inner = 666;\n');
  assert.equal(hashPackageDir(pkg).sha256, a.sha256, 'the nested package is hashed on its own, not here');
});

test('checkPackages: a pinned package passes; a changed byte, another version, an unpinned package and another tarball integrity fail; a stale pin only warns', async () => {
  const dir = makeProject();
  const inputs = await inputsOf(dir);
  const packageLock = { packages: { 'node_modules/fake-pkg': { integrity: 'sha512-AAAA', resolved: 'https://registry.npmjs.org/fake-pkg/-/fake-pkg-1.2.3.tgz' } } };
  const found = collectBundledPackages({ root: dir, inputs, packageLock });
  assert.deepEqual(Object.keys(found.packages).sort(), ['@scope/other', 'fake-pkg']);
  assert.equal(found.packages['fake-pkg'].version, '1.2.3');
  assert.equal(found.packages['fake-pkg'].integrity, 'sha512-AAAA', 'the tarball integrity comes from package-lock.json');
  assert.equal(found.packages['@scope/other'].integrity, null);
  assert.deepEqual(found.duplicates, []);
  const lock = { v: 1, packages: lockEntriesFor(found.packages) };
  assert.deepEqual(Object.keys(lock.packages), ['@scope/other', 'fake-pkg'], 'names sorted');
  const ok = checkPackages(lock, found.packages);
  assert.equal(ok.ok, true, ok.message);
  assert.match(ok.message, /2 bundled package\(s\) match build\.lock\.json/);
  // one changed byte in the source
  const helper = join(dir, 'node_modules', 'fake-pkg', 'lib', 'helper.js');
  const bytes = readFileSync(helper);
  writeFileSync(helper, bytes.toString('utf8').replace('helper:', 'hELper:'));
  const drift = checkPackages(lock, collectBundledPackages({ root: dir, inputs, packageLock }).packages);
  assert.equal(drift.ok, false);
  assert.match(drift.message, /fake-pkg: the source in node_modules differs from the pin \(pinned [0-9a-f]{64}, actual [0-9a-f]{64}\)/);
  assert.match(drift.message, /npm ci --ignore-scripts/);
  assert.match(drift.message, /--update-lock/);
  writeFileSync(helper, bytes);
  // another version
  writeFileSync(join(dir, 'node_modules', 'fake-pkg', 'package.json'), JSON.stringify({ name: 'fake-pkg', version: '1.2.4' }));
  const version = checkPackages(lock, collectBundledPackages({ root: dir, inputs, packageLock }).packages);
  assert.match(version.problems.join(';'), /fake-pkg: version 1\.2\.4 differs from the pinned 1\.2\.3/);
  writeFileSync(join(dir, 'node_modules', 'fake-pkg', 'package.json'), JSON.stringify({ name: 'fake-pkg', version: '1.2.3' }));
  // the tarball integrity of package-lock.json moved
  const swapped = collectBundledPackages({ root: dir, inputs, packageLock: { packages: { 'node_modules/fake-pkg': { integrity: 'sha512-BBBB' } } } });
  assert.match(checkPackages(lock, swapped.packages).problems.join(';'), /tarball integrity in package-lock\.json differs/);
  // a package the lock does not know
  const unpinned = checkPackages({ v: 1, packages: { 'fake-pkg': lock.packages['fake-pkg'] } }, found.packages);
  assert.equal(unpinned.ok, false);
  assert.match(unpinned.problems[0], /@scope\/other@0\.0\.1 is bundled but not pinned/);
  assert.equal(checkPackages({ v: 1 }, found.packages).ok, false, 'a lock without a packages section pins nothing');
  assert.equal(checkPackages({ v: 1 }, {}).ok, true, 'and nothing bundled needs nothing');
  // a pin nobody uses any more only warns
  const stale = checkPackages({ v: 1, packages: Object.assign({ gone: { version: '1.0.0', sha256: '0'.repeat(64) } }, lock.packages) }, found.packages);
  assert.equal(stale.ok, true);
  assert.match(stale.warnings[0], /gone is pinned in build\.lock\.json but no bundle uses it any more/);
  assert.equal(checkPackages(lock, found.packages, { duplicates: ['fake-pkg'] }).ok, false);
});

test('build: a bundled package that is not pinned fails the build, --update-lock pins it, and a changed byte then fails again', async () => {
  const dir = makeProject();
  const outDir = join(work, 'dist-fake');
  const lockFile = join(work, 'fake.lock.json');
  writeFileSync(lockFile, readFileSync(join(ROOT, 'build.lock.json')));
  const entries = miniEntries([{ name: 'fake', in: join(dir, 'entry.js'), out: '_mw/fake.js', format: 'esm' }]);
  await assert.rejects(build({ outDir, quiet: true, lockFile, entries }), (e) => /bundled but not pinned/.test(e.message) && /fake-pkg@1\.2\.3/.test(e.message) && /@scope\/other@0\.0\.1/.test(e.message));
  assert.equal(existsSync(outDir), false, 'nothing is written');
  const pinned = await build({ outDir, quiet: true, lockFile, entries, updateLock: true });
  assert.deepEqual(Object.keys(pinned.packages).sort(), ['@scope/other', 'fake-pkg']);
  const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
  assert.deepEqual(Object.keys(lock), ['v', 'note', 'review', 'vendored', 'packages'], 'the header comes first');
  assert.equal(lock.review, LOCK_REVIEW);
  assert.equal(lock.packages['fake-pkg'].version, '1.2.3');
  assert.match(lock.packages['fake-pkg'].sha256, /^[0-9a-f]{64}$/);
  const info = JSON.parse(readFileSync(join(outDir, 'build.json'), 'utf8'));
  assert.deepEqual(Object.keys(info.packages).sort(), ['@scope/other', 'fake-pkg'], 'build.json records what was bundled');
  // without --update-lock the same sources pass; one changed byte fails with both hashes
  const again = await build({ outDir, quiet: true, lockFile, entries });
  assert.ok(again.buildId);
  const helper = join(dir, 'node_modules', 'fake-pkg', 'lib', 'helper.js');
  writeFileSync(helper, readFileSync(helper, 'utf8').replace('helper:', 'hELper:'));
  await assert.rejects(build({ outDir: join(work, 'dist-fake-2'), quiet: true, lockFile, entries }), (e) => /fake-pkg: the source in node_modules differs from the pin/.test(e.message));
  // --check-lock reaches the same verdict without writing a build
  await assert.rejects(build({ outDir: join(work, 'dist-fake-3'), quiet: true, lockFile, entries, checkLockOnly: true }), /differs from the pin/);
  assert.equal(existsSync(join(work, 'dist-fake-3')), false);
});

test('build: the committed lock pins every bundled package of the real sources (none today besides the vendored WebTorrent), with the two-person note in its header', () => {
  const lock = JSON.parse(readFileSync(join(ROOT, 'build.lock.json'), 'utf8'));
  assert.deepEqual(Object.keys(lock).slice(0, 3), ['v', 'note', 'review']);
  assert.match(lock.review, /Two people review every change to this file/);
  assert.match(lock.review, /CODEOWNERS/);
  assert.equal(typeof lock.packages, 'object');
  assert.deepEqual(orderedLock({ packages: {}, zzz: 1, v: 1, vendored: {}, review: 'r', note: 'n' }), { v: 1, note: 'n', review: 'r', vendored: {}, packages: {}, zzz: 1 });
});

test('the optional widgets: skipped with a warning while missing, never precached, hash-checked by the worker; --strict makes a skip an error; a real error is not swallowed', async () => {
  assert.deepEqual(Array.from(WIDGET_FILES), ['_mw/signin.js', '_mw/chat-panel.js']);
  assert.deepEqual(ENTRIES.filter((e) => e.optional).map((e) => [e.in, e.out]).sort(), [['src/dropin/mw.js', '_mw/mw.js'], ['src/widget/chat-panel.js', '_mw/chat-panel.js'], ['src/widget/signin.js', '_mw/signin.js']]);
  assert.deepEqual(precacheList(['_mw/signin.js', '_mw/chat-panel.js', '_mw/loader.js', '_mw/mw.js']), ['/index.html', '/_mw/loader.js', '/_mw/mw.js']);
  assert.ok(CHECKED_ON_FETCH.includes('/_mw/signin.js') && CHECKED_ON_FETCH.includes('/_mw/chat-panel.js') && CHECKED_ON_FETCH.includes('/_mw/webtorrent.min.js'));
  // the real widget sources (and nothing else of the loader): each is built, or skipped with a warning that names it
  const widgetEntries = miniEntries(ENTRIES.filter((e) => e.name === 'signin' || e.name === 'chat-panel'));
  const res = await build({ outDir: join(work, 'dist-widgets'), quiet: true, entries: widgetEntries });
  for (const name of ['_mw/signin.js', '_mw/chat-panel.js']) {
    const built = res.files.some((f) => f.path === name);
    assert.equal(built || res.skipped.includes(name), true, name + ' is built or skipped');
    assert.equal(built && res.skipped.includes(name), false);
    if (!built) {
      assert.ok(res.warnings.some((w) => w.includes(name.replace('_mw/', 'dist/_mw/'))), 'a warning names ' + name);
      await assert.rejects(build({ outDir: join(work, 'dist-strict'), quiet: true, strict: true, entries: widgetEntries }), /Could not resolve|esbuild failed/);
    }
  }
  const info = JSON.parse(readFileSync(join(work, 'dist-widgets', 'build.json'), 'utf8'));
  for (const p of ['/_mw/signin.js', '/_mw/chat-panel.js']) assert.equal(info.precache.includes(p), false);
  for (const f of res.files.map((x) => '/' + x.path).filter((p) => WIDGET_FILES.map((w) => '/' + w).includes(p))) assert.ok(info.integrity[f], f + ' is hash-checked when the worker serves it');
  // a synthetic optional entry: its file exists but imports a module that does not (yet)
  const dir = fresh('optional');
  writeTree(dir, { 'widget.js': 'import { missing } from "./not-written-yet.js";\nexport default missing;\n', 'broken.js': 'export default (;\n' });
  const mk = (file) => miniEntries([{ name: 'later', in: join(dir, file), out: '_mw/later.js', format: 'esm', optional: true }]);
  const lockFile = join(work, 'optional.lock.json');
  writeFileSync(lockFile, readFileSync(join(ROOT, 'build.lock.json')));
  const skipped = await build({ outDir: join(work, 'dist-optional'), quiet: true, lockFile, entries: mk('widget.js') });
  assert.ok(skipped.skipped.includes('_mw/later.js'));
  assert.ok(skipped.warnings.some((w) => /not-written-yet\.js/.test(w) && /does not exist yet/.test(w)));
  await assert.rejects(build({ outDir: join(work, 'dist-optional-2'), quiet: true, lockFile, entries: mk('widget.js'), strict: true }), /esbuild failed on .*Could not resolve/);
  await assert.rejects(build({ outDir: join(work, 'dist-optional-3'), quiet: true, lockFile, entries: mk('broken.js') }), /esbuild failed/, 'a syntax error in an optional entry is not skipped');
  assert.equal(unresolvedLocalImports([{ text: 'Could not resolve "./a.js"', location: { file: 'src/x.js' } }], ROOT)[0], './a.js (from src/x.js)');
  assert.equal(unresolvedLocalImports([{ text: 'Could not resolve "left-pad"', location: { file: 'src/x.js' } }], ROOT), null, 'a bare package is not a module another lane has not written');
  assert.equal(unresolvedLocalImports([{ text: 'Unexpected ";"', location: { file: 'src/x.js' } }], ROOT), null);
  assert.equal(unresolvedLocalImports([], ROOT), null);
  assert.equal(unresolvedLocalImports([{ text: 'Could not resolve "../package.json"', location: { file: 'tools/x.js' } }], ROOT), null, 'a file that exists is a different problem');
});

test('command line: build.mjs --help names --strict and --check-lock', () => {
  const help = spawnSync(process.execPath, ['build.mjs', '--help'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--strict/);
  assert.match(help.stdout, /--check-lock/);
  assert.equal(sha256Hex(Buffer.from('')).length, 64);
});

// ---------------------------------------------------------------------------------------------------------------------
// The workflows and the shrinkwrap, as files (nothing is run: a release is the owner's step, and CI is not available here).
// repo-layout.test.mjs checks the rules every workflow shares (no permissions at the top, actions pinned to a commit, no
// ${{ }} inside a run block); these check what V03-DESIGN-REVIEW 2.19 asks of the release and rebuild workflows.
// ---------------------------------------------------------------------------------------------------------------------

const readRepo = (f) => readFileSync(join(ROOT, f), 'utf8');
const stripComments = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

/** The jobs of a workflow: name -> its block of text. */
function jobsOf(text) {
  const start = text.search(/^jobs:\s*$/m);
  assert.ok(start >= 0, 'a jobs: section');
  const body = text.slice(start).split('\n').slice(1).join('\n');
  const jobs = {};
  const re = /^ {2}([a-z][a-z0-9-]*):\s*$/gm;
  const marks = [];
  let m;
  while ((m = re.exec(body)) !== null) marks.push({ name: m[1], at: m.index + m[0].length });
  marks.forEach((mark, i) => {
    jobs[mark.name] = body.slice(mark.at, i + 1 < marks.length ? marks[i + 1].at - marks[i + 1].name.length - 3 : undefined);
  });
  return jobs;
}

test('release.yml: a draft, never a replacement; installs without scripts; the lists the owner signs; attest and release are gated and run no repository code', () => {
  const raw = readRepo('.github/workflows/release.yml');
  const code = stripComments(raw);
  assert.match(code, /^permissions: \{\}$/m, 'no permissions at the workflow level');
  for (const m of code.matchAll(/\bnpm ci\b([^\n]*)/g)) assert.match(m[1], /--ignore-scripts/, 'npm ci' + m[1]);
  for (const m of code.matchAll(/\bnpm pack\b([^\n]*)/g)) assert.match(m[1], /--ignore-scripts/);
  assert.ok(!/--clobber/.test(code), 'a release asset is never replaced');
  assert.match(code, /gh release create[\s\S]*--verify-tag[\s\S]*--draft/, 'the release is created as a draft, from a tag that exists');
  assert.ok(/gh release view/.test(code) && /already exists/.test(code), 'an existing release stops the job');
  assert.ok(!/gh release edit[^\n]*--draft=false/.test(code), 'publishing is the owner\'s step, not the workflow\'s');

  const jobs = jobsOf(code);
  assert.deepEqual(Object.keys(jobs), ['build', 'attest', 'release']);
  assert.ok(!/environment:/.test(jobs.build), 'the build needs no approval');
  for (const j of ['attest', 'release']) assert.match(jobs[j], /^\s*environment: release$/m, j + ' waits for the release environment');
  assert.match(jobs.release, /contents: write/);
  assert.ok(!/contents: write/.test(jobs.build + jobs.attest), 'only the release job can write contents');
  assert.match(jobs.attest, /id-token: write/);
  assert.match(jobs.attest, /attestations: write/);
  assert.ok(!/id-token|attestations/.test(jobs.build + jobs.release), 'only the attest job can mint the identity token');
  for (const j of ['attest', 'release']) {
    const runs = (jobs[j].match(/run: [|>]?[\s\S]*?(?=\n {6}- |\n {2}\S|$)/g) || []).join('\n');
    assert.ok(!/\b(npm|npx|node|yarn|pnpm)\b/.test(runs), j + ' runs no repository code and no package manager');
  }

  // the build job: what it checks and what it packs
  for (const needle of ['npm test', 'npm run test:fuzz', 'node build.mjs --strict', 'node build.mjs --check-lock', 'npm run build:idp', 'npm run test:e2e', 'cmp package-lock.json npm-shrinkwrap.json',
    'tools/verify-release.mjs list dist --out release/hashes-dist.json', 'tools/verify-release.mjs list dist-idp --out release/hashes-idp.json', 'sha256sum', 'SHA256SUMS']) {
    assert.ok(jobs.build.includes(needle), 'the build job has: ' + needle);
  }
  assert.match(jobs.build, /tar -tzf "release\/felinar-\$VERSION\.tgz" \| grep -qx 'package\/npm-shrinkwrap\.json'/, 'the tarball is checked to carry the shrinkwrap');
  assert.match(jobs.build, /npm run test:fuzz -- --iterations \d+ --seconds \d+ --seed "\$GITHUB_RUN_NUMBER"/);

  // provenance: pinned to a commit with its tag in a comment; the subjects are the files the build job listed
  assert.match(jobs.attest, /uses: actions\/attest-build-provenance@[0-9a-f]{40} # v\d+\.\d+\.\d+/);
  for (const subject of ['release/felinar-*.zip', 'release/felinar-*.tgz', 'release/hashes-*.json']) assert.ok(jobs.attest.includes(subject), subject);
  assert.ok(jobs.attest.includes('sha256sum -c SHA256SUMS') && jobs.release.includes('sha256sum -c SHA256SUMS'), 'both later jobs check the files against the list the build job wrote');

  // the header explains the settings a workflow cannot make and the owner's offline steps
  for (const needle of ['release immutability', 'tag ruleset', 'required reviewers', 'cooldown', 'CODEOWNERS', 'tools/verify-release.mjs sign', 'tools/verify-release.mjs verify', 'no --clobber', 'gh attestation verify']) {
    assert.ok(raw.includes(needle), 'the release.yml header mentions: ' + needle);
  }
  assert.ok(!/blockchain|serverless|unstoppable|censorship-resistant|production-ready/i.test(raw), 'wording rules');
  assert.ok(!/\u2014|\u2013/.test(raw), 'no em or en dashes');
});

test('rebuild.yml: the loader and the identity page are built on three operating systems and the file lists must be identical', () => {
  const raw = readRepo('.github/workflows/rebuild.yml');
  const code = stripComments(raw);
  assert.match(code, /^permissions: \{\}$/m);
  const jobs = jobsOf(code);
  assert.deepEqual(Object.keys(jobs), ['build', 'compare']);
  assert.match(jobs.build, /os: \[ubuntu-latest, macos-latest, windows-latest\]/);
  assert.match(jobs.build, /fail-fast: false/);
  for (const needle of ['npm ci --ignore-scripts', 'node build.mjs --strict', 'npm run build:idp', 'tools/verify-release.mjs list dist ', 'tools/verify-release.mjs list dist-idp ', 'hashes-${{ matrix.os }}']) {
    assert.ok(jobs.build.includes(needle), 'build has: ' + needle);
  }
  assert.match(jobs.compare, /needs: build/);
  assert.ok(/cmp -s/.test(jobs.compare) && jobs.compare.includes('hashes-ubuntu-latest') && jobs.compare.includes('hashes-macos-latest') && jobs.compare.includes('hashes-windows-latest'));
  assert.ok(!/npm|node /.test(jobs.compare.split('\n').filter((l) => /^\s+run:|^\s{10}/.test(l)).join('\n').replace(/node-version/g, '')), 'the comparison runs no repository code');
  assert.match(raw, /byte for byte/);
  assert.ok(!/\u2014|\u2013/.test(raw), 'no em or en dashes');
});

test('ci.yml: installs without scripts, fuzzes with a seed per run, builds strict; the pack job allows the shrinkwrap and requires it to equal the lockfile', () => {
  const raw = readRepo('.github/workflows/ci.yml');
  const code = stripComments(raw);
  for (const m of code.matchAll(/\bnpm ci\b([^\n]*)/g)) assert.match(m[1], /--ignore-scripts/, 'npm ci' + m[1]);
  assert.match(code, /npm run test:fuzz -- --iterations \d+ --seconds \d+ --seed "\$GITHUB_RUN_NUMBER"/);
  assert.match(code, /node build\.mjs --strict/);
  assert.match(code, /node build\.mjs --check-lock/);
  assert.match(code, /cmp package-lock\.json npm-shrinkwrap\.json/);
  assert.ok(raw.includes('npm-shrinkwrap.json'));
});

test('npm-shrinkwrap.json is the lockfile byte for byte (what the published package pins is what CI tested), and package.json has the new scripts', () => {
  const lock = readFileSync(join(ROOT, 'package-lock.json'));
  const wrap = readFileSync(join(ROOT, 'npm-shrinkwrap.json'));
  assert.ok(lock.equals(wrap), 'npm-shrinkwrap.json differs from package-lock.json: regenerate it (npm shrinkwrap) after every change to the lockfile');
  const parsed = JSON.parse(wrap.toString('utf8'));
  const pkg = JSON.parse(readRepo('package.json'));
  assert.equal(parsed.name, pkg.name);
  assert.equal(parsed.version, pkg.version);
  assert.ok(parsed.lockfileVersion >= 2);
  assert.equal(pkg.scripts['test:fuzz'], 'node test/fuzz/run.mjs');
  assert.equal(pkg.scripts['build:idp'], 'node tools/build-idp.mjs');
  assert.equal(pkg.scripts['verify:release'], 'node tools/verify-release.mjs');
  assert.match(pkg.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  for (const f of ['bin/', 'src/', 'tools/', 'build.mjs', 'build.lock.json', 'npm-shrinkwrap.json']) assert.ok(pkg.files.includes(f), 'files lists ' + f);
  // the published package ships no fuzz or test code, so the fuzzers' scratch targets cannot reach a user
  assert.ok(!pkg.files.some((f) => /^test\/(fuzz|unit)/.test(f)));
});

test('npm pack carries the shrinkwrap (a files list drops it unless it is named), nothing from test/ but the browser arguments, and every relative import stays inside the package', (t) => {
  const bin = join(dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const npm = existsSync(bin) ? bin : 'npm';
  const shell = process.platform === 'win32';
  if (spawnSync(npm, ['--version'], { encoding: 'utf8', shell }).status !== 0) return t.skip('npm is not available here');
  const r = spawnSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', timeout: 120000, shell });
  assert.equal(r.status, 0, r.stderr);
  const [pack] = JSON.parse(r.stdout);
  const names = new Set(pack.files.map((f) => f.path));
  assert.ok(names.has('npm-shrinkwrap.json'), 'the shrinkwrap is in the tarball: name it in package.json "files"');
  for (const must of ['package.json', 'build.mjs', 'build.lock.json', 'bin/felinar.mjs', 'tools/verify-release.mjs', 'tools/ledger-admin.mjs', 'tools/publish.mjs', 'tools/pin.mjs', 'tools/seeder.html', 'tools/webseed-file.mjs', 'tools/init.mjs', 'test/e2e/browser-args.mjs']) {
    assert.ok(names.has(must), must + ' is in the package');
  }
  assert.deepEqual(Array.from(names).filter((n) => /^(test|docs|dist|dist-idp|\.github|packages)\//.test(n) && n !== 'test/e2e/browser-args.mjs'), [], 'no test, docs, build output or workflow in the package');
  assert.deepEqual(Array.from(names).filter((n) => /\.(jwk|pem|key)$/.test(n)), []);
  const outside = [];
  for (const file of names) {
    if (!/\.m?js$/.test(file)) continue;
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const m of text.matchAll(/(?:import|export)\s[^"']*?from\s*["'](\.[^"']+)["']|import\s*\(\s*["'](\.[^"']+)["']\s*\)|import\s*["'](\.[^"']+)["']/g)) {
      const spec = m[1] || m[2] || m[3];
      const target = posix.normalize(posix.join(posix.dirname(file), spec));
      if (!names.has(target)) outside.push(file + ' imports ' + spec);
    }
  }
  assert.deepEqual(outside, [], 'an installed copy would lack these files');
});

test('SUP-5, SUP-8: the CI template checks the loader against the signed release list before the owner key is read, and installs without scripts', () => {
  const text = readFileSync(join(ROOT, 'deploy', 'github-actions', 'publish-site.yml'), 'utf8');
  const publishJob = text.slice(text.indexOf('\n  publish:\n'), text.indexOf('\n  upload:\n') > 0 ? text.indexOf('\n  upload:\n') : undefined);
  const verifyAt = publishJob.indexOf('tools/verify-release.mjs" verify');
  const keyAt = publishJob.indexOf('MW_OWNER_JWK');
  assert.ok(verifyAt > 0, 'the publish job runs verify-release verify');
  assert.ok(keyAt > verifyAt, 'verify runs before the first use of MW_OWNER_JWK');
  assert.match(publishJob, /--expect-version "\$\{FELINAR_REF#v\}"/);
  assert.match(publishJob, /--release-list "\$RUNNER_TEMP\/release\/hashes-dist\.json"/, 'publish checks it again');
  const npmCi = text.split('\n').filter((l) => /\bnpm ci\b/.test(l) && !/^\s*#/.test(l));
  assert.ok(npmCi.length >= 3);
  for (const line of npmCi) assert.match(line, /--ignore-scripts/, line.trim());
});
