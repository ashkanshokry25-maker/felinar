// Unit tests for src/chat/seal.js, tags.js and ck.js (R 2.7.2, 2.7.4, 2.7.7; MF-38, MF-41): U-CH-3 (sealed box
// vectors and the deniability property: the recipient can build a frame that opens as if the sender made it).
// node:crypto (ECDH, HKDF, HMAC, AES-256-GCM) is an independent oracle for the contact vector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createECDH, hkdfSync, createHmac, createDecipheriv, createHash } from 'node:crypto';
import { hex, utf8, b64url, concatBytes } from '../../src/chain/canonical.js';
import { generateKeyPair, exportPublicKey, sign, importPrivateJwk, publicFromPrivateJwk, publicKeyBytes } from '../../src/chain/crypto.js';
import {
  chatKeyFromJwk, generateChatKey, pairKey, sealDm, openDm, sealRaw, encodePlaintext, decodePlaintext, chooseBucket,
  sealTo, openFrom, sealGroup, openGroup, groupKey, hint, collectedProof, plaintextNeed,
} from '../../src/chat/seal.js';
import { contactTag, inboxTag, presenceId, groupTag } from '../../src/chat/tags.js';
import { makeCk, verifyCk, CkCache, ledgerCopy, ckSigningBytes } from '../../src/chat/ck.js';
import { encode, envBody, decode, T } from '../../src/chat/frames.js';
import { BUCKETS, KIND } from '../../src/chat/limits.js';

const V = JSON.parse(readFileSync(new URL('../vectors/chat.json', import.meta.url), 'utf8'));
const vec = (id) => V.vectors.find((v) => v.id === id);
const L = 'mw1:sealTestLedger';
const DAY = 20381;
const NOW = DAY * 86400000 + 3600000;

function raw(jwk) {
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
}
function nodeEcdh(jwk, pubRaw) {
  const e = createECDH('prime256v1');
  e.setPrivateKey(Buffer.from(jwk.d, 'base64url'));
  return e.computeSecret(Buffer.from(pubRaw));
}

async function signerKey() {
  const kp = await generateKeyPair();
  return { pub: await exportPublicKey(kp.publicKey), sign: (b) => sign(kp.privateKey, b) };
}

test('U-CH-3: pair key and tags match the vector and the node:crypto oracle', async () => {
  const v = vec('chat-pair-001');
  const A = await chatKeyFromJwk(v.input.alice);
  const B = await chatKeyFromJwk(v.input.bob);
  assert.equal(A.pub, v.expect.alicePub);
  assert.equal(B.pub, v.expect.bobPub);
  const kA = await pairKey(A, B.pub, v.input.ledgerId);
  const kB = await pairKey(B, A.pub, v.input.ledgerId);
  assert.deepEqual(kA, kB, 'K_pair is symmetric');
  assert.equal(hex.encode(kA), v.expect.kPair);
  const shared = nodeEcdh(v.input.alice, raw(v.input.bob));
  const [a, b] = [A.pub, B.pub].sort();
  const oracle = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), 'mw-pair-v2|' + v.input.ledgerId + '|' + a + '|' + b, 32));
  assert.equal(oracle.toString('hex'), v.expect.kPair);
  assert.equal(hex.encode(await contactTag(kA, v.input.day)), v.expect.contactTag);
  assert.equal(createHmac('sha256', oracle).update('tag|' + v.input.day).digest().subarray(0, 8).toString('hex'), v.expect.contactTag);
  assert.equal(hex.encode(await inboxTag(B.pub, v.input.day)), v.expect.inboxTagBob);
  assert.equal(createHash('sha256').update('mw-inbox-v2|' + B.pub + '|' + v.input.day).digest().subarray(0, 8).toString('hex'), v.expect.inboxTagBob);
  assert.equal(hex.encode(await presenceId(kA, v.input.day)), v.expect.presenceId);
  // Another ledger gives another pair key (domain separation by ledgerId).
  assert.notDeepEqual(await pairKey(A, B.pub, v.input.ledgerId + 'x'), kA);
});

test('U-CH-3: contact DM vector (256-byte bucket, 371-byte frame), checked by an independent decryption', async () => {
  const v = vec('chat-dm-001-contact-256');
  const A = await chatKeyFromJwk(v.input.alice);
  const B = await chatKeyFromJwk(v.input.bob);
  const E = await chatKeyFromJwk(v.input.ephemeral);
  const m = v.input.message;
  const s = await sealDm({
    myChat: A, theirChatPub: B.pub, ledgerId: v.input.ledgerId, day: v.input.day, ephemeral: E, iv: hex.decode(v.input.iv), bucket: v.input.bucket,
    message: { id: hex.decode(m.id), t: m.t, n: m.n, kind: m.kind, flags: m.flags, body: utf8.encode(m.body) },
  });
  assert.equal(hex.encode(s.tag), v.expect.tag);
  assert.equal(hex.encode(s.epk), v.expect.epk);
  assert.equal(hex.encode(s.ct), v.expect.ct);
  assert.equal(s.ct.length, 272);
  const frame = encode(T.ENV, { day: v.input.day % 65536 }, envBody(s));
  assert.equal(hex.encode(frame), v.expect.frame);
  assert.equal(frame.length, 371);

  // Oracle: K_pair, the tag, mk and AES-256-GCM with node:crypto only.
  const [a, b] = [A.pub, B.pub].sort();
  const kPair = Buffer.from(hkdfSync('sha256', nodeEcdh(v.input.bob, raw(v.input.alice)), Buffer.alloc(0), 'mw-pair-v2|' + v.input.ledgerId + '|' + a + '|' + b, 32));
  const tag = createHmac('sha256', kPair).update('tag|' + v.input.day).digest().subarray(0, 8);
  assert.equal(tag.toString('hex'), v.expect.tag);
  const epk = raw(v.input.ephemeral);
  const dh = nodeEcdh(v.input.bob, epk);
  const mk = Buffer.from(hkdfSync('sha256', Buffer.concat([kPair, dh]), tag, 'mw-dm-v2|' + v.input.ledgerId, 32));
  const ct = Buffer.from(v.expect.ct, 'hex');
  const dec = createDecipheriv('aes-256-gcm', mk, Buffer.from(v.input.iv, 'hex'));
  dec.setAAD(Buffer.concat([Buffer.from('mw-dm-v2'), tag, epk]));
  dec.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([dec.update(ct.subarray(0, ct.length - 16)), dec.final()]);
  assert.equal(pt.length, 256);
  assert.equal(pt.subarray(0, 16).toString('hex'), m.id);
  assert.equal(pt.readBigUInt64BE(16), BigInt(m.t));
  assert.equal(pt.readUInt32BE(24), m.n);
  assert.equal(pt[28], m.kind);
  assert.equal(pt[29], 0);
  assert.equal(pt.readUInt16BE(30), utf8.encode(m.body).length);
  assert.equal(pt.subarray(32, 32 + 9).toString('utf8'), m.body);
  assert.ok(pt.subarray(41).every((x) => x === 0), 'zero padding');

  const o = await openDm({ myChat: B, ledgerId: v.input.ledgerId, env: s, theirChatPub: A.pub });
  assert.equal(o.ok, true);
  assert.equal(o.from, A.pub);
  assert.equal(utf8.decode(o.message.body), m.body);
});

test('U-CH-3: stranger DM vector carries the CK and opens with the sender identified by its site key', async () => {
  const v = vec('chat-dm-002-stranger-1024');
  const A = await chatKeyFromJwk(v.input.alice);
  const B = await chatKeyFromJwk(v.input.bob);
  const E = await chatKeyFromJwk(v.input.ephemeral);
  const m = v.input.message;
  assert.equal((await verifyCk(v.input.ck, { ledgerId: v.input.ledgerId, now: v.input.now })).ok, true);
  assert.equal(v.input.ck.signer, await publicFromPrivateJwk(v.input.aliceSign));
  const s = await sealDm({
    myChat: A, theirChatPub: B.pub, ledgerId: v.input.ledgerId, day: v.input.day, ephemeral: E, iv: hex.decode(v.input.iv), stranger: true, ck: v.input.ck,
    message: { id: hex.decode(m.id), t: m.t, n: m.n, kind: m.kind, flags: m.flags, body: utf8.encode(m.body) },
  });
  assert.equal(hex.encode(s.tag), v.expect.tag);
  assert.equal(hex.encode(s.tag), hex.encode(await inboxTag(B.pub, v.input.day)));
  assert.equal(hex.encode(s.ct), v.expect.ct);
  assert.equal(s.ct.length, 1040);
  const o = await openDm({ myChat: B, ledgerId: v.input.ledgerId, env: s, stranger: true, now: v.input.now });
  assert.equal(o.ok, true, o.reason);
  assert.equal(o.from, v.expect.from);
  assert.equal(o.ck.signer, v.expect.ckSigner);
  assert.equal(utf8.decode(o.message.body), m.body);
  // After the CK expires the request no longer opens.
  const late = await openDm({ myChat: B, ledgerId: v.input.ledgerId, env: s, stranger: true, now: v.input.ck.exp + 1 });
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'ck-expired');
});

test('sizes: buckets 256/1,024/4,096/16,000 give ct 272/1,040/4,112/16,016 and frames 371/1,139/4,211/16,115', async () => {
  const v = vec('chat-sizes-001');
  assert.deepEqual(BUCKETS, v.input.buckets);
  const A = await generateChatKey();
  const B = await generateChatKey();
  for (let i = 0; i < BUCKETS.length; i++) {
    const body = new Uint8Array(BUCKETS[i] - 32);
    const s = await sealDm({ myChat: A, theirChatPub: B.pub, ledgerId: L, day: DAY, message: { t: NOW, n: i, kind: KIND.text, body } });
    assert.equal(s.bucket, BUCKETS[i]);
    assert.equal(s.ct.length, v.expect.ct[i]);
    assert.equal(encode(T.ENV, { day: 1 }, envBody(s)).length, v.expect.envFrame[i]);
    const o = await openDm({ myChat: B, ledgerId: L, env: s, theirChatPub: A.pub });
    assert.equal(o.ok, true);
    assert.equal(o.message.body.length, body.length);
  }
  // The plaintext overhead is 32 bytes; one byte more moves to the next bucket; past 16,000 is E_LIMIT.
  assert.equal(chooseBucket(plaintextNeed({ body: new Uint8Array(224) })), 256);
  assert.equal(chooseBucket(plaintextNeed({ body: new Uint8Array(225) })), 1024);
  await assert.rejects(sealDm({ myChat: A, theirChatPub: B.pub, ledgerId: L, day: DAY, message: { t: NOW, n: 0, kind: 1, body: new Uint8Array(15969) } }), (e) => e.code === 'E_LIMIT');
});

test('plaintext layout: strict decode (padding, t bound, CK layout)', () => {
  const p = encodePlaintext({ id: new Uint8Array(16), t: 5, n: 1, kind: 1, body: utf8.encode('x') }, 256);
  assert.equal(decodePlaintext(p).t, 5);
  const bad = new Uint8Array(p);
  bad[255] = 1;
  assert.equal(decodePlaintext(bad), null, 'non-zero padding');
  const big = new Uint8Array(p);
  big.fill(0xff, 16, 24);
  assert.equal(decodePlaintext(big), null, 't above 2^53-1');
  assert.equal(decodePlaintext(p.subarray(0, 255)), null);
  assert.throws(() => encodePlaintext({ id: new Uint8Array(16), t: -1, n: 0, kind: 1 }, 256), TypeError);
  assert.throws(() => encodePlaintext({ id: new Uint8Array(16), t: Number.MAX_SAFE_INTEGER + 1, n: 0, kind: 1 }, 256), TypeError);
  assert.throws(() => encodePlaintext({ id: new Uint8Array(16), t: 0, n: -1, kind: 1 }, 256), TypeError);
  assert.equal(decodePlaintext(encodePlaintext({ id: new Uint8Array(16), t: Number.MAX_SAFE_INTEGER, n: 0xffffffff, kind: 255 }, 256)).n, 0xffffffff);
});

test('opening fails for tampering, the wrong recipient, the wrong sender or the wrong ledger', async () => {
  const A = await generateChatKey();
  const B = await generateChatKey();
  const C = await generateChatKey();
  const s = await sealDm({ myChat: A, theirChatPub: B.pub, ledgerId: L, day: DAY, message: { t: NOW, n: 1, kind: 1, body: utf8.encode('secret') } });
  assert.equal((await openDm({ myChat: C, ledgerId: L, env: s, theirChatPub: A.pub })).ok, false);
  assert.equal((await openDm({ myChat: B, ledgerId: L, env: s, theirChatPub: C.pub })).ok, false);
  assert.equal((await openDm({ myChat: B, ledgerId: L + '2', env: s, theirChatPub: A.pub })).ok, false);
  for (const field of ['tag', 'iv', 'ct']) {
    const t = Object.assign({}, s, { [field]: new Uint8Array(s[field]) });
    t[field][0] ^= 1;
    assert.equal((await openDm({ myChat: B, ledgerId: L, env: t, theirChatPub: A.pub })).ok, false, field);
  }
  const other = await generateChatKey();
  const swapped = Object.assign({}, s, { epk: publicKeyBytes(other.pub) });
  assert.equal((await openDm({ myChat: B, ledgerId: L, env: swapped, theirChatPub: A.pub })).reason, 'aead');
  const off = Object.assign({}, s, { epk: new Uint8Array(65) });
  assert.equal((await openDm({ myChat: B, ledgerId: L, env: off, theirChatPub: A.pub })).reason, 'bad-point');
});

test('stranger frames: a CK that is not the sender\'s own fails the auth field (no impersonation with a public CK)', async () => {
  const A = await generateChatKey();
  const B = await generateChatKey();
  const M = await generateChatKey();
  const aliceSigner = await signerKey();
  const ckA = await makeCk({ signer: aliceSigner, ledger: L, ek: A.pub, now: NOW });
  // Mallory holds Alice's public CK but not Alice's chat key: sealDm refuses a CK of another chat key ...
  await assert.rejects(sealDm({ myChat: M, theirChatPub: B.pub, ledgerId: L, day: DAY, stranger: true, ck: ckA, message: { t: NOW, n: 0, kind: 1, body: utf8.encode('I am Alice') } }), TypeError);
  // ... and a hand-built frame with Alice's CK and Mallory's K_pair fails the auth check at Bob.
  const kM = await pairKey(M, B.pub, L);
  const tag = await inboxTag(B.pub, DAY);
  const eph = await generateChatKey();
  const pt = encodePlaintext({ id: new Uint8Array(16), t: NOW, n: 0, kind: 1, ck: ckA, body: utf8.encode('I am Alice') }, 1024);
  const forged = await sealRaw({ kPair: kM, dh: await eph.ecdh(B.pub), epk: publicKeyBytes(eph.pub), tag, ledgerId: L, plaintext: pt, iv: new Uint8Array(12), stranger: true });
  const o = await openDm({ myChat: B, ledgerId: L, env: forged, stranger: true, now: NOW });
  assert.equal(o.ok, false);
  assert.equal(o.reason, 'auth');
  // A CK with a broken signature is refused before the auth check.
  const badCk = Object.assign({}, ckA, { epoch: 2 });
  const pt2 = encodePlaintext({ id: new Uint8Array(16), t: NOW, n: 0, kind: 1, ck: badCk, body: utf8.encode('x') }, 1024);
  const kA = await pairKey(A, B.pub, L);
  const f2 = await sealRaw({ kPair: kA, dh: await eph.ecdh(B.pub), epk: publicKeyBytes(eph.pub), tag, ledgerId: L, plaintext: pt2, iv: new Uint8Array(12), stranger: true });
  assert.equal((await openDm({ myChat: B, ledgerId: L, env: f2, stranger: true, now: NOW })).reason, 'ck-bad-signature');
});

test('U-CH-3 deniability: the recipient can build a frame that opens exactly as if the sender made it', async () => {
  const A = await generateChatKey();
  const B = await generateChatKey();
  // Bob forges "from Alice" using only his own key and Alice's public chat key.
  const kPair = await pairKey(B, A.pub, L);
  const tag = await contactTag(kPair, DAY);
  const eph = await generateChatKey();
  const epk = publicKeyBytes(eph.pub);
  const dh = await B.ecdh(epk); // = ECDH(eph, Bob): the recipient computes it for any epk
  const pt = encodePlaintext({ id: new Uint8Array(16).fill(1), t: NOW, n: 3, kind: KIND.text, body: utf8.encode('Alice said this (or did she?)') }, 256);
  const forged = await sealRaw({ kPair, dh, epk, tag, ledgerId: L, plaintext: pt, iv: new Uint8Array(12).fill(9) });
  const o = await openDm({ myChat: B, ledgerId: L, env: forged, theirChatPub: A.pub });
  assert.equal(o.ok, true);
  assert.equal(o.from, A.pub);
  // It has the same shape on the wire as a real one from Alice.
  const real = await sealDm({ myChat: A, theirChatPub: B.pub, ledgerId: L, day: DAY, message: { t: NOW, n: 3, kind: KIND.text, body: utf8.encode('Alice said this (or did she?)') } });
  assert.deepEqual(real.tag, forged.tag);
  assert.equal(real.ct.length, forged.ct.length);
  assert.equal(encode(T.ENV, { day: 1 }, envBody(real)).length, encode(T.ENV, { day: 1 }, envBody(forged)).length);
  // The stranger mode is deniable too: Bob can make a request that opens as Alice's (he has her public CK).
  const aliceSigner = await signerKey();
  const ckA = await makeCk({ signer: aliceSigner, ledger: L, ek: A.pub, now: NOW });
  const itag = await inboxTag(B.pub, DAY);
  const pt2 = encodePlaintext({ id: new Uint8Array(16).fill(2), t: NOW, n: 0, kind: KIND.text, ck: ckA, body: utf8.encode('hi') }, 1024);
  const forged2 = await sealRaw({ kPair, dh, epk, tag: itag, ledgerId: L, plaintext: pt2, iv: new Uint8Array(12), stranger: true });
  const o2 = await openDm({ myChat: B, ledgerId: L, env: forged2, stranger: true, now: NOW });
  assert.equal(o2.ok, true);
  assert.equal(o2.ck.signer, aliceSigner.pub);
});

test('CK records: signature over "mw-chat-key-v2\\n" + JCS, lifetime, cache by signer and epoch, opt-in ledger copy', async () => {
  const s = await signerKey();
  const C = await generateChatKey();
  const ck = await makeCk({ signer: s, ledger: L, ek: C.pub, now: NOW });
  assert.equal(ck.exp, NOW + 90 * 86400000);
  assert.ok(utf8.decode(ckSigningBytes(ck)).startsWith('mw-chat-key-v2\n{"ek":'));
  assert.ok(JSON.stringify(ck).length <= 400);
  assert.equal((await verifyCk(ck, { ledgerId: L, now: NOW })).ok, true);
  assert.equal((await verifyCk(ck, { ledgerId: 'other', now: NOW })).reason, 'ck-other-ledger');
  assert.equal((await verifyCk({ ...ck, ek: (await generateChatKey()).pub }, { ledgerId: L, now: NOW })).reason, 'ck-bad-signature');
  assert.equal((await verifyCk(ck, { ledgerId: L, now: ck.exp })).reason, 'ck-expired');
  const long = await makeCk({ signer: s, ledger: L, ek: C.pub, now: NOW, exp: NOW + 200 * 86400000 });
  assert.equal((await verifyCk(long, { ledgerId: L, now: NOW })).reason, 'ck-lifetime');
  let t = NOW;
  const cache = new CkCache({ ledgerId: L, now: () => t });
  assert.equal((await cache.put(ck)).ok, true);
  assert.equal(cache.forSigner(s.pub).ek, C.pub);
  const C2 = await generateChatKey();
  const ck2 = await makeCk({ signer: s, ledger: L, ek: C2.pub, epoch: 2, now: NOW });
  const r = await cache.put(ck2);
  assert.equal(r.changed, true);
  assert.equal(cache.forSigner(s.pub).ek, C2.pub, 'rotation supersedes for new messages');
  assert.equal(cache.forEk(C.pub).epoch, 1, 'the old key still opens old envelopes');
  assert.equal((await cache.put(ck)).superseded, true);
  t = ck2.exp + 1;
  assert.equal(cache.forSigner(s.pub), null);
  const appended = [];
  const node = { append: (l, v) => { appended.push([l, v]); return { h: 'x' }; } };
  await assert.rejects(ledgerCopy(node, ck), (e) => e.code === 'E_POLICY');
  assert.equal(appended.length, 0);
  await ledgerCopy(node, ck, { consented: true });
  assert.deepEqual(appended, [['mw.ck', ck]]);
});

test('code review v0.3 round 2 (MF-20): the CK cache refuses a rotated-away signer, drops what it cached of one, and bounds epoch jumps', async () => {
  const s = await signerKey();
  const C = await generateChatKey();
  let t = NOW;
  const rotated = new Set();
  const cache = new CkCache({ ledgerId: L, now: () => t, rotated: (pub) => rotated.has(pub) });
  const ck1 = await makeCk({ signer: s, ledger: L, ek: C.pub, epoch: 1, now: t });
  assert.equal((await cache.put(ck1)).ok, true);
  // A stolen key cannot pin a far-future epoch over the one this cache holds: one step, plus one per 90 days since.
  const C9 = await generateChatKey();
  const far = await makeCk({ signer: s, ledger: L, ek: C9.pub, epoch: 9, now: t });
  assert.deepEqual(await cache.put(far), { ok: false, reason: 'ck-epoch-jump' });
  assert.equal(cache.forSigner(s.pub).ek, C.pub, 'the cached CK stays current');
  const two = await makeCk({ signer: s, ledger: L, ek: (await generateChatKey()).pub, epoch: 2, now: t });
  assert.equal((await cache.put(two)).ok, true, 'a rotation of one epoch is taken');
  t += 30 * 86400000;
  assert.deepEqual(await cache.put(await makeCk({ signer: s, ledger: L, ek: (await generateChatKey()).pub, epoch: 4, now: t })), { ok: false, reason: 'ck-epoch-jump' }, 'two steps within one CK lifetime');
  // Once the cached CK has expired there is nothing to jump over: the next CK is taken whatever its epoch.
  t = two.exp + 1;
  const C4 = await generateChatKey();
  const four = await makeCk({ signer: s, ledger: L, ek: C4.pub, epoch: 4, now: t });
  assert.equal((await cache.put(four)).ok, true);
  await assert.rejects(makeCk({ signer: s, ledger: L, ek: C.pub, epoch: 2 ** 21, now: t }), TypeError, 'no epoch above CK_EPOCH_MAX');
  // The ledger shows the key as rotated away: its CKs are refused and the cached one stops counting.
  rotated.add(s.pub);
  assert.equal(cache.forSigner(s.pub), null);
  assert.equal(cache.forEk(C4.pub), null);
  const again = await makeCk({ signer: s, ledger: L, ek: (await generateChatKey()).pub, epoch: 5, now: t });
  assert.deepEqual(await cache.put(again), { ok: false, reason: 'ck-rotated' });
});

test('sealTo / openFrom (grants and joins): AAD binds the purpose; hint and COLLECTED proof', async () => {
  const A = await generateChatKey();
  const B = await generateChatKey();
  const aad = utf8.encode('mw-seal-v1\n' + L + '\np256:author');
  const data = new Uint8Array(1024).fill(5);
  const box = await sealTo({ myChat: A, theirChatPub: B.pub, ledgerId: L, data, aad });
  assert.equal(box.ct.length, 1040);
  assert.deepEqual(await openFrom({ myChat: B, theirChatPub: A.pub, ledgerId: L, aad, ...box }), data);
  assert.equal(await openFrom({ myChat: B, theirChatPub: A.pub, ledgerId: L, aad: utf8.encode('other'), ...box }), null);
  assert.equal(await openFrom({ myChat: B, theirChatPub: (await generateChatKey()).pub, ledgerId: L, aad, ...box }), null);
  assert.equal(await openFrom({ myChat: B, theirChatPub: A.pub, ledgerId: L, aad, ...box, epk: new Uint8Array(65) }), null);
  const k = await pairKey(A, B.pub, L);
  const h = await hint(k, DAY);
  assert.equal(h.length, 4);
  assert.equal(hex.encode(h), createHmac('sha256', Buffer.from(k)).update('hint|' + DAY).digest().subarray(0, 4).toString('hex'));
  const fid = new Uint8Array(32).fill(3);
  assert.equal(hex.encode(await collectedProof(k, fid)), createHmac('sha256', Buffer.from(k)).update('collected|' + hex.encode(fid)).digest('hex'));
});

test('groups: epoch vector, K_g and tag; signed messages; another epoch or a forged sender fails', async () => {
  const v = vec('chat-group-001-epoch');
  const creator = await publicFromPrivateJwk(v.input.creatorSign);
  assert.equal(creator, v.expect.creator);
  const secret = hex.decode(v.input.secret);
  assert.equal(createHash('sha256').update(Buffer.from(secret)).digest('hex'), v.expect.commit);
  const epochOracle = createHash('sha256').update(Buffer.alloc(32)).update(Buffer.from(publicKeyBytes(creator))).update(Buffer.from(v.expect.commit, 'hex')).digest('hex');
  assert.equal(epochOracle, v.expect.epochId);
  const epochId = hex.decode(v.expect.epochId);
  const kG = await groupKey(secret, v.input.ledgerId, v.input.groupId, epochId);
  assert.equal(hex.encode(kG), v.expect.groupKey);
  assert.equal(Buffer.from(hkdfSync('sha256', Buffer.from(secret), Buffer.alloc(0), 'mw-grp-msg-v2|' + v.input.ledgerId + '|' + v.input.groupId + '|' + v.expect.epochId, 32)).toString('hex'), v.expect.groupKey);
  assert.equal(hex.encode(await groupTag(kG, v.input.day)), v.expect.groupTag);

  const key = await importPrivateJwk(v.input.creatorSign);
  const sender = { pub: creator, sign: (b) => sign(key, b) };
  const g = await sealGroup({ groupSecret: secret, ledgerId: L, groupId: 'g1', epochId, day: DAY, sender, message: { t: NOW, n: 4, kind: KIND.group, body: utf8.encode('hello group') } });
  assert.equal(g.ct.length, 272);
  const o = await openGroup({ groupSecret: secret, ledgerId: L, groupId: 'g1', epochId, env: g });
  assert.equal(o.ok, true);
  assert.equal(o.from, creator);
  assert.equal(utf8.decode(o.message.body), 'hello group');
  assert.equal((await openGroup({ groupSecret: new Uint8Array(32), ledgerId: L, groupId: 'g1', epochId, env: g })).ok, false);
  assert.equal((await openGroup({ groupSecret: secret, ledgerId: L, groupId: 'g1', epochId: new Uint8Array(32), env: g })).ok, false);
  // A member who knows K_g but signs as someone else: the signature inside fails.
  const mallory = await signerKey();
  const fake = { pub: creator, sign: (b) => mallory.sign(b) };
  const g2 = await sealGroup({ groupSecret: secret, ledgerId: L, groupId: 'g1', epochId, day: DAY, sender: fake, message: { t: NOW, n: 5, kind: KIND.group, body: utf8.encode('x') } });
  assert.equal((await openGroup({ groupSecret: secret, ledgerId: L, groupId: 'g1', epochId, env: g2 })).reason, 'signature');
  // Group frames are ENV frames like any other.
  assert.equal(decode(encode(T.ENV, { day: 1 }, envBody(g))).error, undefined);
});

// ---------------------------------------------------------------------------------------------------------------------------
// Review round (R 5.3, 2026-10-24; docs/deviations/review-round-chat.md)
// ---------------------------------------------------------------------------------------------------------------------------

test('review round (PRIV-1): directional contact tags: a message and its reply (or ACK) carry different tags', async () => {
  const { contactTagFrom } = await import('../../src/chat/tags.js');
  const A = await generateChatKey();
  const B = await generateChatKey();
  const msg = { t: NOW, n: 0, kind: KIND.text, body: utf8.encode('hi') };
  const ab = await sealDm({ myChat: A, theirChatPub: B.pub, ledgerId: L, day: DAY, message: msg, directional: true });
  const ba = await sealDm({ myChat: B, theirChatPub: A.pub, ledgerId: L, day: DAY, message: { ...msg, kind: KIND.ack }, directional: true });
  assert.notDeepEqual(ab.tag, ba.tag, 'the ACK does not repeat the message tag');
  const k = await pairKey(A, B.pub, L);
  assert.deepEqual(ab.tag, await contactTagFrom(k, DAY, A.pub));
  assert.deepEqual(ba.tag, await contactTagFrom(k, DAY, B.pub));
  // Oracle: HMAC(K_pair, "tag|" + day + "|" + senderEk)[:8].
  assert.equal(hex.encode(ab.tag), createHmac('sha256', Buffer.from(k)).update('tag|' + DAY + '|' + A.pub).digest().subarray(0, 8).toString('hex'));
  // The vector form (no option) is unchanged and the same both ways.
  const plain = await sealDm({ myChat: A, theirChatPub: B.pub, ledgerId: L, day: DAY, message: msg });
  assert.deepEqual(plain.tag, await contactTag(k, DAY));
  // Both open.
  for (const env of [ab, plain]) assert.equal((await openDm({ myChat: B, ledgerId: L, env, theirChatPub: A.pub, now: NOW })).ok, true);
});

test('review round (STALK-7): a blinded stranger frame shows one byte of the inbox tag; only the recipient opens it', async () => {
  const A = await generateChatKey();
  const B = await generateChatKey();
  const s = await signerKey();
  const ck = await makeCk({ signer: s, ledger: L, ek: A.pub, now: NOW });
  const full = await inboxTag(B.pub, DAY);
  const env = await sealDm({ myChat: A, theirChatPub: B.pub, ledgerId: L, day: DAY, stranger: true, ck, blindInbox: true, message: { t: NOW, n: 0, kind: KIND.text, body: utf8.encode('hello') } });
  assert.equal(env.tag[0], full[0], 'the first byte is the bucket');
  assert.notDeepEqual(env.tag, full, 'the rest is random');
  // An observer holding 2,000 chat keys finds no key whose inbox tag is on the wire, only a bucket of candidates.
  let exact = 0;
  let bucket = 0;
  for (let i = 0; i < 2000; i++) {
    const t = await inboxTag((await generateChatKey()).pub, DAY);
    if (hex.encode(t) === hex.encode(env.tag)) exact++;
    if (t[0] === env.tag[0]) bucket++;
  }
  assert.equal(exact, 0);
  assert.ok(bucket >= 1, 'the bucket holds other keys too (' + bucket + ' of 2,000)');
  const o = await openDm({ myChat: B, ledgerId: L, env, stranger: true, now: NOW });
  assert.equal(o.ok, true);
  assert.equal(o.ck.signer, s.pub);
  assert.equal(utf8.decode(o.message.body), 'hello');
  // A day later it still opens (day - 1 is listened on); someone else's key does not open it.
  assert.equal((await openDm({ myChat: B, ledgerId: L, env, stranger: true, now: NOW + 86400000 })).ok, true);
  assert.equal((await openDm({ myChat: await generateChatKey(), ledgerId: L, env, stranger: true, now: NOW })).ok, false);
});

test('review round (SYB-15, HUB-8): the COLLECTED hash lock: iv = SHA-256("mw-collect-v1" | s)[:12], s known only to the pair', async () => {
  const { collectSecret, collectIv, collectMatches } = await import('../../src/chat/seal.js');
  const { lockOpens } = await import('../../src/chat/holder.js');
  const A = await generateChatKey();
  const B = await generateChatKey();
  const env = await sealDm({ myChat: A, theirChatPub: B.pub, ledgerId: L, day: DAY, message: { t: NOW, n: 0, kind: KIND.text, body: utf8.encode('x') }, directional: true, collectLock: true });
  const kB = await pairKey(B, A.pub, L);
  const sec = await collectSecret(kB, env.tag, env.epk);
  // Oracle: node:crypto.
  const sOracle = createHmac('sha256', Buffer.from(kB)).update(Buffer.concat([Buffer.from('collect|'), Buffer.from(env.tag), Buffer.from(env.epk)])).digest();
  assert.equal(hex.encode(sec), sOracle.toString('hex'));
  const ivOracle = createHash('sha256').update(Buffer.concat([Buffer.from('mw-collect-v1'), sOracle])).digest().subarray(0, 12);
  assert.equal(hex.encode(env.iv), ivOracle.toString('hex'));
  assert.deepEqual(await collectIv(sec), env.iv);
  assert.equal(await collectMatches(env.iv, sec), true);
  assert.equal(await collectMatches(env.iv, new Uint8Array(32)), false);
  const f = encode(T.ENV, { day: DAY % 65536 }, envBody(env));
  assert.equal(lockOpens(f, sec), true);
  assert.equal(lockOpens(f, await collectSecret(await pairKey(A, (await generateChatKey()).pub, L), env.tag, env.epk)), false);
  assert.equal((await openDm({ myChat: B, ledgerId: L, env, theirChatPub: A.pub, now: NOW })).ok, true, 'the derived iv opens like any');
});

test('review round (MP-5, SYB-5): 4,100 CKs of unknown signers do not push out a known signer\'s CK; the same CK is not verified twice', async () => {
  const known = new Set();
  const cache = new CkCache({ ledgerId: L, now: () => NOW, known: (p) => known.has(p) });
  const contacts = [];
  for (let i = 0; i < 5; i++) {
    const s = await signerKey();
    known.add(s.pub);
    const ck = await makeCk({ signer: s, ledger: L, ek: (await generateChatKey()).pub, now: NOW });
    contacts.push(ck);
    assert.equal((await cache.put(ck)).ok, true);
  }
  const one = await signerKey();
  const attackerCk = await makeCk({ signer: one, ledger: L, ek: (await generateChatKey()).pub, now: NOW });
  // 4,100 distinct signers would cost 4,100 key generations; one signer's CKs under fresh signers is the same pressure on
  // the unknown list, so the flood uses 300 fresh signers and a cache of max 64 to show both limits.
  const small = new CkCache({ ledgerId: L, now: () => NOW, known: (p) => known.has(p), max: 64, unknownMax: 16 });
  for (const ck of contacts) await small.put(ck);
  for (let i = 0; i < 300; i++) {
    const s = await signerKey();
    assert.equal((await small.put(await makeCk({ signer: s, ledger: L, ek: (await generateChatKey()).pub, now: NOW }))).ok, true);
  }
  for (const ck of contacts) assert.equal(small.forSigner(ck.signer).ek, ck.ek, 'a contact\'s CK stays');
  assert.ok(small.unknown.size <= 16 && small.size() <= 5 + 16, 'unknown signers kept apart: ' + small.size());
  // A CK identical to the cached one: answered without a second signature check.
  assert.equal((await cache.put(attackerCk)).ok, true);
  const again = await cache.put(attackerCk);
  assert.equal(again.same, true);
  assert.equal(again.fresh, false);
  // A record that differs in one field is verified (and fails here).
  assert.equal((await cache.put({ ...attackerCk, exp: attackerCk.exp - 1 })).reason, 'ck-bad-signature');
});
