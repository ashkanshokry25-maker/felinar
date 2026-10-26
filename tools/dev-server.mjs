#!/usr/bin/env node
// tools/dev-server.mjs: static development host for the loader (ARCHITECTURE §10, DESIGN-REVIEW
// items 14 and 22). Binds 127.0.0.1 by default; nothing here contacts another host.
//
//   node tools/dev-server.mjs [--root dist] [--port 8080] [--host 127.0.0.1] [--tls] [--webseed <dir>]
//                             [--pointer "<record>"|@file] [--dev] [--hub shared|subdomain] [--doh <template>]
//                             [--spa|--no-spa] [--idp-port <n> [--idp-root dist-idp]] [--tracker-proxy <port>] [--quiet] [--json]
//
// - v0.3 C2 (SEEDING-AND-ZERO-SETUP-DESIGN 3.2, S2 rung 1): --tracker-proxy <port> passes WebSocket upgrades on /tracker to a tracker
//   listening on ws://127.0.0.1:<port> (tools/tracker.mjs), so the tracker answers on the page's own origin: wss://<host>:<port>/tracker
//   with --tls. An https page cannot open a ws:// address on the LAN (mixed content), and a second TLS port would be a second thing for
//   every phone to trust and for the network to allow. Only upgrades are passed on, as the one-box Caddyfile does; a plain GET of
//   /tracker is served like any other path. The upstream is always 127.0.0.1, whatever --host says; bind rules are unchanged.
//
// - v0.3 (V03-DESIGN-REVIEW Part 4): --idp-port serves the identity page (npm run build:idp, dist-idp/) on a SECOND loopback port, with
//   the headers of its _headers file (CSP, frame-ancestors, referrer policy and the rest), on 127.0.0.1 only whatever --host says. A
//   second port is a second origin, so the origin separation the identity page relies on is real in development. The _headers and
//   _redirects files themselves are not served. With --dev, /_dev/store-idb.js serves src/files/store-idb.js to tools/seeder.html.
//
// - Static files from --root with exact MIME types (.mjs, .wasm, .webmanifest included), ETag,
//   Range (206/416), HEAD, and Cache-Control: no-cache everywhere (so /mw-sw.js and HTML are
//   always revalidated, as on a production host).
// - SPA fallback: an unknown path gets the root index.html with 200, as a shell host must answer
//   every URL with the shell (on by default when the root index.html is the loader shell; --spa,
//   --no-spa override). Reserved paths (/_mw/*, /mw-sw.js, /ws/*, /.mw/*, /_dev/*) never fall back.
// - /ws/ is a CORS web seed for --webseed <dir>: OPTIONS answered with Allow-Headers *, every
//   response with Access-Control-Allow-Origin *, Expose-Headers Content-Range, Content-Length,
//   Accept-Ranges, ETag, and Range answered with 206.
// - --pointer stamps <meta name="mw-pointer"> into every HTML document served from --root, --dev
//   adds <meta name="mw-dev" content="1"> (boot.js then relaxes the CSP for ws://127.0.0.1:*,
//   ws://localhost:* and wss://<lan-ip>:*), --hub adds <meta name="mw-hub">, --doh adds <meta name="mw-doh">.
// - --tls serves HTTPS with mkcert certificates from .mw-dev-certs/ (generated locally when mkcert
//   is installed); phones on the LAN need the mkcert root CA installed.
// - With --dev, /_dev/seeder.html serves tools/seeder.html (the headless seeder of tools/demo.mjs).
// - v0.2.1 F7: when --root has no /_mw/sdk.js (a plain static site, a crawler's view of it), that URL
//   is answered with the static SDK stub src/sdk/sdk-static.js (mw.ready() → { mode: 'static' }),
//   so a page that imports it never meets a 404.
// - server.killSwitch() serves <root>/mw-sw-kill.js as /mw-sw.js (DESIGN-REVIEW item 20 acceptance); killSwitch(false) undoes it.
// - Dotfiles and dot-directories under --root (.git, .env) are never served, except .well-known and .mw.
//   The /ws/ web seed serves everything under --webseed, dot-directories included (/.mw/ is part of a torrent).

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createReadStream, readFileSync, statSync, existsSync, realpathSync, mkdirSync } from 'node:fs';
import { join, resolve, sep, dirname } from 'node:path';

import { mimeFor, extOf, parseRange, isShellHtml, headersFor } from '../src/sw/lib.js';
import { parsePointer } from '../src/common/pointer.js';
import {
  parseCli, runMain, isMain, devCerts, lanAddresses, injectMeta, isUtf16, ToolError, UsageError, out, warn, ROOT,
} from './lib.mjs';

const USAGE = `
Usage: node tools/dev-server.mjs [--root dist] [--port 8080] [--host 127.0.0.1] [--tls [--cert f --key f]]
                                [--webseed <dir>] [--pointer "<record>"|@file] [--dev] [--hub shared|subdomain]
                                [--doh <url template>] [--spa|--no-spa] [--idp-port <n> [--idp-root <dir>]] [--tracker-proxy <port>] [--quiet] [--json]

--idp-port <n>  also serve the identity page (--idp-root, default dist-idp, built by npm run build:idp) with its _headers on
                http://127.0.0.1:<n>/ (0 = a free port): a second origin, loopback only
--tracker-proxy <port>  pass WebSocket upgrades on /tracker to the tracker at ws://127.0.0.1:<port>, so the page's own origin carries
                it (wss://<host>:<port>/tracker with --tls); start the tracker yourself (tools/tracker.mjs)
`;

const MIME_EXTRA = { torrent: 'application/x-bittorrent' };
const RESERVED = ['/_mw/', '/ws/', '/.mw/', '/_dev/'];
const SEEDER = join(ROOT, 'tools', 'seeder.html');
const STORE_IDB = join(ROOT, 'src', 'files', 'store-idb.js');
const SDK_STATIC = join(ROOT, 'src', 'sdk', 'sdk-static.js');
const WEBSEED_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': 'Content-Range, Content-Length, Accept-Ranges, ETag',
  'access-control-max-age': '600',
};

export function contentTypeFor(path) {
  const ext = extOf(path);
  return Object.prototype.hasOwnProperty.call(MIME_EXTRA, ext) ? MIME_EXTRA[ext] : mimeFor(path);
}

// Dotfiles and dot-directories of a served project (.git, .env, .DS_Store) are not served; .well-known
// and .mw (the routing manifest and file list that publish writes) are.
const DOT_ALLOWED = new Set(['.well-known', '.mw']);
function hasHiddenSegment(segs) {
  return segs.some((seg) => seg.startsWith('.') && !DOT_ALLOWED.has(seg));
}

function isReserved(pathname) {
  return pathname === '/mw-sw.js' || pathname === '/ws' || RESERVED.some((p) => pathname.startsWith(p));
}

// '/a%20b/c' → ['a b', 'c'] or null when a segment is malformed or unsafe.
function decodeSegments(pathname) {
  const segs = [];
  for (const raw of pathname.split('/')) {
    if (raw === '') continue;
    let seg;
    try {
      seg = decodeURIComponent(raw);
    } catch (_) {
      return null;
    }
    if (seg === '.' || seg === '..' || /[/\\]/.test(seg) || seg.indexOf(String.fromCharCode(0)) >= 0) return null;
    segs.push(seg);
  }
  return segs;
}

function statOrNull(p) {
  try {
    return statSync(p);
  } catch (_) {
    return null;
  }
}

// True when `abs` (after following symbolic links) is `root` or below it.
function containedIn(root, abs) {
  try {
    const real = realpathSync(abs);
    return real === root || real.startsWith(root + sep);
  } catch (_) {
    return false;
  }
}

// The inode is part of the tag: two different files of equal size written in the same millisecond (an
// override swapped in for /mw-sw.js, say) must never share an ETag, or a revalidation answers 304
// with the other file's bytes.
function etagOf(st) {
  return 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '-' + Number(st.ino || 0).toString(16) + '"';
}

/**
 * createIdpServer({ root, port, quiet, log }) → Promise<{ server, url, urls, port, root, headers, close() }>
 * Serves the built identity page from `root` (default dist-idp) on 127.0.0.1 only. Every response carries the headers of the file
 * `_headers` in the root (the same syntax the Service Worker reads: a path line, then indented "Name: value" lines), re-read when it
 * changes; `_headers` and `_redirects` are never served; there is no SPA fallback and no directory listing.
 */
export async function createIdpServer({ root = 'dist-idp', port = 0, quiet = false, log = null } = {}) {
  const abs = resolve(root);
  if (!existsSync(abs)) throw new ToolError('--idp-root ' + root + ' does not exist (run: npm run build:idp)');
  const real = realpathSync(abs);
  const say = quiet ? () => {} : (log || ((line) => process.stdout.write(line + '\n')));
  let headerStamp = null;
  let manifest = { headers: [] };
  const rulesNow = () => {
    const st = statOrNull(join(real, '_headers'));
    const stamp = st ? st.size + '-' + Math.floor(st.mtimeMs) : null;
    if (stamp !== headerStamp) {
      headerStamp = stamp;
      manifest = { headers: st ? readFileSync(join(real, '_headers'), 'utf8') : [] };
    }
    return manifest;
  };
  const initial = rulesNow();
  if (!statOrNull(join(real, '_headers'))) say('[dev-server] warning: ' + root + ' has no _headers file; the identity page is served without its CSP and frame headers');

  function respond(req, res, status, headers, body) {
    const h = Object.assign({ 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' }, headers);
    if (body !== undefined && body !== null && h['content-length'] === undefined) h['content-length'] = String(Buffer.byteLength(body));
    res.writeHead(status, h);
    if (req.method === 'HEAD' || body === undefined || body === null) res.end();
    else res.end(body);
    say('[dev-server idp] ' + req.method + ' ' + req.url + ' ' + status);
  }
  // The _headers rules win over the defaults above, whatever the case of the name.
  function withRules(base, pathname) {
    const out = {};
    for (const [k, v] of Object.entries(base)) out[k.toLowerCase()] = v;
    const rules = headersFor(rulesNow(), pathname);
    for (const [k, v] of Object.entries(rules)) out[k.toLowerCase()] = v;
    return out;
  }

  function handle(req, res) {
    let url;
    try {
      url = new URL(String(req.url).startsWith('/') ? 'http://dev-server.invalid' + req.url : req.url, 'http://dev-server.invalid');
    } catch (_) {
      return respond(req, res, 400, { 'content-type': 'text/plain; charset=utf-8' }, 'Bad request\n');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return respond(req, res, req.method === 'OPTIONS' ? 204 : 405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' }, req.method === 'OPTIONS' ? undefined : 'Method not allowed\n');
    }
    const pathname = url.pathname;
    const segs = decodeSegments(pathname);
    if (!segs) return respond(req, res, 400, { 'content-type': 'text/plain; charset=utf-8' }, 'Bad path\n');
    const notFound = () => {
      const page = statOrNull(join(real, '404.html'));
      if (page && page.isFile()) return sendFile(req, res, join(real, '404.html'), page, '/404.html', 404);
      return respond(req, res, 404, withRules({ 'content-type': 'text/plain; charset=utf-8' }, pathname), 'Not found\n');
    };
    if (hasHiddenSegment(segs) || (segs.length === 1 && (segs[0] === '_headers' || segs[0] === '_redirects'))) return notFound();
    let file = join(real, ...segs);
    if (!(file + sep).startsWith(real + sep) && file !== real) return notFound();
    let st = statOrNull(file);
    if (st && !containedIn(real, file)) st = null;
    if (st && st.isDirectory()) {
      if (!pathname.endsWith('/')) {
        return respond(req, res, 301, { location: '/' + segs.map((s) => encodeURIComponent(s)).join('/') + '/' + url.search, 'content-type': 'text/plain; charset=utf-8' }, 'Moved\n');
      }
      file = join(file, 'index.html');
      st = statOrNull(file);
      if (st && !containedIn(real, file)) st = null;
    }
    if (!st || !st.isFile()) return notFound();
    return sendFile(req, res, file, st, pathname, 200);
  }

  function sendFile(req, res, file, st, pathname, status) {
    const headers = withRules({ 'content-type': contentTypeFor(file), 'last-modified': new Date(st.mtimeMs).toUTCString(), etag: etagOf(st), 'accept-ranges': 'bytes' }, pathname);
    const range = status === 200 ? parseRange(req.headers.range, st.size) : null;
    if (range === 416) {
      headers['content-range'] = 'bytes */' + st.size;
      return respond(req, res, 416, headers, '');
    }
    let start = 0;
    let end = st.size - 1;
    let code = status;
    if (range) {
      start = range.start;
      end = range.end;
      code = 206;
      headers['content-range'] = 'bytes ' + start + '-' + end + '/' + st.size;
    }
    headers['content-length'] = String(st.size === 0 ? 0 : end - start + 1);
    res.writeHead(code, Object.assign({ 'x-content-type-options': 'nosniff' }, headers));
    say('[dev-server idp] ' + req.method + ' ' + req.url + ' ' + code);
    if (req.method === 'HEAD' || st.size === 0) return res.end();
    const stream = createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    return stream.pipe(res);
  }

  const server = http.createServer(handle);
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const boundPort = server.address().port;
  return {
    server,
    port: boundPort,
    url: 'http://127.0.0.1:' + boundPort + '/',
    urls: ['http://127.0.0.1:' + boundPort + '/', 'http://localhost:' + boundPort + '/'],
    root: real,
    headers: Array.isArray(initial.headers) ? initial.headers : [],
    close: () => new Promise((r) => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

// v0.3 C2: --tracker-proxy. An upgrade request for exactly /tracker is passed, byte for byte, to a tracker on 127.0.0.1:<upstreamPort>
// (its request target becomes /, the way a client would address that tracker directly); any other upgrade gets a 404 and is closed. The
// two sockets are piped both ways and each ends when the other does. Nothing here reads or changes a WebSocket frame.
function proxyTrackerUpgrade(req, socket, head, upstreamPort, proxied, log) {
  let url;
  try {
    url = new URL(String(req.url).startsWith('/') ? 'http://dev-server.invalid' + req.url : req.url, 'http://dev-server.invalid');
  } catch (_) {
    socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
    return;
  }
  if (url.pathname !== '/tracker') {
    socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
    log('[dev-server] UPGRADE ' + req.url + ' 404');
    return;
  }
  const upstream = net.connect({ host: '127.0.0.1', port: upstreamPort });
  const pair = { destroy: () => { socket.destroy(); upstream.destroy(); } };
  proxied.add(pair);
  let connected = false;
  const finish = () => {
    proxied.delete(pair);
    pair.destroy();
  };
  socket.on('error', finish);
  socket.on('close', finish);
  upstream.on('close', finish);
  upstream.on('error', (err) => {
    log('[dev-server] /tracker: the tracker at 127.0.0.1:' + upstreamPort + ' is not reachable (' + ((err && err.code) || (err && err.message) || err) + ')');
    if (!connected && socket.writable && !socket.destroyed) {
      // Nothing was passed on yet: answer the client, whose socket then closes and ends the pair.
      socket.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
      upstream.destroy();
    } else finish();
  });
  upstream.once('connect', () => {
    connected = true;
    // The request head again, with the same header names and values, aimed at / (the tracker upgrades on any path).
    let text = req.method + ' / HTTP/' + req.httpVersion + '\r\n';
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) text += req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1] + '\r\n';
    upstream.write(text + '\r\n');
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
    log('[dev-server] UPGRADE /tracker -> ws://127.0.0.1:' + upstreamPort);
  });
}

/**
 * createDevServer(options) → Promise<{ server, url, urls, port, spa, idp, setPointer(text|null), override(urlPath, file|null),
 * killSwitch(on = true), close() }>   idp (with idpPort): { url, urls, port, root, close() } of createIdpServer
 * options: { root = 'dist', port = 8080 (0 = ephemeral), host = '127.0.0.1', tls = false (true or
 * { cert, key } file paths), tlsHosts = [] (extra names for a generated certificate), webseed = null, pointer = null (record text), dev = false, hub = null,
 * doh = null, spa = null (auto), idpPort = null (a number, 0 = ephemeral, serves idpRoot on 127.0.0.1), idpRoot = 'dist-idp',
 * trackerProxy = null (the port of a tracker on 127.0.0.1: WebSocket upgrades on /tracker are passed to it), quiet = false, log = console line writer }
 * v0.3 C2: the result also holds trackerProxy (the port, or null).
 */
export async function createDevServer(options = {}) {
  const o = Object.assign({ root: 'dist', port: 8080, host: '127.0.0.1', tls: false, webseed: null, pointer: null, dev: false, hub: null, doh: null, spa: null, trackerProxy: null, quiet: false }, options);
  if (o.trackerProxy !== null && o.trackerProxy !== undefined && (!Number.isInteger(o.trackerProxy) || o.trackerProxy < 1 || o.trackerProxy > 65535)) {
    throw new UsageError('--tracker-proxy must be the port of a tracker on 127.0.0.1, from 1 to 65535');
  }
  if (!existsSync(resolve(o.root))) throw new ToolError('--root ' + o.root + ' does not exist (run: node build.mjs)');
  const root = realpathSync(resolve(o.root));
  if (o.webseed && !existsSync(resolve(o.webseed))) {
    // The directory publish will write (start the server first, publish against its URL, then hand it the
    // pointer with setPointer): created when its parent exists, so a typo in the path is still an error.
    if (!existsSync(dirname(resolve(o.webseed)))) throw new ToolError('--webseed ' + o.webseed + ' does not exist');
    mkdirSync(resolve(o.webseed));
  }
  const webseedRoot = o.webseed ? realpathSync(resolve(o.webseed)) : null;
  const log = o.quiet ? () => {} : (o.log || ((line) => process.stdout.write(line + '\n')));

  let pointer = o.pointer;
  if (pointer && pointer.startsWith('@')) pointer = readFileSync(pointer.slice(1), 'utf8').trim();
  if (pointer) {
    const parsed = parsePointer(pointer);
    if (!parsed.ok) throw new UsageError('--pointer does not parse: ' + parsed.error + (parsed.detail ? ' (' + parsed.detail + ')' : ''));
  }
  if (o.hub && !['shared', 'subdomain'].includes(o.hub)) throw new UsageError('--hub must be shared or subdomain');
  const metas = [];
  if (pointer) metas.push({ name: 'mw-pointer', content: pointer });
  if (o.dev) metas.push({ name: 'mw-dev', content: '1' });
  if (o.hub) metas.push({ name: 'mw-hub', content: o.hub });
  if (o.doh) metas.push({ name: 'mw-doh', content: o.doh });

  // Replaces (or, with null, removes) the injected pointer while the server runs: a test or demo can
  // start the server first, publish against its URL, then hand it the pointer.
  function setPointer(text) {
    let value = text;
    if (value && value.startsWith('@')) value = readFileSync(value.slice(1), 'utf8').trim();
    if (value) {
      const parsed = parsePointer(value);
      if (!parsed.ok) throw new UsageError('pointer does not parse: ' + parsed.error + (parsed.detail ? ' (' + parsed.detail + ')' : ''));
    }
    const at = metas.findIndex((m) => m.name === 'mw-pointer');
    if (at >= 0) metas.splice(at, 1);
    if (value) metas.unshift({ name: 'mw-pointer', content: value });
  }

  let spa = o.spa;
  if (spa === null || spa === undefined) {
    const index = join(root, 'index.html');
    spa = existsSync(index) && isShellHtml(readFileSync(index, 'utf8'));
  }

  // URL path -> file served instead of what --root has there; used to swap /mw-sw.js for the kill switch
  // worker while the server runs (server.override, server.killSwitch).
  const overrides = new Map();
  for (const key of Object.keys(o.overrides || {})) overrides.set(key, resolve(o.overrides[key]));
  function override(urlPath, file) {
    if (file === null || file === undefined) overrides.delete(urlPath);
    else overrides.set(urlPath, resolve(file));
  }
  function killSwitch(on = true) {
    override('/mw-sw.js', on ? join(root, 'mw-sw-kill.js') : null);
  }

  function send(req, res, status, headers, body) {
    const h = Object.assign({ 'x-content-type-options': 'nosniff' }, headers);
    if (body !== undefined && body !== null && h['content-length'] === undefined) h['content-length'] = String(Buffer.byteLength(body));
    res.writeHead(status, h);
    if (req.method === 'HEAD' || body === undefined || body === null) res.end();
    else res.end(body);
    log('[dev-server] ' + req.method + ' ' + req.url + ' ' + status);
  }

  function serveFile(req, res, abs, st, { status = 200, cors = false, inject = false } = {}) {
    const type = contentTypeFor(abs);
    const headers = Object.assign({
      'content-type': type,
      'cache-control': 'no-cache',
      'last-modified': new Date(st.mtimeMs).toUTCString(),
    }, cors ? WEBSEED_CORS : {});
    if (inject && metas.length && /^text\/html/.test(type)) {
      const raw = readFileSync(abs);
      const body = isUtf16(raw) ? raw : Buffer.from(injectMeta(raw.toString('latin1'), metas).html, 'latin1');
      headers['content-length'] = String(body.length);
      return send(req, res, status, headers, body);
    }
    const etag = etagOf(st);
    headers.etag = etag;
    headers['accept-ranges'] = 'bytes';
    const range = status === 200 ? parseRange(req.headers.range, st.size) : null;
    if (range === null && status === 200 && req.headers['if-none-match'] === etag) {
      delete headers['content-type'];
      return send(req, res, 304, headers);
    }
    if (range === 416) {
      headers['content-range'] = 'bytes */' + st.size;
      return send(req, res, 416, headers, '');
    }
    let start = 0;
    let end = st.size - 1;
    let code = status;
    if (range) {
      start = range.start;
      end = range.end;
      code = 206;
      headers['content-range'] = 'bytes ' + start + '-' + end + '/' + st.size;
    }
    headers['content-length'] = String(st.size === 0 ? 0 : end - start + 1);
    res.writeHead(code, Object.assign({ 'x-content-type-options': 'nosniff' }, headers));
    log('[dev-server] ' + req.method + ' ' + req.url + ' ' + code);
    if (req.method === 'HEAD' || st.size === 0) return res.end();
    const stream = createReadStream(abs, { start, end });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  function notFound(req, res, cors) {
    send(req, res, 404, Object.assign({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' }, cors ? WEBSEED_CORS : {}), 'Not found\n');
  }

  function handle(req, res) {
    let url;
    try {
      // The request target is a path (code review round 1): '//sub' resolved against a base would
      // be read as the host "sub", so it is appended to the origin instead.
      url = new URL(String(req.url).startsWith('/') ? 'http://dev-server.invalid' + req.url : req.url, 'http://dev-server.invalid');
    } catch (_) {
      return send(req, res, 400, { 'content-type': 'text/plain; charset=utf-8' }, 'Bad request\n');
    }
    const pathname = url.pathname;
    const isWs = pathname === '/ws' || pathname.startsWith('/ws/');
    if (req.method === 'OPTIONS') {
      if (isWs) return send(req, res, 204, Object.assign({ 'content-length': '0' }, WEBSEED_CORS));
      return send(req, res, 204, { allow: 'GET, HEAD, OPTIONS', 'content-length': '0' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(req, res, 405, Object.assign({ allow: 'GET, HEAD, OPTIONS', 'content-type': 'text/plain; charset=utf-8' }, isWs ? WEBSEED_CORS : {}), 'Method not allowed\n');
    }
    const segs = decodeSegments(pathname);
    if (!segs) return send(req, res, 400, { 'content-type': 'text/plain; charset=utf-8' }, 'Bad path\n');

    if (isWs) {
      if (!webseedRoot) return notFound(req, res, true);
      const abs = join(webseedRoot, ...segs.slice(1));
      if (!(abs + sep).startsWith(webseedRoot + sep) && abs !== webseedRoot) return notFound(req, res, true);
      const st = statOrNull(abs);
      if (!st || !st.isFile() || !containedIn(webseedRoot, abs)) return notFound(req, res, true);
      return serveFile(req, res, abs, st, { cors: true });
    }

    if (o.dev && pathname === '/_dev/seeder.html') {
      const st = statOrNull(SEEDER);
      if (st) return serveFile(req, res, SEEDER, st);
    }
    // v0.3: the seeder page keeps the torrent in the browser profile (IndexedDB, on disk) with the same chunk store the loader uses.
    if (o.dev && pathname === '/_dev/store-idb.js') {
      const st = statOrNull(STORE_IDB);
      if (st) return serveFile(req, res, STORE_IDB, st);
    }

    if (pathname === '/_mw/sdk.js' && !statOrNull(join(root, '_mw', 'sdk.js'))) {
      const sst = statOrNull(SDK_STATIC);
      if (sst && sst.isFile()) return serveFile(req, res, SDK_STATIC, sst, {});
    }

    if (overrides.has(pathname)) {
      const file = overrides.get(pathname);
      const ost = statOrNull(file);
      if (ost && ost.isFile()) return serveFile(req, res, file, ost, {});
    }
    if (hasHiddenSegment(segs)) return notFound(req, res, false);
    let abs = join(root, ...segs);
    if (!(abs + sep).startsWith(root + sep) && abs !== root) return notFound(req, res, false);
    let st = statOrNull(abs);
    if (st && !containedIn(root, abs)) st = null; // a symbolic link out of the root
    if (st && st.isDirectory()) {
      if (!pathname.endsWith('/')) {
        // Built from the decoded segments (code review round 1): echoing the pathname turned
        // GET /.//assets into "Location: //assets/", a scheme-relative redirect to the host "assets".
        const location = '/' + segs.map((s) => encodeURIComponent(s)).join('/') + '/' + url.search;
        return send(req, res, 301, { location, 'content-type': 'text/plain; charset=utf-8' }, 'Moved\n');
      }
      abs = join(abs, 'index.html');
      st = statOrNull(abs);
      if (st && !containedIn(root, abs)) st = null;
    }
    if (st && st.isFile()) return serveFile(req, res, abs, st, { inject: true });

    if (!isReserved(pathname)) {
      if (spa) {
        const index = join(root, 'index.html');
        const ist = statOrNull(index);
        if (ist && ist.isFile()) return serveFile(req, res, index, ist, { inject: true });
      }
      const page = join(root, '404.html');
      const pst = statOrNull(page);
      if (pst && pst.isFile()) return serveFile(req, res, page, pst, { status: 404, inject: true });
    }
    return notFound(req, res, false);
  }

  let server;
  let scheme = 'http';
  if (o.tls) {
    const hosts = ['localhost', '127.0.0.1', '::1'];
    if (o.host !== '127.0.0.1' && o.host !== 'localhost' && o.host !== '0.0.0.0' && o.host !== '::') hosts.push(o.host);
    if (o.host === '0.0.0.0' || o.host === '::') for (const ip of lanAddresses()) hosts.push(ip);
    for (const h of o.tlsHosts || []) if (!hosts.includes(h)) hosts.push(h); // names the certificate must cover (a phone types them)
    const certs = devCerts(Object.assign({ hosts }, typeof o.tls === 'object' ? o.tls : {}));
    server = https.createServer({ cert: certs.cert, key: certs.key }, handle);
    scheme = 'https';
  } else {
    server = http.createServer(handle);
  }
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const port = server.address().port;
  const proxied = new Set();
  if (o.trackerProxy !== null && o.trackerProxy !== undefined) {
    server.on('upgrade', (req, socket, head) => proxyTrackerUpgrade(req, socket, head, o.trackerProxy, proxied, log));
  }
  const hostForUrl = o.host === '0.0.0.0' || o.host === '::' ? '127.0.0.1' : (o.host.indexOf(':') >= 0 ? '[' + o.host + ']' : o.host);
  const urls = [scheme + '://' + hostForUrl + ':' + port + '/'];
  if (o.host === '0.0.0.0' || o.host === '::') for (const ip of lanAddresses()) urls.push(scheme + '://' + ip + ':' + port + '/');
  let idp = null;
  if (o.idpPort !== null && o.idpPort !== undefined) {
    try {
      idp = await createIdpServer({ root: o.idpRoot || 'dist-idp', port: o.idpPort, quiet: o.quiet, log: o.log });
    } catch (err) {
      await new Promise((r) => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        server.close(() => r());
      });
      throw err;
    }
  }
  return {
    server,
    port,
    url: urls[0],
    urls,
    spa,
    idp,
    trackerProxy: o.trackerProxy === undefined ? null : o.trackerProxy,
    setPointer,
    override,
    killSwitch,
    close: async () => {
      if (idp) await idp.close();
      // closeAllConnections() does not reach upgraded sockets: end the proxied WebSocket pairs here.
      for (const pair of proxied) pair.destroy();
      proxied.clear();
      await new Promise((r) => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        server.close(() => r());
      });
    },
  };
}

async function main(argv) {
  const { flags, positionals } = parseCli(argv, {
    root: { type: 'string', default: 'dist' },
    port: { type: 'int', default: 8080 },
    host: { type: 'string', default: '127.0.0.1' },
    tls: { type: 'tls' },
    cert: { type: 'string' },
    key: { type: 'string' },
    webseed: { type: 'string' },
    pointer: { type: 'string' },
    dev: { type: 'boolean' },
    hub: { type: 'string' },
    doh: { type: 'string' },
    spa: { type: 'boolean', default: null },
    'idp-port': { type: 'int' },
    'idp-root': { type: 'string', default: 'dist-idp' },
    'tracker-proxy': { type: 'int' },
    quiet: { type: 'boolean' },
    json: { type: 'boolean' },
  });
  if (flags.help) {
    out(USAGE.trim());
    return 0;
  }
  if (positionals.length) throw new UsageError('unexpected argument ' + positionals[0]);
  let tls = flags.tls;
  if (tls && (flags.cert || flags.key)) tls = { cert: flags.cert, key: flags.key };
  if (!tls && (flags.cert || flags.key)) throw new UsageError('--cert and --key need --tls');
  const srv = await createDevServer(Object.assign({}, flags, { tls }));
  if (flags.json) out(JSON.stringify(Object.assign({ url: srv.url, urls: srv.urls, port: srv.port, spa: srv.spa }, srv.idp ? { idp: { url: srv.idp.url, urls: srv.idp.urls, port: srv.idp.port } } : {}, srv.trackerProxy !== null ? { trackerProxy: srv.trackerProxy } : {})));
  else {
    out('felinar dev-server: ' + flags.root + (srv.spa ? ' (SPA fallback on)' : '') + (flags.webseed ? ', web seed ' + flags.webseed + ' at /ws/' : ''));
    for (const u of srv.urls) out('  ' + u);
    if (srv.idp) {
      out('  identity page (' + flags.idpRoot + ', with its _headers, loopback only; a second origin):');
      for (const u of srv.idp.urls) out('    ' + u);
    }
    if (srv.trackerProxy !== null) out('  tracker proxy: WebSocket upgrades on /tracker go to ws://127.0.0.1:' + srv.trackerProxy + ' (on this origin: ' + srv.url.replace(/^http/, 'ws') + 'tracker)');
    if (flags.pointer) out('  pointer meta injected into HTML pages');
    if (flags.dev) out('  dev mode: <meta name="mw-dev" content="1">, seeder at ' + srv.url + '_dev/seeder.html');
  }
  if (flags.host === '0.0.0.0' && !tls) warn('phones on the LAN need --tls: browsers allow Service Workers and WebCrypto only on https:// or localhost');
  const stop = () => srv.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return undefined;
}

if (isMain(import.meta.url)) runMain(main, USAGE);
