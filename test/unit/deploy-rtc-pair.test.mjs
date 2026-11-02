// Unit tests for the pairing and room protocol of the rendezvous (deploy/rtc-worker/pair.js, ARCHITECTURE 15.21): the
// pure core through fake connections, and its dispatch inside rtc.js (the same core the Worker and tools/tracker.mjs run). Nothing
// here opens a socket and no real time passes: the clock and the random bytes are injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPairing, isPairAction, isChannel, normalizeCode, formatCode, helloProblem, boxProblem, frameTooLarge,
  MAX_PAIR_BYTES, MAX_BOX_BYTES, KNOCK_TTL_MS, LANE_TTL_MS, CHANNEL_TTL_MS, MIXED, CODE_ALPHABET, DEFAULT_CAPS,
  CHANNEL_LENGTH, SECRET_LENGTH, CODE_LENGTH,
} from '../../deploy/rtc-worker/pair.js';
import { createRendezvous, PEER_TTL_S } from '../../deploy/rtc-worker/rtc.js';

const T0 = 1700000000000;
const MIN = 60000;
const HOUR = 3600000;
const bin = (hex) => Buffer.from(hex, 'hex').toString('binary');
const peer = (ch) => ch.repeat(20);
const A_HASH = 'a'.repeat(40);

/** A box of the right shape: iv is 12 bytes (16 b64url chars), ct is the sealed hello (here b64url filler). */
const boxOf = (fill = 'B', len = 160) => ({ iv: 'A'.repeat(16), ct: fill.repeat(len) });
const BOX = boxOf();
/** The owner's proof of an accept: 86 base64url characters (a 64-byte signature). The core checks the shape and passes it on. */
const PROOF = 'P'.repeat(86);

/** A fake connection: collects what the core sends, parsed. */
function conn(name) {
  const out = [];
  return { name, out, send: (t) => out.push(JSON.parse(t)), take: () => out.splice(0), last: () => out[out.length - 1] };
}

/** A world: the pure core with a clock, counter-based random bytes, the lanes it allowed and the storage ops it asked for. */
function world(opts = {}) {
  let clock = T0;
  let n = 0;
  const lanes = [];
  const ops = [];
  const random = (len) => {
    const a = new Uint8Array(len);
    for (let i = 0; i < len; i++) a[i] = (++n * 29 + i * 13 + 5) & 255;
    return a;
  };
  const p = createPairing({
    random, now: () => clock, caps: opts.caps,
    allowLane: (hex, exp) => { if (opts.refuseLanes) return false; lanes.push([hex, exp]); return true; },
    persist: (o) => ops.push(...o),
  });
  return { p, lanes, ops, tick: (ms) => { clock += ms; }, now: () => clock };
}
const say = (w, from, msg) => w.p.message(from, Object.assign({ v: 1 }, msg));
const to = (r, c) => (Array.isArray(r) ? r : r.replies).filter(([x]) => x === c).map(([, o]) => o);
const only = (r, c) => { const list = to(r, c); assert.equal(list.length, 1, JSON.stringify(list)); return list[0]; };
const fails = (r, c, why) => { const m = only(r, c); assert.equal(m['failure reason'], why, JSON.stringify(m)); return m; };

test('codes and shapes: normalizeCode, formatCode, isPairAction, isChannel, boxProblem, helloProblem, frameTooLarge', () => {
  assert.equal(CODE_ALPHABET.length, 32);
  assert.equal(/[01lo]/.test(CODE_ALPHABET), false, 'no 0, 1, l or o');
  // a code is 12 characters: a 4-character channel (all the rendezvous sees) and an 8-character secret (40 bits, never sent)
  assert.deepEqual([CHANNEL_LENGTH, SECRET_LENGTH, CODE_LENGTH], [4, 8, 12]);
  assert.equal(normalizeCode('ABCD-2345-6789'), 'abcd23456789');
  assert.equal(normalizeCode('  abcd 2345 6789 '), 'abcd23456789');
  assert.equal(normalizeCode('a b-c d-2 3-4 5-6 7-8 9'), 'abcd23456789');
  assert.equal(normalizeCode('abcd23456789'), 'abcd23456789');
  const dash = String.fromCharCode(0x2013);
  assert.equal(normalizeCode('abcd' + dash + '2345' + dash + '6789'), 'abcd23456789', 'a phone keyboard may type an en dash for the hyphen');
  for (const bad of ['abcd-2345', 'abcd-2345-678', 'abcd-2345-67890', 'abcd-2345-6780', 'abcd-2345-6781', 'abcd-2345-678l', 'abcd-2345-678o', 'abcd2345678', 'abcd2345678923', '', 5, null, undefined, 'x'.repeat(100)]) {
    assert.equal(normalizeCode(bad), null, String(bad));
  }
  assert.equal(formatCode('abcd23456789'), 'abcd-2345-6789');
  assert.equal(formatCode('ABCD-2345-6789'), 'abcd-2345-6789');
  assert.equal(formatCode(' abcd 2345 6789'), 'abcd-2345-6789');
  assert.equal(formatCode('abcd-2345'), null, 'a code of the old length, 8 characters, is not a code');
  assert.equal(formatCode('nope'), null);
  assert.equal(formatCode(null), null);
  assert.equal(normalizeCode(formatCode('abcd23456789')).slice(0, CHANNEL_LENGTH), 'abcd', 'the channel is the first 4 characters');
  assert.equal(isPairAction('pair-open'), true);
  assert.equal(isPairAction('room-knock'), true);
  assert.equal(isPairAction('pair-whatever'), true, 'any pair-* action marks a pair socket');
  for (const other of ['announce', 'scrape', 'pair', 'paired', 'xpair-open', '', null, undefined, 7, {}]) assert.equal(isPairAction(other), false, String(other));
  assert.equal(isChannel('abcd'), true);
  for (const bad of ['abc', 'abcde', 'ABCD', 'abc0', 'abc1', 'abcl', 'abco', 'ab-d', '', null, 12345]) assert.equal(isChannel(bad), false, String(bad));

  assert.equal(boxProblem(BOX), null);
  assert.equal(boxProblem({ iv: 'A'.repeat(16), ct: 'x'.repeat(22) }), null, 'a 16-byte tag is the least a sealed box holds');
  for (const bad of [null, 'box', [], {}, { iv: BOX.iv }, { ct: BOX.ct }, { iv: BOX.iv, ct: BOX.ct, extra: 1 }, { iv: 'A'.repeat(15), ct: BOX.ct }, { iv: 'A'.repeat(17), ct: BOX.ct },
    { iv: BOX.iv, ct: 'x'.repeat(21) }, { iv: BOX.iv, ct: 'x'.repeat(30) + '=' }, { iv: BOX.iv, ct: 'x'.repeat(30) + '+' }, { iv: 7, ct: BOX.ct }, { iv: BOX.iv, ct: ['x'] }]) {
    assert.equal(boxProblem(bad), 'box invalid', JSON.stringify(bad));
  }
  const biggest = 'x'.repeat(MAX_BOX_BYTES - JSON.stringify({ iv: BOX.iv, ct: '' }).length);
  assert.equal(JSON.stringify({ iv: BOX.iv, ct: biggest }).length, MAX_BOX_BYTES);
  assert.equal(boxProblem({ iv: BOX.iv, ct: biggest }), null, 'exactly 2,048 bytes of JSON is allowed');
  assert.equal(boxProblem({ iv: BOX.iv, ct: biggest + 'x' }), 'box invalid', 'one more byte is not');

  const key = 'p256:' + 'K'.repeat(87);
  const hello = { pub: key, ek: key, name: 'Ada', t: T0, n: 'n'.repeat(16), sig: 's'.repeat(86) };
  assert.equal(helloProblem(hello), null);
  assert.equal(helloProblem(Object.assign({}, hello, { name: undefined })), null, 'the name is optional');
  const noName = Object.assign({}, hello);
  delete noName.name;
  assert.equal(helloProblem(noName), null);
  assert.equal(helloProblem(Object.assign({}, hello, { name: 'x'.repeat(33) })), 'name invalid');
  assert.equal(helloProblem(Object.assign({}, hello, { name: 'x'.repeat(32) })), null);
  assert.equal(helloProblem(Object.assign({}, hello, { name: 'a' + String.fromCharCode(7) })), 'name invalid', 'no control characters in a name');
  assert.equal(helloProblem(Object.assign({}, hello, { pub: 'p256:short' })), 'pub invalid');
  assert.equal(helloProblem(Object.assign({}, hello, { ek: 'ed25519:' + 'K'.repeat(43) })), 'ek invalid');
  assert.equal(helloProblem(Object.assign({}, hello, { t: 1.5 })), 't invalid');
  assert.equal(helloProblem(Object.assign({}, hello, { t: '1700' })), 't invalid');
  assert.equal(helloProblem(Object.assign({}, hello, { n: 'short' })), 'n invalid');
  assert.equal(helloProblem(Object.assign({}, hello, { sig: 's'.repeat(85) })), 'sig invalid');
  assert.equal(helloProblem(Object.assign({}, hello, { role: 'owner' })), 'hello has an unknown field');
  assert.equal(helloProblem(null), 'hello invalid');
  assert.equal(helloProblem([]), 'hello invalid');

  assert.equal(frameTooLarge('x'.repeat(MAX_PAIR_BYTES)), false);
  assert.equal(frameTooLarge('x'.repeat(MAX_PAIR_BYTES + 1)), true);
  assert.equal(frameTooLarge(String.fromCharCode(0xe9).repeat(4096)), false, '4,096 two-byte characters are 8,192 bytes');
  assert.equal(frameTooLarge(String.fromCharCode(0xe9).repeat(4097)), true, 'bytes are counted, not characters');
  const smile = String.fromCodePoint(0x1f600);
  assert.equal(frameTooLarge(smile.repeat(2048)), false, 'a surrogate pair is 4 bytes');
  assert.equal(frameTooLarge(smile.repeat(2049)), true);
  assert.equal(frameTooLarge(42), true);
});

test('open: a channel and a box bind the code to the socket; the reply echoes the channel and the rid; one code per socket, opening again replaces it', () => {
  const w = world();
  const a = conn('a');
  const r = say(w, a, { action: 'pair-open', channel: 'abcd', box: BOX, rid: 'r1' });
  assert.deepEqual(to(r, a), [{ action: 'pair-open', channel: 'abcd', rid: 'r1' }]);
  assert.equal(r.changed, true, 'the socket now owns a code: its saved state moved');
  assert.equal(r.problem, null);
  assert.deepEqual(w.ops, [['put', 'chan:abcd', { kind: 'pair', box: BOX, lane: null, exp: T0 + CHANNEL_TTL_MS }]], 'the details go to storage, the rendezvous keeps no other copy of the hello');
  assert.deepEqual(w.p.stats(), { codes: 1, knocks: 0 });
  assert.deepEqual(w.p.attachmentOf(a), { c: [['abcd', 'pair']], q: [] });
  assert.deepEqual(only(say(w, a, { action: 'pair-open', channel: 'abcd', box: BOX }), a), { action: 'pair-open', channel: 'abcd' }, 'no rid asked, none echoed; the same channel again is the same code');

  w.ops.length = 0;
  const again = say(w, a, { action: 'pair-open', channel: 'wxyz', box: boxOf('C'), rid: 'r2' });
  assert.deepEqual(to(again, a), [{ action: 'pair-open', channel: 'wxyz', rid: 'r2' }]);
  assert.deepEqual(w.p.attachmentOf(a), { c: [['wxyz', 'pair']] , q: [] }, 'the first code is released');
  assert.equal(w.p.stats().codes, 1);
  assert.deepEqual(w.ops.map((o) => o.slice(0, 2)), [['put', 'chan:wxyz'], ['delete', 'chan:abcd']]);
  const b = conn('b');
  fails(say(w, b, { action: 'pair-knock', channel: 'abcd', box: BOX }), b, 'unknown code');
});

test('bad shapes and mistakes are answered with a failure reason and change nothing', () => {
  const w = world();
  const a = conn('a');
  const b = conn('b');
  const f = (from, msg, why) => { const r = w.p.message(from, msg); fails(r, from, why); assert.equal(r.problem, why); return r; };
  f(a, { action: 'pair-open', channel: 'abcd', box: BOX }, 'unsupported version');
  f(a, { v: 2, action: 'pair-open', channel: 'abcd', box: BOX }, 'unsupported version');
  f(a, { v: '1', action: 'pair-open', channel: 'abcd', box: BOX }, 'unsupported version');
  const bad = f(a, { v: 1, action: 'pair-open', channel: 'abcd', box: BOX, rid: 'x'.repeat(17) }, 'invalid rid');
  assert.equal(to(bad, a)[0].rid, undefined, 'a bad rid is not echoed');
  f(a, { v: 1, action: 'pair-open', channel: 'abcd', box: BOX, rid: 7 }, 'invalid rid');
  f(a, { v: 1, action: 'pair-open', channel: 'abcd', box: BOX, rid: '' }, 'invalid rid');
  for (const channel of [undefined, null, 'abc', 'abcde', 'ABCD', 'ab0d', 'abc1', 5, ['abcd']]) f(a, { v: 1, action: 'pair-open', channel, box: BOX }, 'invalid channel');
  for (const box of [undefined, null, {}, { iv: 'x', ct: 'y' }, 'box', [BOX], Object.assign({ sdp: 'v=0' }, BOX)]) f(a, { v: 1, action: 'pair-open', channel: 'abcd', box }, 'box invalid');
  f(a, { v: 1, action: 'pair-bogus', rid: 'q' }, 'invalid action');
  f(a, { v: 1, action: 'room-' + 'x'.repeat(200) }, 'invalid action');
  assert.equal(to(w.p.message(a, { v: 1, action: 'room-' + 'x'.repeat(200) }), a)[0].action.length, 64, 'an action is echoed at most 64 characters long');
  f(a, { v: 1, action: 'pair-knock', channel: 'abcd' }, 'box invalid');
  f(a, { v: 1, action: 'pair-knock', channel: 'ab', box: BOX }, 'invalid channel');
  f(a, { v: 1, action: 'pair-accept', knock: 'short' }, 'invalid knock');
  f(a, { v: 1, action: 'pair-accept' }, 'invalid knock');
  f(a, { v: 1, action: 'pair-accept', knock: 'K'.repeat(16) }, 'unknown knock');
  f(a, { v: 1, action: 'pair-reject', knock: 'K'.repeat(16) }, 'unknown knock');
  f(a, { v: 1, action: 'pair-cancel', knock: 'K'.repeat(16) }, 'unknown knock');
  f(a, { v: 1, action: 'pair-close' }, 'unknown code');
  f(a, { v: 1, action: 'pair-close', channel: 'abcd' }, 'unknown code');
  f(a, { v: 1, action: 'pair-close', channel: 'bad' }, 'invalid channel');
  assert.deepEqual(w.p.stats(), { codes: 0, knocks: 0 });
  assert.deepEqual(w.ops, []);
  // a channel taken by another socket, or by the same socket as another kind
  say(w, a, { action: 'pair-open', channel: 'abcd', box: BOX });
  f(b, { v: 1, action: 'pair-open', channel: 'abcd', box: BOX, rid: 'r' }, 'channel taken');
  f(b, { v: 1, action: 'room-open', channel: 'abcd', box: BOX }, 'channel taken');
  f(a, { v: 1, action: 'room-open', channel: 'abcd', box: BOX }, 'channel taken');
  assert.equal(only(say(w, b, { action: 'pair-open', channel: 'efgh', box: BOX }), b).channel, 'efgh', 'the client picks another');
  assert.equal(w.p.stats().codes, 2, 'nothing above changed the codes that exist');
});

test('knock: the requester gets a knock id, the owner a request with the channel and the box and nothing else, no sdp and no address', () => {
  const w = world();
  const a = conn('a');
  const b = conn('b');
  say(w, a, { action: 'pair-open', channel: 'abcd', box: boxOf('O') });
  const theirs = boxOf('Q');
  const r = say(w, b, { action: 'pair-knock', channel: 'abcd', box: theirs, rid: 'k1' });
  const mine = only(r, b);
  assert.deepEqual(Object.keys(mine).sort(), ['action', 'knock', 'rid']);
  assert.equal(mine.action, 'pair-knock');
  assert.match(mine.knock, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(mine.rid, 'k1');
  const req = only(r, a);
  assert.deepEqual(Object.keys(req), ['action', 'knock', 'channel', 'box'], 'the owner is told nothing but the request');
  assert.deepEqual(req, { action: 'pair-request', knock: mine.knock, channel: 'abcd', box: theirs });
  assert.equal(r.replies.length, 2);
  assert.doesNotMatch(JSON.stringify(r.replies), /sdp|candidate|offer|answer|address|"ip"/i);
  assert.equal(req.box === theirs, false, 'the box is a copy with the two fields only');
  assert.equal(r.changed, true, 'the requester holds a pending knock now: its saved state moved');
  assert.deepEqual(w.p.attachmentOf(b), { c: [], q: [[mine.knock, 'abcd', Math.floor(T0 / 1000), 'pair']] });
  assert.deepEqual(w.p.attachmentOf(a), { c: [['abcd', 'pair']], q: [] }, 'the owner keeps no knock in its saved state');
  assert.deepEqual(w.p.stats(), { codes: 1, knocks: 1 });
  assert.deepEqual(w.ops.filter((o) => o[1] !== 'chan:abcd'), [], 'a pending knock is never written to storage');
  const knocks = new Set();
  for (let i = 0; i < 4; i++) knocks.add(only(say(w, conn('x' + i), { action: 'pair-knock', channel: 'abcd', box: theirs }), a).knock);
  assert.equal(knocks.size, 4, 'every knock has its own id');
  // refusals: no such code, a room-knock at a pair code, a knock at your own code
  fails(say(w, b, { action: 'pair-knock', channel: 'zzzz', box: theirs }), b, 'unknown code');
  fails(say(w, b, { action: 'room-knock', channel: 'abcd', box: theirs }), b, 'unknown code');
  fails(say(w, a, { action: 'pair-knock', channel: 'abcd', box: theirs }), a, 'unknown code');
});

test('accept: mints a 40-hex lane, allows it for 24 hours, tells both; the requester gets the channel and the owner box; the knock is gone', () => {
  const w = world();
  const a = conn('a');
  const b = conn('b');
  const ownerBox = boxOf('O');
  say(w, a, { action: 'pair-open', channel: 'abcd', box: ownerBox });
  const knock = only(say(w, b, { action: 'pair-knock', channel: 'abcd', box: boxOf('Q') }), b).knock;
  w.p.takeTouched();
  assert.deepEqual(w.lanes, [], 'no lane exists before the owner approves');
  const r = say(w, a, { action: 'pair-accept', proof: PROOF, knock, rid: 'a1' });
  assert.equal(w.lanes.length, 1);
  const [lane, exp] = w.lanes[0];
  assert.match(lane, /^[0-9a-f]{40}$/);
  assert.equal(exp, T0 + LANE_TTL_MS, 'allowed for 24 hours');
  const owner = only(r, a);
  assert.deepEqual(Object.keys(owner), ['action', 'knock', 'lane', 'rid']);
  assert.deepEqual(owner, { action: 'pair-accepted', knock, lane, rid: 'a1' });
  const req = only(r, b);
  assert.deepEqual(Object.keys(req), ['action', 'knock', 'lane', 'channel', 'box', 'proof']);
  assert.deepEqual(req, { action: 'pair-accepted', knock, lane, channel: 'abcd', box: ownerBox, proof: PROOF }, 'the owner\'s proof is passed on unchanged');
  assert.equal(r.changed, false, 'the owner keeps nothing about the knock');
  assert.deepEqual(w.p.takeTouched(), [b], 'the requester no longer holds the knock: its saved state moved');
  assert.deepEqual(w.p.attachmentOf(b), { c: [], q: [] });
  assert.deepEqual(w.p.stats(), { codes: 1, knocks: 0 }, 'the code stays open for the next person; the knock is gone');
  fails(say(w, a, { action: 'pair-accept', proof: PROOF, knock }), a, 'unknown knock');
  // a second person gets a lane of their own; someone else cannot answer a knock they do not own
  const c = conn('c');
  const k2 = only(say(w, c, { action: 'pair-knock', channel: 'abcd', box: boxOf('R') }), c).knock;
  fails(say(w, b, { action: 'pair-accept', proof: PROOF, knock: k2 }), b, 'unknown knock');
  fails(say(w, c, { action: 'pair-accept', proof: PROOF, knock: k2 }), c, 'unknown knock');
  say(w, a, { action: 'pair-accept', proof: PROOF, knock: k2 });
  assert.equal(w.lanes.length, 2);
  assert.notEqual(w.lanes[0][0], w.lanes[1][0]);
});

test('accept: the owner\'s proof must be there and have the shape of a signature; a refused accept leaves the knock and mints no lane (ADV-7)', () => {
  const w = world();
  const a = conn('a');
  const b = conn('b');
  say(w, a, { action: 'pair-open', channel: 'abcd', box: boxOf('O') });
  const knock = only(say(w, b, { action: 'pair-knock', channel: 'abcd', box: boxOf('Q') }), b).knock;
  for (const proof of [undefined, null, '', 5, {}, 'P'.repeat(85), 'P'.repeat(87), 'P'.repeat(85) + '+', 'P'.repeat(85) + ' ']) {
    fails(say(w, a, { action: 'pair-accept', knock, proof, rid: 'a1' }), a, 'proof invalid');
  }
  assert.deepEqual(w.lanes, [], 'no lane was minted');
  assert.deepEqual(w.p.stats(), { codes: 1, knocks: 1 }, 'the knock is still there');
  assert.deepEqual(to(say(w, a, { action: 'pair-accept', knock: 'K'.repeat(16) }), a), [{ action: 'pair-accept', 'failure reason': 'unknown knock' }], 'an unknown knock is named first');
  const ok = say(w, a, { action: 'pair-accept', knock, proof: PROOF });
  assert.equal(only(ok, b).proof, PROOF);
  assert.equal(w.lanes.length, 1);
  // a room: the same
  const r = conn('r');
  const m = conn('m');
  say(w, r, { action: 'room-open', channel: 'rm22', box: boxOf('R') });
  const rk = only(say(w, m, { action: 'room-knock', channel: 'rm22', box: boxOf('S') }), m).knock;
  fails(say(w, r, { action: 'room-accept', knock: rk }), r, 'proof invalid');
  assert.equal(only(say(w, r, { action: 'room-accept', knock: rk, proof: PROOF }), m).proof, PROOF);
});

test('reject, cancel and close', () => {
  const w = world();
  const a = conn('a');
  const b = conn('b');
  const c = conn('c');
  say(w, a, { action: 'pair-open', channel: 'abcd', box: BOX });
  const k1 = only(say(w, b, { action: 'pair-knock', channel: 'abcd', box: BOX }), b).knock;
  const r = say(w, a, { action: 'pair-reject', knock: k1, rid: 'x1' });
  assert.deepEqual(to(r, b), [{ action: 'pair-rejected', knock: k1, reason: 'rejected' }]);
  assert.deepEqual(to(r, a), [{ action: 'pair-reject', knock: k1, rid: 'x1' }]);
  assert.deepEqual(w.lanes, [], 'a rejection mints no lane');
  fails(say(w, a, { action: 'pair-reject', knock: k1 }), a, 'unknown knock');
  fails(say(w, a, { action: 'pair-accept', proof: PROOF, knock: k1 }), a, 'unknown knock');

  const k2 = only(say(w, b, { action: 'pair-knock', channel: 'abcd', box: BOX }), b).knock;
  fails(say(w, a, { action: 'pair-cancel', knock: k2 }), a, 'unknown knock');
  fails(say(w, c, { action: 'pair-cancel', knock: k2 }), c, 'unknown knock');
  const cancelled = say(w, b, { action: 'pair-cancel', knock: k2 });
  assert.deepEqual(to(cancelled, a), [{ action: 'pair-cancelled', knock: k2 }]);
  assert.deepEqual(to(cancelled, b), [], 'no rid asked: no direct reply');
  assert.deepEqual(w.p.attachmentOf(b), { c: [], q: [] });
  const k3 = only(say(w, b, { action: 'pair-knock', channel: 'abcd', box: BOX }), b).knock;
  assert.deepEqual(to(say(w, b, { action: 'pair-cancel', knock: k3, rid: 'c1' }), b), [{ action: 'pair-cancel', knock: k3, rid: 'c1' }], 'a rid asks for an acknowledgement');

  // close: pending knocks are told, the code is gone
  const k4 = only(say(w, b, { action: 'pair-knock', channel: 'abcd', box: BOX }), b).knock;
  const k5 = only(say(w, c, { action: 'pair-knock', channel: 'abcd', box: BOX }), c).knock;
  w.ops.length = 0;
  const closed = say(w, a, { action: 'pair-close', rid: 'z' });
  assert.deepEqual(to(closed, a), [{ action: 'pair-close', channel: 'abcd', rid: 'z' }]);
  assert.deepEqual(to(closed, b), [{ action: 'pair-rejected', knock: k4, reason: 'closed' }]);
  assert.deepEqual(to(closed, c), [{ action: 'pair-rejected', knock: k5, reason: 'closed' }]);
  assert.deepEqual(w.ops, [['delete', 'chan:abcd']]);
  assert.deepEqual(w.p.stats(), { codes: 0, knocks: 0 });
  assert.deepEqual(w.p.attachmentOf(a), { c: [], q: [] });
  fails(say(w, b, { action: 'pair-knock', channel: 'abcd', box: BOX }), b, 'unknown code');
  fails(say(w, a, { action: 'pair-close' }), a, 'unknown code');
  // close without a rid answers nobody but the pending knocks
  say(w, a, { action: 'pair-open', channel: 'abcd', box: BOX });
  assert.deepEqual(say(w, a, { action: 'pair-close' }).replies, []);
  // someone else cannot close a code
  say(w, a, { action: 'pair-open', channel: 'abcd', box: BOX });
  fails(say(w, b, { action: 'pair-close', channel: 'abcd' }), b, 'unknown code');
  assert.equal(w.p.stats().codes, 1);
});

test('rooms: the lane is minted and allowed at open; members knock, the owner accepts, and every member gets the same lane', () => {
  const w = world();
  const a = conn('a');
  const b = conn('b');
  const c = conn('c');
  const ownerBox = boxOf('O');
  const opened = only(say(w, a, { action: 'room-open', channel: 'rm22', box: ownerBox, rid: 'o1' }), a);
  assert.deepEqual(Object.keys(opened), ['action', 'channel', 'lane', 'rid']);
  assert.equal(opened.action, 'room-open');
  assert.match(opened.lane, /^[0-9a-f]{40}$/);
  assert.deepEqual(w.lanes, [[opened.lane, T0 + LANE_TTL_MS]], 'allowed at open');
  assert.deepEqual(w.ops, [['put', 'chan:rm22', { kind: 'room', box: ownerBox, lane: opened.lane, exp: T0 + LANE_TTL_MS }]]);
  assert.deepEqual(only(say(w, a, { action: 'room-open', channel: 'rm22', box: ownerBox }), a).lane, opened.lane, 'opening the same room again is the same room and the same lane');
  assert.equal(w.lanes.length, 1);

  fails(say(w, b, { action: 'pair-knock', channel: 'rm22', box: BOX }), b, 'unknown code');
  const kb = say(w, b, { action: 'room-knock', channel: 'rm22', box: boxOf('Q'), rid: 'k' });
  const knock = only(kb, b);
  assert.equal(knock.action, 'room-knock');
  assert.deepEqual(only(kb, a), { action: 'room-request', knock: knock.knock, channel: 'rm22', box: boxOf('Q') });
  const kc = only(say(w, c, { action: 'room-knock', channel: 'rm22', box: boxOf('R') }), c);
  fails(say(w, a, { action: 'pair-accept', proof: PROOF, knock: knock.knock }), a, 'unknown knock');
  const acc = say(w, a, { action: 'room-accept', proof: PROOF, knock: knock.knock, rid: 'a' });
  assert.deepEqual(only(acc, a), { action: 'room-accepted', knock: knock.knock, rid: 'a' }, 'the owner already holds the lane');
  assert.deepEqual(only(acc, b), { action: 'room-accepted', knock: knock.knock, lane: opened.lane, channel: 'rm22', box: ownerBox, proof: PROOF });
  assert.equal(w.lanes.length, 1, 'accepting a member mints no new lane');
  const rej = say(w, a, { action: 'room-reject', knock: kc.knock });
  assert.deepEqual(only(rej, c), { action: 'room-rejected', knock: kc.knock, reason: 'rejected' });
  assert.deepEqual(only(rej, a), { action: 'room-reject', knock: kc.knock });
  const kd = only(say(w, c, { action: 'room-knock', channel: 'rm22', box: BOX }), c).knock;
  assert.deepEqual(to(say(w, c, { action: 'room-cancel', knock: kd }), a), [{ action: 'room-cancelled', knock: kd }]);

  // at most 4 rooms per socket; room-close names the room when there are several
  for (const ch of ['rm33', 'rm44', 'rm55']) say(w, a, { action: 'room-open', channel: ch, box: BOX });
  fails(say(w, a, { action: 'room-open', channel: 'rm66', box: BOX }), a, 'too many codes');
  assert.equal(w.p.stats().codes, 4);
  fails(say(w, a, { action: 'room-close' }), a, 'invalid channel');
  const ke = only(say(w, b, { action: 'room-knock', channel: 'rm33', box: BOX }), b).knock;
  const closed = say(w, a, { action: 'room-close', channel: 'rm33', rid: 'c' });
  assert.deepEqual(only(closed, a), { action: 'room-close', channel: 'rm33', rid: 'c' });
  assert.deepEqual(only(closed, b), { action: 'room-rejected', knock: ke, reason: 'closed' });
  assert.equal(w.lanes.length, 4, 'the lane of a closed room stays allowed until it expires');
  assert.equal(only(say(w, a, { action: 'room-open', channel: 'rm66', box: BOX }), a).channel, 'rm66', 'a room closed makes room for another');
  // a pair code and rooms live side by side on one socket
  say(w, a, { action: 'pair-open', channel: 'pr22', box: BOX });
  assert.equal(w.p.attachmentOf(a).c.length, 5);
  fails(say(w, a, { action: 'pair-close', channel: 'rm44' }), a, 'unknown code');
});

test('caps: 16 pending per code, 8 pending per requester, 10 knocks and 10 opens a minute, the number of codes and of lanes', () => {
  const w = world();
  const a = conn('a');
  say(w, a, { action: 'pair-open', channel: 'abcd', box: BOX });
  const people = Array.from({ length: 17 }, (_, i) => conn('p' + i));
  for (let i = 0; i < 16; i++) assert.equal(only(say(w, people[i], { action: 'pair-knock', channel: 'abcd', box: BOX }), people[i]).action, 'pair-knock');
  fails(say(w, people[16], { action: 'pair-knock', channel: 'abcd', box: BOX }), people[16], 'too many requests');
  assert.equal(w.p.stats().knocks, 16);

  // a requester holds at most 8 pending knocks (they ride in its saved state, which stays small)
  const w2 = world();
  const r = conn('r');
  const owners = Array.from({ length: 9 }, (_, i) => conn('o' + i));
  const chans = ['aaa2', 'aaa3', 'aaa4', 'aaa5', 'aaa6', 'aaa7', 'aaa8', 'aaa9', 'bbb2'];
  owners.forEach((o, i) => say(w2, o, { action: 'pair-open', channel: chans[i], box: BOX }));
  for (let i = 0; i < 8; i++) assert.equal(only(say(w2, r, { action: 'pair-knock', channel: chans[i], box: BOX }), r).action, 'pair-knock');
  fails(say(w2, r, { action: 'pair-knock', channel: chans[8], box: BOX }), r, 'too many requests');
  assert.ok(JSON.stringify(w2.p.attachmentOf(r)).length < 700, 'eight pending knocks are a few hundred bytes: ' + JSON.stringify(w2.p.attachmentOf(r)).length);

  // 10 knocks a minute from one socket, counted whether or not they found a code; the window slides
  const w3 = world();
  const k = conn('k');
  for (let i = 0; i < 10; i++) fails(say(w3, k, { action: 'pair-knock', channel: 'zzzz', box: BOX }), k, 'unknown code');
  fails(say(w3, k, { action: 'pair-knock', channel: 'zzzz', box: BOX }), k, 'too many requests');
  w3.tick(59 * 1000);
  fails(say(w3, k, { action: 'pair-knock', channel: 'zzzz', box: BOX }), k, 'too many requests');
  w3.tick(1100);
  fails(say(w3, k, { action: 'pair-knock', channel: 'zzzz', box: BOX }), k, 'unknown code');

  // 10 opens a minute from one socket
  const w4 = world();
  const o = conn('o');
  for (let i = 0; i < 10; i++) assert.equal(only(say(w4, o, { action: 'pair-open', channel: 'ch' + (2 + (i % 8)) + '2', box: BOX }), o).action, 'pair-open');
  fails(say(w4, o, { action: 'pair-open', channel: 'ch92', box: BOX }), o, 'too many codes');
  w4.tick(61 * 1000);
  assert.equal(only(say(w4, o, { action: 'pair-open', channel: 'ch92', box: BOX }), o).action, 'pair-open', 'the window slides');

  // the number of codes in all
  const w6 = world({ caps: { maxChannels: 3 } });
  const crowd = ['xx22', 'xx23', 'xx24', 'xx25'].map((ch, i) => { const c = conn('c' + i); return [c, say(w6, c, { action: 'pair-open', channel: ch, box: BOX })]; });
  assert.deepEqual(crowd.map(([c, res]) => to(res, c)[0]['failure reason'] || 'ok'), ['ok', 'ok', 'ok', 'too many codes'], 'the cap on codes in all holds');
  assert.equal(w6.p.stats().codes, 3);
  assert.equal(only(say(w6, crowd[0][0], { action: 'pair-open', channel: 'xx26', box: BOX }), crowd[0][0]).channel, 'xx26', 'a socket that replaces its own code does not need another slot');
  say(w6, crowd[1][0], { action: 'pair-close' });
  assert.equal(only(say(w6, crowd[3][0], { action: 'pair-open', channel: 'xx25', box: BOX }), crowd[3][0]).channel, 'xx25', 'a closed code makes room');
  assert.equal(DEFAULT_CAPS.maxChannels, 4096);

  // a host that cannot allow another lane: the knock stays, the owner may try again; a room is not opened
  const w5 = world({ refuseLanes: true });
  const a5 = conn('a');
  const b5 = conn('b');
  say(w5, a5, { action: 'pair-open', channel: 'abcd', box: BOX });
  const knock = only(say(w5, b5, { action: 'pair-knock', channel: 'abcd', box: BOX }), b5).knock;
  fails(say(w5, a5, { action: 'pair-accept', proof: PROOF, knock }), a5, 'too many lanes');
  assert.equal(w5.p.stats().knocks, 1, 'the knock is still pending');
  fails(say(w5, a5, { action: 'room-open', channel: 'rm22', box: BOX }), a5, 'too many lanes');
  assert.equal(w5.p.stats().codes, 1, 'no room was opened');
  assert.deepEqual(to(w5.p.message(b5, { v: 1, action: 'pair-cancel', knock }), a5), [{ action: 'pair-cancelled', knock }]);
});

test('expiry: a knock pends for 10 minutes, a code for 24 hours; the sweep answers both and lazily so does an accept', () => {
  const w = world();
  const a = conn('a');
  const b = conn('b');
  say(w, a, { action: 'pair-open', channel: 'abcd', box: BOX });
  const k1 = only(say(w, b, { action: 'pair-knock', channel: 'abcd', box: BOX }), b).knock;
  assert.equal(w.p.nextExpiry(), T0 + KNOCK_TTL_MS, 'the next thing to run out is the knock');
  w.tick(KNOCK_TTL_MS - 1);
  assert.deepEqual(w.p.sweep(w.now()), [], 'not yet');
  w.tick(1);
  const swept = w.p.sweep(w.now());
  assert.deepEqual(to(swept, b), [{ action: 'pair-rejected', knock: k1, reason: 'expired' }]);
  assert.deepEqual(to(swept, a), [{ action: 'pair-cancelled', knock: k1 }], 'the owner is told to drop it from the list');
  assert.deepEqual(w.p.stats(), { codes: 1, knocks: 0 });
  assert.deepEqual(w.p.attachmentOf(b), { c: [], q: [] });

  // without a sweep: accepting a knock that ran out fails and tells the requester
  const k2 = only(say(w, b, { action: 'pair-knock', channel: 'abcd', box: BOX }), b).knock;
  w.tick(KNOCK_TTL_MS);
  const late = say(w, a, { action: 'pair-accept', proof: PROOF, knock: k2 });
  assert.deepEqual(to(late, a), [{ action: 'pair-cancelled', knock: k2 }, { action: 'pair-accept', 'failure reason': 'unknown knock' }], 'the owner drops the request from its list and is told the accept failed');
  assert.deepEqual(to(late, b), [{ action: 'pair-rejected', knock: k2, reason: 'expired' }]);
  assert.deepEqual(w.lanes, [], 'no lane for an expired knock');

  // a code runs out: the owner is told, pending knocks are answered, the row goes
  const k3 = only(say(w, b, { action: 'pair-knock', channel: 'abcd', box: BOX }), b).knock;
  w.ops.length = 0;
  w.tick(CHANNEL_TTL_MS);
  const gone = w.p.sweep(w.now());
  assert.deepEqual(to(gone, a), [{ action: 'pair-close', channel: 'abcd', reason: 'expired' }]);
  assert.deepEqual(to(gone, b), [{ action: 'pair-rejected', knock: k3, reason: 'expired' }]);
  assert.deepEqual(w.ops, [['delete', 'chan:abcd']]);
  assert.deepEqual(w.p.stats(), { codes: 0, knocks: 0 });
  assert.equal(w.p.nextExpiry(), Infinity);
  fails(say(w, b, { action: 'pair-knock', channel: 'abcd', box: BOX }), b, 'unknown code');

  // a code that ran out but was not swept yet is already unknown to a knock, and an accept hands out no lane (the knocks are young)
  say(w, a, { action: 'pair-open', channel: 'wxyz', box: BOX });
  say(w, a, { action: 'room-open', channel: 'rm22', box: BOX });
  w.tick(CHANNEL_TTL_MS - 5 * MIN);
  const pending = only(say(w, b, { action: 'pair-knock', channel: 'wxyz', box: BOX }), b).knock;
  const roomKnock = only(say(w, b, { action: 'room-knock', channel: 'rm22', box: BOX }), b).knock;
  const lanesBefore = w.lanes.length;
  w.tick(6 * MIN);
  fails(say(w, b, { action: 'pair-knock', channel: 'wxyz', box: BOX }), b, 'unknown code');
  fails(say(w, a, { action: 'pair-accept', proof: PROOF, knock: pending }), a, 'unknown knock');
  fails(say(w, a, { action: 'room-accept', proof: PROOF, knock: roomKnock }), a, 'unknown knock');
  fails(say(w, a, { action: 'room-reject', knock: roomKnock }), a, 'unknown knock');
  assert.equal(w.lanes.length, lanesBefore, 'no lane was minted or handed out for a code that ran out');
  const closing = w.p.sweep(w.now());
  assert.deepEqual(to(closing, b).map((m) => m.reason).sort(), ['expired', 'expired'], 'the sweep tells the requesters');
  assert.deepEqual(w.p.stats(), { codes: 0, knocks: 0 });
  // a room keeps the expiry of its lane; opening it again does not stretch it past the lane
  const rm = say(w, a, { action: 'room-open', channel: 'rm22', box: BOX });
  w.tick(HOUR);
  say(w, a, { action: 'room-open', channel: 'rm22', box: BOX });
  assert.equal(w.p.nextExpiry() <= w.lanes[w.lanes.length - 1][1], true);
  assert.equal(only(rm, a).action, 'room-open');
});

test('a socket that closes releases its codes (pending knocks get gone) and cancels its own knocks', () => {
  const w = world();
  const a = conn('a');
  const b = conn('b');
  const c = conn('c');
  say(w, a, { action: 'pair-open', channel: 'abcd', box: BOX });
  say(w, a, { action: 'room-open', channel: 'rm22', box: BOX });
  const kb = only(say(w, b, { action: 'pair-knock', channel: 'abcd', box: BOX }), b).knock;
  const kc = only(say(w, c, { action: 'room-knock', channel: 'rm22', box: BOX }), c).knock;
  const ka = only(say(w, a, { action: 'pair-knock', channel: 'efgh', box: BOX }), a);
  assert.equal(ka['failure reason'], 'unknown code');
  w.ops.length = 0;
  const closed = w.p.close(a);
  assert.deepEqual(to(closed, b), [{ action: 'pair-rejected', knock: kb, reason: 'gone' }]);
  assert.deepEqual(to(closed, c), [{ action: 'room-rejected', knock: kc, reason: 'gone' }]);
  assert.deepEqual(w.ops.map((o) => o.join(' ')).sort(), ['delete chan:abcd', 'delete chan:rm22']);
  assert.deepEqual(w.p.stats(), { codes: 0, knocks: 0 });
  assert.deepEqual(w.p.takeTouched().sort((x, y) => x.name.localeCompare(y.name)), [b, c], 'their saved states moved; the closed socket is not listed');

  // the requester goes: the owner is told to drop the request
  const d = conn('d');
  const e = conn('e');
  say(w, d, { action: 'pair-open', channel: 'dd22', box: BOX });
  const ke = only(say(w, e, { action: 'pair-knock', channel: 'dd22', box: BOX }), e).knock;
  assert.deepEqual(to(w.p.close(e), d), [{ action: 'pair-cancelled', knock: ke }]);
  assert.deepEqual(w.p.stats(), { codes: 1, knocks: 0 });
  assert.deepEqual(w.p.close(conn('nobody')), [], 'closing a socket the core never saw is harmless');
});

test('a wake: the codes come back from storage rows and the sockets attachments; pending knocks ride on the requester; what lost its owner is answered', () => {
  const w = world();
  const a = conn('a');
  const b = conn('b');
  const c = conn('c');
  say(w, a, { action: 'pair-open', channel: 'abcd', box: boxOf('O') });
  say(w, a, { action: 'room-open', channel: 'rm22', box: boxOf('P') });
  const k1 = only(say(w, b, { action: 'pair-knock', channel: 'abcd', box: boxOf('Q') }), b).knock;
  const k2 = only(say(w, c, { action: 'room-knock', channel: 'rm22', box: boxOf('R') }), c).knock;
  // what the platform keeps: the rows of the codes (the last put per key) and one attachment per socket
  const rows = new Map();
  for (const [kind, key, value] of w.ops) { if (kind === 'put') rows.set(key, JSON.parse(JSON.stringify(value))); else rows.delete(key); }
  const saved = new Map([a, b, c].map((x) => [x.name, JSON.parse(JSON.stringify(w.p.attachmentOf(x)))]));
  assert.deepEqual(Array.from(rows.keys()).sort(), ['chan:abcd', 'chan:rm22']);

  const wake = (sockets) => {
    const w2 = world();
    w2.tick(5 * MIN);
    w2.p.load(Array.from(rows, ([key, d]) => [key.slice('chan:'.length), d]));
    const back = new Map(sockets.map((s) => [s.name, conn(s.name)]));
    for (const s of sockets) w2.p.attach(back.get(s.name), saved.get(s.name));
    return { w2, back, replies: w2.p.sweep(w2.now()) };
  };

  const full = wake([a, b, c]);
  assert.deepEqual(full.replies, [], 'everything is back: nothing to answer');
  assert.deepEqual(full.w2.p.stats(), { codes: 2, knocks: 2 });
  const [a2, b2, c2] = ['a', 'b', 'c'].map((n) => full.back.get(n));
  assert.deepEqual(full.w2.p.attachmentOf(a2), { c: [['abcd', 'pair'], ['rm22', 'room']], q: [] });
  assert.deepEqual(full.w2.p.attachmentOf(b2).q.map((q) => q[0]), [k1]);
  assert.equal(full.w2.p.ownsLive(a2), true);
  assert.equal(full.w2.p.ownsLive(b2), false);
  const acc = say(full.w2, a2, { action: 'pair-accept', proof: PROOF, knock: k1 });
  assert.equal(only(acc, a2).knock, k1, 'the owner accepts a knock made before the wake');
  assert.deepEqual(only(acc, b2).box, boxOf('O'), 'the owner box comes from the stored row');
  assert.equal(full.w2.lanes.length, 1);
  const racc = say(full.w2, a2, { action: 'room-accept', proof: PROOF, knock: k2 });
  assert.equal(only(racc, c2).lane, JSON.parse(JSON.stringify(rows.get('chan:rm22'))).lane, 'the room lane comes from the stored row');

  // the owner socket is gone while the object slept: its rows are orphans, the requesters are told
  const orphan = wake([b, c]);
  assert.deepEqual(to(orphan.replies, orphan.back.get('b')), [{ action: 'pair-rejected', knock: k1, reason: 'gone' }]);
  assert.deepEqual(to(orphan.replies, orphan.back.get('c')), [{ action: 'room-rejected', knock: k2, reason: 'gone' }]);
  assert.deepEqual(orphan.w2.p.stats(), { codes: 0, knocks: 0 });
  assert.deepEqual(orphan.w2.ops.map((o) => o.join(' ')).sort(), ['delete chan:abcd', 'delete chan:rm22']);

  // a requester socket that is gone: its knock is simply not restored
  const solo = wake([a]);
  assert.deepEqual(solo.replies, []);
  assert.deepEqual(solo.w2.p.stats(), { codes: 2, knocks: 0 });

  // knocks that ran out while the object slept are answered when the socket is attached; unreadable rows and entries are dropped
  const late = world();
  late.tick(KNOCK_TTL_MS + 1000);
  late.p.load([['abcd', rows.get('chan:abcd')], ['bad!', { kind: 'pair' }], ['wxyz', { kind: 'nope' }], ['efgh', { kind: 'room', box: BOX, lane: 'zz', exp: 1 }]]);
  assert.deepEqual(late.ops.map((o) => o.join(' ')).sort(), ['delete chan:bad!', 'delete chan:efgh', 'delete chan:wxyz'], 'a row that is not a code is deleted, whatever its key');
  const b3 = conn('b');
  assert.deepEqual(late.p.attach(b3, saved.get('b')), [[b3, { action: 'pair-rejected', knock: k1, reason: 'expired' }]]);
  assert.deepEqual(late.p.attach(conn('junk'), { c: 'nope', q: [['bad'], 5, null, [k1, 'ab', 1, 'pair']] }), []);
  assert.deepEqual(late.p.attach(conn('none'), null), []);
  assert.deepEqual(late.p.stats(), { codes: 1, knocks: 0 });
});

test('the saved state of a socket stays far under the 2 KB limit even at the caps', () => {
  const w = world();
  const a = conn('a');
  const r = conn('r');
  say(w, a, { action: 'pair-open', channel: 'pr22', box: BOX });
  for (let i = 0; i < 4; i++) say(w, a, { action: 'room-open', channel: 'rm' + (2 + i) + '2', box: BOX });
  const owners = Array.from({ length: 8 }, (_, i) => conn('o' + i));
  owners.forEach((o, i) => say(w, o, { action: 'pair-open', channel: 'pp' + (2 + i) + '2', box: BOX }));
  owners.forEach((o, i) => say(w, r, { action: 'pair-knock', channel: 'pp' + (2 + i) + '2', box: BOX }));
  assert.equal(w.p.attachmentOf(a).c.length, 5);
  assert.equal(w.p.attachmentOf(r).q.length, 8);
  assert.ok(JSON.stringify({ k: 'pair', t: 1700000000, ...w.p.attachmentOf(a) }).length < 300);
  assert.ok(JSON.stringify({ k: 'pair', t: 1700000000, ...w.p.attachmentOf(r) }).length < 700);
});

// ---------------------------------------------------------------------------------------------- inside rtc.js

function rendezvous(opts = {}) {
  let clock = T0;
  let n = 0;
  const ops = [];
  const random = (len) => {
    const a = new Uint8Array(len);
    for (let i = 0; i < len; i++) a[i] = (++n * 29 + i * 13 + 5) & 255;
    return a;
  };
  const r = createRendezvous(Object.assign({ allow: new Set([A_HASH]), now: () => clock, random, persist: (o) => ops.push(...o) }, opts));
  return { r, ops, tick: (ms) => { clock += ms; }, now: () => clock };
}
const frame = (msg) => JSON.stringify(Object.assign({ v: 1 }, msg));
const announce = (hex, id, extra = {}) => JSON.stringify(Object.assign({ action: 'announce', info_hash: bin(hex), peer_id: id, uploaded: 0, downloaded: 0, left: 0, event: 'started', numwant: 0, offers: [] }, extra));

test('rtc.js: a pair-* or room-* frame is dispatched to the pairing before the announce and scrape branch', () => {
  const { r } = rendezvous();
  const a = conn('a');
  const res = r.message(a, frame({ action: 'pair-open', channel: 'abcd', box: BOX, rid: 'r1' }));
  assert.equal(res.problem, null);
  assert.equal(res.changed, true);
  assert.equal(res.pair, true);
  assert.deepEqual(res.touched, []);
  assert.deepEqual(a.take(), [{ action: 'pair-open', channel: 'abcd', rid: 'r1' }]);
  // without the pairing the same frame would have been 'invalid action in WS request: pair-open'
  const b = conn('b');
  r.message(b, frame({ action: 'pair-knock', channel: 'abcd', box: boxOf('Q') }));
  const knock = b.take()[0].knock;
  const accepted = r.message(a, frame({ action: 'pair-accept', proof: PROOF, knock }));
  assert.equal(accepted.pair, true);
  assert.deepEqual(accepted.touched, [b], 'the requester holds no knock any more: the host rewrites its attachment');
  assert.equal(accepted.changed, false);
  assert.equal(a.last().action, 'pair-accepted');
  assert.equal(b.last().action, 'pair-accepted');
  // a frame that is not JSON, or has no action, is what it always was
  assert.deepEqual(r.message(conn('c'), 'not json'), { changed: false, problem: 'invalid message: not JSON' });
  const d = conn('d');
  assert.equal(r.message(d, JSON.stringify({ action: 'connect' })).problem, 'invalid action in WS request: connect');
  assert.equal(r.message(d, JSON.stringify({ v: 1 })).problem, 'invalid action in WS request: undefined');
});

test('rtc.js: the first message classifies a socket; a tracker socket cannot knock and a pair socket cannot announce or scrape', () => {
  const { r } = rendezvous();
  const t = conn('t');
  r.message(t, announce(A_HASH, peer('t')));
  t.take();
  const refused = r.message(t, frame({ action: 'pair-knock', channel: 'abcd', box: BOX, rid: 'k' }));
  assert.equal(refused.problem, MIXED);
  assert.equal(refused.changed, false);
  assert.deepEqual(t.take(), [{ action: 'pair-knock', rid: 'k', 'failure reason': MIXED }]);
  assert.equal(r.message(t, frame({ action: 'room-open', channel: 'abcd', box: BOX })).problem, MIXED);
  assert.equal(r.stats().codes, 0, 'nothing was opened');
  assert.equal(r.stats().peers, 1, 'the tracker socket is untouched');
  r.message(t, announce(A_HASH, peer('t'), { event: 'update' }));
  assert.equal(t.last().action, 'announce');
  assert.equal(t.last()['failure reason'], undefined, 'it still announces');

  const p = conn('p');
  r.message(p, frame({ action: 'pair-open', channel: 'abcd', box: BOX }));
  p.take();
  const a = r.message(p, announce(A_HASH, peer('p')));
  assert.equal(a.problem, MIXED);
  assert.deepEqual(p.take(), [{ action: 'announce', 'failure reason': MIXED }]);
  assert.equal(r.message(p, JSON.stringify({ action: 'scrape', info_hash: bin(A_HASH) })).problem, MIXED);
  assert.deepEqual(p.take(), [{ action: 'scrape', 'failure reason': MIXED }]);
  assert.equal(r.stats().peers, 1, 'the pair socket joined no swarm');
  assert.equal(r.stats().swarms, 1);

  // a scrape classifies a socket as a tracker socket as well; a frame that fails to parse classifies nothing
  const s = conn('s');
  r.message(s, JSON.stringify({ action: 'scrape' }));
  assert.equal(r.message(s, frame({ action: 'pair-open', channel: 'wxyz', box: BOX })).problem, MIXED);
  const u = conn('u');
  r.message(u, '{nope');
  assert.equal(r.message(u, frame({ action: 'pair-open', channel: 'wxyz', box: BOX })).problem, null);
  assert.equal(r.message(u, announce(A_HASH, peer('u'))).problem, MIXED);
});

test('rtc.js: a pair frame is at most 8,192 bytes; a pair socket sends small frames, so a big one is refused unparsed', () => {
  const { r } = rendezvous();
  const fresh = conn('fresh');
  const big = JSON.stringify({ v: 1, action: 'pair-open', channel: 'abcd', box: BOX, rid: 'r', pad: 'x'.repeat(MAX_PAIR_BYTES) });
  const res = r.message(fresh, big);
  assert.equal(res.problem, 'message too large');
  assert.deepEqual(fresh.take(), [{ action: 'pair-open', rid: 'r', 'failure reason': 'message too large' }]);
  assert.equal(r.stats().codes, 0);
  const wide = JSON.stringify({ v: 1, action: 'pair-open', channel: 'abcd', box: BOX, pad: String.fromCharCode(0xe9).repeat(4100) });
  assert.ok(wide.length < MAX_PAIR_BYTES && Buffer.byteLength(wide) > MAX_PAIR_BYTES);
  assert.equal(r.message(conn('w'), wide).problem, 'message too large', 'bytes count, not characters');

  const p = conn('p');
  r.message(p, frame({ action: 'pair-open', channel: 'abcd', box: BOX }));
  p.take();
  const again = r.message(p, big);
  assert.equal(again.problem, 'message too large');
  assert.deepEqual(p.take(), [{ 'failure reason': 'message too large' }], 'a classified pair socket gets the refusal before any parsing');
  assert.equal(r.stats().codes, 1, 'its code is still open');
  // a tracker socket keeps the old limit: the Worker closes a frame over 128 KiB, rtc.js parses what it is given
  const t = conn('t');
  assert.equal(r.message(t, announce(A_HASH, peer('t'), { pad: 'x'.repeat(20000) })).problem, null);
});

test('rtc.js: the saved state of a pair socket is { k, c, q, t }; a wake restores it, and an idle sweep waits for a code to run out', () => {
  const h = rendezvous();
  const { r } = h;
  const a = conn('a');
  const b = conn('b');
  r.message(a, frame({ action: 'pair-open', channel: 'abcd', box: boxOf('O') }));
  r.message(b, frame({ action: 'pair-knock', channel: 'abcd', box: boxOf('Q') }));
  const knock = b.take()[0].knock;
  const savedA = JSON.parse(JSON.stringify(r.attachmentOf(a)));
  const savedB = JSON.parse(JSON.stringify(r.attachmentOf(b)));
  assert.deepEqual(savedA, { k: 'pair', c: [['abcd', 'pair']], q: [], t: Math.floor(T0 / 1000) });
  assert.deepEqual(savedB, { k: 'pair', c: [], q: [[knock, 'abcd', Math.floor(T0 / 1000), 'pair']], t: Math.floor(T0 / 1000) });
  assert.ok(JSON.stringify(savedA).length < 2048 && JSON.stringify(savedB).length < 2048);

  const rows = new Map();
  for (const [kind, key, value] of h.ops) { if (kind === 'put') rows.set(key, JSON.parse(JSON.stringify(value))); else rows.delete(key); }
  const h2 = rendezvous();
  h2.tick(3 * MIN);
  h2.r.restore({ chans: rows, lanes: new Map() });
  const a2 = conn('a2');
  const b2 = conn('b2');
  h2.r.attach(a2, savedA);
  h2.r.attach(b2, savedB);
  assert.deepEqual(h2.r.stats(), { open: false, uploads: false, allowed: 1, swarms: 0, unlisted: 0, peers: 0, sockets: 2, interval: 120, codes: 1, knocks: 1, lanes: 0 });
  const acc = h2.r.message(a2, frame({ action: 'pair-accept', proof: PROOF, knock }));
  assert.equal(acc.problem, null);
  assert.equal(b2.last().action, 'pair-accepted');
  assert.deepEqual(b2.last().box, boxOf('O'));
  assert.ok(h2.ops.some((o) => o[0] === 'put' && o[1].startsWith('lane:')), 'the lane row goes to storage');

  // the idle sweep: a tracker socket is stale after 20 minutes; a pair socket that owns a code is not, until the code runs out
  const t = conn('t');
  h.r.message(t, announce(A_HASH, peer('t')));
  h.tick((PEER_TTL_S + 60) * 1000);
  assert.equal(h.r.stale(t, h.now()), true);
  assert.equal(h.r.stale(a, h.now()), false, 'the owner of a code may sit with the page open and send nothing');
  assert.equal(h.r.stale(b, h.now()), true, 'a requester that sent nothing for 20 minutes is idle (its knock ran out at 10)');
  h.tick(CHANNEL_TTL_MS);
  h.r.sweep(h.now());
  assert.equal(h.r.stale(a, h.now()), true, 'the code ran out: now it is idle like any socket');
  assert.equal(a.take().pop().reason, 'expired');
  assert.equal(h.r.stale(conn('unknown'), h.now()), true);
});

test('rtc.js: the lanes the pairing mints are served like listed infohashes for 24 hours; a lane swarm goes when empty; an expired lane is dead', () => {
  const h = rendezvous();
  const { r } = h;
  const a = conn('a');
  const b = conn('b');
  r.message(a, frame({ action: 'pair-open', channel: 'abcd', box: BOX }));
  r.message(b, frame({ action: 'pair-knock', channel: 'abcd', box: BOX }));
  const knock = b.take()[0].knock;
  const x = conn('x');
  const probe = 'f'.repeat(40);
  r.message(x, announce(probe, peer('x')));
  assert.match(x.last()['failure reason'], /not allowed/, 'an infohash nobody minted is refused');
  r.message(a, frame({ action: 'pair-accept', proof: PROOF, knock }));
  const lane = a.last().lane;
  assert.equal(r.stats().lanes, 1);
  assert.deepEqual(h.ops.filter((o) => o[1] === 'lane:' + lane), [['put', 'lane:' + lane, h.now() + LANE_TTL_MS]]);
  const t1 = conn('t1');
  const t2 = conn('t2');
  r.message(t1, announce(lane, peer('1')));
  assert.equal(t1.last()['failure reason'], undefined, 'served after the owner accepted');
  r.message(t2, announce(lane, peer('2'), { left: 10, offers: [{ offer: { type: 'offer', sdp: 'v=0' }, offer_id: 'o1' }] }));
  assert.equal(t1.last().offer_id, 'o1', 'the first offer moves only now');
  assert.equal(r.stats().swarms, 1);
  assert.equal(r.stats().unlisted, 0, 'a lane is allowed, not unlisted');
  r.close(t1);
  r.close(t2);
  assert.equal(r.stats().swarms, 0, 'an empty lane swarm is forgotten');
  assert.equal(r.stats().lanes, 1, 'the lane itself stays allowed until it expires');

  // after 24 hours the lane is dead: not allowed, its swarm gone, its members out (they are refused at their next announce)
  r.message(t1, announce(lane, peer('1')));
  assert.equal(r.stats().peers, 1);
  assert.deepEqual(r.attachmentOf(t1).s, [[lane, 1]]);
  h.tick(LANE_TTL_MS);
  assert.equal(r.nextExpiry() <= h.now(), true);
  const swept = r.sweep(h.now());
  assert.ok(swept.touched.includes(t1), 'the saved state of the member moved: it is not in the swarm any more');
  assert.ok(swept.touched.includes(a), 'and so did the owner of the code that ran out in the same sweep');
  assert.deepEqual(r.attachmentOf(t1).s, []);
  assert.deepEqual([r.stats().lanes, r.stats().swarms, r.stats().peers, r.stats().unlisted], [0, 0, 0, 0]);
  assert.deepEqual(h.ops.filter((o) => o[0] === 'delete' && o[1] === 'lane:' + lane), [['delete', 'lane:' + lane]]);
  const late = conn('late');
  r.message(late, announce(lane, peer('9')));
  assert.match(late.last()['failure reason'], /not allowed/, 'nobody new joins');
  r.message(t1, announce(lane, peer('1'), { event: 'update' }));
  assert.match(t1.last()['failure reason'], /not allowed/, 'and the member that was in is refused like tools/tracker.mjs refuses it');
  r.close(t1);
  assert.equal(r.stats().swarms, 0);
  assert.equal(r.stats().unlisted, 0);
  // a lane that is also in the allow list is listed whatever the pairing says: the sweep leaves its swarm alone
  const both = rendezvous({ allow: new Set([A_HASH]) });
  both.r.allowLane(A_HASH, both.now() + 1000);
  const m = conn('m');
  both.r.message(m, announce(A_HASH, peer('m')));
  both.tick(2000);
  assert.deepEqual(both.r.sweep(both.now()).touched, []);
  assert.equal(both.r.stats().swarms, 1);
});

test('rtc.js: allowLane and restore load the stored lanes; a lane past its expiry is deleted from the store; the cap on lanes holds', () => {
  const h = rendezvous({ maxLanes: 2 });
  const { r } = h;
  const lane1 = '1'.repeat(40);
  const lane2 = '2'.repeat(40);
  const lane3 = '3'.repeat(40);
  assert.equal(r.allowLane(lane1, h.now() + HOUR), true);
  assert.equal(r.allowLane(lane1, h.now() + 2 * HOUR), true, 'the same lane again is the same lane');
  assert.equal(r.allowLane('nope', h.now() + HOUR), false);
  assert.equal(r.allowLane(lane2, 'soon'), false);
  assert.equal(r.allowLane(lane2, h.now() + HOUR), true);
  assert.equal(r.allowLane(lane3, h.now() + HOUR), false, 'the cap on lanes in all');
  assert.equal(r.stats().lanes, 2);
  assert.deepEqual(h.ops, [], 'loading a stored lane writes nothing');

  const h2 = rendezvous();
  h2.r.restore({
    lanes: new Map([['lane:' + lane1, h2.now() + HOUR], ['lane:' + lane2, h2.now() - 1], ['lane:' + lane3, 'x'], ['lane:short', h2.now() + HOUR]]),
    chans: new Map([['chan:abcd', { kind: 'pair', box: BOX, lane: null, exp: h2.now() + HOUR }], ['chan:bad', { kind: 'pair' }]]),
  });
  assert.equal(h2.r.stats().lanes, 1);
  assert.equal(h2.r.stats().codes, 1, 'a code row is held until its socket claims it');
  assert.deepEqual(h2.ops.map((o) => o.join(' ')).sort(), ['delete chan:bad', 'delete lane:' + lane2, 'delete lane:' + lane3, 'delete lane:short']);
  const t = conn('t');
  h2.r.message(t, announce(lane1, peer('t')));
  assert.equal(t.last()['failure reason'], undefined, 'a restored lane is served');
  h2.r.sweep(h2.now());
  assert.equal(h2.r.stats().codes, 0, 'a row whose socket never came back is released at the first sweep');
});

test('rtc.js: with pairing off the frames are answered, nothing is kept, and the tracker works as before', () => {
  const h = rendezvous({ pairing: false });
  const a = conn('a');
  const res = h.r.message(a, frame({ action: 'pair-open', channel: 'abcd', box: BOX, rid: 'r' }));
  assert.equal(res.problem, 'pairing is off on this rendezvous');
  assert.deepEqual(a.take(), [{ action: 'pair-open', rid: 'r', 'failure reason': 'pairing is off on this rendezvous' }]);
  h.r.message(a, announce(A_HASH, peer('a')));
  assert.equal(a.last()['failure reason'], undefined);
  assert.deepEqual(h.r.stats().codes, 0);
  assert.deepEqual(h.r.sweep(h.now()), { touched: [] });
  assert.equal(h.r.nextExpiry(), Infinity);
  assert.deepEqual(h.r.close(a), { touched: [] });
});
