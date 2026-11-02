// deploy/obs-worker/pages/public/_worker.js: the front of the usage report endpoint for a Cloudflare Pages project (Pages "advanced
// mode": this one file answers every request). It is a copy of the lines between the "front" markers of ../../worker.js, which the
// unit test (test/unit/deploy-obs-worker.test.mjs) compares with this file. Change worker.js, then replace everything under this
// comment with the output of: sed -n '/^\/\/ ===== front: begin/,/^\/\/ ===== front: end/p' ../../worker.js
// It imports nothing, so it needs no bundler. A Pages project cannot define a Durable Object class: the binding OBS of
// ../wrangler.toml reaches the class ObsLog of the Worker felinar-obs-do, deployed from the folder two levels up.
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
