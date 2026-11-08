// Unit tests for the pairing and room protocol in tools/tracker.mjs (ARCHITECTURE 15.21): the Node tracker on
// 127.0.0.1 with real ws clients. The state machine is the one test/unit/deploy-rtc-pair.test.mjs drives (deploy/rtc-worker/pair.js);
// here the wrapper around bittorrent-tracker is under test: the raw frames, the two kinds of socket, the lanes added to the allow
// list, the sweep and the counts. Every server and socket is closed in after().
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
const children = [];
const TRACKER_CLI = fileURLToPath(new URL('../../tools/tracker.mjs', import.meta.url));

after(async () => {
  for (const c of clients) {
    try { c.ws.terminate(); } catch (_) { /* gone */ }
  }
  for (const child of children) {
    try { child.kill('SIGKILL'); } catch (_) { /* gone */ }
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
    const ws = new WebSocket(typeof tracker === 'string' ? tracker : tracker.url);
    const client = { ws, queue: [], closed: null, closeReason: null };
    clients.push(client);
    ws.on('message', (data) => client.queue.push(JSON.parse(data.toString('utf8'))));
    ws.on('close', (code, reason) => { client.closed = code; client.closeReason = reason.toString('utf8'); });
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
  assert.deepEqual(Object.keys(stats).sort(), ['allowed', 'codes', 'evicted', 'joinsRefused', 'knocks', 'lanes', 'open', 'peers', 'relayBusy', 'relayBytes', 'relayDay', 'relayRate', 'relaySince', 'relayed', 'relays', 'torrents', 'unlisted', 'uploads']);
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

// ---------------------------------------------------------------------------------------------- the relay lane (plan 3.1 to 3.4)

const PING = '{"v":1,"action":"pair-ping"}';
/** The stats the older tests pin exactly, without the nine relay fields (plan 3.2, evicted from DECISIONS DEC-1, relaySince from finding A F3 of the 8.2 audit; the relay tests pin those). */
const RELAY_FIELDS = ['relays', 'relayed', 'relayBytes', 'relayDay', 'relaySince', 'relayBusy', 'relayRate', 'joinsRefused', 'evicted'];

/** pairedLane(t): an owner and a requester over real sockets; the owner opens a code, the requester knocks, the owner accepts. */
async function pairedLane(t) {
  const owner = await connect(t);
  const req = await connect(t);
  await ask(owner, { action: 'pair-open', channel: 'abcd', box: BOX });
  say(req, { action: 'pair-knock', channel: 'abcd', box: BOX });
  const knock = (await wait(req, (m) => m.action === 'pair-knock')).knock;
  await wait(owner, (m) => m.action === 'pair-request');
  say(owner, { action: 'pair-accept', proof: PROOF, knock });
  const lane = (await wait(owner, (m) => m.action === 'pair-accepted')).lane;
  await wait(req, (m) => m.action === 'pair-accepted');
  return { owner, req, lane };
}

test('the relay over real sockets: join, joined, relay, relayed, ping and pong, left when a socket closes; the stats count it and name no lane', async () => {
  const startedAt = Date.now();
  const t = await start({ allow: [A] });
  const { owner, req, lane } = await pairedLane(t);
  assert.deepEqual(await ask(owner, { action: 'pair-join', lane, rid: 'j1' }), { action: 'pair-join', lane, peers: 0, rid: 'j1' });
  assert.deepEqual(await ask(req, { action: 'pair-join', lane, rid: 'j2' }), { action: 'pair-join', lane, peers: 1, rid: 'j2' });
  assert.deepEqual(await wait(owner, (m) => m.action === 'pair-joined'), { action: 'pair-joined', lane, peers: 1 });
  // a sealed frame goes to the other socket, byte for byte, and the sender is answered when it asked
  const f = Buffer.alloc(5634, 9).toString('base64url');
  assert.equal(f.length, 7512, 'the largest frame the apps send');
  say(owner, { action: 'pair-relay', lane, f, rid: 'r1234567' });
  assert.deepEqual(await wait(req, (m) => m.action === 'pair-relayed'), { action: 'pair-relayed', lane, f });
  assert.deepEqual(await wait(owner, (m) => m.action === 'pair-relay'), { action: 'pair-relay', lane, peers: 1, rid: 'r1234567' });
  say(req, { action: 'pair-relay', lane, f: 'abcd' });
  assert.deepEqual(await wait(owner, (m) => m.action === 'pair-relayed'), { action: 'pair-relayed', lane, f: 'abcd' });
  assert.deepEqual(await quiet(req), [], 'no rid: no answer, and nothing echoed to the sender');
  // the raw ping text of the client gets its pong, on a socket that has done nothing else
  const pinger = await connect(t);
  pinger.ws.send(PING);
  assert.deepEqual(await wait(pinger), { action: 'pair-pong' });
  assert.equal((await ask(pinger, { action: 'pair-open', channel: 'wxyz', box: BOX })).channel, 'wxyz', 'a ping classified it as a pair socket');
  assert.deepEqual(await reply(pinger, announce(A, 'p'.repeat(20))), { action: 'announce', 'failure reason': MIXED });
  // the counts
  const stats = await (await fetch(t.url.replace(/^ws:/, 'http:') + '/stats.json')).json();
  assert.deepEqual(RELAY_FIELDS.map((k) => typeof stats[k]), Array(RELAY_FIELDS.length).fill('number'));
  assert.deepEqual([stats.relays, stats.relayed, stats.relayBytes, stats.joinsRefused, stats.relayBusy, stats.relayRate], [1, 2, 7512 + 4, 0, 0, 0]);
  assert.match(String(stats.relayDay), /^20\d{6}$/);
  // the counts began when the tracker started (its process is the "run" the counts belong to), or at 00:00 UTC if the day changed meanwhile
  assert.ok(Number.isInteger(stats.relaySince) && stats.relaySince >= startedAt && stats.relaySince <= Date.now(), 'relaySince: ' + stats.relaySince);
  assert.equal(JSON.stringify(stats).includes(lane), false);
  assert.equal(JSON.stringify(stats).includes(f), false);
  assert.deepEqual([t.stats().relays, t.stats().relayed], [1, 2], 'the object the tracker returns says the same');
  // a socket that closes leaves its lane, and the other is told
  req.ws.close();
  assert.deepEqual(await wait(owner, (m) => m.action === 'pair-left'), { action: 'pair-left', lane, peers: 0 });
  for (let i = 0; i < 50 && t.stats().relays > 0; i++) await sleep(10);
  assert.equal(t.stats().relays, 1, 'the owner is still in the lane');
  owner.ws.close();
  for (let i = 0; i < 50 && t.stats().relays > 0; i++) await sleep(10);
  assert.equal(t.stats().relays, 0, 'and the record goes with its last member');
});

test('the relay over real sockets: the refusals of the protocol, a third socket, a frame past 7,700 characters, a lane nobody minted, and a room of three', async () => {
  const t = await start({ allow: [A] });
  const { owner, req, lane } = await pairedLane(t);
  const third = await connect(t);
  assert.equal((await ask(third, { action: 'pair-join', lane: 'ab'.repeat(20), rid: 'u' }))['failure reason'], 'unknown lane', 'a lane nobody minted');
  assert.equal((await ask(third, { action: 'pair-join', lane: 'nope', rid: 'u' }))['failure reason'], 'invalid lane');
  await ask(owner, { action: 'pair-join', lane });
  await ask(req, { action: 'pair-join', lane });
  await wait(owner, (m) => m.action === 'pair-joined');
  assert.equal((await ask(third, { action: 'pair-join', lane, rid: 'f' }))['failure reason'], 'lane full', 'a third socket that knows the lane id finds it full');
  assert.equal((await ask(third, { action: 'pair-relay', lane, f: 'abcd', rid: 'n' }))['failure reason'], 'unknown lane', 'and cannot relay into it');
  assert.deepEqual(await quiet(owner), [], 'the pair heard nothing from it');
  assert.deepEqual(await quiet(req), []);
  assert.equal((await ask(owner, { action: 'pair-relay', lane, f: 'x'.repeat(7701), rid: 'e' }))['failure reason'], 'invalid frame');
  assert.equal((await ask(owner, { action: 'pair-relay', lane, f: 'ab+/', rid: 'e' }))['failure reason'], 'invalid frame');
  const widest = 'x'.repeat(7700);
  say(owner, { action: 'pair-relay', lane, f: widest, rid: 'w' });
  assert.equal((await wait(req, (m) => m.action === 'pair-relayed')).f, widest, '7,700 characters pass over a real socket');
  assert.equal((await wait(owner, (m) => m.action === 'pair-relay')).peers, 1);
  // a frame over 8,192 bytes on the socket is refused before it is read, as every pair frame is
  owner.ws.send(JSON.stringify({ v: 1, action: 'pair-relay', lane, f: 'x'.repeat(8100), rid: 'big' }));
  assert.deepEqual(await wait(owner), { 'failure reason': 'message too large' });
  assert.deepEqual(await quiet(req), []);

  // a room: the lane is minted at open; three members all hear each other, the owner included
  const room = await connect(t);
  const m1 = await connect(t);
  const m2 = await connect(t);
  const lane2 = (await ask(room, { action: 'room-open', channel: 'rm22', box: BOX })).lane;
  for (const m of [room, m1, m2]) await ask(m, { action: 'room-join', lane: lane2 });
  assert.deepEqual(await wait(room, (m) => m.action === 'room-joined' && m.peers === 2), { action: 'room-joined', lane: lane2, peers: 2 });
  say(m1, { action: 'room-relay', lane: lane2, f: 'Zm9v', rid: 'r' });
  assert.deepEqual(await wait(room, (m) => m.action === 'room-relayed'), { action: 'room-relayed', lane: lane2, f: 'Zm9v' });
  assert.deepEqual(await wait(m2, (m) => m.action === 'room-relayed'), { action: 'room-relayed', lane: lane2, f: 'Zm9v' });
  assert.equal((await wait(m1, (m) => m.action === 'room-relay')).peers, 2);
  assert.deepEqual((await quiet(m1)).filter((m) => m.action === 'room-relayed'), [], 'the sender is not echoed its own frame');
  say(m2, { action: 'room-leave', lane: lane2, rid: 'l' });
  assert.deepEqual(await wait(room, (m) => m.action === 'room-left'), { action: 'room-left', lane: lane2, peers: 1 });
  assert.equal((await wait(m2, (m) => m.action === 'room-leave')).rid, 'l');
});

test('relayLane false keeps the pairing and turns the relay off: join, relay and leave all answer "relay is off on this rendezvous"', async () => {
  const t = await start({ allow: [A], relayLane: false });
  assert.deepEqual([t.pairing, t.relayLane], [true, false]);
  const { owner, req, lane } = await pairedLane(t);
  for (const action of ['pair-join', 'pair-relay', 'pair-leave', 'room-join']) {
    assert.deepEqual(await ask(owner, { action, lane, f: 'abcd', rid: 'o' }), { action, rid: 'o', 'failure reason': 'relay is off on this rendezvous' }, action);
  }
  assert.deepEqual(await quiet(req), []);
  req.ws.send(PING);
  assert.deepEqual(await wait(req), { action: 'pair-pong' }, 'a ping still gets its pong');
  assert.equal(t.stats().joinsRefused, 2, 'the two joins are counted');
  assert.deepEqual([t.stats().relays, t.stats().relayed], [0, 0]);
  const on = await start({ allow: [A] });
  assert.deepEqual([on.pairing, on.relayLane], [true, true], 'on by default');
  const offAt = Date.now();
  const off = await start({ allow: [A], pairing: false });
  assert.deepEqual([off.pairing, off.relayLane], [false, false], 'no pairing, no relay');
  assert.deepEqual(RELAY_FIELDS.map((k) => off.stats()[k]).slice(0, 3), [0, 0, 0]);
  assert.match(String(off.stats().relayDay), /^20\d{6}$/);
  assert.ok(Number.isInteger(off.stats().relaySince) && off.stats().relaySince >= offAt && off.stats().relaySince <= Date.now(), 'with pairing off the tracker still says when its zero counts began');
});

test('the 151st message of a minute gets its reason and the socket is closed with 1008; the other member is told it left; a ping is a message here too (DEC-2)', async () => {
  const t = await start({ allow: [A] });
  const { owner, req, lane } = await pairedLane(t);
  await ask(owner, { action: 'pair-join', lane });
  await ask(req, { action: 'pair-join', lane });
  await wait(owner, (m) => m.action === 'pair-joined');
  // the requester has sent 3 messages so far (knock, join, ...); a burst of ping-free messages goes over 150
  for (let i = 0; i < 160; i++) req.ws.send(JSON.stringify({ v: 1, action: 'pair-leave', lane: 'cd'.repeat(20) }));
  for (let i = 0; i < 100 && req.closed === null; i++) await sleep(10);
  assert.equal(req.closed, 1008);
  assert.equal(req.closeReason, 'too many messages');
  assert.ok(req.queue.some((m) => m['failure reason'] === 'too many messages'), 'its last message was answered with the reason');
  assert.deepEqual(await wait(owner, (m) => m.action === 'pair-left'), { action: 'pair-left', lane, peers: 0 });
  assert.equal(owner.closed, null, 'only the flooding socket was closed');
  // DECISIONS DEC-2: the tracker has no platform to answer the exact ping text before it reaches pair.js, so every ping is counted
  // there like any message: a flood of them closes the socket at the 151st; a page's one ping every 50 seconds is 1.2 a minute against 150
  const flood = await connect(t);
  for (let i = 0; i < 1000; i++) flood.ws.send(PING);
  for (let i = 0; i < 200 && flood.closed === null; i++) await sleep(10);
  assert.equal(flood.closed, 1008);
  assert.equal(flood.closeReason, 'too many messages');
  assert.equal(flood.queue.filter((m) => m.action === 'pair-pong').length, 150, 'the first 150 got their pong');
  assert.ok(flood.queue.some((m) => m.action === 'pair-ping' && m['failure reason'] === 'too many messages'), 'the 151st was answered with the reason');
  const calm = await connect(t);
  for (let i = 0; i < 100; i++) calm.ws.send(PING);
  for (let i = 0; i < 200 && calm.queue.length < 100; i++) await sleep(10);
  assert.equal(calm.queue.length, 100);
  assert.equal(calm.closed, null);
  assert.equal((await ask(calm, { action: 'pair-open', channel: 'wxyz', box: BOX })).channel, 'wxyz', 'and the socket still works');
});

test('on an injected clock: the lane runs out at 24 hours, the relay record goes with it and a relay then finds no lane; the day counters roll at 00:00 UTC', async () => {
  let clock = Date.UTC(2026, 10, 7, 22, 0, 0);
  const t = await start({ allow: [A], now: () => clock, random: fixedRandom, pairSweepMs: 3600000 });
  const { owner, req, lane } = await pairedLane(t);
  assert.equal(lane, FIXED_LANE);
  await ask(owner, { action: 'pair-join', lane });
  await ask(req, { action: 'pair-join', lane });
  await wait(owner, (m) => m.action === 'pair-joined');
  say(owner, { action: 'pair-relay', lane, f: 'abcd' });
  await wait(req, (m) => m.action === 'pair-relayed');
  assert.deepEqual([t.stats().relayDay, t.stats().relayed], [20261107, 1]);
  clock += 30 * 60 * 1000; // 22:30 UTC on the 7th
  assert.equal(t.stats().relaySince, Date.UTC(2026, 10, 7, 22, 0, 0), 'the counts began when the tracker started, not when they are read (finding A F3)');
  clock += 2 * 3600 * 1000; // 00:30 UTC on the 8th
  assert.deepEqual([t.stats().relayDay, t.stats().relayed, t.stats().relays], [20261108, 0, 1], 'a new day starts the counters again; the lane is still in use');
  assert.equal(t.stats().relaySince, Date.UTC(2026, 10, 8), 'and they began at 00:00 UTC of the new day, half an hour before the read');
  clock += LANE_TTL_MS - 3600 * 1000;
  // the one reply is the owner's code running out; the relay lane that ran out with the lane tells its members nothing
  assert.deepEqual(t.pairSweep(), { lanes: 1, replies: 1 });
  assert.deepEqual(await wait(owner, (m) => m.action === 'pair-close'), { action: 'pair-close', channel: 'abcd', reason: 'expired' });
  assert.deepEqual(await quiet(req), [], 'and the requester is told nothing at all');
  assert.equal(t.stats().relays, 0);
  assert.equal((await ask(owner, { action: 'pair-relay', lane, f: 'abcd', rid: 'late' }))['failure reason'], 'unknown lane');
  assert.equal((await ask(owner, { action: 'pair-join', lane, rid: 'late' }))['failure reason'], 'unknown lane');
});

test('with pairing off, on an injected clock: the zero relay counts began when the tracker started, or at 00:00 UTC of the day read, whichever is later (finding A F3)', async () => {
  // this is the tracker's own answer (pair.js is not loaded when pairing is off, or not in the install), not the pairing core's
  let clock = Date.UTC(2026, 10, 7, 22, 0, 0);
  const t = await start({ allow: [A], pairing: false, now: () => clock });
  assert.equal(t.pairing, false);
  clock += 30 * 60 * 1000; // 22:30 UTC on the 7th
  assert.deepEqual([t.stats().relayDay, t.stats().relaySince], [20261107, Date.UTC(2026, 10, 7, 22, 0, 0)], 'the start, not the read');
  clock += 2 * 3600 * 1000; // 00:30 UTC on the 8th
  assert.deepEqual([t.stats().relayDay, t.stats().relaySince], [20261108, Date.UTC(2026, 10, 8)], 'the new day began at 00:00 UTC');
  clock -= 3 * 3600 * 1000; // 21:30 UTC on the 7th: a host clock set back across midnight
  assert.deepEqual([t.stats().relayDay, t.stats().relaySince], [20261107, Date.UTC(2026, 10, 7, 22, 0, 0)], 'never before the start');
  const s = t.stats();
  assert.deepEqual([s.relays, s.relayed, s.relayBytes, s.relayBusy, s.relayRate, s.joinsRefused, s.evicted], [0, 0, 0, 0, 0, 0, 0]);
});

test('DEC-1 on the tracker: a join to a full lane evicts the member that showed no life for more than 2 minutes (its message times), closes that socket with 1000 and releases it; a lane whose members are all live still answers lane full', async () => {
  let clock = Date.UTC(2026, 10, 7, 12, 0, 0);
  const t = await start({ allow: [A], now: () => clock, random: fixedRandom, pairSweepMs: 3600000 });
  const { owner, req, lane } = await pairedLane(t);
  await ask(owner, { action: 'pair-join', lane });
  await ask(req, { action: 'pair-join', lane });
  await wait(owner, (m) => m.action === 'pair-joined');
  // the requester's phone changes networks: its old socket stays open here and silent; the owner's page pings
  clock += 121 * 1000;
  owner.ws.send(PING);
  await wait(owner, (m) => m.action === 'pair-pong');
  const fresh = await connect(t);
  assert.deepEqual(await ask(fresh, { action: 'pair-join', lane, rid: 'j' }), { action: 'pair-join', lane, peers: 1, rid: 'j' }, 'the new socket takes the old one\'s place');
  assert.deepEqual(await wait(owner, (m) => m.action === 'pair-left'), { action: 'pair-left', lane, peers: 0 });
  assert.deepEqual(await wait(owner, (m) => m.action === 'pair-joined'), { action: 'pair-joined', lane, peers: 1 });
  for (let i = 0; i < 100 && req.closed === null; i++) await sleep(10);
  assert.equal(req.closed, 1000);
  assert.equal(req.closeReason, 'replaced');
  assert.deepEqual([t.stats().evicted, t.stats().relays, t.stats().joinsRefused], [1, 1, 0]);
  say(owner, { action: 'pair-relay', lane, f: 'abcd' });
  assert.deepEqual(await wait(fresh, (m) => m.action === 'pair-relayed'), { action: 'pair-relayed', lane, f: 'abcd' }, 'a frame reaches the new member');
  // both live: a third socket is refused and nobody is closed
  const third = await connect(t);
  assert.deepEqual(await ask(third, { action: 'pair-join', lane, rid: 'x' }), { action: 'pair-join', rid: 'x', 'failure reason': 'lane full' });
  assert.deepEqual([owner.closed, fresh.closed], [null, null]);
  assert.deepEqual([t.stats().evicted, t.stats().joinsRefused], [1, 1]);
  assert.equal(JSON.stringify(t.stats()).includes(lane), false);
});

test('tools/tracker.mjs --no-relay-lane: the flag is in the usage and in the JSON line, and the tracker it starts keeps the pairing and refuses the relay', async () => {
  const help = spawnSync(process.execPath, [TRACKER_CLI, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--no-relay-lane/);
  assert.match(help.stdout, /relay is off on this rendezvous/);
  const run = async (extra) => {
    const child = spawn(process.execPath, [TRACKER_CLI, '--port', '0', '--allow', A, '--json'].concat(extra), { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let out = '';
    const line = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the tracker printed nothing: ' + out)), 8000);
      child.stdout.on('data', (d) => {
        out += d.toString('utf8');
        if (out.includes('\n')) { clearTimeout(timer); resolve(out.split('\n')[0]); }
      });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error('the tracker exited ' + code + ': ' + out)); });
    });
    return { child, info: JSON.parse(line) };
  };
  const off = await run(['--no-relay-lane']);
  assert.deepEqual([off.info.pairing, off.info.relayLane], [true, false]);
  const c = await connect(off.info.url);
  assert.deepEqual(await ask(c, { action: 'pair-join', lane: 'ab'.repeat(20), rid: 'j' }), { action: 'pair-join', rid: 'j', 'failure reason': 'relay is off on this rendezvous' });
  assert.equal((await ask(c, { action: 'pair-open', channel: 'abcd', box: BOX })).channel, 'abcd', 'the pairing works');
  const on = await run([]);
  assert.deepEqual([on.info.pairing, on.info.relayLane], [true, true]);
  const d = await connect(on.info.url);
  assert.equal((await ask(d, { action: 'pair-join', lane: 'ab'.repeat(20), rid: 'j' }))['failure reason'], 'unknown lane', 'on by default (the lane is nobody\'s)');
  const none = await run(['--no-pairing']);
  assert.deepEqual([none.info.pairing, none.info.relayLane], [false, false]);
});
