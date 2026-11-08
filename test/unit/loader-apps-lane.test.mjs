// Unit tests for the relay lane of the apps (plan relay-first-2026-11-07, sections 3.5, 3.6 and 6.2; amendments A1 to A4). After the accept both
// sides join a relay lane on the pair socket they already hold, and every sealed frame of the conversation or the room goes through the
// rendezvous; direct WebRTC is a door-level opt-in beside it. What these tests hold to:
//   - the pair link (src/loader/apps-link.js): join, relay and leave, the pushes relayed, joined and left, the keepalive and its watchdog;
//   - the service (src/loader/apps.js) on the relay: the new default, the two door tokens and what they resolve to, joining right after the
//     accept, messages through the rendezvous with Delivered and Read, rooms, link drops, strikes, caps, the lifecycle hooks, typing;
//   - privacy: no report field of any event holds a lane id, a frame or a message text;
//   - the same feature bodies over both transports, the direct one and the relay one;
//   - the silent stuck state: a page that meets one of the old build, which never joins the relay lane, says so after 20 seconds in the field
//     hint of the conversation (audit 8.2, lane A, F1; polish decisions P2.D1 to D6).
// Every party is a fake on this machine (test/unit/fakes/apps-fakes.mjs): the rendezvous is the stub of the plan's section 3.1 and, when
// pair.js speaks the relay actions, the real core as well; the last group talks to tools/tracker.mjs over loopback sockets. Nothing leaves
// the machine. Run: node tools/run-unit.mjs test/unit/loader-apps-lane.test.mjs
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import WebSocket from 'ws';

import { createTracker } from '../../tools/tracker.mjs';
import {
  PairLink, createLink, reportWord, reasonWord, reasonCode, BACKOFF_MS, KEEPALIVE_MS, PONG_WAIT_MS, REQUEST_TIMEOUT_MS, RELAY_BUDGET, MESSAGE_BUDGET,
  BUDGET_WINDOW_MS, HELD_PER_LANE
} from '../../src/loader/apps-link.js';
import { createApps, LIMITS } from '../../src/loader/apps.js';
import { EXT_NAME, T, encodeFrame, sealDmBody, shortIdOf } from '../../src/loader/apps-crypto.js';
import { b64url } from '../../src/chain/canonical.js';
import { FakeLink, FakeIdentity, CoreRendezvous, coreHasRelay, makeWorld as anyWorld, makePerson, until, settle } from './fakes/apps-fakes.mjs';

// The rendezvous of these tests is the real pairing core of the Worker and the tracker (deploy/rtc-worker/pair.js, through
// CoreRendezvous) whenever pair.js speaks the relay (plan 7.2, integrate step I1). stubWorld() keeps the stub of plan 3.1 for the
// tests that change, half-way through, what the core fixes when it starts (a cap, the RELAY_LANE switch), as the Worker does.
const CORE_RELAY = !!CoreRendezvous && coreHasRelay();
const makeWorld = (opts = {}) => anyWorld(Object.assign({ core: CORE_RELAY }, opts));
const stubWorld = (opts = {}) => anyWorld(Object.assign({}, opts, { core: false }));

const clone = (v) => JSON.parse(JSON.stringify(v));
const PING = '{"v":1,"action":"pair-ping"}';

// ---------------------------------------------------------------------------------------------------------------------------------
// The pair link on its own
// ---------------------------------------------------------------------------------------------------------------------------------

let laneSeq = 0;
/** A lane the rendezvous minted (it allows joins on it for a day): 40 hex characters, made up and different each time. */
function mint (w) {
  laneSeq++;
  const lane = (laneSeq.toString(16).padStart(8, '0') + 'ab12cd34ef56ab12cd34ef56ab12cd34').slice(0, 40);
  w.rdv.lanes.set(lane, w.clock.now() + 86400000);
  return lane;
}

/** A link on the fake rendezvous that records its reports and the events of the lane: { link, got, ev, digest }. */
function linkOf (w, opts = {}) {
  const got = [];
  const ev = [];
  const link = new FakeLink(w.rdv, Object.assign({
    setTimeoutFn: w.clock.setTimeout, clearTimeoutFn: w.clock.clearTimeout, random: () => 0.5, now: w.clock.now, report: (n, f) => got.push({ name: n, fields: clone(f) })
  }, opts));
  for (const name of ['relayed', 'joined', 'left', 'gone', 'open']) link.on(name, (d) => ev.push([name, name === 'relayed' ? { lane: d.lane, kind: d.kind, bytes: Array.from(d.bytes) } : clone(d)]));
  return { link, got, ev, names: () => ev.map(([n]) => n), digest: () => got.map((r) => r.name + (r.fields.action ? ':' + r.fields.action : '') + (r.fields.name ? ':' + r.fields.name : '')) };
}

/** What the rendezvous pushes to a link, as if it were the rendezvous: any object, delivered in order with the others. */
async function pushTo (w, L, obj) {
  assert.ok(L.link._ws && L.link._ws.conn, 'the link has a socket');
  w.rdv._send(L.link._ws.conn, obj);
  await settle(3);
}

const bytesOf = (n, fill = 7) => new Uint8Array(n).fill(fill);

describe('the pair link: join, relay and leave', () => {
  test('join: the reply counts the other sockets, the second socket finds the first, the first hears pair-joined', async () => {
    const w = makeWorld();
    const lane = mint(w);
    const A = linkOf(w);
    const B = linkOf(w);
    assert.deepEqual(await A.link.join(lane, 'pair'), { ok: true, peers: 0 });
    assert.deepEqual(await B.link.join(lane, 'pair'), { ok: true, peers: 1 });
    await until(() => A.names().includes('joined'), 'the push at the first socket');
    assert.deepEqual(A.ev.filter(([n]) => n === 'joined'), [['joined', { lane, kind: 'pair', peers: 1 }]]);
    assert.equal(B.names().includes('joined'), false, 'the one who joined is not told of its own join');
    assert.deepEqual(await B.link.join(lane, 'pair'), { ok: true, peers: 1 }, 'a second join by the same socket answers with the same count');
    await settle(3);
    assert.equal(A.ev.filter(([n]) => n === 'joined').length, 1, 'and pushes nothing');
    // the request went out as the plan says: v 1, the action, the lane, a rid
    const frames = w.rdv.raw.map((t) => JSON.parse(t)).filter((m) => m.action === 'pair-join');
    assert.equal(frames.length, 3);
    for (const m of frames) assert.deepEqual(Object.keys(m).sort(), ['action', 'lane', 'rid', 'v']);
  });

  test('join refuses what is not a lane or a kind before anything is sent, and passes on the failures of the rendezvous as reason slugs', async () => {
    const w = makeWorld();
    const A = linkOf(w);
    for (const bad of ['', 'abc', 'A'.repeat(40), 'g'.repeat(40), 'a'.repeat(39), 'a'.repeat(41), null, undefined, 12, {}, ['a'.repeat(40)]]) {
      assert.deepEqual(await A.link.join(bad, 'pair'), { ok: false, reason: 'invalid-lane' }, JSON.stringify(bad));
    }
    assert.deepEqual(await A.link.join('a'.repeat(40), 'lane'), { ok: false, reason: 'kind' });
    assert.equal(w.rdv.raw.length, 0, 'nothing was sent for those');
    // a lane the rendezvous never minted, a lane that is full, too many lanes, a rendezvous with the relay off
    assert.deepEqual(await A.link.join('a'.repeat(40), 'pair'), { ok: false, reason: 'unknown-lane' });
    const lane = mint(w);
    const B = linkOf(w);
    const C = linkOf(w);
    assert.equal((await A.link.join(lane, 'pair')).ok, true);
    assert.equal((await B.link.join(lane, 'pair')).ok, true);
    assert.deepEqual(await C.link.join(lane, 'pair'), { ok: false, reason: 'lane-full' });
    for (let i = 0; i < 8; i++) assert.equal((await C.link.join(mint(w), 'pair')).ok, true, 'lane ' + (i + 1) + ' of the socket');
    assert.deepEqual(await C.link.join(mint(w), 'pair'), { ok: false, reason: 'too-many-lanes' }, 'a socket holds at most 8 lanes');
    // the switch is set when the rendezvous starts (RELAY_LANE "0", --no-relay-lane), so it is another rendezvous
    const off = makeWorld({ relayLane: false });
    const D = linkOf(off);
    assert.deepEqual(await D.link.join(mint(off), 'pair'), { ok: false, reason: 'relay-is-off-on-this-rendezvous' });
    // every one of those reasons is one a usage report may name
    for (const r of ['invalid-lane', 'unknown-lane', 'lane-full', 'too-many-lanes', 'relay-is-off-on-this-rendezvous']) assert.equal(reasonWord(r), r);
  });

  test('a join whose reply carries no sensible count is a bad reply', async () => {
    const w = makeWorld();
    const A = linkOf(w);
    const lane = mint(w);
    for (const peers of [undefined, -1, 1.5, '1', null, 65, 1e9]) {
      const orig = w.rdv.handle.bind(w.rdv);
      w.rdv.handle = (conn, m) => (m && m.action === 'pair-join' ? w.rdv._send(conn, Object.assign({ action: 'pair-join', lane, rid: m.rid }, peers === undefined ? {} : { peers })) : orig(conn, m));
      assert.deepEqual(await A.link.join(lane, 'pair'), { ok: false, reason: 'bad-reply' }, String(peers));
      w.rdv.handle = orig;
    }
  });

  test('relay: the frame crosses as bytes, the reply counts the sockets it reached, nobody listening is 0, and the reply to a request is a reply', async () => {
    const w = makeWorld();
    const lane = mint(w);
    const A = linkOf(w);
    const B = linkOf(w);
    await A.link.join(lane, 'pair');
    assert.deepEqual(await A.link.relay(lane, 'pair', bytesOf(300)), { ok: true, peers: 0 }, 'alone: the frame reached nobody');
    assert.equal(B.names().includes('relayed'), false);
    await B.link.join(lane, 'pair');
    const frame = Uint8Array.from({ length: 514 }, (_, i) => (i * 7) % 256);
    assert.deepEqual(await A.link.relay(lane, 'pair', frame), { ok: true, peers: 1 });
    await until(() => B.names().includes('relayed'), 'the frame at the other side');
    const got = B.ev.find(([n]) => n === 'relayed')[1];
    assert.deepEqual([got.lane, got.kind], [lane, 'pair']);
    assert.deepEqual(got.bytes, Array.from(frame), 'the bytes come back as they went');
    assert.equal(A.names().includes('relayed'), false, 'the sender hears nothing of its own frame');
    // the wire form: base64url without padding, in f
    const sent = w.rdv.raw.map((t) => JSON.parse(t)).filter((m) => m.action === 'pair-relay').pop();
    assert.equal(sent.f, b64url.encode(frame));
    assert.doesNotMatch(sent.f, /[=+/]/);
    // and the other way
    assert.deepEqual(await B.link.relay(lane, 'pair', bytesOf(1538, 9)), { ok: true, peers: 1 });
    await until(() => A.names().includes('relayed'), 'the frame at the first side');
    // the reply of a relay is reported like any reply, with the time it took, and its frame and lane are nowhere in a report
    const reps = A.got.filter((r) => r.name === 'reply' && r.fields.action === 'pair-relay');
    assert.equal(reps.length, 2);
    for (const r of reps) assert.ok(r.fields.ok === true && Number.isFinite(r.fields.ms) && r.fields.ms >= 0, JSON.stringify(r.fields));
    assert.ok(!JSON.stringify(A.got.concat(B.got)).includes(lane));
    assert.ok(!JSON.stringify(A.got.concat(B.got)).includes(sent.f));
  });

  test('relay refuses locally what could never go: over 7,700 characters is too-big, under 4 or not bytes is an invalid frame; 7,700 characters goes', async () => {
    const w = stubWorld(); // the stub: the test lowers the caps and turns the relay off half-way, which the core fixes when it starts
    const lane = mint(w);
    const A = linkOf(w);
    const B = linkOf(w);
    await A.link.join(lane, 'pair');
    await B.link.join(lane, 'pair');
    w.rdv.raw.length = 0;
    // 5,775 bytes are 7,700 characters; one byte more is 7,702 and is refused before a frame is made
    assert.deepEqual(await A.link.relay(lane, 'pair', bytesOf(5776)), { ok: false, reason: 'too-big' });
    assert.equal(w.rdv.raw.length, 0, 'nothing was sent');
    assert.deepEqual(await A.link.relay(lane, 'pair', bytesOf(5775)), { ok: true, peers: 1 });
    assert.equal(w.rdv.raw.length, 1);
    assert.ok(Buffer.byteLength(w.rdv.raw[0]) < 8192, 'a frame of 7,700 characters fits the 8,192 bytes of a message');
    for (const bad of [new Uint8Array(0), new Uint8Array(2), 'abcd', null, undefined, [1, 2, 3, 4], 42]) {
      assert.deepEqual(await A.link.relay(lane, 'pair', bad), { ok: false, reason: 'invalid-frame' }, String(bad));
    }
    assert.deepEqual(await A.link.relay('nope', 'pair', bytesOf(10)), { ok: false, reason: 'invalid-lane' });
    assert.deepEqual(await A.link.relay(lane, 'x', bytesOf(10)), { ok: false, reason: 'kind' });
    assert.equal(w.rdv.raw.length, 1);
    // the refusal of the too-big frame is told in a usage report as a reply, with its reason and no frame
    const r = A.got.filter((x) => x.name === 'reply' && x.fields.reason === 'too-big');
    assert.deepEqual(r.map((x) => [x.fields.action, x.fields.ok]), [['pair-relay', false]]);
    // and the failures of the rendezvous come back as slugs: not in the lane, a bad frame, too many a minute, the day cap
    const C = linkOf(w);
    assert.deepEqual(await C.link.relay(lane, 'pair', bytesOf(10)), { ok: false, reason: 'unknown-lane' });
    w.rdv.caps.relayPerMin = 2;
    assert.equal((await A.link.relay(lane, 'pair', bytesOf(10))).ok, true);
    assert.deepEqual(await A.link.relay(lane, 'pair', bytesOf(10)), { ok: false, reason: 'too-many-relays' });
    w.rdv.caps.relayPerMin = 120;
    w.rdv.caps.relayDayMax = 0;
    assert.deepEqual(await A.link.relay(lane, 'pair', bytesOf(10)), { ok: false, reason: 'relay-is-busy' });
    w.rdv.relayLane = false;
    assert.deepEqual(await A.link.relay(lane, 'pair', bytesOf(10)), { ok: false, reason: 'relay-is-off-on-this-rendezvous' });
    for (const reason of ['invalid-frame', 'too-many-relays', 'relay-is-busy', 'too-many-messages']) assert.equal(reasonWord(reason), reason);
  });

  test('leave: the other socket hears pair-left with the count that is left; leaving a lane you are not in is fine; a closed socket leaves by itself', async () => {
    const w = makeWorld();
    const lane = mint(w);
    const A = linkOf(w);
    const B = linkOf(w);
    await A.link.join(lane, 'pair');
    await B.link.join(lane, 'pair');
    assert.deepEqual(await B.link.leave(lane, 'pair'), { ok: true });
    await until(() => A.names().includes('left'), 'the push at the first socket');
    assert.deepEqual(A.ev.filter(([n]) => n === 'left'), [['left', { lane, kind: 'pair', peers: 0 }]]);
    assert.deepEqual(await B.link.leave(lane, 'pair'), { ok: true }, 'again');
    assert.deepEqual(await B.link.leave('a'.repeat(40), 'pair'), { ok: true });
    assert.deepEqual(await B.link.leave('nope', 'pair'), { ok: false, reason: 'invalid-lane' });
    assert.deepEqual(await B.link.leave(lane, 'x'), { ok: false, reason: 'kind' });
    // joined again, then the socket is lost: the rendezvous says left for it
    await B.link.join(lane, 'pair');
    await until(() => A.ev.filter(([n]) => n === 'joined').length === 2, 'joined again');
    B.link.close();
    await until(() => A.ev.filter(([n]) => n === 'left').length === 2, 'left by the close of the socket');
    assert.deepEqual(A.ev.filter(([n]) => n === 'left')[1], ['left', { lane, kind: 'pair', peers: 0 }]);
    // a link that is not open has nothing to leave and does not open a socket for it
    const D = linkOf(w);
    assert.deepEqual(await D.link.leave(lane, 'pair'), { ok: true });
    assert.equal(D.link.state, 'idle');
  });

  test('leave is ok on a timeout, like closeCode, and takes 3 seconds at most', async () => {
    const w = makeWorld();
    const lane = mint(w);
    const A = linkOf(w);
    await A.link.join(lane, 'pair');
    w.rdv.handle = () => {};
    const pending = A.link.leave(lane, 'pair');
    await settle(3);
    w.advance(3000);
    assert.equal((await pending).ok, true);
    assert.deepEqual(A.got.filter((r) => r.name === 'timeout').map((r) => r.fields), [{ action: 'pair-leave', ms: 3000 }]);
  });

  test('rooms use the room- forms: kind room in the pushes and the replies, and a room lane takes more than two', async () => {
    const w = makeWorld();
    const lane = mint(w);
    const L = [linkOf(w), linkOf(w), linkOf(w)];
    assert.deepEqual(await L[0].link.join(lane, 'room'), { ok: true, peers: 0 });
    assert.deepEqual(await L[1].link.join(lane, 'room'), { ok: true, peers: 1 });
    assert.deepEqual(await L[2].link.join(lane, 'room'), { ok: true, peers: 2 });
    await until(() => L[0].ev.filter(([n]) => n === 'joined').length === 2, 'two pushes at the first socket');
    assert.deepEqual(L[0].ev.filter(([n]) => n === 'joined').map(([, d]) => [d.kind, d.peers]), [['room', 1], ['room', 2]]);
    assert.deepEqual(await L[0].link.relay(lane, 'room', bytesOf(200)), { ok: true, peers: 2 });
    await until(() => L[1].names().includes('relayed') && L[2].names().includes('relayed'), 'the frame at both others');
    assert.equal(L[1].ev.find(([n]) => n === 'relayed')[1].kind, 'room');
    // a pair action on a room lane is not a member of it
    assert.deepEqual(await L[0].link.relay(lane, 'pair', bytesOf(200)), { ok: false, reason: 'unknown-lane' });
    assert.deepEqual(await L[0].link.leave(lane, 'room'), { ok: true });
    await until(() => L[1].ev.some(([n, d]) => n === 'left' && d.peers === 1), 'left, with the count that is left');
  });
});

// The rendezvous counts what one socket sends in a sliding minute (plan 3.2): past 120 relayed frames it refuses them, and past 150 messages of
// any kind it closes the socket, which ends every lane, code and knock of the page at once. Every lane of a page shares that one socket, so the
// link keeps its own count under those caps (RELAY_BUDGET, MESSAGE_BUDGET; finding A-3 of verify round 0) and a request that would go over waits
// for room: a page whose frames reach the rendezvous at an even pace does not trip the caps by itself. At most HELD_PER_LANE relayed frames of
// one lane wait, the next is refused at once as too-many-relays, and leaving a lane drops what waited for it (finding A-6 of verify round 1). The
// link counts each frame for BUDGET_WINDOW_MS, longer than the minute of the rendezvous, so that a network that gets a little faster cannot put
// two of the link's minutes into one of the rendezvous; one that holds frames back and then delivers them at once still can (finding C-12).
describe('the minute of the socket: the link stays under the caps of the rendezvous', () => {
  test('300 frames put on one lane at once: RELAY_BUDGET go now, HELD_PER_LANE wait and the rest are refused here at once; the rendezvous refuses nothing and never closes the socket; a join does not wait; a frame that waited is timed from its send', async () => {
    assert.ok(RELAY_BUDGET > 0 && RELAY_BUDGET < 120 && MESSAGE_BUDGET > RELAY_BUDGET && MESSAGE_BUDGET < 150, 'under the caps of the rendezvous (plan 3.2)');
    assert.ok(BUDGET_WINDOW_MS > 60000 && HELD_PER_LANE > 0 && HELD_PER_LANE < RELAY_BUDGET);
    const w = makeWorld();
    const lane = mint(w);
    const A = linkOf(w);
    const B = linkOf(w);
    await A.link.join(lane, 'pair');
    await B.link.join(lane, 'pair');
    const answers = [];
    for (let i = 0; i < 300; i++) A.link.relay(lane, 'pair', bytesOf(40, i % 200)).then((r) => answers.push(r));
    const refusedHere = 300 - RELAY_BUDGET - HELD_PER_LANE;
    await until(() => answers.length === 300 - HELD_PER_LANE, 'the frames that went and the frames refused here are answered');
    await settle(20);
    const relaysSent = () => A.link._ws.sent.filter((t) => JSON.parse(t).action === 'pair-relay').length;
    assert.deepEqual([relaysSent(), A.link._held.length], [RELAY_BUDGET, HELD_PER_LANE], 'HELD_PER_LANE wait in the link, unsent');
    assert.equal(answers.filter((r) => r.ok === true && r.peers === 1).length, RELAY_BUDGET);
    assert.deepEqual(answers.filter((r) => !r.ok), Array.from({ length: refusedHere }, () => ({ ok: false, reason: 'too-many-relays' })), 'the rest are refused at once, as the rendezvous would refuse them');
    const other = mint(w);
    assert.deepEqual(await A.link.join(other, 'pair'), { ok: true, peers: 0 }, 'a join goes at once: the minute has room for it');
    // and in the same turn, as before the minute existed: a sign-out writes its leaves and then closes the socket
    const ws = A.link._ws;
    const before = ws.sent.length;
    const leaving = A.link.leave(other, 'pair');
    assert.equal(ws.sent.length, before + 1, 'the leave was written at once, while relayed frames wait');
    assert.deepEqual(await leaving, { ok: true });
    // a frame counts in the link for BUDGET_WINDOW_MS, longer than the minute of the rendezvous (finding C-12): at 60 seconds nothing goes yet
    w.advance(60000);
    await settle(20);
    assert.equal(relaysSent(), RELAY_BUDGET, 'nothing goes at the end of the minute of the rendezvous');
    w.advance(BUDGET_WINDOW_MS - 60000);
    await until(() => answers.length === 300, 'the frames that waited');
    assert.equal(answers.filter((r) => r.ok === true && r.peers === 1).length, RELAY_BUDGET + HELD_PER_LANE);
    assert.equal(A.link._held.length, 0);
    assert.equal(A.link.state, 'open');
    assert.deepEqual(A.names().filter((n) => n === 'gone'), [], 'the socket was never closed');
    assert.equal(w.rdv.relayStats().relayRate, 0, 'the rendezvous refused nothing');
    // plan 3.5: the ms of a pair-relay reply is the relay round trip, so a frame that waited is timed from its send (finding B-4 of verify round 1)
    const replies = A.got.filter((r) => r.name === 'reply' && r.fields.action === 'pair-relay');
    assert.equal(replies.length, 300);
    assert.ok(replies.every((r) => r.fields.ms < 1000), JSON.stringify(replies.find((r) => r.fields.ms >= 1000)));
    await until(() => B.ev.filter(([n]) => n === 'relayed').length === RELAY_BUDGET + HELD_PER_LANE, 'every frame that went reached the other side, once');
  });

  // The link takes RELAY_BUDGET relayed frames in BUDGET_WINDOW_MS, fewer a minute than the rendezvous takes from a socket, so it also refuses at a
  // pace the rendezvous would still take, as docs/APPS.md says: what the page is spared is the rendezvous' refusal and its close (finding C-13 of
  // verify round 2, A-8 the same)
  test('one lane at a steady pace the rendezvous takes, 100 frames a minute: the link refuses some at once as too-many-relays, the rendezvous refuses none and never closes the socket', async () => {
    const perMin = 100;
    assert.ok(perMin < 120, 'a pace under the cap of the rendezvous (plan 3.2)');
    const w = makeWorld();
    const lane = mint(w);
    const A = linkOf(w);
    const B = linkOf(w);
    await A.link.join(lane, 'pair');
    await B.link.join(lane, 'pair');
    const answers = [];
    for (let i = 0; i < 3 * perMin; i++) { // three minutes, one frame every 600 ms of the clock
      A.link.relay(lane, 'pair', bytesOf(40, i % 200)).then((r) => answers.push(r));
      await settle(2);
      w.advance(60000 / perMin);
    }
    w.advance(BUDGET_WINDOW_MS);
    await until(() => answers.length === 3 * perMin, 'every frame is answered');
    const refused = answers.filter((r) => !r.ok);
    assert.ok(refused.length > 0, 'the link refused some');
    assert.ok(refused.every((r) => r.reason === 'too-many-relays'), JSON.stringify(refused.find((r) => r.reason !== 'too-many-relays')));
    assert.equal(answers.filter((r) => r.ok === true && r.peers === 1).length, 3 * perMin - refused.length, 'the others went');
    assert.equal(w.rdv.relayStats().relayRate, 0, 'the rendezvous refused none');
    assert.deepEqual(A.names().filter((n) => n === 'gone'), [], 'and never closed the socket');
  });

  test('leaving a lane drops the frames that wait for it at once: they answer closed and never go, and the frames of another lane keep their place', async () => {
    const w = makeWorld();
    const [l1, l2] = [mint(w), mint(w)];
    const A = linkOf(w);
    const B = linkOf(w);
    for (const lane of [l1, l2]) {
      await A.link.join(lane, 'pair');
      await B.link.join(lane, 'pair');
    }
    const first = [];
    for (let i = 0; i < RELAY_BUDGET; i++) A.link.relay(l1, 'pair', bytesOf(40, 1)).then((r) => first.push(r));
    await until(() => first.length === RELAY_BUDGET, 'the minute is full');
    const out = { l1: [], l2: [] };
    for (let i = 0; i < 3; i++) {
      A.link.relay(l1, 'pair', bytesOf(40, 2)).then((r) => out.l1.push(r));
      A.link.relay(l2, 'pair', bytesOf(40, 3)).then((r) => out.l2.push(r));
    }
    await settle(10);
    assert.equal(A.link._held.length, 6, 'three of each lane wait');
    assert.deepEqual(await A.link.leave(l1, 'pair'), { ok: true });
    await settle(10);
    assert.deepEqual(out.l1, Array.from({ length: 3 }, () => ({ ok: false, reason: 'closed' })), 'dropped at once');
    assert.equal(A.link._held.length, 3, 'the other lane keeps its place');
    assert.equal(A.link.dropHeld('ab'.repeat(20)), 0, 'a lane with nothing waiting: nothing to drop');
    w.advance(BUDGET_WINDOW_MS);
    await until(() => out.l2.length === 3, 'the other lane goes when the minute has room');
    assert.ok(out.l2.every((r) => r.ok === true && r.peers === 1), JSON.stringify(out.l2));
    const relays = A.link._ws.sent.map((t) => JSON.parse(t)).filter((m) => m.action === 'pair-relay');
    assert.equal(relays.filter((m) => m.lane === l1).length, RELAY_BUDGET, 'nothing of the lane that was left went after the leave');
    assert.equal(relays.filter((m) => m.lane === l2).length, 3);
  });

  test('a request that waited for the minute is timed from its send: with no answer it times out requestTimeoutMs after the send, not after the call', async () => {
    const w = makeWorld();
    const lane = mint(w);
    const A = linkOf(w);
    const B = linkOf(w);
    await A.link.join(lane, 'pair');
    await B.link.join(lane, 'pair');
    const first = [];
    for (let i = 0; i < RELAY_BUDGET; i++) A.link.relay(lane, 'pair', bytesOf(40, 1)).then((r) => first.push(r));
    await until(() => first.length === RELAY_BUDGET, 'the minute is full');
    let late = null;
    A.link.relay(lane, 'pair', bytesOf(40, 2)).then((r) => { late = r; });
    await settle(10);
    w.rdv.handle = () => {}; // the rendezvous answers nothing from now on
    w.advance(BUDGET_WINDOW_MS);
    await settle(10);
    assert.equal(late, null, 'it went now, after its wait, and waits for its answer');
    w.advance(REQUEST_TIMEOUT_MS - 1);
    await settle(10);
    assert.equal(late, null, 'not a moment before requestTimeoutMs after the send');
    w.advance(1);
    await until(() => late !== null, 'the timeout');
    assert.deepEqual(late, { ok: false, reason: 'timeout' });
    assert.deepEqual(A.got.filter((r) => r.name === 'timeout').map((r) => r.fields), [{ action: 'pair-relay', ms: REQUEST_TIMEOUT_MS }]);
  });

  // Finding C-12 of verify round 1: the link counts a frame when it SENDS it, the rendezvous when it ARRIVES. With the same edge on both, a network
  // whose delay shrinks between two of the link's minutes puts the second into the minute of the first at the rendezvous. Counting each frame for
  // BUDGET_WINDOW_MS covers a delay that shrinks by up to BUDGET_WINDOW_MS less a minute.
  test('a network that gets a little faster between two of the link\'s minutes does not take the socket over the caps: the second minute reaches the rendezvous after the first has left its minute', async () => {
    const w = makeWorld();
    const lanes = Array.from({ length: 8 }, () => mint(w));
    const A = linkOf(w);
    const B = linkOf(w);
    for (const lane of lanes) {
      assert.equal((await A.link.join(lane, 'pair')).ok, true);
      assert.equal((await B.link.join(lane, 'pair')).ok, true);
    }
    // from here A's frames reach the rendezvous 11 ms after they leave, and 10 ms after they leave from the 59th second on, in order (as TCP does)
    const t0 = w.clock.now();
    const ws = A.link._ws;
    let last = 0;
    ws.send = (text) => {
      ws.sent.push(text);
      const now = w.clock.now();
      const at = Math.max(last, now + (now - t0 < 59000 ? 11 : 10));
      last = at;
      w.clock.setTimeout(() => w.rdv.handleText(ws.conn, text), at - now);
    };
    const answers = [];
    for (let i = 0; i < 25; i++) for (const lane of lanes) A.link.relay(lane, 'pair', bytesOf(40, i)).then((r) => answers.push(r));
    const held = lanes.length * HELD_PER_LANE;
    await settle(20);
    assert.equal(A.link._held.length, held, 'every lane has its frames waiting');
    w.advance(11);
    await until(() => answers.length === 200 - held, 'the first minute is answered');
    // the minute of the rendezvous ends: a link that counted a frame for one minute only would send the frames that wait now, 10 ms away
    w.advance(60000 - 11);
    await settle(20);
    w.advance(10);
    await settle(20);
    w.advance(BUDGET_WINDOW_MS - 60000 - 10);
    await settle(20);
    w.advance(10);
    await until(() => answers.length === 200, 'the frames that waited are answered');
    assert.equal(answers.filter((r) => r.ok === true && r.peers === 1).length, RELAY_BUDGET + held, JSON.stringify(answers.find((r) => !r.ok && r.reason !== 'too-many-relays')));
    assert.equal(w.rdv.relayStats().relayRate, 0, 'the rendezvous refused nothing');
    assert.deepEqual(A.names().filter((n) => n === 'gone'), [], 'and never closed the socket');
    assert.equal(A.link.state, 'open');
  });

  test('past MESSAGE_BUDGET frames of any kind in a minute every request waits, a join included; one that waits fails as closed when the socket goes, and the new socket starts a minute of its own', async () => {
    const w = makeWorld();
    const lane = mint(w);
    const A = linkOf(w);
    for (let i = 0; i < MESSAGE_BUDGET; i++) assert.equal((await A.link.join(lane, 'pair')).ok, true, 'join ' + (i + 1));
    let held = null;
    const waiting = A.link.join(lane, 'pair').then((r) => { held = r; });
    await settle(20);
    assert.equal(held, null, 'the next one waits for the minute');
    assert.equal(A.link._ws.sent.length, MESSAGE_BUDGET, 'and was not sent');
    A.link.drop();
    await waiting;
    assert.deepEqual(held, { ok: false, reason: 'closed' });
    w.advance(1000); // the back off: a new socket, and a new minute at the rendezvous
    await until(() => A.link.state === 'open', 'the socket is back');
    assert.deepEqual(await A.link.join(lane, 'pair'), { ok: true, peers: 0 }, 'at once');
  });
});

describe('the pushes of the lane', () => {
  const lane = 'ab'.repeat(20);
  const f = b64url.encode(Uint8Array.from({ length: 40 }, (_, i) => i + 1));

  test('a relayed, joined or left push carries no knock and is handled all the same; each is told in a report by its name only', async () => {
    const w = makeWorld();
    const A = linkOf(w);
    await A.link.whenOpen();
    await pushTo(w, A, { action: 'pair-relayed', lane, f });
    await pushTo(w, A, { action: 'pair-joined', lane, peers: 1 });
    await pushTo(w, A, { action: 'pair-left', lane, peers: 0 });
    await pushTo(w, A, { action: 'room-relayed', lane, f });
    await pushTo(w, A, { action: 'room-joined', lane, peers: 7 });
    await pushTo(w, A, { action: 'room-left', lane, peers: 6 });
    assert.deepEqual(A.ev.filter(([n]) => n !== 'open').map(([n, d]) => [n, d.kind, d.peers === undefined ? 'bytes' : d.peers]), [
      ['relayed', 'pair', 'bytes'], ['joined', 'pair', 1], ['left', 'pair', 0], ['relayed', 'room', 'bytes'], ['joined', 'room', 7], ['left', 'room', 6]
    ]);
    assert.deepEqual(A.got.filter((r) => r.name === 'push').map((r) => r.fields), [
      { name: 'pair-relayed' }, { name: 'pair-joined' }, { name: 'pair-left' }, { name: 'room-relayed' }, { name: 'room-joined' }, { name: 'room-left' }
    ]);
    assert.ok(!JSON.stringify(A.got).includes(lane));
    assert.ok(!JSON.stringify(A.got).includes(f));
  });

  test('a push with a bad lane, a bad frame or a bad count is dropped without a word: no event, no report', async () => {
    const w = makeWorld();
    const A = linkOf(w);
    await A.link.whenOpen();
    const before = A.got.length;
    const evBefore = A.ev.length;
    const bad = [
      { action: 'pair-relayed', lane: 'short', f },
      { action: 'pair-relayed', lane: 'AB'.repeat(20), f },
      { action: 'pair-relayed', lane: lane + 'ab', f },
      { action: 'pair-relayed', lane: [lane], f },
      { action: 'pair-relayed', lane: 5, f },
      { action: 'pair-relayed', f },
      { action: 'pair-relayed', lane },
      { action: 'pair-relayed', lane, f: '' },
      { action: 'pair-relayed', lane, f: 'abc' },
      { action: 'pair-relayed', lane, f: 'a'.repeat(7701) },
      { action: 'pair-relayed', lane, f: 'ab+/' + 'a'.repeat(20) },
      { action: 'pair-relayed', lane, f: 'ab==' + 'a'.repeat(20) },
      { action: 'pair-relayed', lane, f: 'a b c d e f' },
      { action: 'pair-relayed', lane, f: 12345678 },
      { action: 'pair-relayed', lane, f: ['abcdefgh'] },
      { action: 'pair-relayed', lane, f: 'abcdefgh' + 'B' }, // a length no byte string has
      { action: 'pair-relayed', lane, f: 'AAAAAB' }, // trailing bits that are not zero: not the spelling of any bytes
      { action: 'pair-joined', lane: 'x', peers: 1 },
      { action: 'pair-joined', lane },
      { action: 'pair-joined', lane, peers: -1 },
      { action: 'pair-joined', lane, peers: 1.5 },
      { action: 'pair-joined', lane, peers: '1' },
      { action: 'pair-joined', lane, peers: null },
      { action: 'pair-joined', lane, peers: 65 },
      { action: 'pair-joined', lane, peers: 999 },
      { action: 'pair-left', lane: null, peers: 0 },
      { action: 'pair-left', lane, peers: NaN },
      { action: 'pair-left', lane, peers: 1e9 },
      { action: 'pair-left', lane }
    ];
    for (const m of bad) await pushTo(w, A, m);
    assert.equal(A.got.length, before, 'no report: ' + JSON.stringify(A.got.slice(before)));
    assert.equal(A.ev.length, evBefore, 'no event: ' + JSON.stringify(A.ev.slice(evBefore)));
    // names that are not push names are not pushes either
    for (const action of ['lane-relayed', 'pair-relayedx', 'pair-relay', 'pair-join', 'pair-leave', 'pairs-joined', 'room-relayed2', 'pair-', 'relayed']) await pushTo(w, A, { action, lane, f, peers: 1 });
    assert.equal(A.ev.length, evBefore);
    assert.equal(A.got.length, before);
    // and the link still works afterwards
    await pushTo(w, A, { action: 'pair-joined', lane, peers: 1 });
    assert.equal(A.ev.length, evBefore + 1);
  });

  test('a reply with a rid is a reply, never a push, even when its action reads like one', async () => {
    const w = makeWorld();
    const A = linkOf(w);
    await A.link.whenOpen();
    w.rdv.handle = () => {};
    const pending = A.link.request('pair-open', { channel: 'abcd', box: { iv: 'x', ct: 'y' } });
    await settle(2);
    const rid = JSON.parse(w.rdv.raw[w.rdv.raw.length - 1]).rid;
    await pushTo(w, A, { action: 'pair-relayed', lane, f, rid });
    const r = await pending;
    assert.equal(r.ok, true);
    assert.equal(A.names().includes('relayed'), false);
    assert.equal(A.got.filter((x) => x.name === 'push').length, 0);
  });
});

describe('the keepalive and its watchdog', () => {
  test('the class default is no keepalive; with keepaliveMs the exact text goes every period, without a rid, and is no request and no report', async () => {
    const w = makeWorld();
    const quiet = linkOf(w);
    await quiet.link.whenOpen();
    w.advance(10 * 60000);
    assert.equal(w.rdv.raw.length, 0, 'the default sends no ping');
    const A = linkOf(w, { keepaliveMs: 50000 });
    await A.link.whenOpen();
    assert.equal(A.link.keepaliveMs, 50000);
    assert.equal(KEEPALIVE_MS, 50000);
    assert.equal(w.rdv.raw.length, 0);
    for (let i = 1; i <= 3; i++) {
      w.advance(50000);
      await settle(3);
      assert.equal(w.rdv.raw.length, i);
    }
    for (const text of w.rdv.raw) assert.equal(text, PING, 'this byte string, no rid, no spaces');
    assert.deepEqual(A.got.map((r) => r.name).filter((n) => n === 'sent' || n === 'reply' || n === 'push' || n === 'timeout'), [], 'a ping is no traffic and no report');
    assert.equal(A.link.state, 'open', 'the pongs came');
  });

  test('a socket that answers nothing within 10 seconds is half open: the link treats it as lost and reconnects with its back off', async () => {
    const w = makeWorld();
    const A = linkOf(w, { keepaliveMs: 50000 });
    await A.link.whenOpen();
    w.rdv.pongs = false;
    w.advance(50000);
    await settle(3);
    assert.equal(A.link.state, 'open', 'not yet: a pong may still come');
    w.advance(9999);
    await settle(3);
    assert.equal(A.link.state, 'open');
    w.advance(1);
    await settle(3);
    assert.equal(A.link.state, 'backoff');
    assert.deepEqual(A.got.filter((r) => r.name === 'gone').map((r) => r.fields), [{ why: 'no-pong' }]);
    assert.deepEqual(A.got.filter((r) => r.name === 'backoff').map((r) => r.fields), [{ attempt: 1, ms: BACKOFF_MS[0], why: 'no-pong' }]);
    assert.ok(A.names().includes('gone'));
    w.rdv.pongs = true;
    w.advance(BACKOFF_MS[0]);
    await until(() => A.link.state === 'open', 'the link is back');
    assert.deepEqual(A.got.filter((r) => r.name === 'open').map((r) => r.fields), [{ attempt: 0 }, { attempt: 1 }]);
    const pings = w.rdv.raw.filter((t) => t === PING).length;
    w.advance(50000);
    await settle(3);
    assert.equal(w.rdv.raw.filter((t) => t === PING).length, pings + 1, 'the keepalive runs again on the new socket');
    assert.equal(A.link.state, 'open');
  });

  test('any other frame in the 10 seconds counts as an answer: the socket is alive; a pong with a payload is a pong; a pong is no event', async () => {
    const w = makeWorld();
    const A = linkOf(w, { keepaliveMs: 50000 });
    await A.link.whenOpen();
    w.rdv.pongs = false;
    w.advance(50000);
    await settle(3);
    await pushTo(w, A, { action: 'pair-joined', lane: 'ab'.repeat(20), peers: 1 });
    w.advance(10000);
    await settle(3);
    assert.equal(A.link.state, 'open', 'a push is an answer');
    w.advance(40000);
    await settle(3);
    await pushTo(w, A, { action: 'pair-pong', junk: 'x'.repeat(100), peers: 5, f: 'abcdefgh' });
    w.advance(10000);
    await settle(3);
    assert.equal(A.link.state, 'open', 'a pong with a payload is a pong');
    assert.deepEqual(A.names().filter((n) => n !== 'open' && n !== 'joined'), []);
    assert.deepEqual(A.got.filter((r) => r.name === 'push').map((r) => r.fields.name), ['pair-joined'], 'the pong is no push in a report');
  });

  test('close() and a lost socket stop the keepalive and the watchdog', async () => {
    const w = makeWorld();
    const A = linkOf(w, { keepaliveMs: 50000 });
    await A.link.whenOpen();
    A.link.close();
    w.rdv.raw.length = 0;
    w.advance(10 * 50000);
    await settle(3);
    assert.equal(w.rdv.raw.length, 0);
    assert.equal(A.link.state, 'idle');
    const B = linkOf(w, { keepaliveMs: 50000 });
    await B.link.whenOpen();
    w.rdv.pongs = false;
    w.advance(50000);
    B.link.close(); // the watchdog was armed: it must not fire on a closed link
    w.advance(10000);
    await settle(3);
    assert.equal(B.link.state, 'idle');
    assert.equal(B.got.filter((r) => r.name === 'backoff').length, 0);
  });
});

describe('the reasons a report may name', () => {
  test('the nine reasons of the relay are on the list, and a text of a rendezvous that is not is "other"', () => {
    const nine = ['invalid-lane', 'unknown-lane', 'lane-full', 'too-many-lanes', 'relay-is-off-on-this-rendezvous', 'invalid-frame', 'too-many-relays', 'relay-is-busy', 'too-many-messages'];
    for (const r of nine) assert.equal(reasonWord(r), r);
    for (const text of ['invalid lane', 'unknown lane', 'lane full', 'too many lanes', 'relay is off on this rendezvous', 'invalid frame', 'too many relays', 'relay is busy', 'too many messages']) {
      assert.equal(reasonWord(reasonCode(text)), reasonCode(text), text);
    }
    assert.equal(reasonWord(reasonCode('relay is busy for Ferdle Morrow at the mill')), 'other');
    assert.equal(reportWord('pair-relay'), 'pair-relay');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The service on the relay
// ---------------------------------------------------------------------------------------------------------------------------------

const URL_OK = 'wss://rendezvous.invalid/';
const made = [];
afterEach(() => {
  for (const X of made.splice(0)) {
    try { X.apps.destroy(); } catch (_) { /* gone */ }
  }
});

/** A person on the fake world with every report recorded (person.reports): the door is { relay, direct } or { config }. */
async function mk (w, name, opts = {}) {
  const X = await w.make(name, Object.assign({ reports: true }, opts));
  made.push(X);
  return X;
}

const RELAY = { relay: 'rendezvous', direct: 'off' }; // the shipped default, spelled out
const BOTH = { relay: 'rendezvous', direct: 'on' };
const LEGACY = { relay: 'none' }; // the transport of before the relay: direct only
const st = (X) => X.apps.state();
const conv = (X, i = 0) => st(X).conversations[i];
const isConnected = (X, i = 0) => { const c = conv(X, i); return !!c && c.status === 'connected'; };
const laneOf = (X, i = 0) => Array.from(X.apps.lanes.keys())[i];
const connOf = (X) => X.link._ws.conn.id;
/** how many frames of an action this person's socket sent to the rendezvous, from the rendezvous' log */
const sentBy = (w, X, action) => w.rdv.log.filter((e) => e.conn === connOf(X) && e.action === action).length;
const framesOf = (w, action) => w.rdv.raw.map((t) => JSON.parse(t)).filter((m) => m.action === action);
/** Waits until this person's socket has stopped sending frames of an action (the work of the last step is done) and says how many it has sent. */
async function quiet (w, X, action = 'pair-relay') {
  let last = -1;
  for (let i = 0; i < 150; i++) {
    const now = sentBy(w, X, action);
    if (now === last) return now;
    last = now;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return last;
}

/** Holds X's joins until the returned function is called: before they are sent, or (replyOnly) their answers on the way back; which(n) picks the nth. */
function gateJoin (X, { replyOnly = false, which = () => true } = {}) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const join = X.link.join.bind(X.link);
  let calls = 0;
  X.link.join = (lane, kind) => {
    calls++;
    if (!which(calls)) return join(lane, kind);
    return replyOnly ? join(lane, kind).then(async (r) => { await gate; return r; }) : gate.then(() => join(lane, kind));
  };
  return release;
}

/** A owns a code, B knocks, A accepts; resolves when both show connected. The door is the same for both. */
async function pairUp (w, door = RELAY, { names = ['Alice', 'Bob'], limits } = {}) {
  const A = await mk(w, names[0], Object.assign({ limits }, door));
  const B = await mk(w, names[1], Object.assign({ limits }, door));
  const { code } = await A.apps.openCode();
  const k = await B.apps.knock(code);
  assert.ok(k.knock, JSON.stringify(k));
  await until(() => st(A).requests.length === 1, 'the request');
  const acc = await A.apps.accept(st(A).requests[0].knock);
  assert.ok(acc.id, JSON.stringify(acc));
  await until(() => isConnected(A) && isConnected(B), 'both connected');
  return { A, B, code, a: conv(A).id, b: conv(B).id };
}

/** The FakeWire that person X writes on, on the first live lane of the world. */
function wireOf (w, X) {
  for (const pairs of w.net.pairs.values()) {
    for (const p of pairs.values()) {
      if (p.a.name === X.name && !p.wa.destroyed) return p.wa;
      if (p.b.name === X.name && !p.wb.destroyed) return p.wb;
    }
  }
  return null;
}

/** every string a report may not hold: the lanes and the sealed frames the rendezvous saw, and what the people said */
function forbiddenOf (w, extra = []) {
  const frames = w.rdv.raw.map((t) => JSON.parse(t)).filter((m) => typeof m.f === 'string').map((m) => m.f);
  return Array.from(w.rdv.lanes.keys()).concat(Array.from(w.rdv.relays.keys()), frames, extra);
}

/**
 * The privacy rule of the plan's section 2 over every report of these people: a name of the allowed shape, flat fields, none of `forbidden`
 * inside any value, and no field but the local ids holds a run of nine hex characters (the lane id is 40; the reporter masks it at 8).
 */
function scan (people, forbidden) {
  let checked = 0;
  for (const X of people) {
    for (const r of X.reports) {
      const where = X.name + ' ' + r.name + ' ' + JSON.stringify(r.fields);
      assert.match(r.name, /^[a-z][a-z0-9.-]{1,48}$/, where);
      for (const [k, v] of Object.entries(r.fields)) {
        assert.ok(typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean', where);
        if (typeof v !== 'string') continue;
        checked++;
        assert.ok(v.length <= 64, where);
        for (const bad of forbidden) assert.ok(!v.toLowerCase().includes(String(bad).toLowerCase()), where + ' carries ' + String(bad).slice(0, 12));
        if (k !== 'id' && k !== 'conv') assert.doesNotMatch(v, /[0-9a-f]{9,}/i, where);
      }
    }
  }
  assert.ok(checked > 10, 'the scan looked at something: ' + checked);
}

/** The owner makes a room, each of the others asks to join and is accepted; resolves when every member holds the room secret. */
async function roomUp (w, door, names = ['Olive', 'Mia', 'Max']) {
  const O = await mk(w, names[0], door);
  const Ms = [];
  for (const name of names.slice(1)) Ms.push(await mk(w, name, door));
  const r = await O.apps.createRoom();
  assert.ok(r.id, JSON.stringify(r));
  const ids = [];
  for (const M of Ms) {
    const j = await M.apps.joinRoom(r.code);
    assert.ok(j.id, JSON.stringify(j));
    ids.push(j.id);
  }
  await until(() => st(O).requests.length === Ms.length, 'the join requests');
  for (const q of st(O).requests.slice()) assert.equal((await O.apps.acceptMember(q.knock)).id, r.id);
  const roomOf = (X, id) => st(X).rooms.find((x) => x.id === id);
  await until(() => Ms.every((M, i) => roomOf(M, ids[i]).status === 'connected'), 'every member holds the key');
  return { O, Ms, id: r.id, ids, code: r.code, roomOf };
}

describe('the door tokens', () => {
  test('relay and direct resolve as the amendment A2 says, and state().cfg shows the resolved values', async () => {
    const w = makeWorld();
    const person = await makePerson('Alice');
    const table = [
      [{}, 'rendezvous', 'off'], [{ relay: 'rendezvous' }, 'rendezvous', 'off'], [{ relay: 'rendezvous', direct: 'off' }, 'rendezvous', 'off'],
      [{ relay: 'rendezvous', direct: 'on' }, 'rendezvous', 'on'], [{ direct: 'on' }, 'rendezvous', 'on'], [{ direct: 'off' }, 'rendezvous', 'off'],
      [{ relay: 'none' }, 'none', 'on'], [{ relay: 'none', direct: 'on' }, 'none', 'on'], [{ relay: 'none', direct: 'off' }, 'none', 'off'],
      [{ relay: 'bogus', direct: 'bogus' }, 'rendezvous', 'off'], [{ relay: 'bogus' }, 'rendezvous', 'off'], [{ relay: 'none', direct: 'bogus' }, 'none', 'on'],
      [{ relay: 5, direct: true }, 'rendezvous', 'off'], [{ relay: null, direct: null }, 'rendezvous', 'off']
    ];
    for (const [tokens, relay, direct] of table) {
      const flat = createApps({ api: { identity: new FakeIdentity(person) }, config: Object.assign({ rendezvous: [URL_OK] }, tokens), WebSocketImpl: w.rdv.socketClass() });
      assert.deepEqual(flat.state().cfg, { relay, direct }, JSON.stringify(tokens));
      flat.destroy();
      // the apps block may sit under config.apps, and the three fields may be passed beside config: the tokens come along either way
      const nested = createApps({ api: { identity: new FakeIdentity(person) }, config: { apps: Object.assign({ rendezvous: [URL_OK] }, tokens) }, WebSocketImpl: w.rdv.socketClass() });
      assert.deepEqual(nested.state().cfg, { relay, direct }, 'nested ' + JSON.stringify(tokens));
      nested.destroy();
      const beside = createApps({ api: { identity: new FakeIdentity(person) }, config: tokens, rendezvous: [URL_OK], WebSocketImpl: w.rdv.socketClass() });
      assert.deepEqual(beside.state().cfg, { relay, direct }, 'beside ' + JSON.stringify(tokens));
      beside.destroy();
    }
    const none = createApps({ api: { identity: new FakeIdentity(person) } });
    assert.deepEqual(none.state().cfg, { relay: 'rendezvous', direct: 'off' }, 'no configuration at all is the new default');
    none.destroy();
  });

  test('a person made on the fake world with no relay key at all is the new default; the world itself is the legacy door', async () => {
    const w = makeWorld();
    const legacy = await mk(w, 'Alice');
    assert.deepEqual(st(legacy).cfg, { relay: 'none', direct: 'on' }, 'the fake world keeps the older bodies on the direct transport');
    const fresh = await mk(w, 'Bob', { config: { relay: undefined } });
    assert.deepEqual(st(fresh).cfg, { relay: 'rendezvous', direct: 'off' });
    const both = await mk(w, 'Carol', BOTH);
    assert.deepEqual(st(both).cfg, { relay: 'rendezvous', direct: 'on' });
  });

  test('the service makes its pair socket with the keepalive of 50 seconds unless the caller says otherwise; its own url and clocks win', async () => {
    const w = makeWorld();
    const person = await makePerson('Alice');
    const options = [];
    const mkApps = (extra) => {
      const apps = createApps(Object.assign({
        api: { identity: new FakeIdentity(person) }, config: { rendezvous: [URL_OK] }, WebSocketImpl: w.rdv.socketClass(), now: w.clock.now,
        setTimeoutFn: w.clock.setTimeout, clearTimeoutFn: w.clock.clearTimeout, random: () => 0.5,
        createLink: (opts) => { options.push(opts); return new PairLink(opts); }
      }, extra));
      made.push({ apps });
      return apps;
    };
    assert.ok((await mkApps({}).openCode()).code);
    assert.equal(options[0].keepaliveMs, 50000);
    assert.ok((await mkApps({ linkOptions: { keepaliveMs: 0, url: 'wss://not-this-one.invalid/' } }).openCode()).code);
    assert.equal(options[1].keepaliveMs, 0, 'the caller may turn it off');
    assert.equal(options[1].url, URL_OK, 'the rendezvous of the apps block, not the one of the options');
  });
});

describe('after the accept: the relay is joined, the manager is not made', () => {
  test('the new default: both sides join the lane right after the accept, no manager is loaded, no peer connection is made, the path is the relay', async () => {
    const w = makeWorld();
    const A = await mk(w, 'Alice', { config: { relay: undefined } });
    const B = await mk(w, 'Bob', { config: { relay: undefined } });
    const { code } = await A.apps.openCode();
    await B.apps.knock(code);
    await until(() => st(A).requests.length === 1, 'the request');
    await settle(8);
    assert.equal(framesOf(w, 'pair-join').length, 0, 'before the accept nothing is joined');
    assert.equal(w.rdv.relays.size, 0);
    const acc = await A.apps.accept(st(A).requests[0].knock);
    assert.ok(acc.id);
    await until(() => isConnected(A) && isConnected(B), 'both connected');
    const lane = Array.from(w.rdv.lanes.keys())[0];
    const joins = framesOf(w, 'pair-join');
    assert.equal(joins.length, 2, 'one join each');
    assert.ok(joins.every((m) => m.lane === lane && m.v === 1 && typeof m.rid === 'string'));
    assert.deepEqual([A.loadCalls.length, B.loadCalls.length], [0, 0], 'direct is off: no manager is loaded');
    assert.deepEqual([A.tm.joined.length, B.tm.joined.length, A.tm.extensions.size, B.tm.extensions.size], [0, 0, 0, 0]);
    assert.equal(w.net.frames.length, 0);
    assert.equal(w.net.pairs.size, 0, 'and no wire exists');
    assert.deepEqual([st(A).tm, st(B).tm], [false, false]);
    assert.deepEqual([conv(A).via, conv(B).via], ['relay', 'relay']);
    assert.deepEqual(st(A).cfg, { relay: 'rendezvous', direct: 'off' });
    assert.equal(w.rdv.relays.get(lane).members.size, 2);
  });

  test('a door with relay none joins nothing and goes the direct way as before', async () => {
    const w = makeWorld();
    const { A, B } = await pairUp(w, LEGACY);
    assert.equal(framesOf(w, 'pair-join').length, 0);
    assert.equal(framesOf(w, 'pair-relay').length, 0);
    assert.equal(w.rdv.relays.size, 0);
    assert.deepEqual([A.loadCalls.length, B.loadCalls.length], [1, 1]);
    assert.equal(A.tm.joined.length, 1);
    assert.deepEqual([conv(A).via, conv(B).via], ['direct', 'direct']);
    assert.deepEqual(A.reports.filter((r) => r.name === 'apps.lane'), [], 'and no relay event is reported');
  });

  test('a message crosses through the relay: the other side shows it and acks it, Delivered, then Read when they read it, as over a wire', async () => {
    const w = makeWorld();
    const { A, B, a, b } = await pairUp(w, RELAY);
    const sent = await A.apps.send(a, 'meet me at the old mill at noon');
    await until(() => conv(B).messages.length === 1, 'the message at the other side');
    assert.equal(conv(B).messages[0].text, 'meet me at the old mill at noon');
    await until(() => conv(A).messages[0].status === 'delivered', 'the ack');
    await B.apps.markRead(b);
    await until(() => conv(A).messages[0].status === 'read', 'the read receipt');
    await B.apps.send(b, 'bring the blue folder please');
    await until(() => conv(A).messages.length === 2 && conv(B).messages.find((m) => m.mine).status === 'delivered', 'the answer, delivered');
    assert.equal(conv(A).messages[0].id, sent.id);
    assert.equal(w.net.frames.length, 0, 'nothing went over a wire');
    assert.ok(w.rdv.relayStats().relayed >= 6, 'the frames went through the rendezvous: ' + JSON.stringify(w.rdv.relayStats()));
    assert.equal(w.rdv.relayStats().relayBusy + w.rdv.relayStats().relayRate, 0);
    // the rendezvous saw sealed frames of the three classes of size, never the text
    const seen = JSON.stringify(w.rdv.raw);
    assert.ok(!seen.includes('old mill') && !seen.includes('blue folder'));
  });

  test('direct on with a network that cannot connect: the manager is made, no wire comes, the relay carries the conversation', async () => {
    const w = makeWorld();
    w.net.canConnect = () => false;
    const { A, B, a } = await pairUp(w, BOTH);
    assert.deepEqual([A.loadCalls.length, B.loadCalls.length], [1, 1], 'the manager is loaded after the accept when direct is on');
    assert.equal(w.net.wiresOf(laneOf(A)).length, 0, 'no wire');
    assert.deepEqual([conv(A).via, conv(B).via], ['relay', 'relay']);
    await A.apps.send(a, 'through the rendezvous');
    await until(() => conv(B).messages.length === 1 && conv(A).messages[0].status === 'delivered', 'delivered');
    assert.ok(w.rdv.relayStats().relayed >= 3);
  });

  test('direct on with a network that connects: the direct wire is preferred, via becomes direct, and a frame that came by both paths shows once', async () => {
    const w = makeWorld();
    const { A, B, a } = await pairUp(w, BOTH);
    await until(() => conv(A).via === 'direct' && conv(B).via === 'direct', 'the direct wire is up and preferred');
    const lane = laneOf(A);
    const before = w.rdv.relayStats().relayed;
    await A.apps.send(a, 'this goes by the wire');
    await until(() => conv(B).messages.length === 1 && conv(A).messages[0].status === 'delivered', 'delivered');
    assert.equal(w.rdv.relayStats().relayed, before, 'a ready direct wire carries everything: the relay is idle');
    // the same sealed frame by the wire and by the rendezvous: shown once
    const now = w.clock.now();
    const sealed = await sealDmBody({ keys: A.person.keys, peerEk: B.person.keys.chat.pub, body: { k: 'msg', id: 'TWICETWICETWICE1', t: now, text: 'by both paths', fmt: 'md1' }, now, n: 900 });
    const bytes = encodeFrame(T.DM, sealed.payload);
    wireOf(w, A).extended(EXT_NAME, bytes);
    assert.deepEqual(await A.link.relay(lane, 'pair', bytes), { ok: true, peers: 1 });
    await until(() => conv(B).messages.some((m) => m.text === 'by both paths'), 'the frame at B');
    await settle(10);
    assert.equal(conv(B).messages.filter((m) => m.text === 'by both paths').length, 1);
    assert.equal(conv(B).unread, 2, 'two messages in all');
  });

  // Plan 3.6: every change of the relay path between usable and not usable moves the conversation's epoch, so that _flush sends again what the
  // other path never acked. A direct wire that dies while the relay is out of use moves nothing (there is no path left to send on): only the
  // relay coming back can, and without its move the message lost on the wire would wait for a later change (finding B-1 of verify round 0).
  test('a message the direct wire took and lost goes again, once, through the relay when the relay comes back after that wire died', async () => {
    const w = makeWorld();
    const { A, B, a } = await pairUp(w, BOTH);
    await until(() => conv(A).via === 'direct' && conv(B).via === 'direct', 'the direct wire is preferred');
    const recA = A.apps.lanes.get(laneOf(A));
    assert.ok(recA && recA.p.rst, 'A holds a relay path for the conversation');
    // B's socket goes: A's relay is out of use and A talks on the direct wire alone
    B.link.drop();
    await until(() => !recA.p.rst.ready, 'A: the relay is out of use');
    assert.equal(conv(A).via, 'direct');
    // from now on the direct wire loses every frame: A writes, the frame goes on the wire and is lost there
    w.net.drops = () => true;
    await A.apps.send(a, 'lost on the wire');
    await until(() => conv(A).messages[0].status === 'sent', 'sent on the direct wire');
    // the wire dies and none can come up again: A has no path left and is connecting
    w.net.canConnect = () => false;
    w.net.pause();
    w.net.dropAll();
    await until(() => conv(A).status === 'connecting', 'A is connecting');
    // B's socket is back after its back off and joins the lane: the relay is usable again, and the message goes again through it
    w.advance(1000);
    await until(() => recA.p.rst.ready, 'A: the relay is usable again');
    await until(() => conv(B).messages.length === 1 && conv(A).messages[0].status === 'delivered', 'the message reached B through the relay', 4000);
    await settle(10);
    assert.equal(conv(B).messages.length, 1, 'shown once');
    assert.ok(w.rdv.relayStats().relayed > 0, 'it went through the relay');
  });

  test('direct off constructs no manager: loadTm is never called, FakeNetwork.canConnect is not even asked, whatever the network can do', async () => {
    const w = makeWorld();
    let asked = 0;
    w.net.canConnect = () => { asked++; return true; };
    const { A, B, a } = await pairUp(w, { relay: 'rendezvous', direct: 'off' });
    await A.apps.send(a, 'no manager');
    await until(() => conv(B).messages.length === 1, 'delivered');
    assert.deepEqual([A.loadCalls.length, B.loadCalls.length, asked], [0, 0, 0]);
    assert.deepEqual([A.tm.joined, B.tm.joined], [[], []]);
    // the same with the shipped default, which says nothing of direct
    const w2 = makeWorld();
    const P = await pairUp(w2, { config: { relay: undefined } });
    assert.deepEqual([P.A.loadCalls.length, P.B.loadCalls.length], [0, 0]);
  });
});

describe('the relay going away and coming back', () => {
  test('the other side leaves: the path is down and the conversation connecting; a message waits; when they are back it goes once, and is acked', async () => {
    const w = makeWorld();
    const { A, B, a } = await pairUp(w, RELAY);
    A.reports.length = 0;
    B.link.drop(); // the rendezvous loses B's socket: A hears pair-left
    await until(() => conv(A).status === 'connecting', 'A sees the other side go');
    assert.equal(conv(A).via, null);
    assert.deepEqual(A.reports.filter((r) => r.name === 'apps.wire').map((r) => r.fields), [{ conv: a, ev: 'down', kind: 'pair', via: 'relay', reason: 'peer-left' }]);
    assert.deepEqual(A.reports.filter((r) => r.name === 'apps.lane').map((r) => r.fields), [{ ev: 'left', peers: 0 }]);
    assert.deepEqual(A.reports.filter((r) => r.name === 'apps.conv').map((r) => r.fields), [{ id: a, status: 'connecting', incoming: true }]);
    const sent = await A.apps.send(a, 'written while you were away');
    await settle(8);
    assert.equal(conv(A).messages[0].status, 'queued', 'nothing can go while nobody is in the lane');
    const before = sentBy(w, A, 'pair-relay');
    w.advance(1000); // B backs off one second, opens the socket again and joins the lane again
    await until(() => conv(B).messages.length === 1, 'the message arrives when B is back');
    await until(() => conv(A).messages[0].status === 'delivered', 'and is acked');
    assert.equal(conv(B).messages[0].id, sent.id);
    assert.equal(conv(B).messages.length, 1, 'shown once');
    assert.equal(await quiet(w, A) - before, 3, 'A put on the relay its name, its settings and the message, once each');
    assert.equal(await quiet(w, B), 3, 'and B, on its new socket, its name, its settings and one ack');
    assert.equal(conv(B).messages.length, 1, 'still once');
    assert.deepEqual(A.reports.filter((r) => r.name === 'apps.wire').map((r) => r.fields.ev + ':' + r.fields.via), ['down:relay', 'up:relay']);
    await until(() => isConnected(A) && isConnected(B), 'both connected again');
    assert.deepEqual([conv(A).via, conv(B).via], ['relay', 'relay']);
  });

  test('a link drop and reopen joins the lanes again, newest first and at most as many as the socket may hold, and what nobody acked goes again', async () => {
    const w = makeWorld({ caps: { lanesPerSocket: 2 } }); // the Worker allows 8; the test shortens both ends the same way
    const A = await mk(w, 'Alice', Object.assign({ limits: { relayLanesMax: 2 } }, RELAY));
    const Bs = [];
    for (const name of ['Bea', 'Bo', 'Bi']) Bs.push(await mk(w, name, RELAY));
    const { code } = await A.apps.openCode();
    for (const B of Bs) await B.apps.knock(code);
    await until(() => st(A).requests.length === 3, 'three requests');
    for (const q of st(A).requests.slice()) assert.ok((await A.apps.accept(q.knock)).id);
    await until(() => st(A).conversations.length === 3, 'three conversations');
    await until(() => st(A).conversations.filter((c) => c.status === 'connected').length === 2, 'two are connected');
    // the third lane did not fit the socket: it is told as full and waits
    const full = A.reports.filter((r) => r.name === 'apps.lane' && r.fields.ev === 'full');
    assert.equal(full.length, 1);
    const lanes = Array.from(A.apps.lanes.keys());
    assert.equal(lanes.length, 3);
    const waiting = st(A).conversations.find((c) => c.status === 'connecting');
    assert.ok(waiting);
    // an unacked message on the first conversation, then the socket is lost and comes back
    const first = st(A).conversations[0];
    A.link.drop();
    await until(() => A.link.state === 'backoff', 'A lost its socket');
    const sent = await A.apps.send(first.id, 'not acked yet, or acked: either way it is shown once');
    w.advance(1000);
    await until(() => A.link.state === 'open', 'A is back');
    await until(() => A.link._ws.sent.filter((t) => JSON.parse(t).action === 'pair-join').length === 2, 'two joins on the new socket');
    const joins = A.link._ws.sent.map((t) => JSON.parse(t)).filter((m) => m.action === 'pair-join').map((m) => m.lane);
    assert.deepEqual(joins, [lanes[2], lanes[1]], 'newest first, and only as many as the socket holds');
    assert.equal(A.link._ws.sent.some((t) => JSON.parse(t).action === 'pair-join' && JSON.parse(t).lane === lanes[0]), false, 'the oldest waits');
    assert.equal(LIMITS.relayLanesMax, 8, 'the shipped number is the Worker\'s cap of lanes for a socket');
    assert.ok(sent.id);
  });

  // Plan 3.6 and docs/APPS.md: the lanes beyond the socket's cap join when one of the others ends. A lane that was joined before the socket went
  // and that the reopen left out must wait for that place too, not until the socket goes again (finding A-1 of verify round 0).
  test('after a reopen, a lane the socket had no place for joins when one of the joined lanes ends', async () => {
    const w = makeWorld({ caps: { lanesPerSocket: 2 } }); // both ends shortened the same way, as above
    const A = await mk(w, 'Alice', Object.assign({ limits: { relayLanesMax: 2 } }, RELAY));
    const Bs = [];
    for (const name of ['Bea', 'Bo', 'Bi']) Bs.push(await mk(w, name, RELAY));
    const { code } = await A.apps.openCode();
    for (const B of Bs) await B.apps.knock(code);
    await until(() => st(A).requests.length === 3, 'three requests');
    for (const q of st(A).requests.slice()) assert.ok((await A.apps.accept(q.knock)).id);
    const connected = () => st(A).conversations.filter((c) => c.status === 'connected');
    await until(() => connected().length === 2, 'two connected before the drop');
    A.link.drop();
    await until(() => A.link.state === 'backoff', 'A lost its socket');
    w.advance(1000);
    await until(() => A.link.state === 'open', 'A is back');
    await until(() => connected().length === 2, 'two connected after the reopen');
    const out = st(A).conversations.find((c) => c.status !== 'connected');
    assert.ok(out, 'one conversation did not fit the socket');
    assert.deepEqual(await A.apps.leave(connected()[0].id), { ok: true });
    await until(() => st(A).conversations.find((c) => c.id === out.id).status === 'connected', 'the conversation left out got the place that came free');
    assert.equal(st(A).conversations.find((c) => c.id === out.id).via, 'relay');
    assert.equal(A.link._ws.conn.joined.size, 2, 'and the socket holds its 2 lanes');
  });

  test('the numbers as shipped: a socket holds 8 lanes, a ninth conversation waits for a place and gets it when one of the others ends', async () => {
    const w = makeWorld();
    const A = await mk(w, 'Alice', RELAY);
    const Bs = [];
    for (let i = 1; i <= 9; i++) Bs.push(await mk(w, 'Bo' + i, RELAY));
    const { code } = await A.apps.openCode();
    for (const B of Bs) assert.ok((await B.apps.knock(code)).knock);
    await until(() => st(A).requests.length === 9, 'nine requests');
    for (const q of st(A).requests.slice()) assert.ok((await A.apps.accept(q.knock)).id);
    await until(() => st(A).conversations.filter((c) => c.status === 'connected').length === 8, 'eight are connected');
    await settle(10);
    assert.equal(A.link._ws.conn.joined.size, 8, 'the socket holds 8 lanes at the rendezvous');
    assert.equal(A.reports.filter((r) => r.name === 'apps.lane' && r.fields.ev === 'full').length, 1, 'and the ninth was told as full, once');
    const waiting = st(A).conversations.find((c) => c.status !== 'connected');
    assert.equal(waiting.status, 'connecting');
    assert.equal(waiting.via, null);
    const gone = st(A).conversations.find((c) => c.status === 'connected');
    assert.deepEqual(await A.apps.leave(gone.id), { ok: true });
    await until(() => st(A).conversations.find((c) => c.id === waiting.id).status === 'connected', 'the ninth got the place');
    assert.equal(A.link._ws.conn.joined.size, 8);
    assert.equal(A.reports.filter((r) => r.name === 'apps.lane' && r.fields.ev === 'full').length, 1, 'and nothing else was refused');
  });

  test('a lane that did not fit is joined when one of the others ends', async () => {
    const w = makeWorld({ caps: { lanesPerSocket: 2 } });
    const A = await mk(w, 'Alice', Object.assign({ limits: { relayLanesMax: 2 } }, RELAY));
    const Bs = [];
    for (const name of ['Bea', 'Bo', 'Bi']) Bs.push(await mk(w, name, RELAY));
    const { code } = await A.apps.openCode();
    for (const B of Bs) await B.apps.knock(code);
    await until(() => st(A).requests.length === 3, 'three requests');
    for (const q of st(A).requests.slice()) assert.ok((await A.apps.accept(q.knock)).id);
    await until(() => st(A).conversations.filter((c) => c.status === 'connected').length === 2, 'two are connected');
    const waiting = st(A).conversations.find((c) => c.status === 'connecting');
    const connected = st(A).conversations.find((c) => c.status === 'connected');
    assert.deepEqual(await A.apps.leave(connected.id), { ok: true });
    await until(() => st(A).conversations.find((c) => c.id === waiting.id).status === 'connected', 'the waiting conversation got the place');
    assert.equal(st(A).conversations.find((c) => c.id === waiting.id).via, 'relay');
  });

  test('strikes on garbage over the relay close the relay path of the lane and say so; the manager is never told; the next open of the socket starts it clean', async () => {
    const w = makeWorld();
    w.net.canConnect = () => false; // direct on, but no wire: the manager must stay out of it
    const { A, B, a } = await pairUp(w, BOTH);
    const lane = laneOf(A);
    A.reports.length = 0;
    for (let i = 0; i < 3; i++) assert.deepEqual(await B.link.relay(lane, 'pair', new Uint8Array(40).fill(7)), { ok: true, peers: 1 });
    await until(() => conv(A).status === 'connecting', 'the relay path is closed');
    assert.deepEqual(A.reports.filter((r) => r.name === 'apps.wire').map((r) => r.fields), [
      { conv: a, ev: 'strike', kind: 'pair', via: 'relay', reason: 'frame' },
      { conv: a, ev: 'strike', kind: 'pair', via: 'relay', reason: 'frame' },
      { conv: a, ev: 'strike', kind: 'pair', via: 'relay', reason: 'frame' },
      { conv: a, ev: 'kill', kind: 'pair', via: 'relay', reason: 'frame' },
      { conv: a, ev: 'down', kind: 'pair', via: 'relay', reason: 'dead' }
    ]);
    assert.deepEqual(A.reports.filter((r) => r.name === 'apps.lane').map((r) => r.fields), [{ ev: 'dead', peers: 1 }]);
    assert.deepEqual(A.tm.ignored, [], 'a relay has no wire to ignore');
    // more garbage is not heard, and a message from the other side does not show on a path that is closed
    await B.link.relay(lane, 'pair', new Uint8Array(40).fill(7));
    await settle(10);
    assert.equal(A.reports.filter((r) => r.fields.ev === 'strike').length, 3);
    assert.equal(conv(A).via, null);
    // the socket is lost and comes back: the lane is joined with a clean path and the conversation talks again
    A.link.drop();
    await until(() => A.link.state === 'backoff', 'the socket is lost');
    w.advance(1000);
    await until(() => conv(A).via === 'relay', 'the path is back');
    await B.apps.send(conv(B).id, 'after the clean start');
    await until(() => conv(A).messages.length === 1, 'and a message shows');
    assert.deepEqual(A.reports.filter((r) => r.fields.ev === 'strike').length, 3);
  });

  test('the rendezvous refuses the relay mid-way (it was switched off): the lane is out of use and reported once as off', async () => {
    const w = stubWorld(); // the stub: its switch moves half-way through; the core takes it when it starts
    const { A, B, a } = await pairUp(w, RELAY);
    A.reports.length = 0;
    w.rdv.relayLane = false;
    await A.apps.send(a, 'goes nowhere');
    await until(() => A.reports.some((r) => r.name === 'apps.lane' && r.fields.ev === 'off'), 'the refusal is reported');
    await until(() => conv(A).via === null, 'the lane is out of use');
    assert.deepEqual(A.reports.filter((r) => r.name === 'apps.lane').map((r) => r.fields.ev), ['off']);
    assert.equal(conv(A).messages[0].status !== 'delivered', true);
    assert.equal(conv(B).messages.length, 0);
  });

  test('over the rate cap and the day cap the lane stays in use and the refusal is told as rate or busy; the message waits and is not lost', async () => {
    const w = stubWorld(); // the stub: its caps move half-way through; the core fixes them when it starts
    const { A, B, a } = await pairUp(w, RELAY);
    A.reports.length = 0;
    await quiet(w, A);
    await quiet(w, B);
    A.reports.length = 0;
    w.rdv.caps.relayPerMin = 0; // everything is over the minute's cap
    const first = await A.apps.send(a, 'over the rate');
    await until(() => A.reports.some((r) => r.name === 'apps.lane' && r.fields.ev === 'rate'), 'told as rate');
    assert.equal(conv(A).via, 'relay', 'the lane stays in use');
    w.rdv.caps.relayPerMin = 120; // the minute passes
    await A.apps.resend(a, first.id);
    await until(() => conv(B).messages.length === 1, 'and the retry goes');
    w.rdv.caps.relayDayMax = 0;
    await A.apps.send(a, 'over the day');
    await until(() => A.reports.some((r) => r.name === 'apps.lane' && r.fields.ev === 'busy'), 'told as busy');
    assert.equal(conv(A).via, 'relay');
    assert.ok(w.rdv.relayStats().relayBusy >= 1);
  });
});

describe('rooms through the relay', () => {
  test('an owner and two members through the relay: the roster reaches all three, messages reach everyone, and nothing goes over a wire', async () => {
    const w = makeWorld();
    const { O, Ms, id, ids, roomOf } = await roomUp(w, RELAY);
    const [M1, M2] = Ms;
    await until(() => [[O, id], [M1, ids[0]], [M2, ids[1]]].every(([X, i]) => roomOf(X, i).members.length === 3), 'the roster at all three');
    assert.deepEqual([O.loadCalls.length, M1.loadCalls.length, M2.loadCalls.length], [0, 0, 0], 'no manager');
    assert.equal(w.net.frames.length, 0);
    await M1.apps.sendRoom(ids[0], 'from the first member');
    await O.apps.sendRoom(id, 'from the owner');
    await M2.apps.sendRoom(ids[1], 'from the second member');
    await until(() => [[O, id], [M1, ids[0]], [M2, ids[1]]].every(([X, i]) => roomOf(X, i).messages.length === 3), 'three messages at all three');
    for (const [X, i] of [[O, id], [M1, ids[0]], [M2, ids[1]]]) {
      assert.deepEqual(roomOf(X, i).messages.map((m) => m.text).sort(), ['from the first member', 'from the owner', 'from the second member'], X.name);
    }
    assert.equal(w.rdv.relays.size, 1, 'one lane, three sockets');
    assert.equal(Array.from(w.rdv.relays.values())[0].kind, 'room');
    assert.equal(Array.from(w.rdv.relays.values())[0].members.size, 3);
    assert.deepEqual([roomOf(O, id).via, roomOf(M1, ids[0]).via, roomOf(M2, ids[1]).via], ['relay', 'relay', 'relay']);
    assert.equal(roomOf(O, id).peers, 2);
    // each message was put on the relay once by its author, and not again by the members that got it
    assert.ok(w.rdv.relayStats().relayed < 40, JSON.stringify(w.rdv.relayStats()));
    assert.ok(w.rdv.relayStats().relayed > 0);
  });

  test('an owner whose direct wire to one member is up still gives the room state to a member who is on the relay alone, whichever came first', async () => {
    const w = makeWorld();
    // the owner has both paths; the first member is on a direct wire only (it never joins the lane at the rendezvous); the second has no direct link at all
    const O = await mk(w, 'Olive', BOTH);
    const M1 = await mk(w, 'Mia', LEGACY);
    const M2 = await mk(w, 'Max', RELAY);
    const roomOf = (X, id) => st(X).rooms.find((x) => x.id === id);
    const r = await O.apps.createRoom();
    const j1 = await M1.apps.joinRoom(r.code);
    await until(() => st(O).requests.length === 1, 'the first request');
    await O.apps.acceptMember(st(O).requests[0].knock);
    await until(() => roomOf(M1, j1.id).status === 'connected', 'the first member is in, by the wire');
    assert.equal(roomOf(O, r.id).via, 'direct');
    const j2 = await M2.apps.joinRoom(r.code);
    await until(() => st(O).requests.length === 1, 'the second request');
    // the second member's join of the lane reaches the rendezvous only after the owner has finished its accept: the lane comes into use later
    const handle = w.rdv.handle.bind(w.rdv);
    const held = [];
    let holding = true;
    w.rdv.handle = (conn, m) => (holding && m && m.action === 'room-join' && conn.id === connOf(M2) ? held.push([conn, m]) : handle(conn, m));
    await O.apps.acceptMember(st(O).requests[0].knock);
    await until(() => held.length === 1, 'the join of the second member waits');
    holding = false;
    for (const [conn, m] of held) handle(conn, m);
    await until(() => roomOf(M2, j2.id).status === 'connected', 'the second member is in, by the relay');
    await until(() => roomOf(M2, j2.id).members.length === 3 && roomOf(M1, j1.id).members.length === 3, 'and both read the roster');
    assert.equal(roomOf(M2, j2.id).via, 'relay');
    await M2.apps.sendRoom(j2.id, 'from the one on the relay alone');
    await O.apps.sendRoom(r.id, 'from the owner');
    await until(() => roomOf(O, r.id).messages.length === 2 && roomOf(M1, j1.id).messages.length === 2 && roomOf(M2, j2.id).messages.length === 2, 'the owner bridges the two paths');
  });

  test('a roster that comes before the room secret is held on the relay path and read when the secret arrives, as on a wire', async () => {
    const w = makeWorld();
    const { O, Ms, id, ids, code, roomOf } = await roomUp(w, RELAY, ['Olive', 'Mia']);
    const [M1] = Ms;
    assert.ok(M1);
    const Late = await mk(w, 'Max', RELAY);
    const j = await Late.apps.joinRoom(code);
    await until(() => st(O).requests.length === 1, 'the join request of the third');
    // nothing the owner puts on the relay reaches the third person: the test hands it the frames itself, the roster first and then its key
    const toLate = connOf(Late);
    const send = w.rdv._send.bind(w.rdv);
    w.rdv._send = (conn, obj) => (conn.id === toLate && obj && obj.action === 'room-relayed' ? undefined : send(conn, obj));
    assert.equal((await O.apps.acceptMember(st(O).requests[0].knock)).id, id);
    const mine = Late.apps.rooms.get(j.id);
    await until(() => mine.p.rst && mine.p.rst.joined && mine.p.rst.peers === 2, 'the third is in the lane');
    assert.equal(mine.p.secret, null, 'and holds no secret yet');
    const roomO = O.apps.rooms.get(id);
    const roster = await O.apps._rosterFrame(roomO);
    const keys = await O.apps._keyFrames(roomO);
    const lane = roomO.lane;
    const hand = (bytes) => send(Late.link._ws.conn, { action: 'room-relayed', lane, f: b64url.encode(bytes) });
    hand(roster);
    await until(() => mine.p.rst.heldRoster !== null, 'the roster is held');
    assert.equal(roomOf(Late, j.id).members.length, 1, 'only the owner is known until the roster is read');
    for (const k of keys) hand(k);
    await until(() => roomOf(Late, j.id).status === 'connected', 'the key arrived');
    await until(() => roomOf(Late, j.id).members.length === 3, 'and the roster that was held is read');
    assert.equal(mine.p.rst.heldRoster, null);
    assert.ok(ids.length === 1);
  });

  test('a room that its owner closes is closed for the members, who leave their lane; a member who leaves is gone from the lane', async () => {
    const w = makeWorld();
    const { O, Ms, id, ids, roomOf } = await roomUp(w, RELAY);
    const [M1, M2] = Ms;
    const lane = Array.from(w.rdv.relays.keys())[0];
    await M1.apps.leaveRoom(ids[0]);
    await until(() => w.rdv.relays.get(lane).members.size === 2, 'the member left the lane');
    assert.equal(framesOf(w, 'room-leave').length, 1);
    await O.apps.leaveRoom(id);
    await until(() => roomOf(M2, ids[1]).status === 'closed', 'the member sees the room closed');
    await until(() => !w.rdv.relays.has(lane), 'both are out of the lane, which is gone');
    assert.equal(framesOf(w, 'room-leave').length, 3, 'each of the three left once');
  });

  // Finding A-3 of verify round 0. Over the relay one frame of the owner reaches every member at once, and every frame counts against the
  // owner's socket at the rendezvous (plan 3.2: 120 relays and 150 messages a minute, the next message closes the socket). The owner used to put
  // the whole room state (the roster and the sealed secret of EVERY member) on the relay at each accept and again at each member's joined push,
  // about 2 (1 + j) frames for the j-th member: a room of 12 filled at one accept every 4 seconds closed the owner's socket. Now the roster goes
  // once per call, and of the sealed secrets only those of the members the owner has not heard from: a member says { k: 'in' } once it holds the
  // secret, and any frame it writes says the same.
  /**
   * fillRoom(w, n, stepMs): an owner and n members on the relay; the owner accepts them one after the other, the clock moving stepMs after each.
   * Between two accepts the test waits, in real time, until the owner has heard the new member say 'in', as it does within a round trip on a real
   * network, long before the next accept: so the count of frames does not depend on how fast this machine opens the sealed boxes.
   */
  async function fillRoom (w, n, stepMs) {
    const O = await mk(w, 'Olive', RELAY);
    const Ms = [];
    for (let i = 1; i <= n; i++) Ms.push(await mk(w, 'Member' + i, RELAY));
    const r = await O.apps.createRoom();
    assert.ok(r.id, JSON.stringify(r));
    const ids = [];
    for (const M of Ms) {
      const j = await M.apps.joinRoom(r.code);
      assert.ok(j.id, JSON.stringify(j));
      ids.push(j.id);
    }
    await until(() => st(O).requests.length === n, 'the join requests');
    const ownerConn = connOf(O);
    const roomO = O.apps.rooms.get(r.id);
    for (const q of st(O).requests.slice()) {
      assert.equal((await O.apps.acceptMember(q.knock)).id, r.id);
      await until(() => roomO.p.needKey.size === 0, 'the owner heard the new member say it holds the secret');
      w.advance(stepMs);
    }
    const roomOf = (X, id) => st(X).rooms.find((x) => x.id === id);
    const inRoom = () => Ms.filter((M, i) => roomOf(M, ids[i]).status === 'connected').length;
    return { O, Ms, id: r.id, ids, ownerConn, roomOf, inRoom };
  }
  const refusedOf = (X) => X.reports.filter((x) => x.name === 'link.reply' && x.fields.ok === false).map((x) => x.fields.reason);
  const goneOf = (X) => X.reports.filter((x) => x.name === 'link.gone').map((x) => x.fields.why);

  test('a room that fills at one accept every 4 seconds: the owner keeps its socket, nothing it sends is refused, every member holds the key, and the owner puts 4 frames on the relay per member, not the whole room each time', async () => {
    assert.ok(CORE_RELAY, 'this test needs the real pairing core (deploy/rtc-worker/pair.js), whose caps are those of the Worker');
    const w = makeWorld();
    const n = 15;
    const { O, Ms, id, ids, ownerConn, roomOf, inRoom } = await fillRoom(w, n, 4000);
    await until(() => inRoom() === n, 'every member holds the key');
    assert.deepEqual(goneOf(O), [], 'the owner\'s socket was never closed');
    assert.deepEqual(refusedOf(O), [], 'nothing the owner sent was refused');
    assert.equal(connOf(O), ownerConn);
    // per member at most: the roster and the new member's sealed secret at the accept, and both again at its joined push (the accept's copy
    // may come before the member is in the lane). The whole state twice per member was 2 (1 + j) frames, 270 for a room of 16.
    const relays = w.rdv.log.filter((e) => e.conn === ownerConn && e.action === 'room-relay').length;
    assert.ok(relays <= 4 * n, 'the owner put ' + relays + ' frames on the relay for ' + n + ' members');
    for (const M of Ms) assert.equal(sentBy(w, M, 'room-relay'), 1, M.name + ' said once that it holds the secret');
    assert.equal(w.rdv.relayStats().relayRate, 0);
    await O.apps.sendRoom(id, 'all fifteen are in');
    await until(() => Ms.every((M, i) => roomOf(M, ids[i]).messages.some((m) => m.text === 'all fifteen are in')), 'a message of the owner reaches every member');
  });

  test('a full room whose sockets all come back at once, as after a restart of the rendezvous: the owner\'s new socket is never refused or closed, puts 3 rosters on the relay at most for all the returns, not one each, and every member still holds the key', async () => {
    assert.ok(CORE_RELAY, 'this test needs the real pairing core (deploy/rtc-worker/pair.js), whose caps are those of the Worker');
    const w = makeWorld();
    const n = 15;
    const { O, Ms, id, ids, roomOf, inRoom } = await fillRoom(w, n, 4000);
    await until(() => inRoom() === n, 'the room is full and every member holds the key');
    w.advance(61000); // a fresh minute at the rendezvous
    await settle(20);
    O.reports.length = 0;
    for (const X of [O, ...Ms]) X.link.drop(); // the object restarted: every socket is lost at once
    await settle(20);
    w.advance(1500); // and all come back after the same back off
    await until(() => [O, ...Ms].every((X) => X.link.state === 'open'), 'every socket is back');
    const ownerConn = connOf(O);
    await until(() => roomOf(O, id).peers === n, 'every member is in the lane again');
    // the n returns reach the owner as a burst of joined pushes, and the owner's passes coalesce: the one that runs and one more, 2 rosters (96
    // runs of 96 under load in fix round 3; one pass per push puts 15). At most 3, so that a push that comes after the second pass started
    // stays in (finding B-5 of verify round 2: the bound of n + 1 held without the coalescing)
    const rosters = await quiet(w, O, 'room-relay');
    assert.ok(rosters <= 3, 'the owner put ' + rosters + ' rosters on the relay for ' + n + ' returns');
    assert.deepEqual(refusedOf(O), [], 'nothing the owner sent was refused');
    assert.deepEqual(goneOf(O), ['closed'], 'the owner\'s socket was lost once, by the restart, and never closed by the rendezvous');
    assert.equal(connOf(O), ownerConn);
    assert.equal(inRoom(), n, 'every member still holds the key');
    for (const M of Ms) assert.equal(refusedOf(M).length, 0, M.name);
    await O.apps.sendRoom(id, 'after the restart');
    await until(() => Ms.every((M, i) => roomOf(M, ids[i]).messages.some((m) => m.text === 'after the restart')), 'the next message reaches every member');
  });

  // The calls of the owner's room-state pass that come while one runs make one more pass, not one each (_relayRoomState). Since the one-box fix
  // of fix round 2 no other test failed without that: the owner of a full room whose sockets all came back put 15 rosters on the relay where it
  // puts 2, against its 100 relayed frames in 65 seconds (finding B-5 of verify round 2).
  test('a burst of calls of the owner\'s room-state pass makes one more pass, not one each: ten calls in one turn put the roster on the relay twice', async () => {
    const w = makeWorld();
    const { O, id, roomOf } = await roomUp(w, RELAY);
    const roomO = O.apps.rooms.get(id);
    await until(() => roomO.p.needKey.size === 0 && roomOf(O, id).peers === 2, 'both members hold the key and are in the lane');
    const before = await quiet(w, O, 'room-relay');
    const calls = [];
    for (let i = 0; i < 10; i++) calls.push(O.apps._relayRoomState(roomO));
    await Promise.all(calls);
    // the pass that ran and one more; each puts the roster alone, since the owner heard both members say they hold the secret
    assert.equal(await quiet(w, O, 'room-relay') - before, 2, 'rosters the owner put on the relay for ten calls');
  });

  test('a member says once that it holds the room secret and the owner stops putting it on the relay; a joined push then costs the owner the roster alone; a member who sees its own sealed secret again says it again', async () => {
    const w = makeWorld();
    const { O, Ms, id, roomOf } = await roomUp(w, RELAY);
    const [M1, M2] = Ms;
    const roomO = O.apps.rooms.get(id);
    await until(() => roomO.p.needKey.size === 0, 'the owner heard from both members');
    for (const M of Ms) assert.equal(await quiet(w, M, 'room-relay'), 1, M.name + ' said it once');
    // M2's socket goes and comes back: its joined push gets the roster from the owner, and no sealed secret
    const before = await quiet(w, O, 'room-relay');
    M2.link.drop();
    await until(() => roomOf(O, id).peers === 1, 'the owner sees M2 go');
    w.advance(1000);
    await until(() => roomOf(O, id).peers === 2, 'and come back');
    assert.equal(await quiet(w, O, 'room-relay') - before, 1, 'one frame: the roster');
    // the owner did not hear M1 (as if its word had been lost): at the next joined push it puts M1's sealed secret on the relay, and M1, seeing
    // its own again, says again that it holds it (at most once a minute)
    w.advance(60000);
    roomO.p.needKey.add(M1.person.keys.pub);
    const m1Before = await quiet(w, M1, 'room-relay');
    M2.link.drop();
    await until(() => roomOf(O, id).peers === 1, 'the owner sees M2 go again');
    w.advance(1000);
    await until(() => roomO.p.needKey.size === 0, 'M1 said it again and the owner heard it');
    assert.equal(await quiet(w, M1, 'room-relay') - m1Before, 1);
  });

  // The test above failed by chance under load (13 of 160 runs, 8 at a time, on the code of checkpoint 1f3dc01): the accept's pass and a joined
  // push's pass each sealed the member a box while the other was sealing, the member kept the key of the first box it opened, and the owner's
  // cache kept the second, which the member then took for another member's box, so it never said 'in' again (found in the full run of fix round 2).
  test('the owner seals one box per member, also when two passes overlap: every pass hands out the same box', async () => {
    const w = makeWorld();
    const { O, id } = await roomUp(w, RELAY);
    const roomO = O.apps.rooms.get(id);
    roomO.p.keyFrames.clear(); // as before the first pass
    const same = (x, y) => x.length === y.length && x.every((box, i) => Buffer.from(box).equals(Buffer.from(y[i])));
    const [a, b] = await Promise.all([O.apps._keyFrames(roomO), O.apps._keyFrames(roomO)]);
    assert.equal(a.length, 2);
    assert.ok(same(a, b), 'the same box for each member'); // compared, never printed: the boxes are sealed frames
    assert.ok(same(await O.apps._keyFrames(roomO), a), 'and the same again later');
  });
});

describe('leaving ends the lane at the rendezvous', () => {
  test('leave sends pair-leave and the other side hears pair-left and the goodbye; the lane of the one who left is gone', async () => {
    const w = makeWorld();
    const { A, B, a } = await pairUp(w, RELAY);
    const lane = laneOf(A);
    assert.equal(w.rdv.relays.get(lane).members.size, 2);
    assert.deepEqual(await A.apps.leave(a), { ok: true });
    assert.equal(sentBy(w, A, 'pair-leave'), 1);
    assert.equal(framesOf(w, 'pair-leave')[0].lane, lane);
    await until(() => conv(B).status === 'left', 'the goodbye at the other side');
    await until(() => !w.rdv.relays.has(lane), 'B left its lane too, on the goodbye, and the lane is gone');
    assert.equal(A.apps.lanes.size, 0);
    assert.equal(B.apps.lanes.size, 0);
  });

  test('block ends it the same way, and so does a sign-out, which sends the leave before the socket closes', async () => {
    const w = makeWorld();
    const { A, B } = await pairUp(w, RELAY);
    const lane = laneOf(A);
    await A.apps.block(B.person.keys.pub);
    await until(() => w.rdv.relays.get(lane).members.size === 1, 'A left the lane on a block');
    assert.equal(conv(A).status, 'blocked');
    assert.equal(sentBy(w, A, 'pair-leave'), 1);
    const w2 = makeWorld();
    const P = await pairUp(w2, RELAY);
    const sent = P.A.link._ws.sent;
    const lane2 = laneOf(P.A);
    P.A.identity.signOut();
    await until(() => w2.rdv.relays.get(lane2).members.size === 1, 'A is out of the lane');
    assert.deepEqual(sent.map((t) => JSON.parse(t)).filter((m) => m.action === 'pair-leave').map((m) => m.lane), [lane2]);
    assert.equal(st(P.A).conversations.length, 0);
  });

  // Plan 3.6: the leave paths send leave. A conversation left while its join is still on the way had nothing to leave yet, and the join's answer
  // then made the socket a member all the same: it kept a seat in the lane (and one of its 8) until it closed (finding A-2 of verify round 0).
  test('a conversation left while its join is on the way leaves the lane when the join is answered: the socket keeps no seat in it', async () => {
    const w = makeWorld();
    const A = await mk(w, 'Alice', RELAY);
    const B = await mk(w, 'Bob', RELAY);
    const { code } = await A.apps.openCode();
    assert.ok((await B.apps.knock(code)).knock);
    await until(() => st(A).requests.length === 1, 'the request');
    // A's join is held on its way until the conversation has been left
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const join = A.link.join.bind(A.link);
    A.link.join = async (lane, kind) => { await gate; return join(lane, kind); };
    const accepting = A.apps.accept(st(A).requests[0].knock);
    await until(() => A.apps.lanes.size === 1, 'the join is on its way');
    const lane = laneOf(A);
    const leaving = A.apps.leave(conv(A).id);
    await settle(10);
    release();
    await accepting;
    await leaving;
    await until(() => sentBy(w, A, 'pair-leave') === 1, 'the leave went once the join was answered');
    await until(() => A.link._ws.conn.joined.size === 0, 'A\'s socket holds no lane at the rendezvous');
    assert.equal(st(A).conversations.length, 0);
    await until(() => w.rdv.relays.has(lane) && w.rdv.relays.get(lane).members.size === 1, 'B is alone in the lane');
    assert.equal(sentBy(w, A, 'pair-leave'), 1, 'and only once');
  });

  // Plan 3.6: the lanes beyond the socket's cap join when one of the 8 ends. The late leave of the test above frees a place on the socket, and the
  // lane that waits for one gets it, as at any other end of a lane; before, nothing asked again and it stayed connecting (finding A-5 of verify round 1).
  test('the place that late leave frees goes to the lane that waits for one', async () => {
    const w = makeWorld({ caps: { lanesPerSocket: 2 } }); // both ends shortened the same way
    const A = await mk(w, 'Alice', Object.assign({ limits: { relayLanesMax: 2 } }, RELAY));
    const Bs = {};
    for (const name of ['Bea', 'Bo', 'Bi']) Bs[name] = await mk(w, name, RELAY);
    const { code } = await A.apps.openCode();
    for (const B of Object.values(Bs)) assert.ok((await B.apps.knock(code)).knock);
    await until(() => st(A).requests.length === 3, 'three requests');
    const reqOf = (name) => st(A).requests.find((q) => q.from.name === name);
    // the joins of Bo and Bi wait before they leave, so that no joined push reaches A meanwhile; the answer to A's second join (Bo's conversation)
    // waits on its way back, after the rendezvous has made A's socket a member of that lane
    const freeBo = gateJoin(Bs.Bo);
    const freeBi = gateJoin(Bs.Bi);
    const freeA = gateJoin(A, { replyOnly: true, which: (n) => n === 2 });
    assert.ok((await A.apps.accept(reqOf('Bea').knock)).id);
    await until(() => st(A).conversations.filter((c) => c.status === 'connected').length === 1, 'the first conversation is connected');
    const accepting = A.apps.accept(reqOf('Bo').knock);
    await until(() => st(A).conversations.length === 2 && A.link._ws.conn.joined.size === 2, 'the second join reached the rendezvous');
    const second = st(A).conversations.find((c) => c.status !== 'connected').id;
    assert.ok((await A.apps.accept(reqOf('Bi').knock)).id);
    await settle(20);
    const third = st(A).conversations.find((c) => c.id !== second && c.status !== 'connected').id;
    assert.equal(A.apps.convs.get(third).p.rst.pending, true, 'the third waits for a place: the socket holds 2 of 2');
    const leaving = A.apps.leave(second); // left while the answer to its join is on the way
    await settle(20);
    freeA();
    await accepting;
    await leaving;
    freeBi();
    freeBo();
    await until(() => sentBy(w, A, 'pair-leave') === 1, 'the late leave');
    await until(() => st(A).conversations.find((c) => c.id === third).status === 'connected', 'the third got the place the late leave freed');
    assert.equal(st(A).conversations.find((c) => c.id === third).via, 'relay');
    assert.equal(A.link._ws.conn.joined.size, 2, 'and the socket holds its 2 lanes');
  });

  // The same case the other way round (finding A-5 of verify round 1, the related case): a lane ends while the join of another is on its way, the
  // rendezvous counted the join first and answered 'too many lanes', and the place came free right after; the answer is out of date when it arrives.
  /** Alice with a socket that holds 2 lanes, connected to Bea and Bo, and Bi's conversation accepted with the answer to its join held on the way back. */
  async function crossing (w) {
    const A = await mk(w, 'Alice', Object.assign({ limits: { relayLanesMax: 2 } }, RELAY));
    const Bs = {};
    for (const name of ['Bea', 'Bo', 'Bi']) Bs[name] = await mk(w, name, RELAY);
    const { code } = await A.apps.openCode();
    for (const B of Object.values(Bs)) assert.ok((await B.apps.knock(code)).knock);
    await until(() => st(A).requests.length === 3, 'three requests');
    const reqOf = (name) => st(A).requests.find((q) => q.from.name === name);
    const free = gateJoin(A, { replyOnly: true, which: (n) => n === 3 });
    for (const name of ['Bea', 'Bo']) assert.ok((await A.apps.accept(reqOf(name).knock)).id);
    await until(() => st(A).conversations.filter((c) => c.status === 'connected').length === 2, 'two connected');
    const accepting = A.apps.accept(reqOf('Bi').knock);
    await until(() => sentBy(w, A, 'pair-join') === 3 && st(A).conversations.length === 3, 'the third join reached the rendezvous, which has no place for it');
    const third = st(A).conversations.find((c) => c.status !== 'connected').id;
    return { A, free, accepting, third };
  }

  test('a too many lanes answer to a join that crossed the end of another lane on its way: the lane that waits gets the place the end freed', async () => {
    const w = makeWorld({ caps: { lanesPerSocket: 2 } });
    const { A, free, accepting, third } = await crossing(w);
    const first = st(A).conversations.find((c) => c.status === 'connected').id;
    assert.deepEqual(await A.apps.leave(first), { ok: true }); // a place comes free while the answer is on its way
    free();
    await accepting;
    await until(() => st(A).conversations.find((c) => c.id === third).status === 'connected', 'the third got the place');
    assert.equal(A.link._ws.conn.joined.size, 2, 'and the socket holds its 2 lanes');
    assert.equal(sentBy(w, A, 'pair-join'), 4, 'asked once more');
  });

  test('a too many lanes answer is asked again once per place that came free on its way, not in a loop: a rendezvous that still has no place gets one more join', async () => {
    const w = stubWorld({ caps: { lanesPerSocket: 2 } }); // the stub: it refuses every later join of Alice's socket, a place the page cannot count
    const { A, free, accepting, third } = await crossing(w);
    const first = st(A).conversations.find((c) => c.status === 'connected').id;
    assert.deepEqual(await A.apps.leave(first), { ok: true });
    const conn = A.link._ws.conn;
    const orig = w.rdv.handle.bind(w.rdv);
    w.rdv.handle = (c, m) => (c === conn && m && m.action === 'pair-join' ? w.rdv._send(c, { action: 'pair-join', rid: m.rid, 'failure reason': 'too many lanes' }) : orig(c, m));
    const joins = () => A.link._ws.sent.map((t) => JSON.parse(t)).filter((m) => m.action === 'pair-join').length;
    const fulls = () => A.reports.filter((r) => r.name === 'apps.lane' && r.fields.ev === 'full').length;
    free();
    await accepting;
    // the answer to the join asked again comes back refused (its request must not time out first, or a page that asked in a loop would pass here)
    await until(() => joins() >= 4 && fulls() >= 2, 'one more join, refused');
    await settle(50);
    assert.deepEqual([joins(), fulls()], [4, 2], 'one more join and no other');
    for (let i = 0; i < 10; i++) {
      w.advance(60000);
      await settle(10);
    }
    assert.equal(joins(), 4, 'and none ten minutes later');
    assert.equal(A.apps.convs.get(third).p.rst.pending, true, 'the lane still waits for a place');
  });

  // The late leave of _relayJoin counts as an end too: the place it frees can be the one a 'too many lanes' answer was refused for while that
  // answer was on its way, and then the lane that waits asks again when the answer comes. Only the end in _leaveLane was tested (finding B-6 of
  // verify round 2).
  test('a too many lanes answer to a join that crossed a late leave on its way: the lane that waits gets the place the late leave freed', async () => {
    const w = makeWorld({ caps: { lanesPerSocket: 2 } }); // both ends shortened the same way
    const A = await mk(w, 'Alice', Object.assign({ limits: { relayLanesMax: 2 } }, RELAY));
    const Bs = {};
    for (const name of ['Bea', 'Bo', 'Bi']) Bs[name] = await mk(w, name, RELAY);
    const { code } = await A.apps.openCode();
    for (const B of Object.values(Bs)) assert.ok((await B.apps.knock(code)).knock);
    await until(() => st(A).requests.length === 3, 'three requests');
    const reqOf = (name) => st(A).requests.find((q) => q.from.name === name);
    assert.ok((await A.apps.accept(reqOf('Bea').knock)).id);
    await until(() => st(A).conversations.filter((c) => c.status === 'connected').length === 1, 'the first conversation is connected');
    // the joins of Bo and Bi wait before they leave, so that no joined push reaches A; the answers to A's next two joins (Bo's conversation,
    // then Bi's) wait on their way back, each until its own release (two gates, each counting the calls that reach it)
    const freeBo = gateJoin(Bs.Bo);
    const freeBi = gateJoin(Bs.Bi);
    const freeSecond = gateJoin(A, { replyOnly: true, which: (n) => n === 1 });
    const freeThird = gateJoin(A, { replyOnly: true, which: (n) => n === 2 });
    const acceptingBo = A.apps.accept(reqOf('Bo').knock);
    await until(() => st(A).conversations.length === 2 && A.link._ws.conn.joined.size === 2, 'the second join reached the rendezvous: the socket holds 2 of 2');
    const second = st(A).conversations.find((c) => c.status !== 'connected').id;
    const leaving = A.apps.leave(second); // left while the answer to its join is on the way: its place comes back by the late leave
    await settle(20);
    const acceptingBi = A.apps.accept(reqOf('Bi').knock);
    await until(() => sentBy(w, A, 'pair-join') === 3, 'the third join reached the rendezvous, which has no place for it');
    await settle(20);
    const third = st(A).conversations.find((c) => c.id !== second && c.status !== 'connected').id;
    freeSecond(); // the second join's answer comes first: the late leave goes, while the third is not waiting for a place yet (its answer is on the way)
    await until(() => sentBy(w, A, 'pair-leave') === 1, 'the late leave');
    await settle(20);
    freeThird(); // then the third join's answer: too many lanes, out of date since the late leave
    await Promise.all([acceptingBo, leaving, acceptingBi]);
    freeBi();
    freeBo();
    await until(() => st(A).conversations.find((c) => c.id === third).status === 'connected', 'the third got the place the late leave freed');
    assert.equal(st(A).conversations.find((c) => c.id === third).via, 'relay');
    assert.equal(A.link._ws.conn.joined.size, 2, 'and the socket holds its 2 lanes');
    const refused = A.reports.filter((r) => r.name === 'link.reply' && r.fields.action === 'pair-join' && r.fields.ok === false).map((r) => r.fields.reason);
    assert.deepEqual(refused, ['too-many-lanes'], 'the third join was refused for want of a place, as the case needs');
    assert.equal(sentBy(w, A, 'pair-join'), 4, 'asked once more');
  });
});

// Finding A-6 of verify round 1. A page acks every direct message it accepts (up to acceptPerMin, 120 a minute a conversation), so contacts whose
// clients relay at the rendezvous' own cap make it owe more frames than its socket's minute allows. The frames over it used to wait in the link
// without end, every other lane of the page waited behind them, and a block left them waiting. Now at most HELD_PER_LANE of a lane wait, the next
// is refused at once (told as rate: an ack or a mark is dropped, a message stays in its outbox). Blocking drops what waits for the lane at once;
// leaving first sends its goodbye, which waits its turn (what waited goes, then the goodbye), or drops it at once when the goodbye is refused.
describe('a page that owes more frames than its socket\'s minute allows', () => {
  test('two contacts that relay at the rendezvous\' cap: what the page owes them waits in its link a lane at most HELD_PER_LANE, a message to a third contact goes within BUDGET_WINDOW_MS, and leaving one and blocking the other drop what waited at once', async () => {
    const w = makeWorld();
    const A = await mk(w, 'Alice', RELAY);
    const C = await mk(w, 'Carol', RELAY);
    // modified clients: no pacing of the service, and a link that keeps only under the caps of the rendezvous
    const hostile = Object.assign({ limits: { sendPerMin: 1000000 }, linkOptions: { relayBudget: 120, messageBudget: 149 } }, RELAY);
    const B1 = await mk(w, 'Bad1', hostile);
    const B2 = await mk(w, 'Bad2', hostile);
    const { code } = await A.apps.openCode();
    for (const X of [C, B1, B2]) assert.ok((await X.apps.knock(code)).knock);
    await until(() => st(A).requests.length === 3, 'three requests');
    for (const q of st(A).requests.slice()) assert.ok((await A.apps.accept(q.knock)).id);
    await until(() => [A, C, B1, B2].every((X) => st(X).conversations.length >= 1 && st(X).conversations.every((c) => c.status === 'connected')), 'all connected');
    const aConv = (name) => st(A).conversations.find((c) => c.peer.name === name);
    const ownConn = connOf(A);
    for (const B of [B1, B2]) for (let i = 0; i < 600; i++) await B.apps.send(conv(B).id, 'flood ' + i);
    const step = async () => { w.advance(5000); await settle(20); await new Promise((resolve) => setTimeout(resolve, 30)); };
    const heldAt = [];
    for (let minute = 1; minute <= 2; minute++) {
      for (let s = 0; s < 12; s++) await step();
      heldAt.push(A.link._held.length);
    }
    assert.ok(heldAt.every((n) => n <= 2 * HELD_PER_LANE), 'frames waiting in the link at each minute: ' + heldAt.join(', '));
    assert.ok(conv(B1).messages.filter((m) => m.status === 'delivered').length > 0, 'the flood is acked as far as the minute allows');
    const laneWith = (name) => A.apps.convs.get(aConv(name).id).p.rst.lane;
    /**
     * A writes to Carol; once the frame is with the link the clock moves in steps of 5 seconds until the link has sent it: how long it waited
     * on the clock. A frame waits for the frames of its minute to run out, so at most BUDGET_WINDOW_MS, however long the flood goes on.
     */
    const toCarol = async (text) => {
      const lane = laneWith('Carol');
      const sentOn = () => A.link._ws.sent.filter((t) => { const m = JSON.parse(t); return m.action === 'pair-relay' && m.lane === lane; }).length;
      const before = sentOn();
      const shown = conv(C).messages.length;
      await A.apps.send(aConv('Carol').id, text);
      await until(() => sentOn() > before || A.link._held.some((h) => h.lane === lane), 'the frame for Carol is with the link');
      const from = w.clock.now();
      while (sentOn() === before && w.clock.now() - from < 10 * 60000) await step();
      await until(() => conv(C).messages.length > shown, 'it shows at Carol');
      return w.clock.now() - from;
    };
    const during = await toCarol('while the two others write');
    assert.ok(during <= BUDGET_WINDOW_MS, 'a message to the third contact waited ' + during / 1000 + ' s of the clock while the flood went on');
    // when the next burst of the flood has filled what may wait for both lanes, leave one and block the other, the clock standing still
    const [lane1, lane2] = [laneWith('Bad1'), laneWith('Bad2')];
    const full = () => A.link._heldOf(lane1) === HELD_PER_LANE && A.link._heldOf(lane2) === HELD_PER_LANE;
    for (let i = 0; i < 40 && !full(); i++) await step();
    assert.ok(full(), 'both lanes have HELD_PER_LANE frames waiting');
    // its goodbye is refused at once (its lane has HELD_PER_LANE waiting), so leave() returns without the clock moving and drops what waited
    const leftIn = await Promise.race([A.apps.leave(aConv('Bad1').id), new Promise((resolve) => setTimeout(() => resolve('still waiting'), 5000))]);
    assert.deepEqual(leftIn, { ok: true }, 'leave() returned while the clock stood still');
    const leftAt = A.link._ws.sent.length;
    assert.equal(A.link._heldOf(lane1), 0, 'what waited for the lane that was left is dropped');
    assert.deepEqual(await A.apps.block(aConv('Bad2').peer.pub), { ok: true });
    const blockedAt = A.link._ws.sent.length;
    await settle(20);
    assert.equal(A.link._held.length, 0, 'nothing waits for the two lanes that were left');
    const after = await toCarol('after the two are gone');
    assert.ok(after <= BUDGET_WINDOW_MS, 'a message to the third contact right after the block waited ' + after / 1000 + ' s of the clock');
    const relayedOn = (from, lane) => A.link._ws.sent.slice(from).map((t) => JSON.parse(t)).filter((m) => m.action === 'pair-relay' && m.lane === lane).length;
    assert.deepEqual([relayedOn(leftAt, lane1), relayedOn(blockedAt, lane2)], [0, 0], 'nothing went for a lane after it was left or blocked');
    assert.equal(connOf(A), ownConn, 'the page kept its socket');
    assert.deepEqual(A.reports.filter((r) => r.name === 'link.gone'), [], 'and the rendezvous never closed it');
  });

  test('a lane that is not joined just now when its conversation ends (the rendezvous switched its relay off) has what waited for it dropped too', async () => {
    const w = stubWorld(); // the stub: its switch moves half-way through; the core takes it when it starts
    const { A, a } = await pairUp(w, RELAY);
    const lane = laneOf(A);
    await quiet(w, A);
    w.rdv.relayLane = false;
    await A.apps.send(a, 'refused');
    await until(() => conv(A).via === null, 'the lane is out of use: the socket is not in it');
    // frames of the page for that lane wait in its link: the minute is full
    for (let i = 0; i < RELAY_BUDGET + 3; i++) A.link.relay(lane, 'pair', bytesOf(40, i)).then(() => {});
    await settle(20);
    assert.ok(A.link._held.length > 0, 'frames wait for the lane');
    assert.deepEqual(await A.apps.leave(a), { ok: true });
    await settle(10);
    assert.equal(A.link._held.length, 0, 'what waited for the lane was dropped with it');
    assert.equal(sentBy(w, A, 'pair-leave'), 0, 'and no leave was sent for a lane the socket is not in');
  });

  // What blocking and leaving do with the frames that wait, and what a message the link refuses does, as docs/APPS.md "Known limits" says
  // (findings C-14 and C-15 of verify round 2, A-7 the same). Blocking sends no goodbye and drops what waited at once. Leaving, and an owner
  // closing a room, first send a goodbye, which waits in the same link behind what waited: what waited goes and then the goodbye, within one
  // count of BUDGET_WINDOW_MS, unless HELD_PER_LANE already wait, when the goodbye is refused at once and the rest dropped.
  /** X's count of relayed frames is filled with frames on a lane the service never heard of, so that nothing of X's own waits yet. */
  async function fillMinute (w, X) {
    const other = mint(w);
    assert.equal((await X.link.join(other, 'pair')).ok, true);
    const room = RELAY_BUDGET - X.link._relayT.length;
    for (let i = 0; i < room; i++) X.link.relay(other, 'pair', bytesOf(40, i)).then(() => {});
    await settle(10);
    assert.equal(X.link._held.length, 0, 'the count is full and nothing waits yet');
  }
  /** B writes n messages (n at most HELD_PER_LANE); A shows them, and A's n Delivered marks wait in its link. */
  async function owe (A, B, b, n, lane) {
    const shown = conv(A).messages.length;
    for (let i = 0; i < n; i++) await B.apps.send(b, 'from b ' + i);
    await until(() => conv(A).messages.length === shown + n, 'A shows what B wrote');
    await until(() => A.link._heldOf(lane) === n, 'the Delivered marks wait in A\'s link');
  }
  const relayedOn = (X, lane, from, action = 'pair-relay') => X.link._ws.sent.slice(from).map((t) => JSON.parse(t)).filter((m) => m.action === action && m.lane === lane).length;
  /** p settles within ms of real time while the clock stands still: its value, or 'still waiting'. */
  const settlesAtOnce = (p, ms = 5000) => Promise.race([p, new Promise((resolve) => setTimeout(() => resolve('still waiting'), ms))]);

  test('leaving a conversation whose frames wait: its goodbye waits its turn, what waited goes and then the goodbye within BUDGET_WINDOW_MS, and the other side shows the message, then the end', async () => {
    const w = makeWorld();
    const { A, B, a, b } = await pairUp(w, RELAY);
    const lane = laneOf(A);
    await fillMinute(w, A);
    await owe(A, B, b, 3, lane);
    await A.apps.send(a, 'from a');
    await until(() => A.link._heldOf(lane) === 4, 'three Delivered marks and a message wait in A\'s link');
    const from = A.link._ws.sent.length;
    const t0 = w.clock.now();
    let left = null;
    A.apps.leave(a).then((r) => { left = r; });
    await settle(30);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(left, null, 'leave() waits for its goodbye while the clock stands still');
    assert.equal(A.link._heldOf(lane), 5, 'the goodbye waits behind what waited, which is not dropped');
    w.advance(BUDGET_WINDOW_MS);
    await until(() => left !== null, 'leave() returns once the count has room');
    assert.deepEqual(left, { ok: true });
    assert.ok(w.clock.now() - t0 <= BUDGET_WINDOW_MS, 'within one count');
    assert.equal(relayedOn(A, lane, from), 5, 'what waited went, and then the goodbye');
    await until(() => conv(B).status === 'left', 'the goodbye reached B');
    assert.equal(conv(B).messages.filter((m) => !m.mine && m.text === 'from a').length, 1, 'the message that waited reached B before the goodbye');
    assert.equal(conv(B).messages.filter((m) => m.mine && m.status === 'delivered').length, 3, 'and so did the Delivered marks');
  });

  test('blocking a conversation whose frames wait drops them at once and sends no goodbye; leaving one whose lane already has HELD_PER_LANE waiting has its goodbye refused at once, drops them, and the other side is not told', async () => {
    const w = makeWorld();
    const { A, B, a, b } = await pairUp(w, RELAY);
    const lane = laneOf(A);
    await fillMinute(w, A);
    await owe(A, B, b, 3, lane);
    await A.apps.send(a, 'from a');
    await until(() => A.link._heldOf(lane) === 4, 'three Delivered marks and a message wait in A\'s link');
    const from = A.link._ws.sent.length;
    assert.deepEqual(await settlesAtOnce(A.apps.block(B.person.keys.pub)), { ok: true }, 'block() returned while the clock stood still');
    assert.equal(A.link._heldOf(lane), 0, 'what waited is dropped at once');
    w.advance(BUDGET_WINDOW_MS);
    await settle(30);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(relayedOn(A, lane, from), 0, 'none of it went, and no goodbye');
    assert.equal(conv(B).messages.filter((m) => !m.mine && m.text === 'from a').length, 0);
    // leaving, with HELD_PER_LANE Delivered marks waiting for the lane
    const w2 = makeWorld();
    const P = await pairUp(w2, RELAY);
    const lane2 = laneOf(P.A);
    await fillMinute(w2, P.A);
    await owe(P.A, P.B, P.b, HELD_PER_LANE, lane2);
    assert.equal(P.A.link._heldOf(lane2), HELD_PER_LANE);
    const from2 = P.A.link._ws.sent.length;
    assert.deepEqual(await settlesAtOnce(P.A.apps.leave(P.a)), { ok: true }, 'leave() returned while the clock stood still: its goodbye was refused at once');
    assert.equal(P.A.link._heldOf(lane2), 0, 'what waited is dropped');
    w2.advance(BUDGET_WINDOW_MS);
    await settle(30);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(relayedOn(P.A, lane2, from2), 0, 'neither what waited nor the goodbye went');
    await until(() => conv(P.B).status === 'connecting', 'the other side lost the lane');
    assert.equal(conv(P.B).status, 'connecting', 'and was not told that the conversation ended');
  });

  test('an owner who closes a room while its frames wait: the goodbye waits its turn, what waited goes and then the goodbye within BUDGET_WINDOW_MS, and the members see the message, then the room closed', async () => {
    const w = makeWorld();
    const { O, Ms, id, ids, roomOf } = await roomUp(w, RELAY);
    const roomO = O.apps.rooms.get(id);
    await until(() => roomO.p.needKey.size === 0 && roomOf(O, id).peers === 2, 'both members hold the key and are in the lane');
    await quiet(w, O, 'room-relay');
    const lane = roomO.p.rst.lane;
    await fillMinute(w, O);
    await O.apps.sendRoom(id, 'last word');
    await until(() => O.link._heldOf(lane) === 1, 'the owner\'s message waits in its link');
    const from = O.link._ws.sent.length;
    const t0 = w.clock.now();
    let closed = null;
    O.apps.leaveRoom(id).then((r) => { closed = r; });
    await settle(30);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(closed, null, 'leaveRoom() waits for its goodbye while the clock stands still');
    assert.equal(O.link._heldOf(lane), 2, 'the goodbye waits behind the message, which is not dropped');
    w.advance(BUDGET_WINDOW_MS);
    await until(() => closed !== null, 'leaveRoom() returns once the count has room');
    assert.deepEqual(closed, { ok: true });
    assert.ok(w.clock.now() - t0 <= BUDGET_WINDOW_MS, 'within one count');
    assert.equal(relayedOn(O, lane, from, 'room-relay'), 2, 'the message went, and then the goodbye');
    await until(() => Ms.every((M, i) => roomOf(M, ids[i]).status === 'closed'), 'the members see the room closed');
    for (const [i, M] of Ms.entries()) assert.equal(roomOf(M, ids[i]).messages.filter((m) => m.text === 'last word').length, 1, M.name + ' got the message before the goodbye');
  });

  test('a message the link refuses waits in the page: failed (Not sent, with Try again) after ackTimeoutMs, never sent by itself, and it goes when the person sends the next one, or tries it again', async () => {
    for (const how of ['next', 'retry']) {
      const w = makeWorld();
      const { A, B, a, b } = await pairUp(w, RELAY);
      const lane = laneOf(A);
      await fillMinute(w, A);
      await owe(A, B, b, HELD_PER_LANE, lane);
      const refusedHere = () => A.reports.filter((r) => r.name === 'link.reply' && r.fields.action === 'pair-relay' && r.fields.ok === false && r.fields.reason === 'too-many-relays').length;
      const s = await A.apps.send(a, 'refused at once');
      assert.ok(s.id, JSON.stringify(s));
      await until(() => refusedHere() === 1, how + ': the link refused it at once');
      const mine = () => conv(A).messages.find((m) => m.id === s.id);
      const atB = (text) => conv(B).messages.filter((m) => !m.mine && m.text === text).length;
      assert.equal(mine().status, 'queued', how + ': it waits in the page');
      w.advance(LIMITS.ackTimeoutMs);
      await settle(20);
      assert.equal(mine().status, 'failed', how + ': after ackTimeoutMs it is failed, which the view shows as Not sent with Try again');
      // the count has room again within BUDGET_WINDOW_MS: what waited in the link goes then, the refused message does not, however long the page waits
      for (let i = 0; i < 2; i++) {
        w.advance(BUDGET_WINDOW_MS);
        await settle(30);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(A.link._held.length, 0, how + ': nothing waits in the link');
      assert.equal(atB('refused at once'), 0, how + ': nothing sent it by itself');
      assert.equal(mine().status, 'failed');
      if (how === 'next') {
        await A.apps.send(a, 'the next one');
        await until(() => atB('refused at once') === 1 && atB('the next one') === 1, 'the next message takes it along');
      } else {
        assert.deepEqual(await A.apps.retry(a, s.id), { ok: true });
        await until(() => atB('refused at once') === 1, 'Try again sends it');
      }
      await until(() => mine().status === 'delivered', how + ': and it is Delivered');
    }
  });

  // verify round 3, A-9 and B-7: the Known limits sentence of docs/APPS.md says only the frames the page already handed to its link go before
  // the goodbye; a message still waiting in the page ends with the conversation
  test('leaving a conversation while a message still waits in the page: the frames the link held go and then the goodbye; the message in the page never reaches the other side, it ends with the conversation', async () => {
    const w = makeWorld();
    const { A, B, a, b } = await pairUp(w, RELAY);
    const lane = laneOf(A);
    await fillMinute(w, A);
    await owe(A, B, b, HELD_PER_LANE, lane);
    const refusedHere = () => A.reports.filter((r) => r.name === 'link.reply' && r.fields.action === 'pair-relay' && r.fields.ok === false && r.fields.reason === 'too-many-relays').length;
    const s = await A.apps.send(a, 'still in the page');
    assert.ok(s.id, JSON.stringify(s));
    await until(() => refusedHere() === 1, 'the link refused it at once: it waits in the page');
    assert.equal(conv(A).messages.find((m) => m.id === s.id).status, 'queued', 'it waits in the page');
    // the count has room again: the Delivered marks the link held go; the refused message stays in the page (the test above)
    w.advance(BUDGET_WINDOW_MS);
    await settle(30);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(A.link._held.length, 0, 'nothing waits in the link');
    assert.equal(A.apps.convs.get(a).p.outbox.length, 1, 'the message still waits in the page');
    assert.equal(conv(B).messages.filter((m) => m.mine && m.status === 'delivered').length, HELD_PER_LANE, 'what the link held reached B');
    const from = A.link._ws.sent.length;
    assert.deepEqual(await A.apps.leave(a), { ok: true });
    await until(() => conv(B).status === 'left', 'the goodbye reached B');
    await settle(30);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(relayedOn(A, lane, from), 1, 'one frame went after the leave began: the goodbye alone');
    assert.equal(conv(B).messages.filter((m) => !m.mine && m.text === 'still in the page').length, 0, 'the message that waited in the page did not reach B: it ended with the conversation');
    const gone = A.apps.convs.get(a);
    assert.ok(!gone || gone.p.outbox.length === 0, 'nothing of it waits in the page any more');
  });
});

describe('what the service tells, and what it never tells', () => {
  test('a pairing, messages, a room, a drop and a leave: no field of any report holds a lane id, a frame or a text, and the lane events are words and counts', async () => {
    const w = makeWorld();
    const { A, B, a, b } = await pairUp(w, RELAY, { names: ['Zelda Quill', 'Orson Finch'] });
    await A.apps.send(a, 'SECRET-WORDS-first one');
    await until(() => conv(B).messages.length === 1, 'delivered');
    await B.apps.markRead(b);
    await B.apps.send(b, 'SECRET-WORDS-second one');
    await until(() => conv(A).messages.length === 2, 'the answer');
    B.link.drop();
    await until(() => conv(A).status === 'connecting', 'a drop');
    w.advance(1000);
    await until(() => isConnected(A) && isConnected(B), 'back');
    const O = await mk(w, 'Isadora Pell', RELAY);
    const M = await mk(w, 'Caspian Rook', RELAY);
    const room = await O.apps.createRoom();
    const joined = await M.apps.joinRoom(room.code);
    await until(() => st(O).requests.length === 1, 'the join request');
    await O.apps.acceptMember(st(O).requests[0].knock);
    await until(() => st(M).rooms[0].status === 'connected', 'the member is in');
    await O.apps.sendRoom(room.id, 'SECRET-WORDS-room one');
    await until(() => st(M).rooms[0].messages.length === 1, 'the room message');
    await A.apps.leave(a);
    await settle(10);
    const people = [A, B, O, M];
    const keys = people.flatMap((X) => [X.person.keys.pub, X.person.keys.chat.pub, shortIdOf(X.person.keys.pub)]);
    assert.ok(joined.id);
    scan(people, forbiddenOf(w, ['SECRET-WORDS', 'Zelda', 'Quill', 'Orson', 'Finch', 'Isadora', 'Pell', 'Caspian', 'Rook'].concat(keys)));
    // the lane events: only the closed list of words, and a count ('alone' is the hint of a pair that nobody joined, polish batch P2.D6)
    const words = new Set(['join', 'joined', 'left', 'full', 'busy', 'off', 'invalid', 'unknown', 'rate', 'dead', 'direct-unavailable', 'alone']);
    const lanes = people.flatMap((X) => X.reports.filter((r) => r.name === 'apps.lane'));
    assert.ok(lanes.length >= 8, 'the lane events were reported: ' + lanes.length);
    for (const r of lanes) {
      assert.deepEqual(Object.keys(r.fields).sort().filter((k) => k !== 'peers'), ['ev']);
      assert.ok(words.has(r.fields.ev), r.fields.ev);
      if ('peers' in r.fields) assert.ok(Number.isInteger(r.fields.peers) && r.fields.peers >= 0 && r.fields.peers <= 15);
    }
    // every wire event names its carrier
    const wires = people.flatMap((X) => X.reports.filter((r) => r.name === 'apps.wire'));
    assert.ok(wires.length > 0 && wires.every((r) => r.fields.via === 'relay'), JSON.stringify(wires.map((r) => r.fields.via)));
    // and a relay frame is reported by its name and the time it took, nothing else
    const relays = people.flatMap((X) => X.reports.filter((r) => r.name === 'link.reply' && r.fields.action === 'pair-relay' && r.fields.ok === true));
    assert.ok(relays.length > 4);
    for (const r of relays) assert.deepEqual(Object.keys(r.fields).sort(), ['action', 'ms', 'ok']);
  });

  test('the same scan with a refused join, a rendezvous with the relay off, and a lane that is unknown: still words and counts', async () => {
    const w = makeWorld({ relayLane: false });
    const A = await mk(w, 'Alice', RELAY);
    const B = await mk(w, 'Bob', RELAY);
    const { code } = await A.apps.openCode();
    await B.apps.knock(code);
    await until(() => st(A).requests.length === 1, 'the request');
    await A.apps.accept(st(A).requests[0].knock);
    await until(() => A.reports.some((r) => r.fields.ev === 'off') && B.reports.some((r) => r.fields.ev === 'off'), 'told as off on both sides');
    assert.equal(A.reports.filter((r) => r.name === 'apps.lane' && r.fields.ev === 'off').length, 1, 'once per side');
    assert.equal(B.reports.filter((r) => r.name === 'apps.lane' && r.fields.ev === 'off').length, 1);
    assert.equal(conv(A).status, 'connecting', 'no error card: the conversation just does not connect without a path');
    assert.equal(conv(A).reason, 'no-path'); // DECISIONS DEC-5: the only path was refused for good, and the conversation says so (was null)
    scan([A, B], forbiddenOf(w, ['Alice', 'Bob']));
  });
});

/**
 * A rendezvous that refuses every relay join with this text while `when()` says so (always, by default; the direct path, FakeNetwork, is not
 * touched). It answers in front of the rendezvous, as plan 3.1 shapes a failure ({ action, rid, 'failure reason' }), so the stub and the real
 * core are refused alike; when `when()` says no, the join goes through to the rendezvous itself.
 */
function refuseJoins (w, text, when = () => true) {
  const orig = w.rdv.handle.bind(w.rdv);
  w.rdv.handle = (conn, m) => (when() && m && /^(?:pair|room)-join$/.test(m.action)
    ? w.rdv._send(conn, Object.assign({ action: m.action }, typeof m.rid === 'string' ? { rid: m.rid } : {}, { 'failure reason': text }))
    : orig(conn, m));
}

describe('joins that fail', () => {
  test('a lane the rendezvous does not know, with no direct path: the conversation is rejected as bad-lane; with a direct path it goes on and only says unknown', async () => {
    const w = makeWorld();
    refuseJoins(w, 'unknown lane');
    const A = await mk(w, 'Alice', RELAY);
    const B = await mk(w, 'Bob', RELAY);
    const { code } = await A.apps.openCode();
    await B.apps.knock(code);
    await until(() => st(A).requests.length === 1, 'the request');
    await A.apps.accept(st(A).requests[0].knock);
    assert.equal(conv(A).status, 'rejected');
    assert.equal(conv(A).reason, 'bad-lane');
    await until(() => conv(B).status === 'rejected', 'and on the other side');
    assert.equal(conv(B).reason, 'bad-lane');
    assert.deepEqual(A.reports.filter((r) => r.name === 'apps.lane').map((r) => r.fields.ev), ['join', 'unknown']);
    // with direct on and a network that connects, the same refusal costs nothing
    const w2 = makeWorld();
    refuseJoins(w2, 'unknown lane');
    const P = await pairUp(w2, BOTH);
    assert.deepEqual([conv(P.A).status, conv(P.B).status], ['connected', 'connected']);
    assert.deepEqual([conv(P.A).via, conv(P.B).via], ['direct', 'direct']);
    assert.ok(P.A.reports.some((r) => r.name === 'apps.lane' && r.fields.ev === 'unknown'));
  });

  test('a full lane, a rendezvous with the relay off, a socket with no place left: each is told as one word, and none of them rejects the conversation', async () => {
    const cases = [['lane full', 'full'], ['relay is off on this rendezvous', 'off'], ['too many lanes', 'full'], ['invalid lane', 'invalid'], ['relay is busy', 'busy'], ['too many relays', 'rate'], ['too many messages', 'rate']];
    for (const [text, word] of cases) {
      const w = makeWorld();
      refuseJoins(w, text);
      const A = await mk(w, 'Alice', RELAY);
      const B = await mk(w, 'Bob', RELAY);
      const { code } = await A.apps.openCode();
      await B.apps.knock(code);
      await until(() => st(A).requests.length === 1, 'the request');
      await A.apps.accept(st(A).requests[0].knock);
      const told = (X) => X.reports.filter((r) => r.name === 'apps.lane').map((r) => r.fields.ev);
      await until(() => told(B).includes(word === 'invalid' ? 'invalid' : word), 'B is told: ' + text);
      const expected = text === 'invalid lane' ? ['join', 'invalid'] : ['join', word];
      assert.deepEqual(told(A), expected, text);
      assert.deepEqual(told(B), expected, text);
      assert.equal(conv(A).status === 'rejected', text === 'invalid lane', text); // an invalid lane is no lane: bad-lane, as the direct path says
    }
  });

  test('direct on without WebRTC on the page: the manager cannot be loaded, direct-unavailable is told once per side, and the relay carries the conversation', async () => {
    const w = makeWorld();
    const noRtc = async () => { throw Object.assign(new Error('no webrtc here'), { code: 'E_UNSUPPORTED' }); };
    const A = await mk(w, 'Alice', Object.assign({ deps: { loadTm: noRtc } }, BOTH));
    const B = await mk(w, 'Bob', Object.assign({ deps: { loadTm: noRtc } }, BOTH));
    const { code } = await A.apps.openCode();
    await B.apps.knock(code);
    await until(() => st(A).requests.length === 1, 'the request');
    const acc = await A.apps.accept(st(A).requests[0].knock);
    assert.ok(acc.id, 'the accept goes through: ' + JSON.stringify(acc));
    await until(() => isConnected(A) && isConnected(B), 'connected through the relay');
    assert.deepEqual([conv(A).via, conv(B).via], ['relay', 'relay']);
    for (const X of [A, B]) assert.equal(X.reports.filter((r) => r.name === 'apps.lane' && r.fields.ev === 'direct-unavailable').length, 1, X.name);
    assert.deepEqual([A.tm.joined, B.tm.joined], [[], []]);
    await A.apps.send(conv(A).id, 'still arrives');
    await until(() => conv(B).messages.length === 1, 'a message');
    // with no relay on the door the same page still gets the error it always got
    const w2 = makeWorld();
    const C = await mk(w2, 'Carol', Object.assign({ deps: { loadTm: noRtc } }, LEGACY));
    const D = await mk(w2, 'Dave', LEGACY);
    const c = await C.apps.openCode();
    await D.apps.knock(c.code);
    await until(() => st(C).requests.length === 1, 'the request');
    assert.deepEqual(await C.apps.accept(st(C).requests[0].knock), { error: 'no manager' });
    assert.equal(st(C).requests.length, 1, 'and the request waits');
  });

  test('a door with relay none and direct off has no way to connect; the service does not throw, and the conversation stays connecting', async () => {
    const w = makeWorld();
    const A = await mk(w, 'Alice', { relay: 'none', direct: 'off' });
    const B = await mk(w, 'Bob', { relay: 'none', direct: 'off' });
    assert.deepEqual(st(A).cfg, { relay: 'none', direct: 'off' });
    const { code } = await A.apps.openCode();
    await B.apps.knock(code);
    await until(() => st(A).requests.length === 1, 'the request');
    const acc = await A.apps.accept(st(A).requests[0].knock);
    assert.ok(acc.id);
    await until(() => conv(B).status === 'connecting', 'the other side is accepted');
    await settle(10);
    w.advance(120000);
    assert.deepEqual([conv(A).status, conv(B).status], ['connecting', 'connecting']);
    assert.deepEqual([A.loadCalls.length, B.loadCalls.length, framesOf(w, 'pair-join').length], [0, 0, 0]);
  });
});

// The orchestrator's decisions on the lane (DECISIONS.md: DEC-1 client side, DEC-5 service side). A full lane is not final: the member in the
// way may be a socket the rendezvous has not found dead yet, so the join is asked again; a socket the rendezvous forgot joins once more; and a
// conversation whose only path is refused for good says so instead of connecting for ever.
describe('DEC-1 and DEC-5: a full lane is asked again, an evicted socket joins again, a refused only path says no-path', () => {
  const joins = (w, action = 'pair-join') => framesOf(w, action).length;
  const evs = (X) => X.reports.filter((r) => r.name === 'apps.lane').map((r) => r.fields.ev);
  const toldFull = (X) => evs(X).filter((ev) => ev === 'full').length;
  const told = (X, ev) => X.reports.filter((r) => r.name === 'apps.lane' && r.fields.ev === ev).length;
  /** A owns a code, B knocks, A accepts; the pair is left to the rendezvous (no wait for a connection). */
  async function acceptBetween (A, B) {
    const { code } = await A.apps.openCode();
    await B.apps.knock(code);
    await until(() => st(A).requests.length === 1, 'the request');
    const acc = await A.apps.accept(st(A).requests[0].knock);
    assert.ok(acc.id, JSON.stringify(acc));
  }

  test('lane full is not final: the join is asked again after 3, 10 and 30 seconds and then every minute while the conversation lives and the socket is open; full is told once per side; the first free place connects the pair', async () => {
    const w = makeWorld();
    let full = true;
    refuseJoins(w, 'lane full', () => full);
    const A = await mk(w, 'Alice', RELAY);
    const B = await mk(w, 'Bob', RELAY);
    await acceptBetween(A, B);
    await until(() => toldFull(A) === 1 && toldFull(B) === 1, 'both told full');
    assert.equal(joins(w), 2);
    assert.deepEqual([conv(A).status, conv(B).status], ['connecting', 'connecting']);
    assert.deepEqual([conv(A).reason, conv(B).reason], [null, null], 'a full lane is no refusal of the path');
    let expected = 2;
    for (const wait of [3000, 10000, 30000, 60000, 60000, 60000]) {
      w.advance(wait - 1);
      await settle(10);
      assert.equal(joins(w), expected, 'nothing is asked a tick before ' + wait + ' ms');
      w.advance(1);
      expected += 2;
      await until(() => joins(w) === expected, 'both ask again at ' + wait + ' ms');
      await settle(10); // the refusal comes back and the next try is scheduled before the clock moves on
    }
    assert.deepEqual([toldFull(A), toldFull(B)], [1, 1], 'full is told once per episode, not once per try');
    assert.deepEqual([conv(A).status, conv(B).status], ['connecting', 'connecting']);
    full = false; // a place is free (the rendezvous evicted the stale member): the next try joins
    w.advance(60000);
    await until(() => isConnected(A) && isConnected(B), 'both connected after the retry');
    assert.deepEqual([conv(A).via, conv(B).via], ['relay', 'relay']);
    assert.equal(joins(w), expected + 2, 'one more join each, and none after');
    await A.apps.send(conv(A).id, 'through at last');
    await until(() => conv(B).messages.length === 1 && conv(A).messages[0].status === 'delivered', 'delivered');
    assert.deepEqual([toldFull(A), toldFull(B)], [1, 1]);
    assert.deepEqual(evs(A).slice(0, 2), ['join', 'full']);
    assert.ok(evs(A).includes('joined'));
    for (const ev of evs(A).concat(evs(B))) assert.ok(['join', 'full', 'joined'].includes(ev), ev);
    scan([A, B], forbiddenOf(w, ['through at last']));
  });

  test('the retry ends with the conversation and waits out a lost socket: a left conversation asks nothing again, and a socket that is back asks at once through the rejoin', async () => {
    const w = makeWorld();
    let full = true;
    refuseJoins(w, 'lane full', () => full);
    const A = await mk(w, 'Alice', RELAY);
    const B = await mk(w, 'Bob', RELAY);
    await acceptBetween(A, B);
    await until(() => toldFull(A) === 1 && toldFull(B) === 1, 'both told full');
    // A leaves while the retry waits: its timer is cancelled with the conversation (B keeps asking)
    await A.apps.leave(conv(A).id);
    w.advance(3000);
    await until(() => joins(w) === 3, 'B asks again, A does not');
    await settle(10);
    w.advance(10000);
    await until(() => joins(w) === 4, 'B again');
    await settle(10);
    // B loses its socket: the retry stops, and the lane is joined by the rejoin when the socket is back, not by the retry
    B.link.drop();
    await until(() => B.link.state === 'backoff', 'B lost its socket');
    w.advance(1000); // the back off: the socket opens again and _rejoinAll asks for the lane at once
    await until(() => joins(w) === 5, 'the rejoin asks at once');
    await settle(10);
    assert.equal(toldFull(B), 1, 'still one full for B: the episode goes on');
    w.advance(30000 - 1000);
    await settle(10);
    assert.equal(joins(w), 5, 'the old schedule did not fire beside the rejoin');
  });

  test('a room lane that is full is asked again too; the member who waited comes in when a place is free, with the roster and the key', async () => {
    const w = makeWorld({ caps: { roomLaneMembers: 2 } }); // the owner and one member fill it; the second member waits for a place
    const O = await mk(w, 'Olive', RELAY);
    const M1 = await mk(w, 'Mia', RELAY);
    const M2 = await mk(w, 'Max', RELAY);
    const r = await O.apps.createRoom();
    assert.ok(r.id, JSON.stringify(r));
    const roomOf = (X) => st(X).rooms[0];
    const j1 = await M1.apps.joinRoom(r.code);
    await until(() => st(O).requests.length === 1, 'the first request');
    await O.apps.acceptMember(st(O).requests[0].knock);
    await until(() => roomOf(M1).status === 'connected', 'the first member holds the key');
    const j2 = await M2.apps.joinRoom(r.code);
    await until(() => st(O).requests.length === 1, 'the second request');
    await O.apps.acceptMember(st(O).requests[0].knock);
    await until(() => toldFull(M2) === 1, 'the second member is told the lane is full');
    assert.equal(roomOf(M2).status, 'connecting');
    assert.equal(roomOf(M2).reason, null);
    const before = joins(w, 'room-join');
    w.advance(3000);
    await until(() => joins(w, 'room-join') === before + 1, 'asked again after 3 seconds');
    await settle(10);
    assert.equal(toldFull(M2), 1);
    // the first member leaves: a place is free, and the next try takes it
    const lane = laneOf(O);
    await M1.apps.leaveRoom(j1.id);
    await until(() => w.rdv.relays.get(lane).members.size === 1, 'the owner is alone in the lane');
    w.advance(10000);
    await until(() => roomOf(M2).status === 'connected', 'the second member is in, with the key');
    assert.equal(roomOf(M2).via, 'relay');
    assert.equal(toldFull(M2), 1, 'told once');
    await O.apps.sendRoom(r.id, 'welcome at last');
    await until(() => roomOf(M2).messages.length === 1, 'a room message reaches the member who waited');
    assert.ok(j2.id);
  });

  test('unknown lane after the lane was joined (this socket was evicted, or the rendezvous restarted): the lane is joined once more and what nobody acked goes again, once; a lane that is gone for good is told and left alone', async () => {
    const w = stubWorld(); // the stub: its membership can be edited behind the client's back, as an eviction does
    const { A, B, a } = await pairUp(w, RELAY);
    const lane = laneOf(A);
    await A.apps.send(a, 'before');
    await until(() => conv(B).messages.length === 1 && conv(A).messages[0].status === 'delivered', 'delivered');
    const joinsBefore = joins(w);
    // the rendezvous forgets A: evicted as stale, or its object came back empty
    const connA = A.link._ws.conn;
    const rec = w.rdv.relays.get(lane);
    rec.members.delete(connA);
    connA.joined.delete(lane);
    await A.apps.send(a, 'after the eviction');
    await until(() => conv(B).messages.length === 2, 'the message reaches B after the rejoin');
    await until(() => conv(A).messages[1].status === 'delivered', 'and is acked');
    assert.equal(joins(w), joinsBefore + 1, 'one more join, from A');
    assert.equal(conv(B).messages.filter((m) => m.text === 'after the eviction').length, 1, 'once');
    assert.deepEqual(evs(A).slice(-3), ['unknown', 'join', 'joined']);
    assert.deepEqual([conv(A).status, conv(A).via], ['connected', 'relay']);
    assert.equal(rec.members.has(connA), true, 'A is a member again');
    // the lane itself is gone (it ran out at the rendezvous): the one rejoin is refused, told, and nothing loops or waits
    rec.members.delete(connA);
    connA.joined.delete(lane);
    w.rdv.lanes.delete(lane);
    const joinsThen = joins(w);
    await A.apps.send(a, 'into the void');
    await until(() => told(A, 'unknown') === 3, 'refused twice more: the relay, then the one rejoin');
    await settle(20);
    assert.equal(joins(w), joinsThen + 1, 'one rejoin and no more');
    assert.equal(conv(A).status, 'connecting');
    w.advance(120000);
    await settle(20);
    assert.equal(joins(w), joinsThen + 1, 'and none later: unknown is not asked again on a schedule');
    assert.equal(conv(A).messages[2].status, 'failed', 'the message is failed after the ack timeout, as a message nobody acks is');
  });

  /**
   * halfOpen(w, X): the network under X's socket is gone without a word, as when a phone changes networks: what the page sends goes nowhere,
   * nothing reaches the page, and no close ever reaches the rendezvous, which keeps the socket a member of its lanes. The page finds out by
   * its keepalive (no answer within PONG_WAIT_MS) and gives the socket up. -> the conn the rendezvous still holds.
   */
  function halfOpen (w, X) {
    const ws = X.link._ws;
    const conn = ws.conn;
    conn.deliver = null; // the rendezvous' replies and pushes to this socket are lost
    ws.send = function (text) {
      if (this.readyState !== 1) throw new Error('socket is not open');
      this.sent.push(text); // and what the page writes never arrives
    };
    ws.close = function () { // the page gives the socket up; no close handshake reaches the rendezvous
      if (this.readyState >= 2) return;
      this.readyState = 2;
      w.rdv.sockets.delete(this);
      setImmediate(() => { this.readyState = 3; this._emit('close', {}); });
    };
    return conn;
  }

  // The case DEC-1 exists for, end to end on the real client and the real core (D-integrate, D-server Ask 2): the stub tests above refuse the
  // join in front of the rendezvous; here nothing is faked but the network, and the core itself evicts the socket the roaming phone left behind.
  test('a roaming phone on the real core: B\'s socket goes half open, its new socket finds the lane full and asks again on the schedule, the core evicts the silent socket once it is older than memberStaleMs, and what both wrote meanwhile goes once each way', async () => {
    assert.ok(CORE_RELAY, 'this test needs the real pairing core (deploy/rtc-worker/pair.js)');
    const STALE_MS = 120000; // DEFAULT_CAPS.memberStaleMs of pair.js (DECISIONS DEC-1)
    const w = makeWorld();
    // the time of every join the rendezvous gets, by socket
    const joinsAt = [];
    const handle = w.rdv.handle.bind(w.rdv);
    w.rdv.handle = (conn, m) => {
      if (m && m.action === 'pair-join') joinsAt.push({ conn: conn.id, t: w.clock.now() });
      return handle(conn, m);
    };
    // the clock moves in steps of 5 seconds with the pages' work done in between, so that every pong is in before its watchdog looks
    // (PONG_WAIT_MS is 10 seconds); one jump of a minute would fire a ping and its watchdog together and drop a healthy socket
    const run = async (ms) => {
      for (let left = ms; left > 0; left -= 5000) {
        w.advance(Math.min(5000, left));
        await settle(10);
      }
    };
    const { A, B, a, b } = await pairUp(w, Object.assign({ linkOptions: { keepaliveMs: KEEPALIVE_MS } }, RELAY));
    const lane = laneOf(A);
    const aConn = connOf(A);
    await A.apps.send(a, 'before the roaming');
    await until(() => conv(B).messages.length === 1 && conv(A).messages[0].status === 'delivered', 'a message before');
    const lastWord = w.clock.now(); // the old socket's last message reached the core now (its ack); the clock has not moved since the pairing
    const old = halfOpen(w, B);
    await A.apps.send(a, 'written while Bob roams');
    await B.apps.send(b, 'written by Bob while roaming');
    await settle(10);
    // the keepalive: A's ping reaches the core (A stays live), B's goes nowhere; with no answer in PONG_WAIT_MS B's page gives the socket up
    await run(KEEPALIVE_MS + PONG_WAIT_MS);
    await until(() => B.link.state === 'backoff', 'B gave its half-open socket up');
    assert.equal(old.closed, false, 'no close reached the rendezvous');
    assert.ok(w.rdv.relays.get(lane).members.has(old), 'the old socket is still a member of the lane');
    assert.deepEqual([conv(A).status, connOf(A)], ['connected', aConn], 'and A cannot tell');
    // the new socket opens after the back off and joins at once: the lane is full of A and the old socket, silent for about a minute
    await run(BACKOFF_MS[0]);
    await until(() => toldFull(B) === 1, 'B is told the lane is full');
    const bNew = connOf(B);
    assert.notEqual(bNew, old.id);
    assert.deepEqual([conv(B).status, conv(B).reason], ['connecting', null], 'a full lane is no refusal of the path');
    // DEC-1: B asks again on the schedule; the core evicts the old socket at the first join after it has been silent past memberStaleMs
    for (let i = 0; i < 40 && !(isConnected(B) && conv(B).via === 'relay'); i++) await run(5000);
    await until(() => isConnected(A) && isConnected(B) && conv(B).via === 'relay', 'both connected again through the relay');
    const tried = joinsAt.filter((j) => j.conn === bNew);
    const letIn = tried[tried.length - 1];
    assert.ok(tried.length >= 4, 'the rejoin and the retries of 3, 10 and 30 seconds came before: ' + tried.length);
    assert.ok(tried.slice(0, -1).every((j) => j.t - lastWord <= STALE_MS), 'every refused join came while the old socket was within memberStaleMs');
    assert.ok(letIn.t - lastWord > STALE_MS, 'the join let in came after the old socket had been silent past memberStaleMs');
    assert.ok(letIn.t - tried[tried.length - 2].t >= 60000, 'and it was the retry of a minute later');
    const byNumber = (x, y) => x - y;
    assert.deepEqual(joinsAt.filter((j) => j.conn !== bNew).map((j) => j.conn).sort(byNumber), [aConn, old.id].sort(byNumber), 'nobody else joined again: A kept its socket all along');
    assert.deepEqual([connOf(A), connOf(B)], [aConn, bNew]);
    await until(() => old.closed, 'the host closes and releases the evicted socket');
    assert.equal(w.rdv.conns.has(old), false);
    assert.equal(w.rdv.relayStats().evicted, 1, 'one member evicted today');
    const members = w.rdv.relays.get(lane).members;
    assert.deepEqual([members.size, members.has(old), members.has(B.link._ws.conn)], [2, false, true], 'A and B\'s new socket');
    // what both wrote while B roamed goes once each way and is acked
    await until(() => conv(B).messages.some((m) => !m.mine && m.text === 'written while Bob roams'), 'A\'s message at B');
    await until(() => conv(A).messages.some((m) => !m.mine && m.text === 'written by Bob while roaming'), 'B\'s message at A');
    const acked = (X) => X.apps.state().conversations[0].messages.filter((m) => m.mine).every((m) => m.status === 'delivered' || m.status === 'read');
    await until(() => acked(A) && acked(B), 'acked both ways');
    await settle(30);
    assert.equal(conv(B).messages.filter((m) => m.text === 'written while Bob roams').length, 1, 'once at B');
    assert.equal(conv(A).messages.filter((m) => m.text === 'written by Bob while roaming').length, 1, 'once at A');
    assert.deepEqual([toldFull(A), toldFull(B)], [0, 1], 'full was told once, to B, for the whole episode');
    assert.ok(evs(A).includes('left') && evs(A).includes('joined'), 'A heard the old socket leave and the new one join: ' + evs(A).join(','));
    scan([A, B], forbiddenOf(w, ['before the roaming', 'written while Bob roams', 'written by Bob while roaming']));
  });

  test('invalid action as the answer to a join (a rendezvous from before the relay) is the relay being off: told as off, no retry, and the conversation says no-path', async () => {
    const w = makeWorld();
    refuseJoins(w, 'invalid action');
    const A = await mk(w, 'Alice', RELAY);
    const B = await mk(w, 'Bob', RELAY);
    await acceptBetween(A, B);
    await until(() => told(A, 'off') === 1 && told(B, 'off') === 1, 'both told off');
    assert.deepEqual([evs(A), evs(B)], [['join', 'off'], ['join', 'off']]);
    await until(() => conv(A).reason === 'no-path' && conv(B).reason === 'no-path', 'both say no-path');
    assert.deepEqual([conv(A).status, conv(B).status], ['connecting', 'connecting']);
    w.advance(10 * 60000);
    await settle(10);
    assert.equal(joins(w), 2, 'off is final: no join is asked again');
    // with direct on and a network that connects, the pair goes direct and nothing is wrong with it
    const w2 = makeWorld();
    refuseJoins(w2, 'invalid action');
    const P = await pairUp(w2, BOTH);
    assert.deepEqual([conv(P.A).via, conv(P.A).reason, conv(P.B).reason], ['direct', null, null]);
    assert.ok(P.A.reports.some((r) => r.name === 'apps.lane' && r.fields.ev === 'off'));
  });

  test('the relay off at the rendezvous with no direct path: the conversation says no-path in state() and in its usage report, stays connecting, asks no join again; a direct path that exists keeps it quiet; direct on without WebRTC is no path either', async () => {
    const w = makeWorld({ relayLane: false });
    const A = await mk(w, 'Alice', RELAY);
    const B = await mk(w, 'Bob', RELAY);
    await acceptBetween(A, B);
    await until(() => conv(A).reason === 'no-path' && conv(B).reason === 'no-path', 'both say no-path');
    assert.deepEqual([conv(A).status, conv(B).status], ['connecting', 'connecting']);
    for (const X of [A, B]) {
      assert.equal(told(X, 'off'), 1, X.name + ' told off once');
      const saidSo = X.reports.filter((r) => r.name === 'apps.conv' && r.fields.reason === 'no-path');
      assert.equal(saidSo.length, 1, X.name + ' said so once');
      assert.equal(saidSo[0].fields.status, 'connecting');
    }
    w.advance(10 * 60000);
    await settle(10);
    assert.equal(joins(w), 2, 'off is final: no join is asked again');
    assert.deepEqual([conv(A).reason, conv(B).reason], ['no-path', 'no-path'], 'and it stays said');
    scan([A, B], forbiddenOf(w));
    // direct on and a network that connects: a path exists, nothing is said
    const w2 = makeWorld({ relayLane: false });
    const P = await pairUp(w2, BOTH);
    assert.deepEqual([conv(P.A).via, conv(P.A).reason, conv(P.B).reason], ['direct', null, null]);
    // direct on but no WebRTC on the page: the relay was the only path, and it is refused
    const w3 = makeWorld({ relayLane: false });
    const noRtc = async () => { throw Object.assign(new Error('no webrtc here'), { code: 'E_UNSUPPORTED' }); };
    const C = await mk(w3, 'Carol', Object.assign({ deps: { loadTm: noRtc } }, BOTH));
    const D = await mk(w3, 'Dave', Object.assign({ deps: { loadTm: noRtc } }, BOTH));
    await acceptBetween(C, D);
    await until(() => conv(C).reason === 'no-path' && conv(D).reason === 'no-path', 'no path on either side');
    assert.equal(told(C, 'direct-unavailable'), 1);
  });

  test('rooms likewise: with the relay off and direct off the owner\'s room and the member\'s room say no-path, in state() and in the usage report', async () => {
    const w = makeWorld({ relayLane: false });
    const O = await mk(w, 'Olive', RELAY);
    const M = await mk(w, 'Mia', RELAY);
    const r = await O.apps.createRoom();
    assert.ok(r.id, JSON.stringify(r));
    const roomOf = (X) => st(X).rooms[0];
    const j = await M.apps.joinRoom(r.code);
    assert.ok(j.id, JSON.stringify(j));
    await until(() => st(O).requests.length === 1, 'the request');
    assert.equal(roomOf(O).reason, null, 'nothing joins a lane before approval, so nothing is refused yet');
    const status = roomOf(O).status;
    assert.equal((await O.apps.acceptMember(st(O).requests[0].knock)).id, r.id);
    await until(() => roomOf(O).reason === 'no-path', 'the owner\'s room says so once its lane is refused, at the first accept');
    assert.equal(roomOf(O).status, status, 'the owner\'s room stays what it was');
    await until(() => roomOf(M).reason === 'no-path', 'the member\'s room too');
    assert.equal(roomOf(M).status, 'connecting');
    for (const X of [O, M]) assert.ok(X.reports.some((x) => x.name === 'apps.room' && x.fields.reason === 'no-path'), X.name);
    assert.equal(told(O, 'off') + told(M, 'off'), 2);
    w.advance(10 * 60000);
    await settle(10);
    assert.equal(joins(w, 'room-join'), 2, 'no join is asked again');
  });

  test('when the rendezvous carries messages again (its socket comes back with the relay on) the lane is joined on the rejoin and no-path is cleared', async () => {
    const w = stubWorld({ relayLane: false }); // the stub: its switch moves half-way through, which a redeploy of the Worker does
    const A = await mk(w, 'Alice', RELAY);
    const B = await mk(w, 'Bob', RELAY);
    await acceptBetween(A, B);
    await until(() => conv(A).reason === 'no-path' && conv(B).reason === 'no-path', 'both say no-path');
    w.rdv.relayLane = true;
    A.link.drop();
    B.link.drop();
    await until(() => A.link.state === 'backoff' && B.link.state === 'backoff', 'both sockets lost');
    w.advance(1000);
    await until(() => isConnected(A) && isConnected(B), 'both connected through the relay');
    assert.deepEqual([conv(A).reason, conv(B).reason, conv(A).via], [null, null, 'relay']);
    await A.apps.send(conv(A).id, 'carried after all');
    await until(() => conv(B).messages.length === 1 && conv(A).messages[0].status === 'delivered', 'delivered');
  });
});

// The silent stuck state (audit 8.2, lane A, finding F1; polish decisions P2.D1 to D6). A page of the old build never joins the relay lane: it has
// no join request at all, and its own meeting point is a second socket that the pair protocol cannot see. A new page that meets one is told
// "nobody else" at its join and nothing after, and both read "Connecting..." for ever with no error. LEGACY (relay none, so direct only, with no
// pair-join) is the stand-in of the old page on these fakes. The new page says what it does know after LIMITS.aloneHintMs, in a field of its own
// (hint), tells one report word and sends no frame for it. The old page cannot be helped from here, and a room has no such hint (P2.D4).
describe('a page that never joins the relay lane: the hint alone', () => {
  const HINT = LIMITS.aloneHintMs;
  const told = (X, ev) => X.reports.filter((r) => r.name === 'apps.lane' && r.fields.ev === ev).length;
  const laneEvs = (X) => X.reports.filter((r) => r.name === 'apps.lane').map((r) => r.fields.ev);
  const hintOf = (X) => conv(X).hint;
  // the private record of the first conversation: its hint timer is read where a test has to prove that none is left
  const recOf = (X) => Array.from(X.apps.convs.values())[0];
  // the state of a page as plain JSON with the one field under test left out: what the hint must never touch
  const apart = (X) => {
    const s = JSON.parse(JSON.stringify(st(X)));
    for (const c of s.conversations) delete c.hint;
    return s;
  };

  /**
   * The new page (the shipped default door unless `door` says otherwise) and the stand-in of an old one, accepted, with nobody connected yet.
   * Resolves when the new page has joined the relay lane and was told that nobody else is in it. -> { N, O, idle }
   */
  async function stuck (w, { newIsOwner = true, door = RELAY, limits } = {}) {
    const N = await mk(w, 'Nora', Object.assign({ limits }, door));
    const O = await mk(w, 'Olga', Object.assign({ limits }, LEGACY));
    const idle = w.clock.pending(); // the timers of the world before anyone has done anything: the count a page that is done must come back to
    const [owner, asker] = newIsOwner ? [N, O] : [O, N];
    const { code } = await owner.apps.openCode();
    const k = await asker.apps.knock(code);
    assert.ok(k.knock, JSON.stringify(k));
    await until(() => st(owner).requests.length === 1, 'the request');
    const acc = await owner.apps.accept(st(owner).requests[0].knock);
    assert.ok(acc.id, JSON.stringify(acc));
    await until(() => told(N, 'joined') === 1, 'the new page joined the lane and was told that nobody else is in it');
    await settle(5);
    return { N, O, idle };
  }

  for (const newIsOwner of [true, false]) {
    test('the old page ' + (newIsOwner ? 'asks and the new one owns the code' : 'owns the code and the new one asks') + ': no hint one millisecond short of the time, the hint at it, nothing else changes, nothing is sent; the old page is never hinted', async () => {
      const w = makeWorld();
      const { N, O, idle } = await stuck(w, { newIsOwner });
      assert.equal(w.clock.pending(), idle + 1, 'the wait is one timer, and the only one the stuck pair holds');
      assert.deepEqual([conv(N).status, conv(N).via, conv(N).reason, conv(N).hint], ['connecting', null, null, null]);
      assert.deepEqual([recOf(N).p.rst.joined, recOf(N).p.rst.peers], [true, 0], 'the new page is in the lane and counts nobody else');
      assert.equal(recOf(O).p.rst, null, 'the stand-in of the old page has no relay lane at all');
      const rawAt = w.rdv.raw.length;
      const before = apart(N);
      w.advance(HINT - 1);
      await settle(5);
      assert.equal(hintOf(N), null, 'one millisecond short of the time');
      assert.equal(told(N, 'alone'), 0);
      w.advance(1);
      assert.equal(hintOf(N), 'alone', 'at the time');
      assert.equal(w.clock.pending(), idle, 'and the timer is spent');
      assert.deepEqual(apart(N), before, 'nothing else about the page changed: status, via, reason, the compare line, the messages, the link');
      assert.deepEqual(N.reports.filter((r) => r.name === 'apps.lane' && r.fields.ev === 'alone').map((r) => r.fields), [{ ev: 'alone', peers: 0 }], 'one word and a count');
      assert.equal(w.rdv.raw.length, rawAt, 'the hint sent nothing to the rendezvous');
      assert.deepEqual([hintOf(O), told(O, 'alone')], [null, 0], 'the old page is not hinted and tells nothing');
      assert.ok('hint' in conv(O) && 'hint' in conv(N), 'every conversation carries the field');
      // it stays while the fact does, is not told again, and leaves no timer behind
      w.advance(10 * 60000);
      await settle(5);
      assert.equal(hintOf(N), 'alone');
      assert.equal(told(N, 'alone'), 1, 'told once for the episode');
      assert.equal(recOf(N).p.aloneTimer, null);
    });
  }

  test('a message typed while the page is alone turns Not sent at the moment the hint comes: the page gives one answer to one question', async () => {
    const w = makeWorld();
    const { N } = await stuck(w);
    const sent = await N.apps.send(conv(N).id, 'written while alone');
    assert.ok(sent.id, JSON.stringify(sent));
    assert.equal(conv(N).messages[0].status, 'queued');
    w.advance(HINT - 1);
    assert.deepEqual([hintOf(N), conv(N).messages[0].status], [null, 'queued']);
    w.advance(1);
    assert.deepEqual([hintOf(N), conv(N).messages[0].status], ['alone', 'failed']);
    assert.equal(conv(N).pending, 1, 'the message waits in the page, as a message nobody acked always does');
  });

  test('two new pages and the second one slow to join: the early page is hinted at the time, the page that has not joined is not, and when the late join is released both connect and the hint goes with its timer', async () => {
    const w = makeWorld();
    const A = await mk(w, 'Alice', RELAY);
    const B = await mk(w, 'Bob', RELAY);
    const release = gateJoin(B);
    const { code } = await A.apps.openCode();
    await B.apps.knock(code);
    await until(() => st(A).requests.length === 1, 'the request');
    await A.apps.accept(st(A).requests[0].knock);
    // B's record, not its state(): the snapshot is not made again while a join is on its way, so it still reads the status of before the accept
    await until(() => told(A, 'joined') === 1 && recOf(B) && recOf(B).status === 'connecting' && recOf(B).p.rst, 'A is in the lane alone, B is accepted and its join is held');
    await settle(5);
    assert.equal(recOf(B).p.rst.joined, false);
    w.advance(HINT);
    assert.equal(hintOf(A), 'alone');
    assert.deepEqual([recOf(B).hint, hintOf(B)], [null, null], 'B\'s own join has not gone, so B cannot say that the other page has not joined');
    assert.deepEqual([told(A, 'alone'), told(B, 'alone')], [1, 0]);
    release();
    await until(() => isConnected(A) && isConnected(B), 'both connected through the relay once the late join is let go');
    assert.deepEqual([hintOf(A), hintOf(B)], [null, null]);
    assert.deepEqual([recOf(A).p.aloneTimer, recOf(B).p.aloneTimer], [null, null]);
    assert.deepEqual(laneEvs(A), ['join', 'joined', 'alone', 'joined'], 'the report of the hint came between the join and the late arrival');
    assert.deepEqual(laneEvs(B), ['join', 'joined']);
    w.advance(2 * HINT);
    await settle(5);
    assert.equal(told(A, 'alone'), 1, 'and no second one');
  });

  test('two new pages that connect at once: no hint, no alone report and no timer, two minutes and more later', async () => {
    const w = makeWorld();
    const { A, B } = await pairUp(w, RELAY);
    assert.deepEqual([recOf(A).p.aloneTimer, recOf(B).p.aloneTimer], [null, null], 'the second join ended the watch of the first');
    w.advance(2 * HINT);
    w.advance(2 * 60000);
    await settle(10);
    assert.deepEqual([hintOf(A), hintOf(B)], [null, null]);
    assert.deepEqual([told(A, 'alone'), told(B, 'alone')], [0, 0]);
    assert.deepEqual([conv(A).status, conv(B).status], ['connected', 'connected']);
  });

  test('the socket of the alone page is lost: the hint goes at once with its timer, the rejoin starts the time again from zero, and the hint comes 20 seconds after it, with a report each time', async () => {
    const w = makeWorld();
    const { N } = await stuck(w);
    w.advance(HINT);
    assert.equal(hintOf(N), 'alone');
    N.link.drop();
    await until(() => N.link.state === 'backoff', 'the socket was lost');
    assert.equal(hintOf(N), null, 'the page is not in the lane any more, so it says nothing about who is');
    assert.equal(recOf(N).p.aloneTimer, null);
    w.advance(1000); // the back off: the socket opens again and the lane is joined at once
    await until(() => told(N, 'joined') === 2, 'the rejoin found nobody again');
    await settle(5);
    assert.equal(hintOf(N), null, 'the time starts again from zero');
    w.advance(HINT - 1);
    assert.equal(hintOf(N), null);
    w.advance(1);
    assert.equal(hintOf(N), 'alone');
    assert.equal(told(N, 'alone'), 2, 'one report for each time the hint came up');
    // a socket lost before the time is up cancels the wait as well
    N.link.drop();
    await until(() => N.link.state === 'backoff', 'the socket was lost again');
    w.advance(1000);
    await until(() => told(N, 'joined') === 3, 'the third join');
    await settle(5);
    w.advance(HINT - 5000);
    assert.notEqual(recOf(N).p.aloneTimer, null, 'the wait of the third join is running');
    N.link.drop();
    await until(() => N.link.state === 'backoff', 'and once more, before the time was up');
    assert.deepEqual([hintOf(N), recOf(N).p.aloneTimer], [null, null]);
    w.advance(5000);
    await settle(5);
    assert.equal(hintOf(N), null, 'the first wait did not run on through the loss');
    assert.equal(told(N, 'alone'), 2);
  });

  test('a pair that was connected once has no hint: when the other page goes and does not come back, the page is alone in the lane and says nothing about it, also after its own rejoin', async () => {
    const w = makeWorld();
    const { A, B } = await pairUp(w, RELAY);
    const lane = laneOf(A);
    B.apps.destroy(); // the other page is closed for good: it leaves the lane and its socket is gone
    await until(() => conv(A).status === 'connecting', 'A heard the other page leave');
    assert.equal(w.rdv.relays.get(lane).members.size, 1, 'A is alone in the lane, as the rendezvous counts');
    assert.equal(typeof conv(A).lastSeenAt, 'number');
    w.advance(2 * HINT);
    await settle(10);
    assert.equal(hintOf(A), null);
    assert.equal(recOf(A).p.aloneTimer, null);
    // A's own socket is lost and comes back: the join is answered with nobody else, as a first join of a stuck pair is, and still the pair was seen
    A.link.drop();
    await until(() => A.link.state === 'backoff', 'the socket was lost');
    w.advance(1000);
    await until(() => told(A, 'joined') === 2, 'the rejoin found nobody');
    await settle(5);
    assert.deepEqual([recOf(A).p.rst.joined, recOf(A).p.rst.peers, conv(A).status], [true, 0, 'connecting']);
    assert.equal(recOf(A).p.aloneTimer, null, 'a pair that was seen is not waited on');
    w.advance(2 * HINT);
    await settle(10);
    assert.equal(hintOf(A), null);
    assert.equal(told(A, 'alone'), 0);
  });

  // The only way a pair is seen and still reads connecting: a valid frame of the other person arrives while the relay path is not in use. The rendezvous
  // is the only one that says who is in the lane, so it can hand over a frame while it counts nobody else (LADV-6 lets it lie about the count). The page
  // has then seen the other person once, whatever the count says, and the wait for a page that "has not joined" is over (finding F6 of the suites verify,
  // round 1: nothing else in _isAlone decides this case).
  test('a valid frame of the other person that arrives while the rendezvous counts nobody else ends the wait for good: the pair was seen, so no hint and no report, although the status stays connecting', async () => {
    const w = makeWorld();
    const { N, O } = await stuck(w);
    assert.notEqual(recOf(N).p.aloneTimer, null, 'the wait is running');
    assert.deepEqual([conv(N).lastSeenAt, conv(N).connectedAt], [null, null]);
    w.advance(HINT / 2);
    const now = w.clock.now();
    const sealed = await sealDmBody({ keys: O.person.keys, peerEk: N.person.keys.chat.pub, body: { k: 'msg', id: 'SEENALONESEEN001', t: now, text: 'I am here', fmt: 'md1' }, now, n: 1 });
    await pushTo(w, N, { action: 'pair-relayed', lane: laneOf(N), f: b64url.encode(encodeFrame(T.DM, sealed.payload)) });
    await until(() => conv(N).messages.length === 1, 'the frame was taken');
    await settle(5);
    assert.equal(typeof conv(N).lastSeenAt, 'number', 'the other person was seen');
    assert.deepEqual([recOf(N).p.rst.joined, recOf(N).p.rst.peers, conv(N).status, conv(N).connectedAt], [true, 0, 'connecting', null], 'and the rendezvous still counts nobody else, so the pair is not connected');
    assert.deepEqual([hintOf(N), recOf(N).p.aloneTimer], [null, null], 'the wait ended with the frame');
    w.advance(2 * HINT);
    await settle(10);
    assert.deepEqual([hintOf(N), told(N, 'alone'), conv(N).status], [null, 0, 'connecting']);
  });

  test('the other person leaves a pair that was connected: the conversation is left, not connecting, and has no hint and no timer', async () => {
    const w = makeWorld();
    const { A, B, b } = await pairUp(w, RELAY);
    assert.deepEqual(await B.apps.leave(b), { ok: true });
    await until(() => conv(A).status === 'left', 'A heard the goodbye');
    w.advance(2 * HINT);
    await settle(10);
    assert.deepEqual([conv(A).status, hintOf(A), told(A, 'alone'), recOf(A).p.aloneTimer], ['left', null, 0, null]);
  });

  test('the relay off at the rendezvous: the conversation says no-path and has no hint, no timer and no alone report', async () => {
    const w = makeWorld({ relayLane: false });
    const A = await mk(w, 'Alice', RELAY);
    const B = await mk(w, 'Bob', RELAY);
    const { code } = await A.apps.openCode();
    await B.apps.knock(code);
    await until(() => st(A).requests.length === 1, 'the request');
    await A.apps.accept(st(A).requests[0].knock);
    await until(() => conv(A).reason === 'no-path' && conv(B).reason === 'no-path', 'both say no-path');
    w.advance(2 * HINT);
    await settle(10);
    assert.deepEqual([hintOf(A), hintOf(B)], [null, null], 'a refused path keeps its own word, and the two are never both told');
    assert.deepEqual([told(A, 'alone'), told(B, 'alone')], [0, 0]);
    assert.deepEqual([recOf(A).p.aloneTimer, recOf(B).p.aloneTimer], [null, null]);
    assert.deepEqual([conv(A).status, conv(A).reason], ['connecting', 'no-path']);
  });

  // The end of the conversation, the block, the page being closed and the person signing out: the wait ends with them, the hint is gone, and
  // nothing is told later. Each is tried before the time is up (the timer must be cancelled) and after the hint came (the word must go).
  for (const how of ['leave', 'block', 'destroy', 'sign out']) {
    for (const raised of [false, true]) {
      test(how + ' ' + (raised ? 'after' : 'before') + ' the hint came: no timer of it is left, no hint, and no report later', async () => {
        const w = makeWorld();
        const { N, idle } = await stuck(w);
        const id = conv(N).id;
        const pub = conv(N).peer.pub;
        w.advance(raised ? HINT : HINT - 1000);
        assert.equal(hintOf(N), raised ? 'alone' : null);
        const timer = recOf(N).p.aloneTimer;
        assert.equal(timer === null, raised, 'a timer waits exactly while the hint has not come');
        assert.equal(w.clock.pending(), raised ? idle : idle + 1);
        if (how === 'leave') assert.deepEqual(await N.apps.leave(id), { ok: true });
        else if (how === 'block') assert.deepEqual(await N.apps.block(pub), { ok: true });
        else if (how === 'destroy') N.apps.destroy();
        else N.identity.signOut();
        await settle(10);
        if (timer !== null) assert.equal(N.apps._timers.has(timer), false, 'the timer ended with the conversation');
        assert.equal(w.clock.pending(), idle, 'the clock holds no timer of the page any more: the count is back to what it was before the pairing');
        assert.deepEqual(st(N).conversations.filter((c) => c.hint !== null), [], 'no conversation of this page carries the word');
        if (how === 'block') assert.deepEqual([conv(N).status, conv(N).hint], ['blocked', null]);
        w.advance(2 * HINT);
        await settle(5);
        assert.equal(told(N, 'alone'), raised ? 1 : 0, 'nothing is told after the end');
        assert.equal(st(N).conversations.filter((c) => c.hint !== null).length, 0);
        if (how === 'destroy' || how === 'sign out') assert.equal(N.apps._timers.size, 0, 'the page holds no timer at all');
      });
    }
  }

  // Garbage from the rendezvous is not a frame of the other person: three strikes close the relay path of the lane (it is out of use until the
  // socket opens again, _kill), and a path that is closed is not a path that waits for anyone.
  for (const raised of [false, true]) {
    test('garbage pushed at the alone page ' + (raised ? 'after' : 'before') + ' the hint came: three strikes close its relay path, the wait and the word end with it, and the next open of the socket starts the wait again', async () => {
      const w = makeWorld();
      const { N } = await stuck(w);
      w.advance(raised ? HINT : HINT - 1000);
      assert.equal(hintOf(N), raised ? 'alone' : null);
      assert.equal(recOf(N).p.aloneTimer === null, raised);
      const lane = laneOf(N);
      const conn = N.link._ws.conn;
      for (let i = 0; i < 3; i++) w.rdv._send(conn, { action: 'pair-relayed', lane, f: b64url.encode(new Uint8Array(40).fill(7)) });
      await until(() => told(N, 'dead') === 1, 'the third strike closed the relay path');
      assert.deepEqual([hintOf(N), recOf(N).hint, recOf(N).p.aloneTimer], [null, null, null]);
      w.advance(2 * HINT);
      await settle(5);
      assert.equal(told(N, 'alone'), raised ? 1 : 0, 'a closed path waits for nobody');
      // the socket is lost and comes back: the lane is joined with a clean path, and alone again, for the time again
      N.link.drop();
      await until(() => N.link.state === 'backoff', 'the socket is lost');
      w.advance(1000);
      await until(() => told(N, 'joined') === 2, 'the clean start found nobody');
      await settle(5);
      assert.equal(hintOf(N), null);
      w.advance(HINT);
      assert.equal(hintOf(N), 'alone');
      assert.equal(told(N, 'alone'), raised ? 2 : 1);
    });
  }

  test('the snapshot shows the word only while the conversation is connecting: a stale one on a connected, a blocked or a left conversation is never shown', async () => {
    const w = makeWorld();
    const { A } = await pairUp(w, RELAY);
    recOf(A).hint = 'alone'; // a stale word, as no path of the service leaves one: the guard of the snapshot is what this tries
    A.apps._touch();
    assert.deepEqual([conv(A).status, conv(A).hint], ['connected', null]);
    await A.apps.block(conv(A).peer.pub);
    recOf(A).hint = 'alone';
    A.apps._touch();
    assert.deepEqual([conv(A).status, conv(A).hint], ['blocked', null]);
    await A.apps.unblock(conv(A).peer.pub);
    recOf(A).hint = 'alone';
    A.apps._touch();
    assert.deepEqual([conv(A).status, conv(A).hint], ['left', null]);
    // and while connecting it is the word of the record, exactly the word alone or null
    const { N } = await stuck(makeWorld());
    assert.equal(N.apps.state().conversations[0].hint, null);
    recOf(N).hint = 'alone';
    N.apps._touch();
    assert.deepEqual([conv(N).status, conv(N).hint], ['connecting', 'alone']);
  });

  test('limits aloneHintMs is honoured, and the shipped value is 20 seconds, the time of ackTimeoutMs', async () => {
    assert.equal(LIMITS.aloneHintMs, 20000);
    const w = makeWorld();
    const { N } = await stuck(w, { limits: { aloneHintMs: 5000 } });
    w.advance(4999);
    assert.equal(hintOf(N), null);
    w.advance(1);
    assert.equal(hintOf(N), 'alone');
    assert.equal(told(N, 'alone'), 1);
  });

  test('direct on, a network that cannot connect: the pair is alone and the hint comes; the direct link coming up later ends it for good, and its loss does not bring the old word back', async () => {
    const w = makeWorld();
    w.net.canConnect = () => false;
    const { N, O } = await stuck(w, { door: BOTH });
    w.advance(HINT);
    assert.deepEqual([conv(N).status, conv(N).via, hintOf(N)], ['connecting', null, 'alone'], 'no direct link and nobody else in the lane');
    assert.equal(hintOf(O), null);
    // the network lets them connect after all
    w.net.canConnect = () => true;
    w.net.resume();
    await until(() => isConnected(N) && isConnected(O), 'the direct link came up');
    assert.equal(conv(N).via, 'direct');
    assert.equal(hintOf(N), null);
    assert.equal(recOf(N).hint, null, 'the word is gone from the record of the conversation, not only hidden by its status');
    assert.equal(recOf(N).p.aloneTimer, null);
    // the direct link is lost again: this pair has been seen, so it is a pair that was connected, and the word of before does not come back
    w.net.dropAll();
    await until(() => conv(N).status === 'connecting', 'the direct link was lost');
    assert.equal(hintOf(N), null);
    w.advance(2 * HINT);
    await settle(5);
    assert.deepEqual([hintOf(N), told(N, 'alone')], [null, 1]);
  });

  test('direct on, a network that connects: the pair connects on the direct link, there is never a hint, and the first frame ended the wait', async () => {
    const w = makeWorld();
    const { N, O } = await stuck(w, { door: BOTH });
    await until(() => isConnected(N) && isConnected(O), 'connected on the direct link');
    assert.equal(conv(N).via, 'direct');
    assert.equal(recOf(N).p.aloneTimer, null, 'the first frame ended the wait, which would only have found a pair that is not alone');
    w.advance(2 * HINT);
    await settle(10);
    assert.deepEqual([hintOf(N), hintOf(O), told(N, 'alone'), told(O, 'alone')], [null, null, 0, 0]);
  });

  test('direct on, a direct link that is up but carries no frame: the pair is not alone, so the time comes and nothing is said', async () => {
    const w = makeWorld();
    w.net.drops = () => true; // every frame is lost: the wires are ready, nothing is ever heard
    const { N } = await stuck(w, { door: BOTH });
    await until(() => Array.from(recOf(N).p.wires).some((x) => x.ready), 'a direct wire is ready');
    w.advance(HINT);
    await settle(5);
    assert.deepEqual([conv(N).status, hintOf(N), told(N, 'alone')], ['connecting', null, 0], 'a ready direct wire is a path: the page is not alone');
    assert.equal(recOf(N).p.aloneTimer, null);
  });

  test('a room has no such hint: the field is a conversation\'s, and a room that sits alone in its lane says nothing about it', async () => {
    const w = makeWorld();
    const O = await mk(w, 'Olive', RELAY);
    const M = await mk(w, 'Mia', LEGACY); // a member whose page never joins the relay lane
    const r = await O.apps.createRoom();
    await M.apps.joinRoom(r.code);
    await until(() => st(O).requests.length === 1, 'the join request');
    await O.apps.acceptMember(st(O).requests[0].knock);
    await until(() => told(O, 'joined') === 1, 'the owner is in the lane alone');
    w.advance(3 * HINT);
    await settle(10);
    assert.equal(told(O, 'alone') + told(M, 'alone'), 0);
    assert.equal('hint' in st(O).rooms[0], false, 'a room carries no hint');
    assert.deepEqual(Object.keys(st(O).rooms[0]).filter((k) => /hint/i.test(k)), []);
  });

  test('privacy: the reports of a stuck pair hold no lane id, no frame and no text, and the lane events are words of the closed list, alone with a count of 0', async () => {
    const w = makeWorld();
    const { N, O } = await stuck(w);
    await N.apps.send(conv(N).id, 'SECRET-WORDS-written while alone');
    w.advance(HINT);
    await settle(10);
    assert.equal(hintOf(N), 'alone');
    const keys = [N, O].flatMap((X) => [X.person.keys.pub, X.person.keys.chat.pub, shortIdOf(X.person.keys.pub)]);
    scan([N, O], forbiddenOf(w, ['SECRET-WORDS', 'Nora', 'Olga'].concat(keys)));
    const words = new Set(['join', 'joined', 'left', 'full', 'busy', 'off', 'invalid', 'unknown', 'rate', 'dead', 'direct-unavailable', 'alone']);
    const lanes = N.reports.filter((r) => r.name === 'apps.lane');
    assert.deepEqual(lanes.map((r) => r.fields.ev), ['join', 'joined', 'alone']);
    for (const r of lanes) {
      assert.deepEqual(Object.keys(r.fields).sort(), ['ev', 'peers']);
      assert.ok(words.has(r.fields.ev), r.fields.ev);
      assert.ok(Number.isInteger(r.fields.peers) && r.fields.peers === 0, JSON.stringify(r.fields));
    }
  });
});

describe('the page comes back', () => {
  test('visible and back open a socket the page lost at once, without waiting for the back off; a link that was never started or was closed stays shut', async () => {
    const w = makeWorld();
    const idle = await mk(w, 'Idle', RELAY);
    idle.hooks.visible();
    idle.hooks.back();
    assert.equal(w.rdv.sockets.size, 0, 'nothing was opened for a person who did nothing');
    const { A, B } = await pairUp(w, RELAY);
    B.link.drop();
    await until(() => B.link.state === 'backoff', 'B lost its socket');
    B.hooks.visible(); // the tab is visible again: no clock moves
    await until(() => B.link.state === 'open', 'and the socket is open again at once');
    await until(() => isConnected(A) && isConnected(B), 'the conversation too');
    B.link.drop();
    await until(() => B.link.state === 'backoff', 'lost again');
    B.hooks.back(); // the network came back
    await until(() => B.link.state === 'open', 'open again at once');
    // a sign-out closes the link for good: the page waking up does not open it
    A.identity.signOut();
    await until(() => A.link.state === 'idle', 'A is closed');
    const sockets = w.rdv.sockets.size;
    A.hooks.visible();
    A.hooks.back();
    await settle(8);
    assert.equal(A.link.state, 'idle');
    assert.equal(w.rdv.sockets.size, sockets);
  });

  test('destroy() takes both listeners off, and a destroyed service does nothing when the page wakes', async () => {
    const w = makeWorld();
    const { A } = await pairUp(w, RELAY);
    assert.equal(A.hooks.visibleFns.size, 1);
    assert.equal(A.hooks.backFns.size, 1);
    A.apps.destroy();
    assert.deepEqual([A.hooks.visibleFns.size, A.hooks.backFns.size, A.hooks.offs], [0, 0, 2]);
    A.hooks.visible();
    A.hooks.back();
    assert.equal(A.link.state, 'idle');
  });

  test('without deps the service listens to the page itself, through globalThis, once for each event, and takes them off in destroy(); a hidden page does nothing', async () => {
    const saved = { document: globalThis.document, add: globalThis.addEventListener, remove: globalThis.removeEventListener };
    const handlers = new Map();
    const log = [];
    const BACK = 'online'; // the DOM event's name, written as it is (DECISIONS DEC-4): it is protocol, not presence wording
    globalThis.document = {
      visibilityState: 'hidden',
      addEventListener (type, fn) { handlers.set('doc:' + type, fn); log.push('doc+' + type); },
      removeEventListener (type, fn) { if (handlers.get('doc:' + type) === fn) handlers.delete('doc:' + type); log.push('doc-' + type); }
    };
    globalThis.addEventListener = (type, fn) => { handlers.set('win:' + type, fn); log.push('win+' + type); };
    globalThis.removeEventListener = (type, fn) => { if (handlers.get('win:' + type) === fn) handlers.delete('win:' + type); log.push('win-' + type); };
    try {
      const w = makeWorld();
      const A = await mk(w, 'Alice', Object.assign({ deps: { onVisible: null, onOnline: null } }, RELAY));
      assert.deepEqual(log, ['doc+visibilitychange', 'win+' + BACK]);
      await A.apps.openCode();
      A.link.drop();
      await until(() => A.link.state === 'backoff', 'the socket is lost');
      handlers.get('doc:visibilitychange')();
      await settle(5);
      assert.equal(A.link.state, 'backoff', 'a page that is still hidden does nothing');
      globalThis.document.visibilityState = 'visible';
      handlers.get('doc:visibilitychange')();
      await until(() => A.link.state === 'open', 'visible: the socket is open again at once');
      A.link.drop();
      await until(() => A.link.state === 'backoff', 'lost again');
      handlers.get('win:' + BACK)();
      await until(() => A.link.state === 'open', 'the network is back: open again at once');
      A.apps.destroy();
      assert.deepEqual(log.slice(2), ['doc-visibilitychange', 'win-' + BACK]);
      assert.equal(handlers.size, 0);
    } finally {
      for (const [key, value] of [['document', saved.document], ['addEventListener', saved.add], ['removeEventListener', saved.remove]]) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    }
  });

  test('in Node, where the page has no such events, a service without deps makes none and does not throw', async () => {
    assert.equal(typeof globalThis.document, 'undefined');
    const person = await makePerson('Alice');
    const apps = createApps({ api: { identity: new FakeIdentity(person) }, config: { rendezvous: [URL_OK] } });
    assert.equal(apps.state().signedIn, true);
    apps.destroy();
  });
});

describe('typing over the relay', () => {
  test('at most one mark every 3 seconds, and none while the outbox is not empty', async () => {
    const w = makeWorld();
    const { A, B, a } = await pairUp(w, RELAY);
    await quiet(w, A);
    await quiet(w, B);
    const n0 = sentBy(w, A, 'pair-relay');
    await A.apps.typing(a, true);
    await A.apps.typing(a, true);
    await A.apps.typing(a, true);
    await until(() => sentBy(w, A, 'pair-relay') === n0 + 1, 'one mark');
    await settle(5);
    assert.equal(sentBy(w, A, 'pair-relay'), n0 + 1, 'the second and third came within 3 seconds');
    w.advance(3001);
    await A.apps.typing(a, true);
    await until(() => sentBy(w, A, 'pair-relay') === n0 + 2, 'another after 3 seconds');
    await A.apps.typing(a, false);
    await until(() => sentBy(w, A, 'pair-relay') === n0 + 3, 'and the end of it');
    // a message that waits for its ack is in the outbox: while it is, no mark goes (B never hears of the message here)
    const orig = w.rdv._send.bind(w.rdv);
    const heldConn = connOf(B);
    w.rdv._send = (conn, obj) => (conn.id === heldConn && obj && obj.action === 'pair-relayed' ? undefined : orig(conn, obj));
    w.advance(3001);
    await A.apps.send(a, 'a message nobody acks');
    await until(() => conv(A).pending === 1 && conv(A).messages[0].status === 'sent', 'it waits for its ack');
    const n1 = await quiet(w, A);
    await A.apps.typing(a, true);
    await A.apps.typing(a, false);
    await settle(8);
    assert.equal(await quiet(w, A), n1, 'no mark while the outbox is not empty');
    // and over a direct wire the marks are as they always were (the outbox does not hold them back)
    const w2 = makeWorld();
    const P = await pairUp(w2, LEGACY);
    await settle(10);
    const f0 = w2.net.frames.length;
    w2.net.drops = () => true; // every frame is lost on the wire, so the message is never acked
    await P.A.apps.send(P.a, 'unacked');
    await until(() => conv(P.A).pending === 1 && w2.net.frames.length > f0, 'the message was written, and lost');
    await settle(5);
    w2.net.drops = null;
    const seen = w2.net.frames.length;
    await P.A.apps.typing(P.a, true);
    await until(() => w2.net.frames.length === seen + 1, 'a mark on the wire');
  });
});

describe('what a hostile or broken rendezvous can do', () => {
  test('a relayed frame for a lane the page never joined is dropped; a joined push with a count no lane can have changes nothing', async () => {
    const w = makeWorld();
    const { A, B } = await pairUp(w, RELAY);
    await settle(10);
    const lane = laneOf(A);
    const stray = 'cd'.repeat(20);
    const before = A.reports.length;
    const sealed = await sealDmBody({ keys: B.person.keys, peerEk: A.person.keys.chat.pub, body: { k: 'msg', id: 'STRAYSTRAYSTRAY1', t: w.clock.now(), text: 'for nobody', fmt: 'md1' }, now: w.clock.now(), n: 901 });
    const bytes = encodeFrame(T.DM, sealed.payload);
    const conn = A.link._ws.conn;
    w.rdv._send(conn, { action: 'pair-relayed', lane: stray, f: b64url.encode(bytes) });
    w.rdv._send(conn, { action: 'pair-joined', lane: stray, peers: 1 });
    w.rdv._send(conn, { action: 'pair-left', lane: stray, peers: 0 });
    w.rdv._send(conn, { action: 'pair-joined', lane, peers: 999 }); // no lane holds that many
    w.rdv._send(conn, { action: 'pair-left', lane, peers: 7 }); // nor can a pair
    w.rdv._send(conn, { action: 'room-relayed', lane, f: b64url.encode(bytes) }); // a room frame for a lane that is a pair
    w.rdv._send(conn, { action: 'room-left', lane, peers: 0 });
    await settle(10);
    assert.deepEqual(conv(A).messages, [], 'nothing was shown');
    assert.equal(conv(A).status, 'connected');
    assert.equal(conv(A).via, 'relay', 'readiness is as it was');
    assert.deepEqual(A.reports.slice(before).filter((r) => r.name.startsWith('apps.')), [], 'and the service told nothing of it');
  });

  test('the rendezvous sends a sender its own frame back: it is dropped, and it settles no receipt and shows no message twice', async () => {
    const w = makeWorld();
    const { A, B, a, b } = await pairUp(w, RELAY);
    const lane = laneOf(A);
    await A.apps.send(a, 'my own words');
    await until(() => conv(B).messages.length === 1 && conv(A).messages[0].status === 'delivered', 'delivered');
    w.advance(5);
    await B.apps.send(b, 'their words');
    await until(() => conv(A).messages.length === 2 && conv(B).messages.find((m) => m.mine).status === 'delivered', 'their message at A, acked');
    // A tells B it has read everything: that frame, echoed to A, would mark A's own message read if A took it for B's
    A.reports.length = 0;
    await A.apps.markRead(a);
    await until(() => conv(B).messages.find((m) => m.mine).status === 'read', 'the read receipt reached B');
    await quiet(w, A);
    await quiet(w, B);
    assert.equal(conv(A).messages.find((m) => m.mine).status, 'delivered');
    // every frame that ever crossed comes back to A, the ones it sent and the ones it was sent, three times
    for (let i = 0; i < 3; i++) for (const m of framesOf(w, 'pair-relay')) w.rdv._send(A.link._ws.conn, { action: 'pair-relayed', lane, f: m.f });
    await settle(40);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(conv(A).messages.find((m) => m.mine).status, 'delivered', 'an echo is not the other side reading');
    assert.equal(conv(A).messages.length, 2);
    assert.equal(A.reports.filter((r) => r.name === 'apps.msg' && r.fields.status === 'read').length, 0);
    assert.equal(A.reports.filter((r) => r.fields.ev === 'strike').length, 0, 'an echo is no garbage either');
    assert.equal(conv(A).via, 'relay');
  });
});

// The feature bodies the older tests prove over a wire, run again over both transports (amendment A4): the direct one and the relay one.
// A door with relay 'none' is the direct transport; a door with relay 'rendezvous' and direct 'off' is the relay one.
for (const [label, door] of [['direct', LEGACY], ['relay', RELAY]]) {
  describe('the same features over the ' + label + ' transport', () => {
    /** The other side goes away, and comes back: a lost wire for the direct transport, a lost socket for the relay. */
    const away = async (w, X, Y) => {
      if (label === 'direct') {
        w.net.pause();
        w.net.dropAll();
      } else {
        Y.link.drop();
      }
      await until(() => conv(X).status === 'connecting', 'the path is gone');
    };
    const back = async (w) => {
      if (label === 'direct') w.net.resume();
      else w.advance(1000);
    };
    /** which transport carried the frames: the wires of the fake network or the relay lane of the rendezvous, and never both */
    const carried = (w) => {
      if (label === 'direct') {
        assert.ok(w.net.frames.length > 0, 'frames went over a wire');
        assert.equal(w.rdv.relayStats().relayed, 0, 'and none through the relay');
      } else {
        assert.equal(w.net.frames.length, 0, 'no frame went over a wire');
        assert.ok(w.rdv.relayStats().relayed > 0, 'they went through the relay');
      }
    };

    test('send, Delivered, Read, and the answer', async () => {
      const w = makeWorld();
      const { A, B, a, b } = await pairUp(w, door);
      const sent = await A.apps.send(a, 'first words');
      await until(() => conv(B).messages.length === 1 && conv(A).messages[0].status === 'delivered', 'delivered');
      assert.equal(conv(A).messages[0].id, sent.id);
      await B.apps.markRead(b);
      await until(() => conv(A).messages[0].status === 'read', 'read');
      await B.apps.send(b, 'the answer');
      await until(() => conv(A).messages.length === 2 && conv(B).messages.find((m) => m.mine).status === 'delivered', 'the answer, delivered');
      assert.deepEqual([conv(A).via, conv(B).via], label === 'direct' ? ['direct', 'direct'] : ['relay', 'relay']);
      carried(w);
    });

    test('edit, delete for both, and a reaction reach the other side', async () => {
      const w = makeWorld();
      const { A, B, a, b } = await pairUp(w, door);
      const m = await A.apps.send(a, 'before the edit');
      await until(() => conv(B).messages.length === 1, 'the message');
      w.advance(1000);
      await A.apps.edit(a, m.id, 'after the edit');
      await until(() => conv(B).messages[0].text === 'after the edit' && conv(B).messages[0].edits.length === 1, 'the edit');
      await B.apps.react(b, m.id, '\u{1F44D}');
      await until(() => Object.keys(conv(A).messages[0].reactions).length === 1, 'the reaction');
      await A.apps.remove(a, m.id, { both: true });
      await until(() => conv(B).messages[0].deleted === true, 'the deletion');
      assert.equal(conv(B).messages[0].text, '');
      carried(w);
    });

    test('messages written while the other side is away wait, then go in order when it is back, and show once', async () => {
      const w = makeWorld();
      const { A, B, a } = await pairUp(w, door);
      await away(w, A, B);
      for (const t of ['one', 'two', 'three']) await A.apps.send(a, t);
      assert.deepEqual(conv(A).messages.map((x) => x.status), ['queued', 'queued', 'queued']);
      await back(w);
      await until(() => conv(B).messages.length === 3 && conv(A).messages.every((x) => x.status === 'delivered'), 'all three delivered');
      await settle(10);
      assert.deepEqual(conv(B).messages.map((x) => x.text), ['one', 'two', 'three']);
      assert.equal(conv(B).messages.length, 3);
      carried(w);
    });

    test('a room of three: the roster reaches all, and every message reaches everyone', async () => {
      const w = makeWorld();
      const { O, Ms, id, ids, roomOf } = await roomUp(w, door);
      const [M1, M2] = Ms;
      await until(() => [[O, id], [M1, ids[0]], [M2, ids[1]]].every(([X, i]) => roomOf(X, i).members.length === 3), 'the roster at all three');
      await M1.apps.sendRoom(ids[0], 'from the first member');
      await O.apps.sendRoom(id, 'from the owner');
      await until(() => [[O, id], [M1, ids[0]], [M2, ids[1]]].every(([X, i]) => roomOf(X, i).messages.length === 2), 'two messages at all three');
      for (const [X, i] of [[O, id], [M1, ids[0]], [M2, ids[1]]]) assert.deepEqual(roomOf(X, i).messages.map((m) => m.text).sort(), ['from the first member', 'from the owner'], X.name);
      carried(w);
    });
  });
}


// The scenarios below ask the rendezvous only what both of its kinds can answer (relayStats), so they run against the in-memory stub of the plan's
// section 3.1 and against the real pairing core (deploy/rtc-worker/pair.js) alike. The second kind runs when pair.js already speaks the relay actions
// (CORE_RELAY, at the top of this file). Running them on both keeps the stub honest for the tests above that still need it.
for (const kind of ['stub', 'core']) {
  describe('the relay on the ' + (kind === 'core' ? 'real pairing core' : 'stub of the rendezvous'), { skip: kind === 'core' && !CORE_RELAY ? 'deploy/rtc-worker/pair.js does not speak the relay actions' : false }, () => {
    const world = (opts) => makeWorld(Object.assign({ core: kind === 'core' }, opts));

    test('the shipped default: a pairing, messages both ways with Delivered and Read, no manager, no wire, one lane at the rendezvous', async () => {
      const w = world();
      const { A, B, a, b } = await pairUp(w, { config: { relay: undefined } });
      await A.apps.send(a, 'over the rendezvous');
      await until(() => conv(B).messages.length === 1 && conv(A).messages[0].status === 'delivered', 'delivered');
      await B.apps.markRead(b);
      await until(() => conv(A).messages[0].status === 'read', 'read');
      await B.apps.send(b, 'and back');
      await until(() => conv(A).messages.length === 2 && conv(B).messages.find((m) => m.mine).status === 'delivered', 'the answer');
      const stats = w.rdv.relayStats();
      assert.equal(stats.relays, 1);
      assert.ok(stats.relayed >= 6, JSON.stringify(stats));
      assert.deepEqual([A.loadCalls.length, B.loadCalls.length, w.net.frames.length], [0, 0, 0]);
      assert.deepEqual([conv(A).via, conv(B).via], ['relay', 'relay']);
    });

    test('the other side drops and returns: the lane is told as left and joined, the message written meanwhile is shown once and acked', async () => {
      const w = world();
      const { A, B, a } = await pairUp(w, RELAY);
      B.link.drop();
      await until(() => conv(A).status === 'connecting' && conv(A).via === null, 'A sees the other side go');
      const sent = await A.apps.send(a, 'written while you were away');
      await settle(8);
      assert.equal(conv(A).messages[0].status, 'queued');
      w.advance(1000);
      await until(() => conv(B).messages.length === 1 && conv(A).messages[0].status === 'delivered', 'shown and acked');
      await settle(10);
      assert.equal(conv(B).messages.length, 1);
      assert.equal(conv(B).messages[0].id, sent.id);
      await until(() => isConnected(A) && isConnected(B), 'connected again');
    });

    test('a room of three: the roster reaches all, messages reach everyone, nothing goes over a wire', async () => {
      const w = world();
      const { O, Ms, id, ids, roomOf } = await roomUp(w, RELAY);
      const [M1, M2] = Ms;
      await until(() => [[O, id], [M1, ids[0]], [M2, ids[1]]].every(([X, i]) => roomOf(X, i).members.length === 3), 'the roster at all three');
      await M1.apps.sendRoom(ids[0], 'from the first member');
      await O.apps.sendRoom(id, 'from the owner');
      await M2.apps.sendRoom(ids[1], 'from the second member');
      await until(() => [[O, id], [M1, ids[0]], [M2, ids[1]]].every(([X, i]) => roomOf(X, i).messages.length === 3), 'three messages at all three');
      assert.equal(w.net.frames.length, 0);
      assert.equal(w.rdv.relayStats().relays, 1);
    });

    test('leaving a conversation and a room, and a sign-out, end the lane: the rendezvous holds none afterwards', async () => {
      const w = world();
      const { A, B, a } = await pairUp(w, RELAY);
      assert.equal(w.rdv.relayStats().relays, 1);
      await A.apps.leave(a);
      await until(() => conv(B).status === 'left' && w.rdv.relayStats().relays === 0, 'both left the lane');
      const w2 = world();
      const P = await pairUp(w2, RELAY);
      P.A.identity.signOut();
      await until(() => w2.rdv.relayStats().relays === 1 && conv(P.B).status === 'connecting', 'the one who stayed is alone in the lane');
      const w3 = world();
      const R = await roomUp(w3, RELAY);
      await R.Ms[0].apps.leaveRoom(R.ids[0]);
      await R.Ms[1].apps.leaveRoom(R.ids[1]);
      await R.O.apps.leaveRoom(R.id);
      await until(() => w3.rdv.relayStats().relays === 0, 'the room lane is gone');
    });

    test('three frames that are garbage close the relay path of the lane; the next open of the socket starts it clean', async () => {
      const w = world();
      w.net.canConnect = () => false;
      const { A, B, a } = await pairUp(w, BOTH);
      const lane = laneOf(A);
      A.reports.length = 0;
      for (let i = 0; i < 3; i++) assert.deepEqual(await B.link.relay(lane, 'pair', new Uint8Array(40).fill(7)), { ok: true, peers: 1 });
      await until(() => conv(A).status === 'connecting', 'the path is closed');
      assert.deepEqual(A.reports.filter((r) => r.name === 'apps.wire').map((r) => r.fields.ev + ':' + r.fields.via), ['strike:relay', 'strike:relay', 'strike:relay', 'kill:relay', 'down:relay']);
      assert.deepEqual(A.tm.ignored, []);
      A.link.drop();
      await until(() => A.link.state === 'backoff', 'the socket is lost');
      w.advance(1000);
      await until(() => conv(A).via === 'relay', 'the path is back');
      await B.apps.send(conv(B).id, 'after the clean start');
      await until(() => conv(A).messages.length === 1, 'and a message shows');
      assert.ok(a);
    });

    test('a rendezvous with the relay switched off: both sides are told off, once, nobody sees an error, and a direct link would still have worked', async () => {
      const w = world({ relayLane: false });
      const A = await mk(w, 'Alice', RELAY);
      const B = await mk(w, 'Bob', RELAY);
      const { code } = await A.apps.openCode();
      await B.apps.knock(code);
      await until(() => st(A).requests.length === 1, 'the request');
      await A.apps.accept(st(A).requests[0].knock);
      await until(() => A.reports.some((r) => r.fields.ev === 'off') && B.reports.some((r) => r.fields.ev === 'off'), 'told as off on both sides');
      for (const X of [A, B]) assert.equal(X.reports.filter((r) => r.name === 'apps.lane' && r.fields.ev === 'off').length, 1, X.name);
      assert.equal(conv(A).status, 'connecting');
      assert.equal(conv(A).reason, 'no-path'); // DECISIONS DEC-5: the only path was refused for good, and the conversation says so (was null)
      // the same rendezvous with direct on: the pair connects by the wire, the relay is told off and costs nothing
      const w2 = world({ relayLane: false });
      const P = await pairUp(w2, BOTH);
      assert.deepEqual([conv(P.A).via, conv(P.B).via], ['direct', 'direct']);
      assert.ok(P.A.reports.some((r) => r.name === 'apps.lane' && r.fields.ev === 'off'));
    });

    test('over ten minutes of the fake clock the keepalive keeps both sockets open on the rendezvous, and no report holds a lane, a frame or a word that was said', async () => {
      const w = world();
      const { A, B, a } = await pairUp(w, Object.assign({ linkOptions: { keepaliveMs: KEEPALIVE_MS } }, RELAY), { names: ['Zelda Quill', 'Orson Finch'] });
      for (let i = 0; i < 12; i++) {
        w.advance(50000);
        await settle(4);
      }
      assert.deepEqual([A.link.state, B.link.state], ['open', 'open']);
      assert.ok(w.rdv.raw.filter((text) => text === PING).length >= 20, 'a ping each period from each of the two');
      await A.apps.send(a, 'SECRET-WORDS-after ten minutes');
      await until(() => conv(B).messages.length === 1 && conv(A).messages[0].status === 'delivered', 'still delivered');
      scan([A, B], forbiddenOf(w, ['SECRET-WORDS', 'Zelda', 'Quill', 'Orson', 'Finch', A.person.keys.pub, B.person.keys.pub]));
    });
  });
}

// The client against the real rendezvous: real WebSockets on loopback to tools/tracker.mjs, which runs the pairing core of the Worker, so the
// page's WebSocket API, the exact ping, the replies by rid and the pushes are met by the code that will answer them. Nothing leaves the machine.
describe('against the Node tracker over real sockets on loopback', () => {
  const closers = [];
  afterEach(async () => {
    for (const fn of closers.splice(0).reverse()) {
      try { await fn(); } catch (_) { /* gone */ }
    }
  });

  async function startTracker (opts = {}) {
    const t = await createTracker(Object.assign({ port: 0, open: true, quiet: true }, opts));
    closers.push(() => t.close());
    assert.equal(t.pairing, true);
    return t;
  }

  async function peopleOn (t, names, door = {}) {
    const out = [];
    for (const name of names) {
      const person = await makePerson(name);
      const reports = [];
      const into = (prefix) => (n, f) => { reports.push({ name: prefix + n, fields: clone(f) }); };
      const apps = createApps({
        api: { identity: new FakeIdentity(person) }, config: Object.assign({ rendezvous: [t.url], stun: [], idp: null }, door),
        report: into('apps.'), linkOptions: { report: into('link.') }
      });
      made.push({ apps });
      out.push({ name, person, apps, reports });
    }
    return out;
  }

  test('the shipped default over the tracker: a pairing, a message each way with Delivered and Read, and the lane is gone when they leave', async () => {
    const t = await startTracker();
    const [A, B] = await peopleOn(t, ['Alice', 'Bob']);
    const { code } = await A.apps.openCode();
    assert.ok((await B.apps.knock(code)).knock);
    await until(() => st(A).requests.length === 1, 'the request');
    assert.ok((await A.apps.accept(st(A).requests[0].knock)).id);
    await until(() => isConnected(A) && isConnected(B), 'both connected through the tracker');
    assert.deepEqual([conv(A).via, conv(B).via], ['relay', 'relay']);
    assert.equal(t.stats().relays, 1);
    await A.apps.send(conv(A).id, 'hello over the tracker');
    await until(() => conv(B).messages.length === 1 && conv(A).messages[0].status === 'delivered', 'delivered');
    await B.apps.markRead(conv(B).id);
    await until(() => conv(A).messages[0].status === 'read', 'read');
    await B.apps.send(conv(B).id, 'and back');
    await until(() => conv(A).messages.length === 2, 'the answer');
    assert.ok(t.stats().relayed >= 6, JSON.stringify(t.stats()));
    assert.equal(t.stats().relayBusy + t.stats().relayRate, 0);
    await A.apps.leave(conv(A).id);
    await until(() => conv(B).status === 'left' && t.stats().relays === 0, 'the lane is gone');
    // the usage reports of both pages hold words and counts about the lane
    for (const X of [A, B]) {
      assert.ok(X.reports.some((r) => r.name === 'apps.lane' && r.fields.ev === 'joined'));
      assert.ok(X.reports.some((r) => r.name === 'link.reply' && r.fields.action === 'pair-relay' && r.fields.ok === true));
    }
  });

  test('a tracker with the relay lane off: both pages are told off once, the pairing itself worked, and no error card is raised', async () => {
    const t = await startTracker({ relayLane: false });
    assert.equal(t.relayLane, false);
    const [A, B] = await peopleOn(t, ['Alice', 'Bob']);
    const { code } = await A.apps.openCode();
    await B.apps.knock(code);
    await until(() => st(A).requests.length === 1, 'the request');
    assert.ok((await A.apps.accept(st(A).requests[0].knock)).id);
    await until(() => A.reports.some((r) => r.fields.ev === 'off') && B.reports.some((r) => r.fields.ev === 'off'), 'told off');
    for (const X of [A, B]) assert.equal(X.reports.filter((r) => r.name === 'apps.lane' && r.fields.ev === 'off').length, 1, X.name);
    // DECISIONS DEC-5: with the relay off and direct off the conversation says no-path instead of connecting for ever (the reasons were null)
    assert.deepEqual([conv(A).status, conv(A).reason, conv(B).reason], ['connecting', 'no-path', 'no-path']);
    assert.equal(t.stats().relays, 0);
  });

  test('the keepalive against the tracker: the exact ping is answered with the exact pong, and a link that pings stays open', async () => {
    const t = await startTracker();
    const raw = new WebSocket(t.url);
    const got = [];
    raw.on('message', (data) => got.push(data.toString('utf8')));
    await new Promise((resolve, reject) => { raw.once('open', resolve); raw.once('error', reject); });
    raw.send(PING);
    await until(() => got.length === 1, 'the pong');
    assert.equal(got[0], '{"action":"pair-pong"}');
    raw.close();
    const link = createLink({ url: t.url, keepaliveMs: 100, pongWaitMs: 300 });
    closers.push(() => link.close());
    assert.equal(await link.whenOpen(), true);
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(link.state, 'open', 'nine periods of pings, every one answered');
    assert.equal(link._heard >= 8, true, 'and the pongs were heard: ' + link._heard);
  });
});

describe('the files of the relay lane', () => {
  const read = (rel) => readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');
  test('this file: ASCII, no dash, no curly quote, straight quotes, none of the banned words, no real name or host', () => {
    const me = read('test/unit/loader-apps-lane.test.mjs');
    assert.equal(/[^\x00-\x7f]/.test(me), false, 'ASCII');
    assert.doesNotMatch(me, /[\u2013\u2014\u2018\u2019\u201c\u201d]/);
    const banned = ['block' + 'chain', 'server' + 'less', 'un' + 'stoppable', 'censorship' + '-resistant', 'production' + '-ready', 'fully ' + 'decentralized', 'sub' + '-second', 'anony' + 'mous'];
    for (const word of banned) assert.ok(!me.toLowerCase().includes(word), word);
    assert.doesNotMatch(me, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    for (const host of ['workers.' + 'dev', 'pages.' + 'dev', 'github.' + 'com', 'cloud' + 'flare']) assert.ok(!me.toLowerCase().includes(host), host);
  });
});
