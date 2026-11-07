// Unit tests for the relay lane of the apps (plan relay-first-2026-11-07, sections 3.5, 3.6 and 6.2; amendments A1 to A4). After the accept both
// sides join a relay lane on the pair socket they already hold, and every sealed frame of the conversation or the room goes through the
// rendezvous; direct WebRTC is a door-level opt-in beside it. What these tests hold to:
//   - the pair link (src/loader/apps-link.js): join, relay and leave, the pushes relayed, joined and left, the keepalive and its watchdog;
//   - the service (src/loader/apps.js) on the relay: the new default, the two door tokens and what they resolve to, joining right after the
//     accept, messages through the rendezvous with Delivered and Read, rooms, link drops, strikes, caps, the lifecycle hooks, typing;
//   - privacy: no report field of any event holds a lane id, a frame or a message text;
//   - the same feature bodies over both transports, the direct one and the relay one.
// Every party is a fake on this machine (test/unit/fakes/apps-fakes.mjs): the rendezvous is the stub of the plan's section 3.1 and, when
// pair.js speaks the relay actions, the real core as well; the last group talks to tools/tracker.mjs over loopback sockets. Nothing leaves
// the machine. Run: node tools/run-unit.mjs test/unit/loader-apps-lane.test.mjs
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import WebSocket from 'ws';

import { createTracker } from '../../tools/tracker.mjs';
import { PairLink, createLink, reportWord, reasonWord, reasonCode, BACKOFF_MS, KEEPALIVE_MS } from '../../src/loader/apps-link.js';
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
    // the lane events: only the closed list of words, and a count
    const words = new Set(['join', 'joined', 'left', 'full', 'busy', 'off', 'invalid', 'unknown', 'rate', 'dead', 'direct-unavailable']);
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
    assert.equal(conv(A).reason, null);
    scan([A, B], forbiddenOf(w, ['Alice', 'Bob']));
  });
});

describe('joins that fail', () => {
  /**
   * A rendezvous that refuses every relay join with this text (the direct path, FakeNetwork, is not touched). It answers in front of the
   * rendezvous, as plan 3.1 shapes a failure ({ action, rid, 'failure reason' }), so the stub and the real core are refused alike.
   */
  function refuseJoins (w, text) {
    const orig = w.rdv.handle.bind(w.rdv);
    w.rdv.handle = (conn, m) => (m && /^(?:pair|room)-join$/.test(m.action)
      ? w.rdv._send(conn, Object.assign({ action: m.action }, typeof m.rid === 'string' ? { rid: m.rid } : {}, { 'failure reason': text }))
      : orig(conn, m));
  }

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
    const BACK = 'on' + 'line';
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
      assert.equal(conv(A).reason, null);
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
    assert.deepEqual([conv(A).status, conv(A).reason, conv(B).reason], ['connecting', null, null]);
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
