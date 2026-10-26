#!/usr/bin/env node
// tools/check-webseed.mjs: the single verification gate for web seeds and hosts (ARCHITECTURE §10,
// DESIGN-REVIEW item 14; v0.2.1: DIGEST-AMENDMENTS B3, B4, MIGRATION-DIGEST M06). One of the three tools
// allowed to contact remote hosts (docs/DEV-NETWORK.md): it prints every target before connecting and
// the tests only ever point it at 127.0.0.1.
//
//   node tools/check-webseed.mjs <base> <site.torrent> [--mode seed|origin|host] [--xs <url>]...
//        [--origin <site origin>] [--pieces first-last|all|none] [--allow-no-preflight] [--timeout 10000] [--json]
//
// Three modes, one tool (publish --verify-ws / --verify-host and check-site call the same functions):
//
//   seed (default)  <base> is a BEP 19 web seed: files at <base>/<torrent name>/<file path>.
//     Per file, cross-origin only: OPTIONS with Access-Control-Request-Headers: range (the only header
//     felinar's patched client sends; v0.2.1 B3) must answer 2xx with Allow-Origin and Allow-Headers
//     covering range; the stock WebTorrent set (cache-control, range, user-agent) is probed once and
//     reported (PASS-needs-patched-client when only the patched set passes).
//     Per file: a GET sent the way a browser sends a Range request (Range, Accept-Encoding: identity,
//     Origin; no Cache-Control, no User-Agent) must answer 206 with Content-Range bytes 0-0/<length>,
//     one byte, no Content-Encoding and, cross-origin, Access-Control-Allow-Origin. A 200 is "Range
//     ignored" (Cloudflare Pages, cdnjs): WebTorrent would take the whole body as the block.
//     Pieces: the SHA-1 of the first and the last piece (--pieces all: every piece), each assembled
//     from ranged GETs across the files it spans: wrong bytes (jsDelivr's 206 cut from a brotli
//     stream, a file overwritten in place) fail here, before visitors hot-loop on them.
//     --xs: each .torrent URL answers 200 (with CORS) and has the pointer's infohash.
//   origin          <base> is the site origin and every file of the torrent is at <base>/<path> (a
//     drop-in host, whose files the Service Worker fetches whole for its /_mw/ws/ rewrite): a full GET
//     of every file with Accept-Encoding: identity, every piece SHA-1 checked; one Range probe says
//     whether the host honours Range (a 200 is fine for drop-in, but such a host cannot be a
//     cross-origin web seed).
//   host            as origin, but each file is requested the way a browser asks for it (an Accept
//     header by type, Accept-Encoding: gzip, deflate, br): catches edge transforms (image
//     optimisation, minification, Accept-dependent formats) that change bytes for browsers only.
//
// Verdicts: PASS | PASS-needs-patched-client | PASS-no-preflight (only with --allow-no-preflight: the
// host has no CORS preflight answer, browsers that preflight a Range header cannot use it) |
// FAIL-range-ignored | FAIL-wrong-bytes | FAIL-cors | FAIL. Exit 0 on PASS*, 1 on FAIL*, 2 on usage errors.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { parseTorrentFile, sliceForPiece } from '../src/common/torrent-file.js';
import { parseCli, runMain, isMain, ToolError, UsageError, out } from './lib.mjs';

const USAGE = `
Usage: node tools/check-webseed.mjs <base> <site.torrent> [--mode seed|origin|host] [--xs <url>]...
                                    [--origin <site origin>] [--pieces first-last|all|none]
                                    [--allow-no-preflight] [--timeout <ms>] [--json]
seed (default): <base> is the web seed base (files at <base>/<name>/<path>). origin, host: <base> is the
site origin (files at <base>/<path>, drop-in). Exit 0 when the verdict is PASS*, 1 on FAIL*, 2 on usage errors.
`;

const DEFAULT_ORIGIN = 'https://check-webseed.invalid';

/**
 * The request-header sets a browser may preflight for a web-seed request. v0.2.1 B3: felinar ships
 * WebTorrent patched to send only Range (CORS-safelisted for simple byte ranges in current Chromium and
 * WebKit, which then send no preflight; older engines may still ask for it); the stock 3.0.21 client
 * also sends Cache-Control and User-Agent, which every browser preflights.
 */
export const PREFLIGHT_SETS = Object.freeze({
  patched: Object.freeze(['range']),
  stock: Object.freeze(['cache-control', 'range', 'user-agent']),
});

export const VERDICTS = Object.freeze(['PASS', 'PASS-needs-patched-client', 'PASS-no-preflight', 'FAIL-range-ignored', 'FAIL-wrong-bytes', 'FAIL-cors', 'FAIL']);

function encodeSegments(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

/** URL of a torrent file on a BEP 19 web seed (multi-file: <base>/<name>/<path>). */
export function webseedUrl(base, parsed, file) {
  if (!parsed.multiFile) return base.endsWith('/') ? base + encodeURIComponent(parsed.name) : base;
  return (base.endsWith('/') ? base : base + '/') + encodeSegments(parsed.name) + '/' + encodeSegments(file.path);
}

/** URL of a torrent file served at its own path on a host (drop-in: <origin>/<path>). */
export function hostFileUrl(base, file) {
  return (base.endsWith('/') ? base : base + '/') + encodeSegments(file.path);
}

function headerList(value) {
  return String(value || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function sameOriginAs(url, origin) {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch (_) {
    return false;
  }
}

/** The Accept header a browser sends for a file of this type (host mode). */
export function browserAccept(path) {
  const ext = (/\.([a-z0-9]+)$/i.exec(path) || [])[1];
  const e = ext ? ext.toLowerCase() : '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp', 'apng'].includes(e)) return 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
  if (e === 'css') return 'text/css,*/*;q=0.1';
  if (['html', 'htm', 'xhtml'].includes(e)) return 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
  if (['mp4', 'webm', 'mp3', 'ogg', 'oga', 'ogv', 'wav', 'm4a', 'flac'].includes(e)) return '*/*';
  if (['woff', 'woff2', 'ttf', 'otf'].includes(e)) return '*/*';
  return '*/*';
}

async function request(fetchImpl, url, init, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetchImpl(url, Object.assign({ redirect: 'follow', signal }, init));
    return { res, error: null };
  } catch (err) {
    const cause = err && err.cause && err.cause.code ? ' (' + err.cause.code + ')' : '';
    const msg = err && err.name === 'TimeoutError' ? 'no answer within ' + timeoutMs + ' ms' : 'network error: ' + ((err && err.message) || String(err)) + cause;
    return { res: null, error: msg };
  }
}

async function drain(res) {
  try {
    return new Uint8Array(await res.arrayBuffer());
  } catch (_) {
    return null;
  }
}

function acaoProblem(res, origin, what) {
  const acao = res.headers.get('access-control-allow-origin');
  if (!acao) return 'no Access-Control-Allow-Origin header on the ' + what;
  if (acao !== '*' && acao !== origin) return 'Access-Control-Allow-Origin on the ' + what + ' is ' + JSON.stringify(acao) + ', not * or ' + origin;
  return null;
}

/**
 * preflight(fetch, url, origin, headers, timeoutMs) → { ok, status, problems }: an OPTIONS request the
 * way a browser sends it before a GET carrying `headers`.
 */
async function preflight(fetchImpl, url, origin, headers, timeoutMs) {
  const pre = await request(fetchImpl, url, {
    method: 'OPTIONS',
    redirect: 'manual',
    headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': headers.join(',') },
  }, timeoutMs);
  if (pre.error) return { ok: false, status: 0, problems: ['OPTIONS: ' + pre.error] };
  const res = pre.res;
  await drain(res);
  const problems = [];
  if (res.status >= 300 && res.status < 400) problems.push('OPTIONS answered a redirect (' + res.status + '): browsers never follow a redirect of a preflight');
  else if (res.status < 200 || res.status > 299) problems.push('OPTIONS answered ' + res.status + ': the host does not answer CORS preflights');
  else {
    const p = acaoProblem(res, origin, 'OPTIONS preflight');
    if (p) problems.push(p);
    const allowed = headerList(res.headers.get('access-control-allow-headers'));
    if (allowed.indexOf('*') < 0) {
      const missing = headers.filter((h) => allowed.indexOf(h) < 0);
      if (missing.length) problems.push('Access-Control-Allow-Headers does not allow ' + missing.join(', ') + ' (answer * or list them)');
    }
    const methods = headerList(res.headers.get('access-control-allow-methods'));
    if (methods.length && methods.indexOf('*') < 0 && methods.indexOf('get') < 0) problems.push('Access-Control-Allow-Methods does not allow GET');
  }
  return { ok: problems.length === 0, status: res.status, problems };
}

/**
 * Headers of a ranged GET as a browser sends it. Accept-Encoding: identity is not set here: the Fetch
 * standard appends it to every request with a Range header, in browsers and in Node's fetch alike.
 */
function rangeHeaders(range, origin, cors) {
  const h = { range, accept: '*/*' };
  if (cors) h.origin = origin;
  return h;
}

/** One ranged GET → { bytes, problems, status } with the exact-206 rules (shared by file and piece checks). */
async function rangedGet({ fetchImpl, url, start, end, length, origin, cors, timeoutMs }) {
  const problems = [];
  const got = await request(fetchImpl, url, { method: 'GET', headers: rangeHeaders('bytes=' + start + '-' + end, origin, cors) }, timeoutMs);
  if (got.error) return { bytes: null, status: 0, problems: ['GET: ' + got.error], kind: 'network' };
  const res = got.res;
  const bytes = await drain(res);
  let kind = null;
  if (res.status === 404 || res.status === 410) {
    problems.push('GET answered ' + res.status + ': the file is not uploaded at this URL');
    kind = 'missing';
  } else if (res.status === 200) {
    problems.push('GET with Range: bytes=' + start + '-' + end + ' answered 200 with the whole file instead of 206: Web seed misconfigured (no Range support); WebTorrent would take the whole body as the block');
    kind = 'range-ignored';
  } else if (res.status !== 206) {
    problems.push('GET with Range: bytes=' + start + '-' + end + ' answered ' + res.status + ', expected 206 Partial Content');
    kind = 'status';
  } else {
    const cr = (res.headers.get('content-range') || '').trim();
    const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(cr);
    if (!m || Number(m[1]) !== start || Number(m[2]) !== end) {
      problems.push('206 without "Content-Range: bytes ' + start + '-' + end + '/' + length + '" (got ' + JSON.stringify(cr) + ')');
      kind = 'content-range';
    } else if (m[3] !== '*' && Number(m[3]) !== length) {
      problems.push('Content-Range says the file has ' + m[3] + ' bytes, the torrent says ' + length + ': the host serves another version of this file, or a compressed representation');
      kind = 'length';
    }
    const enc = (res.headers.get('content-encoding') || '').trim().toLowerCase();
    if (enc && enc !== 'identity') {
      problems.push('the 206 has Content-Encoding: ' + enc + ' although the request asked for identity: the range was cut from compressed bytes');
      kind = kind || 'encoding';
    }
    if (bytes && bytes.length !== end - start + 1) {
      problems.push('206 body is ' + bytes.length + ' bytes, expected ' + (end - start + 1));
      kind = kind || 'length';
    }
  }
  if (cors && res.status !== 404) {
    const p = acaoProblem(res, origin, 'GET response');
    if (p) {
      problems.push(p);
      kind = kind || 'cors';
    }
  }
  if (res.redirected && cors) problems.push('the GET was redirected to ' + res.url + ': a redirect target must also send Access-Control-Allow-Origin');
  return { bytes, status: res.status, problems, kind, res };
}

async function checkSeedFile({ fetchImpl, url, file, origin, cors, timeoutMs, allowNoPreflight }) {
  const problems = [];
  const warnings = [];
  const info = {};
  const kinds = [];
  if (cors) {
    const pre = await preflight(fetchImpl, url, origin, PREFLIGHT_SETS.patched, timeoutMs);
    info.preflight = pre.ok ? 'pass' : 'fail';
    info.options = pre.status;
    if (!pre.ok) {
      const text = pre.problems.map((p) => p + ' (the preflight a browser sends before a request with a Range header)');
      if (allowNoPreflight) warnings.push(...text);
      else {
        problems.push(...text);
        kinds.push('cors');
      }
    }
  }
  if (file.length === 0) {
    const got = await request(fetchImpl, url, { method: 'GET', headers: cors ? { origin, accept: '*/*' } : { accept: '*/*' } }, timeoutMs);
    if (got.error) problems.push('GET: ' + got.error);
    else {
      info.get = got.res.status;
      await drain(got.res);
      if (got.res.status === 404 || got.res.status === 410) problems.push('GET answered ' + got.res.status + ': the file is not uploaded at this URL');
      else if (got.res.status !== 200 && got.res.status !== 204) problems.push('GET of an empty file answered ' + got.res.status);
    }
    return { ok: problems.length === 0, problems, warnings, info, kinds };
  }
  const r = await rangedGet({ fetchImpl, url, start: 0, end: 0, length: file.length, origin, cors, timeoutMs });
  info.get = r.status;
  if (r.res) info.contentRange = r.res.headers.get('content-range') || '';
  problems.push(...r.problems);
  if (r.kind) kinds.push(r.kind);
  if (cors && r.res && r.status === 206) {
    const exposed = headerList(r.res.headers.get('access-control-expose-headers'));
    if (exposed.indexOf('*') < 0 && exposed.indexOf('content-range') < 0) {
      // v0.2.1: a warning only; WebTorrent and the loader read the status and the body, never Content-Range.
      warnings.push('Access-Control-Expose-Headers does not include Content-Range (not needed by WebTorrent; expose Content-Range, Content-Length, Accept-Ranges, ETag for other clients)');
    }
  }
  return { ok: problems.length === 0, problems, warnings, info, kinds };
}

async function checkXs({ fetchImpl, url, parsed, origin, cors, timeoutMs }) {
  const problems = [];
  const headers = cors ? { origin, accept: '*/*' } : { accept: '*/*' };
  const get = await request(fetchImpl, url, { method: 'GET', headers }, timeoutMs);
  if (get.error) return { ok: false, problems: ['GET: ' + get.error], warnings: [], kinds: ['network'] };
  const res = get.res;
  if (res.status !== 200) {
    await drain(res);
    problems.push('GET answered ' + res.status + ', expected 200');
    return { ok: false, problems, warnings: [], kinds: ['status'] };
  }
  const kinds = [];
  if (cors) {
    const p = acaoProblem(res, origin, 'GET response');
    if (p) {
      problems.push(p + ': the loader fetches xs= with CORS');
      kinds.push('cors');
    }
  }
  try {
    const got = await parseTorrentFile(new Uint8Array(await res.arrayBuffer()));
    if (got.infoHash !== parsed.infoHash) {
      problems.push('this .torrent has infohash ' + got.infoHash + ', expected ' + parsed.infoHash + ' (upload the new .torrent)');
      kinds.push('wrong-bytes');
    }
  } catch (err) {
    problems.push('not a valid .torrent: ' + err.message);
    kinds.push('wrong-bytes');
  }
  return { ok: problems.length === 0, problems, warnings: [], kinds };
}

function pieceHash(parsed, index) {
  return Buffer.from(parsed.pieces.subarray(index * 20, index * 20 + 20)).toString('hex');
}

function sha1Hex(bytes) {
  return createHash('sha1').update(bytes).digest('hex');
}

/** pieceIndices(parsed, which) → the piece indices to check: 'first-last' | 'all' | 'none'. */
export function pieceIndices(parsed, which = 'first-last') {
  const n = parsed.pieceCount || 0;
  if (!n || which === 'none') return [];
  if (which === 'all') return Array.from({ length: n }, (_, i) => i);
  return n === 1 ? [0] : [0, n - 1];
}

async function checkPiece({ fetchImpl, parsed, index, urlOf, origin, crossOf, timeoutMs }) {
  const problems = [];
  const kinds = [];
  const parts = [];
  const spans = sliceForPiece(parsed, index);
  const urls = [];
  for (const span of spans) {
    const file = parsed.files[span.fileIndex];
    if (file.pad) {
      parts.push(new Uint8Array(span.end - span.start)); // BEP 47 padding is zeros and never fetched
      continue;
    }
    const url = urlOf(file);
    urls.push(url);
    const r = await rangedGet({ fetchImpl, url, start: span.start, end: span.end - 1, length: file.length, origin, cors: crossOf(url), timeoutMs });
    if (r.problems.length) {
      problems.push(...r.problems.map((p) => file.path + ': ' + p));
      if (r.kind) kinds.push(r.kind);
      return { ok: false, problems, kinds, urls };
    }
    parts.push(r.bytes);
  }
  const data = Buffer.concat(parts.map((p) => Buffer.from(p)));
  if (sha1Hex(data) !== pieceHash(parsed, index)) {
    problems.push('piece ' + index + ' (' + spans.map((s) => parsed.files[s.fileIndex].path).join(', ') + '): the SHA-1 of the bytes served differs from the torrent: the host serves wrong bytes (a file overwritten in place, a transform, or a range cut from compressed bytes); visitors would discard the piece and ask again and again');
    kinds.push('wrong-bytes');
  }
  return { ok: problems.length === 0, problems, kinds, urls };
}

/** Distinct origins of the web seed files and xs URLs (printed before connecting). */
export function webseedTargets(wsBase, parsed, xs = []) {
  const origins = [];
  for (const u of [wsBase].concat(xs)) {
    try {
      const o = new URL(u).origin;
      if (origins.indexOf(o) < 0) origins.push(o);
    } catch (_) { /* reported later */ }
  }
  return { origins, files: parsed.files.filter((f) => !f.pad).length, xs: xs.length };
}

/** verdictOf(results, { stockFailed }) → one of VERDICTS. */
export function verdictOf(results, { stockFailed = false, noPreflight = false } = {}) {
  const kinds = new Set();
  for (const r of results) for (const k of r.kinds || []) kinds.add(k);
  if (results.some((r) => !r.ok)) {
    if (kinds.has('wrong-bytes') || kinds.has('length') || kinds.has('encoding')) return 'FAIL-wrong-bytes';
    if (kinds.has('range-ignored')) return 'FAIL-range-ignored';
    if (kinds.has('cors')) return 'FAIL-cors';
    return 'FAIL';
  }
  if (noPreflight) return 'PASS-no-preflight';
  if (stockFailed) return 'PASS-needs-patched-client';
  return 'PASS';
}

async function runJobs(jobs, concurrency, onResult) {
  const results = new Array(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      const job = jobs[i];
      const r = await job.run();
      results[i] = {
        kind: job.kind, path: job.path, url: job.url, ok: r.ok, problems: r.problems || [], warnings: r.warnings || [],
        info: r.info || {}, kinds: r.kinds || [],
      };
      if (onResult) onResult(results[i]);
    }
  };
  const workers = [];
  for (let w = 0; w < Math.max(1, Math.min(concurrency, jobs.length)); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/**
 * checkWebseed({ wsBase, torrent, xs, origin, fetch, timeoutMs, concurrency, onResult, pieces, allowNoPreflight })
 *   → { ok, verdict, mode: 'seed', btih, name, results: [{ kind: 'file'|'piece'|'xs', path, url, ok, problems,
 *       warnings, info, kinds }], failed, warned, stock: { checked, ok, problems } }
 * Seed mode (see the header). torrent: .torrent bytes or a parseTorrentFile result. fetch defaults to
 * the global fetch.
 */
export async function checkWebseed({
  wsBase, torrent, xs = [], origin = DEFAULT_ORIGIN, fetch: fetchImpl = globalThis.fetch, timeoutMs = 10000, concurrency = 4,
  onResult = null, pieces = 'first-last', allowNoPreflight = false,
} = {}) {
  if (typeof wsBase !== 'string' || !/^https?:\/\//i.test(wsBase)) throw new UsageError('the web seed base must be an http(s) URL');
  if (!['first-last', 'all', 'none'].includes(pieces)) throw new UsageError('--pieces must be first-last, all or none');
  const parsed = torrent && torrent.infoHash && torrent.files ? torrent : await parseTorrentFile(torrent);
  const crossOf = (u) => !sameOriginAs(u, origin);
  const jobs = [];
  for (const file of parsed.files) {
    if (file.pad) continue;
    const url = webseedUrl(wsBase, parsed, file);
    jobs.push({ kind: 'file', path: file.path, url, run: () => checkSeedFile({ fetchImpl, url, file, origin, cors: crossOf(url), timeoutMs, allowNoPreflight }) });
  }
  for (const u of xs) {
    jobs.push({ kind: 'xs', path: u, url: u, run: () => checkXs({ fetchImpl, url: u, parsed, origin, cors: crossOf(u), timeoutMs }) });
  }
  const results = await runJobs(jobs, concurrency, onResult);
  // The stock header set, once (B3: report which set passes; the build ships the patched client).
  const stock = { checked: false, ok: null, problems: [] };
  const firstFile = parsed.files.find((f) => !f.pad);
  if (firstFile && crossOf(webseedUrl(wsBase, parsed, firstFile))) {
    const pre = await preflight(fetchImpl, webseedUrl(wsBase, parsed, firstFile), origin, PREFLIGHT_SETS.stock, timeoutMs);
    stock.checked = true;
    stock.ok = pre.ok;
    stock.problems = pre.problems;
  }
  // Piece SHA-1: only when every file answered (a missing file is reported once, not per piece).
  if (results.every((r) => r.kind !== 'file' || r.ok)) {
    const pieceJobs = pieceIndices(parsed, pieces).map((index) => ({
      kind: 'piece',
      path: 'piece ' + index,
      url: null,
      run: async () => {
        const r = await checkPiece({ fetchImpl, parsed, index, urlOf: (f) => webseedUrl(wsBase, parsed, f), origin, crossOf, timeoutMs });
        return { ok: r.ok, problems: r.problems, kinds: r.kinds, info: { piece: index, urls: r.urls } };
      },
    }));
    results.push(...(await runJobs(pieceJobs, concurrency, onResult)));
  }
  const failed = results.filter((r) => !r.ok).length;
  const warned = results.filter((r) => r.warnings && r.warnings.length).length;
  const noPreflight = allowNoPreflight && results.some((r) => r.info && r.info.preflight === 'fail');
  const verdict = verdictOf(results, { stockFailed: stock.checked && stock.ok === false, noPreflight });
  return { ok: failed === 0, verdict, mode: 'seed', btih: parsed.infoHash, name: parsed.name, results, failed, warned, stock };
}

/**
 * verifyHostFiles({ base, torrent, mode: 'origin'|'host', origin, fetch, timeoutMs, concurrency, onResult })
 *   → { ok, verdict, mode, btih, name, results: [{ kind: 'host', path, url, ok, problems, warnings, info, kinds }],
 *       failed, warned, range: { checked, honoured, status } }
 * Origin and host modes (see the header): a full GET of every file at <base>/<path>, then every piece's
 * SHA-1 over the bytes the host served, attributed to the files it spans.
 */
export async function verifyHostFiles({
  base, torrent, mode = 'host', origin = null, fetch: fetchImpl = globalThis.fetch, timeoutMs = 10000, concurrency = 4, onResult = null,
} = {}) {
  if (typeof base !== 'string' || !/^https?:\/\//i.test(base)) throw new UsageError('the host base must be an http(s) URL');
  if (mode !== 'origin' && mode !== 'host') throw new UsageError('mode must be origin or host');
  const parsed = torrent && torrent.infoHash && torrent.files ? torrent : await parseTorrentFile(torrent);
  const siteOrigin = origin || new URL(base).origin;
  const bodies = new Map(); // file index → Uint8Array of what the host served (only when the length matched)
  const jobs = [];
  parsed.files.forEach((file, index) => {
    if (file.pad) return;
    const url = hostFileUrl(base, file);
    jobs.push({
      kind: 'host',
      path: file.path,
      url,
      run: async () => {
        const problems = [];
        const warnings = [];
        const kinds = [];
        const headers = mode === 'host'
          ? { accept: browserAccept(file.path), 'accept-encoding': 'gzip, deflate, br' }
          : { accept: '*/*', 'accept-encoding': 'identity' };
        if (!sameOriginAs(url, siteOrigin)) headers.origin = siteOrigin;
        const got = await request(fetchImpl, url, { method: 'GET', headers }, timeoutMs);
        if (got.error) return { ok: false, problems: ['GET: ' + got.error], kinds: ['network'] };
        const res = got.res;
        const info = { status: res.status, encoding: res.headers.get('content-encoding') || null, vary: res.headers.get('vary') || null, type: res.headers.get('content-type') || null };
        const bytes = await drain(res);
        if (res.status !== 200) {
          problems.push(url + ' answered HTTP ' + res.status + ' (the torrent lists it; upload every non-HTML file before the pages)');
          kinds.push(res.status === 404 || res.status === 410 ? 'missing' : 'status');
          return { ok: false, problems, kinds, info };
        }
        if (res.redirected) warnings.push('redirected to ' + res.url);
        if (!bytes || bytes.length !== file.length) {
          problems.push(url + ' is ' + (bytes ? bytes.length : '?') + ' bytes on the host, the torrent says ' + file.length + ' (another version is deployed' +
            (mode === 'host' && info.encoding ? ', or the host transforms it for browsers: Content-Encoding ' + info.encoding : '') + ')');
          kinds.push('length');
          return { ok: false, problems, kinds, info };
        }
        bodies.set(index, bytes);
        if (mode === 'host' && info.vary && /\baccept\b/i.test(info.vary)) warnings.push('Vary: ' + info.vary + ': the host may send other bytes to other browsers (Accept-dependent formats)');
        return { ok: true, problems, warnings, kinds, info };
      },
    });
  });
  const results = await runJobs(jobs, concurrency, onResult);
  // Every piece whose files all arrived with the right length: SHA-1 over the served bytes.
  const bad = new Map(); // file index → piece indices that failed
  for (let i = 0; i < parsed.pieceCount; i++) {
    const spans = sliceForPiece(parsed, i);
    if (spans.some((s) => !parsed.files[s.fileIndex].pad && !bodies.has(s.fileIndex))) continue;
    const data = Buffer.concat(spans.map((s) => (parsed.files[s.fileIndex].pad ? Buffer.alloc(s.end - s.start) : Buffer.from(bodies.get(s.fileIndex).subarray(s.start, s.end)))));
    if (sha1Hex(data) !== pieceHash(parsed, i)) {
      for (const s of spans) {
        if (!bad.has(s.fileIndex)) bad.set(s.fileIndex, []);
        bad.get(s.fileIndex).push(i);
      }
    }
  }
  for (const [fileIndex, idx] of bad) {
    const file = parsed.files[fileIndex];
    const r = results.find((x) => x.path === file.path);
    if (!r) continue;
    r.ok = false;
    r.kinds.push('wrong-bytes');
    r.problems.push(r.url + ' serves other bytes than the torrent (piece ' + idx.join(', ') + ' fails its SHA-1): another version with the same length, or an edge transform ' +
      '(image optimisation, minification); exclude the path or turn the transform off');
  }
  if (onResult) for (const [fileIndex] of bad) onResult(results.find((x) => x.path === parsed.files[fileIndex].path));
  // One Range probe (origin mode only): does this host honour Range?
  const range = { checked: false, honoured: null, status: null };
  const probe = parsed.files.find((f, i) => !f.pad && f.length > 1 && bodies.has(i));
  if (mode === 'origin' && probe) {
    const url = hostFileUrl(base, probe);
    const got = await request(fetchImpl, url, { method: 'GET', headers: { range: 'bytes=0-0', accept: '*/*' } }, timeoutMs);
    range.checked = true;
    if (got.res) {
      await drain(got.res);
      range.status = got.res.status;
      range.honoured = got.res.status === 206;
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  const warned = results.filter((r) => r.warnings && r.warnings.length).length;
  return { ok: failed === 0, verdict: verdictOf(results), mode, btih: parsed.infoHash, name: parsed.name, results, failed, warned, range };
}

async function main(argv) {
  const { flags, positionals } = parseCli(argv, {
    mode: { type: 'string', default: 'seed' },
    xs: { type: 'list' },
    origin: { type: 'string', default: DEFAULT_ORIGIN },
    pieces: { type: 'string', default: 'first-last' },
    'allow-no-preflight': { type: 'boolean' },
    timeout: { type: 'int', default: 10000 },
    json: { type: 'boolean' },
  });
  if (flags.help) {
    out(USAGE.trim());
    return 0;
  }
  if (positionals.length !== 2) throw new UsageError('expected <base> <site.torrent>');
  if (!['seed', 'origin', 'host'].includes(flags.mode)) throw new UsageError('--mode must be seed, origin or host');
  const [base, torrentPath] = positionals;
  let bytes;
  try {
    bytes = readFileSync(torrentPath);
  } catch (err) {
    throw new ToolError('cannot read ' + torrentPath + ': ' + err.message);
  }
  const parsed = await parseTorrentFile(new Uint8Array(bytes));
  const print = flags.json ? null : (r) => {
    out((r.ok ? 'ok    ' : 'FAIL  ') + (r.kind === 'xs' ? 'xs ' : '') + (r.url || r.path) + (r.ok && r.info.contentRange ? '  (' + r.info.contentRange + ')' : ''));
    for (const p of r.problems) out('        ' + p);
    for (const w of r.warnings || []) out('        warning: ' + w);
  };
  let res;
  if (flags.mode === 'seed') {
    const targets = webseedTargets(base, parsed, flags.xs);
    if (!flags.json) {
      out('check-webseed ' + parsed.name + ' (btih ' + parsed.infoHash + ', ' + targets.files + ' files)');
      out('Will contact ' + targets.origins.join(', ') + ': OPTIONS and GET (Range: bytes=0-0) per file, ranged GETs for the SHA-1 of ' +
        (flags.pieces === 'all' ? 'every piece' : flags.pieces === 'none' ? 'no piece' : 'the first and the last piece') + (targets.xs ? ', GET per xs URL' : '') + '.');
    }
    res = await checkWebseed({
      wsBase: base, torrent: parsed, xs: flags.xs, origin: flags.origin, timeoutMs: flags.timeout, pieces: flags.pieces,
      allowNoPreflight: flags['allow-no-preflight'], onResult: print,
    });
    if (!flags.json && res.stock.checked) {
      out(res.stock.ok ? 'Stock WebTorrent headers (cache-control, range, user-agent): the preflight passes too.'
        : 'Stock WebTorrent headers (cache-control, range, user-agent): the preflight FAILS (' + res.stock.problems.join('; ') + '); felinar\'s build sends only Range, so only the patched set matters.');
    }
  } else {
    if (!flags.json) {
      out('check-webseed --mode ' + flags.mode + ' ' + parsed.name + ' (btih ' + parsed.infoHash + ', ' + parsed.files.filter((f) => !f.pad).length + ' files)');
      out('Will contact ' + new URL(base).origin + ': a full GET of every file' + (flags.mode === 'origin' ? ' and one Range probe' : ' with browser Accept headers') + '.');
    }
    res = await verifyHostFiles({ base, torrent: parsed, mode: flags.mode, origin: flags.origin === DEFAULT_ORIGIN ? null : flags.origin, timeoutMs: flags.timeout, onResult: print });
    if (!flags.json && res.range && res.range.checked) {
      out(res.range.honoured ? 'Range: honoured (206).' : 'Range: NOT honoured (answered ' + res.range.status + '): fine for drop-in (the Service Worker fetches whole files), but this host cannot be a cross-origin web seed.');
    }
  }
  if (flags.json) out(JSON.stringify(res, null, 2));
  else out(res.ok ? (flags.mode === 'seed' ? 'Web seed OK' : 'Host OK') + ': ' + res.results.length + ' checks passed. Verdict ' + res.verdict + '.'
    : res.failed + ' of ' + res.results.length + ' checks failed. Verdict ' + res.verdict + '.');
  return res.ok ? 0 : 1;
}

if (isMain(import.meta.url)) runMain(main, USAGE);
