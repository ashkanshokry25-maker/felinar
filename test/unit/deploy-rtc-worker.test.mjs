// Unit tests for deploy/rtc-worker: the rendezvous core (rtc.js) through fake connections, and the Worker and Durable Object
// wrapper (worker.js) through a fake platform. Nothing here opens a socket; the protocol is bittorrent-tracker 11.2.3's, the
// one test/unit/tools-tracker.test.mjs drives against tools/tracker.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRendezvous, parseAllow, messageProblem, bin2hex, hex2bin, INTERVAL_S, MAX_OFFERS, MAX_SWARMS_PER_SOCKET, PEER_TTL_S, ATTACHMENT_REFRESH_S } from '../../deploy/rtc-worker/rtc.js';
import worker, { Rendezvous, coreFromEnv } from '../../deploy/rtc-worker/worker.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const bin = (hex) => Buffer.from(hex, 'hex').toString('binary');
const peer = (ch) => ch.repeat(20);

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
  assert.deepEqual(r.stats(), { open: false, uploads: false, allowed: 1, swarms: 1, unlisted: 0, peers: 2, sockets: 2, interval: INTERVAL_S });
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
  assert.deepEqual(u.stats(), { open: false, uploads: true, allowed: 1, swarms: 2, unlisted: 1, peers: 3, sockets: 2, interval: INTERVAL_S });
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
  return { name, sent: [], closed: null, attachment: null, send(t) { this.sent.push(JSON.parse(t)); }, close(code, reason) { this.closed = { code, reason }; }, serializeAttachment(v) { this.attachment = JSON.parse(JSON.stringify(v)); }, deserializeAttachment() { return this.attachment; } };
}
function fakeCtx(sockets = []) {
  let alarm = null;
  return { sockets, accepted: [], getWebSockets: () => sockets.slice(), acceptWebSocket(ws) { this.accepted.push(ws); sockets.push(ws); }, storage: { async getAlarm() { return alarm; }, async setAlarm(t) { alarm = t; } }, alarmAt: () => alarm };
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
  await obj3.alarm();
  assert.deepEqual(ws1.closed, { code: 1001, reason: 'idle' });
  assert.equal(ws3.closed, null);
  assert.equal(obj3.core.stats().sockets, 1);
  assert.ok(ctx3.alarmAt() > Date.now(), 'the next sweep is scheduled while sockets remain');
  const env2 = Object.assign({}, ENV, { ALLOW: 'uploads ' + A, INTERVAL_S: '5' });
  const core = coreFromEnv(env2);
  assert.deepEqual([core.stats().uploads, core.stats().allowed, core.stats().interval], [true, 1, INTERVAL_S], 'INTERVAL_S below 10 falls back to the default');
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
  // the saved time: a message that changes no membership counts as a change once the saved state is ATTACHMENT_REFRESH_S old
  const saved = r.attachmentOf(a);
  assert.equal(saved.t, Math.floor(clock / 1000));
  clock += (ATTACHMENT_REFRESH_S - 1) * 1000;
  assert.equal(r.message(a, announce(A, peer('a'), { event: 'update' })).changed, false, 'under the refresh period: nothing to save');
  clock += 1000;
  assert.equal(r.message(a, announce(A, peer('a'), { event: 'update' })).changed, true, 'at the refresh period: save it');
  assert.equal(r.attachmentOf(a).t, Math.floor(clock / 1000));
  assert.equal(r.message(a, announce(A, peer('a'), { event: 'update' })).changed, false, 'just saved');
  // the fake platform: a periodic announce 19 minutes after the join refreshes the attachment, and an object rebuilt from it two
  // minutes later keeps the socket (before the fix its sweep closed it: the attachment still carried the join time)
  const realNow = Date.now;
  try {
    let t = 1800000000000;
    Date.now = () => t;
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
