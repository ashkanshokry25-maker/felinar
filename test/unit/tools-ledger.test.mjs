// Unit tests for tools/keygen.mjs and tools/ledger-admin.mjs (ARCHITECTURE section 6.2, 10;
// DESIGN-REVIEW items 3, 4, S12): the owner key file, the genesis block and the owner-only ops.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

import { keygen } from '../../tools/keygen.mjs';
import {
  createGenesis, policyOp, policyFromFlags, appendControl, loadLedger, readBlocksFile, writeBlocksFile, formatBlocks,
  checkGenesis, ledgerIdForOwner, genesisOwnerOf, policy as policyOpFn, owner as ownerOpFn, allow as allowOpFn,
  acceptHandover,
} from '../../tools/ledger-admin.mjs';
import { loadOwnerKey, ToolError, UsageError, ROOT } from '../../tools/lib.mjs';
import { generateKeyPair, exportPublicKey } from '../../src/chain/crypto.js';
import { createBlock, validateBlock, DEFAULT_POLICY } from '../../src/chain/block.js';
import { ledgerIdFor } from '../../src/common/pointer.js';

const work = mkdtempSync(join(tmpdir(), 'mw-ledger-test-'));
const T = 1790000000000;
after(() => rmSync(work, { recursive: true, force: true }));
let n = 0;
const path = (name) => join(work, ++n + '-' + name);

async function owner() {
  const file = path('owner.jwk');
  const res = await keygen({ out: file });
  return Object.assign({ file }, res, { identity: await loadOwnerKey(file) });
}

async function person() {
  const { publicKey, privateKey } = await generateKeyPair({ extractable: false });
  return { pub: await exportPublicKey(publicKey), privateKey };
}

// ---------------------------------------------------------------------------------------------- keygen

test('keygen: a JWK file with mode 0600, the fingerprint and the public key, never the private key', async () => {
  const file = path('nested/dir/owner.jwk');
  const res = await keygen({ out: file });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const jwk = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(jwk).sort(), ['crv', 'd', 'kty', 'x', 'y']);
  assert.equal(jwk.kty, 'EC');
  assert.equal(jwk.crv, 'P-256');
  assert.match(res.fingerprint, /^[0-9a-f]{8}$/);
  assert.match(res.pub, /^p256:[A-Za-z0-9_-]{87}$/); // algorithm-tagged since v0.2.1 (A2)
  const loaded = await loadOwnerKey(file);
  assert.equal(loaded.pub, res.pub);
  assert.equal(loaded.fingerprint, res.fingerprint);
});

test('keygen: refuses to overwrite a key without --force; --force replaces it and keeps mode 0600', async () => {
  const file = path('owner.jwk');
  const first = await keygen({ out: file });
  await assert.rejects(keygen({ out: file }), (err) => err instanceof ToolError && /already exists/.test(err.message) && /--force/.test(err.message));
  assert.equal((await loadOwnerKey(file)).pub, first.pub, 'the old key is untouched');
  const second = await keygen({ out: file, force: true });
  assert.notEqual(second.pub, first.pub);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal((await loadOwnerKey(file)).pub, second.pub);
});

test('keygen command line prints the fingerprint and owner= only; the private scalar stays in the file', async () => {
  const file = path('cli.jwk');
  const run = spawnSync(process.execPath, ['tools/keygen.mjs', '--out', file], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^fingerprint [0-9a-f]{8}$/);
  assert.match(lines[1], /^owner=p256:[A-Za-z0-9_-]{87}$/); // algorithm-tagged since v0.2.1 (A2)
  const d = JSON.parse(readFileSync(file, 'utf8')).d;
  assert.equal((run.stdout + run.stderr).includes(d), false);
  assert.match(run.stderr, /mode 600/);
  const again = spawnSync(process.execPath, ['tools/keygen.mjs', '--out', file], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists/);
  const bad = spawnSync(process.execPath, ['tools/keygen.mjs', '--bogus'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

test('loadOwnerKey refuses group- or world-readable files and files that are not P-256 keys', async () => {
  const k = await owner();
  chmodSync(k.file, 0o604);
  await assert.rejects(loadOwnerKey(k.file), /chmod 600/);
  chmodSync(k.file, 0o600);
  const junk = path('junk.jwk');
  writeFileSync(junk, 'not json', { mode: 0o600 });
  await assert.rejects(loadOwnerKey(junk), /not a JSON Web Key/);
  writeFileSync(junk, JSON.stringify({ kty: 'RSA' }), { mode: 0o600 });
  await assert.rejects(loadOwnerKey(junk), /not a P-256 private key/);
  await assert.rejects(loadOwnerKey(path('missing.jwk')), /not found/);
});

// ---------------------------------------------------------------------------------------------- genesis and policy

test('createGenesis: a root policy block with every field stated, signed by the owner, valid for validateBlock', async () => {
  const o = await owner();
  const ledgerId = await ledgerIdForOwner(o.identity.pub, { scope: 'example.com' });
  assert.equal(ledgerId, await ledgerIdFor({ sig: 'x', owner: o.identity.pub, chain: null }, 'example.com'));
  const block = await createGenesis({ identity: o.identity, ledgerId, now: 1790000000000 });
  assert.deepEqual(block.e.prev, []);
  assert.equal(block.e.seq, 0);
  assert.equal(block.e.bits, 0, 'the owner is exempt from proof-of-work');
  assert.equal(block.e.ts % 60000, 0);
  assert.deepEqual(block.e.op, Object.assign({ t: 'policy' }, { writers: 'owner', bits: 16, maxValueBytes: 2048, maxChainBytes: 8388608, moderators: [], allow: [] }));
  assert.deepEqual(await validateBlock(block, { genesisOwner: o.identity.pub, site: ledgerId }), { ok: true });
  assert.deepEqual(await checkGenesis(block, { ledgerId, owner: o.identity.pub }), { ok: true, reason: null });
  assert.equal((await checkGenesis(block, { ledgerId: 'mw1:other', owner: o.identity.pub })).ok, false);
  assert.equal((await checkGenesis(block, { ledgerId, owner: 'p256:' + 'B'.repeat(87) })).ok, false);
  const withPolicy = await createGenesis({ identity: o.identity, ledgerId, policy: { writers: 'open', bits: 8, moderators: [o.identity.pub] } });
  assert.equal(withPolicy.e.op.writers, 'open');
  assert.equal(withPolicy.e.op.bits, 8);
  assert.deepEqual(withPolicy.e.op.moderators, [o.identity.pub]);
  assert.equal(withPolicy.e.op.maxChainBytes, DEFAULT_POLICY.maxChainBytes);
  await assert.rejects(createGenesis({ identity: o.identity, ledgerId: 'btih:' + 'a'.repeat(40) }), /signed ledger id/);
});

test('policyOp validates fields and sorts keys; policyFromFlags maps the command line', () => {
  // 65 bytes starting with 0x04: the shape of an uncompressed P-256 point, algorithm-tagged (v0.2.1 A2)
  const a = 'p256:B' + 'A'.repeat(86);
  const b = 'p256:B' + 'A'.repeat(85) + 'E';
  assert.throws(() => policyOp({ writers: 'everyone' }), ToolError);
  assert.throws(() => policyOp({ bits: 33 }), ToolError);
  assert.throws(() => policyOp({ maxValueBytes: 100000 }), ToolError);
  assert.throws(() => policyOp({ moderators: ['not-a-key'] }), /public key/);
  assert.throws(() => policyOp({ allow: 'x' }), ToolError);
  assert.deepEqual(policyOp({ bits: 10 }), { t: 'policy', bits: 10 });
  assert.equal(policyOp({}, { full: true }).maxChainBytes, DEFAULT_POLICY.maxChainBytes);
  const two = policyOp({ moderators: [b, a, a] }, { full: true });
  assert.equal(two.moderators.length, 2, 'duplicates removed');
  assert.deepEqual(two.moderators, two.moderators.slice().sort());
  assert.deepEqual(policyFromFlags({ policy: 'open', bits: 12, maxValueBytes: null, moderator: [], allow: [], clearAllow: true }), { writers: 'open', bits: 12, allow: [] });
  assert.throws(() => policyFromFlags({ writers: 'nobody' }), UsageError);
});

// ---------------------------------------------------------------------------------------------- appending owner ops

async function ledgerWith(o, policy = {}) {
  const ledgerId = await ledgerIdForOwner(o.identity.pub, { scope: 'example.com' });
  const genesis = await createGenesis({ identity: o.identity, ledgerId, policy, now: 1790000000000 });
  return { ledgerId, genesis, blocks: [genesis] };
}

test('appendControl: policy, allow, ban and tombstone blocks chain onto the heads and change the state', async () => {
  const o = await owner();
  const mod = await person();
  const writer = await person();
  const { genesis, blocks } = await ledgerWith(o);
  const p1 = await appendControl({ blocks, identity: o.identity, op: policyOp({ writers: 'allow', moderators: [mod.pub] }), now: 1790000060000 });
  assert.deepEqual(p1.block.e.prev, [genesis.h]);
  assert.equal(p1.block.e.seq, 1);
  assert.equal(p1.block.e.bits, 0);
  const a1 = await appendControl({ blocks: p1.blocks, identity: o.identity, op: { t: 'allow', add: [writer.pub] }, now: 1790000120000 });
  assert.deepEqual(a1.block.e.prev, [p1.block.h], 'prev: the author\'s own last block');
  const b1 = await appendControl({ blocks: a1.blocks, identity: o.identity, op: { t: 'ban', author: writer.pub }, now: 1790000180000 });
  const led = await loadLedger(b1.blocks);
  assert.equal(led.invalid.length, 0);
  assert.equal(led.genesisOwner, o.identity.pub);
  assert.equal(led.state.policy.writers, 'allow');
  assert.ok(led.state.policy.moderators.has(mod.pub));
  assert.ok(led.state.policy.allow.has(writer.pub));
  assert.ok(led.state.policy.banned.has(writer.pub));
  assert.equal(led.state.owner, o.identity.pub);
  // a tombstone for a block that is not in the file yet is accepted (the owner may redact ahead of time)
  const t1 = await appendControl({ blocks: b1.blocks, identity: o.identity, op: { t: 'tombstone', h: 'ab'.repeat(32) }, now: 1790000240000 });
  assert.equal(t1.blocks.length, 5);
  for (const b of t1.blocks) assert.deepEqual(await validateBlock(b, { genesisOwner: o.identity.pub }), { ok: true });
});

test('appendControl: only the owner in effect can issue policy, owner and allow ops', async () => {
  const o = await owner();
  const stranger = await owner();
  const { blocks } = await ledgerWith(o);
  for (const op of [policyOp({ writers: 'open' }), { t: 'allow', add: [stranger.identity.pub] }, { t: 'owner', next: stranger.identity.pub }]) {
    await assert.rejects(appendControl({ blocks, identity: stranger.identity, op }), (err) => err instanceof ToolError && /not the owner/.test(err.message), op.t);
  }
});

test('appendControl: owner succession hands the control to the next key and takes it from the old one', async () => {
  const o = await owner();
  const next = await owner();
  const { blocks } = await ledgerWith(o);
  const handover = await appendControl({ blocks, identity: o.identity, op: { t: 'owner', next: next.identity.pub }, now: 1790000060000 });
  const led = await loadLedger(handover.blocks);
  assert.equal(led.state.owner, next.identity.pub);
  const asNext = await appendControl({ blocks: handover.blocks, identity: next.identity, op: policyOp({ writers: 'open' }), now: 1790000120000 });
  assert.equal((await loadLedger(asNext.blocks)).state.policy.writers, 'open');
  await assert.rejects(appendControl({ blocks: handover.blocks, identity: o.identity, op: policyOp({ bits: 4 }) }), /not the owner/);
});

test('code review round 1: a second hand-over by the old key is contested until the new owner endorses one (accept)', async () => {
  const o = await owner();
  const next = await owner();
  const thief = await owner();
  const { blocks } = await ledgerWith(o);
  const handover = await appendControl({ blocks, identity: o.identity, op: { t: 'owner', next: next.identity.pub }, now: 1790000060000 });
  // The old key signs a second hand-over beside the first one (its parents omit the first).
  const genesisOnly = blocks.map((b) => b.h);
  const rogue = await createBlock({ identity: o.identity, site: blocks[0].e.site, seq: 9, prev: genesisOnly.slice(-1), op: { t: 'owner', next: thief.identity.pub }, ts: 1790000070000, bits: 0 });
  const both = handover.blocks.concat([rogue]);
  const contested = await loadLedger(both, { expectedOwner: next.identity.pub });
  assert.equal(contested.state.ownerConflict, true);
  await assert.rejects(appendControl({ blocks: both, identity: next.identity, op: policyOp({ writers: 'open' }), expectedOwner: next.identity.pub }), /paused/);
  await assert.rejects(acceptHandover({ blocks: both, identity: next.identity, after: rogue.h }), /not a hand-over to this key/);
  const accepted = await acceptHandover({ blocks: both, identity: next.identity, after: handover.block.h, now: 1790000080000 });
  assert.deepEqual(accepted.block.e.prev, [handover.block.h]);
  const resolved = await loadLedger(accepted.blocks, { expectedOwner: next.identity.pub });
  assert.equal(resolved.state.ownerConflict, false);
  assert.equal(resolved.state.owner, next.identity.pub);
  // Without the anchor (no pointer) the conflict stays visible; the thief's anchor reaches nothing.
  assert.equal((await loadLedger(accepted.blocks)).state.ownerConflict, true);
  assert.equal((await loadLedger(accepted.blocks, { expectedOwner: thief.identity.pub })).state.ownerConflict, true);
  // The new owner can act again.
  const asNext = await appendControl({ blocks: accepted.blocks, identity: next.identity, op: policyOp({ writers: 'open' }), expectedOwner: next.identity.pub, now: 1790000090000 });
  assert.equal((await loadLedger(asNext.blocks, { expectedOwner: next.identity.pub })).state.policy.writers, 'open');
});

test('appendControl refuses broken ledger files: invalid blocks, missing parents, no blocks at all', async () => {
  const o = await owner();
  const { genesis, blocks } = await ledgerWith(o);
  const forged = JSON.parse(JSON.stringify(genesis));
  forged.e.ts += 60000;
  await assert.rejects(appendControl({ blocks: [forged], identity: o.identity, op: policyOp({ bits: 4 }) }), /invalid block/);
  const a = await appendControl({ blocks, identity: o.identity, op: policyOp({ bits: 4 }), now: 1790000060000 });
  await assert.rejects(appendControl({ blocks: [a.block], identity: o.identity, op: policyOp({ bits: 5 }) }), /missing parents|no genesis|genesis/);
  await assert.rejects(appendControl({ blocks: [], identity: o.identity, op: policyOp({ bits: 4 }) }), /no blocks/);
});

test('appendControl is deterministic in its choice of parents: own last block, the deepest head, then the oldest heads', async () => {
  const o = await owner();
  const other = await owner();
  const { genesis, blocks } = await ledgerWith(o, { writers: 'open', bits: 0 });
  // two concurrent writes by another author branch off the genesis
  const w = (seq) => createBlock({ identity: other.identity, site: genesis.e.site, seq, prev: [genesis.h], op: { t: 'append', l: 'log' }, value: { n: seq }, ts: 1790000000000 + seq * 60000, bits: 0 });
  const w1 = await w(1);
  const w2 = await w(2);
  const res = await appendControl({ blocks: blocks.concat([w1, w2]), identity: o.identity, op: policyOp({ bits: 3 }), now: 1790000600000 });
  const prev = res.block.e.prev;
  assert.equal(prev.length, 3);
  assert.equal(prev[0] < prev[1] && prev[1] < prev[2], true, 'prev is sorted');
  assert.deepEqual(prev.slice().sort(), [genesis.h, w1.h, w2.h].sort());
});

// ---------------------------------------------------------------------------------------------- files and command line

test('ledger files: JSON arrays, an object with blocks, a single block and gzip are all read; one block per line is written', async () => {
  const o = await owner();
  const { genesis, blocks } = await ledgerWith(o);
  const next = await appendControl({ blocks, identity: o.identity, op: policyOp({ bits: 3 }), now: 1790000060000 });
  const file = path('ledger.json');
  writeBlocksFile(file, next.blocks);
  const text = readFileSync(file, 'utf8');
  assert.equal(text.trim().split('\n').length, next.blocks.length + 2, 'one block per line inside the array');
  assert.deepEqual(readBlocksFile(file), next.blocks);
  const gz = path('ledger.json.gz');
  writeFileSync(gz, gzipSync(Buffer.from(JSON.stringify(next.blocks))));
  assert.deepEqual(readBlocksFile(gz), next.blocks);
  const wrapped = path('wrapped.json');
  writeFileSync(wrapped, JSON.stringify({ blocks: next.blocks }));
  assert.deepEqual(readBlocksFile(wrapped), next.blocks);
  const single = path('single.json');
  writeFileSync(single, JSON.stringify(genesis));
  assert.deepEqual(readBlocksFile(single), [genesis]);
  const junk = path('junk.json');
  writeFileSync(junk, '{"a":1}');
  assert.throws(() => readBlocksFile(junk), /not a ledger export/);
  writeFileSync(junk, 'nope');
  assert.throws(() => readBlocksFile(junk), /not JSON/);
  assert.equal(formatBlocks([]), '[]\n');
  const led = await loadLedger(readBlocksFile(file));
  assert.equal(genesisOwnerOf(led.dag), o.identity.pub);
  assert.equal(genesisOwnerOf(led.dag, { gen: genesis.h }), o.identity.pub);
  assert.throws(() => genesisOwnerOf(led.dag, { gen: 'cd'.repeat(32) }), /not in the ledger file/);
});

test('ledger-admin command line: genesis, policy, show; usage errors exit 2; the key must be private', async () => {
  const o = await owner();
  const ledger = path('cli-ledger.json');
  const cli = (...args) => spawnSync(process.execPath, ['tools/ledger-admin.mjs', ...args], { cwd: ROOT, encoding: 'utf8' });
  const g = cli('genesis', '--key', o.file, '--scope', 'example.com', '--policy', 'open', '--bits', '9', '--out', ledger);
  assert.equal(g.status, 0, g.stderr);
  assert.match(g.stdout, /^ledger  mw1:/m);
  const gen = /^gen=([0-9a-f]{64})$/m.exec(g.stdout)[1];
  assert.equal(readBlocksFile(ledger)[0].h, gen);
  assert.equal(cli('genesis', '--key', o.file, '--scope', 'example.com', '--out', ledger).status, 1, 'an existing file needs --force');
  assert.equal(cli('genesis', '--key', o.file, '--scope', 'example.com', '--out', ledger, '--force').status, 0);
  const p = cli('policy', '--key', o.file, '--file', ledger, '--writers', 'allow', '--bits', '14');
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /policy    writers=allow bits=14/);
  assert.equal(readBlocksFile(ledger).length, 2);
  const show = cli('show', '--file', ledger);
  assert.equal(show.status, 0);
  assert.match(show.stdout, /blocks    2/);
  assert.equal(cli('policy', '--key', o.file, '--file', ledger).status, 2, 'needs a policy flag');
  assert.equal(cli('bogus', '--key', o.file).status, 2);
  assert.equal(cli().status, 2);
  const stranger = await owner();
  const denied = cli('policy', '--key', stranger.file, '--file', ledger, '--bits', '1');
  assert.equal(denied.status, 1);
  assert.match(denied.stderr, /not the owner/);
  assert.equal(existsSync(ledger), true);
});

test('post-wave fix Q: a gzip ledger file stays gzip when ledger-admin appends to it; genesis --out *.gz writes gzip', async () => {
  const o = await owner();
  const cli = (...args) => spawnSync(process.execPath, ['tools/ledger-admin.mjs', ...args], { cwd: ROOT, encoding: 'utf8' });
  const gz = path('ledger.json.gz');
  const g = cli('genesis', '--key', o.file, '--scope', 'example.com', '--policy', 'open', '--out', gz);
  assert.equal(g.status, 0, g.stderr);
  const isGz = (f) => { const b = readFileSync(f); return b[0] === 0x1f && b[1] === 0x8b; };
  assert.equal(isGz(gz), true, 'genesis --out *.gz is gzip');
  const banned = await person();
  const r = cli('ban', '--key', o.file, '--file', gz, '--author', banned.pub);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /as gzip, as it was/);
  assert.equal(isGz(gz), true, 'still gzip after the append (it held plain JSON under the .gz name before the fix)');
  assert.equal(readBlocksFile(gz).length, 2);
  // A plain file stays plain, whatever its name.
  const plainFile = path('ledger.json');
  writeBlocksFile(plainFile, readBlocksFile(gz));
  assert.equal(cli('policy', '--key', o.file, '--file', plainFile, '--bits', '7').status, 0);
  assert.equal(readFileSync(plainFile)[0], 0x5b, 'plain JSON starts with [');
  assert.equal(readBlocksFile(plainFile).length, 3);
});

test('policy, owner and allow are exported as functions (INTERFACES) and refuse bad input', async () => {
  const o = await owner();
  const next = await owner();
  const writer = await person();
  const { blocks } = await ledgerWith(o);
  const p = await policyOpFn({ blocks, identity: o.identity, policy: { writers: 'allow', bits: 6 }, now: T + 60000 });
  const a = await allowOpFn({ blocks: p.blocks, identity: o.identity, add: [writer.pub], now: T + 120000 });
  let led = await loadLedger(a.blocks);
  assert.equal(led.state.policy.writers, 'allow');
  assert.equal(led.state.policy.bits, 6);
  assert.ok(led.state.policy.allow.has(writer.pub));
  const r = await allowOpFn({ blocks: a.blocks, identity: o.identity, remove: [writer.pub], now: T + 180000 });
  led = await loadLedger(r.blocks);
  assert.equal(led.state.policy.allow.has(writer.pub), false);
  const handed = await ownerOpFn({ blocks: r.blocks, identity: o.identity, next: next.identity.pub, now: T + 240000 });
  assert.equal((await loadLedger(handed.blocks)).state.owner, next.identity.pub);
  await assert.rejects(ownerOpFn({ blocks, identity: o.identity, next: 'nope' }), /public key/);
  await assert.rejects(allowOpFn({ blocks, identity: o.identity }), /keys to add or remove/);
  await assert.rejects(allowOpFn({ blocks, identity: o.identity, add: ['x'] }), /not a P-256 public key/);
  // v0.2.1 A2: an untagged v0.2 key is refused with a hint; an unknown algorithm is named.
  await assert.rejects(allowOpFn({ blocks, identity: o.identity, add: [writer.pub.slice('p256:'.length)] }), /algorithm-tagged since v0\.2\.1: write p256:/);
  await assert.rejects(allowOpFn({ blocks, identity: o.identity, add: ['ed25519:' + writer.pub.slice('p256:'.length)] }), /unsupported key type: ed25519/);
  await assert.rejects(policyOpFn({ blocks, identity: o.identity, policy: { writers: 'everyone' } }), ToolError);
});
