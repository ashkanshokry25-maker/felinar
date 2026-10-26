// src/sw/core.js: the Service Worker core (ARCHITECTURE §3.1-3.4, §7.1, §7.3; INTERFACES
// "src/sw/core.js"; DESIGN-REVIEW items 6, 7, 8, 9, 17, 20, 21, 23, S11).
//
//   createCore({ paths, proto, buildId, precache }) → { install, activate, owns, handle, message, messageError, init, inspect }
//
// Used by /mw-sw.js (src/sw/sw.js) and published on its own as the classic bundle /_mw/sw-core.js.
// A site that already has a Service Worker integrates drop-in serving with two lines
// (ARCHITECTURE §3.4.4); loading this file attaches self.mw and listens for our page messages:
//   importScripts('/_mw/sw-core.js')                                   // first line of its worker
//   if (self.mw.owns(event)) return event.respondWith(self.mw.handle(event))   // top of its fetch handler
//
// owns(event) is synchronous and decides from memory only; handle(event) never rejects, and every
// navigation it takes is answered (Firefox unregisters a worker whose navigations fault three times).
//
// Routing, same-origin GET only (non-GET and cross-origin requests are never touched):
//   /mw-sw.js, /_mw/t/*, /ws/*      pass through, never cached
//   /_mw/ws/<name>/<path>           drop-in web seed: same-origin /<path> with cache 'force-cache',
//                                   the Range sliced from it (no CORS, a 206 is never cached)
//   /_mw/s/<btih>/<path>            shared-origin hub: the site file from that btih; a top-level
//                                   navigation gets a 302 to /#btih:<hex>
//   /_mw/*                          loader assets, cache-first from mw-shell-<BUILD_ID>
//   shell mode                      top-level navigations: the precached /index.html with framing
//                                   headers; iframe navigations and subresources of the site: the
//                                   file from the btih mapped to the client (else meta.current) with
//                                   /.mw/site.json applied; requests of the shell itself pass through
//   drop-in mode                    navigations go to the network (the stamped pointer is read from a
//                                   tee of the first 4 KiB to map the new client, the page is kept for
//                                   offline use); subresources of a mapped client whose site is
//                                   complete and lists the path come from IndexedDB; the rest passes
// Every byte served from IndexedDB was SHA-1 verified first, piece by piece (§7.3): a mismatch
// deletes the site and falls back to the network (drop-in) or tells the shell to re-download.
//
// v0.2.1 (DIGEST-AMENDMENTS D1, D2, D4):
//   D1 every navigation is answered within limits.navigationDeadlineMs (25 s): a "Still loading"
//      interstitial that retries by itself, at most reloadGuardMax times per URL in reloadGuardWindowMs
//      (the reload-loop guard), then without the automatic retry; mw-keepalive and GET /_mw/keepalive
//      keep the worker alive while a page depends on it (src/sw/protocol.js, the versioned protocol);
//      nothing required lives only in memory (meta.current, meta.clients and the mode mark persist).
//   D2 install is atomic: the JS and CSS of the precache list are fetched with Request.integrity from
//      build.json (self.__INTEGRITY__) and checked again here; one failure deletes the half-filled
//      cache and rejects the install, so the previous worker stays in control. HTML stays best-effort
//      (hosts rewrite it). A navigation whose handling fails falls back to the network (fail open),
//      then to an offline page; a frame navigation of shell mode gets the error page instead (the host
//      would answer it with the shell itself).
//   D4 drop-in: on a cold start a subresource waits at most limits.coldStartWaitMs (40 ms) for the
//      index, then passes through; a navigation answered Cache-Control: no-store is never kept and its
//      page is told (mw-ack doc.noStore) to run host-only; the web-seed rewrite fetches each file once
//      for all concurrent requests, never keeps a no-store answer, and forwards Range to the host for
//      files too large to hold in memory.
//
// v0.3 (R 2.3.1, 2.8.5, 2.9.6; ARCHITECTURE 15.7): reserved routes answered before every other route
// and before the navigation catch-all, in shell, hub and drop-in modes alike:
//   /_mw/f/<id>, /_mw/media/<sid>   src/sw/media-route.js (file downloads and private media, sessions
//                                   registered by the engine page with mw-session-register)
//   /_mw/idp-return                 the loader document (shell mode) or a minimal page that loads the
//                                   drop-in runtime, where the sign-in redirect round trip finishes
// Navigation responses the worker builds carry Cross-Origin-Opener-Policy: same-origin-allow-popups
// (the identity-origin popup keeps its opener; a routing manifest's own COOP still wins) and
// Referrer-Policy: no-referrer.

import { PROTO, MSG, KEEPALIVE_PATH, checkProto } from './protocol.js';
import {
  mimeFor, parseRange, splitHubPath, applyRouting, normalizeManifest, headersFor, decodePath,
  encodePath, stampedPointerFromHtml, isShellHtml, reservedRoute,
} from './lib.js';
import { createMediaRoute } from './media-route.js';
import { parseTorrentFile } from '../common/torrent-file.js';
import { normalizeBtih } from '../common/magnet.js';
import { readPiece, checkPiece } from '../loader/verify.js';

export { PROTO };

/** Same values as CONFIG.paths (src/loader/config.js), plus the dev web seed of tools/dev-server.mjs. */
export const DEFAULT_PATHS = Object.freeze({
  sw: '/mw-sw.js',
  assets: '/_mw/',
  hubSite: '/_mw/s/',
  webseedRewrite: '/_mw/ws/',
  torrents: '/_mw/t/',
  devWebseed: '/ws/',
});

/** Fallback precache list for unbuilt development; build.mjs replaces self.__PRECACHE__. */
export const DEFAULT_PRECACHE = Object.freeze([
  '/index.html', '/_mw/boot.js', '/_mw/loader.js', '/_mw/sdk.js', '/_mw/mw.js', '/_mw/sw-core.js',
  '/_mw/pow-worker.js', '/_mw/ui.css', '/_mw/manifest.webmanifest', '/_mw/icons/icon.svg',
]);

export const SHELL_CACHE_PREFIX = 'mw-shell-';

/**
 * v0.3 C2 doors (research/v03/S4-doors.md D3, D4): the door page of every build and the door list. A navigation to the door page is
 * answered from the precache with the shell's framing headers (it works with the host down, like the shell); the door list is never
 * answered or kept by the worker, so a probe of this address reaches the network; and the worker never takes a current site from
 * the door page (it shows other origins' sites, which must never become this origin's meta.current).
 */
export const DOOR_PAGE_PATH = '/_mw/open.html';
export const DOOR_JSON_PATH = '/_mw/door.json';

/** IndexedDB names shared with src/loader/cache.js (the SW re-implements a minimal reader). */
export const DB_NAME = 'mw-sites';
export const STORES = Object.freeze({ sites: 'sites', files: 'files', meta: 'meta', docs: 'docs' });

/** Key of a file Blob in the `files` store (same as cache.js fileKey). */
export function fileKey(btih, path) {
  return btih + '/' + path;
}

/** [lower, upper) key bounds of every file of one btih (same as cache.js fileKeyBounds). */
export function fileKeyBounds(btih) {
  return [btih + '/', btih + '0'];
}

export const DEFAULT_LIMITS = Object.freeze({
  docsMaxEntries: 100, // drop-in offline documents kept (LRU by savedAt)
  docsMaxBytes: 16 * 1024 * 1024,
  docPeekBytes: 4096, // the stamped pointer must sit in the first 4 KiB
  clientMapMax: 512,
  docMapMax: 256,
  shellClientsMax: 64,
  webseedCacheBytes: 64 * 1024 * 1024, // whole host files kept in memory for web-seed slicing
  webseedCacheMs: 60000,
  webseedTorrentsMax: 8, // parsed .torrent files of versions being downloaded (nothing stored yet)
  refreshThrottleMs: 2000, // at most one IndexedDB re-read per btih in this window
  initTimeoutMs: 5000,
  updateThrottleMs: 300000, // registration.update() at most every 5 min
  shellRevalidateMs: 10000, // background re-fetch of the shell document at most every 10 s
  persistDelayMs: 1000, // meta.clients write coalescing
  maxRoutingBytes: 1024 * 1024,
  verifyConcurrency: 4,
  // v0.2.1 D1: every navigation is answered within this time (Firefox unregisters a worker whose
  // navigations fault three times and stops an idle worker after about 60 s; Safari allows 70 s).
  navigationDeadlineMs: 25000,
  interstitialRetryS: 5, // the interstitial reloads itself after this many seconds...
  reloadGuardMax: 3, // ...at most this many times per URL...
  reloadGuardWindowMs: 60000, // ...within this window; then it waits for the visitor
  reloadGuardMaxUrls: 256,
  // v0.2.1 D4: a drop-in subresource waits at most this long for the index after a cold start.
  coldStartWaitMs: 40,
  docInfoMax: 256, // per-client navigation facts (no-store) kept for mw-ack doc
  webseedWholeMaxBytes: 32 * 1024 * 1024, // larger host files: Range is forwarded instead of a whole-file fetch
});

/** v0.3: the opener policy of navigation responses the worker builds (R 2.3.1). */
export const NAV_COOP = 'same-origin-allow-popups';

// v0.3: COOP and Referrer-Policy on a navigation response the worker built, unless already set.
function navigationHeaders(h) {
  if (!h.has('cross-origin-opener-policy')) h.set('Cross-Origin-Opener-Policy', NAV_COOP);
  if (!h.has('referrer-policy')) h.set('Referrer-Policy', 'no-referrer');
  return h;
}

const MODE_KEY = '/_mw/__mw-mode';
const SHELL_KEYS = ['/index.html', '/'];
const OCTET = 'application/octet-stream';
const NESTED = new Set(['iframe', 'frame', 'embed', 'object']);
// Drop-in rule (d): documents, worker scripts and manifests always come from the host.
const DROPIN_PASS = new Set([
  'document', 'iframe', 'frame', 'embed', 'object', 'worker', 'sharedworker', 'serviceworker',
  'manifest', 'report', 'audioworklet', 'paintworklet', 'webidentity',
]);
// Never taken from a routing manifest: they describe the bytes we send or are not ours to set.
const PROTECTED_HEADERS = new Set([
  'content-length', 'content-range', 'accept-ranges', 'location', 'set-cookie', 'set-cookie2',
  'transfer-encoding', 'content-encoding', 'connection', 'keep-alive', 'trailer', 'upgrade',
]);
// Set by the worker on site documents in shell and hub mode (§7.1); a manifest cannot weaken them.
const SITE_OWNED_HEADERS = new Set(['x-frame-options', 'referrer-policy', 'cache-control', 'x-content-type-options']);
const DOC_DROP_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie', 'set-cookie2',
]);
// One message event can reach two listeners (sw.js and the auto-attached one): handle it once.
const HANDLED = new WeakSet();

// ---------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------

function under(path, prefix) {
  return typeof prefix === 'string' && prefix.length > 0 && path.indexOf(prefix) === 0;
}

function errText(err) {
  return (err && err.message) || String(err);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Resolves to the promise's value, or to `fallback` after `ms` (the timer is cleared either way).
function withTimeout(promise, ms, fallback) {
  let timer = null;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, late]).then((v) => {
    clearTimeout(timer);
    return v;
  }, (err) => {
    clearTimeout(timer);
    throw err;
  });
}

function asBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data && ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

// Where the engine cannot keep Blobs in IndexedDB (WebKit private browsing and Playwright's default
// WebKit context), src/loader/cache.js stores each file as an ArrayBuffer instead; the worker
// serves Blobs (size, slice, text), so a stored ArrayBuffer is wrapped on the way out.
function asBlobValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return new Blob([value]);
  return value;
}

function stripHash(href) {
  if (typeof href !== 'string' || !href) return '';
  const cut = href.indexOf('#');
  return cut >= 0 ? href.slice(0, cut) : href;
}

function header(req, name) {
  return req && req.headers && typeof req.headers.get === 'function' ? req.headers.get(name) : null;
}

function isNavigation(req) {
  return req.mode === 'navigate' || req.destination === 'document';
}

// A top-level document navigation: destination 'document', or a navigation that is not a frame's.
function isTopLevel(req) {
  return req.destination === 'document' || (req.mode === 'navigate' && !NESTED.has(req.destination));
}

function safeSet(h, name, value) {
  try {
    h.set(name, value);
  } catch (_) { /* not a valid header value (non-Latin-1): skip it */ }
}

function safeAppend(h, name, value) {
  try {
    h.append(name, value);
  } catch (_) { /* invalid value */ }
}

function waitUntil(event, promise) {
  if (!event || typeof event.waitUntil !== 'function') return;
  try {
    event.waitUntil(Promise.resolve(promise).catch(() => {}));
  } catch (_) { /* the event already finished: the work still runs */ }
}

// Map with insertion order as recency and a size cap.
function remember(map, key, value, max) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

function textResponse(status, body) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

const PAGES = {
  offline: ["You're offline", "This page hasn't been saved on this device yet. Reconnect and reload."],
  notready: ["This site isn't ready yet", "The site hasn't finished loading on this device. It appears here as soon as it's ready."],
  invalid: ['Saved files were removed', "Some files saved on this device didn't match the published site, so they were removed. Reload to fetch them again."],
  error: ['Something went wrong', "This page couldn't be loaded. Reload to try again."],
  slow: ['Still loading', "This page is taking longer than usual. It tries again by itself in a few seconds."],
  slowStopped: ['Still loading', "This page is taking longer than usual. Reload to try again."],
};

// Small self-contained HTML answer for navigations (fixed text only, never request data). refreshS:
// the page reloads itself after that many seconds (the D1 interstitial; never without the guard).
function pageResponse(status, kind, { refreshS = 0 } = {}) {
  const t = PAGES[kind] || PAGES.error;
  const refresh = refreshS > 0 ? '<meta http-equiv="refresh" content="' + Math.floor(refreshS) + '">' : '';
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' + refresh +
    '<meta name="viewport" content="width=device-width, initial-scale=1"><title>' + t[0] + '</title></head>' +
    '<body style="font:16px/1.5 system-ui,sans-serif;max-width:36em;margin:3em auto;padding:0 1em">' +
    '<h1 style="font-size:1.25em">' + t[0] + '</h1><p>' + t[1] + '</p></body></html>';
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': NAV_COOP,
  };
  if (refreshS > 0) headers['Retry-After'] = String(Math.floor(refreshS));
  return new Response(html, { status, headers });
}

/**
 * integrityMatches(bytes, integrity) → Promise<boolean>: SRI check of the bytes against any of the
 * space-separated sha256-/sha384-/sha512- values (v0.2.1 D2). Browsers enforce Request.integrity on
 * the precache fetch already; this repeats it where WebCrypto exists (and in Node tests).
 */
export async function integrityMatches(bytes, integrity) {
  const subtle = typeof crypto !== 'undefined' && crypto && crypto.subtle ? crypto.subtle : null;
  if (!subtle || typeof integrity !== 'string' || !integrity.trim()) return true;
  const algs = { sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };
  let checked = false;
  for (const token of integrity.trim().split(/\s+/)) {
    const m = /^(sha256|sha384|sha512)-([A-Za-z0-9+/=_-]+)/.exec(token);
    if (!m) continue;
    checked = true;
    const digest = new Uint8Array(await subtle.digest(algs[m[1]], bytes));
    let bin = '';
    for (let i = 0; i < digest.length; i++) bin += String.fromCharCode(digest[i]);
    const b64 = btoa(bin);
    if (b64 === m[2] || b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') === m[2].replace(/=+$/, '')) return true;
  }
  return !checked;
}

function redirectResponse(status, location, headers) {
  const h = headers || new Headers();
  h.set('Location', location);
  return new Response(null, { status, headers: h });
}

// Headers for a response built from IndexedDB. 'site' = shell and hub site files (§7.1 framing
// set); 'dropin' = host URLs, where the worker adds nothing the host would not send.
function baseHeaders(kind) {
  const h = new Headers();
  h.set('Accept-Ranges', 'bytes');
  if (kind !== 'dropin') {
    h.set('Cache-Control', 'no-store');
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('Content-Security-Policy', "frame-ancestors 'self'");
    h.set('X-Frame-Options', 'SAMEORIGIN');
    h.set('Referrer-Policy', 'no-referrer');
  }
  return h;
}

// A site CSP must not stop the shell from framing the site: drop its frame-ancestors directive.
function withoutFrameAncestors(policy) {
  return policy.split(',').map((one) => one.split(';').map((d) => d.trim())
    .filter((d) => d && !/^frame-ancestors(\s|$)/i.test(d)).join('; ')).filter(Boolean).join(', ');
}

function applyRouteHeaders(h, values, kind) {
  if (!values) return;
  for (const name of Object.keys(values)) {
    const lower = name.toLowerCase();
    if (PROTECTED_HEADERS.has(lower)) continue;
    if (kind !== 'dropin' && SITE_OWNED_HEADERS.has(lower)) continue;
    let value = String(values[name]);
    if (lower === 'content-security-policy' || lower === 'content-security-policy-report-only') {
      if (kind !== 'dropin') value = withoutFrameAncestors(value);
      if (value) safeAppend(h, name, value);
      continue;
    }
    safeSet(h, name, value);
  }
}

function storableHeaders(headers) {
  const out = {};
  if (headers && typeof headers.forEach === 'function') {
    headers.forEach((value, name) => {
      if (!DOC_DROP_HEADERS.has(name.toLowerCase())) out[name] = value;
    });
  }
  return out;
}

function isHtmlResponse(res) {
  const type = (res.headers && res.headers.get('content-type')) || '';
  return /^\s*(text\/html|application\/xhtml\+xml)\b/i.test(type);
}

function hasNoStore(res) {
  return /(^|[\s,])no-store([\s,;]|$)/i.test((res.headers && res.headers.get('cache-control')) || '');
}

function normalizeCurrent(v) {
  return {
    btih: normalizeBtih(v.btih),
    ledgerId: typeof v.ledgerId === 'string' && v.ledgerId ? v.ledgerId : null,
    routing: v.routing && typeof v.routing === 'object' ? v.routing : null,
  };
}

function precacheList(list, paths, origin) {
  const src = Array.isArray(list) ? list : DEFAULT_PRECACHE;
  const out = [];
  for (const item of src) {
    if (typeof item !== 'string' || !item) continue;
    let p;
    try {
      const u = new URL(item, origin + '/');
      if (u.origin !== origin) continue;
      p = u.pathname;
    } catch (_) {
      continue;
    }
    // webtorrent.min.js (223 KB) is cached on first fetch instead (ARCHITECTURE §7.1).
    if (/\/webtorrent\.min\.js$/.test(p)) continue;
    if (p === paths.sw || under(p, paths.torrents) || under(p, paths.webseedRewrite) ||
      under(p, paths.hubSite) || under(p, paths.devWebseed)) continue;
    if (out.indexOf(p) < 0) out.push(p);
  }
  return out;
}

function resolveEnv(e) {
  const g = typeof self !== 'undefined' ? self : globalThis;
  const given = (k) => Object.prototype.hasOwnProperty.call(e, k);
  const loc = g && g.location;
  return {
    caches: given('caches') ? e.caches : (g.caches || null),
    clients: given('clients') ? e.clients : (g.clients || null),
    registration: given('registration') ? e.registration : (g.registration || null),
    indexedDB: given('indexedDB') ? e.indexedDB : (g.indexedDB || null),
    IDBKeyRange: given('IDBKeyRange') ? e.IDBKeyRange : (g.IDBKeyRange || null),
    origin: e.origin || (loc && loc.origin) || 'http://localhost',
    fetch: e.fetch || ((input, init) => g.fetch(input, init)),
    skipWaiting: e.skipWaiting || (() => (typeof g.skipWaiting === 'function' ? g.skipWaiting() : undefined)),
    now: e.now || (() => Date.now()),
    log: e.log || ((msg) => {
      try {
        console.warn('[mw-sw] ' + msg);
      } catch (_) { /* no console */ }
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// IndexedDB reader (schema owned by src/loader/cache.js: never created or upgraded here)
// ---------------------------------------------------------------------------------------------

function noDatabase(message) {
  const err = new Error(message);
  err.code = 'E_NO_DB';
  return err;
}

/**
 * createIdbStorage({ indexedDB, IDBKeyRange, dbName }) → the storage object createCore uses:
 *   getSite(btih) / listSites() / getFile(btih, path) / getMeta(key) / setMeta(key, value)
 *   deleteSite(btih) / getDoc(url) / putDoc(url, doc, { docsMaxEntries, docsMaxBytes }) / close()
 * Opens the database without a version: if it does not exist yet the upgrade is aborted (the
 * loader creates it with its schema) and reads resolve empty. The connection steps aside on
 * versionchange. Readwrite transactions issue every request synchronously (no await inside).
 */
export function createIdbStorage(options) {
  const o = options || {};
  const factory = o.indexedDB !== undefined ? o.indexedDB : (typeof indexedDB !== 'undefined' ? indexedDB : null);
  const KeyRange = o.IDBKeyRange !== undefined ? o.IDBKeyRange : (typeof IDBKeyRange !== 'undefined' ? IDBKeyRange : null);
  const name = o.dbName || DB_NAME;
  const now = o.now || (() => Date.now());
  let dbPromise = null;
  let missingUntil = 0;

  function open() {
    if (dbPromise) return dbPromise;
    if (!factory) return Promise.reject(noDatabase('IndexedDB is unavailable'));
    if (now() < missingUntil) return Promise.reject(noDatabase('the site database does not exist yet'));
    const p = new Promise((resolve, reject) => {
      let req;
      try {
        req = factory.open(name);
      } catch (err) {
        reject(err);
        return;
      }
      let created = false;
      req.onupgradeneeded = () => {
        created = true;
        try {
          req.transaction.abort();
        } catch (_) { /* already aborted */ }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          try {
            db.close();
          } catch (_) { /* closed */ }
          if (dbPromise === p) dbPromise = null;
        };
        db.onclose = () => {
          if (dbPromise === p) dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = (ev) => {
        if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
        if (created) missingUntil = now() + 1000;
        reject(created ? noDatabase('the site database does not exist yet') : (req.error || new Error('IndexedDB open failed')));
      };
    });
    dbPromise = p;
    p.catch(() => {
      if (dbPromise === p) dbPromise = null;
    });
    return p;
  }

  // body(tx, storeNamesPresent, setResult): every request is issued synchronously or from request
  // callbacks. Stores missing from an older schema are skipped (reads then resolve undefined).
  async function run(storeNames, mode, body) {
    for (let attempt = 0; ; attempt++) {
      const db = await open();
      try {
        return await new Promise((resolve, reject) => {
          const names = storeNames.filter((n) => db.objectStoreNames.contains(n));
          if (names.length === 0) {
            resolve(undefined);
            return;
          }
          let tx;
          try {
            tx = db.transaction(names, mode);
          } catch (err) {
            reject(err);
            return;
          }
          let result;
          let failure = null;
          tx.oncomplete = () => resolve(result);
          tx.onabort = () => reject(failure || tx.error || new Error('IndexedDB transaction aborted'));
          tx.onerror = (ev) => {
            if (!failure && ev && ev.target && ev.target.error) failure = ev.target.error;
          };
          try {
            body(tx, names, (v) => {
              result = v;
            });
          } catch (err) {
            failure = err;
            try {
              tx.abort();
            } catch (_) { /* finished */ }
          }
        });
      } catch (err) {
        if (attempt === 0 && err && (err.name === 'InvalidStateError' || err.name === 'UnknownError')) {
          dbPromise = null; // the connection closed under us (versionchange, Safari): reopen once
          continue;
        }
        throw err;
      }
    }
  }

  function getOne(store, key) {
    return run([store], 'readonly', (tx, names, set) => {
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => set(req.result);
    });
  }

  function putOne(store, key, value) {
    return run([store], 'readwrite', (tx) => {
      const s = tx.objectStore(store);
      if (s.keyPath === null || s.keyPath === undefined) s.put(value, key);
      else s.put(value);
    });
  }

  return {
    // A page just created or wrote the database (mw-set-current, mw-site-saved): forget the short
    // "does not exist yet" negative cache, so the next read opens it for real.
    retry() {
      missingUntil = 0;
    },
    getSite: (btih) => getOne(STORES.sites, btih),
    listSites: () => run([STORES.sites], 'readonly', (tx, names, set) => {
      const req = tx.objectStore(STORES.sites).getAll();
      req.onsuccess = () => set(req.result || []);
    }).then((v) => v || []),
    getFile: (btih, path) => getOne(STORES.files, fileKey(btih, path)),
    getMeta: (key) => getOne(STORES.meta, key),
    setMeta: (key, value) => putOne(STORES.meta, key, value),
    getDoc: (url) => getOne(STORES.docs, url),
    deleteSite: (btih) => run([STORES.sites, STORES.files, STORES.docs], 'readwrite', (tx, names) => {
      if (names.indexOf(STORES.sites) >= 0) tx.objectStore(STORES.sites).delete(btih);
      if (names.indexOf(STORES.files) >= 0 && KeyRange) {
        const b = fileKeyBounds(btih);
        tx.objectStore(STORES.files).delete(KeyRange.bound(b[0], b[1], false, true));
      }
      if (names.indexOf(STORES.docs) >= 0) {
        const cursorReq = tx.objectStore(STORES.docs).openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          if (cursor.value && cursor.value.btih === btih) cursor.delete();
          cursor.continue();
        };
      }
    }),
    putDoc: (url, doc, limits) => run([STORES.docs], 'readwrite', (tx) => {
      const store = tx.objectStore(STORES.docs);
      if (store.keyPath === null || store.keyPath === undefined) store.put(doc, url);
      else store.put(doc);
      const maxEntries = (limits && limits.docsMaxEntries) || DEFAULT_LIMITS.docsMaxEntries;
      const maxBytes = (limits && limits.docsMaxBytes) || DEFAULT_LIMITS.docsMaxBytes;
      const entries = [];
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor) {
          const v = cursor.value || {};
          entries.push({
            key: cursor.key,
            at: typeof v.savedAt === 'number' ? v.savedAt : 0,
            size: v.body && typeof v.body.size === 'number' ? v.body.size : 0,
          });
          cursor.continue();
          return;
        }
        entries.sort((a, b) => a.at - b.at);
        let count = entries.length;
        let bytes = 0;
        for (const e of entries) bytes += e.size;
        for (const e of entries) {
          if (count <= maxEntries && bytes <= maxBytes) break;
          if (e.key === url) continue;
          store.delete(e.key);
          count -= 1;
          bytes -= e.size;
        }
      };
    }),
    close() {
      const p = dbPromise;
      dbPromise = null;
      if (p) p.then((db) => db.close(), () => {});
    },
  };
}

// ---------------------------------------------------------------------------------------------
// the core
// ---------------------------------------------------------------------------------------------

/**
 * createCore({ paths, proto, buildId, precache, foreign, limits, storage, env }) → core
 *   paths     DEFAULT_PATHS (CONFIG.paths plus devWebseed)
 *   proto     protocol version carried by every page↔worker message (1)
 *   buildId   names the precache: mw-shell-<buildId>
 *   precache  same-origin paths to cache at install (webtorrent.min.js is always left out)
 *   integrity v0.2.1 D2: { path: 'sha384-...' } for the JS and CSS of the precache list (build.json;
 *             build.mjs puts it into /mw-sw.js as self.__INTEGRITY__): those entries are the critical
 *             set of an atomic install. Without it (unbuilt development) every entry is best-effort.
 *   foreign   true when running inside a site's own worker via /_mw/sw-core.js: drop-in rules
 *             (b) and (c) only, never a navigation, never a lifecycle step of that worker
 *   limits, storage, env: overrides for tests (env: caches, clients, registration, indexedDB,
 *             IDBKeyRange, fetch, origin, skipWaiting, now, log)
 * core = { install(event), activate(event), owns(event) → boolean, handle(event) → Promise<Response>,
 *          message(event) → boolean, init() → Promise, inspect() → plain object }
 */
export function createCore(options) {
  const opts = options || {};
  const paths = Object.assign({}, DEFAULT_PATHS, opts.paths || {});
  const proto = typeof opts.proto === 'number' ? opts.proto : PROTO;
  const buildId = typeof opts.buildId === 'string' && opts.buildId ? opts.buildId : 'dev';
  const foreign = opts.foreign === true;
  const limits = Object.assign({}, DEFAULT_LIMITS, opts.limits || {});
  const env = resolveEnv(opts.env || {});
  const origin = env.origin;
  const storage = opts.storage || createIdbStorage({ indexedDB: env.indexedDB, IDBKeyRange: env.IDBKeyRange, now: env.now });
  const parseTorrent = typeof opts.parseTorrentFile === 'function' ? opts.parseTorrentFile : parseTorrentFile;
  const cacheName = SHELL_CACHE_PREFIX + buildId;
  const precache = precacheList(opts.precache, paths, origin);
  const integrity = {};
  if (opts.integrity && typeof opts.integrity === 'object') {
    for (const key of Object.keys(opts.integrity)) {
      if (typeof opts.integrity[key] === 'string' && opts.integrity[key]) integrity[key] = opts.integrity[key];
    }
  }
  const mediaRoute = createMediaRoute({ env: { clients: env.clients, now: env.now }, limits: opts.mediaLimits || {} });
  const logged = new Set();
  const log = (msg) => {
    if (logged.has(msg) || logged.size > 200) return;
    logged.add(msg);
    env.log(msg);
  };

  const state = {
    initPromise: null,
    initDone: false,
    mode: foreign ? 'dropin' : null, // 'shell' | 'dropin' | null (not known yet)
    modeFromCache: null, // decided at install from the precached /index.html
    msgShell: false, // a shell page posted mw-set-current to this instance
    current: null, // { btih, ledgerId, routing } (shell mode origin → site)
    sites: new Map(), // btih → entry (complete, parsed and infohash-checked)
    bad: new Set(), // btih not to serve in this instance (mismatch or missing data)
    dropping: new Map(), // btih → deletion in progress
    refreshJobs: new Map(),
    refreshAt: new Map(),
    verified: new Map(), // btih → Set of verified piece indices (memory only, never persisted)
    pieceJobs: new Map(),
    clientMap: new Map(), // clientId → btih
    docMap: new Map(), // document URL → btih (fallback when resultingClientId is missing)
    servedMap: new Map(), // stylesheet URL → btih (requests a stylesheet makes carry it as referrer)
    shellClients: new Map(), // clientId → true (top-level shell pages)
    persistJob: null,
    persistDirty: false,
    wsBlobs: new Map(),
    wsBytes: 0,
    wsJobs: new Map(),
    wsTorrents: new Map(), // btih → { name, pathIndex, padIndex, files } for the web-seed rewrite (first downloads)
    lastUpdate: 0,
    lastShellCheck: 0,
    drops: [], // the last copies deleted after a failed check: { btih, reason, path, at } (inspect only)
    markPromise: null, // the mode mark read from Cache Storage (fast; the D4 cold-start wait uses it)
    docInfo: new Map(), // clientId → { noStore, at }: what a drop-in navigation response said (D4)
    guard: new Map(), // URL → [timestamps of interstitials] (D1 reload-loop guard)
    installFailed: null, // the reason of the last failed atomic install (inspect only)
  };

  // ------------------------------------------------------------------- state and index

  function computeMode() {
    if (foreign) state.mode = 'dropin';
    else if (state.msgShell) state.mode = 'shell';
    else if (state.modeFromCache) state.mode = state.modeFromCache;
    else if (state.initDone) state.mode = state.current ? 'shell' : 'dropin';
    else state.mode = null;
    return state.mode;
  }

  async function readModeMark() {
    if (!env.caches) return null;
    try {
      const res = await env.caches.match(origin + MODE_KEY, { cacheName });
      const text = res ? (await res.text()).trim() : '';
      return text === 'shell' || text === 'dropin' ? text : null;
    } catch (_) {
      return null;
    }
  }

  async function writeModeMark(mode) {
    state.modeFromCache = mode;
    computeMode();
    if (foreign || !env.caches) return;
    try {
      const cache = await env.caches.open(cacheName);
      await cache.put(origin + MODE_KEY, new Response(mode, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
    } catch (_) { /* best effort */ }
  }

  function init() {
    if (!state.initPromise) {
      state.initPromise = (async () => {
        const results = await Promise.all([
          foreign ? Promise.resolve(null) : modeMark(),
          storage.getMeta('current').catch(() => null),
          storage.getMeta('clients').catch(() => null),
          storage.listSites().catch(() => []),
        ]);
        const mark = results[0];
        const current = results[1];
        const clients = results[2];
        const records = results[3];
        if (mark && !state.modeFromCache) state.modeFromCache = mark;
        if (!state.current && current && typeof current === 'object' && normalizeBtih(current.btih)) {
          state.current = normalizeCurrent(current);
        }
        if (clients && typeof clients === 'object') {
          for (const id of Object.keys(clients)) {
            const btih = normalizeBtih(clients[id]);
            if (btih && !state.clientMap.has(id)) remember(state.clientMap, id, btih, limits.clientMapMax);
          }
        }
        if (Array.isArray(records)) await Promise.all(records.map((r) => indexRecord(r).catch(() => null)));
        if (foreign) await cleanupOldCaches();
      })().catch((err) => {
        log('index load failed: ' + errText(err));
      }).then(() => {
        state.initDone = true;
        computeMode();
      });
    }
    return state.initPromise;
  }

  function settle() {
    return withTimeout(init(), limits.initTimeoutMs, null);
  }

  // The mode mark alone (one Cache Storage read): enough to know whether a cold-start request may
  // pass through after the short D4 wait (drop-in) or must wait for the index (shell).
  function modeMark() {
    if (!state.markPromise) {
      state.markPromise = readModeMark().then((mark) => {
        if (mark && !state.modeFromCache) state.modeFromCache = mark;
        return mark;
      }, () => null);
    }
    return state.markPromise;
  }

  async function indexRecord(record) {
    const btih = record && normalizeBtih(record.btih);
    if (!btih) return null;
    if (record.complete === false) {
      state.sites.delete(btih);
      return null;
    }
    const bytes = asBytes(record.torrentFile);
    if (!bytes) return null;
    let parsed;
    try {
      parsed = await parseTorrent(bytes);
    } catch (err) {
      await dropSite(btih, 'bad-torrent', null);
      return null;
    }
    // Once per context: sha1(info) of the stored .torrent must be the expected btih (§7.3).
    if (!parsed || String(parsed.infoHash).toLowerCase() !== btih) {
      await dropSite(btih, 'infohash', null);
      return null;
    }
    const pathIndex = new Map();
    parsed.files.forEach((f, i) => {
      if (!f.pad && !pathIndex.has(f.path)) pathIndex.set(f.path, i);
    });
    const types = new Map();
    if (Array.isArray(record.files)) {
      for (const f of record.files) {
        if (f && typeof f.path === 'string' && typeof f.type === 'string' && f.type) types.set(f.path, f.type);
      }
    }
    const entry = {
      btih,
      kind: record.kind === 'assets' ? 'assets' : 'site',
      name: typeof record.name === 'string' && record.name ? record.name : parsed.name,
      parsed,
      files: parsed.files,
      pathIndex,
      types,
      routingPromise: null,
    };
    state.sites.set(btih, entry);
    return entry;
  }

  // Re-read one site record (after a message, or when a request names an unknown btih).
  function refreshSite(btih, force) {
    const running = state.refreshJobs.get(btih);
    if (running) return running;
    const at = state.refreshAt.get(btih) || 0;
    if (!force && env.now() - at < limits.refreshThrottleMs) return Promise.resolve(state.sites.get(btih) || null);
    state.refreshAt.set(btih, env.now());
    if (force && typeof storage.retry === 'function') storage.retry();
    const job = (async () => {
      const deleting = state.dropping.get(btih);
      if (deleting) await deleting;
      let record = null;
      try {
        record = await storage.getSite(btih);
      } catch (_) {
        record = null;
      }
      if (!record) {
        state.sites.delete(btih);
        return null;
      }
      state.bad.delete(btih); // stored again since it was dropped: index the new copy
      return indexRecord(record);
    })().catch(() => null);
    state.refreshJobs.set(btih, job);
    const clear = () => {
      if (state.refreshJobs.get(btih) === job) state.refreshJobs.delete(btih);
    };
    job.then(clear, clear);
    return job;
  }

  // force: re-read IndexedDB even inside the refresh throttle (a navigation into the site; at most
  // one read per navigation, so a page that saved its copy a moment ago is never told "not ready").
  async function siteEntry(btih, force) {
    if (!btih) return null;
    const entry = state.bad.has(btih) ? null : state.sites.get(btih);
    if (entry) return entry;
    return refreshSite(btih, Boolean(force));
  }

  async function broadcast(msg) {
    if (!env.clients || typeof env.clients.matchAll !== 'function') return;
    let list = [];
    try {
      list = await env.clients.matchAll({ type: 'window', includeUncontrolled: true });
    } catch (_) {
      return;
    }
    for (const c of list) {
      try {
        c.postMessage(Object.assign({ proto }, msg));
      } catch (_) { /* client gone */ }
    }
  }

  // Verification failed: delete the site and everything stamped with it (deleteSite), tell pages.
  function dropSite(btih, reason, path) {
    const running = state.dropping.get(btih);
    if (running) return running;
    state.bad.add(btih);
    state.sites.delete(btih);
    state.verified.delete(btih);
    state.drops.push({ btih, reason, path: path || null, at: env.now() });
    if (state.drops.length > 10) state.drops.shift();
    log('removed cached site ' + btih + ' (' + reason + ')');
    const job = (async () => {
      try {
        await storage.deleteSite(btih);
      } catch (_) { /* best effort */ }
      await broadcast({ type: 'mw-site-invalid', btih, reason, path: path || null });
    })();
    state.dropping.set(btih, job);
    const clear = () => {
      if (state.dropping.get(btih) === job) state.dropping.delete(btih);
    };
    job.then(clear, clear);
    return job;
  }

  // Data is missing (not a mismatch): stop serving the site in this instance and say so, but keep
  // the stored copy (a later message or refresh brings it back).
  function markUnusable(btih, path) {
    if (state.bad.has(btih)) return;
    state.bad.add(btih);
    state.sites.delete(btih);
    log('cached site ' + btih + ' is missing data for ' + path);
    broadcast({ type: 'mw-site-invalid', btih, reason: 'missing', path: path || null });
  }

  // ------------------------------------------------------------------- clients

  function mapClient(id, btih, event) {
    if (!id || !btih) return;
    if (state.clientMap.get(id) === btih) return;
    remember(state.clientMap, id, btih, limits.clientMapMax);
    schedulePersist(event);
  }

  // meta.clients mirrors the live part of the map so a restarted worker can serve mapped clients.
  function schedulePersist(event) {
    state.persistDirty = true;
    if (state.persistJob) {
      waitUntil(event, state.persistJob);
      return;
    }
    const job = (async () => {
      await delay(limits.persistDelayMs);
      state.persistDirty = false;
      let live = null;
      if (env.clients && typeof env.clients.matchAll === 'function') {
        try {
          const list = await env.clients.matchAll({ includeUncontrolled: true, type: 'all' });
          live = new Set(list.map((c) => c.id));
        } catch (_) {
          live = null;
        }
      }
      const out = {};
      state.clientMap.forEach((btih, id) => {
        if (!live || live.has(id)) out[id] = btih;
      });
      try {
        await storage.setMeta('clients', out);
      } catch (_) { /* best effort */ }
    })().catch(() => {});
    state.persistJob = job;
    const after = () => {
      state.persistJob = null;
      if (state.persistDirty) schedulePersist(null);
    };
    job.then(after, after);
    waitUntil(event, job);
  }

  // Synchronous: the btih this request's client renders, from memory only.
  function lookupBtih(event, req) {
    const id = event && event.clientId;
    if (id && state.clientMap.has(id)) return state.clientMap.get(id);
    const ref = stripHash(req.referrer);
    if (ref) {
      const btih = state.docMap.get(ref) || state.servedMap.get(ref);
      if (btih) {
        if (id) mapClient(id, btih, null);
        return btih;
      }
    }
    return null;
  }

  // Shell mode: is this subresource from a shell page (pass through) or from the site?
  async function classifyClient(event) {
    const id = event.clientId;
    if (!id || state.clientMap.has(id)) return 'site';
    if (state.shellClients.has(id)) return 'shell';
    let client = null;
    if (env.clients && typeof env.clients.get === 'function') {
      try {
        client = await env.clients.get(id);
      } catch (_) {
        client = null;
      }
    }
    if (client && client.type === 'window' && client.frameType !== 'nested') {
      remember(state.shellClients, id, true, limits.shellClientsMax);
      return 'shell';
    }
    if (state.current) mapClient(id, state.current.btih, null);
    return 'site';
  }

  function noteShellSource(event) {
    const src = event && event.source;
    if (src && typeof src.id === 'string' && (src.frameType === 'top-level' || src.frameType === 'auxiliary')) {
      remember(state.shellClients, src.id, true, limits.shellClientsMax);
    }
  }

  // ------------------------------------------------------------------- verification

  function verifiedSet(btih) {
    let set = state.verified.get(btih);
    if (!set) {
      set = new Set();
      state.verified.set(btih, set);
    }
    return set;
  }

  // Per-request memoised reads: one IndexedDB read per file, shared by piece checks and the body.
  function blobGetter(btih) {
    const memo = new Map();
    return (path) => {
      let p = memo.get(path);
      if (!p) {
        p = Promise.resolve().then(() => storage.getFile(btih, path)).then(asBlobValue).catch(() => null);
        memo.set(path, p);
      }
      return p;
    };
  }

  function verifyPiece(entry, index, get) {
    const key = entry.btih + ':' + index;
    let job = state.pieceJobs.get(key);
    if (!job) {
      job = (async () => {
        let bytes;
        try {
          bytes = await readPiece(entry.parsed, get, index);
        } catch (_) {
          return 'missing';
        }
        if (!(await checkPiece(entry.parsed, index, bytes))) return 'mismatch';
        verifiedSet(entry.btih).add(index);
        return 'ok';
      })().catch(() => 'missing');
      state.pieceJobs.set(key, job);
      const clear = () => {
        if (state.pieceJobs.get(key) === job) state.pieceJobs.delete(key);
      };
      job.then(clear, clear);
    }
    return job;
  }

  // SHA-1 of every piece covering bytes [first, last] of a file → 'ok' | 'mismatch' | 'missing'.
  // A whole-file response checks every piece of the file; a Range only the pieces it covers.
  async function verifyRange(entry, fileIndex, first, last, get) {
    const file = entry.files[fileIndex];
    if (!file || file.length === 0 || last < first) return 'ok';
    const P = entry.parsed.pieceLength;
    const p0 = Math.floor((file.offset + first) / P);
    const p1 = Math.floor((file.offset + last) / P);
    const done = verifiedSet(entry.btih);
    const todo = [];
    for (let i = p0; i <= p1; i++) if (!done.has(i)) todo.push(i);
    let result = 'ok';
    let next = 0;
    const worker = async () => {
      while (result === 'ok' && next < todo.length) {
        const r = await verifyPiece(entry, todo[next++], get);
        if (r !== 'ok' && result === 'ok') result = r;
      }
    };
    const workers = [];
    for (let w = 0; w < Math.min(limits.verifyConcurrency, todo.length); w++) workers.push(worker());
    await Promise.all(workers);
    return result;
  }

  // Routing manifest of a site: /.mw/site.json from the torrent (verified like any file), else the
  // routing the shell put in meta.current, else defaults.
  function getRouting(entry) {
    if (!entry.routingPromise) {
      entry.routingPromise = (async () => {
        const index = entry.pathIndex.get('.mw/site.json');
        if (index !== undefined) {
          const file = entry.files[index];
          if (file.length > 0 && file.length <= limits.maxRoutingBytes) {
            const get = blobGetter(entry.btih);
            const v = await verifyRange(entry, index, 0, file.length - 1, get);
            if (v === 'mismatch') {
              await dropSite(entry.btih, 'mismatch', '.mw/site.json');
            } else if (v === 'ok') {
              try {
                const blob = await get('.mw/site.json');
                return normalizeManifest(JSON.parse(await blob.text()));
              } catch (err) {
                log('ignoring an unreadable /.mw/site.json in ' + entry.btih);
              }
            }
          }
        }
        const cur = state.current;
        if (cur && cur.btih === entry.btih && cur.routing) return normalizeManifest(cur.routing);
        return normalizeManifest(null);
      })().catch(() => normalizeManifest(null));
    }
    return entry.routingPromise;
  }

  function contentTypeFor(entry, path) {
    const type = mimeFor(path);
    if (type !== OCTET) return type;
    return entry.types.get(path) || OCTET;
  }

  // The file at `path` of a site entry, verified, with Range → { response } | { failure }.
  async function serveEntryFile(req, entry, path, o) {
    const index = entry.pathIndex.get(path);
    const file = index === undefined ? null : entry.files[index];
    if (!file) return { failure: 'missing' };
    const size = file.length;
    const range = o.status === 200 ? parseRange(header(req, 'range'), size) : null;
    const first = range && range !== 416 ? range.start : 0;
    const last = range && range !== 416 ? range.end : size - 1;
    const get = blobGetter(entry.btih);
    if (range !== 416 && size > 0) {
      const v = await verifyRange(entry, index, first, last, get);
      if (v !== 'ok') return { failure: v };
    }
    const blob = await get(path);
    if (!blob || typeof blob.size !== 'number' || blob.size !== size) return { failure: 'missing' };
    const h = baseHeaders(o.kind);
    h.set('Content-Type', contentTypeFor(entry, path));
    applyRouteHeaders(h, o.routeHeaders, o.kind);
    if (range === 416) {
      h.set('Content-Range', 'bytes */' + size);
      return { response: new Response(null, { status: 416, statusText: 'Range Not Satisfiable', headers: h }) };
    }
    if (range) {
      h.set('Content-Range', 'bytes ' + first + '-' + last + '/' + size);
      h.set('Content-Length', String(last - first + 1));
      return { response: new Response(blob.slice(first, last + 1), { status: 206, statusText: 'Partial Content', headers: h }) };
    }
    h.set('Content-Length', String(size));
    return { response: new Response(blob, { status: o.status, statusText: o.status === 404 ? 'Not Found' : 'OK', headers: h }) };
  }

  // ------------------------------------------------------------------- shell and hub

  async function matchShell() {
    if (!env.caches) return null;
    for (const key of SHELL_KEYS) {
      try {
        const res = await env.caches.match(origin + key, { cacheName });
        if (res) return res;
      } catch (_) { /* try the next key */ }
    }
    return null;
  }

  // Caches /index.html as the shell when it is one (or when a shell page vouched for it).
  async function refreshShellCache(trusted) {
    if (!env.caches) return false;
    let res;
    try {
      res = await env.fetch(origin + '/index.html', { cache: 'no-cache', credentials: 'same-origin' });
    } catch (_) {
      return false;
    }
    if (!res || res.status !== 200) return false;
    let text = '';
    try {
      text = await res.text();
    } catch (_) {
      return false;
    }
    if (!isShellHtml(text) && !(trusted && /<html|<!doctype html/i.test(text))) return false;
    try {
      const cache = await env.caches.open(cacheName);
      await cache.put(origin + '/index.html', new Response(text, {
        headers: { 'Content-Type': (res.headers && res.headers.get('content-type')) || 'text/html; charset=utf-8' },
      }));
      return true;
    } catch (_) {
      return false;
    }
  }

  // The integrity attributes of a shell document name its loader build (build.mjs puts SRI on the
  // two static script tags). A shell from another build must never replace the precached one: its
  // scripts would not match the precached /_mw/ assets. The new build arrives with its own worker.
  function shellBuildMark(text) {
    const marks = [];
    const re = /\bintegrity\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(text)) !== null) marks.push(m[1]);
    return marks.sort().join(' ');
  }

  // Cache-first shell navigations keep the shell document of the day the worker installed, and with
  // it the page-tag pointer (<meta name="mw-pointer">). This re-fetches /index.html (no-cache), and
  // when the host still serves a shell of the same build (only deploy-time tags changed: a new
  // pointer after a publish), it replaces the cached copy so the next navigation uses it.
  // → { pointer: raw record text of the host's current page tag | null, replaced } or null.
  async function revalidateShell() {
    if (foreign || !env.caches) return null;
    state.lastShellCheck = env.now();
    let res;
    try {
      res = await env.fetch(origin + '/index.html', { cache: 'no-cache', credentials: 'same-origin' });
    } catch (_) {
      return null; // offline: keep what we have
    }
    if (!res || res.status !== 200) return null;
    let text = '';
    try {
      text = await res.text();
    } catch (_) {
      return null;
    }
    if (!isShellHtml(text)) return null; // the host no longer serves the shell (kill switch, plain site)
    let pointer = null;
    try {
      const record = stampedPointerFromHtml(text);
      pointer = record && typeof record.raw === 'string' ? record.raw : null;
    } catch (_) {
      pointer = null;
    }
    let replaced = false;
    try {
      const cached = await matchShell();
      const cachedText = cached ? await cached.text() : null;
      if (cachedText !== null && cachedText !== text && shellBuildMark(cachedText) === shellBuildMark(text)) {
        const cache = await env.caches.open(cacheName);
        await cache.put(origin + '/index.html', new Response(text, {
          headers: { 'Content-Type': (res.headers && res.headers.get('content-type')) || 'text/html; charset=utf-8' },
        }));
        replaced = true;
      }
    } catch (_) { /* keep the cached shell */ }
    return { pointer, replaced };
  }

  // COOP/COEP of the current site's routing manifest also go on the shell: cross-origin isolation
  // needs them on the top-level document too.
  async function isolationHeaders(h, url) {
    const cur = state.current;
    const entry = cur && state.sites.get(cur.btih);
    if (!entry) return;
    const routing = await withTimeout(getRouting(entry), 1000, null);
    if (!routing) return;
    const values = headersFor(routing, url.pathname);
    for (const name of Object.keys(values)) {
      const lower = name.toLowerCase();
      if (lower === 'cross-origin-opener-policy' || lower === 'cross-origin-embedder-policy') safeSet(h, name, values[name]);
    }
  }

  function maybeUpdate() {
    if (foreign) return;
    const t = env.now();
    if (t - state.lastUpdate < limits.updateThrottleMs) return;
    state.lastUpdate = t;
    const reg = env.registration;
    if (!reg || typeof reg.update !== 'function') return;
    try {
      const p = reg.update();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) { /* offline */ }
  }

  // C2 doors: the precached door page with the shell's framing and referrer headers; its own requests go to the network
  // (it is remembered as a shell client). Not precached yet: the host answers, else the offline page.
  async function serveDoorPage(event, req) {
    if (event.resultingClientId) remember(state.shellClients, event.resultingClientId, true, limits.shellClientsMax);
    let cached = null;
    if (env.caches) {
      try {
        cached = await env.caches.match(origin + DOOR_PAGE_PATH, { cacheName });
      } catch (_) {
        cached = null;
      }
    }
    if (!cached) {
      try {
        return await env.fetch(req);
      } catch (_) {
        return pageResponse(503, 'offline');
      }
    }
    const h = new Headers();
    h.set('Content-Type', (cached.headers && cached.headers.get('content-type')) || 'text/html; charset=utf-8');
    h.set('Content-Security-Policy', "frame-ancestors 'none'");
    h.set('X-Frame-Options', 'DENY');
    h.set('Referrer-Policy', 'no-referrer');
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('Cache-Control', 'no-cache');
    maybeUpdate();
    return new Response(cached.body, { status: 200, statusText: 'OK', headers: h });
  }

  async function serveShell(event, req, url) {
    if (event.resultingClientId) remember(state.shellClients, event.resultingClientId, true, limits.shellClientsMax);
    const cached = await matchShell();
    if (!cached) {
      // Not precached yet: the host answers every path with the shell (SPA fallback or 404.html).
      waitUntil(event, refreshShellCache(state.msgShell));
      try {
        return await env.fetch(req);
      } catch (_) {
        return pageResponse(503, 'offline');
      }
    }
    const h = new Headers();
    h.set('Content-Type', (cached.headers && cached.headers.get('content-type')) || 'text/html; charset=utf-8');
    h.set('Content-Security-Policy', "frame-ancestors 'none'");
    h.set('X-Frame-Options', 'DENY');
    h.set('Referrer-Policy', 'no-referrer');
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('Cache-Control', 'no-cache');
    navigationHeaders(h);
    await isolationHeaders(h, url);
    maybeUpdate();
    if (env.now() - state.lastShellCheck >= limits.shellRevalidateMs) waitUntil(event, revalidateShell());
    return new Response(cached.body, { status: 200, statusText: 'OK', headers: h });
  }

  function notReady(navigate) {
    return navigate ? pageResponse(503, 'notready') : textResponse(503, 'Site not loaded yet');
  }

  async function serveSite(event, req, url, ctx) {
    let entry = await siteEntry(ctx.btih, ctx.navigate);
    if (!entry && !ctx.prefix && state.current && state.current.btih !== ctx.btih) {
      entry = await siteEntry(state.current.btih, ctx.navigate); // the client's version is gone: current one
    }
    if (!entry) return notReady(ctx.navigate);
    const routing = await getRouting(entry);
    const r = applyRouting(routing, ctx.sitePath, (p) => entry.pathIndex.has(p), { navigate: ctx.navigate });
    if (r.redirect) {
      let loc = r.redirect;
      if (loc.charAt(0) === '/') {
        const q = loc.indexOf('?');
        loc = origin + ctx.prefix + encodePath(q >= 0 ? loc.slice(0, q) : loc) + (q >= 0 ? loc.slice(q) : url.search);
      }
      try {
        loc = new URL(loc, origin + '/').href;
      } catch (_) {
        return textResponse(500, 'Invalid redirect target');
      }
      const h = baseHeaders('site');
      applyRouteHeaders(h, r.headers, 'site');
      return redirectResponse(r.status, loc, h);
    }
    if (!r.path) {
      const h = baseHeaders('site');
      h.set('Content-Type', 'text/plain; charset=utf-8');
      return new Response('Not found', { status: 404, statusText: 'Not Found', headers: h });
    }
    const out = await serveEntryFile(req, entry, r.path, { status: r.status, routeHeaders: r.headers, kind: 'site' });
    if (out.failure) {
      if (out.failure === 'mismatch') waitUntil(event, dropSite(entry.btih, 'mismatch', r.path));
      else markUnusable(entry.btih, r.path);
      return ctx.navigate ? pageResponse(503, 'invalid') : textResponse(503, 'Site files failed verification');
    }
    if (event.resultingClientId && isNavigation(req)) mapClient(event.resultingClientId, entry.btih, event);
    if (ctx.navigate) navigationHeaders(out.response.headers);
    return out.response;
  }

  // v0.3 (R 2.3.1): GET /_mw/idp-return finishes the sign-in redirect round trip in the loader. Shell
  // mode: the loader document itself. Drop-in mode: a minimal page that loads the drop-in runtime.
  async function serveIdpReturn(event, req, url) {
    if (!state.initDone) await settle();
    const mode = foreign ? 'dropin' : (computeMode() || 'dropin');
    if (mode === 'shell') return serveShell(event, req, url);
    const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="mw-idp-return" content="1">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1"><title>Signing in</title>' +
      '<script type="module" src="/_mw/mw.js"></script></head><body><p>Signing in</p></body></html>';
    const h = new Headers({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
    });
    return new Response(html, { status: 200, statusText: 'OK', headers: navigationHeaders(h) });
  }

  async function serveShellSite(event, req, url) {
    const navigate = isNavigation(req);
    let btih = null;
    if (!navigate && event.clientId) {
      const mapped = state.clientMap.get(event.clientId);
      if (mapped) btih = mapped; // the version this document was rendered from (§3.4.5)
    }
    if (!btih && state.current) btih = state.current.btih;
    if (!btih) return notReady(navigate);
    return serveSite(event, req, url, { btih, sitePath: url.pathname, prefix: '', navigate });
  }

  function splitHub(pathname) {
    if (!under(pathname, paths.hubSite)) return null;
    return splitHubPath('/_mw/s/' + pathname.slice(paths.hubSite.length));
  }

  async function serveHub(event, req, url, hub) {
    if (isTopLevel(req)) {
      // Never render a hub site at top level: back to the gate, keeping the deep link.
      const deep = hub.path !== '/' || url.search ? '?p=' + encodeURIComponent(hub.path + url.search) : '';
      return redirectResponse(302, origin + '/' + deep + '#btih:' + hub.btih, null);
    }
    const prefix = paths.hubSite + hub.btih;
    if (url.pathname === prefix) return redirectResponse(301, origin + prefix + '/' + url.search, null);
    return serveSite(event, req, url, { btih: hub.btih, sitePath: hub.path, prefix, navigate: isNavigation(req) });
  }

  // ------------------------------------------------------------------- drop-in

  function dropinOwns(event, req, url) {
    if (!state.initDone) return false; // unsure right after a cold start: the host answers
    if (isNavigation(req) || DROPIN_PASS.has(req.destination)) return false;
    const btih = lookupBtih(event, req);
    if (!btih || state.bad.has(btih)) return false;
    const entry = state.sites.get(btih);
    if (!entry) {
      waitUntil(event, refreshSite(btih, false));
      return false;
    }
    return entry.pathIndex.has(decodePath(url.pathname).slice(1));
  }

  async function serveDropinFile(event, req, url) {
    if (!state.initDone) await settle();
    const btih = lookupBtih(event, req);
    const entry = btih && !state.bad.has(btih) ? state.sites.get(btih) : null;
    const path = decodePath(url.pathname).slice(1);
    if (!entry || !entry.pathIndex.has(path) || DROPIN_PASS.has(req.destination) || isNavigation(req)) return env.fetch(req);
    const routing = await getRouting(entry);
    const out = await serveEntryFile(req, entry, path, { status: 200, routeHeaders: headersFor(routing, url.pathname), kind: 'dropin' });
    if (out.failure) {
      if (out.failure === 'mismatch') waitUntil(event, dropSite(btih, 'mismatch', path));
      else markUnusable(btih, path);
      return env.fetch(req); // the host still has the file
    }
    if (req.destination === 'style') remember(state.servedMap, stripHash(url.href), btih, limits.docMapMax);
    return out.response;
  }

  function docKey(url) {
    return url.origin + url.pathname + url.search;
  }

  function mapNavigation(event, url, btih) {
    if (event.resultingClientId) mapClient(event.resultingClientId, btih, event);
    remember(state.docMap, docKey(url), btih, limits.docMapMax);
  }

  // Reads at most `max` bytes, mapping the client as soon as the stamped pointer is complete.
  async function peekPointer(body, max) {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    let record = null;
    try {
      while (total < max) {
        const r = await reader.read();
        if (r.done) break;
        const chunk = asBytes(r.value);
        if (!chunk || chunk.length === 0) continue;
        chunks.push(chunk);
        total += chunk.length;
        const buf = new Uint8Array(Math.min(total, max));
        let off = 0;
        for (const c of chunks) {
          if (off >= buf.length) break;
          const part = c.subarray(0, Math.min(c.length, buf.length - off));
          buf.set(part, off);
          off += part.length;
        }
        record = stampedPointerFromHtml(buf);
        if (record) break;
      }
    } finally {
      // Not awaited: cancelling one branch of a tee() resolves only when the other branches finish too
      // (the page reading the document), and this work must not wait for the page.
      try {
        const c = reader.cancel();
        if (c && typeof c.catch === 'function') c.catch(() => {});
      } catch (_) { /* done */ }
    }
    return record;
  }

  async function keepDocument(event, url, peek, keep, headers) {
    let btih = null;
    try {
      const record = await peekPointer(peek.body, limits.docPeekBytes);
      // A withdrawal (st= other than ok, v0.2.1 A3) maps the page to nothing and is not kept: its
      // requests go to the host, never to a stored peer-to-peer copy (the page's engine deletes them).
      btih = record && !record.withdrawn ? record.btih : null;
    } catch (_) {
      btih = null;
    }
    if (btih) {
      mapNavigation(event, url, btih);
      if (!state.sites.has(btih) && !state.bad.has(btih)) waitUntil(event, refreshSite(btih, false));
    }
    if (!keep) return;
    if (!btih) {
      try {
        await keep.body.cancel();
      } catch (_) { /* done */ }
      return;
    }
    try {
      const body = await keep.blob();
      const key = docKey(url);
      await storage.putDoc(key, { url: key, body, headers: storableHeaders(headers), btih, savedAt: env.now(), size: body.size }, limits);
    } catch (err) {
      log('could not keep a page for offline use: ' + errText(err));
    }
  }

  // Rule (a): navigations go to the network untouched; the response is cloned (a tee) to read the
  // stamped pointer and to keep the page for offline use; offline, the kept copy is served.
  async function serveDropinNavigation(event, req, url) {
    let res;
    try {
      res = await env.fetch(req);
    } catch (err) {
      let doc = null;
      try {
        doc = await storage.getDoc(docKey(url));
      } catch (_) {
        doc = null;
      }
      if (doc && doc.body) {
        if (doc.btih) mapNavigation(event, url, doc.btih);
        const h = new Headers();
        const kept = doc.headers && typeof doc.headers === 'object' ? doc.headers : {};
        for (const name of Object.keys(kept)) safeSet(h, name, kept[name]);
        if (!h.has('content-type')) h.set('Content-Type', 'text/html; charset=utf-8');
        return new Response(doc.body, { status: 200, statusText: 'OK', headers: navigationHeaders(h) });
      }
      return pageResponse(503, 'offline');
    }
    if (res && res.status === 200 && res.body && (res.type === 'basic' || res.type === 'default') && isHtmlResponse(res)) {
      const noStore = hasNoStore(res);
      // D4: a no-store document is never kept, and its page runs host-only (Chromium keeps a no-store
      // page out of the back/forward cache for life after any WebSocket or WebRTC use).
      if (event.resultingClientId) remember(state.docInfo, event.resultingClientId, { noStore, at: env.now() }, limits.docInfoMax);
      const peek = res.clone();
      const keep = noStore ? null : res.clone();
      waitUntil(event, keepDocument(event, url, peek, keep, res.headers));
    }
    return res;
  }

  // ------------------------------------------------------------------- web seed and assets

  // Whole host files are kept per (version, URL): a deploy changes a file under the same URL (an
  // un-hashed data.json), and the page downloading the new version must never be handed the bytes
  // fetched for the previous one (their pieces would fail verification until the entry expired).
  function keepWebseedBlob(key, blob) {
    if (blob.size > limits.webseedCacheBytes || blob.size > limits.webseedWholeMaxBytes) return;
    const old = state.wsBlobs.get(key);
    if (old) {
      state.wsBytes -= old.blob.size;
      state.wsBlobs.delete(key);
    }
    state.wsBlobs.set(key, { blob, at: env.now() });
    state.wsBytes += blob.size;
    const t = env.now();
    for (const [key, value] of state.wsBlobs) {
      if (state.wsBytes <= limits.webseedCacheBytes && t - value.at < limits.webseedCacheMs) break;
      state.wsBlobs.delete(key);
      state.wsBytes -= value.blob.size;
    }
  }

  // One host download per file and version however many piece ranges WebTorrent asks for at once.
  function wholeFile(href, version) {
    const key = (version || '') + ' ' + href;
    const hit = state.wsBlobs.get(key);
    if (hit && env.now() - hit.at < limits.webseedCacheMs) return Promise.resolve(hit.blob);
    const running = state.wsJobs.get(key);
    if (running) return running;
    const job = (async () => {
      const res = await env.fetch(href, { cache: 'force-cache', credentials: 'same-origin', redirect: 'follow' });
      if (!res || res.status !== 200) {
        const err = new Error('the host answered ' + (res ? res.status : 'nothing') + ' for ' + href);
        err.status = res ? res.status : 0;
        throw err;
      }
      const blob = await res.blob();
      // D4: a no-store answer is never kept (concurrent requests still share this one download).
      if (!hasNoStore(res)) keepWebseedBlob(key, blob);
      return blob;
    })();
    state.wsJobs.set(key, job);
    const clear = () => {
      if (state.wsJobs.get(key) === job) state.wsJobs.delete(key);
    };
    job.then(clear, clear);
    return job;
  }

  // The torrent of a version for the web-seed rewrite: the stored copy's, or (a first download, nothing
  // stored yet) the host's own /_mw/t/<btih>.torrent (the drop-in xs=), whose infohash must be the btih.
  async function webseedTorrent(version) {
    if (!version) return null;
    const stored = state.sites.get(version);
    if (stored) return stored;
    const hit = state.wsTorrents.get(version);
    if (hit) return hit;
    let entry = null;
    try {
      const res = await env.fetch(origin + paths.torrents + version + '.torrent', { cache: 'no-cache', credentials: 'same-origin', redirect: 'follow' });
      if (res && res.status === 200) {
        const parsed = await parseTorrent(new Uint8Array(await res.arrayBuffer()));
        if (parsed && String(parsed.infoHash).toLowerCase() === version) {
          const pathIndex = new Map();
          parsed.files.forEach((f, i) => {
            if (!f.pad && !pathIndex.has(f.path)) pathIndex.set(f.path, i);
          });
          entry = { btih: version, name: parsed.name, files: parsed.files, pathIndex };
        }
      }
    } catch (_) {
      entry = null;
    }
    if (entry) remember(state.wsTorrents, version, entry, limits.webseedTorrentsMax);
    return entry;
  }

  // BEP 47 pad files of a torrent: path → length (WebTorrent's web connection asks a web seed for them).
  function padLengthOf(entry, relPath) {
    if (!entry || !Array.isArray(entry.files)) return null;
    for (const f of entry.files) if (f.pad && f.path === relPath) return f.length;
    return null;
  }

  // Code review round 1: what the rewrite answers is never a page: no host HTML, SVG or XML rendered
  // without the host's own headers (CSP, X-Frame-Options, Content-Disposition), so every answer is
  // opaque bytes for the engine that asked.
  function webseedHeaders() {
    const h = new Headers();
    h.set('Content-Type', OCTET);
    h.set('Accept-Ranges', 'bytes');
    h.set('Cache-Control', 'no-store');
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('Content-Security-Policy', "sandbox; default-src 'none'");
    h.set('Cross-Origin-Resource-Policy', 'same-origin');
    return h;
  }

  // A BEP 47 pad file is zeros by definition; no host serves one (code review round 1).
  function zeroRange(req, length) {
    const range = parseRange(header(req, 'range'), length);
    const h = webseedHeaders();
    if (range === 416) {
      h.set('Content-Range', 'bytes */' + length);
      return new Response(null, { status: 416, statusText: 'Range Not Satisfiable', headers: h });
    }
    if (range) {
      const n = range.end - range.start + 1;
      h.set('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + length);
      h.set('Content-Length', String(n));
      return new Response(new Uint8Array(n), { status: 206, statusText: 'Partial Content', headers: h });
    }
    h.set('Content-Length', String(length));
    return new Response(new Uint8Array(length), { status: 200, statusText: 'OK', headers: h });
  }

  // /_mw/ws/<torrent name>/<path> → /<path> on this origin, sliced to the requested Range (3.4.7).
  // The torrent name is the same for every version; the version is the one the requesting page
  // renders (its client mapping), which is the version its engine downloads. Code review round 1:
  // only a path that version's torrent lists is fetched (anything else is 404, never a fetch of an
  // arbitrary host URL), and a BEP 47 pad file is answered with zeros.
  async function serveWebseed(event, req, url) {
    const rest = url.pathname.slice(paths.webseedRewrite.length);
    const slash = rest.indexOf('/');
    if (slash <= 0 || slash === rest.length - 1) return textResponse(404, 'Not found');
    const target = origin + '/' + rest.slice(slash + 1);
    let version = null;
    try {
      version = lookupBtih(event, req);
    } catch (_) {
      version = null;
    }
    const entry = await webseedTorrent(version);
    let rel = null;
    let name = null;
    try {
      rel = decodePath('/' + rest.slice(slash + 1)).slice(1);
      name = decodeURIComponent(rest.slice(0, slash));
    } catch (_) {
      rel = null;
    }
    if (!entry || rel === null || (entry.name && name !== entry.name)) return textResponse(404, 'Not found');
    const padLength = entry.pathIndex.has(rel) ? null : padLengthOf(entry, rel);
    if (padLength !== null) return zeroRange(req, padLength);
    if (!entry.pathIndex.has(rel)) return textResponse(404, 'Not found');
    // D4: a file too large to hold in memory is not fetched whole for every piece: the Range goes to
    // the host (same origin, no CORS). A host that ignores Range (200) falls back to the whole file.
    const knownSize = entry.files[entry.pathIndex.get(rel)].length;
    const rangeHeader = header(req, 'range');
    if (knownSize !== null && knownSize > limits.webseedWholeMaxBytes && rangeHeader) {
      let res = null;
      try {
        res = await env.fetch(target, { headers: { range: rangeHeader }, cache: 'no-store', credentials: 'same-origin', redirect: 'follow' });
      } catch (_) {
        res = null;
      }
      if (res && res.status === 206) {
        const h = webseedHeaders();
        const cr = res.headers.get('content-range');
        if (cr) h.set('Content-Range', cr);
        const cl = res.headers.get('content-length');
        if (cl) h.set('Content-Length', cl);
        return new Response(res.body, { status: 206, statusText: 'Partial Content', headers: h });
      }
      if (res && res.body) {
        try {
          await res.body.cancel();
        } catch (_) { /* done */ }
      }
    }
    let blob;
    try {
      blob = await wholeFile(target, version);
    } catch (err) {
      return textResponse(err && err.status === 404 ? 404 : 502, 'Web seed source unavailable');
    }
    const size = blob.size;
    const range = parseRange(header(req, 'range'), size);
    const h = webseedHeaders();
    if (range === 416) {
      h.set('Content-Range', 'bytes */' + size);
      return new Response(null, { status: 416, statusText: 'Range Not Satisfiable', headers: h });
    }
    if (range) {
      h.set('Content-Range', 'bytes ' + range.start + '-' + range.end + '/' + size);
      h.set('Content-Length', String(range.end - range.start + 1));
      return new Response(blob.slice(range.start, range.end + 1), { status: 206, statusText: 'Partial Content', headers: h });
    }
    h.set('Content-Length', String(size));
    return new Response(blob, { status: 200, statusText: 'OK', headers: h });
  }

  async function cleanResponse(res) {
    if (!res.redirected) return res;
    const body = await res.blob();
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  }

  async function putAsset(path, res) {
    try {
      const cache = await env.caches.open(cacheName);
      await cache.put(origin + path, await cleanResponse(res));
    } catch (_) { /* quota or Lockdown Mode: serve from the network next time */ }
  }

  // /_mw/* loader assets: cache-first; a miss (webtorrent.min.js, icons) is fetched and kept.
  async function serveAsset(event, req, url) {
    if (env.caches) {
      try {
        const hit = await env.caches.match(origin + url.pathname, { cacheName });
        if (hit) {
          maybeUpdate();
          return hit;
        }
      } catch (_) { /* fall through to the network */ }
    }
    let res;
    try {
      res = await env.fetch(req);
    } catch (err) {
      return isNavigation(req) ? pageResponse(503, 'offline') : Response.error();
    }
    // Code review round 1: an asset outside the precache that has a build-time hash (webtorrent.min.js,
    // the bundle that parses every peer and web-seed byte) is checked before it is kept or served, so a
    // mixed deploy or a stale CDN copy cannot stay cached for the life of the build.
    const want = integrity[url.pathname];
    if (want && res && res.status === 200) {
      let body;
      try {
        body = await res.arrayBuffer();
      } catch (_) {
        return Response.error();
      }
      if (!(await integrityMatches(body, want))) {
        state.assetsRefused = (state.assetsRefused || 0) + 1;
        log(url.pathname + ': the bytes do not match the build (' + want.slice(0, 22) + '...), not served or kept: a mixed deploy or a stale CDN copy');
        return new Response('felinar: ' + url.pathname + ' does not match this build\n', {
          status: 502,
          statusText: 'Bad Gateway',
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
        });
      }
      const ok = new Response(body, { status: 200, statusText: 'OK', headers: res.headers });
      if (env.caches && !hasNoStore(res)) waitUntil(event, putAsset(url.pathname, ok.clone()));
      return ok;
    }
    if (env.caches && res && res.status === 200 && (res.type === 'basic' || res.type === 'default') && !hasNoStore(res)) {
      waitUntil(event, putAsset(url.pathname, res.clone()));
    }
    return res;
  }

  async function cleanupOldCaches() {
    if (!env.caches) return;
    try {
      const names = await env.caches.keys();
      await Promise.all(names.filter((n) => n.indexOf(SHELL_CACHE_PREFIX) === 0 && n !== cacheName).map((n) => env.caches.delete(n)));
    } catch (_) { /* best effort */ }
  }

  // ------------------------------------------------------------------- lifecycle

  // D2: the critical set (the JS and CSS with a build-time hash) all-or-nothing. Each entry is fetched
  // with Request.integrity and its hash checked again; one failure deletes the half-filled cache and
  // rejects, so the install fails and the previous worker stays in control.
  async function precacheCritical(cache, list = precache) {
    const critical = list.filter((p) => integrity[p]);
    if (!critical.length) return [];
    try {
      await Promise.all(critical.map(async (path) => {
        let res;
        try {
          // 'no-cache' (code review round 1, was 'reload'): revalidate the copy the page just fetched
          // instead of downloading it again; the integrity check still guards the bytes.
          res = await env.fetch(origin + path, { cache: 'no-cache', credentials: 'same-origin', integrity: integrity[path] });
        } catch (err) {
          throw new Error(path + ': ' + errText(err) + ' (network error or integrity mismatch)');
        }
        if (!res || res.status !== 200) throw new Error(path + ': HTTP ' + (res ? res.status : 'no answer'));
        const body = await res.arrayBuffer();
        if (!(await integrityMatches(body, integrity[path]))) throw new Error(path + ': the bytes do not match the build (' + integrity[path].slice(0, 22) + '...): a mixed deploy or a stale CDN copy');
        const headers = new Headers();
        const type = res.headers && res.headers.get('content-type');
        if (type) headers.set('Content-Type', type);
        await cache.put(origin + path, new Response(body, { status: 200, statusText: 'OK', headers }));
      }));
    } catch (err) {
      try {
        await env.caches.delete(cacheName);
      } catch (_) { /* nothing to delete */ }
      state.installFailed = errText(err);
      throw err;
    }
    return critical;
  }

  // Code review round 1 (F47): each mode loads its own files, so the install fetches /index.html first
  // (the loader shell, or the site's own page in drop-in mode) and precaches only that mode's list; when
  // /index.html does not answer, everything, as before. A drop-in page never loads the shell loader, and
  // a shell never loads mw.js; sw-core.js is fetched by a site's own worker, never from this cache.
  const DROPIN_PRECACHE = new Set(['/_mw/mw.js', '/_mw/sdk.js', '/_mw/pow-worker.js']);
  const NOT_FOR_SHELL = new Set(['/_mw/mw.js', '/_mw/sw-core.js']);
  function precacheFor(mode) {
    if (mode === 'dropin') return precache.filter((p) => DROPIN_PRECACHE.has(p));
    if (mode === 'shell') return precache.filter((p) => !NOT_FOR_SHELL.has(p));
    return precache.slice();
  }

  async function detectInstallMode() {
    if (precache.indexOf('/index.html') < 0) return { mode: null, shell: null };
    try {
      const res = await env.fetch(origin + '/index.html', { cache: 'no-cache', credentials: 'same-origin' });
      if (!res || res.status !== 200) return { mode: null, shell: null };
      const text = await res.text();
      if (!isShellHtml(text)) return { mode: 'dropin', shell: null };
      return { mode: 'shell', shell: { text, type: (res.headers && res.headers.get('content-type')) || 'text/html; charset=utf-8' } };
    } catch (_) {
      return { mode: null, shell: null };
    }
  }

  async function precacheAll() {
    if (!env.caches) return;
    const cache = await env.caches.open(cacheName);
    const detected = await detectInstallMode();
    state.installMode = detected.mode;
    const list = precacheFor(detected.mode);
    const done = await precacheCritical(cache, list);
    let shell = detected.mode === null ? null : detected.mode === 'shell'; // true: /index.html is the loader shell
    if (detected.shell) {
      try {
        await cache.put(origin + '/index.html', new Response(detected.shell.text, { headers: { 'Content-Type': detected.shell.type } }));
      } catch (_) { /* skip */ }
    }
    await Promise.all(list.filter((p) => done.indexOf(p) < 0 && !(detected.mode !== null && p === '/index.html')).map(async (path) => {
      let res;
      try {
        res = await env.fetch(origin + path, { cache: 'no-cache', credentials: 'same-origin' });
      } catch (_) {
        return;
      }
      if (!res || res.status !== 200) return;
      if (under(path, paths.assets)) {
        try {
          await cache.put(origin + path, await cleanResponse(res));
        } catch (_) { /* skip this asset */ }
        return;
      }
      // A document outside /_mw/ is kept only when it is the loader shell: on a drop-in site
      // /index.html is the site's own home page and must never be served for every URL.
      let text = '';
      try {
        text = await res.text();
      } catch (_) {
        return;
      }
      if (isShellHtml(text)) {
        shell = true;
        try {
          await cache.put(origin + path, new Response(text, {
            headers: { 'Content-Type': (res.headers && res.headers.get('content-type')) || 'text/html; charset=utf-8' },
          }));
        } catch (_) { /* skip */ }
      } else if (shell !== true) {
        shell = false;
      }
    }));
    if (shell !== null) await writeModeMark(shell ? 'shell' : 'dropin');
  }

  function install(event) {
    try {
      const p = env.skipWaiting();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_) { /* not a worker */ }
    // D2: a failed critical precache rejects the install (the previous worker keeps serving); the
    // rest stays best-effort. The rejection reaches event.waitUntil unchanged.
    const work = precacheAll().catch((err) => {
      log('install aborted: ' + errText(err));
      throw err;
    });
    if (event && typeof event.waitUntil === 'function') {
      try {
        event.waitUntil(work);
      } catch (_) { /* the event already finished */ }
    }
    return work;
  }

  function activate(event) {
    const work = (async () => {
      await cleanupOldCaches();
      if (env.clients && typeof env.clients.claim === 'function') {
        try {
          await env.clients.claim();
        } catch (_) { /* best effort */ }
      }
      await init();
    })();
    waitUntil(event, work);
    return work;
  }

  // ------------------------------------------------------------------- fetch

  function owns(event) {
    const req = event && event.request;
    if (!req || req.method !== 'GET') return false;
    let url;
    try {
      url = new URL(req.url);
    } catch (_) {
      return false;
    }
    if (url.origin !== origin) return false;
    if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return false;
    if (!state.initPromise) init();
    const p = url.pathname;
    if (p === paths.sw || under(p, paths.torrents) || under(p, paths.devWebseed)) return false;
    if (p === DOOR_JSON_PATH) return false; // C2 doors: a probe of this address must reach the network
    if (p === KEEPALIVE_PATH) return true;
    // Code review round 1: the rewrite is for the engine's fetches only; a navigation or a document,
    // worker or manifest load of /_mw/ws/... is not ours (the host answers it, normally 404).
    if (under(p, paths.webseedRewrite)) return !isNavigation(req) && !DROPIN_PASS.has(req.destination);
    if (splitHub(p)) return !foreign;
    if (under(p, paths.assets)) return true;
    if (foreign) return dropinOwns(event, req, url);
    if (isNavigation(req)) return true; // shell: the shell or a site document; drop-in: rule (a)
    const mode = state.mode;
    if (mode === 'dropin') return dropinOwns(event, req, url);
    if (mode === 'shell') return !(event.clientId && state.shellClients.has(event.clientId));
    return true; // mode not known yet (cold start): handle() waits for the index, then decides
  }

  async function route(event, req, url) {
    const p = url.pathname;
    if (p === KEEPALIVE_PATH) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
    // v0.3: reserved routes before everything else, the navigation catch-all included (MF-47, MF-48)
    const reserved = reservedRoute(p);
    if (reserved && reserved.kind === 'idp-return') return serveIdpReturn(event, req, url);
    if (reserved) return mediaRoute.handle(event, req, url);
    if (under(p, paths.webseedRewrite)) return serveWebseed(event, req, url);
    const hub = splitHub(p);
    if (hub && !foreign) return serveHub(event, req, url, hub);
    if (p === DOOR_PAGE_PATH && !foreign && isNavigation(req)) return serveDoorPage(event, req); // C2 doors
    if (under(p, paths.assets)) return serveAsset(event, req, url);
    if (!state.initDone) {
      if (isNavigation(req) || foreign) await settle();
      else {
        // D4: right after a cold start a subresource waits a bounded time. The mode mark is one Cache
        // Storage read; a shell origin then waits for the index (its files exist only in the torrent),
        // a drop-in origin waits at most coldStartWaitMs in all and then lets the host answer.
        const t0 = env.now();
        await withTimeout(modeMark(), limits.coldStartWaitMs, null);
        if (state.modeFromCache === 'shell' || state.msgShell) await settle();
        else await withTimeout(init(), Math.max(0, limits.coldStartWaitMs - (env.now() - t0)), null);
        if (!state.initDone) return env.fetch(req);
      }
    }
    if (foreign) return serveDropinFile(event, req, url);
    const mode = computeMode() || 'dropin';
    if (mode === 'shell') {
      if (isTopLevel(req)) return serveShell(event, req, url);
      if (!isNavigation(req) && (await classifyClient(event)) === 'shell') return env.fetch(req);
      return serveShellSite(event, req, url);
    }
    if (isNavigation(req)) return serveDropinNavigation(event, req, url);
    if (dropinOwns(event, req, url)) return serveDropinFile(event, req, url);
    return env.fetch(req);
  }

  // D1 reload-loop guard: may the interstitial for this URL reload itself once more?
  function guardAllows(key) {
    const t = env.now();
    const recent = (state.guard.get(key) || []).filter((at) => t - at < limits.reloadGuardWindowMs);
    const allowed = recent.length < limits.reloadGuardMax;
    if (allowed) recent.push(t);
    remember(state.guard, key, recent, limits.reloadGuardMaxUrls);
    return allowed;
  }

  // D1: the answer for a navigation that missed the deadline.
  function interstitial(url) {
    const key = url.origin + url.pathname + url.search;
    return guardAllows(key) ? pageResponse(503, 'slow', { refreshS: limits.interstitialRetryS }) : pageResponse(503, 'slowStopped');
  }

  // D2: a navigation whose handling failed goes to the network (fail open), then to an offline page.
  // A frame navigation of shell mode is the exception: the host answers it with the shell itself.
  async function failOpen(req) {
    if (!foreign && state.mode === 'shell' && !isTopLevel(req)) return pageResponse(500, 'error');
    try {
      return await env.fetch(req);
    } catch (_) {
      return pageResponse(503, 'offline');
    }
  }

  async function answer(event, req, url) {
    try {
      return await route(event, req, url);
    } catch (err) {
      log('request failed: ' + errText(err));
      if (isNavigation(req)) return failOpen(req);
      if (foreign || state.mode !== 'shell') {
        try {
          return await env.fetch(req);
        } catch (_) {
          return Response.error();
        }
      }
      return textResponse(500, 'Internal error');
    }
  }

  async function handle(event) {
    const req = event && event.request;
    let url;
    try {
      url = new URL(req.url);
    } catch (_) {
      return Response.error();
    }
    const work = answer(event, req, url);
    if (!isNavigation(req)) return work;
    // D1: every navigation is answered within the deadline, whatever the work is waiting for.
    let timer = null;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), limits.navigationDeadlineMs);
    });
    const first = await Promise.race([work, late]);
    clearTimeout(timer);
    if (first) return first;
    log('a navigation took longer than ' + limits.navigationDeadlineMs + ' ms: answered with the interstitial');
    waitUntil(event, work);
    return interstitial(url);
  }

  // ------------------------------------------------------------------- messages

  function postReply(event, msg) {
    try {
      const port = event.ports && event.ports[0];
      if (port && typeof port.postMessage === 'function') port.postMessage(msg);
      else if (event.source && typeof event.source.postMessage === 'function') event.source.postMessage(msg);
    } catch (_) { /* the page went away */ }
  }

  async function ensureShellCached() {
    if (foreign || (await matchShell())) return;
    await refreshShellCache(true);
  }

  async function setCurrent(data, event) {
    const btih = normalizeBtih(data.btih);
    if (!btih) return { ok: false, error: 'btih' };
    // C2 doors: the door page shows other origins' sites; none of them becomes this origin's current site.
    if (event && event.source && typeof event.source.url === 'string') {
      let from = null;
      try {
        from = new URL(event.source.url).pathname;
      } catch (_) {
        from = null;
      }
      if (from === DOOR_PAGE_PATH) return { ok: false, error: 'door-page' };
    }
    await settle();
    const prev = state.current && state.current.btih === btih ? state.current : null;
    state.current = {
      btih,
      ledgerId: typeof data.ledgerId === 'string' && data.ledgerId ? data.ledgerId : (prev ? prev.ledgerId : null),
      routing: data.routing && typeof data.routing === 'object' ? data.routing : (prev ? prev.routing : null),
    };
    state.msgShell = true;
    computeMode();
    noteShellSource(event);
    const entry = await refreshSite(btih, true);
    try {
      const stored = await storage.getMeta('current');
      const same = stored && typeof stored === 'object' && normalizeBtih(stored.btih) === btih;
      const next = {
        btih,
        ledgerId: state.current.ledgerId || (same && stored.ledgerId) || null,
        routing: state.current.routing || (same && stored.routing) || null,
      };
      if (!same || stored.ledgerId !== next.ledgerId || stored.routing !== next.routing) await storage.setMeta('current', next);
    } catch (_) { /* the loader writes meta.current too */ }
    await writeModeMark('shell');
    await ensureShellCached();
    return { ok: true, btih, complete: Boolean(entry) };
  }

  async function mapClientMessage(data, event) {
    const btih = normalizeBtih(data.btih);
    const id = typeof data.clientId === 'string' && data.clientId ? data.clientId
      : (event.source && typeof event.source.id === 'string' ? event.source.id : null);
    if (!btih) return { ok: false, error: 'btih' };
    if (!id) return { ok: false, error: 'client' };
    await settle();
    mapClient(id, btih, event);
    let entry = state.sites.get(btih);
    if (!entry || state.bad.has(btih)) entry = await refreshSite(btih, true);
    return { ok: true, btih, clientId: id, complete: Boolean(entry), doc: docInfoFor(id) };
  }

  // D4: what this worker saw of a client's navigation ({ noStore }), or null when it did not see it
  // (the first, uncontrolled page view, or a worker that restarted since: the page then assumes ordinary).
  function docInfoFor(clientId) {
    const info = clientId ? state.docInfo.get(clientId) : null;
    return info ? { noStore: Boolean(info.noStore) } : null;
  }

  async function siteSaved(data) {
    const btih = normalizeBtih(data.btih);
    if (!btih) return { ok: false, error: 'btih' };
    await settle();
    const entry = await refreshSite(btih, true);
    return { ok: true, btih, complete: Boolean(entry) };
  }

  async function clientCounts() {
    let live = null;
    if (env.clients && typeof env.clients.matchAll === 'function') {
      try {
        const list = await env.clients.matchAll({ includeUncontrolled: true, type: 'all' });
        live = new Set(list.map((c) => c.id));
      } catch (_) {
        live = null;
      }
    }
    const counts = {};
    state.clientMap.forEach((btih, id) => {
      if (!live || live.has(id)) counts[btih] = (counts[btih] || 0) + 1;
    });
    return counts;
  }

  /**
   * message(event): { proto, type } messages from pages (§7.1).
   *   mw-ping                          → { proto, type: 'mw-pong', buildId, mode, foreign } (any proto)
   *   mw-set-current { btih, ledgerId?, routing? }   shell: the origin's current site → mw-ack
   *   mw-map-client { clientId?, btih }  drop-in: this client renders btih (clientId defaults to
   *                                      the sender) → mw-ack
   *   mw-site-saved { btih }             re-read a site the page just stored → mw-ack
   *   mw-get-clients                     → { type: 'mw-clients', clients: { btih: liveCount }, current }
   *   mw-keepalive                       v0.2.1 D1: → mw-ack { ok, buildId } (the event keeps the worker alive)
   *   mw-doc-info                        v0.2.1 D4: → mw-ack { ok, doc: { noStore } | null } for the sender
   *   mw-session-register { sid, kind, exp, M?, fk?, file? }   v0.3: a media or file session (media-route.js)
   *   mw-session-close { sid } | { all: true }                 v0.3: → mw-ack { ok, closed }
   * mw-map-client's ack also carries doc. The full list is src/sw/protocol.js.
   * Replies go to the transferred port when there is one, else to the sending client. A message
   * with another proto gets mw-ack { ok: false, error: 'proto' }. Pushed by the worker:
   *   mw-site-invalid { btih, reason, path }   cached files failed verification or are missing
   */
  function message(event) {
    if (!event || typeof event !== 'object' || HANDLED.has(event)) return false;
    const data = event.data;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string' || data.type.indexOf('mw-') !== 0) return false;
    HANDLED.add(event);
    if (!state.initPromise) init();
    const reply = (msg) => postReply(event, Object.assign({ proto }, msg));
    if (data.type === 'mw-ping') {
      if (data.proto === proto) noteShellSource(event);
      reply({ type: 'mw-pong', buildId, mode: state.mode, foreign });
      return true;
    }
    if (data.proto !== proto || !checkProto(data).ok) {
      reply({ type: 'mw-ack', of: data.type, ok: false, error: 'proto', expected: proto });
      return true;
    }
    let work;
    if (data.type === 'mw-set-current') work = setCurrent(data, event);
    else if (data.type === 'mw-map-client') work = mapClientMessage(data, event);
    else if (data.type === 'mw-site-saved') work = siteSaved(data);
    else if (data.type === 'mw-shell-check') {
      // The shell page asks for the host's current page tag (a publish since this worker installed).
      work = revalidateShell().then((r) => ({ ok: !!r, pointer: r ? r.pointer : null, replaced: !!(r && r.replaced) }));
    }
    else if (data.type === 'mw-get-clients') {
      work = clientCounts().then((clients) => ({ type: 'mw-clients', clients, current: state.current ? state.current.btih : null }));
    } else if (data.type === MSG.keepalive) {
      // D1: the message event itself keeps the worker alive; nothing else to do.
      work = Promise.resolve({ ok: true, buildId });
    } else if (data.type === MSG.docInfo) {
      const id = event.source && typeof event.source.id === 'string' ? event.source.id : null;
      work = Promise.resolve({ ok: true, doc: docInfoFor(id) });
    } else if (data.type === MSG.sessionRegister) {
      // v0.3: a media or file session with its private port (event.ports[0], which carries the ack too)
      work = mediaRoute.register(data, event);
    } else if (data.type === MSG.sessionClose) {
      work = Promise.resolve(mediaRoute.close(data, event));
    } else {
      reply({ type: 'mw-ack', of: data.type, ok: false, error: 'unknown-type' });
      return true;
    }
    const done = work.then(
      (r) => reply(r && r.type ? r : Object.assign({ type: 'mw-ack', of: data.type }, r)),
      (err) => reply({ type: 'mw-ack', of: data.type, ok: false, error: errText(err) }),
    );
    waitUntil(event, done);
    return true;
  }

  /**
   * messageError(event): a page's message this worker could not read ('messageerror': a value that cloned in the page and not
   * here, such as a CryptoKey on some engines; G-MD-6). The sending client hears mw-message-error at once, so a pending
   * session register retries with the raw key bytes instead of waiting for its timeout (code review v0.3, round 2).
   */
  function messageError(event) {
    const src = event && event.source;
    if (!src || typeof src.postMessage !== 'function') return false;
    try {
      src.postMessage({ proto, type: MSG.messageError });
    } catch (_) {
      return false;
    }
    return true;
  }

  function inspect() {
    return {
      buildId,
      proto,
      foreign,
      cacheName,
      mode: state.mode,
      initDone: state.initDone,
      current: state.current ? state.current.btih : null,
      sites: Array.from(state.sites.keys()),
      bad: Array.from(state.bad),
      clients: state.clientMap.size,
      shellClients: state.shellClients.size,
      drops: state.drops.slice(),
      precache: precache.slice(),
      integrity: Object.keys(integrity).length,
      installFailed: state.installFailed,
      installMode: state.installMode || null,
      assetsRefused: state.assetsRefused || 0,
      docInfo: state.docInfo.size,
      limits: { navigationDeadlineMs: limits.navigationDeadlineMs, coldStartWaitMs: limits.coldStartWaitMs },
      media: mediaRoute.inspect(),
    };
  }

  return { install, activate, owns, handle, message, messageError, init, inspect };
}

// ---------------------------------------------------------------------------------------------
// /_mw/sw-core.js inside a site's own Service Worker (ARCHITECTURE §3.4.4)
// ---------------------------------------------------------------------------------------------

// Evaluated as a classic script in a ServiceWorkerGlobalScope without self.mw: attach a drop-in
// core and route our page messages to whatever self.mw is when they arrive (/mw-sw.js replaces
// it with its own core right after this module runs). Elsewhere (pages, Node) this does nothing.
(function attachToWorker() {
  if (typeof self === 'undefined' || !self || typeof self.addEventListener !== 'function') return;
  const Scope = self.ServiceWorkerGlobalScope;
  if (typeof Scope !== 'function' || !(self instanceof Scope) || self.mw) return;
  self.mw = createCore({ foreign: true, buildId: self.__BUILD_ID__, precache: self.__PRECACHE__ });
  self.addEventListener('message', (event) => {
    const core = self.mw;
    if (core && typeof core.message === 'function') core.message(event);
  });
  self.addEventListener('messageerror', (event) => {
    const core = self.mw;
    if (core && typeof core.messageError === 'function') core.messageError(event);
  });
})();
