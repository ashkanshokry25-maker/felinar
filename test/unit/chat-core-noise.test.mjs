// Unit tests for src/chat/noise.js (R 2.4.3, MF-40): U-AU-2 (Noise XX vectors; a relay that swaps peer ids
// fails). The vector is reproduced exactly from fixed static and ephemeral keys; the first message is also
// checked against an independent reading of the Noise rules with node:crypto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createHmac, createECDH, createCipheriv } from 'node:crypto';
import { hex, utf8, concatBytes } from '../../src/chain/canonical.js';
import { XXHandshake, prologueFor, PROTOCOL_NAME } from '../../src/chat/noise.js';
import { chatKeyFromJwk, generateChatKey } from '../../src/chat/seal.js';

const V = JSON.parse(readFileSync(new URL('../vectors/chat.json', import.meta.url), 'utf8'));
const vec = (id) => V.vectors.find((v) => v.id === id);

async function run(aStatic, bStatic, { proA = prologueFor('L'), proB = prologueFor('L'), aE, bE } = {}) {
  const I = new XXHandshake({ staticKey: aStatic, prologue: proA, initiator: true, ephemeral: aE });
  const R = new XXHandshake({ staticKey: bStatic, prologue: proB, initiator: false, ephemeral: bE });
  const m1 = await I.next();
  const m2 = await R.next(m1.send);
  const m3 = await I.next(m2.send);
  const r3 = m3.error ? m3 : await R.next(m3.send);
  return { I, R, m1, m2, m3, r3 };
}

test('U-AU-2: Noise XX vector (P-256, AES-256-GCM, SHA-256, prologue "mw-wire-v1" || ledgerId)', async () => {
  const v = vec('chat-noise-001-xx');
  const aS = await chatKeyFromJwk(v.input.initiatorStatic);
  const aE = await chatKeyFromJwk(v.input.initiatorEphemeral);
  const bS = await chatKeyFromJwk(v.input.responderStatic);
  const bE = await chatKeyFromJwk(v.input.responderEphemeral);
  const pro = prologueFor(v.input.ledgerId);
  assert.equal(utf8.decode(pro), 'mw-wire-v1' + v.input.ledgerId);
  const { m1, m2, m3, r3 } = await run(aS, bS, { proA: pro, proB: pro, aE, bE });
  assert.equal(hex.encode(m1.send), v.expect.msg1);
  assert.equal(hex.encode(m2.send), v.expect.msg2);
  assert.equal(hex.encode(m3.send), v.expect.msg3);
  assert.equal(m1.send.length, 65);
  assert.equal(m2.send.length, 65 + 81 + 16);
  assert.equal(m3.send.length, 81 + 16);
  assert.equal(m3.done, true);
  assert.equal(r3.done, true);
  assert.equal(hex.encode(m3.session.handshakeHash), v.expect.handshakeHash);
  assert.deepEqual(m3.session.handshakeHash, r3.session.handshakeHash);
  assert.equal(m3.session.remoteStatic, bS.pub);
  assert.equal(r3.session.remoteStatic, aS.pub);
  assert.equal(hex.encode(await m3.session.encrypt(utf8.encode('first frame'))), v.expect.t1);
  assert.equal(hex.encode(await r3.session.encrypt(utf8.encode('reply'))), v.expect.t2);

  // Independent transcript with node:crypto, read straight from the Noise rules (section 5): every message,
  // the handshake hash and the first transport messages must match.
  assert.equal(PROTOCOL_NAME, 'Noise_XX_P256_AESGCM_SHA256');
  const o = noiseOracle(v.input, pro);
  assert.equal(o.msg1, v.expect.msg1);
  assert.equal(o.msg2, v.expect.msg2);
  assert.equal(o.msg3, v.expect.msg3);
  assert.equal(o.h, v.expect.handshakeHash);
  assert.equal(o.t1, v.expect.t1);
  assert.equal(o.t2, v.expect.t2);
});

function noiseOracle(input, prologue) {
  const pub = (j) => Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]);
  const dh = (j, p) => {
    const e = createECDH('prime256v1');
    e.setPrivateKey(Buffer.from(j.d, 'base64url'));
    return e.computeSecret(p);
  };
  const H = (...b) => createHash('sha256').update(Buffer.concat(b)).digest();
  const HM = (k, d) => createHmac('sha256', k).update(d).digest();
  const hkdf2 = (ck, ikm) => {
    const t = HM(ck, ikm);
    const o1 = HM(t, Buffer.from([1]));
    return [o1, HM(t, Buffer.concat([o1, Buffer.from([2])]))];
  };
  const aead = (k, n, ad, pt) => {
    const iv = Buffer.alloc(12);
    iv.writeBigUInt64BE(BigInt(n), 4);
    const c = createCipheriv('aes-256-gcm', k, iv);
    c.setAAD(ad);
    return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
  };
  const st = { h: Buffer.alloc(32), ck: null, k: null, n: 0 };
  Buffer.from('Noise_XX_P256_AESGCM_SHA256').copy(st.h);
  st.ck = Buffer.from(st.h);
  const mixHash = (d) => { st.h = H(st.h, d); };
  const mixKey = (ikm) => { [st.ck, st.k] = hkdf2(st.ck, ikm); st.n = 0; };
  const encHash = (pt) => {
    const ct = st.k ? aead(st.k, st.n++, st.h, pt) : pt;
    mixHash(ct);
    return ct;
  };
  const eI = pub(input.initiatorEphemeral), eR = pub(input.responderEphemeral);
  const sI = pub(input.initiatorStatic), sR = pub(input.responderStatic);
  const empty = Buffer.alloc(0);
  mixHash(Buffer.from(prologue));
  // -> e
  mixHash(eI);
  const msg1 = Buffer.concat([eI, encHash(empty)]);
  // <- e, ee, s, es
  mixHash(eR);
  mixKey(dh(input.responderEphemeral, eI));
  const cs = encHash(sR);
  mixKey(dh(input.responderStatic, eI));
  const msg2 = Buffer.concat([eR, cs, encHash(empty)]);
  // -> s, se
  const cs3 = encHash(sI);
  mixKey(dh(input.initiatorStatic, eR));
  const msg3 = Buffer.concat([cs3, encHash(empty)]);
  const [k1, k2] = hkdf2(st.ck, empty);
  return {
    msg1: msg1.toString('hex'), msg2: msg2.toString('hex'), msg3: msg3.toString('hex'), h: st.h.toString('hex'),
    t1: aead(k1, 0, empty, Buffer.from('first frame')).toString('hex'), t2: aead(k2, 0, empty, Buffer.from('reply')).toString('hex'),
  };
}

test('transport: in-order sealed frames both ways; a replayed or altered frame fails without breaking the session', async () => {
  const { m3, r3 } = await run(await generateChatKey(), await generateChatKey());
  const a = m3.session;
  const b = r3.session;
  const c1 = await a.encrypt(utf8.encode('one'));
  const c2 = await a.encrypt(utf8.encode('two'));
  assert.equal(utf8.decode(await b.decrypt(c1)), 'one');
  assert.equal(await b.decrypt(c1), null, 'a replayed frame fails (nonce moved on)');
  const bad = new Uint8Array(c2);
  bad[0] ^= 1;
  assert.equal(await b.decrypt(bad), null);
  assert.equal(utf8.decode(await b.decrypt(c2)), 'two', 'the session survives a failed frame');
  assert.equal(utf8.decode(await a.decrypt(await b.encrypt(utf8.encode('back')))), 'back');
  assert.equal(await b.decrypt(new Uint8Array(5)), null);
  assert.equal(await b.decrypt('junk'), null);
});

test('U-AU-2: a relay that swaps peer ids fails', async () => {
  const alice = await generateChatKey();
  const bob = await generateChatKey();
  const mallory = await generateChatKey();

  // (1) Mallory forwards the three handshake messages unchanged: Alice and Bob finish with each other's real
  // keys, and Mallory, who has no session keys, cannot read or inject frames.
  {
    const { m3, r3 } = await run(alice, bob);
    assert.equal(m3.session.remoteStatic, bob.pub);
    assert.equal(r3.session.remoteStatic, alice.pub);
    const ct = await m3.session.encrypt(utf8.encode('to bob'));
    // Mallory's best guess at a frame: a fresh session of her own with Bob's key is a different transcript.
    const { m3: mm } = await run(mallory, bob);
    const injected = await mm.session.encrypt(utf8.encode('from "alice"'));
    assert.equal(await r3.session.decrypt(injected), null);
    assert.equal(utf8.decode(await r3.session.decrypt(ct)), 'to bob');
  }

  // (2) Mallory claims to be Bob (Bob's peer id) and answers Alice herself: Alice learns Mallory's chat key,
  // not Bob's; nothing is gated on the peer id.
  {
    const { m3 } = await run(alice, mallory);
    assert.equal(m3.done, true);
    assert.notEqual(m3.session.remoteStatic, bob.pub);
    assert.equal(m3.session.remoteStatic, mallory.pub);
  }

  // (3) Mallory relays but swaps the ephemeral key in msg1 (to sit in the middle): Bob's msg2 no longer
  // decrypts at Alice.
  {
    const I = new XXHandshake({ staticKey: alice, prologue: prologueFor('L'), initiator: true });
    const R = new XXHandshake({ staticKey: bob, prologue: prologueFor('L'), initiator: false });
    const m1 = await I.next();
    const me = await generateChatKey();
    const { publicKeyBytes } = await import('../../src/chain/crypto.js');
    const swapped = concatBytes(publicKeyBytes(me.pub), m1.send.subarray(65));
    const m2 = await R.next(swapped);
    assert.ok(m2.send);
    const m3 = await I.next(m2.send);
    assert.equal(m3.error, 'xx2');
    assert.equal((await I.next(m2.send)).error, 'xx2', 'a failed handshake stays failed');
  }

  // (4) Any altered byte of msg2 or msg3 fails; the ledger is bound through the prologue.
  {
    const I = new XXHandshake({ staticKey: alice, prologue: prologueFor('L'), initiator: true });
    const R = new XXHandshake({ staticKey: bob, prologue: prologueFor('L'), initiator: false });
    const m1 = await I.next();
    const m2 = await R.next(m1.send);
    const t2 = new Uint8Array(m2.send);
    t2[100] ^= 1;
    assert.ok((await I.next(t2)).error);
  }
  {
    const I = new XXHandshake({ staticKey: alice, prologue: prologueFor('L'), initiator: true });
    const R = new XXHandshake({ staticKey: bob, prologue: prologueFor('L'), initiator: false });
    const m2 = await R.next((await I.next()).send);
    const m3 = await I.next(m2.send);
    const t3 = new Uint8Array(m3.send);
    t3[10] ^= 1;
    assert.equal((await R.next(t3)).error, 'xx3');
  }
  {
    const r = await run(alice, bob, { proA: prologueFor('ledger-one'), proB: prologueFor('ledger-two') });
    assert.equal(r.m3.error, 'xx2', 'peers of two ledgers never complete a handshake');
  }
});

test('handshake input bounds: wrong order, short messages, off-curve points, reuse after done', async () => {
  const alice = await generateChatKey();
  const bob = await generateChatKey();
  const R = new XXHandshake({ staticKey: bob, prologue: prologueFor('L'), initiator: false });
  assert.equal((await R.next(new Uint8Array(10))).error, 'xx1');
  const R2 = new XXHandshake({ staticKey: bob, prologue: prologueFor('L'), initiator: false });
  assert.equal((await R2.next(new Uint8Array(65))).error, 'xx1', 'all-zero point');
  const I = new XXHandshake({ staticKey: alice, prologue: prologueFor('L'), initiator: true });
  assert.equal((await I.next(new Uint8Array(65))).error, 'unexpected-message');
  const ok = await run(alice, bob);
  assert.equal((await ok.I.next(new Uint8Array(3))).error, 'handshake-done');
  assert.throws(() => new XXHandshake({ staticKey: null, prologue: new Uint8Array(0), initiator: true }), TypeError);
  assert.throws(() => new XXHandshake({ staticKey: alice, prologue: 'x', initiator: true }), TypeError);
});
