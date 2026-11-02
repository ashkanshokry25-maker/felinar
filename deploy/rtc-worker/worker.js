// deploy/rtc-worker/worker.js: a WebSocket tracker ("rendezvous") as a Cloudflare Worker with one Durable Object, for sites
// whose visitors must meet without a server of your own (README.md in this folder). The protocol and the allow list are in
// rtc.js; this file only wraps them around the platform: the Worker answers /healthz and hands WebSocket upgrades to the
// Durable Object, which accepts them with the Hibernation API (the object sleeps between messages and is woken by them),
// keeps each connection's state on the socket itself (serializeAttachment), and closes idle connections from an alarm.
import { createRendezvous, parseAllow, MAX_MESSAGE_BYTES } from './rtc.js';

const OBJECT_NAME = 'swarms';
const SWEEP_MS = 5 * 60 * 1000;

const text = (body, status = 200, extra = {}) => new Response(body, { status, headers: Object.assign({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, extra) });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return text('ok\n');
    if (url.pathname === '/stats.json') {
      if (!env.STATS_TOKEN || url.searchParams.get('token') !== env.STATS_TOKEN) return text('not found\n', 404);
      return env.RTC.get(env.RTC.idFromName(OBJECT_NAME)).fetch(request);
    }
    if (url.pathname !== '/') return text('not found\n', 404);
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return text('This is a felinar rendezvous: it answers WebSocket connections from the loader (deploy/rtc-worker/README.md).\n', 426, { Upgrade: 'websocket' });
    }
    return env.RTC.get(env.RTC.idFromName(OBJECT_NAME)).fetch(request);
  },
};

/** coreFromEnv(env) -> the rendezvous core configured by the Worker's vars (wrangler.jsonc). */
export function coreFromEnv(env, now) {
  const allow = parseAllow(env.ALLOW || '');
  const intervalS = Number(env.INTERVAL_S);
  return createRendezvous({
    allow: allow.set, uploads: allow.uploads || env.UPLOADS === '1', open: env.OPEN === '1',
    intervalS: Number.isFinite(intervalS) && intervalS >= 10 ? intervalS : undefined, now,
  });
}

export class Rendezvous {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.core = coreFromEnv(env);
    this.conns = new Map();
    for (const ws of ctx.getWebSockets()) {
      let saved = null;
      try { saved = ws.deserializeAttachment(); } catch (_) { saved = null; }
      this.core.attach(this.connFor(ws), saved);
    }
  }

  connFor(ws) {
    let conn = this.conns.get(ws);
    if (!conn) {
      conn = { send: (t) => { try { ws.send(t); } catch (_) { /* the socket is closing */ } } };
      this.conns.set(ws, conn);
    }
    return conn;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/stats.json') return new Response(JSON.stringify(this.core.stats()) + '\n', { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return text('expected a WebSocket\n', 426, { Upgrade: 'websocket' });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const conn = this.connFor(server);
    this.core.attach(conn, null);
    server.serializeAttachment(this.core.attachmentOf(conn));
    await this.ensureAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string') { ws.close(1003, 'text frames only'); return; }
    if (message.length > MAX_MESSAGE_BYTES) { ws.close(1009, 'message too large'); return; }
    const conn = this.connFor(ws);
    const r = this.core.message(conn, message);
    // changed: the swarms moved, or the saved time is ATTACHMENT_REFRESH_S old (rtc.js), so a sweep after a wake sees a live socket
    if (r.changed) { try { ws.serializeAttachment(this.core.attachmentOf(conn)); } catch (_) { /* the swarm cap keeps it under the limit */ } }
  }

  async webSocketClose(ws) { this.drop(ws); }

  async webSocketError(ws) { this.drop(ws); }

  drop(ws) {
    const conn = this.conns.get(ws);
    if (!conn) return;
    this.core.close(conn);
    this.conns.delete(ws);
  }

  /** The sweep: close every connection that announced nothing for PEER_TTL_S, then sleep again until the next sweep. */
  async alarm() {
    const nowMs = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const conn = this.connFor(ws);
      if (!this.core.stale(conn, nowMs)) continue;
      try { ws.close(1001, 'idle'); } catch (_) { /* already gone */ }
      this.drop(ws);
    }
    if (this.ctx.getWebSockets().length) await this.ctx.storage.setAlarm(nowMs + SWEEP_MS);
  }

  async ensureAlarm() {
    const at = await this.ctx.storage.getAlarm();
    if (at === null || at === undefined) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }
}
