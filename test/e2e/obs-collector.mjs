// test/e2e/obs-collector.mjs: the usage report endpoint of plan obs-2026-11-02 (section 2.7, deploy/obs-worker) as a loopback server for the
// end to end suite (test/e2e/scenarios-obs.mjs). The pages under test post their batches here instead of to a Cloudflare Worker, and the
// scenarios read back what arrived.
//
// It answers the Worker's routes with the Worker's rules, so a page that works against it works against the real endpoint:
//   POST /e            the Origin must be one the collector allows (allowOrigin; none allowed means 403 for everyone, as an empty ALLOW_ORIGINS
//                      does), at most 32768 bytes (413), Content-Type text/plain or application/json (415), then deploy/obs-worker/obs-core.js
//                      decides: 400 with a one-word reason, 429 over the rate limits, 204 with Access-Control-Allow-Origin echoing the origin
//   OPTIONS /e         the preflight, for the allowed origins only
//   GET /events.json   { next, more, batches } behind ?token=, with since, sid, who and limit (the operator tools read this)
//   GET /summary.json  the counts of the last hours, behind ?token=
//   GET /tail          a WebSocket behind ?token=: {"type":"hello","batches":n}, then one text frame per stored batch (the row as JSON)
//   GET /healthz       ok
// The validation and the storage are obs-core.js itself (createObsLog over createMemoryStorage), the same code the Worker's Durable Object
// runs. When that file is not in the tree, the collector falls back to a compact copy of the rules of plan 2.7 (validator reports which one
// it used), so this suite can be run beside a tree that has not got the Worker yet.
//
// What the scenarios get that the Worker does not offer: every POST as it arrived (posts(): the raw text, before any masking, so a scan for
// addresses sees what the page sent and not what the endpoint made of it), every request of any kind (requests(): "never calls the collector"
// is a count of zero), the stored rows (rows()), the rows grouped by session in the order the reporter wrote them (sessions()), and the
// helpers that read them: matchEvent, inOrder, findLeaks.
//
// Nothing here reads a client address or logs; the collector listens on 127.0.0.1 only.

import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CORE_FILE = join(HERE, '..', '..', 'deploy', 'obs-worker', 'obs-core.js');
export const MAX_BODY_BYTES = 32768;
const KEEP_POSTS = 4000;
const KEEP_REQUESTS = 8000;
const PREFLIGHT_MAX_AGE_S = 600;

// ---------------------------------------------------------------------------------------------
// the rules of obs-core.js, when it is there; else the rules of plan 2.7 written out again
// ---------------------------------------------------------------------------------------------

/** loadCore() -> the module deploy/obs-worker/obs-core.js, or null when it is missing or does not export what the collector needs. */
export async function loadCore() {
  if (!existsSync(CORE_FILE)) return null;
  try {
    const mod = await import(pathToFileURL(CORE_FILE).href);
    const need = ['createObsLog', 'createMemoryStorage', 'parseEventsQuery', 'parseSummaryQuery'];
    return need.every((name) => typeof mod[name] === 'function') ? mod : null;
  } catch (_) {
    return null;
  }
}

const SID_RE = /^[a-z2-9]{12}$/;
const NAME_RE = /^[a-z][a-z0-9.-]{1,48}$/;
const FIELD_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const HEX_RE = /^[0-9a-f]{0,16}$/;
const SITE_RE = /^[0-9a-f]{0,8}$/;
const LOADER_RE = /^(?:\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][0-9A-Za-z.]{1,8})?)?$/;
const WHO_RE = /^[a-km-np-z2-9]{4}-[a-km-np-z2-9]{4}$/;
const NET_TYPES = ['bluetooth', 'cellular', 'ethernet', 'mixed', 'none', 'other', 'unknown', 'wifi', 'wimax'];
const NET_EFFECTIVE = ['slow-2g', '2g', '3g', '4g', 'unknown'];
const KEY_RE = /^b:\d{15}:\d{4}$/;
const PAGES = ['site', 'door', 'hub', 'idp'];
const BROWSERS = ['chromium', 'firefox', 'webkit', 'other'];
const INLINE_LIMITS = { events: 100, keys: 12, field: 200, perSidPerMinute: 60, perSidPerDay: 1000, batchesPerDay: 20000, scanRows: 5000, eventsDefault: 200, eventsMax: 1000 };

// The masks of a string value, in the shape of the loader's safeField: an address, a part after '#', a pair code (twelve characters in three
// groups) cut to its channel, an opaque run of 32 or more characters cut to 8. The Worker's own masks are stronger; this copy only has to
// keep the fallback honest about the rules of 2.7.
function inlineMask(value) {
  let s = String(value);
  try { s = s.normalize('NFKC'); } catch (_) { /* used as it is */ }
  s = s.replace(/[\u0000-\u0020\u007f-\u00a0\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]+/g, ' ').trim();
  const hash = s.indexOf('#');
  if (hash >= 0 && /[/:.?=@%&+~]/.test(s.slice(s.lastIndexOf(' ', hash) + 1, hash))) s = s.slice(0, hash + 1);
  s = s.replace(/\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?/g, 'x.x.x.x').replace(/[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}/gi, 'x.x.x.x');
  s = s.replace(/(^|[^A-Za-z0-9])([A-Za-z0-9]{4})-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}(?![A-Za-z0-9])/g, '$1$2').replace(/[A-Za-z0-9_-]{32,}/g, (run) => (/\d/.test(run) ? run.slice(0, 8) : run));
  return s.slice(0, INLINE_LIMITS.field).trim();
}

/** inlineValidate(input) -> { ok: true, batch } | { ok: false, reason }: plan 2.7 rule by rule, with the one-word reasons of obs-core.js. */
function inlineValidate(input) {
  const bad = (reason) => ({ ok: false, reason });
  const obj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
  const int = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
  if (!obj(input)) return bad('shape');
  if (input.v !== 1) return bad('version');
  if (typeof input.sid !== 'string' || !SID_RE.test(input.sid)) return bad('sid');
  if (!int(input.seq, 0, 1e9)) return bad('seq');
  if (!PAGES.includes(input.page)) return bad('page');
  const build = input.build === undefined ? '' : input.build;
  if (typeof build !== 'string' || !HEX_RE.test(build)) return bad('build');
  const loader = input.loader === undefined ? '' : input.loader;
  if (typeof loader !== 'string' || loader.length > 16 || !LOADER_RE.test(loader)) return bad('loader');
  const site = input.site === undefined ? '' : input.site;
  if (typeof site !== 'string' || !SITE_RE.test(site)) return bad('site');
  const who = input.who === undefined ? null : input.who;
  if (who !== null && (typeof who !== 'string' || !WHO_RE.test(who))) return bad('who');
  let net = null;
  if (input.net !== undefined && input.net !== null) {
    if (!obj(input.net)) return bad('net');
    const part = (v, words) => (v === undefined || v === null ? null : typeof v === 'string' && words.includes(v) ? v : undefined);
    const type = part(input.net.type, NET_TYPES);
    const effectiveType = part(input.net.effectiveType, NET_EFFECTIVE);
    if (type === undefined || effectiveType === undefined) return bad('net');
    net = { type, effectiveType };
  }
  if (!obj(input.ua) || !BROWSERS.includes(input.ua.browser) || typeof input.ua.mobile !== 'boolean') return bad('ua');
  if (!int(input.t0, 0, 4102444800)) return bad('t0');
  if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > INLINE_LIMITS.events) return bad('events');
  const events = [];
  for (const ev of input.events) {
    if (!obj(ev)) return bad('event');
    if (!int(ev.t, 0, Number.MAX_SAFE_INTEGER)) return bad('time');
    if (typeof ev.n !== 'string' || !NAME_RE.test(ev.n)) return bad('name');
    const keys = Object.keys(ev).filter((k) => k !== 't' && k !== 'n');
    if (keys.length > INLINE_LIMITS.keys) return bad('keys');
    const out = { t: ev.t, n: ev.n };
    for (const key of keys) {
      if (!FIELD_KEY_RE.test(key)) return bad('key');
      const v = ev[key];
      if (typeof v === 'string') out[key] = inlineMask(v);
      else if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
      else if (typeof v === 'boolean' || v === null) out[key] = v;
      else return bad('value');
    }
    events.push(out);
  }
  return { ok: true, batch: { v: 1, sid: input.sid, seq: input.seq, page: input.page, build, loader, site, who, net, ua: { browser: input.ua.browser, mobile: input.ua.mobile }, t0: input.t0, events } };
}

const clampInt = (raw, min, max, fallback) => (raw === null || raw === undefined || raw === '' || !/^\d{1,9}$/.test(String(raw)) ? fallback : Math.min(max, Math.max(min, Number(raw))));

/** inlineEngine({ now }) -> the same four members the collector asks of obs-core.js: log (ingest, events, summary, todayCount), parseEventsQuery, parseSummaryQuery. */
function inlineEngine({ now }) {
  const rows = new Map();
  const windows = new Map(); // sid -> { times: [ms], day: n }
  let total = 0;
  let lastMs = 0;
  let seq = 0;
  const keyOf = (at) => {
    if (at > lastMs) { lastMs = at; seq = 0; } else seq += 1;
    return 'b:' + String(lastMs).padStart(15, '0') + ':' + String(seq).padStart(4, '0');
  };
  const failure = (status, reason, retryAfter) => Object.assign({ ok: false, status, reason }, retryAfter ? { retryAfter } : {});
  const log = {
    async ingest(body) {
      if (typeof body !== 'string' || body.length === 0) return failure(400, 'empty');
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) return failure(413, 'too large');
      const at = now();
      if (total >= INLINE_LIMITS.batchesPerDay) return failure(429, 'day-all', 60); // before the body is read, as the Worker does
      let value;
      try { value = JSON.parse(body); } catch (_) { return failure(400, 'json'); }
      const checked = inlineValidate(value);
      if (!checked.ok) return failure(400, checked.reason);
      const batch = checked.batch;
      let w = windows.get(batch.sid);
      if (!w) { w = { times: [], day: 0, marks: [] }; windows.set(batch.sid, w); }
      const mark = batch.seq + ' ' + body.length + ' ' + createHash('sha256').update(body).digest('hex').slice(0, 16);
      if (w.marks.includes(mark)) return { ok: true, status: 204, repeat: true }; // a batch sent again (a retry): answered, not stored again
      while (w.times.length && at - w.times[0] >= 60000) w.times.shift();
      if (w.times.length >= INLINE_LIMITS.perSidPerMinute) return failure(429, 'sid-minute', Math.max(1, Math.ceil((w.times[0] + 60000 - at) / 1000)));
      if (w.day >= INLINE_LIMITS.perSidPerDay) return failure(429, 'sid-day', 60);
      w.times.push(at);
      w.day++;
      total++;
      w.marks.push(mark);
      if (w.marks.length > 8) w.marks.shift();
      const key = keyOf(at);
      const row = { at, sid: batch.sid, page: batch.page, who: batch.who, site: batch.site, build: batch.build, n: batch.events.length, body: batch };
      rows.set(key, JSON.parse(JSON.stringify(row)));
      return { ok: true, status: 204, key, row };
    },
    async events(q) {
      const out = [];
      let last = q.since || null;
      let scanned = 0;
      let more = false;
      for (const key of Array.from(rows.keys()).sort()) {
        if (q.since && key <= q.since) continue;
        const row = rows.get(key);
        scanned++;
        last = key;
        if ((!q.sid || row.sid === q.sid) && (!q.who || row.who === q.who)) out.push(row);
        if (out.length >= q.limit || scanned >= INLINE_LIMITS.scanRows) { more = true; break; }
      }
      return { next: last, more, batches: out };
    },
    async summary(q) {
      const from = now() - q.hours * 3600000;
      const sids = new Set();
      const whos = new Set();
      const pages = {};
      const names = {};
      let batches = 0;
      let events = 0;
      for (const row of rows.values()) {
        if (row.at < from) continue;
        batches++;
        events += row.n;
        sids.add(row.sid);
        if (row.who) whos.add(row.who);
        pages[row.page] = (pages[row.page] || 0) + 1;
        for (const ev of row.body.events) names[ev.n] = (names[ev.n] || 0) + 1;
      }
      return { hours: q.hours, from, to: now(), truncated: false, batches, events, sids: sids.size, who: whos.size, pages, names };
    },
    todayCount: () => total,
  };
  const parseEventsQuery = (params) => {
    const since = params.get('since');
    if (since !== null && since !== '' && !KEY_RE.test(since)) return { ok: false, reason: 'since' };
    const sid = params.get('sid');
    if (sid !== null && sid !== '' && !SID_RE.test(sid)) return { ok: false, reason: 'sid' };
    const who = params.get('who');
    if (who !== null && who !== '' && !WHO_RE.test(who)) return { ok: false, reason: 'who' };
    return { ok: true, query: { since: since || null, sid: sid || null, who: who || null, limit: clampInt(params.get('limit'), 1, INLINE_LIMITS.eventsMax, INLINE_LIMITS.eventsDefault) } };
  };
  const parseSummaryQuery = (params) => ({ ok: true, query: { hours: clampInt(params.get('hours'), 1, 168, 24) } });
  return { name: 'inline rules of plan 2.7', log, parseEventsQuery, parseSummaryQuery };
}

/** makeEngine(core, { now }) -> { name, log, parseEventsQuery, parseSummaryQuery } over obs-core.js (core given) or the inline rules (core null). */
function makeEngine(core, { now }) {
  if (!core) return inlineEngine({ now });
  return {
    name: 'deploy/obs-worker/obs-core.js',
    log: core.createObsLog(core.createMemoryStorage(), { now }),
    parseEventsQuery: core.parseEventsQuery,
    parseSummaryQuery: core.parseSummaryQuery,
  };
}

// ---------------------------------------------------------------------------------------------
// reading what arrived
// ---------------------------------------------------------------------------------------------

/**
 * sessionsOf(rows) -> Map sid -> { sid, page, build, loader, ua, t0, who: [values in the order they first labelled a batch], site: [same],
 * seqs: [sorted], batches: [bodies by seq], repeats: how many rows repeated a (sid, seq) already held, events: [...] }.
 * The reporter retries a failed batch with the same sid, seq and body, so a repeated (sid, seq) is kept once (the first row). An event is its
 * name n, its time t (ms since the reporter was made) and its fields at the top, plus: $sid, $seq, $who and $site (what labelled its batch)
 * and $abs, t0 * 1000 + t. t0 is whole seconds, so $abs is at most 999 ms before the true time and the same amount early for every event of
 * one session: the order inside a session is exact, and the order of two events of two sessions is exact when they are 1000 ms or more apart.
 */
export function sessionsOf(rows) {
  const out = new Map();
  for (const row of rows) {
    const b = row && row.body;
    if (!b || typeof b.sid !== 'string') continue;
    let s = out.get(b.sid);
    if (!s) {
      s = { sid: b.sid, page: b.page, build: b.build, loader: b.loader, ua: b.ua, t0: b.t0, who: [], site: [], seqs: [], batches: [], repeats: 0, events: [] };
      out.set(b.sid, s);
    }
    if (s.seqs.includes(b.seq)) { s.repeats++; continue; }
    s.seqs.push(b.seq);
    s.batches.push(b);
  }
  for (const s of out.values()) {
    s.seqs.sort((a, b) => a - b);
    s.batches.sort((a, b) => a.seq - b.seq);
    for (const b of s.batches) {
      if (!s.who.includes(b.who)) s.who.push(b.who);
      if (!s.site.includes(b.site)) s.site.push(b.site);
      for (const ev of b.events) s.events.push(Object.assign({}, ev, { $sid: b.sid, $seq: b.seq, $who: b.who, $site: b.site, $abs: b.t0 * 1000 + ev.t }));
    }
  }
  return out;
}

/**
 * matchEvent(ev, pattern) -> boolean. A string pattern is an event name. An object pattern is { n, ...fields }: every field given must match, a
 * RegExp against a string value, a function as fn(value, ev), anything else with ===. Fields the pattern does not name are not looked at.
 */
export function matchEvent(ev, pattern) {
  if (!ev) return false;
  if (typeof pattern === 'string') return ev.n === pattern;
  if (!pattern || ev.n !== pattern.n) return false;
  for (const key of Object.keys(pattern)) {
    if (key === 'n') continue;
    const want = pattern[key];
    const have = ev[key];
    if (want instanceof RegExp) {
      if (typeof have !== 'string' || !want.test(have)) return false;
    } else if (typeof want === 'function') {
      if (!want(have, ev)) return false;
    } else if (have !== want) {
      return false;
    }
  }
  return true;
}

/** show(pattern) -> a short text for a pattern or an event, for a failure message. */
export function show(pattern) {
  if (typeof pattern === 'string') return pattern;
  const fields = Object.keys(pattern || {}).filter((k) => k !== 'n' && k[0] !== '$').map((k) => k + '=' + (pattern[k] instanceof RegExp ? String(pattern[k]) : typeof pattern[k] === 'function' ? 'fn' : JSON.stringify(pattern[k])));
  return (pattern && pattern.n) + (fields.length ? ' {' + fields.join(', ') + '}' : '');
}

/**
 * inOrder(events, chain) -> { ok: true, at: [index of each link] } | { ok: false, link, after }: every pattern of chain is found in events,
 * each after the one before it (other events may stand between them: this is a subsequence, not a run). On failure, link is the first
 * pattern that was not found and after is the pattern before it.
 */
export function inOrder(events, chain) {
  const at = [];
  let from = 0;
  for (let i = 0; i < chain.length; i++) {
    let found = -1;
    for (let j = from; j < events.length; j++) {
      if (matchEvent(events[j], chain[i])) { found = j; break; }
    }
    if (found < 0) return { ok: false, link: show(chain[i]), after: i ? show(chain[i - 1]) : null, index: i };
    at.push(found);
    from = found + 1;
  }
  return { ok: true, at };
}

/** firstOf(events, pattern) -> the first event that matches, or null. */
export function firstOf(events, pattern) {
  return events.find((ev) => matchEvent(ev, pattern)) || null;
}

// ---------------------------------------------------------------------------------------------
// the scan for what must never be in a report (plan section 4)
// ---------------------------------------------------------------------------------------------

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_RE = new RegExp('(?<![0-9.])' + OCTET + '(?:\\.' + OCTET + '){3}(?![0-9])', 'g');
// An IPv6 literal: eight groups, or fewer around "::" (which, as the Worker's masks do, also takes a bare "::"). A clock time (12:30:45) has
// neither shape and is not an address.
const IPV6_RE = /(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?|::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?/gi;
const RULES = [
  ['an IPv4 address', IPV4_RE],
  ['an IPv6 address', IPV6_RE],
  ['a port after a masked address', /x\.x\.x\.x\]?:\d{1,5}(?!\d)/g],
  ['a loopback name', /\blocalhost\b|\[::1\]/gi],
  ['a full user agent', /Mozilla\/\d|AppleWebKit|Chrome\/\d|Chromium\/\d|Firefox\/\d|Safari\/\d|Gecko\//g],
  ['a URL with a fragment', /[a-z][a-z0-9+.-]*:\/\/[^\s"\\]*#[^\s"\\]+/gi],
  ['a whole pair code', /\b[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}\b/gi],
  ['a hash of 40 or more hex digits', /\b[0-9a-f]{40,}\b/gi],
];

/**
 * findLeaks(text, { ports, literals }) -> [string]: what text holds that a usage report must not carry. Always: an IPv4 or IPv6 address, a
 * port left behind after a masked address (x.x.x.x:5555), localhost, a full user agent, a URL with a fragment, a whole pair code, a hash of
 * 40 or more hex digits. Also: any of ports as ":<port>" after a character that is not a quote or a digit (so "t":5555 is not one), and any of
 * literals (strings the scenario knows the page holds: the whole code, a message, an infohash). An empty array is a clean text.
 */
export function findLeaks(text, { ports = [], literals = [] } = {}) {
  const found = [];
  const s = String(text);
  for (const [what, re] of RULES) {
    re.lastIndex = 0;
    const m = s.match(re);
    if (m) found.push(what + ': ' + JSON.stringify(Array.from(new Set(m)).slice(0, 3)));
  }
  for (const port of ports) {
    if (new RegExp('[^"\\d]:' + Number(port) + '(?!\\d)').test(s)) found.push('the port ' + port);
  }
  for (const lit of literals) {
    if (typeof lit === 'string' && lit.length >= 4 && s.indexOf(lit) >= 0) found.push('the string ' + JSON.stringify(lit.length > 24 ? lit.slice(0, 24) + '...' : lit));
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// the server
// ---------------------------------------------------------------------------------------------

const text = (res, status, body, extra = {}) => {
  res.writeHead(status, Object.assign({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, extra));
  res.end(body);
};

/** originsOf(list) -> the exact origins of a list, as the Worker reads ALLOW_ORIGINS: lower case, no trailing slash, http or https, nothing else. */
function originOf(raw) {
  const origin = String(raw).trim().replace(/\/+$/, '').toLowerCase();
  return /^https?:\/\/[^\s/?#@]+$/.test(origin) ? origin : null;
}

/** readBody(req, max) -> the body as text, or null when it runs past max bytes. */
function readBody(req, max) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let over = false;
    req.on('data', (chunk) => {
      if (over) return;
      total += chunk.length;
      if (total > max) { over = true; chunks.length = 0; return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(over ? null : ''));
  });
}

/**
 * createCollector({ allowOrigins, token, core, now, host, port }) -> Promise<collector>
 *   allowOrigins: origins whose pages may post (more later with allowOrigin); token: READ_TOKEN (default: random); core: obs-core.js as
 *   loadCore() returns it (default: loaded here), or null to force the inline rules; now(): the clock the rate limits and the keys use.
 *
 * collector: { origin, host, port, token, validator, allowOrigin(o), allowedOrigins(), disallowOrigin(o), clear(), rows(), count(), posts(),
 *   requests(), sessions(), rawBodies(), tailCount(), brief(), waitFor(pred, { timeoutMs, label }), close() }
 * posts(): [{ at, origin, type, bytes, status, reason, body }] every POST /e in arrival order; body is the raw text when it was read, null
 * when the request was refused before its body was (an Origin that is not allowed). requests(): [{ at, method, path, origin, status }] every
 * HTTP request and upgrade, whatever the route (viaToken: it carried the read token, so it is the operator's or the test's own and not a page's). rows(): the stored rows { at, sid, page, who, site, build, n, body } in key order.
 */
export async function createCollector({ allowOrigins = [], token = randomBytes(9).toString('hex'), core, now = () => Date.now(), host = '127.0.0.1', port = 0 } = {}) {
  const coreMod = core === undefined ? await loadCore() : core;
  const allowed = new Set();
  for (const o of allowOrigins) { const k = originOf(o); if (k) allowed.add(k); }
  let engine = makeEngine(coreMod, { now });
  let stored = [];
  let posts = [];
  let requests = [];
  const tails = new Set();

  const note = (list, cap, entry) => {
    if (list.length >= cap) list.splice(0, Math.floor(cap / 4));
    list.push(entry);
    return entry;
  };
  const allowedOrigin = (req) => {
    const o = req.headers.origin;
    return typeof o === 'string' && allowed.has(o.toLowerCase()) ? o : null;
  };
  const tokenOk = (url) => token !== '' && url.searchParams.get('token') === token;
  const push = (row) => {
    const frame = JSON.stringify(row);
    for (const ws of tails) {
      try { ws.send(frame); } catch (_) { /* the socket is closing */ }
    }
  };

  async function ingest(req, res, rec) {
    const origin = allowedOrigin(req);
    if (!origin) {
      rec.status = 403;
      rec.reason = 'origin';
      req.resume(); // the body is never read for an origin that is not allowed, but it is let go so the connection stays usable
      return text(res, 403, 'origin not allowed\n', { vary: 'Origin' });
    }
    const cors = { 'access-control-allow-origin': origin, vary: 'Origin' };
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'text/plain' && type !== 'application/json') {
      rec.status = 415;
      rec.reason = 'type';
      req.resume();
      return text(res, 415, 'unsupported type\n', cors);
    }
    const body = await readBody(req, MAX_BODY_BYTES);
    if (body === null) {
      rec.status = 413;
      rec.reason = 'too large';
      return text(res, 413, 'too large\n', cors);
    }
    rec.body = body;
    rec.bytes = Buffer.byteLength(body);
    if (body === '') {
      rec.status = 400;
      rec.reason = 'empty';
      return text(res, 400, 'empty\n', cors);
    }
    const r = await engine.log.ingest(body);
    if (!r.ok) {
      rec.status = r.status;
      rec.reason = r.reason;
      return text(res, r.status, r.reason + '\n', Object.assign({}, cors, r.retryAfter ? { 'retry-after': String(r.retryAfter) } : {}));
    }
    rec.status = 204;
    if (!r.repeat) {
      stored.push(r.row);
      push(r.row);
    }
    res.writeHead(204, Object.assign({ 'cache-control': 'no-store' }, cors));
    return res.end();
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://collector.invalid');
    const path = url.pathname;
    const rec = note(requests, KEEP_REQUESTS, { at: Date.now(), method: req.method, path, origin: req.headers.origin || null, viaToken: tokenOk(url), status: 0 });
    const done = () => { rec.status = rec.status || res.statusCode; };
    res.on('finish', done);
    try {
      if (path === '/healthz') return req.method === 'GET' || req.method === 'HEAD' ? text(res, 200, 'ok\n') : text(res, 404, 'not found\n');
      if (path === '/e') {
        if (req.method === 'OPTIONS') {
          const origin = allowedOrigin(req);
          if (!origin) return text(res, 403, 'origin not allowed\n', { vary: 'Origin' });
          res.writeHead(204, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': String(PREFLIGHT_MAX_AGE_S), vary: 'Origin', 'cache-control': 'no-store' });
          return res.end();
        }
        if (req.method === 'POST') {
          const post = note(posts, KEEP_POSTS, { at: Date.now(), origin: req.headers.origin || null, type: String(req.headers['content-type'] || ''), bytes: 0, status: 0, reason: '', body: null });
          try {
            return await ingest(req, res, post);
          } finally {
            post.status = post.status || res.statusCode;
          }
        }
        return text(res, 404, 'not found\n');
      }
      if (path === '/events.json' || path === '/summary.json') {
        const open = { 'access-control-allow-origin': '*' };
        if (req.method !== 'GET' || !tokenOk(url)) return text(res, 404, 'not found\n', open);
        const events = path === '/events.json';
        const parsed = events ? engine.parseEventsQuery(url.searchParams) : engine.parseSummaryQuery(url.searchParams);
        if (!parsed.ok) return text(res, 400, parsed.reason + '\n', open);
        const value = events ? await engine.log.events(parsed.query) : await engine.log.summary(parsed.query);
        res.writeHead(200, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, open));
        return res.end(JSON.stringify(value) + '\n');
      }
      if (path === '/tail') {
        if (req.method !== 'GET' || !tokenOk(url)) return text(res, 404, 'not found\n');
        return text(res, 426, 'This is the usage report tail: it answers WebSocket connections.\n', { upgrade: 'websocket' });
      }
      return text(res, 404, 'not found\n');
    } catch (err) {
      if (!res.headersSent) text(res, 500, 'collector error: ' + ((err && err.message) || err) + '\n');
      else res.end();
      return undefined;
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.keepAliveTimeout = 2000;
  const sockets = new Set();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  const ws = await import('ws');
  const WebSocketServer = ws.WebSocketServer || (ws.default && ws.default.WebSocketServer) || ws.Server;
  const wss = new WebSocketServer({ noServer: true, clientTracking: false });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://collector.invalid');
    const rec = note(requests, KEEP_REQUESTS, { at: Date.now(), method: 'UPGRADE', path: url.pathname, origin: req.headers.origin || null, viaToken: tokenOk(url), status: 0 });
    if (url.pathname !== '/tail' || !tokenOk(url)) {
      rec.status = 404;
      socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
      return;
    }
    rec.status = 101;
    wss.handleUpgrade(req, socket, head, (sock) => {
      tails.add(sock);
      sock.on('close', () => tails.delete(sock));
      sock.on('error', () => {});
      sock.on('message', () => { /* a tail only listens: whatever a client sends is ignored */ });
      try { sock.send(JSON.stringify({ type: 'hello', batches: engine.log.todayCount() })); } catch (_) { /* closing */ }
    });
  });
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const boundPort = server.address().port;
  const origin = 'http://' + host + ':' + boundPort;

  const collector = {
    origin,
    host,
    port: boundPort,
    token,
    validator: engine.name,
    allowOrigin(o) {
      const k = originOf(o);
      if (!k) throw new Error('allowOrigin: not an origin: ' + o);
      allowed.add(k);
      return k;
    },
    disallowOrigin(o) {
      const k = originOf(o);
      if (k) allowed.delete(k);
    },
    allowedOrigins: () => Array.from(allowed),
    /** clear(): forget every row, post and request and start the limits again; the allowed origins and the open tail sockets stay. */
    clear() {
      engine = makeEngine(coreMod, { now });
      stored = [];
      posts = [];
      requests = [];
    },
    rows: () => stored.slice(),
    count: () => stored.length,
    posts: () => posts.slice(),
    requests: () => requests.slice(),
    /** pageRequests() -> the requests that did not carry the read token: what a visitor's page did, as far as the collector knows. */
    pageRequests: () => requests.filter((r) => !r.viaToken),
    sessions: () => sessionsOf(stored),
    /** rawBodies() -> the text of every POST body as it arrived, accepted or refused after it was read. */
    rawBodies: () => posts.filter((p) => typeof p.body === 'string').map((p) => p.body),
    tailCount: () => tails.size,
    /** brief() -> one line for a failure message: how many batches, from how many sessions, and the events by name. */
    brief() {
      const sessions = sessionsOf(stored);
      const names = {};
      for (const s of sessions.values()) for (const ev of s.events) names[ev.n] = (names[ev.n] || 0) + 1;
      const list = Object.keys(names).sort().map((n) => n + (names[n] > 1 ? 'x' + names[n] : '')).join(' ');
      const refused = posts.filter((p) => p.status !== 204).map((p) => p.status + (p.reason ? ' ' + p.reason : ''));
      return stored.length + ' batches from ' + sessions.size + ' session(s)' + (refused.length ? ', refused: ' + refused.slice(0, 6).join(', ') : '') + (list ? ': ' + list.slice(0, 900) : '');
    },
    /** waitFor(pred, { timeoutMs, stepMs, label }) -> the first truthy value of pred(collector); rejects with the collector's brief after timeoutMs. */
    async waitFor(pred, { timeoutMs = 15000, stepMs = 100, label = 'condition' } = {}) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const v = await pred(collector);
        if (v) return v;
        if (Date.now() > end) throw new Error(label + ': not reached within ' + timeoutMs + ' ms (the collector held ' + collector.brief() + ')');
        await new Promise((r) => setTimeout(r, stepMs));
      }
    },
    close() {
      return new Promise((resolve) => {
        for (const sock of tails) { try { sock.terminate(); } catch (_) { /* already gone */ } }
        tails.clear();
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      });
    },
  };
  return collector;
}
