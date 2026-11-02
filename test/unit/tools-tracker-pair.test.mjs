// Unit tests for the pairing and room protocol in tools/tracker.mjs (ARCHITECTURE 15.21): the Node tracker on
// 127.0.0.1 with real ws clients. The state machine is the one test/unit/deploy-rtc-pair.test.mjs drives (deploy/rtc-worker/pair.js);
// here the wrapper around bittorrent-tracker is under test: the raw frames, the two kinds of socket, the lanes added to the allow
// list, the sweep and the counts. Every server and socket is closed in after().
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';

import { createTracker, loadPairModule } from '../../tools/tracker.mjs';
import { MAX_PAIR_BYTES, MIXED, LANE_TTL_MS, KNOCK_TTL_MS } from '../../deploy/rtc-worker/pair.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const BOX = { iv: 'A'.repeat(16), ct: 'B'.repeat(160) };
// the owner's proof of an accept: 86 base64url characters; the tracker checks the shape and passes it on
const PROOF = 'P'.repeat(86);
const dir = mkdtempSync(join(tmpdir(), 'mw-tracker-pair-test-'));
const trackers = [];
const clients = [];

after(async () => {
  for (const c of clients) {
    try { c.ws.terminate(); } catch (_) { /* gone */ }
  }
  for (const t of trackers) await t.close();
  rmSync(dir, { recursive: true, force: true });
});

const bin = (hex) => Buffer.from(hex, 'hex').toString('binary');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start(options) {
  const t = await createTracker(Object.assign({ port: 0 }, options));
  trackers.push(t);
  return t;
}

/** A client that keeps every message it gets, in order, for wait() to pick from. */
function connect(tracker) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(tracker.url);
    const client = { ws, queue: [], closed: null };
    clients.push(client);
    ws.on('message', (data) => client.queue.push(JSON.parse(data.toString('utf8'))));
    ws.on('close', (code) => { client.closed = code; });
    ws.once('open', () => resolve(client));
    ws.once('error', reject);
  });
}

async function wait(client, pred = () => true, ms = 3000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const i = client.queue.findIndex(pred);
    if (i >= 0) return client.queue.splice(i, 1)[0];
    if (Date.now() > deadline) throw new Error('no message arrived; the queue holds ' + JSON.stringify(client.queue));
    await sleep(4);
  }
}

/** quiet(client): what arrived within a moment, taken out of the queue (to assert that nothing did). */
async function quiet(client, ms = 80) {
  await sleep(ms);
  return client.queue.splice(0);
}

const say = (client, msg) => client.ws.send(JSON.stringify(Object.assign({ v: 1 }, msg)));
const ask = async (client, msg, pred) => { say(client, msg); return wait(client, pred || ((m) => m.action === msg.action || m['failure reason'] !== undefined)); };
const announce = (hex, peer, extra = {}) => Object.assign({ action: 'announce', info_hash: bin(hex), peer_id: peer, uploaded: 0, downloaded: 0, left: 0, event: 'started', numwant: 0, offers: [] }, extra);
const sendRaw = (client, msg) => client.ws.send(JSON.stringify(msg));
const reply = (client, msg) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('no reply')), 3000);
  client.ws.once('message', (data) => { clearTimeout(timer); client.queue.pop(); resolve(JSON.parse(data.toString('utf8'))); });
  sendRaw(client, msg);
});

/** random bytes with a known result: a knock id of twelve 7s, a lane of twenty 0x42 bytes. */
const FIXED_LANE = '42'.repeat(20);
const fixedRandom = (n) => new Uint8Array(n).fill(n === 20 ? 0x42 : 0x07);

test('the flow end to end: open, knock, request without any sdp or address, accept; the lane is refused before the accept and served after it', async () => {
  const t = await start({ allow: [A], random: fixedRandom });
  assert.equal(t.pairing, true);
  const owner = await connect(t);
  const requester = await connect(t);
  const peerA = await connect(t);
  const peerB = await connect(t);

  // the lane does not exist yet: the tracker refuses it, so no offer can move
  const before = await reply(peerA, announce(FIXED_LANE, 'a'.repeat(20)));
  assert.match(before['failure reason'], /not allowed/);

  const opened = await ask(owner, { action: 'pair-open', channel: 'abcd', box: BOX, rid: 'o1' });
  assert.deepEqual(opened, { action: 'pair-open', channel: 'abcd', rid: 'o1' });
  const knockBox = { iv: 'C'.repeat(16), ct: 'D'.repeat(120) };
  say(requester, { action: 'pair-knock', channel: 'abcd', box: knockBox, rid: 'k1' });
  const mine = await wait(requester, (m) => m.action === 'pair-knock');
  const request = await wait(owner, (m) => m.action === 'pair-request');
  assert.equal(mine.knock, request.knock);
  assert.match(mine.knock, /^[A-Za-z0-9_-]{16}$/);
  assert.deepEqual(request, { action: 'pair-request', knock: mine.knock, channel: 'abcd', box: knockBox });
  assert.doesNotMatch(JSON.stringify(request), /sdp|candidate|offer|address|"ip"/i, 'the rendezvous passes on the box and nothing else');
  assert.deepEqual(await quiet(requester), [], 'nothing else is sent to the requester before the owner decides');

  const mid = await reply(peerA, announce(FIXED_LANE, 'a'.repeat(20)));
  assert.match(mid['failure reason'], /not allowed/, 'a pending knock opens no lane');
  assert.equal(t.stats().torrents, 0, 'the tracker saw no swarm for the lane');
  assert.deepEqual([t.stats().codes, t.stats().knocks, t.stats().lanes], [1, 1, 0]);

  say(owner, { action: 'pair-accept', proof: PROOF, knock: mine.knock, rid: 'a1' });
  const accepted = await wait(owner, (m) => m.action === 'pair-accepted');
  const got = await wait(requester, (m) => m.action === 'pair-accepted');
  assert.deepEqual(accepted, { action: 'pair-accepted', knock: mine.knock, lane: FIXED_LANE, rid: 'a1' });
  assert.deepEqual(got, { action: 'pair-accepted', knock: mine.knock, lane: FIXED_LANE, channel: 'abcd', box: BOX, proof: PROOF });
  assert.deepEqual([t.stats().codes, t.stats().knocks, t.stats().lanes], [1, 0, 1]);
  assert.equal(t.allow.has(FIXED_LANE), false, 'the lane is held beside the allow list, which is the operator\'s');

  // now the lane is served: the first offer moves between the two, after the approval
  const first = await reply(peerA, announce(FIXED_LANE, 'a'.repeat(20)));
  assert.equal(first.action, 'announce');
  assert.equal(first['failure reason'], undefined);
  peerB.ws.send(JSON.stringify(announce(FIXED_LANE, 'b'.repeat(20), { left: 5, numwant: 1, offers: [{ offer: { type: 'offer', sdp: 'v=0' }, offer_id: 'o'.repeat(20) }] })));
  const offer = await wait(peerA, (m) => m.offer !== undefined);
  assert.equal(offer.info_hash, bin(FIXED_LANE));
  assert.equal(offer.peer_id, 'b'.repeat(20));
  assert.equal(t.stats().torrents, 1);
  assert.equal(t.stats().unlisted, 0, 'a lane is allowed, not an unlisted swarm');
});

test('a tracker socket cannot knock and a pair socket cannot announce; the first message classifies a socket', async () => {
  const t = await start({ allow: [A] });
  const tracker = await connect(t);
  assert.equal((await reply(tracker, announce(A, 't'.repeat(20)))).action, 'announce');
  const refused = await ask(tracker, { action: 'pair-knock', channel: 'abcd', box: BOX, rid: 'k' });
  assert.deepEqual(refused, { action: 'pair-knock', rid: 'k', 'failure reason': MIXED });
  assert.deepEqual(await ask(tracker, { action: 'room-open', channel: 'abcd', box: BOX }), { action: 'room-open', 'failure reason': MIXED });
  assert.equal(t.stats().codes, 0);
  const still = await reply(tracker, announce(A, 't'.repeat(20), { event: 'update' }));
  assert.equal(still['failure reason'], undefined, 'the tracker socket still announces');

  const pair = await connect(t);
  await ask(pair, { action: 'pair-open', channel: 'abcd', box: BOX });
  const ann = await reply(pair, announce(A, 'p'.repeat(20)));
  assert.deepEqual(ann, { action: 'announce', 'failure reason': MIXED });
  const scr = await reply(pair, { action: 'scrape', info_hash: bin(A) });
  assert.deepEqual(scr, { action: 'scrape', 'failure reason': MIXED });
  assert.equal(t.stats().torrents, 1, 'the pair socket joined no swarm');
  assert.equal(t.stats().codes, 1, 'its code is still open');

  // a bare scrape classifies a socket as a tracker socket; a frame that is not JSON classifies nothing
  const scraper = await connect(t);
  assert.equal((await reply(scraper, { action: 'scrape' })).action, 'scrape');
  assert.deepEqual(await ask(scraper, { action: 'pair-open', channel: 'wxyz', box: BOX }), { action: 'pair-open', 'failure reason': MIXED });
  const junk = await connect(t);
  junk.ws.send('{nope');
  assert.ok((await wait(junk))['failure reason']);
  assert.equal((await ask(junk, { action: 'pair-open', channel: 'wxyz', box: BOX })).channel, 'wxyz');
});

test('rooms: the lane is allowed at open, members knock and are accepted, and a closed owner socket releases the room', async () => {
  const t = await start({ allow: [A] });
  const owner = await connect(t);
  const m1 = await connect(t);
  const m2 = await connect(t);
  const peer = await connect(t);
  const opened = await ask(owner, { action: 'room-open', channel: 'rm22', box: BOX, rid: 'r' });
  assert.equal(opened.action, 'room-open');
  assert.match(opened.lane, /^[0-9a-f]{40}$/);
  assert.equal((await reply(peer, announce(opened.lane, 'p'.repeat(20))))['failure reason'], undefined, 'the room lane is served from the start');
  say(m1, { action: 'room-knock', channel: 'rm22', box: BOX });
  say(m2, { action: 'room-knock', channel: 'rm22', box: BOX });
  const r1 = await wait(owner, (m) => m.action === 'room-request');
  const r2 = await wait(owner, (m) => m.action === 'room-request');
  const k1 = await wait(m1, (m) => m.action === 'room-knock');
  assert.ok([r1.knock, r2.knock].includes(k1.knock));
  say(owner, { action: 'room-accept', proof: PROOF, knock: k1.knock });
  assert.deepEqual(await wait(m1, (m) => m.action === 'room-accepted'), { action: 'room-accepted', knock: k1.knock, lane: opened.lane, channel: 'rm22', box: BOX, proof: PROOF });
  const k2 = await wait(m2, (m) => m.action === 'room-knock');
  say(owner, { action: 'room-reject', knock: k2.knock });
  assert.deepEqual(await wait(m2, (m) => m.action === 'room-rejected'), { action: 'room-rejected', knock: k2.knock, reason: 'rejected' });
  // the owner closes its page: pending knocks are told 'gone', the code is released, the lane stays allowed until it expires
  const m3 = await connect(t);
  say(m3, { action: 'room-knock', channel: 'rm22', box: BOX });
  const k3 = await wait(m3, (m) => m.action === 'room-knock');
  await wait(owner, (m) => m.action === 'room-request' && m.knock === k3.knock);
  owner.ws.close();
  assert.deepEqual(await wait(m3, (m) => m.action === 'room-rejected'), { action: 'room-rejected', knock: k3.knock, reason: 'gone' });
  for (let i = 0; i < 50 && t.stats().codes > 0; i++) await sleep(10);
  assert.deepEqual([t.stats().codes, t.stats().knocks, t.stats().lanes], [0, 0, 1]);
});

test('a socket that closes releases its code, rejects its pending knocks with gone, and cancels its own knocks', async () => {
  const t = await start({ allow: [A] });
  const owner = await connect(t);
  const req = await connect(t);
  await ask(owner, { action: 'pair-open', channel: 'abcd', box: BOX });
  say(req, { action: 'pair-knock', channel: 'abcd', box: BOX });
  const knock = (await wait(req, (m) => m.action === 'pair-knock')).knock;
  await wait(owner, (m) => m.action === 'pair-request');
  owner.ws.close();
  assert.deepEqual(await wait(req, (m) => m.action === 'pair-rejected'), { action: 'pair-rejected', knock, reason: 'gone' });
  for (let i = 0; i < 50 && t.stats().codes > 0; i++) await sleep(10);
  assert.deepEqual([t.stats().codes, t.stats().knocks], [0, 0]);
  assert.equal((await ask(req, { action: 'pair-knock', channel: 'abcd', box: BOX }))['failure reason'], 'unknown code');

  const o2 = await connect(t);
  const r2 = await connect(t);
  await ask(o2, { action: 'pair-open', channel: 'wxyz', box: BOX });
  say(r2, { action: 'pair-knock', channel: 'wxyz', box: BOX });
  const k2 = (await wait(r2, (m) => m.action === 'pair-knock')).knock;
  await wait(o2, (m) => m.action === 'pair-request');
  r2.ws.close();
  assert.deepEqual(await wait(o2, (m) => m.action === 'pair-cancelled'), { action: 'pair-cancelled', knock: k2 });
  assert.equal(t.stats().knocks, 0);
});

test('expiry on an injected clock: a knock runs out at 10 minutes, a lane is dead at 24 hours (its swarm goes, nobody joins it), the counts follow', async () => {
  let clock = 1700000000000;
  const t = await start({ allow: [A], now: () => clock, random: fixedRandom, pairSweepMs: 3600000 });
  const owner = await connect(t);
  const req = await connect(t);
  const peerA = await connect(t);
  const late = await connect(t);
  await ask(owner, { action: 'pair-open', channel: 'abcd', box: BOX });
  say(req, { action: 'pair-knock', channel: 'abcd', box: BOX });
  const k1 = (await wait(req, (m) => m.action === 'pair-knock')).knock;
  await wait(owner, (m) => m.action === 'pair-request');
  clock += KNOCK_TTL_MS - 1;
  assert.deepEqual(t.pairSweep(), { lanes: 0, replies: 0 });
  clock += 1;
  assert.deepEqual(t.pairSweep(), { lanes: 0, replies: 2 });
  assert.deepEqual(await wait(req, (m) => m.action === 'pair-rejected'), { action: 'pair-rejected', knock: k1, reason: 'expired' });
  assert.deepEqual(await wait(owner, (m) => m.action === 'pair-cancelled'), { action: 'pair-cancelled', knock: k1 });

  say(req, { action: 'pair-knock', channel: 'abcd', box: BOX });
  const k2 = (await wait(req, (m) => m.action === 'pair-knock')).knock;
  await wait(owner, (m) => m.action === 'pair-request');
  say(owner, { action: 'pair-accept', proof: PROOF, knock: k2 });
  const lane = (await wait(owner, (m) => m.action === 'pair-accepted')).lane;
  assert.equal(lane, FIXED_LANE);
  assert.equal((await reply(peerA, announce(lane, 'a'.repeat(20))))['failure reason'], undefined);
  assert.equal(t.stats().lanes, 1);
  clock += LANE_TTL_MS - 1;
  t.pairSweep();
  assert.equal(t.stats().lanes, 1, 'not yet');
  clock += 1;
  assert.deepEqual(t.pairSweep(), { lanes: 1, replies: 0 });
  assert.equal(t.stats().lanes, 0);
  assert.equal(t.stats().torrents, 0, 'the swarm of a dead lane is gone');
  assert.equal(t.stats().unlisted, 0);
  assert.match((await reply(late, announce(lane, 'l'.repeat(20))))['failure reason'], /not allowed/, 'nobody new joins an expired lane');
  assert.match((await reply(peerA, announce(lane, 'a'.repeat(20), { event: 'update' })))['failure reason'], /not allowed/, 'and the peer that was in is refused at its next announce');
  assert.equal(t.prune(), 0, 'nothing is left to prune');

  // the code itself runs out at 24 hours: the owner is told
  await ask(owner, { action: 'pair-open', channel: 'wxyz', box: BOX });
  clock += LANE_TTL_MS;
  t.pairSweep();
  assert.deepEqual(await wait(owner, (m) => m.action === 'pair-close' && m.channel === 'wxyz'), { action: 'pair-close', channel: 'wxyz', reason: 'expired' });
});

test('an empty lane swarm is pruned like an unlisted one but never counted as unlisted; the cap on lanes holds; a lane in the allow list stays listed', async () => {
  const t = await start({ allow: [A], random: fixedRandom, maxLanes: 1 });
  const owner = await connect(t);
  const req = await connect(t);
  const peer = await connect(t);
  await ask(owner, { action: 'pair-open', channel: 'abcd', box: BOX });
  say(req, { action: 'pair-knock', channel: 'abcd', box: BOX });
  const k1 = (await wait(req, (m) => m.action === 'pair-knock')).knock;
  await wait(owner, (m) => m.action === 'pair-request');
  say(owner, { action: 'pair-accept', proof: PROOF, knock: k1 });
  await wait(owner, (m) => m.action === 'pair-accepted');
  await reply(peer, announce(FIXED_LANE, 'p'.repeat(20)));
  assert.equal(t.stats().torrents, 1);
  assert.equal(t.stats().unlisted, 0);
  peer.ws.close();
  for (let i = 0; i < 50 && t.stats().peers > 0; i++) await sleep(10);
  assert.equal(t.prune(), 1, 'an empty lane swarm does not wait for its lane to expire');
  assert.equal(t.stats().unlisted, 0);
  assert.equal(t.stats().lanes, 1, 'the lane is still allowed');
  // the same fixed bytes mint the same lane again: allowed, the same entry, so the cap is not hit; a second owner mints another? (it cannot with fixed bytes), so use real randomness
  const t2 = await start({ allow: [A], maxLanes: 1 });
  const o2 = await connect(t2);
  const r2 = await connect(t2);
  await ask(o2, { action: 'pair-open', channel: 'abcd', box: BOX });
  for (let i = 0; i < 2; i++) {
    say(r2, { action: 'pair-knock', channel: 'abcd', box: BOX });
    const k = (await wait(r2, (m) => m.action === 'pair-knock')).knock;
    await wait(o2, (m) => m.action === 'pair-request');
    say(o2, { action: 'pair-accept', proof: PROOF, knock: k });
    if (i === 0) await wait(r2, (m) => m.action === 'pair-accepted');
    else assert.equal((await wait(o2, (m) => m.action === 'pair-accept'))['failure reason'], 'too many lanes');
  }
  assert.equal(t2.stats().lanes, 1);
  assert.equal(t2.stats().knocks, 1, 'the knock waits for room');
  // a lane that is also in the allow list is listed whatever the pairing says
  const lanes = await start({ allow: [FIXED_LANE], random: fixedRandom });
  const x = await connect(lanes);
  const y = await connect(lanes);
  await ask(x, { action: 'pair-open', channel: 'abcd', box: BOX });
  say(y, { action: 'pair-knock', channel: 'abcd', box: BOX });
  const k = (await wait(y, (m) => m.action === 'pair-knock')).knock;
  await wait(x, (m) => m.action === 'pair-request');
  say(x, { action: 'pair-accept', proof: PROOF, knock: k });
  await wait(x, (m) => m.action === 'pair-accepted');
  const z = await connect(lanes);
  await reply(z, announce(FIXED_LANE, 'z'.repeat(20)));
  z.ws.close();
  for (let i = 0; i < 50 && lanes.stats().peers > 0; i++) await sleep(10);
  assert.equal(lanes.prune(), 0, 'a listed swarm costs nothing and stays');
});

test('caps and sizes over real sockets: 10 knocks a minute, a frame over 8,192 bytes, bad shapes', async () => {
  const t = await start({ allow: [A] });
  const k = await connect(t);
  for (let i = 0; i < 10; i++) assert.equal((await ask(k, { action: 'pair-knock', channel: 'zzzz', box: BOX }))['failure reason'], 'unknown code');
  assert.equal((await ask(k, { action: 'pair-knock', channel: 'zzzz', box: BOX }))['failure reason'], 'too many requests');

  const p = await connect(t);
  const big = JSON.stringify({ v: 1, action: 'pair-open', channel: 'abcd', box: BOX, rid: 'r', pad: 'x'.repeat(MAX_PAIR_BYTES) });
  p.ws.send(big);
  assert.deepEqual(await wait(p), { action: 'pair-open', rid: 'r', 'failure reason': 'message too large' });
  assert.equal(t.stats().codes, 0);
  assert.equal((await ask(p, { action: 'pair-open', channel: 'abcd', box: BOX })).channel, 'abcd');
  p.ws.send(big);
  assert.deepEqual(await wait(p), { 'failure reason': 'message too large' }, 'a classified pair socket gets the refusal before any parsing');
  assert.equal(p.closed, null, 'the socket stays open');
  assert.equal(t.stats().codes, 1);

  const q = await connect(t);
  assert.equal((await ask(q, { action: 'pair-open', channel: 'ABCD', box: BOX }))['failure reason'], 'invalid channel');
  assert.equal((await ask(q, { action: 'pair-open', channel: 'abcd', box: BOX }))['failure reason'], 'channel taken');
  assert.equal((await ask(q, { action: 'pair-open', channel: 'efgh', box: { iv: 'x', ct: 'y' } }))['failure reason'], 'box invalid');
  q.ws.send(JSON.stringify({ action: 'pair-open', channel: 'efgh', box: BOX }));
  assert.equal((await wait(q))['failure reason'], 'unsupported version');
  const kinds = await connect(t);
  assert.equal((await ask(kinds, { action: 'pair-bogus' }))['failure reason'], 'invalid action');
});

test('/stats.json counts codes, knocks and lanes and names none of them; --no-pairing (pairing: false) serves the tracker only', async () => {
  const t = await start({ allow: [A], random: fixedRandom });
  const owner = await connect(t);
  const req = await connect(t);
  await ask(owner, { action: 'pair-open', channel: 'abcd', box: BOX });
  say(req, { action: 'pair-knock', channel: 'abcd', box: BOX });
  const knock = (await wait(req, (m) => m.action === 'pair-knock')).knock;
  await wait(owner, (m) => m.action === 'pair-request');
  say(owner, { action: 'pair-accept', proof: PROOF, knock });
  await wait(owner, (m) => m.action === 'pair-accepted');
  const stats = await (await fetch(t.url.replace(/^ws:/, 'http:') + '/stats.json')).json();
  assert.deepEqual(Object.keys(stats).sort(), ['allowed', 'codes', 'knocks', 'lanes', 'open', 'peers', 'torrents', 'unlisted', 'uploads']);
  assert.deepEqual([stats.codes, stats.knocks, stats.lanes], [1, 0, 1]);
  const text = JSON.stringify(stats);
  for (const secret of ['abcd', knock, FIXED_LANE]) assert.equal(text.includes(secret), false, 'stats name no code, knock or lane');

  const off = await start({ allow: [A], pairing: false });
  assert.equal(off.pairing, false);
  const c = await connect(off);
  const refused = await ask(c, { action: 'pair-open', channel: 'abcd', box: BOX });
  assert.ok(refused['failure reason'], 'the library answers an action it does not know');
  assert.equal(off.stats().codes, 0);
  assert.equal((await reply(c, announce(A, 'c'.repeat(20)))).action, 'announce', 'the tracker works');
  const sweepOnly = off.pairSweep();
  assert.deepEqual(sweepOnly, { lanes: 0, replies: 0 });
  const auto = await start({ allow: [B], pairing: undefined });
  assert.equal(auto.pairing, true, 'not asked for either way: on when the file is there');
});

test('loadPairModule: the shared core when deploy/rtc-worker/pair.js is there, null when the file is not part of the install, any other error is thrown', async () => {
  const mod = await loadPairModule();
  assert.equal(typeof mod.createPairing, 'function');
  assert.equal(typeof mod.isPairAction, 'function');
  assert.equal(await loadPairModule(new URL('./no-such-pair-core-' + Date.now() + '.js', import.meta.url).href), null);
  const broken = join(dir, 'broken.mjs');
  writeFileSync(broken, 'export const oops = ;\n');
  await assert.rejects(loadPairModule(new URL('file://' + broken).href), SyntaxError, 'a file that is there but broken is an error, not a silent "pairing off"');
  const tracker = await start({ allow: [A], pairing: true });
  assert.equal(tracker.pairing, true, 'asking for it when the file is there works');
});

test('a defect in the pairing is a failure reply and a warning, not a crashed tracker', async () => {
  const warnings = [];
  const t = await start({ allow: [A], random: () => { throw new Error('no randomness here'); } });
  t.server.on('warning', (err) => warnings.push(err.message));
  const owner = await connect(t);
  const req = await connect(t);
  const other = await connect(t);
  await ask(owner, { action: 'pair-open', channel: 'abcd', box: BOX });
  const failed = await ask(req, { action: 'pair-knock', channel: 'abcd', box: BOX, rid: 'k' });
  assert.deepEqual(failed, { action: 'pair-knock', rid: 'k', 'failure reason': 'internal error' });
  assert.ok(warnings.some((m) => /no randomness here/.test(m)), 'the operator sees it');
  assert.equal((await reply(other, announce(A, 'o'.repeat(20)))).action, 'announce', 'the tracker still serves');
  assert.equal((await ask(owner, { action: 'pair-close', rid: 'c' })).channel, 'abcd', 'and the owner can still close its code');
  assert.deepEqual(await quiet(owner), []);
});
