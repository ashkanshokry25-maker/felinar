// src/sw/media-route.js: the Service Worker routes for shared files and private media (R 2.8.5, 2.9.6;
// MF-47, MF-48; ARCHITECTURE 15.7; INTERFACES "v0.3 (proposed)" src/sw/media-route.js). Imported by
// core.js and routed before the navigation catch-all. No worker globals at module level: the clients
// API, the clock and timers are injected, so Node tests run it as is.
//
//   GET /_mw/f/<id>                a file download: application/octet-stream, Content-Disposition
//                                  attachment with filename*, nosniff, CSP "sandbox; default-src 'none'",
//                                  CORP same-origin, Cache-Control no-store, Accept-Ranges; the bytes are
//                                  plaintext blocks the engine page reads from its chunk store
//   GET /_mw/media/<sid>[?part=poster]
//                                  private media: the worker asks the engine page for ciphertext chunks
//                                  and decrypts them with the session key; 206 for one range (open-ended,
//                                  suffix and bytes=0-1 included), 200 streamed without Range or for
//                                  several ranges, 416 when unsatisfiable, 410 when the session is gone
//                                  (the engine page closed, sign-out, 12 hours)
//
// Sessions arrive as mw-session-register messages from the engine page with a private MessagePort
// (event.ports[0]); the worker sends mw-chunk-need { sid, req, i } on that port and the page answers
// mw-chunk { req, i, data } (ciphertext for media, plaintext blocks for files) or { req, i, error }. When the
// player cancels a range stream (a seek, a closed tab), the worker sends mw-chunk-cancel { sid, req, i } for each
// chunk still requested, so the page stops waiting and takes those pieces out of the front of the download (code
// review v0.3, correctness: abandoned seek ranges piled up in front of the one being watched).
// A worker that restarted has no sessions: it broadcasts mw-session-lost { sid } to its window clients
// and waits a short time for the page to register the session again. At most 4 decrypted chunks per
// stream are in flight (R 2.9.6, chosen). Keys live only in this memory: never in storage, never in a
// response, never sent anywhere.

import { MSG, message } from './protocol.js';
import { parseRange } from './lib.js';
import { fileHeaders, mediaHeaders, unsatisfiedRange } from '../files/serve.js';
import { checkManifest, importChunkKey, decryptChunk, regionOf, partInfo, TAG_BYTES } from '../media/format.js';
import { b64url } from '../chain/canonical.js';

export const ROUTES = Object.freeze({ file: '/_mw/f/', media: '/_mw/media/' });
export const SESSION_MAX_MS = 12 * 60 * 60 * 1000;
export const GONE_TEXT = 'Open this again to keep watching.';

export const DEFAULT_MEDIA_LIMITS = Object.freeze({
  inFlight: 4, // decrypted chunks in flight per stream (R 2.9.6)
  chunkTimeoutMs: 120000, // a chunk the page does not answer within this time fails the stream
  reregisterWaitMs: 3000, // after a worker restart: how long a request waits for the page to register again
  sessionsMax: 256,
  fileBlockMax: 4194304,
});

const SID_RE = /^[0-9a-f]{32}$/;

function plain(status, body) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  });
}

function routeError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

/**
 * createMediaRoute({ env, limits }) -> { owns(pathname), handle(event, req, url), register(data, event),
 *   close(data, event), inspect() }
 * env: { clients, now, setTimeout, clearTimeout }
 */
export function createMediaRoute({ env = {}, limits = {} } = {}) {
  const L = Object.assign({}, DEFAULT_MEDIA_LIMITS, limits);
  const now = typeof env.now === 'function' ? env.now : () => Date.now();
  const setT = typeof env.setTimeout === 'function' ? env.setTimeout : (fn, ms) => setTimeout(fn, ms);
  const clearT = typeof env.clearTimeout === 'function' ? env.clearTimeout : (id) => clearTimeout(id);
  const sessions = new Map(); // sid -> session
  const waiting = new Map(); // sid -> [resolve] (requests waiting for a re-registration)
  const stats = { streams: 0, maxInFlight: 0, chunks: 0, lost: 0, gone: 0 };
  let reqCounter = 0;

  function owns(pathname) {
    return typeof pathname === 'string' && (pathname.indexOf(ROUTES.file) === 0 || pathname.indexOf(ROUTES.media) === 0);
  }

  function drop(sid, reason) {
    const s = sessions.get(sid);
    if (!s) return;
    sessions.delete(sid);
    for (const p of s.pending.values()) {
      clearT(p.timer);
      p.reject(routeError('E_FILE_UNAVAILABLE', 'the session ended: ' + reason));
    }
    s.pending.clear();
    try {
      if (s.port && typeof s.port.close === 'function') s.port.close();
    } catch (_) { /* already closed */ }
  }

  function onPort(s, data) {
    if (!data || typeof data !== 'object' || data.type !== MSG.chunk) return;
    const p = s.pending.get(data.req);
    if (!p) return;
    s.pending.delete(data.req);
    clearT(p.timer);
    if (data.error || !data.data) p.reject(routeError(typeof data.error === 'string' && /^E_[A-Z_]+$/.test(data.error) ? data.error : 'E_FILE_UNAVAILABLE', 'chunk ' + data.i + ' is not available'));
    else p.resolve(data.data instanceof Uint8Array ? data.data : new Uint8Array(data.data));
  }

  /** register(data, event) -> Promise<ack fields>: a session from the engine page (mw-session-register). */
  async function register(data, event) {
    const sid = typeof data.sid === 'string' ? data.sid : '';
    if (!SID_RE.test(sid)) return { ok: false, error: 'sid' };
    const port = event && event.ports && event.ports[0];
    if (!port || typeof port.postMessage !== 'function') return { ok: false, error: 'port' };
    const t = now();
    const exp = Math.min(Number.isFinite(data.exp) ? data.exp : t + SESSION_MAX_MS, t + SESSION_MAX_MS);
    if (exp <= t) return { ok: false, error: 'expired' };
    const s = { sid, kind: data.kind === 'file' ? 'file' : 'media', port, exp, clientId: null, pending: new Map(), at: t };
    if (event.source && typeof event.source.id === 'string') s.clientId = event.source.id;
    if (typeof data.clientId === 'string' && data.clientId) s.clientId = data.clientId;
    if (s.kind === 'media') {
      try {
        s.M = checkManifest(data.M);
        s.key = await importChunkKey(data.fk);
        s.fid = b64url.decode(s.M.fid);
        s.base = b64url.decode(s.M.base);
      } catch (_) {
        return { ok: false, error: 'manifest' };
      }
    } else {
      const f = data.file || {};
      const block = f.block;
      if (!Number.isSafeInteger(f.size) || f.size < 0 || !Number.isSafeInteger(block) || block <= 0 || block > L.fileBlockMax) return { ok: false, error: 'file' };
      s.file = { name: typeof f.name === 'string' ? f.name : 'file', size: f.size, block };
    }
    if (sessions.has(sid)) drop(sid, 'registered again');
    while (sessions.size >= L.sessionsMax) {
      const oldest = sessions.keys().next().value;
      drop(oldest, 'too many sessions');
    }
    sessions.set(sid, s);
    port.onmessage = (e) => onPort(s, e && e.data);
    if (typeof port.start === 'function') port.start();
    const w = waiting.get(sid);
    if (w) {
      waiting.delete(sid);
      for (const fn of w) fn(true);
    }
    return { ok: true, sid, exp };
  }

  /** close(data) -> ack fields: ends one session ({ sid }) or every session of the sender ({ all: true }). */
  function close(data, event) {
    if (data && data.all === true) {
      const id = event && event.source && typeof event.source.id === 'string' ? event.source.id : null;
      let n = 0;
      for (const [sid, s] of Array.from(sessions.entries())) {
        if (!id || s.clientId === id) {
          drop(sid, 'closed');
          n++;
        }
      }
      return { ok: true, closed: n };
    }
    const sid = data && typeof data.sid === 'string' ? data.sid : '';
    if (!sessions.has(sid)) return { ok: true, closed: 0 };
    drop(sid, 'closed');
    return { ok: true, closed: 1 };
  }

  async function broadcastLost(sid) {
    if (!env.clients || typeof env.clients.matchAll !== 'function') return;
    try {
      const list = await env.clients.matchAll({ type: 'window', includeUncontrolled: false });
      for (const c of list) {
        try {
          c.postMessage(message(MSG.sessionLost, { sid }));
        } catch (_) { /* that page went away */ }
      }
    } catch (_) { /* no clients API */ }
  }

  // A session this worker does not hold: ask the pages to register it again, wait a bounded time.
  async function reacquire(sid) {
    stats.lost++;
    const got = new Promise((resolve) => {
      let timer = null;
      const done = (v) => {
        clearT(timer);
        resolve(v);
      };
      const list = waiting.get(sid) || [];
      list.push(done);
      waiting.set(sid, list);
      timer = setT(() => {
        const left = (waiting.get(sid) || []).filter((fn) => fn !== done);
        if (left.length) waiting.set(sid, left);
        else waiting.delete(sid);
        done(false);
      }, L.reregisterWaitMs);
    });
    await broadcastLost(sid);
    await got;
    return sessions.get(sid) || null;
  }

  async function alive(s) {
    if (s.exp <= now()) return false;
    if (!s.clientId || !env.clients || typeof env.clients.get !== 'function') return true;
    try {
      return Boolean(await env.clients.get(s.clientId));
    } catch (_) {
      return true;
    }
  }

  function requestUnit(s, i, track = null) {
    return new Promise((resolve, reject) => {
      const req = ++reqCounter;
      if (track) track.set(req, i);
      const timer = setT(() => {
        s.pending.delete(req);
        if (track) track.delete(req);
        reject(routeError('E_FILE_UNAVAILABLE', 'chunk ' + i + ' did not arrive in time'));
      }, L.chunkTimeoutMs);
      const settle = (fn) => (v) => {
        if (track) track.delete(req);
        fn(v);
      };
      s.pending.set(req, { resolve: settle(resolve), reject: settle(reject), timer });
      stats.maxInFlight = Math.max(stats.maxInFlight, s.pending.size);
      try {
        s.port.postMessage(message(MSG.chunkNeed, { sid: s.sid, req, i }));
      } catch (err) {
        clearT(timer);
        s.pending.delete(req);
        reject(routeError('E_FILE_UNAVAILABLE', 'the engine page is gone'));
      }
    });
  }

  // The byte range [start, end] of a part as a stream of plaintext slices, at most L.inFlight units ahead.
  function rangeStream(s, part, start, end) {
    let unit;
    let base;
    let open;
    if (s.kind === 'media') {
      unit = s.M.P - TAG_BYTES;
      base = partInfo(s.M, part).first;
      open = async (i, ct) => decryptChunk(s.key, s.base, s.fid, i, s.M.total, regionOf(s.M, i), ct);
    } else {
      unit = s.file.block;
      base = 0;
      open = async (i, bytes) => {
        const want = Math.min(unit, s.file.size - i * unit);
        if (bytes.length !== want) throw routeError('E_FILE_UNAVAILABLE', 'block ' + i + ' has the wrong size');
        return bytes;
      };
    }
    const firstU = Math.floor(start / unit);
    const lastU = Math.floor(end / unit);
    let next = firstU;
    let cancelled = false;
    const queue = [];
    const outstanding = new Map(); // req -> chunk index, while the page has not answered
    const fetchUnit = (u) => {
      const i = base + u;
      const p = requestUnit(s, i, outstanding).then((bytes) => open(i, bytes)).then((pt) => {
        stats.chunks++;
        const from = u === firstU ? start - u * unit : 0;
        const to = u === lastU ? end - u * unit + 1 : unit;
        return pt.subarray(from, to);
      });
      p.catch(() => {});
      return p;
    };
    const fill = () => {
      while (!cancelled && queue.length < L.inFlight && next <= lastU) queue.push(fetchUnit(next++));
    };
    stats.streams++;
    return new ReadableStream({
      start() {
        fill();
      },
      async pull(controller) {
        if (queue.length === 0) {
          controller.close();
          return;
        }
        const bytes = await queue.shift();
        fill();
        controller.enqueue(bytes);
        if (queue.length === 0 && next > lastU) controller.close();
      },
      cancel() {
        cancelled = true;
        // The player let go of this range: the page stops waiting for what is still requested (mw-chunk-cancel).
        for (const [req, i] of Array.from(outstanding.entries())) {
          outstanding.delete(req);
          const p = s.pending.get(req);
          if (p) {
            s.pending.delete(req);
            clearT(p.timer);
            p.reject(routeError('E_USER_CANCELLED', 'the range was cancelled'));
          }
          try {
            s.port.postMessage(message(MSG.chunkCancel, { sid: s.sid, req, i }));
          } catch (_) { /* the page went away */ }
        }
      },
    }, { highWaterMark: 0 });
  }

  async function handle(event, req, url) {
    const isFile = url.pathname.indexOf(ROUTES.file) === 0;
    const id = url.pathname.slice((isFile ? ROUTES.file : ROUTES.media).length);
    if (!SID_RE.test(id)) return plain(404, 'Not found');
    let s = sessions.get(id) || await reacquire(id);
    if (s && !(await alive(s))) {
      drop(id, 'gone');
      s = null;
    }
    if (!s) {
      stats.gone++;
      return plain(410, GONE_TEXT);
    }
    if ((s.kind === 'file') !== isFile) return plain(404, 'Not found');
    const part = !isFile && url.searchParams.get('part') === 'poster' ? 'poster' : 'media';
    const info = isFile ? { size: s.file.size, mime: null } : partInfo(s.M, part);
    if (!isFile && part === 'poster' && info.size === 0) return plain(404, 'No poster');
    const range = parseRange(req.headers && typeof req.headers.get === 'function' ? req.headers.get('range') : null, info.size);
    const headersFor = (r) => (isFile ? fileHeaders({ name: s.file.name, size: info.size, range: r }) : mediaHeaders({ mime: info.mime, size: info.size, range: r }));
    if (range === 416) {
      const h = headersFor(null);
      delete h['Content-Length'];
      h['Content-Range'] = unsatisfiedRange(info.size);
      return new Response(null, { status: 416, statusText: 'Range Not Satisfiable', headers: h });
    }
    if (info.size === 0) return new Response(new Uint8Array(0), { status: 200, headers: headersFor(null) });
    if (range) {
      return new Response(rangeStream(s, part, range.start, range.end), { status: 206, statusText: 'Partial Content', headers: headersFor(range) });
    }
    return new Response(rangeStream(s, part, 0, info.size - 1), { status: 200, statusText: 'OK', headers: headersFor(null) });
  }

  function inspect() {
    return {
      sessions: sessions.size,
      kinds: Array.from(sessions.values()).map((s) => s.kind),
      waiting: waiting.size,
      stats: Object.assign({}, stats),
    };
  }

  return { owns, handle, register, close, inspect };
}
