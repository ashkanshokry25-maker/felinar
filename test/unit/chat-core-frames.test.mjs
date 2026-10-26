// Unit tests for src/chat/frames.js and src/chat/stamp.js (R 2.7.3, MF-32, MF-43): U-CH-1 (codec bounds,
// every numeric field at 0, -1 and 2^53-1, malformed input strikes the wire) and U-CH-2 (frameId excludes the
// hop; the stamp binds the frame). node:crypto is used only as an independent SHA-256 oracle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { hex, utf8, b64url, concatBytes } from '../../src/chain/canonical.js';
import {
  T, decode, encode, frameId, withHop, withNonce, isOnCurve, helloBody, xxBody, envBody, roomBody, wantBody, heldBody,
  ckBody, holdingBody, collectedBody, presBody, ichalBody, irespBody,
} from '../../src/chat/frames.js';
import { check, mint, requiredBits, stampDigest, dayAcceptable, headerDay, utcDay } from '../../src/chat/stamp.js';
import { generateChatKey } from '../../src/chat/seal.js';
import { checkCkShape } from '../../src/chat/ck.js';
import { ChatLane } from '../../src/chat/lane.js';
import { publicKeyBytes } from '../../src/chain/crypto.js';
import { FRAME_MAX, CT_LENGTHS, ENV_FRAME_SIZES, FLAG_HOLD, FLAG_STRANGER, FLAG_PAD_ONLY, STRIKES_CLOSE } from '../../src/chat/limits.js';

const VECTORS = JSON.parse(readFileSync(new URL('../vectors/chat.json', import.meta.url), 'utf8'));
const vec = (id) => VECTORS.vectors.find((v) => v.id === id);
const MAX = Number.MAX_SAFE_INTEGER;
const DAY = 20381;
const NOW = DAY * 86400000 + 3600000;

function rand(n) {
  const u = new Uint8Array(n);
  globalThis.crypto.getRandomValues(u);
  return u;
}

let POINT;
async function point() {
  if (!POINT) POINT = publicKeyBytes((await generateChatKey()).pub);
  return POINT;
}

async function sampleFrames() {
  const p = await point();
  const env = envBody({ tag: rand(8), epk: p, iv: rand(12), ct: rand(272) });
  const envFrame = encode(T.ENV, { day: DAY % 65536, flags: FLAG_HOLD }, env);
  const pub = 'p256:' + b64url.encode(p);
  return {
    [T.HELLO]: helloBody({ site: 'mw1:site', owner: null, lanes: ['mw_chat1'] }),
    [T.XX]: xxBody(1, p),
    [T.ENV]: env,
    [T.ROOM]: roomBody({ room: 'Lobby', id: b64url.encode(rand(16)), t: NOW, text: 'hello', author: pub, sig: b64url.encode(rand(64)) }),
    [T.WANT]: wantBody([Uint8Array.of(1), Uint8Array.of(2)]),
    [T.HELD]: heldBody([envFrame]),
    [T.CK]: ckBody({ v: 2, ledger: 'mw1:x', signer: pub, ek: pub, epoch: 1, exp: NOW, sig: b64url.encode(rand(64)) }),
    [T.HOLDING]: holdingBody({ tag: rand(8), frameId: rand(32), expiry: 1700000000 }),
    [T.COLLECTED]: collectedBody({ frameId: rand(32), proof: rand(32) }),
    [T.PRES]: presBody({ mode: 0, slots: Array.from({ length: 8 }, () => rand(8)), status: 1, auth: rand(64) }),
    [T.SIG]: env,
    [T.ICHAL]: ichalBody({ challenge: rand(32), hepk: p }),
    [T.IRESP]: irespBody({ ek: p, proof: rand(32) }),
  };
}

test('every type encodes and decodes; types and names match INTERFACES v0.3', async () => {
  assert.deepEqual({ ...T }, { HELLO: 1, XX: 2, ENV: 3, ROOM: 4, WANT: 5, HELD: 6, CK: 7, HOLDING: 8, COLLECTED: 9, PRES: 10, SIG: 11, ICHAL: 12, IRESP: 13 });
  const bodies = await sampleFrames();
  for (const [type, body] of Object.entries(bodies)) {
    const f = encode(Number(type), { day: 1 }, body);
    const d = decode(f);
    assert.equal(d.error, undefined, 'type ' + type + ': ' + d.error);
    assert.equal(d.type, Number(type));
    assert.equal(d.header.version, 1);
    assert.equal(f.length, 14 + body.length);
  }
});

test('U-CH-1: header numeric fields at 0, -1 and 2^53-1', async () => {
  const body = collectedBody({ frameId: rand(32), proof: rand(32) });
  // 0 is accepted for hop, flags and day; -1 and 2^53-1 are refused by encode (TypeError, local data).
  const ok = decode(encode(T.COLLECTED, { hop: 0, flags: 0, day: 0 }, body));
  assert.equal(ok.error, undefined);
  assert.equal(ok.header.day, 0);
  for (const field of ['hop', 'flags', 'day', 'version']) {
    for (const bad of [-1, MAX, 1.5, NaN, '1']) {
      assert.throws(() => encode(T.COLLECTED, Object.assign({ day: 0 }, { [field]: bad }), body), TypeError, field + '=' + bad);
    }
  }
  // Out-of-range header bytes on the wire: version 0 and 255, hop above the type limit, unknown flag bits.
  const f = encode(T.COLLECTED, { day: 0 }, body);
  for (const [at, val, reason] of [[1, 0, 'unknown-version'], [1, 255, 'unknown-version'], [2, 5, 'hop'], [3, 0x08, 'flags'], [3, FLAG_HOLD, 'flags']]) {
    const g = new Uint8Array(f);
    g[at] = val;
    assert.equal(decode(g).error, reason, 'byte ' + at + ' = ' + val);
  }
  // hop limits per type: ENV 4, ROOM 3, one-hop types 0.
  const bodies = await sampleFrames();
  const env = encode(T.ENV, { day: 0, hop: 4 }, bodies[T.ENV]);
  assert.equal(decode(env).error, undefined);
  assert.equal(decode(withHop(env, 5)).error, 'hop');
  const room = encode(T.ROOM, { day: 0, hop: 3 }, bodies[T.ROOM]);
  assert.equal(decode(room).error, undefined);
  assert.equal(decode(withHop(room, 4)).error, 'hop');
  assert.equal(decode(withHop(encode(T.WANT, { day: 0 }, bodies[T.WANT]), 1)).error, 'hop');
  // Every flag bit on ENV: hold, stranger, pad-only.
  for (const fl of [FLAG_HOLD, FLAG_STRANGER, FLAG_PAD_ONLY, 7]) assert.equal(decode(encode(T.ENV, { day: 0, flags: fl }, bodies[T.ENV])).header.flags, fl);
});

test('U-CH-1: body numeric fields at 0, -1 and 2^53-1 (ROOM t, HELLO v, HOLDING expiry, WANT and HELD counts, CK epoch and exp)', async () => {
  const p = await point();
  const pub = 'p256:' + b64url.encode(p);
  const room = (t) => utf8.encode(JSON.stringify({ room: 'Lobby', id: b64url.encode(rand(16)), t, text: 'x', author: pub, sig: b64url.encode(rand(64)) }));
  const dec = (type, body) => decode(concatBytes(Uint8Array.of(type, 1, 0, 0, 0, 0), new Uint8Array(8), body));
  assert.equal(dec(T.ROOM, room(0)).error, undefined);
  assert.equal(dec(T.ROOM, room(-1)).error, 'room-t');
  assert.equal(dec(T.ROOM, room(MAX)).error, undefined, '2^53-1 is a valid integer; the 5-minute room window refuses it later');
  assert.equal(dec(T.ROOM, room(MAX + 1)).error, 'room-t');
  assert.equal(dec(T.ROOM, room(1.5)).error, 'room-t');
  const hello = (v) => utf8.encode(JSON.stringify({ v, site: 's', owner: null, lanes: [] }));
  assert.equal(dec(T.HELLO, hello(1)).error, undefined);
  for (const v of [0, -1, MAX]) assert.equal(dec(T.HELLO, hello(v)).error, 'hello-version');
  for (const e of [0, 0xffffffff]) assert.equal(decode(encode(T.HOLDING, { day: 0 }, holdingBody({ tag: rand(8), frameId: rand(32), expiry: e }))).fields.expiry, e);
  for (const e of [-1, MAX]) assert.throws(() => holdingBody({ tag: rand(8), frameId: rand(32), expiry: e }), TypeError);
  // counts: WANT 0 and 32 accepted, 33 and 255 refused; HELD 0 accepted, 255 refused.
  assert.equal(dec(T.WANT, Uint8Array.of(0)).error, undefined);
  assert.equal(dec(T.WANT, concatBytes(Uint8Array.of(32), rand(32))).error, undefined);
  assert.equal(dec(T.WANT, concatBytes(Uint8Array.of(33), rand(33))).error, 'want-count');
  assert.equal(dec(T.WANT, concatBytes(Uint8Array.of(255), rand(255))).error, 'want-count');
  assert.equal(dec(T.WANT, concatBytes(Uint8Array.of(2), rand(3))).error, 'want-length');
  assert.equal(dec(T.HELD, Uint8Array.of(0)).error, undefined);
  assert.equal(dec(T.HELD, Uint8Array.of(255)).error, 'held-count');
  // CK numeric fields (shape check of ck.js).
  const ck = { v: 2, ledger: 'mw1:x', signer: pub, ek: pub, epoch: 1, exp: 1, sig: b64url.encode(rand(64)) };
  assert.equal(checkCkShape(ck).ok, true);
  assert.equal(checkCkShape({ ...ck, exp: 0 }).ok, true);
  assert.equal(checkCkShape({ ...ck, exp: MAX }).ok, true);
  assert.equal(checkCkShape({ ...ck, epoch: 0 }).reason, 'ck-epoch');
  assert.equal(checkCkShape({ ...ck, epoch: -1 }).reason, 'ck-epoch');
  assert.equal(checkCkShape({ ...ck, exp: -1 }).reason, 'ck-exp');
  assert.equal(checkCkShape({ ...ck, v: MAX }).reason, 'ck-version');
  assert.equal(checkCkShape({ ...ck, extra: 1 }).reason, 'ck-field');
});

test('U-CH-1: malformed lengths and points are refused with a reason, never an exception', async () => {
  const bodies = await sampleFrames();
  const p = await point();
  // ENV ct must be exactly 272, 1,040, 4,112 or 16,016 bytes.
  for (const len of [0, 1, 271, 273, 1039, 1041, 4113, 16015, 16017]) {
    const body = concatBytes(rand(8), p, rand(12), new Uint8Array(len));
    const f = concatBytes(Uint8Array.of(T.ENV, 1, 0, 0, 0, 0), new Uint8Array(8), body);
    const d = decode(f);
    assert.ok(d.error === 'env-length' || d.error === 'too-large', 'ct ' + len + ': ' + d.error);
  }
  for (const len of CT_LENGTHS) {
    const f = encode(T.ENV, { day: 0 }, envBody({ tag: rand(8), epk: p, iv: rand(12), ct: rand(len) }));
    assert.equal(decode(f).error, undefined);
    assert.ok(ENV_FRAME_SIZES.includes(f.length));
  }
  assert.deepEqual(ENV_FRAME_SIZES, [371, 1139, 4211, 16115]);
  // A point off the curve, a compressed prefix, the identity-like all-zero point.
  const off = new Uint8Array(p);
  off[64] ^= 1;
  for (const bad of [off, concatBytes(Uint8Array.of(2), p.subarray(1)), new Uint8Array(65)]) {
    assert.equal(isOnCurve(bad), false);
    const f = concatBytes(Uint8Array.of(T.ENV, 1, 0, 0, 0, 0), new Uint8Array(8), concatBytes(rand(8), bad, rand(12), rand(272)));
    assert.equal(decode(f).error, 'bad-point');
  }
  assert.equal(isOnCurve(p), true);
  // Size bounds: frames over 16,384 bytes, short frames, HELLO over 512 bytes, XX over 256 bytes.
  assert.equal(decode(new Uint8Array(FRAME_MAX + 1)).error, 'too-large');
  assert.equal(decode(new Uint8Array(13)).error, 'short');
  const bigHello = utf8.encode(JSON.stringify({ v: 1, site: 's', owner: null, lanes: [], pad: 'x'.repeat(600) }));
  assert.equal(decode(concatBytes(Uint8Array.of(T.HELLO, 1, 0, 0, 0, 0), new Uint8Array(8), bigHello)).error, 'hello-json');
  assert.equal(decode(concatBytes(Uint8Array.of(T.XX, 1, 0, 0, 0, 0), new Uint8Array(8), Uint8Array.of(1), new Uint8Array(256))).error, 'xx-length');
  assert.equal(decode(concatBytes(Uint8Array.of(T.HELLO, 1, 0, 0, 0, 0), new Uint8Array(8), utf8.encode('{"v":1,"site":"s","lanes":["a","b","c","d","e"]}'))).error, 'hello-lanes');
  // HOLDING padding must be zero; PRES and IRESP have fixed sizes; unknown types.
  const holding = new Uint8Array(bodies[T.HOLDING]);
  holding[holding.length - 1] = 1;
  assert.equal(decode(concatBytes(Uint8Array.of(T.HOLDING, 1, 0, 0, 0, 0), new Uint8Array(8), holding)).error, 'holding-padding');
  assert.equal(decode(concatBytes(Uint8Array.of(T.PRES, 1, 0, 0, 0, 0), new Uint8Array(8), bodies[T.PRES].subarray(1))).error, 'pres-length');
  for (const type of [0, 14, 200, 255]) assert.equal(decode(concatBytes(Uint8Array.of(type, 1, 0, 0, 0, 0), new Uint8Array(8), rand(20))).error, 'unknown-type');
  // ROOM bounds: text over 2,000 characters, name over 32, extra fields, control characters.
  const pub = 'p256:' + b64url.encode(p);
  const room = (o) => decode(concatBytes(Uint8Array.of(T.ROOM, 1, 0, 0, 0, 0), new Uint8Array(8), utf8.encode(JSON.stringify(Object.assign({ room: 'Lobby', id: b64url.encode(rand(16)), t: 1, text: 'x', author: pub, sig: b64url.encode(rand(64)) }, o)))));
  assert.equal(room({}).error, undefined);
  assert.equal(room({ text: 'x'.repeat(2001) }).error, 'room-text');
  assert.equal(room({ room: 'r'.repeat(33) }).error, 'room-name');
  assert.equal(room({ text: 'a\u0000b' }).error, 'room-text');
  assert.equal(room({ more: 1 }).error, 'room-json');
  assert.equal(room({ author: 'p256:short' }).error, 'room-author');
});

test('U-CH-1: decode never throws (random bytes and mutations of valid frames)', async () => {
  const bodies = await sampleFrames();
  const valid = Object.entries(bodies).map(([t, b]) => encode(Number(t), { day: 1 }, b));
  let errors = 0;
  for (let i = 0; i < 3000; i++) {
    let u;
    if (i % 3 === 0) {
      u = rand(Math.floor(Math.random() * 400));
      if (u.length) u[0] = 1 + (i % 13);
      if (u.length > 1) u[1] = 1;
    } else {
      const base = valid[i % valid.length];
      u = new Uint8Array(base);
      const flips = 1 + (i % 4);
      for (let k = 0; k < flips; k++) u[Math.floor(Math.random() * u.length)] ^= 1 << (k % 8);
      if (i % 5 === 0) u = u.subarray(0, Math.floor(Math.random() * u.length));
    }
    let d;
    assert.doesNotThrow(() => { d = decode(u); });
    if (d.error) errors++;
  }
  assert.ok(errors > 0);
  for (const junk of [null, undefined, 'string', 42, {}, [], new ArrayBuffer(3)]) assert.ok(decode(junk).error);
});

test('U-CH-1: a malformed frame strikes the wire (not a peer id); 20 strikes close it', async () => {
  const chat = await generateChatKey();
  const lane = new ChatLane({ ledgerId: 'mw1:x', chatKey: chat, hello: { site: 'mw1:x' }, setTimeout: () => 0, clearTimeout: () => {} });
  lane.enable();
  let closed = 0;
  const strikes = [];
  lane.on('strike', (s) => strikes.push(s));
  lane.attachWire({ id: 'w1', send: () => true, close: () => { closed++; }, swarm: 'rendezvous' });
  lane.attachWire({ id: 'w2', send: () => true, close: () => {}, swarm: 'rendezvous' });
  await lane.onMessage('w1', concatBytes(Uint8Array.of(T.ENV, 1, 0, 0, 0, 0), new Uint8Array(8), rand(30)));
  assert.equal(strikes.length, 1);
  assert.equal(strikes[0].wire, 'w1');
  assert.equal(strikes[0].reason, 'env-length');
  for (let i = 1; i < STRIKES_CLOSE; i++) await lane.onMessage('w1', rand(5));
  assert.equal(closed, 1, 'closed after 20 strikes');
  assert.equal(lane.wires.has('w1'), false);
  assert.equal(lane.wires.has('w2'), true, 'the other wire is untouched');
  lane.disable();
});

test('U-CH-2: frameId excludes the hop and the nonce; it covers type, version, flags, day and body', async () => {
  const v = vec('chat-frame-001-collected');
  const f = hex.decode(v.expect.frame);
  const id = frameId(f);
  assert.equal(hex.encode(id), v.expect.frameId);
  assert.equal(v.expect.frameIdAtHop3, v.expect.frameId);
  // Independent oracle: SHA-256 over type|version|flags|day|body.
  const oracle = createHash('sha256').update(Buffer.from([f[0], f[1], f[3], f[4], f[5]])).update(Buffer.from(f.subarray(14))).digest('hex');
  assert.equal(hex.encode(id), oracle);
  // Rebuilt from the inputs.
  const rebuilt = encode(T.COLLECTED, { day: v.input.day, stampNonce: hex.decode(v.input.stampNonce) }, collectedBody({ frameId: hex.decode(v.input.frameIdField), proof: hex.decode(v.input.proof) }));
  assert.equal(hex.encode(rebuilt), v.expect.frame);
  for (let hop = 0; hop <= 4; hop++) assert.deepEqual(frameId(withHop(f, hop)), id);
  assert.deepEqual(frameId(withNonce(f, rand(8))), id);
  assert.deepEqual(frameId(decode(f)), id);
  for (const at of [0, 1, 3, 4, 5, 14, f.length - 1]) {
    const g = new Uint8Array(f);
    g[at] ^= 1;
    assert.notDeepEqual(frameId(g), id, 'byte ' + at);
  }
});

test('U-CH-2: the stamp binds the frame; a nonce copied to another frame fails; vector', async () => {
  const sv = vec('chat-stamp-001-bits10');
  const fid = hex.decode(sv.input.frameId);
  const nonce = await mint(fid, sv.input.bits);
  assert.equal(hex.encode(nonce), sv.expect.nonce);
  assert.equal(hex.encode(stampDigest(fid, nonce)), sv.expect.digest);
  const oracle = createHash('sha256').update('mw-relay-v1').update(Buffer.from(fid)).update(Buffer.from(nonce)).digest('hex');
  assert.equal(oracle, sv.expect.digest);
  assert.equal(check(fid, nonce, 10), true);

  const bodies = await sampleFrames();
  const a = encode(T.ENV, { day: 5 }, bodies[T.ENV]);
  const bits = 12;
  const na = await mint(frameId(a), bits);
  const stampedA = withNonce(a, na);
  assert.equal(check(frameId(stampedA), stampedA.subarray(6, 14), bits), true);
  // Copy A's nonce onto other frames: the digest follows each frame's id, so the copy fails except with
  // probability 2^-12 per frame; out of 8 frames at most a lucky one or two may pass.
  let passed = 0;
  for (let i = 0; i < 8; i++) {
    const b = encode(T.ENV, { day: 5 }, envBody({ tag: rand(8), epk: await point(), iv: rand(12), ct: rand(272) }));
    const copied = withNonce(b, na);
    assert.notDeepEqual(frameId(copied), frameId(stampedA));
    if (check(frameId(copied), copied.subarray(6, 14), bits)) passed++;
  }
  assert.ok(passed <= 2, 'copied stamps passed ' + passed + ' of 8');
  // Changing the day or flags (the header fields a relay could rewrite) breaks the stamp too.
  const reDay = new Uint8Array(stampedA);
  reDay[5] ^= 1;
  const reFlags = new Uint8Array(stampedA);
  reFlags[3] = FLAG_HOLD;
  let broken = 0;
  for (const g of [reDay, reFlags]) if (!check(frameId(g), g.subarray(6, 14), bits)) broken++;
  assert.ok(broken >= 1);
  // Bounds of check(): wrong sizes and bit counts are false, never an exception.
  assert.equal(check(fid.subarray(0, 31), nonce, 10), false);
  assert.equal(check(fid, nonce.subarray(0, 7), 10), false);
  for (const b2 of [-1, 33, MAX, 1.5]) assert.equal(check(fid, nonce, b2), false);
  assert.equal(check(fid, nonce, 0), true);
  // Required bits: 10 for contacts, the recipient's chatBits (default 20) with the stranger flag.
  assert.equal(requiredBits(0), 10);
  assert.equal(requiredBits(FLAG_HOLD), 10);
  assert.equal(requiredBits(FLAG_STRANGER), 20);
  assert.equal(requiredBits(FLAG_STRANGER, 24), 24);
  assert.equal(requiredBits(FLAG_STRANGER, -1), 20);
  assert.equal(requiredBits(FLAG_STRANGER, MAX), 20);
  // mint honours an abort signal.
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(mint(fid, 20, { signal: ac.signal }), (e) => e.code === 'E_POW_ABORTED');
  await assert.rejects(mint(fid, -1), TypeError);
});

test('day rule: today or yesterday (UTC, modulo 65536)', () => {
  const now = NOW;
  const today = headerDay(now);
  assert.equal(today, utcDay(now) % 65536);
  assert.equal(dayAcceptable(today, now), true);
  assert.equal(dayAcceptable((today + 65535) % 65536, now), true);
  assert.equal(dayAcceptable((today + 1) % 65536, now), false);
  assert.equal(dayAcceptable((today + 65534) % 65536, now), false);
  // Wrap at 65536.
  const wrapNow = 65536 * 86400000 + 1000;
  assert.equal(headerDay(wrapNow), 0);
  assert.equal(dayAcceptable(65535, wrapNow), true);
});

test('review round (DS-8): within 5 minutes of UTC midnight the next day is accepted; fullDay picks the nearest day', async () => {
  const { fullDay } = await import('../../src/chat/stamp.js');
  const midnight = (utcDay(NOW) + 1) * 86400000;
  const before = midnight - 2 * 60000; // 23:58 UTC
  const today = headerDay(before);
  assert.equal(dayAcceptable((today + 1) % 65536, before), true, 'a sender 3 minutes ahead at 23:58');
  assert.equal(dayAcceptable((today + 1) % 65536, midnight - 6 * 60000), false, 'not 6 minutes before');
  assert.equal(fullDay((today + 1) % 65536, before), utcDay(before) + 1);
  assert.equal(fullDay(today, before), utcDay(before));
  assert.equal(fullDay((today + 65535) % 65536, before), utcDay(before) - 1);
});
