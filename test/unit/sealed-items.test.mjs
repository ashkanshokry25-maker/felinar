// Sealed items mw-seal-v1 (R 2.6.2; test U-SE-1; MF-72): fixed size for 1-byte and 1,000-byte
// data, AAD mismatch fails, random IVs, hint lookup; plus the plaintext codec bounds, kinds 4 and
// 5 through an injected sealed box, and the reader's per-author newest-32 rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import * as s from '../../src/identity/sealed.js';
import { b64url, canonicalize, utf8 } from '../../src/chain/canonical.js';

const LEDGER = 'mw1:sealedtestledger000000000';
const ANA = 'p256:' + 'A'.repeat(87);
const BEN = 'p256:' + 'B'.repeat(87);
const key = () => new Uint8Array(randomBytes(32));

test('U-SE-1 fixed size: 1 byte and 1,000 bytes give the same value size', async () => {
  const k = key();
  const one = await s.seal({ kind: 2, data: new Uint8Array([7]), ledgerId: LEDGER, authorPub: ANA, key: k });
  const big = await s.seal({ kind: 2, data: new Uint8Array(1000).fill(9), ledgerId: LEDGER, authorPub: ANA, key: k });
  for (const v of [one, big]) {
    assert.equal(v.enc, 'mw-seal-v1');
    assert.equal(b64url.decode(v.iv).length, 12);
    assert.equal(b64url.decode(v.ct).length, 1040, '1,024 bytes plus the 16-byte tag');
    assert.equal(v.ct.length, 1387);
  }
  assert.equal(canonicalize(one).length, canonicalize(big).length);
  assert.ok(canonicalize(one).length < 1450, 'value ' + canonicalize(one).length + ' bytes, under maxValueBytes 2,048');
  const max = await s.seal({ kind: 2, data: new Uint8Array(s.MAX_DATA_BYTES), ledgerId: LEDGER, authorPub: ANA, key: k });
  assert.equal(b64url.decode(max.ct).length, 1040);
  await assert.rejects(() => s.seal({ kind: 2, data: new Uint8Array(1014), ledgerId: LEDGER, authorPub: ANA, key: k }), (e) => e.code === 'E_SEAL_TOO_BIG');
  const back = await s.open({ value: big, ledgerId: LEDGER, authorPub: ANA, key: k });
  assert.equal(back.data.length, 1000);
  assert.deepEqual(await s.open({ value: one, ledgerId: LEDGER, authorPub: ANA, key: k }), { kind: 2, ver: 1, seq: 0, count: 1, data: new Uint8Array([7]) });
});

test('U-SE-1 AAD mismatch fails: another ledger or another author', async () => {
  const k = key();
  const v = await s.seal({ kind: 1, ver: 3, seq: 2, count: 5, data: 'index', ledgerId: LEDGER, authorPub: ANA, key: k });
  assert.equal(utf8.decode((await s.open({ value: v, ledgerId: LEDGER, authorPub: ANA, key: k })).data), 'index');
  assert.equal(await s.open({ value: v, ledgerId: 'mw1:other', authorPub: ANA, key: k }), null);
  assert.equal(await s.open({ value: v, ledgerId: LEDGER, authorPub: BEN, key: k }), null, 'B cannot pass off A\'s item as its own');
  assert.equal(await s.open({ value: v, ledgerId: LEDGER, authorPub: ANA, key: key() }), null);
  const ct = b64url.decode(v.ct);
  ct[100] ^= 1;
  assert.equal(await s.open({ value: Object.assign({}, v, { ct: b64url.encode(ct) }), ledgerId: LEDGER, authorPub: ANA, key: k }), null);
  assert.deepEqual(s.sealAad(LEDGER, ANA), utf8.encode('mw-seal-v1\n' + LEDGER + '\n' + ANA));
});

test('U-SE-1 random IVs: sealing the same data twice gives different IVs and ciphertexts', async () => {
  const k = key();
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    const v = await s.seal({ kind: 2, data: 'same', ledgerId: LEDGER, authorPub: ANA, key: k });
    assert.ok(!seen.has(v.iv));
    seen.add(v.iv);
  }
});

test('U-SE-1 hint lookup: the recipient finds items by HMAC(K_pair, "hint|" + day)[:4] within a day of skew', async () => {
  const kPair = new Uint8Array(randomBytes(32));
  const t = Date.UTC(2026, 9, 20, 23, 0, 0);
  const hint = await s.hintFor(kPair, t);
  assert.equal(hint.length, 4);
  assert.deepEqual(await s.hintFor(kPair, t - 3600000), hint, 'same day');
  const box = async (pub, plain) => plain.slice(); // a stand-in box: the format test does not need secrecy here
  const mine = { author: BEN, ts: t, h: 'a', v: await s.seal({ kind: 4, data: 'grant', ledgerId: LEDGER, authorPub: BEN, sealTo: box, theirChatPub: ANA, hint }) };
  const other = { author: BEN, ts: t, h: 'b', v: await s.seal({ kind: 4, data: 'grant', ledgerId: LEDGER, authorPub: BEN, sealTo: box, theirChatPub: ANA, hint: await s.hintFor(new Uint8Array(randomBytes(32)), t) }) };
  const none = { author: BEN, ts: t, h: 'c', v: await s.seal({ kind: 2, data: 'x', ledgerId: LEDGER, authorPub: BEN, key: key() }) };
  assert.deepEqual(await s.findByHint([mine, other, none], kPair, t), [mine]);
  assert.deepEqual(await s.findByHint([mine], kPair, t + 86400000), [mine], 'next day still finds it (skew)');
  assert.deepEqual(await s.findByHint([mine], kPair, t + 3 * 86400000), []);
});

test('kinds 4 and 5 go through the injected sealed box; kinds 1 to 3 never do', async () => {
  const calls = [];
  const secret = new Uint8Array(randomBytes(32));
  const xor = (b) => b.map((x, i) => x ^ secret[i % 32]);
  const sealTo = async (pub, plain, { aad, iv }) => {
    calls.push({ pub, aad: utf8.decode(aad), iv: iv.length, len: plain.length });
    return xor(plain).slice();
  };
  const openFrom = async (ct) => xor(ct).slice();
  const v = await s.seal({ kind: 5, data: 'join me', ledgerId: LEDGER, authorPub: BEN, sealTo, theirChatPub: ANA });
  assert.deepEqual(calls, [{ pub: ANA, aad: 'mw-seal-v1\n' + LEDGER + '\n' + BEN, iv: 12, len: 1024 }]);
  const back = await s.open({ value: v, ledgerId: LEDGER, authorPub: BEN, openFrom });
  assert.equal(back.kind, 5);
  assert.equal(utf8.decode(back.data), 'join me');
  await assert.rejects(() => s.seal({ kind: 4, data: 'x', ledgerId: LEDGER, authorPub: BEN }), TypeError);
  // A self key never yields a grant or join, and a box never yields a self item.
  const k = key();
  const self = await s.seal({ kind: 3, data: 'own media keys', ledgerId: LEDGER, authorPub: BEN, key: k });
  assert.equal(await s.open({ value: self, ledgerId: LEDGER, authorPub: BEN, openFrom: async () => null }), null);
  assert.equal((await s.open({ value: self, ledgerId: LEDGER, authorPub: BEN, key: k })).kind, 3);
});

test('plaintext codec: exact 1,024 bytes, strict padding, field bounds', () => {
  const p = s.encodePlain({ kind: 2, ver: 0xfffffffe, seq: 65535, count: 31, data: new Uint8Array([1, 2, 3]) });
  assert.equal(p.length, 1024);
  assert.deepEqual(s.decodePlain(p), { kind: 2, ver: 0xfffffffe, seq: 65535, count: 31, data: new Uint8Array([1, 2, 3]) });
  const dirty = p.slice();
  dirty[1023] = 1;
  assert.equal(s.decodePlain(dirty), null, 'non-zero padding');
  const longLen = p.slice();
  longLen[9] = 0x03;
  longLen[10] = 0xf6; // 1,014
  assert.equal(s.decodePlain(longLen), null);
  assert.equal(s.decodePlain(p.slice(0, 1023)), null);
  for (const bad of [{ kind: 0 }, { kind: 6 }, { kind: 1, seq: 65536 }, { kind: 1, count: -1 }, { kind: 1, ver: 2 ** 32 }]) {
    assert.throws(() => s.encodePlain(Object.assign({ data: '' }, bad)), RangeError, JSON.stringify(bad));
  }
  assert.equal(s.isSealedValue({ enc: 'mw-seal-v1', iv: 'x', ct: 'y' }), false);
  assert.equal(s.isSealedValue({ enc: 'mw-seal-v1', iv: b64url.encode(new Uint8Array(12)), ct: b64url.encode(new Uint8Array(1040)), extra: 1 }), false);
  assert.equal(s.isSealedValue({ enc: 'mw-seal-v1', iv: b64url.encode(new Uint8Array(12)), ct: b64url.encode(new Uint8Array(1040)) }), true);
});

test('reader: per author, only the newest 32 items count; items that do not open are skipped', async () => {
  const kA = key();
  const items = [];
  for (let i = 0; i < 40; i++) {
    items.push({ author: ANA, ts: 1000 + i, h: 'a' + i, v: await s.seal({ kind: 2, seq: i, data: 'a' + i, ledgerId: LEDGER, authorPub: ANA, key: kA }) });
  }
  // Two of Ana's newest items were sealed with a key we do not have.
  items[39].v = await s.seal({ kind: 2, seq: 39, data: 'x', ledgerId: LEDGER, authorPub: ANA, key: key() });
  items.push({ author: BEN, ts: 5, h: 'b', v: await s.seal({ kind: 2, data: 'ben', ledgerId: LEDGER, authorPub: BEN, key: key() }) });
  items.push({ author: ANA, ts: 9999, h: 'junk', v: { text: 'not sealed' } });
  const out = await s.readEffective(items, { open: (it) => s.open({ value: it.v, ledgerId: LEDGER, authorPub: it.author, key: kA }) });
  const ana = out.get(ANA);
  assert.equal(ana.length, 31, '32 newest counted, one did not open');
  assert.equal(ana[0].plain.seq, 38, 'newest first');
  assert.equal(ana[ana.length - 1].plain.seq, 8, 'items older than the newest 32 do not count');
  assert.deepEqual(out.get(BEN), []);
});
