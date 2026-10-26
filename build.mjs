#!/usr/bin/env node
// build.mjs: builds the static loader into dist/ (ARCHITECTURE section 10 and 13, DESIGN-REVIEW
// items 16, 20, S7). Node >= 22, esbuild only.
//
//   node build.mjs [--out dist] [--no-minify] [--update-lock] [--check-lock] [--strict] [--quiet]
//
// v0.3 (V03-DESIGN-REVIEW 2.19, MF-78): the lock pins every package the bundles take from node_modules (name, version, sha256 of the
// package's files, and the tarball integrity package-lock.json records), not only the vendored WebTorrent; a bundled package that is
// not pinned, or whose source changed, fails the build. The optional widget entries (src/widget/signin.js and chat-panel.js) are
// skipped with a warning while they, or a module they import, do not exist yet; --strict makes that an error (releases build strict).
//
// Outputs (all paths below dist/):
//   index.html, 404.html          src/loader/index.html with SRI on the two static script tags
//   mw-sw.js                      classic IIFE of src/sw/sw.js, BUILD_ID and PRECACHE filled in
//   mw-sw-kill.js                 the self-unregistering worker (src/sw/kill-switch.js)
//   _mw/boot.js                   classic IIFE built at target es5 (code review round 1: the es2017 wrapper
//                                 was an arrow function, so pre-ES2015 browsers never saw the unsupported
//                                 message; es5 also makes esbuild refuse any later syntax in the source)
//   _mw/loader.js, sdk.js, mw.js  ES modules (mw.js is skipped with a warning while src/dropin/mw.js is missing)
//   _mw/signin.js, chat-panel.js  v0.3: the self-hosted widgets of a drop-in site (skipped with a warning while missing); not precached,
//                                 but hash-checked by the worker when it serves them, and published with SRI by tools/publish.mjs
//   _mw/sw-core.js                classic IIFE of src/sw/core.js for a site's own Service Worker
//   _mw/sdk-static.js             v0.2.1 F7: the static /_mw/sdk.js stub (src/sdk/sdk-static.js) for places
//                                 without the runtime (crawler view, plain mirror, after a rollback)
//   _mw/pow-worker.js             classic IIFE of src/chain/pow-worker.js
//   _mw/webtorrent.min.js         the vendored bundle after three gates: build.lock.json (sha256 pin of the
//                                 stock file), the hash-asserted patches (v0.2.1 B3: the request headers; code
//                                 review round 1: no OPFS "chunks" cleanup at import, no FSA polyfill on host
//                                 globals; every patch point must match exactly once and the patched bytes must
//                                 equal the pinned patched sha256) and an esbuild syntax check at the browser floor
//   _mw/ui.css, manifest.webmanifest (no protocol_handlers in v1: code review round 1), icons/icon.svg
//   _mw/open.html                 v0.3 C2 doors (research/v03/S4-doors.md D4, D6): the door page, a copy of the shell whose manifest link
//                                 names the door manifest; it shows any site by its light link in the door view (precached)
//   _mw/door.webmanifest          the door manifest: protocol_handlers web+felinar -> /_mw/open.html#%s, share_target (GET) and
//                                 launch_handler. Only the door page links it; the site manifest (manifest.webmanifest) keeps none
//   _mw/door-frame.js             the door view's renderer (src/loader/doors.js frameMain), a classic IIFE the door page writes
//                                 into its sandboxed frame (precached and hash-checked like every loader script)
//   _mw/door.json                 per-file sha256, SRI and bytes of every other output, and the build id: what a door probe reads
//                                 and tools/check-site.mjs --door compares (written last; not precached, the worker never answers it)
//   build.json                    version, build id, target list, hashes (no timestamp: builds are reproducible)
//
// Targets: ['es2020', 'safari15.4', 'chrome110', 'firefox115'] (Safari/iOS 15.4, Chromium 110,
// Firefox 115 ESR). Service Workers and the PoW worker are classic scripts (module workers need
// Firefox 147+). A mismatch between build.lock.json and the vendored bundle fails the build.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

import { scanTags, walkFiles } from './tools/lib.mjs';
import { lintSource } from './tools/lint-floor.mjs';

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const TARGETS = Object.freeze(['es2020', 'safari15.4', 'chrome110', 'firefox115']);
/** The engines of the floor; the vendored bundle must run on them without syntax lowering. */
export const ENGINE_TARGETS = Object.freeze(['safari15.4', 'chrome110', 'firefox115']);
export const BOOT_TARGET = 'es5';
export const LOCK_FILE = 'build.lock.json';

/** Entry points: source file, output path under dist/, bundle format, options. */
export const ENTRIES = Object.freeze([
  { name: 'boot', in: 'src/loader/boot.js', out: '_mw/boot.js', format: 'iife', target: BOOT_TARGET },
  { name: 'loader', in: 'src/loader/app.js', out: '_mw/loader.js', format: 'esm' },
  { name: 'sdk', in: 'src/sdk/sdk.js', out: '_mw/sdk.js', format: 'esm' },
  { name: 'mw', in: 'src/dropin/mw.js', out: '_mw/mw.js', format: 'esm', optional: true },
  // v0.3 (R 2.3.6, 3.8): the sign-in widget and the chat panel, self-hosted by a drop-in site with SRI.
  { name: 'signin', in: 'src/widget/signin.js', out: '_mw/signin.js', format: 'esm', optional: true },
  { name: 'chat-panel', in: 'src/widget/chat-panel.js', out: '_mw/chat-panel.js', format: 'esm', optional: true },
  { name: 'sw-core', in: 'src/sw/core.js', out: '_mw/sw-core.js', format: 'iife', placeholders: true },
  { name: 'pow-worker', in: 'src/chain/pow-worker.js', out: '_mw/pow-worker.js', format: 'iife' },
  { name: 'sw', in: 'src/sw/sw.js', out: 'mw-sw.js', format: 'iife', placeholders: true },
  { name: 'sw-kill', in: 'src/sw/kill-switch.js', out: 'mw-sw-kill.js', format: 'iife' },
  // v0.2.1 F7: the static /_mw/sdk.js stub for places the runtime is not (publish copies it out).
  { name: 'sdk-static', in: 'src/sdk/sdk-static.js', out: '_mw/sdk-static.js', format: 'esm' },
  // v0.3 C2 doors: the door view's renderer, an entry made of one line (no source file of its own) that runs frameMain in the frame.
  { name: 'door-frame', in: 'src/loader/doors.js', out: '_mw/door-frame.js', format: 'iife', stdin: "import { frameMain } from './src/loader/doors.js';\nframeMain(self);\n" },
]);

/** v0.3 C2 doors: the door page, the door manifest and the door list, beside the loader (research/v03/S4-doors.md D4, D6, D7). */
export const DOOR_PAGE = '_mw/open.html';
export const DOOR_MANIFEST = '_mw/door.webmanifest';
export const DOOR_JSON = '_mw/door.json';

/** The static tags that carry SRI (the host is the trust root; SRI is defence in depth). */
export const SRI_TARGETS = Object.freeze(['/_mw/boot.js', '/_mw/loader.js']);

const MARKER = 'build.json';
/** Strings the vendored webtorrent bundle must contain (see checkMarkers). */
export const DEFAULT_MARKERS = Object.freeze(['_onMessageLength(']);

/**
 * v0.2.1 (DIGEST-AMENDMENTS B3): WebTorrent 3.0.21 sends Cache-Control and user-agent request headers on
 * every web-seed request (lib/webconn.js) and user-agent on the xs= metadata fetch (lib/torrent.js
 * _getMetadataFromServer) and on .torrent URLs (parse-torrent remote()). Both are not CORS-safelisted, so
 * every cross-origin request is preflighted, and 18 of 24 measured hosts fail that preflight; without the
 * two headers (cache: 'no-store' stays: it is a fetch option, not a header) 13 of 24 hosts work and
 * Chromium and WebKit send no preflight at all (RESEARCH-DIGEST P0-9, MIGRATION-DIGEST M07). Each patch
 * is an exact string of the minified 3.0.21 bundle that must occur exactly once; a new bundle that moves
 * a patch point fails the build instead of shipping the stock headers. Replaced by our own bundle later
 * (ROADMAP). The ids are recorded in build.lock.json and build.json.
 */
export const WEBTORRENT_PATCHES = Object.freeze([
  Object.freeze({
    id: 'webconn-request-headers',
    what: 'web-seed Range requests send only Range (no Cache-Control, no user-agent)',
    find: 'headers:{"Cache-Control":"no-store","user-agent":`WebTorrent/${cn} (https://webtorrent.io)`,range:`bytes=${i}-${s}`}',
    replace: 'headers:{range:`bytes=${i}-${s}`}',
  }),
  Object.freeze({
    id: 'xs-metadata-user-agent',
    what: 'the xs= .torrent fetch sends no user-agent header',
    find: 'const s={method:"GET",headers:{"user-agent":e.client.userAgent},signal:n}',
    replace: 'const s={method:"GET",signal:n}',
  }),
  Object.freeze({
    id: 'remote-torrent-user-agent',
    what: 'a .torrent URL given to client.add() is fetched without a user-agent header',
    find: '{headers:{"user-agent":"WebTorrent (https://webtorrent.io)"},signal:AbortSignal.timeout(3e4),...t}',
    replace: '{signal:AbortSignal.timeout(3e4),...t}',
  }),
  // Code review round 1: fsa-chunk-store's module-level cleanup ran at import on the site's own
  // origin (shell and drop-in) and recursively deleted any OPFS directory named "chunks" the site
  // keeps, with no rejection handler where OPFS is unavailable. We never use that store
  // (DESIGN-REVIEW 18: BlobChunkStore / MemoryChunkStore), so the statement goes.
  Object.freeze({
    id: 'opfs-chunks-cleanup',
    what: 'importing the bundle never touches the origin\'s OPFS (no removeEntry("chunks"))',
    find: 'globalThis.navigator?.storage?.getDirectory&&navigator.storage.getDirectory().then(e=>{e.removeEntry("chunks",{recursive:!0}).catch(()=>{})});',
    replace: 'void 0;',
  }),
  // ... and its createWritable polyfill patched host globals on drop-in pages
  // (FileSystemFileHandle.prototype.createWritable through a blob: module Worker,
  // FileSystemDirectoryHandle.prototype.getFileHandle, globalThis.FileSystemWritableFileStream): the
  // guard of that block is now false, so no global is ever replaced.
  Object.freeze({
    id: 'fsa-createwritable-polyfill',
    what: 'the bundle never patches FileSystemFileHandle, FileSystemDirectoryHandle or FileSystemWritableFileStream',
    find: '!globalThis.FileSystemFileHandle||globalThis.FileSystemFileHandle.prototype.createWritable||globalThis.FileSystemWritableFileStream||(globalThis.FileSystemWritableFileStream=Rt),globalThis.FileSystemFileHandle&&!globalThis.FileSystemFileHandle.prototype.createWritable){',
    replace: '!1){',
  }),
]);

// ---------------------------------------------------------------------------------------------
// pure helpers (unit tested)
// ---------------------------------------------------------------------------------------------

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Subresource Integrity value: 'sha384-' + base64(sha384(bytes)). */
export function sriFor(bytes) {
  return 'sha384-' + createHash('sha384').update(bytes).digest('base64');
}

/**
 * computeBuildId(files) → 12 hex characters from [{ path, sha256 }] (order does not matter): the same
 * inputs give the same id, any changed byte gives a new one. The Service Worker files are left out
 * by the caller, because they contain the id.
 */
export function computeBuildId(files) {
  const lines = files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => f.path + '\0' + f.sha256 + '\n');
  return createHash('sha256').update(lines.join('')).digest('hex').slice(0, 12);
}

/**
 * precacheList(paths) → the same-origin paths the Service Worker caches at install: /index.html
 * and every /_mw/ file except webtorrent.min.js (cached on first fetch) and the static SDK stub
 * sdk-static.js (v0.2.1 F7: it is for places without the runtime). `paths` are dist-relative.
 */
export function precacheList(paths) {
  const list = ['/index.html'];
  for (const p of paths.slice().sort()) {
    if (!p.startsWith('_mw/')) continue;
    // v0.3 C2 doors: _mw/door.json answers a probe of this address, so it always comes from the network.
    if (p === '_mw/webtorrent.min.js' || p === '_mw/sdk-static.js' || p === DOOR_JSON || WIDGET_FILES.includes(p)) continue;
    list.push('/' + p);
  }
  return list;
}

/** The optional drop-in widgets (v0.3): not part of the loader's install set, hash-checked by the worker when it serves them. */
export const WIDGET_FILES = Object.freeze(['_mw/signin.js', '_mw/chat-panel.js']);

/**
 * applyPlaceholders(code, { buildId, precache, integrity }) → code with every `self.__BUILD_ID__` replaced by
 * the JSON string of the build id and every `self.__PRECACHE__` by the JSON array. Throws when the
 * bundle contains neither (the Service Worker would silently run as 'dev'). v0.2.1 D2: every
 * `self.__INTEGRITY__` becomes the JSON object { path: 'sha384-...' } (or null when none is given);
 * when `integrity` is given the bundle must contain the placeholder.
 */
export function applyPlaceholders(code, { buildId, precache, integrity = undefined }) {
  if (typeof buildId !== 'string' || !/^[0-9a-z-]{4,64}$/.test(buildId)) throw new Error('applyPlaceholders: invalid build id ' + JSON.stringify(buildId));
  if (!Array.isArray(precache) || precache.some((p) => typeof p !== 'string' || !p.startsWith('/'))) throw new Error('applyPlaceholders: precache must be a list of absolute paths');
  const idRe = /\bself\.__BUILD_ID__\b/g;
  const pcRe = /\bself\.__PRECACHE__\b/g;
  if (!idRe.test(code)) throw new Error('applyPlaceholders: no self.__BUILD_ID__ in the bundle');
  if (!pcRe.test(code)) throw new Error('applyPlaceholders: no self.__PRECACHE__ in the bundle');
  const id = JSON.stringify(buildId);
  const list = JSON.stringify(precache);
  const intRe = /\bself\.__INTEGRITY__\b/g;
  if (integrity !== undefined) {
    if (integrity !== null && (typeof integrity !== 'object' || Object.keys(integrity).some((k) => !k.startsWith('/') || !/^sha(256|384|512)-/.test(String(integrity[k]))))) {
      throw new Error('applyPlaceholders: integrity must map absolute paths to sha256-/sha384-/sha512- values');
    }
    if (!intRe.test(code)) throw new Error('applyPlaceholders: no self.__INTEGRITY__ in the bundle');
  }
  const map = JSON.stringify(integrity === undefined ? null : integrity);
  return code.replace(/\bself\.__BUILD_ID__\b/g, () => id).replace(/\bself\.__PRECACHE__\b/g, () => list).replace(/\bself\.__INTEGRITY__\b/g, () => map);
}

/**
 * integrityMap(outputs, precache) → { '/path': 'sha384-...' } for the JS and CSS of the precache list
 * (v0.2.1 D2: the critical set of the Service Worker's atomic install; HTML stays best-effort because
 * some hosts rewrite it). `outputs` maps dist-relative paths to their final bytes.
 */
export function integrityMap(outputs, precache, { extra = CHECKED_ON_FETCH } = {}) {
  const map = {};
  for (const path of precache) {
    if (!/\.(m?js|css)$/i.test(path)) continue;
    const bytes = outputs.get(path.slice(1));
    if (!bytes) throw new Error('integrityMap: ' + path + ' is in the precache list but was not built');
    map[path] = sriFor(bytes);
  }
  // Code review round 1: files outside the precache that the worker checks when it first fetches them.
  for (const path of extra) {
    const bytes = outputs.get(path.slice(1));
    if (bytes) map[path] = sriFor(bytes);
  }
  return map;
}

/** Loader assets left out of the precache but hash-checked by the worker on first fetch (code review round 1; v0.3: the widgets). */
export const CHECKED_ON_FETCH = Object.freeze(['/_mw/webtorrent.min.js', '/_mw/signin.js', '/_mw/chat-panel.js']);

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * applySri(html, { '/_mw/boot.js': 'sha384-...', ... }) → html with integrity="..." and
 * crossorigin="anonymous" on the <script src> or <link href> tag of each path (an existing integrity
 * or crossorigin attribute is replaced). Throws when a path has no tag.
 */
export function applySri(html, map) {
  const tags = scanTags(html);
  const edits = [];
  for (const path of Object.keys(map)) {
    const hits = tags.filter((t) => (t.name === 'script' && t.attrs.get('src') === path) || (t.name === 'link' && t.attrs.get('href') === path));
    if (hits.length === 0) throw new Error('applySri: index.html has no <script src="' + path + '"> or <link href="' + path + '"> tag');
    for (const tag of hits) edits.push({ tag, integrity: map[path] });
  }
  edits.sort((a, b) => b.tag.start - a.tag.start);
  let out = html;
  for (const { tag, integrity } of edits) {
    let text = out.slice(tag.start, tag.end);
    text = text.replace(/\s+integrity\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, '').replace(/\s+crossorigin(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/i, '');
    const selfClosing = text.endsWith('/>');
    const body = text.slice(0, text.length - (selfClosing ? 2 : 1)).replace(/\s+$/, '');
    text = body + ' integrity="' + escapeHtml(integrity) + '" crossorigin="anonymous"' + (selfClosing ? ' />' : '>');
    out = out.slice(0, tag.start) + text + out.slice(tag.end);
  }
  return out;
}

/**
 * checkLock(lock, { name, bytes, version }) → { ok, expected, actual, message }
 * lock = the parsed build.lock.json; the entry `lock.vendored[name]` pins the sha256 (and the package
 * version) of a vendored file. The message says what to do either way.
 */
export function checkLock(lock, { name, bytes, version = null }) {
  const entry = lock && lock.vendored && lock.vendored[name];
  const actual = sha256Hex(bytes);
  if (!entry || typeof entry.sha256 !== 'string') {
    return { ok: false, expected: null, actual, message: LOCK_FILE + ' has no entry for ' + name + '. Review the bundle, then pin it with: node build.mjs --update-lock' };
  }
  if (entry.sha256 === actual && (version === null || !entry.version || entry.version === version)) {
    return { ok: true, expected: entry.sha256, actual, message: name + ' matches ' + LOCK_FILE + ' (sha256 ' + actual.slice(0, 16) + '...)' };
  }
  const lines = [
    LOCK_FILE + ': the vendored ' + name + ' does not match the pinned sha256.',
    '  pinned  ' + entry.sha256 + (entry.version ? '  (' + (entry.package || name) + ' ' + entry.version + ')' : ''),
    '  actual  ' + actual + (version ? '  (' + (entry.package || name) + ' ' + version + ')' : ''),
  ];
  if (entry.sha256 !== actual) {
    lines.push('If you upgraded the package on purpose: read its changelog and diff the bundle, then run: node build.mjs --update-lock',
      'If you did not: node_modules was changed after install (supply chain). Delete node_modules and run: npm ci');
  } else {
    lines.push('The bytes match but the package version differs; if that is intended, run: node build.mjs --update-lock');
  }
  return { ok: false, expected: entry.sha256, actual, message: lines.join('\n') };
}

/**
 * checkMarkers(code, markers) → { ok, missing }: strings the vendored bundle must still contain because our
 * code depends on them. src/loader/torrent.js wraps `wire._onMessageLength` to cap peer messages at 256 KiB
 * (ARCHITECTURE section 13); a webtorrent release that renames it would turn the cap off without any error.
 */
export function checkMarkers(code, markers) {
  const missing = (Array.isArray(markers) ? markers : []).filter((m) => typeof m === 'string' && code.indexOf(m) < 0);
  return { ok: missing.length === 0, missing };
}

/**
 * syntaxGate(code, { esbuild, targets, engines }) → { ok, problems }
 * Two checks on a file that is copied to dist unchanged: (1) it parses at the full target list
 * (esbuild reports syntax it cannot lower, such as top-level await at es2020); (2) at the engine
 * targets alone esbuild changes nothing, so the browsers of the floor run the file as it is. A
 * bundle that needs lowering for Safari 15.4 (class static blocks, say) fails the build.
 */
export function syntaxGate(code, { esbuild: es = esbuild, targets = TARGETS, engines = ENGINE_TARGETS } = {}) {
  const problems = [];
  try {
    es.transformSync(code, { loader: 'js', format: 'esm', target: Array.from(targets), logLevel: 'silent' });
  } catch (err) {
    const first = err && err.errors && err.errors[0];
    problems.push('does not parse at ' + targets.join(', ') + ': ' + (first ? first.text + (first.location ? ' (line ' + first.location.line + ')' : '') : err.message));
    return { ok: false, problems };
  }
  try {
    const modern = es.transformSync(code, { loader: 'js', format: 'esm', target: 'esnext', minify: true, logLevel: 'silent' }).code;
    const floor = es.transformSync(code, { loader: 'js', format: 'esm', target: Array.from(engines), minify: true, logLevel: 'silent' }).code;
    if (modern !== floor) problems.push('uses syntax that needs lowering for ' + engines.join(', ') + ' (it is copied unchanged, so those browsers would fail to parse it)');
  } catch (err) {
    problems.push('syntax check failed: ' + err.message);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * The lint-floor rules the vendored bundle may break, because the page installs the API before the bundle
 * loads: boot.js (shell) and src/dropin/polyfills.js (drop-in) polyfill the Uint8Array hex and base64
 * conversions on windows, and the bundle runs only in windows (code review round 1).
 */
export const VENDOR_FLOOR_ALLOW = Object.freeze(['Uint8Array hex and base64']);

/**
 * vendorFloorFindings(code) → lint-floor findings of the vendored bundle outside VENDOR_FLOOR_ALLOW (code
 * review round 1: the bundle used to be copied with a syntax gate only, so a webtorrent upgrade that calls
 * a post-floor API would ship).
 */
export function vendorFloorFindings(code, { allow = VENDOR_FLOOR_ALLOW } = {}) {
  return lintSource(code, '_mw/webtorrent.min.js').filter((f) => !allow.includes(f.id));
}

/**
 * applyVendorPatches(code, patches) → { code, applied: [id] }. Every patch's `find` must occur exactly once in
 * the input (zero: the bundle changed and the patch point moved; two or more: the patch would be ambiguous);
 * otherwise it throws and names the patch, so the build fails instead of shipping an unpatched bundle.
 */
export function applyVendorPatches(code, patches = WEBTORRENT_PATCHES) {
  let out = String(code);
  const applied = [];
  for (const p of patches) {
    const count = out.split(p.find).length - 1;
    if (count !== 1) {
      throw new Error('the vendored webtorrent.min.js patch point "' + p.id + '" (' + p.what + ') matches ' + count + ' times, expected exactly once. ' +
        'The bundle changed: review the new lib/webconn.js, lib/torrent.js and parse-torrent sources, update WEBTORRENT_PATCHES in build.mjs, then run node build.mjs --update-lock.');
    }
    out = out.replace(p.find, () => p.replace);
    applied.push(p.id);
  }
  return { code: out, applied };
}

/**
 * checkPatchedLock(lock, { name, bytes, applied }) → { ok, message }: build.lock.json pins the sha256 of the
 * patched bundle too (vendored[name].patched.sha256), so a change to WEBTORRENT_PATCHES or to the patch
 * output is a reviewed change (--update-lock), never a silent one.
 */
export function checkPatchedLock(lock, { name, bytes, applied }) {
  const entry = lock && lock.vendored && lock.vendored[name];
  const pinned = entry && entry.patched;
  const actual = sha256Hex(bytes);
  if (!pinned || typeof pinned.sha256 !== 'string') {
    return { ok: false, actual, message: LOCK_FILE + ' does not pin the patched ' + name + ' (vendored.' + name + '.patched.sha256). Review the patch output, then run: node build.mjs --update-lock' };
  }
  const ids = Array.isArray(pinned.patches) ? pinned.patches : [];
  if (pinned.sha256 !== actual || ids.join(',') !== applied.join(',')) {
    return {
      ok: false,
      actual,
      message: [
        LOCK_FILE + ': the patched ' + name + ' does not match the pin.',
        '  pinned  ' + pinned.sha256 + '  (' + ids.join(', ') + ')',
        '  actual  ' + actual + '  (' + applied.join(', ') + ')',
        'The patch list or the patch output changed. Review it, then run: node build.mjs --update-lock',
      ].join('\n'),
    };
  }
  return { ok: true, actual, message: name + ' patched (' + applied.join(', ') + '), sha256 ' + actual.slice(0, 16) + '...' };
}

// ---------------------------------------------------------------------------------------------
// bundled packages (v0.3, MF-78): every package the bundles take from node_modules is pinned
// ---------------------------------------------------------------------------------------------

/** The two-person rule, stated in the lock header (R 2.19, SC-2): a change to this file is reviewed by a second person. */
export const LOCK_REVIEW = 'Two people review every change to this file. The pull request that changes it needs the approval of a code owner who did not write it (.github/CODEOWNERS), ' +
  'and that reviewer compares the new package source with its upstream release before approving (V03-DESIGN-REVIEW 2.19, SC-2). Nobody runs --update-lock and merges alone.';

/**
 * packageOfInput(path) → { name, dir } | null for an esbuild metafile input path: the innermost package under a node_modules directory
 * ('node_modules/@scope/name/lib/x.js' → name '@scope/name', dir 'node_modules/@scope/name'). Paths are relative to the build root
 * (they may start with '../' for a tree outside it). null for source files.
 */
export function packageOfInput(path) {
  const parts = String(path).split('/');
  const at = parts.lastIndexOf('node_modules');
  if (at < 0 || at + 1 >= parts.length) return null;
  const scoped = parts[at + 1].startsWith('@');
  const take = scoped ? 2 : 1;
  if (at + take >= parts.length) return null;
  const name = parts.slice(at + 1, at + 1 + take).join('/');
  return { name, dir: parts.slice(0, at + 1 + take).join('/') };
}

/**
 * hashPackageDir(dir) → { sha256, files }: sha256 over the sorted lines "<path>\0<sha256 of the file>\n" of every regular file of the
 * package, the nested node_modules left out. Symbolic links are not followed (and not counted).
 */
export function hashPackageDir(dir) {
  const files = walkFiles(dir, { skip: (rel, isDir) => (isDir && rel.split('/').pop() === 'node_modules' ? 'nested node_modules' : null) });
  const lines = files.map((f) => f.path + '\0' + sha256Hex(readFileSync(f.abs)) + '\n');
  return { sha256: createHash('sha256').update(lines.join('')).digest('hex'), files: files.length };
}

/**
 * collectBundledPackages({ root, inputs, packageLock }) → { packages, duplicates }
 * packages = { name: { version, files, sha256, integrity, resolved } } for every package a bundle took files from. integrity and
 * resolved come from package-lock.json (the tarball's sha512 SRI), null when the lockfile has no entry. duplicates lists names
 * bundled from two different directories.
 */
export function collectBundledPackages({ root, inputs, packageLock = null }) {
  const dirs = new Map();
  for (const input of inputs) {
    const p = packageOfInput(input);
    if (!p) continue;
    const abs = resolve(root, p.dir);
    if (!dirs.has(abs)) dirs.set(abs, Object.assign({ abs }, p));
  }
  const packages = {};
  const duplicates = [];
  for (const d of Array.from(dirs.values()).sort((a, b) => (a.abs < b.abs ? -1 : 1))) {
    let version = null;
    try {
      version = JSON.parse(readFileSync(join(d.abs, 'package.json'), 'utf8')).version || null;
    } catch (_) { /* reported by the pin check: no version */ }
    const { sha256, files } = hashPackageDir(d.abs);
    const entry = packageLock && packageLock.packages && !d.dir.startsWith('..') ? packageLock.packages[d.dir] : null;
    if (Object.prototype.hasOwnProperty.call(packages, d.name)) {
      duplicates.push(d.name);
      continue;
    }
    packages[d.name] = { version, files, sha256, integrity: entry && entry.integrity ? entry.integrity : null, resolved: entry && entry.resolved ? entry.resolved : null };
  }
  return { packages, duplicates };
}

/** orderedLock(lock) → the lock with its header first (v, note, review), then vendored, packages and anything else. */
export function orderedLock(lock) {
  const head = ['v', 'note', 'review', 'vendored', 'packages'];
  const result = {};
  for (const k of head) if (lock && Object.prototype.hasOwnProperty.call(lock, k)) result[k] = lock[k];
  for (const k of Object.keys(lock || {})) if (head.indexOf(k) < 0) result[k] = lock[k];
  return result;
}

/**
 * Packages whose releases carry an npm provenance attestation (docs/research/w2b-05-security-hardening-prod.md, F35). A hijacked
 * maintainer account publishes from a laptop, so the hostile release has none: --update-lock refuses a new version of one of these
 * without it unless --accept-no-provenance is given (review round SUP-11, SC-2).
 */
export const PROVENANCE_REQUIRED = Object.freeze(['webtorrent', 'bittorrent-protocol', 'bittorrent-tracker', 'create-torrent', 'parse-torrent', 'magnet-uri', 'esbuild']);

/**
 * npmProvenance(name, version) → true | false | null: whether the registry lists a provenance attestation for that release (npm view
 * <name>@<version> dist.attestations). null when the registry could not be asked. Only --update-lock calls it.
 */
export function npmProvenance(name, version) {
  try {
    const text = execFileSync('npm', ['view', name + '@' + version, 'dist.attestations', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 }).trim();
    if (!text) return false;
    const att = JSON.parse(text);
    return Boolean(att && typeof att === 'object' && (att.provenance || att.url));
  } catch (_) {
    return null;
  }
}

/**
 * provenanceProblems({ before, after, required, provenanceOf }) → Promise<[problem]>. before and after map a package name to its version
 * (the lock as it was, and what --update-lock would write). A package of `required` whose version changed and whose new release has no
 * provenance attestation, or whose attestation could not be looked up, is a problem.
 */
export async function provenanceProblems({ before = {}, after = {}, required = PROVENANCE_REQUIRED, provenanceOf = npmProvenance } = {}) {
  const problems = [];
  for (const name of Object.keys(after).sort()) {
    if (required.indexOf(name) < 0 || !after[name] || before[name] === after[name]) continue;
    const has = await provenanceOf(name, after[name]);
    if (has === true) continue;
    problems.push(name + ' ' + after[name] + (has === null ? ': its provenance attestation could not be looked up (npm view ' + name + '@' + after[name] + ' dist.attestations)'
      : ': the release has no provenance attestation, although ' + name + ' releases carry one (a release published from outside its CI is what a hijacked account looks like)'));
  }
  return problems;
}

/** lockVersions(lock) → { name: version } of the vendored bundle and every pinned package. */
export function lockVersions(lock) {
  const out = {};
  const vendored = lock && lock.vendored && lock.vendored['webtorrent.min.js'];
  if (vendored && vendored.package) out[vendored.package] = vendored.version || null;
  const packages = lock && lock.packages && typeof lock.packages === 'object' ? lock.packages : {};
  for (const name of Object.keys(packages)) out[name] = packages[name] && packages[name].version ? packages[name].version : null;
  return out;
}

async function guardProvenance(o, before, after) {
  const problems = await provenanceProblems({ before, after, provenanceOf: o.provenanceOf || npmProvenance });
  if (!problems.length) return;
  if (o.acceptNoProvenance) {
    for (const p of problems) process.stderr.write('warning: --accept-no-provenance: ' + p + '\n');
    return;
  }
  throw new Error('refusing --update-lock: ' + problems.join('; ') + '. Compare the release with its upstream source first; --accept-no-provenance pins it anyway (and the second reviewer must see why).');
}

/** lockEntriesFor(found) → the `packages` section of the lock (names sorted). */
export function lockEntriesFor(found) {
  const out = {};
  for (const name of Object.keys(found).sort()) out[name] = Object.assign({}, found[name]);
  return out;
}

/**
 * checkPackages(lock, found, { duplicates }) → { ok, problems, warnings, message }
 * Every bundled package must be pinned with the same version and the same source sha256 (and the same tarball integrity when both the
 * lock and package-lock.json have one). A package pinned but no longer bundled is a warning (--update-lock drops the pin).
 */
export function checkPackages(lock, found, { duplicates = [] } = {}) {
  const pinned = lock && lock.packages && typeof lock.packages === 'object' ? lock.packages : {};
  const problems = [];
  const warnings = [];
  for (const name of duplicates) problems.push(name + ' is bundled from two different directories (two versions); make the dependency tree use one');
  for (const name of Object.keys(found).sort()) {
    const f = found[name];
    const p = pinned[name];
    if (!p) {
      problems.push(name + '@' + f.version + ' is bundled but not pinned in ' + LOCK_FILE + ' (source sha256 ' + f.sha256 + ')');
      continue;
    }
    if (p.version !== f.version) problems.push(name + ': version ' + f.version + ' differs from the pinned ' + p.version);
    if (p.sha256 !== f.sha256) problems.push(name + ': the source in node_modules differs from the pin (pinned ' + p.sha256 + ', actual ' + f.sha256 + ')');
    if (p.integrity && f.integrity && p.integrity !== f.integrity) problems.push(name + ': the tarball integrity in package-lock.json differs from the pin (' + f.integrity.slice(0, 24) + '... against ' + p.integrity.slice(0, 24) + '...)');
  }
  for (const name of Object.keys(pinned).sort()) {
    if (!Object.prototype.hasOwnProperty.call(found, name)) warnings.push(name + ' is pinned in ' + LOCK_FILE + ' but no bundle uses it any more; node build.mjs --update-lock removes the pin');
  }
  const ok = problems.length === 0;
  const message = ok ? Object.keys(found).length + ' bundled package(s) match ' + LOCK_FILE : [
    LOCK_FILE + ': the packages the bundles take from node_modules do not match the lock.',
    ...problems.map((p) => '  ' + p),
    'If you added or upgraded a package on purpose: read its changes against the upstream release, then run: node build.mjs --update-lock (a second person reviews the lock change).',
    'If you did not: node_modules was changed after install (supply chain). Delete node_modules and run: npm ci --ignore-scripts',
  ].join('\n');
  return { ok, problems, warnings, message };
}

const ICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="felinar">',
  '  <rect width="64" height="64" rx="14" fill="#101318"/>',
  '  <path d="M18 14v20a14 14 0 0 0 28 0V14h-9v20a5 5 0 0 1-10 0V14z" fill="#e8ebf0"/>',
  '  <rect x="18" y="14" width="9" height="9" fill="#e5484d"/>',
  '  <rect x="37" y="14" width="9" height="9" fill="#3b82f6"/>',
  '</svg>',
  '',
].join('\n');

/**
 * The web app manifest. Code review round 1: no protocol_handlers. DESIGN-REVIEW section 3 keeps the
 * magnet: handler for later ("not advertised in v1"), and in per-domain mode ?mw= is ignored, so an
 * installed site would claim magnet links and then show only itself.
 */
export function manifestJson(version) {
  return JSON.stringify({
    name: 'felinar',
    short_name: 'felinar',
    description: 'felinar: websites loaded by magnet link, verified in your browser, from a plain static host. No backend. The light web.',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f6f7f9',
    theme_color: '#f6f7f9',
    icons: [{ src: '/_mw/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  }, null, 2) + '\n';
}

/**
 * doorManifestJson(version) → the door manifest (v0.3 C2 doors, S4 D6; code review round 1 kept protocol handlers out of the site
 * manifest, and they stay out of it): a separate app (id /_mw/open.html, scope /_mw/) that takes web+felinar: links to
 * /_mw/open.html#%s (desktop Chromium 96+ after a permission dialog; Safari, iOS and Android browsers have no such handler), a GET
 * share target to the same page (?mw=<url>&mwtext=<text>) and launch_handler navigate-existing. Nothing it receives loads before
 * the visitor's click (the gate, C3).
 */
export function doorManifestJson(version) {
  return JSON.stringify({
    name: 'felinar door',
    short_name: 'door',
    description: 'Opens a site by its link, in a limited view that stores nothing for it. Version ' + version + '.',
    id: '/_mw/open.html',
    start_url: '/_mw/open.html',
    scope: '/_mw/',
    display: 'standalone',
    background_color: '#f6f7f9',
    theme_color: '#f6f7f9',
    icons: [{ src: '/_mw/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
    protocol_handlers: [{ protocol: 'web+felinar', url: '/_mw/open.html#%s' }],
    share_target: { action: '/_mw/open.html', method: 'GET', params: { url: 'mw', text: 'mwtext' } },
    launch_handler: { client_mode: 'navigate-existing' },
  }, null, 2) + '\n';
}

/**
 * doorPageHtml(shellHtml) → the door page: the shell (with its SRI) whose manifest link names the door manifest. Throws when the
 * shell has no <link rel="manifest" href="/_mw/manifest.webmanifest">.
 */
export function doorPageHtml(shellHtml) {
  const from = '<link rel="manifest" href="/_mw/manifest.webmanifest">';
  if (String(shellHtml).split(from).length !== 2) throw new Error('doorPageHtml: the shell must link /_mw/manifest.webmanifest exactly once');
  return String(shellHtml).replace(from, '<link rel="manifest" href="/' + DOOR_MANIFEST + '">');
}

/**
 * doorJson(outputs, { version, buildId }) → the bytes of _mw/door.json: { v: 1, kind: 'felinar-door', name, version, buildId, page,
 * files: { '/<path>': { bytes, sha256, sri } } } for every output except door.json and build.json, sorted by path.
 */
export function doorJson(outputs, { version, buildId }) {
  const files = {};
  for (const path of Array.from(outputs.keys()).sort()) {
    if (path === DOOR_JSON || path === MARKER) continue;
    const bytes = outputs.get(path);
    files['/' + path] = { bytes: bytes.length, sha256: sha256Hex(bytes), sri: sriFor(bytes) };
  }
  return Buffer.from(JSON.stringify({ v: 1, kind: 'felinar-door', name: 'felinar', version, buildId, page: '/' + DOOR_PAGE, files }, null, 2) + '\n');
}

// ---------------------------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------------------------

function readLock(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(file + ' is not valid JSON: ' + err.message);
  }
}

function vendoredSource(root) {
  const dir = join(root, 'node_modules', 'webtorrent');
  const file = join(dir, 'dist', 'webtorrent.min.js');
  let version = null;
  try {
    version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version || null;
  } catch (_) { /* not installed: reported below */ }
  return { file, version };
}

/**
 * unresolvedLocalImports(errors, root) → [path] | null: when every esbuild error is `Could not resolve "<relative path>"` for a file
 * that does not exist, the relative paths (root-relative); null as soon as one error is anything else. An optional entry whose only
 * problem is a module another lane has not written yet is skipped with a warning, like an entry that is itself missing.
 */
export function unresolvedLocalImports(errors, root) {
  const found = [];
  if (!Array.isArray(errors) || !errors.length) return null;
  for (const e of errors) {
    const m = /^Could not resolve "(\.{1,2}\/[^"]+)"/.exec(String(e && e.text));
    const from = e && e.location && e.location.file;
    if (!m || !from) return null;
    const target = resolve(dirname(resolve(root, from)), m[1]);
    if (existsSync(target)) return null;
    found.push(m[1] + ' (from ' + from + ')');
  }
  return found;
}

/**
 * build(options) → { outDir, buildId, files: [{ path, bytes, sha256 }], warnings, skipped }
 * options: { root = repository, outDir = 'dist', minify = true, updateLock = false, checkLockOnly = false, strict = false,
 * quiet = false, vendorFile (override of the webtorrent bundle, for tests), vendorVersion, lockFile, entries (override of ENTRIES, for tests),
 * testPsl = [] (v0.3 final integration: Public Suffix List additions for loopback hub tests, e.g. ['localhost'], as
 * tools/build-idp.mjs --test-psl; src/idp/psl.js reads them as PSL_TEST_RULES; a normal build defines nothing) }
 */
export async function build(options = {}) {
  const o = Object.assign({ root: ROOT, outDir: 'dist', minify: true, updateLock: false, checkLockOnly: false, strict: false, quiet: false, entries: ENTRIES, testPsl: [] }, options);
  const testPsl = Array.from(o.testPsl || []).map((s) => {
    if (typeof s !== 'string' || !/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(s) || s.length > 253) throw new Error('testPsl takes lowercase host suffixes, got ' + JSON.stringify(s));
    return s;
  });
  const root = resolve(o.root);
  const outDir = isAbsolute(o.outDir) ? o.outDir : resolve(root, o.outDir);
  const lockFile = o.lockFile || join(root, LOCK_FILE);
  const warnings = [];
  const say = o.quiet ? () => {} : (line) => process.stdout.write(line + '\n');
  const warnLine = (line) => {
    warnings.push(line);
    if (!o.quiet) process.stderr.write('warning: ' + line + '\n');
  };
  const read = (rel) => readFileSync(join(root, rel));
  const version = JSON.parse(read('package.json').toString('utf8')).version;
  const config = await import(pathToFileURL(join(root, 'src', 'loader', 'config.js')).href);
  const appVersion = (config.CONFIG && config.CONFIG.version) || version;

  // ---- vendored bundle: lock, then syntax gate ----------------------------------------------
  const vendor = o.vendorFile ? { file: o.vendorFile, version: o.vendorVersion || null } : vendoredSource(root);
  if (!existsSync(vendor.file)) throw new Error('the vendored bundle ' + vendor.file + ' is missing (run: npm ci)');
  const vendorBytes = readFileSync(vendor.file);
  let lock = readLock(lockFile);
  // v0.2.1 B3: the request-header patch. Computed before --update-lock writes the pins; a failure is
  // reported after the lock check below, so --update-lock still records the reviewed stock file.
  let patchResult = null;
  let patchError = null;
  try {
    patchResult = applyVendorPatches(vendorBytes.toString('utf8'), o.vendorPatches || WEBTORRENT_PATCHES);
  } catch (err) {
    patchError = err;
  }
  const patchedBytes = patchResult ? Buffer.from(patchResult.code, 'utf8') : null;
  const lockedVersions = lockVersions(lock); // before --update-lock changes anything (SUP-11)
  if (o.updateLock) {
    await guardProvenance(o, lockedVersions, { [vendor.package || 'webtorrent']: vendor.version });
    lock = lock || { v: 1 };
    lock.v = 1;
    lock.note = 'sha256 pins of vendored files (DESIGN-REVIEW S7): sha256 is the stock file in node_modules, patched.sha256 the bytes copied into dist/_mw after the hash-asserted patches (v0.2.1 B3 request headers; code review round 1: no OPFS chunks cleanup, no FSA polyfill on host globals). node build.mjs fails when either differs or a patch point moved; after reviewing an upgrade, run node build.mjs --update-lock. v0.3 (MF-78): "packages" pins every other package the bundles take from node_modules (name, version, sha256 of the package files, the tarball integrity of package-lock.json); a bundled package that is not pinned, or whose source changed, fails the build.';
    lock.review = LOCK_REVIEW;
    const previous = (lock.vendored && lock.vendored['webtorrent.min.js']) || {};
    lock.vendored = Object.assign({}, lock.vendored, {
      'webtorrent.min.js': {
        package: 'webtorrent', version: vendor.version, source: 'node_modules/webtorrent/dist/webtorrent.min.js', bytes: vendorBytes.length, sha256: sha256Hex(vendorBytes),
        markers: previous.markers || DEFAULT_MARKERS,
        patched: patchedBytes ? { sha256: sha256Hex(patchedBytes), bytes: patchedBytes.length, patches: patchResult.applied } : null,
      },
    });
    lock = orderedLock(lock);
    writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
    say('wrote ' + LOCK_FILE + ' (webtorrent ' + vendor.version + ', sha256 ' + sha256Hex(vendorBytes) + ')');
  }
  const verdict = checkLock(lock, { name: 'webtorrent.min.js', bytes: vendorBytes, version: vendor.version });
  if (!verdict.ok) throw new Error(verdict.message);
  say(verdict.message);
  const vendorText = vendorBytes.toString('utf8');
  const markers = checkMarkers(vendorText, (lock.vendored['webtorrent.min.js'] && lock.vendored['webtorrent.min.js'].markers) || DEFAULT_MARKERS);
  if (!markers.ok) {
    throw new Error('the vendored webtorrent.min.js no longer contains ' + markers.missing.map((m) => JSON.stringify(m)).join(', ') +
      ', which our code patches or calls (src/loader/torrent.js wraps wire._onMessageLength to cap peer messages). Update the code before pinning this bundle.');
  }
  if (patchError) throw patchError;
  const patchVerdict = checkPatchedLock(lock, { name: 'webtorrent.min.js', bytes: patchedBytes, applied: patchResult.applied });
  if (!patchVerdict.ok) throw new Error(patchVerdict.message);
  say(patchVerdict.message);
  if (!checkMarkers(patchResult.code, (lock.vendored['webtorrent.min.js'] && lock.vendored['webtorrent.min.js'].markers) || DEFAULT_MARKERS).ok) {
    throw new Error('the patched webtorrent.min.js lost a marker string; a patch must never touch _onMessageLength');
  }
  if (!o.checkLockOnly) {
    const gate = syntaxGate(patchResult.code);
    if (!gate.ok) throw new Error('the patched webtorrent.min.js fails the syntax gate: ' + gate.problems.join('; '));
    const floor = vendorFloorFindings(patchResult.code);
    if (floor.length) throw new Error('the patched webtorrent.min.js uses APIs past the browser floor: ' + floor.map((f) => f.id + ' at ' + f.line + ':' + f.column).slice(0, 8).join('; '));
  }

  // ---- bundles ------------------------------------------------------------------------------
  const outputs = new Map(); // dist-relative path -> Buffer
  const skipped = [];
  const bundledInputs = new Set(); // esbuild metafile inputs of every bundle, root-relative
  const common = { bundle: true, write: false, platform: 'browser', logLevel: 'silent', legalComments: 'none', minify: o.minify, charset: 'utf8', metafile: true, absWorkingDir: root };
  const banner = '/* felinar ' + appVersion + ' */';
  for (const entry of o.entries) {
    const input = isAbsolute(entry.in) ? entry.in : join(root, entry.in);
    // v0.3: an optional entry is skipped with a warning while it (or, below, a module it imports) is missing; --strict refuses that.
    const skippable = entry.optional && !o.strict;
    if (!existsSync(input)) {
      if (skippable) {
        warnLine(entry.in + ' does not exist yet: dist/' + entry.out + ' is not built' + (entry.name === 'mw' ? ' (drop-in pages will not start)' : ''));
        skipped.push(entry.out);
        continue;
      }
      throw new Error('missing source file ' + entry.in);
    }
    let result;
    try {
      // v0.3 C2 doors: an entry with `stdin` is that text, resolved from the repository root (the door view's renderer).
      const source = entry.stdin ? { stdin: { contents: entry.stdin, resolveDir: root, sourcefile: entry.name + '-entry.js', loader: 'js' } } : { entryPoints: [input] };
      result = await esbuild.build(Object.assign({}, common, source, {
        format: entry.format, target: Array.from([].concat(entry.target || TARGETS)), banner: { js: banner },
      }, testPsl.length ? { define: { MW_TEST_PSL: JSON.stringify(testPsl) } } : {}));
    } catch (err) {
      const missing = skippable ? unresolvedLocalImports(err && err.errors, root) : null;
      if (missing) {
        warnLine(entry.in + ' imports ' + missing.join(', ') + ', which does not exist yet: dist/' + entry.out + ' is not built');
        skipped.push(entry.out);
        continue;
      }
      const e = err && err.errors && err.errors[0];
      throw new Error('esbuild failed on ' + entry.in + ': ' + (e ? e.text + (e.location ? ' (' + e.location.file + ':' + e.location.line + ')' : '') : err.message));
    }
    for (const w of result.warnings || []) warnLine(entry.in + ': ' + w.text + (w.location ? ' (' + w.location.file + ':' + w.location.line + ')' : ''));
    for (const k of Object.keys((result.metafile && result.metafile.inputs) || {})) bundledInputs.add(k);
    outputs.set(entry.out, Buffer.from(result.outputFiles[0].contents));
  }

  // ---- bundled packages: every one is pinned (v0.3, MF-78) -----------------------------------------
  const packageLock = (() => {
    try {
      return JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    } catch (_) {
      return null;
    }
  })();
  const bundled = collectBundledPackages({ root, inputs: Array.from(bundledInputs).sort(), packageLock });
  if (o.updateLock) {
    await guardProvenance(o, lockedVersions, Object.fromEntries(Object.entries(bundled.packages).map(([name, entry]) => [name, entry && entry.version])));
    lock = lock || { v: 1 };
    lock.packages = lockEntriesFor(bundled.packages);
    lock = orderedLock(lock);
    writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
    say('wrote ' + LOCK_FILE + ' (' + Object.keys(lock.packages).length + ' bundled package(s) pinned)');
  }
  const packageVerdict = checkPackages(lock, bundled.packages, { duplicates: bundled.duplicates });
  for (const w of packageVerdict.warnings) warnLine(w);
  if (!packageVerdict.ok) throw new Error(packageVerdict.message);
  say(packageVerdict.message);
  if (o.checkLockOnly) return { outDir, buildId: null, files: [], warnings, skipped, packages: bundled.packages };

  // ---- static files -------------------------------------------------------------------------
  const css = esbuild.transformSync(read('src/loader/ui.css').toString('utf8'), { loader: 'css', minify: o.minify, target: Array.from(TARGETS), logLevel: 'silent', charset: 'utf8' });
  outputs.set('_mw/ui.css', Buffer.from(css.code));
  outputs.set('_mw/manifest.webmanifest', Buffer.from(manifestJson(appVersion)));
  outputs.set(DOOR_MANIFEST, Buffer.from(doorManifestJson(appVersion))); // v0.3 C2 doors
  outputs.set('_mw/icons/icon.svg', Buffer.from(ICON_SVG));
  outputs.set('_mw/webtorrent.min.js', patchedBytes);

  // ---- shell with SRI -----------------------------------------------------------------------
  const sri = {};
  for (const p of SRI_TARGETS) {
    const bytes = outputs.get(p.slice(1));
    if (!bytes) throw new Error('cannot add SRI: ' + p + ' was not built');
    sri[p] = sriFor(bytes);
  }
  const html = Buffer.from(applySri(read('src/loader/index.html').toString('utf8'), sri));
  outputs.set('index.html', html);
  outputs.set('404.html', html);
  outputs.set(DOOR_PAGE, Buffer.from(doorPageHtml(html.toString('utf8')))); // v0.3 C2 doors: the door page (precached)

  // ---- build id, precache list, Service Worker placeholders ---------------------------------
  const hashed = [];
  for (const [path, bytes] of outputs) hashed.push({ path, sha256: sha256Hex(bytes) });
  const buildId = computeBuildId(hashed.filter((f) => f.path !== '404.html'));
  const precache = precacheList(Array.from(outputs.keys()));
  // The bundles in the precache list get their placeholders first (their final bytes are hashed);
  // then /mw-sw.js, which is not precached, gets the integrity map of the final bytes (v0.2.1 D2).
  for (const entry of ENTRIES) {
    if (!entry.placeholders || !outputs.has(entry.out) || entry.name === 'sw') continue;
    outputs.set(entry.out, Buffer.from(applyPlaceholders(outputs.get(entry.out).toString('utf8'), { buildId, precache })));
  }
  const integrity = integrityMap(outputs, precache);
  for (const entry of ENTRIES) {
    if (!entry.placeholders || !outputs.has(entry.out) || entry.name !== 'sw') continue;
    outputs.set(entry.out, Buffer.from(applyPlaceholders(outputs.get(entry.out).toString('utf8'), { buildId, precache, integrity })));
  }

  // ---- door.json (v0.3 C2 doors): the final bytes of every other output -------------------------
  outputs.set(DOOR_JSON, doorJson(outputs, { version: appVersion, buildId }));

  // ---- build.json ---------------------------------------------------------------------------
  const files = Array.from(outputs.keys()).sort().map((path) => {
    const bytes = outputs.get(path);
    return { path, bytes: bytes.length, sha256: sha256Hex(bytes) };
  });
  const info = {
    name: 'felinar',
    version: appVersion,
    buildId,
    targets: Array.from(TARGETS),
    esbuild: esbuild.version,
    minified: Boolean(o.minify),
    vendored: {
      'webtorrent.min.js': {
        package: 'webtorrent', version: vendor.version, sha256: sha256Hex(vendorBytes),
        patched: true, patchedSha256: sha256Hex(patchedBytes), patches: patchResult.applied.slice(),
      },
    },
    packages: Object.fromEntries(Object.keys(bundled.packages).sort().map((name) => [name, { version: bundled.packages[name].version, sha256: bundled.packages[name].sha256 }])),
    sri,
    precache,
    integrity,
    skipped,
    files,
  };
  outputs.set(MARKER, Buffer.from(JSON.stringify(info, null, 2) + '\n'));

  // ---- write ----------------------------------------------------------------------------------
  // Code review round 1 (F40): the new build is written next to outDir and swapped in with two renames,
  // so a reader (a server, a test walking dist/) never sees a half-written build, only, for an instant,
  // no directory at all.
  if (existsSync(outDir)) {
    const entries = readdirSync(outDir);
    if (entries.length && !existsSync(join(outDir, MARKER))) {
      throw new Error('refusing to replace ' + outDir + ': it is not empty and has no ' + MARKER + ' (not a previous build output)');
    }
  }
  const tag = process.pid + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const staging = outDir + '.build-' + tag;
  const retired = [];
  try {
    for (const [path, bytes] of outputs) {
      const target = join(staging, ...path.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
    }
    // Another build into the same directory may swap its own output in between our two renames: then
    // the second rename finds a directory again, which is moved aside too, and we try again.
    for (let attempt = 0; ; attempt++) {
      if (existsSync(outDir)) {
        const aside = outDir + '.old-' + tag + '-' + attempt;
        renameSync(outDir, aside);
        retired.push(aside);
      }
      try {
        renameSync(staging, outDir);
        break;
      } catch (err) {
        if (attempt >= 4 || !(err && (err.code === 'ENOTEMPTY' || err.code === 'EEXIST' || err.code === 'EPERM'))) throw err;
      }
    }
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    if (retired.length && !existsSync(outDir)) {
      try { renameSync(retired.pop(), outDir); } catch (_) { /* leave it */ }
    }
    for (const dir of retired) rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  for (const dir of retired) rmSync(dir, { recursive: true, force: true });
  const total = files.reduce((n, f) => n + f.bytes, 0);
  say('built ' + files.length + ' files, ' + (total / 1024).toFixed(0) + ' KiB, into ' + outDir + ' (build ' + buildId + ', esbuild ' + esbuild.version + ')');
  for (const f of files) say('  ' + f.path.padEnd(28) + String(f.bytes).padStart(9) + ' bytes');
  return { outDir, buildId, files, warnings, skipped, info, packages: bundled.packages };
}

async function main(argv) {
  const flags = { out: 'dist', minify: true, updateLock: false, checkLock: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') flags.out = argv[++i];
    else if (a.startsWith('--out=')) flags.out = a.slice(6);
    else if (a === '--no-minify') flags.minify = false;
    else if (a === '--update-lock') flags.updateLock = true;
    else if (a === '--accept-no-provenance') flags.acceptNoProvenance = true;
    else if (a === '--check-lock') flags.checkLock = true;
    else if (a === '--strict') flags.strict = true;
    else if (a === '--quiet') flags.quiet = true;
    else if (a === '-h' || a === '--help') {
      process.stdout.write('Usage: node build.mjs [--out dist] [--no-minify] [--update-lock [--accept-no-provenance]] [--check-lock] [--strict] [--quiet]\n' +
        '  --update-lock  pin the vendored bundle and the bundled packages as they are now; a new release of a package that carries npm\n' +
        '                 provenance (PROVENANCE_REQUIRED) must still carry it (npm view), unless --accept-no-provenance\n' +
        '  --check-lock   check build.lock.json (the vendored bundle and every bundled package) and write nothing\n' +
        '  --strict       the optional entries (_mw/mw.js, signin.js, chat-panel.js) must build: a missing one is an error (releases use it)\n');
      return 0;
    } else {
      process.stderr.write('error: unknown argument ' + a + '\n');
      return 2;
    }
  }
  if (!flags.out) {
    process.stderr.write('error: --out needs a directory\n');
    return 2;
  }
  try {
    await build({
      outDir: resolve(flags.out), minify: flags.minify, updateLock: flags.updateLock, checkLockOnly: flags.checkLock, strict: Boolean(flags.strict), quiet: flags.quiet,
      acceptNoProvenance: Boolean(flags.acceptNoProvenance),
    });
    return 0;
  } catch (err) {
    process.stderr.write('error: ' + (err && err.message ? err.message : String(err)) + '\n');
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
