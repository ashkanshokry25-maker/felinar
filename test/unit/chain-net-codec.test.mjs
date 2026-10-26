// chain-net: gossip frame codec (ARCHITECTURE 6.6). Round trip of every frame type at its
// protocol limits, garbage and oversize input, and the paging limits the encoder relies on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MSG, FRAME_MAX, PROTOCOL_VERSION, EMPTY_DIGEST, encode, decode } from '../../src/chain/gossip.js';
import { sha256Sync } from '../../src/chain/sha256-sync.js';
import { hex, utf8 } from '../../src/chain/canonical.js';
import { makeIdentity, mulberry32, put, policy } from './chain-net-helpers.mjs';

const hashOf = (i) => hex.encode(sha256Sync(utf8.encode('h' + i)));
const hashes = (n, from = 0) => Array.from({ length: n }, (_, i) => hashOf(from + i));
const frameOf = (type, json) => {
  const body = utf8.encode(json);
  const out = new Uint8Array(body.length + 1);
  out[0] = type;
  out.set(body, 1);
  return out;
};

test('constants: message types, frame cap, protocol version, empty-window digest', () => {
  assert.deepEqual({ ...MSG }, { HELLO: 1, WANT: 2, BLOCKS: 3, ANN: 4, SYNC: 5, INV: 6 });
  assert.equal(FRAME_MAX, 15360);
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(EMPTY_DIGEST, hex.encode(sha256Sync(new Uint8Array(0))));
});

test('round trip of every frame type at its limits', async () => {
  const owner = await makeIdentity();
  const G = await policy(owner, { writers: 'open', bits: 0 }, []);
  const B1 = await put(owner, 'k', { text: 'x'.repeat(3000) }, [G.h]);
  const cases = [
    [MSG.HELLO, { v: 1, site: 'mw1:abc', owner: owner.pub, n: 12, d: 11, root: hashOf(1), heads: hashes(32) }],
    [MSG.HELLO, { v: 1, site: 'btih:' + 'a'.repeat(40), owner: null, n: 0, d: -1, root: EMPTY_DIGEST, heads: [] }],
    [MSG.WANT, { h: hashes(64) }],
    [MSG.WANT, { h: hashes(3), v: true }],
    [MSG.BLOCKS, { b: [G, B1] }],
    [MSG.ANN, { h: hashes(200) }],
    [MSG.SYNC, { w: Array.from({ length: 128 }, (_, k) => ({ k: k + 1000, dg: hashOf(k), n: 64 * k })) }],
    [MSG.INV, { k: 7, h: hashes(200), more: true }],
    [MSG.INV, { k: 0, h: [], more: false }],
  ];
  for (const [type, obj] of cases) {
    const u8 = encode(type, obj);
    assert.ok(u8 instanceof Uint8Array);
    assert.equal(u8[0], type);
    assert.ok(u8.length <= FRAME_MAX, 'type ' + type + ' fits the frame cap: ' + u8.length);
    const back = decode(u8);
    assert.ok(back, 'decodes type ' + type);
    assert.equal(back.type, type);
    assert.deepEqual(back.obj, JSON.parse(JSON.stringify(obj)));
  }
  // ArrayBuffer and views decode too.
  const u8 = encode(MSG.ANN, { h: hashes(2) });
  assert.ok(decode(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.length)));
  assert.ok(decode(new DataView(u8.buffer, u8.byteOffset, u8.length)));
});

test('garbage never throws and decodes to null', () => {
  const bad = [
    null, undefined, 'string', 42, {}, [],
    new Uint8Array(0), new Uint8Array([1]), new Uint8Array([1, 0x7b]),
    frameOf(0, '{}'), frameOf(7, '{}'), frameOf(255, '{"h":[]}'),
    frameOf(MSG.ANN, '[1,2]'), frameOf(MSG.ANN, '"x"'), frameOf(MSG.ANN, 'null'), frameOf(MSG.ANN, '{"h":'),
    new Uint8Array([MSG.ANN, 0x7b, 0xff, 0xfe, 0x7d]), // invalid UTF-8
    frameOf(MSG.ANN, '{"h":[]}'), // ANN needs at least one hash
    frameOf(MSG.ANN, JSON.stringify({ h: hashes(201) })),
    frameOf(MSG.ANN, JSON.stringify({ h: [hashOf(1).toUpperCase()] })),
    frameOf(MSG.WANT, JSON.stringify({ h: hashes(65) })),
    frameOf(MSG.WANT, JSON.stringify({ h: hashes(1), v: 'yes' })),
    frameOf(MSG.WANT, JSON.stringify({ h: ['abc'] })),
    frameOf(MSG.BLOCKS, '{"b":[]}'),
    frameOf(MSG.BLOCKS, '{"b":[1,"x"]}'),
    frameOf(MSG.BLOCKS, '{"b":{}}'),
    frameOf(MSG.SYNC, '{"w":[]}'),
    frameOf(MSG.SYNC, JSON.stringify({ w: Array.from({ length: 129 }, (_, k) => ({ k, dg: hashOf(k), n: 1 })) })),
    frameOf(MSG.SYNC, JSON.stringify({ w: [{ k: -1, dg: hashOf(1), n: 1 }] })),
    frameOf(MSG.SYNC, JSON.stringify({ w: [{ k: 1.5, dg: hashOf(1), n: 1 }] })),
    frameOf(MSG.SYNC, JSON.stringify({ w: [{ k: 1, dg: 'zz', n: 1 }] })),
    frameOf(MSG.INV, JSON.stringify({ k: 1, h: hashes(1) })), // no more flag
    frameOf(MSG.INV, JSON.stringify({ k: 1, h: hashes(201), more: false })),
    frameOf(MSG.INV, JSON.stringify({ k: '1', h: [], more: false })),
    frameOf(MSG.HELLO, JSON.stringify({ v: 1, site: 's', owner: null, n: 0, d: -2, root: hashOf(1), heads: [] })),
    frameOf(MSG.HELLO, JSON.stringify({ v: 1, site: '', owner: null, n: 0, d: 0, root: hashOf(1), heads: [] })),
    frameOf(MSG.HELLO, JSON.stringify({ v: 1, site: 's', owner: 5, n: 0, d: 0, root: hashOf(1), heads: [] })),
    frameOf(MSG.HELLO, JSON.stringify({ v: 1, site: 's', owner: null, n: -1, d: 0, root: hashOf(1), heads: [] })),
    frameOf(MSG.HELLO, JSON.stringify({ v: 1, site: 's', owner: null, n: 0, d: 0, root: hashOf(1), heads: hashes(33) })),
    frameOf(MSG.HELLO, JSON.stringify({ v: 1, site: 's', owner: null, n: 0, d: 0, root: 'x', heads: [] })),
  ];
  for (const input of bad) assert.equal(decode(input), null, 'rejects ' + (input && input.length !== undefined ? 'frame of ' + input.length : String(input)));
  // Random bytes: never a throw; anything that decodes is a well-formed frame.
  const rand = mulberry32(0xbadf00d);
  for (let i = 0; i < 2000; i++) {
    const len = 1 + Math.floor(rand() * 64);
    const u8 = new Uint8Array(len);
    for (let j = 0; j < len; j++) u8[j] = Math.floor(rand() * 256);
    if (rand() < 0.5) u8[0] = 1 + Math.floor(rand() * 6);
    const r = decode(u8);
    assert.ok(r === null || (r.type >= 1 && r.type <= 6));
  }
  // Mutations of a valid frame.
  const good = encode(MSG.HELLO, { v: 1, site: 'mw1:abc', owner: null, n: 1, d: 0, root: hashOf(1), heads: [hashOf(2)] });
  for (let i = 0; i < good.length; i++) {
    const m = good.slice();
    m[i] ^= 0xff;
    const r = decode(m);
    assert.ok(r === null || r.type === m[0]);
  }
});

test('oversize: encode refuses frames above 15 KiB, decode drops them', () => {
  const base = JSON.stringify({ h: [], more: false, k: 1, pad: '' });
  const pad = 'x'.repeat(FRAME_MAX - 1 - base.length);
  const exact = frameOf(MSG.INV, JSON.stringify({ h: [], more: false, k: 1, pad }));
  assert.equal(exact.length, FRAME_MAX);
  assert.ok(decode(exact), 'exactly FRAME_MAX bytes is accepted');
  const over = frameOf(MSG.INV, JSON.stringify({ h: [], more: false, k: 1, pad: pad + 'x' }));
  assert.equal(over.length, FRAME_MAX + 1);
  assert.equal(decode(over), null);
  assert.throws(() => encode(MSG.INV, { k: 1, h: [], more: false, pad: pad + 'x' }), (err) => err instanceof RangeError && err.code === 'E_FRAME');
  assert.throws(() => encode(9, {}), TypeError);
  assert.throws(() => encode(MSG.ANN, [1]), TypeError);
  // The protocol limits leave headroom: the largest HELLO, ANN, INV, WANT and SYNC fit.
  const bigHash = 'f'.repeat(64);
  assert.ok(encode(MSG.HELLO, { v: 1, site: 'mw1:' + 'x'.repeat(27), owner: 'B'.repeat(87), n: 1e9, d: 1e9, root: bigHash, heads: Array(32).fill(bigHash) }).length < FRAME_MAX);
  assert.ok(encode(MSG.ANN, { h: Array(200).fill(bigHash) }).length < FRAME_MAX);
  assert.ok(encode(MSG.INV, { k: 1e9, h: Array(200).fill(bigHash), more: true }).length < FRAME_MAX);
  assert.ok(encode(MSG.SYNC, { w: Array.from({ length: 128 }, () => ({ k: 1e9, dg: bigHash, n: 1e9 })) }).length < FRAME_MAX);
});
