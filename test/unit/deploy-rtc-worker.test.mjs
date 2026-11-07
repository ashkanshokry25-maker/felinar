// Unit tests for deploy/rtc-worker: the rendezvous core (rtc.js) through fake connections, and the Worker and Durable Object
// wrapper (worker.js) through a fake platform. Nothing here opens a socket; the protocol is bittorrent-tracker 11.2.3's, the
// one test/unit/tools-tracker.test.mjs drives against tools/tracker.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRendezvous, parseAllow, messageProblem, bin2hex, hex2bin, INTERVAL_S, MAX_OFFERS, MAX_SWARMS_PER_SOCKET, PEER_TTL_S, ATTACHMENT_REFRESH_S } from '../../deploy/rtc-worker/rtc.js';
import worker, { Rendezvous, coreFromEnv } from '../../deploy/rtc-worker/worker.js';
import { LANE_TTL_MS, CHANNEL_TTL_MS, KNOCK_TTL_MS, MIXED } from '../../deploy/rtc-worker/pair.js';
import { readFileSync } from 'node:fs';

// The platform's class for the keepalive auto-response does not exist in Node; the fake one keeps the two texts it was given.
globalThis.WebSocketRequestResponsePair = class WebSocketRequestResponsePair {
  constructor(request, response) { this.request = request; this.response = response; }
};

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const bin = (hex) => Buffer.from(hex, 'hex').toString('binary');
const peer = (ch) => ch.repeat(20);
// The tests written before the relay lane pin stats() exactly; they do it through noRelay(stats), which drops the seven relay
// fields (plan 3.2), and the relay tests below pin those seven themselves.
const RELAY_FIELDS = ['relays', 'relayed', 'relayBytes', 'relayDay', 'relayBusy', 'relayRate', 'joinsRefused'];
const noRelay = (stats) => { const out = Object.assign({}, stats); for (const k of RELAY_FIELDS) delete out[k]; return out; };

/** A fake connection: collects what the core sends, parsed. */
function conn(name) {
  const out = [];
  return { name, out, send: (t) => out.push(JSON.parse(t)), last: () => out[out.length - 1], take: () => out.splice(0) };
}
const announce = (hex, id, extra = {}) => JSON.stringify(Object.assign({ action: 'announce', info_hash: bin(hex), peer_id: id, uploaded: 0, downloaded: 0, left: 0, event: 'started', numwant: 0, offers: [] }, extra));
const offer = (n) => ({ offer: { type: 'offer', sdp: 'v=0 offer ' + n }, offer_id: 'o' + n });

test('bin2hex / hex2bin / parseAllow / messageProblem', () => {
  assert.equal(bin2hex(bin(A)), A);
  assert.equal(hex2bin(A), bin(A));
  assert.equal(bin2hex('short'), null);
  assert.equal(bin2hex('\u0100' + 'x'.repeat(19)), null, 'a char above 255 is not a byte');
  const p = parseAllow('# the site\n' + A.toUpperCase() + ', urn:btih:' + B + '\nmagnet:?xt=urn:btih:' + C + '&dn=x uploads\n');
  assert.deepEqual(Array.from(p.set).sort(), [A, B, C]);
  assert.equal(p.uploads, true);
  assert.equal(parseAllow('').set.size, 0);
  assert.equal(messageProblem(JSON.parse(announce(A, peer('p')))), null);
  assert.equal(messageProblem({ action: 'announce', info_hash: 'x', peer_id: peer('p') }), 'invalid info_hash');
  assert.equal(messageProblem({ action: 'announce', info_hash: bin(A), peer_id: 'p' }), 'invalid peer_id');
  assert.equal(messageProblem({ action: 'announce', info_hash: bin(A), peer_id: peer('p'), event: 'boom' }), 'invalid event');
  assert.equal(messageProblem({ action: 'announce', info_hash: bin(A), peer_id: peer('p'), answer: { sdp: 'x' } }), 'invalid `to_peer_id` (required with `answer`)');
  assert.equal(messageProblem({ action: 'announce', info_hash: bin(A), peer_id: peer('p'), offers: [null] }), 'invalid offers');
  assert.equal(messageProblem({ action: 'announce', info_hash: bin(A), peer_id: peer('p'), offers: 'xxxxx' }), 'invalid offers');
  assert.equal(messageProblem({ action: 'announce', info_hash: bin(A), peer_id: peer('p'), offers: Array.from({ length: MAX_OFFERS + 1 }, (_, i) => offer(i)) }), 'invalid offers');
  assert.equal(messageProblem({ action: 'scrape', info_hash: [bin(A), 'nope'] }), 'invalid info_hash');
  assert.equal(messageProblem({ action: 'scrape' }), null);
  assert.equal(messageProblem({ action: 'connect' }), 'invalid action in WS request: connect');
  assert.equal(messageProblem(null), 'invalid message');
});

test('announce: the counts come back, offers reach other peers of the swarm, an answer reaches the peer it names and gets no reply', () => {
  const r = createRendezvous({ allow: new Set([A]) });
  const a = conn('a');
  const b = conn('b');
  let res = r.message(a, announce(A, peer('a'), { offers: [offer(1)] }));
  assert.equal(res.problem, null);
  assert.equal(res.changed, true);
  assert.deepEqual(a.take(), [{ action: 'announce', interval: INTERVAL_S, info_hash: bin(A), complete: 1, incomplete: 0 }], 'alone: the counts, nobody to send the offer to');
  res = r.message(b, announce(A, peer('b'), { left: 100, offers: [offer(2), offer(3)] }));
  assert.deepEqual(b.take(), [{ action: 'announce', interval: INTERVAL_S, info_hash: bin(A), complete: 1, incomplete: 1 }]);
  assert.deepEqual(a.take(), [{ action: 'announce', offer: offer(2).offer, offer_id: 'o2', peer_id: peer('b'), info_hash: bin(A) }], 'one other peer: one offer forwarded');
  res = r.message(a, announce(A, peer('a'), { event: 'update', answer: { type: 'answer', sdp: 'v=0 answer' }, offer_id: 'o2', to_peer_id: peer('b') }));
  assert.equal(res.changed, false);
  assert.deepEqual(a.take(), [], 'an answer gets no reply');
  assert.deepEqual(b.take(), [{ action: 'announce', answer: { type: 'answer', sdp: 'v=0 answer' }, offer_id: 'o2', peer_id: peer('a'), info_hash: bin(A) }]);
  r.message(a, announce(A, peer('a'), { event: 'update', answer: { sdp: 'x' }, offer_id: 'o9', to_peer_id: peer('z') }));
  assert.deepEqual(b.take(), [], 'an answer to an unknown peer goes nowhere');
  assert.deepEqual(noRelay(r.stats()), { open: false, uploads: false, allowed: 1, swarms: 1, unlisted: 0, peers: 2, sockets: 2, interval: INTERVAL_S, codes: 0, knocks: 0, lanes: 0 });
  r.message(b, announce(A, peer('b'), { event: 'stopped' }));
  assert.deepEqual(b.take(), [{ action: 'announce', interval: INTERVAL_S, info_hash: bin(A), complete: 1, incomplete: 0 }], 'stopped is answered with the counts');
  assert.equal(r.stats().peers, 1);
  r.message(a, JSON.stringify({ action: 'scrape', info_hash: [bin(A), bin(B)] }));
  const sc = a.last();
  assert.equal(sc.action, 'scrape');
  assert.deepEqual(sc.files[bin(A)], { complete: 1, incomplete: 0, downloaded: 1 });
  assert.deepEqual(sc.files[bin(B)], { complete: 0, incomplete: 0, downloaded: 0 });
  assert.deepEqual(sc.flags, { min_request_interval: INTERVAL_S });
});

test('the allow list: an unlisted infohash is refused; uploads mode serves it under the caps; open mode serves anything', () => {
  const r = createRendezvous({ allow: new Set([A]) });
  const a = conn('a');
  r.message(a, announce(B, peer('a')));
  assert.match(a.last()['failure reason'], /not allowed/);
  assert.equal(a.last().action, 'announce');
  assert.equal(a.last().info_hash, bin(B));
  assert.equal(r.stats().swarms, 0);
  const u = createRendezvous({ allow: new Set([A]), uploads: true, maxUnlisted: 1, maxPerSocket: 3 });
  const c = conn('c');
  u.message(c, announce(B, peer('c')));
  assert.equal(c.last().action, 'announce');
  assert.equal(c.last()['failure reason'], undefined, 'uploads mode: an unlisted swarm is served');
  u.message(c, announce(C, peer('c')));
  assert.match(c.last()['failure reason'], /no room for another unlisted swarm/);
  u.message(c, announce(A, peer('c')));
  assert.equal(c.last()['failure reason'], undefined, 'a listed swarm is always served');
  const d = conn('d');
  u.message(d, announce(B, peer('d')));
  assert.equal(d.last()['failure reason'], undefined, 'an unlisted swarm that exists takes another peer');
  assert.deepEqual(noRelay(u.stats()), { open: false, uploads: true, allowed: 1, swarms: 2, unlisted: 1, peers: 3, sockets: 2, interval: INTERVAL_S, codes: 0, knocks: 0, lanes: 0 });
  u.close(c);
  u.close(d);
  assert.deepEqual([u.stats().swarms, u.stats().unlisted, u.stats().peers, u.stats().sockets], [1, 0, 0, 0], 'a closed connection takes its peers; an empty unlisted swarm goes, a listed one stays');
  const o = createRendezvous({ open: true });
  o.message(a, announce(C, peer('a')));
  assert.equal(a.last()['failure reason'], undefined);
  const cap = createRendezvous({ open: true, maxPerSocket: 2 });
  const e = conn('e');
  for (const h of [A, B, C]) cap.message(e, announce(h, peer('e')));
  assert.match(e.last()['failure reason'], /too many swarms on one connection \(2\)/);
  assert.equal(MAX_SWARMS_PER_SOCKET, 32);
});

test('malformed messages are answered with a failure reason and change nothing; the state survives a restore from the attachment', () => {
  const r = createRendezvous({ allow: new Set([A, B]), now: () => 1000000 });
  const a = conn('a');
  assert.deepEqual(r.message(a, 'not json'), { changed: false, problem: 'invalid message: not JSON' });
  assert.deepEqual(a.last(), { 'failure reason': 'invalid message: not JSON' });
  r.message(a, JSON.stringify({ action: 'announce', info_hash: bin(A), peer_id: peer('a'), offers: [null] }));
  assert.deepEqual(a.last(), { 'failure reason': 'invalid offers', action: 'announce', info_hash: bin(A) });
  assert.equal(r.stats().peers, 0);
  r.message(a, announce(A, peer('a')));
  r.message(a, announce(B, peer('a'), { left: 5 }));
  const saved = JSON.parse(JSON.stringify(r.attachmentOf(a)));
  assert.deepEqual(saved, { p: peer('a').split('').map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(''), s: [[A, 1], [B, 0]], t: 1000 });
  assert.ok(JSON.stringify(saved).length < 2048, 'the attachment fits the platform limit');
  // the object woke up: a new core, the connection re-attached from what the socket kept
  const r2 = createRendezvous({ allow: new Set([A, B]), now: () => 1000000 + 5000 });
  const a2 = conn('a2');
  r2.attach(a2, saved);
  assert.deepEqual([r2.stats().swarms, r2.stats().peers, r2.stats().sockets], [2, 2, 1]);
  const b = conn('b');
  r2.message(b, announce(A, peer('b'), { offers: [offer(7)] }));
  assert.equal(a2.last().offer_id, 'o7', 'the restored peer still receives offers');
  assert.equal(r2.stale(a2, 1000000 + 5000), false);
  assert.equal(r2.stale(a2, 1000000 + PEER_TTL_S * 1000 + 1), true, 'idle for the TTL: stale');
  const r3 = createRendezvous({ allow: new Set([A]) });
  const c = conn('c');
  r3.attach(c, { p: saved.p, s: [[A, 1], [B, 0]], t: 1000 });
  assert.equal(r3.stats().swarms, 1, 'a restored swarm that is no longer listed is dropped');
  r3.attach(conn('junk'), { p: 'nope', s: 'nope' });
  assert.equal(r3.stats().sockets, 2);
});

// ---------------------------------------------------------------------------------------------- worker.js

function fakeWs(name) {
  return { name, sent: [], closed: null, attachment: null, autoAt: null, send(t) { this.sent.push(JSON.parse(t)); }, close(code, reason) { this.closed = { code, reason }; }, serializeAttachment(v) { this.attachment = JSON.parse(JSON.stringify(v)); }, deserializeAttachment() { return this.attachment; } };
}
/** The Durable Object storage of the fake platform: rows are cloned in and out like structured clones, list() filters by prefix. */
function fakeStorage(rows = new Map()) {
  let alarm = null;
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  return {
    rows,
    async get(key) { return clone(rows.get(key)); },
    async put(key, value) { rows.set(key, clone(value)); },
    async delete(key) { return rows.delete(key); },
    async list({ prefix = '' } = {}) { const out = new Map(); for (const k of Array.from(rows.keys()).sort()) if (k.startsWith(prefix)) out.set(k, clone(rows.get(k))); return out; },
    async getAlarm() { return alarm; },
    async setAlarm(t) { alarm = t; },
    alarmAt: () => alarm,
  };
}
/**
 * The platform's side of a Durable Object: its sockets, its storage and, for the relay lane, the auto-response of a keepalive ping.
 * setWebSocketAutoResponse(pair) keeps the pair; getWebSocketAutoResponseTimestamp(ws) is the time of the last answer to that socket (a
 * Date, or null); wakes counts the frames that had to wake the object; deliver(obj, ws, text) is what the platform does with a text
 * frame from the client: the exact request text of the pair is answered at once and the object is not woken (only the timestamp moves),
 * anything else wakes the object (wakes + 1) and goes to its webSocketMessage.
 */
function fakeCtx(sockets = [], storage = fakeStorage()) {
  return {
    sockets, accepted: [], storage, wakes: 0, autoResponse: null,
    getWebSockets: () => sockets.slice(),
    acceptWebSocket(ws) { this.accepted.push(ws); sockets.push(ws); },
    blockConcurrencyWhile: (fn) => Promise.resolve().then(fn),
    alarmAt: () => storage.alarmAt(),
    setWebSocketAutoResponse(pair) { this.autoResponse = pair; },
    getWebSocketAutoResponseTimestamp(ws) { return ws.autoAt === null || ws.autoAt === undefined ? null : new Date(ws.autoAt); },
    async deliver(obj, ws, text) {
      if (this.autoResponse && text === this.autoResponse.request) {
        ws.autoAt = Date.now();
        ws.sent.push(JSON.parse(this.autoResponse.response));
        return false;
      }
      this.wakes++;
      await obj.webSocketMessage(ws, text);
      return true;
    },
  };
}
const ENV = { ALLOW: A + ' ' + B, UPLOADS: '0', OPEN: '0', INTERVAL_S: '60', STATS_TOKEN: 's3cret', RTC: null };

test('worker fetch: /healthz, a plain GET of / gets 426, unknown paths 404, /stats.json only with the token; the object answers it', async () => {
  const calls = [];
  const env = Object.assign({}, ENV, { RTC: { idFromName: (n) => 'id:' + n, get: (id) => ({ fetch: async (req) => { calls.push(id + ' ' + new URL(req.url).pathname); return new Response('from the object'); } }) } });
  assert.equal(await (await worker.fetch(new Request('https://rtc.example/healthz'), env)).text(), 'ok\n');
  const plain = await worker.fetch(new Request('https://rtc.example/'), env);
  assert.equal(plain.status, 426);
  assert.equal(plain.headers.get('upgrade'), 'websocket');
  assert.equal((await worker.fetch(new Request('https://rtc.example/announce'), env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://rtc.example/stats.json'), env)).status, 404);
  assert.equal((await worker.fetch(new Request('https://rtc.example/stats.json?token=wrong'), env)).status, 404);
  assert.equal(await (await worker.fetch(new Request('https://rtc.example/stats.json?token=s3cret'), env)).text(), 'from the object');
  assert.equal(await (await worker.fetch(new Request('https://rtc.example/', { headers: { Upgrade: 'websocket' } }), env)).text(), 'from the object');
  assert.deepEqual(calls, ['id:swarms /stats.json', 'id:swarms /']);
  assert.equal((await worker.fetch(new Request('https://rtc.example/stats.json?token=x'), Object.assign({}, env, { STATS_TOKEN: '' }))).status, 404, 'no token set: never');
});

test('the object: messages go through the core, the state is kept on the socket, a close drops the peer, the sweep closes idle sockets, a restart restores', async () => {
  const ctx = fakeCtx();
  const obj = new Rendezvous(ctx, ENV);
  await obj.ready;
  const ws1 = fakeWs('1');
  const ws2 = fakeWs('2');
  ctx.sockets.push(ws1, ws2);
  obj.connFor(ws1); obj.connFor(ws2);
  obj.core.attach(obj.connFor(ws1), null); obj.core.attach(obj.connFor(ws2), null);
  await obj.webSocketMessage(ws1, announce(A, peer('1')));
  assert.equal(ws1.sent[0].interval, 60, 'INTERVAL_S from the vars');
  assert.deepEqual(ws1.attachment.s, [[A, 1]], 'the socket keeps the state');
  await obj.webSocketMessage(ws2, announce(A, peer('2'), { left: 1, offers: [offer(1)] }));
  assert.equal(ws1.sent[1].offer_id, 'o1');
  await obj.webSocketMessage(ws2, new ArrayBuffer(4));
  assert.deepEqual(ws2.closed, { code: 1003, reason: 'text frames only' });
  await obj.webSocketMessage(ws1, 'x'.repeat(131073));
  assert.deepEqual(ws1.closed, { code: 1009, reason: 'message too large' });
  await obj.webSocketClose(ws2);
  assert.equal(obj.core.stats().peers, 1);
  const st = await (await obj.fetch(new Request('https://rtc.example/stats.json'))).json();
  assert.equal(st.peers, 1);
  assert.equal(st.allowed, 2);
  assert.equal((await obj.fetch(new Request('https://rtc.example/'))).status, 426, 'the object itself refuses a plain GET of /');
  // a restart (hibernation): the new object rebuilds the connections from the sockets' attachments
  const ctx2 = fakeCtx([ws1]);
  const obj2 = new Rendezvous(ctx2, ENV);
  await obj2.ready;
  assert.deepEqual([obj2.core.stats().peers, obj2.core.stats().sockets], [1, 1]);
  const ws3 = fakeWs('3');
  ctx2.sockets.push(ws3);
  obj2.core.attach(obj2.connFor(ws3), null);
  await obj2.webSocketMessage(ws3, announce(A, peer('3'), { offers: [offer(5)] }));
  assert.equal(ws1.sent[ws1.sent.length - 1].offer_id, 'o5', 'the restored peer receives offers after the restart');
  // the sweep: ws1 announced before the TTL (its attachment time is old), ws3 just now
  ws1.attachment.t = Math.floor(Date.now() / 1000) - PEER_TTL_S - 60;
  const ctx3 = fakeCtx([ws1, ws3]);
  const obj3 = new Rendezvous(ctx3, ENV);
  await obj3.ready;
  await obj3.alarm();
  assert.deepEqual(ws1.closed, { code: 1001, reason: 'idle' });
  assert.equal(ws3.closed, null);
  assert.equal(obj3.core.stats().sockets, 1);
  assert.ok(ctx3.alarmAt() > Date.now(), 'the next sweep is scheduled while sockets remain');
  const env2 = Object.assign({}, ENV, { ALLOW: 'uploads ' + A, INTERVAL_S: '5' });
  const core = coreFromEnv(env2);
  assert.deepEqual([core.stats().uploads, core.stats().allowed, core.stats().interval], [true, 1, INTERVAL_S], 'INTERVAL_S below 10 falls back to the default');
});

// ---------------------------------------------------------------------------------------------- review findings (rtc-worker-lane report)

const countsOf = (r, c, hex) => {
  r.message(c, JSON.stringify({ action: 'scrape', info_hash: bin(hex) }));
  const f = c.last().files[bin(hex)];
  return [f.complete, f.incomplete];
};

test('rtc-worker-lane-1: an answer does not turn a seeder into a leecher; only left === 0 promotes a peer and nothing demotes one', () => {
  const r = createRendezvous({ allow: new Set([A]) });
  const a = conn('a');
  const b = conn('b');
  const watcher = conn('w');
  r.message(a, announce(A, peer('a')));
  r.message(b, announce(A, peer('b'), { left: 100, offers: [offer(1)] }));
  assert.deepEqual(countsOf(r, watcher, A), [1, 1]);
  a.take();
  // what the loader's client sends to answer an offer: no left and no event
  const answer = JSON.stringify({ action: 'announce', info_hash: bin(A), peer_id: peer('a'), answer: { type: 'answer', sdp: 'v=0 answer' }, offer_id: 'o1', to_peer_id: peer('b') });
  const res = r.message(a, answer);
  assert.equal(res.changed, false, 'an answer moves nothing the socket would have to store');
  assert.equal(b.last().offer_id, 'o1', 'the answer reached the peer it names');
  assert.deepEqual(countsOf(r, watcher, A), [1, 1], 'the seeder is still a seeder (it was counted as a leecher: 0 and 2)');
  assert.deepEqual(r.attachmentOf(a).s, [[A, 1]]);
  // only left === 0 promotes, and nothing demotes (bittorrent-tracker's swarm does the same)
  r.message(b, announce(A, peer('b'), { event: 'update', left: 40 }));
  assert.deepEqual(countsOf(r, watcher, A), [1, 1], 'still downloading');
  r.message(b, announce(A, peer('b'), { event: 'update', left: 0 }));
  assert.deepEqual(countsOf(r, watcher, A), [2, 0], 'done');
  r.message(b, announce(A, peer('b'), { event: 'update', left: 50 }));
  assert.deepEqual(countsOf(r, watcher, A), [2, 0], 'an update does not demote');
  r.message(b, announce(A, peer('b'), { event: 'started', left: 50 }));
  assert.deepEqual(countsOf(r, watcher, A), [2, 0], 'nor does a second started (the library treats it as an update)');
  // an answer from a peer the swarm has never seen registers it as a leecher, as the library does
  const c = conn('c');
  r.message(c, JSON.stringify({ action: 'announce', info_hash: bin(A), peer_id: peer('c'), answer: { sdp: 'x' }, offer_id: 'o9', to_peer_id: peer('z') }));
  assert.deepEqual(countsOf(r, watcher, A), [2, 1]);
  // a peer that stops and comes back starts over
  r.message(b, announce(A, peer('b'), { event: 'stopped' }));
  r.message(b, announce(A, peer('b'), { left: 9 }));
  assert.deepEqual(countsOf(r, watcher, A), [1, 2]);
});

test('rtc-worker-lane-3: a scrape names its infohashes; a bare scrape answers files: {} so nobody can list the swarms, unlisted ones included', () => {
  const r = createRendezvous({ allow: new Set([A, B]), uploads: true });
  const a = conn('a');
  r.message(a, announce(A, peer('a')));
  r.message(a, announce(C, peer('a')));
  assert.equal(r.stats().unlisted, 1, 'an unlisted file swarm exists');
  for (const msg of [{ action: 'scrape' }, { action: 'scrape', info_hash: [] }, { action: 'scrape', info_hash: null }]) {
    assert.equal(r.message(a, JSON.stringify(msg)).problem, null);
    assert.deepEqual(a.last(), { action: 'scrape', files: {}, flags: { min_request_interval: INTERVAL_S } }, JSON.stringify(msg));
  }
  r.message(a, JSON.stringify({ action: 'scrape', info_hash: [bin(A), bin(C)] }));
  assert.deepEqual(Object.keys(a.last().files).sort(), [bin(A), bin(C)].sort(), 'asked for by name, counted');
  r.message(a, JSON.stringify({ action: 'scrape', info_hash: bin(A) }));
  assert.deepEqual(a.last().files, { [bin(A)]: { complete: 1, incomplete: 0, downloaded: 1 } });
});

test('rtc-worker-lane-2: a periodic announce keeps the stored time of a socket fresh, so an object rebuilt after a wake does not close a live socket as idle', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1700000000000 });
  const storage = fakeStorage();
  const live = fakeWs('live');
  const silent = fakeWs('silent');
  const ctx = fakeCtx([live, silent], storage);
  const obj = new Rendezvous(ctx, ENV);
  await obj.ready;
  await join(obj, live);
  await join(obj, silent);
  await obj.webSocketMessage(live, announce(A, peer('1')));
  await obj.webSocketMessage(silent, announce(A, peer('2')));
  const joined = live.attachment.t;
  assert.equal(joined, 1700000000);
  // the loader announces again every 2 minutes (the interval it is told); none of these changes the swarms it is in
  for (let i = 0; i < 10; i++) {
    t.mock.timers.tick(2 * 60 * 1000);
    await obj.webSocketMessage(live, announce(A, peer('1'), { event: 'update' }));
  }
  const now = Math.floor(Date.now() / 1000);
  assert.ok(now - live.attachment.t <= 5 * 60 + 2 * 60, 'the stored time is at most a sweep period (and one announce) behind: ' + (now - live.attachment.t) + ' s');
  assert.ok(live.attachment.t > joined, 'it was rewritten without a change of membership');
  assert.equal(silent.attachment.t, joined, 'a socket that sent nothing keeps its old time');
  t.mock.timers.tick(60 * 1000);
  // 21 minutes after both joined: the object is rebuilt from the attachments (a wake, an eviction, a deployment) and the sweep runs
  const woken = new Rendezvous(fakeCtx([live, silent], storage), ENV);
  await woken.ready;
  await woken.alarm();
  assert.equal(live.closed, null, 'announced a minute ago: not idle');
  assert.deepEqual(silent.closed, { code: 1001, reason: 'idle' }, 'silent for 21 minutes: idle');
  assert.equal(woken.core.stats().sockets, 1);
});

// ---------------------------------------------------------------------------------------------- pairing through the object

const frame = (msg) => JSON.stringify(Object.assign({ v: 1 }, msg));
const BOX = { iv: 'A'.repeat(16), ct: 'B'.repeat(160) };
// the owner's proof of an accept: 86 base64url characters; the object checks the shape and passes it on
const PROOF = 'P'.repeat(86);
const T0 = 1700000000000;
const MIN = 60 * 1000;
const take = (ws) => ws.sent.splice(0);
const clocked = new WeakSet();

/** join(obj, ws): what Rendezvous.fetch() does once the platform has the upgraded socket (WebSocketPair does not exist in Node). */
async function join(obj, ws) {
  if (!obj.ctx.sockets.includes(ws)) obj.ctx.sockets.push(ws);
  const c = obj.connFor(ws);
  obj.core.attach(c, null);
  obj.keep(ws, c);
  await obj.ensureAlarm();
  return c;
}

/** An object with an owner socket and a requester socket, at T0 on a mocked clock (set again to T0 each time it is called in one test). */
async function pairedObject(t) {
  if (!clocked.has(t)) { t.mock.timers.enable({ apis: ['Date'], now: T0 }); clocked.add(t); } else t.mock.timers.setTime(T0);
  const storage = fakeStorage();
  const owner = fakeWs('owner');
  const req = fakeWs('req');
  const ctx = fakeCtx([], storage);
  const obj = new Rendezvous(ctx, ENV);
  await obj.ready;
  await join(obj, owner);
  await join(obj, req);
  return { storage, owner, req, ctx, obj };
}

test('the object: a pairing code lives in storage and on its socket, a knock on the requester socket, a lane in storage; nothing about a knock is written to a row', async (t) => {
  const { storage, owner, req, ctx, obj } = await pairedObject(t);
  await obj.webSocketMessage(owner, frame({ action: 'pair-open', channel: 'abcd', box: BOX, rid: 'o' }));
  assert.deepEqual(take(owner), [{ action: 'pair-open', channel: 'abcd', rid: 'o' }]);
  assert.deepEqual(Array.from(storage.rows), [['chan:abcd', { kind: 'pair', box: BOX, lane: null, exp: T0 + CHANNEL_TTL_MS }]]);
  assert.deepEqual(owner.attachment, { k: 'pair', c: [['abcd', 'pair']], q: [], t: T0 / 1000 });

  await obj.webSocketMessage(req, frame({ action: 'pair-knock', channel: 'abcd', box: { iv: 'C'.repeat(16), ct: 'D'.repeat(100) }, rid: 'k' }));
  const knock = take(req)[0].knock;
  const request = take(owner)[0];
  assert.deepEqual(Object.keys(request), ['action', 'knock', 'channel', 'box']);
  assert.equal(request.knock, knock);
  assert.deepEqual(req.attachment, { k: 'pair', c: [], q: [[knock, 'abcd', T0 / 1000, 'pair']], t: T0 / 1000 }, 'the pending knock rides on the requester socket');
  assert.deepEqual(Array.from(storage.rows.keys()), ['chan:abcd'], 'no row for a knock');
  assert.ok(JSON.stringify(req.attachment).length < 2048 && JSON.stringify(owner.attachment).length < 2048);
  assert.equal(ctx.alarmAt(), T0 + 5 * MIN, 'the sweep alarm is the next thing to run');

  // before the owner accepts there is no lane, so no offer can move
  const stranger = fakeWs('stranger');
  await join(obj, stranger);
  await obj.webSocketMessage(stranger, announce('9'.repeat(40), peer('s')));
  assert.match(take(stranger)[0]['failure reason'], /not allowed/);

  await obj.webSocketMessage(owner, frame({ action: 'pair-accept', proof: PROOF, knock, rid: 'a' }));
  const accepted = take(owner)[0];
  const got = take(req)[0];
  assert.match(accepted.lane, /^[0-9a-f]{40}$/);
  assert.deepEqual(accepted, { action: 'pair-accepted', knock, lane: accepted.lane, rid: 'a' });
  assert.deepEqual(got, { action: 'pair-accepted', knock, lane: accepted.lane, channel: 'abcd', box: BOX, proof: PROOF });
  assert.deepEqual(storage.rows.get('lane:' + accepted.lane), T0 + LANE_TTL_MS, 'the lane is allowed for 24 hours, durably');
  assert.deepEqual(req.attachment.q, [], 'the requester socket forgot the knock: the object rewrote its attachment although it sent nothing');
  assert.deepEqual(noRelay(await (await obj.fetch(new Request('https://rtc.example/stats.json'))).json()), {
    open: false, uploads: false, allowed: 2, swarms: 0, unlisted: 0, peers: 0, sockets: 3, interval: 60, codes: 1, knocks: 0, lanes: 1,
  });

  // the lane is served now, to anybody who announces it (the rendezvous cannot tell them from the pair)
  await obj.webSocketMessage(stranger, announce(accepted.lane, peer('s')));
  assert.equal(take(stranger)[0]['failure reason'], undefined);
});

test('the object: a wake loses nothing; a knock made before it can be accepted after it, and the lane survives another wake', async (t) => {
  const { storage, owner, req, obj } = await pairedObject(t);
  await obj.webSocketMessage(owner, frame({ action: 'pair-open', channel: 'abcd', box: BOX }));
  await obj.webSocketMessage(req, frame({ action: 'pair-knock', channel: 'abcd', box: BOX }));
  const knock = take(req)[0].knock;
  take(owner);
  // the object sleeps (nobody reads the request for a while) and is rebuilt from the rows and the attachments
  t.mock.timers.tick(45 * 1000);
  const woken = new Rendezvous(fakeCtx([owner, req], storage), ENV);
  await woken.ready;
  const st = woken.core.stats();
  assert.deepEqual([st.sockets, st.codes, st.knocks, st.lanes], [2, 1, 1, 0]);
  assert.deepEqual([take(owner), take(req)], [[], []], 'nothing to tell anybody');
  await woken.webSocketMessage(owner, frame({ action: 'pair-accept', proof: PROOF, knock }));
  const lane = take(owner)[0].lane;
  assert.equal(take(req)[0].lane, lane, 'the requester gets the lane of a knock the first object made');
  assert.deepEqual(req.attachment.q, []);

  // a second wake: the lane is loaded before the first event, so a tracker socket can announce it at once
  const tracker = fakeWs('tracker');
  const again = new Rendezvous(fakeCtx([owner, req, tracker], storage), ENV);
  await again.ready;
  const st2 = again.core.stats();
  assert.deepEqual([st2.lanes, st2.codes], [1, 1], 'the owner socket claimed its code back');
  again.core.attach(again.connFor(tracker), null);
  await again.webSocketMessage(tracker, announce(lane, peer('t')));
  assert.equal(take(tracker)[0]['failure reason'], undefined);
  assert.deepEqual(tracker.attachment.s, [[lane, 1]]);
  // a tracker socket restored with a lane swarm in its attachment goes back into it
  const fourth = new Rendezvous(fakeCtx([owner, req, tracker], storage), ENV);
  await fourth.ready;
  const st4 = fourth.core.stats();
  assert.deepEqual([st4.swarms, st4.peers], [1, 1]);
});

test('the object: if the owner socket is gone when the object wakes, its code is released and the requester is told; closes on either side are answered', async (t) => {
  const { storage, owner, req, obj } = await pairedObject(t);
  await obj.webSocketMessage(owner, frame({ action: 'pair-open', channel: 'abcd', box: BOX }));
  await obj.webSocketMessage(req, frame({ action: 'pair-knock', channel: 'abcd', box: BOX }));
  const knock = take(req)[0].knock;
  take(owner);
  assert.equal(storage.rows.has('chan:abcd'), true);
  t.mock.timers.tick(30 * 1000);
  const woken = new Rendezvous(fakeCtx([req], storage), ENV);
  await woken.ready;
  assert.deepEqual(take(req), [{ action: 'pair-rejected', knock, reason: 'gone' }]);
  assert.equal(storage.rows.has('chan:abcd'), false, 'the row of a code nobody owns is deleted');
  assert.deepEqual(req.attachment.q, [], 'and the requester forgets its knock');
  assert.equal(woken.core.stats().codes, 0);

  // the same, with both sockets alive: the owner closes
  const second = await pairedObject(t);
  await second.obj.webSocketMessage(second.owner, frame({ action: 'pair-open', channel: 'wxyz', box: BOX }));
  await second.obj.webSocketMessage(second.req, frame({ action: 'pair-knock', channel: 'wxyz', box: BOX }));
  const k2 = take(second.req)[0].knock;
  await second.obj.webSocketClose(second.owner);
  assert.deepEqual(take(second.req), [{ action: 'pair-rejected', knock: k2, reason: 'gone' }]);
  assert.equal(second.storage.rows.size, 0);
  assert.deepEqual(second.req.attachment.q, []);

  // and the other way round: the requester goes, the owner is told to drop the request
  const third = await pairedObject(t);
  await third.obj.webSocketMessage(third.owner, frame({ action: 'pair-open', channel: 'qrst', box: BOX }));
  await third.obj.webSocketMessage(third.req, frame({ action: 'pair-knock', channel: 'qrst', box: BOX }));
  const k3 = take(third.req)[0].knock;
  take(third.owner);
  await third.obj.webSocketError(third.req);
  assert.deepEqual(take(third.owner), [{ action: 'pair-request', knock: k3, channel: 'qrst', box: BOX }, { action: 'pair-cancelled', knock: k3 }].slice(1));
  assert.equal(third.obj.core.stats().knocks, 0);
});

test('the object: a pair message pulls a far alarm forward; the alarm expires knocks at 10 minutes, codes and lanes at 24 hours, and leaves a socket that owns a code alone', async (t) => {
  const { storage, owner, req, ctx, obj } = await pairedObject(t);
  await obj.webSocketMessage(owner, frame({ action: 'pair-open', channel: 'abcd', box: BOX }));
  await obj.webSocketMessage(req, frame({ action: 'pair-knock', channel: 'abcd', box: BOX }));
  const k1 = take(req)[0].knock;
  const tracker = fakeWs('tracker');
  await join(obj, tracker);
  await obj.webSocketMessage(tracker, announce(A, peer('t')));
  take(owner);
  // an alarm set far away is pulled forward by the next pair message (the sweep is every 5 minutes)
  await ctx.storage.setAlarm(T0 + 180 * MIN);
  const req2 = fakeWs('req2');
  await join(obj, req2);
  await obj.webSocketMessage(req2, frame({ action: 'pair-knock', channel: 'abcd', box: BOX }));
  const k2 = take(req2)[0].knock;
  take(owner);
  assert.equal(ctx.alarmAt(), T0 + 5 * MIN);
  // at 3 minutes: nothing ran out; the next alarm is 5 minutes on
  t.mock.timers.tick(3 * MIN);
  await obj.alarm();
  assert.equal(ctx.alarmAt(), T0 + 8 * MIN);
  // at 8 minutes: the knocks run out at 10, sooner than the next sweep period, so the alarm is set for them
  t.mock.timers.tick(5 * MIN);
  await obj.alarm();
  assert.equal(ctx.alarmAt(), T0 + KNOCK_TTL_MS, 'pulled forward to the first knock to run out');
  assert.deepEqual([take(req), take(req2), take(owner)], [[], [], []]);
  t.mock.timers.tick(2 * MIN);
  await obj.alarm();
  assert.deepEqual(take(req), [{ action: 'pair-rejected', knock: k1, reason: 'expired' }]);
  assert.deepEqual(take(req2), [{ action: 'pair-rejected', knock: k2, reason: 'expired' }]);
  assert.deepEqual(take(owner).map((m) => m.action), ['pair-cancelled', 'pair-cancelled']);
  assert.deepEqual([req.attachment.q, req2.attachment.q], [[], []]);
  assert.deepEqual([tracker.closed, req.closed], [null, null], 'nobody is idle after 10 minutes');

  // 25 more minutes of silence: every socket without a code is idle, the socket that owns a code is left alone
  t.mock.timers.tick(25 * MIN);
  await obj.alarm();
  assert.deepEqual(tracker.closed, { code: 1001, reason: 'idle' });
  assert.deepEqual(req.closed, { code: 1001, reason: 'idle' });
  assert.equal(owner.closed, null, 'its code is open, so it may sit there');

  // a lane lasts 24 hours and so does the code: then the alarm deletes the rows and tells the owner
  const req3 = fakeWs('req3');
  await join(obj, req3);
  await obj.webSocketMessage(req3, frame({ action: 'pair-knock', channel: 'abcd', box: BOX }));
  const k3 = take(req3)[0].knock;
  take(owner);
  await obj.webSocketMessage(owner, frame({ action: 'pair-accept', proof: PROOF, knock: k3 }));
  const lane = take(owner)[0].lane;
  take(req3);
  assert.equal(storage.rows.has('lane:' + lane), true);
  const laneExp = storage.rows.get('lane:' + lane);
  assert.equal(laneExp, T0 + 35 * MIN + LANE_TTL_MS, 'minted at minute 35, so it outlives the code (opened at minute 0) by 35 minutes');
  t.mock.timers.setTime(T0 + CHANNEL_TTL_MS + MIN);
  await obj.alarm();
  assert.equal(storage.rows.has('chan:abcd'), false, 'the code row is deleted when the code runs out');
  assert.equal(storage.rows.has('lane:' + lane), true, 'the lane is allowed until its own expiry');
  assert.deepEqual(take(owner), [{ action: 'pair-close', channel: 'abcd', reason: 'expired' }]);
  assert.deepEqual(owner.closed, { code: 1001, reason: 'idle' }, 'it holds no code now and was silent for a day: idle like any socket, in the same sweep');
  const mid = obj.core.stats();
  assert.deepEqual([mid.lanes, mid.codes], [1, 0]);
  t.mock.timers.setTime(laneExp + 1000);
  await obj.alarm();
  assert.equal(storage.rows.has('lane:' + lane), false, 'the lane row is deleted when the lane runs out');
  assert.equal(storage.rows.size, 0);
  assert.equal(obj.core.stats().lanes, 0);
});

test('the object: a woken object drops what ran out while it slept; a frame of the other protocol is refused; PAIRING=0 turns the protocol off', async (t) => {
  const { storage, owner, req, obj } = await pairedObject(t);
  await obj.webSocketMessage(owner, frame({ action: 'pair-open', channel: 'abcd', box: BOX }));
  await obj.webSocketMessage(req, frame({ action: 'pair-knock', channel: 'abcd', box: BOX }));
  const knock = take(req)[0].knock;
  await obj.webSocketMessage(owner, frame({ action: 'pair-accept', proof: PROOF, knock }));
  const lane = take(owner).pop().lane;
  take(owner);
  // the object sleeps for more than a day; woken, it drops the lane, releases the code (the owner is told) and answers nothing else
  t.mock.timers.tick(CHANNEL_TTL_MS + 5000);
  const woken = new Rendezvous(fakeCtx([owner, req], storage), ENV);
  await woken.ready;
  assert.equal(storage.rows.has('lane:' + lane), false);
  assert.equal(storage.rows.has('chan:abcd'), false);
  assert.deepEqual(take(owner), [{ action: 'pair-close', channel: 'abcd', reason: 'expired' }]);
  assert.equal(woken.core.stats().lanes, 0);

  // the other protocol on a classified socket
  const mixed = fakeWs('mixed');
  await join(woken, mixed);
  await woken.webSocketMessage(mixed, announce(A, peer('m')));
  take(mixed);
  await woken.webSocketMessage(mixed, frame({ action: 'pair-open', channel: 'wxyz', box: BOX }));
  assert.deepEqual(take(mixed), [{ action: 'pair-open', 'failure reason': MIXED }]);
  assert.equal(storage.rows.size, 0);

  // PAIRING=0, with the rows an earlier deployment left: the rows of codes are deleted, a lane stays allowed until it expires
  const leftover = 'c'.repeat(40);
  const offStorage = fakeStorage(new Map([['chan:abcd', { kind: 'pair', box: BOX, lane: null, exp: Date.now() + 1000000 }], ['lane:' + leftover, Date.now() + 1000000]]));
  const off = new Rendezvous(fakeCtx([], offStorage), Object.assign({}, ENV, { PAIRING: '0' }));
  await off.ready;
  assert.deepEqual(Array.from(offStorage.rows.keys()), ['lane:' + leftover]);
  assert.equal(off.core.stats().lanes, 1);
  const lw = fakeWs('lw');
  await join(off, lw);
  await off.webSocketMessage(lw, announce(leftover, peer('l')));
  assert.equal(take(lw)[0]['failure reason'], undefined, 'a lane minted before the switch is still served');
  const w = fakeWs('w');
  await join(off, w);
  await off.webSocketMessage(w, frame({ action: 'pair-open', channel: 'abcd', box: BOX, rid: 'r' }));
  assert.deepEqual(take(w), [{ action: 'pair-open', rid: 'r', 'failure reason': 'pairing is off on this rendezvous' }]);
  await off.webSocketMessage(w, announce(A, peer('w')));
  assert.equal(take(w)[0]['failure reason'], undefined, 'the tracker works');
  const asked = coreFromEnv({ ALLOW: A, PAIRING: '0' });
  assert.equal(asked.message(conn('c'), frame({ action: 'pair-open', channel: 'abcd', box: BOX })).problem, 'pairing is off on this rendezvous');
  assert.equal(coreFromEnv({ ALLOW: A }).message(conn('d'), frame({ action: 'pair-open', channel: 'abcd', box: BOX })).problem, null, 'on by default');
});

test('rtc-worker lane (2026-11-01): an answer keeps a seeder complete, a bare scrape lists nothing, event "empty" is an update, and the saved time is refreshed so a sweep after a wake keeps a live socket', async () => {
  let clock = 1800000000000;
  const r = createRendezvous({ allow: new Set([A]), now: () => clock });
  const a = conn('a');
  const b = conn('b');
  r.message(a, announce(A, peer('a')));
  r.message(b, announce(A, peer('b'), { left: 100, offers: [offer(1)] }));
  assert.equal(a.last().offer_id, 'o1');
  // a answers the way the loader's client does: no left, no event
  const res = r.message(a, JSON.stringify({ action: 'announce', info_hash: bin(A), peer_id: peer('a'), to_peer_id: peer('b'), answer: { type: 'answer', sdp: 'v=0 answer' }, offer_id: 'o1' }));
  assert.equal(res.changed, false, 'an answer moves no state');
  r.message(a, JSON.stringify({ action: 'scrape', info_hash: bin(A) }));
  assert.deepEqual(a.last().files[bin(A)], { complete: 1, incomplete: 1, downloaded: 1 }, 'the seeder stays a seeder in the counts');
  r.message(a, announce(A, peer('a'), { left: 7, event: 'update' }));
  r.message(a, JSON.stringify({ action: 'scrape', info_hash: bin(A) }));
  assert.equal(a.last().files[bin(A)].complete, 1, 'bittorrent-tracker never demotes a peer, nor does this');
  r.message(a, JSON.stringify({ action: 'scrape' }));
  assert.deepEqual(a.last(), { action: 'scrape', files: {}, flags: { min_request_interval: INTERVAL_S } }, 'a bare scrape lists no swarm');
  r.message(b, announce(A, peer('b'), { left: 100, event: 'empty' }));
  assert.equal(b.last()['failure reason'], undefined, 'event "empty" is an update');
  assert.equal(b.last().incomplete, 1);
  // the saved time: the core reports membership changes only, so a message that moves no swarm is no change however late it comes;
  // when the saved time is written again is the object's rule (worker.js, ATTACHMENT_REFRESH_S), checked on the fake platform below
  const saved = r.attachmentOf(a);
  assert.equal(saved.t, Math.floor(clock / 1000));
  clock += ATTACHMENT_REFRESH_S * 1000;
  assert.equal(r.message(a, announce(A, peer('a'), { event: 'update' })).changed, false, 'no swarm moved: nothing for the core to report');
  assert.equal(r.attachmentOf(a).t, Math.floor(clock / 1000), 'and the time it would save is the current one');
  // the fake platform: a periodic announce 19 minutes after the join refreshes the attachment, and an object rebuilt from it two
  // minutes later keeps the socket (before the fix its sweep closed it: the attachment still carried the join time)
  const realNow = Date.now;
  try {
    let t = 1800000000000;
    Date.now = () => t;
    // the object's rule: a message that moves no swarm rewrites the attachment once its time is ATTACHMENT_REFRESH_S old, not
    // before, and not again right after
    const wu = fakeWs('u');
    const objU = new Rendezvous(fakeCtx([wu]), ENV);
    objU.core.attach(objU.connFor(wu), null);
    wu.serializeAttachment(objU.core.attachmentOf(objU.connFor(wu)));
    await objU.webSocketMessage(wu, announce(A, peer('u')));
    const joinedU = wu.attachment.t;
    t += (ATTACHMENT_REFRESH_S - 1) * 1000;
    await objU.webSocketMessage(wu, announce(A, peer('u'), { event: 'update' }));
    assert.equal(wu.attachment.t, joinedU, 'under the refresh period: nothing to save');
    t += 1000;
    await objU.webSocketMessage(wu, announce(A, peer('u'), { event: 'update' }));
    assert.equal(wu.attachment.t, joinedU + ATTACHMENT_REFRESH_S, 'at the refresh period: save it');
    t += 1000;
    await objU.webSocketMessage(wu, announce(A, peer('u'), { event: 'update' }));
    assert.equal(wu.attachment.t, joinedU + ATTACHMENT_REFRESH_S, 'just saved');
    const ws = fakeWs('v');
    const ctx = fakeCtx([ws]);
    const obj = new Rendezvous(ctx, ENV);
    obj.core.attach(obj.connFor(ws), null);
    ws.serializeAttachment(obj.core.attachmentOf(obj.connFor(ws)));
    await obj.webSocketMessage(ws, announce(A, peer('v')));
    const joined = ws.attachment.t;
    t += 19 * 60 * 1000;
    await obj.webSocketMessage(ws, announce(A, peer('v'), { event: 'update' }));
    assert.equal(ws.attachment.t, joined + 19 * 60, 'the periodic announce refreshed the saved time');
    t += 2 * 60 * 1000;
    const woke = new Rendezvous(fakeCtx([ws]), ENV);
    await woke.alarm();
    assert.equal(ws.closed, null, 'the rebuilt object keeps a socket that announced two minutes ago');
    assert.equal(woke.core.stats().peers, 1);
    t += PEER_TTL_S * 1000 + 1000;
    await woke.alarm();
    assert.deepEqual(ws.closed, { code: 1001, reason: 'idle' }, 'and still closes one that went silent');
  } finally {
    Date.now = realNow;
  }
});

// ---------------------------------------------------------------------------------------------- the relay lane through the object

const PING = '{"v":1,"action":"pair-ping"}';
const PONG = { action: 'pair-pong' };
const laneHex = (i) => i.toString(16).padStart(2, '0').repeat(20);

/** acceptedLane(obj, owner, req): the owner opens a code, the requester knocks, the owner accepts; the lane the accept minted. */
async function acceptedLane(obj, owner, req) {
  await obj.webSocketMessage(owner, frame({ action: 'pair-open', channel: 'abcd', box: BOX }));
  await obj.webSocketMessage(req, frame({ action: 'pair-knock', channel: 'abcd', box: BOX }));
  const knock = take(req)[0].knock;
  take(owner);
  await obj.webSocketMessage(owner, frame({ action: 'pair-accept', proof: PROOF, knock }));
  const lane = take(owner)[0].lane;
  take(req);
  return lane;
}

test('RELAY_LANE: "0" turns every join and relay off, anything else (absent too) leaves it on; the pairing is not touched', () => {
  const probe = (env) => {
    const core = coreFromEnv(env);
    const c = conn('p');
    const res = core.message(c, frame({ action: 'pair-join', lane: laneHex(1), rid: 'j' }));
    return [res.problem, core.message(c, frame({ action: 'pair-open', channel: 'abcd', box: BOX })).problem];
  };
  assert.deepEqual(probe(ENV), ['unknown lane', null], 'absent: the relay is on (it found no such lane)');
  assert.deepEqual(probe(Object.assign({}, ENV, { RELAY_LANE: '1' })), ['unknown lane', null]);
  for (const other of ['', 'yes', 'true', ' 0', '00']) assert.deepEqual(probe(Object.assign({}, ENV, { RELAY_LANE: other })), ['unknown lane', null], JSON.stringify(other) + ' is not "0"');
  assert.deepEqual(probe(Object.assign({}, ENV, { RELAY_LANE: '0' })), ['relay is off on this rendezvous', null], '"0": off, and pairing still opens a code');
  assert.deepEqual(probe(Object.assign({}, ENV, { RELAY_LANE: '0', PAIRING: '0' }))[1], 'pairing is off on this rendezvous');
});

test('the object asks the platform to answer the keepalive ping itself: the exact texts, once per object; pings never wake it, any other text does', async () => {
  const ctx = fakeCtx();
  const given = [];
  const set = ctx.setWebSocketAutoResponse;
  ctx.setWebSocketAutoResponse = function (pair) { given.push(pair); return set.call(this, pair); };
  const obj = new Rendezvous(ctx, ENV);
  await obj.ready;
  assert.equal(given.length, 1, 'once per object');
  assert.ok(given[0] instanceof globalThis.WebSocketRequestResponsePair);
  assert.equal(given[0].request, '{"v":1,"action":"pair-ping"}');
  assert.equal(given[0].response, '{"action":"pair-pong"}');
  const ws = fakeWs('c');
  await join(obj, ws);
  for (let i = 0; i < 1000; i++) assert.equal(await ctx.deliver(obj, ws, PING), false);
  assert.equal(ctx.wakes, 0, 'a thousand pings woke the object 0 times');
  assert.equal(ws.sent.length, 1000);
  assert.deepEqual(ws.sent[999], PONG);
  assert.equal(ws.sent.every((m) => m.action === 'pair-pong' && Object.keys(m).length === 1), true, 'a pong carries nothing');
  ws.sent.length = 0;
  // a ping with a space in it is not the pair the platform holds: it wakes the object, and the core answers it all the same
  assert.equal(await ctx.deliver(obj, ws, '{"v":1, "action":"pair-ping"}'), true);
  assert.equal(ctx.wakes, 1);
  assert.deepEqual(ws.sent, [PONG]);
  // a platform (or a fake) without the API still runs: the ping reaches the core
  const bare = { sockets: [], accepted: [], storage: fakeStorage(), getWebSockets: () => bare.sockets.slice(), acceptWebSocket(w) { bare.sockets.push(w); }, blockConcurrencyWhile: (fn) => Promise.resolve().then(fn) };
  const plain = new Rendezvous(bare, ENV);
  await plain.ready;
  const w2 = fakeWs('w2');
  await join(plain, w2);
  await plain.webSocketMessage(w2, PING);
  assert.deepEqual(w2.sent, [PONG]);
  await plain.alarm();
  assert.equal(w2.closed, null);
});

test('the object: two sockets join the lane the accept minted and pass a sealed frame; membership rides on the attachments and survives a wake; the relay writes nothing to storage', async (t) => {
  const { storage, owner, req, obj } = await pairedObject(t);
  const lane = await acceptedLane(obj, owner, req);
  const rows = JSON.stringify(Array.from(storage.rows));
  await obj.webSocketMessage(owner, frame({ action: 'pair-join', lane, rid: 'j1' }));
  assert.deepEqual(take(owner), [{ action: 'pair-join', lane, peers: 0, rid: 'j1' }]);
  assert.deepEqual(owner.attachment.l, [[lane, 'pair']], 'the lane is on the socket');
  await obj.webSocketMessage(req, frame({ action: 'pair-join', lane, rid: 'j2' }));
  assert.deepEqual(take(req), [{ action: 'pair-join', lane, peers: 1, rid: 'j2' }]);
  assert.deepEqual(take(owner), [{ action: 'pair-joined', lane, peers: 1 }]);
  assert.deepEqual(req.attachment.l, [[lane, 'pair']]);
  const f = 'Zm9v-_' + 'A'.repeat(200);
  await obj.webSocketMessage(owner, frame({ action: 'pair-relay', lane, f, rid: 'r1' }));
  assert.deepEqual(take(req), [{ action: 'pair-relayed', lane, f }]);
  assert.deepEqual(take(owner), [{ action: 'pair-relay', lane, peers: 1, rid: 'r1' }]);
  assert.equal(JSON.stringify(Array.from(storage.rows)), rows, 'storage is what the accept left: no row for a join, a frame or a lane member');
  assert.ok(JSON.stringify(owner.attachment).length < 2048 && JSON.stringify(req.attachment).length < 2048);

  // the object sleeps and is rebuilt from the rows and the attachments: both sockets are members again without joining
  t.mock.timers.tick(45 * 1000);
  const woken = new Rendezvous(fakeCtx([owner, req], storage), ENV);
  await woken.ready;
  assert.equal(woken.core.stats().relays, 1);
  assert.deepEqual([take(owner), take(req)], [[], []], 'a wake tells nobody anything');
  await woken.webSocketMessage(req, frame({ action: 'pair-relay', lane, f: 'abcd', rid: 'r2' }));
  assert.deepEqual(take(owner), [{ action: 'pair-relayed', lane, f: 'abcd' }]);
  assert.deepEqual(take(req), [{ action: 'pair-relay', lane, peers: 1, rid: 'r2' }]);
  // a socket that closes leaves the lane and the other is told, with the count of those who remain
  await woken.webSocketClose(req);
  assert.deepEqual(take(owner), [{ action: 'pair-left', lane, peers: 0 }]);
  await woken.webSocketMessage(owner, frame({ action: 'pair-leave', lane, rid: 'l' }));
  assert.deepEqual(take(owner), [{ action: 'pair-leave', lane, rid: 'l' }]);
  assert.equal('l' in owner.attachment, false, 'and its saved state shows no lane any more');
  assert.equal(woken.core.stats().relays, 0);
});

test('the object: a lane that ran out while it slept is dropped quietly at the wake, and a relay on it finds no lane', async (t) => {
  const { storage, owner, req, obj } = await pairedObject(t);
  const lane = await acceptedLane(obj, owner, req);
  await obj.webSocketMessage(owner, frame({ action: 'pair-join', lane }));
  await obj.webSocketMessage(req, frame({ action: 'pair-join', lane }));
  take(owner); take(req);
  assert.deepEqual(owner.attachment.l, [[lane, 'pair']]);
  t.mock.timers.tick(LANE_TTL_MS + 1000);
  const woken = new Rendezvous(fakeCtx([owner, req], storage), ENV);
  await woken.ready;
  assert.equal(woken.core.stats().relays, 0, 'the lane row ran out: nobody is a member of it');
  assert.equal('l' in owner.attachment, false, 'the wake rewrote the saved state without the lane');
  assert.equal('l' in req.attachment, false);
  await woken.webSocketMessage(owner, frame({ action: 'pair-relay', lane, f: 'abcd', rid: 'x' }));
  assert.equal(take(owner).pop()['failure reason'], 'unknown lane');
});

test('the object: join, relay and leave leave the alarm alone; the frames that open a code or a knock still move it', async (t) => {
  const { storage, owner, req, ctx, obj } = await pairedObject(t);
  const lane = await acceptedLane(obj, owner, req);
  const calls = { get: 0, set: 0 };
  const getAlarm = storage.getAlarm;
  const setAlarm = storage.setAlarm;
  storage.getAlarm = async function () { calls.get++; return getAlarm.call(this); };
  storage.setAlarm = async function (at) { calls.set++; return setAlarm.call(this, at); };
  const before = ctx.alarmAt();
  assert.ok(before > 0);
  await obj.webSocketMessage(owner, frame({ action: 'pair-join', lane }));
  await obj.webSocketMessage(req, frame({ action: 'pair-join', lane }));
  for (let i = 0; i < 5; i++) await obj.webSocketMessage(owner, frame({ action: 'pair-relay', lane, f: 'abcd', rid: 'r' + i }));
  await obj.webSocketMessage(req, frame({ action: 'pair-leave', lane }));
  await obj.webSocketMessage(owner, frame({ action: 'pair-leave', lane }));
  assert.deepEqual(calls, { get: 0, set: 0 }, 'no alarm read and none written for the relay frames');
  assert.equal(ctx.alarmAt(), before);
  await obj.webSocketMessage(req, frame({ action: 'pair-knock', channel: 'abcd', box: BOX }));
  assert.ok(calls.get >= 1, 'a knock still looks at the alarm');
});

test('the object: the sweep keeps a socket that only pings (answered by the platform) and closes one that went silent at 20 minutes, with or without a wake in between', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const storage = fakeStorage();
  const owner = fakeWs('owner');
  const x = fakeWs('pinger');
  const y = fakeWs('silent');
  const ctx = fakeCtx([], storage);
  const obj = new Rendezvous(ctx, ENV);
  await obj.ready;
  await join(obj, owner);
  await join(obj, x);
  await join(obj, y);
  await obj.webSocketMessage(owner, frame({ action: 'room-open', channel: 'rm22', box: BOX }));
  const lane = take(owner)[0].lane;
  for (const s of [owner, x, y]) { await obj.webSocketMessage(s, frame({ action: 'room-join', lane })); take(s); }
  take(owner);
  assert.deepEqual(x.attachment.l, [[lane, 'room']]);
  // 19 minutes: x pings every minute, y says nothing; the sweep runs and closes neither
  for (let i = 0; i < 19; i++) { t.mock.timers.tick(60 * 1000); await ctx.deliver(obj, x, PING); }
  assert.equal(ctx.wakes, 0, 'no ping woke the object');
  assert.equal(x.attachment.t, T0 / 1000, 'and none rewrote the saved time: the platform answered them alone');
  await obj.alarm();
  assert.deepEqual([x.closed, y.closed], [null, null], '19 minutes: nobody is idle yet');
  // 22 minutes: y has been silent for more than 20 and x pinged a minute ago
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(60 * 1000); await ctx.deliver(obj, x, PING); }
  // the object is rebuilt first (a wake, a deployment): the saved times are old, the platform's answers are not
  const woken = new Rendezvous(fakeCtx([owner, x, y], storage), ENV);
  woken.ctx.autoResponse = ctx.autoResponse;
  await woken.ready;
  await woken.alarm();
  assert.equal(x.closed, null, 'the socket that pinged a minute ago is alive although its saved time is 22 minutes old');
  assert.deepEqual(y.closed, { code: 1001, reason: 'idle' }, 'the silent one is closed');
  assert.deepEqual(take(owner).pop(), { action: 'room-left', lane, peers: 1 }, 'and the others are told it left (the owner and the pinger remain)');
  assert.deepEqual(take(x).pop(), { action: 'room-left', lane, peers: 1 });
  assert.equal(owner.closed, null, 'the owner of a code is never idle while the code lives');
  // the same object, no wake: a pinger is kept and a silent one closed
  const same = new Rendezvous(fakeCtx([owner, x], storage), ENV);
  await same.ready;
  t.mock.timers.tick(PEER_TTL_S * 1000 + 1000);
  await same.alarm();
  assert.deepEqual(x.closed, { code: 1001, reason: 'idle' }, 'a socket that stopped pinging is idle 20 minutes later like any other');
});

test('the object: the 151st message of a minute gets its reason, the socket is closed with 1008 and released, and the others are told it left', async (t) => {
  const { storage, owner, req, obj } = await pairedObject(t);
  const lane = await acceptedLane(obj, owner, req);
  await obj.webSocketMessage(owner, frame({ action: 'pair-join', lane }));
  await obj.webSocketMessage(req, frame({ action: 'pair-join', lane }));
  take(owner); take(req);
  // owner has sent 4 messages (open, accept, join, ...); stay under with idempotent joins, then go over
  for (let i = 0; i < 140; i++) await obj.webSocketMessage(owner, frame({ action: 'pair-join', lane }));
  take(owner); take(req);
  assert.equal(owner.closed, null);
  let over = 0;
  while (owner.closed === null && over < 20) { await obj.webSocketMessage(owner, frame({ action: 'pair-join', lane, rid: 'z' })); over++; }
  assert.deepEqual(owner.closed, { code: 1008, reason: 'too many messages' });
  assert.ok(over >= 1 && over <= 10, 'closed within a few messages of the cap: ' + over);
  assert.equal(take(owner).pop()['failure reason'], 'too many messages', 'the last thing it was sent is why');
  assert.deepEqual(take(req), [{ action: 'pair-left', lane, peers: 0 }]);
  assert.equal(obj.core.stats().sockets, 1, 'the core released it');
  assert.equal(storage.rows.has('chan:abcd'), false, 'and so did its code');
});

test('worker fetch: the object is handed a fresh request with only the upgrade headers; a stats request carries no header and no token', async () => {
  const seen = [];
  const env = Object.assign({}, ENV, { RTC: { idFromName: (n) => n, get: () => ({ fetch: async (req) => { seen.push(req); return new Response('from the object'); } }) } });
  const sender = {
    Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Protocol': 'mw', 'Sec-WebSocket-Extensions': 'permessage-deflate',
    Origin: 'https://door.example', Referer: 'https://door.example/page', 'User-Agent': 'x', 'CF-Connecting-IP': 'client-address', 'X-Forwarded-For': 'client-address', 'X-Real-IP': 'client-address',
    Cookie: 'a=b', 'Accept-Language': 'fr', 'Sec-Fetch-Site': 'cross-site', Authorization: 'x',
  };
  await worker.fetch(new Request('https://rtc.example/?x=1', { headers: sender }), env);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://rtc.example/', 'the path only: no query');
  assert.deepEqual(Array.from(seen[0].headers.keys()).sort(), ['connection', 'sec-websocket-extensions', 'sec-websocket-key', 'sec-websocket-protocol', 'sec-websocket-version', 'upgrade']);
  assert.equal(seen[0].headers.get('upgrade'), 'websocket');
  assert.equal(seen[0].method, 'GET');
  await worker.fetch(new Request('https://rtc.example/stats.json?token=s3cret', { headers: sender }), env);
  assert.equal(seen[1].url, 'https://rtc.example/stats.json', 'the token stays in the Worker');
  assert.deepEqual(Array.from(seen[1].headers.keys()), [], 'and no header of the caller reaches the object');
  // only the headers that were there are passed; a request without the optional ones passes the ones it has
  await worker.fetch(new Request('https://rtc.example/', { headers: { Upgrade: 'websocket', Origin: 'https://door.example' } }), env);
  assert.deepEqual(Array.from(seen[2].headers.keys()), ['upgrade']);
  // a request that is not an upgrade, or a path that is not served, never reaches the object
  await worker.fetch(new Request('https://rtc.example/', { headers: sender }).clone(), Object.assign({}, env, { RTC: null })).catch(() => {});
  assert.equal(seen.length, 3);
});

test('worker fetch: the headers are read by name, one at a time, and request.cf is never touched', async () => {
  const read = new Set();
  const props = new Set();
  const env = Object.assign({}, ENV, { RTC: { idFromName: (n) => n, get: () => ({ fetch: async () => new Response('from the object') }) } });
  const spy = (target) => new Proxy(target, {
    get(t, prop) {
      if (prop === 'headers') return { get: (n) => { read.add(String(n).toLowerCase()); return t.headers.get(n); }, has: (n) => { read.add(String(n).toLowerCase()); return t.headers.has(n); } };
      props.add(String(prop));
      const v = Reflect.get(t, prop, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  const sender = { Upgrade: 'websocket', Origin: 'https://door.example', Referer: 'https://door.example/', 'User-Agent': 'x', 'CF-Connecting-IP': 'client-address', 'X-Forwarded-For': 'client-address' };
  for (const path of ['/', '/healthz', '/stats.json?token=s3cret', '/nothing']) await worker.fetch(spy(new Request('https://rtc.example' + path, { headers: sender })), env);
  const allowed = new Set(['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']);
  assert.deepEqual(Array.from(read).filter((n) => !allowed.has(n)), [], 'headers read: ' + Array.from(read).join(', '));
  assert.ok(read.has('upgrade'));
  for (const prop of ['cf', 'signal', 'referrer', 'mode', 'credentials', 'integrity', 'body']) assert.equal(props.has(prop), false, prop);
});

test('/stats.json of the object carries the seven relay fields: counts and a UTC day, no lane and no frame', async (t) => {
  const { owner, req, obj } = await pairedObject(t);
  const lane = await acceptedLane(obj, owner, req);
  await obj.webSocketMessage(owner, frame({ action: 'pair-join', lane }));
  await obj.webSocketMessage(req, frame({ action: 'pair-join', lane }));
  const f = 'QUJD' + 'x'.repeat(96);
  await obj.webSocketMessage(owner, frame({ action: 'pair-relay', lane, f }));
  await obj.webSocketMessage(req, frame({ action: 'pair-relay', lane, f }));
  const st = await (await obj.fetch(new Request('https://rtc.example/stats.json'))).json();
  assert.deepEqual(Object.fromEntries(RELAY_FIELDS.map((k) => [k, st[k]])), { relays: 1, relayed: 2, relayBytes: 200, relayDay: 20231114, relayBusy: 0, relayRate: 0, joinsRefused: 0 });
  assert.equal(JSON.stringify(st).includes(lane), false);
  assert.equal(JSON.stringify(st).includes('QUJD'), false);
  assert.deepEqual(Object.keys(st).sort(), ['allowed', 'codes', 'interval', 'joinsRefused', 'knocks', 'lanes', 'open', 'peers', 'relayBusy', 'relayBytes', 'relayDay', 'relayRate', 'relayed', 'relays', 'sockets', 'swarms', 'unlisted', 'uploads']);
});

test('wrangler.jsonc: observability is off, RELAY_LANE is "1", no token and no hash in the file, and the header says how to deploy behind a Pages front', () => {
  const raw = readFileSync(new URL('../../deploy/rtc-worker/wrangler.jsonc', import.meta.url), 'utf8');
  const json = JSON.parse(raw.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n'));
  assert.deepEqual(json.observability, { enabled: false }, 'the platform keeps no Workers Logs for this Worker (plan 3.7, D7)');
  assert.equal(json.vars.RELAY_LANE, '1');
  assert.equal(json.vars.PAIRING, '1');
  assert.equal(json.vars.STATS_TOKEN, '', 'a token never sits in the repository');
  assert.equal(json.vars.ALLOW, '', 'the live list is passed at deploy time (--var), not kept here');
  assert.equal(json.workers_dev, true, 'the repository file is the standalone form');
  assert.deepEqual(Object.keys(json.vars).sort(), ['ALLOW', 'INTERVAL_S', 'OPEN', 'PAIRING', 'RELAY_LANE', 'STATS_TOKEN', 'UPLOADS']);
  const header = raw.split('\n').slice(0, 12).join('\n');
  assert.ok(header.includes('--name <worker>-do') && header.includes('"workers_dev": false'), 'the header names the Pages-front form');
  assert.equal(/[A-Za-z0-9_-]{32,}/.test(raw.replace(/\/\/.*$/gm, '').replace(/"[^"]*"\s*:/g, '')), false, 'no long random-looking value');
});
