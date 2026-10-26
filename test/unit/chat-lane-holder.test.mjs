// Unit tests for src/chat/holder.js (R 2.7.5 item 4; MF-33, MF-35): U-CH-7 (only flagged frames are held;
// COLLECTED deletes; per-source quota and stamp-weighted eviction; stranger mail is released only after the
// inbox proof), plus HELD answered once per tag per wire per minute and the lane's HOLDING route back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicKeyBytes } from '../../src/chain/crypto.js';
import { Holder, inboxProof, packHeld } from '../../src/chat/holder.js';
import { T, encode, envBody, decode, frameId, withNonce, heldBody } from '../../src/chat/frames.js';
import { generateChatKey, collectIv } from '../../src/chat/seal.js';
import { inboxTag } from '../../src/chat/tags.js';
import { stampWork, headerDay, utcDay } from '../../src/chat/stamp.js';
import { FLAG_HOLD, FLAG_STRANGER, DAY_MS, HOLD_PER_TAG, FRAME_MAX } from '../../src/chat/limits.js';

const T0 = 20381 * DAY_MS + 12 * 3600000;
let EPK;

async function frame(tag, { flags = FLAG_HOLD, ct = 272, nonce, iv = new Uint8Array(12) } = {}) {
  if (!EPK) EPK = publicKeyBytes((await generateChatKey()).pub);
  const c = new Uint8Array(ct);
  globalThis.crypto.getRandomValues(c);
  let f = encode(T.ENV, { day: headerDay(T0), flags }, envBody({ tag, epk: EPK, iv, ct: c }));
  if (nonce) f = withNonce(f, nonce);
  return { bytes: f, d: decode(f) };
}

function tagOf(n) {
  return Uint8Array.of(n & 255, (n >> 8) & 255, 3, 4, 5, 6, 7, 8);
}

// A nonce with at least / at most a given stamp work for a frame (searching a few thousand counters).
function nonceWithWork(f, pred) {
  for (let n = 0; n < 1 << 16; n++) {
    const nonce = new Uint8Array(8);
    new DataView(nonce.buffer).setUint32(4, n);
    if (pred(stampWork(frameId(f), nonce))) return nonce;
  }
  throw new Error('no nonce');
}

test('U-CH-7: only hold-flagged frames are held; peer holders refuse stranger mail; HOLDING says for how long', async () => {
  let now = T0;
  const h = new Holder({ now: () => now });
  const live = await frame(tagOf(1), { flags: 0 });
  assert.deepEqual(h.offer(live.bytes, live.d, 'w1'), { held: false, reason: 'not-flagged' });
  const stranger = await frame(tagOf(2), { flags: FLAG_HOLD | FLAG_STRANGER });
  assert.equal(h.offer(stranger.bytes, stranger.d, 'w1').reason, 'stranger-mail');
  const ok = await frame(tagOf(3));
  const r = h.offer(ok.bytes, ok.d, 'w1');
  assert.equal(r.held, true);
  assert.deepEqual(r.holding.frameId, frameId(ok.bytes));
  assert.equal(r.holding.expiry, Math.floor((T0 + 7 * DAY_MS) / 1000));
  assert.equal(h.offer(ok.bytes, ok.d, 'w2').reason, 'duplicate');
  const room = encode(T.HOLDING, { day: 1 }, new Uint8Array(357));
  assert.equal(h.offer(room, decode(room), 'w1').reason, 'type');
  // Seven days later the frame is gone.
  now = T0 + 7 * DAY_MS;
  h.expire();
  assert.equal(h.stats().count, 0);
});

test('U-CH-7: WANT answers by prefix or full tag, each tag once per wire per minute; COLLECTED deletes only with the hash-lock secret', async () => {
  let now = T0;
  const h = new Holder({ now: () => now });
  // Contact mail carries the COLLECTED hash lock in its iv (review round, SYB-15 / HUB-8): iv = SHA-256(prefix | s)[:12].
  const sA = new Uint8Array(32).fill(0xa1);
  const sB = new Uint8Array(32).fill(0xb2);
  const a = await frame(tagOf(0x10), { iv: await collectIv(sA) });
  const b = await frame(tagOf(0x20), { iv: await collectIv(sB) });
  h.offer(a.bytes, a.d, 'src');
  h.offer(b.bytes, b.d, 'src');
  const got = h.want([Uint8Array.of(0x10)], 'collector');
  assert.equal(got.length, 1);
  assert.equal(got[0][2], 0, 'stored and handed out with hop 0');
  assert.deepEqual(frameId(got[0]), frameId(a.bytes));
  assert.equal(h.want([Uint8Array.of(0x10)], 'collector').length, 0, 'not again on this wire within a minute');
  assert.equal(h.want([tagOf(0x10)], 'other').length, 1, 'another wire, full tag');
  now += 60000;
  assert.equal(h.want([Uint8Array.of(0x10)], 'collector').length, 1, 'after a minute');
  // COLLECTED: a made-up proof deletes nothing, even from a wire that was handed the frame (it was: 'collector').
  assert.equal(h.collected(frameId(a.bytes), new Uint8Array(32), 'collector'), false);
  assert.equal(h.collected(frameId(a.bytes), sB, 'collector'), false, 'another frame\'s secret');
  assert.equal(h.has(frameId(a.bytes)), true);
  assert.equal(h.collected(frameId(a.bytes), sA.subarray(0, 31), 'collector'), false, 'proof is 32 bytes');
  assert.equal(h.collected(frameId(a.bytes), sA, 'any-wire'), true, 'the secret deletes, on any wire');
  assert.equal(h.has(frameId(a.bytes)), false);
  assert.equal(h.has(frameId(b.bytes)), true);
});

test('review round (SYB-15, HUB-8): the 256-prefix wipe leaves every frame; the holder hands one wire at most 64 frames a minute', async () => {
  let now = T0;
  const h = new Holder({ now: () => now });
  const secrets = [];
  for (let i = 0; i < 80; i++) {
    const sec = new Uint8Array(32);
    globalThis.crypto.getRandomValues(sec);
    secrets.push(sec);
    const f = await frame(tagOf(1000 + i), { iv: await collectIv(sec) });
    assert.equal(h.offer(f.bytes, f.d, 'src' + (i % 8)).held, true);
  }
  const all = [];
  for (let b = 0; b < 256; b++) all.push(Uint8Array.of(b));
  const handed = h.want(all, 'mallory');
  assert.equal(handed.length, 64, 'at most 64 frames to one wire a minute');
  for (const f of handed) assert.equal(h.collected(frameId(f), new Uint8Array(32), 'mallory'), false);
  for (const f of handed) {
    const rnd = new Uint8Array(32);
    globalThis.crypto.getRandomValues(rnd);
    assert.equal(h.collected(frameId(f), rnd, 'mallory'), false);
  }
  assert.equal(h.stats().count, 80, 'nothing was wiped');
  now += 60000;
  assert.equal(h.want(all, 'mallory').length, 64, 'again at most 64 a minute later');
});

test('review round (DS-7): quotas follow the neighbour\'s Noise key across wires; the newest source gives way first', async () => {
  const h = new Holder({ now: () => T0, quotas: { bytes: 65536 } });
  // One key on two wires shares one 8 KiB quota (7 frames of 1,139 bytes).
  let held = 0;
  for (let i = 0; i < 12; i++) {
    const f = await frame(tagOf(2000 + i), { ct: 1040 });
    const g = withNonce(f.bytes, nonceWithWork(f.bytes, (w) => w === 0));
    if (h.offer(g, decode(g), i % 2 ? 'wire-1' : 'wire-2', 'p256:mallory').held) held++;
  }
  assert.equal(held, 7, 'two wires of one key: one quota');
  assert.equal(h.bySource.size, 1);
  // An honest neighbour N fills its share first; then 12 new keys each fill theirs; N loses less than half.
  const h2 = new Holder({ now: () => T0, quotas: { bytes: 65536 } });
  const nFrames = [];
  for (let i = 0; i < 7; i++) {
    const f = await frame(tagOf(3000 + i), { ct: 1040 });
    nFrames.push(f.bytes);
    assert.equal(h2.offer(f.bytes, f.d, 'w-n', 'p256:honest').held, true);
  }
  for (let k = 0; k < 12; k++) {
    for (let i = 0; i < 7; i++) {
      const f = await frame(tagOf(4000 + k * 16 + i), { ct: 1040 });
      h2.offer(f.bytes, f.d, 'w-m' + k, 'p256:m' + k);
    }
  }
  const left = nFrames.filter((b) => h2.has(frameId(b))).length;
  assert.ok(left > 3, 'N kept ' + left + ' of 7 frames');
});

test('U-CH-7: per-source quota (1/8 of the store) with stamp-weighted eviction; per-tag cap of 64; largest source first', async () => {
  // A small store so the quotas bite: 64 KiB, so one source may use 8 KiB (7 frames of 1,139 bytes).
  const h = new Holder({ now: () => T0, quotas: { bytes: 65536 } });
  const weak = [];
  for (let i = 0; i < 7; i++) {
    const f = await frame(tagOf(100 + i), { ct: 1040 });
    const n = nonceWithWork(f.bytes, (w) => w === 0);
    const g = withNonce(f.bytes, n);
    weak.push(g);
    assert.equal(h.offer(g, decode(g), 'flooder').held, true);
  }
  const f8 = await frame(tagOf(200), { ct: 1040 });
  const zero = withNonce(f8.bytes, nonceWithWork(f8.bytes, (w) => w === 0));
  assert.equal(h.offer(zero, decode(zero), 'flooder').reason, 'source-quota', 'no more work, no room');
  const strong = withNonce(f8.bytes, nonceWithWork(f8.bytes, (w) => w >= 4));
  assert.equal(h.offer(strong, decode(strong), 'flooder').held, true, 'more stamp work replaces the weakest frame');
  assert.ok(h.bySource.get('flooder') <= 8192);
  // Other sources keep their own share.
  for (let s = 0; s < 7; s++) {
    const f = await frame(tagOf(300 + s), { ct: 1040 });
    assert.equal(h.offer(f.bytes, f.d, 'honest' + s).held, true);
  }
  // Fill the whole store: eviction starts at the largest source, never by age alone.
  for (let i = 0; i < 60; i++) {
    const f = await frame(tagOf(400 + i), { ct: 1040 });
    h.offer(f.bytes, f.d, 'bulk' + (i % 7));
  }
  assert.ok(h.stats().bytes <= 65536);
  for (const [, bytes] of h.bySource) assert.ok(bytes <= 8192);
  // Per tag: 64 frames.
  const h2 = new Holder({ now: () => T0 });
  const tag = tagOf(7);
  let held = 0;
  for (let i = 0; i < HOLD_PER_TAG + 5; i++) {
    const f = await frame(tag);
    const g = withNonce(f.bytes, nonceWithWork(f.bytes, (w) => w === 0));
    if (h2.offer(g, decode(g), 's' + (i % 16)).held) held++;
  }
  assert.equal(held, HOLD_PER_TAG);
  assert.equal(h2.byTag.get('0700030405060708').size, HOLD_PER_TAG);
});

test('U-CH-7: stranger mail at the pin mailbox is released only after the inbox proof (INBOX-CHAL / INBOX-RESP)', async () => {
  const h = new Holder({ now: () => T0, pinMailbox: true });
  const bob = await generateChatKey();
  const eve = await generateChatKey();
  const day = utcDay(T0);
  const mail = await frame(await inboxTag(bob.pub, day), { flags: FLAG_HOLD | FLAG_STRANGER });
  assert.equal(h.offer(mail.bytes, mail.d, 'sender').held, true);
  // Asking for the inbox tag or its prefix in WANT gets nothing.
  assert.equal(h.want([mail.d.fields.tag], 'eve').length, 0);
  assert.equal(h.want([mail.d.fields.tag.subarray(0, 1)], 'eve').length, 0);
  // Eve answers a challenge with her own key, or with Bob's public key and a made-up proof: nothing.
  const c1 = await h.challenge('eve');
  assert.equal(c1.hepk.length, 65);
  const proofEve = await inboxProof(eve, c1.hepk, c1.challenge);
  assert.deepEqual(await h.respond('eve', { ek: publicKeyBytes(eve.pub), proof: proofEve }), []);
  const c2 = await h.challenge('eve');
  assert.equal(await h.respond('eve', { ek: publicKeyBytes(bob.pub), proof: proofEve }), null, 'wrong proof for Bob\'s key');
  assert.equal(await h.respond('eve', { ek: publicKeyBytes(bob.pub), proof: proofEve }), null, 'one answer per challenge');
  assert.ok(c2);
  // Bob proves the chat key and gets his mail, then COLLECTED deletes it.
  const c3 = await h.challenge('bob');
  const out = await h.respond('bob', { ek: publicKeyBytes(bob.pub), proof: await inboxProof(bob, c3.hepk, c3.challenge) });
  assert.equal(out.length, 1);
  assert.deepEqual(frameId(out[0]), frameId(mail.bytes));
  assert.equal(h.collected(frameId(mail.bytes), new Uint8Array(32), 'bob'), true);
  assert.equal(h.stats().count, 0);
  // A peer holder never issues challenges.
  assert.equal(await new Holder({}).challenge('x'), null);
});

test('packHeld: HELD bodies stay under the frame cap and decode', async () => {
  const frames = [];
  for (let i = 0; i < 40; i++) frames.push((await frame(tagOf(i), { ct: 1040 })).bytes);
  const bodies = packHeld(frames);
  let count = 0;
  for (const b of bodies) {
    const f = encode(T.HELD, { day: 1 }, b);
    assert.ok(f.length <= FRAME_MAX);
    const d = decode(f);
    assert.equal(d.error, undefined);
    count += d.fields.frames.length;
  }
  assert.equal(count, 40);
  assert.ok(bodies.length >= 3);
  assert.deepEqual(heldBody([frames[0]]), packHeld([frames[0]])[0]);
});
