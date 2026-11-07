// Adversary tests for the relay lane (plan relay-first-2026-11-07, section 6.5; the hostile client and the hostile rendezvous of verifier A's list).
// They run the REAL pairing core (deploy/rtc-worker/pair.js, also through rtc.js, the Node tracker on loopback and the Durable Object class of
// worker.js on a fake platform) and the REAL client (src/loader/apps-link.js, src/loader/apps.js, src/loader/apps-ui.js) on the fakes of
// test/unit/fakes/apps-fakes.mjs. Every party is a fake on this machine; the only sockets are loopback ones to a tracker that this file starts.
// Run: node tools/run-unit.mjs test/unit/lane-adversary.test.mjs
//
//   LADV-1  a third socket that knows the lane id: a pair lane holds two sockets ("lane full"); it can neither relay into nor leave a lane it is
//           not in; guessing lane ids is refused and ends at the 151st message; if it joined first, the pair's strikes drop the relay and the
//           pair goes on direct when direct is on
//   LADV-2  an f that is too long: 7,700 characters pass, 7,701 do not, nothing is scanned past the length, and a text past 8,192 bytes is refused
//   LADV-3  an f of other alphabets or other types, and a lane of other shapes: refused, never forwarded, never counted as a relayed frame
//   LADV-4  10,000 relays in a burst: 120 go through, the 121st to the 149th are refused, the socket is closed at its 151st message, and a host that
//           keeps feeding the core still forwards nothing; the same on a real socket of the Node tracker
//   LADV-5  a relayed frame for a lane the page never joined is dropped (a frame of another conversation's lane, a frame replayed under another lane)
//   LADV-6  a joined push with peers 999 is not taken, and a rendezvous that lies about who is in the lane loses and doubles no message
//   LADV-7  the rendezvous echoing a frame back to its sender: no message twice, no receipt of ours settled by our own read receipt
//   LADV-8  a pong with a payload feeds the watchdog and goes nowhere else
//   LADV-9  a ping flood: the platform answers the exact text without waking the object; the core answers any other ping with the bare pong and
//           counts it toward messagesPerMin and no relay cap, so a flood is closed at the 151st message of the minute (DECISIONS DEC-2)
//   LADV-10 the frame text, the lane id and the message text, searched in every report, log line, inspect-like state and the page
//   LADV-L  the e2e launch policy: an extra switch cannot take the local-only policy of a test browser away
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

import { createTracker } from '../../tools/tracker.mjs';
import { createPairing, MAX_PAIR_BYTES, DEFAULT_CAPS } from '../../deploy/rtc-worker/pair.js';
import { createRendezvous } from '../../deploy/rtc-worker/rtc.js';
import { Rendezvous } from '../../deploy/rtc-worker/worker.js';
import { createAppsUi } from '../../src/loader/apps-ui.js';
import { FakeDocument } from './dropin-fake-dom.mjs';
import { FakeLink, makeWorld, until, settle } from './fakes/apps-fakes.mjs';
import { launchArgs } from '../e2e/lib.mjs';

const MIN = 60000;
const DAY = 24 * 60 * MIN;
const T0 = Date.UTC(2026, 10, 7, 15, 0, 0);
const LANE = '0123456789abcdef0123456789abcdef01234567';
const LANE_2 = 'fedcba9876543210fedcba9876543210fedcba98';
const BOX = { iv: 'A'.repeat(16), ct: 'B'.repeat(160) };
const PROOF = 'P'.repeat(86);
// The two texts of plan 3.4, byte for byte: what a client sends every 50 seconds and what the platform answers without waking the object.
const PING = '{"v":1,"action":"pair-ping"}';
const PONG = '{"action":"pair-pong"}';
// A marker in every message text: long enough that it never turns up in base64 by chance.
const MARK = 'ladv-q7kz';
const CAPS = { relayPerMin: 120, messagesPerMin: 150, relayDayMax: 20000, lanesPerSocket: 8, pairLaneMembers: 2, roomLaneMembers: 16 };

/** The nth distinct sealed-frame stand-in: base64url of 4 or more characters; the core never opens it. */
const frame = (n, len = 24) => ('F' + n.toString(36) + 'Zz9_-').padEnd(len, 'x').slice(0, len);
const hexOf = (n) => n.toString(16).padStart(40, '0');

// ---------------------------------------------------------------------------------------------
// the real pairing core on a manual clock, with plain connections
// ---------------------------------------------------------------------------------------------

/** rig({ caps, relay }) -> the pair core as the Worker and the tracker run it, a clock of its own and conns that collect what they are told. */
function rig({ caps = {}, relay = true } = {}) {
  const clock = { t: T0 };
  const lanes = new Map();
  const core = createPairing({
    now: () => clock.t,
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    allowLane: (hex, exp) => { lanes.set(hex, exp); return true; },
    laneExpiry: (hex) => lanes.get(hex) || 0,
    caps,
    relay,
  });
  const r = {
    clock, lanes, core,
    /** mint(hex): the host allows this lane (an accept does it in life). */
    mint(hex = LANE) { lanes.set(hex, clock.t + DAY); return hex; },
    conn(name) { return { name, out: [] }; },
    /** send(conn, msg): one message to the core; its replies land in the `out` of the conns they are for. -> the core's answer. */
    send(conn, msg) {
      const out = core.message(conn, Object.assign({ v: 1 }, msg));
      for (const [to, obj] of out.replies) to.out.push(obj);
      return out;
    },
    /** drop(conn): the socket is gone. */
    drop(conn) { for (const [to, obj] of core.close(conn)) to.out.push(obj); },
    take(conn) { return conn.out.splice(0); },
  };
  return r;
}

/** Two joined sockets on one lane, nothing pending. */
function pairOnLane(r, lane = LANE) {
  r.mint(lane);
  const a = r.conn('a');
  const b = r.conn('b');
  r.send(a, { action: 'pair-join', lane, rid: 'ja' });
  r.send(b, { action: 'pair-join', lane, rid: 'jb' });
  r.take(a);
  r.take(b);
  return { a, b };
}

const joinFailure = (reason, rid) => ({ action: 'pair-join', 'failure reason': reason, rid });
const relayFailure = (reason, rid) => ({ action: 'pair-relay', 'failure reason': reason, rid });

// ---------------------------------------------------------------------------------------------
// the same core behind rtc.js, with the pairing protocol run to the point of a lane
// ---------------------------------------------------------------------------------------------

/** A conn for the rendezvous core of rtc.js: it is sent text, which it keeps parsed. */
function textConn(name) {
  const out = [];
  return { name, out, send: (t) => out.push(JSON.parse(t)), take: () => out.splice(0) };
}

/** meetOn(core): an owner opens a code, a requester knocks, the owner accepts; -> { owner, requester, lane } with the lane both were handed. */
function meetOn(core) {
  const owner = textConn('owner');
  const requester = textConn('requester');
  const say = (c, msg) => core.message(c, JSON.stringify(Object.assign({ v: 1 }, msg)));
  say(owner, { action: 'pair-open', channel: 'abcd', box: BOX, rid: 'o' });
  say(requester, { action: 'pair-knock', channel: 'abcd', box: BOX, rid: 'k' });
  const knock = requester.take().find((m) => m.knock).knock;
  owner.take();
  say(owner, { action: 'pair-accept', knock, proof: PROOF, rid: 'a' });
  const lane = owner.take().find((m) => m.lane).lane;
  requester.take();
  return { owner, requester, lane, say };
}

// ---------------------------------------------------------------------------------------------
// the real client on the real core, with every report, log line and state recorded
// ---------------------------------------------------------------------------------------------

const made = [];
afterEach(() => {
  for (const p of made.splice(0)) {
    try { p.apps.destroy(); } catch (_) { /* gone */ }
    try { p.link.close(); } catch (_) { /* gone */ }
  }
});

const st = (X) => X.apps.state();
const conv = (X, i = 0) => st(X).conversations[i];
const isConnected = (X) => { const c = conv(X); return !!c && c.status === 'connected'; };
const slow = (fn, what) => until(fn, what, 30000); // real PBKDF2 and ECDH: a busy machine (the whole suite in parallel) slows them

/** A person on the world: relay rendezvous, the direct setting asked for, every report ('apps.' and 'link.' names) and log line recorded. */
async function person(w, name, { direct = 'off', limits } = {}) {
  const logs = [];
  const log = (...parts) => { logs.push(parts.map((x) => (x && x.message) || String(x)).join(' ')); };
  const X = await w.make(name, { relay: 'rendezvous', direct, reports: true, limits, deps: { log } });
  X.logs = logs;
  made.push(X);
  return X;
}

/** A owns a code, B knocks, A accepts; resolves when both show connected through the relay (or as `direct` asks). -> the two and the lane. */
async function pairViaRelay(w, { direct = 'off', limits } = {}) {
  const A = await person(w, 'Alice', { direct, limits });
  const B = await person(w, 'Bob', { direct, limits });
  const { code } = await A.apps.openCode();
  const k = await B.apps.knock(code);
  assert.ok(k.knock, JSON.stringify(k));
  await slow(() => st(A).requests.length === 1, 'the request at Alice');
  const acc = await A.apps.accept(st(A).requests[0].knock);
  assert.ok(acc.id, JSON.stringify(acc));
  await slow(() => isConnected(A) && isConnected(B), 'both connected');
  await slow(() => conv(A).via === 'relay' && conv(B).via === 'relay', 'both on the relay');
  const lane = Array.from(w.rdv.lanes.keys())[0];
  assert.match(lane, /^[0-9a-f]{40}$/);
  return { A, B, lane, code, a: conv(A).id, b: conv(B).id };
}

/** The rendezvous' own end of a person's socket: what a hostile rendezvous pushes to that page. */
const connOf = (X) => X.link._ws.conn;
const push = (w, X, obj) => w.rdv._send(connOf(X), obj);

/** The `f` of every pair-relay request a person's socket sent, in order. */
const relayedBy = (X) => X.link._ws.sent.map((t) => JSON.parse(t)).filter((m) => m.action === 'pair-relay').map((m) => m.f);

/** What a conversation shows about the other person, as one string: the messages with their state, the counters. */
const view = (X) => JSON.stringify([
  conv(X).messages.map((m) => [m.id, m.mine, m.text, m.status, m.deleted, m.edits.length, m.reactions]),
  conv(X).unread, conv(X).typingPeer, conv(X).status, conv(X).via,
]);

// ---------------------------------------------------------------------------------------------
// LADV-1  a third socket that knows the lane id
// ---------------------------------------------------------------------------------------------

describe('LADV-1 a third socket that knows the lane id', () => {
  test('LADV-1 pair lane full at 2: C is refused, gets no frame, can relay nothing in and leave nothing out, and A and B notice nothing', () => {
    const r = rig();
    const { a, b } = pairOnLane(r);
    const c = r.conn('c');
    r.send(c, { action: 'pair-join', lane: LANE, rid: 'j3' });
    assert.deepEqual(r.take(c), [joinFailure('lane full', 'j3')], 'the refusal names no lane');
    r.send(c, { action: 'pair-relay', lane: LANE, f: frame(1), rid: 'r3' });
    assert.deepEqual(r.take(c), [relayFailure('unknown lane', 'r3')], 'a socket that is not a member cannot relay into the lane');
    r.send(c, { action: 'pair-leave', lane: LANE, rid: 'l3' });
    r.take(c);
    assert.deepEqual([r.take(a), r.take(b)], [[], []], 'A and B were told nothing: no left, no joined, no frame');
    // the pair works, C hears none of it
    r.send(a, { action: 'pair-relay', lane: LANE, f: frame(2), rid: 'r1' });
    assert.deepEqual(r.take(b), [{ action: 'pair-relayed', lane: LANE, f: frame(2) }]);
    assert.deepEqual(r.take(a), [{ action: 'pair-relay', lane: LANE, peers: 1, rid: 'r1' }]);
    assert.deepEqual(r.take(c), []);
    r.send(b, { action: 'pair-relay', lane: LANE, f: frame(3) });
    assert.deepEqual(r.take(a), [{ action: 'pair-relayed', lane: LANE, f: frame(3) }]);
    const s = r.core.stats();
    assert.deepEqual([s.relays, s.relayed, s.joinsRefused], [1, 2, 1]);
  });

  test('LADV-1 C joined first: A takes the second place, B is "lane full", and what A relays goes to C alone', () => {
    const r = rig();
    r.mint();
    const [a, b, c] = ['a', 'b', 'c'].map(r.conn);
    r.send(c, { action: 'pair-join', lane: LANE, rid: 'j0' });
    r.send(a, { action: 'pair-join', lane: LANE, rid: 'j1' });
    r.send(b, { action: 'pair-join', lane: LANE, rid: 'j2' });
    assert.deepEqual(r.take(a), [{ action: 'pair-join', lane: LANE, peers: 1, rid: 'j1' }]);
    assert.deepEqual(r.take(b), [joinFailure('lane full', 'j2')]);
    r.take(c);
    r.send(a, { action: 'pair-relay', lane: LANE, f: frame(4) });
    assert.deepEqual(r.take(c), [{ action: 'pair-relayed', lane: LANE, f: frame(4) }]);
    assert.deepEqual(r.take(b), [], 'B is not in the lane and gets nothing');
    r.send(b, { action: 'pair-relay', lane: LANE, f: frame(5), rid: 'r2' });
    assert.deepEqual(r.take(b), [relayFailure('unknown lane', 'r2')], 'and cannot relay into it');
    assert.deepEqual(r.take(a), []);
  });

  test('LADV-1 a guessed lane id is refused ("unknown lane") and the guessing ends at the 151st message of the socket', () => {
    const r = rig();
    r.mint();
    const { a, b } = pairOnLane(r);
    const c = r.conn('c');
    let closedAt = 0;
    let refused = 0;
    for (let i = 1; i <= 200; i++) {
      const out = r.send(c, { action: 'pair-join', lane: hexOf(i), rid: 'g' + i });
      const reply = r.take(c)[0];
      if (reply && reply['failure reason'] === 'unknown lane') refused++;
      if (out.close && !closedAt) closedAt = i;
    }
    assert.equal(refused, CAPS.messagesPerMin, 'every guess the core looked at was an unknown lane');
    assert.equal(closedAt, CAPS.messagesPerMin + 1, 'the 151st message asks the host to close the socket');
    assert.equal(r.core.stats().joinsRefused, CAPS.messagesPerMin);
    assert.deepEqual([r.take(a), r.take(b)], [[], []], 'the pair is untouched');
    r.drop(c);
    assert.equal(r.core.stats().relays, 1);
  });

  test('LADV-1 a room lane holds 16: the 17th is "lane full"; one frame reaches the other 15 and is counted once; the minute\'s cap is the sender\'s, not the copies\'', () => {
    const r = rig();
    r.mint();
    const members = Array.from({ length: CAPS.roomLaneMembers }, (_, i) => r.conn('m' + i));
    for (const m of members) r.send(m, { action: 'room-join', lane: LANE });
    for (const m of members) r.take(m);
    const extra = r.conn('extra');
    r.send(extra, { action: 'room-join', lane: LANE, rid: 'x' });
    assert.deepEqual(r.take(extra), [{ action: 'room-join', 'failure reason': 'lane full', rid: 'x' }]);
    r.send(members[0], { action: 'room-relay', lane: LANE, f: frame(1) });
    assert.deepEqual(members.slice(1).map((m) => r.take(m).length), new Array(CAPS.roomLaneMembers - 1).fill(1), 'each of the other 15 got one copy');
    assert.deepEqual([r.take(members[0]), r.take(extra)], [[], []], 'the sender and the outsider got none');
    assert.equal(r.core.stats().relayed, 1, 'one frame, not fifteen');
    for (let i = 2; i <= CAPS.relayPerMin + 3; i++) r.send(members[0], { action: 'room-relay', lane: LANE, f: frame(i) });
    assert.equal(r.core.stats().relayed, CAPS.relayPerMin, 'the sender may send ' + CAPS.relayPerMin + ' in a minute, whatever the copies');
  });

  test('LADV-1 a socket that is lost frees every lane it held, and the record of a lane goes with its last member', () => {
    const r = rig();
    const c = r.conn('c');
    for (let i = 1; i <= CAPS.lanesPerSocket; i++) {
      r.mint(hexOf(i));
      r.send(c, { action: 'pair-join', lane: hexOf(i) });
    }
    r.mint(hexOf(99));
    r.send(c, { action: 'pair-join', lane: hexOf(99), rid: 'nine' });
    assert.deepEqual(r.take(c).pop(), joinFailure('too many lanes', 'nine'), 'a socket joins 8 lanes at most');
    assert.equal(r.core.stats().relays, CAPS.lanesPerSocket);
    r.drop(c);
    assert.equal(r.core.stats().relays, 0, 'no record is left to grow');
  });

  test('LADV-1 C joined first, direct on: the pair\'s strikes drop the relay and the pair goes on direct, the message A relayed to C arrives once', async () => {
    const w = makeWorld({ core: true });
    w.net.canConnect = () => false; // no direct link yet: the relay is all there is
    const A = await person(w, 'Alice', { direct: 'on' });
    const B = await person(w, 'Bob', { direct: 'on' });
    // C is the rendezvous itself (or anyone it told): it joins the lane the moment the accept minted it, before A and B hear of it
    const C = { conn: w.rdv.connect(), got: [] };
    C.conn.deliver = (text) => C.got.push(JSON.parse(text));
    const set = w.rdv.lanes.set.bind(w.rdv.lanes);
    let planted = false;
    w.rdv.lanes.set = (lane, exp) => {
      set(lane, exp);
      if (!planted) {
        planted = true;
        queueMicrotask(() => w.rdv.handle(C.conn, { v: 1, action: 'pair-join', lane, rid: 'c0' }));
      }
      return w.rdv.lanes;
    };
    const { code } = await A.apps.openCode();
    await B.apps.knock(code);
    await slow(() => st(A).requests.length === 1, 'the request');
    await A.apps.accept(st(A).requests[0].knock);
    const lane = await slow(() => Array.from(w.rdv.lanes.keys())[0], 'the lane');
    await slow(() => conv(A) && conv(A).via === 'relay', 'A believes it is on the relay (C is its only peer there)');
    assert.equal(w.rdv.core.stats().relays, 1);
    assert.ok(A.reports.some((x) => x.name === 'apps.lane' && x.fields.ev === 'joined'), 'A joined');
    await slow(() => B.reports.some((x) => x.name === 'apps.lane' && x.fields.ev === 'full'), 'B was told "lane full"');
    const sent = await A.apps.send(conv(A).id, 'sent while C was the only one there ' + MARK);
    await slow(() => C.got.some((m) => m.action === 'pair-relayed'), 'the frame at C');
    const seenByC = C.got.filter((m) => m.action === 'pair-relayed').map((m) => Buffer.from(m.f, 'base64url').toString('latin1')).join('');
    assert.equal(seenByC.includes(MARK), false, 'C got sealed bytes, not the text');
    // C turns on A: frames of the right alphabet that are no frame of this conversation
    for (let i = 0; i < 4; i++) w.rdv.handle(C.conn, { v: 1, action: 'pair-relay', lane, f: 'q'.repeat(60), rid: 'g' + i });
    await slow(() => A.reports.some((x) => x.name === 'apps.wire' && x.fields.ev === 'kill' && x.fields.via === 'relay'), 'the strikes kill the relay at A');
    assert.notEqual(conv(A).via, 'relay', 'A no longer talks to C');
    // direct becomes possible: both come up on it and what A sent goes across once
    w.net.canConnect = () => true;
    w.net.connect(lane);
    await slow(() => conv(A).via === 'direct' && conv(B).via === 'direct', 'both on the direct wire');
    await slow(() => conv(B).messages.some((m) => !m.mine && m.text === 'sent while C was the only one there ' + MARK), 'the message at B');
    assert.equal(conv(B).messages.filter((m) => m.text === 'sent while C was the only one there ' + MARK).length, 1, 'once');
    assert.ok(sent.id);
  });
});

// ---------------------------------------------------------------------------------------------
// LADV-2  an f that is too long
// ---------------------------------------------------------------------------------------------

describe('LADV-2 an f that is too long', () => {
  test('LADV-2 7,700 characters pass, 7,701 and more do not, and a refused frame is not counted as relayed', () => {
    const r = rig();
    const { a, b } = pairOnLane(r);
    r.send(a, { action: 'pair-relay', lane: LANE, f: 'A'.repeat(7700), rid: 'ok' });
    assert.deepEqual(r.take(a), [{ action: 'pair-relay', lane: LANE, peers: 1, rid: 'ok' }]);
    assert.equal(r.take(b)[0].f.length, 7700);
    const before = r.core.stats();
    for (const n of [7701, 8000, 8191, 8192, 9000, 100000, 1000000]) {
      r.send(a, { action: 'pair-relay', lane: LANE, f: 'A'.repeat(n), rid: 'n' + n });
      assert.deepEqual(r.take(a), [relayFailure('invalid frame', 'n' + n)], n + ' characters');
    }
    assert.deepEqual(r.take(b), [], 'nothing of those reached B');
    const after = r.core.stats();
    assert.deepEqual([after.relayed, after.relayBytes], [before.relayed, before.relayBytes], 'no refused frame is counted');
  });

  test('LADV-2 a message past 8,192 bytes is refused whole by the rendezvous core: nothing is forwarded, nothing is counted', () => {
    const core = createRendezvous({ open: true });
    const { owner, requester, lane, say } = meetOn(core);
    say(owner, { action: 'pair-join', lane, rid: 'jo' });
    say(requester, { action: 'pair-join', lane, rid: 'jr' });
    owner.take();
    requester.take();
    const before = core.stats();
    const big = JSON.stringify({ v: 1, action: 'pair-relay', lane, f: 'A'.repeat(MAX_PAIR_BYTES), rid: 'big' });
    assert.ok(big.length > MAX_PAIR_BYTES);
    core.message(owner, big);
    assert.deepEqual(owner.take().map((m) => m['failure reason']), ['message too large']);
    assert.deepEqual(requester.take(), []);
    const after = core.stats();
    assert.deepEqual([after.relayed, after.relayBytes], [before.relayed, before.relayBytes]);
  });

  test('LADV-2 the client refuses to send what the rendezvous would refuse: nothing leaves the socket', async () => {
    const w = makeWorld({ core: true });
    const link = new FakeLink(w.rdv, { setTimeoutFn: w.clock.setTimeout, clearTimeoutFn: w.clock.clearTimeout, random: () => 0.5, now: w.clock.now });
    made.push({ apps: { destroy () {} }, link });
    assert.equal(await link.whenOpen(), true);
    const sentBefore = link._ws.sent.length;
    assert.deepEqual(await link.relay(LANE, 'pair', new Uint8Array(5776)), { ok: false, reason: 'too-big' }, '5,776 bytes are 7,702 characters');
    assert.deepEqual(await link.relay(LANE, 'pair', new Uint8Array(2)), { ok: false, reason: 'invalid-frame' });
    assert.deepEqual(await link.relay(LANE, 'pair', 'not bytes'), { ok: false, reason: 'invalid-frame' });
    assert.equal((await link.relay('X'.repeat(40), 'pair', new Uint8Array(40))).ok, false);
    assert.equal((await link.relay(LANE, 'nonsense', new Uint8Array(40))).ok, false);
    assert.equal(link._ws.sent.length, sentBefore, 'not one frame was written');
  });
});

// ---------------------------------------------------------------------------------------------
// LADV-3  an f of other alphabets or other types, and a lane of other shapes
// ---------------------------------------------------------------------------------------------

describe('LADV-3 other alphabets, other types', () => {
  const BAD_F = [
    ['the + of standard base64', 'AA+A'], ['the / of standard base64', 'AA/A'], ['base64 padding', 'AAA='], ['a space', 'AA AA'], ['a newline', 'AAAA\n'],
    ['a tab', 'AA\tAA'], ['full width letters', '\uff21\uff22\uff23\uff24'], ['Arabic-Indic digits', '\u0660\u0661\u0662\u0663'], ['a Cyrillic A', '\u0410BCD'],
    ['a zero width space', 'AA\u200bAA'], ['an emoji', 'AA\u{1F600}A'], ['a combining mark', 'A\u0301AAA'], ['a NUL', 'AA\0AA'], ['a percent escape', 'AA%41'],
    ['a dot', 'AA.AA'], ['a quote', 'AA"AA'], ['a backslash', 'AA\\AA'], ['an empty string', ''], ['three characters', 'AAA'],
    ['a number', 1234], ['null', null], ['true', true], ['an array', ['AAAA']], ['an object', {}], ['an object with f', { f: 'AAAA' }],
  ];

  test('LADV-3 every f of another alphabet or type is "invalid frame": nothing is forwarded, and nothing is counted', () => {
    const r = rig();
    const { a, b } = pairOnLane(r);
    const before = r.core.stats();
    let n = 0;
    for (const [what, f] of BAD_F) {
      r.send(a, { action: 'pair-relay', lane: LANE, f, rid: 'x' + n });
      assert.deepEqual(r.take(a), [relayFailure('invalid frame', 'x' + n)], what);
      n++;
    }
    r.send(a, { action: 'pair-relay', lane: LANE, rid: 'none' });
    assert.deepEqual(r.take(a), [relayFailure('invalid frame', 'none')], 'no f at all');
    assert.deepEqual(r.take(b), [], 'B heard none of it');
    const after = r.core.stats();
    assert.deepEqual([after.relayed, after.relayBytes, after.relayRate, after.relayBusy], [before.relayed, before.relayBytes, before.relayRate, before.relayBusy]);
    // the whole alphabet, and only it, passes
    const all = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    r.send(a, { action: 'pair-relay', lane: LANE, f: all });
    assert.deepEqual(r.take(b), [{ action: 'pair-relayed', lane: LANE, f: all }]);
  });

  test('LADV-3 a lane of another shape is "invalid lane" (a join counts as refused), never a member and never forwarded to', () => {
    const r = rig();
    const { a, b } = pairOnLane(r);
    const c = r.conn('c');
    const BAD_LANE = [LANE.toUpperCase(), LANE.slice(1), LANE + '0', 'g' + LANE.slice(1), '', ' ' + LANE, LANE + ' ', '\uff10'.repeat(40), 1234, null, [LANE], { lane: LANE }];
    let refused = r.core.stats().joinsRefused;
    for (const lane of BAD_LANE) {
      r.send(c, { action: 'pair-join', lane, rid: 'j' });
      assert.deepEqual(r.take(c), [joinFailure('invalid lane', 'j')], JSON.stringify(lane));
      refused++;
      r.send(c, { action: 'pair-relay', lane, f: frame(7), rid: 'r' });
      assert.deepEqual(r.take(c), [relayFailure('invalid lane', 'r')]);
    }
    assert.equal(r.core.stats().joinsRefused, refused);
    assert.deepEqual([r.take(a), r.take(b)], [[], []]);
  });

  test('LADV-3 a lane has one kind, the kind of its first joiner: room-join and room-relay on a pair lane are refused and reach nobody', () => {
    const r = rig();
    const { a, b } = pairOnLane(r);
    const c = r.conn('c');
    r.send(c, { action: 'room-join', lane: LANE, rid: 'j' });
    assert.equal(r.take(c)[0]['failure reason'], 'unknown lane');
    r.send(a, { action: 'room-relay', lane: LANE, f: frame(8), rid: 'x' });
    assert.equal(r.take(a)[0]['failure reason'], 'unknown lane');
    assert.deepEqual([r.take(b), r.take(c)], [[], []]);
    r.send(a, { action: 'pair-relay', lane: LANE, f: frame(9) });
    assert.equal(r.take(b)[0].action, 'pair-relayed', 'the pair lane still works as a pair lane');
  });
});

// ---------------------------------------------------------------------------------------------
// LADV-4  10,000 relays in a burst
// ---------------------------------------------------------------------------------------------

describe('LADV-4 10,000 relays in a burst', () => {
  test('LADV-4 the numbers below are the caps of plan 3.2, which are the module\'s own', () => {
    for (const [name, want] of Object.entries(CAPS)) assert.equal(DEFAULT_CAPS[name], want, name);
  });

  test('LADV-4 the core: 120 go through, the 121st to the 149th are "too many relays", the 151st message asks for the close, and a host that goes on gets nothing forwarded', () => {
    const r = rig();
    const { a, b } = pairOnLane(r);
    // the join was message 1: relay i is message i + 1
    let closedAt = 0;
    let rate = 0;
    let capped = 0;
    for (let i = 1; i <= 10000; i++) {
      const out = r.send(a, { action: 'pair-relay', lane: LANE, f: frame(i) });
      const reply = r.take(a)[0];
      if (reply && reply['failure reason'] === 'too many relays') rate++;
      if (reply && reply['failure reason'] === 'too many messages') capped++;
      if (out.close === 'too many messages' && !closedAt) closedAt = i;
    }
    const forwarded = r.take(b);
    assert.equal(forwarded.length, CAPS.relayPerMin, 'the 120 first are forwarded, none more');
    assert.ok(forwarded.every((m, i) => m.action === 'pair-relayed' && m.f === frame(i + 1)), 'and they are the first 120, in order');
    assert.equal(rate, CAPS.messagesPerMin - 1 - CAPS.relayPerMin, 'relays 121 to 149 are refused by the minute\'s cap (the join took one message)');
    assert.equal(closedAt, CAPS.messagesPerMin, 'relay 150 is the socket\'s 151st message: the close');
    assert.ok(capped >= 1, 'the message over the allowance was refused for it, with a reply that says why');
    const s = r.core.stats();
    assert.deepEqual([s.relayed, s.relayRate], [CAPS.relayPerMin, rate]);
    // the host closes the socket: B hears that A left
    r.drop(a);
    assert.deepEqual(r.take(b), [{ action: 'pair-left', lane: LANE, peers: 0 }]);
    assert.equal(r.core.stats().relays, 1, 'B is still in the lane');
  });

  test('LADV-4 the minute is a sliding one: a burst that was refused can send again a minute later, from a new socket of the same person', () => {
    const r = rig();
    const { a, b } = pairOnLane(r);
    for (let i = 1; i <= CAPS.relayPerMin + 5; i++) r.send(a, { action: 'pair-relay', lane: LANE, f: frame(i) });
    r.take(a);
    r.take(b);
    r.clock.t += MIN + 1;
    r.send(a, { action: 'pair-relay', lane: LANE, f: frame(500), rid: 'again' });
    assert.deepEqual(r.take(a), [{ action: 'pair-relay', lane: LANE, peers: 1, rid: 'again' }]);
    assert.equal(r.take(b).length, 1);
  });

  test('LADV-4 on a real socket of the Node tracker: 10,000 relays are 120 pushes at the other side and the socket is closed with 1008', async () => {
    const t = await createTracker({ port: 0, open: true, quiet: true });
    const sockets = [];
    try {
      const open = (name) => new Promise((resolve, reject) => {
        const ws = new WebSocket(t.url);
        const c = { name, ws, got: [], closed: null };
        ws.on('message', (d) => c.got.push(JSON.parse(d.toString('utf8'))));
        ws.on('close', (code) => { c.closed = code; });
        ws.once('open', () => resolve(c));
        ws.once('error', reject);
        sockets.push(ws);
      });
      const say = (c, msg) => c.ws.send(JSON.stringify(Object.assign({ v: 1 }, msg)));
      const A = await open('owner');
      const B = await open('requester');
      say(A, { action: 'pair-open', channel: 'abcd', box: BOX, rid: 'o' });
      await until(() => A.got.some((m) => m.action === 'pair-open'), 'the code', 4000);
      say(B, { action: 'pair-knock', channel: 'abcd', box: BOX, rid: 'k' });
      const knock = (await until(() => B.got.find((m) => m.knock), 'the knock', 4000)).knock;
      say(A, { action: 'pair-accept', knock, proof: PROOF, rid: 'a' });
      const lane = (await until(() => A.got.find((m) => m.action === 'pair-accepted'), 'the accept', 4000)).lane;
      say(A, { action: 'pair-join', lane, rid: 'ja' });
      say(B, { action: 'pair-join', lane, rid: 'jb' });
      await until(() => A.got.some((m) => m.action === 'pair-joined') && B.got.some((m) => m.action === 'pair-join'), 'both in the lane', 4000);
      for (let i = 1; i <= 10000 && A.ws.readyState === WebSocket.OPEN; i++) say(A, { action: 'pair-relay', lane, f: frame(i) });
      await until(() => A.closed !== null, 'the close', 8000);
      assert.equal(A.closed, 1008, 'the socket is closed with 1008');
      await until(() => B.got.filter((m) => m.action === 'pair-left').length === 1, 'B told that A left', 4000);
      const relayed = B.got.filter((m) => m.action === 'pair-relayed');
      assert.equal(relayed.length, CAPS.relayPerMin, 'B was sent 120 frames and no more');
      assert.equal(t.stats().relayed, CAPS.relayPerMin);
    } finally {
      for (const ws of sockets) ws.terminate();
      await t.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// LADV-5  a relayed frame for a lane the page never joined
// ---------------------------------------------------------------------------------------------

describe('LADV-5 a relayed frame for a lane the page never joined', () => {
  test('LADV-5 the page drops it: no state moves, no strike, no report moves', async () => {
    const w = makeWorld({ core: true });
    const { A, B, lane, a } = await pairViaRelay(w);
    const sent = await A.apps.send(a, 'a message of the conversation ' + MARK);
    await slow(() => conv(B).messages.some((m) => !m.mine && m.text.endsWith(MARK)), 'the message at B');
    await settle(20);
    const real = relayedBy(A)[0]; // a genuine sealed frame of this conversation
    const reportsBefore = A.reports.length;
    const stateBefore = view(A) + JSON.stringify(st(A).requests);
    push(w, A, { action: 'pair-relayed', lane: LANE_2, f: real }); // another lane
    push(w, A, { action: 'pair-relayed', lane: hexOf(77), f: 'q'.repeat(60) }); // another lane, garbage
    await settle(20);
    assert.equal(view(A) + JSON.stringify(st(A).requests), stateBefore, 'the service did nothing with them');
    assert.deepEqual(A.reports.slice(reportsBefore).filter((x) => x.name.startsWith('apps.')), [], 'and reported nothing');
    assert.equal(conv(A).via, 'relay');
    // the genuine frame under the right lane is a replay: seen already, shown once
    push(w, A, { action: 'pair-relayed', lane, f: relayedBy(B)[0] });
    await settle(20);
    assert.equal(conv(A).messages.filter((m) => m.text.endsWith(MARK)).length, 1);
    assert.ok(sent.id);
  });

  test('LADV-5 a frame of A and B\'s lane pushed to a third person\'s page, who never joined it, is dropped', async () => {
    const w = makeWorld({ core: true });
    const { A, B, lane } = await pairViaRelay(w);
    const C = await person(w, 'Cara');
    const D = await person(w, 'Dan');
    const { code } = await C.apps.openCode();
    await D.apps.knock(code);
    await slow(() => st(C).requests.length === 1, 'the request at Cara');
    await C.apps.accept(st(C).requests[0].knock);
    await slow(() => isConnected(C) && isConnected(D) && conv(C).via === 'relay', 'Cara and Dan connected');
    const before = view(C) + view(D);
    const real = relayedBy(A).concat(relayedBy(B)).filter(Boolean);
    assert.ok(real.length > 0, 'the harness has frames to move');
    for (const f of real) push(w, C, { action: 'pair-relayed', lane, f });
    await settle(30);
    assert.equal(view(C) + view(D), before, 'nothing of Alice and Bob\'s conversation touches Cara\'s');
    assert.equal(conv(C).via, 'relay');
  });
});

// ---------------------------------------------------------------------------------------------
// LADV-6  a joined push with peers 999, and a rendezvous that lies about who is in the lane
// ---------------------------------------------------------------------------------------------

describe('LADV-6 pushes about who is in the lane', () => {
  test('LADV-6 the link takes a count from 0 to 64 and drops every other: 999, -1, 1.5, "2", null, a missing one', async () => {
    const w = makeWorld({ core: true });
    const link = new FakeLink(w.rdv, { setTimeoutFn: w.clock.setTimeout, clearTimeoutFn: w.clock.clearTimeout, random: () => 0.5, now: w.clock.now });
    made.push({ apps: { destroy () {} }, link });
    const heard = [];
    for (const ev of ['joined', 'left']) link.on(ev, (e) => heard.push([ev, e.peers]));
    assert.equal(await link.whenOpen(), true);
    const conn = connOf({ link });
    for (const peers of [999, 65, -1, 1.5, '2', null, undefined, NaN, {}, [1]]) {
      w.rdv._send(conn, { action: 'pair-joined', lane: LANE, peers });
      w.rdv._send(conn, { action: 'pair-left', lane: LANE, peers });
    }
    w.rdv._send(conn, { action: 'pair-joined', peers: 1 }); // no lane
    w.rdv._send(conn, { action: 'pair-joined', lane: LANE.toUpperCase(), peers: 1 });
    await settle(20);
    assert.deepEqual(heard, [], 'not one of them was taken');
    w.rdv._send(conn, { action: 'pair-joined', lane: LANE, peers: 1 });
    w.rdv._send(conn, { action: 'pair-left', lane: LANE, peers: 0 });
    await settle(20);
    assert.deepEqual(heard, [['joined', 1], ['left', 0]], 'the control: a sound push is taken');
  });

  test('LADV-6 a joined push with peers 999 changes nothing in a connected conversation: readiness, via, and every report', async () => {
    const w = makeWorld({ core: true });
    const { A, B, lane } = await pairViaRelay(w);
    await settle(10);
    const before = view(A);
    const reports = A.reports.length;
    push(w, A, { action: 'pair-joined', lane, peers: 999 });
    push(w, A, { action: 'pair-joined', lane: LANE_2, peers: 999 });
    await settle(20);
    assert.equal(view(A), before);
    assert.equal(conv(A).via, 'relay');
    assert.equal(JSON.stringify(A.reports.slice(reports)).includes('999'), false, 'no report carries the number');
    assert.equal(JSON.stringify(st(A)).includes('999'), false, 'and neither does the state');
    // and a message still goes across
    const r = await A.apps.send(conv(A).id, 'still here ' + MARK);
    await slow(() => conv(B).messages.some((m) => m.text === 'still here ' + MARK), 'the message at B');
    assert.ok(r.id);
  });

  test('LADV-6 a rendezvous that says the other person left, and then that they are back, loses no message and shows none twice', async () => {
    const w = makeWorld({ core: true });
    const { A, B, lane, a } = await pairViaRelay(w);
    push(w, A, { action: 'pair-left', lane, peers: 0 }); // a lie: B never left
    await slow(() => conv(A).via !== 'relay', 'A believes the other person is gone');
    const sent = await A.apps.send(a, 'written while the lane looked empty ' + MARK);
    await settle(20);
    push(w, A, { action: 'pair-joined', lane, peers: 1 });
    await slow(() => conv(A).via === 'relay', 'and back');
    await slow(() => conv(B).messages.some((m) => !m.mine && m.text === 'written while the lane looked empty ' + MARK), 'the message at B');
    await settle(30);
    assert.equal(conv(B).messages.filter((m) => m.text.endsWith(MARK) && m.text.startsWith('written')).length, 1, 'once');
    await slow(() => conv(A).messages.find((m) => m.id === sent.id).status !== 'sent' && conv(A).messages.find((m) => m.id === sent.id).status !== 'queued', 'delivered at A');
  });
});

// ---------------------------------------------------------------------------------------------
// LADV-7  the rendezvous echoing a frame back to its sender
// ---------------------------------------------------------------------------------------------

describe('LADV-7 the rendezvous echoes a frame back to its sender', () => {
  /** What A believes about the other person, without the path: the messages with their receipts, the unread count, the typing line. */
  const belief = (X) => JSON.stringify([conv(X).messages.map((m) => [m.id, m.mine, m.text, m.status, m.deleted, m.edits.length, m.reactions]), conv(X).unread, conv(X).typingPeer]);

  /** A and B talk over the relay in the order that makes a reflected read receipt dangerous: A's message is OLDER than the reply A reads. */
  async function talked(w) {
    const p = await pairViaRelay(w);
    const { A, B, a, b } = p;
    w.advance(1000);
    const first = await A.apps.send(a, 'A wrote this first ' + MARK);
    await slow(() => conv(A).messages.find((m) => m.id === first.id).status === 'delivered', 'delivered');
    w.advance(1000);
    await B.apps.send(b, 'B answered ' + MARK);
    await slow(() => conv(A).messages.some((m) => !m.mine), 'the answer at A');
    await A.apps.markRead(a); // A sends { k: 'read', upTo } that names B's message, and A's first message is older than that
    await slow(() => relayedBy(A).length >= 4, 'the frames went');
    await settle(30);
    assert.equal(conv(A).messages.find((m) => m.id === first.id).status, 'delivered', 'B never read it: Delivered, not Read');
    return Object.assign({ first }, p);
  }

  test('LADV-7 every frame A sent, pushed back to A: no message twice, no receipt settled by A\'s own read receipt, nothing of the other person invented', async () => {
    const w = makeWorld({ core: true });
    const { A, B, lane, first } = await talked(w);
    const before = belief(A);
    const reads = A.reports.filter((x) => x.name === 'apps.msg' && x.fields.status === 'read').length;
    const frames = relayedBy(A);
    assert.ok(frames.length >= 4, 'A sent a message, an ack, a read receipt and more: ' + frames.length);
    for (const f of frames) push(w, A, { action: 'pair-relayed', lane, f });
    await settle(60);
    assert.equal(conv(A).messages.find((m) => m.id === first.id).status, 'delivered', 'the echo of A\'s own receipt marked nothing Read');
    assert.equal(A.reports.filter((x) => x.name === 'apps.msg' && x.fields.status === 'read').length, reads, 'and no read was reported');
    assert.equal(belief(A), before, 'no message twice, no state of the other person made from A\'s own frames');
    assert.equal(conv(B).messages.find((m) => m.mine).status, 'read', 'the one real receipt (A read B\'s answer) is B\'s, and stays');
  });

  test('LADV-7 the plan\'s contract: an echo is dropped, not struck, so it does not end the relay (plan 6.5: dropped by _fresh)', async () => {
    const w = makeWorld({ core: true });
    const { A, B, lane, b } = await talked(w);
    const frames = relayedBy(A);
    for (const f of frames) push(w, A, { action: 'pair-relayed', lane, f });
    await settle(60);
    const strikes = A.reports.filter((x) => x.name === 'apps.wire' && (x.fields.ev === 'strike' || x.fields.ev === 'kill')).map((x) => x.fields.ev + ':' + x.fields.reason);
    assert.deepEqual(strikes, [], 'A struck its own frames (' + frames.length + ' echoed): a sealed frame A made cannot be opened by A, so the echo must be told apart before it is opened');
    assert.equal(conv(A).via, 'relay', 'the relay lives');
    const after = await B.apps.send(b, 'and then ' + MARK);
    await slow(() => conv(A).messages.some((m) => m.id === after.id), 'a message after the echo');
  });
});

// ---------------------------------------------------------------------------------------------
// LADV-8  a pong with a payload
// ---------------------------------------------------------------------------------------------

describe('LADV-8 a pong with a payload', () => {
  test('LADV-8 any pong feeds the watchdog and nothing else: no event, no report, no log line carries what it brought; silence still reconnects', async () => {
    const w = makeWorld({ core: true });
    w.rdv.pongs = false; // this rendezvous answers no ping on its own: the test is the only one that can
    const reports = [];
    const logs = [];
    const events = [];
    const link = new FakeLink(w.rdv, {
      keepaliveMs: 1000, pongWaitMs: 500, setTimeoutFn: w.clock.setTimeout, clearTimeoutFn: w.clock.clearTimeout, random: () => 0.5, now: w.clock.now,
      report: (n, f) => reports.push([n, JSON.parse(JSON.stringify(f))]), log: (...p) => logs.push(p.map(String).join(' ')),
    });
    made.push({ apps: { destroy () {} }, link });
    for (const ev of ['state', 'open', 'gone', 'request', 'accepted', 'rejected', 'cancelled', 'closed', 'silent', 'relayed', 'joined', 'left']) link.on(ev, (e) => events.push([ev, e]));
    assert.equal(await link.whenOpen(), true);
    events.length = 0;
    reports.length = 0;
    const ws = link._ws;
    w.clock.advance(1000); // the keepalive
    assert.equal(ws.sent.filter((t) => t === PING).length, 1, 'the exact ping text, once');
    // the pong brings a payload of every kind a pong should not have
    push(w, { link }, { action: 'pair-pong', data: MARK, f: 'AAAA'.repeat(10), lane: LANE, peers: 999, box: BOX, rid: 'nope', 'failure reason': 'x' + MARK });
    await settle(10);
    w.clock.advance(600); // past pongWaitMs: the pong was heard, so the socket is not taken for half open
    assert.equal(link.state, 'open', 'the pong kept the link');
    assert.deepEqual(events, [], 'a pong is no event');
    assert.equal(JSON.stringify(reports).includes(MARK) || JSON.stringify(logs).includes(MARK), false, 'and nothing it carried is in a report or a log line');
    assert.equal(reports.filter(([n]) => n === 'push').length, 0, 'it is not even a push');
    // silence: the next ping gets no pong and nothing else comes
    w.clock.advance(1000);
    w.clock.advance(600);
    assert.equal(link.state, 'backoff', 'no pong and no frame: the socket is half open and the link goes to reconnect');
  });
});

// ---------------------------------------------------------------------------------------------
// LADV-9  a ping flood
// ---------------------------------------------------------------------------------------------

/**
 * A platform for the Durable Object class of worker.js: the Hibernation API in memory. It answers the exact text of setWebSocketAutoResponse itself,
 * keeps the time of that answer for getWebSocketAutoResponseTimestamp, and counts every message that does wake the object (state.wakes).
 */
function platform() {
  if (typeof globalThis.WebSocketRequestResponsePair !== 'function') {
    globalThis.WebSocketRequestResponsePair = class WebSocketRequestResponsePair { constructor(request, response) { this.request = request; this.response = response; } };
  }
  const rows = new Map();
  let alarm = null;
  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const state = { wakes: 0, answered: 0, auto: null, calls: 0 };
  const sockets = [];
  const stamps = new Map();
  const storage = {
    async get(key) { return clone(rows.get(key)); },
    async put(key, value) { rows.set(key, clone(value)); },
    async delete(key) { return rows.delete(key); },
    async list({ prefix = '' } = {}) { const out = new Map(); for (const k of Array.from(rows.keys()).sort()) if (k.startsWith(prefix)) out.set(k, clone(rows.get(k))); return out; },
    async getAlarm() { return alarm; },
    async setAlarm(t) { alarm = t; },
  };
  const ctx = {
    storage, sockets,
    getWebSockets: () => sockets.slice(),
    acceptWebSocket(ws) { sockets.push(ws); },
    blockConcurrencyWhile: (fn) => Promise.resolve().then(fn),
    setWebSocketAutoResponse(pair) { state.calls++; state.auto = pair ? { request: pair.request, response: pair.response } : null; },
    getWebSocketAutoResponseTimestamp(ws) { return stamps.get(ws) || null; },
  };
  const ws = (name) => ({ name, sent: [], closed: null, attachment: null, send(t) { this.sent.push(t); }, close(code, reason) { this.closed = { code, reason }; }, serializeAttachment(v) { this.attachment = clone(v); }, deserializeAttachment() { return this.attachment; } });
  return {
    ctx, state, stamps, ws,
    /** deliver(obj, socket, text): what the platform does with a text frame from a client. */
    async deliver(obj, socket, text) {
      if (state.auto && text === state.auto.request) {
        state.answered++;
        stamps.set(socket, new Date(Date.now()));
        socket.send(state.auto.response);
        return;
      }
      state.wakes++;
      await obj.webSocketMessage(socket, text);
    },
  };
}

describe('LADV-9 a ping flood', () => {
  // DECISIONS DEC-2 (W1 Open 2): on the Worker the platform answers the exact keepalive text before the object wakes (the next test), so a ping
  // that reaches the core has another shape and woke the object. It counts toward messagesPerMin like any message, so a flood of them is closed
  // like a flood of anything else, and toward no relay cap; it is still answered with the bare pong and changes nothing.
  test('LADV-9 the core answers a ping of any shape with the bare pong, counts it toward messagesPerMin and no relay cap, and the 151st message of the minute closes the socket (DEC-2)', () => {
    const r = rig();
    const { a, b } = pairOnLane(r); // a's join is the first message of its minute (the rig's clock stands still)
    const before = r.core.stats();
    const closes = [];
    let changed = 0;
    for (let i = 0; i < 10000; i++) {
      const out = r.send(a, i % 3 === 0 ? { action: 'pair-ping' } : i % 3 === 1 ? { action: 'pair-ping', rid: 'x' + i, junk: MARK } : { action: 'pair-ping', f: frame(i), lane: LANE });
      if (out.close) closes.push(i);
      if (out.changed) changed++;
    }
    const answers = r.take(a);
    assert.equal(answers.length, 10000, 'one answer for each ping');
    const allowed = CAPS.messagesPerMin - 1; // the join and 149 pings make the 150 messages of the minute
    assert.ok(answers.slice(0, allowed).every((m) => JSON.stringify(m) === PONG), 'every ping under the cap gets exactly the pong: no payload comes back');
    assert.equal(closes[0], allowed, 'the 150th ping, the 151st message of the minute, is the first the core refuses: the host closes the socket (1008)');
    assert.equal(closes.length, 10000 - allowed, 'and so is every later one (this rig never closes the socket; a host does at the first)');
    for (const m of answers.slice(allowed)) {
      assert.deepEqual(Object.keys(m).filter((k) => k !== 'rid'), ['action', 'failure reason'], 'one failure reply, no pong: ' + JSON.stringify(m).slice(0, 80));
      assert.equal(m.action, 'pair-ping');
      assert.equal(m['failure reason'], 'too many messages');
    }
    const said = JSON.stringify(answers);
    assert.equal(said.includes(MARK) || said.includes(LANE) || said.includes('Zz9_-'), false, 'nothing a ping carried comes back: not its junk, its lane or its f');
    assert.equal(changed, 0, 'no ping changed anything');
    assert.deepEqual(r.take(b), [], 'B heard nothing of them');
    assert.deepEqual(r.core.stats(), before, 'no counter moved: a ping is no relay, no refused join and no eviction');
    // toward no relay cap: B, whose minute holds its join alone, sends 29 pings and still has all 120 relays of the minute (if pings counted
    // toward relayPerMin only 91 would pass); its 151st message, a ping again, is refused and closes the socket like any other
    for (let i = 0; i < 29; i++) assert.equal(r.send(b, { action: 'pair-ping' }).close, undefined);
    for (let i = 1; i <= CAPS.relayPerMin; i++) assert.equal(r.send(b, { action: 'pair-relay', lane: LANE, f: frame(i) }).close, undefined, 'relay ' + i);
    assert.equal(r.take(a).filter((m) => m.action === 'pair-relayed').length, CAPS.relayPerMin, 'all 120 frames reached the other socket');
    assert.equal(r.core.stats().relayRate, 0, 'no frame was refused by the relay cap');
    r.take(b);
    const over = r.send(b, { action: 'pair-ping' });
    assert.equal(over.close, 'too many messages');
    assert.deepEqual(r.take(b), [{ action: 'pair-ping', 'failure reason': 'too many messages' }], 'told why, once, and no pong');
  });

  test('LADV-9 the client\'s ping text, the core\'s and the Worker\'s registered request are the same bytes, and a flood of it never wakes the object', async () => {
    // what a client sends: the real link with a keepalive, on a fake socket, with a manual clock
    const w = makeWorld({ core: true });
    const link = new FakeLink(w.rdv, { keepaliveMs: 1000, setTimeoutFn: w.clock.setTimeout, clearTimeoutFn: w.clock.clearTimeout, random: () => 0.5, now: w.clock.now });
    made.push({ apps: { destroy () {} }, link });
    assert.equal(await link.whenOpen(), true);
    w.clock.advance(1000);
    const clientText = link._ws.sent.find((t) => t.includes('pair-ping'));
    assert.equal(clientText, PING, 'the client sends the exact text of plan 3.4');
    // the Worker: a Durable Object on the fake platform
    const p = platform();
    const obj = new Rendezvous(p.ctx, { ALLOW: '', OPEN: '1', PAIRING: '1', STATS_TOKEN: 's3cret', RTC: null });
    await obj.ready;
    assert.equal(p.state.calls >= 1 && p.state.auto !== null, true, 'the object registered an auto-response');
    assert.deepEqual(p.state.auto, { request: PING, response: PONG }, 'the exact strings, the client\'s among them');
    const ws = p.ws('flood');
    p.ctx.sockets.push(ws);
    const conn = obj.connFor(ws);
    obj.core.attach(conn, null);
    obj.keep(ws, conn);
    await obj.ensureAlarm();
    for (let i = 0; i < 10000; i++) await p.deliver(obj, ws, clientText);
    assert.equal(p.state.wakes, 0, '10,000 pings woke the object 0 times');
    assert.equal(p.state.answered, 10000);
    assert.equal(ws.sent.length, 10000);
    assert.ok(ws.sent.every((t) => t === PONG));
    assert.ok(p.stamps.get(ws) instanceof Date, 'and the time of the last answer is kept, for the idle sweep (plan 3.4)');
    assert.equal(ws.closed, null);
    // controls: a text that is not byte for byte that ping wakes the object (so the counter counts), and the core still answers it with a pong. Such a near
    // miss counts toward the socket's messages a minute (DECISIONS DEC-2): the test above pins it on the core, deploy-rtc-worker's DEC-2 test on the object.
    const near = clientText.replace('"v":1', '"v":1 ');
    await p.deliver(obj, ws, near);
    await p.deliver(obj, ws, JSON.stringify({ v: 1, action: 'pair-ping', rid: 'r' }));
    assert.equal(p.state.wakes, 2, 'two near misses woke it');
    assert.deepEqual(ws.sent.slice(-2).map((t) => JSON.parse(t).action), ['pair-pong', 'pair-pong']);
    assert.equal(ws.closed, null);
  });
});

// ---------------------------------------------------------------------------------------------
// LADV-10  the secrets, searched where they must not be
// ---------------------------------------------------------------------------------------------

/** windows(text, len): every part of `len` characters of text. A lane id is searched by its 9 character windows: the reporter's mask keeps 8, so no more than that may be anywhere. */
function windows(text, len) {
  const out = [];
  for (let i = 0; i + len <= text.length; i++) out.push(text.slice(i, i + len));
  return out;
}

/** dump(node): every text and attribute of a fake DOM, each with whether it lies where messages are drawn. */
function dump(node, inRegion = false, out = []) {
  const role = node.getAttribute ? node.getAttribute('data-role') : null;
  const klass = node.className || (node.getAttribute && node.getAttribute('class')) || '';
  const region = inRegion || role === 'messages' || role === 'room-messages' || /\bmw-apps-row-prev\b/.test(klass) || role === 'replying';
  if (node._text) out.push({ value: node._text, region, where: 'text' });
  if (node.attrs) for (const [k, v] of node.attrs) out.push({ value: k + '=' + v, region, where: 'attribute ' + k });
  if (typeof node.value === 'string' && node.value) out.push({ value: node.value, region, where: 'value' });
  for (const c of node.children || []) dump(c, region, out);
  if (node._shadow) dump(node._shadow, region, out);
  return out;
}

describe('LADV-10 the lane id, the frames and the message texts are nowhere they must not be', () => {
  test('LADV-10 after a conversation over the relay: every report field, log line and state value, and the page, hold no lane id, no frame, and no message text outside the lists of messages', async () => {
    const w = makeWorld({ core: true });
    const { A, B, lane, a, b } = await pairViaRelay(w);
    const texts = ['first ' + MARK + '-1', 'second ' + MARK + '-2', 'third ' + MARK + '-3'];
    await A.apps.send(a, texts[0]);
    await slow(() => conv(B).messages.some((m) => m.text === texts[0]), 'the first at B');
    w.advance(1000);
    await B.apps.send(b, texts[1]);
    await slow(() => conv(A).messages.some((m) => m.text === texts[1]), 'the second at A');
    await A.apps.markRead(a);
    w.advance(1000);
    await A.apps.send(a, texts[2]);
    await slow(() => conv(B).messages.some((m) => m.text === texts[2]), 'the third at B');
    await B.apps.markRead(b);
    await slow(() => conv(A).messages.find((m) => m.text === texts[0]).status === 'read', 'read');
    await settle(40);
    // a view for each of them, over the real service
    const views = [A, B].map((X) => {
      const doc = new FakeDocument();
      const root = doc.createElement('div');
      doc.body.appendChild(root);
      const ui = { showApps(n) { root.appendChild(n); }, hideApps() {}, download() { return true; }, prompt: () => Promise.resolve(true) };
      const acts = { calls: [], openLink() {}, copy: async () => true, signIn: async () => {}, signOut: async () => {}, log() {} };
      const app = createAppsUi({ root, ui, service: X.apps, lang: 'en', actions: acts, now: w.clock.now });
      return { X, doc, app };
    });
    // the frames and the lane, as the rendezvous saw them
    const frames = Array.from(new Set(relayedBy(A).concat(relayedBy(B)))).filter(Boolean);
    assert.ok(frames.length >= 6, 'there were frames to look for: ' + frames.length);
    const needles = { lane: windows(lane, 9).concat([lane.toUpperCase()]), frame: [], text: texts.concat([MARK]) };
    for (const f of frames) needles.frame.push(f.slice(0, 32), f.slice(Math.floor(f.length / 2) - 16, Math.floor(f.length / 2) + 16), f.slice(-32));
    const secret = needles.lane.concat(needles.frame);
    const searched = [];
    const find = (where, text, list) => { searched.push(where); const hit = list.find((n) => text.includes(n)); assert.equal(hit, undefined, where + ' holds ' + JSON.stringify(hit && hit.slice(0, 14)) + '...'); };
    for (const { X, doc, app } of views) {
      // reports and log lines: no secret, and no message text either
      for (const rep of X.reports) find(X.name + ' report ' + rep.name, JSON.stringify(rep.fields), secret.concat(needles.text));
      for (const line of X.logs) find(X.name + ' log line', line, secret.concat(needles.text));
      // what state() and the view's inspect() hold: ids, counts and states; a message text lives in state() by design, so the lane and the frames are what is looked for
      find(X.name + ' state', JSON.stringify(st(X)), secret);
      find(X.name + ' inspect', JSON.stringify(app.inspect()), secret.concat(needles.text));
      // the page: the list, then the conversation
      for (const shown of ['messages', 'conversation']) {
        if (shown === 'messages') app.show('messages');
        else app.show('conversation', conv(X).id);
        const pieces = dump(doc.body);
        assert.ok(pieces.length > 40, 'the page has something to read');
        for (const piece of pieces) {
          find(X.name + ' page (' + shown + ') ' + piece.where, piece.value, secret);
          if (!piece.region) find(X.name + ' page (' + shown + ') ' + piece.where + ' outside the messages', piece.value, needles.text);
        }
      }
    }
    assert.ok(searched.length > 60, 'the search read ' + searched.length + ' places');
    // a positive control: the search does see a text where messages are drawn, and does see a lane id put in the page
    const ctl = views[0];
    ctl.app.show('conversation', conv(A).id);
    assert.ok(dump(ctl.doc.body).some((x) => x.region && x.value.includes(texts[0])), 'the messages are drawn in the region the scan allows them');
    assert.equal(dump(ctl.doc.body).some((x) => !x.region && x.value.includes(texts[0])), false);
    const planted = ctl.doc.createElement('p');
    planted._text = 'oops ' + lane;
    ctl.doc.body.appendChild(planted);
    assert.ok(dump(ctl.doc.body).some((x) => needles.lane.some((n) => x.value.includes(n))), 'a lane id in the page is found');
  });
});

// ---------------------------------------------------------------------------------------------
// LADV-L  the launch policy of the e2e browsers
// ---------------------------------------------------------------------------------------------

describe('LADV-L the e2e launch policy', () => {
  test('LADV-L an extra switch is added after the local-only policy; one that repeats a switch of the policy, or names a proxy or a resolver, is refused', () => {
    const base = launchArgs();
    assert.ok(base.some((x) => x.startsWith('--host-resolver-rules=MAP * ~NOTFOUND')), 'the policy is there');
    assert.ok(base.includes('--allow-loopback-in-peer-connection'));
    const extra = launchArgs(['--force-webrtc-ip-handling-policy=disable_non_proxied_udp']);
    assert.deepEqual(extra.slice(0, base.length), base);
    assert.equal(extra[extra.length - 1], '--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    for (const bad of ['--host-resolver-rules=MAP * relay.example.test', '--proxy-server=http://proxy.example.test:3128', '--no-proxy-server', '--disable-features=Foo', '--enable-features=Foo',
      '--allow-loopback-in-peer-connection', '--no-first-run', 'force-webrtc', '', 7]) {
      assert.throws(() => launchArgs([bad]), /launchArgs/, String(bad));
    }
  });
});
