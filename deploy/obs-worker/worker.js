// deploy/obs-worker/worker.js: the usage report endpoint as a Cloudflare Worker with one Durable Object, for site owners who turn on
// usage reports (README.md in this folder). Two parts:
//
// - The front (the default export, between the "front" markers below) answers /healthz and vets every request before the object
//   sees it: the Origin of a report must be one ALLOW_ORIGINS names, a body is read only up to 32768 bytes, the read routes and the
//   tail need READ_TOKEN (24 characters or more: a shorter one is taken for none). It hands the object a new request that carries
//   the text of the batch and nothing of the visitor's connection, so no address and no header of the sender reaches it (the
//   operator's tail upgrade is the one request passed on as it came, because the platform ties the socket to it). The front does
//   not read the batch: the object does, so that the checks run in one place, and a batch is refused before it is read once the
//   day's total is reached. pages/public/_worker.js is a copy of these lines (a Pages
//   project cannot define a Durable Object class, so the front runs there and reaches the class of the Worker deployed from this
//   folder through a binding); the unit test holds the two together.
// - The Durable Object ObsLog keeps the rows (obs-core.js does the work: validation, masking, the limits, the order of the keys),
//   accepts the operator's tail sockets with the Hibernation API (the object sleeps between frames and is woken by them) and
//   sweeps old rows and old sockets from an alarm.
//
// This file never reads the sender's address or location, in any header or in the platform's request properties, and never logs:
// the only request headers it reads are Origin, Content-Type, Content-Length and Upgrade. The unit test greps for all of it.
import { createObsLog, parseEventsQuery, parseSummaryQuery, LIMITS } from './obs-core.js';

// ===== front: begin (the lines down to "front: end" are copied unchanged into pages/public/_worker.js) =====
const OBJECT_NAME = 'log';
const INTERNAL = 'https://obs.internal';
const MAX_BODY_BYTES = 32768;
const PREFLIGHT_MAX_AGE_S = 600;
const MIN_TOKEN_CHARS = 24; // a READ_TOKEN shorter than this opens nothing: it is taken for none (README.md makes one of 48 hex characters)

const text = (body, status = 200, extra = {}) => new Response(body, { status, headers: Object.assign({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, extra) });

/** objectOf(env) -> the stub of the one object that holds every row. */
const objectOf = (env) => env.OBS.get(env.OBS.idFromName(OBJECT_NAME));

/** originsOf(env) -> the exact origins ALLOW_ORIGINS names, comma or space separated. No wildcard exists: "*" and "null" match nothing. */
function originsOf(env) {
  const out = new Set();
  for (const raw of String(env.ALLOW_ORIGINS || '').split(/[,\s]+/)) {
    const origin = raw.replace(/\/+$/, '').toLowerCase();
    if (/^https?:\/\/[^\s/?#@]+$/.test(origin)) out.add(origin);
  }
  return out;
}

/** sameText(a, b) -> a === b, compared over the longer length so the time it takes does not say where the two differ. */
function sameText(a, b) {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/**
 * tokenOk(env, url) -> true only when READ_TOKEN is set, is at least MIN_TOKEN_CHARS long, and is the request's token (the gate of the read
 * routes and the tail). A short token ("x", three spaces) is no gate, so it is no token: every read stays closed until a longer one is set.
 */
function tokenOk(env, url) {
  const wanted = typeof env.READ_TOKEN === 'string' ? env.READ_TOKEN : '';
  return wanted.length >= MIN_TOKEN_CHARS && sameText(url.searchParams.get('token') || '', wanted);
}

/** readText(request, max) -> the body as text, or null when it runs past max bytes (the stream is cancelled at that point). */
async function readText(request, max) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      try { await reader.cancel(); } catch (_) { /* the stream is closing */ }
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { all.set(chunk, at); at += chunk.byteLength; }
  return new TextDecoder().decode(all);
}

/** preflight(request, env) -> the answer to OPTIONS /e: 204 for an allowed origin, 403 for any other. */
function preflight(request, env) {
  const origin = request.headers.get('Origin');
  if (origin === null || !originsOf(env).has(origin)) return text('origin not allowed\n', 403, { vary: 'Origin' });
  return new Response(null, { status: 204, headers: { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': String(PREFLIGHT_MAX_AGE_S), vary: 'Origin', 'cache-control': 'no-store' } });
}

/** ingest(request, env) -> 204 once the object has stored the batch, else 403, 413, 415, 400, 429 or 503. */
async function ingest(request, env) {
  const origin = request.headers.get('Origin');
  if (origin === null || !originsOf(env).has(origin)) return text('origin not allowed\n', 403, { vary: 'Origin' });
  const cors = { 'access-control-allow-origin': origin, vary: 'Origin' };
  const declared = request.headers.get('Content-Length');
  if (declared !== null && /^\d{1,15}$/.test(declared) && Number(declared) > MAX_BODY_BYTES) return text('too large\n', 413, cors);
  const type = String(request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'text/plain' && type !== 'application/json') return text('unsupported type\n', 415, cors);
  const body = await readText(request, MAX_BODY_BYTES);
  if (body === null) return text('too large\n', 413, cors);
  if (body === '') return text('empty\n', 400, cors);
  let res;
  try {
    res = await objectOf(env).fetch(new Request(INTERNAL + '/e', { method: 'POST', headers: { 'content-type': 'text/plain' }, body }));
  } catch (_) {
    return text('unavailable\n', 503, cors);
  }
  const headers = Object.assign({}, cors);
  const retry = res.headers.get('retry-after');
  if (retry) headers['retry-after'] = retry;
  if (res.status === 204) return new Response(null, { status: 204, headers: Object.assign({ 'cache-control': 'no-store' }, headers) });
  return text(await res.text(), res.status, headers);
}

/** readRoute(url, env) -> /events.json or /summary.json from the object, behind the token; any origin may read (the token is the gate). */
async function readRoute(url, env) {
  const open = { 'access-control-allow-origin': '*' };
  if (!tokenOk(env, url)) return text('not found\n', 404, open);
  const inner = new URL(INTERNAL + url.pathname);
  for (const name of ['since', 'sid', 'who', 'limit', 'hours']) {
    const value = url.searchParams.get(name);
    if (value !== null) inner.searchParams.set(name, value);
  }
  let res;
  try {
    res = await objectOf(env).fetch(new Request(inner.href));
  } catch (_) {
    return text('unavailable\n', 503, open);
  }
  return new Response(res.body, { status: res.status, headers: Object.assign({ 'content-type': res.headers.get('content-type') || 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, open) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    if (path === '/healthz') return method === 'GET' || method === 'HEAD' ? text('ok\n') : text('not found\n', 404);
    if (path === '/e') {
      if (method === 'POST') return ingest(request, env);
      if (method === 'OPTIONS') return preflight(request, env);
      return text('not found\n', 404);
    }
    if (path === '/events.json' || path === '/summary.json') return method === 'GET' ? readRoute(url, env) : text('not found\n', 404);
    if (path === '/tail') {
      if (method !== 'GET' || !tokenOk(env, url)) return text('not found\n', 404);
      if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
        return text('This is the usage report tail: it answers WebSocket connections from the operator tools (deploy/obs-worker/README.md).\n', 426, { Upgrade: 'websocket' });
      }
      try {
        return await objectOf(env).fetch(request);
      } catch (_) {
        return text('unavailable\n', 503);
      }
    }
    return text('not found\n', 404);
  },
};
// ===== front: end =====

const SWEEP_MS = 10 * 60 * 1000;
const TAIL_MAX_MS = 12 * 60 * 60 * 1000;
const MAX_TAILS = 16;

const json = (value) => new Response(JSON.stringify(value) + '\n', { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

/** intVar(raw, min, max, fallback) -> a var as a whole number held between min and max, the fallback when it is not one. */
function intVar(raw, min, max, fallback) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim();
  return /^\d{1,9}$/.test(s) ? Math.min(max, Math.max(min, Number(s))) : fallback;
}

export class ObsLog {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.log = createObsLog(ctx.storage, {
      retentionDays: intVar(env.RETENTION_DAYS, 1, 30, LIMITS.retentionDays),
      maxBatchesPerDay: intVar(env.MAX_BATCHES_PER_DAY, 1, 200000, LIMITS.maxBatchesPerDay), // the per-session windows of that many batches fit in an object's memory
    });
    this.alarmAt = null; // when the next sweep runs, as far as this object knows; null when none is set
    // The counter row is read before the first event is delivered (a wake delivers one); the sockets that survived need no work,
    // their state is on the sockets themselves.
    this.ready = ctx.blockConcurrencyWhile(() => this.wake());
    this.ready.catch(() => {}); // a failed load resets the object; the handlers below see the rejection themselves
  }

  async wake() {
    await this.log.load();
    const at = await this.ctx.storage.getAlarm();
    this.alarmAt = typeof at === 'number' ? at : null;
    if (this.alarmAt === null && (this.log.rowCount() > 0 || this.ctx.getWebSockets().length > 0)) await this.arm(Date.now() + SWEEP_MS);
  }

  async arm(at) {
    this.alarmAt = at;
    await this.ctx.storage.setAlarm(at);
  }

  /** ensureAlarm(): one sweep is always pending while there are rows or sockets (the next ingest or tail sets it again after it stopped). */
  async ensureAlarm() {
    if (this.alarmAt === null) await this.arm(Date.now() + SWEEP_MS);
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'POST' && path === '/e') return this.ingest(await request.text());
    if (request.method === 'GET' && path === '/events.json') return this.events(url);
    if (request.method === 'GET' && path === '/summary.json') return this.summary(url);
    if (request.method === 'GET' && path === '/tail') return this.tail(request);
    return text('not found\n', 404);
  }

  /** ingest(body) -> 204 once the row is stored and every tail socket has had its frame, else the status and reason word of the log. */
  async ingest(body) {
    const r = await this.log.ingest(body);
    if (!r.ok) return text(r.reason + '\n', r.status, r.retryAfter ? { 'retry-after': String(r.retryAfter) } : {});
    if (r.repeat) return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } }); // sent before: nothing stored, nothing pushed
    this.push(JSON.stringify(r.row));
    await this.ensureAlarm();
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  }

  /** push(frame): one text frame, the stored row as JSON, to every tail socket. */
  push(frame) {
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(frame); } catch (_) { /* the socket is closing */ }
    }
  }

  async events(url) {
    const parsed = parseEventsQuery(url.searchParams);
    if (!parsed.ok) return text(parsed.reason + '\n', 400);
    return json(await this.log.events(parsed.query));
  }

  async summary(url) {
    const parsed = parseSummaryQuery(url.searchParams);
    return json(await this.log.summary(parsed.query));
  }

  async tail(request) {
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return text('expected a WebSocket\n', 426, { Upgrade: 'websocket' });
    if (this.ctx.getWebSockets().length >= MAX_TAILS) return text('too many tail sockets\n', 429);
    const pair = new WebSocketPair();
    await this.accept(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** accept(server): what fetch() does with the server end of a tail socket once the platform has made the pair (WebSocketPair does not exist in Node, so a test calls this). */
  async accept(server) {
    this.ctx.acceptWebSocket(server);
    try { server.serializeAttachment({ at: Date.now() }); } catch (_) { /* the socket is closing */ }
    try { server.send(JSON.stringify({ type: 'hello', batches: this.log.todayCount() })); } catch (_) { /* the socket is closing */ }
    await this.ensureAlarm();
  }

  async webSocketMessage() {
    // A tail socket only listens: whatever a client sends, a ping included, is ignored.
  }

  async webSocketClose(ws, code) {
    try { ws.close(code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006 && code !== 1015 ? code : 1000, 'closed'); } catch (_) { /* already closed */ }
  }

  async webSocketError(ws) {
    try { ws.close(1011, 'error'); } catch (_) { /* already gone */ }
  }

  /** The sweep: close tail sockets that have been open for 12 hours, delete old rows, and sleep again unless nothing is left to look after. */
  async alarm() {
    await this.ready;
    this.alarmAt = null;
    const now = Date.now();
    let open = 0;
    for (const ws of this.ctx.getWebSockets()) {
      let saved = null;
      try { saved = ws.deserializeAttachment(); } catch (_) { saved = null; }
      if (now - (saved && typeof saved.at === 'number' ? saved.at : 0) >= TAIL_MAX_MS) {
        try { ws.close(1001, 'idle'); } catch (_) { /* already gone */ }
      } else {
        open++;
      }
    }
    const swept = await this.log.sweep();
    if (swept.more) await this.arm(now + 1000);
    else if (swept.rows > 0 || open > 0) await this.arm(now + SWEEP_MS);
  }
}
