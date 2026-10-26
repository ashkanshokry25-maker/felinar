// Unit tests for build.mjs (ARCHITECTURE section 10 and 13, DESIGN-REVIEW items 16, 20, S7):
// placeholder replacement, SRI, the build id, the sha256 lock and the syntax gate as pure
// functions, plus one real build into a temporary directory.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as esbuildForTests from 'esbuild';

// True when esbuild accepts the code at target es5 (it refuses ES2015+ syntax it cannot lower).
function esbuildTransformEs5 (code) {
  try {
    esbuildForTests.transformSync(code, { loader: 'js', target: 'es5', logLevel: 'silent' });
    return true;
  } catch (_) {
    return false;
  }
}

import {
  applyPlaceholders, applySri, checkLock, checkMarkers, computeBuildId, precacheList, sriFor, syntaxGate, manifestJson, build,
  sha256Hex, TARGETS, ENGINE_TARGETS, ROOT, ENTRIES, WEBTORRENT_PATCHES, applyVendorPatches, checkPatchedLock, integrityMap,
  provenanceProblems, lockVersions, PROVENANCE_REQUIRED,
} from '../../build.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'mw-build-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const VENDORED = join(ROOT, 'node_modules', 'webtorrent', 'dist', 'webtorrent.min.js');

// ---------------------------------------------------------------------------------------------- pure functions

test('targets are the declared floor', () => {
  assert.deepEqual(Array.from(TARGETS), ['es2020', 'safari15.4', 'chrome110', 'firefox115']);
  assert.deepEqual(Array.from(ENGINE_TARGETS), ['safari15.4', 'chrome110', 'firefox115']);
});

test('sriFor: sha384 base64 (empty input vector)', () => {
  assert.equal(sriFor(new Uint8Array(0)), 'sha384-OLBgp1GsljhM2TJ+sbHjaiH9txEUvgdDTAzHv2P24donTt6/529l+9Ua0vFImLlb');
});

test('applyPlaceholders: replaces self.__BUILD_ID__ and self.__PRECACHE__ everywhere, as JSON', () => {
  const code = 'const a = self.__BUILD_ID__ || "dev"; const b = self.__PRECACHE__ || []; self.mw = f({ buildId: self.__BUILD_ID__, precache: self.__PRECACHE__ });';
  const out = applyPlaceholders(code, { buildId: 'abc123def456', precache: ['/index.html', '/_mw/boot.js'] });
  assert.equal(out.includes('__BUILD_ID__'), false);
  assert.equal(out.includes('__PRECACHE__'), false);
  assert.equal(out, 'const a = "abc123def456" || "dev"; const b = ["/index.html","/_mw/boot.js"] || []; self.mw = f({ buildId: "abc123def456", precache: ["/index.html","/_mw/boot.js"] });');
  // the result still parses as a classic script
  assert.doesNotThrow(() => new vm.Script(out));
});

test('applyPlaceholders: a bundle without the placeholders, or bad values, fail loudly', () => {
  assert.throws(() => applyPlaceholders('self.__BUILD_ID__', { buildId: 'abcdef123456', precache: ['/index.html'] }), /__PRECACHE__/);
  assert.throws(() => applyPlaceholders('self.__PRECACHE__', { buildId: 'abcdef123456', precache: ['/index.html'] }), /__BUILD_ID__/);
  assert.throws(() => applyPlaceholders('x', { buildId: 'abcdef123456', precache: [] }), /__BUILD_ID__/);
  assert.throws(() => applyPlaceholders('self.__BUILD_ID__ self.__PRECACHE__', { buildId: '', precache: [] }), /build id/);
  assert.throws(() => applyPlaceholders('self.__BUILD_ID__ self.__PRECACHE__', { buildId: 'abcdef123456', precache: ['index.html'] }), /absolute/);
  // replacement text is literal: "$&" in a path must not be expanded
  const out = applyPlaceholders('self.__BUILD_ID__;self.__PRECACHE__', { buildId: 'abcdef123456', precache: ['/a$&b'] });
  assert.equal(out, '"abcdef123456";["/a$&b"]');
});

test('computeBuildId: stable, order independent, sensitive to every byte and every path', () => {
  const files = [{ path: 'a.js', sha256: sha256Hex('a') }, { path: 'b.js', sha256: sha256Hex('b') }];
  const id = computeBuildId(files);
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.equal(computeBuildId(files.slice().reverse()), id);
  assert.notEqual(computeBuildId([files[0], { path: 'b.js', sha256: sha256Hex('c') }]), id);
  assert.notEqual(computeBuildId([files[0], { path: 'c.js', sha256: files[1].sha256 }]), id);
});

test('precacheList: the shell and every /_mw/ file except the vendored bundle', () => {
  const list = precacheList(['index.html', '404.html', 'mw-sw.js', '_mw/webtorrent.min.js', '_mw/loader.js', '_mw/boot.js', '_mw/icons/icon.svg', 'build.json']);
  assert.deepEqual(list, ['/index.html', '/_mw/boot.js', '/_mw/icons/icon.svg', '/_mw/loader.js']);
});

const SHELL = [
  '<!doctype html><html><head><meta charset="utf-8">',
  '<link rel="modulepreload" href="/_mw/loader.js">',
  '<link rel="stylesheet" href="/_mw/ui.css">',
  '</head><body><script src="/_mw/boot.js"></script></body></html>',
].join('\n');

test('applySri: integrity and crossorigin on exactly the two static tags; idempotent', () => {
  const map = { '/_mw/boot.js': 'sha384-AAA', '/_mw/loader.js': 'sha384-BBB' };
  const once = applySri(SHELL, map);
  assert.match(once, /<link rel="modulepreload" href="\/_mw\/loader\.js" integrity="sha384-BBB" crossorigin="anonymous">/);
  assert.match(once, /<script src="\/_mw\/boot\.js" integrity="sha384-AAA" crossorigin="anonymous"><\/script>/);
  assert.equal((once.match(/integrity=/g) || []).length, 2, 'the stylesheet gets none');
  assert.equal(applySri(once, map), once, 'running it again changes nothing');
  const changed = applySri(once, { '/_mw/boot.js': 'sha384-CCC', '/_mw/loader.js': 'sha384-BBB' });
  assert.match(changed, /boot\.js" integrity="sha384-CCC" crossorigin="anonymous"/);
  assert.equal((changed.match(/integrity=/g) || []).length, 2);
  const selfClosing = applySri('<head><link rel="modulepreload" href="/_mw/loader.js" /><script src="/_mw/boot.js"></script></head>', map);
  assert.match(selfClosing, /href="\/_mw\/loader\.js" integrity="sha384-BBB" crossorigin="anonymous" \/>/);
});

test('applySri: a missing tag fails the build instead of dropping SRI', () => {
  assert.throws(() => applySri('<html><head></head></html>', { '/_mw/boot.js': 'sha384-AAA' }), /no <script src="\/_mw\/boot\.js">/);
});

test('checkLock: a match passes; one changed byte, a wrong version or a missing entry fail with instructions', () => {
  const bytes = Buffer.from('vendored bundle bytes');
  const lock = { v: 1, vendored: { 'webtorrent.min.js': { package: 'webtorrent', version: '3.0.21', sha256: sha256Hex(bytes) } } };
  const ok = checkLock(lock, { name: 'webtorrent.min.js', bytes, version: '3.0.21' });
  assert.equal(ok.ok, true);
  const flipped = Buffer.from(bytes);
  flipped[3] ^= 1;
  const bad = checkLock(lock, { name: 'webtorrent.min.js', bytes: flipped, version: '3.0.21' });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /does not match the pinned sha256/);
  assert.ok(bad.message.includes(sha256Hex(bytes)) && bad.message.includes(sha256Hex(flipped)), 'both hashes are shown');
  assert.match(bad.message, /--update-lock/);
  assert.match(bad.message, /npm ci/);
  const version = checkLock(lock, { name: 'webtorrent.min.js', bytes, version: '3.1.0' });
  assert.equal(version.ok, false);
  assert.match(version.message, /version differs/);
  assert.equal(checkLock({ v: 1, vendored: {} }, { name: 'webtorrent.min.js', bytes }).ok, false);
  assert.equal(checkLock(null, { name: 'webtorrent.min.js', bytes }).ok, false);
});

test('syntaxGate: passes ES2020 code, rejects top-level await and syntax the floor engines need lowered', () => {
  assert.equal(syntaxGate('export default class A { x = 1; async f() { return await 1; } }\n').ok, true);
  const tla = syntaxGate('await Promise.resolve(1);\nexport default 1;\n');
  assert.equal(tla.ok, false);
  assert.match(tla.problems[0], /does not parse/);
  const staticBlock = syntaxGate('class A { static { A.x = 1; } }\nexport default A;\n');
  assert.equal(staticBlock.ok, false);
  assert.match(staticBlock.problems[0], /needs lowering/);
  assert.equal(syntaxGate('export default (a ?? 1) + 1;\n').ok, true);
  assert.equal(syntaxGate('export default @@@;').ok, false);
});

test('the vendored webtorrent bundle passes the syntax gate and the lock file pins it', () => {
  const bytes = readFileSync(VENDORED);
  const gate = syntaxGate(bytes.toString('utf8'));
  assert.deepEqual(gate.problems, []);
  const lock = JSON.parse(readFileSync(join(ROOT, 'build.lock.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'webtorrent', 'package.json'), 'utf8'));
  const verdict = checkLock(lock, { name: 'webtorrent.min.js', bytes, version: pkg.version });
  assert.equal(verdict.ok, true, verdict.message);
});

test('manifestJson: no protocol_handlers in v1 (code review round 1, DESIGN-REVIEW section 3), an svg icon, no backend wording problems', () => {
  const m = JSON.parse(manifestJson('0.2.0'));
  assert.equal(m.protocol_handlers, undefined, 'the magnet: handler is not advertised in v1');
  assert.equal(m.icons[0].src, '/_mw/icons/icon.svg');
  assert.equal(m.start_url, '/');
  assert.equal(/serverless|blockchain|unstoppable|censorship/i.test(JSON.stringify(m)), false);
});

// ---------------------------------------------------------------------------------------------- real build

test('build: writes every output, a classic SW with the build id, SRI that matches the files; reproducible', async () => {
  const out1 = join(tmp, 'dist1');
  const res = await build({ outDir: out1, quiet: true });
  const names = res.files.map((f) => f.path);
  const expected = ['index.html', '404.html', 'mw-sw.js', 'mw-sw-kill.js', '_mw/boot.js', '_mw/loader.js', '_mw/sdk.js', '_mw/sw-core.js',
    '_mw/pow-worker.js', '_mw/webtorrent.min.js', '_mw/ui.css', '_mw/manifest.webmanifest', '_mw/icons/icon.svg'];
  for (const name of expected) {
    if (name === '_mw/mw.js') continue;
    assert.ok(names.includes(name), 'builds ' + name);
    assert.ok(existsSync(join(out1, ...name.split('/'))), name + ' is on disk');
  }
  assert.ok(existsSync(join(out1, 'build.json')));
  // _mw/mw.js is built when src/dropin/mw.js exists, and reported as skipped otherwise
  const dropinThere = existsSync(join(ROOT, 'src', 'dropin', 'mw.js'));
  assert.equal(names.includes('_mw/mw.js'), dropinThere);
  assert.equal(res.skipped.includes('_mw/mw.js'), !dropinThere);

  assert.equal(readFileSync(join(out1, '404.html')).equals(readFileSync(join(out1, 'index.html'))), true);
  const webtorrent = readFileSync(join(out1, '_mw', 'webtorrent.min.js'));
  // v0.2.1 B3: the vendored bundle is copied with the hash-asserted request-header patch applied
  // (it used to be copied byte for byte).
  const patchedExpected = Buffer.from(applyVendorPatches(readFileSync(VENDORED, 'utf8')).code, 'utf8');
  assert.equal(webtorrent.equals(patchedExpected), true, 'dist gets the patched bundle, nothing else changed');
  assert.equal(webtorrent.equals(readFileSync(VENDORED)), false, 'the stock bundle is never shipped');

  for (const classic of ['mw-sw.js', 'mw-sw-kill.js', '_mw/boot.js', '_mw/sw-core.js', '_mw/pow-worker.js']) {
    const code = readFileSync(join(out1, ...classic.split('/')), 'utf8');
    assert.doesNotThrow(() => new vm.Script(code), classic + ' parses as a classic script');
    assert.equal(/^\s*(import|export)\s/m.test(code), false, classic + ' has no module syntax');
  }
  for (const sw of ['mw-sw.js', '_mw/sw-core.js']) {
    const code = readFileSync(join(out1, ...sw.split('/')), 'utf8');
    assert.equal(code.includes('self.__BUILD_ID__'), false, sw + ' has no placeholder left');
    assert.equal(code.includes('self.__PRECACHE__'), false);
    assert.ok(code.includes('"' + res.buildId + '"'), sw + ' carries the build id');
  }
  const sw = readFileSync(join(out1, 'mw-sw.js'), 'utf8');
  assert.ok(sw.includes('"/index.html","/_mw/boot.js"'), 'the precache list is embedded');
  assert.equal(sw.includes('"/_mw/webtorrent.min.js"') && /precache:\["\/index\.html"[^\]]*webtorrent/.test(sw), false, 'webtorrent.min.js is not precached');

  const html = readFileSync(join(out1, 'index.html'), 'utf8');
  for (const p of ['/_mw/boot.js', '/_mw/loader.js']) {
    const sri = sriFor(readFileSync(join(out1, ...p.slice(1).split('/'))));
    assert.ok(html.includes('"' + sri + '"'), 'index.html carries the SRI of ' + p);
  }
  assert.equal((html.match(/integrity=/g) || []).length, 2);
  // Code review round 1 (item 22): the static boot line explains a non-root deployment, where boot.js never runs.
  assert.match(html, /<p id="mw-boot"[^>]*>Starting\.\.\. <span class="mw-boot-hint">If this stays, the loader did not start\. It must be served from the root of its domain/)
  const css = readFileSync(join(out1, '_mw', 'ui.css'), 'utf8')
  assert.match(css, /\.mw-boot-hint\{animation:/, 'shown only after a delay when ui.css loads')
  // Code review round 1 (F43): the frame shows the page canvas colour, not the shell's grey; (F45) phone fields are 16 px.
  assert.match(css, /\.mw-site-frame\{[^}]*background:Canvas/)
  const at = css.search(/@media ?\(max-width:767px\)/)
  assert.ok(at >= 0, 'the phone media block')
  const phone = css.slice(at, css.indexOf('@media', at + 6) > 0 ? css.indexOf('@media', at + 6) : undefined)
  assert.match(phone, /\.mw-input,textarea\.mw-input,select\.mw-input\{font-size:16px\}/, 'inputs are 16 px on phones (no iOS focus zoom)')
  // Code review round 1 (F41): boot.js parses in pre-ES2015 browsers, so they can say they are unsupported.
  const bootCode = readFileSync(join(out1, '_mw', 'boot.js'), 'utf8')
  assert.equal(bootCode.includes('=>'), false, 'no arrow function, not even the IIFE wrapper')
  assert.equal(/\b(let|const|class)\s/.test(bootCode), false, 'no block-scoped declarations or classes')
  assert.equal(esbuildTransformEs5(bootCode), true, 'an es5 transform accepts it as is')

  const info = JSON.parse(readFileSync(join(out1, 'build.json'), 'utf8'));
  assert.equal(info.buildId, res.buildId);
  assert.deepEqual(info.targets, Array.from(TARGETS));
  assert.equal(info.vendored['webtorrent.min.js'].sha256, sha256Hex(readFileSync(VENDORED)), 'sha256 names the stock file');
  assert.equal(info.vendored['webtorrent.min.js'].patched, true, 'build.json records patched: true');
  assert.equal(info.vendored['webtorrent.min.js'].patchedSha256, sha256Hex(webtorrent));
  assert.deepEqual(info.vendored['webtorrent.min.js'].patches, WEBTORRENT_PATCHES.map((p) => p.id));
  assert.equal(Object.keys(info).includes('builtAt'), false, 'no timestamp: builds are reproducible');

  const res2 = await build({ outDir: join(tmp, 'dist2'), quiet: true });
  assert.equal(res2.buildId, res.buildId);
  assert.deepEqual(res2.files, res.files, 'same sources, same bytes');

  // a second build into the same directory replaces it
  const res3 = await build({ outDir: out1, quiet: true });
  assert.equal(res3.buildId, res.buildId);
});

test('build: refuses to wipe a directory that is not a build output', async () => {
  const dir = join(tmp, 'precious');
  mkdirSync(dir);
  writeFileSync(join(dir, 'notes.txt'), 'keep me');
  await assert.rejects(build({ outDir: dir, quiet: true }), /refusing to replace/);
  assert.equal(existsSync(join(dir, 'notes.txt')), true);
});

test('build: one changed byte in the vendored bundle fails the build (DESIGN-REVIEW S7)', async () => {
  const tampered = Buffer.from(readFileSync(VENDORED));
  tampered[1000] ^= 1;
  const file = join(tmp, 'webtorrent.tampered.js');
  writeFileSync(file, tampered);
  const outDir = join(tmp, 'dist-tampered');
  await assert.rejects(build({ outDir, quiet: true, vendorFile: file, vendorVersion: '3.0.21' }), (err) => {
    assert.match(err.message, /does not match the pinned sha256/);
    assert.ok(err.message.includes(sha256Hex(tampered)));
    return true;
  });
  assert.equal(existsSync(outDir), false, 'nothing is written');
});

test('build: --update-lock pins a reviewed bundle in a lock file of its own', async () => {
  const lockFile = join(tmp, 'other.lock.json');
  const changed = Buffer.from(readFileSync(VENDORED));
  changed[1000] ^= 1;
  const file = join(tmp, 'webtorrent.changed.js');
  writeFileSync(file, changed);
  // a flipped byte may or may not still parse; the gate is allowed to refuse it, the lock must have been written first
  // SUP-11: a new webtorrent release must carry npm provenance (looked up with npm view; injected here, nothing leaves the machine)
  await assert.rejects(build({ outDir: join(tmp, 'dist-updated'), quiet: true, vendorFile: file, vendorVersion: '9.9.9', lockFile, updateLock: true, provenanceOf: async () => false }),
    (e) => /refusing --update-lock: webtorrent 9\.9\.9: the release has no provenance attestation/.test(e.message));
  assert.equal(existsSync(lockFile), false, 'nothing was pinned');
  await build({ outDir: join(tmp, 'dist-updated'), quiet: true, vendorFile: file, vendorVersion: '9.9.9', lockFile, updateLock: true, provenanceOf: async () => true }).catch(() => {});
  const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
  assert.equal(lock.vendored['webtorrent.min.js'].sha256, sha256Hex(changed));
  assert.equal(lock.vendored['webtorrent.min.js'].version, '9.9.9');
  assert.equal(ENTRIES.length >= 7, true);
});

test('checkMarkers: strings that our code patches must still be in the vendored bundle', () => {
  assert.deepEqual(checkMarkers('class W { _onMessageLength(n) {} }', ['_onMessageLength(']), { ok: true, missing: [] });
  assert.deepEqual(checkMarkers('class W { _onLength(n) {} }', ['_onMessageLength(']), { ok: false, missing: ['_onMessageLength('] });
  assert.deepEqual(checkMarkers('anything', []), { ok: true, missing: [] });
  const lock = JSON.parse(readFileSync(join(ROOT, 'build.lock.json'), 'utf8'));
  assert.deepEqual(lock.vendored['webtorrent.min.js'].markers, ['_onMessageLength(']);
  assert.equal(checkMarkers(readFileSync(VENDORED, 'utf8'), lock.vendored['webtorrent.min.js'].markers).ok, true);
});

// ---------------------------------------------------------------------------------------------- v0.2.1 B3: request-header patch

test('B3: the patch removes Cache-Control and user-agent from web-seed, xs= and .torrent URL requests, keeps cache: no-store', () => {
  const stock = readFileSync(VENDORED, 'utf8');
  const { code, applied } = applyVendorPatches(stock);
  assert.deepEqual(applied, ['webconn-request-headers', 'xs-metadata-user-agent', 'remote-torrent-user-agent', 'opfs-chunks-cleanup', 'fsa-createwritable-polyfill']);
  for (const p of WEBTORRENT_PATCHES) {
    assert.equal(stock.split(p.find).length - 1, 1, p.id + ': exactly one patch point in the stock bundle');
    assert.equal(code.includes(p.find), false, p.id + ' applied');
  }
  // The web-seed request: Range only, the fetch option cache: 'no-store' stays (it is not a header).
  assert.ok(code.includes('cache:"no-store",method:"GET",headers:{range:`bytes=${i}-${s}`}'), 'web-seed request keeps cache: no-store and Range');
  assert.equal(code.includes('"Cache-Control":"no-store"'), false, 'no Cache-Control request header anywhere');
  // One user-agent header is left: the blocklist download, which only runs with a blocklist option (never in the loader).
  assert.equal(code.split('"user-agent"').length - 1, 1);
  assert.ok(/blocklist,\{headers:\{"user-agent"/.test(code), 'the remaining user-agent is the unused blocklist fetch');
  assert.equal(syntaxGate(code).ok, true, 'the patched bundle still passes the syntax gate');
  assert.equal(checkMarkers(code, ['_onMessageLength(']).ok, true);
});

test('code review round 1: the patched bundle never deletes the origin\'s OPFS "chunks" nor patches FSA globals at import', async () => {
  const stock = readFileSync(VENDORED, 'utf8');
  const { code } = applyVendorPatches(stock);
  assert.equal(stock.split('removeEntry("chunks"').length - 1, 1, 'the stock bundle has the cleanup');
  assert.equal(code.includes('removeEntry("chunks"'), false);
  assert.equal(code.includes('FileSystemWritableFileStream=Rt'), false);
  assert.equal(code.includes('FileSystemDirectoryHandle.prototype.getFileHandle=async function'), true, 'the polyfill body stays, behind a false guard');
  // Import it in a child process with a fake OPFS and fake FSA globals: no getDirectory() call, no
  // global replaced. The stock bundle, imported the same way, calls getDirectory() once (control).
  const dir = mkdtempSync(join(tmpdir(), 'mw-opfs-'));
  try {
    const probe = (bundle) => {
      const file = join(dir, 'b' + Math.random().toString(36).slice(2) + '.mjs');
      writeFileSync(file, bundle);
      const script = [
        'let calls = 0;',
        'const removed = [];',
        "const root = { removeEntry: async (name, opts) => { removed.push([name, opts]); } };",
        "Object.defineProperty(globalThis, 'navigator', { value: { storage: { getDirectory: () => { calls++; return Promise.resolve(root); } }, userAgent: 'node' }, configurable: true });",
        'globalThis.self = globalThis;',
        'class FileSystemFileHandle {}',
        'class FileSystemDirectoryHandle { async getFileHandle() { return null; } }',
        'const origGet = FileSystemDirectoryHandle.prototype.getFileHandle;',
        'globalThis.FileSystemFileHandle = FileSystemFileHandle;',
        'globalThis.FileSystemDirectoryHandle = FileSystemDirectoryHandle;',
        'await import(' + JSON.stringify(pathToFileURL(file).href) + ');',
        'await new Promise((r) => setTimeout(r, 50));',
        'console.log(JSON.stringify({ calls, removed, createWritable: typeof FileSystemFileHandle.prototype.createWritable, getPatched: FileSystemDirectoryHandle.prototype.getFileHandle !== origGet, stream: typeof globalThis.FileSystemWritableFileStream }));',
        'process.exit(0);',
      ].join('\n');
      const runner = join(dir, 'run' + Math.random().toString(36).slice(2) + '.mjs');
      writeFileSync(runner, script);
      const res = spawnSync(process.execPath, [runner], { encoding: 'utf8', timeout: 30000 });
      assert.equal(res.status, 0, res.stderr);
      return JSON.parse(res.stdout.trim().split('\n').pop());
    };
    const patched = probe(code);
    assert.deepEqual(patched, { calls: 0, removed: [], createWritable: 'undefined', getPatched: false, stream: 'undefined' });
    const control = probe(stock);
    assert.equal(control.calls, 1, 'the stock bundle asks for the OPFS root at import');
    assert.deepEqual(control.removed, [['chunks', { recursive: true }]]);
    assert.equal(control.createWritable, 'function', 'the stock bundle patches the host global');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('B3: a moved or duplicated patch point fails loudly (never ships the stock headers)', () => {
  const stock = readFileSync(VENDORED, 'utf8');
  const p = WEBTORRENT_PATCHES[0];
  const moved = stock.replace(p.find, p.find.replace('"Cache-Control"', '"cache-control"'));
  assert.throws(() => applyVendorPatches(moved), (err) => /patch point "webconn-request-headers"/.test(err.message) && /matches 0 times/.test(err.message));
  const twice = stock + '\n/*' + WEBTORRENT_PATCHES[1].find + '*/';
  assert.throws(() => applyVendorPatches(twice), /"xs-metadata-user-agent".*matches 2 times/s);
});

test('B3: checkPatchedLock pins the patched bytes and the patch list', () => {
  const bytes = Buffer.from('patched');
  const applied = ['a', 'b'];
  const good = { vendored: { 'webtorrent.min.js': { patched: { sha256: sha256Hex(bytes), patches: ['a', 'b'] } } } };
  assert.equal(checkPatchedLock(good, { name: 'webtorrent.min.js', bytes, applied }).ok, true);
  assert.equal(checkPatchedLock({ vendored: { 'webtorrent.min.js': {} } }, { name: 'webtorrent.min.js', bytes, applied }).ok, false);
  const other = checkPatchedLock(good, { name: 'webtorrent.min.js', bytes: Buffer.from('other'), applied });
  assert.equal(other.ok, false);
  assert.match(other.message, /does not match the pin/);
  assert.equal(checkPatchedLock(good, { name: 'webtorrent.min.js', bytes, applied: ['a'] }).ok, false, 'a dropped patch is a change');
  const lock = JSON.parse(readFileSync(join(ROOT, 'build.lock.json'), 'utf8'));
  const real = applyVendorPatches(readFileSync(VENDORED, 'utf8'));
  const verdict = checkPatchedLock(lock, { name: 'webtorrent.min.js', bytes: Buffer.from(real.code, 'utf8'), applied: real.applied });
  assert.equal(verdict.ok, true, verdict.message);
});

test('B3: build fails when the patched output differs from the pin (a patch changed without --update-lock)', async () => {
  const lockFile = join(tmp, 'patchpin.lock.json');
  const lock = JSON.parse(readFileSync(join(ROOT, 'build.lock.json'), 'utf8'));
  lock.vendored['webtorrent.min.js'].patched.sha256 = '0'.repeat(64);
  writeFileSync(lockFile, JSON.stringify(lock));
  const outDir = join(tmp, 'dist-patchpin');
  await assert.rejects(build({ outDir, quiet: true, lockFile }), /patched webtorrent\.min\.js does not match the pin/);
  assert.equal(existsSync(outDir), false, 'nothing is written');
  const moved = [Object.assign({}, WEBTORRENT_PATCHES[0], { find: 'this string is not in the bundle' })];
  await assert.rejects(build({ outDir, quiet: true, vendorPatches: moved }), /matches 0 times/);
  assert.equal(existsSync(outDir), false);
});

test('build: a pinned bundle that lost a marker fails with the reason (the message-length cap would silently stop working)', async () => {
  const bundle = Buffer.from('export default class WebTorrent {}\n');
  const file = join(tmp, 'webtorrent.nomarker.js');
  writeFileSync(file, bundle);
  const lockFile = join(tmp, 'nomarker.lock.json');
  writeFileSync(lockFile, JSON.stringify({ v: 1, vendored: { 'webtorrent.min.js': { sha256: sha256Hex(bundle), version: '1.0.0', markers: ['_onMessageLength('] } } }));
  await assert.rejects(build({ outDir: join(tmp, 'dist-nomarker'), quiet: true, vendorFile: file, vendorVersion: '1.0.0', lockFile }), /no longer contains "_onMessageLength\("/);
});

// ---------------------------------------------------------------------------------------------- v0.2.1 D2, F7

test('D2 build: /mw-sw.js carries the integrity map of the precached JS and CSS (the critical set), equal to build.json', async () => {
  const out = join(tmp, 'dist-integrity');
  const res = await build({ outDir: out, quiet: true });
  const info = JSON.parse(readFileSync(join(out, 'build.json'), 'utf8'));
  // Code review round 1 (F37): plus /_mw/webtorrent.min.js, not precached but checked on first fetch.
  // v0.3 (intended change): the built drop-in widgets are in the same class: checked when the worker serves them, never precached.
  const widgetsBuilt = ['/_mw/signin.js', '/_mw/chat-panel.js'].filter((p) => info.files.some((f) => '/' + f.path === p));
  const expectedKeys = info.precache.filter((p) => /\.(m?js|css)$/.test(p)).concat(['/_mw/webtorrent.min.js'], widgetsBuilt);
  assert.equal(info.precache.includes('/_mw/webtorrent.min.js'), false, 'still not precached');
  for (const p of ['/_mw/signin.js', '/_mw/chat-panel.js']) assert.equal(info.precache.includes(p), false, p + ' is not precached');
  assert.deepEqual(Object.keys(info.integrity).sort(), expectedKeys.slice().sort(), 'every precached JS and CSS file and the bundle, no HTML');
  for (const [p, value] of Object.entries(info.integrity)) {
    assert.equal(value, sriFor(readFileSync(join(out, ...p.slice(1).split('/')))), p + ': the hash of the final bytes (placeholders applied)');
  }
  const sw = readFileSync(join(out, 'mw-sw.js'), 'utf8');
  assert.equal(sw.includes('self.__INTEGRITY__'), false);
  for (const value of Object.values(info.integrity)) assert.ok(sw.includes(value), 'mw-sw.js embeds ' + value.slice(0, 20));
  assert.equal(readFileSync(join(out, '_mw', 'sw-core.js'), 'utf8').includes('__INTEGRITY__'), false);
  assert.ok(res.buildId);
  assert.throws(() => applyPlaceholders('self.__BUILD_ID__; self.__PRECACHE__', { buildId: 'abcd', precache: [], integrity: {} }), /no self\.__INTEGRITY__/);
  assert.throws(() => applyPlaceholders('self.__BUILD_ID__; self.__PRECACHE__; self.__INTEGRITY__', { buildId: 'abcd', precache: [], integrity: { 'x.js': 'sha384-a' } }), /absolute paths/);
  assert.equal(applyPlaceholders('self.__BUILD_ID__; self.__PRECACHE__; self.__INTEGRITY__', { buildId: 'abcd', precache: [] }).endsWith('null'), true, 'no map: null');
  assert.deepEqual(Object.keys(integrityMap(new Map([['_mw/a.js', Buffer.from('a')], ['_mw/b.css', Buffer.from('b')]]), ['/index.html', '/_mw/a.js', '/_mw/b.css', '/_mw/i.svg'])), ['/_mw/a.js', '/_mw/b.css']);
  assert.deepEqual(Object.keys(integrityMap(new Map([['_mw/a.js', Buffer.from('a')], ['_mw/webtorrent.min.js', Buffer.from('w')]]), ['/_mw/a.js'])), ['/_mw/a.js', '/_mw/webtorrent.min.js'], 'the bundle is checked on fetch');
});

test('F7 build: the static /_mw/sdk.js stub is emitted (dependency-free ESM), never precached, and resolves { mode: static }', async () => {
  const out = join(tmp, 'dist-stub');
  await build({ outDir: out, quiet: true });
  const file = join(out, '_mw', 'sdk-static.js');
  const code = readFileSync(file, 'utf8');
  assert.equal(/\bimport\s*[({'"]/.test(code.replace(/^\/\*[\s\S]*?\*\//, '')), false, 'no imports');
  const info = JSON.parse(readFileSync(join(out, 'build.json'), 'utf8'));
  assert.equal(info.precache.includes('/_mw/sdk-static.js'), false);
  assert.deepEqual(precacheList(['_mw/sdk-static.js', '_mw/sdk.js']), ['/index.html', '/_mw/sdk.js']);
  const mw = (await import(pathToFileURL(file).href + '?t=' + Date.now())).default;
  assert.equal(mw.mode, 'static');
  // v0.3 (SDK lane): the state also names auth ('guest') and features (all off); the v0.2.1 members are unchanged
  const ready = await mw.ready();
  const base = { mode: 'static', siteId: null, btih: null, identity: null, role: 'reader', peers: 0, height: 0, owner: null, unmoderated: true };
  assert.deepEqual(Object.fromEntries(Object.entries(ready).filter(([k]) => k in base)), base);
  for (const k of Object.keys(ready)) if (!(k in base)) assert.ok(['auth', 'features'].includes(k), 'unexpected member ' + k);
  if (ready.auth !== undefined) assert.equal(ready.auth, 'guest');
  if (ready.features !== undefined) assert.ok(Object.values(ready.features).every((v) => v === false), 'no feature is on in a static place');
  assert.equal(await mw.db.get('x'), undefined);
  assert.deepEqual(await mw.db.list('guestbook'), []);
  await assert.rejects(mw.db.append('guestbook', { t: 'hi' }), (err) => err.code === 'E_NO_HOST');
  assert.equal(typeof mw.db.subscribe(() => {}), 'function');
  assert.equal(mw.consent.state(), 'host-only');
  assert.equal(await mw.consent.request(), 'host-only');
  assert.equal('accept' in mw.consent, false, 'v0.2.1 A4 surface: no consent.accept');
  assert.equal(mw.net.peers(), 0);
});

test('B3 loader side: the web-seed probe sends what the patched connection sends (Range only, cache: no-store)', async () => {
  const { TorrentManager } = await import('../../src/loader/torrent.js');
  const seen = [];
  const tm = new TorrentManager({
    WebTorrent: class {},
    fetch: async (url, init) => {
      seen.push({ url, init });
      return new Response(new Uint8Array([1]), { status: 206, headers: { 'content-range': 'bytes 0-0/10' } });
    },
  });
  const r = await tm.probeWebseed('https://seed.example/ws/', { name: 'site', files: [{ path: 'a.css', length: 10, pad: false }, { path: 'b.js', length: 4, pad: false }] });
  assert.equal(r.ok, true);
  assert.equal(seen.length, 1);
  const headers = Object.keys(seen[0].init.headers || {}).map((h) => h.toLowerCase());
  assert.deepEqual(headers, ['range'], 'no Cache-Control or user-agent: no CORS preflight in current engines');
  assert.equal(seen[0].init.cache, 'no-store');
  tm.destroy && tm.destroy();
});

test('code review round 1 (F40): concurrent builds into one directory never expose a half-written build', async () => {
  const out = join(tmp, 'dist-concurrent');
  await build({ outDir: out, quiet: true });
  let checks = 0;
  let partial = 0;
  let stop = false;
  const reader = (async () => {
    while (!stop) {
      try {
        const info = JSON.parse(readFileSync(join(out, 'build.json'), 'utf8'));
        for (const f of info.files) {
          const bytes = readFileSync(join(out, ...f.path.split('/')));
          if (bytes.length !== f.bytes) partial++;
        }
        checks++;
      } catch (err) {
        // ENOENT for an instant between the two renames is allowed; anything readable must be whole.
        if (!(err && err.code === 'ENOENT')) partial++;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  await Promise.all([build({ outDir: out, quiet: true }), build({ outDir: out, quiet: true }), build({ outDir: out, quiet: true })]);
  stop = true;
  await reader;
  assert.equal(partial, 0, 'a reader saw a file of another size than build.json says');
  assert.ok(checks > 0);
  const info = JSON.parse(readFileSync(join(out, 'build.json'), 'utf8'));
  for (const f of info.files) assert.ok(existsSync(join(out, ...f.path.split('/'))), f.path);
  const { readdirSync } = await import('node:fs');
  assert.deepEqual(readdirSync(tmp).filter((n) => n.startsWith('dist-concurrent.')), [], 'no staging or retired directory left behind');
});

test('SUP-11: provenanceProblems flags a changed release of a provenance package without an attestation, or one that could not be looked up', async () => {
  const asked = [];
  const look = (answers) => async (name, version) => {
    asked.push(name + '@' + version);
    return answers[name];
  };
  assert.deepEqual(await provenanceProblems({ before: { webtorrent: '3.0.21' }, after: { webtorrent: '3.0.21' }, provenanceOf: look({}) }), [], 'an unchanged version is not looked up');
  assert.deepEqual(asked, []);
  const lost = await provenanceProblems({ before: { webtorrent: '3.0.21', esbuild: '0.25.0' }, after: { webtorrent: '3.0.22', esbuild: '0.25.1', 'left-pad': '2.0.0' }, provenanceOf: look({ webtorrent: false, esbuild: null }) });
  assert.equal(lost.length, 2);
  assert.match(lost[0], /^esbuild 0\.25\.1: its provenance attestation could not be looked up/);
  assert.match(lost[1], /^webtorrent 3\.0\.22: the release has no provenance attestation/);
  assert.equal(asked.includes('left-pad@2.0.0'), false, 'a package outside PROVENANCE_REQUIRED is not asked about');
  assert.deepEqual(await provenanceProblems({ before: {}, after: { webtorrent: '3.0.22' }, provenanceOf: async () => true }), []);
  assert.ok(PROVENANCE_REQUIRED.includes('webtorrent'));
  assert.deepEqual(lockVersions({ vendored: { 'webtorrent.min.js': { package: 'webtorrent', version: '3.0.21' } }, packages: { a: { version: '1.0.0' } } }), { webtorrent: '3.0.21', a: '1.0.0' });
});
