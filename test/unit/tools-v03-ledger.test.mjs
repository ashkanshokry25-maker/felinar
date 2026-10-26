// Unit tests for the v0.3 additions of tools/ledger-admin.mjs (V03-DESIGN-REVIEW 2.5.3, 2.5.5, 2.8.7, 2.10.1; MF-20, MF-22,
// MF-27 to MF-29): every new op produces a block the freeze-lane validator and the ingest rules accept, the cfg rows,
// the deny key hashing, the capacity meter and the command line. All offline; keys and ledgers live in a temporary directory.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { keygen } from '../../tools/keygen.mjs';
import {
  createGenesis, policyOp, policyFromFlags, appendControl, loadLedger, readBlocksFile, writeBlocksFile, ledgerIdForOwner, isGzipFile,
  parseUntil, parseVoid, banOp, unbanOp, bulkTombstoneOp, recoveryCommitment, keyinfoOp, rotateOp, checkpointBlock,
  cfgFromFlags, mergeCfg, currentCfg, setCfg, denyKey, denyValue, denyIdentifier, capacityMeter, SEALED_ITEM_BYTES, DENY_REASONS, CFG_KEYS, CFG_ENUMS,
  listedKey, acceptListing,
} from '../../tools/ledger-admin.mjs';
import { listingVisible, idKey, LISTED_PREFIX } from '../../src/loader/mod.js';
import { loadOwnerKey, ToolError, UsageError, ROOT } from '../../tools/lib.mjs';
import { generateKeyPair, exportPublicKey, verify as verifySig } from '../../src/chain/crypto.js';
import { createBlock, validateBlock, rotateSigningInput } from '../../src/chain/block.js';
import { admit, reduce, snapshot as stateSnapshot, reduceFromCheckpoint, checkpointSnap, schemaOk } from '../../src/chain/state.js';
import { canonicalize } from '../../src/chain/canonical.js';

const work = mkdtempSync(join(tmpdir(), 'mw-v03-ledger-'));
after(() => rmSync(work, { recursive: true, force: true }));
const T = 1790000000000; // a minute boundary
const MIN = 60000;
let n = 0;
const path = (name) => join(work, ++n + '-' + name);

async function ownerKey() {
  const file = path('owner.jwk');
  const res = await keygen({ out: file });
  return Object.assign({ file }, res, { identity: await loadOwnerKey(file) });
}

async function person() {
  const { publicKey, privateKey } = await generateKeyPair({ extractable: false });
  return { pub: await exportPublicKey(publicKey), privateKey };
}

async function ledger({ writers = 'open', bits = 0, extra = {} } = {}) {
  const o = await ownerKey();
  const ledgerId = await ledgerIdForOwner(o.identity.pub, { scope: 'example.com' });
  const genesis = await createGenesis({ identity: o.identity, ledgerId, policy: Object.assign({ writers, bits }, extra), now: T });
  return { o, ledgerId, blocks: [genesis] };
}

// A member's payload put, appended at the heads of `blocks` (open ledger, bits 0).
async function memberPut(L, who, k, value, ts) {
  const led = await loadLedger(L.blocks);
  const prev = led.dag.heads({ limit: 8 }).slice().sort();
  const seq = led.dag.order().filter((b) => b.e.author === who.pub).length;
  const block = await createBlock({ identity: who, site: L.ledgerId, seq, prev, op: { t: 'put', k }, value, ts, bits: 0 });
  L.blocks = L.blocks.concat([block]);
  return block;
}

const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const b64url = (buf) => Buffer.from(buf).toString('base64url');

async function accepted(L, block) {
  const led = await loadLedger(L.blocks.filter((b) => b.h !== block.h));
  assert.deepEqual(await validateBlock(block, { site: L.ledgerId }), { ok: true });
  const verdict = admit(led.state, block, { dag: led.dag, genesisOwner: led.genesisOwner });
  assert.equal(verdict.ok, true, 'ingest refused: ' + JSON.stringify(verdict));
}

// ---------------------------------------------------------------------------------------------- policy fields

test('policy: the freeze-group fields are written only when given, validated, and the genesis stays byte-compatible without them', async () => {
  const none = policyOp({}, { full: true });
  assert.deepEqual(Object.keys(none).sort(), ['allow', 'bits', 'maxChainBytes', 'maxValueBytes', 'moderators', 't', 'writers'], 'no freeze fields unless asked');
  const a = await person();
  const b = await person();
  const op = policyOp({ modAllowPerDay: 7, modActionsPerHour: 30, reservedPool: 40, voided: [{ author: b.pub, after: 'b'.repeat(64) }, { author: a.pub, after: 'a'.repeat(64) }] });
  assert.equal(op.modAllowPerDay, 7);
  assert.equal(op.modActionsPerHour, 30);
  assert.equal(op.reservedPool, 40);
  assert.deepEqual(op.voided.map((v) => v.author), [a.pub, b.pub].sort(), 'voided is sorted by author');
  assert.throws(() => policyOp({ reservedPool: 51 }), ToolError, 'at most 50 percent');
  assert.throws(() => policyOp({ modAllowPerDay: 1001 }), ToolError);
  assert.throws(() => policyOp({ voided: [{ author: a.pub, after: 'zz' }] }), ToolError);
  assert.throws(() => policyOp({ voided: [{ author: a.pub, after: 'a'.repeat(64) }, { author: a.pub, after: 'b'.repeat(64) }] }), ToolError, 'one entry per author');
  assert.throws(() => policyOp({ voided: Array.from({ length: 51 }, () => ({ author: a.pub, after: 'a'.repeat(64) })) }), ToolError);
  // flags
  const fromFlags = policyFromFlags({ writers: null, policy: null, bits: null, maxValueBytes: null, maxChainBytes: null, moderator: [], allow: [], clearModerators: false, clearAllow: false,
    modAllowPerDay: 5, modActionsPerHour: 9, reservedPool: 10, clearVoided: false, void: [a.pub + '@' + 'c'.repeat(64)] });
  assert.deepEqual(fromFlags, { modAllowPerDay: 5, modActionsPerHour: 9, reservedPool: 10, voided: [{ author: a.pub, after: 'c'.repeat(64) }] });
  assert.deepEqual(policyFromFlags({ clearVoided: true, void: [] }), { voided: [] });
  assert.throws(() => parseVoid('nonsense'), UsageError);
  assert.throws(() => parseVoid(a.pub + '@123'), UsageError);
});

test('policy command: a block with the new fields is valid and the reducer applies them (moderator hour cap, daily allow cap, pool)', async () => {
  const L = await ledger({ writers: 'allow', bits: 0 });
  const mod = await person();
  const res = await appendControl({ blocks: L.blocks, identity: L.o.identity, op: policyOp({ moderators: [mod.pub], modAllowPerDay: 3, modActionsPerHour: 2, reservedPool: 10 }), now: T + MIN });
  L.blocks = res.blocks;
  await accepted(L, res.block);
  const snap = stateSnapshot((await loadLedger(L.blocks)).state);
  assert.equal(snap.policy.modAllowPerDay, 3);
  assert.equal(snap.policy.modActionsPerHour, 2);
  assert.equal(snap.policy.reservedPool, 10);
  const g = await createGenesis({ identity: L.o.identity, ledgerId: L.ledgerId, policy: { modAllowPerDay: 12 }, now: T });
  assert.equal(g.e.op.modAllowPerDay, 12, 'genesis states the freeze field when given');
  assert.equal(await validateBlock(g, { genesisOwner: L.o.identity.pub, site: L.ledgerId }).then((r) => r.ok), true);
});

// ---------------------------------------------------------------------------------------------- ban --until, unban

test('parseUntil: milliseconds or an ISO date; seconds, junk and the past century are refused', () => {
  assert.equal(parseUntil('1790000000000'), 1790000000000);
  assert.equal(parseUntil('2026-12-01'), Date.UTC(2026, 11, 1));
  assert.equal(parseUntil('2026-12-01T09:30:00Z'), Date.UTC(2026, 11, 1, 9, 30));
  assert.throws(() => parseUntil('1790000000'), (e) => e instanceof UsageError && /milliseconds/.test(e.message), 'seconds are not milliseconds');
  assert.throws(() => parseUntil('tomorrow'), UsageError);
  assert.throws(() => parseUntil(''), UsageError);
  assert.throws(() => parseUntil('99999999999999999999'), UsageError);
});

test('ban --until: the block carries until, the validator and ingest accept it, and the ban governs only blocks before it', async () => {
  const L = await ledger();
  const spammer = await person();
  const before = await memberPut(L, spammer, 'k-before', 'early', T + MIN);
  const until = T + 2 * 60 * MIN;
  assert.deepEqual(banOp({ author: spammer.pub, until }), { t: 'ban', author: spammer.pub, until });
  assert.deepEqual(banOp({ author: spammer.pub }), { t: 'ban', author: spammer.pub }, 'absent until means permanent');
  const res = await appendControl({ blocks: L.blocks, identity: L.o.identity, op: banOp({ author: spammer.pub, until }), now: T + 3 * MIN });
  L.blocks = res.blocks;
  await accepted(L, res.block);
  assert.equal(res.block.e.op.until, until);
  const late = await memberPut(L, spammer, 'k-late', 'after the ban ended', until + 5 * MIN);
  const early2 = await memberPut(L, spammer, 'k-early2', 'claimed during the ban', T + 5 * MIN);
  const state = (await loadLedger(L.blocks)).state;
  assert.equal(state.kv.has('k-before'), false, 'a ban redacts what the author wrote before it, as a v1 ban does');
  assert.equal(state.kv.has('k-early2'), false, 'a block claimed before until is governed by the ban');
  assert.equal(state.kv.has('k-late'), true, 'a block claimed at or after until is not');
  assert.ok(before && late && early2);
  assert.throws(() => banOp({ author: 'nope' }), ToolError);
  assert.throws(() => banOp({ author: spammer.pub, until: -1 }), ToolError);
});

test('unban: valid from the owner, lifts a ban for later blocks, never brings back what the ban hid', async () => {
  const L = await ledger();
  const member = await person();
  await memberPut(L, member, 'kept-out', 'hidden by the ban', T + MIN);
  let res = await appendControl({ blocks: L.blocks, identity: L.o.identity, op: banOp({ author: member.pub }), now: T + 2 * MIN });
  L.blocks = res.blocks;
  assert.equal(stateSnapshot((await loadLedger(L.blocks)).state).policy.banned.includes(member.pub), true);
  res = await appendControl({ blocks: L.blocks, identity: L.o.identity, op: unbanOp({ author: member.pub }), now: T + 3 * MIN });
  L.blocks = res.blocks;
  await accepted(L, res.block);
  assert.deepEqual(res.block.e.op, { t: 'unban', author: member.pub });
  await memberPut(L, member, 'back', 'after the unban', T + 10 * MIN);
  const state = (await loadLedger(L.blocks)).state;
  assert.equal(stateSnapshot(state).policy.banned.includes(member.pub), false);
  assert.equal(state.kv.has('back'), true);
  assert.equal(state.kv.has('kept-out'), false, 'values the ban redacted stay dropped');
  assert.throws(() => unbanOp({ author: 'x' }), ToolError);
});

test('moderators use the same tool: a moderator may unban what a moderator banned, not what the owner banned', async () => {
  const L = await ledger();
  const mod = await person();
  const bad = await person();
  const worse = await person();
  let res = await appendControl({ blocks: L.blocks, identity: L.o.identity, op: policyOp({ moderators: [mod.pub] }), now: T + MIN });
  L.blocks = res.blocks;
  res = await appendControl({ blocks: L.blocks, identity: mod, op: banOp({ author: bad.pub }), now: T + 2 * MIN });
  L.blocks = res.blocks;
  res = await appendControl({ blocks: L.blocks, identity: L.o.identity, op: banOp({ author: worse.pub }), now: T + 3 * MIN });
  L.blocks = res.blocks;
  res = await appendControl({ blocks: L.blocks, identity: mod, op: unbanOp({ author: bad.pub }), now: T + 4 * MIN });
  L.blocks = res.blocks;
  await accepted(L, res.block);
  await memberPut(L, bad, 'bad-after', 'lifted', T + 20 * MIN);
  await memberPut(L, worse, 'worse-after', 'still banned by the owner', T + 20 * MIN);
  const state = (await loadLedger(L.blocks)).state;
  assert.equal(state.kv.has('bad-after'), true);
  // The moderator's unban of an owner ban is a state-rule no-op: the block is valid and relayed, the ban stands.
  res = await appendControl({ blocks: L.blocks, identity: mod, op: unbanOp({ author: worse.pub }), now: T + 5 * MIN });
  L.blocks = res.blocks;
  await memberPut(L, worse, 'worse-after-2', 'still banned', T + 30 * MIN);
  assert.equal((await loadLedger(L.blocks)).state.kv.has('worse-after-2'), false);
});

// ---------------------------------------------------------------------------------------------- bulk tombstone

test('bulk tombstone: authors sorted and capped at 64, before must be a block in the new block\'s past; the validator accepts it', async () => {
  const L = await ledger();
  const a = await person();
  const b = await person();
  const first = await memberPut(L, a, 'a1', 'a spam', T + MIN);
  await memberPut(L, b, 'b1', 'b spam', T + 2 * MIN);
  const marker = await memberPut(L, a, 'a2', 'a later', T + 10 * MIN);
  const op = bulkTombstoneOp({ authors: [b.pub, a.pub, a.pub], before: marker.h });
  assert.deepEqual(op.authors, [a.pub, b.pub].sort());
  assert.throws(() => bulkTombstoneOp({ authors: [], before: marker.h }), ToolError);
  assert.throws(() => bulkTombstoneOp({ authors: [a.pub], before: 'short' }), ToolError);
  const many = await Promise.all(Array.from({ length: 65 }, () => person()));
  assert.throws(() => bulkTombstoneOp({ authors: many.map((p) => p.pub), before: marker.h }), (e) => e instanceof ToolError && /at most 64/.test(e.message));
  const res = await appendControl({ blocks: L.blocks, identity: L.o.identity, op, ensureInPast: [op.before], now: T + 11 * MIN });
  L.blocks = res.blocks;
  await accepted(L, res.block);
  const led = await loadLedger(L.blocks);
  assert.ok(led.dag.ancestors(res.block.h).has(marker.h), 'before is in the causal past of the tombstone');
  assert.equal(led.state.kv.has('a1'), false);
  assert.equal(led.state.kv.has('b1'), false);
  assert.ok(first);
});

// ---------------------------------------------------------------------------------------------- keyinfo and rotate

test('keyinfo: rc is base64url sha256 of the tagged recover key, the first one wins, and ingest says why a second is refused', async () => {
  const L = await ledger();
  const member = await person();
  const recover = await person();
  const rc = await recoveryCommitment(recover.pub);
  assert.equal(rc, b64url(createHash('sha256').update(recover.pub, 'utf8').digest()), 'computed independently with node:crypto');
  assert.equal(rc.length, 43);
  assert.deepEqual(await keyinfoOp({ recoverPub: recover.pub }), { t: 'keyinfo', rc });
  await assert.rejects(keyinfoOp({ recoverPub: 'nope' }), ToolError);
  const res = await appendControl({ blocks: L.blocks, identity: member, op: await keyinfoOp({ recoverPub: recover.pub }), now: T + MIN });
  L.blocks = res.blocks;
  await accepted(L, res.block);
  assert.equal((await loadLedger(L.blocks)).state.keyinfo.get(member.pub).rc, rc);
  const second = await person();
  await assert.rejects(appendControl({ blocks: L.blocks, identity: member, op: await keyinfoOp({ recoverPub: second.pub }), now: T + 2 * MIN }),
    (e) => e instanceof ToolError && /keyinfo-set/.test(e.message) && /first one per key wins/.test(e.message));
});

test('keyinfo on a ledger with a posting fee: a member\'s block is mined at the governing bits, the owner\'s is not', async () => {
  const L = await ledger({ writers: 'open', bits: 6 });
  const member = await person();
  const recover = await person();
  const res = await appendControl({ blocks: L.blocks, identity: member, op: await keyinfoOp({ recoverPub: recover.pub }), now: T + MIN });
  assert.equal(res.block.e.bits, 6);
  await accepted({ ledgerId: L.ledgerId, blocks: res.blocks }, res.block);
  const owner = await appendControl({ blocks: L.blocks, identity: L.o.identity, op: await keyinfoOp({ recoverPub: recover.pub }), now: T + MIN });
  assert.equal(owner.block.e.bits, 0);
});

test('rotate --by self: authored by the old key, valid, and the reducer records the key change', async () => {
  const L = await ledger();
  const from = await person();
  const next = await person();
  const op = await rotateOp({ by: 'self', from: from.pub, next: next.pub });
  assert.deepEqual(op, { t: 'rotate', from: from.pub, next: next.pub, by: 'self' });
  const res = await appendControl({ blocks: L.blocks, identity: from, op, now: T + MIN });
  L.blocks = res.blocks;
  await accepted(L, res.block);
  assert.equal(res.block.e.author, from.pub);
  const state = (await loadLedger(L.blocks)).state;
  assert.equal(state.rotations.get(from.pub).next, next.pub);
  assert.equal(stateSnapshot(state).keychange[from.pub].next, next.pub, 'readers show "key changed"');
  await assert.rejects(rotateOp({ by: 'self', from: from.pub, next: from.pub }), ToolError);
});

test('integrator (HUB-1, chain request 10): rotate --by self --next-key carries nsig, the new key\'s consent, and the change is linked', async () => {
  const L = await ledger();
  const from = await person();
  const next = await person();
  const op = await rotateOp({ by: 'self', from: from.pub, next: next.pub, ledgerId: L.ledgerId, nextKey: next });
  assert.equal(typeof op.nsig, 'string');
  assert.ok(op.nsig.length > 40);
  await assert.rejects(rotateOp({ by: 'self', from: from.pub, next: next.pub, ledgerId: L.ledgerId, nextKey: from }), ToolError, 'a --next-key that is not --next');
  const res = await appendControl({ blocks: L.blocks, identity: from, op, now: T + MIN });
  L.blocks = res.blocks;
  await accepted(L, res.block);
  const state = (await loadLedger(L.blocks)).state;
  assert.equal(state.rotations.get(from.pub).next, next.pub);
  assert.equal(stateSnapshot(state).keychange[from.pub].next, next.pub);
});

test('rotate --by recover: authored by the new key, rsig is the recover key\'s signature over the exact input, and it beats a self rotation in either order', async () => {
  const L = await ledger();
  const from = await person();
  const recover = await person();
  const attacker = await person();
  const next = await person();
  let res = await appendControl({ blocks: L.blocks, identity: from, op: await keyinfoOp({ recoverPub: recover.pub }), now: T + MIN });
  L.blocks = res.blocks;
  // a thief holding `from` rotates it to the attacker's key first (self rotation)
  res = await appendControl({ blocks: L.blocks, identity: from, op: await rotateOp({ by: 'self', from: from.pub, next: attacker.pub }), now: T + 2 * MIN });
  L.blocks = res.blocks;
  const op = await rotateOp({ by: 'recover', from: from.pub, next: next.pub, ledgerId: L.ledgerId, recover });
  assert.equal(op.by, 'recover');
  assert.equal(op.rp, recover.pub);
  assert.equal(await verifySig(recover.pub, rotateSigningInput(L.ledgerId, from.pub, next.pub), op.rsig), true, 'the signed input is "mw-rotate-v1\\n" + ledger + "\\n" + from + "\\n" + next');
  assert.equal(rotateSigningInput(L.ledgerId, from.pub, next.pub), 'mw-rotate-v1\n' + L.ledgerId + '\n' + from.pub + '\n' + next.pub);
  res = await appendControl({ blocks: L.blocks, identity: next, op, now: T + 3 * MIN });
  L.blocks = res.blocks;
  await accepted(L, res.block);
  assert.equal(res.block.e.author, next.pub, 'a recover rotation is authored by the new key');
  const state = (await loadLedger(L.blocks)).state;
  assert.equal(state.rotations.get(from.pub).next, next.pub, 'the recover rotation overrides the self rotation');
  assert.equal(state.rotations.get(from.pub).by, 'recover');
  // a recover key that does not match the commitment is refused with the reason
  const other = await person();
  const bad = await rotateOp({ by: 'recover', from: from.pub, next: (await person()).pub, ledgerId: L.ledgerId, recover: other });
  const nextBad = await person();
  const bad2 = await rotateOp({ by: 'recover', from: from.pub, next: nextBad.pub, ledgerId: L.ledgerId, recover: other });
  await assert.rejects(appendControl({ blocks: L.blocks, identity: nextBad, op: bad2, now: T + 4 * MIN }), (e) => e instanceof ToolError && /recover/.test(e.message) && /keyinfo/.test(e.message));
  assert.ok(bad);
  await assert.rejects(rotateOp({ by: 'recover', from: from.pub, next: next.pub, ledgerId: L.ledgerId }), ToolError, 'a recover rotation needs the recover key');
  await assert.rejects(rotateOp({ by: 'sideways', from: from.pub, next: next.pub }), UsageError);
});

// ---------------------------------------------------------------------------------------------- checkpoint

test('checkpoint: the state file hashes to the snap, the block is accepted, and the state reduces like the full ledger', async () => {
  const L = await ledger();
  const a = await person();
  const b = await person();
  await memberPut(L, a, 'k1', 'one', T + MIN);
  await memberPut(L, b, 'k2', 'two', T + 2 * MIN);
  const res = await checkpointBlock({ blocks: L.blocks, identity: L.o.identity, now: T + 5 * MIN });
  L.blocks = res.blocks;
  await accepted(L, res.block);
  assert.equal(sha256hex(res.file), res.snap, 'sha256 of the state file is the snap');
  assert.equal(checkpointSnap(res.S), res.snap);
  assert.equal(res.file, canonicalize(res.S));
  assert.equal(res.block.e.op.snap, res.snap);
  assert.equal(res.block.e.op.n, res.n);
  assert.equal(res.block.e.op.bytes, res.bytes);
  assert.deepEqual(res.block.e.op.heads, res.heads);
  assert.equal(res.block.e.prev.length, res.heads.length, 'every head is a parent of the checkpoint block');
  const full = stateSnapshot((await loadLedger(L.blocks)).state);
  const led = await loadLedger(L.blocks);
  const fromS = reduceFromCheckpoint(res.S, [res.block], { genesisOwner: led.genesisOwner, snap: res.snap });
  assert.deepEqual(stateSnapshot(fromS).kv, full.kv);
  assert.deepEqual(stateSnapshot(fromS).policy, full.policy);
  assert.equal(full.checkpoint.h, res.block.h);
  // a second checkpoint covers what came after
  await memberPut(L, a, 'k3', 'three', T + 6 * MIN);
  const again = await checkpointBlock({ blocks: L.blocks, identity: L.o.identity, now: T + 8 * MIN });
  assert.notEqual(again.snap, res.snap);
  assert.ok(again.n > res.n);
});

test('checkpoint: owner only, at most 8 heads (the parents), a head the file does not hold is refused', async () => {
  const L = await ledger();
  const a = await person();
  await memberPut(L, a, 'k', 'v', T + MIN);
  await assert.rejects(checkpointBlock({ blocks: L.blocks, identity: a, now: T + 2 * MIN }), (e) => e instanceof ToolError && /not the owner/.test(e.message));
  await assert.rejects(checkpointBlock({ blocks: L.blocks, identity: L.o.identity, heads: ['f'.repeat(64)], now: T + 2 * MIN }), /not in the ledger file/);
  await assert.rejects(checkpointBlock({ blocks: L.blocks, identity: L.o.identity, heads: Array.from({ length: 9 }, (_, i) => String(i).repeat(64)), now: T + 2 * MIN }), /at most 8/);
});

// ---------------------------------------------------------------------------------------------- cfg

test('cfg rows: every setting of R 2.5.5 is written as one put of _mw.cfg that the reader\'s schema accepts', async () => {
  const L = await ledger({ writers: 'owner' });
  const pinNode = await person();
  const verifier = await person();
  const rows = [
    [{ chat: 'members' }, { chat: 'members' }],
    [{ chat: 'open' }, { chat: 'open' }],
    [{ files: 'members' }, { files: 'members' }],
    [{ media: 'members' }, { media: 'members' }],
    [{ records: 'sealed', maxItems: 4 }, { records: 'sealed', maxItems: 4 }],
    [{ requests: 'on', chatBits: 20 }, { requests: 'on', chatBits: 20 }],
    [{ pin: pinNode.pub }, { pin: pinNode.pub }],
    [{ turn: { urls: ['turns:turn.example:5349'], mode: 'static' } }, { turn: { urls: ['turns:turn.example:5349'], mode: 'static' } }],
    [{ age: verifier.pub }, { age: verifier.pub }],
    [{ age: 'none' }, { age: 'none' }],
  ];
  let accumulated = {};
  let step = 0;
  for (const [set, expect] of rows) {
    const res = await setCfg({ blocks: L.blocks, identity: L.o.identity, set, clear: [], now: T + ++step * MIN });
    L.blocks = res.blocks;
    await accepted(L, res.block);
    assert.equal(res.block.e.op.t, 'put');
    assert.equal(res.block.e.op.k, '_mw.cfg');
    accumulated = Object.assign(accumulated, expect);
    assert.deepEqual(res.cfg, Object.fromEntries(Object.entries(accumulated).sort(([x], [y]) => (x < y ? -1 : 1))), 'settings that are not passed keep their value');
    assert.equal(schemaOk('_mw.cfg', res.block.v, 'key'), true);
  }
  assert.deepEqual(currentCfg((await loadLedger(L.blocks)).state), accumulated);
  assert.deepEqual(CFG_KEYS, ['chat', 'files', 'media', 'calls', 'records', 'maxItems', 'requests', 'chatBits', 'pin', 'turn', 'age', 'wall', 'blockTiers']);
});

// Code review v0.3 (conformance M1): blockTiers (ARCHITECTURE 15.7, the files lane), wall (R 3.5, the social template) and
// requests 'introduced' (R 2.17.2) are in the readers' schema, so the writer offers them.
test('cfg --block-tiers, --wall and --requests introduced: written as the readers\' schema takes them; --clear removes them', async () => {
  const f = (o) => Object.assign({ chat: null, files: null, media: null, calls: null, records: null, requests: null, wall: null, maxItems: null, chatBits: null, pin: null, age: null, turn: [], turnMode: null, blockTiers: [], clear: [] }, o);
  assert.deepEqual(cfgFromFlags(f({ blockTiers: ['installer,executable', 'script'] })).set, { blockTiers: ['executable', 'installer', 'script'] });
  assert.deepEqual(cfgFromFlags(f({ blockTiers: ['none'] })), { set: {}, clear: ['blockTiers'] });
  assert.throws(() => cfgFromFlags(f({ blockTiers: ['exe'] })), (e) => e instanceof UsageError && /--block-tiers takes kinds of image/.test(e.message));
  assert.deepEqual(cfgFromFlags(f({ wall: 'follow' })).set, { wall: 'follow' });
  assert.throws(() => cfgFromFlags(f({ wall: 'friends' })), (e) => e instanceof UsageError && /--wall must be everyone, follow, nobody, approve/.test(e.message));
  assert.deepEqual(cfgFromFlags(f({ requests: 'introduced', chatBits: 20 })).set, { requests: 'introduced', chatBits: 20 });
  assert.deepEqual(cfgFromFlags(f({ clear: ['block-tiers', 'wall'] })).clear, ['blockTiers', 'wall']);
  assert.deepEqual(mergeCfg({ chat: 'members' }, { set: { requests: 'introduced', chatBits: 20 } }), { chat: 'members', chatBits: 20, requests: 'introduced' }, 'chatBits stays with introduced');
  assert.deepEqual(mergeCfg({ chat: 'members', requests: 'introduced', chatBits: 20 }, { set: { requests: 'off' } }), { chat: 'members', requests: 'off' });
  const L = await ledger({ writers: 'owner' });
  const res = await setCfg({ blocks: L.blocks, identity: L.o.identity, set: { chat: 'members', files: 'members', blockTiers: ['executable'], wall: 'approve' }, clear: [], now: T + MIN });
  await accepted(L, res.block);
  assert.equal(schemaOk('_mw.cfg', res.block.v, 'key'), true);
  assert.deepEqual(currentCfg((await loadLedger(res.blocks)).state), { blockTiers: ['executable'], chat: 'members', files: 'members', wall: 'approve' }, 'readers keep the whole object');
});

test('cfg flags: --max-items is at most 32 and needs records sealed, --chat-bits needs requests on, bad values are usage errors, --clear removes a setting', async () => {
  const f = (o) => Object.assign({ chat: null, files: null, media: null, records: null, requests: null, maxItems: null, chatBits: null, pin: null, age: null, turn: [], turnMode: null, clear: [] }, o);
  assert.deepEqual(cfgFromFlags(f({ records: 'sealed', maxItems: 32 })).set, { records: 'sealed', maxItems: 32 });
  assert.throws(() => cfgFromFlags(f({ records: 'sealed', maxItems: 33 })), (e) => e instanceof UsageError && /1 to 32/.test(e.message));
  assert.throws(() => cfgFromFlags(f({ records: 'sealed', maxItems: 0 })), UsageError);
  assert.throws(() => cfgFromFlags(f({ chat: 'everyone' })), (e) => e instanceof UsageError && /off, members, open/.test(e.message));
  assert.throws(() => cfgFromFlags(f({ files: 'open' })), UsageError, 'public file listings are off or members only');
  assert.throws(() => cfgFromFlags(f({ requests: 'on', chatBits: 33 })), UsageError);
  assert.throws(() => cfgFromFlags(f({ pin: 'not-a-key' })), UsageError);
  assert.throws(() => cfgFromFlags(f({ age: 'child' })), UsageError);
  assert.throws(() => cfgFromFlags(f({ turn: ['http://insecure.example'] })), UsageError);
  assert.throws(() => cfgFromFlags(f({ turnMode: 'static' })), UsageError, '--turn-mode needs --turn');
  assert.throws(() => cfgFromFlags(f({ turn: Array.from({ length: 9 }, (_, i) => 'turn:t' + i + '.example') })), UsageError);
  assert.deepEqual(cfgFromFlags(f({ turn: ['turn:b.example', 'turn:a.example,turns:c.example'], turnMode: 'endpoint' })).set.turn, { urls: ['turn:a.example', 'turn:b.example', 'turns:c.example'], mode: 'endpoint' });
  assert.deepEqual(cfgFromFlags(f({ pin: 'none' })), { set: {}, clear: ['pin'] });
  assert.deepEqual(cfgFromFlags(f({ turn: ['none'] })), { set: {}, clear: ['turn'] });
  assert.deepEqual(cfgFromFlags(f({ clear: ['chat-bits', 'maxItems'] })).clear, ['chatBits', 'maxItems']);
  assert.throws(() => cfgFromFlags(f({ clear: ['nonsense'] })), UsageError);
  // merge rules
  assert.throws(() => mergeCfg({}, { set: { maxItems: 4 } }), (e) => e instanceof ToolError && /records sealed/.test(e.message));
  assert.throws(() => mergeCfg({}, { set: { chatBits: 20 } }), (e) => e instanceof ToolError && /requests on/.test(e.message));
  assert.deepEqual(mergeCfg({ records: 'sealed', maxItems: 4 }, { set: { maxItems: 8 } }), { maxItems: 8, records: 'sealed' });
  assert.deepEqual(mergeCfg({ records: 'sealed', maxItems: 4, chat: 'members' }, { set: { records: 'off' } }), { chat: 'members', records: 'off' }, 'maxItems goes with sealed records');
  assert.deepEqual(mergeCfg({ chat: 'members', files: 'members' }, { clear: ['files'] }), { chat: 'members' });
  assert.throws(() => mergeCfg({ chat: 'members' }, { clear: ['chat'] }), /nothing is set/);
});

// v0.3 C2 (SEEDING-AND-ZERO-SETUP-DESIGN 3.2 and 3.5): --calls off|contacts, validated like --chat. Writing it also needs the reader's
// schema (src/chain/state.js CFG) to list calls; that file belongs to another lane (request: docs/deviations/zero-setup.md), so the rows
// that write a block run only when the schema lists it, and otherwise the test pins the message that says so.
test('cfg --calls: off or contacts, needs chat on, --clear calls removes it; the writer never produces a setting the reader hides', async () => {
  const f = (o) => Object.assign({ chat: null, files: null, media: null, calls: null, records: null, requests: null, maxItems: null, chatBits: null, pin: null, age: null, turn: [], turnMode: null, clear: [] }, o);
  assert.deepEqual(cfgFromFlags(f({ calls: 'contacts' })).set, { calls: 'contacts' });
  assert.deepEqual(cfgFromFlags(f({ calls: 'off' })).set, { calls: 'off' });
  assert.deepEqual(cfgFromFlags(f({})).set, {}, 'no --calls, no setting');
  assert.throws(() => cfgFromFlags(f({ calls: 'everyone' })), (e) => e instanceof UsageError && /--calls must be off, contacts/.test(e.message));
  assert.throws(() => cfgFromFlags(f({ calls: 'members' })), UsageError, 'calls are for contacts, not for every member');
  assert.deepEqual(cfgFromFlags(f({ clear: ['calls'] })), { set: {}, clear: ['calls'] });
  assert.deepEqual(CFG_ENUMS.calls, ['off', 'contacts']);
  // calls travel over the chat lane
  assert.throws(() => mergeCfg({}, { set: { calls: 'contacts' } }), (e) => e instanceof ToolError && /--calls contacts needs chat on/.test(e.message));
  assert.throws(() => mergeCfg({ chat: 'off' }, { set: { calls: 'contacts' } }), (e) => e instanceof ToolError && /the setting is off/.test(e.message));
  assert.throws(() => mergeCfg({ chat: 'members', calls: 'contacts' }, { set: { chat: 'off' } }), (e) => e instanceof ToolError && /calls are on \(contacts\) and need chat: turn them off with --calls off/.test(e.message));
  assert.throws(() => mergeCfg({ chat: 'members', calls: 'contacts' }, { clear: ['chat'] }), (e) => e instanceof ToolError && /need chat/.test(e.message));
  const readerKnowsCalls = schemaOk('_mw.cfg', { calls: 'contacts' }, 'key');
  if (readerKnowsCalls) {
    assert.deepEqual(mergeCfg({ chat: 'members' }, { set: { calls: 'contacts' } }), { calls: 'contacts', chat: 'members' });
    assert.deepEqual(mergeCfg({ chat: 'open', calls: 'contacts' }, { set: { calls: 'off' } }), { calls: 'off', chat: 'open' });
    assert.deepEqual(mergeCfg({ chat: 'members', calls: 'contacts' }, { clear: ['calls'] }), { chat: 'members' });
    const L = await ledger({ writers: 'owner' });
    const res = await setCfg({ blocks: L.blocks, identity: L.o.identity, set: { chat: 'members', calls: 'contacts' }, clear: [], now: T + MIN });
    await accepted(L, res.block);
    assert.deepEqual(res.cfg, { calls: 'contacts', chat: 'members' });
    assert.equal(schemaOk('_mw.cfg', res.block.v, 'key'), true);
  } else {
    assert.throws(() => mergeCfg({ chat: 'members' }, { set: { calls: 'contacts' } }), (e) => e instanceof ToolError && /the reader schema in src\/chain\/state\.js does not list calls yet/.test(e.message));
    assert.throws(() => mergeCfg({}, { set: { calls: 'off' } }), (e) => e instanceof ToolError && /does not list calls yet/.test(e.message));
    assert.throws(() => mergeCfg({}, { set: { chat: 'sideways' } }), (e) => e instanceof ToolError && !/calls/.test(e.message), 'another reason is reported without the calls hint');
  }
});

test('cfg: a moderator may set it (shown with who set it), a plain member is refused with the reason', async () => {
  const L = await ledger({ writers: 'open' });
  const mod = await person();
  const member = await person();
  let res = await appendControl({ blocks: L.blocks, identity: L.o.identity, op: policyOp({ moderators: [mod.pub] }), now: T + MIN });
  L.blocks = res.blocks;
  res = await setCfg({ blocks: L.blocks, identity: mod, set: { chat: 'members' }, now: T + 2 * MIN });
  L.blocks = res.blocks;
  assert.equal(res.block.e.author, mod.pub);
  assert.equal(currentCfg((await loadLedger(L.blocks)).state).chat, 'members');
  await assert.rejects(setCfg({ blocks: L.blocks, identity: member, set: { chat: 'open' }, now: T + 3 * MIN }),
    (e) => e instanceof ToolError && /E_NOT_MODERATOR/.test(e.message) && /owner or a moderator/.test(e.message));
});

// ---------------------------------------------------------------------------------------------- deny

test('deny key hashing: _deny/ + base64url(sha256(utf8(identifier))), lowercase hex only, and the value follows the reader\'s schema', async () => {
  const ih = '0123456789abcdef0123456789abcdef01234567';
  const key = await denyKey(ih);
  assert.equal(key, '_deny/' + b64url(createHash('sha256').update(ih, 'utf8').digest()), 'computed independently with node:crypto');
  assert.equal(key.length, '_deny/'.length + 43);
  assert.equal(await denyKey(ih.toUpperCase()), key, 'an upper-case spelling is the same identifier');
  const sha = 'ab'.repeat(32);
  assert.equal(await denyKey(sha), '_deny/' + b64url(createHash('sha256').update(sha, 'utf8').digest()));
  assert.notEqual(await denyKey(ih), await denyKey(sha));
  await assert.rejects(denyKey('xyz'), ToolError);
  await assert.rejects(denyKey('ab'.repeat(20) + '00'), ToolError, '42 characters is neither an infohash nor a SHA-256');
  const by = (await person()).pub;
  for (const reason of DENY_REASONS) {
    const v = denyValue({ by, t: T, reason });
    assert.equal(schemaOk(key, v, 'key'), true, reason);
  }
  assert.deepEqual(denyValue({ by, t: T, reason: 'P0', ref: 'report 7' }), { by, reason: 'P0', t: T, ref: 'report 7' });
  assert.throws(() => denyValue({ by, t: T, reason: 'because' }), UsageError);
  assert.deepEqual(DENY_REASONS, ['P0', 'illegal', 'malware', 'spam', 'other']);
});

test('deny: the block is a put of the hashed key by the owner or a moderator, accepted at ingest, and the identifier itself is not in the ledger', async () => {
  const L = await ledger({ writers: 'owner' });
  const ih = 'fedcba9876543210fedcba9876543210fedcba98';
  const res = await denyIdentifier({ blocks: L.blocks, identity: L.o.identity, id: ih, reason: 'illegal', ref: 'case 41', now: T + MIN });
  L.blocks = res.blocks;
  await accepted(L, res.block);
  assert.equal(res.block.e.op.k, res.key);
  assert.equal(res.block.v.reason, 'illegal');
  assert.equal(res.block.v.by, L.o.identity.pub);
  assert.equal(JSON.stringify(res.block).includes(ih), false, 'the ledger holds a hash of the identifier, not the identifier');
  const state = (await loadLedger(L.blocks)).state;
  assert.equal(state.kv.get(res.key).v.reason, 'illegal');
  const stranger = await person();
  await assert.rejects(denyIdentifier({ blocks: L.blocks, identity: stranger, id: ih, reason: 'spam', now: T + 2 * MIN }), ToolError);
});

// ---------------------------------------------------------------------------------------------- listed (premoderation)

test('listed (code review v0.3 round 2): the owner accepts a new key\'s public listing offline, and honest copies then show it and the author\'s later ones', async () => {
  const L = await ledger({ writers: 'open' });
  const alice = await person();
  const listing = (ih, t) => ({ ih, len: 5, name: 'note.txt', mime: 'text/plain', t });
  const ih1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const ih2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const append = async (who, v, ts) => {
    const led = await loadLedger(L.blocks);
    const prev = led.dag.heads({ limit: 8 }).slice().sort();
    const seq = led.dag.order().filter((b) => b.e.author === who.pub).length;
    const block = await createBlock({ identity: who, site: L.ledgerId, seq, prev, op: { t: 'append', l: 'mw.files' }, value: v, ts, bits: 0 });
    L.blocks = L.blocks.concat([block]);
    return block;
  };
  await append(alice, listing(ih1, T + MIN), T + MIN);
  let state = (await loadLedger(L.blocks)).state;
  const item = () => state.lists.get('mw.files').find((it) => it.v.ih === ih1);
  assert.equal(listingVisible(state, item()), false, 'a new key\'s first listing waits for a moderator');
  assert.equal(await listedKey(ih1), await idKey(LISTED_PREFIX, ih1), 'the key the loader\'s moderation card writes');
  await assert.rejects(listedKey('xyz'), ToolError);
  const res = await acceptListing({ blocks: L.blocks, identity: L.o.identity, ih: ih1, now: T + 2 * MIN });
  L.blocks = res.blocks;
  await accepted(L, res.block);
  assert.deepEqual(res.block.v, { by: L.o.identity.pub, t: T + 2 * MIN, ih: ih1, author: alice.pub }, 'MAL53-1: bound to the author');
  assert.equal(res.key, await listedKey(ih1, alice.pub));
  state = (await loadLedger(L.blocks)).state;
  assert.equal(listingVisible(state, item()), true, 'accepted: honest copies show it');
  await append(alice, listing(ih2, T + 3 * MIN), T + 3 * MIN);
  state = (await loadLedger(L.blocks)).state;
  assert.equal(listingVisible(state, state.lists.get('mw.files').find((it) => it.v.ih === ih2)), true, 'and the author\'s later listings');
  const stranger = await person();
  const forged = await acceptListing({ blocks: L.blocks, identity: stranger, ih: ih2, now: T + 4 * MIN }).catch((e) => e);
  assert.ok(forged instanceof ToolError, 'a key that is not the owner\'s or a moderator\'s is refused');
  // MAL53-1 (integrator): another key that lists the accepted infohash is not credited, and an ambiguous acceptance asks for --author.
  const mallory = await person();
  await append(mallory, listing(ih1, T + 5 * MIN), T + 5 * MIN);
  state = (await loadLedger(L.blocks)).state;
  const mal = state.lists.get('mw.files').find((it) => it.v.ih === ih1 && it.author === mallory.pub);
  assert.equal(listingVisible(state, mal), false, 'a re-listing of an accepted infohash by another key stays in the queue');
  await assert.rejects(acceptListing({ blocks: L.blocks, identity: L.o.identity, ih: ih1, now: T + 6 * MIN }), /--author/);
  await assert.rejects(acceptListing({ blocks: L.blocks, identity: L.o.identity, ih: 'cccccccccccccccccccccccccccccccccccccccc', now: T + 6 * MIN }), /--author/);
});

// ---------------------------------------------------------------------------------------------- capacity meter

test('capacity meter: members x items x 1,877 bytes, labelled arithmetic; the R example (1,000 members x 4 items = 7.5 MB) fits the 8 MiB default', () => {
  assert.equal(SEALED_ITEM_BYTES, 1877);
  const m = capacityMeter({ members: 1000, items: 4 });
  assert.equal(m.bytes, 7508000);
  assert.equal(m.fits, true);
  assert.ok(Math.abs(m.share - 7508000 / 8388608) < 1e-12);
  const text = m.lines.join('\n');
  assert.match(text, /arithmetic/);
  assert.match(text, /1,000 members x 4 items x 1,877 bytes = 7,508,000 bytes/);
  assert.match(text, /89\.5 percent/);
  assert.equal(/measured/.test(text), false, 'it does not claim a measurement');
  const big = capacityMeter({ members: 5000, items: 4 });
  assert.equal(big.fits, false);
  assert.match(big.lines.join('\n'), /raise maxChainBytes/);
  assert.match(capacityMeter({ members: 1, items: 33 }).lines.join('\n'), /at most 32/);
  assert.match(capacityMeter({ members: 10, items: 4, usedBytes: 4096 }).lines.join('\n'), /now holds 4,096 bytes/);
  assert.throws(() => capacityMeter({ members: -1, items: 4 }), UsageError);
});

// ---------------------------------------------------------------------------------------------- the command line

function cli(args, cwd = ROOT) {
  return spawnSync(process.execPath, ['tools/ledger-admin.mjs', ...args], { cwd, encoding: 'utf8' });
}

test('command line: every v0.3 command is in --help, and bad flags exit 2', () => {
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  for (const c of ['unban', 'keyinfo', 'rotate', 'checkpoint', 'cfg', 'deny', 'capacity', 'tombstone', '--until', '--authors', '--before', '--records', '--max-items', '--chat-bits',
    '--pin', '--turn', '--age', '--calls', '--mod-allow-per-day', '--mod-actions-per-hour', '--reserved-pool', '--void', '--recover-key']) {
    assert.ok(help.stdout.includes(c), '--help mentions ' + c);
  }
  assert.equal(cli(['bogus']).status, 2);
  assert.equal(cli(['cfg', '--chat', 'members']).status, 2, 'cfg needs a key');
  assert.equal(cli(['capacity']).status, 2);
  assert.equal(cli(['capacity', '--members', 'x']).status, 2);
});

test('command line: cfg --calls is a usage error for a bad value, and a plain error without chat (no block is written either way)', async () => {
  const owner = await ownerKey();
  const file = join(work, 'cli-ledger-calls.json');
  assert.equal(cli(['genesis', '--key', owner.file, '--scope', 'calls.example', '--out', file]).status, 0);
  const before = readFileSync(file, 'utf8');
  const bad = cli(['cfg', '--key', owner.file, '--file', file, '--calls', 'everyone']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--calls must be off, contacts/);
  const noChat = cli(['cfg', '--key', owner.file, '--file', file, '--calls', 'contacts']);
  assert.equal(noChat.status, 1);
  assert.match(noChat.stderr, /--calls contacts needs chat on: set --chat members \(or open\)/);
  assert.equal(readFileSync(file, 'utf8'), before, 'a refused setting changes nothing');
  const help = cli(['--help']);
  assert.match(help.stdout, /--calls off\|contacts/);
  assert.match(help.stdout, /needs chat on and the site's own tracker and STUN/);
});

test('command line: cfg, deny, ban --until, unban, keyinfo, rotate, checkpoint and capacity on a real ledger file (gzip stays gzip)', async () => {
  const owner = await ownerKey();
  const member = await ownerKey();
  const recover = await ownerKey();
  const next = await ownerKey();
  const file = join(work, 'cli-ledger.json.gz');
  const genesis = cli(['genesis', '--key', owner.file, '--scope', 'cli.example', '--writers', 'open', '--bits', '4', '--mod-allow-per-day', '5', '--out', file]);
  assert.equal(genesis.status, 0, genesis.stderr);
  assert.equal(isGzipFile(file), true);
  const run = (args) => {
    const r = cli(args);
    assert.equal(r.status, 0, args.join(' ') + '\n' + r.stderr + r.stdout);
    return r;
  };
  const cfg = run(['cfg', '--key', owner.file, '--file', file, '--chat', 'members', '--files', 'members', '--media', 'members', '--records', 'sealed', '--max-items', '4', '--requests', 'on', '--chat-bits', '20']);
  assert.match(cfg.stdout, /appended put block/);
  assert.equal(isGzipFile(file), true, 'a gzip ledger file stays gzip');
  assert.deepEqual(JSON.parse(run(['cfg', '--file', file, '--show']).stdout), { chat: 'members', chatBits: 20, files: 'members', maxItems: 4, media: 'members', records: 'sealed', requests: 'on' });
  run(['cfg', '--key', owner.file, '--file', file, '--turn', 'turns:turn.example:5349', '--pin', member.pub, '--age', 'none', '--clear', 'files']);
  const shown = JSON.parse(run(['cfg', '--file', file, '--show']).stdout);
  assert.deepEqual(shown.turn, { mode: 'static', urls: ['turns:turn.example:5349'] });
  assert.equal(shown.pin, member.pub);
  assert.equal(shown.files, undefined);
  assert.equal(cli(['cfg', '--key', owner.file, '--file', file, '--records', 'sealed', '--max-items', '33']).status, 2);
  const ih = '0123456789abcdef0123456789abcdef01234567';
  const deny = run(['deny', '--key', owner.file, '--file', file, '--ih', ih, '--reason', 'malware', '--ref', 'scan 3']);
  assert.match(deny.stdout, /_deny\/[A-Za-z0-9_-]{43}/);
  assert.equal(deny.stdout.includes(ih), false, 'the identifier is not printed back into the ledger notes');
  assert.equal(cli(['deny', '--key', owner.file, '--file', file, '--ih', ih, '--sha256', 'aa'.repeat(32), '--reason', 'spam']).status, 2);
  assert.equal(cli(['deny', '--key', owner.file, '--file', file, '--ih', ih, '--reason', 'whatever']).status, 2);
  run(['ban', '--key', owner.file, '--file', file, '--author', member.pub, '--until', '2099-01-01']);
  assert.equal(cli(['ban', '--key', owner.file, '--file', file, '--author', member.pub, '--until', '12345']).status, 2, 'seconds are refused');
  run(['unban', '--key', owner.file, '--file', file, '--author', member.pub]);
  const ki = run(['keyinfo', '--key', member.file, '--file', file, '--recover-key', recover.file]);
  assert.match(ki.stdout, /rc = [A-Za-z0-9_-]{43}/);
  assert.equal(cli(['keyinfo', '--key', member.file, '--file', file, '--recover-key', member.file]).status, 1, 'the recover key must differ from the key');
  run(['rotate', '--by', 'recover', '--key', next.file, '--file', file, '--from', member.pub, '--recover-key', recover.file]);
  assert.equal(cli(['rotate', '--by', 'recover', '--key', next.file, '--file', file, '--from', member.pub]).status, 2);
  assert.equal(cli(['rotate', '--key', next.file, '--file', file]).status, 2);
  const stateFile = join(work, 'cli-state.json');
  const cp = run(['checkpoint', '--key', owner.file, '--file', file, '--out', stateFile]);
  const snapLine = /snap\s+([0-9a-f]{64})/.exec(cp.stdout);
  assert.ok(snapLine, cp.stdout);
  assert.equal(sha256hex(readFileSync(stateFile, 'utf8')), snapLine[1], 'the state file written by the command hashes to the printed snap');
  assert.equal(isGzipFile(file), true);
  const blocks = readBlocksFile(file);
  const led = await loadLedger(blocks);
  assert.equal(led.invalid.length, 0);
  assert.equal(led.state.checkpoint.snap, snapLine[1]);
  const ops = blocks.map((b) => b.e.op.t);
  for (const t of ['policy', 'put', 'ban', 'unban', 'keyinfo', 'rotate', 'checkpoint']) assert.ok(ops.includes(t), t);
  const cap = run(['capacity', '--members', '1000', '--items', '4']);
  assert.match(cap.stdout, /7,508,000 bytes/);
  // a ledger file alone gives its position, with no invented budget line
  const position = run(['capacity', '--file', file]);
  assert.match(position.stdout, /Position of the ledger file/);
  assert.match(position.stdout, /this ledger file now holds [\d,]+ bytes/);
  assert.ok(!/members x/.test(position.stdout), position.stdout);
  assert.equal(cli(['capacity', '--members', '5000', '--items', '4']).status, 1, 'exit 1 when it does not fit');
  const shownFile = run(['show', '--file', file]);
  assert.match(shownFile.stdout, /freeze\s+modAllowPerDay=5/);
  assert.match(shownFile.stdout, /cfg\s+\{/);
  assert.match(shownFile.stdout, /checkpoint=/);
});

test('command line: tombstone --authors --before is a bulk tombstone; --h still works; both together are a usage error', async () => {
  const owner = await ownerKey();
  const spam = await ownerKey();
  const file = join(work, 'bulk-ledger.json');
  assert.equal(cli(['genesis', '--key', owner.file, '--scope', 'bulk.example', '--writers', 'open', '--bits', '0', '--out', file]).status, 0);
  const led0 = await loadLedger(readBlocksFile(file));
  const blk = await createBlock({ identity: spam.identity, site: led0.site, seq: 0, prev: led0.dag.heads(), op: { t: 'put', k: 'x' }, value: 'spam', ts: T, bits: 0 });
  writeBlocksFile(file, readBlocksFile(file).concat([blk]));
  const r = cli(['tombstone', '--key', owner.file, '--file', file, '--authors', spam.pub, '--before', blk.h]);
  assert.equal(r.status, 0, r.stderr);
  const last = readBlocksFile(file).pop();
  assert.deepEqual(last.e.op, { t: 'tombstone', authors: [spam.pub], before: blk.h });
  assert.equal((await loadLedger(readBlocksFile(file))).state.kv.has('x'), false);
  assert.equal(cli(['tombstone', '--key', owner.file, '--file', file, '--authors', spam.pub, '--before', blk.h, '--h', blk.h]).status, 2);
  assert.equal(cli(['tombstone', '--key', owner.file, '--file', file, '--h', blk.h]).status, 0);
  assert.equal(existsSync(file), true);
});

test('command line (code review v0.3 round 2, MF-54): genesis and policy warn when writing opens; listed is in --help and writes the acceptance', async () => {
  const owner = await ownerKey();
  const file = join(work, 'cli-ledger-open.json');
  const g = cli(['genesis', '--key', owner.file, '--scope', 'open.example', '--writers', 'open', '--out', file]);
  assert.equal(g.status, 0, g.stderr);
  assert.match(g.stderr, /writers open: every visitor stores and passes on what strangers post/);
  const closed = cli(['genesis', '--key', owner.file, '--scope', 'owner.example', '--out', join(work, 'cli-ledger-owner.json')]);
  assert.equal(closed.status, 0);
  assert.doesNotMatch(closed.stderr, /writers open/, 'no warning for an owner-only ledger');
  const p = cli(['policy', '--key', owner.file, '--file', join(work, 'cli-ledger-owner.json'), '--writers', 'open']);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stderr, /writers open/);
  assert.match(cli(['--help']).stdout, /listed {5}--key owner\.jwk --file <ledger\.json> --ih <40 hex>/);
  const ih = 'cccccccccccccccccccccccccccccccccccccccc';
  // MAL53-1: with no listing of that infohash in the file the tool asks for --author; with --author it binds the acceptance.
  assert.equal(cli(['listed', '--key', owner.file, '--file', file, '--ih', ih]).status, 2);
  const author = (await person()).pub;
  const l = cli(['listed', '--key', owner.file, '--file', file, '--ih', ih, '--author', author]);
  assert.equal(l.status, 0, l.stderr);
  assert.match(l.stdout, /key _listed\//);
  const state = (await loadLedger(readBlocksFile(file))).state;
  assert.ok(state.kv.has(await listedKey(ih, author)), 'the acceptance is in the ledger, bound to the author');
  assert.equal(cli(['listed', '--key', owner.file, '--file', file, '--ih', 'nope']).status, 2);
});
