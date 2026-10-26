#!/usr/bin/env node
// tools/check-site.mjs: the owner's health probe for a published site (ARCHITECTURE section 10,
// DESIGN-REVIEW S13). Run it from CI or cron: it exits non-zero when anything is wrong.
//
//   node tools/check-site.mjs <url> [--tr <wss>]... [--no-doh] [--doh <template>] [--timeout 10000]
//        [--tolerate-trackers <n>] [--allow-no-preflight] [--full] [--headless [--consent] [--screenshot <file>]] [--json] [--quiet]
//
// What it checks, in order (each target is printed before it is contacted; this is one of the three
// tools allowed to reach the internet, docs/DEV-NETWORK.md, and the tests never run it against one):
//   1. the page: HTTP 200, loader shell or drop-in page, /mw-sw.js and the loader assets, and that the
//      SRI hashes in the page match the files the host serves now (a stale CDN shows up here)
//   2. the pointer in the page's <meta name="mw-pointer">: parses, signature, expiry (warns at 14 days)
//   3. the pointer in DNS TXT at _magnet.<host>, read over DNS-over-HTTPS with src/loader/doh.js
//      (skipped, with no request, for names that cannot carry a record: localhost, IP addresses, nip.io and sslip.io names;
//      the report then says the page tag is the only pointer and when it expires), compared with the meta record
//   4. xs=: the .torrent downloads, has the infohash of the pointer
//   5. ws=: the verification gate of tools/check-webseed.mjs in seed mode (v0.2.1 B4: the Range
//      preflight, a browser-style ranged GET per file, the SHA-1 of the first and last piece, Range-200
//      and wrong-bytes detection); drop-in pages: host mode, a full GET of every file at its own URL
//      with browser Accept headers, every piece SHA-1 checked (catches edge transforms)
//   6. tr=: a WebSocket to each tracker, a "stopped" announce (checks the tracker's allow list, registers
//      nothing) and a scrape for the infohash (seeders and leechers online)
//   7. cs=: the ledger snapshot downloads and holds the genesis block named by gen=
//   8. with --headless: Playwright Chromium opens the site like a visitor and waits for it to render
//
// v0.3 C2 doors (docs/research/v03/S4-doors.md D3, D7): --door checks a door instead of a site (checkDoor): the address is the
// root of an https: host (http only on loopback); /mw-sw.js answers 200 with a JavaScript type and no redirect; /_mw/door.json
// is a door list (kind felinar-door) that other origins may read (Access-Control-Allow-Origin, else other doors see this one as
// "answering, not checked": --allow-no-cors makes that a warning, for GitHub Pages); and every /_mw/* file it lists, and /mw-sw.js,
// has exactly the bytes it names (a CDN that rewrites a file, or a half-finished deploy, shows up here). No pointer is read.

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import { parsePointer, verifyPointer, verifyRotation, pickRecord, ledgerIdFor, normalizeScope, EXP_WARN_DAYS } from '../src/common/pointer.js';
import { checkDoorJson } from '../src/loader/doors.js';
import { parseTorrentFile } from '../src/common/torrent-file.js';
import { resolveTxt, shouldSkipDoh, isWildcardDnsName, isNoTxtPlatformName, magnetTxtName, dohOverrideFromMeta, RESOLVERS } from '../src/loader/doh.js';
import { isShellHtml } from '../src/sw/lib.js';
import { validateBlock } from '../src/chain/block.js';
import { fingerprint, shortKey } from '../src/chain/crypto.js';
import { checkWebseed, webseedTargets, verifyHostFiles } from './check-webseed.mjs';
import {
  parseCli, runMain, isMain, readMeta, scanTags, isLoopbackHost, isLoopbackUrl, isoDate, formatBytes, UsageError, out,
} from './lib.mjs';

/**
 * keyLabel(pub) → the key's fingerprint as the loader shows it ("publisher key changed" prompts show
 * fingerprints), or the first 8 characters of its body when it cannot be decoded (v0.2.1 A2: keys are
 * 'p256:' + base64url, so slicing the string itself would print the tag).
 */
async function keyLabel(pub) {
  try {
    return await fingerprint(pub);
  } catch (_) {
    return shortKey(pub) + '...';
  }
}

const USAGE = `
Usage: node tools/check-site.mjs <url> [--tr <wss>]... [--no-doh] [--doh <url template>] [--timeout <ms>]
                                [--tolerate-trackers <n>] [--allow-no-preflight] [--full] [--headless [--consent] [--screenshot <file>]]
                                [--json] [--quiet]
       node tools/check-site.mjs <door url> --door [--allow-no-cors] [--timeout <ms>] [--json] [--quiet]
Exit 0 when every check passes (warnings are allowed), 1 when any check fails, 2 on usage errors.
`;

/** v0.3 C2 doors: the largest door.json and the largest loader file --door reads. */
const MAX_DOOR_JSON_BYTES = 64 * 1024;
const MAX_DOOR_FILE_BYTES = 16 * 1024 * 1024;
/** The Origin header --door sends with its door.json request, so a host that answers CORS only when asked does. */
export const DOOR_CHECK_ORIGIN = 'https://door-check.invalid';

/**
 * checkDoor(url, { fetch, timeoutMs, allowNoCors, log }) → { ok, failures, warnings, results, door } (v0.3 C2 doors). door is the
 * parsed /_mw/door.json (or null). Steps: 'door' (the address), '/mw-sw.js', '/_mw/door.json', 'cors', and one per listed file.
 */
export async function checkDoor(urlText, options = {}) {
  const o = Object.assign({ fetch: globalThis.fetch, timeoutMs: 10000, allowNoCors: false, log: () => {} }, options);
  const results = [];
  const add = (level, step, message) => {
    results.push({ level, step, message });
    o.log((level === 'ok' ? '[ok]   ' : level === 'info' ? '[info] ' : level === 'warn' ? '[warn] ' : '[FAIL] ') + step + ': ' + message);
  };
  const target = (text) => o.log('  -> ' + text);
  const timeout = () => AbortSignal.timeout(o.timeoutMs);
  let u;
  try {
    u = new URL(urlText);
  } catch (_) {
    throw new UsageError('not a URL: ' + urlText);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new UsageError('the URL must be http(s): ' + urlText);
  const origin = u.origin;
  const done = (door) => {
    const failures = results.filter((r) => r.level === 'fail').length;
    const warnings = results.filter((r) => r.level === 'warn').length;
    return { ok: failures === 0, failures, warnings, results, door };
  };
  if (u.protocol === 'http:' && !isLoopbackHost(u.hostname)) add('fail', 'door', 'plain http: a door must be served over https (browsers run the loader only on https:// or localhost)');
  else add('ok', 'door', origin + (u.protocol === 'http:' ? ' (loopback, for local development)' : ''));
  if (u.pathname !== '/' && u.pathname !== '/_mw/open.html') add('warn', 'door', 'checking ' + origin + '/: a door is the root of its host name (the path ' + u.pathname + ' is ignored)');

  // /mw-sw.js: 200, a JavaScript type, no redirect (a redirected worker script fails to register).
  let swBytes = null;
  {
    const url = origin + '/mw-sw.js';
    target('GET ' + url + ' (no redirect followed)');
    try {
      const res = await o.fetch(url, { redirect: 'manual', signal: timeout(), headers: { 'cache-control': 'no-cache' } });
      const type = (res.headers.get('content-type') || '').split(';')[0];
      if (res.status >= 300 && res.status < 400) add('fail', '/mw-sw.js', 'HTTP ' + res.status + ' redirect to ' + (res.headers.get('location') || '?') + ': a Service Worker script must be served without a redirect');
      else if (res.status !== 200) add('fail', '/mw-sw.js', 'HTTP ' + res.status + ': the worker must be at the root of the host name');
      else if (!/javascript|ecmascript/i.test(type)) add('fail', '/mw-sw.js', 'content-type is ' + (type || 'missing') + '; browsers refuse a worker script that is not served as JavaScript');
      else {
        swBytes = await readCapped(res, MAX_DOOR_FILE_BYTES);
        add('ok', '/mw-sw.js', formatBytes(swBytes.length) + ', ' + type);
      }
    } catch (err) {
      add('fail', '/mw-sw.js', 'cannot fetch ' + url + ': ' + errText(err));
    }
  }

  // /_mw/door.json: a door list, readable by other origins.
  let door = null;
  {
    const url = origin + '/_mw/door.json';
    target('GET ' + url + ' (Origin: ' + DOOR_CHECK_ORIGIN + ')');
    try {
      const res = await o.fetch(url, { redirect: 'manual', signal: timeout(), headers: { origin: DOOR_CHECK_ORIGIN, 'cache-control': 'no-cache' } });
      if (res.status !== 200) {
        add('fail', '/_mw/door.json', 'HTTP ' + res.status + ': this host does not serve a loader built with doors (v0.3 C2), or the deploy is incomplete');
      } else {
        const bytes = await readCapped(res, MAX_DOOR_JSON_BYTES);
        let json = null;
        try { json = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch (_) { json = null; }
        const check = checkDoorJson(json);
        if (!check.ok) add('fail', '/_mw/door.json', 'not a door list (' + check.reason + '): a block page, an error page or another site answers here');
        else {
          door = json;
          add('ok', '/_mw/door.json', 'build ' + check.buildId + (check.version ? ', loader ' + check.version : '') + ', ' + Object.keys(json.files).length + ' files listed');
        }
        const acao = res.headers.get('access-control-allow-origin');
        if (acao === '*' || acao === DOOR_CHECK_ORIGIN) add('ok', 'cors', 'Access-Control-Allow-Origin: ' + acao + ' (other doors can check this one)');
        else add(o.allowNoCors ? 'warn' : 'fail', 'cors', 'no Access-Control-Allow-Origin on /_mw/door.json: other doors see this one as "answering, not checked" (add the header: the kit\'s _headers, vercel.json or Caddyfile do; GitHub Pages cannot, use --allow-no-cors there)');
      }
    } catch (err) {
      add('fail', '/_mw/door.json', 'cannot fetch ' + url + ': ' + errText(err));
    }
  }

  // Every /_mw/* file door.json lists, and /mw-sw.js, byte for byte.
  if (door) {
    const sha = (b) => createHash('sha256').update(b).digest('hex');
    const sw = door.files['/mw-sw.js'];
    if (swBytes && sw) {
      if (sha(swBytes) === sw.sha256) add('ok', '/mw-sw.js', 'the bytes match door.json');
      else add('fail', '/mw-sw.js', 'the bytes differ from door.json (sha256 ' + sha(swBytes).slice(0, 16) + '..., door.json says ' + String(sw.sha256).slice(0, 16) + '...): a stale CDN copy or a half-finished deploy');
    }
    let checked = 0;
    for (const path of Object.keys(door.files).sort()) {
      if (!path.startsWith('/_mw/')) continue;
      const want = door.files[path];
      const url = origin + path;
      target('GET ' + url);
      try {
        const res = await o.fetch(url, { redirect: 'manual', signal: timeout(), headers: { 'cache-control': 'no-cache' } });
        if (res.status !== 200) { add('fail', path, 'HTTP ' + res.status); continue; }
        const bytes = await readCapped(res, MAX_DOOR_FILE_BYTES);
        if (bytes.length !== want.bytes || sha(bytes) !== want.sha256) {
          add('fail', path, 'the host serves ' + formatBytes(bytes.length) + ' with sha256 ' + sha(bytes).slice(0, 16) + '...; door.json names ' + formatBytes(want.bytes) + ' with ' + String(want.sha256).slice(0, 16) + '... (a transformed file: minifier, image optimiser, compression with changed bytes, or a mixed deploy)');
          continue;
        }
        checked++;
      } catch (err) {
        add('fail', path, 'cannot fetch ' + url + ': ' + errText(err));
      }
    }
    if (checked) add('ok', '/_mw/*', checked + ' file(s) match door.json byte for byte');
  }
  return done(door);
}

const DAY_MS = 86400000;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_TORRENT_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 67108864;

/** Plain-words explanation of a verifyPointer reason. */
export function describeReason(reason, scope) {
  switch (reason) {
    case 'unsigned': return 'the record is not signed (a bare magnet link: no owner key, the ledger is unmoderated)';
    case 'no-btih': return 'the record has no valid btih';
    case 'bad-owner': return 'owner= is not a P-256 public key';
    case 'missing-exp': return 'a signed record needs exp=';
    case 'missing-seq': return 'a signed record needs seq=';
    case 'bad-sig': return 'the signature does not verify for the hostname ' + scope + ' (fields were changed after signing, or the record was signed for another hostname)';
    case 'expired': return 'the record has expired: publish again (tools/publish.mjs --exp)';
    case 'exp-too-far': return 'exp= is more than 400 days away';
    case 'seq-future': return 'seq= is more than a day ahead of the clock: visitors refuse it (publish with the default seq, the Unix time)';
    default: return String(reason);
  }
}

// ---------------------------------------------------------------------------------------------
// small network helpers
// ---------------------------------------------------------------------------------------------

async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length')) || 0;
  if (declared > maxBytes) throw new Error('the response is ' + formatBytes(declared) + ', more than the ' + formatBytes(maxBytes) + ' this check reads');
  const chunks = [];
  let total = 0;
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  if (!reader) return new Uint8Array(await res.arrayBuffer());
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('the response is larger than the ' + formatBytes(maxBytes) + ' this check reads');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return bytes;
}

function sri384(bytes) {
  return 'sha384-' + createHash('sha384').update(bytes).digest('base64');
}

function errText(err) {
  if (!err) return 'unknown error';
  if (err.name === 'TimeoutError') return 'no answer in time';
  const code = err.cause && err.cause.code ? ' (' + err.cause.code + ')' : '';
  return (err.message || String(err)) + code;
}

async function openSocketFactory() {
  try {
    const mod = await import('ws');
    return { kind: 'ws', WebSocket: mod.default || mod.WebSocket };
  } catch (_) { /* optional: bittorrent-tracker brings it in */ }
  if (typeof globalThis.WebSocket === 'function') return { kind: 'global', WebSocket: globalThis.WebSocket };
  return null;
}

/**
 * probeTracker(url, { btih, origin, timeoutMs, factory }) → { ok, ms, seeders, leechers, note, error }
 * Opens a WebSocket (with the site's Origin header when the ws package is there), sends a "stopped"
 * announce for the infohash (it runs the tracker's allow list but registers no peer), then a scrape
 * for the counts. A tracker that does not allow the torrent says so in `error`.
 */
export function probeTracker(url, { btih, origin, timeoutMs = 10000, factory }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let done = false;
    let sock = null;
    let timer = null;
    let stepTimer = null;
    let connectedAt = null;
    let counts = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(stepTimer);
      try {
        if (sock && typeof sock.terminate === 'function') sock.terminate();
        else if (sock) sock.close();
      } catch (_) { /* already closed */ }
      resolve(Object.assign({ url, ms: connectedAt === null ? Date.now() - started : connectedAt }, result));
    };
    timer = setTimeout(() => finish({ ok: false, error: connectedAt === null ? 'no connection within ' + timeoutMs + ' ms' : 'no answer within ' + timeoutMs + ' ms' }), timeoutMs);
    if (!factory) return finish({ ok: false, error: 'this Node has no WebSocket client (use Node 22 or later)' });
    const binary = Buffer.from(btih, 'hex').toString('latin1');
    const peerId = '-MW0200-' + createHash('sha1').update(String(Math.random()) + started).digest('hex').slice(0, 12);
    const countsOf = (msg) => (Number.isFinite(Number(msg.complete)) && Number.isFinite(Number(msg.incomplete))
      ? { seeders: Number(msg.complete), leechers: Number(msg.incomplete) } : null);
    const sendScrape = () => {
      try {
        sock.send(JSON.stringify({ action: 'scrape', info_hash: binary }));
      } catch (err) {
        return finish({ ok: false, error: 'send failed: ' + errText(err) });
      }
      stepTimer = setTimeout(() => finish(counts ? Object.assign({ ok: true }, counts) : { ok: true, note: 'connected, but the tracker did not answer a scrape' }), Math.min(3000, timeoutMs));
      return undefined;
    };
    const onOpen = () => {
      connectedAt = Date.now() - started;
      try {
        sock.send(JSON.stringify({ action: 'announce', info_hash: binary, peer_id: peerId, uploaded: 0, downloaded: 0, left: 0, event: 'stopped', numwant: 0, offers: [] }));
      } catch (err) {
        return finish({ ok: false, error: 'send failed: ' + errText(err) });
      }
      stepTimer = setTimeout(sendScrape, 1500); // some trackers do not answer a "stopped" announce
      return undefined;
    };
    const onMessage = (data) => {
      let msg;
      try {
        msg = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
      } catch (_) {
        return finish({ ok: true, note: 'connected; the answer was not JSON' });
      }
      if (msg && msg['failure reason']) return finish({ ok: false, error: 'the tracker refuses this torrent: ' + msg['failure reason'] });
      if (msg && msg.action === 'announce') {
        counts = countsOf(msg);
        clearTimeout(stepTimer);
        return sendScrape();
      }
      const files = msg && msg.files && typeof msg.files === 'object' ? Object.values(msg.files) : [];
      if (files.length) return finish({ ok: true, seeders: Number(files[0].complete) || 0, leechers: Number(files[0].incomplete) || 0 });
      return finish(counts ? Object.assign({ ok: true }, counts) : { ok: true, note: 'connected; the tracker knows nothing about this torrent yet' });
    };
    try {
      if (factory.kind === 'ws') {
        sock = new factory.WebSocket(url, { headers: { Origin: origin }, handshakeTimeout: timeoutMs });
        sock.on('open', onOpen);
        sock.on('message', onMessage);
        sock.on('error', (err) => finish({ ok: false, error: errText(err) }));
        sock.on('unexpected-response', (req, res) => finish({ ok: false, error: 'HTTP ' + res.statusCode + ' instead of a WebSocket upgrade' }));
        sock.on('close', (code) => finish({ ok: false, error: 'the tracker closed the connection (' + code + ')' }));
      } else {
        sock = new factory.WebSocket(url);
        sock.addEventListener('open', onOpen);
        sock.addEventListener('message', (e) => onMessage(e.data));
        sock.addEventListener('error', () => finish({ ok: false, error: 'connection failed' }));
        sock.addEventListener('close', (e) => finish({ ok: false, error: 'the tracker closed the connection (' + e.code + ')' }));
      }
    } catch (err) {
      finish({ ok: false, error: errText(err) });
    }
    return undefined;
  });
}

// ---------------------------------------------------------------------------------------------
// the check
// ---------------------------------------------------------------------------------------------

/**
 * checkSite(url, options) → { ok, failures, warnings, results: [{ level, step, message }], record, torrent }
 * options: { fetch, timeoutMs = 10000, doh = true | false | { override } | { resolvers }, extraTrackers = [],
 * tolerateTrackers = 0, headless = false, consent = false, screenshot = null, now = Date.now(), log, WebSocketFactory }
 * level is 'ok', 'info', 'warn' or 'fail'. `log(line)` receives progress lines; every target is
 * logged before it is contacted.
 */
export async function checkSite(urlText, options = {}) {
  const o = Object.assign({
    fetch: globalThis.fetch, timeoutMs: 10000, doh: true, extraTrackers: [], tolerateTrackers: 0, headless: false, consent: false, allowNoPreflight: false, full: false,
    screenshot: null, now: Date.now(), log: () => {}, WebSocketFactory: undefined,
  }, options);
  const results = [];
  const add = (level, step, message) => {
    results.push({ level, step, message });
    o.log((level === 'ok' ? '[ok]   ' : level === 'info' ? '[info] ' : level === 'warn' ? '[warn] ' : '[FAIL] ') + step + ': ' + message);
  };
  const target = (text) => o.log('  -> ' + text);
  const timeout = () => AbortSignal.timeout(o.timeoutMs);

  let pageUrl;
  try {
    pageUrl = new URL(urlText);
  } catch (_) {
    throw new UsageError('not a URL: ' + urlText);
  }
  if (pageUrl.protocol !== 'https:' && pageUrl.protocol !== 'http:') throw new UsageError('the URL must be http(s): ' + urlText);
  const loopbackPage = isLoopbackHost(pageUrl.hostname);
  if (pageUrl.protocol === 'http:' && !loopbackPage) {
    add('fail', 'page', 'plain http: browsers run the loader only on https:// (or localhost), so visitors see "This page must be served over HTTPS (or localhost)"');
  }

  // ---- 1. the page --------------------------------------------------------------------------
  target('GET ' + pageUrl.href);
  let html = null;
  let finalUrl = pageUrl;
  try {
    const res = await o.fetch(pageUrl.href, { redirect: 'follow', headers: { accept: 'text/html' }, signal: timeout() });
    finalUrl = new URL(res.url || pageUrl.href);
    const bytes = await readCapped(res, MAX_PAGE_BYTES);
    html = Buffer.from(bytes).toString('utf8');
    const type = res.headers.get('content-type') || '';
    if (res.status !== 200) add('fail', 'page', 'HTTP ' + res.status + ' for ' + finalUrl.href);
    else if (!/html/i.test(type)) add('fail', 'page', 'content-type is ' + (type || 'missing') + ', not HTML');
    else add('ok', 'page', 'HTTP 200, ' + formatBytes(bytes.length) + (finalUrl.href !== pageUrl.href ? ', redirected to ' + finalUrl.href : ''));
  } catch (err) {
    add('fail', 'page', 'cannot fetch ' + pageUrl.href + ': ' + errText(err));
  }
  const origin = finalUrl.origin;
  const scope = (() => {
    try {
      return normalizeScope(finalUrl.hostname);
    } catch (_) {
      return finalUrl.hostname;
    }
  })();
  if (finalUrl.hostname !== pageUrl.hostname) add('warn', 'page', 'redirected to another hostname; pointers are scoped to ' + scope);

  let kind = 'plain';
  if (html) {
    if (isShellHtml(html)) kind = 'shell';
    else if (/<script\b[^>]*\bsrc\s*=\s*["']?\/_mw\/mw\.js/i.test(html)) kind = 'dropin';
    add('info', 'page', kind === 'shell' ? 'loader shell (shell mode)' : kind === 'dropin' ? 'drop-in page (loads /_mw/mw.js)' : 'neither the loader shell nor a drop-in page');
  }

  // ---- 1b. service worker, loader assets, SRI ----------------------------------------------
  if (html && kind !== 'plain') {
    const assetPaths = kind === 'shell' ? ['/_mw/boot.js', '/_mw/loader.js'] : ['/_mw/mw.js'];
    const integrity = new Map();
    for (const t of scanTags(html)) {
      const ref = t.name === 'script' ? t.attrs.get('src') : t.name === 'link' ? t.attrs.get('href') : null;
      if (ref && t.attrs.get('integrity')) integrity.set(ref, t.attrs.get('integrity'));
    }
    const missing = [];
    for (const p of ['/mw-sw.js'].concat(assetPaths)) {
      const url = new URL(p, origin).href;
      target('GET ' + url);
      try {
        const res = await o.fetch(url, { redirect: 'follow', signal: timeout(), headers: { 'cache-control': 'no-cache' } });
        const bytes = await readCapped(res, 8 * 1024 * 1024);
        const type = res.headers.get('content-type') || '';
        if (res.status !== 200) {
          add('fail', p, 'HTTP ' + res.status + (p === '/mw-sw.js' ? ': the Service Worker must be at the origin root' : ''));
          missing.push(p);
          continue;
        }
        if (!/javascript|ecmascript/i.test(type)) add('fail', p, 'content-type is ' + (type || 'missing') + '; browsers refuse a script that is not served as JavaScript');
        else add('ok', p, formatBytes(bytes.length) + ', ' + type.split(';')[0]);
        if (p === '/mw-sw.js') {
          const cc = (res.headers.get('cache-control') || '').toLowerCase();
          const maxAge = /max-age=(\d+)/.exec(cc);
          if (!/no-cache|no-store/.test(cc) && (!maxAge || Number(maxAge[1]) > 0)) {
            add('warn', p, 'Cache-Control is "' + (cc || 'absent') + '": serve it with "no-cache" so updates and the kill switch reach returning visitors at once');
          }
        }
        const want = integrity.get(p);
        if (want) {
          const got = sri384(bytes);
          if (want.split(/\s+/).includes(got)) add('ok', p, 'matches the integrity attribute in the page');
          else add('fail', p, 'the page names integrity ' + want.slice(0, 24) + '... but the host serves ' + got.slice(0, 24) + '...: stale CDN or half-finished deploy (purge the CDN, upload /_mw/ before the pages); visitors would see "did not load"');
        }
      } catch (err) {
        add('fail', p, 'cannot fetch ' + url + ': ' + errText(err));
        missing.push(p);
      }
    }
    // Code review round 1 (DESIGN-REVIEW item 22): a site deployed under a sub-path (for example a
    // GitHub Pages project site at /repo/) loads its loader from the origin root, which has none, so
    // visitors stay on "Starting...". Say so in those words.
    const dir = finalUrl.pathname.replace(/[^/]*$/, '');
    const entry = assetPaths[0];
    if (dir !== '/' && missing.includes(entry)) {
      const under = new URL(entry.slice(1), finalUrl).href;
      target('GET ' + under);
      let there = false;
      try {
        const res = await o.fetch(under, { redirect: 'follow', signal: timeout(), headers: { 'cache-control': 'no-cache' } });
        there = res.status === 200;
        try { await res.body?.cancel(); } catch (_) { /* nothing to drop */ }
      } catch (_) {
        there = false;
      }
      add('fail', 'deployment', 'non-root deployment: the page is under ' + dir + (there ? ' and the loader files are at ' + dir + entry.slice(1) : '') +
        ', but browsers load ' + entry + ' and /mw-sw.js from the origin root ' + origin + '/, where they are missing, so visitors stay on "Starting...". ' +
        'Serve the published folder at the root of a domain or subdomain (a custom domain, or a user or organisation Pages site).');
    }
  }

  // ---- 2. meta pointer ----------------------------------------------------------------------
  const days = (expiresAt) => Math.floor((expiresAt - o.now) / DAY_MS);
  let metaRecord = null;
  let metaExpiresAt = null;
  const metaText = html ? readMeta(html, 'mw-pointer') : null;
  if (metaText) {
    const parsed = parsePointer(metaText);
    if (!parsed.ok) add('fail', 'meta pointer', 'does not parse: ' + parsed.detail);
    else if (!parsed.record.signed) {
      add('warn', 'meta pointer', 'unsigned (a magnet link): no owner key, the ledger is unmoderated');
      metaRecord = parsed.record;
    } else {
      const v = await verifyPointer(parsed.record, scope, { now: o.now });
      if (!v.ok) add('fail', 'meta pointer', describeReason(v.reason, scope));
      else {
        metaRecord = parsed.record;
        metaExpiresAt = v.expiresAt;
        const left = days(v.expiresAt);
        add(left < EXP_WARN_DAYS ? 'warn' : 'ok', 'meta pointer', 'signed, seq ' + metaRecord.seq + ', owner ' + (await keyLabel(metaRecord.owner)) + ', expires ' + isoDate(v.expiresAt) + ' (' + left + ' days left' + (left < EXP_WARN_DAYS ? '; publish again soon' : '') + ')');
      }
    }
  } else if (html && kind !== 'plain') {
    add('warn', 'meta pointer', 'the page has no <meta name="mw-pointer">: first visits depend on DNS-over-HTTPS alone');
  }

  // ---- 3. DNS pointer -----------------------------------------------------------------------
  let dnsRecord = null;
  if (o.doh !== false) {
    const override = (o.doh && o.doh.override) || (html ? dohOverrideFromMeta({ querySelector: () => {
      const content = readMeta(html, 'mw-doh');
      return content === null ? null : { getAttribute: () => content };
    } }) : null);
    const resolvers = o.doh && o.doh.resolvers ? o.doh.resolvers : RESOLVERS;
    if (!override && shouldSkipDoh(finalUrl.hostname)) {
      // v0.3 C2 (SEEDING-AND-ZERO-SETUP-DESIGN 3.2): a name that cannot carry a DNS record has the page tag as its only pointer, and the
      // page tag expires (S2 F18): after that date new visitors are refused until the owner publishes again. No DoH request is made.
      const why = isWildcardDnsName(finalUrl.hostname)
        ? finalUrl.hostname + ' belongs to a free wildcard-DNS service (nip.io or sslip.io), which lets nobody set a record under it'
        // 0.3.0 independence (IND-10): a hosting platform's name is a public DNS name, but its users cannot publish a TXT record there.
        : isNoTxtPlatformName(finalUrl.hostname)
          ? finalUrl.hostname + ' is on a hosting platform where no user can publish a TXT record (github.io, netlify.app, pages.dev and others)'
          : finalUrl.hostname + ' is not a public DNS name';
      add('info', 'dns pointer', 'not possible for this name (page tag only): ' + why + ', so DNS-over-HTTPS is skipped (visitors skip it too)' +
        (metaExpiresAt !== null ? '; the page tag expires on ' + isoDate(metaExpiresAt) + ', and after that new visitors cannot load the site until you publish again' : ''));
    } else {
      const name = magnetTxtName(finalUrl.hostname);
      target('DNS-over-HTTPS TXT ' + name + ' via ' + (override ? new URL(override.replace(/\{(?:name|type)\}/g, 'x')).origin : resolvers.map((r) => new URL(r.url('x', 'TXT')).host).join(', ')) + ' (the first resolver that answers wins)');
      try {
        const answer = await resolveTxt(name, { fetch: o.fetch, timeoutMs: o.timeoutMs, override, resolvers });
        if (answer.strings.length === 0) {
          add('info', 'dns pointer', 'no TXT record at ' + name + ' (answered by ' + answer.resolver + '): the meta tag is the only pointer, which is fine');
        } else {
          const valid = [];
          let bad = 0;
          for (const text of answer.strings) {
            const parsed = parsePointer(text);
            if (!parsed.ok) {
              bad++;
              add('fail', 'dns pointer', 'a TXT record does not parse: ' + parsed.detail);
              continue;
            }
            if (!parsed.record.signed) {
              bad++;
              add('fail', 'dns pointer', 'a TXT record is not signed; the loader ignores unsigned DNS records');
              continue;
            }
            const v = await verifyPointer(parsed.record, scope, { now: o.now });
            if (v.ok) valid.push(parsed.record);
            else {
              bad++;
              add('fail', 'dns pointer', 'a TXT record is invalid: ' + describeReason(v.reason, scope));
            }
          }
          dnsRecord = pickRecord(valid);
          if (dnsRecord) {
            add('ok', 'dns pointer', answer.strings.length + ' TXT record(s) via ' + answer.resolver + (answer.ad ? ' (DNSSEC validated)' : '') + ', winner seq ' + dnsRecord.seq + ', ttl ' + (answer.ttl === null ? '?' : answer.ttl + ' s') +
              (bad ? ', ' + bad + ' invalid record(s) ignored' : ''));
          }
        }
      } catch (err) {
        const detail = err && err.errors ? err.errors.map((e) => e.resolver + ': ' + e.error).join('; ') : errText(err);
        add('fail', 'dns pointer', 'no DNS-over-HTTPS resolver answered (' + detail + ')');
      }
    }
  } else {
    add('info', 'dns pointer', 'skipped (--no-doh)');
  }

  // ---- 3b. meta against DNS, and the record to probe -----------------------------------------
  let record = metaRecord;
  if (metaRecord && dnsRecord) {
    const sameOwner = dnsRecord.owner === metaRecord.owner;
    const rotated = !sameOwner && (await verifyRotation(dnsRecord, metaRecord.owner, scope));
    if (!sameOwner && !rotated) add('fail', 'dns pointer', 'signed by another key than the meta record (' + (await keyLabel(dnsRecord.owner)) + ' against ' + (await keyLabel(metaRecord.owner)) + '); returning visitors would be asked to confirm a "publisher key changed" prompt');
    else if (dnsRecord.seq > metaRecord.seq) {
      record = dnsRecord;
      add('info', 'dns pointer', 'is ahead of the meta tag (seq ' + dnsRecord.seq + ' against ' + metaRecord.seq + '): visitors see "Update available: reload"' + (dnsRecord.btih !== metaRecord.btih ? ' and the infohash changes' : ''));
    } else if (dnsRecord.seq < metaRecord.seq) add('warn', 'dns pointer', 'is behind the meta tag (seq ' + dnsRecord.seq + ' against ' + metaRecord.seq + '): update the TXT record');
    else if (dnsRecord.btih !== metaRecord.btih) add('fail', 'dns pointer', 'has the same seq as the meta tag but another infohash');
    else add('ok', 'dns pointer', 'agrees with the meta tag');
  } else if (!metaRecord && dnsRecord) {
    record = dnsRecord;
  }
  if (!record) {
    add('fail', 'pointer', 'no usable pointer: neither the page nor DNS yields a valid record');
    return finish(o, results, null, null);
  }

  // ---- 4. xs: the .torrent ------------------------------------------------------------------
  const resolveUrl = (u) => new URL(u, finalUrl.href).href;
  let torrent = null;
  const xsList = record.xs.map(resolveUrl);
  const wsList = record.ws.filter((u) => /^https?:/i.test(u) || u.startsWith('/')).map(resolveUrl);
  if (!xsList.length && !wsList.length) add('warn', 'reachability', 'the pointer has neither xs= nor ws=: the site loads only while another visitor is online');
  if (!xsList.length && wsList.length) add('warn', 'xs', 'no xs=: web seeds attach only after the metadata arrives, so a cold start needs a peer or xs=');
  for (const url of xsList) {
    target('GET ' + url + ' (Origin ' + origin + ')');
    try {
      const sameOrigin = new URL(url).origin === origin;
      const res = await o.fetch(url, { redirect: 'follow', headers: sameOrigin ? {} : { origin }, signal: timeout() });
      if (res.status !== 200) {
        add('fail', 'xs', url + ' answered HTTP ' + res.status);
        continue;
      }
      if (!sameOrigin && !res.headers.get('access-control-allow-origin')) add('fail', 'xs', url + ' has no Access-Control-Allow-Origin: the loader fetches the .torrent with CORS');
      const parsed = await parseTorrentFile(await readCapped(res, MAX_TORRENT_BYTES));
      if (parsed.infoHash !== record.btih) {
        add('fail', 'xs', url + ' is the torrent ' + parsed.infoHash + ', the pointer says ' + record.btih + ' (upload the new .torrent)');
        continue;
      }
      torrent = torrent || parsed;
      add('ok', 'xs', url + ': "' + parsed.name + '", ' + parsed.files.filter((f) => !f.pad).length + ' files, ' + formatBytes(parsed.length) + ', infohash matches');
    } catch (err) {
      add('fail', 'xs', 'cannot read ' + url + ': ' + errText(err));
    }
  }

  // ---- 5. web seed --------------------------------------------------------------------------
  const dropinHost = kind === 'dropin' || record.xs.some((u) => u.startsWith('/_mw/t/'));
  if (wsList.length && torrent) {
    for (const base of wsList) {
      const t = webseedTargets(base, torrent, []);
      target('web seed ' + base + ': OPTIONS and GET (Range: bytes=0-0) for ' + t.files + ' files and ranged GETs for the first and last piece at ' + t.origins.join(', '));
      const res = await checkWebseed({ wsBase: base, torrent, origin, fetch: o.fetch, timeoutMs: o.timeoutMs, allowNoPreflight: o.allowNoPreflight });
      if (res.ok) {
        add(res.verdict === 'PASS' ? 'ok' : 'warn', 'web seed', base + ': every file answers Range with 206 and the first and last piece hash correctly (' + res.verdict +
          (res.verdict === 'PASS-needs-patched-client' ? ': the stock WebTorrent headers would fail the preflight; felinar sends only Range' : '') +
          (res.verdict === 'PASS-no-preflight' ? ': no CORS preflight answer, so browsers that preflight Range cannot use this seed' : '') + ')');
      } else {
        for (const r of res.results.filter((x) => !x.ok).slice(0, 5)) add('fail', 'web seed', (r.url || r.path) + ': ' + r.problems.join('; '));
        if (res.failed > 5) add('fail', 'web seed', base + ': ' + (res.failed - 5) + ' more checks fail');
        add('fail', 'web seed', base + ': verdict ' + res.verdict);
      }
      if (o.full) {
        // origin mode of the gate over this seed: a full GET of every file, every piece hashed.
        const fileBase = (base.endsWith('/') ? base : base + '/') + (torrent.multiFile ? torrent.name.split('/').map(encodeURIComponent).join('/') + '/' : '');
        target('web seed ' + base + ': a full GET of every file (--full)');
        const full = await verifyHostFiles({ base: torrent.multiFile ? fileBase : base, torrent, mode: 'origin', origin, fetch: o.fetch, timeoutMs: o.timeoutMs });
        if (full.ok) add('ok', 'web seed', base + ': every byte of every file matches the torrent (' + full.results.length + ' files)');
        else for (const r of full.results.filter((x) => !x.ok).slice(0, 5)) add('fail', 'web seed', r.problems.join('; '));
      }
    }
  } else if (wsList.length && !torrent) {
    add('fail', 'web seed', 'cannot probe ' + wsList[0] + ' without the .torrent (xs= is missing or unreachable)');
  }
  if (dropinHost && torrent) {
    // v0.2.1 B4: host mode of the verification gate. The Service Worker's /_mw/ws/ rewrite fetches each
    // file whole from the host, so the host must hand browsers exactly the torrent's bytes.
    target('GET ' + origin + '/<path> for ' + torrent.files.filter((f) => !f.pad).length + ' files with browser Accept headers: the host is the web seed of a drop-in site');
    try {
      const res = await verifyHostFiles({ base: origin + '/', torrent, mode: 'host', origin, fetch: o.fetch, timeoutMs: o.timeoutMs });
      for (const r of res.results) {
        if (!r.ok) add('fail', 'host files', r.problems.join('; '));
        else for (const w of r.warnings) add('warn', 'host files', r.url + ': ' + w);
      }
      if (res.ok) add('ok', 'host files', 'every file of the torrent is on the host with the torrent\'s bytes (' + res.results.length + ' files, every piece hash checked)');
    } catch (err) {
      add('fail', 'host files', 'cannot check the host files: ' + errText(err));
    }
  }

  // ---- 6. trackers ----------------------------------------------------------------------------
  const trackers = Array.from(new Set(record.tr.concat(o.extraTrackers)));
  if (!trackers.length) add('warn', 'trackers', 'the pointer has no tr=: visitors cannot find each other (the site still loads from the web seed)');
  else {
    const factory = o.WebSocketFactory === undefined ? await openSocketFactory() : o.WebSocketFactory;
    let failed = 0;
    for (const url of trackers) {
      if (/^ws:\/\//i.test(url) && !isLoopbackUrl(url.replace(/^ws:/i, 'http:'))) add('warn', 'tracker', url + ' is plaintext ws://: browsers block it from an https:// page');
      target('WebSocket ' + url + ' (Origin ' + origin + '), then a scrape for ' + record.btih);
      const r = await probeTracker(url, { btih: record.btih, origin, timeoutMs: o.timeoutMs, factory });
      if (r.ok) {
        add('ok', 'tracker', url + ' connected in ' + r.ms + ' ms' + (r.seeders !== undefined ? '; ' + r.seeders + ' seeder(s), ' + r.leechers + ' leecher(s) online now' : '; ' + r.note));
      } else {
        failed++;
        add('fail', 'tracker', url + ': ' + r.error);
      }
    }
    if (failed && failed <= o.tolerateTrackers) add('info', 'trackers', failed + ' tracker failure(s) tolerated (--tolerate-trackers ' + o.tolerateTrackers + ')');
    else if (failed) add('fail', 'trackers', failed + ' of ' + trackers.length + ' trackers failed');
    if (failed && failed <= o.tolerateTrackers) {
      // the individual failures stay in the list, but they no longer fail the run
      for (const r of results) if (r.step === 'tracker' && r.level === 'fail') r.level = 'warn';
    }
  }

  // ---- 7. ledger snapshot --------------------------------------------------------------------
  if (record.cs) {
    const url = resolveUrl(record.cs);
    target('GET ' + url);
    try {
      const sameOrigin = new URL(url).origin === origin;
      const res = await o.fetch(url, { redirect: 'follow', headers: sameOrigin ? {} : { origin }, signal: timeout() });
      if (res.status !== 200) add('fail', 'snapshot', url + ' answered HTTP ' + res.status);
      else {
        let bytes = Buffer.from(await readCapped(res, MAX_SNAPSHOT_BYTES));
        if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
        const blocks = JSON.parse(bytes.toString('utf8'));
        if (!Array.isArray(blocks)) add('fail', 'snapshot', url + ' is not a JSON array of blocks');
        else {
          const ledgerId = record.signed ? await ledgerIdFor(record, scope) : null;
          const genesis = record.gen ? blocks.find((b) => b && b.h === record.gen) : null;
          if (!record.gen) add('ok', 'snapshot', blocks.length + ' blocks (the pointer has no gen=)');
          else if (!genesis) add('fail', 'snapshot', blocks.length + ' blocks, but not the genesis block gen=' + record.gen.slice(0, 12) + '...: a first visitor cannot verify the ledger root');
          else {
            const v = await validateBlock(genesis, { genesisOwner: record.owner, site: ledgerId || undefined });
            if (v.ok) add('ok', 'snapshot', blocks.length + ' blocks, ' + formatBytes(bytes.length) + ', the genesis block is there and valid');
            else add('fail', 'snapshot', 'the genesis block in the snapshot is invalid (' + v.reason + ')');
          }
        }
      }
    } catch (err) {
      add('fail', 'snapshot', 'cannot read ' + url + ': ' + errText(err));
    }
  } else if (record.signed) {
    add('info', 'snapshot', 'no cs=: the ledger loads only from other visitors (see tools/snapshot.mjs)');
  }

  // ---- 8. headless load ------------------------------------------------------------------------
  if (o.headless) {
    target('Chromium (Playwright) opens ' + finalUrl.href + ' like a visitor; it contacts the hosts named above' + (o.consent ? ' and, after consent, trackers and peers' : ' (no consent given: the web seed path only)'));
    try {
      const live = await import('./live.mjs');
      // Code review round 1: a loopback page gets the local-only browser (docs/DEV-NETWORK.md).
      const session = await live.launchBrowser({ headless: true, allowRemote: live.allowRemoteFor(finalUrl.href), ignoreHTTPSErrors: loopbackPage });
      try {
        const page = await session.context.newPage();
        await page.goto(finalUrl.href, { waitUntil: 'domcontentloaded', timeout: o.timeoutMs * 3 });
        if (o.consent) await live.acceptConsent(page, { timeoutMs: 15000 });
        const rendered = await live.waitForSiteRendered(page, { timeoutMs: 45000 });
        if (o.screenshot) await page.screenshot({ path: o.screenshot, fullPage: false });
        add(rendered.ok ? 'ok' : 'fail', 'headless load', rendered.detail + (rendered.ok && rendered.status ? ' | ' + live.formatStatus(rendered.status) : ''));
      } finally {
        await session.close();
      }
    } catch (err) {
      add('fail', 'headless load', errText(err));
    }
  }

  return finish(o, results, record, torrent);
}

function finish(o, results, record, torrent) {
  const failures = results.filter((r) => r.level === 'fail').length;
  const warnings = results.filter((r) => r.level === 'warn').length;
  return { ok: failures === 0, failures, warnings, results, record, torrent };
}

async function main(argv) {
  const { flags, positionals } = parseCli(argv, {
    tr: { type: 'list' },
    'no-doh': { type: 'boolean' },
    doh: { type: 'string' },
    timeout: { type: 'int', default: 10000 },
    'tolerate-trackers': { type: 'int', default: 0 },
    'allow-no-preflight': { type: 'boolean' },
    full: { type: 'boolean' },
    headless: { type: 'boolean' },
    consent: { type: 'boolean' },
    screenshot: { type: 'string' },
    json: { type: 'boolean' },
    quiet: { type: 'boolean' },
    door: { type: 'boolean' },
    'allow-no-cors': { type: 'boolean' },
  });
  if (flags.help) {
    out(USAGE.trim());
    return 0;
  }
  if (positionals.length !== 1) throw new UsageError('expected one URL');
  const log = flags.json || flags.quiet ? () => {} : out;
  if (flags.door) {
    // v0.3 C2 doors: a door, not a site (no pointer, no DNS, no trackers).
    log('check-site --door ' + positionals[0]);
    log('Will contact: ' + new URL(positionals[0]).origin + ' only (/mw-sw.js, /_mw/door.json and every /_mw/ file it lists). Each target is printed before it is contacted.');
    const result = await checkDoor(positionals[0], { timeoutMs: flags.timeout, allowNoCors: flags.allowNoCors, log });
    if (flags.json) out(JSON.stringify({ url: positionals[0], door: true, ok: result.ok, failures: result.failures, warnings: result.warnings, results: result.results }, null, 2));
    else out((result.ok ? 'OK' : 'FAILED') + ': ' + result.failures + ' failure(s), ' + result.warnings + ' warning(s).');
    return result.ok ? 0 : 1;
  }
  log('check-site ' + positionals[0]);
  log('Will contact: ' + new URL(positionals[0]).origin + ' (the page and its loader files)' + (flags.noDoh ? '' : ', the DNS-over-HTTPS resolvers (Cloudflare, dns.sb, Google) for _magnet.<host>') +
    ', then the xs, ws, tr and cs hosts named in the pointer' + (flags.headless ? ', and a headless Chromium' : '') + '. Each target is printed before it is contacted.');
  const result = await checkSite(positionals[0], {
    timeoutMs: flags.timeout,
    doh: flags.noDoh ? false : (flags.doh ? { override: flags.doh } : true),
    extraTrackers: flags.tr,
    tolerateTrackers: flags.tolerateTrackers,
    allowNoPreflight: flags.allowNoPreflight,
    full: flags.full,
    headless: flags.headless,
    consent: flags.consent,
    screenshot: flags.screenshot,
    log,
  });
  if (flags.json) out(JSON.stringify({ url: positionals[0], ok: result.ok, failures: result.failures, warnings: result.warnings, results: result.results }, null, 2));
  else out((result.ok ? 'OK' : 'FAILED') + ': ' + result.failures + ' failure(s), ' + result.warnings + ' warning(s).');
  return result.ok ? 0 : 1;
}

if (isMain(import.meta.url)) runMain(main, USAGE);
