// Unit tests for tools/lint-floor.mjs and tools/run-unit.mjs (ARCHITECTURE section 10:
// "npm test lints src/ against post-floor APIs"). Positive cases must be found, negative cases
// (comments, strings, divisions, guarded calls) must stay quiet, and src/ itself must be clean.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { lintSource, lintPaths, scanJs, RULES } from '../../tools/lint-floor.mjs';
import { unitTestFiles, isBrowserTest } from '../../tools/run-unit.mjs';
import { ROOT } from '../../tools/lib.mjs';

const work = mkdtempSync(join(tmpdir(), 'mw-rununit-test-'));
after(() => rmSync(work, { recursive: true, force: true }));

const ids = (text, file = 'src/x.js') => lintSource(text, file).map((f) => f.id);

test('positive: every post-floor API named in ARCHITECTURE section 10 is reported', () => {
  assert.deepEqual(ids('const d = Promise.withResolvers();'), ['Promise.withResolvers']);
  assert.deepEqual(ids('Object.groupBy(list, fn);'), ['Object.groupBy / Map.groupBy']);
  assert.deepEqual(ids('Map.groupBy(list, fn);'), ['Object.groupBy / Map.groupBy']);
  assert.deepEqual(ids('await Array.fromAsync(gen());'), ['Array.fromAsync']);
  for (const m of ['union', 'intersection', 'difference', 'symmetricDifference', 'isSubsetOf', 'isSupersetOf', 'isDisjointFrom']) {
    assert.deepEqual(ids('a.' + m + '(b);'), ['Set methods'], m);
  }
  assert.deepEqual(ids('const u = URL.parse(x);'), ['URL.parse']);
  assert.deepEqual(ids('const s = AbortSignal.any([a, b]);'), ['AbortSignal.any']);
  assert.deepEqual(ids('map.values().map((v) => v);'), ['iterator helpers']);
  assert.deepEqual(ids('set.entries().filter(Boolean);'), ['iterator helpers']);
  assert.deepEqual(ids('Iterator.from(x);'), ['iterator helpers']);
  assert.deepEqual(ids('const re = /[\\p{L}--[a-z]]/v;'), ['regex v flag']);
  assert.deepEqual(ids('const re = /abc/giv;'), ['regex v flag']);
  assert.deepEqual(ids("const re = new RegExp('a', 'v');"), ['regex v flag (RegExp)']);
});

test('positive: other syntax and APIs past Safari 15.4 / Chromium 110 / Firefox 115', () => {
  assert.deepEqual(ids('const re = /(?<=a)b/;'), ['regex lookbehind']);
  assert.deepEqual(ids('const re = /(?<!a)b/;'), ['regex lookbehind']);
  assert.deepEqual(ids("new RegExp('(?<=a)b');"), ['regex lookbehind']);
  assert.deepEqual(ids('a.toSorted();'), ['toSorted / toReversed / toSpliced']);
  assert.deepEqual(ids('class A { static { init(); } }'), ['class static block']);
  assert.deepEqual(ids('bytes.toHex();'), ['Uint8Array hex and base64']);
  assert.deepEqual(ids('Uint8Array.fromBase64(s);'), ['Uint8Array hex and base64']);
  assert.deepEqual(ids('buf.transfer();'), ['ArrayBuffer transfer / resize']);
  assert.deepEqual(ids('s.isWellFormed();'), ['isWellFormed / toWellFormed']);
  assert.deepEqual(ids('Promise.try(fn);'), ['Promise.try']);
  assert.deepEqual(ids('const c = structuredClone(x);'), ['structuredClone without a fallback']);
  assert.deepEqual(ids('<script type="importmap">{}</script>', 'src/x.html'), ['import maps']);
  assert.deepEqual(ids('.a:has(img) { color: red }', 'src/x.css'), ['CSS :has()']);
  assert.deepEqual(ids('@container (min-width: 10px) { a { b: c } }', 'src/x.css'), ['CSS container queries']);
  assert.deepEqual(ids('a { color: color-mix(in srgb, red, blue) }', 'src/x.css'), ['CSS color-mix / light-dark']);
});

test('reports file, line and column of each use', () => {
  const found = lintSource('const a = 1;\n\n  const { promise } = Promise.withResolvers();\n', 'src/loader/app.js');
  assert.equal(found.length, 1);
  assert.deepEqual([found[0].file, found[0].line, found[0].column], ['src/loader/app.js', 3, 23]);
  assert.match(found[0].why, /Chrome 119/);
  assert.match(found[0].fix, /new Promise/);
});

test('negative: comments, string contents and division are not code', () => {
  assert.deepEqual(ids('// Promise.withResolvers is past the floor\nconst a = 1;'), []);
  assert.deepEqual(ids('/* Object.groupBy(x) and AbortSignal.any */ const a = 1;'), []);
  assert.deepEqual(ids("const m = 'Promise.withResolvers is not available'; const n = \"URL.parse\";"), []);
  assert.deepEqual(ids('const t = `no Array.fromAsync here`;'), []);
  assert.deepEqual(ids('const q = a / b / c; const r = (a + b) / 2; const s = x.length / 2 / y;'), []);
  assert.deepEqual(ids('const re = /Promise.withResolvers/; const re2 = /a\\/b/g; x.replace(/ab+c/gi, "");'), []);
  assert.deepEqual(ids('const re = /[/]Object.groupBy[/]/;'), []);
  assert.deepEqual(ids('const ok = /(?:a)(?=b)(?<name>c)/u;'), [], 'lookahead and named groups are inside the floor');
  assert.deepEqual(ids('const x = Object.values(o).map(String); const y = Array.from(m.values()).map(f);'), []);
  assert.deepEqual(ids('const f = typeof structuredClone === "function" ? structuredClone(x) : JSON.parse(JSON.stringify(x));'), [], 'a guarded structuredClone is fine');
  assert.deepEqual(ids('const y = static_value; const staticBlock = 1;'), []);
  assert.deepEqual(ids('a { color: red } /* :has(x) is noted here */', 'src/x.css'), []);
  assert.deepEqual(ids('<!-- <script type="importmap"> --><p>hi</p>', 'src/x.html'), []);
});

test('code inside a template literal expression is still code', () => {
  assert.deepEqual(ids('const s = `value ${Promise.withResolvers()} text`;'), ['Promise.withResolvers']);
  assert.deepEqual(ids('const s = `value ${"Promise.withResolvers"} text`;'), []);
  assert.deepEqual(ids('const s = `a ${`b ${URL.parse(x)}`} c`;'), ['URL.parse']);
});

test('the lint-floor-ignore comments skip a guarded use', () => {
  assert.deepEqual(ids('const d = Promise.withResolvers(); // lint-floor-ignore: feature-detected above'), []);
  assert.deepEqual(ids('// lint-floor-ignore-next\nconst d = Promise.withResolvers();\nconst e = Promise.withResolvers();'), ['Promise.withResolvers']);
});

test('boot.js is exempt from the Uint8Array hex/base64 rule (it installs the polyfills), other files are not', () => {
  const code = "if (!Uint8Array.fromHex) {}\nconst v = Uint8Array.fromHex('00');";
  assert.deepEqual(ids(code, 'src/loader/boot.js'), []);
  assert.equal(ids(code, 'src/sw/core.js').length > 0, true);
});

test('scanJs keeps offsets and finds regex literals and RegExp calls', () => {
  const text = "const a = /x(?<=y)/gu;\nconst b = new RegExp('(?<!z)', 'u');\nconst c = 4 / 2;";
  const { code, regexes } = scanJs(text);
  assert.equal(code.length, text.length);
  assert.equal(code.split('\n').length, 3);
  assert.deepEqual(regexes.map((r) => [r.kind, r.flags]), [['literal', 'gu'], ['constructor', 'u']]);
});

test('every rule has an id, a reason and a fix', () => {
  const seen = new Set();
  for (const rule of RULES) {
    assert.ok(rule.id && rule.why && rule.fix, rule.id);
    assert.equal(seen.has(rule.id), false, 'unique id ' + rule.id);
    seen.add(rule.id);
  }
});

test('src/ is clean: no API or syntax past the browser floor', () => {
  const { findings, files } = lintPaths(['src'], { root: ROOT });
  assert.ok(files >= 30, 'scanned the source tree (' + files + ' files)');
  assert.deepEqual(findings.map((f) => f.file + ':' + f.line + ' ' + f.id), []);
});

test('run-unit: the unit list leaves out the browser tests and the browser list holds only them', () => {
  assert.equal(isBrowserTest('sw-browser.test.mjs'), true);
  assert.equal(isBrowserTest('loader-common-browser.test.mjs'), true);
  assert.equal(isBrowserTest('tools-build.test.mjs'), false);
  const unit = unitTestFiles().map((f) => f.split('/').pop());
  const browser = unitTestFiles({ browser: true }).map((f) => f.split('/').pop());
  assert.ok(unit.includes('tools-build.test.mjs') && unit.includes('common-pointer.test.mjs'));
  assert.equal(unit.some((n) => /-browser/.test(n)), false);
  assert.ok(browser.length >= 3 && browser.every((n) => /-browser/.test(n)));
  assert.equal(unit.some((n) => !n.endsWith('.test.mjs')), false, 'helpers such as chain-net-helpers.mjs are not run as tests');
});

test('run-unit: exit codes follow the tests, and a file that never exits is stopped by the watchdog', () => {
  const fixture = (name, body) => {
    const file = join(work, name + '.test.mjs');
    writeFileSync(file, "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n" + body);
    return file;
  };
  // inside `node --test`, NODE_TEST_CONTEXT would make the nested `node --test` act as a child reporter
  const env = Object.assign({}, process.env);
  delete env.NODE_TEST_CONTEXT;
  const run = (...args) => spawnSync(process.execPath, ['tools/run-unit.mjs', ...args], { cwd: ROOT, encoding: 'utf8', env });
  const pass = fixture('pass', "test('ok', () => assert.equal(1, 1));\n");
  const fail = fixture('fail', "test('broken', () => assert.equal(1, 2));\n");
  const hang = fixture('hang', "test('ok', () => assert.equal(1, 1));\nsetInterval(() => {}, 1000); // an open handle: the process never exits\n");
  assert.equal(run(pass).status, 0);
  assert.equal(run(fail).status, 1);
  const started = Date.now();
  const stopped = run('--total', '2500', hang);
  assert.equal(stopped.status, 1);
  assert.match(stopped.stderr, /a test file did not exit/);
  assert.ok(Date.now() - started < 20000, 'the watchdog fired');
  assert.equal(run('no-such-file.test.mjs').status, 2);
  const list = run('--list');
  assert.equal(list.status, 0);
  assert.ok(list.stdout.split('\n').filter(Boolean).every((f) => f.endsWith('.test.mjs') && !/-browser/.test(f)));
});

test('code review round 1: the APIs the floor review found missing are reported; guarded uses carry the ignore comment', () => {
  assert.deepEqual(ids('const s = new DecompressionStream("gzip");'), ['DecompressionStream / CompressionStream']);
  assert.deepEqual(ids('new CompressionStream("gzip");'), ['DecompressionStream / CompressionStream']);
  assert.deepEqual(ids('return Response.json({ a: 1 });'), ['Response.json (static)']);
  assert.deepEqual(ids('return await res.json();'), [], 'the instance method is fine');
  assert.deepEqual(ids('if (URL.canParse(x)) go();'), ['URL.canParse']);
  assert.deepEqual(ids('root.adoptedStyleSheets = [s];'), ['constructable stylesheets']);
  assert.deepEqual(ids('const s = new CSSStyleSheet(); s.replaceSync(css);').sort(), ['constructable stylesheets', 'constructable stylesheets']);
  assert.deepEqual(ids('const u8 = await res.bytes();'), ['Response / Blob .bytes()']);
  assert.deepEqual(ids('for await (const chunk of res.body) n++;'), ['for await over a stream']);
  assert.deepEqual(ids('for await (const x of gen()) n++;'), [], 'async generators are fine');
  assert.deepEqual(ids('if (navigator.userActivation.isActive) go();'), ['navigator.userActivation']);
  assert.deepEqual(ids('el.showPopover();'), ['popover']);
  assert.deepEqual(ids('const seg = new Intl.Segmenter("en");'), ['Intl.Segmenter']);
  assert.deepEqual(ids('if (el.checkVisibility()) go();'), ['Element.checkVisibility']);
  assert.deepEqual(ids('const b = a.with(0, 1);'), ['Array.prototype.with']);
  assert.deepEqual(ids('const u = import.meta.resolve("./x.js");'), ['import.meta.resolve']);
  assert.deepEqual(ids('const DS = win.DecompressionStream; // lint-floor-ignore: inflate.js otherwise'), []);
});

test('code review round 1: build.mjs lints the patched vendored bundle; only the polyfilled Uint8Array conversions are allowed', async () => {
  const { vendorFloorFindings, VENDOR_FLOOR_ALLOW } = await import('../../build.mjs');
  assert.deepEqual(VENDOR_FLOOR_ALLOW, ['Uint8Array hex and base64']);
  assert.deepEqual(vendorFloorFindings('const p=e=>e.toHex(),g=e=>Uint8Array.fromHex(e);'), [], 'boot.js and polyfills.js install these on windows');
  assert.deepEqual(vendorFloorFindings('const d=Promise.withResolvers();const s=new DecompressionStream("gzip");').map((f) => f.id), ['Promise.withResolvers', 'DecompressionStream / CompressionStream']);
  const { readFileSync } = await import('node:fs');
  const { applyVendorPatches } = await import('../../build.mjs');
  const vendored = readFileSync(join(ROOT, 'node_modules', 'webtorrent', 'dist', 'webtorrent.min.js'), 'utf8');
  assert.deepEqual(vendorFloorFindings(applyVendorPatches(vendored).code), [], 'the shipped bundle is within the floor');
});

// Code review v0.3 (browser lens): the post-floor APIs v0.3 depends on must stay feature-detected.
test('v0.3 APIs: an unguarded use is a finding; a typeof / in / && / ?. guard or a try on its line or the line before is not', () => {
  assert.deepEqual(ids("navigator.wakeLock.request('screen');"), ['navigator.wakeLock']);
  assert.deepEqual(ids('const c = new OffscreenCanvas(1, 1);'), ['OffscreenCanvas']);
  assert.deepEqual(ids("if (typeof navigator.wakeLock === 'object') navigator.wakeLock.request('screen');"), []);
  assert.deepEqual(ids("if ('wakeLock' in navigator) {\n  navigator.wakeLock.request('screen');\n}"), []);
  assert.deepEqual(ids("const c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');"), []);
  assert.deepEqual(ids("if (typeof OffscreenCanvas !== 'function') return null;\nconst c = new OffscreenCanvas(1, 1);"), []);
  // Too far from the guard: two lines down is a finding again.
  assert.deepEqual(ids("if (typeof OffscreenCanvas !== 'function') return null;\nconst a = 1;\nconst c = new OffscreenCanvas(1, 1);"), ['OffscreenCanvas']);
  const cases = [
    ['const caps = await PublicKeyCredential.getClientCapabilities();', 'PublicKeyCredential.getClientCapabilities',
      "if (typeof PublicKeyCredential.getClientCapabilities === 'function') caps = await PublicKeyCredential.getClientCapabilities();"],
    ['const out = ext.prf.results.first;', 'WebAuthn PRF results', 'const out = ext.prf && ext.prf.results ? ext.prf.results.first : null;'],
    ['const s = await navigator.mediaDevices.getDisplayMedia({ video: true });', 'getDisplayMedia',
      "if (typeof md.getDisplayMedia !== 'function') throw err;\nconst s = await md.getDisplayMedia({ video: true });"],
    ["const d = new BarcodeDetector({ formats: ['qr_code'] });", 'BarcodeDetector', "const d = typeof BarcodeDetector === 'function' ? new BarcodeDetector() : null;"],
    ['requestIdleCallback(run);', 'requestIdleCallback', "if (typeof win.requestIdleCallback === 'function') win.requestIdleCallback(run);"],
    ['const b = await navigator.getBattery();', 'navigator.getBattery', 'try {\n  const b = await navigator.getBattery();\n} catch (_) {}'],
    ['const t = navigator.connection.effectiveType;', 'navigator.connection', 'const c = nav.connection && typeof nav.connection === "object" ? nav.connection : null;'],
    ["navigator.mediaSession.setActionHandler('hangup', end);", 'Media Session actions beyond play and pause',
      "try {\n  navigator.mediaSession.setActionHandler('hangup', end);\n} catch (_) {}"],
    ["const b = await createImageBitmap(blob, { imageOrientation: 'from-image' });", 'createImageBitmap option values',
      "for (const args of [[{ imageOrientation: 'from-image' }], []]) {\n  try {\n    return await cib(blob, ...args);\n  } catch (_) {}\n}"],
  ];
  for (const [bad, id, good] of cases) {
    assert.deepEqual(ids(bad), [id], bad);
    assert.deepEqual(ids(good), [], good);
  }
  // play and pause are in every floor browser; a lint-floor-ignore still silences any use.
  assert.deepEqual(ids("navigator.mediaSession.setActionHandler('play', go);"), []);
  assert.deepEqual(ids("navigator.wakeLock.request('screen'); // lint-floor-ignore: the dock checks support first"), []);
  // Names inside strings and comments are not uses.
  assert.deepEqual(ids("// navigator.wakeLock.request('screen')\nconst s = 'new OffscreenCanvas(1, 1)';"), []);
  for (const id of ['navigator.wakeLock', 'OffscreenCanvas', 'getDisplayMedia', 'requestIdleCallback', 'navigator.connection']) {
    assert.ok(RULES.some((r) => r.id === id && Array.isArray(r.guard)), id);
  }
});
