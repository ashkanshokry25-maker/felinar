// Unit tests for src/calls/signal.js (SZ 3.5 "Signalling"): the SIG body codec and its bounds, the golden vectors in
// test/vectors/calls.json, duplicates and replays by (call, seq) and t, ring limits, buckets, fingerprints and the
// 'mw-call' control messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  encodeSignal, decodeSignal, validateSignal, SignalGuard, RingLimiter, bucketFor, fingerprintsOf, normalizeFingerprint,
  checkSdp, newCallId, isCallId, isGroupId, encodeControl, decodeControl, validateControl,
} from '../../src/calls/signal.js';
import { PAYLOAD_MAX, SDP_MAX, CAND_MAX, ROSTER_MAX, RING_TTL_MS, T_SKEW_MS, CONTROL_MAX } from '../../src/calls/limits.js';
import { utf8 } from '../../src/chain/canonical.js';
import { generateKeyPair, exportPublicKey } from '../../src/chain/crypto.js';

const VEC = JSON.parse(readFileSync(fileURLToPath(new URL('../vectors/calls.json', import.meta.url)), 'utf8'));
const byId = (id) => VEC.vectors.find((v) => v.id === id);
const CALL = 'AAECAwQFBgcICQoLDA0ODw';
const T = 1760961600000;
const FP = 'D2:3A:9C:41:7E:05:B8:6F:10:C4:2D:93:E7:58:AA:01:6B:F2:3C:84:19:D0:5E:A7:42:BB:0C:91:E6:73:28:5F';
const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=fingerprint:sha-256 ' + FP + '\r\na=mid:0\r\n';
const base = (k, extra = {}) => Object.assign({ v: 1, c: CALL, k, s: 1, t: T }, extra);

async function pubs(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(await exportPublicKey((await generateKeyPair()).publicKey));
  return out;
}

test('golden vectors: every positive body encodes to its bytes, decodes back, and lands in its bucket', () => {
  const positives = VEC.vectors.filter((v) => v.id.startsWith('calls-sig-0'));
  assert.ok(positives.length >= 6);
  for (const v of positives) {
    const bytes = encodeSignal(v.input);
    assert.equal(utf8.decode(bytes), v.expect.json, v.id);
    assert.equal(bytes.length, v.expect.bytes, v.id);
    assert.equal(bucketFor(bytes.length), v.expect.bucket, v.id);
    const d = decodeSignal(bytes);
    assert.equal(d.ok, true, v.id);
    assert.deepEqual(d.msg, JSON.parse(v.expect.json), v.id);
  }
  for (const v of VEC.vectors.filter((x) => x.id.startsWith('calls-sig-neg-'))) {
    assert.deepEqual(decodeSignal(utf8.encode(v.input.text)), v.expect, v.id);
  }
  const b = byId('calls-bucket-001');
  assert.deepEqual(b.input.bytes.map(bucketFor), b.expect.buckets);
});

test('the key order is fixed (v, c, k, s, t, sdp, cand, media, roster, g) whatever order the caller used', () => {
  const a = encodeSignal({ g: 'grp_1', t: T, s: 3, k: 'leave', c: CALL, v: 1 });
  assert.equal(utf8.decode(a), '{"v":1,"c":"' + CALL + '","k":"leave","s":3,"t":' + T + ',"g":"grp_1"}');
});

test('every kind takes only its own fields; ring and accept need media, offer and answer an SDP, ice candidates', () => {
  const ok = (m) => assert.equal(validateSignal(m).ok, true, JSON.stringify(m).slice(0, 80));
  const bad = (m, reason) => assert.equal(validateSignal(m).reason, reason, JSON.stringify(m).slice(0, 80));
  ok(base('ring', { media: { a: true, v: false } }));
  ok(base('accept', { media: { a: true } }));
  ok(base('decline'));
  ok(base('busy'));
  ok(base('offer', { sdp: SDP }));
  ok(base('answer', { sdp: SDP, media: { a: true, v: true, s: true } }));
  ok(base('ice', { cand: ['candidate:1 1 udp 1 198.51.100.4 9 typ host'] }));
  ok(base('hangup', { g: 'Gx7k' }));
  ok(base('leave'));
  bad(base('ring'), 'missing:media');
  bad(base('accept'), 'missing:media');
  bad(base('ring', { media: { a: true }, sdp: SDP }), 'field:sdp');
  bad(base('decline', { media: { a: true } }), 'field:media');
  bad(base('ice', { sdp: SDP, cand: ['candidate:1 1 udp 1 198.51.100.4 9 typ host'] }), 'field:sdp');
  bad(base('offer'), 'missing:sdp');
  bad(base('answer', { cand: ['candidate:1'] }), 'field:cand');
  bad(base('ice'), 'missing:cand');
  bad(base('hangup', { roster: [] }), 'field:roster');
  bad(base('nope'), 'kind');
  bad(Object.assign(base('hangup'), { v: 2 }), 'version');
  bad(Object.assign(base('hangup'), { c: 'short' }), 'call-id');
  bad(Object.assign(base('hangup'), { s: -1 }), 'seq');
  bad(Object.assign(base('hangup'), { s: 1.5 }), 'seq');
  bad(Object.assign(base('hangup'), { t: '1' }), 't');
  bad(Object.assign(base('hangup'), { extra: 1 }), 'key:extra');
  bad(base('hangup', { g: 'bad group!' }), 'group');
  bad(base('hangup', { g: 'x'.repeat(65) }), 'group');
  bad([], 'shape');
  bad(null, 'shape');
});

test('SDP rules: v=0 first, at most 14,000 bytes, every fingerprint sha-256 and all equal', () => {
  assert.deepEqual(checkSdp(SDP), { ok: true, fingerprints: [FP] });
  assert.equal(checkSdp('o=- 1 2 IN IP4 x\r\na=fingerprint:sha-256 ' + FP).reason, 'sdp-version');
  assert.equal(checkSdp('v=0\r\nm=audio 9 x\r\n').reason, 'sdp-fingerprint');
  assert.equal(checkSdp('v=0\r\na=fingerprint:sha-1 ' + FP + '\r\n').reason, 'sdp-fingerprint');
  assert.equal(checkSdp('v=0\r\na=fingerprint:sha-256 ' + FP + '\r\na=fingerprint:sha-384 ' + FP + '\r\n').reason, 'sdp-fingerprint');
  assert.equal(checkSdp('v=0\r\na=fingerprint:sha-256 ' + FP + '\r\na=fingerprint:sha-256 ' + FP.replace('D2', 'AA') + '\r\n').reason, 'sdp-fingerprints-differ');
  assert.equal(checkSdp('v=0\r\na=fingerprint:sha-256 AB:CD\r\n').reason, 'sdp-fingerprint', 'a fingerprint is 32 bytes');
  const big = SDP + 'a=x:' + 'y'.repeat(SDP_MAX - SDP.length) + '\r\n';
  assert.ok(utf8.encode(big).length > SDP_MAX);
  assert.equal(checkSdp(big).reason, 'sdp-size');
  assert.equal(checkSdp('v=0\u0000\r\na=fingerprint:sha-256 ' + FP).reason, 'sdp-char');
  assert.deepEqual(fingerprintsOf('a=fingerprint:sha-256 ' + FP.toLowerCase()), [FP], 'case is normalized');
  assert.equal(normalizeFingerprint(FP.replace(/:/g, '').toLowerCase()), FP);
  assert.equal(normalizeFingerprint('zz'), null);
});

test('candidates: 1 to 16 strings, each candidate:..., at most 512 bytes, printable ASCII without line breaks', () => {
  const c = 'candidate:1 1 udp 2122260223 198.51.100.4 50001 typ host generation 0';
  assert.equal(validateSignal(base('ice', { cand: Array(CAND_MAX).fill(c) })).ok, true);
  assert.equal(validateSignal(base('ice', { cand: Array(CAND_MAX + 1).fill(c) })).reason, 'cand');
  assert.equal(validateSignal(base('ice', { cand: [] })).reason, 'cand');
  assert.equal(validateSignal(base('ice', { cand: ['a=candidate:1 1 udp 1 1.2.3.4 9 typ host'] })).reason, 'cand');
  assert.equal(validateSignal(base('ice', { cand: [c + '\r\na=fingerprint:sha-256 ' + FP] })).reason, 'cand');
  assert.equal(validateSignal(base('ice', { cand: ['candidate:' + 'x'.repeat(503)] })).reason, 'cand', '513 bytes');
  assert.equal(validateSignal(base('ice', { cand: ['candidate:' + 'x'.repeat(502)] })).ok, true, '512 bytes');
  assert.equal(validateSignal(base('ice', { cand: [42] })).reason, 'cand');
});

test('rosters: at most 5 distinct p256: keys; media flags are booleans', async () => {
  const keys = await pubs(6);
  assert.equal(validateSignal(base('ring', { media: { a: true }, roster: keys.slice(0, ROSTER_MAX) })).ok, true);
  assert.equal(validateSignal(base('ring', { media: { a: true }, roster: keys })).reason, 'roster');
  assert.equal(validateSignal(base('ring', { media: { a: true }, roster: [keys[0], keys[0]] })).reason, 'roster');
  assert.equal(validateSignal(base('ring', { media: { a: true }, roster: ['p256:nope'] })).reason, 'roster');
  assert.equal(validateSignal(base('ring', { media: { a: 'yes' } })).reason, 'media');
  assert.equal(validateSignal(base('ring', { media: { a: true, x: true } })).reason, 'media');
  assert.equal(validateSignal(base('ring', { media: [] })).reason, 'media');
});

test('size: the body is at most 15,000 bytes; encode refuses more with E_LIMIT, decode with size', () => {
  const cand = 'candidate:1 1 udp 1 198.51.100.4 9 typ host ' + 'x'.repeat(460);
  const msg = base('ice', { cand: Array(16).fill(cand) });
  assert.ok(encodeSignal(msg).length < PAYLOAD_MAX);
  // An SDP of 13,999 bytes plus the header goes over 15,000 once escaped.
  const sdp = SDP + 'a=x:' + '"'.repeat(SDP_MAX - SDP.length - 8) + '\r\n';
  assert.ok(checkSdp(sdp).ok);
  let e = null;
  try { encodeSignal(base('offer', { sdp })); } catch (err) { e = err; }
  assert.equal(e && e.code, 'E_LIMIT');
  assert.equal(decodeSignal(new Uint8Array(PAYLOAD_MAX + 1)).reason, 'size');
  assert.equal(decodeSignal(new Uint8Array(0)).reason, 'size');
  assert.equal(decodeSignal(utf8.encode('{"v":1')).reason, 'json');
  assert.equal(decodeSignal(new Uint8Array([0xff, 0xfe])).reason, 'json', 'strict UTF-8');
  assert.equal(decodeSignal('not bytes but a string is fine: {').reason, 'json');
  assert.equal(decodeSignal(42).reason, 'bytes');
  assert.throws(() => encodeSignal({ v: 1 }), TypeError);
});

test('ids: call ids are 16 random bytes in b64url; group ids are b64url-like and at most 64 characters', () => {
  const a = newCallId();
  const b = newCallId();
  assert.notEqual(a, b);
  assert.ok(isCallId(a) && isCallId(b) && isCallId(CALL));
  assert.equal(isCallId(CALL + 'A'), false);
  assert.equal(isCallId('AAECAwQFBgcICQoLDA0OD+'), false);
  assert.equal(isCallId(42), false);
  assert.ok(isGroupId('Gx7k2QpZ9vB3nL0aT5mE1w'));
  assert.equal(isGroupId(''), false);
  assert.equal(isGroupId('a/b'), false);
});

test('SignalGuard: duplicates by (sender, call, seq) are dropped, t must be within 60 s, far-behind seqs are dropped', () => {
  let now = T;
  const g = new SignalGuard({ now: () => now });
  const m = (s, t = now, c = CALL) => ({ v: 1, c, k: 'ice', s, t });
  assert.equal(g.accept('p256:a', m(0)).ok, true);
  assert.equal(g.accept('p256:a', m(0)).reason, 'dup');
  assert.equal(g.accept('p256:b', m(0)).ok, true, 'another sender is its own sequence');
  assert.equal(g.accept('p256:a', m(0, now, 'AAAAAAAAAAAAAAAAAAAAAA')).ok, true, 'another call too');
  assert.equal(g.accept('p256:a', m(2)).ok, true);
  assert.equal(g.accept('p256:a', m(1)).ok, true, 'reordered on the way (relays wait 0.5 to 3 s): still taken once');
  assert.equal(g.accept('p256:a', m(1)).reason, 'dup');
  assert.equal(g.accept('p256:a', m(3, now - T_SKEW_MS - 1)).reason, 'skew');
  assert.equal(g.accept('p256:a', m(3, now + T_SKEW_MS + 1)).reason, 'skew');
  assert.equal(g.check('p256:a', m(3)).ok, true, 'check() records nothing');
  assert.equal(g.accept('p256:a', m(3)).ok, true);
  assert.equal(g.accept('p256:a', m(300)).ok, true);
  assert.equal(g.accept('p256:a', m(10)).reason, 'old');
  g.forget(CALL);
  assert.equal(g.accept('p256:a', m(0)).ok, true, 'forgotten');
  now += 1;
  assert.equal(g.accept(null, m(1)).reason, 'input');
});

test('RingLimiter: one pending ring per contact, at most 10 an hour; pending clears on done or after 45 s', () => {
  let now = T;
  const r = new RingLimiter({ now: () => now });
  assert.equal(r.add('p256:a', 'c1').ok, true);
  assert.equal(r.add('p256:a', 'c2').reason, 'pending');
  assert.equal(r.add('p256:b', 'c3').ok, true, 'another contact');
  r.done('p256:a', 'c1');
  for (let i = 0; i < 9; i++) {
    assert.equal(r.add('p256:a', 'x' + i).ok, true, 'ring ' + (i + 2));
    r.done('p256:a', 'x' + i);
  }
  assert.equal(r.add('p256:a', 'y').reason, 'rate', 'the 11th ring of the hour');
  now += 3600000;
  assert.equal(r.add('p256:a', 'y').ok, true, 'a new hour');
  now += RING_TTL_MS;
  assert.equal(r.check('p256:a').ok, true, 'a pending ring expires after 45 s');
});

test('control messages: state, roster, leave, desc, cand; JSON at most 16 KiB; strict fields', async () => {
  const keys = await pubs(2);
  for (const m of [{ t: 'state', mute: true, camera: false }, { t: 'roster', pubs: keys }, { t: 'leave' }, { t: 'desc', type: 'offer', sdp: SDP }, { t: 'cand', cand: ['candidate:1 1 udp 1 198.51.100.4 9 typ host'] }]) {
    const s = encodeControl(m);
    assert.deepEqual(decodeControl(s), { ok: true, msg: m });
    assert.deepEqual(decodeControl(utf8.encode(s)).msg, m, 'bytes too');
  }
  assert.equal(validateControl({ t: 'state', mute: 1 }).reason, 'state');
  assert.equal(validateControl({ t: 'roster' }).reason, 'roster');
  assert.equal(validateControl({ t: 'roster', pubs: keys, cks: [{ v: 2 }, 'x'] }).reason, 'cks');
  assert.equal(validateControl({ t: 'roster', pubs: keys, cks: [{ big: 'x'.repeat(500) }] }).reason, 'cks');
  assert.equal(validateControl({ t: 'desc', type: 'pranswer', sdp: SDP }).reason, 'desc-type');
  assert.equal(validateControl({ t: 'desc', type: 'answer', sdp: 'v=0' }).reason, 'sdp-fingerprint');
  assert.equal(validateControl({ t: 'leave', why: 'x' }).reason, 'key:why');
  assert.equal(validateControl({ t: 'chat', text: 'hi' }).reason, 'type');
  assert.equal(decodeControl('x'.repeat(CONTROL_MAX + 1)).reason, 'size');
  assert.equal(decodeControl('{').reason, 'json');
  assert.equal(decodeControl('').reason, 'type');
  assert.throws(() => encodeControl({ t: 'nope' }), TypeError);
  const v = byId('calls-control-001');
  assert.deepEqual(v.input.valid.map((m) => encodeControl(m)), v.expect.valid);
  assert.deepEqual(v.input.invalid.map((m) => validateControl(m).reason), v.expect.invalid);
});
