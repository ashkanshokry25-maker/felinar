// Golden test vectors (v0.2.1, DIGEST-AMENDMENTS A2): test/vectors/pointer.json (MW-PTR/1),
// test/vectors/block.json (block v1 and the salted value hash) and test/vectors/hello.json (the
// gossip HELLO frame). The vectors pin the wire formats other implementations must reproduce.
// v0.3 wave 1 (integrator): ledger.json (freeze group, checked by freeze-state.test.mjs), identity.json
// and signin.json (identity core and mw-signin-v1, checked by identity-core-* and signin-*), chat.json
// (chat-core-*) and media.json (media-format) are locked here too; their own tests check their content.
// v0.3 C2 (integrator): pin.json (mw_pin1 frames and the pin heartbeat, checked by pin-frames and pin-heartbeat) and
// calls.json (SIG payloads, ICE filter and media profiles, checked by calls-signal and calls-ice) are locked here too.
//
// APPEND ONLY. test/vectors/LOCK.json lists every vector's hash (sha256 of its RFC 8785 JSON) in
// the order the vectors were added, chained; the chain head over the first `count` entries is
// frozen in FROZEN below. Editing or removing an existing vector, or an existing LOCK entry, fails
// this test; so does a vector that is not in the lock. To add vectors: give them new ids, append
// them to a vector file, append the { file, id, sha256 } lines this test prints to LOCK.json, and
// (when a release freezes them) append { count, head } to FROZEN. Never edit an existing entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { canonicalize } from '../../src/chain/canonical.js';
import {
  parsePointer, signingInput, formatPointer, verifyPointer, ledgerIdFor, pointerBudget, hubLabelFor,
} from '../../src/common/pointer.js';
import { validateBlock, valueHash, valueHashSync, valueHashInput, blockBytes } from '../../src/chain/block.js';
import { encode, decode, MSG } from '../../src/chain/gossip.js';

const VECTORS = join(dirname(fileURLToPath(import.meta.url)), '..', 'vectors');
const FILES = ['pointer.json', 'block.json', 'hello.json', 'ledger.json', 'identity.json', 'signin.json', 'chat.json', 'media.json', 'pin.json', 'calls.json'];

/** Chain heads frozen at releases: { count: entries covered, head }. Append only. */
const FROZEN = [
  { count: 28, head: '97ec17dc96e8d359e8cde663d983126c200f8d3862b91ae1f6f6b2c11853765c' }, // v0.2.1, 2026-10-19
  { count: 226, head: 'd3c50559f823ae0ba3576a9c172f7c36aaa22ecc6664f2b370424c5799effe3c' }, // v0.3.0
];

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const load = (file) => JSON.parse(readFileSync(join(VECTORS, file), 'utf8'));
const vectorHash = (v) => sha(canonicalize(v));

test('golden vectors are append-only: every vector is locked, no locked vector changed or vanished, the frozen chain holds', () => {
  const lock = load('LOCK.json');
  assert.equal(lock.v, 1);
  assert.ok(Array.isArray(lock.entries) && lock.entries.length > 0);
  const onDisk = readdirSync(VECTORS).filter((f) => f.endsWith('.json') && f !== 'LOCK.json').sort();
  assert.deepEqual(onDisk, FILES.slice().sort(), 'vector files are listed in FILES (add new files there)');
  const current = new Map();
  for (const file of FILES) {
    const doc = load(file);
    assert.ok(Array.isArray(doc.vectors), file);
    for (const v of doc.vectors) {
      assert.equal(typeof v.id, 'string', file + ': every vector has an id');
      const key = file + '#' + v.id;
      assert.ok(!current.has(key), 'duplicate vector id ' + key);
      current.set(key, vectorHash(v));
    }
  }
  const seen = new Set();
  for (const e of lock.entries) {
    const key = e.file + '#' + e.id;
    assert.ok(!seen.has(key), 'LOCK.json lists ' + key + ' twice');
    seen.add(key);
    assert.ok(current.has(key), 'locked vector ' + key + ' was removed: vectors are append-only');
    assert.equal(current.get(key), e.sha256, 'locked vector ' + key + ' was modified: vectors are append-only, add a new id instead');
  }
  const unlocked = [];
  for (const [key, hash] of current) {
    if (seen.has(key)) continue;
    const [file, id] = key.split('#');
    unlocked.push(JSON.stringify({ file, id, sha256: hash }));
  }
  assert.deepEqual(unlocked, [], 'new vectors must be appended to test/vectors/LOCK.json entries:\n' + unlocked.join(',\n'));
  // The chain: head_0 = sha256("mw-vectors-v1"), head_i = sha256(head + "\n" + file + "\n" + id + "\n" + sha256).
  let head = sha('mw-vectors-v1');
  const heads = [head];
  for (const e of lock.entries) {
    head = sha(head + '\n' + e.file + '\n' + e.id + '\n' + e.sha256);
    heads.push(head);
  }
  for (const f of FROZEN) {
    assert.ok(lock.entries.length >= f.count, 'LOCK.json lost entries: it has ' + lock.entries.length + ', ' + f.count + ' were frozen');
    assert.equal(heads[f.count], f.head, 'the first ' + f.count + ' LOCK.json entries changed: locked vectors are append-only');
  }
});

test('pointer vectors (MW-PTR/1): parse, signing input, canonical format, verification, ledger id, size', async () => {
  const doc = load('pointer.json');
  assert.ok(doc.vectors.length >= 13);
  // v0.3 (MF-28): a vector named in another vector's "supersedes" keeps its locked bytes, but its verify
  // expectation is replaced by the newer vector's (ptr-023 supersedes ptr-010: rot= v1 is deleted). Parse,
  // signing input, format, ledger id and size still hold for it; the new verify result is pinned below.
  const superseded = new Set(doc.vectors.map((v) => v.supersedes).filter(Boolean));
  for (const v of doc.vectors) {
    const res = parsePointer(v.text);
    assert.equal(res.ok, v.expect.parse.ok, v.id + ': parse');
    if (!res.ok) {
      assert.equal(res.error, v.expect.parse.error, v.id);
      continue;
    }
    const r = res.record;
    for (const [k, want] of Object.entries(v.expect.parse.fields)) assert.deepEqual(r[k], want, v.id + ': field ' + k);
    assert.equal(signingInput(r, v.scope), v.expect.signingInput, v.id + ': signing input');
    assert.equal(formatPointer(r), v.expect.format, v.id + ': format');
    const got = await verifyPointer(r, v.scope, v.verifyOptions);
    if (!superseded.has(v.id)) {
      for (const [k, want] of Object.entries(v.expect.verify)) assert.deepEqual(got[k], want, v.id + ': verify.' + k);
    }
    assert.equal(await ledgerIdFor(r, v.scope), v.expect.ledgerId, v.id + ': ledger id');
    const budget = pointerBudget(v.text);
    assert.equal(budget.bytes, v.expect.bytes, v.id + ': bytes');
    assert.equal(budget.strings, v.expect.strings, v.id + ': TXT strings');
    // Code review round 1: hub labels (vectors from ptr-014 on), recomputed independently here:
    // base32 (RFC 4648, lowercase) of sha256("mw-label-v1\n" + kind + "\n" + id), 32 characters.
    if (v.expect.hubLabel !== undefined) {
      const label = hubLabelFor(r, v.expect.ledgerId);
      assert.equal(label, v.expect.hubLabel, v.id + ': hub label');
      const kind = r.signed ? 'ledger' : 'btih';
      const id = r.signed ? v.expect.ledgerId : r.btih;
      assert.equal(base32Lower(createHash('sha256').update('mw-label-v1\n' + kind + '\n' + id, 'utf8').digest()).slice(0, 32), label, v.id + ': hub label, independent');
    }
  }
});

function base32Lower(bytes) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

test('code review round 1 vectors: a rotation with lo= keeps the ledger id and hub label; rot= v2 does not travel to another scope; empty st= withdraws', () => {
  const doc = load('pointer.json');
  const by = Object.fromEntries(doc.vectors.map((v) => [v.id, v]));
  const rotated = by['ptr-014-rotation-v2-keeps-ledger'];
  const before = by['ptr-015-ledger-owner-before-rotation'];
  assert.equal(rotated.expect.ledgerId, before.expect.ledgerId);
  assert.equal(rotated.expect.hubLabel, before.expect.hubLabel);
  assert.equal(rotated.expect.verify.rotated, true);
  assert.match(rotated.text, /; lo=p256:/);
  assert.equal(by['ptr-016-rotation-v2-other-scope'].expect.verify.reason, 'owner-changed');
  assert.equal(by['ptr-017-empty-status'].expect.verify.withdrawn, true);
  assert.match(by['ptr-017-empty-status'].expect.format, /; st=;|; st=$/);
  assert.notEqual(by['ptr-018-unsigned-hub-label'].expect.hubLabel, before.expect.hubLabel);
});

test('v0.3 supersedes: ptr-010 (a v1 rot=) no longer verifies, as ptr-023 states; every supersedes names a vector', async () => {
  const doc = load('pointer.json');
  const by = Object.fromEntries(doc.vectors.map((v) => [v.id, v]));
  const pairs = doc.vectors.filter((v) => v.supersedes);
  assert.ok(pairs.length >= 1);
  for (const v of pairs) assert.ok(by[v.supersedes], v.id + ' supersedes a vector that exists');
  assert.equal(by['ptr-023-rot-v1-refused'].supersedes, 'ptr-010-rotation');
  const old = by['ptr-010-rotation'];
  const res = parsePointer(old.text);
  assert.equal(res.ok, true);
  const got = await verifyPointer(res.record, old.scope, old.verifyOptions);
  assert.equal(got.ok, false, 'the v1 rot= of ptr-010 is refused');
  assert.equal(got.reason, 'owner-changed');
  assert.equal(by['ptr-023-rot-v1-refused'].expect.verify.reason, 'owner-changed');
});

test('block vectors: salted value hashes and block validity (MW-LOG/1 block v1)', async () => {
  const doc = load('block.json');
  let blocks = 0;
  let hashes = 0;
  for (const v of doc.vectors) {
    if (v.kind === 'value-hash') {
      hashes++;
      assert.equal(valueHashInput(v.value, v.z), v.input, v.id + ': hashed text');
      assert.equal(v.input, 'mw-vh-v1\n' + v.z + '\n' + canonicalize(v.value), v.id + ': layout');
      assert.equal(await valueHash(v.value, v.z), v.vh, v.id);
      assert.equal(valueHashSync(v.value, v.z), v.vh, v.id + ' (sync)');
      assert.equal(sha(v.input), v.vh, v.id + ' (node:crypto)');
      continue;
    }
    assert.equal(v.kind, 'block', v.id);
    blocks++;
    const got = await validateBlock(v.block, v.options);
    if (v.expect.valid) {
      assert.deepEqual(got, { ok: true }, v.id);
      assert.equal(v.block.h, sha(canonicalize(v.block.e)), v.id + ': h = sha256(canonical(e))');
      assert.equal(blockBytes(v.block), v.expect.bytes, v.id + ': bytes');
      if (v.block.v !== undefined) assert.equal(await valueHash(v.block.v, v.block.z), v.block.e.op.vh, v.id + ': vh');
    } else {
      assert.deepEqual(got, { ok: false, reason: v.expect.reason }, v.id);
    }
  }
  assert.ok(blocks >= 8 && hashes >= 4);
});

test('HELLO vectors: frame bytes, decode, and the algorithm-tagged owner', () => {
  const doc = load('hello.json');
  for (const v of doc.vectors) {
    const bytes = Uint8Array.from(Buffer.from(v.frame, 'hex'));
    if (v.obj) assert.equal(Buffer.from(encode(MSG.HELLO, v.obj)).toString('hex'), v.frame, v.id + ': encode');
    assert.deepEqual(decode(bytes), v.expect.decode, v.id + ': decode');
  }
});
