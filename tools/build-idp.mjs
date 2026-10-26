#!/usr/bin/env node
// tools/build-idp.mjs: builds the identity origin (IdO) bundle into dist-idp/ (R 2.1, N-1: a static bundle the
// project publishes, reproducible and hash-pinned; ARCHITECTURE 15.1). esbuild only, as build.mjs.
//
//   node tools/build-idp.mjs [--out dist-idp] [--no-minify] [--quiet] [--json]
//                            [--hub-suffix <suffix>]... [--shared-origin <origin>]...
//   node tools/build-idp.mjs --test --test-psl localhost [--test-psl <suffix>]...   (loopback test builds only)
//
// --hub-suffix <suffix> (code review v0.3, round 2): a single-operator hub whose labels may share one hub identity (src/idp/psl.js
// MW_HUB_SUFFIXES): only a suffix the operator runs alone and has on the Public Suffix List, never a shared platform suffix such as
// github.io. A normal build has none, so every hub gets per-site keys until its operator is listed. --shared-origin <origin>: a
// shared-origin hub (MW_SHARED_ORIGINS): keys there are for this visit only. Both are part of the build id.
//
// Outputs (below the output directory):
//   index.html, signin/index.html   src/idp/index.html with SRI on the script and the stylesheet and
//                                   <meta name="mw-idp-build" content="<version> <build id> <bundle sha256>">
//   idp.js                          the ES module bundle of src/idp/idp.js (the cards, the vault, the passkey, the QR codec)
//   idp.css                         src/idp/idp.css, minified
//   sw.js                           classic script of src/idp/sw.js with the build id and the precache list filled in
//   _headers                        CSP script-src 'self' 'wasm-unsafe-eval', frame-ancestors 'none', Referrer-Policy no-referrer
//   build.json                      version, build id, bundle sha256, file hashes, the QR codec's gzip size, test flags
//
// It prints the bundle sha256 (of idp.js) and the build id. --test-psl adds a suffix to the bundled Public Suffix
// List snapshot (src/idp/psl.js MW_TEST_PSL) so hub identity can be tested on loopback names; it is refused
// without --test, a test build goes to dist-idp-test/ by default, and its cards say "Test build".
// Details and measurements: docs/deviations/idp.md.

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

import { parseCli, runMain, isMain, ROOT, UsageError, ToolError, out } from './lib.mjs';
import { collectBundledPackages, checkPackages, LOCK_FILE } from '../build.mjs';

export const TARGETS = Object.freeze(['es2020', 'safari15.4', 'chrome110', 'firefox115']);
const MARKER = 'build.json';
export const PRECACHE = Object.freeze(['./', './index.html', './signin/', './signin/index.html', './idp.js', './idp.css']);

const USAGE = `
Usage: node tools/build-idp.mjs [--out <dir>] [--no-minify] [--quiet] [--json] [--test [--test-psl <suffix>]...]
                                [--hub-suffix <suffix>]... [--shared-origin <origin>]... [--hub-template <40-hex btih>]...
Builds the identity origin bundle (default dist-idp/, dist-idp-test/ for --test) and prints the bundle sha256 and
the build id. --test-psl <suffix> adds a Public Suffix List entry for loopback hub tests and needs --test.
--hub-suffix <suffix>: a single-operator hub (on the Public Suffix List, run by you alone) whose labels may share one
hub identity. --shared-origin <https origin>: a hub that serves many publishers on one origin (this visit only there).
--hub-template <btih>: the infohash of the hub operator's own page code (review round R 5.3, PHISH-1, HUB-3); the hub identity
goes only to pages that run one of these templates. Part of the build id.
`;

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sriFor(bytes) {
  return 'sha384-' + createHash('sha384').update(bytes).digest('base64');
}

/** computeBuildId(files) -> 12 hex characters from [{ path, sha256 }] (order does not matter). */
export function computeBuildId(files) {
  const lines = files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => f.path + '\0' + f.sha256 + '\n');
  return createHash('sha256').update(lines.join('')).digest('hex').slice(0, 12);
}

function checkSuffix(s) {
  if (typeof s !== 'string' || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(s)) {
    throw new UsageError('--test-psl takes a lowercase host suffix, got ' + JSON.stringify(s));
  }
  return s;
}

/** checkHubSuffix(s) -> s: a lowercase host suffix of at least two labels (a single-label TLD is never a hub suffix). */
export function checkHubSuffix(s) {
  if (typeof s !== 'string' || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(s) || s.length > 253) {
    throw new UsageError('--hub-suffix takes a lowercase host suffix of two or more labels, such as hub.example.org, got ' + JSON.stringify(s));
  }
  return s;
}

/** checkSharedOrigin(s, { test }) -> s: an exact https origin (an http loopback origin only in a test build). */
export function checkSharedOrigin(s, { test = false } = {}) {
  let u = null;
  try { u = new URL(String(s)); } catch (_) { u = null; }
  const loopback = u && u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].indexOf(u.hostname) >= 0;
  if (!u || u.origin !== s || !(u.protocol === 'https:' || (test && loopback)) || !/^[a-z0-9.:/-]{1,253}$/.test(s)) {
    throw new UsageError('--shared-origin takes an exact https origin such as https://demo.example.org (no path or trailing slash), got ' + JSON.stringify(s));
  }
  return s;
}

/** pageFor(html, { prefix, buildMeta, sriJs, sriCss }) -> the page with asset paths, SRI and the build meta. */
export function pageFor(html, { prefix, buildMeta, sriJs, sriCss }) {
  let outHtml = html;
  const swap = (re, replacement, what) => {
    if (!re.test(outHtml)) throw new Error('src/idp/index.html has no ' + what);
    outHtml = outHtml.replace(re, replacement);
  };
  swap(/<meta name="mw-idp-build" content="[^"]*">/, '<meta name="mw-idp-build" content="' + buildMeta + '">', 'mw-idp-build meta');
  swap(/<link rel="stylesheet" href="\.\/idp\.css">/, '<link rel="stylesheet" href="' + prefix + 'idp.css" integrity="' + sriCss + '">', 'stylesheet link');
  swap(/<script type="module" src="\.\/idp\.js"><\/script>/, '<script type="module" src="' + prefix + 'idp.js" integrity="' + sriJs + '"></script>', 'module script');
  return outHtml;
}

async function bundle(entry, { format, minify, define }) {
  const result = await esbuild.build({
    entryPoints: [entry], bundle: true, write: false, platform: 'browser', format, target: Array.from(TARGETS), minify,
    legalComments: 'none', charset: 'utf8', logLevel: 'silent', define: define || {}, metafile: true,
  });
  const inputs = result.metafile && result.metafile.inputs ? Object.keys(result.metafile.inputs) : [];
  return { bytes: Buffer.from(result.outputFiles[0].contents), warnings: result.warnings || [], inputs };
}

/**
 * checkIdpPackages(root, inputs) -> the npm packages the identity origin bundles, checked against build.lock.json like the
 * loader's (review round R 5.3, SUP-7): a bundled package that is not pinned, has another version or other bytes, or comes
 * from two directories fails the build. A pin the identity origin does not use is fine (the loader uses it).
 */
export function checkIdpPackages(root, inputs) {
  let packageLock = null;
  try { packageLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')); } catch (_) { packageLock = null; }
  const { packages, duplicates } = collectBundledPackages({ root, inputs, packageLock });
  let lock = null;
  try { lock = JSON.parse(readFileSync(join(root, LOCK_FILE), 'utf8')); } catch (_) { lock = null; }
  const { problems } = checkPackages(lock, packages, { duplicates });
  if (problems.length) throw new ToolError('the identity origin bundles packages that ' + LOCK_FILE + ' does not pin as found:\n  ' + problems.join('\n  '));
  return Object.keys(packages).sort();
}

/**
 * buildIdp(options) -> { outDir, buildId, bundleSha256, qrGzipBytes, files, test, testPsl, hubSuffixes, sharedOrigins, hubTemplates }
 * options: { root = repository, outDir, minify = true, test = false, testPsl = [], hubSuffixes = [], sharedOrigins = [], hubTemplates = [], quiet = false }
 */
export async function buildIdp(options = {}) {
  const o = Object.assign({ root: ROOT, minify: true, test: false, testPsl: [], hubSuffixes: [], sharedOrigins: [], hubTemplates: [], quiet: false }, options);
  const testPsl = Array.from(o.testPsl || []).map(checkSuffix);
  if (testPsl.length && o.test !== true) throw new UsageError('--test-psl is for loopback test builds only: add --test');
  const hubSuffixes = Array.from(new Set(Array.from(o.hubSuffixes || []).map(checkHubSuffix))).sort();
  const sharedOrigins = Array.from(new Set(Array.from(o.sharedOrigins || []).map((x) => checkSharedOrigin(x, { test: o.test === true })))).sort();
  const hubTemplates = Array.from(new Set(Array.from(o.hubTemplates || []).map((x) => {
    const b = String(x || '').trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(b)) throw new UsageError('--hub-template is a 40-hex infohash: ' + JSON.stringify(x));
    return b;
  }))).sort();
  const root = resolve(o.root);
  const outDir = o.outDir ? (isAbsolute(o.outDir) ? o.outDir : resolve(root, o.outDir)) : resolve(root, o.test ? 'dist-idp-test' : 'dist-idp');
  const say = o.quiet ? () => {} : (line) => out(line);
  const src = (rel) => join(root, 'src', 'idp', rel);
  const { IDP_VERSION } = await import(pathToFileURL(src('idp.js')).href);
  const define = o.test ? { MW_TEST_PSL: JSON.stringify(testPsl) } : {};
  if (hubSuffixes.length) define.MW_HUB_SUFFIXES = JSON.stringify(hubSuffixes);
  if (sharedOrigins.length) define.MW_SHARED_ORIGINS = JSON.stringify(sharedOrigins);
  if (hubTemplates.length) define.MW_HUB_TEMPLATES = JSON.stringify(hubTemplates);

  const js = await bundle(src('idp.js'), { format: 'esm', minify: o.minify, define });
  const sw = await bundle(src('sw.js'), { format: 'iife', minify: o.minify });
  const qr = await bundle(src('qr.js'), { format: 'esm', minify: true });
  const idpPackages = checkIdpPackages(root, [].concat(js.inputs, sw.inputs, qr.inputs));
  const css = Buffer.from(esbuild.transformSync(readFileSync(src('idp.css'), 'utf8'), { loader: 'css', minify: o.minify, target: Array.from(TARGETS), logLevel: 'silent', charset: 'utf8' }).code);
  const headers = readFileSync(src('_headers'));
  for (const w of js.warnings.concat(sw.warnings)) say('warning: ' + w.text);

  const bundleSha256 = sha256Hex(js.bytes);
  const pinned = [{ path: 'idp.js', sha256: bundleSha256 }, { path: 'idp.css', sha256: sha256Hex(css) }, { path: '_headers', sha256: sha256Hex(headers) }];
  if (o.test) pinned.push({ path: 'test-psl', sha256: sha256Hex(Buffer.from(JSON.stringify(testPsl))) });
  if (hubSuffixes.length) pinned.push({ path: 'hub-suffixes', sha256: sha256Hex(Buffer.from(JSON.stringify(hubSuffixes))) });
  if (sharedOrigins.length) pinned.push({ path: 'shared-origins', sha256: sha256Hex(Buffer.from(JSON.stringify(sharedOrigins))) });
  if (hubTemplates.length) pinned.push({ path: 'hub-templates', sha256: sha256Hex(Buffer.from(JSON.stringify(hubTemplates))) });
  const buildId = (o.test ? 'test-' : '') + computeBuildId(pinned);
  const buildMeta = IDP_VERSION + ' ' + buildId + ' ' + bundleSha256;
  const html = readFileSync(src('index.html'), 'utf8');
  const sriJs = sriFor(js.bytes);
  const sriCss = sriFor(css);
  const outputs = new Map();
  outputs.set('idp.js', js.bytes);
  outputs.set('idp.css', css);
  outputs.set('_headers', headers);
  outputs.set('index.html', Buffer.from(pageFor(html, { prefix: './', buildMeta, sriJs, sriCss })));
  outputs.set('signin/index.html', Buffer.from(pageFor(html, { prefix: '../', buildMeta, sriJs, sriCss })));
  let swCode = sw.bytes.toString('utf8');
  const buildRe = /\bself\.__MW_IDP_BUILD__\b/g;
  const listRe = /\bself\.__MW_IDP_PRECACHE__\b/g;
  if (!buildRe.test(swCode) || !listRe.test(swCode)) throw new Error('src/idp/sw.js lost its build placeholders');
  swCode = swCode.replace(buildRe, () => JSON.stringify(buildId)).replace(listRe, () => JSON.stringify(PRECACHE));
  outputs.set('sw.js', Buffer.from(swCode));
  const qrGzipBytes = gzipSync(qr.bytes, { level: 9 }).length;
  const files = Array.from(outputs.keys()).sort().map((path) => ({ path, bytes: outputs.get(path).length, sha256: sha256Hex(outputs.get(path)) }));
  const info = {
    name: 'magnet-web-idp', version: IDP_VERSION, buildId, bundleSha256, test: o.test === true, testPsl, hubSuffixes, sharedOrigins, hubTemplates,
    targets: Array.from(TARGETS), esbuild: esbuild.version, minified: Boolean(o.minify),
    qr: { minifiedBytes: qr.bytes.length, gzipBytes: qrGzipBytes }, precache: Array.from(PRECACHE), files,
  };
  outputs.set(MARKER, Buffer.from(JSON.stringify(info, null, 2) + '\n'));

  // Write next to outDir and swap it in (build.mjs does the same): a reader never sees a half-written bundle.
  if (existsSync(outDir) && readdirSync(outDir).length && !existsSync(join(outDir, MARKER))) {
    throw new Error('refusing to replace ' + outDir + ': it is not empty and has no ' + MARKER);
  }
  const tag = process.pid + '-' + Date.now().toString(36);
  const staging = outDir + '.build-' + tag;
  try {
    for (const [path, bytes] of outputs) {
      const target = join(staging, ...path.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
    renameSync(staging, outDir);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  say('built the identity origin into ' + outDir + (o.test ? ' (TEST BUILD, PSL additions: ' + testPsl.join(', ') + ')' : ''));
  say('npm packages in the bundles, checked against ' + LOCK_FILE + ': ' + (idpPackages.length ? idpPackages.join(', ') : 'none'));
  say('hub suffixes: ' + (hubSuffixes.length ? hubSuffixes.join(', ') : 'none (every hub gets per-site keys)') + '; shared origins: ' + (sharedOrigins.length ? sharedOrigins.join(', ') : 'none'));
  say('bundle sha256 ' + bundleSha256);
  say('build id ' + buildId);
  say('QR encoder and decoder: ' + qr.bytes.length + ' bytes minified, ' + qrGzipBytes + ' bytes gzip');
  for (const f of files) say('  ' + f.path.padEnd(20) + String(f.bytes).padStart(9) + ' bytes');
  return { outDir, buildId, bundleSha256, qrGzipBytes, files, test: o.test === true, testPsl, hubSuffixes, sharedOrigins, hubTemplates };
}

async function main(argv) {
  const { flags } = parseCli(argv, {
    out: { type: 'string' }, minify: { type: 'boolean', default: true }, quiet: { type: 'boolean' }, json: { type: 'boolean' },
    test: { type: 'boolean' }, 'test-psl': { type: 'list' }, 'hub-suffix': { type: 'list' }, 'shared-origin': { type: 'list' },
    'hub-template': { type: 'list' },
  });
  if (flags.help) {
    out(USAGE.trim());
    return 0;
  }
  const r = await buildIdp({
    outDir: flags.out || undefined, minify: flags.minify, test: flags.test, testPsl: flags.testPsl,
    hubSuffixes: flags.hubSuffix || [], sharedOrigins: flags.sharedOrigin || [], hubTemplates: flags.hubTemplate || [], quiet: flags.quiet || flags.json,
  });
  if (flags.json) out(JSON.stringify({ outDir: r.outDir, buildId: r.buildId, bundleSha256: r.bundleSha256, qrGzipBytes: r.qrGzipBytes, test: r.test, testPsl: r.testPsl, hubSuffixes: r.hubSuffixes, sharedOrigins: r.sharedOrigins, hubTemplates: r.hubTemplates }));
  return 0;
}

if (isMain(import.meta.url)) runMain(main, USAGE);
