// deploy/rtc-worker/worker.js: a WebSocket tracker ("rendezvous") as a Cloudflare Worker with one Durable Object, for sites
// whose visitors must meet without a server of your own (README.md in this folder). The protocol and the allow list are in
// rtc.js, the pairing and room protocol of the apps in pair.js; this file only wraps them around the platform: the Worker
// answers /healthz and hands WebSocket upgrades to the Durable Object, which accepts them with the Hibernation API (the object
// sleeps between messages and is woken by them), keeps each connection's state on the socket itself (serializeAttachment),
// keeps the rows that must outlive a socket in ctx.storage (a pairing code's details as chan:<channel>, a private lane's expiry
// as lane:<hex>), and closes idle connections and expires codes, knocks and lanes from an alarm.
import { createRendezvous, parseAllow, MAX_MESSAGE_BYTES, ATTACHMENT_REFRESH_S } from './rtc.js';
import { CHAN_KEY, LANE_KEY } from './pair.js';

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

/** coreFromEnv(env, now, extra) -> the rendezvous core configured by the Worker's vars (wrangler.jsonc); extra adds core options (persist). */
export function coreFromEnv(env, now, extra = {}) {
  const allow = parseAllow(env.ALLOW || '');
  const intervalS = Number(env.INTERVAL_S);
  return createRendezvous(Object.assign({
    allow: allow.set, uploads: allow.uploads || env.UPLOADS === '1', open: env.OPEN === '1',
    intervalS: Number.isFinite(intervalS) && intervalS >= 10 ? intervalS : undefined, now,
    pairing: env.PAIRING !== '0',
  }, extra));
}

export class Rendezvous {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.writes = []; // storage writes started by the core, awaited before the handler returns
    this.core = coreFromEnv(env, undefined, { persist: (ops) => this.persist(ops) });
    this.conns = new Map(); // ws -> conn
    this.written = new Map(); // conn -> ms: when its attachment was last written (rtc-worker-lane-2)
    // The rows of the codes and lanes are loaded before the first event is delivered (a wake delivers one), then the sockets
    // that survived are attached: the channel-to-socket map is rebuilt from their attachments.
    this.ready = ctx.blockConcurrencyWhile(() => this.wake());
    this.ready.catch(() => {}); // a failed load resets the object; the handlers below see the rejection themselves
  }

  async wake() {
    const [chans, lanes] = await Promise.all([this.ctx.storage.list({ prefix: CHAN_KEY }), this.ctx.storage.list({ prefix: LANE_KEY })]);
    this.core.restore({ chans, lanes });
    for (const ws of this.ctx.getWebSockets()) {
      let saved = null;
      try { saved = ws.deserializeAttachment(); } catch (_) { saved = null; }
      const conn = this.connFor(ws);
      this.core.attach(conn, saved);
      if (saved && typeof saved.t === 'number') this.written.set(conn, saved.t * 1000);
    }
    // codes whose socket is gone, codes and knocks that ran out while the object slept
    this.touch(this.core.sweep(Date.now()).touched);
    await this.settle();
    if (this.ctx.getWebSockets().length) await this.rearm();
  }

  connFor(ws) {
    let conn = this.conns.get(ws);
    if (!conn) {
      conn = { ws, send: (t) => { try { ws.send(t); } catch (_) { /* the socket is closing */ } } };
      this.conns.set(ws, conn);
    }
    return conn;
  }

  /** persist(ops): the core's storage rows; the writes are started now (before its replies are sent) and awaited by settle(). */
  persist(ops) {
    for (const [kind, key, value] of ops) this.writes.push(kind === 'put' ? this.ctx.storage.put(key, value) : this.ctx.storage.delete(key));
  }

  async settle() {
    while (this.writes.length) await Promise.all(this.writes.splice(0));
  }

  /** keep(ws, conn): store the connection's state on its socket. */
  keep(ws, conn, at = Date.now()) {
    try {
      ws.serializeAttachment(this.core.attachmentOf(conn));
      this.written.set(conn, at);
    } catch (_) { /* the caps keep it under the 2 KB limit */ }
  }

  /** touch(conns): the connections other than the sender whose saved state moved (a requester whose knock was answered). */
  touch(conns) {
    for (const conn of conns || []) if (conn.ws && this.conns.get(conn.ws) === conn) this.keep(conn.ws, conn);
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname === '/stats.json') return new Response(JSON.stringify(this.core.stats()) + '\n', { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return text('expected a WebSocket\n', 426, { Upgrade: 'websocket' });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const conn = this.connFor(server);
    this.core.attach(conn, null);
    this.keep(server, conn);
    await this.ensureAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    await this.ready;
    if (typeof message !== 'string') { ws.close(1003, 'text frames only'); return; }
    if (message.length > MAX_MESSAGE_BYTES) { ws.close(1009, 'message too large'); return; }
    const conn = this.connFor(ws);
    const r = this.core.message(conn, message);
    const at = Date.now();
    // rtc-worker-lane-2: a periodic announce changes no membership, so the stored time would stay at the last join and an object
    // rebuilt after a wake would close a live socket as idle. Rewrite the attachment once its time is ATTACHMENT_REFRESH_S old (rtc.js).
    if (r.changed || at - (this.written.get(conn) || 0) >= ATTACHMENT_REFRESH_S * 1000) this.keep(ws, conn, at);
    this.touch(r.touched);
    await this.settle();
    if (r.pair) await this.rearm();
  }

  async webSocketClose(ws) { await this.drop(ws); }

  async webSocketError(ws) { await this.drop(ws); }

  async drop(ws) {
    await this.ready;
    const conn = this.conns.get(ws);
    if (!conn) return;
    const r = this.core.close(conn);
    this.conns.delete(ws);
    this.written.delete(conn);
    this.touch(r.touched);
    await this.settle();
  }

  /** nextAlarm(nowMs) -> when the next sweep runs: in a sweep period, or sooner when a knock, a code or a lane runs out first. */
  nextAlarm(nowMs) {
    return Math.max(nowMs + 1000, Math.min(nowMs + SWEEP_MS, this.core.nextExpiry()));
  }

  /** The sweep: expire lanes, codes and knocks, close every connection that announced nothing for PEER_TTL_S, then sleep again until the next one. */
  async alarm() {
    await this.ready;
    const nowMs = Date.now();
    this.touch(this.core.sweep(nowMs).touched);
    for (const ws of this.ctx.getWebSockets()) {
      const conn = this.connFor(ws);
      if (!this.core.stale(conn, nowMs)) continue;
      try { ws.close(1001, 'idle'); } catch (_) { /* already gone */ }
      await this.drop(ws);
    }
    await this.settle();
    if (this.ctx.getWebSockets().length) await this.ctx.storage.setAlarm(this.nextAlarm(nowMs));
  }

  async ensureAlarm() {
    const at = await this.ctx.storage.getAlarm();
    if (at === null || at === undefined) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  /** rearm(): pull the alarm forward when a new knock or code runs out before it. */
  async rearm() {
    const want = this.nextAlarm(Date.now());
    const at = await this.ctx.storage.getAlarm();
    if (at === null || at === undefined || want < at) await this.ctx.storage.setAlarm(want);
  }
}
