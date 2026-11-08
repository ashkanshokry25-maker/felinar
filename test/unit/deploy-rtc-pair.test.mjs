// Unit tests for the pairing and room protocol of the rendezvous (deploy/rtc-worker/pair.js, ARCHITECTURE 15.21): the
// pure core through fake connections, and its dispatch inside rtc.js (the same core the Worker and tools/tracker.mjs run). Nothing
// here opens a socket and no real time passes: the clock and the random bytes are injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createPairing, isPairAction, isChannel, normalizeCode, formatCode, helloProblem, boxProblem, frameTooLarge,
  MAX_PAIR_BYTES, MAX_BOX_BYTES, KNOCK_TTL_MS, LANE_TTL_MS, CHANNEL_TTL_MS, MIXED, CODE_ALPHABET, DEFAULT_CAPS,
  CHANNEL_LENGTH, SECRET_LENGTH, CODE_LENGTH,
} from '../../deploy/rtc-worker/pair.js';
import { createRendezvous, PEER_TTL_S } from '../../deploy/rtc-worker/rtc.js';
// The names the relay lane adds are read through the namespace, so a file that lacks one fails that test and not the whole file.
import * as PAIR from '../../deploy/rtc-worker/pair.js';

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

/**
 * A world: the pure core with a clock, counter-based random bytes, the lanes it allowed and the storage ops it asked for.
 * known is what the host's laneExpiry(hex) answers (lane -> expiry ms): the lanes the core minted, and any a test adds;
 * opts.hostExpiry === false gives the core no laneExpiry at all, opts.relay: false switches the relay lane off, and opts.liveness is the
 * host's liveness(conn) (DECISIONS DEC-1: the time of the socket's last keepalive the platform answered). opts.start is the first reading
 * of the clock (T0 when absent), which is the moment the core is built: a test that builds a core again later passes a later start.
 */
function world(opts = {}) {
  let clock = opts.start === undefined ? T0 : opts.start;
  let n = 0;
  const lanes = [];
  const known = new Map();
  const ops = [];
  const random = (len) => {
    const a = new Uint8Array(len);
    for (let i = 0; i < len; i++) a[i] = (++n * 29 + i * 13 + 5) & 255;
    return a;
  };
  const p = createPairing({
    random, now: () => clock, caps: opts.caps, relay: opts.relay, liveness: opts.liveness,
    allowLane: (hex, exp) => { if (opts.refuseLanes) return false; lanes.push([hex, exp]); known.set(hex, exp); return true; },
    laneExpiry: opts.hostExpiry === false ? undefined : (hex) => known.get(hex) || 0,
    persist: (o) => ops.push(...o),
  });
  return { p, lanes, known, ops, tick: (ms) => { clock += ms; }, now: () => clock };
}
/**
 * The nine relay fields of stats() (plan 3.2, evicted from DECISIONS DEC-1, and relaySince from finding A F3 of the 8.2 audit: the moment
 * the counts began). The tests written before the relay lane pin the pairing counts and the tracker's counts exactly; they do it through
 * noRelay(stats), which drops these nine, and the relay tests pin them.
 */
const relayFields = ['relays', 'relayed', 'relayBytes', 'relayDay', 'relaySince', 'relayBusy', 'relayRate', 'joinsRefused', 'evicted'];
const noRelay = (stats) => { const out = Object.assign({}, stats); for (const k of relayFields) delete out[k]; return out; };
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
  assert.deepEqual(noRelay(w.p.stats()), { codes: 1, knocks: 0 });
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
  assert.deepEqual(noRelay(w.p.stats()), { codes: 0, knocks: 0 });
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
  assert.deepEqual(noRelay(w.p.stats()), { codes: 1, knocks: 1 });
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
  assert.deepEqual(noRelay(w.p.stats()), { codes: 1, knocks: 0 }, 'the code stays open for the next person; the knock is gone');
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
  assert.deepEqual(noRelay(w.p.stats()), { codes: 1, knocks: 1 }, 'the knock is still there');
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
  assert.deepEqual(noRelay(w.p.stats()), { codes: 0, knocks: 0 });
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
  assert.deepEqual(noRelay(w.p.stats()), { codes: 1, knocks: 0 });
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
  assert.deepEqual(noRelay(w.p.stats()), { codes: 0, knocks: 0 });
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
  assert.deepEqual(noRelay(w.p.stats()), { codes: 0, knocks: 0 });
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
  assert.deepEqual(noRelay(w.p.stats()), { codes: 0, knocks: 0 });
  assert.deepEqual(w.p.takeTouched().sort((x, y) => x.name.localeCompare(y.name)), [b, c], 'their saved states moved; the closed socket is not listed');

  // the requester goes: the owner is told to drop the request
  const d = conn('d');
  const e = conn('e');
  say(w, d, { action: 'pair-open', channel: 'dd22', box: BOX });
  const ke = only(say(w, e, { action: 'pair-knock', channel: 'dd22', box: BOX }), e).knock;
  assert.deepEqual(to(w.p.close(e), d), [{ action: 'pair-cancelled', knock: ke }]);
  assert.deepEqual(noRelay(w.p.stats()), { codes: 1, knocks: 0 });
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
  assert.deepEqual(noRelay(full.w2.p.stats()), { codes: 2, knocks: 2 });
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
  assert.deepEqual(noRelay(orphan.w2.p.stats()), { codes: 0, knocks: 0 });
  assert.deepEqual(orphan.w2.ops.map((o) => o.join(' ')).sort(), ['delete chan:abcd', 'delete chan:rm22']);

  // a requester socket that is gone: its knock is simply not restored
  const solo = wake([a]);
  assert.deepEqual(solo.replies, []);
  assert.deepEqual(noRelay(solo.w2.p.stats()), { codes: 2, knocks: 0 });

  // knocks that ran out while the object slept are answered when the socket is attached; unreadable rows and entries are dropped
  const late = world();
  late.tick(KNOCK_TTL_MS + 1000);
  late.p.load([['abcd', rows.get('chan:abcd')], ['bad!', { kind: 'pair' }], ['wxyz', { kind: 'nope' }], ['efgh', { kind: 'room', box: BOX, lane: 'zz', exp: 1 }]]);
  assert.deepEqual(late.ops.map((o) => o.join(' ')).sort(), ['delete chan:bad!', 'delete chan:efgh', 'delete chan:wxyz'], 'a row that is not a code is deleted, whatever its key');
  const b3 = conn('b');
  assert.deepEqual(late.p.attach(b3, saved.get('b')), [[b3, { action: 'pair-rejected', knock: k1, reason: 'expired' }]]);
  assert.deepEqual(late.p.attach(conn('junk'), { c: 'nope', q: [['bad'], 5, null, [k1, 'ab', 1, 'pair']] }), []);
  assert.deepEqual(late.p.attach(conn('none'), null), []);
  assert.deepEqual(noRelay(late.p.stats()), { codes: 1, knocks: 0 });
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

// ---------------------------------------------------------------------------------------------- the relay lane (plan 3.1 to 3.4)

// The module never reads a frame: here a frame is any string of base64url characters, and what comes out is the same string.
const LANE = 'ab'.repeat(20);
const laneN = (i) => i.toString(16).padStart(2, '0').repeat(20);
const frameOf = (n, fill = 'x') => fill.repeat(n);

/** A world whose host knows LANE for 24 hours. */
function relayWorld(opts = {}) {
  const w = world(opts);
  w.known.set(LANE, T0 + LANE_TTL_MS);
  return w;
}
const joinLane = (w, c, extra = {}, kind = 'pair', lane = LANE) => say(w, c, Object.assign({ action: kind + '-join', lane }, extra));
const relayTo = (w, c, f, extra = {}, kind = 'pair', lane = LANE) => say(w, c, Object.assign({ action: kind + '-relay', lane, f }, extra));
test('relay: the protocol examples of plan section 4, step by step (join, joined, relay, relayed, ping, left, lane full)', () => {
  const w = relayWorld();
  const a = conn('a');
  const b = conn('b');
  const c = conn('c');
  const ja = joinLane(w, a, { rid: 'j1' });
  assert.deepEqual(ja.replies.map(([x, o]) => [x.name, o]), [['a', { action: 'pair-join', lane: LANE, peers: 0, rid: 'j1' }]], 'alone: the answer and nobody to tell');
  assert.equal(ja.changed, true, 'the socket is in a lane now: its saved state moved');
  assert.equal(ja.problem, null);
  const jb = joinLane(w, b, { rid: 'j2' });
  assert.deepEqual(to(jb, b), [{ action: 'pair-join', lane: LANE, peers: 1, rid: 'j2' }]);
  assert.deepEqual(to(jb, a), [{ action: 'pair-joined', lane: LANE, peers: 1 }]);
  const f = frameOf(120, 'Q');
  const ra = relayTo(w, a, f, { rid: 'r1' });
  assert.deepEqual(ra.replies.map(([x]) => x.name), ['b', 'a'], 'the push goes out first, then the answer to the sender');
  assert.deepEqual(to(ra, b), [{ action: 'pair-relayed', lane: LANE, f }]);
  assert.deepEqual(to(ra, a), [{ action: 'pair-relay', lane: LANE, peers: 1, rid: 'r1' }]);
  assert.equal(ra.changed, false, 'a relayed frame moves nothing a socket would have to store');
  assert.deepEqual(to(say(w, a, { action: 'pair-ping' }), a), [{ action: 'pair-pong' }]);
  assert.deepEqual(to(w.p.close(b), a), [{ action: 'pair-left', lane: LANE, peers: 0 }]);
  joinLane(w, conn('b2'));
  const jc = joinLane(w, c, { rid: 'j3' });
  assert.deepEqual(jc.replies, [[c, { action: 'pair-join', rid: 'j3', 'failure reason': 'lane full' }]]);
  assert.equal(jc.changed, false);
  assert.deepEqual(w.ops, [], 'nothing about a lane or a frame is written to storage');
});

test('relay join: bad lanes, unknown and expired lanes, full lanes, too many lanes; every refusal is counted and none names the lane', () => {
  const w = relayWorld();
  const a = conn('a');
  for (const lane of [undefined, null, 7, '', 'ab', 'AB'.repeat(20), 'ab'.repeat(20) + 'a', 'zz'.repeat(20), [LANE], 'ab'.repeat(19) + 'a-']) {
    fails(say(w, a, { action: 'pair-join', lane, rid: 'x' }), a, 'invalid lane');
  }
  const unknown = fails(joinLane(w, a, { rid: 'u' }, 'pair', laneN(1)), a, 'unknown lane');
  assert.deepEqual(Object.keys(unknown).sort(), ['action', 'failure reason', 'rid'], 'a refusal does not name the lane');
  w.known.set(laneN(2), T0 + 1000);
  assert.equal(only(joinLane(w, a, {}, 'pair', laneN(2)), a).peers, 0, 'allowed until its expiry');
  w.tick(1000);
  const late = conn('late');
  fails(joinLane(w, late, {}, 'pair', laneN(2)), late, 'unknown lane');
  assert.equal(w.p.stats().joinsRefused, 12, 'ten bad lanes, one nobody minted, one that ran out: every refusal is counted');
});

test('relay join: a pair lane holds 2 sockets and a room lane 16; the caps are the host\'s to change; a member joining again is not refused', () => {
  const w = relayWorld();
  const [p1, p2, p3] = ['p1', 'p2', 'p3'].map(conn);
  joinLane(w, p1);
  joinLane(w, p2);
  fails(joinLane(w, p3, { rid: 'f' }), p3, 'lane full');
  assert.deepEqual(only(joinLane(w, p1, { rid: 'again' }), p1), { action: 'pair-join', lane: LANE, peers: 1, rid: 'again' }, 'idempotent, even though the lane is full');
  const again = joinLane(w, p1);
  assert.deepEqual([again.replies.length, again.changed], [1, false], 'no push, nothing to store');
  assert.equal(to(joinLane(w, p2), p1).length, 0, 'and nobody is told');

  const room = laneN(3);
  w.known.set(room, T0 + LANE_TTL_MS);
  const members = Array.from({ length: 17 }, (_, i) => conn('m' + i));
  const results = members.map((m) => joinLane(w, m, {}, 'room', room));
  assert.deepEqual(results.slice(0, 16).map((r, i) => only(r, members[i]).peers), Array.from({ length: 16 }, (_, i) => i), 'each member is told how many are there already');
  fails(results[16], members[16], 'lane full');
  assert.deepEqual(to(results[15], members[0]), [{ action: 'room-joined', lane: room, peers: 15 }], 'the first member hears about the sixteenth, with its own count');

  const roomy = relayWorld({ caps: { pairLaneMembers: 3, roomLaneMembers: 2 } });
  const crowd = ['x', 'y', 'z', 'q'].map(conn);
  assert.deepEqual(crowd.map((c) => to(joinLane(roomy, c), c)[0]['failure reason'] || 'ok'), ['ok', 'ok', 'ok', 'lane full'], 'pairLaneMembers is a cap the host may change');
  roomy.known.set(room, T0 + LANE_TTL_MS);
  assert.deepEqual(crowd.slice(0, 3).map((c) => to(joinLane(roomy, c, {}, 'room', room), c)[0]['failure reason'] || 'ok'), ['ok', 'ok', 'lane full']);
  assert.equal(PAIR.DEFAULT_CAPS.pairLaneMembers, 2);
  assert.equal(PAIR.DEFAULT_CAPS.roomLaneMembers, 16);
});

test('relay join: one socket holds at most 8 lanes; a ninth is refused, a lane it is in is not a new one, leaving makes room', () => {
  const w = world();
  const many = conn('many');
  for (let i = 1; i <= 9; i++) w.known.set(laneN(i), T0 + LANE_TTL_MS);
  for (let i = 1; i <= 8; i++) assert.equal(only(joinLane(w, many, {}, 'pair', laneN(i)), many).peers, 0);
  fails(joinLane(w, many, { rid: 'n' }, 'pair', laneN(9)), many, 'too many lanes');
  assert.equal(only(joinLane(w, many, {}, 'pair', laneN(8)), many).peers, 0, 'a lane it is in already is not a ninth');
  say(w, many, { action: 'pair-leave', lane: laneN(1) });
  assert.equal(only(joinLane(w, many, {}, 'pair', laneN(9)), many).peers, 0, 'leaving one made room');
  const other = conn('other');
  assert.equal(only(joinLane(w, other, {}, 'pair', laneN(9)), other).peers, 1, 'the cap is per socket: another socket joins the same lane and finds it there');
  assert.equal(w.p.stats().relays, 8, 'eight lanes have a member');
  assert.equal(PAIR.DEFAULT_CAPS.lanesPerSocket, 8);
});

test('relay join (DEC-1): a member that showed no life for more than memberStaleMs does not block its replacement: a join to the full lane evicts it through the leave path, the others hear left then joined, the host is told whom to close, and it is counted', () => {
  const w = relayWorld();
  const [a, b, c] = ['a', 'b', 'c'].map(conn);
  joinLane(w, a);
  joinLane(w, b);
  a.take();
  // 2 minutes later: a pinged, b said nothing since its join (a phone that changed networks: its old socket is half open here)
  w.tick(PAIR.DEFAULT_CAPS.memberStaleMs);
  say(w, a, { action: 'pair-ping' });
  a.take();
  const early = joinLane(w, c, { rid: 'e' });
  fails(early, c, 'lane full');
  assert.equal(early.evicted, undefined, 'exactly memberStaleMs of silence is not yet older than it');
  w.tick(1);
  const r = joinLane(w, c, { rid: 'j3' });
  assert.deepEqual(to(r, c), [{ action: 'pair-join', lane: LANE, peers: 1, rid: 'j3' }], 'c takes the place of b');
  assert.deepEqual(to(r, a), [{ action: 'pair-left', lane: LANE, peers: 0 }, { action: 'pair-joined', lane: LANE, peers: 1 }], 'the path of a socket that closed, then the newcomer');
  assert.deepEqual(to(r, b), [], 'the evicted socket is told nothing here: the host closes it');
  assert.deepEqual(r.evicted, [b], 'whom the host closes (code 1000) and releases');
  assert.equal(r.changed, true);
  assert.equal(r.problem, null);
  assert.deepEqual(w.p.attachmentOf(b), { c: [], q: [] }, 'b is in no lane any more');
  assert.deepEqual(w.p.attachmentOf(c).l, [[LANE, 'pair']]);
  fails(relayTo(w, b, frameOf(8), { rid: 'x' }), b, 'unknown lane');
  assert.deepEqual(to(relayTo(w, c, frameOf(8)), a), [{ action: 'pair-relayed', lane: LANE, f: frameOf(8) }], 'a frame reaches the new member');
  const s = w.p.stats();
  assert.deepEqual([s.evicted, s.joinsRefused, s.relays], [1, 1, 1], 'the early refusal was counted as a refusal, the eviction as an eviction');
  // the host then closes b as it closes any socket: nothing of it is left in the lane, so nobody is told twice
  assert.deepEqual(w.p.close(b), []);
  assert.deepEqual([w.p.stats().relays, w.p.attachmentOf(a).l.length], [1, 1]);
  assert.deepEqual(w.ops, [], 'nothing about an eviction is written to storage');
  // the counter belongs to the UTC day like the others
  w.tick(2 * HOUR);
  assert.equal(w.p.stats().evicted, 0, 'a new UTC day starts it at 0');
  assert.equal(PAIR.DEFAULT_CAPS.memberStaleMs, 120000, 'about 2.4 keepalives of 50 seconds');
});

test('relay join (DEC-1): liveness is the later of the last message here and what the host knows (the keepalive the platform answered); the host is asked about the members of the full lane only; a lane whose members are all live still answers lane full', () => {
  const asked = [];
  const alive = new Map(); // conn -> the time the host's platform last answered its ping
  const w = relayWorld({ liveness: (x) => { asked.push(x.name); return alive.has(x) ? alive.get(x) : undefined; } });
  const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map(conn);
  joinLane(w, a);
  joinLane(w, b);
  const other = laneN(5);
  w.known.set(other, T0 + LANE_TTL_MS);
  joinLane(w, d, {}, 'pair', other);
  // 10 minutes of silence from both; the platform answered b's ping a minute ago (seen(), in the Worker), a's never
  w.tick(10 * MIN);
  alive.set(b, w.now() - MIN);
  alive.set(d, w.now());
  asked.length = 0;
  const r = joinLane(w, c, { rid: 'j' });
  assert.deepEqual(asked.sort(), ['a', 'b'], 'the host is asked about a and b, not about d in another lane and not about c');
  assert.deepEqual(to(r, c), [{ action: 'pair-join', lane: LANE, peers: 1, rid: 'j' }], 'a is gone, b is kept');
  assert.deepEqual(r.evicted, [a]);
  assert.deepEqual(to(r, b), [{ action: 'pair-left', lane: LANE, peers: 0 }, { action: 'pair-joined', lane: LANE, peers: 1 }]);
  assert.deepEqual(to(r, d), [], 'another lane hears nothing');
  // both live now (c just joined, the platform answered b): a fifth socket is refused, nobody is evicted, only the members are asked about
  alive.set(b, w.now());
  asked.length = 0;
  const full = joinLane(w, e, { rid: 'f' });
  fails(full, e, 'lane full');
  assert.equal(full.evicted, undefined);
  assert.deepEqual(asked.sort(), ['b', 'c']);
  assert.deepEqual([w.p.stats().evicted, w.p.stats().joinsRefused], [1, 1]);
  // what the host answers only moves a time forward: an answer in the past, or none, leaves the last message here as the time
  w.tick(10 * MIN);
  alive.set(c, w.now() - 20 * MIN);
  alive.delete(b);
  say(w, b, { action: 'pair-ping' });
  b.take();
  const again = joinLane(w, e, { rid: 'g' });
  assert.deepEqual(to(again, e), [{ action: 'pair-join', lane: LANE, peers: 1, rid: 'g' }], 'c went silent for 10 minutes and the host knows nothing fresher: evicted; b pinged just now: kept');
  assert.deepEqual(again.evicted, [c]);
  assert.equal(w.p.stats().evicted, 2);
});

test('relay join (DEC-1): a room evicts every stale member at once and the newcomer sees who is left; a pair lane whose two members both vanished starts over with the joiner alone; a joiner at its own cap is refused before anyone is evicted', () => {
  const w = relayWorld();
  const room = laneN(3);
  w.known.set(room, T0 + LANE_TTL_MS);
  const members = Array.from({ length: 16 }, (_, i) => conn('m' + i));
  for (const m of members) joinLane(w, m, {}, 'room', room);
  for (const m of members) m.take();
  w.tick(3 * MIN);
  const silent = [members[2], members[7], members[15]];
  for (const m of members) if (!silent.includes(m)) { say(w, m, { action: 'pair-ping' }); m.take(); }
  const late = conn('late');
  const r = joinLane(w, late, { rid: 'r' }, 'room', room);
  assert.deepEqual(to(r, late), [{ action: 'room-join', lane: room, peers: 13, rid: 'r' }]);
  assert.deepEqual(r.evicted, silent);
  assert.deepEqual(to(r, members[0]).map((m) => [m.action, m.peers]), [['room-left', 14], ['room-left', 13], ['room-left', 12], ['room-joined', 13]], 'each eviction is a left with the count of those who remain, then the newcomer');
  for (const m of silent) assert.deepEqual(w.p.attachmentOf(m), { c: [], q: [] });
  assert.equal(w.p.stats().evicted, 3);

  // a pair lane whose both members vanished: the joiner is alone in a fresh record
  const [a, b, c] = ['a', 'b', 'c'].map(conn);
  joinLane(w, a);
  joinLane(w, b);
  w.tick(3 * MIN);
  const alone = joinLane(w, c, { rid: 'c' });
  assert.deepEqual(to(alone, c), [{ action: 'pair-join', lane: LANE, peers: 0, rid: 'c' }]);
  assert.deepEqual(alone.evicted, [a, b]);
  assert.deepEqual([w.p.stats().relays, w.p.stats().evicted], [2, 5]);
  assert.deepEqual(w.p.attachmentOf(c).l, [[LANE, 'pair']]);

  // a socket that holds 8 lanes already cannot join: too many lanes, and the stale members of the lane it asked for are left alone
  const many = conn('many');
  for (let i = 10; i < 18; i++) { w.known.set(laneN(i), T0 + LANE_TTL_MS); joinLane(w, many, {}, 'pair', laneN(i)); }
  const [x, y] = ['x', 'y'].map(conn);
  w.known.set(laneN(20), T0 + LANE_TTL_MS);
  joinLane(w, x, {}, 'pair', laneN(20));
  joinLane(w, y, {}, 'pair', laneN(20));
  w.tick(3 * MIN);
  const refused = joinLane(w, many, { rid: 'n' }, 'pair', laneN(20));
  fails(refused, many, 'too many lanes');
  assert.equal(refused.evicted, undefined, 'nobody is evicted for a socket that could not join anyway');
  assert.deepEqual(w.p.attachmentOf(x).l, [[laneN(20), 'pair']]);
  assert.equal(w.p.stats().evicted, 5);
});

test('relay join (DEC-1): a socket restored after a wake counts as alive from the host\'s time t in its attachment, or from the wake itself when the host keeps none', () => {
  const w = relayWorld();
  const [a, b] = ['a', 'b'].map(conn);
  joinLane(w, a);
  joinLane(w, b);
  const saved = JSON.parse(JSON.stringify(w.p.attachmentOf(a)));
  // the object is rebuilt 3 minutes later: the host keeps the seconds of a socket's last message in the attachment as t (rtc.js does)
  const w2 = relayWorld();
  w2.tick(3 * MIN);
  const [a2, b2, c2] = ['a2', 'b2', 'c2'].map(conn);
  w2.p.attach(a2, Object.assign({ t: Math.floor(T0 / 1000) }, saved));
  w2.p.attach(b2, saved); // no t kept: as alive as the wake
  assert.equal(w2.p.stats().relays, 1);
  const r = joinLane(w2, c2, { rid: 'j' });
  assert.deepEqual(r.evicted, [a2], 'the time the host kept says a2 has been silent for 3 minutes; b2 has no time and is as alive as the wake');
  assert.deepEqual(to(r, c2), [{ action: 'pair-join', lane: LANE, peers: 1, rid: 'j' }]);
  assert.deepEqual(to(r, b2), [{ action: 'pair-left', lane: LANE, peers: 0 }, { action: 'pair-joined', lane: LANE, peers: 1 }]);
  assert.equal(w2.p.stats().evicted, 1);
});

test('relay: a lane has one kind, the kind of its first joiner; the other kind\'s actions on it find no lane', () => {
  const w = relayWorld();
  const a = conn('a');
  const b = conn('b');
  joinLane(w, a, {}, 'pair');
  fails(joinLane(w, b, { rid: 'k' }, 'room'), b, 'unknown lane');
  fails(relayTo(w, a, frameOf(8), { rid: 'k' }, 'room'), a, 'unknown lane');
  assert.deepEqual(only(joinLane(w, b, {}, 'pair'), b), { action: 'pair-join', lane: LANE, peers: 1 });
  assert.deepEqual(to(relayTo(w, a, frameOf(8), {}, 'pair'), b), [{ action: 'pair-relayed', lane: LANE, f: frameOf(8) }]);
  assert.deepEqual(w.p.attachmentOf(a).l, [[LANE, 'pair']]);
});

test('relay: a frame reaches every other member and nobody else; the sender is answered only when it sent a rid; alone, peers is 0', () => {
  const w = relayWorld();
  const [a, b, c, outsider] = ['a', 'b', 'c', 'outsider'].map(conn);
  const room = laneN(3);
  w.known.set(room, T0 + LANE_TTL_MS);
  for (const m of [a, b, c]) joinLane(w, m, {}, 'room', room);
  joinLane(w, outsider);
  const f = frameOf(64, 'Z');
  const r = relayTo(w, a, f, { rid: 'r' }, 'room', room);
  assert.deepEqual(to(r, b), [{ action: 'room-relayed', lane: room, f }]);
  assert.deepEqual(to(r, c), [{ action: 'room-relayed', lane: room, f }]);
  assert.deepEqual(to(r, outsider), [], 'a socket in another lane hears nothing');
  assert.deepEqual(to(r, a), [{ action: 'room-relay', lane: room, peers: 2, rid: 'r' }]);
  const quietly = relayTo(w, a, f, {}, 'room', room);
  assert.deepEqual(to(quietly, a), [], 'no rid: no answer');
  assert.equal(quietly.replies.length, 2);
  // alone in the lane: nobody to write to, and the sender is told so
  const alone = relayTo(w, outsider, f, { rid: 'solo' });
  assert.deepEqual(alone.replies, [[outsider, { action: 'pair-relay', lane: LANE, peers: 0, rid: 'solo' }]]);
  assert.deepEqual(relayTo(w, outsider, f).replies, []);
  // a frame is never echoed to its sender
  assert.equal(r.replies.filter(([x, o]) => x === a && o.f !== undefined).length, 0);
});

test('relay: a socket that is not in the lane, a lane that ran out and a lane nobody minted find no lane; the shapes of f are checked', () => {
  const w = relayWorld();
  const a = conn('a');
  const b = conn('b');
  fails(relayTo(w, a, frameOf(8), { rid: 'n' }), a, 'unknown lane');
  joinLane(w, b);
  fails(relayTo(w, a, frameOf(8), { rid: 'n' }), a, 'unknown lane');
  assert.deepEqual(to(relayTo(w, b, frameOf(8)), a), [], 'the non-member got nothing');
  for (const lane of [undefined, null, 7, 'ab', 'AB'.repeat(20), [LANE]]) fails(say(w, b, { action: 'pair-relay', lane, f: frameOf(8) }), b, 'invalid lane');
  fails(relayTo(w, b, frameOf(8), {}, 'pair', laneN(77)), b, 'unknown lane');
  for (const f of [undefined, null, 7, '', 'abc', 'a b c d', 'ab+/', 'abcd=', 'abc\n', 'caf\u00e9caf\u00e9', 'x'.repeat(7701), ['abcd'], { f: 'abcd' }]) {
    fails(relayTo(w, b, f, { rid: 'bad' }), b, 'invalid frame');
  }
  for (const f of ['abcd', 'A-_z09', 'x'.repeat(7699), 'x'.repeat(7700)]) assert.equal(only(relayTo(w, b, f, { rid: 'ok' }), b).peers, 0, f.slice(0, 8) + ' (' + f.length + ' characters)');
  // the lane runs out: a member is not a member of anything any more once the clock passes it
  w.tick(LANE_TTL_MS);
  fails(relayTo(w, b, frameOf(8), { rid: 'late' }), b, 'unknown lane');
  assert.equal(PAIR.MAX_FRAME_CHARS, 7700);
});

test('relay: the three sealed DM frames fit the pair frame limit with room to spare (514, 1,538 and 5,634 bytes = 686, 2,051 and 7,512 characters)', () => {
  const w = relayWorld();
  const [a, b] = ['a', 'b'].map(conn);
  joinLane(w, a);
  joinLane(w, b);
  const expect = [[514, 686], [1538, 2051], [5634, 7512]];
  for (const [bytes, chars] of expect) {
    const f = Buffer.alloc(bytes, 7).toString('base64url');
    assert.equal(f.length, chars);
    const request = JSON.stringify({ v: 1, action: 'pair-relay', lane: LANE, f, rid: 'r1234567' });
    const r = w.p.message(a, JSON.parse(request));
    const push = JSON.stringify(to(r, b)[0]);
    assert.deepEqual(to(r, b), [{ action: 'pair-relayed', lane: LANE, f }], bytes + ' bytes');
    assert.equal(frameTooLarge(request), false);
    assert.equal(frameTooLarge(push), false);
    if (bytes === 5634) assert.deepEqual([Buffer.byteLength(request), Buffer.byteLength(push)], [7615, 7594], 'the largest request and the largest push of the plan');
  }
  const widest = JSON.stringify({ v: 1, action: 'pair-relay', lane: LANE, f: frameOf(7700), rid: 'r1234567' });
  assert.equal(frameTooLarge(widest), false, 'even the longest f the regex allows fits under ' + MAX_PAIR_BYTES);
  assert.ok(Buffer.byteLength(widest) < MAX_PAIR_BYTES);
});

test('relay caps: the 121st relay in a minute is refused and the window slides; refused frames are counted; the 151st message of any kind returns close', () => {
  const w = relayWorld();
  const [a, b] = ['a', 'b'].map(conn);
  joinLane(w, a);
  joinLane(w, b);
  const f = frameOf(16);
  for (let i = 0; i < 120; i++) assert.equal(only(relayTo(w, a, f, { rid: 'r' }), a).peers, 1, 'relay ' + (i + 1));
  const over = relayTo(w, a, f, { rid: 'r121' });
  fails(over, a, 'too many relays');
  assert.equal(over.close, undefined, 'a refusal is not a reason to close');
  assert.equal(w.p.stats().relayRate, 1);
  assert.equal(w.p.stats().relayed, 120, 'a refused frame was not forwarded');
  w.tick(59 * 1000);
  fails(relayTo(w, a, f, { rid: 'r' }), a, 'too many relays');
  w.tick(1100);
  assert.equal(only(relayTo(w, a, f, { rid: 'r' }), a).peers, 1, 'the window slides');
  assert.equal(PAIR.DEFAULT_CAPS.relayPerMin, 120);

  // 150 messages of any kind a minute: relays that were refused are messages too; the 151st is the last
  const w2 = relayWorld();
  const [c, d] = ['c', 'd'].map(conn);
  joinLane(w2, c);
  joinLane(w2, d);
  // message 1 was c's join; messages 2 to 121 are relays and all are forwarded; 122 to 150 are relays the rate cap refuses (a ping
  // would count as a message too since DECISIONS DEC-2: the ping test below has that case)
  for (let i = 0; i < 120; i++) relayTo(w2, c, f);
  for (let i = 0; i < 29; i++) fails(relayTo(w2, c, f, { rid: 'x' }), c, 'too many relays');
  const flood = relayTo(w2, c, f, { rid: 'x151' });
  assert.equal(flood.close, 'too many messages', 'the 151st message');
  assert.equal(flood.problem, 'too many messages');
  assert.deepEqual(to(flood, c), [{ action: 'pair-relay', rid: 'x151', 'failure reason': 'too many messages' }], 'the sender is told why, once');
  assert.deepEqual(to(flood, d), [], 'and the frame went nowhere');
  assert.deepEqual([w2.p.stats().relayed, w2.p.stats().relayRate], [120, 29]);
  assert.equal(PAIR.DEFAULT_CAPS.messagesPerMin, 150);
  // the host closes the socket; the core then releases it as it does any
  assert.deepEqual(to(w2.p.close(c), d), [{ action: 'pair-left', lane: LANE, peers: 0 }]);
  // a window that slides: a quiet minute later the same socket would be fine
  const w3 = relayWorld();
  const e = conn('e');
  for (let i = 0; i < 150; i++) assert.equal(joinLane(w3, e).close, undefined);
  assert.equal(joinLane(w3, e).close, 'too many messages');
  w3.tick(61 * 1000);
  assert.equal(joinLane(w3, e).close, undefined);
});

test('relay: the day cap refuses with "relay is busy" until the UTC day changes, then the counters start again; a busy day burns no rate slots', () => {
  const w = relayWorld({ caps: { relayDayMax: 5 } });
  const [a, b] = ['a', 'b'].map(conn);
  joinLane(w, a);
  joinLane(w, b);
  assert.equal(w.p.stats().relayDay, 20231114, 'T0 is 2023-11-14 22:13 UTC');
  assert.equal(w.p.stats().relaySince, T0, 'the counts began when this core was built, 22:13 UTC (finding A F3)');
  for (let i = 0; i < 5; i++) assert.equal(only(relayTo(w, a, frameOf(10), { rid: 'r' }), a).peers, 1);
  for (let i = 0; i < 3; i++) fails(relayTo(w, b, frameOf(10), { rid: 'r' }), b, 'relay is busy');
  let s = w.p.stats();
  assert.deepEqual([s.relayed, s.relayBytes, s.relayBusy, s.relayRate], [5, 50, 3, 0], 'five forwarded, three refused by the day cap and none by the rate');
  w.tick(HOUR);
  fails(relayTo(w, b, frameOf(10), { rid: 'r' }), b, 'relay is busy');
  assert.equal(w.p.stats().relayDay, 20231114, 'one hour later it is still 22:13 + 1 h = 23:13');
  assert.equal(w.p.stats().relaySince, T0, 'and the counts began where they did: frames, refusals and reads move nothing');
  w.tick(HOUR); // 00:13 UTC on the 15th
  s = w.p.stats();
  assert.deepEqual([s.relayDay, s.relayed, s.relayBytes, s.relayBusy, s.relayRate, s.joinsRefused], [20231115, 0, 0, 0, 0, 0], 'the counters of a new day start at 0');
  assert.equal(s.relaySince, Date.UTC(2023, 10, 15), 'a new day: the counts begin at 00:00 UTC of it, whenever the day was noticed');
  assert.ok(s.relaySince > T0 && s.relaySince < w.now(), 'between the build and the read');
  assert.equal(only(relayTo(w, b, frameOf(10), { rid: 'r' }), b).peers, 1, 'and relaying works again');
  assert.equal(w.p.stats().relayed, 1);
  assert.equal(PAIR.DEFAULT_CAPS.relayDayMax, 20000);

  // the day rolls on the first relay of the day even when nobody reads the stats; a refused frame at day change is counted for the new day
  const w2 = relayWorld({ caps: { relayDayMax: 1 } });
  const [c, d] = ['c', 'd'].map(conn);
  joinLane(w2, c);
  joinLane(w2, d);
  relayTo(w2, c, frameOf(4));
  fails(relayTo(w2, c, frameOf(4), { rid: 'x' }), c, 'relay is busy');
  w2.tick(2 * HOUR);
  relayTo(w2, c, frameOf(4));
  fails(relayTo(w2, c, frameOf(4), { rid: 'x' }), c, 'relay is busy');
  assert.deepEqual([w2.p.stats().relayDay, w2.p.stats().relayed, w2.p.stats().relayBusy], [20231115, 1, 1]);
  assert.equal(w2.p.stats().relaySince, Date.UTC(2023, 10, 15), 'the counts of the new day began at 00:00 UTC although the first read of the day came with a relay');

  // a rate cap that bites first is counted as a rate refusal
  const w3 = relayWorld({ caps: { relayPerMin: 2 } });
  const [e, g] = ['e', 'g'].map(conn);
  joinLane(w3, e);
  joinLane(w3, g);
  relayTo(w3, e, frameOf(4));
  relayTo(w3, e, frameOf(4));
  fails(relayTo(w3, e, frameOf(4), { rid: 'x' }), e, 'too many relays');
  assert.deepEqual([w3.p.stats().relayRate, w3.p.stats().relayBusy], [1, 0]);
});

// Finding A F3 of the 8.2 audit: the counters, the minute windows and the day cap are variables of one run of the core, and the Worker
// builds a new core whenever its object wakes. The next test pins what a rebuilt core reports (it passes with or without relaySince);
// the one after pins relaySince, which tells a reader that a rebuild happened (decision P3.D1, option B).
test('relay: a core built again over the same lane and sockets reads relays back and starts every count at 0, and its day cap is its own: the cap holds for one run of the core (finding A F3)', () => {
  const caps = { relayDayMax: 5 };
  const w = relayWorld({ caps });
  const [a, b] = ['a', 'b'].map(conn);
  joinLane(w, a);
  joinLane(w, b);
  for (let i = 0; i < 5; i++) assert.equal(only(relayTo(w, a, frameOf(10), { rid: 'r' }), a).peers, 1);
  fails(relayTo(w, a, frameOf(10), { rid: 'x' }), a, 'relay is busy');
  const first = w.p.stats();
  assert.deepEqual([first.relays, first.relayed, first.relayBytes, first.relayBusy, first.relayDay], [1, 5, 50, 1, 20231114], 'the cap was reached');
  // The object slept and is built again 5 minutes later, on the same UTC day. The host restores the lane from its rows and gives each
  // socket the state it kept (attachmentOf): that is all that survives a wake (README, "Relay").
  const saved = [a, b].map((c) => JSON.parse(JSON.stringify(w.p.attachmentOf(c))));
  const w2 = relayWorld({ caps, start: T0 + 5 * MIN });
  const [a2, b2] = ['a2', 'b2'].map(conn);
  w2.p.attach(a2, saved[0]);
  w2.p.attach(b2, saved[1]);
  const second = w2.p.stats();
  assert.equal(second.relays, 1, 'relays is read back from the sockets: a gauge, it does not start again');
  assert.deepEqual(['relayed', 'relayBytes', 'relayBusy', 'relayRate', 'joinsRefused', 'evicted'].map((k) => second[k]), [0, 0, 0, 0, 0, 0], 'the counters do');
  assert.equal(second.relayDay, first.relayDay, 'relayDay is the UTC day of the reading: it does not show that the counts began again');
  // the day cap belongs to the run: five more frames go through on the same UTC day, and then the new core is busy in its turn
  for (let i = 0; i < 5; i++) assert.equal(only(relayTo(w2, a2, frameOf(10), { rid: 'r' }), a2).peers, 1, 'frame ' + (i + 1) + ' after the rebuild');
  fails(relayTo(w2, a2, frameOf(10), { rid: 'x' }), a2, 'relay is busy');
  const third = w2.p.stats();
  assert.deepEqual([third.relayed, third.relayBusy, third.relayDay], [5, 1, 20231114], 'ten frames were forwarded on 2023-11-14 with a cap of five a day');
});

test('relay: relaySince is the later of 00:00 UTC of relayDay and the moment the core was built; no frame, refusal or read moves it, a core built again has its own, and a new UTC day moves it to 00:00 UTC (finding A F3, decision P3.D1)', () => {
  const w = relayWorld();
  const [a, b, c] = ['a', 'b', 'c'].map(conn);
  assert.equal(typeof w.p.stats().relaySince, 'number', 'a number, as every relay field is');
  assert.equal(w.p.stats().relaySince, T0, 'before any traffic: the moment the core was built');
  joinLane(w, a);
  joinLane(w, b);
  w.tick(MIN); // under memberStaleMs (2 minutes): both members are still live, so the third join is refused and evicts nobody
  relayTo(w, a, frameOf(10));
  fails(joinLane(w, c, { rid: 'x' }), c, 'lane full');
  assert.deepEqual([w.p.stats().relayed, w.p.stats().joinsRefused, w.p.stats().relaySince], [1, 1, T0], 'frames, refused joins and reads do not move it');

  // a core built again 30 minutes later, the same UTC day: its own moment, larger than the first core's
  const w2 = relayWorld({ start: T0 + 30 * MIN });
  assert.equal(w2.p.stats().relayDay, w.p.stats().relayDay);
  assert.equal(w2.p.stats().relaySince, T0 + 30 * MIN);
  assert.ok(w2.p.stats().relaySince > w.p.stats().relaySince, 'two reads with different values do not share a count');

  // a core built at 23:50 UTC counts from the build until midnight and from 00:00 UTC after it: not from the read that noticed the day
  const late = relayWorld({ start: Date.UTC(2023, 10, 14, 23, 50) });
  assert.equal(late.p.stats().relaySince, Date.UTC(2023, 10, 14, 23, 50));
  late.tick(20 * MIN); // 00:10 UTC on the 15th
  assert.equal(late.p.stats().relayDay, 20231115);
  assert.equal(late.p.stats().relaySince, Date.UTC(2023, 10, 15), 'the new day began at 00:00 UTC, ten minutes before the read');

  // never before the build: a host clock that is set back across midnight starts the counts again, but they cannot have begun before the core existed
  const back = relayWorld({ start: Date.UTC(2023, 10, 15, 0, 5) });
  back.tick(-10 * MIN); // 23:55 UTC on the 14th
  const s = back.p.stats();
  assert.equal(s.relayDay, 20231114, 'the UTC day of the reading');
  assert.equal(s.relaySince, Date.UTC(2023, 10, 15, 0, 5), 'the build, which is later than 00:00 UTC of that day');
});

test('relay leave and close: the others are told left with their own count; the record goes when the last member does; leaving a lane you are not in is quiet', () => {
  const w = relayWorld();
  const [a, b, c] = ['a', 'b', 'c'].map(conn);
  const room = laneN(3);
  w.known.set(room, T0 + LANE_TTL_MS);
  for (const m of [a, b, c]) joinLane(w, m, {}, 'room', room);
  assert.equal(w.p.stats().relays, 1);
  const left = say(w, b, { action: 'room-leave', lane: room, rid: 'l1' });
  assert.deepEqual(to(left, b), [{ action: 'room-leave', lane: room, rid: 'l1' }]);
  assert.deepEqual(to(left, a), [{ action: 'room-left', lane: room, peers: 1 }]);
  assert.deepEqual(to(left, c), [{ action: 'room-left', lane: room, peers: 1 }]);
  assert.equal(left.changed, true, 'the socket left a lane: its saved state moved');
  assert.deepEqual(w.p.attachmentOf(b), { c: [], q: [] }, 'and the saved state shows no lane');
  assert.deepEqual(to(relayTo(w, b, frameOf(8), { rid: 'x' }, 'room', room), b), [{ action: 'room-relay', rid: 'x', 'failure reason': 'unknown lane' }], 'a socket that left cannot relay');
  assert.deepEqual(to(relayTo(w, a, frameOf(8), { rid: 'x' }, 'room', room), b), [], 'and hears nothing');
  // no rid: the others are told, the sender is not answered
  const quiet = say(w, c, { action: 'room-leave', lane: room });
  assert.deepEqual(to(quiet, c), []);
  assert.deepEqual(to(quiet, a), [{ action: 'room-left', lane: room, peers: 0 }]);
  // not a member: nothing to leave, nobody is told; a bad lane is a failure
  const nothing = say(w, c, { action: 'room-leave', lane: room, rid: 'again' });
  assert.deepEqual(nothing.replies, [[c, { action: 'room-leave', lane: room, rid: 'again' }]]);
  assert.equal(nothing.changed, false);
  fails(say(w, c, { action: 'room-leave', lane: 'nope', rid: 'bad' }), c, 'invalid lane');
  // the last member leaves: the record is deleted
  say(w, a, { action: 'room-leave', lane: room });
  assert.equal(w.p.stats().relays, 0);
  // a socket that closes leaves every lane it joined, and each lane's others are told
  const w2 = relayWorld();
  const [x, y, z] = ['x', 'y', 'z'].map(conn);
  w2.known.set(laneN(5), T0 + LANE_TTL_MS);
  joinLane(w2, x);
  joinLane(w2, y);
  joinLane(w2, x, {}, 'pair', laneN(5));
  joinLane(w2, z, {}, 'pair', laneN(5));
  const gone = w2.p.close(x);
  assert.deepEqual(to(gone, y), [{ action: 'pair-left', lane: LANE, peers: 0 }]);
  assert.deepEqual(to(gone, z), [{ action: 'pair-left', lane: laneN(5), peers: 0 }]);
  assert.equal(gone.length, 2);
  assert.equal(w2.p.stats().relays, 2, 'both lanes still have a member');
  w2.p.close(y);
  w2.p.close(z);
  assert.equal(w2.p.stats().relays, 0);
  assert.deepEqual(w2.p.takeTouched(), [], 'closed sockets are not listed');
});

test('relay ping: a pong for any ping, nothing changes; a ping that reaches this module counts toward messagesPerMin and toward no relay cap (DEC-2); the strings are the ones the platform answers without waking the object', () => {
  assert.equal(PAIR.PING_TEXT, '{"v":1,"action":"pair-ping"}');
  assert.equal(PAIR.PONG_TEXT, '{"action":"pair-pong"}');
  assert.deepEqual(JSON.parse(PAIR.PING_TEXT), { v: 1, action: 'pair-ping' });
  const w = relayWorld({ relay: false });
  const a = conn('a');
  for (const msg of [{ v: 1, action: 'pair-ping' }, { action: 'pair-ping' }, { v: 2, action: 'pair-ping' }, { v: 1, action: 'pair-ping', rid: 'p' }, { v: 1, action: 'pair-ping', rid: 7, junk: [1] }]) {
    const r = w.p.message(a, msg);
    assert.deepEqual(r, { replies: [[a, { action: 'pair-pong' }]], changed: false, problem: null }, JSON.stringify(msg));
  }
  assert.equal(w.p.stats().codes + w.p.stats().knocks, 0);
  // DECISIONS DEC-2: on the Worker only the exact PING_TEXT is answered by the platform without waking the object; a ping of any other
  // shape wakes it and reaches this module, so it counts toward the socket's messages a minute like any message (a flood of near misses
  // closes the socket like a flood of anything else), and toward no relay cap. The Node tracker has no auto-response: every ping counts there.
  const w2 = relayWorld();
  const [c, d] = ['c', 'd'].map(conn);
  joinLane(w2, c); // message 1
  joinLane(w2, d);
  for (let i = 0; i < 120; i++) assert.deepEqual(to(say(w2, c, { action: 'pair-ping', junk: i }), c), [{ action: 'pair-pong' }]); // messages 2 to 121
  assert.equal(only(relayTo(w2, c, frameOf(8), { rid: 'r' }), c).peers, 1, 'after 120 pings the first relay goes through: pings count toward no relay cap'); // 122
  assert.deepEqual([w2.p.stats().relayRate, w2.p.stats().relayed], [0, 1]);
  for (let i = 0; i < 28; i++) assert.equal(say(w2, c, { action: 'pair-ping' }).close, undefined); // 123 to 150
  const over = say(w2, c, { action: 'pair-ping' }); // the 151st
  assert.equal(over.close, 'too many messages', 'the 151st message of the minute is a ping: the host closes the socket all the same');
  assert.deepEqual(to(over, c), [{ action: 'pair-ping', 'failure reason': 'too many messages' }], 'told why, once, and no pong');
  assert.deepEqual(to(over, d), []);
  assert.deepEqual([w2.p.stats().relayed, w2.p.stats().relayRate, w2.p.stats().relays], [1, 0, 1], 'no relay counter moved for a ping');
  // a page pings once every 50 seconds: 1.2 a minute against 150. A thousand of them over 14 hours never come near the cap.
  const w3 = relayWorld();
  const e = conn('e');
  for (let i = 0; i < 1000; i++) { assert.equal(say(w3, e, { action: 'pair-ping' }).close, undefined); w3.tick(50 * 1000); }
});

test('relay off (relay: false): join, relay and leave all say so, nothing is kept, a ping still gets its pong; each refused join is counted', () => {
  const w = relayWorld({ relay: false });
  const a = conn('a');
  for (const action of ['pair-join', 'room-join', 'pair-relay', 'room-relay', 'pair-leave', 'room-leave']) {
    const r = say(w, a, { action, lane: LANE, f: frameOf(8), rid: 'o' });
    assert.deepEqual(r.replies, [[a, { action, rid: 'o', 'failure reason': 'relay is off on this rendezvous' }]], action);
    assert.equal(r.changed, false);
  }
  assert.equal(w.p.stats().joinsRefused, 2, 'only joins are counted: the two join forms');
  assert.equal(w.p.stats().relays, 0);
  assert.deepEqual(to(say(w, a, { action: 'pair-ping' }), a), [{ action: 'pair-pong' }]);
  // the other half of the protocol is untouched
  assert.equal(only(say(w, a, { action: 'pair-open', channel: 'abcd', box: BOX }), a).action, 'pair-open');
});

test('relay saved state: attachmentOf lists the lanes as l (absent when there are none); attach rebuilds the membership after a wake and drops what is gone', () => {
  const w = relayWorld();
  const [a, b] = ['a', 'b'].map(conn);
  assert.equal('l' in w.p.attachmentOf(a), false, 'a socket in no lane keeps the older shape');
  joinLane(w, a);
  w.known.set(laneN(4), T0 + LANE_TTL_MS);
  joinLane(w, a, {}, 'room', laneN(4));
  joinLane(w, b);
  assert.deepEqual(w.p.attachmentOf(a), { c: [], q: [], l: [[LANE, 'pair'], [laneN(4), 'room']] });
  const savedA = JSON.parse(JSON.stringify(w.p.attachmentOf(a)));
  const savedB = JSON.parse(JSON.stringify(w.p.attachmentOf(b)));

  // the object slept and is rebuilt: the host knows the lane again (restored from storage) and hands the sockets their saved state
  const w2 = world();
  w2.known.set(LANE, T0 + LANE_TTL_MS);
  w2.known.set(laneN(4), T0 + LANE_TTL_MS);
  w2.tick(3 * MIN);
  const [a2, b2] = ['a2', 'b2'].map(conn);
  assert.deepEqual(w2.p.attach(a2, savedA), []);
  assert.deepEqual(w2.p.attach(b2, savedB), []);
  assert.equal(w2.p.stats().relays, 2);
  assert.deepEqual(w2.p.attachmentOf(a2), savedA);
  assert.deepEqual(to(relayTo(w2, a2, frameOf(8), { rid: 'r' }), b2), [{ action: 'pair-relayed', lane: LANE, f: frameOf(8) }], 'the sockets are members again without joining');
  assert.equal(only(relayTo(w2, a2, frameOf(8), { rid: 'r' }), a2).peers, 1);
  assert.deepEqual(w2.p.takeTouched(), [], 'a clean restore moves nothing');
  const third = conn('c');
  fails(joinLane(w2, third), third, 'lane full');
});

test('relay saved state: a lane the host says is gone is dropped quietly and the socket is marked for rewriting; junk is ignored; at most 8 entries are read; relay off ignores them', () => {
  const w = world();
  w.known.set(LANE, T0 + LANE_TTL_MS);
  const a = conn('a');
  w.p.attach(a, { l: [[LANE, 'pair'], [laneN(9), 'pair']] });
  assert.deepEqual(w.p.attachmentOf(a).l, [[LANE, 'pair']], 'the lane nobody minted was dropped');
  assert.deepEqual(w.p.takeTouched(), [a], 'and the host rewrites the saved state without it');
  const junk = conn('junk');
  w.p.attach(junk, { l: 'nope' });
  w.p.attach(junk, { l: [null, 5, ['zz'], [LANE], [LANE, 'moon'], [LANE.toUpperCase(), 'pair'], { 0: LANE }] });
  assert.equal('l' in w.p.attachmentOf(junk), false);
  const lots = conn('lots');
  const nine = [];
  for (let i = 1; i <= 9; i++) { w.known.set(laneN(i), T0 + LANE_TTL_MS); nine.push([laneN(i), 'pair']); }
  w.p.attach(lots, { l: nine });
  assert.equal(w.p.attachmentOf(lots).l.length, 8, 'a socket never holds more than 8 lanes, whatever its saved state says');
  // a lane of another kind than the record the first socket made is not joined
  const kinds = conn('kinds');
  w.p.attach(kinds, { l: [[laneN(1), 'room']] });
  assert.equal('l' in w.p.attachmentOf(kinds), false);
  // a full lane stays full
  const [p1, p2, p3] = ['p1', 'p2', 'p3'].map(conn);
  w.known.set(laneN(20), T0 + LANE_TTL_MS);
  for (const p of [p1, p2, p3]) w.p.attach(p, { l: [[laneN(20), 'pair']] });
  assert.deepEqual([p1, p2, p3].map((p) => 'l' in w.p.attachmentOf(p)), [true, true, false], 'a pair lane takes two');
  const off = world({ relay: false });
  off.known.set(LANE, T0 + LANE_TTL_MS);
  const o = conn('o');
  off.p.attach(o, { l: [[LANE, 'pair']] });
  assert.equal('l' in off.p.attachmentOf(o), false);
  assert.deepEqual(off.p.takeTouched(), [o], 'the stale entry is rewritten away');
});

test('relay saved state: 8 lanes beside 5 codes and 8 pending knocks stay under the 2 KB limit of a socket attachment', () => {
  const w = world();
  const a = conn('a');
  say(w, a, { action: 'pair-open', channel: 'pr22', box: BOX });
  for (let i = 0; i < 4; i++) say(w, a, { action: 'room-open', channel: 'rm' + (2 + i) + '2', box: BOX });
  const owners = Array.from({ length: 8 }, (_, i) => conn('o' + i));
  owners.forEach((o, i) => say(w, o, { action: 'pair-open', channel: 'pp' + (2 + i) + '2', box: BOX }));
  owners.forEach((o, i) => say(w, a, { action: 'pair-knock', channel: 'pp' + (2 + i) + '2', box: BOX }));
  for (let i = 1; i <= 8; i++) { w.known.set(laneN(i), T0 + LANE_TTL_MS); joinLane(w, a, {}, i % 2 ? 'pair' : 'room', laneN(i)); }
  const att = w.p.attachmentOf(a);
  assert.deepEqual([att.c.length, att.q.length, att.l.length], [5, 8, 8], 'the worst case: every part at its cap');
  const stored = JSON.stringify({ k: 'pair', t: 1700000000, ...att });
  assert.ok(stored.length < 2048, 'the worst case is ' + stored.length + ' bytes of JSON');
  assert.ok(stored.length < 1300, 'and it leaves room for the structured-clone overhead: ' + stored.length);
});

test('relay: a lane that runs out is dropped by the sweep, its members are marked for rewriting and nobody is pushed; the next expiry counts lanes in use', () => {
  const w = relayWorld();
  const [a, b] = ['a', 'b'].map(conn);
  joinLane(w, a);
  joinLane(w, b);
  w.p.takeTouched();
  assert.equal(w.p.nextExpiry(), T0 + LANE_TTL_MS, 'a lane in use is a thing that runs out');
  w.tick(LANE_TTL_MS - 1);
  assert.deepEqual(w.p.sweep(w.now()), []);
  assert.equal(w.p.stats().relays, 1, 'not yet');
  w.tick(1);
  assert.deepEqual(w.p.sweep(w.now()), [], 'the members are not told: the lane is dead, their next relay finds no lane');
  assert.equal(w.p.stats().relays, 0);
  assert.deepEqual(w.p.takeTouched().sort((x, y) => x.name.localeCompare(y.name)), [a, b]);
  assert.equal('l' in w.p.attachmentOf(a), false);
  fails(relayTo(w, a, frameOf(8), { rid: 'x' }), a, 'unknown lane');
  assert.equal(w.p.nextExpiry(), Infinity);
});

test('relay stats: the nine fields, counts, a UTC day and the moment the counts began; no lane, no frame', () => {
  const w = relayWorld();
  const [a, b] = ['a', 'b'].map(conn);
  assert.deepEqual(w.p.stats(), { codes: 0, knocks: 0, relays: 0, relayed: 0, relayBytes: 0, relayDay: 20231114, relaySince: T0, relayBusy: 0, relayRate: 0, joinsRefused: 0, evicted: 0 });
  joinLane(w, a);
  joinLane(w, b);
  relayTo(w, a, frameOf(100, 'Q'));
  relayTo(w, b, frameOf(23, 'Q'), { rid: 'r' });
  const c = conn('c');
  fails(joinLane(w, c), c, 'lane full');
  const s = w.p.stats();
  assert.deepEqual(relayFields.map((k) => typeof s[k]), Array(relayFields.length).fill('number'));
  assert.deepEqual([s.relays, s.relayed, s.relayBytes, s.joinsRefused], [1, 2, 123, 1]);
  const text = JSON.stringify(s);
  assert.equal(text.includes(LANE), false);
  assert.equal(text.includes('QQQQ'), false);
});

test('relay privacy: a relay writes nothing to storage, the module has no log and no import, and a frame comes out exactly as it went in', () => {
  const w = relayWorld();
  const [a, b] = ['a', 'b'].map(conn);
  joinLane(w, a);
  joinLane(w, b);
  const f = 'A-_' + 'Zm9vYmFy'.repeat(40);
  const out = relayTo(w, a, f);
  assert.deepEqual(out.replies, [[b, { action: 'pair-relayed', lane: LANE, f }]], 'the frame is passed on as the same string, once, to the other member');
  assert.equal(out.replies[0][1].f, f);
  say(w, b, { action: 'pair-leave', lane: LANE });
  assert.deepEqual(w.ops, [], 'the relay keeps no row and no frame');
  const src = readFileSync(new URL('../../deploy/rtc-worker/pair.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((line) => (/^\s*\/\//.test(line) ? '' : line.replace(/\s\/\/\s.*$/, ''))).join('\n');
  assert.equal(/\bconsole\b|\bfetch\s*\(|\bimport\b|\brequire\s*\(|\bprocess\b|\blocalStorage\b/.test(code), false, 'pure state machine: no log, no import, no platform');
  assert.equal(/[^\x00-\x7f]/.test(src), false, 'deploy is pure ASCII');
  assert.equal(/^import\b/m.test(src), false, 'zero imports: the Docker images copy this one file');
});

test('relay without a laneExpiry from the host: the lanes the core minted itself are the ones it knows', () => {
  const w = world({ hostExpiry: false });
  const [o, r, x] = ['o', 'r', 'x'].map(conn);
  say(w, o, { action: 'pair-open', channel: 'abcd', box: BOX });
  const knock = only(say(w, r, { action: 'pair-knock', channel: 'abcd', box: BOX }), r).knock;
  const lane = only(say(w, o, { action: 'pair-accept', proof: PROOF, knock }), o).lane;
  assert.equal(only(joinLane(w, o, {}, 'pair', lane), o).peers, 0);
  assert.deepEqual(to(joinLane(w, r, {}, 'pair', lane), o), [{ action: 'pair-joined', lane, peers: 1 }]);
  fails(joinLane(w, x, {}, 'pair', laneN(1)), x, 'unknown lane');
  fails(joinLane(w, x, {}, 'pair', lane), x, 'lane full');
  w.tick(LANE_TTL_MS);
  w.p.sweep(w.now());
  fails(joinLane(w, x, {}, 'pair', lane), x, 'unknown lane');
  // a room's lane is minted at open
  const rm = only(say(w, o, { action: 'room-open', channel: 'rm22', box: BOX }), o).lane;
  assert.equal(only(joinLane(w, o, {}, 'room', rm), o).peers, 0);
  // a host that refused the lane never lets it be joined
  const refuse = world({ hostExpiry: false, refuseLanes: true });
  const [ro, rr] = ['ro', 'rr'].map(conn);
  say(refuse, ro, { action: 'pair-open', channel: 'abcd', box: BOX });
  const k2 = only(say(refuse, rr, { action: 'pair-knock', channel: 'abcd', box: BOX }), rr).knock;
  fails(say(refuse, ro, { action: 'pair-accept', proof: PROOF, knock: k2 }), ro, 'too many lanes');
  assert.equal(refuse.p.stats().relays, 0);
});

test('relay: pair-ping, pair-join and the rest are pair actions; the first frame of a socket classifies it as a pair socket', () => {
  for (const action of ['pair-ping', 'pair-join', 'pair-relay', 'pair-leave', 'room-join', 'room-relay', 'room-leave']) assert.equal(isPairAction(action), true, action);
  for (const action of ['pair-joined', 'pair-relayed', 'pair-left', 'pair-pong']) assert.equal(isPairAction(action), true, action + ' (a push name is a pair action too: a client sending it gets invalid action)');
  const w = relayWorld();
  const a = conn('a');
  for (const action of ['pair-joined', 'pair-relayed', 'pair-left', 'pair-pong', 'room-pong']) fails(say(w, a, { action, lane: LANE, f: frameOf(8), rid: 'p' }), a, 'invalid action');
  assert.equal(PAIR.isRelayAction('pair-join') && PAIR.isRelayAction('room-relay') && PAIR.isRelayAction('pair-leave') && PAIR.isRelayAction('pair-ping'), true);
  for (const action of ['pair-open', 'room-knock', 'pair-accept', 'announce', 'pair-joined', undefined, null, 5]) assert.equal(PAIR.isRelayAction(action), false, String(action));
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
  assert.deepEqual(noRelay(h2.r.stats()), { open: false, uploads: false, allowed: 1, swarms: 0, unlisted: 0, peers: 0, sockets: 2, interval: 120, codes: 1, knocks: 1, lanes: 0 });
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
  // and the relay has nothing to run on: its frames are answered the same way, its counts are zero for today
  const j = h.r.message(conn('j'), frame({ action: 'pair-join', lane: LANE, rid: 'j' }));
  assert.equal(j.problem, 'pairing is off on this rendezvous');
  const s = h.r.stats();
  assert.deepEqual(relayFields.map((k) => s[k]), [0, 0, 0, 20231114, T0, 0, 0, 0, 0]);
  // the counts began when the rendezvous was built; once the UTC day has changed they began at 00:00 UTC of the day read (finding A F3)
  h.tick(2 * HOUR); // 00:13 UTC on the 15th
  const next = h.r.stats();
  assert.deepEqual([next.relayDay, next.relaySince], [20231115, Date.UTC(2023, 10, 15)]);
});

// ---------------------------------------------------------------------------------------------- the relay lane inside rtc.js

/** Opens a code on a, knocks from b and accepts: the rendezvous has minted a lane that both sockets know. */
function minted(h) {
  const a = conn('a');
  const b = conn('b');
  h.r.message(a, frame({ action: 'pair-open', channel: 'abcd', box: BOX }));
  h.r.message(b, frame({ action: 'pair-knock', channel: 'abcd', box: boxOf('Q') }));
  const knock = b.take()[0].knock;
  a.take();
  h.r.message(a, frame({ action: 'pair-accept', proof: PROOF, knock }));
  const lane = a.take()[0].lane;
  b.take();
  return { a, b, lane };
}
const joinFrame = (lane, extra = {}, kind = 'pair') => frame(Object.assign({ action: kind + '-join', lane }, extra));
const relayFrame = (lane, f, extra = {}, kind = 'pair') => frame(Object.assign({ action: kind + '-relay', lane, f }, extra));

test('rtc.js relay: a lane the rendezvous minted can be joined and relayed on, one nobody minted cannot, and the lane\'s 24 hours end it', () => {
  const h = rendezvous();
  const { a, b, lane } = minted(h);
  const x = conn('x');
  const miss = h.r.message(x, joinFrame(laneN(1), { rid: 'j' }));
  assert.equal(miss.problem, 'unknown lane');
  assert.deepEqual(x.take(), [{ action: 'pair-join', rid: 'j', 'failure reason': 'unknown lane' }]);
  const ja = h.r.message(a, joinFrame(lane, { rid: 'j1' }));
  assert.deepEqual([ja.changed, ja.pair, ja.relay, ja.problem], [true, true, true, null], 'a join moves the saved state of the socket; the host may leave its alarm alone');
  assert.equal(ja.close, undefined);
  assert.deepEqual(a.take(), [{ action: 'pair-join', lane, peers: 0, rid: 'j1' }]);
  h.r.message(b, joinFrame(lane));
  assert.deepEqual(a.take(), [{ action: 'pair-joined', lane, peers: 1 }]);
  assert.equal(b.take()[0].peers, 1);
  const f = 'Zm9v-_' + 'A'.repeat(100);
  const rel = h.r.message(a, relayFrame(lane, f, { rid: 'r' }));
  assert.deepEqual([rel.changed, rel.relay, rel.problem], [false, true, null]);
  assert.deepEqual(b.take(), [{ action: 'pair-relayed', lane, f }]);
  assert.deepEqual(a.take(), [{ action: 'pair-relay', lane, peers: 1, rid: 'r' }]);
  assert.equal(h.r.message(a, frame({ action: 'pair-open', channel: 'wxyz', box: BOX })).relay, undefined, 'a frame that is not a relay action carries no relay flag');
  // nothing about the relay reaches storage; the lane row is the one the accept wrote
  assert.deepEqual(h.ops.filter((o) => !o[1].startsWith('chan:') && !o[1].startsWith('lane:')), []);
  // the lane runs out: the sweep drops the relay with it and a relay finds no lane (the sweep tells nobody)
  a.take();
  h.tick(LANE_TTL_MS);
  const swept = h.r.sweep(h.now());
  assert.ok(swept.touched.includes(b) && swept.touched.includes(a), 'the saved states moved: the lane is gone from them');
  assert.deepEqual(b.take(), []);
  assert.equal(h.r.stats().relays, 0);
  assert.equal('l' in h.r.attachmentOf(b), false);
  const late = h.r.message(a, relayFrame(lane, f, { rid: 'late' }));
  assert.equal(late.problem, 'unknown lane');
});

test('rtc.js relay: relayLane false (RELAY_LANE "0") answers every join and relay with "relay is off on this rendezvous" and keeps pairing as it was', () => {
  const on = rendezvous();
  assert.equal(on.r.message(conn('p'), joinFrame(laneN(1))).problem, 'unknown lane', 'on by default');
  const off = rendezvous({ relayLane: false });
  const { a, b, lane } = minted(off);
  for (const [text, why] of [[joinFrame(lane, { rid: 'j' }), 'relay is off on this rendezvous'], [relayFrame(lane, 'abcd', { rid: 'r' }), 'relay is off on this rendezvous'], [frame({ action: 'room-leave', lane, rid: 'l' }), 'relay is off on this rendezvous']]) {
    const res = off.r.message(a, text);
    assert.equal(res.problem, why);
    assert.equal(res.changed, false);
  }
  assert.deepEqual(a.take().map((m) => m['failure reason']), Array(3).fill('relay is off on this rendezvous'));
  assert.equal(off.r.stats().joinsRefused, 1);
  assert.equal(off.r.stats().codes, 1, 'the code the owner opened is still there');
  assert.equal(b.take().length, 0);
});

test('rtc.js relay: seen(conn, ms) is how a ping the platform answered keeps a socket from looking idle; it never moves a time back', () => {
  const h = rendezvous();
  const { lane } = minted(h);
  const x = conn('x');
  const y = conn('y');
  h.r.message(x, joinFrame(lane));
  h.r.message(y, joinFrame(lane));
  h.tick((PEER_TTL_S - 60) * 1000);
  assert.equal(h.r.stale(x, h.now()), false);
  h.r.seen(x, h.now()); // x pinged a moment ago: the platform answered it without waking the object
  h.tick(120 * 1000);
  assert.equal(h.r.stale(x, h.now()), false, 'it pinged two minutes ago');
  assert.equal(h.r.stale(y, h.now()), true, 'the one that sent nothing for 21 minutes is idle');
  h.r.seen(x, 0);
  h.r.seen(x, NaN);
  h.r.seen(x, 'soon');
  h.r.seen(conn('nobody'), h.now());
  assert.equal(h.r.stale(x, h.now()), false, 'a time in the past, or not a time, changes nothing');
  h.tick(PEER_TTL_S * 1000);
  assert.equal(h.r.stale(x, h.now()), true, 'and a socket that stops pinging is idle after 20 minutes like any other');
  assert.equal(typeof h.r.seen, 'function');
});

test('rtc.js relay (DEC-1): a member\'s liveness is its st.last, the later of its last message and seen(); the host\'s probe runs for the members of the full lane only; the evicted conn comes back in the result; stats carry evicted', () => {
  const probed = [];
  const h = rendezvous({ probe: (c) => probed.push(c.name) });
  const { a, b, lane } = minted(h);
  const x = conn('x');
  const y = conn('y');
  h.r.message(x, joinFrame(lane));
  h.r.message(y, joinFrame(lane));
  x.take();
  y.take();
  h.tick(3 * 60 * 1000);
  h.r.seen(x, h.now() - 30 * 1000); // the platform answered x's ping half a minute ago (worker.js reads it in the probe); y neither pinged nor sent
  probed.length = 0;
  const z = conn('z');
  const res = h.r.message(z, joinFrame(lane, { rid: 'j' }));
  assert.deepEqual(probed.sort(), ['x', 'y'], 'the probe ran for the two members of that lane: not for the code owner a, the knocker b or the joiner z');
  assert.deepEqual([res.pair, res.relay, res.changed, res.problem], [true, true, true, null]);
  assert.deepEqual(res.evicted, [y], 'the host closes y with code 1000 and releases it');
  assert.deepEqual(z.take(), [{ action: 'pair-join', lane, peers: 1, rid: 'j' }]);
  assert.deepEqual(x.take(), [{ action: 'pair-left', lane, peers: 0 }, { action: 'pair-joined', lane, peers: 1 }]);
  assert.deepEqual(y.take(), []);
  assert.equal(h.r.stats().evicted, 1);
  assert.equal('l' in h.r.attachmentOf(y), false, 'the saved state of y shows no lane');
  // the host's close path, as worker.js and the tracker run it: nothing of y is left in the lane
  assert.deepEqual(h.r.close(y), { touched: [] });
  assert.equal(h.r.stats().sockets, 4, 'a, b, x and z');
  assert.deepEqual([a.take(), b.take()], [[], []], 'the pairing sockets heard nothing of it');
  // a member that sent a frame is as alive as one that pinged: the next newcomer finds the lane full, and only the two members are probed
  probed.length = 0;
  h.tick(3 * 60 * 1000);
  h.r.message(x, relayFrame(lane, 'abcd'));
  h.r.seen(z, h.now());
  z.take();
  const w = conn('w');
  assert.equal(h.r.message(w, joinFrame(lane, { rid: 'k' })).problem, 'lane full');
  assert.deepEqual(probed.sort(), ['x', 'z']);
  assert.deepEqual([h.r.stats().evicted, h.r.stats().joinsRefused, h.r.stats().relays], [1, 1, 1]);
  assert.equal(JSON.stringify(h.r.stats()).includes(lane), false);
});

test('rtc.js relay: the saved state of a socket carries its lanes as l, and a wake gives the membership back', () => {
  const h = rendezvous();
  const { lane } = minted(h);
  const x = conn('x');
  const y = conn('y');
  h.r.message(x, joinFrame(lane));
  h.r.message(y, joinFrame(lane));
  const savedX = JSON.parse(JSON.stringify(h.r.attachmentOf(x)));
  const savedY = JSON.parse(JSON.stringify(h.r.attachmentOf(y)));
  assert.deepEqual(savedX, { k: 'pair', c: [], q: [], l: [[lane, 'pair']], t: Math.floor(T0 / 1000) });
  assert.ok(JSON.stringify(savedX).length < 2048);
  const rows = new Map();
  for (const [kind, key, value] of h.ops) { if (kind === 'put') rows.set(key, JSON.parse(JSON.stringify(value))); else rows.delete(key); }
  const part = (prefix) => new Map(Array.from(rows).filter(([key]) => key.startsWith(prefix)));
  const h2 = rendezvous();
  h2.tick(3 * MIN);
  h2.r.restore({ chans: part('chan:'), lanes: part('lane:') });
  const x2 = conn('x2');
  const y2 = conn('y2');
  h2.r.attach(x2, savedX);
  h2.r.attach(y2, savedY);
  assert.equal(h2.r.stats().relays, 1);
  assert.equal(h2.r.stats().sockets, 2);
  assert.equal(h2.r.message(x2, relayFrame(lane, 'abcd', { rid: 'r' })).problem, null, 'a member again without joining');
  assert.deepEqual(y2.take(), [{ action: 'pair-relayed', lane, f: 'abcd' }]);
  assert.deepEqual(x2.take(), [{ action: 'pair-relay', lane, peers: 1, rid: 'r' }]);
  // a saved state that holds only l is a pair socket's all the same
  const lone = conn('lone');
  h2.r.attach(lone, { l: [[lane, 'pair']] });
  assert.equal(h2.r.attachmentOf(lone).k, 'pair');
  assert.equal('l' in h2.r.attachmentOf(lone), false, 'the lane is full (x2 and y2 are in it)');
  // a socket closing leaves its lane and tells the other
  h2.r.close(y2);
  assert.deepEqual(x2.take(), [{ action: 'pair-left', lane, peers: 0 }]);
});

test('rtc.js relay: the counts are in stats() beside the older ones; a frame of 7,512 characters passes the size guard, one of 8,100 does not', () => {
  const h = rendezvous();
  const { a, b, lane } = minted(h);
  h.r.message(a, joinFrame(lane));
  h.r.message(b, joinFrame(lane));
  a.take();
  b.take();
  const widest = 'x'.repeat(7512);
  assert.equal(h.r.message(a, relayFrame(lane, widest, { rid: 'r1234567' })).problem, null);
  assert.equal(Buffer.byteLength(relayFrame(lane, widest, { rid: 'r1234567' })), 7615);
  assert.deepEqual(b.take(), [{ action: 'pair-relayed', lane, f: widest }]);
  a.take();
  const wide = relayFrame(lane, 'x'.repeat(8100), { rid: 'w' });
  assert.ok(Buffer.byteLength(wide) > MAX_PAIR_BYTES);
  assert.equal(h.r.message(a, wide).problem, 'message too large');
  assert.deepEqual(a.take(), [{ 'failure reason': 'message too large' }], 'a pair socket gets the refusal before any parsing');
  assert.equal(h.r.message(a, relayFrame(lane, 'x'.repeat(7701), { rid: 'e' })).problem, 'invalid frame');
  const s = h.r.stats();
  assert.deepEqual(noRelay(s), { open: false, uploads: false, allowed: 1, swarms: 0, unlisted: 0, peers: 0, sockets: 2, interval: 120, codes: 1, knocks: 0, lanes: 1 });
  assert.deepEqual(relayFields.map((k) => s[k]), [1, 1, 7512, 20231114, T0, 0, 0, 0, 0]);
  assert.equal(JSON.stringify(s).includes(lane), false, 'the counts name no lane');
});

test('rtc.js relay: the 151st message returns close (the host closes the socket with 1008); a ping as the first frame makes a pair socket like any pair action', () => {
  const h = rendezvous();
  const flood = conn('flood');
  const first = h.r.message(flood, frame({ action: 'pair-ping' }));
  assert.deepEqual([first.changed, first.pair, first.relay, first.problem], [true, true, true, null], 'the first frame classified the socket, so its saved state moved');
  assert.deepEqual(flood.take(), [{ action: 'pair-pong' }]);
  assert.equal(h.r.message(flood, announce(A_HASH, peer('f'))).problem, MIXED, 'a pair socket cannot announce');
  flood.take();
  // the ping was message 1 (DECISIONS DEC-2: a ping that reaches the core counts); the refused announce never reached it; 149 joins make 150
  for (let i = 0; i < 149; i++) assert.equal(h.r.message(flood, joinFrame(laneN(1))).close, undefined);
  flood.take();
  const res = h.r.message(flood, joinFrame(laneN(1), { rid: 'x' }));
  assert.equal(res.close, 'too many messages');
  assert.equal(res.problem, 'too many messages');
  assert.deepEqual(flood.take(), [{ action: 'pair-join', rid: 'x', 'failure reason': 'too many messages' }]);
  // a join as the first frame classifies a socket too, and a tracker frame after it is refused
  const joiner = conn('joiner');
  assert.equal(h.r.message(joiner, joinFrame(laneN(2))).pair, true);
  assert.equal(h.r.message(joiner, announce(A_HASH, peer('j'))).problem, MIXED);
});
